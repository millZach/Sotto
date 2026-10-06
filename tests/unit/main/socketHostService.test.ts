// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
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
const frozen = { v: 1, status: 'ready', hostId, pid: 4242, port: 4319, sottoVersion: '0.1.16', features: ['detail-delta', 'git-refs', 'git-changed-files', 'git-pull-request', 'host-folders'] }

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

describe('SocketHostService git-refs feature', () => {
  it('sends git-refs to no host that does not list the feature, and names the version instead', async () => {
    const url = await hostAnswering({ ...frozen, features: ['detail-delta'] })
    const client = new SocketHostService({ url, token: 'paired-token', owned: true })
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(client.gitRefs({ threadId: randomUUID() })).rejects.toMatchObject({ code: 'version_mismatch', message: hostVersionMismatch(packageVersion, '0.1.16', true) })
    await expect(client.gitChangedFiles({ threadId: randomUUID() })).rejects.toMatchObject({ code: 'version_mismatch' })
    await expect(client.gitPullRequest({ threadId: randomUUID() })).rejects.toMatchObject({ code: 'version_mismatch' })
    // A host from before staged images is sent no image, and has none to hand back.
    await expect(client.stageAttachment({ name: 'Shot.png', mimeType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) })).rejects.toMatchObject({ code: 'version_mismatch' })
    await expect(client.attachmentContent('a'.repeat(64))).resolves.toBeNull()
    expect(requested).toEqual(['/v1/health', '/v1/session'])
  })
})

describe('SocketHostService host-folders feature', () => {
  it('sends host-folders to no host that does not list the feature, and names the version instead', async () => {
    const url = await hostAnswering({ ...frozen, features: ['detail-delta'] })
    const client = new SocketHostService({ url, token: 'paired-token', owned: true })
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(client.hostFolders({})).rejects.toMatchObject({ code: 'version_mismatch', message: hostVersionMismatch(packageVersion, '0.1.16', true) })
    expect(requested).toEqual(['/v1/health', '/v1/session'])
  })
})

describe('SocketHostService thread tool features (ADR-0025, October 5 amendment)', () => {
  it('sends no Files, Changes or Agents read to a host that does not list its feature, and names the version instead', async () => {
    const url = await hostAnswering({ ...frozen, features: ['detail-delta', 'git-refs'] })
    const client = new SocketHostService({ url, token: 'paired-token', owned: false })
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated' })
    const message = hostVersionMismatch(packageVersion, '0.1.16', false)
    const workspaceId = 'a'.repeat(64)
    for (const read of [
      () => client.threadFiles({ threadId: 'thread', path: '' }), () => client.threadFilePreview({ threadId: 'thread', path: 'a.txt', workspaceId }),
      () => client.gitChanges({ threadId: 'thread' }), () => client.gitReview({ threadId: 'thread', workspaceId, scope: { kind: 'working' } }),
      () => client.subagentPage({ threadId: 'thread' }), () => client.subagentAssignments({ threadId: 'thread', agentId: 'agent' }),
    ]) await expect(read()).rejects.toMatchObject({ code: 'version_mismatch', message })
    expect(requested).toEqual(['/v1/health', '/v1/session'])
  })
  it('lets each surface\'s read through only on a host that lists that surface\'s own feature', async () => {
    const url = await hostAnswering({ ...frozen, features: ['thread-changes'] })
    const client = new SocketHostService({ url, token: 'paired-token', owned: true })
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated' })
    // Only a hello lists what this client may use (ADR-0053), and the stand-in refuses the session before one, so the
    // test lists what that hello would. tests/integration/socketHost.test.ts covers the hello itself.
    Object.assign(client, { features: ['thread-changes'] })
    await expect(client.threadFiles({ threadId: 'thread', path: '' })).rejects.toMatchObject({ code: 'version_mismatch' })
    await expect(client.subagentPage({ threadId: 'thread' })).rejects.toMatchObject({ code: 'version_mismatch' })
    // Listed, so the read is sent: with no socket open it fails as a dropped connection, not as the version.
    await expect(client.gitChanges({ threadId: 'thread' })).rejects.toMatchObject({ code: 'disconnected' })
  })
})

