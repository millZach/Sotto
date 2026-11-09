import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { version as appVersion } from '../../../package.json'
import { agentProjectSchema, attachmentReferences, type AgentHostSnapshot, type AgentModel, type AgentRuntimeMode, type AgentThread } from '../../shared/agents'
import { mergeAgentActivities, type OwnServerTurn } from '../../shared/agentActivity'
import type { MediaCapture } from './threadMedia'
import type { OwnServer } from '../../shared/ownModelServers'
import { watcherProvidersInWords } from '../../shared/workerRoles'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { ActivitySubscribers, certifyActivityView, cloneActivitySnapshot } from './activitySnapshots'
import { acpImageBlocks, deliverAttachments, withAttachedFilesNote } from './attachedFiles'
import type { BrowserAgentTools } from './browserAgentServer'
import { cloneHostSnapshot } from './cloneHostSnapshot'
import { hermesActivities, HERMES_THINKING_ID_PREFIX } from './hermesActivity'
import { hermesCatalog, hermesModelRoute, hermesModelValue, hermesSettingsOf, HERMES_RUNTIME_MODES } from './hermesModels'
import { hermesAnswer, hermesDecline, hermesPending, type HermesPending, type HermesToolDetail } from './hermesRequests'
import { compareHermesVersions, HermesRejected, HermesRpc, HermesUncertain, HERMES_ACP_VERSION, HERMES_CLI_VERSION,
  findHermesExecutable, readHermesVersion, type HermesFrame } from './hermesRpc'
import { HermesRuntime, hermesServers } from './hermesRuntime'
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

/** One managed gateway, project homes, and one ACP viewer per thread. Sotto keeps message identity
 * and history; Hermes keeps native sessions, memory and skills. Sotto runs it with Full access only. */

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const attachmentSchema = z.object({ id: z.string(), name: z.string(), mimeType: z.string(), sizeBytes: z.number() })
/** One message Sotto sent: its identities, the digest of what the harness was given, and its turn's place. */
const originSchema = z.object({ messageId: z.string(), commandId: z.string(), digest: z.string(), createdAt: z.string(), turn: z.number().int().nonnegative(),
  attachments: z.array(attachmentSchema).default([]) })
type Origin = z.infer<typeof originSchema>
const aliasSchema = z.object({
  hermesSessionId: z.string().min(1).max(512).optional(), projectId: z.string(), cwd: z.string(), title: z.string(), createdAt: z.string(),
  modelId: z.string(), reasoningEffort: z.string().optional(), runtimeMode: z.enum(HERMES_RUNTIME_MODES).default('full-access'),
  /** How many user turns the session holds, as Sotto last counted them: the place the next prompt takes. */
  turns: z.number().int().nonnegative().default(0),
  origins: z.array(originSchema).default([]), answeredRequestIds: z.array(z.string()).default([]),
})
type Alias = z.infer<typeof aliasSchema>
const aliasStoreSchema = z.record(z.string(), aliasSchema)
const projectStoreSchema = z.array(agentProjectSchema)
const ANSWERED_KEPT = 128
/** A thread's saved origins and answered requests, indexed from its record once, the way Cursor's are. */
class ThreadIndex {
  private readonly byCommand = new Map<string, Origin>()
  private readonly byMessage = new Map<string, Origin>()
  private readonly byDigest = new Map<string, Origin>()
  private readonly answered: Set<string>
  constructor(readonly alias: Alias) {
    for (const origin of alias.origins) this.index(origin)
    if (alias.answeredRequestIds.length > ANSWERED_KEPT) alias.answeredRequestIds = alias.answeredRequestIds.slice(-ANSWERED_KEPT)
    this.answered = new Set(alias.answeredRequestIds)
  }
  private index(origin: Origin): void { this.byCommand.set(origin.commandId, origin); this.byMessage.set(origin.messageId, origin); this.byDigest.set(origin.digest, origin) }
  sent(commandId: string, messageId: string): Origin | undefined { return this.byCommand.get(commandId) ?? this.byMessage.get(messageId) }
  containsDigest(value: string): boolean { return this.byDigest.has(value) }
  add(origin: Origin): void { this.alias.origins.push(origin); this.index(origin) }
  remove(origin: Origin): void {
    const at = this.alias.origins.lastIndexOf(origin)
    if (at >= 0) this.alias.origins.splice(at, 1)
    if (this.byCommand.get(origin.commandId) === origin) this.byCommand.delete(origin.commandId)
    if (this.byMessage.get(origin.messageId) === origin) this.byMessage.delete(origin.messageId)
    if (this.byDigest.get(origin.digest) === origin) this.byDigest.delete(origin.digest)
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
const PROCESS_LOST = 'Hermes stopped before this reply finished, so it may be cut short. Send a message to carry on.'
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
    return { id: `hermes-reply-${this.key}-${this.replies - 1}`, opened }
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
  readonly rpc: HermesRpc
  readonly nonce: string
  readonly clientRevision: number
  readonly patchRevision: number
  readonly mode: AgentRuntimeMode
  closing: boolean
  replaying: boolean
  /** The model and effort this process's session is on, as the harness last said. */
  model: string | undefined
  effort: string | undefined
  /** The tool calls this process has shown, by ID: a permission request names only its call, and its card is built from this. */
  tools: Map<string, HermesToolDetail>
}
type Pending = HermesPending & { readonly connection: Connection }

export interface HermesAcpOptions {
  /** The pinned `hermes` to start, in place of finding the user's own: a test's fake client. */
  executable?: string
  /** Extra arguments ahead of `acp`: a test's fake client process. */
  executableArgs?: readonly string[]
  environment?: NodeJS.ProcessEnv
  /** Sotto's Hermes folder: `<userData>/hermes` by default. */
  homeDirectory?: string
  /** The user's own model servers, read at connect and again when the record changes. */
  servers?: () => Promise<readonly OwnServer[]>
  /** The providers held back in this build, which the Watcher refusal names among the admitted. */
  heldProviders?: HeldProviders
  requestTimeoutMs?: number
  startTimeoutMs?: number
  reaperSweepMs?: number
  sessionIdleMs?: number
  /** The thread media store's capture (ADR-0170), given only with the Owl feature `inline-media` on: a tool's pictures become handles on its step. */
  captureMedia?: MediaCapture
}

export class HermesAcpHost implements AgentHost {
  private readonly aliasStore: AtomicJsonStore<Record<string, Alias>>
  private readonly projectStore: AtomicJsonStore<AgentHostSnapshot['projects']>
  private aliases: Record<string, Alias> = {}
  /** Whether `this.aliases` reflects the store: false until a `connect()` has loaded it once (ADR-0140). */
  private aliasesLoaded = false
  /** Threads `forgetThread` removed, kept so a `connect()` racing its disk write cannot bring one back. */
  private readonly forgottenAliasIds = new Set<string>()
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
  private readonly processes = new Set<HermesRpc>()
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
  private patching = Promise.resolve()
  private servers: readonly OwnServer[] = []
  private httpToolServers = false
  /** Whether the harness advertised image prompts on the current overlay: unknown until a process has started on it. */
  private harnessImages = false
  private generation = 0
  private writing = Promise.resolve()
  private state: AgentHostSnapshot = { connected: false, name: 'Hermes', version: '', projects: [], models: [], threads: [],
    capabilities: { projects: true, threads: true, submit: true, observe: true, questions: false, permissions: true, interrupt: true, messageOrigin: true,
      reconcile: true, configureThread: true, configureThreadModel: true, skills: false, steer: true, compact: false } }
  private readonly homeDirectory: string
  private readonly runtime: HermesRuntime

