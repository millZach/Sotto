import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
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
import { piActivities, PI_THINKING_ID_PREFIX } from './piActivity'
import { piCatalog, piModelRoute, piSettingsOf, PI_RUNTIME_MODES } from './piModels'
import { comparePiVersions, piEnvironment, PiRejected, PiRpc, PiUncertain, PI_CLI_VERSION,
  findPiExecutable, readPiVersion, type PiFrame } from './piRpc'
import { piProgram } from './piLookup'
import { piModels } from './piModels'
import { PiAccounts } from './piAccounts'
import { PI_SOURCES } from '../../shared/piSignIn'
import { PiTools } from './piTools'
import { PI_ISOLATION_ARGS, piSessionDirectory, piThreadEnvironment, writePiModels } from './piRuntime'
import { piEventUpdates, piUsage, type PiTurnUsage } from './piEvents'
import type { ActivitySubscriptionOptions, ProviderHost, AgentHostCommand, AgentHostResult, ThreadHistorySource, ThreadHostEvent,
  ThreadLaunchProfiles, ThreadReadPurpose, ThreadSessionDraft } from './host'
import { OpenSessions } from './openSessions'
import { verifyFileMentions } from './promptFiles'
import { ProviderUnavailable } from './providerProblem'
import { adapterItemCount, ProviderSnapshotPublisher } from './providerSnapshotPublisher'
import { AdapterThreadChanges, restOf } from './adapterThreadChanges'
import type { ActivityChangesListener, ActivityChangesSubscription } from './threadChanges'
import { SessionReaper, busyHolds, type HeldSession } from './sessionReaper'
import { markSendStage } from './sendStages'
import { settledThinking, thinkingSettledAs } from './thinkingActivity'
import { ThreadMessageLog } from './threadMessageLog'
import { effortAfterChange, validatePromptAttachments, validateThreadOptions } from './threadOptions'
import { scopedThreadServers, type ScopedThreadTools, type ThreadMcpServer } from './threadToolServer'
import { existingWorkingDirectory } from './threadWorktrees'
import { markTurnActivity } from './turnActivity'
import { WatcherProfileRefusal } from './watcherProfile'
import { heldProvidersOf, type HeldProviders } from '../../shared/heldProviders'

/** Pi's native JSONL RPC, one process per thread. Sotto owns identity, delivery and history. */

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const attachmentSchema = z.object({ id: z.string(), name: z.string(), mimeType: z.string(), sizeBytes: z.number() })
/** One message Sotto sent: its identities, the digest of what the client was given, and its turn's place. */
const originSchema = z.object({ messageId: z.string(), commandId: z.string(), digest: z.string(), createdAt: z.string(), turn: z.number().int().nonnegative(),
  attachments: z.array(attachmentSchema).default([]) })
type Origin = z.infer<typeof originSchema>
const aliasSchema = z.object({
  piSessionId: z.string().min(1).max(512).optional(), projectId: z.string(), cwd: z.string(), title: z.string(), createdAt: z.string(),
  modelId: z.string(), reasoningEffort: z.string().optional(), runtimeMode: z.enum(PI_RUNTIME_MODES).default('full-access'),
  /** How many user turns the session holds, as Sotto last counted them: the place the next prompt takes. */
  turns: z.number().int().nonnegative().default(0),
  origins: z.array(originSchema).default([]),
})
type Alias = z.infer<typeof aliasSchema>
/** A thread's sent identities, indexed once for delivery reconciliation. */
class ThreadIndex {
  private readonly byCommand = new Map<string, Origin>()
  private readonly byMessage = new Map<string, Origin>()
  constructor(readonly alias: Alias) {
    for (const origin of alias.origins) this.index(origin)
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

}
const aliasStoreSchema = z.record(z.string(), aliasSchema)
const projectStoreSchema = z.array(agentProjectSchema)
const PROCESS_LOST = 'Pi stopped before this reply finished, so it may be cut short. Send a message to carry on.'

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
    return { id: `pi-reply-${this.key}-${this.replies - 1}`, opened }
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
/** The turn a thread is on, as its own stream reports it. `taken` once the client showed it is working on a prompt Sotto sent. */
interface LiveTurn {
  readonly places: TurnPlaces
  readonly origin: Origin | undefined
  taken: boolean
  ended: boolean
  wake: (() => void) | undefined
}
/** One thread's own client process: its model declarations and client revisions, and what its session last said. */
interface Connection {
  readonly rpc: PiRpc
  readonly clientRevision: number
  readonly modelRevision: number
  closing: boolean
  /** The model and effort this process's session is on, as the client last said. */
  model: string | undefined
  effort: string | undefined
  usage: PiTurnUsage
  failed: boolean
}

export interface PiOptions {
  /** The `pi` to start, in place of finding the user's own: a test's fake client. */
  executable?: string
  /** Extra arguments ahead of `--mode`: a test's fake client process. */
  executableArgs?: readonly string[]
  environment?: NodeJS.ProcessEnv
  /** Sotto's Pi folder (ADR-0202): `<userData>/pi` by default. */
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

export class PiHost implements ProviderHost {
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
  private readonly dispatching = new Set<string>()
  private readonly observed = new Set<string>()
  private readonly outdated = new Set<string>()
  private tools = new PiTools()
  private toolClosing = Promise.resolve()
  readonly accounts: PiAccounts
  private accountModels: AgentModel[] = []
  private readonly processes = new Set<PiRpc>()
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
  private modelRevision = 0
  private modelConfig: string | undefined
  private servers: readonly OwnServer[] = []
  private generation = 0
  private writing = Promise.resolve()
  private state: AgentHostSnapshot = { connected: false, name: 'Pi', version: '', projects: [], models: [], threads: [],
    capabilities: { projects: true, threads: true, submit: true, observe: true, questions: false, permissions: false, interrupt: true, messageOrigin: true,
      reconcile: true, configureThread: true, configureThreadModel: true, skills: false, steer: false, compact: false } }
  private readonly homeDirectory: string

