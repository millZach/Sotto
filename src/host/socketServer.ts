import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { z } from 'zod'
import type { HostService, ClientIdentity } from '../main/agents/hostService'
import { PairedClients, originAllowed, SESSION_LIFETIME_MS } from '../main/agents/pairing'
import { coalesceAgentStatePublishes, coalesceAgentThreadDetailPublishes } from '../main/agents/control'
import { HOST_EVENT_PAGE_SIZE, HOST_MAX_FRAME_BYTES, HOST_SESSION_REJECTED, hostRequestSchema, type HostDescriptor, type HostErrorCode, type HostPush, type HostReceipt, type HostRequest, type HostResponse } from '../shared/hostProtocol'
import type { AgentCommand } from '../shared/agents'
import { remoteCommandRefusal } from './remoteCommands'
import { SocketFrames } from './socketFrames'

const errors: Record<HostErrorCode, string> = {
  unauthenticated: HOST_SESSION_REJECTED,
  invalid_request: 'This request is not supported. Update this client and try again.',
  stale_request: 'This request has already changed or been answered. Refresh the thread before answering.',
  forbidden: 'This action is not allowed from this device. Check its permission policy or complete the action on the host.',
  unavailable: 'The host could not complete this request. Refresh the thread before trying again.',
  busy: 'The host has too many pending requests. Wait for them to finish and try again.',
  too_large: 'A thread on this host is too large to send to this device. Open it on the host machine.',
}
/** A shell push is the thread list, not one thread, so its oversize error says so. */
const SHELL_TOO_LARGE = 'The thread list on this host is too large to send to this device. Open it on the host machine.'
class Refusal extends Error { constructor(readonly code: HostErrorCode) { super(errors[code]) } }
interface Peer { frames: SocketFrames; client: ClientIdentity; session: string; observed: Set<string>; inFlight: number; window: number; count: number; preview: boolean; afterSeq: number; selectedThreadId: string | null; selectedProjectId: string | null }
export interface SocketServerOptions {
  service: HostService; pairing: PairedClients; port?: number; origins?: readonly string[]
  mayAnswer?: (client: ClientIdentity) => boolean
  setAnswers?: (clientId: string, allowed: boolean) => void
  /** Tests shorten the replay window and the cap; the host keeps the defaults. */
  receipts?: { lifetimeMs?: number; limit?: number; now?: () => number }
}
/**
 * A settled receipt answers a retried command for this long, which covers a reconnect after a lost
 * acknowledgement; after it the entry is dropped, so a host that runs for weeks never fills up.
 */
