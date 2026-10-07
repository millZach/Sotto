import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { version as appVersion } from '../../../package.json'
import { agentProjectSchema, type AgentHostSnapshot, type AgentMessage, type AgentProviderMode, type AgentRuntimeMode, type AgentThread } from '../../shared/agents'
import { mergeAgentActivities } from '../../shared/agentActivity'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { ProviderUnavailable } from './providerProblem'
import type { ActivitySubscriptionOptions, AgentHost, AgentHostCommand, AgentHostResult, ThreadHistorySource, ThreadHostEvent, ThreadReadPurpose } from './host'
import { ThreadMessageLog } from './threadMessageLog'
import { cloneHostSnapshot } from './cloneHostSnapshot'
import { ActivitySubscribers, cloneActivitySnapshot, immutableActivities, isImmutableActivities } from './activitySnapshots'
import { ProviderSnapshotPublisher } from './providerSnapshotPublisher'
import { SessionReaper } from './sessionReaper'
import { existingWorkingDirectory } from './threadWorktrees'
import { validatePromptAttachments, validateThreadOptions } from './threadOptions'
import { verifyFileMentions } from './promptFiles'
import { markTurnActivity } from './turnActivity'
import { DEVIN_THINKING_ID_PREFIX, devinActivities } from './devinActivity'
import { settledThinking, thinkingSettledAs } from './thinkingActivity'
import { devinPending, devinAnswer, devinDecline, type DevinPending } from './devinRequests'
import { markSendStage } from './sendStages'
import { prepareDevinPolicy, verifyDevinPolicy, assertDevinNoIntegrations, type DevinAllowance, type DevinProfile } from './devinPolicy'
import { compareClientVersions } from './clientVersions'
import { DevinRpc, DevinRejected, DevinUncertain, DEVIN_CLI_VERSION, DEVIN_ACP_VERSION, devinEnvironment, findDevinExecutable, readDevinVersion, type DevinFrame } from './devinRpc'

const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024
const MAX_TOOL_BYTES = 8 * 1024 * 1024
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const originSchema = z.object({
  nativeMessageId: z.string().uuid(), messageId: z.string(), commandId: z.string(),
  digest: z.string(), createdAt: z.string(), confirmed: z.boolean().default(false),
})
const aliasSchema = z.object({
  devinSessionId: z.string().optional(), ephemeral: z.boolean().default(false), emptyReleased: z.boolean().default(false), projectId: z.string(), cwd: z.string(), title: z.string(), modelId: z.string(),
  createdAt: z.string(), settingsConfirmed: z.boolean(), origins: z.array(originSchema),
  answeredRequestIds: z.array(z.string()).default([]),
  /** Absent on a thread made before permission modes existed, which keeps the asking default. */
  providerMode: z.string().optional(),
})
type Alias = z.infer<typeof aliasSchema>
type Origin = z.infer<typeof originSchema>
const optionSchema = z.object({ value: z.string().min(1), name: z.string().min(1), description: z.string().max(2_000).optional() })
const configSchema = z.object({
  id: z.string(), currentValue: z.string(),
  options: z.array(z.union([optionSchema, z.object({ group: z.string(), name: z.string(), options: z.array(optionSchema) })])).optional(),
})
const sessionSchema = z.object({ configOptions: z.array(configSchema) })
function sessionModeConfig(value: unknown) {
  const mode = sessionSchema.parse(value).configOptions.find(option => option.id === 'mode')
  if (!mode) throw new Error('Devin did not report its permission modes. Your threads are kept. Use a Devin CLI version Sotto has checked, then reconnect.')
  const reported = new Map((mode.options ?? []).flatMap(option => 'value' in option ? [option] : option.options)
    .map(option => [option.value, { name: option.name, description: option.description }] as const))
  return { current: mode.currentValue, reported }
}
function modelConfig(value: unknown) {
  const model = sessionSchema.parse(value).configOptions.find(option => option.id === 'model')
  if (!model) throw new Error('Devin did not confirm its model. Reconnect before sending.')
  const models = (model.options ?? []).flatMap(option => 'value' in option ? [option] : option.options)
  return { current: model.currentValue, models }
}
interface Transcript {
  messages: AgentMessage[]
  bytes: number
  user?: AgentMessage
  assistant?: AgentMessage
  nativeUser?: string
}
/**
 * Devin names its own conversation modes, and Sotto's four do not fit them. These are the settings the
 * permission chip offers for a Devin thread: Devin's own modes, each with the allowance Sotto writes into
 * the owned profile so the mode means what it says, plus `ask-first`, which is Devin coding with Sotto
 * asking about everything. That one comes first because it is what a thread starts on, and what a thread
 * made before this keeps: an upgrade may not let Devin act unasked where the user never chose it (ADR-0022).
 * Only the modes Devin reports are offered; this table says what each one allows, which Devin does not.
 */
const DEVIN_MODES = [
  { id: 'ask-first', devinMode: 'accept-edits', allows: 'nothing', name: 'Ask first',
    description: 'Devin writes code and Sotto asks you first.', asks: 'Sotto asks before every edit, command and fetch.' },
  { id: 'accept-edits', devinMode: 'accept-edits', allows: 'edits', name: 'Code',
    description: 'Write and edit code.', asks: 'Sotto asks before every command and fetch.' },
  { id: 'smart', devinMode: 'smart', allows: 'edits', name: 'Smart',
    description: 'Auto-approve actions the model judges safe.', asks: 'Sotto asks before every command and fetch.' },
  { id: 'plan', devinMode: 'plan', allows: 'nothing', name: 'Plan',
    description: 'Plan changes before implementing.', asks: 'Sotto asks before every edit, command and fetch.' },
  { id: 'ask', devinMode: 'ask', allows: 'nothing', name: 'Ask',
    description: 'Answer questions without code changes.', asks: 'Sotto asks before every edit, command and fetch.' },
  { id: 'bypass', devinMode: 'bypass', allows: 'everything', name: 'Bypass permissions',
    description: 'Auto-approve all tool calls.', asks: 'Sotto asks about nothing. Devin acts without asking you.' },
] as const satisfies readonly { id: string; devinMode: string; allows: DevinAllowance; name: string; description: string; asks: string }[]
type DevinMode = (typeof DEVIN_MODES)[number]
/**
 * The settings offered for Devin: only the modes Devin reports, in Devin's own words where the setting is
 * Devin's mode, and each with what Sotto still asks. Ask first is Sotto's, so it keeps Sotto's words, and it
 * is offered only while the mode it runs Devin in is one Devin reports.
 */
function offeredModes(reported: ReadonlyMap<string, { readonly name: string; readonly description?: string | undefined }>): AgentProviderMode[] {
  return DEVIN_MODES.filter(mode => reported.has(mode.devinMode)).map(mode => {
    const own = mode.id === mode.devinMode ? reported.get(mode.devinMode) : undefined
    return { id: mode.id, name: own?.name ?? mode.name, description: own?.description ?? mode.description, asks: mode.asks, allows: mode.allows }
  })
}
/** An unknown or missing mode is the asking one, never a more permissive guess. */
const modeOf = (id: string | undefined): DevinMode => DEVIN_MODES.find(mode => mode.id === id) ?? DEVIN_MODES[0]
/** What an allowance means in Sotto's own four, so every surface that reads `runtimeMode` still reads the truth. */
const RUNTIME_OF_ALLOWANCE: Record<DevinAllowance, AgentRuntimeMode> = { nothing: 'approval-required', edits: 'auto-accept-edits', everything: 'full-access' }
/** Devin's own reason when it gave one, since the provider notice is the only place a thread's open failure is read. */
const openFailure = (error: unknown): string => error instanceof Error && !(error instanceof DevinUncertain) && error.message
  ? error.message : 'A Devin session could not be opened. Your thread is kept. Check the native client and reconnect.'