  constructor(private readonly userDataDirectory: string, private readonly options: PiOptions = {}) {
    this.homeDirectory = options.homeDirectory ?? join(userDataDirectory, 'pi')
    this.accounts = new PiAccounts(this.homeDirectory, () => this.clientProgram())
    this.aliasStore = new AtomicJsonStore(join(userDataDirectory, 'pi-threads.json'), aliasStoreSchema.parse, () => ({}))
    this.projectStore = new AtomicJsonStore(join(userDataDirectory, 'pi-projects.json'), projectStoreSchema.parse, () => [])
    this.reaper = new SessionReaper({
      ...(options.reaperSweepMs === undefined ? {} : { sweepEveryMs: options.reaperSweepMs }),
      ...(options.sessionIdleMs === undefined ? {} : { idleAfterMs: options.sessionIdleMs }),
      isWatched: id => this.observed.has(id),
      isBusy: id => this.busy(id),
      whyBusy: id => busyHolds({ busy: this.working(id), request: this.asking(id) }),
      stop: id => this.stopSession(id),
    })
  }

  /** The sessions the reaper tracks, why each is held, and its process, read only on request (#2398). */
  heldSessions(): HeldSession[] { return this.reaper.held(id => this.connections.get(id)?.rpc.pid) }

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
  /** Sotto's Pi folder, which every process runs as `PI_CODING_AGENT_DIR` (ADR-0202). */
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
   * ADR-0140: stop the thread's own Pi process if it has one, remove its alias and every per-thread
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
    this.tools.revoke(id)
    this.observed.delete(id)
    this.outdated.delete(id)
    this.dispatching.delete(id)
    this.loaded.delete(id)
    this.endTurn(id, 'interrupted')
    this.turns.delete(id)
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
    if (!alias) throw new Error('This Pi thread does not exist.')
    let thread = this.threads.get(id)
    if (!thread) {
      thread = { id, projectId: alias.projectId, title: alias.title, workingDirectory: alias.cwd, modelId: alias.modelId, runtimeMode: alias.runtimeMode,
        ...(alias.reasoningEffort ? { reasoningEffort: alias.reasoningEffort } : {}),
        status: alias.piSessionId ? 'idle' : 'error', messages: [], requests: [] }
      this.threads.set(id, thread)
      if (this.connections.has(id) && !this.loading.has(id)) this.loaded.add(id)
    }
    this.changed(id)
    return thread
  }
  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new PiUncertain('Pi’s connection changed before this could finish.')
  }

  /**
   * Watcher is outside this first version. Refuse its profile before a Pi process starts (ADR-0202).
   */
  private async refuseWatcher(id: string): Promise<void> {
    const generation = this.generation
    let profile
    try { profile = await this.launchProfiles?.profileFor(id) }
    catch (error) {
      if (generation !== this.generation) throw new PiUncertain('Pi’s connection changed.')
      throw error instanceof WatcherProfileRefusal ? error : new WatcherProfileRefusal('Watcher’s saved profile could not be verified. Nothing was sent.')
    }
    if (generation !== this.generation) throw new PiUncertain('Pi’s connection changed.')
    if (!profile) return
    const reason = `Pi cannot host Watcher. Nothing was sent. Choose a ${watcherProvidersInWords(this.options.heldProviders ?? heldProvidersOf({}))} model for Watcher.`
    try { profile.revoke(reason) } catch { /* The refusal stands either way. */ }
    throw new WatcherProfileRefusal(reason)
  }

  /** Sotto's own tool servers for this thread, each with the thread's Bearer [REDACTED], as the other RPC adapters pass them. */
  private async toolServers(id: string): Promise<ThreadMcpServer[]> {
    const servers: ThreadMcpServer[] = []
    if (this.browserTools) servers.push(await this.browserTools.mcpServer(id))
    for (const { server } of await scopedThreadServers(this.threadTools, id)) servers.push(server)
    return servers
  }

  // ---- Processes -----------------------------------------------------------------------------------------------------