  constructor(private readonly userDataDirectory: string, private readonly options: HermesAcpOptions = {}) {
    this.homeDirectory = options.homeDirectory ?? join(userDataDirectory, 'hermes')
    this.runtime = new HermesRuntime(this.homeDirectory, () => this.disconnect(), options.environment)
    this.aliasStore = new AtomicJsonStore(join(userDataDirectory, 'hermes-threads.json'), aliasStoreSchema.parse, () => ({}))
    this.projectStore = new AtomicJsonStore(join(userDataDirectory, 'hermes-projects.json'), projectStoreSchema.parse, () => [])
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
  /** Sotto's private Hermes root; project profiles live beneath it. */
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
  /**
   * ADR-0140: stop the thread's own Hermes process if it has one, remove its alias and every per-thread
   * record this adapter keeps, and persist. Guarded with `forgottenAliasIds` against a `connect()` that reads the
   * alias store before this removal reaches disk (see there).
   */
  async forgetThread(id: string): Promise<void> {
    this.forgottenAliasIds.add(id)
    if (!this.aliasesLoaded) {
      const current = await this.aliasStore.read()
      if (!(id in current)) return
      const next = { ...current }
      delete next[id]
      await this.aliasStore.write(next)
      return
    }
    if (!this.aliases[id]) return
    // A session still opening would set its process after the stop; it settles first, so the stop catches it.
    await this.loading.get(id)?.catch(() => undefined)
    await this.stopSession(id)
    this.reaper.forget(id)
    this.observed.delete(id)
    this.outdated.delete(id)
    this.dispatching.delete(id)
    this.loaded.delete(id)
    this.endTurn(id, 'interrupted')
    this.turns.delete(id)
    for (const [requestId, pending] of [...this.pending]) if (pending.threadId === id) this.pending.delete(requestId)
    this.indexes.delete(id)
    this.log.forget(id)
    this.threads.delete(id)
    delete this.aliases[id]
    await this.persist()
    if (this.state.connected) this.emit()
  }
  private indexOf(id: string, alias: Alias): ThreadIndex {
    let index = this.indexes.get(id)
    if (!index || index.alias !== alias) { index = new ThreadIndex(alias); this.indexes.set(id, index) }
    return index
  }
  private thread(id: string): AgentThread {
    const alias = this.aliases[id]
    if (!alias) throw new Error('This Hermes thread does not exist.')
    let thread = this.threads.get(id)
    if (!thread) {
      thread = { id, projectId: alias.projectId, title: alias.title, workingDirectory: alias.cwd, modelId: alias.modelId, runtimeMode: alias.runtimeMode,
        ...(alias.reasoningEffort ? { reasoningEffort: alias.reasoningEffort } : {}),
        status: alias.hermesSessionId ? 'idle' : 'error', messages: [], requests: [] }
      this.threads.set(id, thread)
      if (this.connections.has(id) && !this.loading.has(id)) this.loaded.add(id)
    }
    this.changed(id)
    return thread
  }
  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new HermesUncertain('Hermes’s connection changed before this could finish.')
  }

  /**
   * Watcher is outside this local build, so its saved profile is refused before a viewer starts.
   */
  private async refuseWatcher(id: string): Promise<void> {
    const generation = this.generation
    let profile
    try { profile = await this.launchProfiles?.profileFor(id) }
    catch (error) {
      if (generation !== this.generation) throw new HermesUncertain('Hermes’s connection changed.')
      throw error instanceof WatcherProfileRefusal ? error : new WatcherProfileRefusal('Watcher’s saved profile could not be verified. Nothing was sent.')
    }
    if (generation !== this.generation) throw new HermesUncertain('Hermes’s connection changed.')
    if (!profile) return
    const reason = `Hermes cannot host Watcher. Nothing was sent. Choose a ${watcherProvidersInWords(this.options.heldProviders ?? heldProvidersOf({}))} model for Watcher.`
    try { profile.revoke(reason) } catch { /* The refusal stands either way. */ }
    throw new WatcherProfileRefusal(reason)
  }

