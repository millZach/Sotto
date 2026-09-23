// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { connect, createServer, Server } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { parseHostArguments, startHeadlessHost } from '../../src/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'

let root: string | undefined, host: Awaited<ReturnType<typeof startHeadlessHost>> | undefined
afterEach(async () => {
  await host?.close(); host = undefined
  if (root && dirname(root) === tmpdir()) await rm(root, { recursive: true, force: true })
  root = undefined
})
async function start(options: { startedBy?: 'launch-script' } = {}) {
  root ??= await mkdtemp(join(tmpdir(), 'sotto-host-listener-'))
  host = await startHeadlessHost({ dataDirectory: root, port: 0, ...options, reasoner: e2eAgentReasoner,
    providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() } })
  return host
}
/** Every address this machine has on an interface other than loopback. */
const external = Object.values(networkInterfaces()).flat()
  .filter(item => item !== undefined && !item.internal && (item.family === 'IPv4' || !item.address.startsWith('fe80')))
  .map(item => item!.address)
function reach(address: string, port: number): Promise<'connected' | 'unreachable'> {
  return new Promise(done => {
    const socket = connect({ host: address, port, localAddress: address, timeout: 5000 })
    socket.once('connect', () => { socket.destroy(); done('connected') })
    socket.once('timeout', () => { socket.destroy(); done('unreachable') })
    socket.once('error', () => done('unreachable'))
  })
}

it('listens on the loopback address only', async () => {
  const listen = vi.spyOn(Server.prototype, 'listen')
  let servers: Server[]
  try { await start() } finally { servers = [...listen.mock.contexts] as Server[]; listen.mockRestore() }
  const listener = servers.find(server => { const address = server.address(); return typeof address === 'object' && address?.port === host!.descriptor!.port })
  expect(listener?.address()).toEqual({ address: '127.0.0.1', family: 'IPv4', port: host!.descriptor!.port })
})
it.skipIf(external.length === 0)('cannot be reached by a client bound to any other interface', async () => {
  // The probe itself works: a listener on every interface is reached the same way.
  const open = createServer(socket => socket.destroy())
  await new Promise<void>(resolve => open.listen(0, resolve))
  const port = (open.address() as { port: number }).port
  try { expect(await reach(external[0]!, port)).toBe('connected') } finally { open.close() }
  const running = await start()
  const results = await Promise.all(external.map(async address => [address, await reach(address, running.descriptor!.port)]))
  expect(results).toEqual(external.map(address => [address, 'unreachable']))
})
it('records in its descriptor that the launch script started it, and only then', async () => {
  await start({ startedBy: 'launch-script' })
  expect(JSON.parse(await readFile(join(root!, 'host-listener.json'), 'utf8'))).toMatchObject({ startedBy: 'launch-script', pid: process.pid })
  await host!.close(); host = undefined
  await start()
  expect(JSON.parse(await readFile(join(root!, 'host-listener.json'), 'utf8'))).not.toHaveProperty('startedBy')
})
it('reads the launch script mark from SOTTO_HOST_STARTED_BY and nothing else', () => {
  expect(parseHostArguments(['--data', './data'], { SOTTO_HOST_STARTED_BY: 'launch-script' })).toEqual({ dataDirectory: resolve('data'), port: 0, startedBy: 'launch-script' })
  expect(parseHostArguments(['--data', './data'], { SOTTO_HOST_STARTED_BY: 'someone' })).toEqual({ dataDirectory: resolve('data'), port: 0 })
})