  private spawn(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, receive: (frame: PiFrame) => Promise<void> | void, lost: () => void, executable = this.executable!): PiRpc {
    const rpc = new PiRpc(executable, args, cwd, env, this.options.requestTimeoutMs ?? 30_000, receive, lost)
    this.processes.add(rpc); void rpc.closed.then(() => this.processes.delete(rpc))
    return rpc
  }
  async clientProgram() {
    await mkdir(this.homeDirectory, { recursive: true, mode: 0o700 })
    const executable = this.executable ?? this.options.executable ?? await findPiExecutable(this.options.environment)
    if (!executable) throw new Error('Install Pi before signing in. Your threads are kept.')
    const env = piEnvironment(this.homeDirectory, {}, this.options.environment)
    const version = await readPiVersion(executable, env, this.options.executableArgs ?? [])
    if (comparePiVersions(version, PI_CLI_VERSION) < 0) throw new Error(`Pi ${PI_CLI_VERSION} or newer is needed.`)
    const program = await piProgram(executable, env)
    return { ...program, args: [...program.args, ...(this.options.executableArgs ?? [])] }
  }
  setAccountModels(models: AgentModel[]): void {
    if (JSON.stringify(models) === JSON.stringify(this.accountModels)) return
    this.accountModels = models
    this.state.models = [...piCatalog(this.servers), ...this.accountModels]
    this.modelRevision++
    for (const [id, connection] of this.connections) if (this.stale(connection)) this.outdated.add(id)
    this.emit()
  }
  async accountsChanged(): Promise<void> {
    this.accounts.invalidate()
    this.setAccountModels((await this.accounts.read()).models)
  }
  private readModelConfig(): void { this.modelConfig = piModels(this.servers) }
  private async startProcess(id: string, alias: Alias, cwd: string): Promise<Connection> {
    if (!this.executable || !this.state.connected) throw new Error('Connect Pi before using its threads.')
    const modelRevision = this.modelRevision
    this.readModelConfig()
    if (!this.model(alias.modelId)) throw new Error('Pi no longer offers this model. Your thread is kept. Check its model source in Settings or choose another model.')
    const env = await piThreadEnvironment(this.homeDirectory, id, this.modelConfig!, [await this.tools.mount(id, await this.toolServers(id))], this.options.environment)
    const sessions = piSessionDirectory(this.homeDirectory, id)
    await mkdir(sessions, { recursive: true })
    const connection: Connection = { rpc: undefined as unknown as PiRpc, clientRevision: this.clientRevision,
      modelRevision, closing: false, model: undefined, effort: undefined, usage: {}, failed: false }
    const args = [...(this.options.executableArgs ?? []), '--mode', 'rpc', '--session-dir', sessions, '--model', alias.modelId,
      ...PI_ISOLATION_ARGS, ...(alias.piSessionId ? ['--session', alias.piSessionId] : [])]
    const program = await piProgram(this.executable, env)
    const rpc = this.spawn([...program.args, ...args], cwd, program.env, frame => this.frame(id, connection, frame), () => this.processLost(id, connection), program.executable)
    ;(connection as { rpc: PiRpc }).rpc = rpc
    try {
      await rpc.request('get_state', {}, value => {
        const state = piSettingsOf(value)
        if (alias.piSessionId && state.sessionId !== alias.piSessionId) throw new Error('Pi opened a different session.')
        this.readSettings(connection, value)
      }, false, this.options.startTimeoutMs ?? 30_000)
      await rpc.request('set_auto_retry', { enabled: false })
      await rpc.request('set_auto_compaction', { enabled: false })
    } catch (error) { this.close(connection); throw error }
    return connection
  }
  private close(connection: Connection): void { connection.closing = true; connection.rpc.close() }

  // ---- Connecting ----------------------------------------------------------------------------------------------------

