import type { BrowserAgentTools } from './browserAgentServer'
import { ClaudeHistory } from './claudeHistory'
import { ProviderSnapshotPublisher } from './providerSnapshotPublisher'
import { isDeepStrictEqual } from 'node:util'
import { personalContext, type NativeConversation, type PersonalConversation, type PersonalCreateCommand, type PersonalMemory } from './personalConversation'
import { existingWorkingDirectory } from './threadWorktrees'
import { NativeUsage } from './nativeUsage'
import { compactionPending, compactionSchema } from '../../shared/compaction'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { agentAttachmentReferenceSchema, agentProjectSchema, agentRuntimeModeSchema, attachmentSizeBytes, type AgentHostSnapshot, type AgentMessage, type AgentRuntimeMode, type AgentThread } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { AgentHost, AgentHostCommand, AgentHostResult, AgentSkillScope, RestoredThreadHistory, ThreadHistorySource, ThreadHostEvent } from './host'
import { ThreadMessageLog } from './threadMessageLog'
import { cloneHostSnapshot } from './cloneHostSnapshot'
import type { AgentSkillCatalog } from '../../shared/agentSkills'
import { claudeSkillPrompt, discoverClaudeSkills } from './claudeSkills'
import { verifyFileMentions } from './promptFiles'
import { ClaudeSubscriptionClient } from './subscriptionClaude'
import { ClaudeProtocol, object, type ClaudeFrame } from './claudeProtocol'
import { authoredClaudeUser, claudeDigest, ClaudeSessionLog, claudeText } from './claudeSessionLog'
import { claudeAnswer, claudeDenial, claudePending, type ClaudePending } from './claudeRequests'
import { validatePromptAttachments, validateThreadOptions } from './threadOptions'
import { ClaudeActivity } from './claudeActivity'
import { ClaudeMonitoring } from './claudeMonitoring'
import { SessionReaper } from './sessionReaper'
import { markCompactionActivity } from './compactionActivity'
import { markTurnActivity } from './turnActivity'
import { MAX_AGENT_ACTIVITIES, type AgentActivity } from '../../shared/agentActivity'

const originSchema = z.object({ messageId: z.string(), commandId: z.string(), uuid: z.string().uuid(), digest: z.string(), createdAt: z.string(), attachments: z.array(agentAttachmentReferenceSchema).optional() })
/**
 * Transcript cursor: how far a thread's native transcript had been read when Sotto last stopped, whose
 * file that was, and what the reader had already matched there. Reconnecting seeks to it instead of
 * reading the whole file again, and it is only trusted alongside the messages it accounted for.
 */
const cursorSchema = z.object({ sessionId: z.string().uuid(), offset: z.number().int().nonnegative(), size: z.number().int().nonnegative(),
  ino: z.string().optional(), birthtimeMs: z.number().optional(), consumedOriginIds: z.array(z.string()).default([]), lastDigest: z.string().optional() })
const aliasSchema = z.object({ sessionId: z.string().uuid(), historyEpoch: z.string().uuid().optional(), projectId: z.string().optional(), kind: z.literal('personal').optional(), cwd: z.string(), title: z.string(), modelId: z.string(), createdAt: z.string(),
  compaction: compactionSchema.optional(), compactStartedAt: z.string().datetime().optional(), compactInputIds: z.array(z.string().uuid()).optional(), resumeCompactionDismissed: z.boolean().optional(),
  forkMessageIds: z.record(z.string(), z.string()).optional(), lineage: z.array(z.object({ sessionId: z.string().uuid(), boundary: z.string().uuid().optional() })).optional(), rollbackPending: z.object({ sourceSessionId: z.string().uuid(), sourceDigest: z.string(), boundary: z.string().uuid().optional(), targetSessionId: z.string().uuid().optional() }).optional(),
  reasoningEffort: z.string().optional(), runtimeMode: agentRuntimeModeSchema.optional(), transcriptCursor: cursorSchema.optional(), origins: z.array(originSchema).default([]), answeredRequestIds: z.array(z.string()).default([]) }).refine(alias => alias.kind === 'personal' ? alias.projectId === undefined : !!alias.projectId, 'A personal chat cannot have a project; a project thread requires one.')
type Alias = z.infer<typeof aliasSchema>
// Native CLI permission modes. Aliases without a stored mode keep the original
// approval-required behaviour. Prompts still route to Sotto (--permission-prompts host).
const nativePermissionModes = { 'approval-required': 'default', 'auto-accept-edits': 'acceptEdits', auto: 'auto', 'full-access': 'bypassPermissions' } as const satisfies Record<AgentRuntimeMode, string>
function permissionArguments(mode: AgentRuntimeMode = 'approval-required'): string[] {
  // The CLI only accepts bypassPermissions when bypassing is explicitly allowed at launch.
  return ['--permission-mode', nativePermissionModes[mode], '--permission-prompts', 'host', ...(mode === 'full-access' ? ['--allow-dangerously-skip-permissions'] : [])]
}
// Sotto's own browser tools carry no native prompt. Admission is not authority: opening a page,
// navigating, clicking and typing still need the user's one-time answer in Tools (ADR-0020), and
// the native prompt asked the same question a second time without naming the browser. The names are
// listed one by one because the CLI does not match a wildcard against a tool added at launch, and
// the flag is variadic, so it is only ever followed here by another option.
function browserAllowance(server: string, definitions: readonly { name: string }[]): string[] {
  return definitions.length ? ['--allowedTools', ...definitions.map(tool => `mcp__${server}__${tool.name}`)] : []
}
export interface ClaudeStreamJsonHostOptions {
  userDataPath: string; executable?: string; args?: string[]; claudeHome?: string; environment?: NodeJS.ProcessEnv; requestTimeoutMs?: number; pollIntervalMs?: number
  /** Session reaper cadence and idle threshold; see `sessionReaper.ts`. */
  reaperSweepMs?: number; sessionIdleMs?: number
}
type Runtime = { protocol: ClaudeProtocol; requests: Map<string, ClaudePending>; answered: Set<string> }