interface Connection {
  rpc: DevinRpc
  nonce: string
  profile: DevinProfile
  fresh: boolean
  tools: Map<string, Record<string, unknown>>
  toolBytes: number
  transcript: Transcript
  replaying: boolean
  /** The Devin mode confirmed on this process. Any other mode it announces after that is its own change. */
  mode: string | undefined
  intentionalClose: boolean
  /** When the profile and native integrations were last confirmed for this process, so one send checks them once. */
  checkedAt: number
}
interface ActiveTurn {
  origin: Origin
  text: string
  assistant: string
  /** The owner's own stream has carried this turn's work: Devin took the prompt (see `send`). */
  streamed: boolean
  /** The prompt's own answer came, or the turn was settled without one. */
  ended: boolean
  /** Wakes the send waiting on this turn's acceptance. */
  wake: (() => void) | undefined
}
/**
 * What only a prompt being worked on streams. Devin streams these between a prompt and its answer and at no
 * other time, so on the connection that holds the session they are evidence its one prompt was taken. A
 * `tool_call_update` is left out because background work started by an earlier turn may still report.
 */
const TURN_WORK = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'plan'])
/** How long a send waits on the owner's stream before it also reads the replay for its dispatch identity. */
const ACCEPTANCE_GRACE_MS = 1_500
const settle = (turn: ActiveTurn): void => { turn.ended = true; turn.wake?.() }
export interface DevinAcpOptions {
  executable?: string
  /** Arguments before native flags, used by the scripted provider. */
  args?: string[]
  environment?: NodeJS.ProcessEnv
  nativeConfigDirectory?: string
  requestTimeoutMs?: number
  pollIntervalMs?: number
  /** How long a send waits on the owner's stream before reading the replay as well. */
  acceptanceGraceMs?: number
  reaperSweepMs?: number
  sessionIdleMs?: number
}

