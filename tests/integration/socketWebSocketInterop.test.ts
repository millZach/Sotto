// @vitest-environment node
/**
 * The host's socket against a WebSocket client Sotto did not write: Node's own global WebSocket. Every
 * other socket test has SocketFrames on both ends, so a framing mistake the two share would pass there.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { DEFLATE_SYNC_MAX_BYTES, SocketFrames } from '../../src/host/socketFrames'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostService } from '../../src/main/agents/hostService'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import type { AgentThreadDetail } from '../../src/shared/agents'

let root: string, host: Awaited<ReturnType<typeof startHeadlessHost>>, server: Awaited<ReturnType<typeof startSocketServer>>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sotto-websocket-interop-'))
  // No listener of its own: the listener under test is the one started below.
  host = await startHeadlessHost({ dataDirectory: root, providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner })
  server = await startSocketServer({ service: host.service, pairing: host.pairing })
})
afterEach(async () => {
  await server?.close(); await host?.close()
  if (root && dirname(root) === tmpdir() && root.includes('sotto-websocket-interop-')) await rm(root, { recursive: true, force: true })
})

/** Node's WebSocket, which is undici's, takes request headers as a non-standard option; the DOM types do not list it. */
type NodeWebSocket = new (url: string, init: { headers: Record<string, string> }) => WebSocket

it('says hello, runs a command and receives a pushed event over Node’s own WebSocket', async () => {
  const base = `http://127.0.0.1:${server.descriptor.port}`
  const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'WebSocket interop')
  const opened = await fetch(`${base}/v1/session`, { method: 'POST', headers: { Authorization: `Bearer ${paired.token}` } })
  const { session } = await opened.json() as { session: string }
  const socket = new (WebSocket as unknown as NodeWebSocket)(`ws://127.0.0.1:${server.descriptor.port}/v1/socket`, { headers: { Authorization: `Bearer ${session}` } })
  const messages: Record<string, unknown>[] = []
  const waiters = new Set<() => void>()
  socket.addEventListener('message', event => { messages.push(JSON.parse(event.data as string) as Record<string, unknown>); for (const wake of waiters) wake() })
  const closed = new Promise<CloseEvent>(resolve => socket.addEventListener('close', resolve))
  const next = (match: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const check = (): void => { const found = messages.find(match); if (found) { waiters.delete(check); resolve(found) } }
    waiters.add(check); check()
    void closed.then(() => reject(new Error('The socket closed first.')))
  })
  await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve()); socket.addEventListener('error', () => reject(new Error('The socket did not open.'))) })

  // Node's WebSocket offers permessage-deflate, and this listener counts every client as a desktop, so the hello's
  // shell, well over the kilobyte below which nothing is compressed, arrives compressed by the host's own deflate.
  expect(socket.extensions).toContain('permessage-deflate')
  socket.send(JSON.stringify({ v: 1, id: 'hello-1', session, op: 'hello' }))
  const hello = await next(message => message.id === 'hello-1')
  expect(hello).toMatchObject({ v: 1, ok: true, result: { hostId: host.service.shell().hostId, clientId: paired.clientId, capabilities: { mayAnswer: false } } })
  expect(Buffer.byteLength(JSON.stringify(hello))).toBeGreaterThan(1024)

  const commandId = randomUUID()
  socket.send(JSON.stringify({ v: 1, id: commandId, session, op: 'command', command: { type: 'configure', patch: { enabled: false } } }))
  const reply = await next(message => message.id === commandId)
  expect(reply).toMatchObject({ v: 1, ok: true, result: { configuration: { enabled: false } } })
  expect(host.service.shell().configuration.enabled).toBe(false)
  // The change is pushed as well as answered: a shell event carrying it arrives unasked.
  const pushed = await next(message => message.event === 'shell' && (message.state as { configuration?: { enabled?: boolean } }).configuration?.enabled === false)
  expect(pushed).toMatchObject({ v: 1, event: 'shell', eventPage: expect.any(Object) })

  // Compressed shell pushes may still be on their way. Node's WebSocket inflates a compressed message off the loop, and
  // its socket's close handler does not wait for its parser: when the host's Close reply and end of stream arrive behind
  // a message it is still inflating, it reports 1006 although the Close frame arrived (#1467). So the close code is
  // checked below, on a socket with nothing in flight.
  socket.close(1000, 'done')
  await closed
})