  /** Sotto's own tool servers for this thread, each with the thread's bearer token, as the other ACP adapters pass them. */
  private async toolServers(id: string): Promise<ThreadMcpServer[]> {
    if (!this.httpToolServers) return []
    const servers: ThreadMcpServer[] = []
    if (this.browserTools) servers.push(await this.browserTools.mcpServer(id))
    for (const { server } of await scopedThreadServers(this.threadTools, id)) servers.push(server)
    return servers
  }

  // ---- Processes -----------------------------------------------------------------------------------------------------

  private spawn(args: string[], cwd: string, home: string, receive: (frame: HermesFrame, rpc: HermesRpc) => void, lost: () => void): HermesRpc {
    const rpc: HermesRpc = new HermesRpc(this.executable!, args, cwd, this.runtime.env(home, cwd), this.options.requestTimeoutMs ?? 30_000, frame => receive(frame, rpc), lost)
    this.processes.add(rpc); void rpc.closed.then(() => this.processes.delete(rpc))
    return rpc
  }
  private async handshake(rpc: HermesRpc): Promise<boolean> {
    let protocol: number | undefined, images = false
    await rpc.request('initialize', { protocolVersion: HERMES_ACP_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'sotto', version: appVersion } }, value => {
      const client = initializeSchema.parse(value)
      protocol = client.protocolVersion
      this.httpToolServers = true // Hermes accepts HTTP MCP despite omitting the capability in v0.23.0.
      images = client.agentCapabilities.promptCapabilities?.image === true
    }, false, this.options.startTimeoutMs ?? 30_000)
    if (protocol !== HERMES_ACP_VERSION) throw new ProviderUnavailable('cannot-start', `Sotto speaks ACP ${HERMES_ACP_VERSION}, and this Hermes client answered ACP ${protocol}.`)
    return images
  }
  /**
   * What a process on the current overlay and client advertised decides whether any model offers images: the harness
   * takes them only when the overlay's default model declares image input, and refuses every image block otherwise.
   */
  private readHarnessImages(connection: Connection, images: boolean): void {
    if (this.stale(connection) || images === this.harnessImages) return
    this.harnessImages = images
    this.state.models = hermesCatalog(this.servers, images)
    this.emit()
  }
  /** The overlay from the current record, written whenever it changed: a record change makes processes outdated. */
  /** One write at a time, so an older overlay never lands on disk after a newer one. */
  private writePatch(): Promise<void> {
    this.patching = this.patching.catch(() => undefined).then(async () => {
      await this.runtime.writeConfig(this.homeDirectory, this.servers)
      this.patchText = JSON.stringify(this.servers)
    })
    return this.patching
  }
  /** This thread's own process, started in the thread's permission mode with the current overlay, ready for a session. */
  private async startProcess(id: string, alias: Alias, cwd: string): Promise<Connection> {
    if (!this.executable || !this.state.connected) throw new Error('Connect Hermes before using its threads.')
    // The revision is read before the overlay is written, so a change during the write leaves this process outdated.
    const patchRevision = this.patchRevision, stops = this.runtime.stops
    await this.writePatch()
    if (!this.patchText) throw new Error('Hermes has no model server it can run. Your thread is kept. Add one under Your own model servers, then send again.')
    const connection: Connection = { rpc: undefined as unknown as HermesRpc, nonce: randomUUID(), clientRevision: this.clientRevision,
      patchRevision, mode: alias.runtimeMode, closing: false, replaying: false, model: undefined, effort: undefined, tools: new Map() }
    const project = this.state.projects.find(project => project.id === alias.projectId)
    const home = await this.runtime.project(this.executable, project?.path ?? cwd, this.servers, stops)
    const rpc = this.spawn([...(this.options.executableArgs ?? []), 'acp'], cwd, home, frame => this.frame(id, connection, frame), () => this.processLost(id, connection))
    ;(connection as { rpc: HermesRpc }).rpc = rpc
    try { this.readHarnessImages(connection, await this.handshake(rpc)) }
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
      const executable = this.options.executable ?? await findHermesExecutable(this.options.environment)
      if (!executable || !isAbsolute(executable)) throw new ProviderUnavailable('not-installed', 'Install Hermes, then connect it again. Your threads are kept.')
      await this.runtime.writeConfig(this.homeDirectory, this.servers)
      const version = await readHermesVersion(executable, this.runtime.env(), this.options.executableArgs ?? [])
      this.assertGeneration(generation)
      if (compareHermesVersions(version, HERMES_CLI_VERSION) < 0) throw new ProviderUnavailable('too-old', `Sotto needs Hermes ${HERMES_CLI_VERSION} or later, and this one is ${version}. Update Hermes, then connect again. Your threads are kept.`, version, HERMES_CLI_VERSION)
      this.servers = hermesServers(await this.options.servers?.() ?? [], await this.runtime.keys.read())
      this.assertGeneration(generation)
      // Images wait for the harness to say it takes them, which a process started on this overlay does.
      this.harnessImages = false
      const models = hermesCatalog(this.servers)
      if (!models.length) throw new ProviderUnavailable('signed-out', 'Hermes runs your own model servers, and none it can run is saved yet. Add one under Your own model servers, then connect again. Your threads are kept.', version)
      this.executable = executable
      await this.writePatch()
      const [aliases, projects] = await Promise.all([this.aliasStore.read(), this.projectStore.read()])
      this.assertGeneration(generation)
      for (const id of this.forgottenAliasIds) delete aliases[id]
      this.aliases = aliases; this.aliasesLoaded = true; this.indexes.clear(); this.state.projects = projects; this.state.models = models
      this.threads.clear(); this.threadChanges.markAll(); this.log.forgetAll()
      for (const id of Object.keys(this.aliases)) { this.thread(id); this.log.seed(id, this.history?.messageIdentities(id) ?? []) }
      this.state.connected = true; this.state.version = `${version} / ACP ${HERMES_ACP_VERSION}`
      delete this.state.error; delete this.state.problem; delete this.state.requiredVersion
      if (compareHermesVersions(version, HERMES_CLI_VERSION) > 0) this.state.verifiedVersion = HERMES_CLI_VERSION
      else delete this.state.verifiedVersion
      // A thread that cannot open is that thread's error, not the provider's: the rest stay usable.
      await Promise.all([...this.observed].filter(id => this.aliases[id]?.hermesSessionId).map(id => this.open(id).catch((error: unknown) => {
        if (generation !== this.generation) return
        this.markOpenFailed(id, error)
      })))
      this.assertGeneration(generation)
      this.reaper.start(); this.emit(); return this.current()
    } catch (error) {
      if (generation === this.generation) this.disconnect()
      if (error instanceof WatcherProfileRefusal) throw error
      const refused = error instanceof ProviderUnavailable
      const detail = refused || error instanceof HermesUncertain ? error.message : error instanceof Error && /^Sotto could not read/u.test(error.message) ? error.message : ''
      const message = ['Could not connect Hermes.', detail, refused ? '' : 'Connect again to retry.'].filter(Boolean).join(' ')
      if (refused) throw new ProviderUnavailable(error.problem, message, error.version, error.requiredVersion)
      throw new Error(message, { cause: error })
    }
  }
  private markOpenFailed(id: string, error: unknown): void {
    if (!this.aliases[id]) return
    this.thread(id).status = 'error'
    this.state.error = error instanceof Error && error.message ? error.message : 'A Hermes thread could not be opened. Your thread is kept. Reconnect Hermes to try again.'
    this.emit()
  }
  /**
   * The user's own model servers changed: the catalog is rebuilt and every running process, started with the old
   * overlay, is outdated, moving to a fresh one as it goes idle. Never awaits the provider, so a failed read
   * leaves the last good catalog.
   */
  ownServersChanged(): void {
    if (!this.state.connected) return
    const generation = this.generation
    void (async () => {
      const saved = await this.options.servers?.()
      const servers = saved ? hermesServers(saved, await this.runtime.keys.read()) : undefined
      if (!servers || generation !== this.generation) return
      this.servers = servers
      this.state.models = hermesCatalog(servers, this.harnessImages)
      // Only a new overlay outdates a process: a save that leaves it the same, such as a keyed server's, restarts nothing.
      if (JSON.stringify(servers) !== this.patchText) {
        this.patchRevision++
        for (const [id, connection] of this.connections) if (this.stale(connection)) this.outdated.add(id)
      }
      this.emit()
    })().catch(() => undefined)
  }
  /** A keyed server was added (ADR-0124): Hermes keeps its own copy of the key, as OpenCode does, and can run it from now on. */
  async keepKey(id: string, key: string): Promise<void> { await this.runtime.keys.keep(id, key); this.ownServersChanged() }
  /** A keyed server was removed: Hermes's copy of its key goes with it, from its record and every profile's `.env`. */
  async forgetKey(id: string): Promise<void> { await this.runtime.forgetKey(id); this.ownServersChanged() }
  /**
   * Hermes's client on disk was updated while Sotto stayed connected (ADR-0042, ADR-0038): find it again
   * and hold it to the floor; every new process starts from it, and each thread moves onto it as it goes idle.
   */
  async clientUpdated(): Promise<void> {
    if (!this.state.connected) return
    const generation = this.generation
    const executable = this.options.executable ?? await findHermesExecutable(this.options.environment).catch(() => undefined)
    if (generation !== this.generation || !this.state.connected) return
    if (!executable) throw new Error('Hermes was updated, but Sotto cannot find it now. Threads that are working carry on and nothing was lost. Check Hermes, then connect it again.')
    let version: string
    try { version = await readHermesVersion(executable, this.runtime.env(), this.options.executableArgs ?? []) }
    catch (error) {
      if (generation !== this.generation || !this.state.connected) return
      throw new Error('Hermes was updated, but the new version did not answer. Threads that are working carry on and nothing was lost. Connect Hermes again to try the new version.', { cause: error })
    }
    if (generation !== this.generation || !this.state.connected) return
    if (compareHermesVersions(version, HERMES_CLI_VERSION) < 0) throw new Error(`Hermes was updated, but Sotto needs ${HERMES_CLI_VERSION} or later and this one is ${version}. Threads that are working carry on and nothing was lost.`)
    this.executable = executable; this.clientRevision++
    this.state.version = `${version} / ACP ${HERMES_ACP_VERSION}`
    if (compareHermesVersions(version, HERMES_CLI_VERSION) > 0) this.state.verifiedVersion = HERMES_CLI_VERSION
    else delete this.state.verifiedVersion
    for (const [id, connection] of this.connections) if (connection.clientRevision < this.clientRevision) this.outdated.add(id)
    this.emit()
  }
  /** Whether a process started before the newest client or overlay. */
  private stale(connection: Connection): boolean { return connection.clientRevision < this.clientRevision || connection.patchRevision < this.patchRevision }
  /** Stop each outdated process whose thread is not busy; a watched one opens again at once on the new client or overlay. */
  private stopOutdated(): void {
    if (!this.outdated.size) return
    for (const id of [...this.outdated]) {
      const connection = this.connections.get(id)
      if (!connection || !this.stale(connection)) { this.outdated.delete(id); continue }
      if (this.busy(id)) continue
      this.outdated.delete(id)
      const generation = this.generation
      void this.stopSession(id).then(() => {
        if (generation === this.generation && this.observed.has(id) && this.aliases[id]?.hermesSessionId) return this.open(id).then(() => undefined)
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
    if (!alias?.hermesSessionId) throw new Error('Hermes did not confirm this thread’s session. Your thread is kept. Start a new thread to carry on.')
    const cwd = await existingWorkingDirectory(alias.cwd)
    this.assertGeneration(generation)
    const connection = await this.startProcess(id, alias, cwd)
    if (generation !== this.generation) { this.close(connection); throw new HermesUncertain('Hermes’s connection changed while the thread was opening.') }
    this.connections.set(id, connection)
    if (this.stale(connection)) this.outdated.add(id)
    try {
      const mcpServers = await this.toolServers(id)
      this.assertGeneration(generation)
      // Sotto retains its own history on resume: the thread's history stays Sotto's, and the session continues.
      connection.replaying = true
      await connection.rpc.request('session/resume', { sessionId: alias.hermesSessionId, cwd: alias.cwd, mcpServers }, value => { this.readSettings(connection, value); connection.replaying = false })
      if (generation !== this.generation || this.connections.get(id) !== connection) throw new HermesUncertain('Hermes’s connection changed while the thread was opening.')
      await this.applySettings(alias, connection)
      this.log.pin(id); this.reaper.touch(id)
      const thread = this.thread(id)
      if (!this.turns.get(id) || this.turns.get(id)!.ended) thread.status = 'idle'
      return connection
    } catch (error) {
      if (this.connections.get(id) === connection) this.connections.delete(id)
      this.close(connection)
      if (error instanceof HermesRejected) throw new Error('Hermes could not open this thread’s saved session. Your Sotto history is kept. Start a new thread to carry on; Sotto will not resend earlier work.', { cause: error })
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
    if (!this.state.connected || !this.aliases[id]?.hermesSessionId) return
    await this.open(id)
    this.reaper.touch(id)
  }
  observeThreads(ids: readonly string[]): void {
    this.observed.clear(); for (const id of ids) this.observed.add(id)
    this.log.observe(ids)
    if (!this.state.connected) return
    const generation = this.generation
    for (const id of ids) if (this.aliases[id]?.hermesSessionId) void this.open(id).catch((error: unknown) => { if (generation === this.generation) this.markOpenFailed(id, error) })
  }
  async snapshot(): Promise<AgentHostSnapshot> { return this.current() }
  async refreshThread(id: string, purpose?: ThreadReadPurpose): Promise<AgentHostSnapshot> {
    if (!this.aliases[id]?.hermesSessionId) throw new Error('This Hermes thread has no confirmed session.')
    const generation = this.generation
    await this.refuseWatcher(id)
    this.assertGeneration(generation)
    await this.open(id)
    return this.current(purpose?.historyFromEvents)
  }

  // ---- What the harness says -------------------------------------------------------------------------------------------

  /** The model and effort a session answer names, as the harness last said them. */
  private readSettings(connection: Connection, value: unknown): void {
    const settings = hermesSettingsOf(value)
    if (settings.model !== undefined) connection.model = settings.model
    connection.effort = settings.effort
  }
  /** Every frame from one thread's process. A request is answered on the process that asked, never another. */
  private frame(id: string, connection: Connection, frame: HermesFrame): void {
    const alias = this.aliases[id]
    if (!alias || connection.closing) return
    const params = record(frame.params)
    if (frame.method === 'session/update') {
      if (!params || (alias.hermesSessionId && params.sessionId !== alias.hermesSessionId)) return
      const update = record(params.update)
      if (!update || this.connections.get(id) !== connection) return
      if (connection.replaying && ['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(String(update.sessionUpdate))) return
      this.liveUpdate(id, alias, update)
      return
    }
    if (!frame.method || frame.id === undefined) return
    if (this.connections.get(id) !== connection) { connection.rpc.refuse(frame.id); return }
    this.taken(id)
    const toolCallId = typeof record(params?.toolCall)?.toolCallId === 'string' ? record(params?.toolCall)!.toolCallId as string : undefined
    const asked = hermesPending(frame.id, frame.method, frame.params, id, toolCallId ? connection.tools.get(toolCallId) : undefined)
    if (!asked) {
      connection.rpc.refuse(frame.id)
      const notice = unreadableRequest('Hermes'); const thread = this.thread(id)
      thread.requestNotice = notice; this.state.error = notice; this.emit()
      return
    }
    if (alias.hermesSessionId && params?.sessionId !== alias.hermesSessionId) { connection.rpc.refuse(frame.id); return }
    const requestId = `hermes-request-${digest(JSON.stringify([id, connection.nonce, frame.id]))}`
    const pending: Pending = { ...asked, request: { ...asked.request, id: requestId }, connection }
    if (this.pending.has(requestId)) return
    if (this.indexOf(id, alias).wasAnswered(requestId)) { void connection.rpc.reply(frame.id, hermesDecline(pending)).catch(() => undefined); return }
    if (this.pending.size >= 128) { void connection.rpc.reply(frame.id, hermesDecline(pending)).catch(() => undefined); return }
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
      if (this.indexOf(id, alias).containsDigest(digest(words))) { this.taken(id); return }
      // Something typed into this session elsewhere starts a turn of its own.
      const index = alias.turns; alias.turns++
      void this.persist().catch(() => undefined)
      const key = `hermes-user-${index}-${digest(words).slice(0, 16)}`
      this.log.add(id, { id: key, role: 'user', text: words, createdAt: new Date().toISOString() })
      // A turn still running keeps its place, so its prompt's answer still ends it.
      if (!turn || turn.ended) this.turns.set(id, { places: new TurnPlaces(key), origin: undefined, taken: true, ended: true, wake: undefined })
      this.emit()
      return
    }
    this.taken(id)
    let turn = this.turns.get(id)
    if (!turn) {
      turn = { places: new TurnPlaces(this.log.lastUserMessageId(id) ?? 'hermes-history'), origin: undefined, taken: true, ended: true, wake: undefined }
      this.turns.set(id, turn)
    }
    const thread = this.thread(id)
    if (kind === 'agent_message_chunk') {
      if (words === undefined) return
      const reply = turn.places.reply()
      if (reply.opened || !this.log.has(id, reply.id)) {
        this.log.add(id, { id: reply.id, role: 'assistant', text: words, createdAt: new Date().toISOString(), turnMessageId: turn.places.key })
        const settled = settledThinking(HERMES_THINKING_ID_PREFIX, thread.activities ?? [], 'completed', true)
        if (settled.length) thread.activities = mergeAgentActivities(thread.activities, settled)
        this.emit()
      } else { this.log.appendText(id, reply.id, words); this.emit(true) }
      return
    }
    const key = kind === 'agent_thought_chunk' ? turn.places.thought()
      : typeof update.toolCallId === 'string' && (kind === 'tool_call' || kind === 'tool_call_update') ? turn.places.tool(update.toolCallId, kind === 'tool_call') : undefined
    const rows = hermesActivities(update, { turnId: turn.places.key, afterMessageId: this.log.lastMessageId(id), cwd: alias.cwd, key }, thread.activities, true, this.options.captureMedia)
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
    const thoughts = settledThinking(HERMES_THINKING_ID_PREFIX, thread.activities ?? [], thinkingSettledAs(status), true)
    const settled = thoughts.length ? mergeAgentActivities(thread.activities, thoughts) : thread.activities
    const closed = settled?.map(row => row.status === 'running' && row.kind !== 'turn' && row.kind !== 'plan' && row.turnId === turn.places.key
      ? { ...row, status: status === 'completed' ? 'completed' as const : status === 'interrupted' ? 'interrupted' as const : 'unknown' as const } : row)
    thread.activities = markTurnActivity(closed, { provider: 'hermes', turnId: turn.places.key, status, ...(error ? { error } : {}) })
    this.changed(id)
    this.reaper.touch(id)
  }
  /** The thread's own server as its turn record names it (ADR-0124): every Hermes turn runs on one. */
  private ownServerTurn(alias: Alias): OwnServerTurn | undefined {
    const route = hermesModelRoute(alias.modelId)
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
      catch (error) { if (error instanceof HermesUncertain) return { accepted: false, uncertain: true }; throw error }
      this.assertGeneration(generation)
    }
    if (command.type === 'steer') return this.steer(command, generation)
    if (command.type === 'compact-thread') throw new Error('Hermes cannot compact a thread.')
    if (!this.state.connected) throw new Error('Connect Hermes before managing threads.')
    if (command.type !== 'send' && command.type !== 'create-thread') return this.run(command, generation, watcherGuard)
    if (this.dispatching.has(command.threadId)) throw new Error('Hermes is already receiving work for this thread. Wait for its delivery result.')
    this.dispatching.add(command.threadId)
    try { return await this.run(command, generation, watcherGuard) } finally { this.dispatching.delete(command.threadId); this.stopOutdated() }
  }
  private async run(command: AgentHostCommand, generation: number, watcherGuard?: () => void): Promise<AgentHostResult> {
    try {
      if (command.type === 'create-project') {
        if (!isAbsolute(command.path)) throw new Error('Hermes projects need an absolute folder.')
        if (!this.state.projects.some(project => project.id === command.projectId)) {
          this.state.projects.push({ id: command.projectId, title: command.title, path: command.path })
          await this.projectStore.write(this.state.projects)
        }
        this.emit(); return { accepted: true }
      }
      if (command.type === 'create-thread') return await this.create(command, generation, watcherGuard)
      if (command.type === 'configure-thread') return await this.configure(command, generation, watcherGuard)
      const id = command.threadId, alias = this.aliases[id]
      if (!alias?.hermesSessionId) throw new Error('Hermes did not confirm this thread’s session. Your thread is kept. Do not repeat its creation automatically.')
      if (command.type === 'interrupt') return await this.interrupt(id, alias, watcherGuard)
      const connection = await this.open(id)
      if (generation !== this.generation || this.connections.get(id) !== connection) throw new HermesUncertain('Hermes’s connection changed.')
      this.reaper.touch(id)
      if (command.type === 'send') return await this.send(command, alias, connection, generation, watcherGuard)
      if (command.type === 'answer') return await this.answer(command, alias, connection)
      throw new Error('Hermes does not take that action.')
    } catch (error) {
      if (error instanceof HermesUncertain) return { accepted: false, uncertain: true }
      throw error
    }
  }
  private runtimeModeOf(command: { runtimeMode?: AgentRuntimeMode | undefined }): AgentRuntimeMode {
    const mode = command.runtimeMode ?? 'full-access'
    if (!HERMES_RUNTIME_MODES.includes(mode)) throw new Error('That permission mode is not supported by this provider.')
    return mode
  }
  private async create(command: Extract<AgentHostCommand, { type: 'create-thread' }>, generation: number, watcherGuard?: () => void): Promise<AgentHostResult> {
    const saved = this.aliases[command.threadId]
    if (saved) return saved.hermesSessionId ? { accepted: true } : { accepted: false, uncertain: true }
    const runtimeMode = this.runtimeModeOf(command)
    validateThreadOptions(this.state, { ...command, runtimeMode })
    const project = this.state.projects.find(item => item.id === command.projectId)
    if (!project) throw new Error('Choose a Hermes project first.')
    // A create that names no effort starts on the model's default and says so, so the chip names the effort it runs at.
    const reasoningEffort = command.reasoningEffort ?? this.model(command.modelId)?.defaultReasoningEffort
    const alias: Alias = { projectId: project.id, cwd: await existingWorkingDirectory(command.workingDirectory ?? project.path), title: command.title, createdAt: new Date().toISOString(),
      modelId: command.modelId, ...(reasoningEffort ? { reasoningEffort } : {}), runtimeMode, turns: 0, origins: [], answeredRequestIds: [] }
    this.assertGeneration(generation)
    const connection = await this.startProcess(command.threadId, alias, alias.cwd)
    if (generation !== this.generation) { this.close(connection); throw new HermesUncertain('Hermes’s connection changed.') }
    // The process is the thread's from here, so what it says while its session is made reaches the thread.
    this.connections.set(command.threadId, connection)
    if (this.stale(connection)) this.outdated.add(command.threadId)
    try {
      this.aliases[command.threadId] = alias; await this.persist()
      const mcpServers = await this.toolServers(command.threadId)
      this.assertGeneration(generation)
      watcherGuard?.()
      await connection.rpc.request('session/new', { cwd: alias.cwd, mcpServers }, async value => {
        alias.hermesSessionId = sessionNewSchema.parse(value).sessionId; this.readSettings(connection, value); await this.persist()
      })
      this.assertGeneration(generation)
      await this.applySettings(alias, connection)
    } catch (error) {
      if (this.connections.get(command.threadId) === connection) this.connections.delete(command.threadId)
      this.close(connection)
      if (this.aliases[command.threadId] === alias && alias.hermesSessionId) this.thread(command.threadId).status = 'error'
      throw error
    }
    const thread = this.thread(command.threadId)
    thread.status = 'idle'; thread.modelId = alias.modelId; thread.runtimeMode = alias.runtimeMode
    if (alias.reasoningEffort) thread.reasoningEffort = alias.reasoningEffort
    this.loaded.add(command.threadId); this.log.pin(command.threadId); this.reaper.touch(command.threadId)
    this.emit(); return { accepted: true }
  }
  private model(modelId: string): AgentModel | undefined { return this.state.models.find(model => model.id === modelId) }
  /** Put the session on the thread's model and effort before a prompt that needs them, read back from the answer. */
  private async applySettings(alias: Alias, connection: Connection): Promise<void> {
    const value = hermesModelValue(alias.modelId)
    if (value === undefined) throw new Error('This thread’s model is not one of your own model servers. Choose a model your servers offer, then send.')
    await connection.rpc.request('session/set_mode', { sessionId: alias.hermesSessionId, modeId: 'dont_ask' })
    if (connection.model !== alias.modelId) {
      await connection.rpc.request('session/set_model', { sessionId: alias.hermesSessionId, modelId: value })
      connection.model = alias.modelId
    }
  }
  private async steer(command: Extract<AgentHostCommand, { type: 'steer' }>, generation: number): Promise<AgentHostResult> {
    const id = command.threadId, alias = this.aliases[id], turn = this.turns.get(id)
    if (!this.state.connected || !alias?.hermesSessionId || !turn || turn.ended) throw new Error('Hermes is not working on this thread. Send a follow-up instead.')
    if (command.attachments?.length || command.skills?.length) throw new Error('Hermes steering takes text only. Queue attachments for the next turn.')
    const index = this.indexOf(id, alias), previous = index.sent(command.commandId, command.messageId)
    if (previous) return { accepted: this.log.has(id, previous.messageId), ...(!this.log.has(id, previous.messageId) ? { uncertain: true } : {}) }
    if (command.expectedLastUserMessageId !== undefined && command.expectedLastUserMessageId !== (this.log.lastUserMessageId(id) ?? null)) throw new Error('The latest user message changed. Review the thread before steering.')
    if (this.thread(id).requests.length) throw new Error('Answer Hermes’s pending request before steering.')
    verifyFileMentions(command.text, command.files)
    const connection = await this.open(id)
    this.assertGeneration(generation)
    if (this.turns.get(id) !== turn || turn.ended) throw new Error('This turn has ended. Send a follow-up instead.')
    const text = `/steer ${command.text}`
    const origin: Origin = { messageId: command.messageId, commandId: command.commandId, digest: digest(text), createdAt: new Date().toISOString(), turn: alias.turns, attachments: [] }
    index.add(origin)
    try { await this.persist() } catch (error) { index.remove(origin); throw error }
    this.assertGeneration(generation)
    try { await connection.rpc.request('session/prompt', { sessionId: alias.hermesSessionId, prompt: [{ type: 'text', text }] }) }
    catch (error) { if (error instanceof HermesUncertain) return { accepted: false, uncertain: true }; throw error }
    this.log.add(id, { id: origin.messageId, role: 'user', text: command.text, commandId: origin.commandId, createdAt: origin.createdAt })
    this.emit()
    return { accepted: true }
  }

  private async configure(command: Extract<AgentHostCommand, { type: 'configure-thread' }>, generation: number, watcherGuard?: () => void): Promise<AgentHostResult> {
    const id = command.threadId, alias = this.aliases[id]
    if (!alias?.hermesSessionId) throw new Error('Hermes did not confirm this thread’s session. Your thread is kept.')
    if (command.providerMode !== undefined) throw new Error('That permission mode is not supported by this provider.')
    const runtimeMode = command.runtimeMode === undefined ? undefined : this.runtimeModeOf(command)
    const modelId = command.modelId ?? alias.modelId
    const reasoningEffort = effortAfterChange(this.state, command, alias.reasoningEffort)
    validateThreadOptions(this.state, { modelId, ...(command.reasoningEffort !== undefined ? { reasoningEffort: command.reasoningEffort } : {}), ...(runtimeMode ? { runtimeMode } : {}) }, alias.modelId)
    const thread = this.thread(id)
    const modeChanges = runtimeMode !== undefined && runtimeMode !== alias.runtimeMode
    watcherGuard?.()
    if (modeChanges) { await this.loading.get(id)?.catch(() => undefined); await this.stopping.get(id); this.assertGeneration(generation) }
    // A changed process mode requires a quiet thread.
    if (modeChanges && this.busy(id)) throw new Error('Hermes is working on this thread. Its permission mode is unchanged. Change it once the thread is idle.')
    const settingsChange = modelId !== alias.modelId || reasoningEffort !== alias.reasoningEffort
    watcherGuard?.()
    alias.modelId = modelId
    if (reasoningEffort) alias.reasoningEffort = reasoningEffort; else delete alias.reasoningEffort
    if (runtimeMode) alias.runtimeMode = runtimeMode
    await this.persist()
    this.assertGeneration(generation)
    thread.modelId = alias.modelId; thread.runtimeMode = alias.runtimeMode
    if (alias.reasoningEffort) thread.reasoningEffort = alias.reasoningEffort; else delete thread.reasoningEffort
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
      if (generation !== this.generation || this.connections.get(id) !== connection || !this.state.connected) throw new HermesUncertain('Hermes’s connection changed. Delivery has not been confirmed.')
    }
    const index = this.indexOf(id, alias)
    const previous = index.sent(command.commandId, command.messageId)
    if (previous) {
      if (previous.messageId !== command.messageId || previous.commandId !== command.commandId) throw new Error('This Hermes message identity is already in use.')
      return this.log.has(id, previous.messageId) ? { accepted: true } : { accepted: false, uncertain: true }
    }
    if (command.expectedLastUserMessageId !== undefined && (this.log.lastUserMessageId(id) ?? null) !== command.expectedLastUserMessageId) throw new Error('The latest user message changed. Review the thread before replying.')
    const running = this.turns.get(id)
    if (running && !running.ended) throw new Error('Hermes is still working on this thread. Queue this follow-up.')
    if (this.thread(id).requests.length) throw new Error('Answer Hermes’s pending request before sending another message.')
    // An image is refused here, before any bytes are read, unless the model's record and the harness both take images.
    const attachments = validatePromptAttachments(this.state, alias.modelId, command.attachments, { workingDirectory: alias.cwd })
    verifyFileMentions(command.text, command.files)
    if (command.skills?.length) throw new Error('Hermes takes no skills from the composer in this version.')
    // Images go as ACP image blocks after the words; files that are not images are saved into the thread's folder and
    // named in a note after the words (ADR-0131).
    const delivered = await deliverAttachments(alias.cwd, attachments)
    const nativeText = `Work in this project directory: ${alias.cwd}\nUse this directory for relative file paths and command working directories.\n\n${withAttachedFilesNote(command.text, delivered.note)}`
    const images = await acpImageBlocks(delivered.images)
    await this.applySettings(alias, connection)
    current()
    const origin: Origin = { messageId: command.messageId, commandId: command.commandId, digest: digest(nativeText), createdAt: new Date().toISOString(), turn: alias.turns,
      attachments: attachmentReferences(attachments) }
    index.add(origin); alias.turns++
    // A record that cannot be written takes the origin back out, so the same command can be sent again.
    try { await this.persist() } catch (error) { index.remove(origin); alias.turns--; throw error }
    current()
    try { watcherGuard?.() } catch (error) { index.remove(origin); alias.turns--; await this.persist(); throw error }
    const thread = this.thread(id)
    delete thread.requestNotice
    const turn: LiveTurn = { places: new TurnPlaces(origin.messageId), origin, taken: false, ended: false, wake: undefined }
    this.turns.set(id, turn)
    thread.status = 'running'; thread.lastTurn = { id: origin.messageId, status: 'running' }
    const ownServer = this.ownServerTurn(alias)
    thread.activities = markTurnActivity(thread.activities, { provider: 'hermes', turnId: origin.messageId, status: 'running', afterMessageId: origin.messageId, ...(ownServer ? { ownServer } : {}) })
    this.emit()
    this.log.add(id, { id: origin.messageId, role: 'user', text: command.text, commandId: origin.commandId, createdAt: origin.createdAt,
      ...(origin.attachments.length ? { attachments: origin.attachments.map(ref => ({ ...ref })) } : {}) })
    this.emit()
    markSendStage(command.commandId, 'written')
    const superseded = (): boolean => generation !== this.generation || this.turns.get(id) !== turn
    void connection.rpc.request('session/prompt', { sessionId: alias.hermesSessionId, prompt: [{ type: 'text', text: nativeText }, ...images] }, value => {
      if (superseded()) return
      const stop = promptAnswerSchema.parse(value).stopReason
      this.endTurn(id, stop === 'end_turn' ? 'completed' : stop === 'cancelled' ? 'interrupted' : stop === 'refusal' ? 'failed' : 'completed',
        stop === 'refusal' ? 'Hermes refused this turn. Nothing else was lost.' : undefined)
      this.emit()
    }, true).catch((error: unknown) => {
      if (superseded() || turn.ended) return
      this.endTurn(id, 'failed', connection.rpc.alive ? error instanceof HermesRejected ? 'Hermes refused this message. Nothing else was lost. Check the thread’s model server, then send again.' : undefined : PROCESS_LOST)
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
    if (!pending || pending.threadId !== command.threadId) throw new Error('That Hermes request is no longer waiting.')
    if (pending.connection !== connection) return { accepted: false, uncertain: true }
    if (pending.answering) return { accepted: false, uncertain: true }
    const result = hermesAnswer(pending, command.approved, command.permissionChoice)
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
      this.removeRequest(requestId); await pending.connection.rpc.reply(pending.wireId, hermesDecline(pending)).catch(() => undefined)
    }
    watcherGuard?.()
    if (connection) connection.rpc.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: alias.hermesSessionId } })
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
      try { pending.connection.rpc.write({ jsonrpc: '2.0', id: pending.wireId, result: hermesDecline(pending) }) } catch { /* A closed pipe grants nothing. */ }
    }
    this.pending.clear()
    for (const id of this.turns.keys()) this.endTurn(id, 'interrupted')
    this.turns.clear()
    for (const thread of this.threads.values()) thread.requests = []
    this.threadChanges.markAll()
    for (const connection of this.connections.values()) this.close(connection)
    for (const rpc of this.processes) rpc.close()
    this.connections.clear(); this.loading.clear(); this.loaded.clear(); this.outdated.clear()
    this.runtime.stop()
    this.state.connected = false; this.emit()
  }
  async closed(): Promise<void> { await this.runtime.closed(); await Promise.all([...this.processes].map(rpc => rpc.closed)); await Promise.all([...this.stopping.values()].map(work => work.catch(() => undefined))); await this.writing }
}