  async connect(): Promise<AgentHostSnapshot> {
    this.disconnect(); await this.closed()
    const generation = this.generation
    try {
      await mkdir(this.homeDirectory, { recursive: true })
      const executable = this.options.executable ?? await findPiExecutable(this.options.environment)
      if (!executable || !isAbsolute(executable)) throw new ProviderUnavailable('not-installed', 'Install Pi, then connect it again. Your threads are kept.')
      const version = await readPiVersion(executable, piEnvironment(this.homeDirectory, {}, this.options.environment), this.options.executableArgs ?? [])
      this.assertGeneration(generation)
      if (comparePiVersions(version, PI_CLI_VERSION) < 0) throw new ProviderUnavailable('too-old', `Pi ${PI_CLI_VERSION} or newer is needed, and this one is ${version}. Update it, then connect again. Your threads are kept.`, version, PI_CLI_VERSION)
      this.servers = await this.options.servers?.() ?? []
      this.assertGeneration(generation)
      this.readModelConfig()
      await writePiModels(this.homeDirectory, this.modelConfig!)
      this.accounts.invalidate()
      this.accountModels = (await this.accounts.read()).models
      const models = [...piCatalog(this.servers), ...this.accountModels]
      if (!models.length) throw new ProviderUnavailable('signed-out', 'Pi has no model it can use yet. Sign in to a Pi model source or add a server under APIs and your own model servers, then connect again. Your threads are kept.', version)
      this.executable = executable
      this.readModelConfig()
      const [aliases, projects] = await Promise.all([this.aliasStore.read(), this.projectStore.read()])
      this.assertGeneration(generation)
      for (const id of this.forgottenAliasIds) delete aliases[id]
      this.aliases = aliases; this.aliasesLoaded = true; this.indexes.clear(); this.state.projects = projects; this.state.models = models
      this.threads.clear(); this.threadChanges.markAll(); this.log.forgetAll()
      for (const id of Object.keys(this.aliases)) { this.thread(id); this.log.seed(id, this.history?.messageIdentities(id) ?? []) }
      this.state.connected = true; this.state.version = `${version} / RPC`
      delete this.state.error; delete this.state.problem; delete this.state.requiredVersion
      if (comparePiVersions(version, PI_CLI_VERSION) > 0) this.state.verifiedVersion = PI_CLI_VERSION
      else delete this.state.verifiedVersion
      // A thread that cannot open is that thread's error, not the provider's: the rest stay usable.
      await Promise.all([...this.observed].filter(id => this.aliases[id]?.piSessionId).map(id => this.open(id).catch((error: unknown) => {
        if (generation !== this.generation) return
        this.markOpenFailed(id, error)
      })))
      this.assertGeneration(generation)
      this.reaper.start(); this.emit(); return this.current()
    } catch (error) {
      if (generation === this.generation) this.disconnect()
      if (error instanceof WatcherProfileRefusal) throw error
      const refused = error instanceof ProviderUnavailable
      const detail = refused || error instanceof PiUncertain ? error.message : error instanceof Error && /^Sotto could not read/u.test(error.message) ? error.message : ''
      const message = ['Could not connect Pi.', detail, refused ? '' : 'Connect again to retry.'].filter(Boolean).join(' ')
      if (refused) throw new ProviderUnavailable(error.problem, message, error.version, error.requiredVersion)
      throw new Error(message, { cause: error })
    }
  }
  private markOpenFailed(id: string, error: unknown): void {
    if (!this.aliases[id]) return
    this.thread(id).status = 'error'
    this.state.error = error instanceof Error && error.message ? error.message : 'A Pi thread could not be opened. Your thread is kept. Reconnect Pi to try again.'
    this.emit()
  }
  /**
   * The user's own model servers changed: the catalog is rebuilt and every running process, started with the old
   * model declarations, is outdated, moving to a fresh one as it goes idle. Never awaits the provider, so a failed read
   * leaves the last good catalog.
   */
  ownServersChanged(): void {
    if (!this.state.connected) return
    const generation = this.generation
    void (async () => {
      const servers = await this.options.servers?.()
      if (!servers || generation !== this.generation) return
      this.servers = servers
      this.state.models = [...piCatalog(servers), ...this.accountModels]
      // Only a new model declarations outdates a process: a save that leaves it the same, such as a keyed server's, restarts nothing.
      if (piModels(servers) !== this.modelConfig) {
        this.modelRevision++
        for (const [id, connection] of this.connections) if (this.stale(connection)) this.outdated.add(id)
      }
      this.emit()
    })().catch(() => undefined)
  }
  /**
   * Pi's client on disk was updated while Sotto stayed connected (ADR-0042, ADR-0038): find it again
   * and hold it to the floor; every new process starts from it, and each thread moves onto it as it goes idle.
   */
  async clientUpdated(): Promise<void> {
    if (!this.state.connected) return
    const generation = this.generation
    const executable = this.options.executable ?? await findPiExecutable(this.options.environment).catch(() => undefined)
    if (generation !== this.generation || !this.state.connected) return
    if (!executable) throw new Error('Pi was updated, but Sotto cannot find it now. Threads that are working carry on and nothing was lost. Check Pi, then connect it again.')
    let version: string
    try { version = await readPiVersion(executable, piEnvironment(this.homeDirectory, {}, this.options.environment), this.options.executableArgs ?? []) }
    catch (error) {
      if (generation !== this.generation || !this.state.connected) return
      throw new Error('Pi was updated, but the new version did not answer. Threads that are working carry on and nothing was lost. Connect Pi again to try the new version.', { cause: error })
    }
    if (generation !== this.generation || !this.state.connected) return
    if (comparePiVersions(version, PI_CLI_VERSION) < 0) throw new Error(`Pi was updated, but Sotto cannot run ${version}: ${PI_CLI_VERSION} or newer is needed. Threads that are working carry on and nothing was lost.`)
    this.executable = executable; this.clientRevision++
    this.state.version = `${version} / RPC`
    if (comparePiVersions(version, PI_CLI_VERSION) > 0) this.state.verifiedVersion = PI_CLI_VERSION
    else delete this.state.verifiedVersion
    for (const [id, connection] of this.connections) if (connection.clientRevision < this.clientRevision) this.outdated.add(id)
    this.emit()
  }
  /** Whether a process started before the newest client or model declarations. */
  private stale(connection: Connection): boolean { return connection.clientRevision < this.clientRevision || connection.modelRevision < this.modelRevision }
  /** Stop each outdated process whose thread is not busy; a watched one opens again at once on the new client or model declarations. */
  private stopOutdated(): void {
    if (!this.outdated.size) return
    for (const id of [...this.outdated]) {
      const connection = this.connections.get(id)
      if (!connection || !this.stale(connection)) { this.outdated.delete(id); continue }
      if (this.busy(id)) continue
      this.outdated.delete(id)
      const generation = this.generation
      void this.stopSession(id).then(() => {
        if (generation === this.generation && this.observed.has(id) && this.aliases[id]?.piSessionId) return this.open(id).then(() => undefined)
      }).catch((error: unknown) => { if (generation === this.generation) this.markOpenFailed(id, error) })
    }
  }

  // ---- Sessions ------------------------------------------------------------------------------------------------------