describe('the version sentence', () => {
  it('says which side to bring up to date, and offers Stop host only for a host Sotto started', () => {
    expect(hostIsNewer('0.1.16', '0.1.15')).toBe(true)
    expect(hostIsNewer('0.2.0', '0.10.0')).toBe(false)
    expect(hostIsNewer('0.1.15', '0.1.15')).toBe(false)
    expect(hostIsNewer(undefined, '0.1.15')).toBe(false)
    expect(hostVersionMismatch('0.1.16', '0.1.15', true)).toBe('This host is running a different version of Sotto. Nothing on the host was lost. Update it from the Threads page, or put the Sotto 0.1.16 host in its installation folder, press Stop host, then connect again.')
    expect(hostVersionMismatch('0.1.16', undefined, false)).toBe('This host is running a different version of Sotto. Nothing on the host was lost. Put the Sotto 0.1.16 host in its installation folder, stop the host on that machine, then connect again.')
    expect(hostVersionMismatch('0.1.15', '0.1.16', true)).toBe('This host is running a newer version of Sotto than this computer. Nothing on the host was lost. Update Sotto on this computer, then connect again.')
  })
})

it('keeps the saved pairing when an older host refuses an upgrade with 401', async () => {
  const url = await hostAnswering(frozen)
  server!.removeAllListeners('request')
  server!.on('request', (request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(request.url === '/v1/health' ? frozen : {
      v: 1, hostId, clientId: 'client', session: 'session', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }))
  })
  server!.on('upgrade', (_request, stream) => stream.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'))
  const client = new SocketHostService({ url, token: 'paired-token' })
  await expect(client.connect()).rejects.toMatchObject({ code: 'unavailable', pairingRequired: false })
})

describe('what a desktop uses of a host, and where it pairs (ADR-0053)', () => {
  it('uses only the features a hello listed, never the ones health listed for the listener', async () => {
    // Health lists everything the listener offers; this session is refused before any hello says what this client may use.
    const url = await hostAnswering({ ...frozen, features: [...frozen.features, 'provider-sign-in', 'client-updates', 'attachment-staging'] })
    const client = new SocketHostService({ url, token: 'paired-token' })
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(client.offersSignIn()).toBe(false)
    expect(client.offersClientUpdates()).toBe(false)
    await expect(client.signIn({ op: 'sign-in-start', provider: 'codex' })).rejects.toMatchObject({ code: 'version_mismatch' })
    await expect(client.gitRefs({ threadId: randomUUID() })).rejects.toMatchObject({ code: 'version_mismatch' })
    expect(requested).toEqual(['/v1/health', '/v1/session'])
  })

  it('sends a pairing code to this computer only, and never to a host’s tailnet address', async () => {
    const url = await hostAnswering(frozen)
    const sent = vi.spyOn(globalThis, 'fetch')
    try {
      for (const address of ['https://forge.tail5728ca.ts.net:8443', 'https://127.0.0.1:4319']) {
        await expect(SocketHostService.pair(address, 'synthetic-code', 'Sotto desktop')).rejects.toThrow('This computer pairs with a host only through its SSH connection. Nothing was sent.')
      }
      expect(sent).not.toHaveBeenCalled()
      // The forward on this computer is where pairing goes; the stand-in refuses the code, which is enough to show it was sent.
      await expect(SocketHostService.pair(url, 'synthetic-code', 'Sotto desktop')).rejects.toMatchObject({ code: 'unauthenticated' })
      expect(requested).toEqual(['/v1/pair'])
    } finally { sent.mockRestore() }
  })
})

