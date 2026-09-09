import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentRequest, type AgentThread } from '../../shared/agents'
import type { AgentHost, AgentHostCommand, AgentHostConnection, AgentHostResult } from './host'

// These are T3's internal application contracts, verified against the shipped build.
// A new version must pass the live compatibility probe before being added here.
export const T3_COMPATIBLE_VERSIONS = ['0.0.38'] as const
const execFileAsync = promisify(execFile)
const identifier = z.string().min(1)
const selectionSchema = z.object({ instanceId: identifier, model: identifier })
const messageSchema = z.object({
  id: identifier, role: z.enum(['user', 'assistant', 'system']), text: z.string(), createdAt: z.string(),
})
const activitySchema = z.object({
  id: identifier, kind: z.string(), summary: z.string(), payload: z.unknown(), createdAt: z.string(),
  sequence: z.number().optional(),
})
const threadSchema = z.object({
  id: identifier, projectId: identifier, title: identifier, modelSelection: selectionSchema,
  runtimeMode: z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access']),
  interactionMode: z.enum(['default', 'plan']),
  latestTurn: z.object({ state: z.string() }).nullable(),
  session: z.object({ status: z.string(), lastError: z.string().nullable() }).nullable(),
  updatedAt: z.string(),
  messages: z.array(messageSchema).optional(), activities: z.array(activitySchema).optional(),
})
const shellSchema = z.object({
  snapshotSequence: z.number(),
  projects: z.array(z.object({ id: identifier, title: identifier, workspaceRoot: identifier })),
  threads: z.array(threadSchema),
})
const providerSchema = z.object({
  instanceId: identifier, driver: identifier, displayName: z.string().optional(),
  installed: z.boolean(), enabled: z.boolean(), status: z.string(),
  availability: z.string().optional(), auth: z.object({ status: z.string() }),
  models: z.array(z.object({ slug: identifier, name: identifier })),
})
const configSchema = z.object({ providers: z.array(providerSchema) })
const questionSchema = z.object({
  id: identifier, question: z.string(), options: z.array(z.object({ label: z.string(), description: z.string() })),
  multiSelect: z.boolean().optional(),
})
type T3Thread = z.infer<typeof threadSchema>
type T3Activity = z.infer<typeof activitySchema>
type T3Question = z.infer<typeof questionSchema>
type PendingRequest = { activity: T3Activity; questions: T3Question[] }
type RpcWaiter = {
  resolve(value: unknown): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}

export interface T3CodeHostOptions {
  /** Saves Sotto's own exchanged client token in the main-process OS credential vault. */
  onCredential?: (credential: string) => void | Promise<void>
  pollIntervalMs?: number
  clientLabel?: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function loopbackEndpoint(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Connect to a local T3 HTTP address, such as http://127.0.0.1:3773.')
  }
  return url.origin
}

function pendingRequests(activities: readonly T3Activity[]): Map<string, PendingRequest> {
  const requests = new Map<string, PendingRequest>()
  const ordered = [...activities].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  for (const activity of ordered) {
    const payload = asRecord(activity.payload)
    if (typeof payload.requestId !== 'string') continue
    if (activity.kind === 'approval.requested' || activity.kind === 'user-input.requested') {
      const questions = z.array(questionSchema).safeParse(payload.questions)
      requests.set(payload.requestId, { activity, questions: questions.success ? questions.data : [] })
    } else if (activity.kind === 'approval.resolved' || activity.kind === 'user-input.resolved') {
      requests.delete(payload.requestId)
    } else if (activity.kind === 'provider.approval.respond.failed' || activity.kind === 'provider.user-input.respond.failed') {
      const detail = typeof payload.detail === 'string' ? payload.detail.toLowerCase() : ''
      if (/(stale|unknown) pending (approval|permission|user-input|user input|codex user input) request/u.test(detail)) requests.delete(payload.requestId)
    }
  }
  return requests
}

