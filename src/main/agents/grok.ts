import { BROWSER_MCP_SERVER, type BrowserAgentTools } from './browserAgentServer'
import { personalContext, type NativeConversation, type PersonalConversation, type PersonalCreateCommand, type PersonalMemory } from './personalConversation'
import { existingWorkingDirectory } from './threadWorktrees'
import { ProviderSnapshotPublisher } from './providerSnapshotPublisher'
import { NativeUsage } from './nativeUsage'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { agentProjectSchema, type AgentHostSnapshot, type AgentThread, type AgentMessage, type AgentRuntimeMode } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { AgentHost, AgentHostCommand, AgentHostResult, AgentSkillScope, ThreadHistorySource, ThreadHostEvent } from './host'
import { ThreadMessageLog } from './threadMessageLog'
import { cloneHostSnapshot } from './cloneHostSnapshot'
import type { AgentSkillCatalog } from '../../shared/agentSkills'
import { discoverGrokSkills, grokSkillPrompt } from './grokSkills'
import { verifyFileMentions } from './promptFiles'
import { validatePromptAttachments, validateThreadOptions } from './threadOptions'
import { grokActivities } from './grokActivity'
import { markTurnActivity } from './turnActivity'
import { grokPending, grokAnswer, type GrokPending as Pending } from './grokRequests'
import { needsPerson, unreadableRequest } from './nativeRequests'
import { object } from './claudeProtocol'
import { mergeAgentActivities, type AgentActivity } from '../../shared/agentActivity'
import { compareClientVersions } from './clientVersions'
import { findGrokExecutable, grokEnvironment, GROK_ACP_VERSION, GROK_CLI_VERSION, GrokRpc, GrokRejected, GrokUncertain, GrokUnsupported, type GrokFrame } from './grokRpc'
import { SessionReaper } from './sessionReaper'

