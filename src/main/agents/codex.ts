import { existingWorkingDirectory } from './threadWorktrees'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { agentProjectSchema, agentRuntimeModeSchema, type AgentRuntimeMode, type AgentHostSnapshot, type AgentMessage, type AgentThread } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { AgentSkillCatalog, AgentSkillReference } from '../../shared/agentSkills'
import { codexSkillInput, parseCodexSkillCatalog } from './codexSkills'
import type { AgentHost, AgentHostCommand, AgentHostResult, AgentSkillScope } from './host'
import { findExecutable, nativeEnvironment } from './subscriptionCodex'
import { CodexSessionLogWatcher, promptDigest, textOf } from './codexSessionLog'
import { answerRequest, declineRequest, pendingRequest, requestKey, type CodexPendingRequest } from './codexRequests'
import { validatePromptAttachments, validateThreadOptions } from './threadOptions'
import { CodexActivityProjection, codexItemSchema } from './codexActivity'

const MAX_OUTPUT_BYTES = 1024 * 1024
const threadPolicy = { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' } as const
// Codex's previous policy is auto-accept-edits; preserve it for old aliases and
// creation without an explicit selection. Shapes verified with generated 0.154 schemas.
function runtimePolicy(mode: AgentRuntimeMode = 'auto-accept-edits') {
  if (mode === 'approval-required') return { approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'read-only' }
  if (mode === 'full-access') return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' }
  return { approvalPolicy: 'on-request', approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user', sandbox: 'workspace-write' }
}
const configArguments = Object.entries({ model_provider: 'openai', approval_policy: threadPolicy.approvalPolicy,
  approvals_reviewer: threadPolicy.approvalsReviewer, sandbox_mode: threadPolicy.sandbox }).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])
const originSchema = z.object({ messageId: z.string(), commandId: z.string(), digest: z.string(), createdAt: z.string(), itemId: z.string().optional(), turnId: z.string().optional() })
const aliasSchema = z.object({ codexThreadId: z.string(), projectId: z.string(), cwd: z.string(), title: z.string(), modelId: z.string(),
  pendingSettings: z.object({ modelId: z.string(), reasoningEffort: z.string().optional(), runtimeMode: agentRuntimeModeSchema }).optional(),
  reasoningEffort: z.string().optional(), runtimeMode: agentRuntimeModeSchema.optional(), createdAt: z.string(), origins: z.array(originSchema).default([]) })
const aliasesSchema = z.record(z.string(), aliasSchema)
type Alias = z.infer<typeof aliasSchema>
type Origin = z.infer<typeof originSchema>
const rpcSchema = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(), error: z.unknown().optional() })
const itemSchema = codexItemSchema
const turnSchema = z.object({ id: z.string(), status: z.enum(['inProgress', 'completed', 'interrupted', 'failed']), items: z.array(itemSchema).default([]), startedAt: z.number().nullish(),
  completedAt: z.number().nullish(), durationMs: z.number().nonnegative().nullish(), error: z.object({ message: z.string() }).nullish() })
const threadSchema = z.object({ id: z.string(), turns: z.array(turnSchema).default([]), status: z.object({ type: z.string() }).optional() })
const threadResponse = z.object({ thread: threadSchema })
const settingsResponse = threadResponse.extend({ model: z.string(), reasoningEffort: z.string().nullish(),
  approvalPolicy: z.string(), approvalsReviewer: z.string(), sandbox: z.object({ type: z.string() }) })
const notificationSchema = z.object({ threadId: z.string(), turnId: z.string().optional(), turn: turnSchema.optional(), item: itemSchema.optional(), itemId: z.string().optional(), delta: z.string().optional(), requestId: z.union([z.string(), z.number()]).optional(),
  startedAtMs: z.number().optional(), completedAtMs: z.number().optional(), summaryIndex: z.number().optional(), message: z.string().optional(),
  error: z.object({ message: z.string() }).optional(), willRetry: z.boolean().optional(), status: z.object({ type: z.string() }).optional(),
  explanation: z.string().nullish(), plan: z.array(z.object({ step: z.string(), status: z.string() })).optional() })
class Uncertain extends Error {}
class Rejected extends Error {
  readonly unmaterializedThreadId: string | undefined
  readonly missingThreadId: string | undefined
  constructor(value: unknown) {
    super('Codex rejected the operation. Review the thread before retrying.')
    const error = z.object({ code: z.literal(-32600), message: z.string() }).safeParse(value)
    this.unmaterializedThreadId = error.success
      ? /^thread (\S+) is not materialized yet; includeTurns is unavailable before first user message$/.exec(error.data.message)?.[1]
      : undefined
    this.missingThreadId = error.success ? /^no rollout found for thread id (\S+)$/.exec(error.data.message)?.[1] : undefined
    if (this.missingThreadId) this.message = 'Codex could not find this thread’s saved session. Create a new thread to continue.'
  }
}
type Waiter = { resolve: () => void; reject: (error: Error) => void; apply: (value: unknown) => Promise<void> | void;
  onRejected: (() => Promise<void> | void) | undefined; timer: ReturnType<typeof setTimeout> }

export interface CodexAppServerHostOptions {
  userDataPath: string; executable?: string; args?: string[]; codexHome?: string; requestTimeoutMs?: number; pollIntervalMs?: number
}

