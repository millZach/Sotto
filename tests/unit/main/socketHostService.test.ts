// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { SocketHostService } from '../../../src/main/agents/socketHostService'
import { hostIsNewer, hostVersionMismatch } from '../../../src/shared/hostProtocol'
import { version as packageVersion } from '../../../package.json'

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
    const client = new SocketHostService({ url, token: 'paired-token', owned: true })
    const message = hostVersionMismatch(packageVersion, undefined, true)
    await expect(client.connect()).rejects.toMatchObject({ code: 'version_mismatch', message })
    // Connect starts whatever is installed, so the sentence names the version to put there before Stop host.
    expect(message).toContain(`Put the Sotto ${packageVersion} host in its installation folder, press Stop host, then connect again.`)
    expect(message).not.toContain('not supported')
    expect(requested).toEqual(['/v1/health'])
  })

  it('names an older host speaking another protocol version the same way', async () => {
    const url = await hostAnswering({ ...frozen, v: 2, sottoVersion: '0.0.1' })
    const client = new SocketHostService({ url, token: 'paired-token' })
    await expect(client.connect()).rejects.toMatchObject({ code: 'version_mismatch', message: hostVersionMismatch(packageVersion, '0.0.1', false) })
    expect(client.hostIsNewer()).toBe(false)
    expect(requested).toEqual(['/v1/health'])
  })

  it('asks for this computer to be updated when the host is the newer side, since restarting it would not help', async () => {
    const url = await hostAnswering({ ...frozen, v: 2, sottoVersion: '99.0.0' })
    const client = new SocketHostService({ url, token: 'paired-token', owned: true })
    await expect(client.connect()).rejects.toMatchObject({ code: 'version_mismatch', message: expect.stringContaining('Update Sotto on this computer, then connect again.') })
    expect(client.hostIsNewer()).toBe(true)
  })

  it('goes on to open a session with a host that speaks v1, whatever its Sotto version, and ignores features it does not know', async () => {
    const url = await hostAnswering({ ...frozen, sottoVersion: '9.9.9', features: ['detail-delta', 'a-later-feature'] })
    const client = new SocketHostService({ url, token: 'paired-token' })
    // The stand-in refuses the session; what matters is that the version check let the client ask for one.
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(requested).toEqual(['/v1/health', '/v1/session'])
  })
})

describe('the version sentence', () => {
  it('says which side to bring up to date, and offers Stop host only for a host Sotto started', () => {
    expect(hostIsNewer('0.1.16', '0.1.15')).toBe(true)
    expect(hostIsNewer('0.2.0', '0.10.0')).toBe(false)
    expect(hostIsNewer('0.1.15', '0.1.15')).toBe(false)
    expect(hostIsNewer(undefined, '0.1.15')).toBe(false)
    expect(hostVersionMismatch('0.1.16', '0.1.15', true)).toBe('This host is running a different version of Sotto. Nothing on the host was lost. Put the Sotto 0.1.16 host in its installation folder, press Stop host, then connect again.')
    expect(hostVersionMismatch('0.1.16', undefined, false)).toBe('This host is running a different version of Sotto. Nothing on the host was lost. Put the Sotto 0.1.16 host in its installation folder, stop the host on that machine, then connect again.')
    expect(hostVersionMismatch('0.1.15', '0.1.16', true)).toBe('This host is running a newer version of Sotto than this computer. Nothing on the host was lost. Update Sotto on this computer, then connect again.')
  })
})