describe('SocketHostService on a tailnet connection (ADR-0053)', () => {
  it('sends a host that answers as another one nothing of this device’s pairing', async () => {
    const url = await hostAnswering({ ...frozen, sottoVersion: packageVersion, hostId: randomUUID() })
    const client = new SocketHostService({ url, token: 'paired-token', expectedHostId: hostId })
    await expect(client.connect()).rejects.toMatchObject({ name: 'Error', code: 'unauthenticated', message: 'This address belongs to a different host. Check the connection before continuing.' })
    expect(requested).toEqual(['/v1/health'])
  })

  it('reads a 403 as the host refusing this device here, which keeps the pairing, and a 401 as pairing again', async () => {
    requested.length = 0
    let status = 403
    server = createServer((request, response) => {
      requested.push(request.url ?? '')
      if (request.url === '/v1/health') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ...frozen, sottoVersion: packageVersion })); return }
      response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ v: 1, error: { code: 'forbidden', message: 'Phones are off on forge.' } }))
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No loopback port.')
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + address.port, token: 'paired-token', expectedHostId: hostId })
    await expect(client.connect()).rejects.toMatchObject({ code: 'forbidden', pairingRequired: false })
    status = 401
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated', pairingRequired: true })
  })

  it('gives up on a health check that takes longer than the time it was given', async () => {
    requested.length = 0
    server = createServer(request => { requested.push(request.url ?? '') })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No loopback port.')
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + address.port, token: 'paired-token', healthTimeoutMs: 50 })
    await expect(client.connect()).rejects.toMatchObject({ name: 'TimeoutError' })
    server.closeAllConnections()
  })
})

describe('SocketHostService exact acceptance pushes', () => {
  it('accepts proof that arrives before its negative receipt reply, without accepting unknown or mismatched targets', async () => {
    const client = new SocketHostService({ url: 'http://127.0.0.1:1', token: 'unused' })
    Object.assign(client, { features: ['answer-receipts'], cached: emptyDesktopState() })
    const receive = (value: unknown) => (client as unknown as { receive(text: string): void }).receive(JSON.stringify(value))
    const target = { threadId: 'thread', providerId: 'claude' as const, requestId: 'question', questionsDigest: 'a'.repeat(64) }
    const proof = { ...target, decisionId: 'decision' }
    const notify = vi.fn(); client.subscribe(notify)
    vi.spyOn(client, 'receipt').mockImplementation(async () => {
      for (const changed of [{ decisionId: 'unknown' }, { threadId: 'other' }, { providerId: 'codex' },
        { requestId: 'other' }, { questionsDigest: 'b'.repeat(64) }]) {
        receive({ v: 1, event: 'answer-receipt', acceptedAnswer: { ...proof, ...changed } })
        expect(client.requestAnswerRecovery('thread', 'claude').completed).toEqual([])
      }
      receive({ v: 1, event: 'answer-receipt', acceptedAnswer: proof })
      return { status: 'unknown' }
    })
    await client.refreshRequestAnswer('decision', target)
    expect(client.requestAnswerRecovery('thread', 'claude').completed).toEqual([{ requestId: 'question', questionsDigest: target.questionsDigest, decisionId: 'decision' }])
    expect(notify).toHaveBeenCalledTimes(1)
    receive({ v: 1, event: 'answer-receipt', acceptedAnswer: proof })
    expect(notify).toHaveBeenCalledTimes(1)
  })
  it('bounds queried targets and refuses a decision being rebound to different questions', async () => {
    const client = new SocketHostService({ url: 'http://127.0.0.1:1', token: 'unused' })
    Object.assign(client, { features: ['answer-receipts'], cached: emptyDesktopState() })
    const receipt = vi.spyOn(client, 'receipt').mockResolvedValue({ status: 'unknown' })
    const target = { threadId: 'thread', providerId: 'claude' as const, requestId: 'question', questionsDigest: 'a'.repeat(64) }
    for (let i = 0; i < 513; i++) await client.refreshRequestAnswer(String(i), target)
    await client.refreshRequestAnswer('512', { ...target, questionsDigest: 'b'.repeat(64) })
    expect(receipt).toHaveBeenCalledTimes(513)
    const receive = (decisionId: string) => (client as unknown as { receive(text: string): void }).receive(JSON.stringify({ v: 1, event: 'answer-receipt', acceptedAnswer: { ...target, decisionId } }))
    receive('0')
    expect(client.requestAnswerRecovery('thread', 'claude').completed).toEqual([])
    receive('512')
    expect(client.requestAnswerRecovery('thread', 'claude').completed).toHaveLength(1)
  })
})
