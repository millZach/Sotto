// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startHeadlessHost, type HostStartedBy } from '../../src/host'
import { HostCredentialEncryption } from '../../src/host/credentials'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { DesktopHosts } from '../../src/main/hosts/desktopHosts'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { SshHostLauncher, type SshBootResult, type SshConnectOptions, type SshHostConnection } from '../../src/main/hosts/sshLauncher'
import { TAILNET_STORE_FILE } from '../../src/main/hosts/tailnetStore'
import { hostTailnetSetting } from '../../src/main/hosts/hostTailnetSetting'
import { BOOT_TAILNET_ONLY_MS } from '../../src/main/hosts/hostConnectionPlan'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import type { RemoteHost } from '../../src/shared/hosts'
import { ensureFixtureDesktopAnswers } from '../fixtures/sshDesktopAnswers'
import { standInTailscale } from '../fixtures/standInTailscale'
import { serveStandIn } from '../fixtures/serveStandIn'

// A desktop reaches a host over its tailnet first (ADR-0053), against a real headless host whose tailnet listener sits
// behind a stand-in for Tailscale Serve, and a scripted SSH whose every connect is counted: a connect that needs no SSH
// makes none.

const DNS = 'forge.tail5728ca.ts.net'
const ADDRESS = `https://${DNS}:8443`
let root: string, data: string
let host: Awaited<ReturnType<typeof startHeadlessHost>>
let hostTailscale: ReturnType<typeof standInTailscale>
let stand: Awaited<ReturnType<typeof serveStandIn>>
let credentials: AgentCredentials, router: DesktopHostRouter, manager: DesktopHosts
const launchers: FixtureSsh[] = []
/** Every launch script operation a fixture connection ran, with the kind of connection it ran on. */
const operations: string[] = []
let returnMs = 60_000
/** How long a reconnect waits; at once unless a test holds it to see the threads reading Reconnecting. */
let retryMs = 0
/** Whether Tailscale is installed on the host's machine; the stand-in's Serve is used only while it is. */
let tailscaleInstalled = true
/** Whether the host's Serve is refused until the SSH account is Tailscale's operator, as Linux asks. */
let serveDenied = false
/** The desktop's clock, which a test moves on to pass a boot host's first minute of retries. */
let clock = 0
/** A token the fixture's connections hand out instead of the host's, as a host that will not take it would see. */
let adminTokenOverride: string | undefined
/** Holds every administrative token request until released, so a press stays running while something else happens. */
let tokenGate: Promise<void> | undefined
/** Fails every administrative token request as a dropped SSH connection would, with no answer from the host. */
let tokenUnanswered = false
/** What a start at boot change on the fixture's connections answers; none has one unless a test gives it. */
let bootChange: (() => Promise<SshBootResult>) | undefined
const bootOn = { supported: true, installed: true, enabled: true, active: true, linger: true, nodeDrift: false } as const