const RECEIPT_LIFETIME_MS = 5 * 60_000
const RECEIPT_LIMIT = 10_000
/** Selecting and observing only move this client's own view; repeating one is harmless, so they keep no receipt. */
const UNRECEIPTED = new Set<string>(['select-thread', 'select-project', 'observe-threads'])
/** Only this listener owns sockets; clients never get a provider handle or a claimed identity. */
export async function startSocketServer(options: SocketServerOptions) {
  const { service, pairing } = options
  const hostId = service.shell().hostId
  if (!hostId) throw new Error('The host must have an identity before listening.')
  const adminToken = randomBytes(32).toString('base64url')
  const peers = new Set<Peer>(), operations = new Set<Promise<unknown>>()
  const receipts = new Map<string, { digest: string; receipt: HostReceipt; task: Promise<unknown>; settledAt?: number }>()
  const receiptLifetime = options.receipts?.lifetimeMs ?? RECEIPT_LIFETIME_MS, receiptLimit = options.receipts?.limit ?? RECEIPT_LIMIT
  const clock = options.receipts?.now ?? Date.now
  /** Drops receipts settled longer ago than the replay window, then the oldest settled one if still full. Only pending work is busy. */
  const makeRoomForReceipt = (): void => {
    const now = clock()
    for (const [key, entry] of receipts) if (entry.settledAt !== undefined && now - entry.settledAt > receiptLifetime) receipts.delete(key)
    if (receipts.size < receiptLimit) return
    for (const [key, entry] of receipts) if (entry.settledAt !== undefined) { receipts.delete(key); return }
    throw new Refusal('busy')
  }
  let closing = false
  let httpWindow = Date.now(), httpCount = 0
  const identity = (clientId: string): ClientIdentity => ({ clientId, user: pairing.list().find(client => client.clientId === clientId)?.name ?? 'Paired client', transport: 'socket' })
  const shell = (peer: Peer) => {
    const state = service.shell()
    return { ...state, activeThreadId: peer.selectedThreadId, activeProjectId: peer.selectedProjectId }
  }
  const authenticated = (peer: Peer): boolean => pairing.verifySession(peer.session) === peer.client.clientId
  const fits = (text: string): boolean => Buffer.byteLength(text) <= HOST_MAX_FRAME_BYTES
  /**
   * Sends one message, or an explicit too_large error in its place when it would not fit in a frame, and
   * says whether the message itself went. Closing the socket instead would only have the client reconnect
   * and be sent the same message again.
   */
  const deliver = (peer: Peer, value: HostPush | HostResponse): boolean => {
    const text = JSON.stringify(value)
    if (fits(text)) { peer.frames.sendText(text); return true }
    const error = { code: 'too_large' as const, message: 'event' in value && value.event === 'shell' ? SHELL_TOO_LARGE : errors.too_large }
    peer.frames.send('event' in value ? { v: 1, event: 'error', ...(value.event === 'detail' ? { threadId: value.threadId } : {}), error } : { v: 1, id: value.id, ok: false, error })
    return false
  }
  const push = (peer: Peer, value: HostPush): boolean => { if (!authenticated(peer)) { peer.frames.close(); return false } return deliver(peer, value) }
  const events = (afterSeq: number, threadId?: string) => {
    const all = service.events(afterSeq, threadId, HOST_EVENT_PAGE_SIZE + 1), page = all.slice(0, HOST_EVENT_PAGE_SIZE)
    return { events: page, latestSeq: page.at(-1)?.seq ?? afterSeq, hasMore: all.length > page.length }
  }
  const observe = async (): Promise<void> => {
    const ids = [...new Set([...peers].flatMap(peer => [...peer.observed]))]
    await service.command({ type: 'observe-threads', threadIds: ids }, { clientId: 'socket-observations', user: '', transport: 'socket' })
  }
  const track = <T>(task: Promise<T>): Promise<T> => { operations.add(task); void task.finally(() => operations.delete(task)).catch(() => undefined); return task }
  const detail = (peer: Peer, threadId: string): void => { push(peer, { v: 1, event: 'detail', threadId, detail: service.threadDetail(threadId) }) }
  // A streaming thread changes the shell many times a second. Pushes go out at most once a window, the
  // same way the desktop's own IPC coalesces them, and each carries the state as it is when it is sent.
  // Details come through their own subscription when the service has one, so a shell change resends no history.
  const detailsFollowShell = service.subscribeThreadDetail === undefined
  // The peer's event cursor moves only once the events have gone or the client has been told to fetch them:
  // a page too large to ride along is left behind and the shell says there is more, so the client reads
  // the events itself from its own cursor instead of never being sent them.
  const shellPublisher = coalesceAgentStatePublishes(() => {
    for (const peer of peers) {
      if (!authenticated(peer)) { peer.frames.close(); continue }
      const state = shell(peer), eventPage = events(peer.afterSeq)
      const full = JSON.stringify({ v: 1, event: 'shell', state, eventPage })
      if (fits(full)) { peer.frames.sendText(full); peer.afterSeq = eventPage.latestSeq }
      else if (push(peer, { v: 1, event: 'shell', state, eventPage: { events: [], latestSeq: peer.afterSeq, hasMore: true } })) peer.afterSeq = eventPage.latestSeq
      if (detailsFollowShell) for (const threadId of peer.observed) detail(peer, threadId)
    }
  })
  const detailPublisher = coalesceAgentThreadDetailPublishes(update => {
    for (const peer of peers) if (peer.observed.has(update.threadId)) detail(peer, update.threadId)
  })
  const unsubscribe = service.subscribe(state => shellPublisher.publish(state))
  const unsubscribeDetails = service.subscribeThreadDetail?.(update => detailPublisher.publish(update))
  /** The permission settings of a new or changed thread's model that let the provider do nothing unasked. */
  const askingProviderModes = (input: AgentCommand): string[] => {
    if (input.type !== 'create-thread' && input.type !== 'configure-thread') return []
    const host = service.shell().host
    const modelId = input.modelId ?? (input.type === 'configure-thread' ? host.threads.find(thread => thread.id === input.threadId)?.modelId : undefined)
    return host.models.find(model => model.id === modelId)?.providerModes?.filter(mode => mode.allows === 'nothing').map(mode => mode.id) ?? []
  }
  const command = async (peer: Peer, request: Extract<HostRequest, { op: 'command' }>): Promise<unknown> => {
    const key = peer.client.clientId + ':' + request.id
    const digest = createHash('sha256').update(JSON.stringify(request.command)).digest('hex')
    const previous = receipts.get(key)
    if (previous) {
      if (previous.digest !== digest) throw new Refusal('invalid_request')
      await previous.task
      if (previous.receipt.error) throw new Refusal(previous.receipt.error.code)
      return shell(peer)
    }
    const input = request.command
    const refusal = remoteCommandRefusal(input, { mayAnswer: options.mayAnswer?.(peer.client) ?? false, askingProviderModes: askingProviderModes(input) })
    if (refusal) throw new Refusal(refusal)
    const recorded = !UNRECEIPTED.has(input.type)
    if (recorded) makeRoomForReceipt()
    if (input.type === 'answer') {
      const thread = service.shell().host.threads.find(thread => thread.id === input.threadId)
      if (!thread?.requests.some(item => item.id === input.requestId && !item.delivery)) throw new Refusal('stale_request')
    }
    const receipt: HostReceipt = { status: 'pending' }
    const task = (async () => {
      try {
        if (input.type === 'select-thread') {
          const thread = service.shell().host.threads.find(thread => thread.id === input.threadId)
          if (!thread) throw new Refusal('invalid_request')
          peer.selectedThreadId = thread.id; peer.selectedProjectId = thread.projectId
          detail(peer, thread.id)
        } else if (input.type === 'select-project') {
          peer.selectedProjectId = input.projectId; peer.selectedThreadId = null
        } else if (input.type === 'observe-threads') {
          peer.observed = new Set(input.threadIds); await observe()
        } else await service.command(input, peer.client)
        receipt.status = 'completed'
      } catch { receipt.status = 'completed'; receipt.error = { code: 'unavailable', message: errors.unavailable }; throw new Refusal('unavailable') }
    })()
    if (recorded) {
      const entry: { digest: string; receipt: HostReceipt; task: Promise<unknown>; settledAt?: number } = { digest, receipt, task }
      receipts.set(key, entry)
      const settle = (): void => { entry.settledAt = clock() }
      void task.then(settle, settle)
    }
    await task
    return shell(peer)
  }
  const dispatch = async (peer: Peer, request: HostRequest): Promise<unknown> => {
    if (closing) throw new Refusal('unavailable')
    if (request.session !== peer.session || !authenticated(peer)) throw new Refusal('unauthenticated')
    switch (request.op) {
      case 'hello': peer.afterSeq = request.afterSeq ?? 0; return { hostId, clientId: peer.client.clientId, shell: shell(peer), capabilities: { mayAnswer: options.mayAnswer?.(peer.client) ?? false }, ...events(request.afterSeq ?? 0) }
      case 'shell': return shell(peer)
      case 'detail': return service.threadDetail(request.threadId)
      case 'events': return events(request.afterSeq, request.threadId)
      case 'receipt': return receipts.get(peer.client.clientId + ':' + request.commandId)?.receipt ?? { status: 'unknown' }
      case 'observe': peer.observed = new Set(request.threadIds); await observe(); for (const id of peer.observed) detail(peer, id); return null
      case 'command': return command(peer, request)
      case 'preview':
        if (peer.preview) throw new Refusal('busy')
        peer.preview = true
        try { return await service.attachmentPreview?.(request.request) ?? null } finally { peer.preview = false }
    }
  }
  const onMessage = (peer: Peer, text: string): void => {
    let request: HostRequest
    try { request = hostRequestSchema.parse(JSON.parse(text)) } catch { peer.frames.close(); return }
    const now = Date.now()
    if (now - peer.window > 1000) { peer.window = now; peer.count = 0 }
    if (++peer.count > 100 || peer.inFlight >= 32) { peer.frames.close(); return }
    peer.inFlight++
    track((async () => {
      let response: HostResponse
      try { response = { v: 1, id: request.id, ok: true, result: await dispatch(peer, request) } }
      catch (error) { const code = error instanceof Refusal ? error.code : 'unavailable'; response = { v: 1, id: request.id, ok: false, error: { code, message: errors[code] } } }
      // A revocation while an operation was pending also denies its response.
      if (!authenticated(peer)) { peer.frames.send({ v: 1, id: request.id, ok: false, error: { code: 'unauthenticated', message: errors.unauthenticated } }); peer.frames.close() }
      else deliver(peer, response)
    })().finally(() => { peer.inFlight-- }))
  }
  const bearer = (request: IncomingMessage): string => /^Bearer ([A-Za-z0-9_.-]{1,2048})$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
  const body = async (request: IncomingMessage): Promise<unknown> => {
    let size = 0; const chunks: Buffer[] = []
    for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 8192) throw new Refusal('invalid_request'); chunks.push(bytes) }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Refusal('invalid_request') }
  }
  const respond = (response: ServerResponse, status: number, result: unknown): void => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(result)) }
  const server = createServer((request, response) => {
    track((async () => {
      try {
        if (closing) throw new Refusal('unavailable')
        if (request.headers.origin && !originAllowed(request.headers.origin, options.origins)) throw new Refusal('unauthenticated')
        if (Date.now() - httpWindow > 60000) { httpWindow = Date.now(); httpCount = 0 }
        if (++httpCount > 120) throw new Refusal('busy')
        if (request.method === 'GET' && request.url === '/v1/health') { respond(response, 200, { ...descriptor, status: 'ready' }); return }
        if (request.method !== 'POST') throw new Refusal('invalid_request')
        if (request.url?.startsWith('/v1/admin/')) {
          const token = Buffer.from(bearer(request)), expected = Buffer.from(adminToken)
          if (token.length !== expected.length || !timingSafeEqual(token, expected)) throw new Refusal('unauthenticated')
          if (request.url === '/v1/admin/pairing-code') { respond(response, 200, { v: 1, hostId, ...pairing.issuePairingCode() }); return }
          const input = z.object({ clientId: z.string().min(1).max(512) }).strict().parse(await body(request))
          if (request.url === '/v1/admin/revoke-client') { const revoked = await pairing.revoke(input.clientId); for (const peer of peers) if (!authenticated(peer)) peer.frames.close(); respond(response, 200, { v: 1, hostId, revoked }); return }
          else if (request.url === '/v1/admin/allow-answers' || request.url === '/v1/admin/deny-answers') {
            if (!pairing.list().some(client => client.clientId === input.clientId) || !options.setAnswers) throw new Refusal('invalid_request')
            options.setAnswers(input.clientId, request.url.endsWith('/allow-answers'))
          } else throw new Refusal('invalid_request')
          respond(response, 200, { v: 1, hostId, ok: true }); return
        }
        if (request.url === '/v1/pair') {
          const input = z.object({ v: z.literal(1), code: z.string().min(1).max(32), name: z.string().min(1).max(256) }).strict().parse(await body(request))
          let paired: Awaited<ReturnType<PairedClients['redeem']>>
          try { paired = await pairing.redeem(input.code, input.name) } catch { throw new Refusal('unauthenticated') }
          respond(response, 200, { v: 1, hostId, ...paired }); return
        }
        if (request.url === '/v1/revoke') {
          const clientId = pairing.verifyToken(bearer(request))
          if (!clientId) throw new Refusal('unauthenticated')
          const revoked = await pairing.revoke(clientId)
          for (const peer of peers) if (!authenticated(peer)) peer.frames.close()
          respond(response, 200, { v: 1, hostId, revoked }); return
        }
        if (request.url === '/v1/session') {
          const clientId = pairing.verifyToken(bearer(request))
          if (!clientId) throw new Refusal('unauthenticated')
          const at = Date.now()
          respond(response, 200, { v: 1, hostId, clientId, session: pairing.signSession(clientId, at), expiresAt: new Date(at + SESSION_LIFETIME_MS).toISOString() }); return
        }
        throw new Refusal('invalid_request')
      } catch (error) {
        const code = error instanceof Refusal ? error.code : 'invalid_request'
        respond(response, code === 'unauthenticated' ? 401 : code === 'busy' ? 429 : 400, { v: 1, error: { code, message: errors[code] } })
      }
    })())
  })
  server.headersTimeout = 5000; server.requestTimeout = 10000; server.keepAliveTimeout = 1000
  server.on('upgrade', (request, stream: Duplex, head) => {
    const reject = (): void => { stream.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n') }
    const session = bearer(request), clientId = pairing.verifySession(session)
    const key = request.headers['sec-websocket-key']
    if (closing || peers.size >= 32 || request.url !== '/v1/socket' || !clientId || request.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || (request.headers.origin && !originAllowed(request.headers.origin, options.origins))) { reject(); return }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    stream.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    const frames = new SocketFrames(stream, false, text => onMessage(peer, text))
    const peer: Peer = { frames, client: identity(clientId), session, observed: new Set(), inFlight: 0, window: Date.now(), count: 0, preview: false, afterSeq: 0, selectedThreadId: null, selectedProjectId: null }
    peers.add(peer)
    frames.onClose(() => { peers.delete(peer); if (!closing) track(observe().catch(() => undefined)) })
    frames.feed(head)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The host listener did not receive a loopback port.')
  const descriptor: HostDescriptor = { v: 1, hostId, pid: process.pid, port: address.port }
  const expiry = setInterval(() => { for (const peer of peers) if (!authenticated(peer)) peer.frames.close() }, 1000)
  expiry.unref()
  return {
    descriptor, adminToken,
    close: async (): Promise<void> => {
      closing = true; clearInterval(expiry); unsubscribe(); unsubscribeDetails?.(); shellPublisher.dispose(); detailPublisher.dispose()
      for (const peer of peers) peer.frames.close()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await Promise.allSettled([...operations]); await pairing.settled()
    },
  }
}