/** Provider session aliases isolate server-assigned Codex thread IDs from Sotto's thread interface. */
export class CodexAppServerHost implements AgentHost {
  private readonly aliasStore: AtomicJsonStore<Record<string, Alias>>
  private readonly projectStore: AtomicJsonStore<AgentHostSnapshot['projects']>
  private aliases: Record<string, Alias> = {}
  private readonly providerSessionIds = new Map<string, string>()
  private readonly threads = new Map<string, AgentThread>()
  private readonly live = new Set<string>()
  private readonly observed = new Set<string>()
  private readonly resuming = new Map<string, Promise<void>>()
  private readonly threadReads = new Map<string, Promise<void>>()
  private readonly revisions = new Map<string, number>()
  private readonly dispatching = new Set<string>()
  private readonly runningTurns = new Map<string, string>()
  private readonly terminalTurns = new Set<string>()
  private readonly turnDates = new Map<string, string>()
  private readonly fileSummaries = new Map<string, string>()
  private activity = new CodexActivityProjection()
  private readonly completedMessages = new Set<string>()
  private readonly requests = new Map<string, CodexPendingRequest>()
  private readonly inFlightRequestIds = new Set<string>()
  private readonly waiters = new Map<string, Waiter>()
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private readonly unconfirmedDispatchSessionIds = new Set<string>()
  private readonly creating = new Set<string>()
  private child: ChildProcessWithoutNullStreams | undefined
  private watcher: CodexSessionLogWatcher | undefined
  private stopping: Promise<void> = Promise.resolve()
  private frames: Promise<void> = Promise.resolve()
  private writing: Promise<void> = Promise.resolve()
  private nextId = 0
  private generation = 0
  private skillsRevision = 0
  private readonly loadedSkillCwds = new Set<string>()
  private state: AgentHostSnapshot = { connected: false, name: 'Codex', version: '', projects: [], models: [], threads: [],
    capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true, skills: true, steer: true } }

  constructor(private readonly options: CodexAppServerHostOptions) {
    this.aliasStore = new AtomicJsonStore(join(options.userDataPath, 'codex-threads.json'), aliasesSchema.parse, () => ({}))
    this.projectStore = new AtomicJsonStore(join(options.userDataPath, 'codex-projects.json'), z.array(agentProjectSchema).parse, () => [])
  }
  async connect(): Promise<AgentHostSnapshot> {
    this.shutdown(false); await this.closed()
    const generation = this.generation
    const [aliases, projects, executable] = await Promise.all([this.aliasStore.read(), this.projectStore.read(), this.options.executable ?? findExecutable()])
    if (generation !== this.generation) throw new Error('Codex connection was cancelled.')
    if (!executable) throw new Error('Install Codex and sign in before connecting this provider.')
    this.aliases = aliases; this.state.projects = projects
    this.providerSessionIds.clear()
    for (const [id, alias] of Object.entries(aliases)) this.providerSessionIds.set(alias.codexThreadId, id)
    this.threads.clear(); this.terminalTurns.clear(); this.runningTurns.clear(); this.turnDates.clear()
    this.activity = new CodexActivityProjection(); this.completedMessages.clear(); this.fileSummaries.clear()
    const codexHome = this.options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
    this.watcher = new CodexSessionLogWatcher({ codexHome, pollIntervalMs: this.options.pollIntervalMs, onMessage: (id, message) => {
      const sessionId = this.sessionId(id)
      if (sessionId) { this.touch(sessionId); this.addMessage(sessionId, message); this.emit() }
    } })
    for (const [id, alias] of Object.entries(aliases)) {
      this.ensureThread(id)
      this.watcher.observe(alias.codexThreadId)
      for (const origin of alias.origins) this.watcher.sentDigest(alias.codexThreadId, origin.messageId, origin.digest)
    }
    const child = spawn(executable, this.options.args ?? ['app-server', '--stdio', ...configArguments], {
      cwd: this.options.userDataPath, env: { ...nativeEnvironment(), CODEX_HOME: codexHome }, windowsHide: true, shell: false, stdio: 'pipe',
    })
    this.child = child
    let buffer = ''; let stderrBytes = 0; let queuedBytes = 0
    const ended = new Promise<void>(resolve => child.once('close', () => { if (this.child === child) this.lostChild(); resolve() }))
    this.stopping = ended
    child.on('error', () => { if (this.child === child) this.lostChild() })
    child.stdin.on('error', () => { if (this.child === child) this.lostChild() })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return
      buffer += chunk
      if (Buffer.byteLength(buffer) > MAX_OUTPUT_BYTES) { this.lostChild(); return }
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        const bytes = Buffer.byteLength(line)
        queuedBytes += bytes
        if (queuedBytes > MAX_OUTPUT_BYTES) { this.lostChild(); return }
        this.frames = this.frames.then(async () => {
          try { if (this.child === child) await this.frame(rpcSchema.parse(JSON.parse(line))) }
          finally { queuedBytes -= bytes }
        }).catch(() => { if (this.child === child) this.lostChild() })
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > MAX_OUTPUT_BYTES && this.child === child) this.lostChild() })
    try {
      await this.rpc('initialize', { clientInfo: { name: 'sotto', title: 'Sotto threads', version: '1.0' }, capabilities: { experimentalApi: true } }, value => {
        const result = z.object({ userAgent: z.string().optional(), version: z.string().optional() }).parse(value)
        this.state.version = result.version ?? result.userAgent ?? ''
      })
      this.write({ method: 'initialized' })
      this.state.models = []; delete this.state.error
      await this.rpc('model/list', { limit: 100, includeHidden: false }, value => {
        const result = z.object({ data: z.array(z.object({ model: z.string(), displayName: z.string(), hidden: z.boolean().optional(),
          supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })).optional(), defaultReasoningEffort: z.string().optional(),
        })) }).parse(value)
        const models = result.data.filter(m => !m.hidden).map(m => ({ id: m.model, name: m.displayName, provider: 'Codex', ready: true,
          reasoningEfforts: m.supportedReasoningEfforts?.map(option => option.reasoningEffort) ?? [],
          ...(m.defaultReasoningEffort ? { defaultReasoningEffort: m.defaultReasoningEffort } : {}),
          runtimeModes: [...agentRuntimeModeSchema.options], supportsImages: false,
        }))
        this.state.models = models; delete this.state.error
      }).catch(() => { this.state.models = []; this.state.error = 'Codex models could not be listed. Check Codex and reconnect.' })
      if (this.child !== child) throw new Error('Codex disconnected while connecting.')
      this.state.connected = true
      await Promise.all(Object.keys(this.aliases).map(id => this.resume(id).catch(error => {
        if (!(error instanceof Rejected) || error.missingThreadId !== this.aliases[id]!.codexThreadId) throw error
        // An unavailable saved thread must not take the whole provider offline.
        // Its alias remains intact; never replace the native session implicitly.
      })))
      await this.watcher.poll(); this.watcher.start()
      this.emit(); return this.snapshot()
    } catch (error) { if (this.child === child) this.disconnect(); throw error }
  }
  async listThreadSkills(threadId: string, forceReload = false, scope?: AgentSkillScope): Promise<AgentSkillCatalog> {
    if (!this.state.connected) throw new Error('Reconnect Codex before browsing skills.')
    const cwd = this.aliases[threadId]?.cwd ?? (scope?.providerId === 'codex' ? scope.workingDirectory : undefined)
    if (!cwd || !isAbsolute(cwd)) throw new Error('This thread has no available Codex working folder.')
    const generation = this.generation; const revision = this.skillsRevision
    let catalog: AgentSkillCatalog | undefined
    let invalid = false
    try {
      if (!(await stat(cwd)).isDirectory()) throw new Error('The thread working folder is unavailable.')
      await this.rpc('skills/list', { cwds: [cwd], forceReload: forceReload || !this.loadedSkillCwds.has(cwd) }, value => {
        // A malformed read must not tear down running coding threads.
        try { catalog = parseCodexSkillCatalog(value, threadId, cwd) } catch { invalid = true }
      })
      if (invalid || !catalog) throw new Error('Codex returned an invalid skill catalog.')
      if (generation !== this.generation || revision !== this.skillsRevision || !this.state.connected) throw new Error('Codex skills changed while loading. Refresh the catalog.')
      this.loadedSkillCwds.add(cwd)
      return structuredClone(catalog)
    } catch {
      this.loadedSkillCwds.delete(cwd)
      return { threadId, providerId: 'codex', cwd, status: 'error', skills: [], errors: [],
        error: 'Codex skills could not be listed. Check Codex and refresh skills.' }
    }
  }
  /** Send and steer share native reference validation and input mapping. */
  async prepareSkillInput(threadId: string, text: string, skills: readonly AgentSkillReference[] = []) {
    if (!skills.length) return [{ type: 'text' as const, text }]
    return codexSkillInput(text, skills, await this.listThreadSkills(threadId, true))
  }
  private ensureThread(id: string): AgentThread {
    const alias = this.aliases[id]!
    if (!this.threads.has(id)) this.threads.set(id, { id, projectId: alias.projectId, workingDirectory: alias.cwd, title: alias.title, modelId: alias.modelId,
      runtimeMode: alias.runtimeMode ?? 'auto-accept-edits', ...(alias.reasoningEffort ? { reasoningEffort: alias.reasoningEffort } : {}), status: 'idle', messages: [], requests: [] })
    return this.threads.get(id)!
  }
  private sessionId(codexThreadId: string): string | undefined { return this.providerSessionIds.get(codexThreadId) }
  private current(): AgentHostSnapshot { return structuredClone({ ...this.state, threads: [...this.threads.values()] }) }
  private emit(): void { for (const listener of this.listeners) listener(this.current()) }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private persist(): Promise<void> {
    this.writing = this.aliasStore.write(structuredClone(this.aliases))
    return this.writing
  }
  async pollSessionLogs(): Promise<void> { await this.watcher?.poll() }
  async snapshot(): Promise<AgentHostSnapshot> {
    await this.pollSessionLogs()
    const pending = new Set([...Object.keys(this.aliases).filter(id => this.aliases[id]!.pendingSettings), ...this.unconfirmedDispatchSessionIds])
    if (this.state.connected) await Promise.all([...pending].map(id => this.refreshThread(id).catch(() => undefined)))
    return this.current()
  }
  async refreshThread(id: string): Promise<AgentHostSnapshot> {
    if (!this.aliases[id]) throw new Error('That Codex thread is unavailable.')
    const generation = this.generation
    const work = (this.threadReads.get(id) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (generation !== this.generation || !this.state.connected) throw new Error('Codex connection changed while reading the thread.')
      await this.resume(id)
      const alias = this.aliases[id]!
      // Read an uncertain settings save without replaying its overrides.
      if (alias.pendingSettings) await this.rpc('thread/resume', { threadId: alias.codexThreadId, excludeTurns: false }, value => this.applySettings(id, value))
      let applied = false
      for (let attempt = 0; attempt < 3 && !applied; attempt++) {
        const revision = this.revisions.get(id)
        let current = true
        try {
          const apply = (value: unknown): void => {
            // A late read must not overwrite streamed text, a completion, or a permission.
            if (!current || generation !== this.generation || revision !== this.revisions.get(id)) return
            this.applyThread(id, threadResponse.parse(value).thread); applied = true
          }
          try { await this.rpc('thread/read', { threadId: alias.codexThreadId, includeTurns: true }, apply) }
          catch (error) {
            // Codex has live metadata but no transcript before the first message.
            // Read that metadata only for this exact response on a pristine thread.
            if (!(error instanceof Rejected) || error.unmaterializedThreadId !== alias.codexThreadId
              || this.ensureThread(id).messages.length || this.runningTurns.has(id)) throw error
            await this.rpc('thread/read', { threadId: alias.codexThreadId, includeTurns: false }, apply)
          }
        } finally { current = false }
      }
      if (!applied) throw new Error('The Codex thread changed while reading it. Review its current state before replying.')
      await this.watcher?.pollThread(alias.codexThreadId)
      if (generation !== this.generation || !this.state.connected) throw new Error('Codex connection changed while reading the thread.')
    })
    this.threadReads.set(id, work)
    try { await work; return this.current() }
    finally { if (this.threadReads.get(id) === work) this.threadReads.delete(id) }
  }
  private touch(id: string): void { this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1) }
  observeThreads(sessionIds: readonly string[]): void {
    for (const id of sessionIds) this.observed.add(id)
    if (this.state.connected) for (const id of this.observed) void this.resume(id).catch(() => { this.ensureThread(id).status = 'error'; this.emit() })
  }
  private resume(id: string): Promise<void> {
    if (!this.aliases[id] || this.live.has(id)) return Promise.resolve()
    const pending = this.resuming.get(id)
    if (pending) return pending
    const alias = this.aliases[id]!
    const operation = this.rpc('thread/resume', alias.pendingSettings ? { threadId: alias.codexThreadId, cwd: alias.cwd, excludeTurns: false } : { threadId: alias.codexThreadId, cwd: alias.cwd, model: alias.modelId, modelProvider: 'openai',
      ...runtimePolicy(alias.runtimeMode), ...(alias.reasoningEffort ? { config: { model_reasoning_effort: alias.reasoningEffort } } : {}), excludeTurns: false }, value => {
      if (alias.pendingSettings) return this.applySettings(id, value)
      this.applyThread(id, threadResponse.parse(value).thread); this.live.add(id)
      const thread = this.ensureThread(id); delete thread.historyStatus; delete thread.historyError
      this.emit()
    }).catch(error => {
      if (error instanceof Rejected && error.missingThreadId === alias.codexThreadId) {
        const thread = this.ensureThread(id)
        thread.status = 'error'; thread.historyStatus = 'error'; thread.historyError = error.message
        this.emit()
      }
      throw error
    }).finally(() => { this.resuming.delete(id) })
    this.resuming.set(id, operation); return operation
  }
  private addMessage(id: string, message: AgentMessage): void {
    const thread = this.ensureThread(id)
    const index = thread.messages.findIndex(m => m.id === message.id)
    if (index < 0) thread.messages.push(message)
    else thread.messages[index] = { ...message, createdAt: thread.messages[index]!.createdAt }
  }
  private applyItem(id: string, item: z.infer<typeof itemSchema>, turnId?: string, createdAt?: string,
    lifecycle: { phase: 'started' | 'completed' | 'history'; startedAtMs?: number | undefined; completedAtMs?: number | undefined; afterMessageId?: string | undefined; terminal?: boolean | undefined } = { phase: 'history' }): void {
    const thread = this.ensureThread(id)
    if (turnId) this.activity.item(thread, item, { ...lifecycle, turnId, afterMessageId: lifecycle.afterMessageId ?? thread.messages.at(-1)?.id })
    if (item.type === 'fileChange') {
      this.fileSummaries.set(item.id, (item.changes ?? []).map(c => `${c.kind?.type ?? 'change'}: ${c.path}`).join('\n'))
      return
    }
    if (item.type !== 'userMessage' && item.type !== 'agentMessage') return
    const messageKey = JSON.stringify([id, item.id])
    if (item.type === 'agentMessage' && lifecycle.phase === 'started' && this.completedMessages.has(messageKey)) return
    if (item.type === 'agentMessage' && (lifecycle.phase === 'completed' || lifecycle.terminal)) this.completedMessages.add(messageKey)
    const alias = this.aliases[id]!
    const text = item.type === 'agentMessage' ? item.text ?? '' : textOf(z.array(z.object({ type: z.string(), text: z.string().optional() })).optional().parse(item.content))
    let origin: Origin | undefined
    if (item.type === 'userMessage') {
      origin = alias.origins.find(o => o.itemId === item.id || o.messageId === item.clientId)
        ?? alias.origins.find(o => !o.itemId && o.digest === promptDigest(text) && (!o.turnId || o.turnId === turnId))
      if (origin && origin.itemId !== item.id) { origin.itemId = item.id; origin.turnId = turnId; void this.persist().catch(() => this.lostChild()) }
    }
    this.addMessage(id, { id: origin?.messageId ?? item.id, role: item.type === 'userMessage' ? 'user' : 'assistant', text,
      createdAt: origin?.createdAt ?? createdAt ?? this.turnDates.get(turnId ?? '') ?? alias.createdAt, ...(origin ? { commandId: origin.commandId } : {}) })
    if (item.type === 'userMessage' && turnId) this.activity.anchor(thread, turnId, origin?.messageId ?? item.id)
    if (origin) this.unconfirmedDispatchSessionIds.delete(id)
  }
  private applyTurn(id: string, turn: z.infer<typeof turnSchema>, live = false): void {
    const thread = this.ensureThread(id)
    const createdAt = turn.startedAt ? new Date(turn.startedAt * 1000).toISOString() : this.aliases[id]!.createdAt
    this.turnDates.set(turn.id, createdAt)
    // A delayed start response must never resurrect a turn whose completion already arrived.
    if (turn.status === 'inProgress' && this.terminalTurns.has(turn.id)) return
    let anchor = thread.messages.at(-1)?.id
    for (const item of turn.items) {
      this.applyItem(id, item, turn.id, createdAt, { phase: 'history', afterMessageId: anchor, terminal: turn.status !== 'inProgress' })
      if (item.type === 'userMessage' || item.type === 'agentMessage') anchor = this.aliases[id]!.origins.find(origin => origin.itemId === item.id)?.messageId ?? item.id
    }
    this.activity.turn(thread, turn, live)
    if (!this.runningTurns.has(id) || this.runningTurns.get(id) === turn.id || turn.status === 'inProgress') {
      thread.lastTurn = { id: turn.id, status: turn.status === 'inProgress' ? 'running' : turn.status }
    }
    if (turn.status === 'inProgress') { this.runningTurns.set(id, turn.id); thread.status = 'running' }
    else {
      this.terminalTurns.add(turn.id)
      if (!this.runningTurns.has(id) || this.runningTurns.get(id) === turn.id) {
        this.runningTurns.delete(id); thread.status = turn.status === 'failed' ? 'error' : 'idle'
      }
    }
  }
  private applyThread(id: string, thread: z.infer<typeof threadSchema>): void {
    if (thread.id !== this.aliases[id]!.codexThreadId) throw new Error('Codex returned a different provider session.')
    for (const turn of thread.turns) this.applyTurn(id, turn)
    if (thread.status?.type === 'systemError') this.ensureThread(id).status = 'error'
    else if (thread.status?.type === 'active') this.ensureThread(id).status = 'running'
    else if (thread.status?.type === 'idle') {
      this.runningTurns.delete(id)
      if (thread.turns.at(-1)?.status !== 'failed') this.ensureThread(id).status = 'idle'
    }
  }
  private async applySettings(id: string, value: unknown): Promise<void> {
    const alias = this.aliases[id]!
    const desired = alias.pendingSettings
    if (!desired) return
    const response = settingsResponse.parse(value)
    const policy = runtimePolicy(desired.runtimeMode)
    const sandboxType = policy.sandbox === 'read-only' ? 'readOnly' : policy.sandbox === 'workspace-write' ? 'workspaceWrite' : 'dangerFullAccess'
    if (response.model !== desired.modelId || response.approvalPolicy !== policy.approvalPolicy || response.approvalsReviewer !== policy.approvalsReviewer || response.sandbox.type !== sandboxType
      || desired.reasoningEffort !== undefined && response.reasoningEffort !== desired.reasoningEffort) throw new Error('Codex did not confirm the selected thread settings.')
    alias.modelId = response.model; alias.runtimeMode = desired.runtimeMode; alias.reasoningEffort = response.reasoningEffort ?? undefined
    delete alias.pendingSettings
    const thread = this.ensureThread(id)
    thread.modelId = alias.modelId; thread.runtimeMode = alias.runtimeMode; thread.reasoningEffort = alias.reasoningEffort
    this.applyThread(id, response.thread); this.live.add(id); await this.persist(); this.emit()
  }
  async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (!this.state.connected) throw new Error('Connect to Codex before sending a command.')
    if (command.type === 'create-project') {
      if (!isAbsolute(command.path)) throw new Error('Choose an absolute project path.')
      const project = { id: command.projectId, title: command.title, path: command.path }
      const projects = [...this.state.projects.filter(p => p.id !== project.id), project]
      await this.projectStore.write(projects); this.state.projects = projects; this.emit(); return { accepted: true }
    }
    try {
      if (command.type === 'create-thread') {
        if (this.aliases[command.threadId]) return { accepted: true }
        if (this.creating.has(command.threadId)) return { accepted: false, uncertain: true }
        const project = this.state.projects.find(p => p.id === command.projectId)
        if (!project) throw new Error('Choose a known Codex project.')
        if (!this.state.models.some(m => m.id === command.modelId && m.ready)) throw new Error('Choose an available Codex model.')
        validateThreadOptions(this.state, command)
        const cwd = await existingWorkingDirectory(command.workingDirectory ?? project.path)
        this.creating.add(command.threadId)
        await this.rpc('thread/start', { cwd, model: command.modelId, modelProvider: 'openai', allowProviderModelFallback: false,
          ...runtimePolicy(command.runtimeMode), ...(command.reasoningEffort ? { config: { model_reasoning_effort: command.reasoningEffort } } : {}), ephemeral: false, historyMode: 'legacy' }, async value => {
          const response = settingsResponse.parse(value)
          const policy = runtimePolicy(command.runtimeMode)
          const sandboxType = policy.sandbox === 'read-only' ? 'readOnly' : policy.sandbox === 'workspace-write' ? 'workspaceWrite' : 'dangerFullAccess'
          if (response.model !== command.modelId || response.approvalPolicy !== policy.approvalPolicy || response.approvalsReviewer !== policy.approvalsReviewer
            || response.sandbox.type !== sandboxType || command.reasoningEffort !== undefined && response.reasoningEffort !== command.reasoningEffort) throw new Error('Codex did not confirm the requested thread options.')
          this.aliases[command.threadId] = { codexThreadId: response.thread.id, projectId: command.projectId, cwd,
            title: command.title, modelId: command.modelId,
            runtimeMode: command.runtimeMode ?? 'auto-accept-edits', ...(response.reasoningEffort ? { reasoningEffort: response.reasoningEffort } : {}),
            createdAt: new Date().toISOString(), origins: [] }
          this.providerSessionIds.set(response.thread.id, command.threadId)
          await this.persist(); this.creating.delete(command.threadId); this.ensureThread(command.threadId); this.live.add(command.threadId)
          this.watcher?.observe(response.thread.id); this.applyThread(command.threadId, response.thread); this.emit()
        }, () => { this.creating.delete(command.threadId) })
      } else {
        const id = command.threadId; const alias = this.aliases[id]
        if (!alias) throw new Error('This Codex provider session is unknown.')
        if (alias.pendingSettings && command.type !== 'interrupt' && command.type !== 'answer') return { accepted: false, uncertain: true }
        if (command.type === 'configure-thread') {
          const thread = this.ensureThread(id)
          if (thread.status === 'running' || thread.requests.length) throw new Error('Wait for the thread and resolve pending requests before changing settings.')
          validateThreadOptions(this.state, command, alias.modelId)
          const modelId = command.modelId ?? alias.modelId
          const reasoningEffort = command.reasoningEffort ?? (command.modelId !== undefined
            ? this.state.models.find(model => model.id === modelId)?.defaultReasoningEffort : alias.reasoningEffort)
          const mode = command.runtimeMode ?? alias.runtimeMode ?? 'auto-accept-edits'
          const policy = runtimePolicy(mode)
          alias.pendingSettings = { modelId, reasoningEffort, runtimeMode: mode }
          await this.persist()
          await this.rpc('thread/resume', { threadId: alias.codexThreadId, cwd: alias.cwd, model: modelId, modelProvider: 'openai',
            ...policy, config: { model_reasoning_effort: reasoningEffort ?? null }, excludeTurns: false }, value => this.applySettings(id, value), async () => {
            delete alias.pendingSettings; await this.persist()
          })
        } else if (command.type === 'steer') {
          const thread = this.ensureThread(id)
          const expectedTurnId = this.runningTurns.get(id)
          const generation = this.generation
          let skillsRevision: number | undefined
          const validate = (): void => {
            if (generation !== this.generation || !this.state.connected) throw new Error('Codex connection changed before steering. Review this prompt.')
            if (command.skills?.length && skillsRevision !== undefined && skillsRevision !== this.skillsRevision) throw new Error('Codex skills changed before steering. Refresh skills and review the selection.')
            if (!expectedTurnId || this.runningTurns.get(id) !== expectedTurnId || thread.status !== 'running') throw new Error('The active Codex turn changed. Queue this follow-up instead.')
            if (thread.requests.length) throw new Error('Answer the pending Codex request explicitly before steering.')
            if (command.expectedLastUserMessageId !== undefined && command.expectedLastUserMessageId !== (thread.messages.findLast(m => m.role === 'user')?.id ?? null)) throw new Error('The thread changed in Codex. Review it before steering.')
          }
          validatePromptAttachments(this.state, alias.modelId, command.attachments)
          if (alias.origins.some(o => o.messageId === command.messageId)) return thread.messages.some(m => m.id === command.messageId) ? { accepted: true } : { accepted: false, uncertain: true }
          validate()
          if (this.dispatching.has(id)) throw new Error('A Codex prompt is already being submitted.')
          this.dispatching.add(id)
          let input: Awaited<ReturnType<CodexAppServerHost['prepareSkillInput']>>
          try {
            input = await this.prepareSkillInput(id, command.text, command.skills)
            skillsRevision = this.skillsRevision
            validate()
          } catch (error) { this.dispatching.delete(id); throw error }
          const origin: Origin = { messageId: command.messageId, commandId: command.commandId, digest: promptDigest(command.text), createdAt: new Date().toISOString(), turnId: expectedTurnId! }
          alias.origins.push(origin)
          try {
            try { await this.persist(); await this.watcher?.pollThread(alias.codexThreadId); validate() }
            catch (error) { alias.origins = alias.origins.filter(o => o !== origin); await this.persist(); throw error }
            this.watcher?.sent(alias.codexThreadId, command.messageId, command.text)
            await this.rpc('turn/steer', { threadId: alias.codexThreadId, expectedTurnId, input }, async value => {
              const response = z.object({ turnId: z.string() }).parse(value)
              if (response.turnId !== expectedTurnId) throw new Error('Codex acknowledged steering a different turn.')
              if (!thread.messages.some(m => m.id === origin.messageId)) this.addMessage(id, { id: origin.messageId, commandId: origin.commandId, role: 'user', text: command.text, createdAt: origin.createdAt })
              this.unconfirmedDispatchSessionIds.delete(id); this.emit(); await this.persist()
            }, async () => {
              alias.origins = alias.origins.filter(o => o !== origin)
              this.watcher?.forget(alias.codexThreadId, origin.messageId); this.unconfirmedDispatchSessionIds.delete(id); await this.persist()
            })
          } catch (error) {
            if (error instanceof Uncertain) this.unconfirmedDispatchSessionIds.add(id)
            throw error
          } finally { this.dispatching.delete(id) }
        } else if (command.type === 'answer') {
          const pending = this.requests.get(command.requestId)
          if (!pending || pending.sessionId !== id) throw new Error('This Codex request is no longer pending.')
          const result = answerRequest(pending, command.answer, command.approved)
          await this.respond(pending, result)
        } else if (command.type === 'interrupt') {
          await this.decline(id)
          const turnId = this.runningTurns.get(id)
          if (turnId) await this.rpc('turn/interrupt', { threadId: alias.codexThreadId, turnId }, () => {
            this.ensureThread(id).lastTurn = { id: turnId, status: 'interrupted' }
            this.activity.turn(this.ensureThread(id), { id: turnId, status: 'interrupted' }, true)
            this.terminalTurns.add(turnId); this.runningTurns.delete(id); this.ensureThread(id).status = 'idle'; this.emit()
          })
        } else {
          // Image rollout origins need a separate authority-safe reconciliation
          // contract. Until supported, reject explicitly rather than drop images.
          validatePromptAttachments(this.state, alias.modelId, command.attachments)
          try { await this.refreshThread(id) }
          catch (error) { throw error instanceof Uncertain ? new Error('Codex history could not be verified before sending the prompt.', { cause: error }) : error }
          if (command.expectedLastUserMessageId !== undefined && command.expectedLastUserMessageId !== (this.ensureThread(id).messages.findLast(m => m.role === 'user')?.id ?? null)) {
            throw new Error('The thread changed in Codex before Sotto could reply. Review its manual control state.')
          }
          if (alias.origins.some(o => o.messageId === command.messageId)) return this.ensureThread(id).messages.some(m => m.id === command.messageId) ? { accepted: true } : { accepted: false, uncertain: true }
          if (this.dispatching.has(id) || this.ensureThread(id).status === 'running') throw new Error('Codex is already running a turn.')
          if (this.ensureThread(id).requests.length) throw new Error('Answer the pending Codex request before sending another prompt.')
          this.dispatching.add(id)
          const generation = this.generation
          let input: Awaited<ReturnType<CodexAppServerHost['prepareSkillInput']>>
          try { input = await this.prepareSkillInput(id, command.text, command.skills) }
          catch (error) { this.dispatching.delete(id); throw error }
          const skillsRevision = this.skillsRevision
          const origin: Origin = { messageId: command.messageId, commandId: command.commandId, digest: promptDigest(command.text), createdAt: new Date().toISOString() }
          alias.origins.push(origin)
          try {
            await this.persist()
            // Runtime requests arrive on the subscribed native stream. Re-read authored
            // input after persistence, before registering this prompt as our own input.
            await this.watcher?.pollThread(alias.codexThreadId)
            if (generation !== this.generation || !this.state.connected) throw new Error('Codex connection changed before sending the prompt.')
            if (command.skills?.length && skillsRevision !== this.skillsRevision) throw new Error('Codex skills changed before sending. Refresh skills and review the selection.')
            if (command.expectedLastUserMessageId !== undefined && command.expectedLastUserMessageId !== (this.ensureThread(id).messages.findLast(message => message.role === 'user')?.id ?? null)) throw new Error('The thread changed in Codex before Sotto could reply. Review its manual control state.')
            if (this.ensureThread(id).status === 'running' || this.ensureThread(id).requests.length) throw new Error('The Codex thread started working or needs an answer before another prompt.')
          } catch (error) {
            alias.origins = alias.origins.filter(candidate => candidate !== origin); this.dispatching.delete(id)
            await this.persist(); throw error
          }
          this.watcher?.sent(alias.codexThreadId, command.messageId, command.text)
          try {
            await this.rpc('turn/start', { threadId: alias.codexThreadId, cwd: alias.cwd, clientUserMessageId: command.messageId,
              input, approvalPolicy: runtimePolicy(alias.runtimeMode).approvalPolicy,
              approvalsReviewer: runtimePolicy(alias.runtimeMode).approvalsReviewer,
              ...(alias.reasoningEffort ? { effort: alias.reasoningEffort } : {}) }, value => {
              const { turn } = z.object({ turn: turnSchema }).parse(value)
              origin.turnId = turn.id
              this.applyTurn(id, turn)
              if (!this.ensureThread(id).messages.some(m => m.id === origin.messageId)) this.addMessage(id, { id: origin.messageId, commandId: origin.commandId, role: 'user', text: command.text, createdAt: origin.createdAt })
              this.unconfirmedDispatchSessionIds.delete(id); this.emit()
              return this.persist()
            }, () => {
              alias.origins = alias.origins.filter(o => o !== origin)
              this.watcher?.forget(alias.codexThreadId, origin.messageId)
              this.unconfirmedDispatchSessionIds.delete(id)
              return this.persist()
            })
          } catch (error) {
            if (!(error instanceof Rejected)) this.unconfirmedDispatchSessionIds.add(id)
            throw error
          } finally { this.dispatching.delete(id) }
        }
      }
      return { accepted: true }
    } catch (error) { if (error instanceof Uncertain) return { accepted: false, uncertain: true }; throw error }
  }
  private async frame(frame: z.infer<typeof rpcSchema>): Promise<void> {
    if (!frame.method && frame.id !== undefined) {
      const key = JSON.stringify(frame.id); const waiter = this.waiters.get(key)
      if (!waiter) return
      clearTimeout(waiter.timer); this.waiters.delete(key)
      try {
        if (frame.error !== undefined) { await waiter.onRejected?.(); waiter.reject(new Rejected(frame.error)) }
        else { await waiter.apply(frame.result); waiter.resolve() }
      } catch { waiter.reject(new Uncertain('Codex response could not be applied.')); this.lostChild() }
      return
    }
    if (frame.method === 'skills/changed' || frame.method === 'account/updated') {
      this.skillsRevision++; this.loadedSkillCwds.clear(); return
    }
    if (frame.method === 'thread/started') {
      const { thread } = threadResponse.parse(frame.params); const id = this.sessionId(thread.id)
      if (id) { this.touch(id); this.applyThread(id, thread); this.emit() }
      return
    }
    if (frame.method && frame.id !== undefined) {
      const params = z.object({ threadId: z.string() }).safeParse(frame.params)
      const id = params.success ? this.sessionId(params.data.threadId) : undefined
      const parsed = id ? pendingRequest(frame.id, frame.method, frame.params, id,
        this.fileSummaries.get(z.object({ itemId: z.string().optional() }).parse(frame.params).itemId ?? '')) : undefined
      if (!parsed) { this.write({ id: frame.id, error: { code: -32601, message: 'Sotto does not handle this request.' } }); return }
      this.touch(id!); this.requests.set(parsed.request.id, parsed); this.ensureThread(id!).requests.push(parsed.request); this.emit(); return
    }
    if (!['turn/started', 'turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta', 'error', 'serverRequest/resolved',
      'item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'item/reasoning/summaryTextDelta', 'item/plan/delta', 'item/mcpToolCall/progress',
      'turn/plan/updated', 'thread/status/changed'].includes(frame.method ?? '')) return
    const params = notificationSchema.parse(frame.params); const id = this.sessionId(params.threadId)
    if (!id) {
      const owner = this.activity.childNotification(params.threadId, frame.method!, params)
      if (owner) { this.touch(owner.id); this.emit() }
      return
    }
    this.touch(id)
    if (params.turn) this.applyTurn(id, params.turn, true)
    if (params.item) this.applyItem(id, params.item, params.turnId, undefined, { phase: frame.method === 'item/started' ? 'started' : 'completed', startedAtMs: params.startedAtMs, completedAtMs: params.completedAtMs })
    if (frame.method === 'item/agentMessage/delta' && params.itemId && params.delta !== undefined
      && !this.completedMessages.has(JSON.stringify([id, params.itemId])) && !this.terminalTurns.has(params.turnId ?? '')) {
      const previous = this.ensureThread(id).messages.find(m => m.id === params.itemId)
      this.addMessage(id, { id: params.itemId, role: 'assistant', text: (previous?.text ?? '') + params.delta,
        createdAt: previous?.createdAt ?? this.turnDates.get(params.turnId ?? '') ?? this.aliases[id]!.createdAt })
    }
    if (['item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'item/reasoning/summaryTextDelta', 'item/plan/delta', 'item/mcpToolCall/progress'].includes(frame.method!)) {
      this.activity.delta(this.ensureThread(id), frame.method!, params)
    }
    if (frame.method === 'turn/plan/updated' && params.turnId && params.plan) this.activity.plan(this.ensureThread(id), params.turnId, params.plan, params.explanation)
    if (frame.method === 'thread/status/changed' && params.status) {
      const thread = this.ensureThread(id)
      thread.status = params.status.type === 'active' ? 'running' : params.status.type === 'systemError' ? 'error' : 'idle'
      if (thread.status !== 'running') this.runningTurns.delete(id)
    }
    if (frame.method === 'error') {
      if (params.error && params.turnId) this.activity.error(this.ensureThread(id), params.turnId, params.error.message, params.willRetry === true)
      if (!params.willRetry) {
        this.ensureThread(id).status = 'error'
        if (params.turnId) {
          this.terminalTurns.add(params.turnId); this.runningTurns.delete(id)
          this.ensureThread(id).lastTurn = { id: params.turnId, status: 'failed' }
          this.activity.turn(this.ensureThread(id), { id: params.turnId, status: 'failed', error: params.error }, true)
        }
      }
    }
    if (frame.method === 'serverRequest/resolved' && params.requestId !== undefined) this.removeRequest(requestKey(params.requestId))
    this.emit()
  }
  private write(value: unknown): void {
    if (!this.child || this.child.stdin.destroyed) throw new Uncertain('Codex connection closed before acknowledgement.')
    this.child.stdin.write(JSON.stringify(value) + '\n')
  }
  private rpc(method: string, params: unknown, apply: Waiter['apply'] = () => undefined, onRejected?: Waiter['onRejected']): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      // Keep the callback after timeout: late thread/start responses still establish durable aliases.
      const timer = setTimeout(() => reject(new Uncertain('Codex did not acknowledge the operation in time.')), this.options.requestTimeoutMs ?? 15000)
      this.waiters.set(JSON.stringify(id), { resolve, reject, apply, onRejected, timer })
      try { this.write({ id, method, params }) } catch (error) { clearTimeout(timer); this.waiters.delete(JSON.stringify(id)); reject(error) }
    })
  }
  private removeRequest(id: string): void {
    const pending = this.requests.get(id)
    if (!pending) return
    this.requests.delete(id); this.ensureThread(pending.sessionId).requests = this.ensureThread(pending.sessionId).requests.filter(r => r.id !== id)
  }
  private async respond(pending: CodexPendingRequest, result: unknown): Promise<void> {
    const child = this.child
    if (!child) throw new Uncertain('Codex disconnected before receiving the answer.')
    this.inFlightRequestIds.add(pending.request.id)
    this.removeRequest(pending.request.id); this.emit()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Uncertain('Codex answer delivery is uncertain.')), this.options.requestTimeoutMs ?? 15000)
      child.stdin.write(JSON.stringify({ id: pending.id, result }) + '\n', error => {
        clearTimeout(timer); this.inFlightRequestIds.delete(pending.request.id)
        if (error) reject(new Uncertain('Codex answer delivery is uncertain.')); else resolve()
      })
    })
  }
  private async decline(sessionId: string): Promise<void> {
    for (const pending of [...this.requests.values()]) {
      if (pending.sessionId === sessionId && this.requests.has(pending.request.id) && !this.inFlightRequestIds.has(pending.request.id)) await this.respond(pending, declineRequest(pending.method))
    }
  }
  private reset(): void {
    this.skillsRevision++; this.loadedSkillCwds.clear()
    this.child = undefined; this.state.connected = false; this.live.clear(); this.resuming.clear()
    for (const waiter of this.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Uncertain('Codex disconnected before acknowledgement.')) }
    this.waiters.clear(); this.requests.clear(); this.inFlightRequestIds.clear()
    for (const thread of this.threads.values()) thread.requests = []
  }
  private lostChild(): void {
    const child = this.child; this.reset(); child?.kill('SIGKILL')
    void this.watcher?.stop()
    this.emit()
  }
  disconnect(): void { this.shutdown(true) }
  private shutdown(publish: boolean): void {
    this.generation++
    const child = this.child
    if (child) {
      for (const pending of this.requests.values()) {
        if (this.inFlightRequestIds.has(pending.request.id)) continue
        try { this.write({ id: pending.id, result: declineRequest(pending.method) }) } catch { /* Closed pipes cannot grant permission. */ }
      }
      // Flush denials before ending stdin; force termination if the server keeps running.
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 100)
      timer.unref(); child.once('close', () => clearTimeout(timer))
    }
    this.reset()
    const watcher = this.watcher; this.watcher = undefined
    this.stopping = Promise.all([this.stopping, watcher?.stop()]).then(() => undefined)
    if (publish) this.emit()
  }
  /** Shutdown barrier for callers removing user data or replacing a host. */
  async closed(): Promise<void> { await this.stopping; await this.frames; await this.writing }
}
