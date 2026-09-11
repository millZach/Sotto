import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { agentProjectSchema, type AgentHostSnapshot, type AgentMessage, type AgentThread } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { AgentHost, AgentHostCommand, AgentHostConnection, AgentHostResult } from './host'
import { findExecutable, nativeEnvironment } from './subscriptionCodex'
import { CodexSessionLogWatcher, promptDigest } from './codexSessions'
import { answerRequest, declineRequest, pendingRequest, type CodexPendingRequest } from './codexRequests'

const MAX_OUTPUT_BYTES = 1024 * 1024
const configArguments = ['model_provider="openai"', 'approval_policy="on-request"', 'approvals_reviewer="user"', 'sandbox_mode="workspace-write"'].flatMap(v => ['-c', v])
const originSchema = z.object({ messageId: z.string(), commandId: z.string(), digest: z.string(), createdAt: z.string(), itemId: z.string().optional(), turnId: z.string().optional() })
const aliasSchema = z.object({ codexThreadId: z.string(), projectId: z.string(), cwd: z.string(), title: z.string(), modelId: z.string(), createdAt: z.string(), origins: z.array(originSchema).default([]) })
const aliasesSchema = z.record(z.string(), aliasSchema)
type Alias = z.infer<typeof aliasSchema>
type Origin = z.infer<typeof originSchema>
const rpcSchema = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(), error: z.unknown().optional() })
const itemSchema = z.object({ id: z.string(), type: z.string(), clientId: z.string().nullish(), text: z.string().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  changes: z.array(z.object({ path: z.string(), kind: z.object({ type: z.string() }).optional() })).optional() })
const turnSchema = z.object({ id: z.string(), status: z.enum(['inProgress', 'completed', 'interrupted', 'failed']), items: z.array(itemSchema).default([]), startedAt: z.number().nullish() })
const threadSchema = z.object({ id: z.string(), turns: z.array(turnSchema).default([]), status: z.object({ type: z.string() }).optional() })
const threadResponse = z.object({ thread: threadSchema })
const notificationSchema = z.object({ threadId: z.string(), turnId: z.string().optional(), turn: turnSchema.optional(), item: itemSchema.optional(), itemId: z.string().optional(), delta: z.string().optional(), requestId: z.union([z.string(), z.number()]).optional() })
class Uncertain extends Error {}
class Rejected extends Error {}
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
  private readonly threads = new Map<string, AgentThread>()
  private readonly live = new Set<string>()
  private readonly observed = new Set<string>()
  private readonly resuming = new Map<string, Promise<void>>()
  private readonly runningTurns = new Map<string, string>()
  private readonly terminalTurns = new Set<string>()
  private readonly turnDates = new Map<string, string>()
  private readonly fileSummaries = new Map<string, string>()
  private readonly requests = new Map<string, CodexPendingRequest>()
  private readonly waiters = new Map<string, Waiter>()
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private readonly uncertainSessions = new Set<string>()
  private readonly creating = new Set<string>()
  private child: ChildProcessWithoutNullStreams | undefined
  private watcher: CodexSessionLogWatcher | undefined
  private stopping: Promise<void> = Promise.resolve()
  private frames: Promise<void> = Promise.resolve()
  private writing: Promise<void> = Promise.resolve()
  private nextId = 0
  private generation = 0
  private state: AgentHostSnapshot = { connected: false, name: 'Codex', version: '', projects: [], models: [], threads: [],
    capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true } }

  constructor(private readonly options: CodexAppServerHostOptions) {
    this.aliasStore = new AtomicJsonStore(join(options.userDataPath, 'codex-threads.json'), aliasesSchema.parse, () => ({}))
    this.projectStore = new AtomicJsonStore(join(options.userDataPath, 'codex-projects.json'), z.array(agentProjectSchema).parse, () => [])
  }
  async connect(_connection: AgentHostConnection): Promise<AgentHostSnapshot> {
    void _connection
    this.shutdown(false); await this.closed()
    const generation = this.generation
    const [aliases, projects, executable] = await Promise.all([this.aliasStore.read(), this.projectStore.read(), this.options.executable ?? findExecutable()])
    if (generation !== this.generation) throw new Error('Codex connection was cancelled.')
    if (!executable) throw new Error('Install Codex and sign in before connecting this provider.')
    this.aliases = aliases; this.state.projects = projects
    this.threads.clear(); this.terminalTurns.clear(); this.runningTurns.clear(); this.turnDates.clear()
    const codexHome = this.options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
    this.watcher = new CodexSessionLogWatcher({ codexHome, pollIntervalMs: this.options.pollIntervalMs, onMessage: (id, message) => {
      const sessionId = this.sessionId(id)
      if (sessionId) { this.addMessage(sessionId, message); this.emit() }
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
      this.state.models = [{ id: 'gpt-5.4', provider: 'Codex', name: 'Codex default', ready: true }]
      await this.rpc('model/list', { limit: 100, includeHidden: false }, value => {
        const result = z.object({ data: z.array(z.object({ model: z.string(), displayName: z.string(), hidden: z.boolean().optional() })) }).parse(value)
        const models = result.data.filter(m => !m.hidden).map(m => ({ id: m.model, name: m.displayName, provider: 'Codex', ready: true }))
        if (models.length) this.state.models = models
      }).catch(() => undefined)
      if (this.child !== child) throw new Error('Codex disconnected while connecting.')
      this.state.connected = true
      await Promise.all(Object.keys(this.aliases).map(id => this.resume(id)))
      await this.watcher.poll(); this.watcher.start()
      this.emit(); return this.snapshot()
    } catch (error) { if (this.child === child) this.disconnect(); throw error }
  }
  private ensureThread(id: string): AgentThread {
    const alias = this.aliases[id]!
    if (!this.threads.has(id)) this.threads.set(id, { id, projectId: alias.projectId, title: alias.title, modelId: alias.modelId, status: 'idle', messages: [], requests: [] })
    return this.threads.get(id)!
  }
  private sessionId(codexThreadId: string): string | undefined { return Object.keys(this.aliases).find(id => this.aliases[id]!.codexThreadId === codexThreadId) }
  private current(): AgentHostSnapshot { return structuredClone({ ...this.state, threads: [...this.threads.values()] }) }
  private emit(): void { for (const listener of this.listeners) listener(this.current()) }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private persist(): Promise<void> {
    this.writing = this.aliasStore.write(structuredClone(this.aliases))
    return this.writing
  }
  async pollSessions(): Promise<void> { await this.watcher?.poll() }
  async snapshot(): Promise<AgentHostSnapshot> {
    await this.pollSessions()
    if (this.state.connected) await Promise.all([...this.uncertainSessions].map(async id => {
      await this.rpc('thread/read', { threadId: this.aliases[id]!.codexThreadId, includeTurns: true }, value => this.applyThread(id, threadResponse.parse(value).thread)).catch(() => undefined)
    }))
    return this.current()
  }
  observeThreads(sessionIds: readonly string[]): void {
    for (const id of sessionIds) this.observed.add(id)
    if (this.state.connected) for (const id of this.observed) void this.resume(id).catch(() => { this.ensureThread(id).status = 'error'; this.emit() })
  }
  private resume(id: string): Promise<void> {
    if (!this.aliases[id] || this.live.has(id)) return Promise.resolve()
    const pending = this.resuming.get(id)
    if (pending) return pending
    const alias = this.aliases[id]!
    const operation = this.rpc('thread/resume', { threadId: alias.codexThreadId, cwd: alias.cwd, model: alias.modelId, modelProvider: 'openai',
      approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', excludeTurns: false }, value => {
      this.applyThread(id, threadResponse.parse(value).thread); this.live.add(id); this.emit()
    }).finally(() => { this.resuming.delete(id) })
    this.resuming.set(id, operation); return operation
  }
  private addMessage(id: string, message: AgentMessage): void {
    const thread = this.ensureThread(id)
    const index = thread.messages.findIndex(m => m.id === message.id)
    if (index < 0) thread.messages.push(message)
    else thread.messages[index] = { ...message, createdAt: thread.messages[index]!.createdAt }
  }
  private applyItem(id: string, item: z.infer<typeof itemSchema>, turnId?: string, createdAt?: string): void {
    if (item.type === 'fileChange') {
      this.fileSummaries.set(item.id, (item.changes ?? []).map(c => `${c.kind?.type ?? 'change'}: ${c.path}`).join('\n'))
      return
    }
    if (item.type !== 'userMessage' && item.type !== 'agentMessage') return
    const alias = this.aliases[id]!
    const text = item.type === 'agentMessage' ? item.text ?? '' : (item.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
    let origin: Origin | undefined
    if (item.type === 'userMessage') {
      origin = alias.origins.find(o => o.itemId === item.id || o.messageId === item.clientId)
        ?? alias.origins.find(o => !o.itemId && o.digest === promptDigest(text) && (!o.turnId || o.turnId === turnId))
      if (origin && origin.itemId !== item.id) { origin.itemId = item.id; origin.turnId = turnId; void this.persist().catch(() => this.lostChild()) }
    }
    this.addMessage(id, { id: origin?.messageId ?? item.id, role: item.type === 'userMessage' ? 'user' : 'assistant', text,
      createdAt: origin?.createdAt ?? createdAt ?? this.turnDates.get(turnId ?? '') ?? alias.createdAt, ...(origin ? { commandId: origin.commandId } : {}) })
    if (origin) this.uncertainSessions.delete(id)
  }
  private applyTurn(id: string, turn: z.infer<typeof turnSchema>): void {
    const thread = this.ensureThread(id)
    const createdAt = turn.startedAt ? new Date(turn.startedAt * 1000).toISOString() : this.aliases[id]!.createdAt
    this.turnDates.set(turn.id, createdAt)
    for (const item of turn.items) this.applyItem(id, item, turn.id, createdAt)
    // A delayed start response must never resurrect a turn whose completion already arrived.
    if (turn.status === 'inProgress' && this.terminalTurns.has(turn.id)) return
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
        this.creating.add(command.threadId)
        await this.rpc('thread/start', { cwd: project.path, model: command.modelId, modelProvider: 'openai', allowProviderModelFallback: false,
          approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', ephemeral: false, historyMode: 'legacy' }, async value => {
          const response = threadResponse.parse(value)
          this.aliases[command.threadId] = { codexThreadId: response.thread.id, projectId: command.projectId, cwd: project.path,
            title: command.title, modelId: command.modelId, createdAt: new Date().toISOString(), origins: [] }
          await this.persist(); this.creating.delete(command.threadId); this.ensureThread(command.threadId); this.live.add(command.threadId)
          this.watcher?.observe(response.thread.id); this.applyThread(command.threadId, response.thread); this.emit()
        }, () => { this.creating.delete(command.threadId) })
      } else {
        const id = command.threadId; const alias = this.aliases[id]
        if (!alias) throw new Error('This Codex provider session is unknown.')
        if (command.type === 'answer') {
          const pending = this.requests.get(command.requestId)
          if (!pending || pending.sessionId !== id) throw new Error('This Codex request is no longer pending.')
          const result = answerRequest(pending, command.answer, command.approved)
          await this.respond(pending, result)
        } else if (command.type === 'interrupt') {
          await this.decline(id)
          const turnId = this.runningTurns.get(id)
          if (turnId) await this.rpc('turn/interrupt', { threadId: alias.codexThreadId, turnId }, () => {
            this.terminalTurns.add(turnId); this.runningTurns.delete(id); this.ensureThread(id).status = 'idle'; this.emit()
          })
        } else {
          await this.resume(id); await this.pollSessions()
          if (command.expectedLastUserMessageId !== undefined && command.expectedLastUserMessageId !== (this.ensureThread(id).messages.findLast(m => m.role === 'user')?.id ?? null)) {
            throw new Error('The thread changed in Codex before Sotto could reply. Review its manual control state.')
          }
          if (alias.origins.some(o => o.messageId === command.messageId)) return this.ensureThread(id).messages.some(m => m.id === command.messageId) ? { accepted: true } : { accepted: false, uncertain: true }
          const origin: Origin = { messageId: command.messageId, commandId: command.commandId, digest: promptDigest(command.text), createdAt: new Date().toISOString() }
          alias.origins.push(origin); await this.persist()
          this.watcher?.sent(alias.codexThreadId, command.messageId, command.text)
          try {
            await this.rpc('turn/start', { threadId: alias.codexThreadId, clientUserMessageId: command.messageId,
              input: [{ type: 'text', text: command.text }], approvalPolicy: 'on-request', approvalsReviewer: 'user' }, value => {
              const { turn } = z.object({ turn: turnSchema }).parse(value)
              origin.turnId = turn.id
              this.applyTurn(id, turn)
              if (!this.ensureThread(id).messages.some(m => m.id === origin.messageId)) this.addMessage(id, { id: origin.messageId, commandId: origin.commandId, role: 'user', text: command.text, createdAt: origin.createdAt })
              this.uncertainSessions.delete(id); this.emit()
              return this.persist()
            }, () => {
              alias.origins = alias.origins.filter(o => o !== origin)
              this.watcher?.forget(alias.codexThreadId, origin.messageId)
              this.uncertainSessions.delete(id)
              return this.persist()
            })
          } catch (error) {
            if (!(error instanceof Rejected)) this.uncertainSessions.add(id)
            throw error
          }
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
        if (frame.error !== undefined) { await waiter.onRejected?.(); waiter.reject(new Rejected('Codex rejected the operation. Review the thread before retrying.')) }
        else { await waiter.apply(frame.result); waiter.resolve() }
      } catch { waiter.reject(new Uncertain('Codex response could not be applied.')); this.lostChild() }
      return
    }
    if (frame.method === 'thread/started') {
      const { thread } = threadResponse.parse(frame.params); const id = this.sessionId(thread.id)
      if (id) { this.applyThread(id, thread); this.emit() }
      return
    }
    if (frame.method && frame.id !== undefined) {
      const params = z.object({ threadId: z.string() }).safeParse(frame.params)
      const id = params.success ? this.sessionId(params.data.threadId) : undefined
      const parsed = id ? pendingRequest(frame.id, frame.method, frame.params, id,
        this.fileSummaries.get(z.object({ itemId: z.string().optional() }).parse(frame.params).itemId ?? '')) : undefined
      if (!parsed) { this.write({ id: frame.id, error: { code: -32601, message: 'Sotto does not handle this request.' } }); return }
      this.requests.set(parsed.request.id, parsed); this.ensureThread(id!).requests.push(parsed.request); this.emit(); return
    }
    if (!['turn/started', 'turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta', 'error', 'serverRequest/resolved'].includes(frame.method ?? '')) return
    const params = notificationSchema.parse(frame.params); const id = this.sessionId(params.threadId)
    if (!id) return
    if (params.turn) this.applyTurn(id, params.turn)
    if (params.item) this.applyItem(id, params.item, params.turnId)
    if (frame.method === 'item/agentMessage/delta' && params.itemId && params.delta !== undefined) {
      const previous = this.ensureThread(id).messages.find(m => m.id === params.itemId)
      this.addMessage(id, { id: params.itemId, role: 'assistant', text: (previous?.text ?? '') + params.delta,
        createdAt: previous?.createdAt ?? this.turnDates.get(params.turnId ?? '') ?? this.aliases[id]!.createdAt })
    }
    if (frame.method === 'error') {
      this.ensureThread(id).status = 'error'
      if (params.turnId) this.terminalTurns.add(params.turnId)
    }
    if (frame.method === 'serverRequest/resolved' && params.requestId !== undefined) this.removeRequest(`rpc:${JSON.stringify(params.requestId)}`)
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
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Uncertain('Codex answer delivery is uncertain.')), this.options.requestTimeoutMs ?? 15000)
      child.stdin.write(JSON.stringify({ id: pending.id, result }) + '\n', error => { clearTimeout(timer); if (error) reject(new Uncertain('Codex answer delivery is uncertain.')); else resolve() })
    })
    this.removeRequest(pending.request.id); this.emit()
  }
  private async decline(sessionId: string): Promise<void> {
    for (const pending of [...this.requests.values()]) if (pending.sessionId === sessionId) await this.respond(pending, declineRequest(pending.method))
  }
  private lostChild(): void {
    const child = this.child; this.child = undefined; child?.kill('SIGKILL')
    this.state.connected = false; this.live.clear(); this.resuming.clear()
    void this.watcher?.stop()
    for (const waiter of this.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Uncertain('Codex disconnected before acknowledgement.')) }
    this.waiters.clear(); this.requests.clear()
    for (const thread of this.threads.values()) thread.requests = []
    this.emit()
  }
  disconnect(): void { this.shutdown(true) }
  private shutdown(publish: boolean): void {
    this.generation++
    const child = this.child
    if (child) {
      for (const pending of this.requests.values()) { try { this.write({ id: pending.id, result: declineRequest(pending.method) }) } catch { /* Closed pipes cannot grant permission. */ } }
      // Flush denials before ending stdin; force termination if the server keeps running.
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 100)
      timer.unref(); child.once('close', () => clearTimeout(timer))
    }
    this.child = undefined; this.state.connected = false; this.live.clear(); this.resuming.clear()
    const watcher = this.watcher; this.watcher = undefined
    this.stopping = Promise.all([this.stopping, watcher?.stop()]).then(() => undefined)
    for (const waiter of this.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Uncertain('Codex disconnected before acknowledgement.')) }
    this.waiters.clear(); this.requests.clear()
    for (const thread of this.threads.values()) thread.requests = []
    if (publish) this.emit()
  }
  /** Shutdown barrier for callers removing user data or replacing a host. */
  async closed(): Promise<void> { await this.stopping; await this.frames; await this.writing }
}
