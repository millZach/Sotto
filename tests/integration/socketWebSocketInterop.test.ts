// @vitest-environment node
/**
 * The host's socket against a WebSocket client Sotto did not write: Node's own global WebSocket. Every
 * other socket test has SocketFrames on both ends, so a framing mistake the two share would pass there.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { startSocketServer } from '../../src/host/socketServer'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'

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

  socket.send(JSON.stringify({ v: 1, id: 'hello-1', session, op: 'hello' }))
  const hello = await next(message => message.id === 'hello-1')
  expect(hello).toMatchObject({ v: 1, ok: true, result: { hostId: host.service.shell().hostId, clientId: paired.clientId, capabilities: { mayAnswer: false } } })

  const commandId = randomUUID()
  socket.send(JSON.stringify({ v: 1, id: commandId, session, op: 'command', command: { type: 'configure', patch: { enabled: false } } }))
  const reply = await next(message => message.id === commandId)
  expect(reply).toMatchObject({ v: 1, ok: true, result: { configuration: { enabled: false } } })
  expect(host.service.shell().configuration.enabled).toBe(false)
  // The change is pushed as well as answered: a shell event carrying it arrives unasked.
  const pushed = await next(message => message.event === 'shell' && (message.state as { configuration?: { enabled?: boolean } }).configuration?.enabled === false)
  expect(pushed).toMatchObject({ v: 1, event: 'shell', eventPage: expect.any(Object) })

  socket.close(1000, 'done')
  expect((await closed).code).toBe(1000)
})