// Only strip our suffix after durable origin/digest matching; foreign native
// messages remain untouched and no extra plaintext prompt is stored in aliases.
function personalAuthoredText(text: string): string {
  const boundary = text.lastIndexOf('\n\n<SottoPersonalContext>\n')
  return boundary >= 0 && text.endsWith('\n</SottoPersonalContext>') ? text.slice(0, boundary) : text
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
// Grok 1.0.5 applies session _meta when a session starts or loads while not resident in its leader.
// A resident session can gain always-approve from session/load but never loses it, so mode changes
// close the session first. session/set_mode accepts any value, so it is not used as proof of a mode.
const grokRuntimeModes = ['approval-required', 'auto', 'full-access'] as const
type GrokRuntimeMode = typeof grokRuntimeModes[number]
const grokRuntimeModeSchema = z.enum(grokRuntimeModes)
function grokRuntimeMode(mode: AgentRuntimeMode): GrokRuntimeMode {
  const parsed = grokRuntimeModeSchema.safeParse(mode)
  if (!parsed.success) throw new Error('That permission mode is not supported by this provider.')
  return parsed.data
}
/** Both flags are always explicit; a missing mode keeps the original approval-required policy. */
function sessionPolicy(mode: GrokRuntimeMode | undefined): { yoloMode: boolean; autoMode: boolean } {
  return { yoloMode: mode === 'full-access', autoMode: mode === 'auto' }
}
/**
 * How Sotto spawns the native client. The allow rule covers Sotto's own browser server and nothing
 * else, and lives on this process rather than in Grok's own configuration; Tools still asks before
 * any page action (ADR-0020). One leader serves every thread, so the rule cannot be per-thread: on a
 * personal chat, which never receives a browser server, it matches nothing.
 */
export function grokArguments(): string[] {
  return ['--permission-mode', 'default', '--allow', `MCPTool(${BROWSER_MCP_SERVER}__*)`, 'agent', '--leader', 'stdio']
}
const originSchema = z.object({ messageId: z.string(), commandId: z.string(), digest: z.string(), createdAt: z.string(), entryKey: z.string().optional() })
const aliasSchema = z.object({ grokSessionId: z.string().uuid().optional(), projectId: z.string().optional(), kind: z.literal('personal').optional(), cwd: z.string(), title: z.string(), modelId: z.string(), nativeModelId: z.string().optional(), settingsConfirmed: z.boolean().default(false), createdAt: z.string(), origins: z.array(originSchema), reasoningEffort: z.string().optional(), runtimeMode: grokRuntimeModeSchema.optional(), pendingRuntimeMode: grokRuntimeModeSchema.optional(), answeredRequestIds: z.array(z.string()).default([]) }).refine(alias => alias.kind === 'personal' ? alias.projectId === undefined : !!alias.projectId, 'A personal chat cannot have a project; a project thread requires one.')
type Alias = z.infer<typeof aliasSchema>
const catalogSchema = z.object({ currentModelId: z.string(), availableModels: z.array(z.object({ modelId: z.string(), name: z.string(), _meta: z.object({ reasoningEffort: z.string().optional(), supportsReasoningEffort: z.boolean().optional(), reasoningEfforts: z.array(z.object({ id: z.string(), value: z.string().optional() })).optional() }).optional() })).min(1) })
const updateSchema = z.object({ sessionId: z.string(), _meta: z.object({ eventId: z.string().optional(), agentTimestampMs: z.number().optional(), promptId: z.string().optional(), streamStartMs: z.number().optional() }).optional(), update: z.object({ sessionUpdate: z.string(), content: z.unknown().optional(), stop_reason: z.string().optional(), stopReason: z.string().optional(), tool_call_id: z.string().optional() }).passthrough() })
const historySchema = z.object({ updates: z.array(z.object({ timestamp: z.union([z.number(), z.string()]), method: z.string(), params: z.unknown() })), totalCount: z.number().int().nonnegative(), hasMore: z.boolean() })
// Grok 1.0.5 restarts its event counter on CLI resume. eventId alone is not a message identity.
function eventKey(params: z.infer<typeof updateSchema>, fallback: string | number): string {
  return `grok-event-${digest(JSON.stringify([params._meta?.eventId, params._meta?.agentTimestampMs ?? fallback, params.update]))}`
}
// Native durable history coalesces message chunks, so chunk event IDs/text are not message identities.
function assistantKey(id: string, params: z.infer<typeof updateSchema>, userId: string, lastActivityId?: string): string {
  return `grok-assistant-${digest(JSON.stringify([id, params._meta?.promptId ?? userId, params._meta?.streamStartMs ?? lastActivityId ?? 'start']))}`
}
// A stream's identity is the work that preceded it, as Grok reported it. Sotto's own turn records are
// not Grok's work, so they must not shift that identity between the live rail and durable history.
const lastReportedId = (rows: readonly AgentActivity[] | undefined): string | undefined =>
  rows?.filter(row => row.kind !== 'turn').at(-1)?.id
function messageOrigin(alias: Alias, key: string, text: string, timestampMs: number) {
  const hash = digest(text)
  return alias.origins.find(origin => origin.entryKey === key && origin.digest === hash)
    ?? alias.origins.find((origin, index) => !origin.entryKey && origin.digest === hash && Date.parse(origin.createdAt) <= timestampMs
      && (!alias.origins[index + 1] || timestampMs < Date.parse(alias.origins[index + 1]!.createdAt)))
}
function completedStatus(stopReason: string | undefined): AgentThread['status'] {
  return ['end_turn', 'cancelled', 'max_tokens', 'max_turn_requests', 'refusal'].includes(stopReason ?? '') ? 'idle' : 'error'
}

function turnOutcome(reason: string | undefined): 'completed' | 'interrupted' | 'failed' {
  return reason === 'end_turn' ? 'completed' : reason === 'cancelled' ? 'interrupted' : 'failed'
}

const HISTORY_PAGE_SIZE = 100
// One poll reads at most this much of a session's durable history. A longer backlog keeps its place
// and continues on the next poll, so the cost of a poll never grows with the length of the thread.
const HISTORY_PAGES_PER_POLL = 4
/** What Sotto has already read of one session's durable history, and where to read on from. */
interface HistoryRead {
  offset: number
  total: number
  messages: AgentMessage[]
  activities: AgentActivity[]
  events: Set<string>
  statusEvents: Set<string>
  status: AgentThread['status']
  lastTurn?: AgentThread['lastTurn']
  assistant?: AgentMessage
}
function freshHistory(history?: HistoryRead): HistoryRead {
  const read = history ?? { offset: 0, total: 0, messages: [], activities: [], events: new Set<string>(), statusEvents: new Set<string>(), status: 'idle' as AgentThread['status'] }
  read.offset = 0; read.total = 0; read.messages = []; read.activities = []
  read.events.clear(); read.statusEvents.clear(); read.status = 'idle'
  delete read.lastTurn; delete read.assistant
  return read
}

export interface GrokAcpOptions {
  executable?: string; args?: string[]; environment?: NodeJS.ProcessEnv; requestTimeoutMs?: number; pollIntervalMs?: number
  /** Session reaper cadence and idle threshold; see `sessionReaper.ts`. */
  reaperSweepMs?: number; sessionIdleMs?: number
}

/** Grok owns credentials, tools and durable sessions. Only alias/origin metadata belongs to Sotto. */
export class GrokAcpHost implements AgentHost {
  private browserHttp = false
  private browserTools: BrowserAgentTools | undefined
  useBrowserTools(tools: BrowserAgentTools): void { this.browserTools = tools }
  private async browserServers(id: string) {
    if (!this.browserTools || this.aliases[id]?.kind === 'personal' || !this.browserHttp) return []
    return [await this.browserTools.mcpServer(id)]
  }
  private readonly usage: NativeUsage
  private readonly aliasStore: AtomicJsonStore<Record<string, Alias>>
  private readonly projectStore: AtomicJsonStore<AgentHostSnapshot['projects']>
  private aliases: Record<string, Alias> = {}
  private readonly threads = new Map<string, NativeConversation>()
  private readonly personalContexts = new Map<string, string>()
  private readonly pending = new Map<string, Pending>()
  private readonly answeredRequests = new Set<string>()
  private readonly deliveries = new Map<string, { resolve(): void; reject(error: Error): void }>()
  private readonly activePrompts = new Set<string>()
  private readonly streams = new Map<string, { threadId: string; userId: string; message: AgentMessage }>()
  private readonly authored = new Map<string, { threadId: string; message: AgentMessage }>()
  private readonly liveStatus = new Map<string, { eventKey: string; status: AgentThread['status'] }>()
  private readonly selections = new Map<string, { model: string; effort: string | undefined }>()
  private readonly seenUpdates = new Set<string>()
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private readonly publisher = new ProviderSnapshotPublisher(() => {
    for (const listener of this.listeners) listener(this.current())
  })
  private rpc: GrokRpc | undefined
  private stopping = Promise.resolve()
  private writing = Promise.resolve()
  private polling: Promise<void> | undefined
  private readonly historyReads = new Map<string, Promise<void>>()
  private readonly histories = new Map<string, HistoryRead>()
  /** This adapter's append path: every change to what a thread said leaves through it as an event. */
  private readonly log = new ThreadMessageLog()
  /** What the host's event store already holds, so a session read from its start is not added twice. */
  private history: ThreadHistorySource | undefined
  /** Watched set: the threads the coordinator asked for. Their sessions are loaded eagerly, never reaped. */
  private readonly observed = new Set<string>()
  /** The sessions this connection has loaded; only these are polled for history. */
  private readonly loaded = new Set<string>()
  private readonly loading = new Map<string, Promise<void>>()
  private readonly reaper: SessionReaper
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private generation = 0
  private state: AgentHostSnapshot = { connected: false, name: 'Grok', version: '', projects: [], models: [], threads: [], capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true, configureThreadModel: false, skills: true } }
  constructor(private readonly userDataDirectory: string, private readonly options: GrokAcpOptions = {}) {
    this.usage = new NativeUsage(userDataDirectory, 'grok')
    this.aliasStore = new AtomicJsonStore(join(userDataDirectory, 'grok-threads.json'), z.record(z.string(), aliasSchema).parse, () => ({}))
    this.projectStore = new AtomicJsonStore(join(userDataDirectory, 'grok-projects.json'), z.array(agentProjectSchema).parse, () => [])
    this.reaper = new SessionReaper({
      ...(options.reaperSweepMs !== undefined ? { sweepEveryMs: options.reaperSweepMs } : {}),
      ...(options.sessionIdleMs !== undefined ? { idleAfterMs: options.sessionIdleMs } : {}),
      isWatched: id => this.observed.has(id) || this.aliases[id]?.kind === 'personal',
      isBusy: id => this.busy(id),
      stop: id => this.stopSession(id),
    })
  }
  /** A prompt in flight, a running turn or an unanswered request all hold a session open. */
  private busy(id: string): boolean {
    const thread = this.threads.get(id)
    return this.activePrompts.has(id) || this.loading.has(id) || this.historyReads.has(id)
      || !!thread && (thread.status === 'running' || thread.requests.length > 0)
      || !!this.aliases[id]?.pendingRuntimeMode
  }
  /**
   * Load this thread's native session, once. Sotto holds no session until a thread is watched or acted on,
   * so this is where a thread's provider session begins on this connection.
   */
  private loadSession(id: string, reconciling = false): Promise<void> {
    const alias = this.aliases[id]
    if (!alias?.grokSessionId || !this.state.connected || !this.rpc) return Promise.resolve()
    // A load reads and confirms this thread's native settings. A thread whose settings or permission mode
    // were never confirmed is reconciled by connecting, never by an action that would confirm them along
    // the way, so lazy loading leaves those threads exactly where they were.
    if (!reconciling && (!alias.settingsConfirmed || alias.pendingRuntimeMode)) return Promise.resolve()
    this.reaper.touch(id)
    if (this.loaded.has(id)) return Promise.resolve()
    const pending = this.loading.get(id); if (pending) return pending
    const rpc = this.rpc
    const work = this.browserServers(id).then(mcpServers => rpc.request('session/load', { sessionId: alias.grokSessionId, cwd: alias.cwd, mcpServers, _meta: sessionPolicy(alias.pendingRuntimeMode ?? alias.runtimeMode) }, async value => {
      this.confirmLoad(id, alias, value); await this.persist()
    })).then(() => {
      if (rpc !== this.rpc) return
      this.loaded.add(id); this.log.pin(id); this.reaper.touch(id)
    }).finally(() => { if (this.loading.get(id) === work) this.loading.delete(id) })
    this.loading.set(id, work)
    return work
  }
  /**
   * Close the native session. Grok reports `closed` or `notResident`, and a later load restores the
   * conversation, so the thread keeps its messages and its idle status and the next action loads it again.
   */
  private async stopSession(id: string): Promise<void> {
    const alias = this.aliases[id]; const rpc = this.rpc
    if (!alias?.grokSessionId || !rpc) return
    this.loaded.delete(id)
    // The history cursor is a read position in a session Sotto no longer holds; the next load reads afresh.
    this.histories.delete(id)
    this.log.release(id)
    await this.closeSession(rpc, alias)
  }
  private current(): AgentHostSnapshot {
    return cloneHostSnapshot({ ...this.state, threads: [...this.threads.values()]
      .filter((thread): thread is AgentThread => 'projectId' in thread).map(thread => this.log.publishedThread(thread)) })
  }
  private emit(streaming = false): void { this.publisher.publish(streaming) }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void { return this.log.subscribeEvents(listener) }
  useThreadHistory(source: ThreadHistorySource): void { this.history = source }
  private persist(): Promise<void> { this.writing = this.aliasStore.write(structuredClone(this.aliases)); return this.writing }
  private thread(id: string): NativeConversation {
    const alias = this.aliases[id]; if (!alias) throw new Error('The Grok thread does not exist.')
    if (!this.threads.has(id)) this.threads.set(id, { id, ...(alias.kind === 'personal' ? { kind: 'personal' as const } : { projectId: alias.projectId! }), workingDirectory: alias.cwd, title: alias.title, modelId: alias.settingsConfirmed ? alias.modelId : alias.nativeModelId ?? '', runtimeMode: alias.runtimeMode ?? 'approval-required', ...(alias.reasoningEffort && alias.settingsConfirmed ? { reasoningEffort: alias.reasoningEffort } : {}), status: alias.grokSessionId && alias.settingsConfirmed ? 'idle' : 'error', messages: [], requests: [] })
    const thread = this.threads.get(id)!; thread.usage = this.usage.get(id); return thread
  }
  /** Applies a native load that carried the alias's pending (or committed) mode policy. */
  private confirmLoad(id: string, alias: Alias, value: unknown): void {
    const response = z.object({ models: catalogSchema, _meta: z.object({ sessionId: z.literal(alias.grokSessionId!) }) }).parse(value)
    alias.nativeModelId = response.models.currentModelId
    alias.settingsConfirmed = alias.nativeModelId === alias.modelId && (!alias.reasoningEffort || response.models.availableModels.find(model => model.modelId === alias.modelId)?._meta?.reasoningEffort === alias.reasoningEffort)
    if (alias.pendingRuntimeMode) { alias.runtimeMode = alias.pendingRuntimeMode; delete alias.pendingRuntimeMode }
    const thread = this.thread(id); thread.modelId = alias.nativeModelId; thread.runtimeMode = alias.runtimeMode ?? 'approval-required'
  }
  private closeSession(rpc: GrokRpc, alias: Alias): Promise<void> {
    return rpc.request('_x.ai/session/close', { sessionId: alias.grokSessionId }, value => { z.object({ result: z.object({ success: z.literal(true), outcome: z.enum(['closed', 'notResident']) }) }).parse(value) })
  }
  private id(nativeId: string): string | undefined { return Object.keys(this.aliases).find(id => this.aliases[id]!.grokSessionId === nativeId) }
  async connect(): Promise<AgentHostSnapshot> {
    this.disconnect(); await this.closed()
    const generation = this.generation
    await this.usage.load()
    await mkdir(this.userDataDirectory, { recursive: true })
    const executable = this.options.executable ?? await findGrokExecutable(this.options.environment)
    if (!executable || !isAbsolute(executable)) throw new Error('Install Grok CLI and sign in before connecting Grok.')
    this.aliases = await this.aliasStore.read(); this.state.projects = await this.projectStore.read(); this.threads.clear(); this.streams.clear(); this.authored.clear(); this.liveStatus.clear(); this.selections.clear(); this.activePrompts.clear(); this.seenUpdates.clear(); this.answeredRequests.clear(); this.histories.clear()
    if (generation !== this.generation) throw new Error('Grok connection was cancelled.')
    const rpc = new GrokRpc(executable, this.options.args ?? grokArguments(), this.userDataDirectory,
      grokEnvironment(this.options.environment), this.options.requestTimeoutMs ?? 15000, frame => this.frame(frame), () => {
        if (this.rpc === rpc) { this.state.connected = false; clearInterval(this.pollTimer); for (const delivery of this.deliveries.values()) delivery.reject(new GrokUncertain('Grok disconnected.')); this.deliveries.clear(); this.pending.clear(); for (const thread of this.threads.values()) thread.requests = []; this.emit() }
      })
    this.rpc = rpc; this.stopping = rpc.closed
    try {
      await rpc.request('initialize', { protocolVersion: GROK_ACP_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'sotto', version: '1' } }, value => {
        const response = z.object({ protocolVersion: z.number(), agentCapabilities: z.object({ loadSession: z.literal(true), mcpCapabilities: z.object({ http: z.boolean().optional() }).optional() }), authMethods: z.array(z.object({ id: z.string() })), _meta: z.object({ agentVersion: z.string().min(1).max(64), modelState: catalogSchema }) }).parse(value)
        // The pin is a floor, not one exact version (ADR-0020): an exact pin is what kept an installed
        // client on 1.0.5 while 1.0.40 was published. Older than the checked version is still refused.
        if (response.protocolVersion !== GROK_ACP_VERSION) throw new GrokUnsupported(`Sotto speaks ACP ${GROK_ACP_VERSION}, and this client answered ACP ${response.protocolVersion}.`)
        if (compareClientVersions(response._meta.agentVersion, GROK_CLI_VERSION) < 0) throw new GrokUnsupported(`Grok CLI ${GROK_CLI_VERSION} or newer is required, and this client is ${response._meta.agentVersion}.`)
        if (!response.authMethods.some(auth => auth.id === 'cached_token') || response.authMethods.some(auth => /api.?key/iu.test(auth.id))) throw new GrokUnsupported('Grok must be signed in to its own subscription; Sotto never connects it with an API key.')
        this.browserHttp = response.agentCapabilities.mcpCapabilities?.http === true
        this.state.version = `${response._meta.agentVersion} / ACP ${GROK_ACP_VERSION}`
        if (compareClientVersions(response._meta.agentVersion, GROK_CLI_VERSION) > 0) this.state.verifiedVersion = GROK_CLI_VERSION
        else delete this.state.verifiedVersion
        this.state.models = response._meta.modelState.availableModels.map(model => ({ id: model.modelId, name: model.name, provider: 'Grok', ready: true, runtimeModes: [...grokRuntimeModes], supportsImages: false,
          reasoningEfforts: model._meta?.supportsReasoningEffort ? model._meta.reasoningEfforts?.map(effort => effort.value ?? effort.id) ?? [] : [], ...(model._meta?.reasoningEffort ? { defaultReasoningEffort: model._meta.reasoningEffort } : {}) }))
      })
      await rpc.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } }, value => { z.object({}).parse(value) })
      // Lazy sessions: a known thread is in the snapshot from its alias, idle, and loads when it is
      // watched or acted on. Personal chats own their own native request channel, so they load here.
      // A fresh connection reads each session from its start again, so what the store already holds is
      // recognised here: the same message read twice is not a second message.
      this.log.forgetAll()
      for (const [id, alias] of Object.entries(this.aliases)) {
        this.thread(id); this.log.seed(id, this.history?.messageIdentities(id) ?? [])
        if (alias.kind === 'personal') this.observed.add(id)
      }
      if (generation !== this.generation) throw new Error('Grok connection was cancelled.')
      this.state.connected = true; delete this.state.error
      for (const [id, alias] of Object.entries(this.aliases)) {
        if (!alias.grokSessionId || !this.observed.has(id)) continue
        // An unconfirmed mode change is finished before anything else can use the session.
        if (alias.pendingRuntimeMode) await this.closeSession(rpc, alias)
        await this.loadSession(id, true)
      }
      if (generation !== this.generation) throw new Error('Grok connection was cancelled.')
      this.reaper.start()
      await this.pollHistory()
      this.pollTimer = setInterval(() => { void this.pollHistory().catch(() => { this.state.error = 'Grok history could not be checked. Reconnect before sending automatic replies.'; this.emit() }) }, this.options.pollIntervalMs ?? 1500); this.pollTimer.unref()
      this.emit(); return this.current()
    } catch (error) {
      this.disconnect()
      // What the user reads is what happened. A client Sotto will not drive names the requirement it
      // missed, and pressing again will not change it. Anything else, an answer Sotto could not read or
      // a connection lost partway through, says so and is worth another press. The version and the
      // sign-in are named only by the refusal that found them, never over a failure that passed both.
      const refused = error instanceof GrokUnsupported
      const detail = refused || error instanceof GrokUncertain ? error.message : ''
      throw new Error(['Could not connect Grok.', detail, refused ? '' : 'Connect again to retry.'].filter(Boolean).join(' '), { cause: error })
    }
  }
  /**
   * Take the watched set as given and load the sessions that have entered it. A thread that has left the
   * set keeps its session until the reaper finds it idle. Foreign sessions are never discovered.
   */
  observeThreads(ids: readonly string[]): void {
    const watched = new Set(ids)
    for (const [id, alias] of Object.entries(this.aliases)) if (alias.kind === 'personal') watched.add(id)
    this.observed.clear(); for (const id of watched) this.observed.add(id)
    this.log.observe([...this.observed])
    if (!this.state.connected) return
    for (const id of this.observed) {
      if (!this.aliases[id]?.grokSessionId) continue
      void this.loadSession(id, true).then(() => this.queueRead(id)).catch(() => {
        this.state.error = 'A Grok thread could not be loaded. Check the native client.'; this.emit()
      })
    }
  }
  async snapshot(): Promise<AgentHostSnapshot> { if (this.state.connected) await this.pollHistory(); return this.current() }
  async listThreadSkills(threadId: string, _forceReload = false, scope?: AgentSkillScope): Promise<AgentSkillCatalog> {
    void _forceReload // inspect is a fresh native read for this directory on every request.
    const cwd = this.aliases[threadId]?.cwd ?? (scope?.providerId === 'grok' ? scope.workingDirectory : undefined)
    if (!this.state.connected || !cwd) throw new Error('Reconnect this Grok thread before browsing skills.')
    const generation = this.generation
    try {
      const executable = this.options.executable ?? await findGrokExecutable(this.options.environment)
      if (!executable) throw new Error('Grok is unavailable.')
      const catalog = await discoverGrokSkills(threadId, await existingWorkingDirectory(cwd), executable, this.options.args ?? [], grokEnvironment(this.options.environment))
      if (generation !== this.generation) throw new Error('Grok connection changed while discovering skills.')
      return catalog
    } catch { return { threadId, providerId: 'grok', cwd, status: 'error', skills: [], errors: [], error: 'Grok native skill discovery failed. Check that the installed client supports inspect --json.' } }
  }
  async refreshThread(id: string): Promise<AgentHostSnapshot> {
    if (!this.aliases[id]?.grokSessionId) throw new Error('This Grok thread has no confirmed provider session.')
    // Reading a thread is opening it, so a session that is not loaded on this connection loads here.
    await this.loadSession(id)
    // An explicit refresh reads to the end of the history: what it reports decides whether a prompt is sent.
    await this.queueRead(id)
    return this.current()
  }
  private async queueRead(id: string, maxPages = Number.POSITIVE_INFINITY): Promise<void> {
    const generation = this.generation
    const work = (this.historyReads.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => {
      if (generation !== this.generation || !this.state.connected) throw new Error('Grok connection changed while reading the thread.')
      return this.readHistory(id, maxPages)
    })
    this.historyReads.set(id, work)
    try { await work }
    finally { if (this.historyReads.get(id) === work) this.historyReads.delete(id) }
  }
  /**
   * Native history query includes CLI-authored input and filters rewound branches. ACP offers no push for
   * durable history (its session/update notifications are live only, and a CLI takeover can be written
   * without one), so Sotto polls; each poll reads on from a cursor rather than the whole session. The
   * cursor is not persisted: native history is rewritten behind it by rewinds and coalesced chunks, and
   * Sotto keeps no durable copy of the messages, so a fresh process reads the session once from its start.
   */
  pollHistory(): Promise<void> {
    if (this.polling) return this.polling
    this.polling = this.readHistories().finally(() => { this.polling = undefined })
    return this.polling
  }
  private async readHistories(): Promise<void> {
    if (!this.state.connected || !this.rpc) return
    // Only a loaded session is polled; an unopened thread costs nothing until it is watched or acted on.
    for (const [id, alias] of Object.entries(this.aliases)) if (alias.grokSessionId && this.loaded.has(id)) await this.queueRead(id, HISTORY_PAGES_PER_POLL)
  }
  private async readHistory(id: string, maxPages = Number.POSITIVE_INFINITY): Promise<void> {
    const generation = this.generation; const rpc = this.rpc!; const alias = this.aliases[id]!
    const history = this.histories.get(id) ?? freshHistory()
    this.histories.set(id, history)
    let more = true; let changed = false; let pages = 0; let restarted = false
    while (more && pages < maxPages) {
      pages++
      await rpc.request('_x.ai/session/updates', { sessionId: alias.grokSessionId, cwd: alias.cwd, offset: history.offset, limit: HISTORY_PAGE_SIZE }, value => {
        if (generation !== this.generation || rpc !== this.rpc) { more = false; return }
        const page = historySchema.parse(value)
        if (page.hasMore && !page.updates.length) throw new Error('Invalid Grok history page.')
        // Grok rewrites history behind the cursor when a turn is rewound or streamed chunks are coalesced.
        // A history shorter than the one already read is read again from its start, once per read. That
        // shortening is the one signal that words were taken back, so it is the one place the log resets.
        if (page.totalCount < history.total && !restarted) { restarted = true; freshHistory(history); this.log.reset(id); more = true; return }
        history.total = page.totalCount
        more = page.hasMore
        for (const entry of page.updates) {
          const ordinal = history.offset++
          const parsed = updateSchema.safeParse(entry.params); if (!parsed.success || parsed.data.sessionId !== alias.grokSessionId) continue
          const key = eventKey(parsed.data, `${entry.timestamp}-${ordinal}`)
          if (history.events.has(key)) continue
          history.events.add(key)
          const createdAt = new Date(parsed.data._meta?.agentTimestampMs ?? (typeof entry.timestamp === 'number' ? entry.timestamp * 1000 : entry.timestamp)).toISOString()
          const update = parsed.data.update; const content = object(update.content)
          this.usage.grok(id, this.thread(id).modelId, parsed.data); this.thread(id)
          if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) delete history.assistant
          history.activities = mergeAgentActivities(history.activities, grokActivities(update, { turnId: history.messages.filter(message => message.role === 'user').at(-1)?.id ?? 'native-history', afterMessageId: history.messages.at(-1)?.id, cwd: alias.cwd }, history.activities))
          if (entry.method === 'session/update' && content?.type === 'text' && typeof content.text === 'string') {
            if (update.sessionUpdate === 'user_message_chunk') {
              history.statusEvents.add(eventKey(parsed.data, 0))
              delete history.assistant; history.status = 'running'
              const text = content.text
              const origin = messageOrigin(alias, key, text, Date.parse(createdAt))
              history.lastTurn = { id: origin?.messageId ?? key, status: 'running' }
              if (origin && !origin.entryKey) { origin.entryKey = key; changed = true }
              history.messages.push({ id: origin?.messageId ?? key, role: 'user', text: origin && alias.kind === 'personal' ? personalAuthoredText(text) : text, createdAt: origin?.createdAt ?? createdAt, ...(origin ? { commandId: origin.commandId } : {}) })
              if (origin) this.deliveries.get(origin.messageId)?.resolve()
            } else if (update.sessionUpdate === 'agent_message_chunk') {
              const assistantId = assistantKey(id, parsed.data, history.messages.filter(message => message.role === 'user').at(-1)?.id ?? 'native-history', lastReportedId(history.activities))
              if (history.assistant?.id !== assistantId) { history.assistant = { id: assistantId, role: 'assistant', text: '', createdAt }; history.messages.push(history.assistant) }
              history.assistant.text += content.text
            }
          }
          if (update.sessionUpdate === 'turn_completed') { history.statusEvents.add(eventKey(parsed.data, 0)); history.status = completedStatus(update.stop_reason ?? update.stopReason); history.lastTurn = { id: history.lastTurn?.id ?? key, status: turnOutcome(update.stop_reason ?? update.stopReason) }; delete history.assistant }
        }
      })
    }
    if (generation !== this.generation || rpc !== this.rpc || !this.state.connected) throw new Error('Grok connection changed while reading the thread.')
    if (changed) await this.persist()
    if (generation !== this.generation || rpc !== this.rpc || !this.state.connected) throw new Error('Grok connection changed while reading the thread.')
    const thread = this.thread(id)
    if (history.activities.length || thread.activities?.length) thread.activities = mergeAgentActivities(thread.activities, history.activities)
    let status = history.status; let lastTurn = history.lastTurn
    // A live native turn may belong to the CLI, not activePrompts. Older durable
    // status cannot supersede it until its event has entered the persisted timeline.
    const liveStatus = this.liveStatus.get(id)
    if (liveStatus) {
      if (history.statusEvents.has(liveStatus.eventKey)) this.liveStatus.delete(id)
      else { status = liveStatus.status; lastTurn = thread.lastTurn }
    }
    if (lastTurn && !this.activePrompts.has(id)) thread.lastTurn = lastTurn
    this.record(id, status)
    thread.status = !alias.settingsConfirmed ? 'error' : this.activePrompts.has(id) ? 'running' : status
    this.emit()
  }
  /**
   * Grok's append path. The durable rail stays as Sotto read it; the live tail is merged into a copy of
   * it, and the whole is handed to the log, which works out what is new and publishes it as events. No
   * other place in this adapter changes what a thread said.
   */
  private record(id: string, status: AgentThread['status']): void {
    const messages = (this.histories.get(id)?.messages ?? []).map(message => ({ ...message }))
    // Native writes may lag behind live notifications. Keep their tail until the durable rail catches up.
    for (const live of [...[...this.authored.values()].filter(entry => entry.threadId === id).map(entry => entry.message), ...[...this.streams.values()].filter(stream => stream.threadId === id).map(stream => stream.message)]) {
      if (live.role === 'user') {
        if (!messages.some(message => message.id === live.id)) messages.push(live)
        else this.authored.delete(live.id)
      }
      if (live.role === 'assistant') {
        const streamKey = [...this.streams].find(([, entry]) => entry.message === live)?.[0]
        if (!streamKey) continue
        const userId = this.streams.get(streamKey)!.userId
        const userIndex = messages.findIndex(message => message.id === userId)
        if (userIndex < 0) continue
        const nextUserIndex = messages.findIndex((message, index) => index > userIndex && message.role === 'user')
        // Separate streams can repeat the same words around a tool. Only the
        // native stream identity can tell us which durable message caught up.
        const persisted = messages.slice(userIndex + 1, nextUserIndex < 0 ? undefined : nextUserIndex)
          .find(message => message.role === 'assistant' && message.id === live.id)
        if (!persisted) messages.splice(nextUserIndex < 0 ? messages.length : nextUserIndex, 0, live)
        else if (persisted.text.startsWith(live.text)) {
          if (status === 'idle' && !this.activePrompts.has(id)) this.streams.delete(streamKey)
        } else if (live.text.startsWith(persisted.text)) persisted.text = live.text
      }
    }
    this.log.set(id, messages)
  }
  personalSnapshot(): PersonalConversation[] {
    return structuredClone([...this.threads.values()].filter((thread): thread is PersonalConversation => 'kind' in thread && thread.kind === 'personal')
      .map(thread => this.log.publishedThread(thread)))
  }
  async createPersonalConversation(command: PersonalCreateCommand, memories: readonly PersonalMemory[] = []): Promise<AgentHostResult> {
    this.personalContexts.set(command.threadId, personalContext(memories))
    return this.executeNative({ ...command, type: 'create-personal' })
  }
  async sendPersonalConversation(command: Extract<AgentHostCommand, { type: 'send' }>, memories: readonly PersonalMemory[]): Promise<AgentHostResult> {
    if (this.aliases[command.threadId]?.kind !== 'personal') throw new Error('This is not an owned personal conversation.')
    this.personalContexts.set(command.threadId, personalContext(memories))
    return this.execute(command)
  }
  async execute(command: AgentHostCommand): Promise<AgentHostResult> { return this.executeNative(command) }
  private async executeNative(command: AgentHostCommand | (PersonalCreateCommand & { type: 'create-personal' })): Promise<AgentHostResult> {
    if (command.type === 'compact-thread') throw new Error('Grok does not expose supported native manual compaction.')
    if (command.type === 'steer') throw new Error('This provider does not support native steering. Queue a follow-up instead.')
    if (!this.state.connected || !this.rpc) throw new Error('Connect Grok before managing threads.')
    const rpc = this.rpc
    try {
      if (command.type === 'create-project') {
        if (!isAbsolute(command.path)) throw new Error('Grok projects require an absolute working directory.')
        if (!this.state.projects.some(project => project.id === command.projectId)) { this.state.projects.push({ id: command.projectId, title: command.title, path: command.path }); await this.projectStore.write(this.state.projects) }
      } else if (command.type === 'create-thread' || command.type === 'create-personal') {
        if (this.aliases[command.threadId]) return this.aliases[command.threadId]!.settingsConfirmed ? { accepted: true } : { accepted: false, uncertain: true }
        validateThreadOptions(this.state, command)
        const project = command.type === 'create-thread' ? this.state.projects.find(project => project.id === command.projectId) : undefined; if (command.type === 'create-thread' && !project) throw new Error('Choose a Grok project first.')
        const alias: Alias = { ...(command.type === 'create-personal' ? { kind: 'personal' as const } : { projectId: project!.id }), cwd: await existingWorkingDirectory(command.workingDirectory ?? project!.path), title: command.title, modelId: command.modelId, settingsConfirmed: false, createdAt: new Date().toISOString(), origins: [], answeredRequestIds: [], ...(command.reasoningEffort ? { reasoningEffort: command.reasoningEffort } : {}), ...(command.runtimeMode ? { runtimeMode: grokRuntimeMode(command.runtimeMode) } : {}) }
        this.aliases[command.threadId] = alias; await this.persist()
        await rpc.request('session/new', { cwd: alias.cwd, mcpServers: await this.browserServers(command.threadId), _meta: sessionPolicy(alias.runtimeMode) }, async value => {
          const response = z.object({ sessionId: z.string().uuid(), models: catalogSchema }).parse(value)
          alias.grokSessionId = response.sessionId; alias.nativeModelId = response.models.currentModelId; await this.persist(); this.thread(command.threadId).status = 'error'; this.emit()
        })
        await rpc.request('session/set_model', { sessionId: alias.grokSessionId, modelId: alias.modelId, ...(alias.reasoningEffort ? { _meta: { reasoningEffort: alias.reasoningEffort } } : {}) }, value => {
          z.object({ _meta: z.object({ model: z.object({ Ok: z.literal(alias.modelId) }) }) }).parse(value)
        })
        if (alias.reasoningEffort && this.selections.get(alias.grokSessionId!)?.effort !== alias.reasoningEffort) {
          // Grok can reply before model_changed. Read its owned session's native state; never infer success.
          await rpc.request('session/load', { sessionId: alias.grokSessionId, cwd: alias.cwd, mcpServers: await this.browserServers(command.threadId), _meta: sessionPolicy(alias.runtimeMode) }, value => {
            const response = z.object({ models: catalogSchema, _meta: z.object({ sessionId: z.literal(alias.grokSessionId!) }) }).parse(value)
            if (response.models.currentModelId !== alias.modelId || response.models.availableModels.find(model => model.modelId === alias.modelId)?._meta?.reasoningEffort !== alias.reasoningEffort) throw new Error('Grok did not confirm the requested reasoning effort.')
          })
        }
        alias.settingsConfirmed = true; alias.nativeModelId = alias.modelId; await this.persist()
        // A new session is resident and polled from here; the reaper owns it like any other.
        this.loaded.add(command.threadId); this.reaper.touch(command.threadId)
        const thread = this.thread(command.threadId); thread.modelId = alias.modelId; thread.status = 'idle'; if (alias.reasoningEffort) thread.reasoningEffort = alias.reasoningEffort
      } else {
        const alias = this.aliases[command.threadId]; if (!alias?.grokSessionId) throw new Error('This Grok thread has no confirmed provider session. Do not repeat its creation automatically.')
        // Lazy sessions: an action on a thread whose session is not loaded loads it before the command runs.
        this.reaper.touch(command.threadId); await this.loadSession(command.threadId)
        if (command.type === 'configure-thread') {
          if ((command.modelId !== undefined && command.modelId !== alias.modelId) || (command.reasoningEffort !== undefined && command.reasoningEffort !== alias.reasoningEffort)) throw new Error('Grok cannot change the model or reasoning level of an existing thread in Sotto yet. Only the permission mode can be changed.')
          if (command.runtimeMode !== undefined) {
            validateThreadOptions(this.state, { runtimeMode: command.runtimeMode }, alias.modelId)
            const mode = grokRuntimeMode(command.runtimeMode)
            if (alias.pendingRuntimeMode || (alias.runtimeMode ?? 'approval-required') !== mode) {
              if (!alias.settingsConfirmed && !alias.pendingRuntimeMode) throw new Error('Grok has not confirmed this thread’s model settings. Reconnect to check before changing its permission mode.')
              try { await this.refreshThread(command.threadId) }
              catch (error) { throw error instanceof GrokUncertain ? new Error('Grok history could not be verified before changing the permission mode.', { cause: error }) : error }
              const thread = this.thread(command.threadId)
              if (this.activePrompts.has(command.threadId) || thread.status === 'running' || thread.requests.length) throw new Error('Wait for this Grok thread to finish and answer its pending requests before changing its permission mode.')
              // Until the reload is confirmed, sends are blocked and reconnect finishes the change.
              alias.pendingRuntimeMode = mode; alias.settingsConfirmed = false; thread.status = 'error'; await this.persist(); this.emit()
              await this.closeSession(rpc, alias)
              await rpc.request('session/load', { sessionId: alias.grokSessionId, cwd: alias.cwd, mcpServers: await this.browserServers(command.threadId), _meta: sessionPolicy(mode) }, async value => {
                this.confirmLoad(command.threadId, alias, value); await this.persist()
              })
              thread.status = alias.settingsConfirmed ? 'idle' : 'error'
            }
          }
        } else if (command.type === 'send') {
          if (alias.pendingRuntimeMode) throw new Error('Grok has not confirmed this thread’s permission mode. Reconnect to check before sending.')
          if (!alias.settingsConfirmed) throw new Error('Grok has not confirmed this thread’s model settings. Reconnect to check before sending.')
          validatePromptAttachments(this.state, alias.modelId, command.attachments)
          try { await this.refreshThread(command.threadId) }
          catch (error) { throw error instanceof GrokUncertain ? new Error('Grok history could not be verified before sending the prompt.', { cause: error }) : error }
          const thread = this.thread(command.threadId)
          if (command.expectedLastUserMessageId !== undefined && (this.log.lastUserMessageId(command.threadId) ?? null) !== command.expectedLastUserMessageId) throw new Error('The latest user message changed. Review the thread before replying.')
          const previous = alias.origins.find(origin => origin.messageId === command.messageId || origin.commandId === command.commandId)
          if (previous) return previous.entryKey ? { accepted: true } : { accepted: false, uncertain: true }
          if (this.activePrompts.has(command.threadId) || thread.status === 'running') throw new Error('Grok is already running a prompt in this thread.')
          if (thread.requests.length) throw new Error('Answer the pending Grok request before sending another prompt.')
          verifyFileMentions(command.text, command.files)
          const skillText = command.skills?.length ? grokSkillPrompt(command.text, command.skills, await this.listThreadSkills(command.threadId, true)) : command.text
          // ACP has no per-turn developer-instruction field. Append context after the
          // leading native slash command so skills still expand; preserve authored text by origin.
          const nativeText = alias.kind === 'personal' ? `${skillText}\n\n<SottoPersonalContext>\n${this.personalContexts.get(command.threadId) ?? personalContext()}\n</SottoPersonalContext>` : skillText
          // Direct sends run beside configure-thread; a mode change that began during the awaits above owns the session now.
          if (alias.pendingRuntimeMode || !alias.settingsConfirmed) throw new Error('Grok is applying a new permission mode to this thread. Send again once it is confirmed.')
          const origin = { messageId: command.messageId, commandId: command.commandId, digest: digest(nativeText), createdAt: new Date().toISOString() }
          alias.origins.push(origin)
          this.activePrompts.add(command.threadId)
          const generation = this.generation
          try {
            await this.persist()
            // Saving the origin is an async boundary at which native CLI input can revoke authority.
            await this.refreshThread(command.threadId)
            if (command.expectedLastUserMessageId !== undefined && (this.log.lastUserMessageId(command.threadId) ?? null) !== command.expectedLastUserMessageId) throw new Error('The latest user message changed. Review the thread before replying.')
            if (thread.requests.length) throw new Error('Answer the pending Grok request before sending another prompt.')
            if (generation !== this.generation || !this.state.connected || !this.activePrompts.has(command.threadId)) throw new Error('The Grok prompt was cancelled before dispatch.')
          } catch (error) {
            // No prompt was written. Rolling back this reserved origin cannot duplicate native work.
            alias.origins = alias.origins.filter(item => item !== origin); this.activePrompts.delete(command.threadId); await this.persist()
            throw error instanceof GrokUncertain ? new Error('Grok history could not be verified before sending the prompt.', { cause: error }) : error
          }
          let timer: ReturnType<typeof setTimeout> | undefined
          const delivery = new Promise<void>((resolve, reject) => { this.deliveries.set(command.messageId, { resolve, reject }); timer = setTimeout(() => reject(new GrokUncertain('Grok prompt delivery is uncertain.')), this.options.requestTimeoutMs ?? 15000) })
          // ACP prompt responds at turn completion. Its authored-message echo acknowledges delivery.
          void rpc.request('session/prompt', { sessionId: alias.grokSessionId, prompt: [{ type: 'text', text: nativeText }] }, value => {
            const completion = z.object({ stopReason: z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']) }).parse(value)
            this.thread(command.threadId).lastTurn = { id: command.messageId, status: turnOutcome(completion.stopReason) }
            this.markTurn(command.threadId, turnOutcome(completion.stopReason), command.messageId)
            this.activePrompts.delete(command.threadId); this.thread(command.threadId).status = 'idle'; this.deliveries.get(command.messageId)?.resolve(); this.emit()
          }, true).catch(async error => {
            if (error instanceof GrokRejected) { alias.origins = alias.origins.filter(item => item !== origin); await this.persist() }
            this.activePrompts.delete(command.threadId); this.deliveries.get(command.messageId)?.reject(error)
            this.thread(command.threadId).status = 'error'
            this.markTurn(command.threadId, 'failed', command.messageId, error instanceof Error ? error.message : undefined)
            this.emit()
          }).catch(() => this.disconnect())
          try { await delivery } finally { clearTimeout(timer); this.deliveries.delete(command.messageId) }
          await this.refreshThread(command.threadId)
        } else if (command.type === 'answer') {
          const pending = this.pending.get(command.requestId)
          if (!pending || pending.threadId !== command.threadId) throw new Error('That Grok request is no longer pending.')
          if (pending.answering || this.answeredRequests.has(pending.request.id)) return { accepted: false, uncertain: true }
          const result = grokAnswer(pending, command.answer, command.approved, command.questionAnswers, command.permissionChoice)
          pending.answering = true; this.answeredRequests.add(pending.request.id)
          alias.answeredRequestIds.push(pending.request.id)
          try { await this.persist() } catch (error) { alias.answeredRequestIds = alias.answeredRequestIds.filter(id => id !== pending.request.id); pending.answering = false; this.answeredRequests.delete(pending.request.id); throw error }
          if (rpc !== this.rpc || !this.state.connected || !this.pending.has(pending.request.id)) return { accepted: false, uncertain: true }
          try { await rpc.reply(pending.wireId, result); this.removeRequest(pending) }
          catch { pending.request.delivery = 'uncertain'; this.emit(); return { accepted: false, uncertain: true } }
        } else if (command.type === 'interrupt') {
          this.activePrompts.delete(command.threadId)
          await this.decline(command.threadId)
          rpc.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: alias.grokSessionId } })
        }
      }
      this.emit(); return { accepted: true }
    } catch (error) { if (error instanceof GrokUncertain) return { accepted: false, uncertain: true }; throw error }
  }
  private async frame(frame: GrokFrame): Promise<void> {
    let method = frame.method; let params = frame.params
    if (method?.startsWith('_')) {
      method = method.slice(1)
      const wrapped = z.object({ method: z.string(), params: z.unknown() }).safeParse(params)
      if (wrapped.success) { method = wrapped.data.method; params = wrapped.data.params }
    }
    if (frame.id !== undefined && method) {
      const sessionId = object(params)?.sessionId
      const threadId = typeof sessionId === 'string' ? this.id(sessionId) : undefined
      const pending = threadId ? grokPending(frame.id, method, params, threadId) : undefined
      if (pending) {
        // RPC counters restart on reconnect; the native tool request owns the durable identity.
        pending.request.id = `grok-request-${digest(JSON.stringify([threadId, pending.toolCallId, pending.request.kind]))}`
        this.reaper.touch(pending.threadId)
        if (this.answeredRequests.has(pending.request.id) || this.pending.has(pending.request.id)) return
        if (this.aliases[pending.threadId]!.answeredRequestIds.includes(pending.request.id)) { pending.answering = true; pending.request.delivery = 'uncertain'; this.answeredRequests.add(pending.request.id) }
        this.pending.set(pending.request.id, pending); this.thread(pending.threadId).requests.push(pending.request); this.emit()
      }
      else {
        this.rpc?.write({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Sotto does not handle this request.' } })
        // Grok reads that refusal as an answer and keeps going, so a renamed or reshaped approval would
        // otherwise pass as the user declining. Foreign sessions stay none of Sotto's business.
        if (threadId && needsPerson(method) && this.state.error !== unreadableRequest('Grok')) {
          this.state.error = unreadableRequest('Grok')
          this.emit()
        }
      }
      return
    }
    if (['session/update', 'x.ai/session/update', 'x.ai/session_notification'].includes(method ?? '')) {
      const parsed = updateSchema.safeParse(params); if (!parsed.success) return
      const id = this.id(parsed.data.sessionId); if (!id) return
      this.reaper.touch(id)
      if (parsed.data._meta?.eventId && parsed.data._meta.agentTimestampMs !== undefined) {
        const key = `${id}:${eventKey(parsed.data, 0)}`
        if (this.seenUpdates.has(key)) return
        this.seenUpdates.add(key)
        if (this.seenUpdates.size > 20000) this.seenUpdates.delete(this.seenUpdates.values().next().value!)
      }
      const update = parsed.data.update; const content = object(update.content); const thread = this.thread(id)
      this.usage.grok(id, thread.modelId, parsed.data); thread.usage = this.usage.get(id)
      const activities = grokActivities(update, { turnId: this.log.lastUserMessageId(id) ?? 'native-history', afterMessageId: this.log.lastMessageId(id), cwd: this.aliases[id]!.cwd }, thread.activities, true)
      if (activities.length) thread.activities = mergeAgentActivities(thread.activities, activities)
      if (update.sessionUpdate === 'model_changed' && typeof update.model_id === 'string') this.selections.set(parsed.data.sessionId, { model: update.model_id, effort: typeof update.reasoning_effort === 'string' ? update.reasoning_effort : undefined })
      if (update.sessionUpdate === 'user_message_chunk' && content?.type === 'text' && typeof content.text === 'string') {
        const key = eventKey(parsed.data, Date.now())
        const origin = messageOrigin(this.aliases[id]!, key, content.text, parsed.data._meta?.agentTimestampMs ?? Date.now())
        const messageId = origin?.messageId ?? key
        if (messageId && !this.authored.has(messageId) && !this.log.has(id, messageId)) {
          const message: AgentMessage = { id: messageId, role: 'user', text: origin && this.aliases[id]!.kind === 'personal' ? personalAuthoredText(content.text) : content.text, createdAt: origin?.createdAt ?? new Date(parsed.data._meta?.agentTimestampMs ?? Date.now()).toISOString(), ...(origin ? { commandId: origin.commandId } : {}) }
          this.authored.set(messageId, { threadId: id, message })
        }
        if (origin) this.deliveries.get(origin.messageId)?.resolve()
        this.liveStatus.set(id, { eventKey: eventKey(parsed.data, 0), status: 'running' })
        thread.status = 'running'; thread.lastTurn = { id: messageId, status: 'running' }
        this.markTurn(id, 'running', messageId)
      }
      if (update.sessionUpdate === 'agent_message_chunk' && content?.type === 'text') {
        const userId = this.log.lastUserMessageId(id) ?? 'native-history'
        const streamId = assistantKey(id, parsed.data, userId, lastReportedId(thread.activities))
        const previous = this.streams.get(streamId)?.message
        if (previous) previous.text += content.text ?? ''
        else {
          const message: AgentMessage = { id: streamId, role: 'assistant', text: typeof content.text === 'string' ? content.text : '', createdAt: new Date(parsed.data._meta?.agentTimestampMs ?? Date.now()).toISOString() }
          this.streams.set(streamId, { threadId: id, userId, message })
        }
      }
      if (update.sessionUpdate === 'turn_completed') {
        this.activePrompts.delete(id); thread.status = completedStatus(update.stop_reason ?? update.stopReason)
        thread.lastTurn = { id: thread.lastTurn?.id ?? eventKey(parsed.data, 0), status: turnOutcome(update.stop_reason ?? update.stopReason) }
        this.liveStatus.set(id, { eventKey: eventKey(parsed.data, 0), status: thread.status })
        this.markTurn(id, turnOutcome(update.stop_reason ?? update.stopReason))
      }
      if (update.sessionUpdate === 'interaction_resolved') for (const pending of this.pending.values()) if (pending.threadId === id && pending.toolCallId === update.tool_call_id) this.removeRequest(pending)
      this.record(id, thread.status)
      this.emit(!['user_message_chunk', 'turn_completed', 'interaction_resolved'].includes(update.sessionUpdate))
    }
  }
  /**
   * Grok reports no turn lifecycle, so Sotto records the turn it watched. The turn is identified by
   * its user message, the same identity the projected activity rows already carry.
   */
  private markTurn(id: string, status: AgentActivity['status'], turnId?: string, error?: string): void {
    const thread = this.threads.get(id); if (!thread) return
    const last = this.log.lastUserMessageId(id)
    const turn = turnId ?? last
    if (turn === undefined) return
    thread.activities = markTurnActivity(thread.activities, { provider: 'grok', turnId: turn, status,
      ...(last === turn ? { afterMessageId: turn } : {}), ...(error !== undefined ? { error } : {}) })
  }
  private removeRequest(pending: Pending): void { this.pending.delete(pending.request.id); this.thread(pending.threadId).requests = this.thread(pending.threadId).requests.filter(request => request.id !== pending.request.id); this.emit() }
  private refusal(pending: Pending): unknown { return pending.permission ? { outcome: { outcome: 'cancelled' } } : { outcome: 'cancelled' } }
  private async decline(id: string): Promise<void> { for (const pending of [...this.pending.values()]) if (pending.threadId === id && !pending.answering) { this.removeRequest(pending); await this.rpc?.reply(pending.wireId, this.refusal(pending)) } }
  disconnect(): void {
    this.generation++; clearInterval(this.pollTimer); this.reaper.dispose(); this.loaded.clear(); this.loading.clear()
    for (const pending of this.pending.values()) { if (pending.answering) continue; try { this.rpc?.write({ jsonrpc: '2.0', id: pending.wireId, result: this.refusal(pending) }) } catch { /* Closed pipes never grant permission. */ } }
    this.pending.clear(); for (const thread of this.threads.values()) thread.requests = []
    for (const delivery of this.deliveries.values()) delivery.reject(new GrokUncertain('Grok disconnected before acknowledgement.'))
    this.deliveries.clear(); this.rpc?.close(); this.state.connected = false; this.emit()
  }
  async closed(): Promise<void> { await this.stopping; await this.polling?.catch(() => undefined); await Promise.allSettled(this.historyReads.values()); await this.writing; await this.usage.flushed() }
}
