import { ProviderUnavailable } from './providerProblem'
import { BROWSER_MCP_SERVER, type BrowserAgentTools } from './browserAgentServer'
import { scopedThreadServers, type ScopedThreadTools } from './threadToolServer'
import { personalContext, type NativeConversation, type PersonalConversation, type PersonalCreateCommand, type PersonalMemory } from './personalConversation'
import { existingWorkingDirectory } from './threadWorktrees'
import { ProviderSnapshotPublisher } from './providerSnapshotPublisher'
import { NativeUsage } from './nativeUsage'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { agentProjectSchema, type AgentHostSnapshot, type AgentThread, type AgentMessage, type AgentRuntimeMode } from '../../shared/agents'
import { orderReasoningEfforts } from '../../shared/reasoningEfforts'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { ActivitySubscriptionOptions, AgentHost, AgentHostCommand, AgentHostResult, AgentSkillScope, ShortTextPrompt, ThreadHistorySource, ThreadHostEvent, ThreadReadPurpose } from './host'
import { SIDE_WRITING_TIMEOUT_MS } from './sideWriting'
import { GrokSubscriptionClient, sweepLeftoverSessions } from './subscriptionGrok'
import { ThreadMessageLog } from './threadMessageLog'
import { cloneHostSnapshot } from './cloneHostSnapshot'
import { ActivitySubscribers, cloneActivitySnapshot, immutableActivities, isImmutableActivities } from './activitySnapshots'
import type { AgentSkillCatalog } from '../../shared/agentSkills'
import { discoverGrokSkills, grokSkillPrompt } from './grokSkills'
import { verifyFileMentions } from './promptFiles'
import { validatePromptAttachments, validateThreadOptions } from './threadOptions'
import { grokActivities } from './grokActivity'
import { markTurnActivity } from './turnActivity'
import { grokBrowserAdmission, grokPending, grokAnswer, type GrokPending } from './grokRequests'
import { needsPerson, unreadableRequest } from './nativeRequests'
import { object } from './claudeProtocol'
import { mergeAgentActivities, type AgentActivity } from '../../shared/agentActivity'
import { compareClientVersions } from './clientVersions'
import { findGrokExecutable, grokEnvironment, GROK_ACP_VERSION, GROK_CLI_VERSION, GrokRpc, GrokRejected, GrokSignedOut, GrokTooOld, GrokUncertain, GrokUnsupported, type GrokFrame } from './grokRpc'
import { SessionReaper } from './sessionReaper'
import { markSendStage } from './sendStages'

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
 * How Sotto spawns the native client. It once carried an allow rule for Sotto's browser server, but Grok
 * does not apply `--allow` rules to calls made through its `use_tool`, as a leader or as a local agent, so
 * the adapter answers that prompt itself instead (ADR-0020).
 *
 * Each thread session is its own agent process, never a proxy to Grok's shared leader. A leader serves every
 * client from one binary, and a client newer than the leader asks it to relaunch onto the new binary with a
 * five-second grace for running turns, so an update would cut off every working thread. An agent of its own
 * keeps a working thread on the binary it started with until it goes idle (ADR-0042).
 */
export function grokArguments(): string[] {
  return ['--permission-mode', 'default', 'agent', '--no-leader', 'stdio']
}
/**
 * One thread session's own Grok process. `clientRevision` is the client it was started from, which
 * `clientUpdated` moves on; `closing` marks a close Sotto asked for, and `lost` an exit nobody asked for.
 */
