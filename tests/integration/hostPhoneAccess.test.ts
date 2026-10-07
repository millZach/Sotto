// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import type { PhoneAccessTailscale } from '../../src/main/phones/phoneAccess'
import { standInTailscale } from '../fixtures/standInTailscale'
import type { HostPhonesCommand, PhonesState } from '../../src/shared/phones'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { phonesOff } from '../../src/host/socketServer'
import { ensureFixtureDesktopAnswers } from '../fixtures/sshDesktopAnswers'
import { rawPeer } from '../fixtures/rawHostPeer'

// A headless host's own phone access (ADR-0050), driven the way the desktop drives it: on the host's administrative
// routes with its token. Tailscale is a stand-in that holds one Serve setting, so a restart can be seen to put it back.

const DNS = 'forge.tail5728ca.ts.net'

let root: string
let hosts: { close(): Promise<void> }[] = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sotto-host-phones-')); hosts = [] })
afterEach(async () => {
  for (const host of hosts.reverse()) await host.close().catch(() => undefined)
  if (dirname(root) === tmpdir() && root.includes('sotto-host-phones-')) await rm(root, { recursive: true, force: true })
})

async function start(tailscale: PhoneAccessTailscale, options: { startedBy?: 'launch-script'; log?: (event: string) => void } = {}) {
  const providers = { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }
  const host = await startHeadlessHost({ dataDirectory: root, port: 0, providers, reasoner: e2eAgentReasoner, tailscale, ...options })
  hosts.push(host)
  const { adminToken } = JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8')) as { adminToken: string }
  const url = `http://127.0.0.1:${host.descriptor!.port}`
  const admin = async (route: 'phones' | 'phones-command' | 'tailnet' | 'pairing-code' | 'revoke-client', body: unknown, token = adminToken) => {
    const response = await fetch(`${url}/v1/admin/${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as { hostId: string; state: PhonesState; enabled?: boolean; url?: string; error?: string; code?: string; revoked?: boolean } }
  }
  const command = async (input: HostPhonesCommand) => (await admin('phones-command', { command: input })).body
  const read = async () => (await admin('phones', {})).body.state
  /** Turns the host's tailnet connections on or off the way a desktop does over SSH, and answers once Serve has followed. */
  const tailnet = async (enabled?: boolean) => (await admin('tailnet', enabled === undefined ? {} : { enabled })).body
  /** Pairs a client the way the host's own `--pairing-code` does, on the listener with the administrative routes. */
  const pair = async (name: string) => {
    const { code } = (await fetch(`${url}/v1/admin/pairing-code`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } }).then(response => response.json())) as { code: string }
    return await SocketHostService.pair(url, code, name)
  }
  /** What the launch script does over SSH once a desktop's paired client ID is confirmed: its grant, and its record as a desktop. */
  const recordDesktop = (clientId: string) => ensureFixtureDesktopAnswers(root, host.descriptor!.hostId, clientId)
  return { host, admin, command, read, tailnet, pair, recordDesktop }
}
const opened: SocketHostService[] = []
afterEach(async () => { for (const service of opened.splice(0)) await service.close().catch(() => undefined) })
/** A client's connection to a listener, closed after the test. */
function client(port: number, token: string): SocketHostService {
  const service = new SocketHostService({ url: `http://127.0.0.1:${port}`, token, catchUpEvents: false })
  opened.push(service)
  return service
}
const session = (port: number, token: string) => fetch(`http://127.0.0.1:${port}/v1/session`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })

it('turns phone access on from the administrative routes, serves the host on a loopback port of its own, and pairs a phone there', async () => {
  const stand = standInTailscale()
  const { host, admin, command, read } = await start(stand.tailscale)
  expect((await admin('phones', {}, 'not-the-token-0000000000000000000000000')).status).toBe(401)
  // Never used, it never runs Tailscale.
  expect(await read()).toMatchObject({ enabled: false, phase: 'off', phones: [] })
  expect(stand.calls).toEqual([])

  const turned = await command({ type: 'set-enabled', enabled: true })
  expect(turned.hostId).toBe(host.descriptor!.hostId)
  await vi.waitFor(async () => expect(await read()).toMatchObject({ enabled: true, phase: 'on', address: `https://${DNS}:8443`, computerName: 'forge' }))
  const phonePort = stand.proxied()!
  expect(phonePort).not.toBe(host.descriptor!.port)

  // The phone listener answers health with the host's name, and has no administrative routes for the tailnet to reach.
  const health = await (await fetch(`http://127.0.0.1:${phonePort}/v1/health`)).json() as { hostId: string; name?: string }
  expect(health).toMatchObject({ hostId: host.descriptor!.hostId, name: 'forge' })
  expect((await fetch(`http://127.0.0.1:${phonePort}/v1/admin/phones`, { method: 'POST', body: '{}' })).status).toBe(400)

  const { state: shown } = await command({ type: 'show-code' })
  const paired = await (await fetch(`http://127.0.0.1:${phonePort}/v1/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, code: shown.code!.code, name: 'Zach’s iPhone' }) })).json() as { clientId: string }
  await vi.waitFor(async () => expect(await read()).toMatchObject({ code: null, phones: [{ clientId: paired.clientId, name: 'Zach’s iPhone', canAnswer: false }] }))
  // A client paired from the host's own pairing command, as a desktop is, is no phone and is not listed.
  const { code: desktopCode } = await (await fetch(`http://127.0.0.1:${host.descriptor!.port}/v1/admin/pairing-code`, { method: 'POST', headers: { Authorization: `Bearer ${JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8')).adminToken as string}` } })).json() as { code: string }
  await fetch(`http://127.0.0.1:${host.descriptor!.port}/v1/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, code: desktopCode, name: 'Sotto desktop' }) })
  expect((await read()).phones.map(phone => phone.name)).toEqual(['Zach’s iPhone'])
  // One pairing store: the host's own listing knows the phone too.
  expect(host.pairing.list().map(client => client.clientId)).toContain(paired.clientId)
  expect((await command({ type: 'set-can-answer', clientId: paired.clientId, allowed: true })).state.phones[0]).toMatchObject({ canAnswer: true })
  expect(await command({ type: 'set-can-answer', clientId: 'not-a-client', allowed: true })).toMatchObject({ error: 'That phone is no longer paired. Nothing was changed.' })
})

it('takes its Serve setting away when it stops, and puts it back on the same port when it starts again', async () => {
  const stand = standInTailscale()
  const first = await start(stand.tailscale)
  await first.command({ type: 'set-enabled', enabled: true })
  await vi.waitFor(async () => expect((await first.read()).phase).toBe('on'))
  const port = stand.proxied()
  await first.host.close()
  expect(stand.calls.at(-1)).toBe('unserve')
  expect(stand.proxied()).toBeUndefined()

  const second = await start(stand.tailscale)
  await vi.waitFor(async () => expect((await second.read()).phase).toBe('on'))
  expect(stand.proxied()).toBe(port)

  // Off is the host's own setting too, so the next start leaves Tailscale alone.
  await second.command({ type: 'set-enabled', enabled: false })
  await vi.waitFor(async () => expect(await second.read()).toMatchObject({ enabled: false, phase: 'off' }))
  expect(stand.proxied()).toBeUndefined()
  await second.host.close()
  const calls = stand.calls.length
  const third = await start(stand.tailscale)
  expect(await third.read()).toMatchObject({ enabled: false, phase: 'off' })
  expect(stand.calls.length).toBe(calls)
})

it('hands back Tailscale’s page for turning Serve on, for the desktop to open, rather than opening anything itself', async () => {
  const stand = standInTailscale({ ok: false, reason: 'not-enabled', enableUrl: 'https://login.tailscale.com/f/serve?node=forge1' })
  const { command, read } = await start(stand.tailscale)
  await command({ type: 'set-enabled', enabled: true })
  await vi.waitFor(async () => expect(await read()).toMatchObject({ phase: 'failed', serve: { status: 'failed', reason: 'not-enabled', canOpenSetup: true } }))
  expect(await command({ type: 'open-serve-setup' })).toMatchObject({ url: 'https://login.tailscale.com/f/serve?node=forge1' })
  expect((await command({ type: 'show-code' })).error).toMatch(/^Turn on Let phones connect first/u)
})

it('carries a recorded desktop on the tailnet listener with phone access off, and refuses phones there, pairing included (ADR-0053)', async () => {
  const stand = standInTailscale()
  const { host, tailnet, pair, recordDesktop, admin } = await start(stand.tailscale, { startedBy: 'launch-script' })
  const desktop = await pair('Sotto desktop')
  await recordDesktop(desktop.clientId)
  const phone = await pair('Zach’s iPhone')

  // Off until a desktop turns it on, and then Serve carries the listener with phone access still off.
  expect(await tailnet()).toMatchObject({ enabled: false, state: { enabled: false, phase: 'off' } })
  expect(stand.calls).toEqual([])
  expect(await tailnet(true)).toMatchObject({ enabled: true, state: { enabled: false, phase: 'on', address: `https://${DNS}:8443` } })
  const port = stand.proxied()!
  expect(port).not.toBe(host.descriptor!.port)

  // Health lists every feature the listener offers, and where the tailnet reaches it; the host records the address too.
  const health = await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json() as { features: string[]; tailnetAddress?: string; startedBy?: string; name?: string }
  expect(health.features).toEqual(expect.arrayContaining(['provider-sign-in', 'client-updates']))
  expect(health).toMatchObject({ tailnetAddress: `https://${DNS}:8443`, startedBy: 'launch-script' })
  await vi.waitFor(async () => expect(JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8'))).toMatchObject({ tailnetAddress: `https://${DNS}:8443`, startedBy: 'launch-script' }))

  // The recorded desktop gets the full features, the host's address and its phone access in the row's words.
  const hello = await client(port, desktop.token).connect()
  expect(hello.features).toEqual(expect.arrayContaining(['provider-sign-in', 'client-updates']))
  expect(hello).toMatchObject({ clientId: desktop.clientId, tailnetAddress: `https://${DNS}:8443`, startedBy: 'launch-script', phoneAccess: { status: 'off', phones: 0 } })

  // A phone is refused a session, and nobody pairs here while phone access is off.
  const refused = await session(port, phone.token)
  expect(refused.status).toBe(403)
  // Named for the host as phones show it, saying the pairing is kept, since 403 is not 401's "pair again".
  expect(health.name).toBeTruthy()
  expect(await refused.json()).toMatchObject({ error: { code: 'forbidden', message: phonesOff(health.name) } })
  expect(phonesOff(health.name)).toContain(`Phone access is off on ${health.name}. Your pairing is kept.`)
  const { code } = (await admin('pairing-code', {})).body as { code: string }
  const pairing = await fetch(`http://127.0.0.1:${port}/v1/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, code, name: 'Another phone' }) })
  expect(pairing.status).toBe(403)
  // The code was not spent: it still pairs where pairing is allowed.
  await expect(SocketHostService.pair(`http://127.0.0.1:${host.descriptor!.port}`, code, 'Another desktop')).resolves.toMatchObject({ hostId: host.descriptor!.hostId })
})

it('writes the descriptor again after a write failed, so the launch script learns the tailnet address without a restart', async () => {
  const stand = standInTailscale()
  const events: string[] = []
  const { tailnet, command } = await start(stand.tailscale, { log: event => events.push(event) })
  const path = join(root, 'host-listener.json')
  const saved = await readFile(path, 'utf8')
  // A descriptor that cannot be replaced, standing in for a full disk or a denied write, as Serve comes up.
  await rm(path); await mkdir(path)
  await tailnet(true)
  await vi.waitFor(() => expect(events).toContain('host-descriptor-write-failed'))
  await rm(path, { recursive: true }); await writeFile(path, saved)
  // The next change to phone access writes it, with the address: the failed write did not stop the ones after it.
  await command({ type: 'set-enabled', enabled: true })
  await vi.waitFor(async () => expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ tailnetAddress: `https://${DNS}:8443` }))
})

it('treats a client paired from the host’s own pairing code and recorded nowhere as a phone, until the launch script records it', async () => {
  const stand = standInTailscale()
  const { command, read, pair, recordDesktop } = await start(stand.tailscale)
  await command({ type: 'set-enabled', enabled: true })
  await vi.waitFor(async () => expect((await read()).phase).toBe('on'))
  const port = stand.proxied()!
  const unknown = await pair('Sotto desktop')

  // In neither file: a phone, offered today's list and told nothing a desktop is told.
  const asPhone = await client(port, unknown.token).connect()
  expect(asPhone.features).not.toContain('provider-sign-in')
  expect(asPhone.features).not.toContain('client-updates')
  expect(asPhone.features).toContain('detail-delta')
  expect(asPhone.phoneAccess).toBeUndefined()
  // And it is no phone the Phones dialog lists either.
  expect((await read()).phones).toEqual([])

  // Its next SSH connect records it, and its next session on the tailnet is a desktop's.
  await recordDesktop(unknown.clientId)
  const asDesktop = await client(port, unknown.token).connect()
  expect(asDesktop.features).toEqual(expect.arrayContaining(['provider-sign-in', 'client-updates']))
  expect(asDesktop.phoneAccess).toEqual({ status: 'on', phones: 0 })
})

it('counts nobody as a desktop when the record of desktops cannot be read', async () => {
  const stand = standInTailscale()
  const { tailnet, pair, recordDesktop } = await start(stand.tailscale)
  const desktop = await pair('Sotto desktop')
  await recordDesktop(desktop.clientId)
  await tailnet(true)
  const port = stand.proxied()!
  expect((await session(port, desktop.token)).status).toBe(200)
  await writeFile(join(root, 'desktop-clients.json'), '{ not json')
  expect((await session(port, desktop.token)).status).toBe(403)
})

it('drops a connected phone when phone access turns off and keeps the desktop beside it connected', async () => {
  const stand = standInTailscale()
  const { command, read, tailnet, pair, recordDesktop } = await start(stand.tailscale)
  const desktop = await pair('Sotto desktop')
  await recordDesktop(desktop.clientId)
  await tailnet(true)
  await command({ type: 'set-enabled', enabled: true })
  const { state: shown } = await command({ type: 'show-code' })
  const port = stand.proxied()!
  const phone = await SocketHostService.pair(`http://127.0.0.1:${port}`, shown.code!.code, 'Zach’s iPhone')
  const changes: boolean[] = []
  const phoneService = new SocketHostService({ url: `http://127.0.0.1:${port}`, token: phone.token, catchUpEvents: false, onConnectionChange: connected => changes.push(connected) })
  opened.push(phoneService)
  await phoneService.connect()
  const desktopChanges: boolean[] = []
  const desktopService = new SocketHostService({ url: `http://127.0.0.1:${port}`, token: desktop.token, catchUpEvents: false, onConnectionChange: connected => desktopChanges.push(connected) })
  opened.push(desktopService)
  await desktopService.connect()
  await vi.waitFor(async () => expect((await read()).phones).toMatchObject([{ clientId: phone.clientId, connected: true }]))

  await command({ type: 'set-enabled', enabled: false })
  await vi.waitFor(() => expect(changes).toEqual([true, false]))
  // Serve stays for the desktop, whose socket is untouched, and phones are shown no code.
  expect(stand.proxied()).toBe(port)
  expect(desktopChanges).toEqual([true])
  expect((await command({ type: 'show-code' })).error).toMatch(/^Turn on Let phones connect first/u)
})

it('turns tailnet connections off itself when the last desktop is revoked, so Forget leaves no Serve setting behind', async () => {
  const stand = standInTailscale()
  const { tailnet, pair, recordDesktop, admin } = await start(stand.tailscale)
  const first = await pair('Sotto desktop')
  const second = await pair('Studio desktop')
  await recordDesktop(first.clientId)
  await recordDesktop(second.clientId)
  await tailnet(true)
  expect(stand.proxied()).toBeDefined()

  // Another desktop is still paired, so the host keeps carrying it.
  expect((await admin('revoke-client', { clientId: first.clientId })).body).toMatchObject({ revoked: true })
  await vi.waitFor(async () => expect(JSON.parse(await readFile(join(root, 'desktop-clients.json'), 'utf8'))).toEqual([second.clientId]))
  expect(await tailnet()).toMatchObject({ enabled: true })
  expect(stand.proxied()).toBeDefined()

  // The last one forgets itself on the tailnet listener; with phone access off, Serve goes with the setting.
  const port = stand.proxied()!
  expect((await fetch(`http://127.0.0.1:${port}/v1/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${second.token}` } })).status).toBe(200)
  await vi.waitFor(async () => expect(await tailnet()).toMatchObject({ enabled: false, state: { phase: 'off' } }))
  expect(stand.proxied()).toBeUndefined()
})

it('keeps the tailnet listener up for phones when the last desktop is revoked with phone access on', async () => {
  const stand = standInTailscale()
  const { command, read, tailnet, pair, recordDesktop, admin } = await start(stand.tailscale)
  const desktop = await pair('Sotto desktop')
  await recordDesktop(desktop.clientId)
  await tailnet(true)
  await command({ type: 'set-enabled', enabled: true })
  await admin('revoke-client', { clientId: desktop.clientId })
  await vi.waitFor(async () => expect(await tailnet()).toMatchObject({ enabled: false }))
  expect(await read()).toMatchObject({ enabled: true, phase: 'on' })
  expect(stand.proxied()).toBeDefined()
})

it('keeps a desktop’s observed threads apart on the host’s two listeners, and answers its retried command from one receipt across them', async () => {
  const stand = standInTailscale()
  const { host, tailnet, pair, recordDesktop } = await start(stand.tailscale)
  const desktop = await pair('Sotto desktop')
  await recordDesktop(desktop.clientId)
  await tailnet(true)
  const command = vi.spyOn(host.service, 'command')
  const session = host.pairing.signSession(desktop.clientId)
  const overSsh = await rawPeer(host.descriptor!.port, session)
  const overTailnet = await rawPeer(stand.proxied()!, session)
  try {
    await overSsh.call('observe-ssh', { op: 'observe', threadIds: ['thread-over-ssh'] })
    await overTailnet.call('observe-tailnet', { op: 'observe', threadIds: ['thread-over-tailnet'] })
    const keys = command.mock.calls.filter(([input]) => input.type === 'observe-threads').map(([, client]) => client.clientId)
    expect(new Set(keys).size).toBe(2)

    const interrupt = { op: 'command', command: { type: 'interrupt', threadId: 'missing' } }
    await overSsh.call('moved-command', interrupt)
    await overTailnet.call('moved-command', interrupt)
    expect(command.mock.calls.filter(([input]) => input.type === 'interrupt')).toHaveLength(1)
  } finally { overSsh.frames.close(); overTailnet.frames.close(); command.mockRestore() }
})

it('puts Serve back for desktops when it starts again with tailnet connections on and phone access off', async () => {
  const stand = standInTailscale()
  const first = await start(stand.tailscale)
  await first.tailnet(true)
  const port = stand.proxied()
  await first.host.close()
  expect(stand.proxied()).toBeUndefined()
  const second = await start(stand.tailscale)
  await vi.waitFor(async () => expect(await second.tailnet()).toMatchObject({ enabled: true, state: { enabled: false, phase: 'on' } }))
  expect(stand.proxied()).toBe(port)
})

it('leaves tailnet connections on when a client that is no desktop is revoked, with no desktop recorded yet', async () => {
  const stand = standInTailscale()
  const { command, tailnet, admin } = await start(stand.tailscale)
  await tailnet(true)
  await command({ type: 'set-enabled', enabled: true })
  const { state: shown } = await command({ type: 'show-code' })
  const phone = await SocketHostService.pair(`http://127.0.0.1:${stand.proxied()!}`, shown.code!.code, 'Zach’s iPhone')
  expect((await fetch(`http://127.0.0.1:${stand.proxied()!}/v1/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${phone.token}` } })).status).toBe(200)
  await admin('revoke-client', { clientId: 'never-paired' })
  expect(await tailnet()).toMatchObject({ enabled: true })
})