/** Devin owns its account and tools. Sotto saves only session/dispatch identities in this adapter. */
export class DevinAcpHost implements AgentHost {
  private readonly aliasStore: AtomicJsonStore<Record<string, Alias>>
  private readonly projectStore: AtomicJsonStore<AgentHostSnapshot['projects']>
  private aliases: Record<string, Alias> = {}
  private readonly threads = new Map<string, AgentThread>()
  private readonly connections = new Map<string, Connection>()
  private readonly loading = new Map<string, Promise<Connection>>()
  private readonly reading = new Map<string, Promise<void>>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly lastReadAt = new Map<string, number>()
  private readonly active = new Map<string, ActiveTurn>()
  private readonly pending = new Map<string, { decision: DevinPending; connection: Connection; fingerprint: string }>()
  private readonly dispatching = new Set<string>()
  private readonly observed = new Set<string>()
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private readonly activityListeners = new ActivitySubscribers()
  private readonly allProcesses = new Set<DevinRpc>()
  private readonly log = new ThreadMessageLog()
  private history: ThreadHistorySource | undefined
  private readonly publisher = new ProviderSnapshotPublisher(() => {
    for (const listener of this.listeners) listener(this.current())
    this.activityListeners.publish(historyFromEvents => this.activitySnapshot(historyFromEvents))
  })
  private readonly reaper: SessionReaper
  private state: AgentHostSnapshot = {
    connected: false, name: 'Devin', version: '', projects: [], models: [], threads: [],
    capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true,
      permissions: true, interrupt: true, messageOrigin: true, reconcile: true,
      configureThread: true, configureThreadModel: false, skills: false, steer: false, compact: false },
  }
  private executable = ''
  private generation = 0
  private writing = Promise.resolve()
  private shutdown = Promise.resolve()
  private polling: Promise<void> | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  constructor(private readonly userDataDirectory: string, private readonly options: DevinAcpOptions = {}) {
    this.aliasStore = new AtomicJsonStore(join(userDataDirectory, 'devin-threads.json'), z.record(z.string(), aliasSchema).parse, () => ({}))
    this.projectStore = new AtomicJsonStore(join(userDataDirectory, 'devin-projects.json'), z.array(agentProjectSchema).parse, () => [])
    this.reaper = new SessionReaper({
      ...(options.reaperSweepMs === undefined ? {} : { sweepEveryMs: options.reaperSweepMs }),
      ...(options.sessionIdleMs === undefined ? {} : { idleAfterMs: options.sessionIdleMs }),
      isWatched: id => this.observed.has(id),
      isBusy: id => this.dispatching.has(id) || this.active.has(id) || this.loading.has(id) || this.reading.has(id) || this.thread(id).requests.length > 0,
      stop: id => this.stopSession(id),
    })
  }
  private persist(): Promise<void> {
    this.writing = this.aliasStore.write(structuredClone(this.aliases))
    return this.writing
  }
  private thread(id: string): AgentThread {
    const alias = this.aliases[id]
    if (!alias) throw new Error('The Devin thread does not exist.')
    let thread = this.threads.get(id)
    if (!thread) {
      thread = { id, projectId: alias.projectId, title: alias.title, workingDirectory: alias.cwd,
        modelId: alias.modelId, providerMode: modeOf(alias.providerMode).id, runtimeMode: RUNTIME_OF_ALLOWANCE[modeOf(alias.providerMode).allows],
        status: alias.devinSessionId && alias.settingsConfirmed ? 'idle' : 'error', messages: [], requests: [] }
      this.threads.set(id, thread)
    }
    return thread
  }
  /** The public snapshot: a copy of everything, held threads' messages included. A caller that keeps history
   * from this adapter's events is handed every thread with its summary and no messages, as an activity
   * subscriber that asks for it is (#368). */
  private current(historyFromEvents = false): AgentHostSnapshot {
    if (historyFromEvents) return cloneActivitySnapshot(this.activitySnapshot(true))
    return cloneHostSnapshot({ ...this.state, threads: [...this.threads.values()].map(thread => this.log.publishedThread(thread)) })
  }
  /** What activity subscribers are handed. One that keeps history from this adapter's events gets each
   * thread's summary and no messages: those already left as events (#322). */
  private activitySnapshot(historyFromEvents: boolean): AgentHostSnapshot {
    for (const thread of this.threads.values()) if (thread.activities && !isImmutableActivities(thread.activities)) {
      thread.activities = immutableActivities(thread.activities)
    }
    return { ...this.state, threads: [...this.threads.values()].map(thread => this.log.activityThread(thread, historyFromEvents)) }
  }
  private emit(streaming = false): void { this.publisher.publish(streaming) }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener)
  }
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
    return this.activityListeners.add(listener, options)
  }
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void { return this.log.subscribeEvents(listener) }
  useThreadHistory(source: ThreadHistorySource): void { this.history = source }

  private async start(cwd: string, allows: DevinAllowance, id?: string, observer = false): Promise<Connection> {
    const generation = this.generation
    const checking = Date.now()
    const profile = await prepareDevinPolicy(this.userDataDirectory, allows, cwd, this.options.nativeConfigDirectory)
    // Before the process exists: an integration it would load is refused before it can start.
    await assertDevinNoIntegrations(this.executable, [...(this.options.args ?? []), '--config', profile.path], devinEnvironment(this.options.environment), cwd)
    if (generation !== this.generation) throw new DevinUncertain('Devin connection changed.')
    const connection: Connection = {
      rpc: undefined as unknown as DevinRpc, nonce: randomUUID(), profile, fresh: false, tools: new Map(), toolBytes: 0,
      transcript: { messages: [], bytes: 0 }, replaying: observer, mode: undefined, intentionalClose: false, checkedAt: 0,
    }
    const rpc: DevinRpc = new DevinRpc(this.executable, [...(this.options.args ?? []), '--config', profile.path, 'acp'], cwd,
      devinEnvironment(this.options.environment), this.options.requestTimeoutMs ?? 15_000,
      frame => id ? this.frame(id, connection, frame, observer) : this.unsupported(rpc, frame),
      () => {
        if (connection.intentionalClose || observer || !id || this.connections.get(id) !== connection) return
        this.connections.delete(id); this.finishUnsettledTurn(id, 'failed'); this.clearRequests(id)
        this.thread(id).status = 'error'
        this.state.error = 'Devin stopped. Your saved thread is kept. Reconnect to check delivery before sending again.'
        this.emit()
      })
    connection.rpc = rpc; this.allProcesses.add(rpc)
    void rpc.closed.then(() => this.allProcesses.delete(rpc))
    try {
      await rpc.request('initialize', {
        protocolVersion: DEVIN_ACP_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
        clientInfo: { name: 'sotto', version: appVersion },
      }, value => {
        const result = z.object({
          protocolVersion: z.literal(DEVIN_ACP_VERSION),
          agentCapabilities: z.object({ loadSession: z.literal(true) }),
          authMethods: z.array(z.object({ id: z.string() })),
        }).parse(value)
        if (!result.authMethods.some(method => method.id === 'devin-browser')) throw new Error('Native Devin sign-in is required.')
      })
      await rpc.request('_cognition.ai/config/read', {}, value => verifyDevinPolicy(value, profile))
      if (generation !== this.generation) throw new DevinUncertain('Devin connection changed.')
      connection.checkedAt = checking
      return connection
    } catch (error) { connection.intentionalClose = true; rpc.close(); await rpc.closed; throw error }
  }
  private async revalidate(connection: Connection, cwd: string, generation: number): Promise<void> {
    const current = (): void => {
      if (generation !== this.generation || connection.intentionalClose) throw new DevinUncertain('Devin connection changed.')
    }
    try {
      current()
      const checking = Date.now()
      const profile = await prepareDevinPolicy(this.userDataDirectory, connection.profile.allows, cwd, this.options.nativeConfigDirectory)
      // The process is already running, so the integration lists and its own reading of the profile are
      // independent and run side by side. Both must pass; the lists are judged first so a refusal reads the same.
      const [integrations, config] = await Promise.allSettled([
        assertDevinNoIntegrations(this.executable, [...(this.options.args ?? []), '--config', profile.path], devinEnvironment(this.options.environment), cwd),
        connection.rpc.request('_cognition.ai/config/read', {}, value => { current(); verifyDevinPolicy(value, profile) }),
      ])
      if (integrations.status === 'rejected') throw integrations.reason
      if (config.status === 'rejected') throw config.reason
      current()
      connection.checkedAt = checking
    } catch (error) {
      connection.rpc.close(); await connection.rpc.closed
      throw error
    }
  }
  private finishUnsettledTurn(id: string, status: 'failed' | 'interrupted'): void {
    const turn = this.active.get(id)
    if (!turn) return
    this.publishActive(id); this.active.delete(id); settle(turn)
    const thread = this.thread(id)
    thread.status = status === 'failed' ? 'error' : 'idle'
    thread.lastTurn = { id: turn.origin.messageId, status }
    // A thought the turn ended on was cut off, which is known; the work it left running has an outcome nobody saw.
    const thoughts = settledThinking(DEVIN_THINKING_ID_PREFIX, thread.activities ?? [], thinkingSettledAs(status), true)
    const settled = thoughts.length ? mergeAgentActivities(thread.activities, thoughts) : thread.activities
    thread.activities = markTurnActivity(settled?.map(activity => activity.status === 'running' && activity.kind !== 'turn'
      ? { ...activity, status: status === 'failed' ? 'unknown' : 'interrupted' } : activity), { provider: 'devin', turnId: turn.origin.messageId, status })
  }
  private unsupported(rpc: DevinRpc, frame: DevinFrame): void {
    if (frame.method && frame.id !== undefined) rpc.write({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Unsupported client method' } })
  }
  /** The catalog session needs a working folder, and Sotto's own data folder
   * holds every thread worktree. This one stays empty, so the compatibility
   * checks pass on their own terms and connecting costs the same however many
   * threads exist. They still run against it; it is not exempt. */
  private get catalogDirectory(): string { return join(this.userDataDirectory, 'devin', 'catalog') }
  async connect(): Promise<AgentHostSnapshot> {
    try { return await this.establish() } catch (error) {
      // An uncertain connection has no verdict to report, and a superseded one
      // belongs to the connect that replaced it. Both stay throws.
      if (error instanceof DevinUncertain) throw error
      // A refusal Devin states is reported in the snapshot instead, so a failed
      // reconnect keeps the threads and models Sotto already has.
      this.state.connected = false
      this.state.error = error instanceof Error && error.message
        ? error.message
        : 'Devin did not confirm the connection. Your threads and drafts are kept.'
      // What a host's provider tile says and offers (ADR-0037); a refusal without a name reads as not startable.
      delete this.state.requiredVersion
      if (error instanceof ProviderUnavailable) {
        this.state.problem = error.problem
        if (error.version) this.state.version = error.version
        if (error.requiredVersion) this.state.requiredVersion = error.requiredVersion
      } else delete this.state.problem
      this.emit(); return this.current()
    }
  }
  private async establish(): Promise<AgentHostSnapshot> {
    this.disconnect(); const generation = this.generation
    await this.closed()
    if (generation !== this.generation) throw new DevinUncertain('Devin connection changed.')
    // The cause carries the errno; the message the user reads never does.
    try { await mkdir(this.catalogDirectory, { recursive: true }) } catch (error) {
      throw new Error('Sotto could not prepare its own Devin folder. Your threads and drafts are kept. Check access to Sotto’s data folder and connect again.', { cause: error })
    }
    this.executable = this.options.executable ?? await findDevinExecutable(this.options.environment) ?? ''
    if (!isAbsolute(this.executable)) throw new ProviderUnavailable('not-installed', 'Install Devin CLI and run devin auth login, then connect again. Your threads and drafts are kept.')
    const version = await readDevinVersion(this.executable, this.options.args ?? [], devinEnvironment(this.options.environment))
    if (compareClientVersions(version, DEVIN_CLI_VERSION) < 0) throw new ProviderUnavailable('too-old', 'This Devin version is older than the one Sotto checked. Your threads are kept. Use Devin CLI ' + DEVIN_CLI_VERSION + ' or newer before connecting.', version, DEVIN_CLI_VERSION)
    const [aliases, projects] = await Promise.all([this.aliasStore.read(), this.projectStore.read()])
    if (generation !== this.generation) throw new DevinUncertain('Devin connection changed.')
    const catalog = await this.start(this.catalogDirectory, 'nothing')
    try {
      if (generation !== this.generation) throw new DevinUncertain('Devin connection changed.')
      let disposableSession: string | undefined
      await catalog.rpc.request('session/new', { cwd: this.catalogDirectory, mcpServers: [] }, value => {
        if (generation !== this.generation) throw new DevinUncertain('Devin connection changed.')
        disposableSession = z.object({ sessionId: z.string().min(1) }).parse(value).sessionId
        const model = modelConfig(value)
        const providerModes = offeredModes(sessionModeConfig(value).reported)
        this.state.models = model.models.map(option => ({
          id: option.value, name: option.name, provider: 'Devin', ready: true, providerModes,
          supportsImages: false, reasoningEfforts: [],
        }))
      })
      await this.revalidate(catalog, this.catalogDirectory, generation)
      // This empty session belongs only to discovery; no inference runs at connect.
      if (disposableSession) await catalog.rpc.request('session/delete', { sessionId: disposableSession })
      // Devin lists no models to an account it has no sign-in for.
      if (!this.state.models.length) throw new ProviderUnavailable('signed-out', 'Devin returned no available models. Run devin auth login and check your account access, then reconnect. Your threads and drafts are kept.', version)
    } finally { catalog.intentionalClose = true; catalog.rpc.close(); await catalog.rpc.closed }
    if (generation !== this.generation) throw new DevinUncertain('Devin connection changed.')
    // Replace what this process holds only once discovery has succeeded. A
    // refusal earlier leaves the threads and their messages as they were,
    // rather than publishing empty ones over a history Sotto already had.
    this.aliases = aliases; this.state.projects = projects
    this.threads.clear(); this.log.forgetAll()
    for (const id of Object.keys(this.aliases)) {
      this.thread(id); this.log.seed(id, this.history?.messageIdentities(id) ?? [])
    }
    this.state.connected = true; this.state.version = version + ' / ACP 1'; delete this.state.error; delete this.state.problem; delete this.state.requiredVersion
    if (compareClientVersions(version, DEVIN_CLI_VERSION) > 0) this.state.verifiedVersion = DEVIN_CLI_VERSION
    else delete this.state.verifiedVersion
    // A thread that cannot be opened is that thread's error, not the provider's: the rest stay usable.
    for (const id of this.observed) if (this.aliases[id]?.devinSessionId) {
      try { await this.open(id) } catch (error) {
        if (generation !== this.generation) throw new DevinUncertain('Devin connection changed.')
        if (error instanceof DevinUncertain) throw error
        this.thread(id).status = 'error'
        this.state.error = openFailure(error)
      }
    }
    if (generation !== this.generation) throw new DevinUncertain('Devin connection changed.')
    this.reaper.start()
    this.pollTimer = setInterval(() => { void this.poll().catch(() => {
      this.state.error = 'Devin history could not be checked. Your thread is kept. Reconnect before sending a follow-up.'; this.emit()
    }) }, this.options.pollIntervalMs ?? 1500)
    this.pollTimer.unref(); this.emit(); return this.current()
  }
  /** Sets the session's conversation mode and refuses the thread unless Devin echoes it back. */
  private async applyMode(connection: Connection, alias: Alias, mode: DevinMode, current: () => void): Promise<void> {
    await connection.rpc.request('session/set_config_option', {
      sessionId: alias.devinSessionId, configId: 'mode', value: mode.devinMode,
    }, value => {
      current()
      if (sessionModeConfig(value).current !== mode.devinMode) throw new Error('Devin did not confirm the selected permission setting.')
      connection.mode = mode.devinMode
    })
  }
  private open(id: string): Promise<Connection> {
    const stopping = this.stopping.get(id)
    if (stopping) return stopping.then(() => this.open(id))
    // A connection still loading has not had its mode set, so a caller waits for the load rather than using it.
    const current = this.loading.get(id)
    if (current) return current
    const existing = this.connections.get(id)
    if (existing) return Promise.resolve(existing)
    const loading = this.load(id).finally(() => { if (this.loading.get(id) === loading) this.loading.delete(id) })
    this.loading.set(id, loading); return loading
  }
  private async load(id: string): Promise<Connection> {
    const generation = this.generation
    const alias = this.aliases[id]!
    if (!alias?.devinSessionId) throw new Error('Devin did not confirm this thread’s creation. Your thread is kept; do not repeat the creation automatically.')
    const mode = modeOf(alias.providerMode)
    // A history read loads the session in a process of its own, and Devin lets one process hold a session at a
    // time. Opening alongside a read in flight would find the session taken by Sotto itself, so the open waits.
    await this.reading.get(id)?.catch(() => undefined)
    if (generation !== this.generation) throw new DevinUncertain('Devin connection changed.')
    const connection = await this.start(await existingWorkingDirectory(alias.cwd), mode.allows, id, false)
    if (generation !== this.generation) { connection.intentionalClose = true; connection.rpc.close(); throw new DevinUncertain('Devin connection changed.') }
    connection.replaying = true
    this.connections.set(id, connection)
    // Devin keeps a session only from its first prompt, so an empty one ends with the process that made it,
    // however that process ended. A thread Sotto never sent to has nothing to resend, so it gets a new empty
    // session under the same model and mode. A thread with a dispatch record, or any message at all, is never recreated.
    const neverSent = (): boolean => alias.ephemeral && alias.origins.length === 0 && !this.log.hasMessages(id)
    const renew = async (): Promise<void> => {
      // A known release skips the load that would fail; the reservation keeps a lost acknowledgement from
      // skipping it again, so the next open asks Devin before making another.
      alias.emptyReleased = false; alias.settingsConfirmed = false; await this.persist()
      if (generation !== this.generation || this.connections.get(id) !== connection) throw new DevinUncertain('Devin connection changed.')
      await connection.rpc.request('session/new', { cwd: alias.cwd, mcpServers: [] }, async value => {
        if (generation !== this.generation || this.connections.get(id) !== connection) throw new DevinUncertain('Devin connection changed.')
        alias.devinSessionId = z.object({ sessionId: z.string().min(1) }).parse(value).sessionId
        alias.emptyReleased = false; connection.fresh = true; await this.persist()
      })
      await connection.rpc.request('session/set_config_option', { sessionId: alias.devinSessionId, configId: 'model', value: alias.modelId }, value => {
        if (generation !== this.generation || this.connections.get(id) !== connection) throw new DevinUncertain('Devin connection changed.')
        if (modelConfig(value).current !== alias.modelId) throw new Error('Devin did not confirm the model for this thread. Your thread and draft are kept. Reconnect Devin, or start a new thread.')
      })
    }
    try {
      if (neverSent() && alias.emptyReleased) await renew()
      else {
        let loadedModel: string | undefined
        try {
          await connection.rpc.request('session/load', { sessionId: alias.devinSessionId, cwd: alias.cwd, mcpServers: [] }, value => {
            if (generation !== this.generation || this.connections.get(id) !== connection) throw new DevinUncertain('Devin connection changed.')
            loadedModel = modelConfig(value).current
          })
        } catch (error) {
          if (!(error instanceof DevinRejected && error.code === -32016 && neverSent())) throw error
          await renew(); loadedModel = alias.modelId
        }
        if (loadedModel !== alias.modelId) throw new Error('Devin changed the saved model. Your thread and draft are kept. Restore the original model in Devin and reconnect, or start a new thread. Sotto will not substitute it.')
      }
      // A session opens on Devin's own default mode, whether it was loaded or made again, so the mode this
      // thread records is set back on it before anything runs under it.
      await this.applyMode(connection, alias, mode, () => {
        if (generation !== this.generation || this.connections.get(id) !== connection) throw new DevinUncertain('Devin connection changed.')
      })
      // The profile was chosen when this open began. A mode changed since would leave Devin running under
      // an allowance the thread no longer records, so the open is abandoned and the next action starts again.
      if (modeOf(alias.providerMode).id !== mode.id) throw new DevinUncertain('Devin connection changed.')
      if (generation !== this.generation || this.connections.get(id) !== connection) throw new DevinUncertain('Devin connection changed.')
      await this.revalidate(connection, alias.cwd, generation)
      if (this.connections.get(id) !== connection) throw new DevinUncertain('Devin connection changed.')
      alias.settingsConfirmed = true
      await this.mergeReplay(id, connection.transcript)
      if (generation !== this.generation || this.connections.get(id) !== connection) throw new DevinUncertain('Devin connection changed.')
      connection.transcript = { messages: [], bytes: 0 }
      // Loading replayed the whole session, so the thread has just been read; the next poll need not repeat it.
      connection.replaying = false; this.log.pin(id); this.reaper.touch(id); this.lastReadAt.set(id, Date.now())
      this.thread(id).status = 'idle'; await this.persist()
      if (generation !== this.generation || this.connections.get(id) !== connection) throw new DevinUncertain('Devin connection changed.')
      this.emit(); return connection
    } catch (error) {
      if (this.connections.get(id) === connection) this.connections.delete(id); connection.intentionalClose = true; connection.rpc.close(); await connection.rpc.closed
      if (generation !== this.generation) throw new DevinUncertain('Devin connection changed.')
      this.thread(id).status = 'error'
      if (error instanceof DevinRejected && error.code === -32015) throw new Error('This Devin session is open in another client. Finish there and reconnect. Your thread and draft are kept.', { cause: error })
      if (error instanceof DevinRejected && error.code === -32016) throw new Error('Devin could not find this saved session. Your Sotto history and draft are kept. Restore the session in Devin or start a new thread; Sotto will not resend earlier work.', { cause: error })
      throw error
    }
  }
  observeThreads(ids: readonly string[]): void {
    this.observed.clear(); for (const id of ids) this.observed.add(id)
    this.log.observe(ids)
    if (!this.state.connected) return
    const generation = this.generation
    for (const id of ids) if (this.aliases[id]?.devinSessionId) void this.open(id).catch((error: unknown) => {
      if (generation !== this.generation) return
      this.thread(id).status = 'error'; this.state.error = openFailure(error); this.emit()
    })
  }
  async snapshot(): Promise<AgentHostSnapshot> { if (this.state.connected) await this.poll(); return this.current() }
  private poll(): Promise<void> {
    if (this.polling) return this.polling
    const now = Date.now()
    const ids = [...this.connections.keys()].filter(id => {
      // A session still opening is read once its open settles, not on this tick.
      if (this.loading.has(id)) return false
      const active = this.active.get(id)
      const busy = active !== undefined || this.thread(id).requests.length > 0
      // Every thread polled here has a live owner, and the owner's stream carries its turn once Devin has shown
      // it took the prompt. Until then only a replay can confirm it, so that is the one wait read at the busy pace.
      const awaiting = active !== undefined && !active.streamed && !active.origin.confirmed
      const interval = this.options.pollIntervalMs ?? (awaiting ? 1_500 : 15_000)
      return (this.observed.has(id) || busy) && now - (this.lastReadAt.get(id) ?? 0) >= interval
    })
    const polling = Promise.all(ids.map(id => this.readHistory(id))).then(() => undefined)
      .finally(() => { if (this.polling === polling) this.polling = undefined })
    this.polling = polling
    return polling
  }
  async refreshThread(id: string, purpose?: ThreadReadPurpose): Promise<AgentHostSnapshot> {
    await this.open(id)
    // While this thread's own connection holds its session, Devin refuses the session to every other client
    // (-32015), so the replay the owner loaded and its stream since are the whole history and nothing can have
    // changed it unseen. A replay then adds only the confirmation of a dispatch not yet confirmed by one, which a
    // reconciliation read still gets; the read before a send needs none, so it never starts an observer (ADR-0017).
    const unconfirmed = this.aliases[id]?.origins.some(origin => !origin.confirmed) === true
    if (!this.connections.has(id) || unconfirmed && !purpose?.beforeSend) await this.readHistory(id)
    return this.current(purpose?.historyFromEvents)
  }
  private readHistory(id: string): Promise<void> {
    const previous = this.reading.get(id)
    if (previous) return previous
    // A read loads the session in a process of its own and would take it from an open in progress, so it
    // starts once the open settles. The open waits only for a read already running, so neither waits on the other.
    const opening = this.loading.get(id)
    if (opening) return opening.then(() => this.readHistory(id), () => this.readHistory(id))
    this.lastReadAt.set(id, Date.now())
    const reading = this.read(id).finally(() => { if (this.reading.get(id) === reading) this.reading.delete(id) })
    this.reading.set(id, reading); return reading
  }
  private async read(id: string): Promise<void> {
    const alias = this.aliases[id]!
    if (!alias.devinSessionId || !this.state.connected) return
    // Native empty sessions have no transcript until the first prompt; only their live owner knows them.
    if (this.connections.get(id)?.fresh && alias.origins.length === 0) return
    const generation = this.generation
    const observer = await this.start(alias.cwd, modeOf(alias.providerMode).allows, id, true)
    try {
      try {
        await observer.rpc.request('session/load', { sessionId: alias.devinSessionId, cwd: alias.cwd, mcpServers: [] }, value => {
          if (modelConfig(value).current !== alias.modelId) throw new Error('Devin changed this thread’s model.')
        })
      } catch (error) {
        // The native process replays history before reporting that the session is locked.
        // Only our still-live owner can explain that lock for a send or guarded follow-up.
        const owned = this.connections.get(id)
        const awaitingFirstAcceptance = owned?.fresh && this.active.has(id) && alias.origins.length === 1 && !alias.origins[0]!.confirmed
        if (error instanceof DevinRejected && error.code === -32016 && awaitingFirstAcceptance) return
        if (!(error instanceof DevinRejected && error.code === -32015 && owned)) throw error
      }
      await this.revalidate(observer, alias.cwd, generation)
      if (generation !== this.generation) return
      await this.mergeReplay(id, observer.transcript)
    } finally { observer.intentionalClose = true; observer.rpc.close(); await observer.rpc.closed }
  }
  private consume(id: string, transcript: Transcript, update: Record<string, unknown>): void {
    const content = record(update.content)
    if (content?.type !== 'text' || typeof content.text !== 'string') return
    transcript.bytes += Buffer.byteLength(content.text)
    if (transcript.bytes > MAX_TRANSCRIPT_BYTES || transcript.messages.length >= 20_000) throw new Error('Devin history exceeds the supported read limit. Your saved history is kept.')
    const alias = this.aliases[id]!
    if (update.sessionUpdate === 'user_message_chunk') {
      const meta = record(update._meta)
      const nativeId = z.string().uuid().parse(meta?.['cognition.ai/clientMessageId'])
      const origin = alias.origins.find(item => item.nativeMessageId === nativeId)
      const messageId = origin?.messageId ?? 'devin-user-' + nativeId
      let message = transcript.messages.find(message => message.id === messageId)
      if (!message) {
        message = { id: messageId, role: 'user', text: '', createdAt: origin?.createdAt ?? (typeof meta?.['cognition.ai/timestamp'] === 'string' ? meta['cognition.ai/timestamp'] : alias.createdAt),
          ...(origin ? { commandId: origin.commandId } : {}) }
        transcript.messages.push(message)
      }
      message.text += content.text; transcript.user = message; transcript.nativeUser = nativeId; delete transcript.assistant
    } else if (update.sessionUpdate === 'agent_message_chunk' && transcript.user && transcript.nativeUser) {
      if (!transcript.assistant) {
        transcript.assistant = { id: 'devin-assistant-' + transcript.nativeUser, role: 'assistant', text: '', createdAt: transcript.user.createdAt }
        transcript.messages.push(transcript.assistant)
      }
      transcript.assistant.text += content.text
    }
  }
  private async mergeReplay(id: string, transcript: Transcript): Promise<void> {
    const alias = this.aliases[id]!
    let changed = false
    for (const message of transcript.messages) {
      if (message.role === 'user') {
        const origin = alias.origins.find(origin => origin.messageId === message.id)
        if (origin) {
          if (digest(message.text) !== origin.digest) throw new Error('Devin replay did not match the saved dispatch. Delivery remains uncertain.')
          if (!origin.confirmed) { origin.confirmed = true; changed = true }
        }
      }
      // A replay can lag behind the live stream; it must not replace a longer observed reply.
      const previous = this.log.message(id, message.id)
      if (message.role === 'assistant' && previous?.text.startsWith(message.text)) continue
      this.log.add(id, message)
    }
    if (changed) await this.persist()
    this.publishActive(id); this.emit()
  }
  /** The owner's stream showed Devin working on this turn's prompt: show it, and wake the send waiting on it. */
  private taken(id: string, turn: ActiveTurn): void { turn.streamed = true; this.publishActive(id); turn.wake?.() }
  private publishActive(id: string): void {
    const active = this.active.get(id)
    // Shown once Devin has taken the prompt, by its replay or by its own stream, so a reply appears as it streams.
    if (!active || !active.origin.confirmed && !active.streamed) return
    this.log.add(id, { id: active.origin.messageId, role: 'user', text: active.text,
      commandId: active.origin.commandId, createdAt: active.origin.createdAt })
    const existing = this.log.message(id, 'devin-assistant-' + active.origin.nativeMessageId)
    if (active.assistant && !existing?.text.startsWith(active.assistant)) this.log.add(id, { id: 'devin-assistant-' + active.origin.nativeMessageId,
      role: 'assistant', text: active.assistant, createdAt: active.origin.createdAt })
  }
  private async frame(id: string, connection: Connection, frame: DevinFrame, observer: boolean): Promise<void> {
    const alias = this.aliases[id]
    if (!alias || connection.intentionalClose) return
    const params = record(frame.params)
    if (frame.method === 'session/update') {
      if (!params || params.sessionId !== alias.devinSessionId) return
      const update = record(params.update)
      if (!update) throw new Error('Invalid Devin update.')
      if (!connection.replaying && alias.settingsConfirmed && update.sessionUpdate === 'config_option_update' && modelConfig(update).current !== alias.modelId) throw new Error('Devin changed the selected model.')
      // Devin announces every mode it is set to, the thread's own included. Until it confirms the mode Sotto set
      // on this process, what it announces is where the session opened or was left, not a change of its own;
      // a history read never sets one and never acts.
      if (update.sessionUpdate === 'current_mode_update' && connection.mode !== undefined && update.currentModeId !== connection.mode) throw new Error('Devin changed the session mode.')
      if (connection.replaying) { this.consume(id, connection.transcript, update); return }
      if (typeof update.toolCallId === 'string') {
        if (connection.tools.size >= 1000 && !connection.tools.has(update.toolCallId)) throw new Error('Too many pending Devin tools.')
        const old = connection.tools.get(update.toolCallId)
        const tool = { ...old, ...update }
        connection.toolBytes += Buffer.byteLength(JSON.stringify(tool)) - (old ? Buffer.byteLength(JSON.stringify(old)) : 0)
        if (connection.toolBytes > MAX_TOOL_BYTES) throw new Error('Devin tool details exceed the supported limit.')
        connection.tools.set(update.toolCallId, tool)
      }
      const active = this.active.get(id)
      if (active && !active.streamed && typeof update.sessionUpdate === 'string' && TURN_WORK.has(update.sessionUpdate)
        && this.connections.get(id) === connection) this.taken(id, active)
      if (update.sessionUpdate === 'agent_message_chunk' && active) {
        const content = record(update.content)
        if (content?.type === 'text' && typeof content.text === 'string') {
          if (Buffer.byteLength(active.assistant) + Buffer.byteLength(content.text) > MAX_TRANSCRIPT_BYTES) throw new Error('Devin reply exceeds the supported limit.')
          active.assistant += content.text; this.publishActive(id)
        }
      } else if (update.sessionUpdate === 'user_message_chunk') {
        this.consume(id, connection.transcript, update)
        await this.mergeReplay(id, connection.transcript)
      }
      if (active) {
        const thread = this.thread(id)
        thread.activities = mergeAgentActivities(thread.activities ?? [], devinActivities(update, {
          turnId: active.origin.messageId, afterMessageId: active.origin.messageId, cwd: alias.cwd,
        }, thread.activities, true))
      }
      this.emit(true); return
    }
    if (frame.method && frame.id !== undefined) {
      if (observer || !params || params.sessionId !== alias.devinSessionId) { this.unsupported(connection.rpc, frame); return }
      try {
        const toolId = record(params.toolCall)?.toolCallId
        const decision = devinPending(frame.id, frame.method, params, id, typeof toolId === 'string' ? connection.tools.get(toolId) : undefined)
        if (!decision) { this.unsupported(connection.rpc, frame); return }
        decision.request.id = 'devin-request-' + digest(JSON.stringify([id, connection.nonce, frame.id]))
        const fingerprint = digest(JSON.stringify([frame.method, params, typeof toolId === 'string' ? connection.tools.get(toolId)?.rawInput : null]))
        const prior = this.pending.get(decision.request.id)
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new Error('Devin changed a pending request.')
          return
        }
        if (this.pending.size >= 128) throw new Error('Too many pending Devin requests.')
        if (alias.answeredRequestIds.includes(decision.request.id)) {
          await connection.rpc.reply(frame.id, devinDecline(decision)); return
        }
        this.pending.set(decision.request.id, { decision, connection, fingerprint }); this.thread(id).requests.push(decision.request)
        // A question or a permission on the owner's session is the prompt being worked on, as streamed work is.
        const active = this.active.get(id)
        if (active && !active.streamed && this.connections.get(id) === connection) this.taken(id, active)
        this.reaper.touch(id); this.emit()
      } catch {
        connection.rpc.write({ jsonrpc: '2.0', id: frame.id, error: { code: -32602, message: 'Unsupported request' } })
        this.state.error = 'Devin requested an action Sotto cannot safely present. Stop the turn and review it in Devin.'
        connection.rpc.close(); this.emit()
      }
    }
  }
  async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (command.type !== 'send' && command.type !== 'create-thread') return this.executeNative(command)
    if (this.dispatching.has(command.threadId)) throw new Error('Devin is already receiving work for this thread. Wait for its delivery result.')
    this.dispatching.add(command.threadId)
    try { return await this.executeNative(command) } finally { this.dispatching.delete(command.threadId) }
  }
  private async executeNative(command: AgentHostCommand): Promise<AgentHostResult> {
    const generation = this.generation; const began = Date.now()
    if (!this.state.connected) throw new Error('Connect Devin before managing threads.')
    let creation: Connection | undefined
    try {
      if (command.type === 'create-project') {
        const path = await existingWorkingDirectory(command.path)
        if (generation !== this.generation) throw new DevinUncertain('Devin connection changed.')
        if (!this.state.projects.some(project => project.id === command.projectId)) {
          this.state.projects.push({ id: command.projectId, title: command.title, path })
          await this.projectStore.write(this.state.projects)
        }
      } else if (command.type === 'create-thread') {
        const saved = this.aliases[command.threadId]
        if (saved) return saved.settingsConfirmed ? { accepted: true } : { accepted: false, uncertain: true }
        validateThreadOptions(this.state, command)
        const project = this.state.projects.find(project => project.id === command.projectId)
        if (!project) throw new Error('Choose a Devin project first.')
        const mode = modeOf(command.providerMode)
        const alias: Alias = { projectId: project.id, cwd: await existingWorkingDirectory(command.workingDirectory ?? project.path),
          title: command.title, modelId: command.modelId, providerMode: mode.id, createdAt: new Date().toISOString(),
          settingsConfirmed: false, ephemeral: true, emptyReleased: false, origins: [], answeredRequestIds: [] }
        if (generation !== this.generation) throw new DevinUncertain('Devin connection changed.')
        this.aliases[command.threadId] = alias; await this.persist()
        if (generation !== this.generation) throw new DevinUncertain('Devin connection changed.')
        const connection = await this.start(alias.cwd, mode.allows, command.threadId, false)
        if (generation !== this.generation) { connection.intentionalClose = true; connection.rpc.close(); throw new DevinUncertain('Devin connection changed.') }
        creation = connection; this.connections.set(command.threadId, connection)
        await connection.rpc.request('session/new', { cwd: alias.cwd, mcpServers: [] }, async value => {
          if (generation !== this.generation || this.connections.get(command.threadId) !== connection) throw new DevinUncertain('Devin connection changed.')
          alias.devinSessionId = z.object({ sessionId: z.string().min(1) }).parse(value).sessionId
          connection.fresh = true
          await this.persist()
        })
        await connection.rpc.request('session/set_config_option', {
          sessionId: alias.devinSessionId, configId: 'model', value: alias.modelId,
        }, async value => {
          if (generation !== this.generation || this.connections.get(command.threadId) !== connection) throw new DevinUncertain('Devin connection changed.')
          if (modelConfig(value).current !== alias.modelId) throw new Error('Devin did not confirm the selected model.')
        })
        // Devin opens a session in its own default mode, which is not the one the user chose.
        await this.applyMode(connection, alias, mode, () => {
          if (generation !== this.generation || this.connections.get(command.threadId) !== connection) throw new DevinUncertain('Devin connection changed.')
        })
        await this.revalidate(connection, alias.cwd, generation)
        if (this.connections.get(command.threadId) !== connection) throw new DevinUncertain('Devin connection changed.')
        alias.settingsConfirmed = true; await this.persist()
        if (generation !== this.generation || this.connections.get(command.threadId) !== connection) throw new DevinUncertain('Devin connection changed.')
        // A session made just now has no history to read, so the next poll need not start an observer for it.
        this.log.pin(command.threadId); this.reaper.touch(command.threadId); this.lastReadAt.set(command.threadId, Date.now())
        this.thread(command.threadId).status = 'idle'
      } else if (command.type === 'configure-thread') {
        if (command.modelId !== undefined || command.reasoningEffort !== undefined || command.runtimeMode !== undefined) {
          throw new Error('Devin can only change this thread\u2019s permissions. Start a new thread to choose a model.')
        }
        const alias = this.aliases[command.threadId]
        if (!alias?.devinSessionId) throw new Error('Devin did not confirm this session. Your thread is kept.')
        const mode = DEVIN_MODES.find(candidate => candidate.id === command.providerMode)
        if (!mode) throw new Error('Devin does not offer that permission setting.')
        // Already the recorded mode: the snapshot says so, and nothing is stopped or read.
        if (modeOf(alias.providerMode).id === mode.id) return { accepted: true, snapshot: this.current(command.historyFromEvents) }
        // A session being opened or sent to has already chosen its profile; changing the mode under it would
        // leave the two out of step, so the change waits until the thread is quiet.
        if (this.active.has(command.threadId) || this.loading.has(command.threadId) || this.dispatching.has(command.threadId)
          || this.thread(command.threadId).requests.length) {
          throw new Error('Devin is working on this thread. Your permission setting is unchanged. Change it once the thread is idle.')
        }
        // What a mode allows lives in the owned profile, and a profile is chosen when the process starts,
        // so the allowance is written and confirmed before the thread keeps it. Stopping the session leaves the
        // native session itself untouched; the next action resumes it under the new profile (ADR-0022).
        await prepareDevinPolicy(this.userDataDirectory, mode.allows, alias.cwd, this.options.nativeConfigDirectory)
        if (generation !== this.generation) throw new DevinUncertain('Devin connection changed.')
        const previous = alias.providerMode
        alias.providerMode = mode.id
        try { await this.persist() } catch (error) { alias.providerMode = previous; throw error }
        const projected = this.thread(command.threadId)
        projected.providerMode = mode.id; projected.runtimeMode = RUNTIME_OF_ALLOWANCE[mode.allows]
        await this.stopSession(command.threadId)
        this.emit()
        // The profile is confirmed and recorded, and the session resumes under it on the thread's next action
        // (ADR-0022). The snapshot says so; reading the thread now would start that session only to be read.
        if (generation === this.generation) return { accepted: true, snapshot: this.current(command.historyFromEvents) }
      } else if (command.type === 'steer' || command.type === 'compact-thread') {
        throw new Error('This Devin action is not supported. Start a new thread to choose a model, or queue a text follow-up.')
      } else {
        const id = command.threadId; const alias = this.aliases[id]
        if (!alias?.devinSessionId) throw new Error('Devin did not confirm this session. Your thread is kept. Do not repeat its creation automatically.')
        const connection = await this.open(id)
        if (generation !== this.generation || this.connections.get(id) !== connection) throw new DevinUncertain('Devin connection changed.')
        this.reaper.touch(id)
        if (!alias.settingsConfirmed) throw new Error('Devin has not confirmed this thread’s settings. Reconnect before sending.')
        if (command.type === 'send') return await this.send(command, connection, began)
        if (command.type === 'answer') {
          const saved = this.pending.get(command.requestId)
          if (!saved || saved.decision.threadId !== id || saved.connection !== connection) throw new Error('That Devin request is no longer pending.')
          const decision = saved.decision
          const checkScope = (): void => {
            if (decision.permission && JSON.stringify(connection.tools.get(decision.toolCallId!)?.rawInput) !== decision.actionDetails) {
              this.removeRequest(command.requestId); connection.rpc.close()
              throw new Error('Devin changed this action after asking. Nothing was approved. Reconnect and review the new request.')
            }
          }
          checkScope()
          if (decision.answering) return { accepted: false, uncertain: true }
          const answer = devinAnswer(decision, command.answer, command.approved, command.questionAnswers, command.permissionChoice)
          decision.answering = true; alias.answeredRequestIds.push(command.requestId)
          try { await this.persist() } catch (error) {
            alias.answeredRequestIds = alias.answeredRequestIds.filter(id => id !== command.requestId); decision.answering = false; throw error
          }
          if (this.pending.get(command.requestId) !== saved || this.connections.get(id) !== connection) return { accepted: false, uncertain: true }
          checkScope()
          try { await connection.rpc.reply(decision.wireId, answer); this.removeRequest(command.requestId) }
          catch { decision.request.delivery = 'uncertain'; this.emit(); return { accepted: false, uncertain: true } }
        } else if (command.type === 'interrupt') {
          for (const [requestId, saved] of this.pending) if (saved.decision.threadId === id && !saved.decision.answering) {
            await connection.rpc.reply(saved.decision.wireId, devinDecline(saved.decision)); this.removeRequest(requestId)
          }
          connection.rpc.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: alias.devinSessionId } })
        }
      }
      this.emit(); return { accepted: true }
    } catch (error) {
      if (creation) {
        if (command.type === 'create-thread' && this.connections.get(command.threadId) === creation) this.connections.delete(command.threadId)
        creation.intentionalClose = true; creation.rpc.close(); await creation.rpc.closed
        if (generation === this.generation && command.type === 'create-thread') this.thread(command.threadId).status = 'error'
      }
      if (error instanceof DevinUncertain) return { accepted: false, uncertain: true }
      throw error
    }
  }
  /** `began` is when this send was asked for: checks this connection passed since then are not run again. */
  private async send(command: Extract<AgentHostCommand, { type: 'send' }>, connection: Connection, began: number): Promise<AgentHostResult> {
    const generation = this.generation
    const id = command.threadId; const alias = this.aliases[id]!
    const checkConnection = (): void => {
      if (generation !== this.generation || this.connections.get(id) !== connection || !this.state.connected) throw new DevinUncertain('Devin connection changed. Delivery has not been confirmed.')
    }
    validatePromptAttachments(this.state, alias.modelId, command.attachments)
    if (command.skills?.length) throw new Error('Devin skill selection is not supported.')
    if (/^\s*\/[a-z][\w-]*(?:\s|$)/iu.test(command.text)) throw new Error('Devin slash commands are not supported here. Send a text prompt instead.')
    verifyFileMentions(command.text, command.files)
    const previous = alias.origins.find(origin => origin.commandId === command.commandId || origin.messageId === command.messageId)
    if (previous) {
      if (previous.digest !== digest(command.text) || previous.messageId !== command.messageId || previous.commandId !== command.commandId) throw new Error('This Devin dispatch identity is already in use.')
      await this.readHistory(id)
      return previous.confirmed ? { accepted: true } : { accepted: false, uncertain: true }
    }
    // The profile and native integrations are confirmed fresh before every prompt (ADR-0017): once, here, unless
    // opening the session for this same send has just done it. No history is read first. This connection holds the
    // session, Devin refuses it to every other client while it does (-32015), and the replay it loaded and its
    // stream since are the whole history, so the stale-input check below needs nothing more.
    if (connection.checkedAt < began) await this.revalidate(connection, alias.cwd, generation)
    checkConnection()
    if (command.expectedLastUserMessageId !== undefined && (this.log.lastUserMessageId(id) ?? null) !== command.expectedLastUserMessageId) throw new Error('The Devin thread changed before this follow-up. Review the newest input first.')
    if (this.active.has(id) || this.thread(id).requests.length) throw new Error('Devin is still working. Queue this follow-up.')
    const origin: Origin = { nativeMessageId: randomUUID(), messageId: command.messageId, commandId: command.commandId,
      digest: digest(command.text), createdAt: new Date().toISOString(), confirmed: false }
    alias.origins.push(origin); alias.ephemeral = false; await this.persist()
    checkConnection()
    const turn: ActiveTurn = { origin, text: command.text, assistant: '', streamed: false, ended: false, wake: undefined }
    this.active.set(id, turn)
    this.thread(id).status = 'running'
    this.thread(id).lastTurn = { id: origin.messageId, status: 'running' }
    this.thread(id).activities = markTurnActivity(this.thread(id).activities, { provider: 'devin', turnId: origin.messageId, status: 'running' })
    this.emit()
    markSendStage(command.commandId, 'written')
    void connection.rpc.request('session/prompt', {
      sessionId: alias.devinSessionId, prompt: [{ type: 'text', text: command.text }],
      _meta: { 'cognition.ai/clientMessageId': origin.nativeMessageId },
    }, async value => {
      if (generation !== this.generation || this.connections.get(id) !== connection || this.active.get(id)?.origin !== origin) { settle(turn); return }
      const stopReason = z.object({ stopReason: z.string() }).parse(value).stopReason
      // A completion alone is not taken as acceptance: one with no work streamed is checked against the replay.
      this.publishActive(id); this.active.delete(id); settle(turn); this.clearRequests(id); connection.tools.clear(); connection.toolBytes = 0
      const status = stopReason === 'end_turn' ? 'completed' : stopReason === 'cancelled' ? 'interrupted' : 'failed'
      this.thread(id).status = status === 'failed' ? 'error' : 'idle'
      this.thread(id).lastTurn = { id: origin.messageId, status }
      // A thought the turn ended on gets no later update to settle it.
      const thoughts = settledThinking(DEVIN_THINKING_ID_PREFIX, this.thread(id).activities ?? [], thinkingSettledAs(status), true)
      this.thread(id).activities = markTurnActivity(thoughts.length ? mergeAgentActivities(this.thread(id).activities, thoughts) : this.thread(id).activities, { provider: 'devin', turnId: origin.messageId, status })
      this.reaper.touch(id); this.emit()
      // A turn taken on the stream's evidence alone has its replay read once it ends, unless a read has confirmed it
      // already, so a dispatch the replay contradicts still says so, and the next send's reads find nothing to confirm.
      if (!origin.confirmed) void this.readHistory(id).catch(() => {
        if (generation !== this.generation) return
        this.state.error = 'Devin history could not be checked. Your thread is kept. Reconnect before sending a follow-up.'; this.emit()
      })
    }, true).catch(() => {
      if (generation !== this.generation || this.connections.get(id) !== connection || this.active.get(id)?.origin !== origin) { settle(turn); return }
      this.finishUnsettledTurn(id, 'failed'); this.clearRequests(id); this.thread(id).status = 'error'; this.emit()
    })
    return this.acceptance(id, command.commandId, turn, generation)
  }
  /**
   * Whether Devin took a prompt. Native ACP sends no acknowledgement and no echo of it, so there are two kinds of
   * evidence. The first is the owner's own stream: Devin streams a turn's work only while a prompt runs, and only
   * this connection can prompt the session it holds, so work streamed after this prompt went out is this prompt
   * being worked on. The second is the replay of the dispatch identity saved before sending, which an observer
   * reads only once the stream has shown nothing for the grace period, or the turn ended without showing any work.
   * Neither ever sends the prompt again; a prompt with no evidence by the request deadline stays uncertain.
   */
  private async acceptance(id: string, commandId: string, turn: ActiveTurn, generation: number): Promise<AgentHostResult> {
    const deadline = Date.now() + (this.options.requestTimeoutMs ?? 15_000)
    const cadence = this.options.pollIntervalMs ?? 1_500
    let nextRead = Date.now() + (this.options.acceptanceGraceMs ?? ACCEPTANCE_GRACE_MS)
    let readAfterEnd = false
    while (true) {
      if (turn.streamed || turn.origin.confirmed) { markSendStage(commandId, 'acknowledged'); return { accepted: true } }
      if (generation !== this.generation) return { accepted: false, uncertain: true }
      if (turn.ended && !readAfterEnd) { readAfterEnd = true; nextRead = Date.now() }
      const now = Date.now()
      if (now >= deadline) return { accepted: false, uncertain: true }
      if (now >= nextRead) {
        try { await this.readHistory(id) } catch { return { accepted: false, uncertain: true } }
        nextRead = Date.now() + cadence
        continue
      }
      await new Promise<void>(resolve => {
        const done = (): void => { clearTimeout(timer); if (turn.wake === done) turn.wake = undefined; resolve() }
        const timer = setTimeout(done, Math.min(nextRead, deadline) - now); timer.unref()
        turn.wake = done
      })
    }
  }
  private removeRequest(id: string): void {
    const saved = this.pending.get(id); if (!saved) return
    this.pending.delete(id); this.thread(saved.decision.threadId).requests = this.thread(saved.decision.threadId).requests.filter(request => request.id !== id); this.emit()
  }
  private clearRequests(id: string): void {
    for (const [requestId, saved] of this.pending) if (saved.decision.threadId === id) this.pending.delete(requestId)
    const thread = this.threads.get(id); if (thread) thread.requests = []
  }
  private stopSession(id: string): Promise<void> {
    const previous = this.stopping.get(id)
    if (previous) return previous
    const stopping = this.stop(id).finally(() => { if (this.stopping.get(id) === stopping) this.stopping.delete(id) })
    this.stopping.set(id, stopping); return stopping
  }
  private async stop(id: string): Promise<void> {
    const generation = this.generation
    const alias = this.aliases[id]
    const connection = this.connections.get(id); if (!connection) return
    this.connections.delete(id); connection.intentionalClose = true; connection.rpc.close(); await connection.rpc.closed
    if (generation !== this.generation || this.aliases[id] !== alias) return
    if (alias?.ephemeral && alias.origins.length === 0 && alias.settingsConfirmed) { alias.emptyReleased = true; await this.persist() }
    this.log.release(id); this.reaper.forget(id)
  }
  disconnect(): void {
    this.generation++; clearInterval(this.pollTimer); this.pollTimer = undefined; this.reaper.dispose()
    for (const saved of this.pending.values()) if (!saved.decision.answering) {
      try { saved.connection.rpc.write({ jsonrpc: '2.0', id: saved.decision.wireId, result: devinDecline(saved.decision) }) } catch { /* A closed pipe grants nothing. */ }
    }
    const empty = [...this.connections.keys()].filter(id => this.aliases[id]?.ephemeral && this.aliases[id]!.origins.length === 0 && this.aliases[id]!.settingsConfirmed && !this.dispatching.has(id)).map(id => [id, this.aliases[id]!] as const)
    for (const id of this.active.keys()) this.finishUnsettledTurn(id, 'interrupted')
    this.pending.clear(); this.active.clear()
    this.loading.clear(); this.reading.clear(); this.lastReadAt.clear(); this.polling = undefined
    for (const thread of this.threads.values()) thread.requests = []
    for (const connection of this.connections.values()) connection.intentionalClose = true
    this.connections.clear()
    const closing = [...this.allProcesses]
    for (const rpc of closing) rpc.close()
    this.shutdown = Promise.all([this.shutdown, ...closing.map(rpc => rpc.closed)]).then(async () => {
      let changed = false
      for (const [id, alias] of empty) if (this.aliases[id] === alias && alias.ephemeral && alias.origins.length === 0) { alias.emptyReleased = true; changed = true }
      if (changed) await this.persist()
    })
    this.state.connected = false; this.emit()
  }
  async closed(): Promise<void> { await this.shutdown; await Promise.all([...this.allProcesses].map(rpc => rpc.closed)); await this.writing }
}
