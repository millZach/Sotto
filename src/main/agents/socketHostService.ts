import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { SocketFrames } from '../../host/socketFrames'
import { agentStateSchema, agentThreadDetailResultSchema, agentAttachmentPreviewResultSchema, type AgentCommand, type AgentState, type AgentThreadDetail, type AgentThreadDetailUpdate, type AgentAttachmentPreviewRequest, type AgentAttachmentPreviewResult } from '../../shared/agents'
import type { StoredThreadEvent } from '../../shared/threadEvents'
import { HOST_BUSY, hostPairingSchema, hostSessionSchema, hostHelloSchema, hostEventPageSchema, hostResponseSchema, hostPushSchema, hostReceiptSchema } from '../../shared/hostProtocol'
import type { HostHello, HostOperation, HostPairing, HostSession, HostResponse, HostPush, HostEventPage, HostReceipt, HostErrorCode } from '../../shared/hostProtocol'
import type { HostService, ClientIdentity } from './hostService'

export class HostConnectionError extends Error {
  constructor(message: string, readonly code: HostErrorCode | 'disconnected', readonly commandId?: string, readonly pairingRequired = false) { super(message) }
}
export interface SocketHostServiceOptions {
  url: string; token: string; expectedHostId?: string
  onConnectionChange?: (connected: boolean) => void
  /** A push the host could not send, such as a thread too large for one frame. The message is plain copy. */
  onPushError?: (message: string) => void
  /** What the last push error was about has since arrived: the thread it named, or the shell when it named none. */
  onPushErrorCleared?: () => void
  /**
   * False for a client with nothing that reads the host's event log, such as the desktop router. It asks
   * for no events when it opens, reads none after a command and follows no catch-up a push offers, so a
   * connect never downloads a log nobody reads. The shell and the observed threads' details still arrive
   * in full on every open, which is what a reconnect needs (ADR-0025). Defaults to true.
   */
  catchUpEvents?: boolean
}
/** An `afterSeq` past any sequence a host can reach: the host has no event after it, so it sends none. */
const NO_EVENTS_AFTER = Number.MAX_SAFE_INTEGER
/** A 429 is the host's request budget, not this device's pairing, so it says to wait rather than to pair again. */
const refusal = (status: number, otherwise: string, code: HostErrorCode, pairingRequired = false): HostConnectionError =>
  status === 429 ? new HostConnectionError(HOST_BUSY, 'busy') : new HostConnectionError(otherwise, code, undefined, pairingRequired)