function normalizeRequest(id: string, request: PendingRequest): AgentRequest {
  const { activity, questions } = request
  const payload = asRecord(activity.payload)
  if (activity.kind === 'approval.requested') {
    const options = z.array(z.object({ decision: z.string(), label: z.string() })).safeParse(payload.options)
    return {
      id, kind: 'permission', text: typeof payload.detail === 'string' ? payload.detail : activity.summary,
      options: options.success ? options.data.map(option => ({ id: option.decision, label: option.label })) : [],
    }
  }
  const text = questions.length === 1 ? questions[0]!.question : questions.map((question, index) =>
    `${index + 1}. ${question.question}${question.options.length ? ` (${question.options.map(option => option.label).join('; ')})` : ''}`).join('\n')
  return {
    id, kind: 'question', text: text || activity.summary,
    options: questions.length === 1 ? questions[0]!.options.map(option => ({ id: option.label, label: option.label })) : [],
  }
}

function questionAnswers(questions: readonly T3Question[], answer: string): Record<string, string | string[]> {
  if (questions.length === 1) return { [questions[0]!.id]: answer }
  if (questions.length === 0) throw new Error('T3 did not supply question identifiers. Answer this request directly in T3.')
  const numbered = new Map<number, string>()
  for (const line of answer.split(/\r?\n/u)) {
    const match = /^(\d+)[.):]\s*(.+)$/u.exec(line.trim())
    if (match) numbered.set(Number(match[1]), match[2]!)
  }
  if (questions.some((_, index) => !numbered.has(index + 1))) {
    throw new Error('This request has several questions. Answer each on a numbered line (1: answer, 2: answer), or reply directly in T3.')
  }
  return Object.fromEntries(questions.map((question, index) => [question.id, numbered.get(index + 1)!]))
}

/** Authenticated client of the same T3 server used by its visible desktop application. */
export class T3CodeHost implements AgentHost {
  private endpoint = ''
  private credential = ''
  private version = ''
  private socket: WebSocket | null = null
  private connected = false
  private sequence = 0
  private requestCounter = 0
  private generation = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private inFlight: Promise<AgentHostSnapshot> | null = null
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private readonly waiters = new Map<string, RpcWaiter>()
  private readonly streams = new Map<string, (value: unknown) => void>()
  private readonly observed = new Set<string>()
  private readonly detail = new Map<string, T3Thread>()
  private readonly commandOrigins = new Map<string, string>()
  private current: AgentHostSnapshot = { ...EMPTY_AGENT_HOST }

  constructor(private readonly options: T3CodeHostOptions = {}) {}

