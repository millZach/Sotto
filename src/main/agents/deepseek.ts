import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { version as appVersion } from '../../../package.json'
import { agentProjectSchema, attachmentReferences, type AgentHostSnapshot, type AgentModel, type AgentRuntimeMode, type AgentThread } from '../../shared/agents'
import { mergeAgentActivities, type OwnServerTurn } from '../../shared/agentActivity'
import type { OwnServer } from '../../shared/ownModelServers'
import { watcherProvidersInWords } from '../../shared/workerRoles'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { ActivitySubscribers, certifyActivityView, cloneActivitySnapshot } from './activitySnapshots'
import { deliverAttachments, withAttachedFilesNote } from './attachedFiles'
import type { BrowserAgentTools } from './browserAgentServer'
import { cloneHostSnapshot } from './cloneHostSnapshot'
import { deepseekActivities, DEEPSEEK_THINKING_ID_PREFIX } from './deepseekActivity'
import { deepseekCatalog, deepseekModelRoute, deepseekModelValue, deepseekSandboxMode, deepseekSettingsOf, DEEPSEEK_RUNTIME_MODES } from './deepseekModels'
import { deepseekAnswer, deepseekDecline, deepseekPending, type DeepSeekPending, type DeepSeekToolDetail } from './deepseekRequests'
import { compareDeepSeekVersions, deepseekEnvironment, DeepSeekRejected, DeepSeekRpc, DeepSeekUncertain, DEEPSEEK_ACP_VERSION, DEEPSEEK_CLI_VERSION,
  findDeepSeekExecutable, readDeepSeekVersion, type DeepSeekFrame } from './deepseekRpc'
import { deepseekPatch, deepseekRouteKeys } from '../ownModelServers/deepseekPatch'
import type { ActivitySubscriptionOptions, AgentHost, AgentHostCommand, AgentHostResult, ThreadHistorySource, ThreadHostEvent,
  ThreadLaunchProfiles, ThreadReadPurpose, ThreadSessionDraft } from './host'
import { unreadableRequest } from './nativeRequests'
import { OpenSessions } from './openSessions'
import { verifyFileMentions } from './promptFiles'
import { ProviderUnavailable } from './providerProblem'
import { adapterItemCount, ProviderSnapshotPublisher } from './providerSnapshotPublisher'
import { AdapterThreadChanges, restOf } from './adapterThreadChanges'
import type { ActivityChangesListener, ActivityChangesSubscription } from './threadChanges'
import { SessionReaper } from './sessionReaper'
import { markSendStage } from './sendStages'
import { settledThinking, thinkingSettledAs } from './thinkingActivity'
import { ThreadMessageLog } from './threadMessageLog'
import { effortAfterChange, validatePromptAttachments, validateThreadOptions } from './threadOptions'
import { scopedThreadServers, type ScopedThreadTools, type ThreadMcpServer } from './threadToolServer'
import { existingWorkingDirectory } from './threadWorktrees'
import { markTurnActivity } from './turnActivity'
import { WatcherProfileRefusal } from './watcherProfile'
import { heldProvidersOf, type HeldProviders } from '../../shared/heldProviders'

/**
 * DeepSeek Harness as a thread provider (ADR-0136): one `dsh --profile acp` process per thread, started in the
 * thread's folder with Sotto's own harness folder as `DSH_HOME` and a `--patch` overlay generated from the user's
 * own model servers, speaking ACP on stdio. The harness keeps the sessions and the tools, and runs only the user's
 * keyless servers in this version; Sotto keeps each thread's session ID, its settings and what it sent, by digest,
 * never by its words.
 *
 * A resumed session replays nothing, so a thread's history is Sotto's event store's and the adapter's log of what
 * the process said live, the way the other ACP adapters keep theirs. Replies and thoughts arrive as committed
 * messages; a message's identity is its turn and its place in the turn, so a thread resumed after a restart keeps
 * the messages and rows it showed.
 */

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const attachmentSchema = z.object({ id: z.string(), name: z.string(), mimeType: z.string(), sizeBytes: z.number() })
/** One message Sotto sent: its identities, the digest of what the harness was given, and its turn's place. */
const originSchema = z.object({ messageId: z.string(), commandId: z.string(), digest: z.string(), createdAt: z.string(), turn: z.number().int().nonnegative(),
  attachments: z.array(attachmentSchema).default([]) })
type Origin = z.infer<typeof originSchema>
const aliasSchema = z.object({
  deepseekSessionId: z.string().min(1).max(512).optional(), projectId: z.string(), cwd: z.string(), title: z.string(), createdAt: z.string(),
  modelId: z.string(), reasoningEffort: z.string().optional(), runtimeMode: z.enum(DEEPSEEK_RUNTIME_MODES).default('auto-accept-edits'),
  /** How many user turns the session holds, as Sotto last counted them: the place the next prompt takes. */
  turns: z.number().int().nonnegative().default(0),
  origins: z.array(originSchema).default([]), answeredRequestIds: z.array(z.string()).default([]),
})
type Alias = z.infer<typeof aliasSchema>
const ANSWERED_KEPT = 128
/** A thread's saved origins and answered requests, indexed from its record once, the way Cursor's are. */
class ThreadIndex {
  private readonly byCommand = new Map<string, Origin>()
  private readonly byMessage = new Map<string, Origin>()
  private readonly answered: Set<string>
  constructor(readonly alias: Alias) {
    for (const origin of alias.origins) this.index(origin)
    if (alias.answeredRequestIds.length > ANSWERED_KEPT) alias.answeredRequestIds = alias.answeredRequestIds.slice(-ANSWERED_KEPT)
    this.answered = new Set(alias.answeredRequestIds)
  }
  private index(origin: Origin): void { this.byCommand.set(origin.commandId, origin); this.byMessage.set(origin.messageId, origin) }
  sent(commandId: string, messageId: string): Origin | undefined { return this.byCommand.get(commandId) ?? this.byMessage.get(messageId) }
  add(origin: Origin): void { this.alias.origins.push(origin); this.index(origin) }
  remove(origin: Origin): void {
    const at = this.alias.origins.lastIndexOf(origin)
    if (at >= 0) this.alias.origins.splice(at, 1)
    if (this.byCommand.get(origin.commandId) === origin) this.byCommand.delete(origin.commandId)
    if (this.byMessage.get(origin.messageId) === origin) this.byMessage.delete(origin.messageId)
  }
  wasAnswered(requestId: string): boolean { return this.answered.has(requestId) }
  answer(requestId: string): void {
    if (this.answered.has(requestId)) return
    this.answered.add(requestId); this.alias.answeredRequestIds.push(requestId)
    while (this.alias.answeredRequestIds.length > ANSWERED_KEPT) this.answered.delete(this.alias.answeredRequestIds.shift()!)
  }
  unanswer(requestId: string): void {
    if (!this.answered.delete(requestId)) return
    const at = this.alias.answeredRequestIds.lastIndexOf(requestId)
    if (at >= 0) this.alias.answeredRequestIds.splice(at, 1)
  }
}
const initializeSchema = z.object({ protocolVersion: z.number(), agentCapabilities: z.object({
  mcpCapabilities: z.object({ http: z.boolean().optional() }).passthrough().optional(),
  promptCapabilities: z.object({ image: z.boolean().optional() }).passthrough().optional(),
  sessionCapabilities: z.object({ resume: z.unknown().optional(), close: z.unknown().optional() }).passthrough().optional(),
}).passthrough() }).passthrough()
const sessionNewSchema = z.object({ sessionId: z.string().min(1).max(512) }).passthrough()
const promptAnswerSchema = z.object({ stopReason: z.string() }).passthrough()
const PROCESS_LOST = 'DeepSeek Harness stopped before this reply finished, so it may be cut short. Send a message to carry on.'
/** What Sotto says once to a thread that comes with Auto-accept edits, whose asking stops at the sandbox boundary (ADR-0136). */
export const DEEPSEEK_ALLOW_EDITS_NOTICE = 'On DeepSeek Harness, Auto-accept edits runs commands and network inside the workspace sandbox without asking. It asks before anything crosses that boundary.'
/** What Sotto says once to a thread that comes with Ask for approval on DeepSeek Harness (ADR-0136). */
export const DEEPSEEK_ASK_NOTICE = 'On DeepSeek Harness, Ask for approval denies a first attempt and the model then asks to retry it. A model that does not ask simply fails the write.'