const descriptor = async () => JSON.parse(await readFile(join(data, 'host-listener.json'), 'utf8')) as { adminToken: string; hostId: string; tailnetAddress?: string; startedBy?: string }
async function admin(route: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${host.descriptor!.port}/v1/admin/${route}`, { method: 'POST', headers: { Authorization: `Bearer ${(await descriptor()).adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return await response.json() as Record<string, unknown>
}

/** SSH as the launch script answers it, on this machine: the host's own listener as the forward, and its descriptor read. */
class FixtureSsh extends SshHostLauncher {
  disconnected = false
  options?: SshConnectOptions
  override async connect(...[, , options = {}]: Parameters<SshHostLauncher['connect']>): Promise<SshHostConnection> {
    this.options = options
    const which = options.start === false ? 'admin' : 'ssh'
    const about = await descriptor()
    return { url: 'http://127.0.0.1:' + host.descriptor!.port, hostId: about.hostId, owned: true, route: { hostname: 'forge', identityFiles: [] },
      ...(about.tailnetAddress ? { tailnetAddress: about.tailnetAddress } : {}),
      close: async () => undefined,
      showHostPairingCode: async () => ({ ...host.pairing.issuePairingCode(), hostId: about.hostId }),
      ensureDesktopAnswers: async clientId => { operations.push(`${which} desktop-answers`); await ensureFixtureDesktopAnswers(data, about.hostId, clientId) },
      revokeClient: async clientId => { operations.push(`${which} revoke-client`); return (await admin('revoke-client', { clientId })).revoked === true },
      hostAdminToken: async () => { await tokenGate; if (tokenUnanswered) throw new Error('ssh: connection reset'); return adminTokenOverride ?? (await descriptor()).adminToken },
      stopHost: async () => { operations.push(`${which} stop-host`); return true },
      updateHost: async () => { throw new Error('This fixture host has no update.') },
      boot: async () => { if (!bootChange) throw new Error('This fixture host has no start at boot.'); return bootChange() },
    }
  }
  override async disconnect(): Promise<void> { this.disconnected = true }
}

function startHost(startedBy: HostStartedBy) {
  const standIn = hostTailscale.tailscale
  return startHeadlessHost({ dataDirectory: data, port: 0, providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() },
    reasoner: e2eAgentReasoner, tailscale: { ...standIn, status: async () => tailscaleInstalled ? standIn.status() : { state: 'missing' },
      serve: async (port, loopback) => serveDenied ? { ok: false, reason: 'denied' } : standIn.serve(port, loopback) }, startedBy })
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sotto-desktop-tailnet-'))
  data = join(root, 'remote')
  hostTailscale = standInTailscale({ ok: true }, DNS)
  tailscaleInstalled = true; serveDenied = false; clock = Date.now(); adminTokenOverride = undefined; tokenGate = undefined; tokenUnanswered = false; bootChange = undefined
  host = await startHost('launch-script')
  stand = await serveStandIn(() => hostTailscale.proxied())
  credentials = new AgentCredentials(join(root, 'desktop'), new HostCredentialEncryption('synthetic-desktop-credential-key')); await credentials.load()
  router = new DesktopHostRouter(emptyDesktopState)
  launchers.length = 0; operations.length = 0; returnMs = 60_000; retryMs = 0
  manager = newManager()
  await manager.start()
})
afterEach(async () => {
  await manager?.close(); router?.dispose(); await stand?.close(); await host?.close()
  if (root && dirname(root) === tmpdir() && root.includes('sotto-desktop-tailnet-')) await rm(root, { recursive: true, force: true })
})
function newManager(): DesktopHosts {
  return new DesktopHosts({ directory: join(root, 'desktop'), credentials, router, localHostRunning: false, localHostEnabled: () => false, restart: () => undefined, retryDelayMs: () => retryMs, now: () => clock,
    launcher: () => { const launcher = new FixtureSsh(); launchers.push(launcher); return launcher }, tailnetReturnMs: returnMs,
    // MagicDNS and Serve's certificate cannot run here: the forge name goes to the stand-in on loopback.
    resolveTailnet: address => new URL(address).hostname === DNS ? stand.url : address })
}
async function relaunch(): Promise<void> {
  await manager.close(); router.dispose(); router = new DesktopHostRouter(emptyDesktopState)
  launchers.length = 0; operations.length = 0
  manager = newManager()
  await manager.start()
}
const connection = (): Omit<RemoteHost, 'enabled'> => ({ id: randomUUID(), name: 'forge', target: 'forge', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data/sotto' })
async function add(): Promise<Omit<RemoteHost, 'enabled'>> { const remote = connection(); await manager.command({ type: 'add', host: remote }); return remote }
const saved = async () => JSON.parse(await readFile(join(root, 'desktop', TAILNET_STORE_FILE), 'utf8').catch(() => '[]')) as { id: string; prefer: string; address?: string }[]
const first = () => manager.get().hosts[0]!
const onTailnet = () => vi.waitFor(() => expect(first()).toMatchObject({ phase: 'connected', via: 'tailnet' }), { timeout: 20_000 })
async function remoteThread(): Promise<string> {
  const client = desktopWindowClient('desktop-test')
  await router.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } }, client)
  await router.command({ type: 'connect', provider: 'codex' }, client)
  const state = await router.command({ type: 'create-project', provider: 'codex', title: 'Remote', path: root, useExisting: true }, client)
  const project = state.host.projects.find(item => item.path === root)!
  const threadId = randomUUID()
  await router.command({ type: 'create-thread', projectId: project.id, threadId, title: 'Remote task', modelId: state.host.models[0]!.id, managed: false, workingCopy: 'shared' }, client)
  const qualified = hostEntityKey(host.descriptor!.hostId, threadId)
  await router.command({ type: 'select-thread', threadId: qualified }, client)
  return qualified
}
const row = (id: string) => router.shell().host.threads.find(thread => thread.id === id)