  async connect(connection: AgentHostConnection): Promise<AgentHostSnapshot> {
    this.disconnect()
    this.endpoint = loopbackEndpoint(connection.endpoint)
    const generation = this.generation
    try {
      const descriptor = z.object({ serverVersion: z.string() }).parse(await this.request('/.well-known/t3/environment'))
      this.version = descriptor.serverVersion
      if (!(T3_COMPATIBLE_VERSIONS as readonly string[]).includes(this.version)) {
        throw new Error(`T3 ${this.version} has not passed Sotto's compatibility checks. Supported version: ${T3_COMPATIBLE_VERSIONS.join(', ')}.`)
      }
      let credential = connection.credential.trim()
      if (credential) {
        this.credential = credential
        const session = asRecord(await this.request('/api/auth/session'))
        if (session.authenticated !== true) this.credential = ''
      }
      if (!this.credential) {
        if (!credential) credential = await this.createLocalPairing()
        const result = asRecord(await this.request('/oauth/token', {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: credential,
            subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
            requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            client_label: this.options.clientLabel ?? 'Sotto agent control', client_device_type: 'bot', client_os: process.platform,
          }).toString(),
        }))
        if (result.token_type !== 'Bearer' || typeof result.access_token !== 'string') throw new Error('T3 did not issue a supported client session. Pair again from T3.')
        this.credential = result.access_token
        await this.options.onCredential?.(this.credential)
      }
      if (generation !== this.generation) throw new Error('T3 connection was cancelled.')
      await this.openSocket()
      this.connected = true
      const snapshot = await this.snapshot()
      this.stream('orchestration.subscribeShell', { afterSequence: this.sequence, requestCompletionMarker: true }, () => this.scheduleRefresh())
      this.timer = setInterval(() => this.scheduleRefresh(), this.options.pollIntervalMs ?? 5_000)
      this.timer.unref()
      return snapshot
    } catch (error) {
      if (generation === this.generation) this.disconnect()
      throw error
    }
  }

  /** Only assigned/selected conversations need content; discovery uses the shell metadata. */
  observeThreads(threadIds: readonly string[]): void {
    this.observed.clear()
    for (const id of threadIds) this.observed.add(id)
    for (const id of this.detail.keys()) if (!this.observed.has(id)) this.detail.delete(id)
    if (this.connected) this.scheduleRefresh()
  }

  async snapshot(): Promise<AgentHostSnapshot> {
    if (!this.connected) return { ...this.current, connected: false }
    if (this.inFlight) return this.inFlight
    const reading = this.readSnapshot().finally(() => { if (this.inFlight === reading) this.inFlight = null })
    this.inFlight = reading
    return reading
  }

  private async readSnapshot(): Promise<AgentHostSnapshot> {
    const generation = this.generation
    const [shellValue, configValue] = await Promise.all([
      this.request('/api/orchestration/shell'), this.rpc('server.getConfig', {}),
    ])
    const shell = shellSchema.parse(shellValue)
    const config = configSchema.parse(configValue)
    const detailed = await Promise.all(shell.threads.filter(thread => this.observed.has(thread.id)).map(async thread => {
      const value = z.object({ thread: threadSchema }).parse(await this.request(`/api/orchestration/threads/${encodeURIComponent(thread.id)}?turnLimit=5`))
      return value.thread
    }))
    if (generation !== this.generation) throw new Error('T3 connection changed while reading state.')
    this.sequence = shell.snapshotSequence
    for (const thread of detailed) this.detail.set(thread.id, thread)
    this.current = {
      connected: true, name: 'T3 Code', version: this.version,
      capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true,
        permissions: true, interrupt: true, messageOrigin: true, reconcile: true },
      projects: shell.projects.map(project => ({ id: project.id, title: project.title, path: project.workspaceRoot })),
      models: config.providers.flatMap(provider => provider.models.map(model => ({
        id: `${provider.instanceId}:${model.slug}`, provider: provider.displayName ?? provider.driver, name: model.name,
        ready: provider.installed && provider.enabled && provider.status !== 'error' && provider.status !== 'disabled' &&
          provider.availability !== 'unavailable' && provider.auth.status !== 'unauthenticated',
      }))),
      threads: shell.threads.map(thread => this.normalizeThread(this.detail.get(thread.id) ?? thread)),
    }
    return this.current
  }

  private normalizeThread(thread: T3Thread): AgentThread {
    const status = thread.latestTurn?.state === 'running' || ['starting', 'running'].includes(thread.session?.status ?? '') ? 'running' :
      thread.latestTurn?.state === 'error' || thread.session?.status === 'error' ? 'error' : 'idle'
    return {
      id: thread.id, projectId: thread.projectId, title: thread.title,
      modelId: `${thread.modelSelection.instanceId}:${thread.modelSelection.model}`, status,
      messages: (thread.messages ?? []).filter(message => message.role !== 'system').map(message => ({
        id: message.id, role: message.role as 'user' | 'assistant', text: message.text, createdAt: message.createdAt,
        ...(this.commandOrigins.has(message.id) ? { commandId: this.commandOrigins.get(message.id)! } : {}),
      })),
      requests: [...pendingRequests(thread.activities ?? [])].map(([id, pending]) => normalizeRequest(id, pending)),
    }
  }

  async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (!this.connected) throw new Error('Connect to T3 before sending a command.')
    const createdAt = new Date().toISOString()
    let payload: Record<string, unknown>
    switch (command.type) {
      case 'create-project':
        payload = { type: 'project.create', commandId: command.commandId, projectId: command.projectId,
          title: command.title, workspaceRoot: command.path, createWorkspaceRootIfMissing: false, createdAt }
        break
      case 'create-thread': {
        const model = this.current.models.find(candidate => candidate.id === command.modelId)
        if (!model?.ready) throw new Error('That agent model is unavailable in T3. Choose an available model; Sotto will not switch accounts automatically.')
        const separator = model.id.indexOf(':')
        this.observed.add(command.threadId)
        payload = { type: 'thread.create', commandId: command.commandId, threadId: command.threadId,
          projectId: command.projectId, title: command.title,
          modelSelection: { instanceId: model.id.slice(0, separator), model: model.id.slice(separator + 1) },
          runtimeMode: 'approval-required', interactionMode: 'default', branch: null, worktreePath: null, createdAt }
        break
      }
      case 'send': {
        this.observed.add(command.threadId)
        const detail = z.object({ thread: threadSchema }).parse(await this.request(`/api/orchestration/threads/${encodeURIComponent(command.threadId)}?turnLimit=1`)).thread
        if (command.expectedLastUserMessageId !== undefined) {
          const latestUserMessageId = detail.messages?.filter(message => message.role === 'user').at(-1)?.id ?? null
          if (latestUserMessageId !== command.expectedLastUserMessageId) {
            this.detail.set(detail.id, detail)
            this.current = { ...this.current, threads: this.current.threads.map(thread => thread.id === detail.id ? this.normalizeThread(detail) : thread) }
            for (const listener of this.listeners) listener(this.current)
            throw new Error('The thread changed in T3 before Sotto could reply. Automatic submission was stopped; review its manual control state.')
          }
        }
        this.commandOrigins.set(command.messageId, command.commandId)
        payload = { type: 'thread.turn.start', commandId: command.commandId, threadId: command.threadId,
          message: { messageId: command.messageId, role: 'user', text: command.text, attachments: [] },
          runtimeMode: detail.runtimeMode, interactionMode: detail.interactionMode, createdAt }
        break
      }
      case 'answer': {
        const detail = z.object({ thread: threadSchema }).parse(await this.request(`/api/orchestration/threads/${encodeURIComponent(command.threadId)}?turnLimit=5`)).thread
        const pending = pendingRequests(detail.activities ?? []).get(command.requestId)
        if (!pending) throw new Error('This T3 request is no longer pending. Refresh the thread before answering.')
        if (pending.activity.kind === 'approval.requested') {
          if (typeof command.approved !== 'boolean') throw new Error('This is a permission request. Explicitly approve or decline it.')
          const payloadOptions = asRecord(pending.activity.payload).options
          const options = z.array(z.object({ decision: z.string(), label: z.string() })).safeParse(payloadOptions)
          const decision = command.approved ? 'accept' : 'decline'
          if (options.success && options.data.length > 0 && !options.data.some(option => option.decision === decision)) {
            throw new Error('This permission needs a choice that Sotto cannot submit. Answer it directly in T3.')
          }
          payload = { type: 'thread.approval.respond', commandId: command.commandId, threadId: command.threadId,
            requestId: command.requestId, decision, createdAt }
        } else {
          payload = { type: 'thread.user-input.respond', commandId: command.commandId, threadId: command.threadId,
            requestId: command.requestId, answers: questionAnswers(pending.questions, command.answer), createdAt }
        }
        break
      }
      case 'interrupt':
        payload = { type: 'thread.turn.interrupt', commandId: command.commandId, threadId: command.threadId, createdAt }
        break
    }
    try {
      await this.request('/api/orchestration/dispatch', { method: 'POST', body: JSON.stringify(payload) })
      this.scheduleRefresh()
      return { accepted: true }
    } catch (error) {
      if (error instanceof T3HttpError && error.status >= 400 && error.status < 500) throw error
      // The host may have committed a command before its acknowledgment was lost.
      // The coordinator owns durable IDs and must reconcile instead of generating a retry.
      this.scheduleRefresh()
      return { accepted: false, uncertain: true }
    }
  }

  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  disconnect(): void {
    this.generation++
    this.connected = false
    clearInterval(this.timer)
    clearTimeout(this.refreshTimer)
    this.timer = undefined
    this.refreshTimer = undefined
    const socket = this.socket
    this.socket = null
    socket?.close()
    for (const waiter of this.waiters.values()) { clearTimeout(waiter.timeout); waiter.reject(new Error('T3 connection closed.')) }
    this.waiters.clear()
    this.streams.clear()
    this.detail.clear()
    this.inFlight = null
    this.credential = ''
    this.current = { ...this.current, connected: false }
  }

  private scheduleRefresh(): void {
    if (!this.connected || this.refreshTimer) return
    const generation = this.generation
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      void this.snapshot().then(snapshot => {
        if (generation !== this.generation) return
        for (const listener of this.listeners) listener(snapshot)
      }).catch(() => {
        if (generation !== this.generation) return
        this.connected = false
        this.current = { ...this.current, connected: false }
        for (const listener of this.listeners) listener(this.current)
      })
    }, 100)
    this.refreshTimer.unref()
  }

  private async request(path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<unknown> {
    const response = await fetch(this.endpoint + path, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { ...(this.credential ? { authorization: `Bearer ${this.credential}` } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    })
    if (!response.ok) throw new T3HttpError(response.status)
    return response.json()
  }

  private async openSocket(): Promise<void> {
    const ticket = z.object({ ticket: z.string() }).parse(await this.request('/api/auth/websocket-ticket', { method: 'POST' }))
    const url = new URL('/ws', this.endpoint.replace('http:', 'ws:'))
    url.searchParams.set('wsTicket', ticket.ticket)
    url.searchParams.set('clientAppVersion', 'Sotto')
    const socket = new WebSocket(url)
    this.socket = socket
    socket.addEventListener('message', event => {
      try {
        const decoded: unknown = JSON.parse(String(event.data))
        for (const item of Array.isArray(decoded) ? decoded : [decoded]) this.handleFrame(asRecord(item))
      } catch { socket.close() }
    })
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return
      this.connected = false
      this.current = { ...this.current, connected: false }
      for (const waiter of this.waiters.values()) { clearTimeout(waiter.timeout); waiter.reject(new Error('T3 disconnected before replying.')) }
      this.waiters.clear()
      for (const listener of this.listeners) listener(this.current)
    })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(new Error('T3 did not open its event connection.')) }, 15_000)
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Could not establish T3 event monitoring.')) }, { once: true })
    })
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const requestId = String(frame.requestId ?? '')
    if (frame._tag === 'Ping') { this.socket?.send(JSON.stringify({ _tag: 'Pong' })); return }
    if (frame._tag === 'Chunk') {
      if (Array.isArray(frame.values)) for (const value of frame.values) this.streams.get(requestId)?.(value)
      this.socket?.send(JSON.stringify({ _tag: 'Ack', requestId }))
    } else if (frame._tag === 'Exit') {
      const waiter = this.waiters.get(requestId)
      if (!waiter) return
      clearTimeout(waiter.timeout)
      this.waiters.delete(requestId)
      const exit = asRecord(frame.exit)
      if (exit._tag === 'Success') waiter.resolve(exit.value)
      else waiter.reject(new Error('T3 could not complete the requested operation. Check its connection and permissions.'))
    }
  }

  private rpc(tag: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState !== WebSocket.OPEN) { reject(new Error('T3 event connection is unavailable.')); return }
      const id = String(++this.requestCounter)
      const timeout = setTimeout(() => { this.waiters.delete(id); reject(new Error('T3 did not respond in time.')) }, 15_000)
      this.waiters.set(id, { resolve, reject, timeout })
      this.socket.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }))
    })
  }

  private stream(tag: string, payload: unknown, callback: (value: unknown) => void): void {
    const id = String(++this.requestCounter)
    this.streams.set(id, callback)
    this.socket?.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }))
  }

  private async createLocalPairing(): Promise<string> {
    const paths = process.platform === 'win32' ? [
      join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 't3code'),
    ] : process.platform === 'darwin' ? ['/Applications/T3 Code (Alpha).app/Contents', '/Applications/T3 Code.app/Contents'] : []
    for (const root of paths) {
      const executable = process.platform === 'win32' ? join(root, 'T3 Code (Alpha).exe') : join(root, 'MacOS', 'T3 Code')
      const resources = process.platform === 'win32' ? join(root, 'resources') : join(root, 'Resources')
      const bin = join(resources, 'server.asar', 'apps', 'server', 'dist', 'bin.mjs')
      try { await access(executable); await access(join(resources, 'server.asar')) } catch { continue }
      try {
        const { stdout } = await execFileAsync(executable, [bin, 'auth', 'pairing', 'create', '--base-dir', join(homedir(), '.t3'),
          '--label', this.options.clientLabel ?? 'Sotto agent control', '--ttl', '5m', '--json'], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024,
        })
        return z.object({ credential: z.string() }).parse(JSON.parse(stdout)).credential
      } catch { throw new Error('Automatic T3 pairing failed. Create a pairing code in T3 and enter it in Sotto Connections.') }
    }
    throw new Error('T3 could not be located for local pairing. Create a pairing code in T3 and enter it in Sotto Connections.')
  }
}

class T3HttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? 'T3 rejected this client session. Pair again or check the granted permissions.' :
      `T3 could not complete the request (HTTP ${status}). Check its visible thread before retrying.`)
  }
}