/**
 * Where each update of one turn belongs. Replies are counted by segment, broken by a tool or a thought; tools and
 * thoughts in order. A turn is keyed by its user message.
 */
class TurnPlaces {
  private replies = 0; private thoughts = 0; private tools = 0
  private readonly toolKeys = new Map<string, string>()
  private current: 'reply' | 'thought' | undefined
  constructor(readonly key: string) {}
  reply(): { id: string; opened: boolean } {
    const opened = this.current !== 'reply'
    if (opened) { this.current = 'reply'; this.replies++ }
    return { id: `deepseek-reply-${this.key}-${this.replies - 1}`, opened }
  }
  thought(): string {
    if (this.current !== 'thought') { this.current = 'thought'; this.thoughts++ }
    return `${this.key}-${this.thoughts - 1}`
  }
  tool(nativeId: string, opens: boolean): string {
    let key = this.toolKeys.get(nativeId)
    if (!key) { key = `${this.key}-${this.tools++}`; this.toolKeys.set(nativeId, key) }
    if (opens) this.current = undefined
    return key
  }
}
/** The turn a thread is on, as its own stream reports it. `taken` once the harness showed it is working on a prompt Sotto sent. */
interface LiveTurn {
  readonly places: TurnPlaces
  readonly origin: Origin | undefined
  taken: boolean
  ended: boolean
  wake: (() => void) | undefined
}
/** One thread's own harness process: its patch and client revisions, its mode, and what its session last said. */
interface Connection {
  readonly rpc: DeepSeekRpc
  readonly nonce: string
  readonly clientRevision: number
  readonly patchRevision: number
  readonly mode: AgentRuntimeMode
  closing: boolean
  /** The model and effort this process's session is on, as the harness last said. */
  model: string | undefined
  effort: string | undefined
  /** The tool calls this process has shown, by ID: a permission request names only its call, and its card is built from this. */
  tools: Map<string, DeepSeekToolDetail>
}
type Pending = DeepSeekPending & { readonly connection: Connection }

export interface DeepSeekAcpOptions {
  /** The `dsh` to start, in place of finding the user's own: a test's fake client. */
  executable?: string
  /** Extra arguments ahead of `--profile`: a test's fake client process. */
  executableArgs?: readonly string[]
  environment?: NodeJS.ProcessEnv
  /** Sotto's DeepSeek Harness folder (ADR-0136): `<userData>/deepseek` by default. */
  homeDirectory?: string
  /** The user's own model servers, read at connect and again when the record changes. */
  servers?: () => Promise<readonly OwnServer[]>
  /** The providers held back in this build, which the Watcher refusal names among the admitted. */
  heldProviders?: HeldProviders
  requestTimeoutMs?: number
  startTimeoutMs?: number
  reaperSweepMs?: number
  sessionIdleMs?: number
}

export class DeepSeekAcpHost implements AgentHost {
  private readonly aliasStore: AtomicJsonStore<Record<string, Alias>>
  private readonly projectStore: AtomicJsonStore<AgentHostSnapshot['projects']>
  private aliases: Record<string, Alias> = {}
  private readonly indexes = new Map<string, ThreadIndex>()
  private readonly threads = new Map<string, AgentThread>()
  private readonly connections = new Map<string, Connection>()
  private readonly loading = new Map<string, Promise<Connection>>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly turns = new Map<string, LiveTurn>()
  private readonly pending = new Map<string, Pending>()
  private readonly dispatching = new Set<string>()
  private readonly observed = new Set<string>()
  private readonly outdated = new Set<string>()
  private readonly processes = new Set<DeepSeekRpc>()
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private readonly activityListeners = new ActivitySubscribers()
  /** Thread changes (ADR-0016, #925), published beside the activity snapshots from the same view. */
  private readonly threadChanges = new AdapterThreadChanges({
    view: historyFromEvents => this.activitySnapshot(historyFromEvents),
    thread: (id, historyFromEvents) => this.activityThread(id, historyFromEvents),
    rest: () => { certifyActivityView(this.state, []); return restOf(this.state) },
  })
  private readonly log = new ThreadMessageLog(id => this.threadChanges.mark(id))
  private readonly loaded = new OpenSessions(id => this.threads.get(id), id => this.threadChanges.mark(id))
  private readonly publisher = new ProviderSnapshotPublisher(() => {
    for (const listener of this.listeners) listener(this.current())
    this.activityListeners.publish(historyFromEvents => this.activitySnapshot(historyFromEvents))
    this.threadChanges.publish()
  }, () => adapterItemCount(this.log, this.threads.values()))
  private readonly reaper: SessionReaper
  private history: ThreadHistorySource | undefined
  private launchProfiles: ThreadLaunchProfiles | undefined
  private browserTools: BrowserAgentTools | undefined
  private threadTools: readonly ScopedThreadTools[] = []
  private executable: string | undefined
  private clientRevision = 0
  private patchRevision = 0
  private patchText: string | undefined
  private servers: readonly OwnServer[] = []
  private httpToolServers = false
  private generation = 0
  private writing = Promise.resolve()
  private state: AgentHostSnapshot = { connected: false, name: 'DeepSeek Harness', version: '', projects: [], models: [], threads: [],
    capabilities: { projects: true, threads: true, submit: true, observe: true, questions: false, permissions: true, interrupt: true, messageOrigin: true,
      reconcile: true, configureThread: true, configureThreadModel: true, skills: false, steer: false, compact: false } }
  private readonly homeDirectory: string
  private readonly patchPath: string

  constructor(private readonly userDataDirectory: string, private readonly options: DeepSeekAcpOptions = {}) {
    this.homeDirectory = options.homeDirectory ?? join(userDataDirectory, 'deepseek')
    this.patchPath = join(this.homeDirectory, 'sotto-acp.patch.yml')
    this.aliasStore = new AtomicJsonStore(join(userDataDirectory, 'deepseek-threads.json'), z.record(z.string(), aliasSchema).parse, () => ({}))
    this.projectStore = new AtomicJsonStore(join(userDataDirectory, 'deepseek-projects.json'), z.array(agentProjectSchema).parse, () => [])
    this.reaper = new SessionReaper({
      ...(options.reaperSweepMs === undefined ? {} : { sweepEveryMs: options.reaperSweepMs }),
      ...(options.sessionIdleMs === undefined ? {} : { idleAfterMs: options.sessionIdleMs }),
      isWatched: id => this.observed.has(id),
      isBusy: id => this.busy(id),
      stop: id => this.stopSession(id),
    })
  }

  // ---- What the adapter publishes ------------------------------------------------------------------------------------

