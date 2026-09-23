import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { z } from 'zod'
import { SocketFrames } from '../../host/socketFrames'
import { agentStateSchema, agentThreadDetailResultSchema, agentAttachmentPreviewResultSchema, type AgentCommand, type AgentState, type AgentThreadDetail, type AgentThreadDetailDelta, type AgentThreadDetailUpdate, type AgentAttachmentPreviewRequest, type AgentAttachmentPreviewResult } from '../../shared/agents'
import { applyAgentThreadDetailDelta } from '../../shared/agentThreadDetail'
import type { StoredThreadEvent } from '../../shared/threadEvents'
import { gitRefsPageSchema, type GitRefsPage, type GitRefsRequest } from '../../shared/gitRefs'
import { HOST_BUSY, hostIsNewer, hostVersionMismatch, hostHealthFeatures, hostPairingSchema, hostSessionSchema, hostHelloSchema, hostEventPageSchema, hostResponseSchema, hostPushSchema, hostReceiptSchema } from '../../shared/hostProtocol'
import type { HostHello, HostOperation, HostPairing, HostSession, HostResponse, HostPush, HostEventPage, HostReceipt, HostErrorCode } from '../../shared/hostProtocol'
import type { HostService, ClientIdentity } from './hostService'
import { version as clientVersion } from '../../../package.json'

