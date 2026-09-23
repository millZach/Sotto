// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { SocketHostService } from '../../../src/main/agents/socketHostService'
import { HOST_VERSION_MISMATCH } from '../../../src/shared/hostProtocol'

let server: Server | undefined
const requested: string[] = []
/** A loopback stand-in for a host that answers /v1/health with the given body and refuses everything else. */
async function hostAnswering(health: unknown): Promise<string> {
  requested.length = 0
  server = createServer((request, response) => {
    requested.push(request.url ?? '')
    if (request.url === '/v1/health') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(health)); return }
    response.writeHead(401); response.end()
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No loopback port.')
  return 'http://127.0.0.1:' + address.port
}
afterEach(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); server = undefined })

const hostId = randomUUID()
const frozen = { v: 1, status: 'ready', hostId, pid: 4242, port: 4319, sottoVersion: '0.1.16', features: ['detail-delta'] }

describe('SocketHostService version check', () => {
  it('names a host from before protocol v1 froze and says how to start the new version, before sending it anything', async () => {
    // What a 0.1.15 host answers: protocol version 1, but no Sotto version and no features.
    const url = await hostAnswering({ v: 1, status: 'ready', hostId, pid: 4242, port: 4319 })
    const client = new SocketHostService({ url, token: 'paired-token' })
    await expect(client.connect()).rejects.toMatchObject({ code: 'version_mismatch', message: HOST_VERSION_MISMATCH })
    expect(HOST_VERSION_MISMATCH).toContain('Stop host, then connect again to start the new version.')
    expect(HOST_VERSION_MISMATCH).not.toContain('not supported')
    expect(requested).toEqual(['/v1/health'])
  })

  it('names a host speaking another protocol version the same way', async () => {
    const url = await hostAnswering({ ...frozen, v: 2 })
    const client = new SocketHostService({ url, token: 'paired-token' })
    await expect(client.connect()).rejects.toMatchObject({ code: 'version_mismatch', message: HOST_VERSION_MISMATCH })
    expect(requested).toEqual(['/v1/health'])
  })

  it('goes on to open a session with a host that speaks v1, whatever its Sotto version, and ignores features it does not know', async () => {
    const url = await hostAnswering({ ...frozen, sottoVersion: '9.9.9', features: ['detail-delta', 'a-later-feature'] })
    const client = new SocketHostService({ url, token: 'paired-token' })
    // The stand-in refuses the session; what matters is that the version check let the client ask for one.
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(requested).toEqual(['/v1/health', '/v1/session'])
  })
})