it('sends a phone compressed messages it reads over Node’s own WebSocket, one over 64 KiB among them, with phone compression on (#2394)', async () => {
  // A thread long enough to be compressed on the thread pool rather than the loop.
  const long: AgentThreadDetail = { threadId: 'long', revision: 1, messages: Array.from({ length: 4 }, (_, index) => ({ id: 'message-' + index, role: 'assistant' as const,
    createdAt: '2026-11-10T00:00:00.000Z', text: Array.from({ length: 3000 }, (_, line) => `src/host/socketServer.ts:${line} ok ${index}`).join('\n') })) }
  const service: HostService = { shell: () => host.service.shell(), state: () => host.service.state(), events: (afterSeq, threadId, limit) => host.service.events(afterSeq, threadId, limit),
    subscribe: listener => host.service.subscribe(listener), threadDetail: id => id === 'long' ? structuredClone(long) : host.service.threadDetail(id),
    command: (command, identity) => host.service.command(command, identity), subscribeThreadDetail: () => () => undefined }
  // Shaped like a headless host's tailnet listener with no desktop recorded, so this client is a phone.
  const phones = await startSocketServer({ service, pairing: host.pairing, admin: false, compressPhones: true, tailnet: { phonesAdmitted: () => true, desktops: { has: () => false, refresh: async () => undefined } } })
  const written = vi.spyOn(SocketFrames.prototype as unknown as { frame(opcode: number, data: Buffer, compressed: boolean): boolean }, 'frame')
  try {
    const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'WebSocket phone')
    const opened = await fetch(`http://127.0.0.1:${phones.descriptor.port}/v1/session`, { method: 'POST', headers: { Authorization: `Bearer ${paired.token}` } })
    const { session } = await opened.json() as { session: string }
    const socket = new (WebSocket as unknown as NodeWebSocket)(`ws://127.0.0.1:${phones.descriptor.port}/v1/socket`, { headers: { Authorization: `Bearer ${session}` } })
    const messages: Record<string, unknown>[] = []
    socket.addEventListener('message', event => messages.push(JSON.parse(event.data as string) as Record<string, unknown>))
    const closed = new Promise<CloseEvent>(resolve => socket.addEventListener('close', resolve))
    await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve()); socket.addEventListener('error', () => reject(new Error('The socket did not open.'))) })
    expect(socket.extensions).toContain('permessage-deflate')
    socket.send(JSON.stringify({ v: 1, id: 'hello-1', session, op: 'hello' }))
    await vi.waitFor(() => expect(messages.find(message => message.id === 'hello-1')).toMatchObject({ ok: true }))
    socket.send(JSON.stringify({ v: 1, id: 'long-1', session, op: 'detail', threadId: 'long' }))
    await vi.waitFor(() => expect(messages.some(message => message.id === 'long-1')).toBe(true))
    const read = messages.find(message => message.id === 'long-1')!
    expect((read.result as AgentThreadDetail).messages).toEqual(long.messages)
    const bytes = Buffer.byteLength(JSON.stringify(read))
    expect(bytes).toBeGreaterThan(DEFLATE_SYNC_MAX_BYTES)
    // What went on the wire for it was compressed, a fraction of the thread's size.
    const compressed = written.mock.calls.filter(([opcode, , packed]) => opcode === 1 && packed).map(([, data]) => data.length)
    expect(compressed.length).toBeGreaterThanOrEqual(2)
    expect(Math.max(...compressed)).toBeLessThan(bytes / 4)
    socket.close(1000, 'done')
    await closed
  } finally { written.mockRestore(); await phones.close() }
})

it('finishes the closing handshake with Node’s WebSocket', async () => {
  const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'WebSocket interop')
  const opened = await fetch(`http://127.0.0.1:${server.descriptor.port}/v1/session`, { method: 'POST', headers: { Authorization: `Bearer ${paired.token}` } })
  const { session } = await opened.json() as { session: string }
  const socket = new (WebSocket as unknown as NodeWebSocket)(`ws://127.0.0.1:${server.descriptor.port}/v1/socket`, { headers: { Authorization: `Bearer ${session}` } })
  const messages: unknown[] = []
  socket.addEventListener('message', event => messages.push(event.data))
  const closed = new Promise<CloseEvent>(resolve => socket.addEventListener('close', resolve))
  await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve()); socket.addEventListener('error', () => reject(new Error('The socket did not open.'))) })
  expect(socket.extensions).toContain('permessage-deflate')

  // A socket that has not said hello is sent nothing, so the Close reply is the only frame the host writes to it.
  socket.close(1000, 'done')
  const event = await closed
  expect(messages).toEqual([])
  expect({ code: event.code, reason: event.reason, wasClean: event.wasClean }).toEqual({ code: 1000, reason: 'done', wasClean: true })
})