  /** A thread being created or sent to, a prompt in flight, a session opening or an unanswered request hold a session open. */
  private busy(id: string): boolean { return this.working(id) || this.asking(id) }
  private working(id: string): boolean {
    const turn = this.turns.get(id)
    return this.dispatching.has(id) || this.loading.has(id) || this.stopping.has(id) || (turn !== undefined && !turn.ended)
  }
  private asking(id: string): boolean { return (this.threads.get(id)?.requests.length ?? 0) > 0 }
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
    if (!alias?.piSessionId) throw new Error('Pi did not confirm this thread’s session. Your thread is kept. Start a new thread to carry on.')
    const cwd = await existingWorkingDirectory(alias.cwd)
    this.assertGeneration(generation)
    const connection = await this.startProcess(id, alias, cwd)
    if (generation !== this.generation) { this.close(connection); throw new PiUncertain('Pi’s connection changed while the thread was opening.') }
    this.connections.set(id, connection)
    if (this.stale(connection)) this.outdated.add(id)
    try {
      this.assertGeneration(generation)
      // A resumed session replays nothing (ADR-0202): the thread's history stays Sotto's, and the session continues.
      await connection.rpc.request('get_state', {}, value => { this.readSettings(connection, value) })
      if (generation !== this.generation || this.connections.get(id) !== connection) throw new PiUncertain('Pi’s connection changed while the thread was opening.')
      await this.applySettings(alias, connection)
      this.log.pin(id); this.reaper.touch(id)
      const thread = this.thread(id)
      if (!this.turns.get(id) || this.turns.get(id)!.ended) thread.status = 'idle'
      return connection
    } catch (error) {
      if (this.connections.get(id) === connection) this.connections.delete(id)
      this.close(connection)
      if (error instanceof PiRejected) throw new Error('Pi could not open this thread’s saved session. Your Sotto history is kept. Start a new thread to carry on; Sotto will not resend earlier work.', { cause: error })
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
      this.tools.revoke(id)
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
    if (!this.state.connected || !this.aliases[id]?.piSessionId) return
    await this.open(id)
    this.reaper.touch(id)
  }
  observeThreads(ids: readonly string[]): void {
    this.observed.clear(); for (const id of ids) this.observed.add(id)
    this.log.observe(ids)
    if (!this.state.connected) return
    const generation = this.generation
    for (const id of ids) if (this.aliases[id]?.piSessionId) void this.open(id).catch((error: unknown) => { if (generation === this.generation) this.markOpenFailed(id, error) })
  }
  async snapshot(): Promise<AgentHostSnapshot> { return this.current() }
  async refreshThread(id: string, purpose?: ThreadReadPurpose): Promise<AgentHostSnapshot> {
    if (!this.aliases[id]?.piSessionId) throw new Error('This Pi thread has no confirmed session.')
    const generation = this.generation
    await this.refuseWatcher(id)
    this.assertGeneration(generation)
    await this.open(id)
    return this.current(purpose?.historyFromEvents)
  }

  // ---- What the client says -------------------------------------------------------------------------------------------