describe('a tailnet connection (ADR-0053)', () => {
  it('turns on the host’s tailnet connections at Add host, moves the socket to the tailnet and closes the SSH connection', async () => {
    const remote = await add()
    expect(first()).toMatchObject({ phase: 'connected', via: 'tailnet', prefer: 'tailnet' })
    expect(first().tailnetNote).toBeUndefined()
    // The SSH connection Add host paired over closed once the socket moved, taking the administrative token with it.
    expect(launchers).toHaveLength(1)
    expect(launchers[0]!.disconnected).toBe(true)
    expect(await saved()).toEqual([expect.objectContaining({ id: remote.id, prefer: 'tailnet', address: ADDRESS })])
    expect(await admin('tailnet', {})).toMatchObject({ enabled: true })
    expect(hostTailscale.proxied()).toBeDefined()
    // Add host's checklist ends with its tailnet step, done.
    expect(first().addTailnet).toEqual({ state: 'done' })
    // Edit connection shows the address and when this computer last reached the host there.
    expect(first()).toMatchObject({ tailnetAddress: ADDRESS, tailnetSeen: clock })
    // The threads are the host's, on the Threads page, over the tailnet.
    const thread = await remoteThread()
    expect(row(thread)).toMatchObject({ clientConnected: true })
  })

  it('leaves a host with no Tailscale running on SSH at Add host, with its tailnet connections off again', async () => {
    tailscaleInstalled = false
    await add()
    expect(first()).toMatchObject({ phase: 'connected', via: 'ssh', prefer: 'ssh' })
    expect(first().tailnetNote).toBeUndefined()
    // No entry is SSH: Add host writes the tailnet only for a host it will be reached on.
    expect(await saved()).toEqual([])
    expect(await admin('tailnet', {})).toMatchObject({ enabled: false })
    expect(hostTailscale.proxied()).toBeUndefined()
    // Add host's tailnet step says why the host stayed on SSH.
    expect(first().addTailnet).toEqual({ state: 'ssh', why: 'no-tailscale' })
  })

  it('shows Add host’s tailnet step under way from the moment the host is saved, until the socket is on the tailnet', async () => {
    const seen: string[] = []
    manager.subscribe(state => { const saved = state.hosts[0]; if (saved) seen.push(`${saved.phase} ${saved.addTailnet?.state ?? 'none'}`) })
    await add()
    // The host never reads as added and done before its tailnet step has run.
    expect(seen[0]).toBe('connected active')
    expect(seen).not.toContain('connected none')
    expect(seen.at(-1)).toBe('connected done')
  })

  it('says at Add host that the host’s Serve needs its operator, and tries that Serve again when the tailnet is chosen again', async () => {
    serveDenied = true
    const remote = await add()
    expect(first()).toMatchObject({ phase: 'connected', via: 'ssh', prefer: 'tailnet', tailnetNote: 'operator', addTailnet: { state: 'ssh', why: 'operator' } })
    // The owner runs the command on the host, then presses Try again, which chooses the tailnet again.
    serveDenied = false
    await manager.command({ type: 'set-connection', id: remote.id, prefer: 'tailnet' })
    await onTailnet()
    expect((await saved())[0]).toMatchObject({ prefer: 'tailnet', address: ADDRESS })
  })

  it('says at Add host that a host too old for the tailnet route needs updating, and keeps it on SSH', async () => {
    // A host older than the route answers 400 to it.
    const real = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => String(input).endsWith('/v1/admin/tailnet') ? new Response('{}', { status: 400 }) : real(input, init))
    await add()
    vi.restoreAllMocks()
    expect(first()).toMatchObject({ phase: 'connected', via: 'ssh', prefer: 'ssh', addTailnet: { state: 'ssh', why: 'old-host' } })
    expect(await saved()).toEqual([])
  })

  it('says at Add host that the host refused its tailnet connections, and keeps it on SSH', async () => {
    // The host will not take the administrative token, even when asked again: it refuses the setting.
    adminTokenOverride = 'A'.repeat(43)
    await add()
    adminTokenOverride = undefined
    expect(first()).toMatchObject({ phase: 'connected', via: 'ssh', prefer: 'ssh', addTailnet: { state: 'ssh', why: 'refused' } })
    expect(await admin('tailnet', {})).toMatchObject({ enabled: false })
  })

  it('says at Add host that Sotto could not reach the host for its tailnet connections when the press got no answer', async () => {
    tokenUnanswered = true
    await add()
    tokenUnanswered = false
    expect(first()).toMatchObject({ phase: 'connected', via: 'ssh', prefer: 'ssh', addTailnet: { state: 'ssh', why: 'not-reached' } })
  })

  it('tries a Serve that needed its operator again at the 5-minute check, over the SSH connection it is on', async () => {
    returnMs = 300
    await relaunch()
    serveDenied = true
    await add()
    expect(first()).toMatchObject({ via: 'ssh', tailnetNote: 'operator' })
    serveDenied = false
    await onTailnet()
    // The check signed in nothing: the only SSH connection is Add host's.
    expect(launchers).toHaveLength(1)
  })

  it('leaves the host’s tailnet connections on at Add host when another desktop turned them on, even with no Tailscale running', async () => {
    tailscaleInstalled = false
    await admin('tailnet', { enabled: true })
    await add()
    expect(first()).toMatchObject({ phase: 'connected', via: 'ssh', prefer: 'ssh' })
    expect(await admin('tailnet', {})).toMatchObject({ enabled: true })
  })

  it('reconnects over the tailnet at launch with no SSH at all', async () => {
    await add()
    await manager.close(); router.dispose(); router = new DesktopHostRouter(emptyDesktopState)
    launchers.length = 0
    clock += 60_000
    manager = newManager()
    // What the window was last told: Edit connection says when this computer last reached the host on its tailnet.
    let told: number | undefined
    manager.subscribe(state => { told = state.hosts[0]?.tailnetSeen })
    await manager.start()
    await onTailnet()
    expect(launchers).toEqual([])
    await vi.waitFor(() => expect(told).toBe(clock))
  })

  it('keeps the threads on the page through a drop, and reconnects over the tailnet without SSH', async () => {
    await add()
    const thread = await remoteThread()
    launchers.length = 0
    retryMs = 60_000
    stand.cut()
    await vi.waitFor(() => expect(row(thread)).toMatchObject({ clientReconnecting: true }), { timeout: 20_000 })
    expect(first()).toMatchObject({ phase: 'connecting', reconnecting: true })
    // The retry, pressed rather than waited for, goes over the tailnet and takes the same place.
    await manager.command({ type: 'connect', id: first().id })
    await onTailnet()
    expect(row(thread)?.clientReconnecting).toBeUndefined()
    expect(router.shell().activeThreadId).toBe(thread)
    expect(launchers).toEqual([])
  })

  it('falls back to SSH when Serve answers 502, says why, and moves back once the tailnet answers', async () => {
    const remote = await add()
    returnMs = 200
    stand.answer(502)
    await relaunch()
    await vi.waitFor(() => expect(first()).toMatchObject({ phase: 'connected', via: 'ssh', tailnetNote: 'unreachable' }), { timeout: 20_000 })
    expect(launchers).toHaveLength(1)
    expect(launchers[0]!.options).toEqual({})
    // The 5-minute check (shortened here) tries again; once Serve carries the listener again, the socket moves across.
    stand.answer('proxy')
    await onTailnet()
    expect(first().tailnetNote).toBeUndefined()
    expect(launchers[0]!.disconnected).toBe(true)
    expect((await saved())[0]).toMatchObject({ id: remote.id, prefer: 'tailnet' })
  })

  it('pairs again over SSH when the tailnet refuses the pairing, then moves back to the tailnet', async () => {
    const remote = await add()
    const before = first().clientId
    await credentials.set(`remote-host:${remote.id}`, 'A'.repeat(43))
    await relaunch()
    await onTailnet()
    // One SSH connect, which paired again over its forward and recorded the new pairing as a desktop.
    expect(launchers).toHaveLength(1)
    expect(operations).toContain('ssh desktop-answers')
    expect(first().clientId).not.toBe(before)
  })

  it('goes over SSH, which records this computer as a desktop, when the host does not know it as one', async () => {
    await add()
    await writeFile(join(data, 'desktop-clients.json'), '[]\n')
    await relaunch()
    await onTailnet()
    expect(launchers).toHaveLength(1)
    expect(operations).toEqual(['ssh desktop-answers'])
    expect(JSON.parse(await readFile(join(data, 'desktop-clients.json'), 'utf8'))).toEqual([first().clientId])
  })

  it('turns the host’s tailnet connections off for SSH only and moves the socket to SSH, and back for the tailnet', async () => {
    const remote = await add()
    launchers.length = 0
    await manager.command({ type: 'set-connection', id: remote.id, prefer: 'ssh' })
    await vi.waitFor(() => expect(first()).toMatchObject({ phase: 'connected', via: 'ssh', prefer: 'ssh' }), { timeout: 20_000 })
    expect(first().tailnetNote).toBeUndefined()
    // The press went over an admin connection, which starts no host; the reconnect is the SSH connection.
    expect(launchers.map(launcher => launcher.options)).toEqual([{ start: false }, {}])
    expect(await admin('tailnet', {})).toMatchObject({ enabled: false })
    expect(hostTailscale.proxied()).toBeUndefined()
    expect((await saved())[0]).toMatchObject({ prefer: 'ssh' })

    await manager.command({ type: 'set-connection', id: remote.id, prefer: 'tailnet' })
    await onTailnet()
    expect(await admin('tailnet', {})).toMatchObject({ enabled: true })
    expect((await saved())[0]).toMatchObject({ prefer: 'tailnet', address: ADDRESS })
  })

  it('keeps the choice as it was when the press cannot reach the host', async () => {
    const remote = await add()
    vi.spyOn(FixtureSsh.prototype, 'connect').mockRejectedValueOnce(new Error('ssh: connect to host forge port 22: Connection refused'))
    await expect(manager.command({ type: 'set-connection', id: remote.id, prefer: 'ssh' })).rejects.toThrow('How Sotto connects to forge could not be changed. Nothing was changed.')
    vi.restoreAllMocks()
    expect(first()).toMatchObject({ prefer: 'tailnet', via: 'tailnet', phase: 'connected' })
    expect((await saved())[0]).toMatchObject({ prefer: 'tailnet' })
  })

  it('writes a grant the tailnet found missing at the next admin connection, and opens no SSH for it alone', async () => {
    const remote = await add()
    await admin('deny-answers', { clientId: first().clientId })
    await relaunch()
    await onTailnet()
    expect(launchers).toEqual([])
    await manager.command({ type: 'stop-host', id: remote.id })
    expect(operations).toEqual(['admin desktop-answers', 'admin stop-host'])
  })

  it('forgets what it kept about the tailnet with the host', async () => {
    const remote = await add()
    await manager.command({ type: 'forget', id: remote.id })
    expect(await saved()).toEqual([])
    // The host's last recorded desktop is gone, so it turns its tailnet connections off itself.
    await vi.waitFor(async () => expect(await admin('tailnet', {})).toMatchObject({ enabled: false }), { timeout: 20_000 })
  })

  it('keeps a host on SSH when a move to the tailnet fails after the host accepted its socket, and moves later', async () => {
    returnMs = 200
    await relaunch()
    stand.answer('cut-upgrade')
    await add()
    // The tailnet socket opened and was cut before it could be used: the SSH connection carries on, and nothing reconnects.
    expect(first()).toMatchObject({ phase: 'connected', via: 'ssh', prefer: 'tailnet', tailnetNote: 'unreachable' })
    expect(first().reconnecting).toBeFalsy()
    expect(launchers[0]!.disconnected).toBe(false)
    stand.answer('proxy')
    await onTailnet()
    expect(launchers).toHaveLength(1)
    expect(launchers[0]!.disconnected).toBe(true)
  })

  it('leaves the SSH connection open under a press still running on it when the socket moves, and closes it after', async () => {
    returnMs = 200
    await relaunch()
    stand.answer(502)
    const remote = await add()
    expect(first()).toMatchObject({ phase: 'connected', via: 'ssh', tailnetNote: 'unreachable' })
    let release!: () => void
    tokenGate = new Promise(resolve => { release = resolve })
    const link = manager.phonesLinks().find(item => item.id === remote.id)!
    const pressing = link.press(connection => hostTailnetSetting(connection, link.hostId))
    stand.answer('proxy')
    await onTailnet()
    // The press holds the SSH connection it started on; a new press would open an admin connection instead.
    expect(launchers[0]!.disconnected).toBe(false)
    release(); tokenGate = undefined
    await expect(pressing).resolves.toMatchObject({ enabled: true })
    await vi.waitFor(() => expect(launchers[0]!.disconnected).toBe(true), { timeout: 20_000 })
  })

  it('lets a move to the tailnet under way end before a start at boot restart, so the threads read Reconnecting through it', async () => {
    returnMs = 200
    await relaunch()
    stand.answer(502)
    const remote = await add()
    expect(first()).toMatchObject({ phase: 'connected', via: 'ssh', tailnetNote: 'unreachable' })
    const thread = await remoteThread()
    // The 5-minute check (shortened here) finds the tailnet answering, and its health waits: the move is under way.
    let answerHealth!: () => void
    stand.hold(new Promise(resolve => { answerHealth = resolve }))
    const asked = stand.requests.length
    stand.answer('proxy')
    await vi.waitFor(() => expect(stand.requests.slice(asked)).toContain('GET /v1/health'), { timeout: 20_000 })
    bootChange = async () => {
      // The unit takes the host over: the host Sotto started stops, and the threads the restart holds read Reconnecting.
      // They are the tailnet connection's by now, since the move ended before the restart began.
      expect(first().via).toBe('tailnet')
      await host.close()
      await vi.waitFor(() => expect(row(thread)).toMatchObject({ clientConnected: false, clientReconnecting: true }))
      host = await startHost('launch-script')
      return { type: 'boot-installed', installed: true, stopped: true, pid: process.pid, bootStart: bootOn }
    }
    const installing = manager.setBootStart(remote.id, 'install')
    stand.hold(undefined); answerHealth()
    await expect(installing).resolves.toMatchObject({ stopped: true })
    await onTailnet()
    expect(router.shell().host.threads.filter(item => item.id === thread)).toHaveLength(1)
    expect(row(thread)).toMatchObject({ clientConnected: true })
    expect(row(thread)?.clientReconnecting).toBeUndefined()
    // The SSH connection the press began on closed once it ended.
    expect(launchers[0]!.disconnected).toBe(true)
  })

  it('lets a move to the tailnet under way end before SSH only acts, so the host stays on the SSH connection it was on', async () => {
    returnMs = 200
    await relaunch()
    stand.answer(502)
    const remote = await add()
    expect(first()).toMatchObject({ phase: 'connected', via: 'ssh', tailnetNote: 'unreachable' })
    // The 5-minute check (shortened here) finds the tailnet answering, and its health waits: the move is under way.
    let answerHealth!: () => void
    stand.hold(new Promise(resolve => { answerHealth = resolve }))
    const asked = stand.requests.length
    stand.answer('proxy')
    await vi.waitFor(() => expect(stand.requests.slice(asked)).toContain('GET /v1/health'), { timeout: 20_000 })
    // SSH only is pressed meanwhile: the host's setting goes off, and the choice waits for the move before it acts.
    const choosing = manager.command({ type: 'set-connection', id: remote.id, prefer: 'ssh' })
    await vi.waitFor(async () => expect(await admin('tailnet', {})).toMatchObject({ enabled: false }), { timeout: 20_000 })
    stand.hold(undefined); answerHealth()
    await choosing
    await vi.waitFor(() => expect(first()).toMatchObject({ phase: 'connected', via: 'ssh', prefer: 'ssh' }), { timeout: 20_000 })
    // The move ended back on SSH, since the host had turned its tailnet connections off: the host stays on the SSH
    // connection it was on, rather than SSH only connecting again over a socket the move was still opening.
    expect(launchers.map(launcher => launcher.disconnected)).toEqual([false])
  })

  it('keeps a host on its SSH connection when an update begins while a move to the tailnet is under way, and moves after it', async () => {
    returnMs = 200
    await relaunch()
    stand.answer(502)
    await add()
    let updating: string | undefined, asks = 0
    manager.useUpdates({ state: () => [], command: async () => undefined, subscribe: () => () => undefined, busy: () => { asks += 1; return updating } })
    let answerHealth!: () => void
    stand.hold(new Promise(resolve => { answerHealth = resolve }))
    const asked = stand.requests.length
    stand.answer('proxy')
    await vi.waitFor(() => expect(stand.requests.slice(asked)).toContain('GET /v1/health'), { timeout: 20_000 })
    updating = 'forge is being updated.'
    const before = asks
    stand.hold(undefined); answerHealth()
    // The tailnet answered, but the update needs the SSH connection between its steps: the move asks once more before it
    // takes the threads' place, gives way, and the next 5-minute check (shortened here) asks again and waits too.
    await vi.waitFor(() => expect(asks).toBeGreaterThanOrEqual(before + 2), { timeout: 20_000 })
    expect(first()).toMatchObject({ phase: 'connected', via: 'ssh', tailnetNote: 'unreachable' })
    expect(launchers[0]!.disconnected).toBe(false)
    updating = undefined
    await onTailnet()
    expect(launchers[0]!.disconnected).toBe(true)
  })

  it('tries only the tailnet for the first minute of retries of a host that starts at boot, and SSH after it', async () => {
    await host.close()
    host = await startHost('boot')
    await add()
    await onTailnet()
    launchers.length = 0
    retryMs = 20
    stand.answer(502)
    stand.cut()
    await vi.waitFor(() => expect(stand.requests.filter(item => item === 'GET /v1/health').length).toBeGreaterThan(3), { timeout: 20_000 })
    expect(launchers).toEqual([])
    expect(first()).toMatchObject({ phase: 'connecting', reconnecting: true })
    clock += BOOT_TAILNET_ONLY_MS
    await vi.waitFor(() => expect(first()).toMatchObject({ phase: 'connected', via: 'ssh', tailnetNote: 'unreachable' }), { timeout: 20_000 })
    expect(launchers).toHaveLength(1)
  })

  it('goes over SSH, sending the tailnet nothing of its pairing, when the tailnet answers as another host', async () => {
    await add()
    stand.answer('impostor')
    stand.requests.length = 0
    await relaunch()
    await vi.waitFor(() => expect(first()).toMatchObject({ phase: 'connected', via: 'ssh', tailnetNote: 'unreachable' }), { timeout: 20_000 })
    expect(stand.requests).toEqual(['GET /v1/health'])
    expect(launchers).toHaveLength(1)
  })

  it('tries the saved route over SSH when Edit connection is saved, then moves back to the tailnet', async () => {
    const remote = await add()
    launchers.length = 0
    await manager.command({ type: 'save', host: { ...remote, name: 'forge' } })
    await vi.waitFor(() => expect(launchers).toHaveLength(1), { timeout: 20_000 })
    expect(launchers[0]!.options).toEqual({})
    await onTailnet()
  })

  it('saves a new choice with Edit connection’s SSH settings, and changes nothing when those settings are mistyped', async () => {
    const remote = await add()
    launchers.length = 0
    // A host name with a space is refused before the choice is written, so the host stays on the tailnet.
    await expect(manager.command({ type: 'save', host: { ...remote, target: 'for ge' }, prefer: 'ssh' })).rejects.toThrow('Enter an SSH host such as forge or user@forge.')
    expect(first()).toMatchObject({ prefer: 'tailnet', via: 'tailnet', phase: 'connected', target: 'forge' })
    expect((await saved())[0]).toMatchObject({ prefer: 'tailnet' })
    expect(launchers).toEqual([])
    // The same SSH settings with a new choice write the choice and nothing else: no test connect over SSH follows the move.
    await manager.command({ type: 'save', host: remote, prefer: 'ssh' })
    await vi.waitFor(() => expect(first()).toMatchObject({ phase: 'connected', via: 'ssh', prefer: 'ssh' }), { timeout: 20_000 })
    expect(launchers.map(launcher => launcher.options)).toEqual([{ start: false }, {}])
    // A changed port with the tailnet chosen again writes the choice, then saves the port and connects again over SSH to check it.
    await manager.command({ type: 'save', host: { ...remote, sshPort: 2222 }, prefer: 'tailnet' })
    expect(first()).toMatchObject({ sshPort: 2222 })
    expect((await saved())[0]).toMatchObject({ prefer: 'tailnet' })
    await onTailnet()
  })

  it('saves and connects with new SSH settings before pressing a new choice over that connection, signing in once', async () => {
    const remote = await add()
    await onTailnet()
    launchers.length = 0
    await manager.command({ type: 'save', host: { ...remote, sshPort: 2222 }, prefer: 'ssh' })
    expect(first()).toMatchObject({ phase: 'connected', via: 'ssh', prefer: 'ssh', sshPort: 2222 })
    // The connect that checks the new settings carried the choice: no admin connection, and no second SSH connect.
    expect(launchers.map(launcher => launcher.options)).toEqual([{}])
    expect(await admin('tailnet', {})).toMatchObject({ enabled: false })
    expect((await saved())[0]).toMatchObject({ prefer: 'ssh' })
  })

  it('keeps the choice and says the host refused when it will not take the change', async () => {
    const remote = await add()
    adminTokenOverride = 'A'.repeat(43)
    await expect(manager.command({ type: 'set-connection', id: remote.id, prefer: 'ssh' })).rejects.toThrow('The host on forge refused the change. Nothing was changed.')
    expect(first()).toMatchObject({ prefer: 'tailnet', via: 'tailnet', phase: 'connected' })
    expect((await saved())[0]).toMatchObject({ prefer: 'tailnet' })
  })

  it('keeps start at boot as a launch last reported it for a tailnet connection after a relaunch', async () => {
    const bootStart = { supported: true, installed: true, enabled: true, active: true, linger: true, nodeDrift: false } as const
    const connect = FixtureSsh.prototype.connect
    vi.spyOn(FixtureSsh.prototype, 'connect').mockImplementation(async function (this: FixtureSsh, ...args) { return { ...await connect.apply(this, args), bootStart } })
    await add()
    vi.restoreAllMocks()
    await relaunch()
    await onTailnet()
    expect(launchers).toEqual([])
    expect(first().bootStart).toEqual(bootStart)
  })
})