interface ThreadProcess { rpc: GrokRpc; ready: Promise<ThreadProcess>; clientRevision: number; closing: boolean; lost: boolean }
/** A Grok request as this adapter keeps it: answered on the process that asked, never another. */
type Pending = GrokPending & { rpc: GrokRpc }
const THREAD_PROCESS_LOST = 'Grok Build stopped before this reply finished, so it may be cut short. Send a message to carry on.'
const originSchema = z.object({ messageId: z.string(), commandId: z.string(), digest: z.string(), createdAt: z.string(), entryKey: z.string().optional() })
const aliasSchema = z.object({ grokSessionId: z.string().uuid().optional(), projectId: z.string().optional(), kind: z.literal('personal').optional(), cwd: z.string(), title: z.string(), modelId: z.string(), nativeModelId: z.string().optional(), settingsConfirmed: z.boolean().default(false), createdAt: z.string(), origins: z.array(originSchema), reasoningEffort: z.string().optional(), runtimeMode: grokRuntimeModeSchema.optional(), pendingRuntimeMode: grokRuntimeModeSchema.optional(), answeredRequestIds: z.array(z.string()).default([]), endedTurn: z.object({ id: z.string(), outcome: z.enum(['failed', 'interrupted']) }).optional() }).refine(alias => alias.kind === 'personal' ? alias.projectId === undefined : !!alias.projectId, 'A personal chat cannot have a project; a project thread requires one.')
type Alias = z.infer<typeof aliasSchema>
const catalogSchema = z.object({ currentModelId: z.string(), availableModels: z.array(z.object({ modelId: z.string(), name: z.string(), _meta: z.object({ reasoningEffort: z.string().optional(), supportsReasoningEffort: z.boolean().optional(), reasoningEfforts: z.array(z.object({ id: z.string(), value: z.string().optional(), default: z.boolean().optional() })).optional() }).optional() })).min(1) })
const initializeSchema = z.object({ protocolVersion: z.number(), agentCapabilities: z.object({ loadSession: z.literal(true), mcpCapabilities: z.object({ http: z.boolean().optional() }).optional() }), authMethods: z.array(z.object({ id: z.string() })), _meta: z.object({ agentVersion: z.string().min(1).max(64), modelState: catalogSchema }) })
type GrokClient = z.infer<typeof initializeSchema>
/** Why Sotto will not drive this client, or undefined when it will. */
function clientRefusal(client: GrokClient): GrokUnsupported | undefined {
  // The pin is a floor, not one exact version (ADR-0042): an exact pin is what kept an installed
  // client on 1.0.5 while 1.0.40 was published. Older than the checked version is still refused.
  if (client.protocolVersion !== GROK_ACP_VERSION) return new GrokUnsupported(`Sotto speaks ACP ${GROK_ACP_VERSION}, and this client answered ACP ${client.protocolVersion}.`)
  if (compareClientVersions(client._meta.agentVersion, GROK_CLI_VERSION) < 0) return new GrokTooOld(`Grok CLI ${GROK_CLI_VERSION} or newer is required, and this client is ${client._meta.agentVersion}.`, client._meta.agentVersion)
  if (client.authMethods.some(auth => /api.?key/iu.test(auth.id))) return new GrokUnsupported('Grok must be signed in to its own subscription; Sotto never connects it with an API key.')
  // Signed in, Grok Build offers its cached sign-in beside grok.com; signed out, only grok.com.
  if (!client.authMethods.some(auth => auth.id === 'cached_token')) return new GrokSignedOut('Grok Build is not signed in on this machine.')
  return undefined
}
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
  /** Whether this Grok client takes HTTP MCP servers, which is how every one of Sotto's tool servers is reached. */
  private httpToolServers = false
  private browserTools: BrowserAgentTools | undefined
  useBrowserTools(tools: BrowserAgentTools): void { this.browserTools = tools }
  private threadTools: readonly ScopedThreadTools[] = []
  useThreadTools(tools: readonly ScopedThreadTools[]): void { this.threadTools = tools }
  /**
   * Sotto's own tool servers for this thread: the browser's, the host setup tools while its setup runs (ADR-0035), and
   * the visual tool while visuals are on (ADR-0055).
   */
  private async toolServers(id: string) {
    if (this.aliases[id]?.kind === 'personal' || !this.httpToolServers) return []
    const browser = this.browserTools ? [await this.browserTools.mcpServer(id)] : []
    return [...browser, ...(await scopedThreadServers(this.threadTools, id)).map(({ server }) => server)]
  }
  private showRequest(pending: Pending): void {
    if (this.aliases[pending.threadId]!.answeredRequestIds.includes(pending.request.id)) { pending.answering = true; pending.request.delivery = 'uncertain'; this.answeredRequests.add(pending.request.id) }
    this.pending.set(pending.request.id, pending); this.thread(pending.threadId).requests.push(pending.request); this.emit()
  }
  /** Grok's prompt for one of this thread's own Sotto tool servers, answered here rather than shown (ADR-0020, ADR-0035). */
  private toolAdmission(pending: Pending): unknown {
    if (!pending.permission || !this.httpToolServers || this.aliases[pending.threadId]?.kind === 'personal') return undefined
    // Each scoped server is answered the same way, by its own name: adding a host asks the user in the thread itself
    // (ADR-0035), and a visual changes nothing outside the thread (ADR-0055).
    const browser = this.browserTools ? grokBrowserAdmission(pending, BROWSER_MCP_SERVER, this.browserTools.definitions.map(tool => tool.name)) : undefined
    if (browser !== undefined) return browser
    for (const entry of this.threadTools) {
      const answer = grokBrowserAdmission(pending, entry.name, entry.definitions.map(tool => tool.name))
      if (answer !== undefined) return answer
    }
    return undefined
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
  private readonly activityListeners = new ActivitySubscribers()
  private readonly publisher = new ProviderSnapshotPublisher(() => {
    for (const listener of this.listeners) listener(this.current())
    this.activityListeners.publish(historyFromEvents => this.activitySnapshot(historyFromEvents))
  })
  /**
   * One ACP process per thread session, the way T3 Code runs Grok. The provider itself holds none between a
   * connect and the next: each thread's live work and requests go to its own process, one process exiting
   * fails only its own thread, and a client update moves each thread onto the new binary as it goes idle.
   */
  private readonly processes = new Map<string, ThreadProcess>()
  /** Threads whose process is an outdated process (CONTEXT.md): each stops as soon as its thread is not busy. */
  private readonly outdated = new Set<string>()
  /** Creates and sends still between their awaits, by thread: neither shows in the thread until it reaches Grok. */
  private readonly holds = new Map<string, number>()
  /** Every Grok process still running, so the shutdown barrier waits for them all. */
  private readonly exits = new Set<Promise<void>>()
  /** The client new processes start from, found again when the client is updated. */
  private executable: string | undefined
  /** Which client new processes start from, moved on by each client update; a thread's keeps the one it started with. */
  private clientRevision = 0
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
      isReading: id => this.historyReads.has(id),
      stop: id => this.stopSession(id),
    })
  }
  /**
   * A thread being created, a send on its way to Grok, a prompt in flight, a running turn or an unanswered request
   * all hold a session open.
   */
  private busy(id: string): boolean {
    const thread = this.threads.get(id)
    return this.holds.has(id) || this.activePrompts.has(id) || this.loading.has(id)
      || !!thread && (thread.status === 'running' || thread.requests.length > 0)
      || !!this.aliases[id]?.pendingRuntimeMode
  }
  /**
   * Load this thread's native session, once. Sotto holds no session until a thread is watched or acted on,
   * so this is where a thread's provider session begins on this connection.
   */
  private loadSession(id: string, reconciling = false): Promise<void> {
    const alias = this.aliases[id]
    if (!alias?.grokSessionId || !this.state.connected) return Promise.resolve()
    // A load reads and confirms this thread's native settings. A thread whose settings or permission mode
    // were never confirmed is reconciled by connecting, never by an action that would confirm them along
    // the way, so lazy loading leaves those threads exactly where they were.
    if (!reconciling && (!alias.settingsConfirmed || alias.pendingRuntimeMode)) return Promise.resolve()
    this.reaper.touch(id)
    if (this.loaded.has(id)) return Promise.resolve()
    const pending = this.loading.get(id); if (pending) return pending
    // The thread's own process starts here when it has none: the first need is its start.
    const work = this.threadProcess(id).then(async entry => {
      const mcpServers = await this.toolServers(id)
      await entry.rpc.request('session/load', { sessionId: alias.grokSessionId, cwd: alias.cwd, mcpServers, _meta: sessionPolicy(alias.pendingRuntimeMode ?? alias.runtimeMode) }, async value => {
        this.confirmLoad(id, alias, value); await this.persist()
      })
      if (this.processes.get(id) !== entry) return
      this.loaded.add(id); this.log.pin(id); this.reaper.touch(id)
    }).finally(() => { if (this.loading.get(id) === work) this.loading.delete(id); this.stopOutdated() })
    this.loading.set(id, work)
    return work
  }
  /**
   * Stop this thread's session: close it in Grok, then end its process. Grok reports `closed` or
   * `notResident`, and a later load restores the conversation, so the thread keeps its messages and its idle
   * status and the next action starts a process and loads it again. A close Grok refuses keeps the process.
   */
  private async stopSession(id: string): Promise<void> {
    const alias = this.aliases[id]; const entry = this.processes.get(id)
    this.loaded.delete(id)
    // The history cursor is a read position in a session Sotto no longer holds; the next load reads afresh.
    this.histories.delete(id)
    this.log.release(id)
    if (!entry) return
    // The slot is free at once: an action that arrives while the close is in flight starts a new process
    // rather than loading its session onto one about to end.
    this.processes.delete(id); this.outdated.delete(id)
    // A process that never finished starting holds no session, and its start already ended it.
    const started = await entry.ready.then(() => true, () => false)
    if (!started) return
    try { if (alias?.grokSessionId) await this.closeSession(entry.rpc, alias) }
    catch (error) {
      if (!this.processes.has(id) && !entry.lost && this.state.connected) { this.processes.set(id, entry); throw error }
    }
    this.closeProcess(entry)
  }
  private closeProcess(entry: ThreadProcess): void { entry.closing = true; entry.rpc.close() }
  /** Keep this thread's process from being stopped while a create or send is between awaits. Release once. */
  private hold(id: string): () => void {
    this.holds.set(id, (this.holds.get(id) ?? 0) + 1)
    let held = true
    return () => {
      if (!held) return
      held = false
      const left = (this.holds.get(id) ?? 1) - 1
      if (left > 0) this.holds.set(id, left); else this.holds.delete(id)
      this.stopOutdated()
    }
  }
  /** End a process that holds no loaded session, such as one started only to read a thread's history. */
  private releaseProcess(id: string): void {
    const entry = this.processes.get(id)
    if (!entry || this.loaded.has(id) || this.loading.has(id) || this.historyReads.has(id) || this.busy(id)) return
    this.processes.delete(id); this.outdated.delete(id); this.closeProcess(entry)
  }
  /** Start a Grok process. Its frames come back with the process that sent them. */
  private spawn(executable: string, lost: () => void): GrokRpc {
    const rpc: GrokRpc = new GrokRpc(executable, this.options.args ?? grokArguments(), this.userDataDirectory,
      grokEnvironment(this.options.environment), this.options.requestTimeoutMs ?? 15000, frame => this.frame(frame, rpc), lost)
    const exit = rpc.closed.finally(() => { this.exits.delete(exit) }); this.exits.add(exit)
    return rpc
  }
  /** Ask a process which client it is. Whether Sotto will drive it is `clientRefusal`'s answer. */
  private async identify(rpc: GrokRpc): Promise<GrokClient> {
    let client: GrokClient | undefined
    await rpc.request('initialize', { protocolVersion: GROK_ACP_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'sotto', version: '1' } }, value => {
      client = initializeSchema.parse(value)
    })
    return client!
  }
  private authenticate(rpc: GrokRpc): Promise<void> {
    return rpc.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } }, value => { z.object({}).parse(value) })
  }
  /** The provider's facts come from the newest client Sotto accepted, never from an older thread process. */
  private applyClient(client: GrokClient): void {
    this.httpToolServers = client.agentCapabilities.mcpCapabilities?.http === true
    this.state.version = `${client._meta.agentVersion} / ACP ${GROK_ACP_VERSION}`
    if (compareClientVersions(client._meta.agentVersion, GROK_CLI_VERSION) > 0) this.state.verifiedVersion = GROK_CLI_VERSION
    else delete this.state.verifiedVersion
    this.state.models = client._meta.modelState.availableModels.map(model => {
      // Grok lists its levels highest first; Sotto's order runs the other way (orderReasoningEfforts).
      const reasoningEfforts = model._meta?.supportsReasoningEffort ? orderReasoningEfforts(model._meta.reasoningEfforts?.map(effort => effort.value ?? effort.id) ?? []) : []
      // `_meta.reasoningEffort` is the level the session is on now, which a user's own Grok settings
      // can move; the level Grok marks as its default is what the card's Default button means.
      const flagged = model._meta?.reasoningEfforts?.find(effort => effort.default)
      const reportedDefault = flagged?.value ?? flagged?.id ?? model._meta?.reasoningEffort
      return { id: model.modelId, name: model.name, provider: 'Grok', ready: true, runtimeModes: [...grokRuntimeModes], supportsImages: false,
        reasoningEfforts, ...(reportedDefault && reasoningEfforts.includes(reportedDefault) ? { defaultReasoningEffort: reportedDefault } : {}) }
    })
  }
  /**
   * This thread's own process, started on first need from the current client. It is checked and signed in
   * the way connecting checks the provider, so a client Sotto would refuse never runs a thread either.
   */
  private threadProcess(id: string): Promise<ThreadProcess> {
    const current = this.processes.get(id); if (current) return current.ready
    const executable = this.executable
    if (!this.state.connected || !executable) return Promise.reject(new Error('Connect Grok before managing threads.'))
    const generation = this.generation
    const entry = { clientRevision: this.clientRevision, closing: false, lost: false } as ThreadProcess
    entry.rpc = this.spawn(executable, () => this.processLost(id, entry))
    entry.ready = (async () => {
      try {
        const refusal = clientRefusal(await this.identify(entry.rpc))
        if (refusal) throw refusal
        await this.authenticate(entry.rpc)
      } catch (error) {
        if (this.processes.get(id) === entry) this.processes.delete(id)
        this.closeProcess(entry)
        if (error instanceof GrokUnsupported) throw new Error(`Grok could not start this thread. ${error.message} Nothing was sent to it.`, { cause: error })
        if (error instanceof GrokRejected) throw new Error('Grok could not start this thread because Grok Build is not signed in on this machine. Nothing was sent to it. Sign in to Grok, then try again.', { cause: error })
        throw error
      }
      if (generation !== this.generation || this.processes.get(id) !== entry) throw new GrokUncertain('Grok connection changed while starting the thread.')
      return entry
    })()
    this.processes.set(id, entry)
    return entry.ready
  }
  /**
   * A thread's process ended without Sotto asking. Only that thread is affected: its session is no longer
   * loaded, its requests can no longer be answered, and a turn it was running has failed. The provider stays
   * connected, and the thread's next action starts a new process.
   */
  private processLost(id: string, entry: ThreadProcess): void {
    if (entry.closing) return
    entry.lost = true
    if (this.processes.get(id) !== entry) return
    this.processes.delete(id); this.outdated.delete(id)
    this.loaded.delete(id); this.histories.delete(id); this.log.release(id); this.reaper.forget(id)
    for (const pending of [...this.pending.values()]) if (pending.threadId === id) this.pending.delete(pending.request.id)
    const thread = this.threads.get(id)
    if (thread) {
      thread.requests = []
      if (this.endTurn(id, 'failed')) void this.persist().catch(() => undefined)
      // A Sotto prompt fails through its own request; a turn Sotto only watched fails here.
      if (thread.status === 'running' && !this.activePrompts.has(id)) { thread.status = 'error'; this.liveStatus.delete(id); this.markTurn(id, 'failed', undefined, THREAD_PROCESS_LOST) }
    }
    this.emit()
  }
  /**
   * Remember the turn this thread was running when its process ended, since no process is left to record
   * its end in Grok's history. Kept with the thread's metadata, so it holds across a restart too.
   */
  private endTurn(id: string, outcome: 'failed' | 'interrupted'): boolean {
    const alias = this.aliases[id]; const thread = this.threads.get(id)
    if (!alias || !thread || (thread.status !== 'running' && !this.activePrompts.has(id))) return false
    const turn = thread.lastTurn?.status === 'running' ? thread.lastTurn.id : this.histories.get(id)?.lastTurn?.id
    if (!turn) return false
    alias.endedTurn = { id: turn, outcome }
    return true
  }
  /** Stop every outdated process whose thread is no longer busy; a watched one starts again at once on the new client. */
  private stopOutdated(): void {
    if (!this.outdated.size) return
    for (const id of [...this.outdated]) {
      const entry = this.processes.get(id)
      if (!entry || entry.clientRevision === this.clientRevision) { this.outdated.delete(id); continue }
      if (this.busy(id) || this.historyReads.has(id)) continue
      this.outdated.delete(id)
      const generation = this.generation
      void this.stopSession(id).then(() => {
        if (generation !== this.generation || !this.observed.has(id) || !this.aliases[id]?.grokSessionId) return
        return this.loadSession(id, true).then(() => this.queueRead(id))
      }).catch(() => { if (generation === this.generation && this.processes.get(id) === entry) this.outdated.add(id) })
    }
  }
  /** The public snapshot: a copy of everything, held threads' messages included. A caller that keeps history
   * from this adapter's events is handed every thread with its summary and no messages, as an activity
   * subscriber that asks for it is (#368). */
  private current(historyFromEvents = false): AgentHostSnapshot {
    if (historyFromEvents) return cloneActivitySnapshot(this.activitySnapshot(true))
    return cloneHostSnapshot({ ...this.state, threads: [...this.threads.values()]
      .filter((thread): thread is AgentThread => 'projectId' in thread).map(thread => this.log.publishedThread(thread)) })
  }
  /** What activity subscribers are handed. One that keeps history from this adapter's events gets each
   * thread's summary and no messages: those already left as events (#322). */
  private activitySnapshot(historyFromEvents: boolean): AgentHostSnapshot {
    for (const thread of this.threads.values()) if (thread.activities && !isImmutableActivities(thread.activities)) {
      thread.activities = immutableActivities(thread.activities)
    }
    return { ...this.state, threads: [...this.threads.values()]
      .filter((thread): thread is AgentThread => 'projectId' in thread).map(thread => this.log.activityThread(thread, historyFromEvents)) }
  }
  private emit(streaming = false): void { this.publisher.publish(streaming); this.stopOutdated() }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
    return this.activityListeners.add(listener, options)
  }
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
    // Side calls' throwaway homes that a crash or a failed removal left behind hold thread content (ADR-0026).
    await sweepLeftoverSessions(join(this.userDataDirectory, 'writing', 'grok'))
    const executable = this.options.executable ?? await findGrokExecutable(this.options.environment)
    if (!executable || !isAbsolute(executable)) throw new ProviderUnavailable('not-installed', 'Install Grok CLI and sign in before connecting Grok.')
    this.aliases = await this.aliasStore.read(); this.state.projects = await this.projectStore.read(); this.threads.clear(); this.streams.clear(); this.authored.clear(); this.liveStatus.clear(); this.selections.clear(); this.activePrompts.clear(); this.seenUpdates.clear(); this.answeredRequests.clear(); this.histories.clear()
    if (generation !== this.generation) throw new Error('Grok connection was cancelled.')
    this.executable = executable
    /** The client's version when it is older than Sotto supports, which a host's tile names (ADR-0037). */
    let tooOld: string | undefined
    // Connecting checks the client and its sign-in on a process of its own, which ends once it has answered.
    // Threads start their own processes as they are needed, from the same client.
    const probe = this.spawn(executable, () => undefined)
    try {
      try {
        const client = await this.identify(probe)
        const refusal = clientRefusal(client)
        if (refusal instanceof GrokTooOld) tooOld = refusal.version
        if (refusal instanceof GrokSignedOut) throw new ProviderUnavailable('signed-out', 'Sign in to Grok Build on this machine, then connect it again.', client._meta.agentVersion)
        if (refusal) throw refusal
        this.applyClient(client)
        // Grok refuses its cached sign-in when there is none: that is the one refusal a host's tile offers Sign in for (ADR-0037).
        try { await this.authenticate(probe) }
        catch (error) { throw error instanceof GrokRejected ? new ProviderUnavailable('signed-out', 'Sign in to Grok Build on this machine, then connect it again.', client._meta.agentVersion) : error }
      } finally { probe.close() }
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
      // Each watched session loads in a new process of its own, where it is not yet resident, so a pending
      // mode change is applied by the load itself: nothing is left over to close first.
      await Promise.all(Object.entries(this.aliases).filter(([id, alias]) => alias.grokSessionId && this.observed.has(id)).map(([id]) => this.loadSession(id, true)))
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
      const refused = error instanceof GrokUnsupported || error instanceof ProviderUnavailable
      const detail = refused || error instanceof GrokUncertain ? error.message : ''
      const message = ['Could not connect Grok.', detail, refused ? '' : 'Connect again to retry.'].filter(Boolean).join(' ')
      if (error instanceof ProviderUnavailable) throw new ProviderUnavailable(error.problem, message, error.version, error.requiredVersion)
      if (tooOld) throw new ProviderUnavailable('too-old', message, tooOld, GROK_CLI_VERSION)
      throw new Error(message, { cause: error })
    }
  }
  /**
   * The Grok client on disk was updated while Sotto stayed connected. Find it again (the installer may have
   * moved it), ask the new binary which client it is, and hold it to the same checks connecting applies
   * (ADR-0042). An accepted client becomes the provider's version and the one every new process starts
   * from; each thread moves onto it as it goes idle: an idle session stops now, invisibly, as the reaper
   * stops one, and a working one finishes its turn on the process it started with and stops after. Nothing
   * is disconnected, cancelled or answered here. A client Sotto cannot find, or would refuse, is refused with
   * the sentence the update reports: nothing moves to it, and the provider's version stays what it was.
   */
  async clientUpdated(): Promise<void> {
    if (!this.state.connected) return
    const generation = this.generation
    const executable = await Promise.resolve(this.options.executable ?? findGrokExecutable(this.options.environment)).catch(() => undefined)
    if (generation !== this.generation || !this.state.connected) return
    if (!executable || !isAbsolute(executable)) throw new Error('Grok Build was updated, but Sotto cannot find it now. Threads that are working carry on and nothing was lost. Check the Grok Build install, then connect Grok Build again.')
    const probe = this.spawn(executable, () => undefined)
    let client: GrokClient
    try { client = await this.identify(probe) }
    catch (error) {
      if (generation !== this.generation || !this.state.connected) return
      throw new Error('Grok Build was updated, but the new version did not answer. Threads that are working carry on and nothing was lost. Connect Grok Build again to try the new version.', { cause: error })
    } finally { probe.close() }
    if (generation !== this.generation || !this.state.connected) return
    const refusal = clientRefusal(client)
    if (refusal) throw new Error(`Grok Build was updated, but Sotto cannot run the new version. ${refusal.message} Threads that are working carry on and nothing was lost. Install a Grok Build version Sotto supports, then connect Grok Build again.`, { cause: refusal })
    // Set together with the version, so a process is started either from the old client and counted old, or from the new one.
    this.executable = executable; this.clientRevision++
    this.applyClient(client)
    for (const [id, entry] of this.processes) if (entry.clientRevision < this.clientRevision) this.outdated.add(id)
    this.emit()
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
  /**
   * A side call on this thread's client, account and model, in its folder (ADR-0026). It is its own
   * short-lived Grok process with a throwaway home, not the thread's own process, so the
   * thread's session is never loaded for it and this adapter's alias store never learns of it.
   */
  async writeShortText(id: string, prompt: ShortTextPrompt, signal?: AbortSignal): Promise<string | null> {
    const alias = this.aliases[id]
    if (!this.state.connected || !alias?.grokSessionId) return null
    const writer = new GrokSubscriptionClient(join(this.userDataDirectory, 'writing', 'grok'), {
      ...(this.options.executable ? { executable: this.options.executable } : {}), ...(this.options.args ? { prefixArgs: this.options.args } : {}),
      ...(this.options.environment ? { environment: this.options.environment } : {}) })
    return writer.write({ ...prompt, model: alias.nativeModelId ?? alias.modelId, workingDirectory: await existingWorkingDirectory(alias.cwd), timeoutMs: SIDE_WRITING_TIMEOUT_MS, ...(signal ? { signal } : {}) })
  }
  async refreshThread(id: string, purpose?: ThreadReadPurpose): Promise<AgentHostSnapshot> {
    if (!this.aliases[id]?.grokSessionId) throw new Error('This Grok thread has no confirmed provider session.')
    // Reading a thread is opening it, so a session that is not loaded on this connection loads here.
    await this.loadSession(id)
    // An explicit refresh reads to the end of the history: what it reports decides whether a prompt is sent.
    await this.queueRead(id)
    return this.current(purpose?.historyFromEvents)
  }
  private async queueRead(id: string, maxPages = Number.POSITIVE_INFINITY): Promise<void> {
    const generation = this.generation
    const work = (this.historyReads.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => {
      if (generation !== this.generation || !this.state.connected) throw new Error('Grok connection changed while reading the thread.')
      return this.readHistory(id, maxPages)
    })
    this.historyReads.set(id, work)
    try { await work }
    finally {
      if (this.historyReads.get(id) === work) {
        this.historyReads.delete(id)
        // A process started only to read an unloaded session's history ends with the read, and an outdated
        // one the read held open can stop now.
        this.releaseProcess(id); this.stopOutdated()
      }
    }
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
    if (!this.state.connected) return
    // Only a loaded session is polled; an unopened thread costs nothing until it is watched or acted on.
    for (const [id, alias] of Object.entries(this.aliases)) {
      if (!alias.grokSessionId || !this.loaded.has(id)) continue
      const entry = this.processes.get(id); const generation = this.generation
      try { await this.queueRead(id, HISTORY_PAGES_PER_POLL) }
      catch (error) {
        // A read cut short because its thread's own process ended or was stopped is that thread's business,
        // already settled where the process went; the provider's history is still being checked.
        if (generation === this.generation && this.state.connected && entry && (entry.lost || this.processes.get(id) !== entry)) continue
        throw error
      }
    }
  }
  private async readHistory(id: string, maxPages = Number.POSITIVE_INFINITY): Promise<void> {
    const generation = this.generation; const alias = this.aliases[id]!
    // A loaded session is read on its own process; an unloaded one is read on a process started for it.
    const entry = await this.threadProcess(id); const rpc = entry.rpc
    const current = () => generation === this.generation && this.processes.get(id) === entry && this.state.connected
    const history = this.histories.get(id) ?? freshHistory()
    this.histories.set(id, history)
    let more = true; let changed = false; let pages = 0; let restarted = false
    while (more && pages < maxPages) {
      pages++
      await rpc.request('_x.ai/session/updates', { sessionId: alias.grokSessionId, cwd: alias.cwd, offset: history.offset, limit: HISTORY_PAGE_SIZE }, value => {
        if (!current()) { more = false; return }
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
          if (this.loaded.has(id)) this.reaper.touch(id)
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
    if (!current()) throw new Error('Grok connection changed while reading the thread.')
    if (changed) await this.persist()
    if (!current()) throw new Error('Grok connection changed while reading the thread.')
    const thread = this.thread(id)
    if (history.activities.length || thread.activities?.length) thread.activities = mergeAgentActivities(thread.activities, history.activities)
    let status = history.status; let lastTurn = history.lastTurn
    // A turn whose process ended before it finished never records its end in Grok's history, which would
    // otherwise read as running for good and refuse every later send. Sotto saw it end, and says how.
    if (status === 'running' && lastTurn && alias.endedTurn?.id === lastTurn.id && !this.activePrompts.has(id)) {
      status = alias.endedTurn.outcome === 'failed' ? 'error' : 'idle'; lastTurn = { id: lastTurn.id, status: alias.endedTurn.outcome }
    }
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
    if (!this.state.connected) throw new Error('Connect Grok before managing threads.')
    /** A settings change Grok confirmed, or one that had nothing to change: its snapshot carries the effective settings. */
    let settled = false
    /** Whether that snapshot may leave every thread's messages out, because its caller keeps history from events (#368). */
    const historyFromEvents = command.type === 'configure-thread' && command.historyFromEvents === true
    /** A send holds its thread's process from its first read of the thread until the prompt is on its way. */
    let release: (() => void) | undefined
    try {
      if (command.type === 'create-project') {
        if (!isAbsolute(command.path)) throw new Error('Grok projects require an absolute working directory.')
        if (!this.state.projects.some(project => project.id === command.projectId)) { this.state.projects.push({ id: command.projectId, title: command.title, path: command.path }); await this.projectStore.write(this.state.projects) }
      } else if (command.type === 'create-thread' || command.type === 'create-personal') {
        if (this.aliases[command.threadId]) return this.aliases[command.threadId]!.settingsConfirmed ? { accepted: true } : { accepted: false, uncertain: true }
        validateThreadOptions(this.state, command)
        const project = command.type === 'create-thread' ? this.state.projects.find(project => project.id === command.projectId) : undefined; if (command.type === 'create-thread' && !project) throw new Error('Choose a Grok project first.')
        // A create that names no level (the Agents view's new-thread form, a coordinator dispatch) starts on
        // the model's default and says so to Grok. Left unsent, Grok would run at the level in the user's
        // own Grok settings while the chip fell back to the flagged default and named a level it is not on.
        const reasoningEffort = command.reasoningEffort ?? this.state.models.find(model => model.id === command.modelId)?.defaultReasoningEffort
        const alias: Alias = { ...(command.type === 'create-personal' ? { kind: 'personal' as const } : { projectId: project!.id }), cwd: await existingWorkingDirectory(command.workingDirectory ?? project!.path), title: command.title, modelId: command.modelId, settingsConfirmed: false, createdAt: new Date().toISOString(), origins: [], answeredRequestIds: [], ...(reasoningEffort ? { reasoningEffort } : {}), ...(command.runtimeMode ? { runtimeMode: grokRuntimeMode(command.runtimeMode) } : {}) }
        // The thread's own process starts before anything is saved for it, so a client that cannot start
        // leaves no thread behind. Its session is created there and stays resident there, and the process is
        // held until the create is done: a client update meanwhile must not stop it halfway.
        const releaseCreate = this.hold(command.threadId)
        let rpc: GrokRpc
        try { ({ rpc } = await this.threadProcess(command.threadId)) } catch (error) { releaseCreate(); throw error }
        try { this.aliases[command.threadId] = alias; await this.persist() } catch (error) { releaseCreate(); throw error }
        try {
          await rpc.request('session/new', { cwd: alias.cwd, mcpServers: await this.toolServers(command.threadId), _meta: sessionPolicy(alias.runtimeMode) }, async value => {
            const response = z.object({ sessionId: z.string().uuid(), models: catalogSchema }).parse(value)
            alias.grokSessionId = response.sessionId; alias.nativeModelId = response.models.currentModelId; await this.persist(); this.thread(command.threadId).status = 'error'; this.emit()
          })
          await rpc.request('session/set_model', { sessionId: alias.grokSessionId, modelId: alias.modelId, ...(alias.reasoningEffort ? { _meta: { reasoningEffort: alias.reasoningEffort } } : {}) }, value => {
            z.object({ _meta: z.object({ model: z.object({ Ok: z.literal(alias.modelId) }) }) }).parse(value)
          })
          if (alias.reasoningEffort && this.selections.get(alias.grokSessionId!)?.effort !== alias.reasoningEffort) {
            // Grok can reply before model_changed. Read its owned session's native state; never infer success.
            await rpc.request('session/load', { sessionId: alias.grokSessionId, cwd: alias.cwd, mcpServers: await this.toolServers(command.threadId), _meta: sessionPolicy(alias.runtimeMode) }, value => {
              const response = z.object({ models: catalogSchema, _meta: z.object({ sessionId: z.literal(alias.grokSessionId!) }) }).parse(value)
              if (response.models.currentModelId !== alias.modelId || response.models.availableModels.find(model => model.modelId === alias.modelId)?._meta?.reasoningEffort !== alias.reasoningEffort) throw new Error('Grok did not confirm the requested reasoning effort.')
            })
          }
          alias.settingsConfirmed = true; alias.nativeModelId = alias.modelId; await this.persist()
        } catch (error) {
          releaseCreate()
          // A refused creation leaves nothing running; an uncertain one keeps its process for the late answer.
          if (!(error instanceof GrokUncertain)) this.releaseProcess(command.threadId)
          throw error
        }
        // A new session is resident and polled from here; the reaper owns it like any other.
        this.loaded.add(command.threadId); this.reaper.touch(command.threadId)
        const thread = this.thread(command.threadId); thread.modelId = alias.modelId; thread.status = 'idle'; if (alias.reasoningEffort) thread.reasoningEffort = alias.reasoningEffort
        releaseCreate()
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
              // The change happens on the thread's own process, the one its session is resident in.
              const { rpc } = await this.threadProcess(command.threadId)
              await this.closeSession(rpc, alias)
              await rpc.request('session/load', { sessionId: alias.grokSessionId, cwd: alias.cwd, mcpServers: await this.toolServers(command.threadId), _meta: sessionPolicy(mode) }, async value => {
                this.confirmLoad(command.threadId, alias, value); await this.persist()
              })
              thread.status = alias.settingsConfirmed ? 'idle' : 'error'
            }
          }
          settled = alias.settingsConfirmed && !alias.pendingRuntimeMode
        } else if (command.type === 'send') {
          release = this.hold(command.threadId)
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
          // The prompt now holds the process itself.
          release()
          const generation = this.generation
          let entry: ThreadProcess
          try {
            await this.persist()
            // Saving the origin is an async boundary at which native CLI input can revoke authority.
            await this.refreshThread(command.threadId)
            if (command.expectedLastUserMessageId !== undefined && (this.log.lastUserMessageId(command.threadId) ?? null) !== command.expectedLastUserMessageId) throw new Error('The latest user message changed. Review the thread before replying.')
            if (thread.requests.length) throw new Error('Answer the pending Grok request before sending another prompt.')
            // The turn runs on the process that holds the thread's session, and stays there to its end.
            entry = await this.threadProcess(command.threadId)
            if (generation !== this.generation || !this.state.connected || !this.activePrompts.has(command.threadId) || !this.loaded.has(command.threadId)) throw new Error('The Grok prompt was cancelled before dispatch.')
          } catch (error) {
            // No prompt was written. Rolling back this reserved origin cannot duplicate native work.
            alias.origins = alias.origins.filter(item => item !== origin); this.activePrompts.delete(command.threadId); await this.persist()
            throw error instanceof GrokUncertain ? new Error('Grok history could not be verified before sending the prompt.', { cause: error }) : error
          }
          let timer: ReturnType<typeof setTimeout> | undefined
          const delivery = new Promise<void>((resolve, reject) => { this.deliveries.set(command.messageId, { resolve, reject }); timer = setTimeout(() => reject(new GrokUncertain('Grok prompt delivery is uncertain.')), this.options.requestTimeoutMs ?? 15000) })
          // ACP prompt responds at turn completion. Its authored-message echo acknowledges delivery.
          markSendStage(command.commandId, 'written')
          void entry.rpc.request('session/prompt', { sessionId: alias.grokSessionId, prompt: [{ type: 'text', text: nativeText }] }, value => {
            const completion = z.object({ stopReason: z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']) }).parse(value)
            this.thread(command.threadId).lastTurn = { id: command.messageId, status: turnOutcome(completion.stopReason) }
            this.markTurn(command.threadId, turnOutcome(completion.stopReason), command.messageId)
            this.activePrompts.delete(command.threadId); this.thread(command.threadId).status = 'idle'; this.deliveries.get(command.messageId)?.resolve(); this.emit()
          }, true).catch(async error => {
            if (error instanceof GrokRejected) { alias.origins = alias.origins.filter(item => item !== origin); await this.persist() }
            this.activePrompts.delete(command.threadId); this.deliveries.get(command.messageId)?.reject(error)
            this.thread(command.threadId).status = 'error'; this.thread(command.threadId).lastTurn = { id: command.messageId, status: 'failed' }
            // A process that ended mid-turn failed this thread alone, and the next send starts a new one.
            this.markTurn(command.threadId, 'failed', command.messageId, entry.lost ? THREAD_PROCESS_LOST : error instanceof Error ? error.message : undefined)
            this.emit()
          }).catch(() => this.disconnect())
          try { await delivery } finally { clearTimeout(timer); this.deliveries.delete(command.messageId) }
          markSendStage(command.commandId, 'acknowledged')
          await this.refreshThread(command.threadId)
        } else if (command.type === 'answer') {
          const pending = this.pending.get(command.requestId)
          if (!pending || pending.threadId !== command.threadId) throw new Error('That Grok request is no longer pending.')
          if (pending.answering || this.answeredRequests.has(pending.request.id)) return { accepted: false, uncertain: true }
          const result = grokAnswer(pending, command.answer, command.approved, command.questionAnswers, command.permissionChoice)
          pending.answering = true; this.answeredRequests.add(pending.request.id)
          alias.answeredRequestIds.push(pending.request.id)
          try { await this.persist() } catch (error) { alias.answeredRequestIds = alias.answeredRequestIds.filter(id => id !== pending.request.id); pending.answering = false; this.answeredRequests.delete(pending.request.id); throw error }
          // The answer goes to the process that asked, and only while that process is still the thread's.
          if (pending.rpc !== this.processes.get(command.threadId)?.rpc || !this.state.connected || !this.pending.has(pending.request.id)) return { accepted: false, uncertain: true }
          try { await pending.rpc.reply(pending.wireId, result); this.removeRequest(pending) }
          catch { pending.request.delivery = 'uncertain'; this.emit(); return { accepted: false, uncertain: true } }
        } else if (command.type === 'interrupt') {
          this.activePrompts.delete(command.threadId)
          await this.decline(command.threadId)
          ;(await this.threadProcess(command.threadId)).rpc.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: alias.grokSessionId } })
        }
      }
      this.emit()
      // What was emitted is the reconciliation of a confirmed settings change.
      return settled ? { accepted: true, snapshot: this.current(historyFromEvents) } : { accepted: true }
    } catch (error) { if (error instanceof GrokUncertain) return { accepted: false, uncertain: true }; throw error }
    finally { release?.() }
  }
  /** One frame from one process. A request is answered on the process that sent it, never another. */
  private async frame(frame: GrokFrame, rpc: GrokRpc): Promise<void> {
    let method = frame.method; let params = frame.params
    if (method?.startsWith('_')) {
      method = method.slice(1)
      const wrapped = z.object({ method: z.string(), params: z.unknown() }).safeParse(params)
      if (wrapped.success) { method = wrapped.data.method; params = wrapped.data.params }
    }
    if (frame.id !== undefined && method) {
      const sessionId = object(params)?.sessionId
      const threadId = typeof sessionId === 'string' ? this.id(sessionId) : undefined
      const asked = threadId ? grokPending(frame.id, method, params, threadId) : undefined
      const pending: Pending | undefined = asked && { ...asked, rpc }
      if (pending) {
        // RPC counters restart on reconnect; the native tool request owns the durable identity.
        pending.request.id = `grok-request-${digest(JSON.stringify([threadId, pending.toolCallId, pending.request.kind]))}`
        this.reaper.touch(pending.threadId)
        if (this.answeredRequests.has(pending.request.id) || this.pending.has(pending.request.id)) return
        const admission = this.toolAdmission(pending)
        // An admission that fails to arrive is shown instead, so a request never goes unanswered and unseen.
        if (admission !== undefined) { rpc.reply(pending.wireId, admission).catch(() => { if (this.processes.get(pending.threadId)?.rpc === rpc) this.showRequest(pending) }); return }
        this.showRequest(pending)
      }
      else {
        rpc.write({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Sotto does not handle this request.' } })
        // Grok reads that refusal as an answer and keeps going, so a renamed or reshaped approval would
        // otherwise pass as the user declining. Foreign sessions stay none of Sotto's business.
        if (threadId && needsPerson(method)) {
          const notice = unreadableRequest('Grok'); const thread = this.thread(threadId)
          if (this.state.error !== notice || thread.requestNotice !== notice) {
            thread.requestNotice = notice; this.state.error = notice; this.emit()
          }
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
  private async decline(id: string): Promise<void> { for (const pending of [...this.pending.values()]) if (pending.threadId === id && !pending.answering) { this.removeRequest(pending); await pending.rpc.reply(pending.wireId, this.refusal(pending)) } }
  disconnect(): void {
    this.generation++; clearInterval(this.pollTimer); this.reaper.dispose(); this.loaded.clear(); this.loading.clear()
    for (const pending of this.pending.values()) { if (pending.answering) continue; try { pending.rpc.write({ jsonrpc: '2.0', id: pending.wireId, result: this.refusal(pending) }) } catch { /* Closed pipes never grant permission. */ } }
    this.pending.clear(); for (const thread of this.threads.values()) thread.requests = []
    for (const delivery of this.deliveries.values()) delivery.reject(new GrokUncertain('Grok disconnected before acknowledgement.'))
    this.deliveries.clear()
    // Each thread's turn ends with its process, and Grok's history will never say so.
    let ended = false
    for (const id of this.processes.keys()) ended = this.endTurn(id, 'interrupted') || ended
    if (ended) void this.persist().catch(() => undefined)
    for (const entry of this.processes.values()) this.closeProcess(entry)
    this.processes.clear(); this.outdated.clear(); this.state.connected = false; this.emit()
  }
  async closed(): Promise<void> { await Promise.all([...this.exits]); await this.polling?.catch(() => undefined); await Promise.allSettled(this.historyReads.values()); await this.writing; await this.usage.flushed() }
}