  /** The model and effort a session answer names, as the client last said them. */
  private readSettings(connection: Connection, value: unknown): void {
    const settings = piSettingsOf(value)
    if (settings.model !== undefined) connection.model = settings.model
    connection.effort = settings.effort
  }
  /** Events stay with their originating process. Only agent_settled finishes a turn. */
  private async frame(id: string, connection: Connection, frame: PiFrame): Promise<void> {
    const alias = this.aliases[id]
    if (!alias || connection.closing || this.connections.get(id) !== connection) return
    if (frame.type === 'agent_start') this.taken(id)
    if (frame.type === 'message_end') {
      const message = record(frame.message)
      if (message?.role === 'assistant') {
        if (message.stopReason === 'error') connection.failed = true
        piUsage(connection.usage, message.usage)
      }
    }
    for (const update of piEventUpdates(frame)) this.liveUpdate(id, alias, update)
    if (frame.type === 'agent_settled') {
      this.readUsage(id, connection)
      if (this.connections.get(id) !== connection) return
      const status = frame.aborted === true ? 'interrupted' : connection.failed ? 'failed' : 'completed'
      this.endTurn(id, status, status === 'failed' ? 'Pi could not finish this turn. Your thread is kept. Check its model source or sign-in in Settings, then try again.' : undefined)
      this.emit()
    }
  }
  private readUsage(id: string, connection: Connection): void {
    // Never await a command inside the receive callback: its response is on that same serialized stream.
    const usage = { ...connection.usage }
    void connection.rpc.request('get_session_stats', {}, value => {
      if (this.connections.get(id) !== connection) return
      const stats = record(value), context = record(stats?.contextUsage), tokens = record(stats?.tokens)
      const thread = this.thread(id), now = new Date().toISOString()
      thread.usage = { rateVersions: [], partial: true, ...thread.usage, latest: usage, updatedAt: now,
        ...(typeof context?.tokens === 'number' ? { contextUsed: context.tokens, contextUpdatedAt: now } : {}),
        ...(typeof context?.contextWindow === 'number' ? { contextWindow: context.contextWindow } : {}),
        ...(typeof tokens?.input === 'number' && typeof tokens.output === 'number' ? { total: { input: tokens.input, output: tokens.output } } : {}),
      }
      this.emit()
    }).catch(() => undefined)
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
        // Fullness only: the client reports no token counts, so the ledger stays partial and outside Usage.
        thread.usage = { rateVersions: [], partial: true, ...thread.usage,
          ...(used !== undefined ? { contextUsed: used } : {}), ...(size !== undefined ? { contextWindow: size } : {}),
          contextUpdatedAt: now, updatedAt: now }
        this.emit(true)
      }
      return
    }
    if (!['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(kind)) { this.taken(id); return }
    const content = record(update.content)
    const words = content?.type === 'text' && typeof content.text === 'string' ? content.text : undefined
    if (kind === 'user_message_chunk') {
      if (words === undefined) return
      const turn = this.turns.get(id)
      // A matching user echo is delivery evidence for the prompt Sotto sent, not a second message.
      if (turn?.origin && !turn.ended && digest(words) === turn.origin.digest) { this.taken(id); return }
      // Something typed into this session elsewhere starts a turn of its own.
      const index = alias.turns; alias.turns++
      void this.persist().catch(() => undefined)
      const key = `pi-user-${index}-${digest(words).slice(0, 16)}`
      this.log.add(id, { id: key, role: 'user', text: words, createdAt: new Date().toISOString() })
      // A turn still running keeps its place, so its prompt's answer still ends it.
      if (!turn || turn.ended) this.turns.set(id, { places: new TurnPlaces(key), origin: undefined, taken: true, ended: true, wake: undefined })
      this.emit()
      return
    }
    this.taken(id)
    let turn = this.turns.get(id)
    if (!turn) {
      turn = { places: new TurnPlaces(this.log.lastUserMessageId(id) ?? 'pi-history'), origin: undefined, taken: true, ended: true, wake: undefined }
      this.turns.set(id, turn)
    }
    const thread = this.thread(id)
    if (kind === 'agent_message_chunk') {
      if (words === undefined) return
      const reply = turn.places.reply()
      if (reply.opened || !this.log.has(id, reply.id)) {
        this.log.add(id, { id: reply.id, role: 'assistant', text: words, createdAt: new Date().toISOString(), turnMessageId: turn.places.key })
        const settled = settledThinking(PI_THINKING_ID_PREFIX, thread.activities ?? [], 'completed', true)
        if (settled.length) thread.activities = mergeAgentActivities(thread.activities, settled)
        this.emit()
      } else { this.log.appendText(id, reply.id, words); this.emit(true) }
      return
    }
    const key = kind === 'agent_thought_chunk' ? turn.places.thought()
      : typeof update.toolCallId === 'string' && (kind === 'tool_call' || kind === 'tool_call_update') ? turn.places.tool(update.toolCallId, kind === 'tool_call') : undefined
    const rows = piActivities(update, { turnId: turn.places.key, afterMessageId: this.log.lastMessageId(id), cwd: alias.cwd, key }, thread.activities, true, this.options.captureMedia)
    if (rows.length) { thread.activities = mergeAgentActivities(thread.activities, rows); this.emit(kind === 'agent_thought_chunk') }
  }
  /** The client has shown it is working on the prompt Sotto sent: the send waiting on it is woken. */
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
    const thoughts = settledThinking(PI_THINKING_ID_PREFIX, thread.activities ?? [], thinkingSettledAs(status), true)
    const settled = thoughts.length ? mergeAgentActivities(thread.activities, thoughts) : thread.activities
    const closed = settled?.map(row => row.status === 'running' && row.kind !== 'turn' && row.kind !== 'plan' && row.turnId === turn.places.key
      ? { ...row, status: status === 'completed' ? 'completed' as const : status === 'interrupted' ? 'interrupted' as const : 'unknown' as const } : row)
    thread.activities = markTurnActivity(closed, { provider: 'pi', turnId: turn.places.key, status, ...(error ? { error } : {}) })
    this.changed(id)
    this.reaper.touch(id)
  }
  /** The thread's own server as its turn record names it (ADR-0124): every Pi turn runs on one. */
  private ownServerTurn(alias: Alias): OwnServerTurn | undefined {
    const route = piModelRoute(alias.modelId)
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
      catch (error) { if (error instanceof PiUncertain) return { accepted: false, uncertain: true }; throw error }
      this.assertGeneration(generation)
    }
    if (command.type === 'steer') throw new Error('Pi takes no message while it works. Queue this follow-up instead.')
    if (command.type === 'compact-thread') throw new Error('Pi cannot compact a thread.')
    if (!this.state.connected) throw new Error('Connect Pi before managing threads.')
    if (command.type !== 'send' && command.type !== 'create-thread') return this.run(command, generation, watcherGuard)
    if (this.dispatching.has(command.threadId)) throw new Error('Pi is already receiving work for this thread. Wait for its delivery result.')
    this.dispatching.add(command.threadId)
    try { return await this.run(command, generation, watcherGuard) } finally { this.dispatching.delete(command.threadId); this.stopOutdated() }
  }
  private async run(command: AgentHostCommand, generation: number, watcherGuard?: () => void): Promise<AgentHostResult> {
    try {
      if (command.type === 'create-project') {
        if (!isAbsolute(command.path)) throw new Error('Pi projects need an absolute folder.')
        if (!this.state.projects.some(project => project.id === command.projectId)) {
          this.state.projects.push({ id: command.projectId, title: command.title, path: command.path })
          await this.projectStore.write(this.state.projects)
        }
        this.emit(); return { accepted: true }
      }
      if (command.type === 'create-thread') return await this.create(command, generation, watcherGuard)
      if (command.type === 'configure-thread') return await this.configure(command, generation, watcherGuard)
      const id = command.threadId, alias = this.aliases[id]
      if (!alias?.piSessionId) throw new Error('Pi did not confirm this thread’s session. Your thread is kept. Do not repeat its creation automatically.')
      if (command.type === 'interrupt') return await this.interrupt(id, alias, watcherGuard)
      const connection = await this.open(id)
      if (generation !== this.generation || this.connections.get(id) !== connection) throw new PiUncertain('Pi’s connection changed.')
      this.reaper.touch(id)
      if (command.type === 'send') return await this.send(command, alias, connection, generation, watcherGuard)
      if (command.type === 'answer') throw new Error('Pi has no approval or question cards. It runs with Full access and does not ask before tools.')
      throw new Error('Pi does not take that action.')
    } catch (error) {
      if (error instanceof PiUncertain) return { accepted: false, uncertain: true }
      throw error
    }
  }
  private runtimeModeOf(command: { runtimeMode?: AgentRuntimeMode | undefined }): AgentRuntimeMode {
    const mode = command.runtimeMode ?? 'full-access'
    if (!PI_RUNTIME_MODES.includes(mode)) throw new Error('That permission mode is not supported by this provider.')
    return mode
  }
  private async create(command: Extract<AgentHostCommand, { type: 'create-thread' }>, generation: number, watcherGuard?: () => void): Promise<AgentHostResult> {
    const saved = this.aliases[command.threadId]
    if (saved) return saved.piSessionId ? { accepted: true } : { accepted: false, uncertain: true }
    const runtimeMode = this.runtimeModeOf(command)
    validateThreadOptions(this.state, { ...command, runtimeMode })
    const project = this.state.projects.find(item => item.id === command.projectId)
    if (!project) throw new Error('Choose a Pi project first.')
    // A create that names no effort starts on the model's default and says so, so the chip names the effort it runs at.
    const reasoningEffort = command.reasoningEffort ?? this.model(command.modelId)?.defaultReasoningEffort
    const alias: Alias = { projectId: project.id, cwd: await existingWorkingDirectory(command.workingDirectory ?? project.path), title: command.title, createdAt: new Date().toISOString(),
      modelId: command.modelId, ...(reasoningEffort ? { reasoningEffort } : {}), runtimeMode, turns: 0, origins: [] }
    this.assertGeneration(generation)
    const connection = await this.startProcess(command.threadId, alias, alias.cwd)
    if (generation !== this.generation) { this.close(connection); throw new PiUncertain('Pi’s connection changed.') }
    // The process is the thread's from here, so what it says while its session is made reaches the thread.
    this.connections.set(command.threadId, connection)
    if (this.stale(connection)) this.outdated.add(command.threadId)
    try {
      this.aliases[command.threadId] = alias; await this.persist()
      this.assertGeneration(generation)
      watcherGuard?.()
      await connection.rpc.request('get_state', {}, async value => {
        alias.piSessionId = piSettingsOf(value).sessionId; this.readSettings(connection, value); await this.persist()
      })
      this.assertGeneration(generation)
      await this.applySettings(alias, connection)
    } catch (error) {
      if (this.connections.get(command.threadId) === connection) this.connections.delete(command.threadId)
      this.close(connection)
      if (this.aliases[command.threadId] === alias && alias.piSessionId) this.thread(command.threadId).status = 'error'
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
    const route = piModelRoute(alias.modelId)
    if (!route || !this.model(alias.modelId)) throw new Error('Choose a model your servers offer, then send.')
    if (connection.model !== alias.modelId) {
      await connection.rpc.request('set_model', { provider: route.serverId, modelId: route.model })
      await connection.rpc.request('get_state', {}, value => this.readSettings(connection, value))
      if (connection.model !== alias.modelId) throw new Error('Pi did not confirm this model. Your draft is kept. Choose the model again.')
    }
    if (alias.reasoningEffort && connection.effort !== alias.reasoningEffort) {
      await connection.rpc.request('set_thinking_level', { level: alias.reasoningEffort })
      await connection.rpc.request('get_state', {}, value => this.readSettings(connection, value))
      if (connection.effort !== alias.reasoningEffort) throw new Error('Pi did not confirm this effort. Your draft is kept. Choose the effort again.')
    }
  }

  private async configure(command: Extract<AgentHostCommand, { type: 'configure-thread' }>, generation: number, watcherGuard?: () => void): Promise<AgentHostResult> {
    const id = command.threadId, alias = this.aliases[id]
    if (!alias?.piSessionId) throw new Error('Pi did not confirm this thread’s session. Your thread is kept.')
    if (command.providerMode !== undefined) throw new Error('That permission mode is not supported by this provider.')
    const runtimeMode = command.runtimeMode === undefined ? undefined : this.runtimeModeOf(command)
    const modelId = command.modelId ?? alias.modelId
    const reasoningEffort = effortAfterChange(this.state, command, alias.reasoningEffort)
    validateThreadOptions(this.state, { modelId, ...(command.reasoningEffort !== undefined ? { reasoningEffort: command.reasoningEffort } : {}), ...(runtimeMode ? { runtimeMode } : {}) }, alias.modelId)
    const thread = this.thread(id)
    const modeChanges = runtimeMode !== undefined && runtimeMode !== alias.runtimeMode
    watcherGuard?.()
    if (modeChanges) { await this.loading.get(id)?.catch(() => undefined); await this.stopping.get(id); this.assertGeneration(generation) }
    // A process takes its Full access mode when it starts, so a new mode means a new process, once the thread is quiet.
    if (modeChanges && this.busy(id)) throw new Error('Pi is working on this thread. Its permission mode is unchanged. Change it once the thread is idle.')
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
      if (generation !== this.generation || this.connections.get(id) !== connection || !this.state.connected) throw new PiUncertain('Pi’s connection changed. Delivery has not been confirmed.')
    }
    const index = this.indexOf(id, alias)
    const previous = index.sent(command.commandId, command.messageId)
    if (previous) {
      if (previous.messageId !== command.messageId || previous.commandId !== command.commandId) throw new Error('This Pi message identity is already in use.')
      return this.log.has(id, previous.messageId) ? { accepted: true } : { accepted: false, uncertain: true }
    }
    if (command.expectedLastUserMessageId !== undefined && (this.log.lastUserMessageId(id) ?? null) !== command.expectedLastUserMessageId) throw new Error('The latest user message changed. Review the thread before replying.')
    const running = this.turns.get(id)
    if (running && !running.ended) throw new Error('Pi is still working on this thread. Queue this follow-up.')
    if (this.thread(id).requests.length) throw new Error('Answer Pi’s pending request before sending another message.')
    // An image is refused here, before any bytes are read, unless the model's record and the client both take images.
    const source = PI_SOURCES.find(source => alias.modelId.startsWith(source.id + '/'))
    if (source && (await this.accounts.check(source.id)).status !== 'ready') {
      await this.accountsChanged()
      throw new Error(`Pi is not signed in to ${source.name}, or its sign-in expired. Your draft is kept. Sign in again in Settings > Providers > Pi.`)
    }
    const attachments = validatePromptAttachments(this.state, alias.modelId, command.attachments, { workingDirectory: alias.cwd })
    verifyFileMentions(command.text, command.files)
    if (command.skills?.length) throw new Error('Pi takes no skills from the composer in this version.')
    // Images go as RPC image blocks after the words; files that are not images are saved into the thread's folder and
    // named in a note after the words (ADR-0131).
    const delivered = await deliverAttachments(alias.cwd, attachments)
    const nativeText = withAttachedFilesNote(command.text, delivered.note)
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
    connection.usage = {}; connection.failed = false
    const turn: LiveTurn = { places: new TurnPlaces(origin.messageId), origin, taken: false, ended: false, wake: undefined }
    this.turns.set(id, turn)
    thread.status = 'running'; thread.lastTurn = { id: origin.messageId, status: 'running' }
    const ownServer = this.ownServerTurn(alias)
    thread.activities = markTurnActivity(thread.activities, { provider: 'pi', turnId: origin.messageId, status: 'running', afterMessageId: origin.messageId, ...(ownServer ? { ownServer } : {}) })
    this.emit()
    this.log.add(id, { id: origin.messageId, role: 'user', text: command.text, commandId: origin.commandId, createdAt: origin.createdAt,
      ...(origin.attachments.length ? { attachments: origin.attachments.map(ref => ({ ...ref })) } : {}) })
    this.emit()
    markSendStage(command.commandId, 'written')
    const superseded = (): boolean => generation !== this.generation || this.turns.get(id) !== turn
    void connection.rpc.request('prompt', { message: nativeText, ...(images.length ? { images } : {}) }, value => {
      if (superseded()) return
      const disposition = record(value)?.disposition
      if (disposition !== 'started') {
        this.endTurn(id, 'failed', 'Pi did not start this turn. Your thread is kept. Review the message before trying again.')
      }
      this.taken(id); this.emit()
    }).catch((error: unknown) => {
      if (superseded() || turn.ended || error instanceof PiUncertain) return
      this.endTurn(id, 'failed', connection.rpc.alive ? 'Pi refused this message. Your thread is kept. Check its model server, then try again.' : PROCESS_LOST)
      this.emit()
    })
    return this.awaitTaken(command.commandId, turn, generation)
  }
  /**
   * Pi acknowledges prompt acceptance separately from completion. A late acknowledgement still applies;
   * a prompt with no evidence by the deadline stays uncertain and is never sent again.
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
  private async interrupt(id: string, _alias: Alias, watcherGuard?: () => void): Promise<AgentHostResult> {
    const connection = this.connections.get(id)
    watcherGuard?.()
    if (connection) {
      await connection.rpc.request('clear_queue', {})
      await connection.rpc.request('abort', {})
    }
    return { accepted: true }
  }
  private clearRequests(id: string): void {
    const thread = this.threads.get(id)
    if (thread) { thread.requests = []; this.changed(id) }
  }

  // ---- Disconnecting -------------------------------------------------------------------------------------------------

  disconnect(): void {
    this.generation++; this.reaper.dispose()
    for (const id of this.turns.keys()) this.endTurn(id, 'interrupted')
    this.turns.clear()
    for (const thread of this.threads.values()) thread.requests = []
    this.threadChanges.markAll()
    for (const connection of this.connections.values()) this.close(connection)
    for (const rpc of this.processes) rpc.close()
    this.connections.clear(); this.loading.clear(); this.loaded.clear(); this.outdated.clear()
    const tools = this.tools; this.tools = new PiTools()
    const previous = this.toolClosing
    this.toolClosing = (async () => {
      const results = await Promise.allSettled([previous, (async () => tools.close())()])
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })()
    // A disconnect starts closing now; closed() later reports any failure after every resource drains.
    void this.toolClosing.catch(() => undefined)
    this.state.connected = false; this.emit()
  }
  async closed(): Promise<void> {
    const results = await Promise.allSettled([this.toolClosing, ...[...this.processes].map(rpc => rpc.closed),
      ...[...this.stopping.values()].map(work => work.catch(() => undefined)), this.writing])
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
}