/** One native coding CLI per thread. Credentials and transcript persistence remain native. */
export class ClaudeStreamJsonHost implements AgentHost {
  private browserTools: BrowserAgentTools | undefined
  useBrowserTools(tools: BrowserAgentTools): void { this.browserTools = tools }
  private readonly usage: NativeUsage
  private readonly aliasStore: AtomicJsonStore<Record<string, Alias>>
  private readonly projectStore: AtomicJsonStore<AgentHostSnapshot['projects']>
  private readonly client: ClaudeSubscriptionClient
  private aliases: Record<string, Alias> = {}
  private readonly threads = new Map<string, NativeConversation>()
  private readonly personalContexts = new Map<string, string>()
  private readonly runtimes = new Map<string, Runtime>()
  private readonly starting = new Map<string, Promise<Runtime>>()
  private readonly logs = new Map<string, ClaudeSessionLog>()
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private readonly publisher = new ProviderSnapshotPublisher(() => {
    const snapshot = this.view()
    for (const listener of this.listeners) listener(snapshot)
  })
  private readonly acknowledgements = new Map<string, () => void>()
  private readonly dispatching = new Set<string>()
  private readonly logOrigins = new Map<string, Set<string>>()
  private readonly lastLogDigest = new Map<string, string>()
  private readonly staleContexts = new Set<string>()
  private readonly completedOrigins = new Set<string>()
  private readonly assistantBlocks = new Map<string, Map<string, string>>()
  /** Watched set: the threads the coordinator asked for. Their CLIs are started eagerly and never reaped. */
  private readonly observed = new Set<string>()
  private readonly reaper: SessionReaper
  private readonly activity = new Map<string, ClaudeActivity>()
  private readonly monitoring = new Map<string, ClaudeMonitoring>()
  private readonly restoredHistory = new Map<string, RestoredThreadHistory>()
  /** This adapter's append path: every change to what a thread said leaves through it as an event. */
  private readonly messageLog = new ThreadMessageLog()
  /** What the host's event store already holds, asked per thread before its transcript is read. */
  private history: ThreadHistorySource | undefined
  /** The assistant message a stream has opened per thread, so its deltas are recorded as appends. */
  private readonly streaming = new Map<string, string>()
  private cursorTimer: ReturnType<typeof setTimeout> | undefined
  private executable = ''
  private generation = 0
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private closures: Promise<void>[] = []
  private state: AgentHostSnapshot = { connected: false, name: 'Claude Code', version: '', models: [], projects: [], threads: [],
    capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true, skills: true, compact: true } }
  constructor(private readonly options: ClaudeStreamJsonHostOptions) {
    this.usage = new NativeUsage(options.userDataPath, 'claude')
    this.aliasStore = new AtomicJsonStore(join(options.userDataPath, 'claude-threads.json'), z.record(z.string(), aliasSchema).parse, () => ({}))
    this.projectStore = new AtomicJsonStore(join(options.userDataPath, 'claude-projects.json'), z.array(agentProjectSchema).parse, () => [])
    this.client = new ClaudeSubscriptionClient(options.userDataPath, { ...(options.executable ? { executable: options.executable } : {}), ...(options.args ? { prefixArgs: options.args } : {}), ...(options.environment ? { environment: options.environment } : {}) })
    this.reaper = new SessionReaper({
      ...(options.reaperSweepMs !== undefined ? { sweepEveryMs: options.reaperSweepMs } : {}),
      ...(options.sessionIdleMs !== undefined ? { idleAfterMs: options.sessionIdleMs } : {}),
      isWatched: id => this.observed.has(id),
      isBusy: id => this.busy(id),
      stop: id => this.stopSession(id),
    })
  }
  /** A turn, live watch, unanswered request, compaction or command mid-dispatch holds a session open. */
  private busy(id: string): boolean {
    const thread = this.threads.get(id)
    return this.dispatching.has(id) || this.starting.has(id) || !!thread && (thread.status === 'running' || thread.requests.length > 0 || !!thread.monitoring?.length)
      || compactionPending(this.aliases[id]?.compaction) || !!this.aliases[id]?.rollbackPending
  }
  /**
   * End this thread's CLI and flush its transcript cursor, the way disconnecting does (ADR-0015). Nothing
   * the user can see changes: the thread keeps its messages and its idle status, its transcript is still
   * read, and the next action launches the CLI again from the stored session.
   */
  private async stopSession(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    this.runtimes.delete(id)
    this.clearMonitoring(id)
    this.messageLog.release(id)
    runtime.protocol.stop()
    await runtime.protocol.closed
    this.flushCursors()
  }
  /** Write the cursors a pending cadence still owes, rather than losing them with the session. */
  private flushCursors(): void {
    if (!this.cursorTimer) return
    clearTimeout(this.cursorTimer); this.cursorTimer = undefined
    this.closures.push(this.persist().catch(() => undefined))
  }
  async connect(): Promise<AgentHostSnapshot> {
    this.disconnect(); await this.closed()
    const generation = this.generation
    await this.usage.load()
    const [account, executable, aliases, projects] = await Promise.all([this.client.status(), this.client.findExecutable(), this.aliasStore.read(), this.projectStore.read()])
    if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    this.state.error = undefined; this.state.models = account.models.map(model => ({ ...model, provider: 'claude', ready: account.ready, runtimeModes: [...agentRuntimeModeSchema.options], supportsImages: true }))
    if (!account.ready || !executable) { this.state.error = account.detail; this.emit(); return this.view() }
    // Without this the version is only known once a session runs, so an idle provider could not be
    // compared against what its channel publishes (ADR-0021).
    this.state.version = await this.client.version(executable) || this.state.version
    this.executable = executable; this.aliases = aliases; this.state.projects = projects
    for (const alias of Object.values(this.aliases)) if (alias.compaction?.status === 'running') alias.compaction = { ...alias.compaction, status: 'uncertain', error: 'Native compaction was interrupted by disconnection. Reconnecting observes its result without retrying.' }
    // Reconnecting keeps what this process already projected, so its stored cursor stays usable.
    const held = new Map([...this.threads].map(([id, thread]) => [id, {
      threadId: id, messages: this.messageLog.messages(id), activities: thread.activities ?? [], ...(thread.historyEpoch ? { historyEpoch: thread.historyEpoch } : {}),
    }]))
    this.messageLog.forgetAll()
    this.threads.clear(); this.logs.clear(); this.activity.clear(); this.logOrigins.clear(); this.lastLogDigest.clear(); this.staleContexts.clear(); this.completedOrigins.clear(); this.assistantBlocks.clear()
    for (const [id, stored] of Object.entries(aliases)) {
      let alias = stored
      if (alias.rollbackPending?.targetSessionId) {
        try { alias = await this.finishRollback(id, alias) }
        catch { this.state.error = 'Claude rollback could not be reconciled. Review its native sessions; it will not be replayed.' }
      }
      this.ensureThread(id, alias)
      this.seedHistory(id, alias, held.get(id) ?? this.restoredHistory.get(id))
      // Handed back for this connect only; a later one is seeded again or reads from the first byte.
      this.restoredHistory.delete(id)
      if (alias.kind === 'personal' && alias.origins.length && !await this.log(id).exists()) {
        this.threads.get(id)!.historyStatus = 'error'; this.threads.get(id)!.historyError = 'Claude native history is unavailable. Cached messages are retained; restore its session before continuing.'
      }
      await this.log(id).poll()
      // Personal connections own only these aliases; reattach their native
      // request channel on reconnect without waiting for a new user prompt.
      if (alias.kind === 'personal') this.observed.add(id)
    }
    if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    this.state.connected = true
    this.reaper.start()
    // Lazy sessions: connecting starts a CLI only for the watched set (and the personal chats added above).
    // Every other known thread is in the snapshot from its alias, and starts on its first action.
    for (const id of this.observed) {
      if (!aliases[id] || aliases[id].rollbackPending) continue
      try { await this.start(id) } catch { this.threads.get(id)!.status = 'error'; this.state.error = 'A Claude thread could not resume. Check its native session before sending again.' }
      if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    }
    this.pollTimer = setInterval(() => { void this.pollSessionLogs().catch(() => { this.state.error = 'Claude history is unavailable. Check the native client before continuing.'; this.emit() }) }, this.options.pollIntervalMs ?? 1000)
    this.pollTimer.unref(); this.emit(); return this.view()
  }
  async snapshot(): Promise<AgentHostSnapshot> { await this.pollSessionLogs(); return this.view() }
  async listThreadSkills(threadId: string, _forceReload = false, scope?: AgentSkillScope): Promise<AgentSkillCatalog> {
    void _forceReload // Native discovery is always fresh; no account/directory cache can leak across threads.
    const cwd = this.aliases[threadId]?.cwd ?? (scope?.providerId === 'claude' ? scope.workingDirectory : undefined)
    if (!this.state.connected || !cwd) throw new Error('Reconnect this Claude thread before browsing skills.')
    const generation = this.generation
    try {
      const catalog = await discoverClaudeSkills(threadId, await existingWorkingDirectory(cwd), this.executable, this.options.args ?? [], this.client.environment(), this.options.requestTimeoutMs ?? 15000)
      if (generation !== this.generation) throw new Error('Claude connection changed while discovering skills.')
      return catalog
    } catch { return { threadId, providerId: 'claude', cwd, status: 'error', skills: [], errors: [], error: 'Claude native skill discovery failed. Reconnect or check the installed client.' } }
  }
  async refreshThread(id: string): Promise<AgentHostSnapshot> {
    if (!this.aliases[id]) throw new Error('That Claude thread is unavailable.')
    const generation = this.generation
    const alias = this.aliases[id]!, thread = this.threads.get(id)!
    const firstReservedPrompt = this.dispatching.has(id) && alias.origins.length === 1 && this.messageLog.count(id) === 0 && this.runtimes.has(id)
    if (alias.kind === 'personal' && alias.origins.length && !firstReservedPrompt && !await this.log(id).exists()) {
      thread.historyStatus = 'error'; thread.historyError = 'Claude native history is unavailable. Cached messages are retained; restore its session before continuing.'
      this.emit(); throw new Error(thread.historyError)
    }
    // Reading a thread is opening it, so a reaped or never-started session starts here. A start that
    // cannot happen is reported by the action that needs it, not by a read.
    await this.start(id).catch(() => undefined)
    await this.log(id).poll()
    if (alias.kind === 'personal') { thread.historyStatus = 'ready'; delete thread.historyError }
    if (generation !== this.generation || !this.state.connected) throw new Error('Claude connection changed while reading the thread.')
    return this.view()
  }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void { return this.messageLog.subscribeEvents(listener) }
  useThreadHistory(source: ThreadHistorySource): void { this.history = source }
  observeThreads(ids: readonly string[]): void {
    this.observed.clear(); for (const id of ids) this.observed.add(id)
    this.messageLog.observe([...this.observed])
    if (!this.state.connected) return
    for (const id of ids) if (this.aliases[id]) void this.start(id).catch(() => {
      const thread = this.threads.get(id); if (thread) thread.status = 'error'
      this.state.error = 'A Claude thread could not resume. Check the native client.'; this.emit()
    })
  }
  rollbackCapability(id: string): { supported: boolean; reason?: string } {
    const alias = this.aliases[id]
    if (!alias || alias.kind === 'personal') return { supported: false, reason: 'Choose an owned Claude project thread.' }
    return alias.rollbackPending ? { supported: false, reason: 'Claude rollback is unconfirmed. Review its native sessions before continuing.' }
      : { supported: true }
  }
  async rollbackThread(id: string, removeTurns: number, expectedUserMessageIds: readonly string[]): Promise<AgentHostResult> {
    const alias = this.aliases[id], thread = this.threads.get(id)
    if (!alias || !thread || !this.state.connected) throw new Error('Connect this Claude thread before rewinding.')
    if (alias.kind === 'personal') throw new Error('Personal chats do not have project checkpoints.')
    if (alias.rollbackPending) throw new Error('Claude rollback is unconfirmed; it will not be replayed.')
    if (!Number.isSafeInteger(removeTurns) || removeTurns < 1 || removeTurns > expectedUserMessageIds.length) throw new Error('Choose an exact Claude turn boundary.')
    if (thread.status === 'running' || thread.requests.length || this.dispatching.has(id)) throw new Error('Wait for Claude and answer its requests before rewinding.')
    const generation = this.generation
    const history = new ClaudeHistory(this.client.environment(), this.options.claudeHome ?? join(homedir(), '.claude'), alias.cwd)
    await this.refreshThread(id)
    const matches = (): boolean => isDeepStrictEqual([...this.messageLog.userMessageIds(id)], [...expectedUserMessageIds])
    if (!matches()) throw new Error('Claude conversation changed. Refresh the checkpoint preview.')
    const messages = await history.read(alias.sessionId)
    const nativeUsers = messages.filter(message => authoredClaudeUser(message))
    const ids = nativeUsers.map(message => alias.origins.find(origin => origin.uuid === message.uuid)?.messageId ?? alias.forkMessageIds?.[message.uuid] ?? message.uuid)
    if (!isDeepStrictEqual(ids, expectedUserMessageIds)) throw new Error('The exact Claude history boundary is unavailable, possibly after compaction. No files or conversation were changed.')
    const retainedCount = ids.length - removeTurns
    const firstRemoved = messages.findIndex(message => message.uuid === nativeUsers[retainedCount]!.uuid)
    const retained = retainedCount ? messages.slice(0, firstRemoved) : []
    const boundary = retained.at(-1)?.uuid
    if (retainedCount > 0 && (!boundary || firstRemoved < 1)) throw new Error('Claude retained history is unavailable.')
    await this.refreshThread(id)
    if (generation !== this.generation || !this.state.connected || !matches() || this.threads.get(id)?.status === 'running' || thread.requests.length) throw new Error('Claude changed before rewind. Refresh the preview.')
    this.dispatching.add(id)
    const sourceSessionId = alias.sessionId
    let forkDispatched = false
    try {
      alias.rollbackPending = { sourceSessionId, sourceDigest: claudeDigest(JSON.stringify(messages)), ...(boundary ? { boundary } : {}) }
      try { await this.persist() } catch (error) { delete alias.rollbackPending; throw error }
      const runtime = this.runtimes.get(id)
      if (runtime) { this.runtimes.delete(id); this.clearMonitoring(id); runtime.protocol.stop(); await runtime.protocol.closed }
      forkDispatched = true
      const targetSessionId = boundary ? await history.fork(sourceSessionId, boundary) : randomUUID()
      alias.rollbackPending.targetSessionId = targetSessionId; await this.persist()
      const next = await this.finishRollback(id, alias)
      // A confirmed rewind is the one change that takes words back: the thread's record starts again.
      this.messageLog.reset(id, next.historyEpoch)
      this.logs.delete(id); this.activity.delete(id); this.logOrigins.delete(id); this.lastLogDigest.delete(id); this.staleContexts.delete(id)
      for (const key of this.assistantBlocks.keys()) if (key.startsWith(`${id}:`)) this.assistantBlocks.delete(key)
      this.ensureThread(id, next); await this.log(id).poll()
      if (generation !== this.generation || !this.state.connected) return { accepted: false, uncertain: true }
      await this.start(id); this.emit(); return { accepted: true }
    } catch (error) {
      this.state.error = 'Claude rewind could not be confirmed. Review its native sessions; Sotto will not replay it.'; this.emit()
      if (forkDispatched) return { accepted: false, uncertain: true }
      delete alias.rollbackPending
      await this.persist()
      throw error
    } finally { this.dispatching.delete(id) }
  }
  /** Reconcile only the durably recorded native fork. Never create another fork
   * on restart, and never accept a changed source or partial retained history. */
  private async finishRollback(id: string, alias: Alias): Promise<Alias> {
    const pending = alias.rollbackPending
    if (!pending?.targetSessionId) throw new Error('Claude rollback has no confirmed native fork identity.')
    const history = new ClaudeHistory(this.client.environment(), this.options.claudeHome ?? join(homedir(), '.claude'), alias.cwd)
    const source = await history.read(pending.sourceSessionId)
    if (claudeDigest(JSON.stringify(source)) !== pending.sourceDigest) throw new Error('Claude source history changed during rewind.')
    const boundaryIndex = pending.boundary ? source.findIndex(message => message.uuid === pending.boundary) : -1
    if (pending.boundary && boundaryIndex < 0) throw new Error('Claude retained history boundary is unavailable.')
    const retained = source.slice(0, boundaryIndex + 1)
    const fork = await history.read(pending.targetSessionId)
    if (!isDeepStrictEqual(retained.map(message => [message.type, message.message]), fork.map(message => [message.type, message.message]))) throw new Error('Claude fork did not preserve the exact retained history.')
    const remap = new Map(retained.map((message, index) => [message.uuid, fork[index]!.uuid]))
    const next = structuredClone(alias)
    next.sessionId = pending.targetSessionId
    next.historyEpoch = randomUUID()
    next.lineage = [...(alias.lineage ?? []), { sessionId: pending.sourceSessionId, ...(pending.boundary ? { boundary: pending.boundary } : {}) }]
    next.forkMessageIds = Object.fromEntries(retained.filter(message => message.type === 'user').map(message => [remap.get(message.uuid)!, alias.origins.find(origin => origin.uuid === message.uuid)?.messageId ?? alias.forkMessageIds?.[message.uuid] ?? message.uuid]))
    next.origins = alias.origins.filter(origin => remap.has(origin.uuid)).map(origin => ({ ...origin, uuid: remap.get(origin.uuid)! }))
    next.answeredRequestIds = []; delete next.rollbackPending
    this.aliases[id] = next
    try { await this.persist() } catch (error) { this.aliases[id] = alias; throw error }
    return next
  }
  personalSnapshot(): PersonalConversation[] {
    return structuredClone([...this.threads.values()].filter((thread): thread is PersonalConversation => 'kind' in thread && thread.kind === 'personal')
      .map(thread => this.messageLog.publishedThread(thread)))
  }
  async createPersonalConversation(command: PersonalCreateCommand, memories: readonly PersonalMemory[] = []): Promise<AgentHostResult> {
    this.personalContexts.set(command.threadId, personalContext(memories))
    return this.executeNative({ ...command, type: 'create-personal' })
  }
  async sendPersonalConversation(command: Extract<AgentHostCommand, { type: 'send' }>, memories: readonly PersonalMemory[]): Promise<AgentHostResult> {
    if (this.aliases[command.threadId]?.kind !== 'personal') throw new Error('This is not an owned personal conversation.')
    const context = personalContext(memories)
    if (this.personalContexts.get(command.threadId) !== context) this.staleContexts.add(command.threadId)
    this.personalContexts.set(command.threadId, context)
    return this.execute(command)
  }
  async execute(command: AgentHostCommand): Promise<AgentHostResult> { return this.executeNative(command) }
  private async executeNative(command: AgentHostCommand | (PersonalCreateCommand & { type: 'create-personal' })): Promise<AgentHostResult> {
    if (command.type === 'steer') throw new Error('This provider does not support native steering. Queue a follow-up instead.')
    if (!this.state.connected) throw new Error('Connect Claude Code before continuing.')
    if (command.type === 'create-project') {
      if (!isAbsolute(command.path)) throw new Error('Choose an absolute project folder.')
      const projects = this.state.projects.filter(project => project.id !== command.projectId)
      projects.push({ id: command.projectId, title: command.title, path: command.path })
      await this.projectStore.write(projects); this.state.projects = projects; this.emit(); return { accepted: true }
    }
    if (command.type === 'create-thread' || command.type === 'create-personal') {
      if (this.aliases[command.threadId]) return { accepted: true }
      validateThreadOptions(this.state, command)
      const project = command.type === 'create-thread' ? this.state.projects.find(candidate => candidate.id === command.projectId) : undefined
      if (command.type === 'create-thread' && !project) throw new Error('Choose an existing project.')
      const alias: Alias = { sessionId: randomUUID(), ...(command.type === 'create-personal' ? { kind: 'personal' as const } : { projectId: project!.id }), cwd: await existingWorkingDirectory(command.workingDirectory ?? project!.path), title: command.title, modelId: command.modelId,
        reasoningEffort: command.reasoningEffort, ...(command.runtimeMode ? { runtimeMode: command.runtimeMode } : {}), createdAt: new Date().toISOString(), origins: [], answeredRequestIds: [] }
      this.aliases[command.threadId] = alias
      try { await this.persist() } catch (error) { delete this.aliases[command.threadId]; throw error }
      this.ensureThread(command.threadId, alias); this.emit()
      // Creating a durable local identity does not require a paid model turn.
      try { await this.start(command.threadId) } catch { this.threads.get(command.threadId)!.status = 'error'; this.emit(); return { accepted: false, uncertain: true } }
      return { accepted: true }
    }
    const id = command.threadId; const alias = this.aliases[id]; const thread = this.threads.get(id)
    if (!alias || !thread) throw new Error('That Claude thread is unavailable.')
    this.reaper.touch(id)
    if (alias.rollbackPending) throw new Error('Claude rollback is unconfirmed. Review the original and forked native sessions before continuing; Sotto will not replay it.')
    if (compactionPending(alias.compaction) && command.type !== 'interrupt' && command.type !== 'answer') throw new Error('Native compaction is still running or unconfirmed. Wait for its result; it will not be sent twice.')
    if (command.type === 'compact-thread') {
      if (this.dispatching.has(id) || thread.status === 'running' || thread.requests.length) throw new Error('Wait for the Claude thread and its requests before compacting.')
      this.dispatching.add(id)
      try {
        const runtime = await this.start(id)
        if (!thread.manualCompactionSupported) throw new Error('This Claude client does not expose native manual compaction.')
        if (this.threads.get(id)?.status === 'running' || thread.requests.length) throw new Error('Claude started working before compaction.')
        const inputId = randomUUID()
        alias.compaction = { commandId: command.commandId, status: 'running' }
        alias.compactStartedAt = new Date().toISOString()
        alias.compactInputIds = [...(alias.compactInputIds ?? []), inputId]
        try { await this.persist() } catch (error) { delete alias.compaction; throw error }
        thread.compaction = alias.compaction; thread.status = 'running'; this.emit()
        try { await runtime.protocol.write({ type: 'user', uuid: inputId, session_id: alias.sessionId, parent_tool_use_id: null, message: { role: 'user', content: '/compact' } }) }
        catch {
          alias.compaction = { commandId: command.commandId, status: 'uncertain', error: 'Native compaction is unconfirmed. Reconnect to observe its result; it will not be retried.' }
          thread.compaction = alias.compaction; await this.persist(); this.emit(); return { accepted: false, uncertain: true }
        }
        return { accepted: true }
      } finally { this.dispatching.delete(id) }
    }
    if (command.type === 'configure-thread') {
      validateThreadOptions(this.state, command, alias.modelId)
      if (thread.status === 'running' || thread.requests.length) throw new Error('Wait for this Claude turn to finish before changing settings.')
      const runtime = this.runtimes.get(id)
      if (runtime) { this.runtimes.delete(id); this.clearMonitoring(id); runtime.protocol.stop(); await runtime.protocol.closed }
      alias.modelId = command.modelId ?? alias.modelId; alias.reasoningEffort = command.reasoningEffort ?? alias.reasoningEffort; if (command.runtimeMode) alias.runtimeMode = command.runtimeMode
      await this.persist(); thread.modelId = alias.modelId; thread.reasoningEffort = alias.reasoningEffort; thread.runtimeMode = alias.runtimeMode ?? 'approval-required'
      await this.start(id); this.emit(); return { accepted: true }
    }
    if (command.type === 'send') {
      validatePromptAttachments(this.state, alias.modelId, command.attachments)
      const checkLatestUserMessage = (): void => {
        if (command.expectedLastUserMessageId !== undefined && (this.messageLog.lastUserMessageId(id) ?? null) !== command.expectedLastUserMessageId) throw new Error('The latest user message changed. Review the thread before replying.')
      }
      await this.refreshThread(id)
      checkLatestUserMessage()
      if (alias.origins.some(origin => origin.messageId === command.messageId)) return this.messageLog.has(id, command.messageId) ? { accepted: true } : { accepted: false, uncertain: true }
      if (this.dispatching.has(id) || thread.status === 'running') throw new Error('Claude is already running a turn.')
      if (thread.requests.length) throw new Error('Answer the pending Claude request before sending another prompt.')
      this.dispatching.add(id)
      try {
        if (this.staleContexts.delete(id)) {
          const stale = this.runtimes.get(id)
          if (stale) { await this.denyPending(id, stale); this.runtimes.delete(id); this.clearMonitoring(id); stale.protocol.stop(); await stale.protocol.closed }
        }
        const runtime = await this.start(id)
        verifyFileMentions(command.text, command.files)
        const nativePrompt = command.skills?.length ? claudeSkillPrompt(command.text, command.skills, await this.listThreadSkills(id, true)) : command.text
        const nativeText = typeof nativePrompt === 'string' ? nativePrompt : claudeText(nativePrompt)
        const origin = { messageId: command.messageId, commandId: command.commandId, uuid: randomUUID(), digest: claudeDigest(nativeText), createdAt: new Date().toISOString(),
          ...(command.attachments?.length ? { attachments: command.attachments.map(attachment => ({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachmentSizeBytes(attachment.dataUrl) })) } : {}) }
        alias.origins.push(origin)
        try { await this.persist() } catch (error) { alias.origins = alias.origins.filter(candidate => candidate.uuid !== origin.uuid); throw error }
        const content: unknown = command.attachments?.length ? [
          ...command.attachments.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1) } })),
          ...(typeof nativePrompt === 'string' ? (nativePrompt ? [{ type: 'text', text: nativePrompt }] : []) : nativePrompt),
        ] : nativePrompt
        // Resume and durable origin writes can yield while the user takes over.
        // Recheck at the dispatch boundary; an undispatched origin is safe to remove.
        try {
          await this.refreshThread(id); checkLatestUserMessage()
          if (thread.requests.length || this.threads.get(id)?.status === 'running') throw new Error('The Claude thread started working or needs an answer before another prompt.')
        }
        catch (error) {
          alias.origins = alias.origins.filter(candidate => candidate.uuid !== origin.uuid)
          await this.persist(); throw error
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        const acknowledged = new Promise<boolean>(resolve => {
          timer = setTimeout(() => { this.acknowledgements.delete(origin.uuid); resolve(false) }, this.options.requestTimeoutMs ?? 15000)
          this.acknowledgements.set(origin.uuid, () => { clearTimeout(timer); this.acknowledgements.delete(origin.uuid); resolve(true) })
        })
        thread.status = 'running'; thread.lastTurn = { id: origin.uuid, status: 'running' }
        try {
          const delivery = runtime.protocol.write({ type: 'user', uuid: origin.uuid, session_id: alias.sessionId, parent_tool_use_id: null, message: { role: 'user', content } })
          this.emit(); await delivery
        }
        catch { clearTimeout(timer); this.acknowledgements.delete(origin.uuid); return { accepted: false, uncertain: true } }
        return await acknowledged ? { accepted: true } : { accepted: false, uncertain: true }
      } finally { this.dispatching.delete(id) }
    }
    // Answering and interrupting start the session too, so a reaped thread behaves like a live one.
    let runtime: Runtime
    try { runtime = await this.start(id) }
    catch { throw new Error('Claude is not attached to this thread. Reconnect before continuing.') }
    if (command.type === 'answer') {
      const pending = runtime.requests.get(command.requestId)
      if (!pending) throw new Error('That request is no longer pending.')
      if (runtime.answered.has(pending.id)) return { accepted: false, uncertain: true }
      const answer = claudeAnswer(pending, command.answer, command.approved, command.questionAnswers, command.permissionChoice)
      runtime.answered.add(pending.id)
      alias.answeredRequestIds.push(pending.id)
      try { await this.persist() } catch (error) { alias.answeredRequestIds = alias.answeredRequestIds.filter(id => id !== pending.id); runtime.answered.delete(pending.id); throw error }
      if (this.runtimes.get(id) !== runtime || !runtime.requests.has(pending.id)) return { accepted: false, uncertain: true }
      try {
        await this.reply(runtime, pending.id, answer)
        if (pending.resumeDialog && answer.result === 'never') {
          alias.resumeCompactionDismissed = true
          for (const current of this.threads.values()) current.resumeCompactionDismissed = true
          await this.persist()
        }
        runtime.requests.delete(pending.id); thread.requests = thread.requests.filter(request => request.id !== pending.id); this.emit(); return { accepted: true }
      } catch { pending.request.delivery = 'uncertain'; this.emit(); return { accepted: false, uncertain: true } }
    }
    if (command.type === 'interrupt') {
      await this.denyPending(id, runtime)
      try { await runtime.protocol.control({ subtype: 'interrupt' }); this.clearMonitoring(id); thread.status = 'idle'; thread.lastTurn = { id: thread.lastTurn?.id ?? command.commandId, status: 'interrupted' }; this.markTurn(id, 'interrupted'); this.emit(); return { accepted: true } }
      catch { return { accepted: false, uncertain: true } }
    }
    throw new Error('Unsupported Claude command.')
  }
  async pollSessionLogs(): Promise<void> { for (const log of this.logs.values()) await log.poll() }
  /** Messages the workspace still holds; a thread whose history is handed back may resume its cursor. */
  restoreThreadHistory(threads: readonly RestoredThreadHistory[]): Promise<void> {
    for (const thread of threads) if (thread.messages.length) this.restoredHistory.set(thread.threadId, thread)
    return Promise.resolve()
  }
  disconnect(): void {
    this.generation++; clearInterval(this.pollTimer); this.pollTimer = undefined; this.state.connected = false
    for (const id of this.threads.keys()) this.clearMonitoring(id)
    this.reaper.dispose()
    this.flushCursors()
    for (const [id, runtime] of this.runtimes) {
      const closure = this.denyPending(id, runtime).catch(() => undefined).then(() => { runtime.protocol.stop(); return runtime.protocol.closed })
      this.closures.push(closure)
    }
    this.runtimes.clear(); this.starting.clear(); this.emit()
  }
  async closed(): Promise<void> { await Promise.all(this.closures); this.closures = []; await this.usage.flushed() }
  private async start(id: string): Promise<Runtime> {
    this.reaper.touch(id)
    const pending = this.starting.get(id); if (pending) return pending
    const runtime = this.runtimes.get(id); if (runtime) return runtime
    const work = this.launch(id); this.starting.set(id, work)
    try { const started = await work; this.messageLog.pin(id); return started } finally { this.starting.delete(id) }
  }
  private async launch(id: string): Promise<Runtime> {
    const alias = this.aliases[id]!; const generation = this.generation
    if (alias.rollbackPending) throw new Error('Claude rollback is unconfirmed; reconnect to reconcile its native history.')
    const resume = await this.log(id).exists()
    if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    if (!resume && alias.origins.length) throw new Error('Claude native history is unavailable. Restore its session before continuing; Sotto will not recreate or resend an uncertain turn.')
    const browser = alias.kind !== 'personal' ? await this.browserTools?.mcpServer(id) : undefined
    const browserArguments = browser ? ['--mcp-config', JSON.stringify({ mcpServers: { [browser.name]: {
      type: browser.type, url: browser.url, headers: Object.fromEntries(browser.headers.map(header => [header.name, header.value])),
    } } }), ...browserAllowance(browser.name, this.browserTools?.definitions ?? [])] : []
    const args = [...(this.options.args ?? []), ...browserArguments, '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--replay-user-messages', ...permissionArguments(alias.runtimeMode),
      ...(alias.kind === 'personal' ? ['--append-system-prompt', this.personalContexts.get(id) ?? personalContext()] : []),
      resume ? '--resume' : '--session-id', alias.sessionId, '--model', alias.modelId, ...(alias.reasoningEffort ? ['--effort', alias.reasoningEffort] : [])]
    const runtime: Runtime = { requests: new Map(), answered: new Set(), protocol: new ClaudeProtocol(this.executable, args, alias.cwd, { ...this.client.environment(), ...(browser ? { MCP_TOOL_TIMEOUT: '360000' } : {}) }, this.options.requestTimeoutMs ?? 15000,
      frame => { if (this.runtimes.get(id) === runtime) this.frame(id, frame) }, () => {
        if (this.runtimes.get(id) !== runtime) return
        this.clearMonitoring(id)
        this.runtimes.delete(id); this.threads.get(id)!.requests = []; this.threads.get(id)!.status = 'error'
        this.state.connected = false; this.state.error = 'Claude Code disconnected. Reconnect to recover its existing session; uncertain prompts will not be resent.'; this.emit()
      }) }
    this.runtimes.set(id, runtime); this.closures.push(runtime.protocol.closed)
    try {
      const initialized = await runtime.protocol.control({ subtype: 'initialize', hooks: {}, sdkMcpServers: [], promptSuggestions: false, supportedDialogKinds: ['resume_return'] })
      this.threads.get(id)!.manualCompactionSupported = Array.isArray(initialized.commands) && initialized.commands.some(command => object(command)?.name === 'compact')
      for (const pending of Array.isArray(initialized.pending_user_dialog_requests) ? initialized.pending_user_dialog_requests : []) {
        if (object(pending)) this.frame(id, pending as ClaudeFrame)
      }
    }
    catch (error) { this.runtimes.delete(id); this.clearMonitoring(id); runtime.protocol.stop(); throw error }
    if (generation !== this.generation) { runtime.protocol.stop(); throw new Error('Claude connection was cancelled.') }
    return runtime
  }
  private frame(id: string, frame: ClaudeFrame): void {
    this.reaper.touch(id)
    const runtime = this.runtimes.get(id)!; const thread = this.threads.get(id)!; const alias = this.aliases[id]!
    if (typeof frame.session_id === 'string' && frame.session_id !== alias.sessionId) return
    let monitoring = this.monitoring.get(id)
    if (!monitoring) { monitoring = new ClaudeMonitoring(); this.monitoring.set(id, monitoring) }
    monitoring.apply(frame); thread.monitoring = monitoring.current
    if (frame.type === 'system' && frame.subtype === 'init' && typeof frame.claude_code_version === 'string') this.state.version = frame.claude_code_version
    if (frame.type === 'control_request') {
      if (typeof frame.request_id === 'string' && runtime.answered.has(frame.request_id)) return
      const pending = runtime.requests.size < 256 ? claudePending(frame) : undefined
      if (pending) {
        if (alias.answeredRequestIds.includes(pending.id)) { pending.request.delivery = 'uncertain'; runtime.answered.add(pending.id) }
        runtime.requests.set(pending.id, pending); thread.requests = [...runtime.requests.values()].map(value => value.request); this.emit()
      }
      else if (typeof frame.request_id === 'string') {
        const requestId = frame.request_id
        const response = object(frame.request)?.subtype === 'can_use_tool'
          ? this.reply(runtime, requestId, claudeDenial())
          : runtime.protocol.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'Unsupported Claude control request.' } })
        void response.catch(() => undefined)
      }
      return
    }
    if (frame.type === 'control_cancel_request' && typeof frame.request_id === 'string') { runtime.requests.delete(frame.request_id); thread.requests = [...runtime.requests.values()].map(value => value.request) }
    this.projectActivity(id, frame, true)
    if (frame.parent_tool_use_id) { this.emit(true); return }
    this.observeCompaction(id, frame, false)
    if (frame.type === 'user' && authoredClaudeUser(frame)) {
      this.message(id, frame, false)
      const uuid = typeof frame.uuid === 'string' ? frame.uuid : ''
      if (alias.origins.some(origin => origin.uuid === uuid)) {
        if (!this.completedOrigins.has(uuid)) { thread.status = 'running'; this.markTurn(id, 'running') }
        this.acknowledgements.get(uuid)?.()
      }
    }
    if (frame.type === 'assistant') this.message(id, frame, false)
    if (frame.type === 'stream_event') {
      this.usage.claude(id, frame, thread.modelId); thread.usage = this.usage.get(id)
      const event = object(frame.event)
      if (event?.type === 'message_start') {
        const message = object(event.message)
        if (typeof message?.id === 'string') {
          this.streaming.set(id, message.id)
          this.addMessage(id, { id: message.id, role: 'assistant', text: '', createdAt: new Date().toISOString() })
        }
      }
      const delta = object(event?.delta)
      if (event?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
        // A streamed reply grew by a suffix, which is what the record says about it.
        const last = this.messageLog.lastMessage(id)
        const streaming = this.streaming.get(id) ?? (last?.role === 'assistant' ? last.id : undefined)
        if (streaming !== undefined) this.messageLog.appendText(id, streaming, delta.text)
      }
    }
    if (frame.type === 'result') {
      if (compactionPending(alias.compaction)) {
        alias.compaction = { commandId: alias.compaction!.commandId, status: frame.is_error === true ? 'failed' : 'uncertain',
          error: frame.is_error === true ? 'Claude native compaction failed.' : 'Claude finished without confirming a compaction boundary. The operation will not be retried.' }
        thread.compaction = alias.compaction
        void this.persist().catch(() => { this.state.error = 'The native compaction result could not be saved.'; this.emit() })
      }
      this.usage.claudeResult(id, frame)
      thread.usage = this.usage.get(id)
      this.messageLog.dropEmpty(id); this.streaming.delete(id)
      const origin = typeof frame.user_message_uuid === 'string' ? frame.user_message_uuid : alias.origins.at(-1)?.uuid
      if (origin) {
        this.completedOrigins.add(origin)
        if (thread.lastTurn?.id !== origin || thread.lastTurn.status !== 'interrupted') thread.lastTurn = { id: origin, status: frame.is_error === true ? 'failed' : 'completed' }
        this.markTurn(id, thread.lastTurn?.status === 'interrupted' ? 'interrupted' : frame.is_error === true ? 'failed' : 'completed',
          alias.origins.find(value => value.uuid === origin)?.messageId, typeof frame.result === 'string' && frame.is_error === true ? frame.result : undefined)
      }
      thread.status = frame.is_error === true ? 'error' : 'idle'; runtime.requests.clear(); thread.requests = []
      if (frame.is_error === true) { this.clearMonitoring(id); this.state.error = 'Claude could not complete this turn. Check its native subscription, model and usage limits.' }
    }
    this.emit(frame.type === 'stream_event' || frame.type === 'assistant'
      || frame.type === 'system' && ['task_started', 'task_progress', 'task_updated', 'task_notification'].includes(String(frame.subtype)))
  }
  private clearMonitoring(id: string): void {
    this.monitoring.delete(id)
    const thread = this.threads.get(id)
    if (thread) delete thread.monitoring
  }
  private message(id: string, frame: ClaudeFrame, fromLog: boolean): void {
    if (typeof frame.uuid === 'string' && this.aliases[id]?.compactInputIds?.includes(frame.uuid)) return
    this.usage.claude(id, frame, this.threads.get(id)!.modelId)
    this.threads.get(id)!.usage = this.usage.get(id)
    if (frame.parent_tool_use_id || frame.isSidechain === true) return
    const message = object(frame.message); let text = claudeText(message?.content)
    if ((!text && frame.type !== 'user') || !['user', 'assistant'].includes(String(frame.type))) return
    if (frame.type === 'user' && !authoredClaudeUser(frame)) return
    const alias = this.aliases[id]!; const uuid = typeof frame.uuid === 'string' ? frame.uuid : ''
    const digest = claudeDigest(text)
    let origin = alias.origins.find(value => value.uuid === uuid)
    if (fromLog && frame.type === 'user') {
      const consumed = this.logOrigins.get(id) ?? new Set<string>(); this.logOrigins.set(id, consumed)
      origin ??= alias.origins.find(value => !consumed.has(value.uuid) && value.digest === digest)
      if (origin) { consumed.add(origin.uuid); this.lastLogDigest.set(id, digest) }
      else if (this.lastLogDigest.get(id) === digest) return
      else { this.lastLogDigest.delete(id); this.staleContexts.add(id) }
    }
    const providerId = frame.type === 'assistant' && typeof message?.id === 'string' ? message.id : uuid || `native-${digest}`
    if (frame.type === 'assistant') {
      const blockKey = `${id}:${providerId}`; const blocks = this.assistantBlocks.get(blockKey) ?? new Map<string, string>()
      blocks.set(uuid || digest, text); this.assistantBlocks.set(blockKey, blocks); text = [...blocks.values()].join('\n')
    }
    this.addMessage(id, { id: origin?.messageId ?? alias.forkMessageIds?.[uuid] ?? providerId, role: frame.type as 'user' | 'assistant', text,
      createdAt: origin?.createdAt ?? (typeof frame.timestamp === 'string' ? frame.timestamp : new Date().toISOString()), ...(origin ? { commandId: origin.commandId, ...(origin.attachments ? { attachments: origin.attachments } : {}) } : {}) })
  }
  private log(id: string): ClaudeSessionLog {
    let log = this.logs.get(id)
    if (!log) {
      const alias = this.aliases[id]!
      const generation = this.generation
      // One publish per read, not per entry: a connect reads the whole transcript, and a snapshot per line
      // is a snapshot clone and a workspace write per line, which ran the main process out of heap.
      const current = (): boolean => generation === this.generation && this.aliases[id]?.sessionId === alias.sessionId
      log = new ClaudeSessionLog(this.options.claudeHome ?? join(homedir(), '.claude'), alias.cwd, alias.sessionId, frame => {
        if (current()) { this.observeCompaction(id, frame, true); this.projectActivity(id, frame); this.message(id, frame, true) }
      }, () => { if (current()) { this.noteCursor(id); this.emit() } })
      this.logs.set(id, log)
    }
    return log
  }
  /**
   * A stored cursor stands for both authored messages and activity classification behind it.
   * Missing activity evidence requires a full replay, even when message identities are available.
   */
  private seedHistory(id: string, alias: Alias, restored: RestoredThreadHistory | undefined): void {
    const cursor = alias.transcriptCursor
    if (!cursor || cursor.sessionId !== alias.sessionId) { delete alias.transcriptCursor; return }
    const matching = restored?.historyEpoch === alias.historyEpoch ? restored : undefined
    const stored = matching?.messages.length ? matching.messages : this.history?.messageIdentities(id) ?? []
    const activities = matching?.activities ?? this.history?.activities?.(id, alias.historyEpoch)
    if (!stored.length || activities === undefined) { delete alias.transcriptCursor; return }
    this.messageLog.seed(id, stored)
    this.threads.get(id)!.activities = structuredClone(activities.slice(-MAX_AGENT_ACTIVITIES))
    // A later block of an assistant message already projected must add to its text, not replace it.
    for (const message of matching?.messages ?? []) if (message.role === 'assistant') this.assistantBlocks.set(`${id}:${message.id}`, new Map([['restored', message.text]]))
    this.logOrigins.set(id, new Set(cursor.consumedOriginIds))
    if (cursor.lastDigest) this.lastLogDigest.set(id, cursor.lastDigest)
    this.log(id).resume(cursor)
  }
  /** Record where this thread's transcript has been read to; the write itself waits for the cadence below. */
  private noteCursor(id: string): void {
    const alias = this.aliases[id]; const cursor = this.logs.get(id)?.cursor()
    if (!alias || !cursor) return
    const lastDigest = this.lastLogDigest.get(id)
    alias.transcriptCursor = { sessionId: alias.sessionId, offset: cursor.offset, size: cursor.size, ...(cursor.ino ? { ino: cursor.ino } : {}),
      ...(cursor.birthtimeMs === undefined ? {} : { birthtimeMs: cursor.birthtimeMs }),
      consumedOriginIds: [...(this.logOrigins.get(id) ?? [])], ...(lastDigest ? { lastDigest } : {}) }
    this.saveCursors()
  }
  /** Cursors ride a slow shared write, never one per line, so reading a transcript stays a read. */
  private saveCursors(): void {
    if (this.cursorTimer) return
    this.cursorTimer = setTimeout(() => { this.cursorTimer = undefined; void this.persist().catch(() => undefined) }, 5000)
    this.cursorTimer.unref()
  }
  private ensureThread(id: string, alias: Alias): void {
    this.threads.set(id, { id, ...(alias.kind === 'personal' ? { kind: 'personal' as const } : { projectId: alias.projectId! }), ...(alias.historyEpoch ? { historyEpoch: alias.historyEpoch } : {}), workingDirectory: alias.cwd, title: alias.title, modelId: alias.modelId, reasoningEffort: alias.reasoningEffort, runtimeMode: alias.runtimeMode ?? 'approval-required', status: 'idle', messages: [], requests: [], activities: [] })
    this.threads.get(id)!.usage = this.usage.get(id)
    this.threads.get(id)!.compaction = alias.compaction
    this.threads.get(id)!.resumeCompactionDismissed = Object.values(this.aliases).some(value => value.resumeCompactionDismissed)
  }
  private observeCompaction(id: string, frame: ClaudeFrame, fromLog: boolean): void {
    if (frame.parent_tool_use_id || frame.isSidechain || frame.type !== 'system' || !(frame.subtype === 'compact_boundary' || frame.subtype === 'status' && ['success', 'failed'].includes(String(frame.compact_result)))) return
    const alias = this.aliases[id]!, thread = this.threads.get(id)!
    const timestamp = typeof frame.timestamp === 'string' ? Date.parse(frame.timestamp) : NaN
    // Persisted history may replay older compactions. Only evidence after this
    // durable request can reconcile an operation whose live acknowledgement was lost.
    if (compactionPending(alias.compaction) && (!fromLog || timestamp >= Date.parse(alias.compactStartedAt ?? ''))) {
      alias.compaction = { commandId: alias.compaction!.commandId, status: frame.compact_result === 'failed' ? 'failed' : 'completed',
        ...(frame.compact_result === 'failed' ? { error: typeof frame.compact_error === 'string' ? frame.compact_error : 'Claude native compaction failed.' } : {}) }
      thread.compaction = alias.compaction
      thread.status = frame.compact_result === 'failed' ? 'error' : 'idle'
      void this.persist().catch(() => { this.state.error = 'The native compaction result could not be saved.'; this.emit() })
    }
    if (frame.subtype === 'compact_boundary' && (!fromLog || Number.isFinite(timestamp) && timestamp > Date.parse(thread.usage?.contextUpdatedAt ?? '1970-01-01'))) {
      const metadata = object(frame.compact_metadata) ?? object(frame.compactMetadata)
      const tokens = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined
      // The size Sotto last saw is the honest stand-in when the boundary omits its own before-count.
      const before = tokens(metadata?.pre_tokens ?? metadata?.preTokens) ?? thread.usage?.contextUsed
      const after = tokens(metadata?.post_tokens ?? metadata?.postTokens)
      this.markCompaction(id, String(frame.uuid ?? timestamp), before, after, Number.isFinite(timestamp) ? timestamp : undefined)
      this.usage.compacted(id, metadata?.post_tokens ?? metadata?.postTokens, Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined)
      thread.usage = this.usage.get(id)
    }
  }
  /** A compaction is not a turn and not a tool: the transcript says so on its own line. */
  private markCompaction(id: string, key: string, before: number | undefined, after: number | undefined, at: number | undefined): void {
    const thread = this.threads.get(id); if (!thread) return
    const anchor = this.messageLog.lastTextMessageId(id)
    thread.activities = markCompactionActivity(thread.activities, { provider: 'claude', key,
      turnId: this.messageLog.lastUserMessageId(id) ?? 'native-history',
      ...(anchor !== undefined ? { afterMessageId: anchor } : {}),
      ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}), ...(at !== undefined ? { at } : {}) })
  }
  /**
   * Claude reports no turn lifecycle, so Sotto records the turn it watched. The turn is identified by
   * its user message, the same identity the projected activity rows already carry.
   */
  private markTurn(id: string, status: AgentActivity['status'], turnId?: string, error?: string): void {
    const thread = this.threads.get(id); if (!thread) return
    const last = this.messageLog.lastUserMessageId(id)
    const turn = turnId ?? last
    if (turn === undefined) return
    thread.activities = markTurnActivity(thread.activities, { provider: 'claude', turnId: turn, status,
      ...(last === turn ? { afterMessageId: turn } : {}), ...(error !== undefined ? { error } : {}) })
  }
  private projectActivity(id: string, frame: ClaudeFrame, live = false): void {
    const thread = this.threads.get(id)!
    let projector = this.activity.get(id)
    if (!projector) { projector = new ClaudeActivity(activityId => this.history?.activity?.(id, activityId, this.aliases[id]?.historyEpoch)); this.activity.set(id, projector) }
    const turnId = this.messageLog.lastUserMessageId(id) ?? 'native-history'
    const rows = projector.apply(thread.activities ?? [], frame, turnId, this.messageLog.lastTextMessageId(id), this.aliases[id]!.cwd, live)
    if (rows.length) thread.activities = rows
  }
  /** The one place a Claude message reaches the record: the transcript tail, a streamed reply, or a
   * takeover typed into the CLI. The log works out whether it is an addition, an append or a change. */
  private addMessage(id: string, message: AgentMessage): void { this.messageLog.add(id, message) }
  private reply(runtime: Runtime, id: string, response: ClaudeFrame): Promise<void> {
    return runtime.protocol.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
  }
  private async denyPending(id: string, runtime: Runtime): Promise<void> {
    const pending = [...runtime.requests.values()].filter(request => !runtime.answered.has(request.id)); runtime.requests.clear()
    const thread = this.threads.get(id); if (thread) thread.requests = []
    await Promise.all(pending.map(request => this.reply(runtime, request.id, request.resumeDialog ? { behavior: 'cancelled' } : claudeDenial())))
  }
  private persist(): Promise<void> { return this.aliasStore.write(structuredClone(this.aliases)) }
  private view(): AgentHostSnapshot {
    return cloneHostSnapshot({ ...this.state, threads: [...this.threads.values()]
      .filter((thread): thread is AgentThread => 'projectId' in thread).map(thread => this.messageLog.publishedThread(thread)) })
  }
  private emit(streaming = false): void { this.publisher.publish(streaming) }
}