/** `version_mismatch` is this client's own finding, never a code on the wire: the host speaks a protocol it cannot use. */
export class HostConnectionError extends Error {
  constructor(message: string, readonly code: HostErrorCode | 'disconnected' | 'version_mismatch', readonly commandId?: string, readonly pairingRequired = false) { super(message) }
}
export interface SocketHostServiceOptions {
  url: string; token: string; expectedHostId?: string
  onConnectionChange?: (connected: boolean) => void
  /** A push the host could not send, such as a thread too large for one frame. The message is plain copy. */
  onPushError?: (message: string) => void
  /** What the last push error was about has since arrived: the thread it named, or the shell when it named none. */
  onPushErrorCleared?: () => void
  /** Whether Sotto started this host, so the version sentence offers Stop host only when it is there to press. */
  owned?: boolean
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
  /** What the host advertised on this connection; a client uses a feature only when the host lists it. */
  private hostVersion: string | undefined
  private features: readonly string[] = []
  /** Threads being read whole because a delta did not follow the revision held, so a run of them costs one read. */
  private readonly resyncing = new Set<string>()
  /** Threads the host said are too large to send. No delta asks for one again until it is observed again or arrives whole. */
  private readonly tooLarge = new Set<string>()
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
    // The host says what it speaks before anything is sent to it, so a host of another version is named
    // as one instead of answering a request it cannot read with a refusal or a closed socket.
    const healthResponse = await fetch(this.endpoint('/v1/health'), { signal: AbortSignal.any([opening.signal, AbortSignal.timeout(15000)]), redirect: 'error' })
    if (generation !== this.generation) throw new HostConnectionError('This host connection was closed.', 'disconnected')
    if (!healthResponse.ok) throw new HostConnectionError('The host did not answer its health check. Connect again.', 'unavailable')
    const healthBody: unknown = await healthResponse.json().catch(() => null)
    const health = hostHealthFeatures(healthBody)
    if (!health) {
      // A host of another protocol version may still say which Sotto it runs, which decides the way out.
      const advertised = healthBody !== null && typeof healthBody === 'object' && 'sottoVersion' in healthBody ? healthBody.sottoVersion : undefined
      this.hostVersion = typeof advertised === 'string' ? advertised : undefined
      throw new HostConnectionError(this.mismatch(), 'version_mismatch')
    }
    this.hostVersion = health.sottoVersion; this.features = health.features
    const response = await fetch(this.endpoint('/v1/session'), { method: 'POST', headers: { Authorization: 'Bearer ' + this.options.token }, signal: AbortSignal.any([opening.signal, AbortSignal.timeout(15000)]), redirect: 'error' })
    if (generation !== this.generation) throw new HostConnectionError('This host connection was closed.', 'disconnected')
    if (!response.ok) throw refusal(response.status, 'This device needs to connect again or be paired on the host.', 'unauthenticated', response.status === 401)
    const session = hostSessionSchema.parse(await response.json())
    if (session.v !== 1 || typeof session.session !== 'string' || (this.options.expectedHostId && session.hostId !== this.options.expectedHostId)) throw new HostConnectionError('This address belongs to a different host. Check the connection before continuing.', 'unauthenticated')
    this.session = session
    this.details.clear(); this.tooLarge.clear()
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
      const accepts = this.features.includes('detail-delta') ? { accepts: ['detail-delta'] } : {}
      const hello = this.read(hostHelloSchema, await this.call({ op: 'hello', afterSeq: this.catchesUp ? this.latestSeq : NO_EVENTS_AFTER, ...accepts }))
      if (hello.hostId !== session.hostId) throw new HostConnectionError('The host identity changed. Connect again.', 'unauthenticated')
      this.hostVersion = hello.sottoVersion; this.features = hello.features
      this.publish(this.read(agentStateSchema, hello.shell))
      if (this.catchesUp) {
        this.cacheEvents(hello)
        let page: HostEventPage = hello
        while (page.hasMore) page = await this.readEvents(this.latestSeq)
      }
      await this.observe(this.observed)
      // A thread too large to send is reported and left out, the way a push of it is, so it cannot fail
      // the connection and have the reconnect that follows read it whole again, and again.
      for (const id of this.observed) await this.readThreadDetail(id).catch((error: unknown) => { if (!this.reportedTooLarge(id, error)) throw error })
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
    let raw: unknown
    try { raw = JSON.parse(text) } catch { this.frames?.close(); return }
    const parsed = raw !== null && typeof raw === 'object' && 'event' in raw ? hostPushSchema.safeParse(raw) : hostResponseSchema.safeParse(raw)
    if (!parsed.success) { this.unreadable(raw); return }
    const message: HostResponse | HostPush = parsed.data
    try {
      if ('event' in message) {
        if (message.event === 'shell') { if (message.eventPage && this.catchesUp) { this.cacheEvents(message.eventPage); if (message.eventPage.hasMore) this.catchUp() } this.publish(this.read(agentStateSchema, message.state)) }
        else if (message.event === 'detail') this.cacheDetail(message.threadId, agentThreadDetailResultSchema.parse(message.detail))
        else if (message.event === 'detail-delta') this.applyDelta(message.threadId, message.delta)
        else { this.pushErrorThread = message.threadId ?? null; if (message.threadId) this.tooLarge.add(message.threadId); this.options.onPushError?.(message.error.message) }
      } else {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id); clearTimeout(pending.timer)
        if (message.ok) pending.resolve(message.result)
        // A host of another version refusing a request as unreadable is version skew, not a bad request.
        else if (message.error.code === 'invalid_request' && this.skewed()) pending.reject(new HostConnectionError(this.mismatch(), 'version_mismatch', pending.command ? message.id : undefined))
        else pending.reject(new HostConnectionError(message.error.message, message.error.code, pending.command ? message.id : undefined))
      }
    } catch { this.frames?.close() }
  }
  /**
   * A message this client cannot read. From a host of the same version it is a broken stream, and the
   * socket closes. From a host of another version it is skew: the request it answered fails with the
   * version sentence, or the sentence is reported the way a push error is, and the connection stays up.
   */
  private unreadable(raw: unknown): void {
    if (!this.skewed()) { this.frames?.close(); return }
    const id = raw !== null && typeof raw === 'object' && 'id' in raw && typeof raw.id === 'string' ? raw.id : undefined
    const pending = id === undefined ? undefined : this.pending.get(id)
    // The sentence names no thread and no shell, so no arrival clears it; only a new connection does.
    if (id === undefined || !pending) { this.pushErrorThread = undefined; this.options.onPushError?.(this.mismatch()); return }
    this.pending.delete(id); clearTimeout(pending.timer)
    pending.reject(new HostConnectionError(this.mismatch(), 'version_mismatch', pending.command ? id : undefined))
  }
  /** Whether the host runs another Sotto version than this client, by what it advertised. */
  private skewed(): boolean { return this.hostVersion !== undefined && this.hostVersion !== clientVersion }
  /** The version sentence for this host, which says which side to bring up to date. */
  private mismatch(): string { return hostVersionMismatch(clientVersion, this.hostVersion, this.options.owned ?? false) }
  /** Whether the host last advertised a later Sotto than this client: stopping it would not help. */
  hostIsNewer(): boolean { return hostIsNewer(this.hostVersion, clientVersion) }
  /** Reads what the host answered; from a host of another version, an answer this client cannot read is named as skew. */
  private read<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value)
    if (parsed.success) return parsed.data
    if (this.skewed()) throw new HostConnectionError(this.mismatch(), 'version_mismatch')
    throw parsed.error
  }
  /**
   * What changed in an observed thread since a revision. It applies only to the revision this client
   * holds, the way the window applies one over IPC, and is then passed on as it came, so the window
   * applies it to that same revision. Anything else reads the whole thread, once however many deltas
   * miss; a delta that what is held already covers is dropped.
   */
  private applyDelta(threadId: string, delta: AgentThreadDetailDelta): void {
    if (delta.threadId !== threadId) throw new HostConnectionError('The host returned a different thread. Refresh before continuing.', 'invalid_request')
    const held = this.details.get(threadId)
    if (held && delta.revision <= held.revision) return
    const applied = held ? applyAgentThreadDetailDelta(held, delta) : null
    if (applied === null) { this.resync(threadId); return }
    this.details.set(threadId, applied)
    for (const listener of this.detailListeners) listener(structuredClone(delta))
    if (this.pushErrorThread === threadId) this.clearPushError()
  }
  /** Reads a thread whole after a delta could not follow it. A thread too large to send is reported, not asked for again. */
  private resync(threadId: string): void {
    if (this.resyncing.has(threadId) || this.tooLarge.has(threadId)) return
    this.resyncing.add(threadId)
    void this.readThreadDetail(threadId).catch((error: unknown) => { this.reportedTooLarge(threadId, error) })
      .finally(() => { this.resyncing.delete(threadId) })
  }
  /** Reports a thread the host said is too large to send, so nothing asks for it again; false for any other failure. */
  private reportedTooLarge(threadId: string, error: unknown): boolean {
    if (!(error instanceof HostConnectionError) || error.code !== 'too_large') return false
    this.tooLarge.add(threadId); this.pushErrorThread = threadId; this.options.onPushError?.(error.message)
    return true
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
    this.details.set(threadId, detail); this.tooLarge.delete(threadId)
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
  async readShell(): Promise<AgentState> { const generation = this.generation; const state = this.read(agentStateSchema, await this.call({ op: 'shell' })); this.sameGeneration(generation); this.publish(state); return this.shell() }
  async readThreadDetail(threadId: string): Promise<AgentThreadDetail | null> { const generation = this.generation; const detail = this.read(agentThreadDetailResultSchema, await this.call({ op: 'detail', threadId })); this.sameGeneration(generation); this.cacheDetail(threadId, detail); return this.threadDetail(threadId) }
  async readEvents(afterSeq: number, threadId?: string): Promise<HostEventPage> { const page = this.read(hostEventPageSchema, await this.call({ op: 'events', afterSeq, ...(threadId ? { threadId } : {}) })); this.cacheEvents(page, threadId === undefined); return page }
  /** Observing a thread again lets one the host found too large be tried again: the host sends each observed thread whole. */
  async observe(threadIds: string[]): Promise<void> { this.observed = [...threadIds]; for (const id of threadIds) this.tooLarge.delete(id); await this.call({ op: 'observe', threadIds }) }
  async command(command: AgentCommand, _client?: ClientIdentity, commandId?: string): Promise<AgentState> {
    if (command.type === 'observe-threads') { await this.observe(command.threadIds); return this.state() }
    const generation = this.generation
    const state = this.read(agentStateSchema, await this.call({ op: 'command', command }, commandId)); this.sameGeneration(generation); this.publish(state)
    if ('threadId' in command && command.threadId) await this.readThreadDetail(command.threadId)
    if (this.catchesUp) { let page = await this.readEvents(this.latestSeq); while (page.hasMore) page = await this.readEvents(this.latestSeq) }
    return this.state()
  }
  async receipt(commandId: string): Promise<HostReceipt> { return this.read(hostReceiptSchema, await this.call({ op: 'receipt', commandId })) }
  attachmentPreview(request: AgentAttachmentPreviewRequest): Promise<AgentAttachmentPreviewResult> {
    const result = this.previewTail.then(async () => this.read(agentAttachmentPreviewResultSchema, await this.call({ op: 'preview', request })))
    this.previewTail = result.catch(() => undefined); return result
  }
  async gitRefs(request: GitRefsRequest): Promise<GitRefsPage> { return this.read(gitRefsPageSchema, await this.call({ op: 'git-refs', request })) }
  async revokePairing(): Promise<void> {
    const response = await fetch(this.endpoint('/v1/revoke'), { method: 'POST', headers: { Authorization: 'Bearer ' + this.options.token }, signal: AbortSignal.timeout(15000), redirect: 'error' })
    if (!response.ok) throw refusal(response.status, 'The host could not forget this device. Connect again and retry.', 'unavailable')
    await this.close()
  }
  async close(): Promise<void> { this.generation++; this.opening?.abort(); this.frames?.close() }
}