  private current(historyFromEvents = false): AgentHostSnapshot {
    if (historyFromEvents) return cloneActivitySnapshot(this.activitySnapshot(true))
    return cloneHostSnapshot({ ...this.state, threads: [...this.threads.values()].map(thread => this.log.publishedThread(thread)) })
  }
  private activitySnapshot(historyFromEvents: boolean): AgentHostSnapshot {
    certifyActivityView(this.state, this.threads.values())
    return { ...this.state, threads: [...this.threads.values()].map(thread => this.log.activityThread(thread, historyFromEvents)) }
  }
  /** One thread as `activitySnapshot` lists it, for the thread changes of the threads marked changed. */
  private activityThread(id: string, historyFromEvents: boolean): AgentThread | undefined {
    const thread = this.threads.get(id)
    if (!thread) return undefined
    certifyActivityView(this.state, [thread])
    return this.log.activityThread(thread, historyFromEvents)
  }
  /**
   * This thread's state changed (ADR-0016, #925): its next thread changes carry it. `thread` marks the thread it hands
   * out, and a path that writes without it, or after an await, marks it where it writes.
   */
  private changed(id: string): void { this.threadChanges.mark(id) }
  private emit(streaming = false): void { this.publisher.publish(streaming); this.stopOutdated() }
  /** Sotto's DeepSeek Harness folder, which every process runs as `DSH_HOME` (ADR-0136). */
  get folder(): string { return this.homeDirectory }
  isConnected(): boolean { return this.state.connected }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
    return this.activityListeners.add(listener, options)
  }
  subscribeActivityChanges(listener: ActivityChangesListener, options?: ActivitySubscriptionOptions): ActivityChangesSubscription {
    return this.threadChanges.subscribeActivityChanges(listener, options)
  }
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void { return this.log.subscribeEvents(listener) }
  useThreadHistory(source: ThreadHistorySource): void { this.history = source }
  useLaunchProfiles(profiles: ThreadLaunchProfiles): void { this.launchProfiles = profiles }
  useBrowserTools(tools: BrowserAgentTools): void { this.browserTools = tools }
  useThreadTools(tools: readonly ScopedThreadTools[]): void { this.threadTools = tools }
  private persist(): Promise<void> { this.writing = this.aliasStore.write(this.aliases); return this.writing }
  private indexOf(id: string, alias: Alias): ThreadIndex {
    let index = this.indexes.get(id)
    if (!index || index.alias !== alias) { index = new ThreadIndex(alias); this.indexes.set(id, index) }
    return index
  }
  private thread(id: string): AgentThread {
    const alias = this.aliases[id]
    if (!alias) throw new Error('This DeepSeek Harness thread does not exist.')
    let thread = this.threads.get(id)
    if (!thread) {
      thread = { id, projectId: alias.projectId, title: alias.title, workingDirectory: alias.cwd, modelId: alias.modelId, runtimeMode: alias.runtimeMode,
        ...(alias.reasoningEffort ? { reasoningEffort: alias.reasoningEffort } : {}),
        status: alias.deepseekSessionId ? 'idle' : 'error', messages: [], requests: [] }
      this.threads.set(id, thread)
      if (this.connections.has(id) && !this.loading.has(id)) this.loaded.add(id)
    }
    this.changed(id)
    return thread
  }
  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new DeepSeekUncertain('DeepSeek Harness’s connection changed before this could finish.')
  }

  /**
   * DeepSeek Harness cannot host Watcher in this version: its ACP surface carries no instructions channel and its
   * sandbox asks only at its boundary, so a Watcher thread is refused before its process starts (ADR-0136).
   */
  private async refuseWatcher(id: string): Promise<void> {
    const generation = this.generation
    let profile
    try { profile = await this.launchProfiles?.profileFor(id) }
    catch (error) {
      if (generation !== this.generation) throw new DeepSeekUncertain('DeepSeek Harness’s connection changed.')
      throw error instanceof WatcherProfileRefusal ? error : new WatcherProfileRefusal('Watcher’s saved profile could not be verified. Nothing was sent.')
    }
    if (generation !== this.generation) throw new DeepSeekUncertain('DeepSeek Harness’s connection changed.')
    if (!profile) return
    const reason = `DeepSeek Harness cannot host Watcher. Nothing was sent. Choose a ${watcherProvidersInWords(this.options.heldProviders ?? heldProvidersOf({}))} model for Watcher.`
    try { profile.revoke(reason) } catch { /* The refusal stands either way. */ }
    throw new WatcherProfileRefusal(reason)
  }

  /** Sotto's own tool servers for this thread, each with the thread's Bearer [REDACTED], as the other ACP adapters pass them. */
  private async toolServers(id: string): Promise<ThreadMcpServer[]> {
    if (!this.httpToolServers) return []
    const servers: ThreadMcpServer[] = []
    if (this.browserTools) servers.push(await this.browserTools.mcpServer(id))
    for (const { server } of await scopedThreadServers(this.threadTools, id)) servers.push(server)
    return servers
  }

  // ---- Processes -----------------------------------------------------------------------------------------------------

  private environment(mode: AgentRuntimeMode): NodeJS.ProcessEnv {
    return deepseekEnvironment(this.homeDirectory, deepseekSandboxMode(mode), deepseekRouteKeys(this.servers), this.options.environment)
  }
  private spawn(args: readonly string[], cwd: string, mode: AgentRuntimeMode, receive: (frame: DeepSeekFrame, rpc: DeepSeekRpc) => Promise<void> | void, lost: () => void): DeepSeekRpc {
    const rpc: DeepSeekRpc = new DeepSeekRpc(this.executable!, args, cwd, this.environment(mode), this.options.requestTimeoutMs ?? 30_000, frame => receive(frame, rpc), lost)
    this.processes.add(rpc); void rpc.closed.then(() => this.processes.delete(rpc))
    return rpc
  }
  private async handshake(rpc: DeepSeekRpc): Promise<void> {
    let protocol: number | undefined
    await rpc.request('initialize', { protocolVersion: DEEPSEEK_ACP_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'sotto', version: appVersion } }, value => {
      const client = initializeSchema.parse(value)
      protocol = client.protocolVersion
      this.httpToolServers = client.agentCapabilities.mcpCapabilities?.http === true
    }, false, this.options.startTimeoutMs ?? 30_000)
    if (protocol !== DEEPSEEK_ACP_VERSION) throw new ProviderUnavailable('cannot-start', `Sotto speaks ACP ${DEEPSEEK_ACP_VERSION}, and this DeepSeek Harness client answered ACP ${protocol}.`)
  }
  /** The overlay from the current record, written whenever it changed: a record change makes processes outdated. */
  private async writePatch(): Promise<void> {
    const text = deepseekPatch(this.servers)
    if (text === this.patchText) return
    if (text) await writeFile(this.patchPath, text, 'utf8')
    this.patchText = text
  }
  /** This thread's own process, started in the thread's permission mode with the current overlay, ready for a session. */
  private async startProcess(id: string, alias: Alias, cwd: string): Promise<Connection> {
    if (!this.executable || !this.state.connected) throw new Error('Connect DeepSeek Harness before using its threads.')
    await this.writePatch()
    const connection: Connection = { rpc: undefined as unknown as DeepSeekRpc, nonce: randomUUID(), clientRevision: this.clientRevision,
      patchRevision: this.patchRevision, mode: alias.runtimeMode, closing: false, model: undefined, effort: undefined, tools: new Map() }
    const rpc = this.spawn([...(this.options.executableArgs ?? []), '--profile', 'acp', '--patch', this.patchPath], cwd, alias.runtimeMode, frame => this.frame(id, connection, frame), () => this.processLost(id, connection))
    ;(connection as { rpc: DeepSeekRpc }).rpc = rpc
    try { await this.handshake(rpc) }
    catch (error) { connection.closing = true; rpc.close(); throw error }
    return connection
  }
  private close(connection: Connection): void { connection.closing = true; connection.rpc.close() }

  // ---- Connecting ----------------------------------------------------------------------------------------------------

  async connect(): Promise<AgentHostSnapshot> {
    this.disconnect(); await this.closed()
    const generation = this.generation
    try {
      await mkdir(this.homeDirectory, { recursive: true })
      const executable = this.options.executable ?? await findDeepSeekExecutable(this.options.environment)
      if (!executable || !isAbsolute(executable)) throw new ProviderUnavailable('not-installed', 'Install DeepSeek Harness, then connect it again. Your threads are kept.')
      const version = await readDeepSeekVersion(executable, this.options.environment ?? process.env, this.options.executableArgs ?? [])
      this.assertGeneration(generation)
      if (compareDeepSeekVersions(version, DEEPSEEK_CLI_VERSION) < 0) throw new ProviderUnavailable('too-old', `DeepSeek Harness ${DEEPSEEK_CLI_VERSION} or newer is needed, and this one is ${version}. Update it, then connect again. Your threads are kept.`, version, DEEPSEEK_CLI_VERSION)
      this.servers = await this.options.servers?.() ?? []
      this.assertGeneration(generation)
      const models = deepseekCatalog(this.servers)
      if (!models.length) throw new ProviderUnavailable('signed-out', 'DeepSeek Harness runs your own model servers, and none it can run is saved yet. Add one under Your own model servers, then connect again. Your threads are kept.', version)
      this.executable = executable
      await this.writePatch()
      const [aliases, projects] = await Promise.all([this.aliasStore.read(), this.projectStore.read()])
      this.assertGeneration(generation)
      this.aliases = aliases; this.indexes.clear(); this.state.projects = projects; this.state.models = models
      this.threads.clear(); this.threadChanges.markAll(); this.log.forgetAll()
      for (const id of Object.keys(this.aliases)) { this.thread(id); this.log.seed(id, this.history?.messageIdentities(id) ?? []) }
      this.state.connected = true; this.state.version = `${version} / ACP ${DEEPSEEK_ACP_VERSION}`
      delete this.state.error; delete this.state.problem; delete this.state.requiredVersion
      if (compareDeepSeekVersions(version, DEEPSEEK_CLI_VERSION) > 0) this.state.verifiedVersion = DEEPSEEK_CLI_VERSION
      else delete this.state.verifiedVersion
      // A thread that cannot open is that thread's error, not the provider's: the rest stay usable.
      await Promise.all([...this.observed].filter(id => this.aliases[id]?.deepseekSessionId).map(id => this.open(id).catch((error: unknown) => {
        if (generation !== this.generation) return
        this.markOpenFailed(id, error)
      })))
      this.assertGeneration(generation)
      this.reaper.start(); this.emit(); return this.current()
    } catch (error) {
      if (generation === this.generation) this.disconnect()
      if (error instanceof WatcherProfileRefusal) throw error
      const refused = error instanceof ProviderUnavailable
      const detail = refused || error instanceof DeepSeekUncertain ? error.message : error instanceof Error && /^Sotto could not read/u.test(error.message) ? error.message : ''
      const message = ['Could not connect DeepSeek Harness.', detail, refused ? '' : 'Connect again to retry.'].filter(Boolean).join(' ')
      if (refused) throw new ProviderUnavailable(error.problem, message, error.version, error.requiredVersion)
      throw new Error(message, { cause: error })
    }
  }
  private markOpenFailed(id: string, error: unknown): void {
    if (!this.aliases[id]) return
    this.thread(id).status = 'error'
    this.state.error = error instanceof Error && error.message ? error.message : 'A DeepSeek Harness thread could not be opened. Your thread is kept. Reconnect DeepSeek Harness to try again.'
    this.emit()
  }
  /**
   * The user's own model servers changed: the catalog is rebuilt and every running process, started with the old
   * overlay, is outdated, moving to a fresh one as it goes idle. Never awaits the provider, so a failed read
   * leaves the last good catalog.
   */
  ownServersChanged(): void {
    this.patchRevision++
    for (const [id, connection] of this.connections) if (connection.patchRevision < this.patchRevision) this.outdated.add(id)
    if (!this.state.connected) return
    const generation = this.generation
    void (async () => {
      this.servers = await this.options.servers?.() ?? this.servers
      if (generation !== this.generation) return
      this.state.models = deepseekCatalog(this.servers)
      this.emit()
    })().catch(() => undefined)
    this.stopOutdated()
  }
  /**
   * DeepSeek Harness's client on disk was updated while Sotto stayed connected (ADR-0042, ADR-0038): find it again
   * and hold it to the floor; every new process starts from it, and each thread moves onto it as it goes idle.
   */
  async clientUpdated(): Promise<void> {
    if (!this.state.connected) return
    const generation = this.generation
    const executable = this.options.executable ?? await findDeepSeekExecutable(this.options.environment).catch(() => undefined)
    if (generation !== this.generation || !this.state.connected) return
    if (!executable) throw new Error('DeepSeek Harness was updated, but Sotto cannot find it now. Threads that are working carry on and nothing was lost. Check DeepSeek Harness, then connect it again.')
    let version: string
    try { version = await readDeepSeekVersion(executable, this.options.environment ?? process.env, this.options.executableArgs ?? []) }
    catch (error) {
      if (generation !== this.generation || !this.state.connected) return
      throw new Error('DeepSeek Harness was updated, but the new version did not answer. Threads that are working carry on and nothing was lost. Connect DeepSeek Harness again to try the new version.', { cause: error })
    }
    if (generation !== this.generation || !this.state.connected) return
    if (compareDeepSeekVersions(version, DEEPSEEK_CLI_VERSION) < 0) throw new Error(`DeepSeek Harness was updated, but Sotto cannot run ${version}: ${DEEPSEEK_CLI_VERSION} or newer is needed. Threads that are working carry on and nothing was lost.`)
    this.executable = executable; this.clientRevision++
    this.state.version = `${version} / ACP ${DEEPSEEK_ACP_VERSION}`
    if (compareDeepSeekVersions(version, DEEPSEEK_CLI_VERSION) > 0) this.state.verifiedVersion = DEEPSEEK_CLI_VERSION
    else delete this.state.verifiedVersion
    for (const [id, connection] of this.connections) if (connection.clientRevision < this.clientRevision) this.outdated.add(id)
    this.emit()
  }
  /** Stop each outdated process whose thread is not busy; a watched one opens again at once on the new client or overlay. */
  private stopOutdated(): void {
    if (!this.outdated.size) return
    for (const id of [...this.outdated]) {
      const connection = this.connections.get(id)
      if (!connection || (connection.clientRevision === this.clientRevision && connection.patchRevision === this.patchRevision)) { this.outdated.delete(id); continue }
      if (this.busy(id)) continue
      this.outdated.delete(id)
      const generation = this.generation
      void this.stopSession(id).then(() => {
        if (generation === this.generation && this.observed.has(id) && this.aliases[id]?.deepseekSessionId) return this.open(id).then(() => undefined)
      }).catch((error: unknown) => { if (generation === this.generation) this.markOpenFailed(id, error) })
    }
  }

  // ---- Sessions ------------------------------------------------------------------------------------------------------

  /** A thread being created or sent to, a prompt in flight, a session opening or an unanswered request hold a session open. */
  private busy(id: string): boolean {
    const turn = this.turns.get(id)
    return this.dispatching.has(id) || this.loading.has(id) || this.stopping.has(id) || (turn !== undefined && !turn.ended)
      || (this.threads.get(id)?.requests.length ?? 0) > 0
  }
  /** This thread's session, opened on its own process when it has none. */
  private open(id: string): Promise<Connection> {
    const stopping = this.stopping.get(id)
    if (stopping) return stopping.then(() => this.open(id))
    const loading = this.loading.get(id); if (loading) return loading
    const existing = this.connections.get(id); if (existing) return Promise.resolve(existing)
    const work = this.load(id).finally(() => { if (this.loading.get(id) === work) { this.loading.delete(id); if (this.connections.has(id)) { this.loaded.add(id); this.emit() } } })
    this.loading.set(id, work)
    return work
  }
  private async load(id: string): Promise<Connection> {
    const generation = this.generation
    await this.refuseWatcher(id)
    this.assertGeneration(generation)
    const alias = this.aliases[id]
    if (!alias?.deepseekSessionId) throw new Error('DeepSeek Harness did not confirm this thread’s session. Your thread is kept. Start a new thread to carry on.')
    const cwd = await existingWorkingDirectory(alias.cwd)
    this.assertGeneration(generation)
    const connection = await this.startProcess(id, alias, cwd)
    if (generation !== this.generation) { this.close(connection); throw new DeepSeekUncertain('DeepSeek Harness’s connection changed while the thread was opening.') }
    this.connections.set(id, connection)
    try {
      const mcpServers = await this.toolServers(id)
      this.assertGeneration(generation)
      // A resumed session replays nothing (ADR-0136): the thread's history stays Sotto's, and the session continues.
      await connection.rpc.request('session/resume', { sessionId: alias.deepseekSessionId, cwd: alias.cwd, mcpServers }, value => { this.readSettings(connection, value) })
      if (generation !== this.generation || this.connections.get(id) !== connection) throw new DeepSeekUncertain('DeepSeek Harness’s connection changed while the thread was opening.')
      await this.applySettings(alias, connection)
      this.log.pin(id); this.reaper.touch(id)
      const thread = this.thread(id)
      if (!this.turns.get(id) || this.turns.get(id)!.ended) thread.status = 'idle'
      return connection
    } catch (error) {
      if (this.connections.get(id) === connection) this.connections.delete(id)
      this.close(connection)
      if (error instanceof DeepSeekRejected) throw new Error('DeepSeek Harness could not open this thread’s saved session. Your Sotto history is kept. Start a new thread to carry on; Sotto will not resend earlier work.', { cause: error })
      throw error
    }
  }
  /** Stop this thread's session: its process ends, and the next action starts one and resumes the session again. */
  private stopSession(id: string): Promise<void> {
    const previous = this.stopping.get(id); if (previous) return previous
    const connection = this.connections.get(id)
    if (!connection) return Promise.resolve()
    const work = (async () => {
      this.connections.delete(id); this.outdated.delete(id)
      if (this.loaded.delete(id)) this.emit()
      this.log.release(id); this.reaper.forget(id)
      this.close(connection); await connection.rpc.closed
    })().finally(() => { if (this.stopping.get(id) === work) this.stopping.delete(id) })
    this.stopping.set(id, work)
    return work
  }
  /** A thread's process ended without Sotto asking: only that thread is affected, and the next action starts a new one. */
  private processLost(id: string, connection: Connection): void {
    if (connection.closing || this.connections.get(id) !== connection) return
    this.connections.delete(id); this.outdated.delete(id); this.loaded.delete(id); this.log.release(id); this.reaper.forget(id)
    this.clearRequests(id)
    this.endTurn(id, 'failed', PROCESS_LOST)
    this.emit()
  }
  async startThreadSession(id: string, draft?: ThreadSessionDraft): Promise<void> {
    void draft
    const generation = this.generation
    await this.refuseWatcher(id)
    this.assertGeneration(generation)
    // A thread whose first send has not happened has no session to open; making one is the send's to do.
    if (!this.state.connected || !this.aliases[id]?.deepseekSessionId) return
    await this.open(id)
    this.reaper.touch(id)
  }
  observeThreads(ids: readonly string[]): void {
    this.observed.clear(); for (const id of ids) this.observed.add(id)
    this.log.observe(ids)
    if (!this.state.connected) return
    const generation = this.generation
    for (const id of ids) if (this.aliases[id]?.deepseekSessionId) void this.open(id).catch((error: unknown) => { if (generation === this.generation) this.markOpenFailed(id, error) })
  }
  async snapshot(): Promise<AgentHostSnapshot> { return this.current() }
  async refreshThread(id: string, purpose?: ThreadReadPurpose): Promise<AgentHostSnapshot> {
    if (!this.aliases[id]?.deepseekSessionId) throw new Error('This DeepSeek Harness thread has no confirmed session.')
    const generation = this.generation
    await this.refuseWatcher(id)
    this.assertGeneration(generation)
    await this.open(id)
    return this.current(purpose?.historyFromEvents)
  }

  // ---- What the harness says -------------------------------------------------------------------------------------------

  /** The model and effort a session answer names, as the harness last said them. */
  private readSettings(connection: Connection, value: unknown): void {
    const settings = deepseekSettingsOf(value)
    if (settings.model !== undefined) connection.model = settings.model
    connection.effort = settings.effort
  }
  /** Every frame from one thread's process. A request is answered on the process that asked, never another. */
  private frame(id: string, connection: Connection, frame: DeepSeekFrame): void {
    const alias = this.aliases[id]
    if (!alias || connection.closing) return
    const params = record(frame.params)
    if (frame.method === 'session/update') {
      if (!params || (alias.deepseekSessionId && params.sessionId !== alias.deepseekSessionId)) return
      const update = record(params.update)
      if (!update || this.connections.get(id) !== connection) return
      this.liveUpdate(id, alias, update)
      return
    }
    if (!frame.method || frame.id === undefined) return
    if (this.connections.get(id) !== connection) { connection.rpc.refuse(frame.id); return }
    this.taken(id)
    const toolCallId = typeof record(params?.toolCall)?.toolCallId === 'string' ? record(params?.toolCall)!.toolCallId as string : undefined
    const asked = deepseekPending(frame.id, frame.method, frame.params, id, toolCallId ? connection.tools.get(toolCallId) : undefined)
    if (!asked) {
      connection.rpc.refuse(frame.id)
      const notice = unreadableRequest('DeepSeek Harness'); const thread = this.thread(id)
      thread.requestNotice = notice; this.state.error = notice; this.emit()
      return
    }
    if (alias.deepseekSessionId && params?.sessionId !== alias.deepseekSessionId) { connection.rpc.refuse(frame.id); return }
    const requestId = `deepseek-request-${digest(JSON.stringify([id, connection.nonce, frame.id]))}`
    const pending: Pending = { ...asked, request: { ...asked.request, id: requestId }, connection }
    if (this.pending.has(requestId)) return
    if (this.indexOf(id, alias).wasAnswered(requestId)) { void connection.rpc.reply(frame.id, deepseekDecline(pending)).catch(() => undefined); return }
    if (this.pending.size >= 128) { void connection.rpc.reply(frame.id, deepseekDecline(pending)).catch(() => undefined); return }
    this.pending.set(requestId, pending)
    this.thread(id).requests.push(pending.request)
    this.reaper.touch(id); this.emit()
  }
  /** A live update from the thread's own stream: its reply, its work, its context, or something typed into the session elsewhere. */
  private liveUpdate(id: string, alias: Alias, update: Record<string, unknown>): void {
    this.reaper.touch(id)
    const kind = String(update.sessionUpdate)
    if (kind === 'config_option_update') {
      const connection = this.connections.get(id)
      if (connection) this.readSettings(connection, update)
      return
    }
    if (kind === 'usage_update') {
      this.taken(id)
      const used = typeof update.used === 'number' && Number.isFinite(update.used) && update.used >= 0 ? Math.round(update.used) : undefined
      const size = typeof update.size === 'number' && Number.isFinite(update.size) && update.size > 0 ? Math.round(update.size) : undefined
      if (used !== undefined || size !== undefined) {
        const thread = this.thread(id)
        const now = new Date().toISOString()
        // Fullness only: the harness reports no token counts, so the ledger stays partial and outside Usage.
        thread.usage = { rateVersions: [], partial: true, ...thread.usage,
          ...(used !== undefined ? { contextUsed: used } : {}), ...(size !== undefined ? { contextWindow: size } : {}),
          contextUpdatedAt: now, updatedAt: now }
        this.emit(true)
      }
      return
    }
    // A permission card is built from the tool update before it, so every shown call is buffered by its ID.
    if ((kind === 'tool_call' || kind === 'tool_call_update') && typeof update.toolCallId === 'string') {
      const connection = this.connections.get(id)
      if (connection) {
        const previous = connection.tools.get(update.toolCallId)
        connection.tools.set(update.toolCallId, {
          title: typeof update.title === 'string' ? update.title : previous?.title,
          rawInput: update.rawInput !== undefined ? update.rawInput : previous?.rawInput,
        })
        if (connection.tools.size > 512) connection.tools.delete(connection.tools.keys().next().value!)
      }
    }
    if (!['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(kind)) { this.taken(id); return }
    const content = record(update.content)
    const words = content?.type === 'text' && typeof content.text === 'string' ? content.text : undefined
    if (kind === 'user_message_chunk') {
      if (words === undefined) return
      const turn = this.turns.get(id)
      // The harness does not echo a prompt; one that comes back anyway is the prompt Sotto sent, not new input.
      if (turn?.origin && !turn.taken && digest(words) === turn.origin.digest) { this.taken(id); return }
      // Something typed into this session elsewhere starts a turn of its own.
      const index = alias.turns; alias.turns++
      void this.persist().catch(() => undefined)
      const key = `deepseek-user-${index}-${digest(words).slice(0, 16)}`
      this.log.add(id, { id: key, role: 'user', text: words, createdAt: new Date().toISOString() })
      this.turns.set(id, { places: new TurnPlaces(key), origin: undefined, taken: true, ended: true, wake: undefined })
      this.emit()
      return
    }
    this.taken(id)
    let turn = this.turns.get(id)
    if (!turn) {
      turn = { places: new TurnPlaces(this.log.lastUserMessageId(id) ?? 'deepseek-history'), origin: undefined, taken: true, ended: true, wake: undefined }
      this.turns.set(id, turn)
    }
    const thread = this.thread(id)
    if (kind === 'agent_message_chunk') {
      if (words === undefined) return
      const reply = turn.places.reply()
      if (reply.opened || !this.log.has(id, reply.id)) {
        this.log.add(id, { id: reply.id, role: 'assistant', text: words, createdAt: new Date().toISOString(), turnMessageId: turn.places.key })
        const settled = settledThinking(DEEPSEEK_THINKING_ID_PREFIX, thread.activities ?? [], 'completed', true)
        if (settled.length) thread.activities = mergeAgentActivities(thread.activities, settled)
        this.emit()
      } else { this.log.appendText(id, reply.id, words); this.emit(true) }
      return
    }
    const key = kind === 'agent_thought_chunk' ? turn.places.thought()
      : typeof update.toolCallId === 'string' && (kind === 'tool_call' || kind === 'tool_call_update') ? turn.places.tool(update.toolCallId, kind === 'tool_call') : undefined
    const rows = deepseekActivities(update, { turnId: turn.places.key, afterMessageId: this.log.lastMessageId(id), cwd: alias.cwd, key }, thread.activities, true)
    if (rows.length) { thread.activities = mergeAgentActivities(thread.activities, rows); this.emit(kind === 'agent_thought_chunk') }
  }
  /** The harness has shown it is working on the prompt Sotto sent: the send waiting on it is woken. */
  private taken(id: string): void {
    const turn = this.turns.get(id)
    if (turn && !turn.taken) { turn.taken = true; turn.wake?.() }
  }
  /** A turn ended: how, its thoughts settled, and the thread ready for the next prompt. */
  private endTurn(id: string, status: 'completed' | 'interrupted' | 'failed', error?: string): void {
    const turn = this.turns.get(id)
    if (!turn || turn.ended) return
    turn.ended = true; turn.taken = true; turn.wake?.()
    const thread = this.threads.get(id); if (!thread) return
    thread.status = status === 'failed' ? 'error' : 'idle'
    thread.lastTurn = { id: turn.places.key, status }
    const thoughts = settledThinking(DEEPSEEK_THINKING_ID_PREFIX, thread.activities ?? [], thinkingSettledAs(status), true)
    const settled = thoughts.length ? mergeAgentActivities(thread.activities, thoughts) : thread.activities
    const closed = settled?.map(row => row.status === 'running' && row.kind !== 'turn' && row.kind !== 'plan' && row.turnId === turn.places.key
      ? { ...row, status: status === 'completed' ? 'completed' as const : status === 'interrupted' ? 'interrupted' as const : 'unknown' as const } : row)
    thread.activities = markTurnActivity(closed, { provider: 'deepseek', turnId: turn.places.key, status, ...(error ? { error } : {}) })
    this.changed(id)
    this.reaper.touch(id)
  }
  /** The thread's own server as its turn record names it (ADR-0124): every DeepSeek Harness turn runs on one. */
  private ownServerTurn(alias: Alias): OwnServerTurn | undefined {
    const route = deepseekModelRoute(alias.modelId)
    const server = route ? this.servers.find(item => item.id === route.serverId) : undefined
    if (!server || !route) return undefined
    const model = server.models.find(item => item.id === route.model)?.name ?? route.model
    let host: string
    try { host = new URL(server.address).host } catch { host = server.address }
    return { name: server.name, model, host }
  }

  // ---- Commands ------------------------------------------------------------------------------------------------------

  async execute(command: AgentHostCommand): Promise<AgentHostResult> { return this.executeGuarded(command) }
  executeFromWatcher(command: AgentHostCommand, guard: () => void): Promise<AgentHostResult> { return this.executeGuarded(command, guard) }
  private async executeGuarded(command: AgentHostCommand, watcherGuard?: () => void): Promise<AgentHostResult> {
    const generation = this.generation
    if ('threadId' in command && command.type !== 'interrupt') {
      try { await this.refuseWatcher(command.threadId) }
      catch (error) { if (error instanceof DeepSeekUncertain) return { accepted: false, uncertain: true }; throw error }
      this.assertGeneration(generation)
    }
    if (command.type === 'steer') throw new Error('DeepSeek Harness takes no message while it works. Queue this follow-up instead.')
    if (command.type === 'compact-thread') throw new Error('DeepSeek Harness cannot compact a thread.')
    if (!this.state.connected) throw new Error('Connect DeepSeek Harness before managing threads.')
    if (command.type !== 'send' && command.type !== 'create-thread') return this.run(command, generation, watcherGuard)
    if (this.dispatching.has(command.threadId)) throw new Error('DeepSeek Harness is already receiving work for this thread. Wait for its delivery result.')
    this.dispatching.add(command.threadId)
    try { return await this.run(command, generation, watcherGuard) } finally { this.dispatching.delete(command.threadId); this.stopOutdated() }
  }
  private async run(command: AgentHostCommand, generation: number, watcherGuard?: () => void): Promise<AgentHostResult> {
    try {
      if (command.type === 'create-project') {
        if (!isAbsolute(command.path)) throw new Error('DeepSeek Harness projects need an absolute folder.')
        if (!this.state.projects.some(project => project.id === command.projectId)) {
          this.state.projects.push({ id: command.projectId, title: command.title, path: command.path })
          await this.projectStore.write(this.state.projects)
        }
        this.emit(); return { accepted: true }
      }
      if (command.type === 'create-thread') return await this.create(command, generation, watcherGuard)
      if (command.type === 'configure-thread') return await this.configure(command, generation, watcherGuard)
      const id = command.threadId, alias = this.aliases[id]
      if (!alias?.deepseekSessionId) throw new Error('DeepSeek Harness did not confirm this thread’s session. Your thread is kept. Do not repeat its creation automatically.')
      if (command.type === 'interrupt') return await this.interrupt(id, alias, watcherGuard)
      const connection = await this.open(id)
      if (generation !== this.generation || this.connections.get(id) !== connection) throw new DeepSeekUncertain('DeepSeek Harness’s connection changed.')
      this.reaper.touch(id)
      if (command.type === 'send') return await this.send(command, alias, connection, generation, watcherGuard)
      if (command.type === 'answer') return await this.answer(command, alias, connection)
      throw new Error('DeepSeek Harness does not take that action.')
    } catch (error) {
      if (error instanceof DeepSeekUncertain) return { accepted: false, uncertain: true }
      throw error
    }
  }
  private runtimeModeOf(command: { runtimeMode?: AgentRuntimeMode | undefined }): AgentRuntimeMode {
    const mode = command.runtimeMode ?? 'auto-accept-edits'
    if (!DEEPSEEK_RUNTIME_MODES.includes(mode)) throw new Error('That permission mode is not supported by this provider.')
    return mode
  }
  private async create(command: Extract<AgentHostCommand, { type: 'create-thread' }>, generation: number, watcherGuard?: () => void): Promise<AgentHostResult> {
    const saved = this.aliases[command.threadId]
    if (saved) return saved.deepseekSessionId ? { accepted: true } : { accepted: false, uncertain: true }
    const runtimeMode = this.runtimeModeOf(command)
    validateThreadOptions(this.state, { ...command, runtimeMode })
    const project = this.state.projects.find(item => item.id === command.projectId)
    if (!project) throw new Error('Choose a DeepSeek Harness project first.')
    // A create that names no effort starts on the model's default and says so, so the chip names the effort it runs at.
    const reasoningEffort = command.reasoningEffort ?? this.model(command.modelId)?.defaultReasoningEffort
    const alias: Alias = { projectId: project.id, cwd: await existingWorkingDirectory(command.workingDirectory ?? project.path), title: command.title, createdAt: new Date().toISOString(),
      modelId: command.modelId, ...(reasoningEffort ? { reasoningEffort } : {}), runtimeMode, turns: 0, origins: [], answeredRequestIds: [] }
    this.assertGeneration(generation)
    const connection = await this.startProcess(command.threadId, alias, alias.cwd)
    if (generation !== this.generation) { this.close(connection); throw new DeepSeekUncertain('DeepSeek Harness’s connection changed.') }
    // The process is the thread's from here, so what it says while its session is made reaches the thread.
    this.connections.set(command.threadId, connection)
    try {
      this.aliases[command.threadId] = alias; await this.persist()
      const mcpServers = await this.toolServers(command.threadId)
      this.assertGeneration(generation)
      watcherGuard?.()
      await connection.rpc.request('session/new', { cwd: alias.cwd, mcpServers }, async value => {
        alias.deepseekSessionId = sessionNewSchema.parse(value).sessionId; this.readSettings(connection, value); await this.persist()
      })
      this.assertGeneration(generation)
      await this.applySettings(alias, connection)
    } catch (error) {
      if (this.connections.get(command.threadId) === connection) this.connections.delete(command.threadId)
      this.close(connection)
      if (this.aliases[command.threadId] === alias && alias.deepseekSessionId) this.thread(command.threadId).status = 'error'
      throw error
    }
    const thread = this.thread(command.threadId)
    thread.status = 'idle'; thread.modelId = alias.modelId; thread.runtimeMode = alias.runtimeMode
    if (alias.reasoningEffort) thread.reasoningEffort = alias.reasoningEffort
    thread.requestNotice = alias.runtimeMode === 'auto-accept-edits' ? DEEPSEEK_ALLOW_EDITS_NOTICE : alias.runtimeMode === 'approval-required' ? DEEPSEEK_ASK_NOTICE : thread.requestNotice
    this.loaded.add(command.threadId); this.log.pin(command.threadId); this.reaper.touch(command.threadId)
    this.emit(); return { accepted: true }
  }
  private model(modelId: string): AgentModel | undefined { return this.state.models.find(model => model.id === modelId) }
  /** Put the session on the thread's model and effort before a prompt that needs them, read back from the answer. */
  private async applySettings(alias: Alias, connection: Connection): Promise<void> {
    const value = deepseekModelValue(alias.modelId)
    if (value === undefined) throw new Error('This thread’s model is not one of your own model servers. Choose a model your servers offer, then send.')
    if (connection.model !== alias.modelId) {
      await connection.rpc.request('session/set_config_option', { sessionId: alias.deepseekSessionId, configId: 'model', value }, result => { this.readSettings(connection, result) })
      if (connection.model !== alias.modelId) throw new Error('DeepSeek Harness did not confirm this thread’s model. Your thread and draft are kept. Choose the model again, then send.')
    }
    const efforts = this.model(alias.modelId)?.reasoningEfforts
    if (efforts?.length && alias.reasoningEffort && connection.effort !== alias.reasoningEffort) {
      await connection.rpc.request('session/set_config_option', { sessionId: alias.deepseekSessionId, configId: 'reasoning_effort', value: alias.reasoningEffort }, result => { this.readSettings(connection, result) })
      if (connection.effort !== alias.reasoningEffort) throw new Error('DeepSeek Harness did not confirm this thread’s effort. Your thread and draft are kept. Choose the effort again, then send.')
    }
  }
  private async configure(command: Extract<AgentHostCommand, { type: 'configure-thread' }>, generation: number, watcherGuard?: () => void): Promise<AgentHostResult> {
    const id = command.threadId, alias = this.aliases[id]
    if (!alias?.deepseekSessionId) throw new Error('DeepSeek Harness did not confirm this thread’s session. Your thread is kept.')
    if (command.providerMode !== undefined) throw new Error('That permission mode is not supported by this provider.')
    const runtimeMode = command.runtimeMode === undefined ? undefined : this.runtimeModeOf(command)
    const modelId = command.modelId ?? alias.modelId
    const reasoningEffort = effortAfterChange(this.state, command, alias.reasoningEffort)
    validateThreadOptions(this.state, { modelId, ...(command.reasoningEffort !== undefined ? { reasoningEffort: command.reasoningEffort } : {}), ...(runtimeMode ? { runtimeMode } : {}) }, alias.modelId)
    const thread = this.thread(id)
    const modeChanges = runtimeMode !== undefined && runtimeMode !== alias.runtimeMode
    watcherGuard?.()
    if (modeChanges) { await this.loading.get(id)?.catch(() => undefined); await this.stopping.get(id); this.assertGeneration(generation) }
    // A process takes its sandbox when it starts, so a new mode means a new process, once the thread is quiet.
    if (modeChanges && this.busy(id)) throw new Error('DeepSeek Harness is working on this thread. Its permission mode is unchanged. Change it once the thread is idle.')
    const settingsChange = modelId !== alias.modelId || reasoningEffort !== alias.reasoningEffort
    watcherGuard?.()
    alias.modelId = modelId
    if (reasoningEffort) alias.reasoningEffort = reasoningEffort; else delete alias.reasoningEffort
    if (runtimeMode) alias.runtimeMode = runtimeMode
    await this.persist()
    this.assertGeneration(generation)
    thread.modelId = alias.modelId; thread.runtimeMode = alias.runtimeMode
    if (alias.reasoningEffort) thread.reasoningEffort = alias.reasoningEffort; else delete thread.reasoningEffort
    if (command.runtimeMode === 'auto-accept-edits') thread.requestNotice = DEEPSEEK_ALLOW_EDITS_NOTICE
    if (command.runtimeMode === 'approval-required') thread.requestNotice = DEEPSEEK_ASK_NOTICE
    this.changed(id)
    if (modeChanges && this.connections.has(id)) {
      await this.stopSession(id)
      this.assertGeneration(generation)
      if (this.observed.has(id)) void this.open(id).catch((error: unknown) => { if (generation === this.generation) this.markOpenFailed(id, error) })
    } else if (settingsChange) {
      // Model and effort reach the running session in place, before its next prompt, and are read back now.
      const connection = this.connections.get(id)
      if (connection && !this.busy(id)) await this.applySettings(alias, connection)
    }
    this.emit()
    return { accepted: true, snapshot: this.current(command.historyFromEvents) }
  }
  private async send(command: Extract<AgentHostCommand, { type: 'send' }>, alias: Alias, connection: Connection, generation: number, watcherGuard?: () => void): Promise<AgentHostResult> {
    const id = command.threadId
    const current = (): void => {
      if (generation !== this.generation || this.connections.get(id) !== connection || !this.state.connected) throw new DeepSeekUncertain('DeepSeek Harness’s connection changed. Delivery has not been confirmed.')
    }
    const index = this.indexOf(id, alias)
    const previous = index.sent(command.commandId, command.messageId)
    if (previous) {
      if (previous.messageId !== command.messageId || previous.commandId !== command.commandId) throw new Error('This DeepSeek Harness message identity is already in use.')
      return this.log.has(id, previous.messageId) ? { accepted: true } : { accepted: false, uncertain: true }
    }
    if (command.expectedLastUserMessageId !== undefined && (this.log.lastUserMessageId(id) ?? null) !== command.expectedLastUserMessageId) throw new Error('The latest user message changed. Review the thread before replying.')
    const running = this.turns.get(id)
    if (running && !running.ended) throw new Error('DeepSeek Harness is still working on this thread. Queue this follow-up.')
    if (this.thread(id).requests.length) throw new Error('Answer DeepSeek Harness’s pending request before sending another message.')
    // Images are refused here, before any bytes are read: no model on this provider advertises them in this version.
    const attachments = validatePromptAttachments(this.state, alias.modelId, command.attachments, { workingDirectory: alias.cwd })
    verifyFileMentions(command.text, command.files)
    if (command.skills?.length) throw new Error('DeepSeek Harness takes no skills from the composer in this version.')
    // Files that are not images are saved into the thread's folder and named in a note after the words (ADR-0131).
    const delivered = await deliverAttachments(alias.cwd, attachments)
    const nativeText = withAttachedFilesNote(command.text, delivered.note)
    await this.applySettings(alias, connection)
    current()
    const origin: Origin = { messageId: command.messageId, commandId: command.commandId, digest: digest(nativeText), createdAt: new Date().toISOString(), turn: alias.turns,
      attachments: attachmentReferences(attachments) }
    index.add(origin); alias.turns++
    await this.persist()
    current()
    try { watcherGuard?.() } catch (error) { index.remove(origin); alias.turns--; await this.persist(); throw error }
    const thread = this.thread(id)
    delete thread.requestNotice
    const turn: LiveTurn = { places: new TurnPlaces(origin.messageId), origin, taken: false, ended: false, wake: undefined }
    this.turns.set(id, turn)
    thread.status = 'running'; thread.lastTurn = { id: origin.messageId, status: 'running' }
    const ownServer = this.ownServerTurn(alias)
    thread.activities = markTurnActivity(thread.activities, { provider: 'deepseek', turnId: origin.messageId, status: 'running', afterMessageId: origin.messageId, ...(ownServer ? { ownServer } : {}) })
    this.emit()
    this.log.add(id, { id: origin.messageId, role: 'user', text: command.text, commandId: origin.commandId, createdAt: origin.createdAt,
      ...(origin.attachments.length ? { attachments: origin.attachments.map(ref => ({ ...ref })) } : {}) })
    this.emit()
    markSendStage(command.commandId, 'written')
    const superseded = (): boolean => generation !== this.generation || this.turns.get(id) !== turn
    void connection.rpc.request('session/prompt', { sessionId: alias.deepseekSessionId, prompt: [{ type: 'text', text: nativeText }] }, value => {
      if (superseded()) return
      const stop = promptAnswerSchema.parse(value).stopReason
      this.endTurn(id, stop === 'end_turn' ? 'completed' : stop === 'cancelled' ? 'interrupted' : stop === 'refusal' ? 'failed' : 'completed',
        stop === 'refusal' ? 'DeepSeek Harness refused this turn. Nothing else was lost.' : undefined)
      this.emit()
    }, true).catch((error: unknown) => {
      if (superseded() || turn.ended) return
      this.endTurn(id, 'failed', connection.rpc.alive ? error instanceof DeepSeekRejected ? 'DeepSeek Harness refused this message. Nothing else was lost. Check the thread’s model server, then send again.' : undefined : PROCESS_LOST)
      this.emit()
    })
    return this.awaitTaken(command.commandId, turn, generation)
  }
  /**
   * Whether the harness took the prompt. ACP sends no acknowledgement, so the evidence is the thread's own process
   * working: any update or request it sends after the prompt went out, or the prompt's own answer. A prompt with no
   * evidence by the deadline stays uncertain, and is never sent again.
   */
  private async awaitTaken(commandId: string, turn: LiveTurn, generation: number): Promise<AgentHostResult> {
    const deadline = Date.now() + (this.options.requestTimeoutMs ?? 30_000)
    while (!turn.taken) {
      if (generation !== this.generation) return { accepted: false, uncertain: true }
      const left = deadline - Date.now()
      if (left <= 0) return { accepted: false, uncertain: true }
      await new Promise<void>(resolve => {
        const done = (): void => { clearTimeout(timer); if (turn.wake === done) turn.wake = undefined; resolve() }
        const timer = setTimeout(done, left); timer.unref()
        turn.wake = done
      })
    }
    markSendStage(commandId, 'acknowledged')
    return { accepted: true }
  }
  private async answer(command: Extract<AgentHostCommand, { type: 'answer' }>, alias: Alias, connection: Connection): Promise<AgentHostResult> {
    const pending = this.pending.get(command.requestId)
    if (!pending || pending.threadId !== command.threadId) throw new Error('That DeepSeek Harness request is no longer waiting.')
    if (pending.connection !== connection) return { accepted: false, uncertain: true }
    if (pending.answering) return { accepted: false, uncertain: true }
    const result = deepseekAnswer(pending, command.approved, command.permissionChoice)
    pending.answering = true
    const index = this.indexOf(command.threadId, alias)
    index.answer(pending.request.id)
    try { await this.persist() } catch (error) { index.unanswer(pending.request.id); pending.answering = false; throw error }
    if (this.pending.get(command.requestId) !== pending || this.connections.get(command.threadId) !== connection) return { accepted: false, uncertain: true }
    try { await connection.rpc.reply(pending.wireId, result); this.removeRequest(command.requestId) }
    catch { pending.request.delivery = 'uncertain'; this.changed(command.threadId); this.emit(); return { accepted: false, uncertain: true } }
    this.emit(); return { accepted: true }
  }
  private async interrupt(id: string, alias: Alias, watcherGuard?: () => void): Promise<AgentHostResult> {
    const connection = this.connections.get(id)
    // Every request still waiting is declined, which grants nothing, before the harness is told to stop.
    if (!watcherGuard) for (const [requestId, pending] of [...this.pending]) if (pending.threadId === id && !pending.answering) {
      this.removeRequest(requestId); await pending.connection.rpc.reply(pending.wireId, deepseekDecline(pending)).catch(() => undefined)
    }
    watcherGuard?.()
    if (connection) connection.rpc.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: alias.deepseekSessionId } })
    this.emit(); return { accepted: true }
  }
  private removeRequest(requestId: string): void {
    const pending = this.pending.get(requestId); if (!pending) return
    this.pending.delete(requestId)
    const thread = this.threads.get(pending.threadId)
    if (thread) { thread.requests = thread.requests.filter(request => request.id !== requestId); this.changed(pending.threadId) }
  }
  private clearRequests(id: string): void {
    for (const [requestId, pending] of this.pending) if (pending.threadId === id) this.pending.delete(requestId)
    const thread = this.threads.get(id); if (thread) { thread.requests = []; this.changed(id) }
  }

  // ---- Disconnecting -------------------------------------------------------------------------------------------------

  disconnect(): void {
    this.generation++; this.reaper.dispose()
    // Nothing the user did not answer is approved: every waiting request is declined on its way out.
    for (const pending of this.pending.values()) if (!pending.answering) {
      try { pending.connection.rpc.write({ jsonrpc: '2.0', id: pending.wireId, result: deepseekDecline(pending) }) } catch { /* A closed pipe grants nothing. */ }
    }
    this.pending.clear()
    for (const id of this.turns.keys()) this.endTurn(id, 'interrupted')
    this.turns.clear()
    for (const thread of this.threads.values()) thread.requests = []
    this.threadChanges.markAll()
    for (const connection of this.connections.values()) this.close(connection)
    for (const rpc of this.processes) rpc.close()
    this.connections.clear(); this.loading.clear(); this.loaded.clear(); this.outdated.clear()
    this.state.connected = false; this.emit()
  }
  async closed(): Promise<void> { await Promise.all([...this.processes].map(rpc => rpc.closed)); await Promise.all([...this.stopping.values()].map(work => work.catch(() => undefined))); await this.writing }
}
