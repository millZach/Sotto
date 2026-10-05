// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import type { PhoneAccessTailscale } from '../../src/main/phones/phoneAccess'
import { standInTailscale } from '../fixtures/standInTailscale'
import type { HostPhonesCommand, PhonesState } from '../../src/shared/phones'

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

async function start(tailscale: PhoneAccessTailscale) {
  const providers = { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }
  const host = await startHeadlessHost({ dataDirectory: root, port: 0, providers, reasoner: e2eAgentReasoner, tailscale })
  hosts.push(host)
  const { adminToken } = JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8')) as { adminToken: string }
  const url = `http://127.0.0.1:${host.descriptor!.port}`
  const admin = async (route: 'phones' | 'phones-command', body: unknown, token = adminToken) => {
    const response = await fetch(`${url}/v1/admin/${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as { hostId: string; state: PhonesState; url?: string; error?: string } }
  }
  const command = async (input: HostPhonesCommand) => (await admin('phones-command', { command: input })).body
  const read = async () => (await admin('phones', {})).body.state
  return { host, admin, command, read }
}

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