/** A transport cache, not a second coordinator. Losing a socket never replays a command. */
export class SocketHostService implements HostService {
  private frames: SocketFrames | undefined
  private session?: HostSession
  private cached?: AgentState
  private readonly details = new Map<string, AgentThreadDetail | null>()
  private readonly storedEvents = new Map<number, StoredThreadEvent>()
  private latestSeq = 0
  private catchup: Promise<void> | undefined
  /** The thread the last push error named, null for the shell, undefined when none is outstanding. */
  private pushErrorThread: string | null | undefined
  private readonly listeners = new Set<(state: AgentState) => void>()
  private readonly detailListeners = new Set<(detail: AgentThreadDetailUpdate) => void>()
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; command: boolean }>()
  private connecting: Promise<HostHello> | undefined
  private observed: string[] = []
  private generation = 0
  private opening: AbortController | undefined
  private previewTail: Promise<unknown> = Promise.resolve()
  constructor(private readonly options: SocketHostServiceOptions) { this.endpoint('/v1/health') }
  private get catchesUp(): boolean { return this.options.catchUpEvents !== false }
  static async pair(url: string, code: string, name: string): Promise<HostPairing> {
    const endpoint = new SocketHostService({ url, token: '' }).endpoint('/v1/pair')
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, code, name }), signal: AbortSignal.timeout(15000), redirect: 'error' })
    if (!response.ok) throw refusal(response.status, 'This pairing code could not be used. Make a new code on the host and try again.', 'unauthenticated')
    return hostPairingSchema.parse(await response.json())
  }
  private endpoint(path: string): URL {
    const url = new URL(path, this.options.url)
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('Use a host HTTP or HTTPS address without credentials in its URL.')
    if (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error('A remote host address must use HTTPS.')
    return url
  }
  connect(): Promise<HostHello> {
    if (this.connecting) return this.connecting
    const task = this.open()
    this.connecting = task
    void task.finally(() => { if (this.connecting === task) this.connecting = undefined }).catch(() => undefined)
    return task
  }
  private async open(): Promise<HostHello> {
    const generation = ++this.generation
    this.opening?.abort()
    const opening = new AbortController(); this.opening = opening
    this.frames?.close()
    const response = await fetch(this.endpoint('/v1/session'), { method: 'POST', headers: { Authorization: 'Bearer ' + this.options.token }, signal: AbortSignal.any([opening.signal, AbortSignal.timeout(15000)]), redirect: 'error' })
    if (generation !== this.generation) throw new HostConnectionError('This host connection was closed.', 'disconnected')
    if (!response.ok) throw refusal(response.status, 'This device needs to connect again or be paired on the host.', 'unauthenticated', response.status === 401)
    const session = hostSessionSchema.parse(await response.json())
    if (session.v !== 1 || typeof session.session !== 'string' || (this.options.expectedHostId && session.hostId !== this.options.expectedHostId)) throw new HostConnectionError('This address belongs to a different host. Check the connection before continuing.', 'unauthenticated')
    this.session = session
    this.details.clear()
    const url = this.endpoint('/v1/socket'), key = randomBytes(16).toString('base64')
    const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    this.frames = await new Promise<SocketFrames>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { signal: opening.signal, headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, Authorization: 'Bearer ' + session.session } })
      request.setTimeout(15000, () => request.destroy(new Error('Host connection timed out.')))
      request.on('error', () => reject(new HostConnectionError('The host connection could not be opened.', 'disconnected')))
      request.on('response', response => { response.resume(); reject(new HostConnectionError('The host refused this connection. Connect again.', 'unauthenticated')) })
      request.on('upgrade', (response, stream, head) => {
        if (response.headers['sec-websocket-accept'] !== expected) { stream.destroy(); reject(new HostConnectionError('The host did not accept this protocol.', 'invalid_request')); return }
        stream.setTimeout(0)
        const frames = new SocketFrames(stream, true, text => this.receive(text))
        frames.onClose(() => this.disconnected(frames))
        frames.feed(head)
        resolve(frames)
      })
      request.end()
    })
    if (generation !== this.generation) { this.frames.close(); throw new HostConnectionError('This host connection was closed.', 'disconnected') }
    try {
      const hello = hostHelloSchema.parse(await this.call({ op: 'hello', afterSeq: this.catchesUp ? this.latestSeq : NO_EVENTS_AFTER }))
      if (hello.hostId !== session.hostId) throw new HostConnectionError('The host identity changed. Connect again.', 'unauthenticated')
      this.publish(agentStateSchema.parse(hello.shell))
      if (this.catchesUp) {
        this.cacheEvents(hello)
        let page: HostEventPage = hello
        while (page.hasMore) page = await this.readEvents(this.latestSeq)
      }
      await this.observe(this.observed)
      for (const id of this.observed) await this.readThreadDetail(id)
      this.options.onConnectionChange?.(true)
      return hello
    } catch (error) { this.frames?.close(); throw error }
  }
  private disconnected(frames: SocketFrames): void {
    if (this.frames !== frames) return
    this.frames = undefined
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer)
      item.reject(new HostConnectionError(item.command ? 'The connection closed before the host confirmed this command. Refresh before deciding what to do next.' : 'The host connection closed. Connect again to refresh.', 'disconnected', item.command ? id : undefined))
    }
    this.pending.clear()
    if (this.cached) this.publish({ ...this.cached, stale: true })
    this.options.onConnectionChange?.(false)
  }
  private receive(text: string): void {
    let message: HostResponse | HostPush
    try { const raw: unknown = JSON.parse(text); message = raw && typeof raw === 'object' && 'event' in raw ? hostPushSchema.parse(raw) : hostResponseSchema.parse(raw) } catch { this.frames?.close(); return }
    if (message.v !== 1) { this.frames?.close(); return }
    try {
      if ('event' in message) {
        if (message.event === 'shell') { if (message.eventPage && this.catchesUp) { this.cacheEvents(message.eventPage); if (message.eventPage.hasMore) this.catchUp() } this.publish(agentStateSchema.parse(message.state)) }
        else if (message.event === 'detail') this.cacheDetail(message.threadId, agentThreadDetailResultSchema.parse(message.detail))
        else { this.pushErrorThread = message.threadId ?? null; this.options.onPushError?.(message.error.message) }
      } else {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id); clearTimeout(pending.timer)
        if (message.ok) pending.resolve(message.result)
        else pending.reject(new HostConnectionError(message.error.message, message.error.code, pending.command ? message.id : undefined))
      }
    } catch { this.frames?.close() }
  }
  private catchUp(): void {
    if (this.catchup) return
    const task = (async () => {
      let page = await this.readEvents(this.latestSeq)
      while (page.hasMore) page = await this.readEvents(this.latestSeq)
    })()
    this.catchup = task
    void task.finally(() => { if (this.catchup === task) this.catchup = undefined }).catch(() => undefined)
  }
  private call(operation: HostOperation, id: string = randomUUID()): Promise<unknown> {
    const frames = this.frames, session = this.session
    if (!frames || !session) return Promise.reject(new HostConnectionError('The host is disconnected. Connect again before sending.', 'disconnected'))
    if (this.pending.has(id) || this.pending.size >= 32) return Promise.reject(new HostConnectionError('Wait for the pending host request to finish.', 'busy'))
    return new Promise((resolve, reject) => {
      const command = operation.op === 'command'
      const timer = setTimeout(() => { this.pending.delete(id); reject(new HostConnectionError(command ? 'The host has not confirmed this command. Refresh before deciding what to do next.' : 'The host did not answer in time. Try refreshing.', 'disconnected', command ? id : undefined)) }, 120000)
      this.pending.set(id, { resolve, reject, timer, command })
      if (!frames.send({ v: 1, id, session: session.session, ...operation })) { clearTimeout(timer); this.pending.delete(id); reject(new HostConnectionError('The connection closed before this request could be confirmed.', 'disconnected', command ? id : undefined)) }
    })
  }
  private publish(state: AgentState): void {
    const hostId = this.session?.hostId
    if (hostId && (state.hostId !== hostId || state.host.hostId !== hostId || state.host.threads.some(thread => thread.hostId && thread.hostId !== hostId) || state.host.projects.some(project => project.hostId && project.hostId !== hostId))) throw new HostConnectionError('The host returned another host identity. Reconnect before continuing.', 'unauthenticated')
    delete state.clientScoped; delete state.connections
    this.cached = state; for (const listener of this.listeners) listener(this.state())
    if (this.pushErrorThread === null) this.clearPushError()
  }
  private clearPushError(): void { this.pushErrorThread = undefined; this.options.onPushErrorCleared?.() }
  private cacheDetail(threadId: string, detail: AgentThreadDetail | null): void {
    if (detail && detail.threadId !== threadId) throw new HostConnectionError('The host returned a different thread. Refresh before continuing.', 'invalid_request')
    const current = this.details.get(threadId)
    if (detail && current && detail.revision < current.revision) return
    this.details.set(threadId, detail)
    if (detail) for (const listener of this.detailListeners) listener(detail)
    if (this.pushErrorThread === threadId) this.clearPushError()
  }
  private sameGeneration(generation: number): void { if (generation !== this.generation) throw new HostConnectionError('This result belongs to an earlier connection. Refresh the host.', 'disconnected') }
  private cacheEvents(page: HostEventPage, advance = true): void {
    for (const event of page.events) this.storedEvents.set(event.seq, event)
    if (advance) this.latestSeq = Math.max(this.latestSeq, page.latestSeq)
    while (this.storedEvents.size > 10000) this.storedEvents.delete(this.storedEvents.keys().next().value!)
  }
  state(): AgentState {
    const shell = this.shell()
    return { ...shell, host: { ...shell.host, threads: shell.host.threads.map(thread => { const detail = this.details.get(thread.id); return detail ? { ...thread, messages: detail.messages, activities: detail.activities } : thread }) } }
  }
  shell(): AgentState { if (!this.cached) throw new Error('Connect to the host before reading its state.'); return structuredClone(this.cached) }
  threadDetail(threadId: string): AgentThreadDetail | null { return structuredClone(this.details.get(threadId) ?? null) }
  events(afterSeq: number, threadId?: string): StoredThreadEvent[] { return structuredClone([...this.storedEvents.values()].filter(event => event.seq > afterSeq && (!threadId || event.threadId === threadId)).sort((a, b) => a.seq - b.seq)) }
  subscribe(listener: (state: AgentState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  subscribeThreadDetail(listener: (detail: AgentThreadDetailUpdate) => void): () => void { this.detailListeners.add(listener); return () => this.detailListeners.delete(listener) }
  async readShell(): Promise<AgentState> { const generation = this.generation; const state = agentStateSchema.parse(await this.call({ op: 'shell' })); this.sameGeneration(generation); this.publish(state); return this.shell() }
  async readThreadDetail(threadId: string): Promise<AgentThreadDetail | null> { const generation = this.generation; const detail = agentThreadDetailResultSchema.parse(await this.call({ op: 'detail', threadId })); this.sameGeneration(generation); this.cacheDetail(threadId, detail); return this.threadDetail(threadId) }
  async readEvents(afterSeq: number, threadId?: string): Promise<HostEventPage> { const page = hostEventPageSchema.parse(await this.call({ op: 'events', afterSeq, ...(threadId ? { threadId } : {}) })); this.cacheEvents(page, threadId === undefined); return page }
  async observe(threadIds: string[]): Promise<void> { this.observed = [...threadIds]; await this.call({ op: 'observe', threadIds }) }
  async command(command: AgentCommand, _client?: ClientIdentity, commandId?: string): Promise<AgentState> {
    if (command.type === 'observe-threads') { await this.observe(command.threadIds); return this.state() }
    const generation = this.generation
    const state = agentStateSchema.parse(await this.call({ op: 'command', command }, commandId)); this.sameGeneration(generation); this.publish(state)
    if ('threadId' in command && command.threadId) await this.readThreadDetail(command.threadId)
    if (this.catchesUp) { let page = await this.readEvents(this.latestSeq); while (page.hasMore) page = await this.readEvents(this.latestSeq) }
    return this.state()
  }
  async receipt(commandId: string): Promise<HostReceipt> { return hostReceiptSchema.parse(await this.call({ op: 'receipt', commandId })) }
  attachmentPreview(request: AgentAttachmentPreviewRequest): Promise<AgentAttachmentPreviewResult> {
    const result = this.previewTail.then(async () => agentAttachmentPreviewResultSchema.parse(await this.call({ op: 'preview', request })))
    this.previewTail = result.catch(() => undefined); return result
  }
  async revokePairing(): Promise<void> {
    const response = await fetch(this.endpoint('/v1/revoke'), { method: 'POST', headers: { Authorization: 'Bearer ' + this.options.token }, signal: AbortSignal.timeout(15000), redirect: 'error' })
    if (!response.ok) throw refusal(response.status, 'The host could not forget this device. Connect again and retry.', 'unavailable')
    await this.close()
  }
  async close(): Promise<void> { this.generation++; this.opening?.abort(); this.frames?.close() }
}
