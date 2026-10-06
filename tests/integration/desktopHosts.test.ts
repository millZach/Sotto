// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import { it } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { HostCredentialEncryption } from '../../src/host/credentials'
import { AtomicJsonStore } from '../../src/main/storage/atomicJsonStore'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { DesktopHosts, reconnectDelayMs } from '../../src/main/hosts/desktopHosts'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { SshFailure, SshHostLauncher, type SshBootOperation, type SshBootResult, type SshCallbacks, type SshConnectOptions, type SshHostConnection, type SshHostConfiguration, type SshHostUpdateOperation, type SshHostUpdateResult } from '../../src/main/hosts/sshLauncher'
import type { BootStatus } from '../../src/shared/bootStart'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import type { RemoteHost } from '../../src/shared/hosts'
import { hostVersionMismatch } from '../../src/shared/hostProtocol'
import { version as packageVersion } from '../../package.json'
import { createServer, type Server } from 'node:http'
import { HOST_BUSY } from '../../src/shared/hostProtocol'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { REMOTE_PERMISSION_DENIED } from '../../src/main/agents/authority'
import { ensureFixtureDesktopAnswers } from '../fixtures/sshDesktopAnswers'
import { standInTailscale } from '../fixtures/standInTailscale'
import { HostPhones } from '../../src/main/hosts/hostPhones'
let hostTailscale: ReturnType<typeof standInTailscale>
let root: string, host: Awaited<ReturnType<typeof startHeadlessHost>>, credentials: AgentCredentials, router: DesktopHostRouter, manager: DesktopHosts
let reportedHostId: string
const launchers: FixtureSsh[] = [], failures: Error[] = []
let retryDelay: (attempt: number) => number = () => 0
/** Every reconnect the manager scheduled, by attempt: an empty list proves no retry can fire, with no waiting. */
const scheduled: number[] = []
let owned = true, stopResult: boolean | Error = true
/** Where the fixture tunnel leads; by default the real host's listener. */
let tunnelUrl: (() => string) | undefined
/** Runs before a stop answers; the real host closes its listener, dropping every peer, before it replies. */
let beforeStopReply: () => Promise<void> = async () => undefined
/** What the fixture host answers to each operation of an update; by default it has none. */
const noUpdates = async (): Promise<SshHostUpdateResult> => { throw new Error('This fixture host has no update.') }
let updateHost: (operation: SshHostUpdateOperation) => Promise<SshHostUpdateResult> = noUpdates
/** Start at boot as the fixture's launch finds it (ADR-0054); absent unless a test says. */
let bootStart: BootStatus | undefined
/** What the fixture host answers to a start at boot operation; by default it has none. Every one it was asked is in `boots`. */
const noBoot = async (): Promise<SshBootResult> => { throw new Error('This fixture host has no start at boot.') }
let boot: (operation: SshBootOperation) => Promise<SshBootResult> = noBoot
const boots: SshBootOperation[] = []
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
/** Revokes the way the launch script does, through the host's admin endpoint, which closes the revoked peer before replying. */
async function adminRevoke(clientId: string): Promise<boolean> {
  const descriptor = JSON.parse(await readFile(join(root, 'remote', 'host-listener.json'), 'utf8')) as { adminToken: string }
  const response = await fetch('http://127.0.0.1:' + host.descriptor!.port + '/v1/admin/revoke-client', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId }) })
  return ((await response.json()) as { revoked: boolean }).revoked
}
const stops: string[] = []
/** Every launch script operation a fixture connection ran, in order, with the kind of connection it ran on. */
const operations: string[] = []
/** Whether the fixture host is running, as an admin connection finds it; one that is not fails its connect. */
let hostRunning = true
/** When set, the launch script's revoke-client fails the way it does when the host refuses it. */
let revokeFails = false
/** When set, the launch script's revoke-client fails with this instead, the way a request that never got an answer does. */
let revokeError: Error | undefined
/** When set, the next connect asks this SSH question and waits for its answer, or for the attempt to be cancelled. */
let askOnConnect: 'passphrase' | undefined
/** Every answer given to an SSH question, to prove where the dialog's answer went. */
const answers: string[] = []
/** When set, the next connect runs this first, the way the launcher reports steps and Tailscale's approval. */
let onConnect: ((callbacks: SshCallbacks) => Promise<void>) | undefined
/** Every page the manager opened in the browser. */
const opened: string[] = []
/** The Node the fixture host's launch script says it ran under. */
const FIXTURE_NODE = '/home/zach/.local/share/mise/installs/node/24.4.0/bin/node'
class FixtureSsh extends SshHostLauncher {
  callbacks?: SshCallbacks
  configuration?: SshHostConfiguration
  options?: SshConnectOptions
  private waiting?: { resolve: () => void; reject: (error: Error) => void }
  override async connect(configuration: SshHostConfiguration, callbacks: SshCallbacks = {}, options: SshConnectOptions = {}): Promise<SshHostConnection> {
    this.callbacks = callbacks; this.configuration = configuration; this.options = options
    if (onConnect) { const script = onConnect; onConnect = undefined; await script(callbacks) }
    if (askOnConnect) {
      askOnConnect = undefined
      callbacks.onPrompt?.({ id: 'prompt-1', kind: 'passphrase', text: 'Enter passphrase for key' })
      await new Promise<void>((resolve, reject) => { this.waiting = { resolve, reject } })
    }
    const failure = failures.shift()
    if (failure) throw failure
    // An admin connection starts nothing: a host that is not running fails its connect.
    if (options.start === false && !hostRunning) throw new SshFailure('host-not-running')
    const which = options.start === false ? 'admin' : 'ssh'
    return { url: tunnelUrl?.() ?? 'http://127.0.0.1:' + host.descriptor!.port, hostId: reportedHostId, owned, route: { hostname: 'forge', identityFiles: [] }, node: FIXTURE_NODE,
      close: async () => undefined,
      showHostPairingCode: async () => ({ ...host.pairing.issuePairingCode(), hostId: reportedHostId }),
      ensureDesktopAnswers: clientId => ensureFixtureDesktopAnswers(join(root, 'remote'), reportedHostId, clientId),
      revokeClient: async clientId => { operations.push(`${which} revoke-client`); if (revokeError) throw revokeError; if (revokeFails) throw new SshFailure('revoke-failed'); return adminRevoke(clientId) },
      hostAdminToken: async () => (JSON.parse(await readFile(join(root, 'remote', 'host-listener.json'), 'utf8')) as { adminToken: string }).adminToken,
      stopHost: async () => { operations.push(`${which} stop-host`); stops.push(reportedHostId); await beforeStopReply(); if (stopResult instanceof Error) throw stopResult; return stopResult },
      updateHost: async operation => { operations.push(`${which} ${operation.op}`); return updateHost(operation) },
      ...(bootStart ? { bootStart } : {}), boot: async operation => { operations.push(`${which} ${operation.op}`); boots.push(operation); return boot(operation) },
    }
  }
  override answerPrompt(id: string, answer: string): void {
    if (!this.waiting || id !== 'prompt-1') throw new Error('This SSH prompt is no longer waiting. Reconnect if needed.')
    answers.push(answer); this.callbacks?.onPrompt?.(null); this.waiting.resolve(); delete this.waiting
  }
  override async disconnect(): Promise<void> { this.waiting?.reject(new SshFailure('cancelled')); delete this.waiting }
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sotto-desktop-hosts-'))
  hostTailscale = standInTailscale()
  host = await startHeadlessHost({ dataDirectory: join(root, 'remote'), port: 0, providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner, tailscale: hostTailscale.tailscale })
  reportedHostId = host.descriptor!.hostId
  credentials = new AgentCredentials(join(root, 'desktop'), new HostCredentialEncryption('synthetic-desktop-credential-key')); await credentials.load()
  router = new DesktopHostRouter(emptyDesktopState)
  launchers.length = 0; failures.length = 0; stops.length = 0; answers.length = 0; askOnConnect = undefined; onConnect = undefined; opened.length = 0; scheduled.length = 0; retryDelay = () => 0; owned = true; stopResult = true; beforeStopReply = async () => undefined; tunnelUrl = undefined; updateHost = noUpdates
  operations.length = 0; hostRunning = true; revokeFails = false; revokeError = undefined; bootStart = undefined; boot = noBoot; boots.length = 0
  manager = newManager()
  await manager.start()
})
function newManager(): DesktopHosts {
  return new DesktopHosts({ directory: join(root, 'desktop'), credentials, router, localHostRunning: false, localHostEnabled: () => false, restart: () => undefined, retryDelayMs: attempt => { scheduled.push(attempt); return retryDelay(attempt) }, launcher: () => { const launcher = new FixtureSsh(); launchers.push(launcher); return launcher },
    openExternal: async url => { opened.push(url) } })
}
/** Quits and starts Sotto again over the same saved hosts, the way a relaunch does; `saved` replaces the file first when given. */
async function relaunch(saved?: object[]): Promise<void> {
  await manager.close(); router.dispose(); router = new DesktopHostRouter(emptyDesktopState)
  if (saved) { await mkdir(join(root, 'desktop'), { recursive: true }); await writeFile(join(root, 'desktop', 'remote-hosts.json'), JSON.stringify(saved)) }
  manager = newManager()
  await manager.start()
}
const savedFile = async (): Promise<unknown[]> => JSON.parse(await readFile(join(root, 'desktop', 'remote-hosts.json'), 'utf8').catch(() => '[]')) as unknown[]
afterEach(async () => { await manager?.close(); router?.dispose(); await host?.close(); if (root && dirname(root) === tmpdir() && root.includes('sotto-desktop-hosts-')) await rm(root, { recursive: true, force: true }) })
type Connection = Omit<RemoteHost, 'enabled'>
const connection = (target = 'forge'): Connection => ({ id: randomUUID(), name: 'Forge fixture', target, identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data/sotto' })
/** Add host: connects, pairs and saves in one command. */
async function add(target = 'forge'): Promise<Connection> {
  const remote = connection(target)
  await manager.command({ type: 'add', host: remote })
  return remote
}
/** A thread on the host, connected, so its row on the Threads page has something to lose. */
async function remoteThread(): Promise<string> {
  await manager.command({ type: 'select', hostId: reportedHostId })
  const client = desktopWindowClient('desktop-test')
  await router.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } }, client)
  await router.command({ type: 'connect', provider: 'codex' }, client)
  const state = await router.command({ type: 'create-project', provider: 'codex', title: 'Remote', path: root, useExisting: true }, client)
  const project = state.host.projects.find(item => item.path === root)!
  const threadId = randomUUID()
  await router.command({ type: 'create-thread', projectId: project.id, threadId, title: 'Remote task', modelId: state.host.models[0]!.id, managed: false, workingCopy: 'shared' }, client)
  const qualified = hostEntityKey(reportedHostId, threadId)
  await router.command({ type: 'select-thread', threadId: qualified }, client)
  return qualified
}
const row = (id: string) => router.shell().host.threads.find(thread => thread.id === id)
describe('phones on a remote host (ADR-0050)', () => {
  it('reads a connected host’s phone access through its tunnel, and turns it on there from the Phones dialog', async () => {
    const phones = new HostPhones({ hosts: { links: () => manager.phonesLinks(), subscribe: listener => manager.subscribe(() => listener()) }, openExternal: async () => undefined })
    manager.usePhones(phones)
    try {
      const remote = await add()
      await vi.waitFor(() => expect(manager.get().phones).toMatchObject([{ id: remote.id, state: { enabled: false, phase: 'off' } }]))
      await manager.command({ type: 'host-phones', id: remote.id, command: { type: 'set-enabled', enabled: true } })
      // The open dialog's reads every couple of seconds are what show the host finishing its setup.
      await manager.command({ type: 'watch-host-phones', id: remote.id, watching: true })
      await vi.waitFor(() => expect(manager.get().phones?.[0]?.state).toMatchObject({ enabled: true, phase: 'on', address: 'https://forge.tail5728ca.ts.net:8443' }), { timeout: 20_000 })
      expect(hostTailscale.proxied()).toBeDefined()
      await expect(manager.command({ type: 'host-phones', id: randomUUID(), command: { type: 'retry' } })).rejects.toThrow('no longer saved')
    } finally { phones.close() }
  })
})

describe('desktop remote host management over a real socket', () => {
  it('retries a socket that drops while the connected host identity is saved', async () => {
    const remote = await add()
    await manager.command({ type: 'set-enabled', id: remote.id, enabled: false })
    retryDelay = () => 60_000
    const sockets: SocketHostService[] = []
    const connect = SocketHostService.prototype.connect
    const opening = vi.spyOn(SocketHostService.prototype, 'connect').mockImplementation(function (this: SocketHostService) {
      sockets.push(this)
      return connect.call(this)
    })
    const write = AtomicJsonStore.prototype.write
    let dropped = false
    const saving = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function (this: AtomicJsonStore<unknown>, value) {
      const socket = sockets.at(-1)
      if (!dropped && socket && Array.isArray(value) && value.some(item => item.id === remote.id)) {
        dropped = true
        await socket.close()
      }
      return write.call(this, value)
    })
    try {
      await manager.command({ type: 'set-enabled', id: remote.id, enabled: true })
      await vi.waitFor(() => expect(scheduled).toEqual([0]))
    } finally { opening.mockRestore(); saving.mockRestore() }
    expect(dropped).toBe(true)
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
    expect(scheduled).toEqual([0])
    expect(router.shell().connections).not.toContainEqual(expect.objectContaining({ hostId: reportedHostId, connected: true }))
  })

  it('refuses pairing before spending a code when secure storage is unavailable', async () => {
    const available = vi.spyOn(credentials, 'available').mockReturnValue(false)
    try { await add() } finally { available.mockRestore() }
    expect(host.pairing.list()).toHaveLength(0)
    expect(manager.get().adding).toMatchObject({ phase: 'error', error: expect.stringContaining('Secure credential storage is unavailable') })
  })

  it('revokes a fresh pairing when saving its credential fails', async () => {
    const saving = vi.spyOn(credentials, 'set').mockRejectedValueOnce(new Error('Fixture storage failure'))
    try { await add() } finally { saving.mockRestore() }
    expect(host.pairing.list()).toHaveLength(0)
    expect(await savedFile()).toEqual([])
    expect(manager.get().adding).toMatchObject({ phase: 'error' })
  })

  it('lets a new SSH desktop change permission modes immediately, leaves phone pairing unprivileged, and preserves revocation on reconnect', async () => {
    const remote = await add()
    const local = desktopWindowClient('desktop-test')
    await router.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } }, local)
    await router.command({ type: 'connect', provider: 'codex' }, local)
    const state = await router.command({ type: 'create-project', provider: 'codex', title: 'Remote', path: root, useExisting: true }, local)
    const project = state.host.projects.find(item => item.path === root)!
    const created = await router.command({ type: 'create-thread', projectId: project.id, modelId: state.host.models[0]!.id, title: 'Remote permissions', managed: false }, local)
    expect(created.error).toBeNull()
    const threadId = created.host.threads.find(item => item.title === 'Remote permissions')!.id
    for (const runtimeMode of ['full-access', 'auto', 'auto-accept-edits', 'approval-required'] as const) {
      const next = await router.command({ type: 'configure-thread', threadId, runtimeMode }, local)
      expect(next.error).toBeNull()
      expect(next.host.threads.find(item => item.id === threadId)?.runtimeMode).toBe(runtimeMode)
    }
    // A paired client's name supplies no authority, even when it claims to be a desktop.
    const url = 'http://127.0.0.1:' + host.descriptor!.port
    const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Sotto desktop')
    const phone = new SocketHostService({ url, token: paired.token })
    try { expect((await phone.connect()).capabilities.mayAnswer).toBe(false) } finally { await phone.close() }
    const descriptor = JSON.parse(await readFile(join(root, 'remote', 'host-listener.json'), 'utf8')) as { adminToken: string }
    const response = await fetch(url + '/v1/admin/deny-answers', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: manager.get().hosts[0]!.clientId }) })
    expect(response.status).toBe(200)
    await manager.command({ type: 'disconnect', id: remote.id })
    await manager.command({ type: 'connect', id: remote.id })
    expect(manager.get().hosts[0]!.phase).toBe('connected')
    expect((await router.command({ type: 'configure-thread', threadId, runtimeMode: 'full-access' }, local)).error).toBe(REMOTE_PERMISSION_DENIED)
  })

  it('repairs an existing desktop pairing with no policy on the next connection', async () => {
    const remote = connection()
    const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Sotto desktop')
    await credentials.set('remote-host:' + remote.id, paired.token)
    // A saved connection can omit the client ID; setup must use the host's authenticated hello.
    await relaunch([{ ...remote, hostId: reportedHostId }])
    await vi.waitFor(() => expect(manager.get().hosts[0]!.phase).toBe('connected'))
    const probe = new SocketHostService({ url: 'http://127.0.0.1:' + host.descriptor!.port, token: paired.token })
    try { expect((await probe.connect()).capabilities.mayAnswer).toBe(true) } finally { await probe.close() }
    expect(host.pairing.list()).toHaveLength(1)
  })

  it('saves, pairs itself, selects, sends only to the remote host and revokes on Forget', async () => {
    const remote = await add()
    expect(manager.get().hosts[0]!.phase).toBe('connected')
    await manager.command({ type: 'select', hostId: reportedHostId })
    const client = desktopWindowClient('desktop-test')
    await router.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } }, client)
    await router.command({ type: 'connect', provider: 'codex' }, client)
    const state = await router.command({ type: 'create-project', provider: 'codex', title: 'Remote', path: root, useExisting: true }, client)
    const project = state.host.projects.find(project => project.path === root)!
    const model = state.host.models[0]!
    const threadId = randomUUID()
    await router.command({ type: 'create-thread', projectId: project.id, threadId, title: 'Remote task', modelId: model.id, managed: false, workingCopy: 'shared' }, client)
    const qualified = hostEntityKey(reportedHostId, threadId)
    await router.command({ type: 'observe-threads', threadIds: [qualified] }, client)
    await router.command({ type: 'manual-send', threadId: qualified, draftId: randomUUID(), text: 'Synthetic remote prompt' }, client)
    await expect.poll(() => host.service.threadDetail(threadId)?.messages.some(message => message.text === 'Synthetic remote prompt')).toBe(true)
    const token = credentials.get('remote-host:' + remote.id)
    expect(token).not.toBe('')
    expect(await readFile(join(root, 'desktop', 'remote-hosts.json'), 'utf8')).not.toContain(token)
    expect(await readFile(join(root, 'desktop', 'credentials.json'), 'utf8')).not.toContain(token)
    expect(host.pairing.verifyToken(token)).toBeDefined()
    await manager.command({ type: 'forget', id: remote.id })
    expect(host.pairing.verifyToken(token)).toBeUndefined(); expect(credentials.has('remote-host:' + remote.id)).toBe(false)
    expect(stops).toEqual([reportedHostId])
    expect(manager.get().hosts).toEqual([]); expect(router.shell().host.threads).toEqual([])
    await expect(readFile(join(root, 'desktop', 'workspace.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('leaves a host Sotto started running on Disconnect and stops it only on Stop host', async () => {
    const remote = await add()
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'connected', owned: true })
    await manager.command({ type: 'disconnect', id: remote.id })
    expect(stops).toEqual([])
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'disconnected' })
    expect(manager.get().hosts[0]!.owned).toBeUndefined()
    await expect(manager.command({ type: 'stop-host', id: remote.id })).rejects.toThrow('Connect to Forge fixture before stopping its host.')
    await manager.command({ type: 'connect', id: remote.id })
    await manager.command({ type: 'stop-host', id: remote.id })
    expect(stops).toEqual([reportedHostId])
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'disconnected' })
    expect(router.shell().connections).toEqual([])
  })
  it('does not reconnect while a stop slower than the retry delay closes the host under it', async () => {
    const remote = await add()
    beforeStopReply = async () => { await host.close(); await pause(150) }
    await manager.command({ type: 'stop-host', id: remote.id })
    // The drop arrived while the stop was pending. No retry was ever scheduled, so none can fire later.
    expect(scheduled).toEqual([])
    expect(stops).toEqual([reportedHostId])
    expect(launchers).toHaveLength(1)
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'disconnected' })
    expect(manager.get().hosts[0]!.reconnecting).toBeUndefined()
  })
  it('forgets over a revoke that closes the socket, stops the host and never pairs again', async () => {
    const remote = await add()
    const token = credentials.get('remote-host:' + remote.id)
    beforeStopReply = () => pause(150)
    await manager.command({ type: 'forget', id: remote.id })
    // The revoke dropped the socket before the stop replied, and no retry was scheduled to pair again.
    expect(scheduled).toEqual([])
    expect(host.pairing.verifyToken(token)).toBeUndefined()
    expect(stops).toEqual([reportedHostId])
    expect(manager.get().hosts).toEqual([]); expect(credentials.has('remote-host:' + remote.id)).toBe(false)
    expect(launchers).toHaveLength(1)
    expect(host.pairing.list()).toEqual([])
  })
  it('never stops a host it discovered and says so', async () => {
    owned = false
    const remote = await add()
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'connected', owned: false })
    await expect(manager.command({ type: 'stop-host', id: remote.id })).rejects.toThrow('Sotto did not start the host on Forge fixture')
    expect(stops).toEqual([])
    expect(manager.get().hosts[0]!.phase).toBe('connected')
    await manager.command({ type: 'forget', id: remote.id })
    expect(stops).toEqual([]); expect(manager.get().hosts).toEqual([])
  })
  it('keeps the saved host when an owned host could not be stopped and says it may still run', async () => {
    stopResult = false
    const remote = await add()
    await expect(manager.command({ type: 'stop-host', id: remote.id })).rejects.toThrow('may still be running')
    expect(manager.get().hosts[0]!.phase).toBe('disconnected')
    stopResult = new Error('launch script gone')
    await manager.command({ type: 'connect', id: remote.id })
    await expect(manager.command({ type: 'forget', id: remote.id })).rejects.toThrow('may still be running')
    expect(manager.get().hosts).toHaveLength(1)
    expect(manager.get().hosts[0]!.phase).toBe('disconnected')
  })
  it('forgets a host it cannot reach, keeps nothing of it here, and says the host still trusts this computer and how to revoke it there', async () => {
    const remote = await add()
    const token = credentials.get('remote-host:' + remote.id)
    const clientId = manager.get().hosts[0]!.clientId!
    await manager.command({ type: 'disconnect', id: remote.id })
    failures.push(new SshFailure('ssh-unreachable'))
    const state = await manager.command({ type: 'forget', id: remote.id })
    expect(state.hosts).toEqual([]); expect(credentials.has('remote-host:' + remote.id)).toBe(false)
    expect(await savedFile()).toEqual([])
    expect(host.pairing.verifyToken(token)).toBeDefined()
    expect(stops).toEqual([])
    // The command resolves `current` on the host and runs the Node and folders this computer last saw.
    expect(state.forgotten).toEqual([{ id: remote.id, name: 'Forge fixture', cause: 'unreachable', command: 'I="/opt/sotto"; E="$I/host/index.js"; [ -f "$I/current" ] && V=$(cat "$I/current") && [ -f "$I/versions/$V/host/index.js" ] && E="$I/versions/$V/host/index.js"; '
      + `"${FIXTURE_NODE}" "$E" --data "/data/sotto" --revoke-client "${clientId}"` }])
    // Dismiss puts it away; a dismiss for another host changes nothing.
    expect((await manager.command({ type: 'dismiss-forgotten', id: randomUUID() })).forgotten).toBeDefined()
    expect((await manager.command({ type: 'dismiss-forgotten', id: remote.id })).forgotten).toBeUndefined()
  })
  it('refuses changed host identity before sending the saved pairing credential', async () => {
    const remote = await add()
    await manager.command({ type: 'disconnect', id: remote.id })
    reportedHostId = randomUUID()
    await manager.command({ type: 'connect', id: remote.id })
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'error', error: expect.stringContaining('identity changed') })
    expect(router.shell().connections).toEqual([])
  })
  it('keeps the verified SSH route and pairs again by itself after the saved token is revoked', async () => {
    const remote = await add()
    const token = credentials.get('remote-host:' + remote.id)
    const clientId = host.pairing.verifyToken(token)!
    await manager.command({ type: 'disconnect', id: remote.id })
    await host.pairing.revoke(clientId)
    await manager.command({ type: 'connect', id: remote.id })
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'connected', clientId: expect.any(String) })
    expect(host.pairing.verifyToken(credentials.get('remote-host:' + remote.id))).not.toBe(clientId)
  })
  it('refuses to add a host already saved, under the same route or another, and leaves the saved one connected', async () => {
    const first = await add()
    await expect(add()).rejects.toThrow('forge is already saved as Forge fixture. Nothing was saved.')
    const second = connection('forge-again')
    await manager.command({ type: 'add', host: second })
    expect(manager.get().adding).toMatchObject({ id: second.id, phase: 'error', error: expect.stringContaining('This is the same host as Forge fixture') })
    expect(manager.get().adding!.error).toContain('Nothing was saved.')
    expect(manager.get().hosts.map(host => host.id)).toEqual([first.id])
    expect(credentials.has('remote-host:' + second.id)).toBe(false)
    await manager.command({ type: 'cancel-add', id: second.id })
    expect(manager.get().adding).toBeUndefined()
    expect(router.shell().connections).toEqual([expect.objectContaining({ hostId: reportedHostId })])
    expect(manager.get().hosts[0]!.phase).toBe('connected')
  })
  it('reconnects a dropped established connection and resets the attempt count on success', async () => {
    await add()
    expect(manager.get().hosts[0]!.phase).toBe('connected')
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
    await vi.waitFor(() => expect(manager.get().hosts[0]!.phase).toBe('connected'))
    expect(launchers.length).toBe(2)
    expect(manager.get().hosts[0]!.reconnecting).toBe(false)
    launchers[1]!.callbacks!.onDisconnected!('dropped again')
    await vi.waitFor(() => expect(manager.get().hosts[0]!.phase).toBe('connected'))
    expect(launchers.length).toBe(3)
  })
  it.each([
    ['archive-missing', 'installation was not found'],
    ['ssh-too-old', "This computer's OpenSSH is too old"],
  ] as const)('stops retrying when a reconnect fails with an error only the user can fix: %s', async (code, message) => {
    await add()
    failures.push(new SshFailure(code))
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    await vi.waitFor(() => expect(manager.get().hosts[0]).toMatchObject({ phase: 'error', reconnecting: false, error: expect.stringContaining(message) }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(launchers.length).toBe(2)
  })
  it('clears a retry left by a failed reconnect when Sotto quits, so no SSH session starts during the drain', async () => {
    const remote = await add()
    retryDelay = attempt => attempt === 0 ? 0 : 60_000
    failures.push(new SshFailure('ssh-unreachable'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      launchers[0]!.callbacks!.onDisconnected!('dropped')
      // The first retry fails, leaving a second one pending for a host that is no longer live.
      await vi.waitFor(() => expect(scheduled).toEqual([0, 1]))
      expect(launchers).toHaveLength(2)
      expect(manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
      await manager.close()
      // Running every pending timer would fire the retry if close() had left it.
      vi.runOnlyPendingTimers()
      await manager.command({ type: 'connect', id: remote.id })
      expect(launchers).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })
  it('decides on the failure code, so rewording a message changes no retry decision', async () => {
    await add()
    // Words that once meant "stop retrying", on a failure a retry can fix: it is retried.
    failures.push(new SshFailure('ssh-unreachable', 'The host installation was not found, the host key changed and the identity changed.'))
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    await vi.waitFor(() => expect(manager.get().hosts[0]!.phase).toBe('connected'))
    expect(launchers).toHaveLength(3)
    // Words that say nothing, on a failure only the user can fix: it stops.
    failures.push(new SshFailure('node-too-old', 'Something is not right.'))
    launchers[2]!.callbacks!.onDisconnected!('dropped')
    await vi.waitFor(() => expect(manager.get().hosts[0]).toMatchObject({ phase: 'error', reconnecting: false, error: 'Something is not right.' }))
    expect(launchers).toHaveLength(4)
    expect(scheduled).toEqual([0, 1, 0])
  })
  it('backs off 3, 4, 8 and then 16 seconds between reconnects, and keeps retrying', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(reconnectDelayMs)).toEqual([3_000, 4_000, 8_000, 16_000, 16_000, 16_000, 16_000])
  })
  it('opens and reconnects without downloading the host’s event log, and still reads the current shell', async () => {
    const client = desktopWindowClient('desktop-test')
    await host.service.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } }, client)
    await host.service.command({ type: 'connect', provider: 'codex' }, client)
    const state = await host.service.command({ type: 'create-project', provider: 'codex', title: 'Logged', path: root, useExisting: true }, client)
    const project = state.host.projects.find(project => project.path === root)!
    const threadId = randomUUID()
    await host.service.command({ type: 'create-thread', projectId: project.id, threadId, title: 'Logged task', modelId: state.host.models[0]!.id, managed: false, workingCopy: 'shared' }, client)
    await host.service.command({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic logged prompt' }, client)
    await expect.poll(() => host.service.events(0).length).toBeGreaterThan(0)
    const connect = vi.spyOn(SocketHostService.prototype, 'connect'), readEvents = vi.spyOn(SocketHostService.prototype, 'readEvents')
    try {
      const remote = await add()
      // The host sent none of the log in the hello, and a routed command reads none after it.
      const hello = (index: number) => connect.mock.results[index]!.value as ReturnType<SocketHostService['connect']>
      expect(await hello(0)).toMatchObject({ events: [], latestSeq: Number.MAX_SAFE_INTEGER, hasMore: false })
      await router.command({ type: 'configure', patch: { enabled: false } }, client)
      await manager.command({ type: 'disconnect', id: remote.id })
      await host.service.command({ type: 'configure', patch: { enabled: true } }, client)
      await manager.command({ type: 'connect', id: remote.id })
      expect(manager.get().hosts[0]!.phase).toBe('connected')
      expect(router.shell().configuration.enabled).toBe(true)
      expect(router.shell().host.threads.map(thread => thread.id)).toContain(hostEntityKey(reportedHostId, threadId))
      expect(await hello(1)).toMatchObject({ events: [], latestSeq: Number.MAX_SAFE_INTEGER, hasMore: false })
      expect(readEvents).not.toHaveBeenCalled()
    } finally { connect.mockRestore(); readEvents.mockRestore() }
  })
  it('says the host is busy when this computer’s session budget is spent, and keeps retrying instead of pairing again', async () => {
    const remote = await add()
    const token = credentials.get('remote-host:' + remote.id)
    // Spend this client's session budget for the minute, the way a loop on its token would.
    const session = () => fetch('http://127.0.0.1:' + host.descriptor!.port + '/v1/session', { method: 'POST', headers: { Authorization: 'Bearer ' + token } })
    let response = await session()
    for (let index = 0; response.status === 200 && index < 200; index++) response = await session()
    expect(response.status).toBe(429)
    retryDelay = attempt => attempt === 0 ? 0 : 60_000
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    // The busy reconnect is not final: a second retry is scheduled after it.
    await vi.waitFor(() => expect(scheduled).toEqual([0, 1]))
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
    await manager.command({ type: 'disconnect', id: remote.id })
    await manager.command({ type: 'connect', id: remote.id })
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'error', error: HOST_BUSY })
    expect(credentials.get('remote-host:' + remote.id)).toBe(token)
    expect(host.pairing.list()).toHaveLength(1)
  })
  it('keeps retrying when pairing again meets a busy host, instead of calling it a failed pairing', async () => {
    const remote = await add()
    await host.pairing.revoke(host.pairing.verifyToken(credentials.get('remote-host:' + remote.id))!)
    const fetchOriginal = globalThis.fetch
    const pairingResponse = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).endsWith('/v1/pair')) return Promise.resolve(new Response(JSON.stringify({ v: 1, error: { code: 'busy', message: HOST_BUSY } }), { status: 429 }))
      return fetchOriginal(input, init)
    })
    try {
      retryDelay = attempt => attempt === 0 ? 0 : 60_000
      launchers[0]!.callbacks!.onDisconnected!('dropped')
      // The session is refused, pairing again is refused as busy, and a second retry is scheduled after it.
      await vi.waitFor(() => expect(scheduled).toEqual([0, 1]))
      expect(manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
      await manager.command({ type: 'disconnect', id: remote.id })
      await manager.command({ type: 'connect', id: remote.id })
      expect(manager.get().hosts[0]).toMatchObject({ phase: 'error', error: HOST_BUSY })
    } finally { pairingResponse.mockRestore() }
  })
  it('cancels a pending retry when the user disconnects', async () => {
    const remote = await add()
    retryDelay = () => 50
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
    await manager.command({ type: 'disconnect', id: remote.id })
    expect(manager.get().hosts[0]!.phase).toBe('disconnected')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(launchers.length).toBe(1)
  })
})

describe('Add host, the switch and reconnect on launch', () => {
  it('connects, pairs and only then saves the host, switched on, with the SSH user and port it was given', async () => {
    const remote = { ...connection('zach@forge'), sshPort: 2222 }
    const pending = manager.command({ type: 'add', host: remote })
    // Until the host answers, the host is Add host's alone: no row, nothing on disk.
    expect(manager.get().hosts).toEqual([])
    expect(manager.get().adding).toMatchObject({ id: remote.id, phase: 'connecting' })
    const state = await pending
    expect(state.adding).toBeUndefined()
    expect(state.hosts).toEqual([expect.objectContaining({ id: remote.id, phase: 'connected', enabled: true, target: 'zach@forge', sshPort: 2222 })])
    expect(launchers[0]!.configuration).toMatchObject({ target: 'zach@forge', sshPort: 2222 })
    const [saved] = await savedFile() as Record<string, unknown>[]
    expect(saved).toMatchObject({ id: remote.id, target: 'zach@forge', sshPort: 2222, hostId: reportedHostId })
    // On is the default, so a saved host carries no flag until it is switched off.
    expect(saved).not.toHaveProperty('enabled')
    expect(credentials.has('remote-host:' + remote.id)).toBe(true)
  })
  it('saves nothing and keeps no credential when the host cannot be reached, and says so in the dialog', async () => {
    failures.push(new SshFailure('ssh-unreachable'))
    const remote = connection()
    await manager.command({ type: 'add', host: remote })
    expect(manager.get().hosts).toEqual([])
    expect(manager.get().adding).toMatchObject({ id: remote.id, phase: 'error', error: 'SSH could not reach the host. Nothing was saved. Check the host name and your network, then add the host again.' })
    expect(await savedFile()).toEqual([])
    expect(credentials.has('remote-host:' + remote.id)).toBe(false)
    // A failed add is not retried, since nothing asked for this host to stay connected.
    expect(scheduled).toEqual([])
    // Adding again replaces the failed attempt.
    await manager.command({ type: 'add', host: { ...remote, id: randomUUID() } })
    expect(manager.get().adding).toBeUndefined()
    expect(manager.get().hosts).toHaveLength(1)
  })
  it('revokes the pairing and keeps no credential when the host fails after pairing', async () => {
    // Pairing succeeds, and then the host refuses the session.
    const remote = connection()
    const refuse = vi.spyOn(SocketHostService.prototype, 'connect').mockRejectedValueOnce(new Error('The host closed the connection. Try again.'))
    try { await manager.command({ type: 'add', host: remote }) } finally { refuse.mockRestore() }
    expect(manager.get().hosts).toEqual([])
    // Past the tunnel, a failure is the pairing's.
    expect(manager.get().adding).toMatchObject({ phase: 'error', step: 'pair', error: expect.stringContaining('Nothing was saved.') })
    expect(credentials.has('remote-host:' + remote.id)).toBe(false)
    expect(host.pairing.list()).toEqual([])
  })
  for (const ending of ['Cancel', 'quitting Sotto'] as const) {
    it(`revokes the pairing and keeps no credential when ${ending} ends an add after pairing`, async () => {
      const remote = connection()
      // Pairing succeeds, and the session is still opening when the add is ended.
      let refuse: ((error: Error) => void) | undefined
      const opening = vi.spyOn(SocketHostService.prototype, 'connect').mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject }))
      try {
        const pending = manager.command({ type: 'add', host: remote })
        await vi.waitFor(() => expect(refuse).toBeTypeOf('function'))
        expect(credentials.has('remote-host:' + remote.id)).toBe(true)
        expect(host.pairing.list()).toHaveLength(1)
        const ended = ending === 'Cancel' ? manager.command({ type: 'cancel-add', id: remote.id }) : manager.close()
        // The session gives up only once the add has let go of it, as a socket to a closed tunnel does.
        await vi.waitFor(() => expect(host.pairing.list()).toEqual([]))
        refuse!(new Error('The host closed the connection. Try again.'))
        await ended
        // Quitting waits for the add to finish letting go, so the credential is gone before the quit drain ends.
        expect(credentials.has('remote-host:' + remote.id)).toBe(false)
        await pending
      } finally { opening.mockRestore() }
      expect(manager.get().adding).toBeUndefined()
      expect(manager.get().hosts).toEqual([])
      expect(await savedFile()).toEqual([])
    })
  }
  it('asks its SSH question in the dialog, and Cancel there leaves nothing behind', async () => {
    askOnConnect = 'passphrase'
    const remote = connection()
    const pending = manager.command({ type: 'add', host: remote })
    await vi.waitFor(() => expect(manager.get().adding?.prompt).toMatchObject({ id: 'prompt-1', kind: 'passphrase' }))
    expect(manager.get().hosts).toEqual([])
    await manager.command({ type: 'cancel-add', id: remote.id })
    await pending
    expect(manager.get().adding).toBeUndefined()
    expect(manager.get().hosts).toEqual([])
    expect(await savedFile()).toEqual([])
    expect(credentials.has('remote-host:' + remote.id)).toBe(false)
    // Answered instead, the question goes to this attempt's SSH session and the host is saved.
    askOnConnect = 'passphrase'
    const second = connection()
    const adding = manager.command({ type: 'add', host: second })
    await vi.waitFor(() => expect(manager.get().adding?.prompt?.id).toBe('prompt-1'))
    await manager.command({ type: 'ssh-answer', id: second.id, promptId: 'prompt-1', answer: 'synthetic passphrase' })
    await adding
    expect(answers).toEqual(['synthetic passphrase'])
    expect(manager.get().hosts).toEqual([expect.objectContaining({ id: second.id, phase: 'connected' })])
    expect(JSON.stringify(await savedFile())).not.toContain('synthetic passphrase')
  })
  it('reports each step and Tailscale\'s approval page, opens the page only while it waits, and saves the host once approved', async () => {
    const url = 'https://login.tailscale.com/a/l1a2b3c4'
    const approved = Promise.withResolvers<void>()
    onConnect = async callbacks => {
      callbacks.onStep?.('reach'); callbacks.onStep?.('tailscale'); callbacks.onApproval?.({ url })
      await approved.promise
      callbacks.onApproval?.(null); callbacks.onStep?.('install'); callbacks.onStep?.('start')
    }
    const remote = connection()
    const pending = manager.command({ type: 'add', host: remote })
    await vi.waitFor(() => expect(manager.get().adding).toMatchObject({ phase: 'connecting', step: 'tailscale', tailscale: { waiting: true, url } }))
    expect(opened).toEqual([])
    await manager.command({ type: 'open-approval', id: remote.id })
    expect(opened).toEqual([url])
    approved.resolve()
    await pending
    // The pairing is Sotto's own step, after the launcher's.
    expect(manager.get().hosts).toEqual([expect.objectContaining({ id: remote.id, phase: 'connected', step: 'pair', tailscale: { waiting: false } })])
    await expect(manager.command({ type: 'open-approval', id: remote.id })).rejects.toThrow('Tailscale is no longer waiting for this approval. Nothing was opened.')
    expect(opened).toHaveLength(1)
    expect(JSON.stringify(await savedFile())).not.toContain('tailscale.com')
  })
  it('opens no page but Tailscale\'s own, whatever reached the state', async () => {
    const held = Promise.withResolvers<void>()
    onConnect = async callbacks => { callbacks.onApproval?.({ url: 'https://login.tailscale.com.example.net/a/l1' }); await held.promise }
    const remote = connection()
    const pending = manager.command({ type: 'add', host: remote })
    await vi.waitFor(() => expect(manager.get().adding?.tailscale?.waiting).toBe(true))
    await expect(manager.command({ type: 'open-approval', id: remote.id })).rejects.toThrow('Nothing was opened.')
    expect(opened).toEqual([])
    held.resolve(); await pending
  })
  it('puts a failure on the step it belongs to, with its fix, and a Tailscale approval that never came stops the retries', async () => {
    const changed = new SshFailure('host-key-changed')
    changed.fix = { text: 'Remove the old key:', command: 'ssh-keygen -R forge.example.net' }
    failures.push(changed)
    onConnect = async callbacks => { callbacks.onStep?.('reach') }
    const remote = connection()
    await manager.command({ type: 'add', host: remote })
    expect(manager.get().adding).toMatchObject({ phase: 'error', step: 'sign-in', fix: { text: 'Remove the old key:', command: 'ssh-keygen -R forge.example.net' },
      error: 'The SSH host key changed. Nothing was saved. Verify the host identity and update your SSH known hosts before adding the host again.' })
    // A failure with no step of its own stays where the connect had reached.
    failures.push(new SshFailure('connect-timeout'))
    onConnect = async callbacks => { callbacks.onStep?.('reach'); callbacks.onStep?.('sign-in') }
    await manager.command({ type: 'add', host: connection() })
    expect(manager.get().adding).toMatchObject({ phase: 'error', step: 'sign-in' })
    await manager.command({ type: 'cancel-add', id: manager.get().adding!.id })
    await add()
    const unapproved = new SshFailure('tailscale-unapproved')
    failures.push(unapproved)
    await relaunch()
    await vi.waitFor(() => expect(manager.get().hosts[0]).toMatchObject({ phase: 'error', reconnecting: false, step: 'tailscale',
      error: 'Tailscale SSH asked you to approve this connection, and no approval came within 5 minutes, so Sotto stopped connecting. Approve it in your browser when Sotto asks, then reconnect.' }))
    expect(scheduled).toEqual([])
  })
  it('says in the dialog that nothing was saved when Tailscale\'s approval never came', async () => {
    failures.push(new SshFailure('tailscale-unapproved'))
    onConnect = async callbacks => { callbacks.onStep?.('reach'); callbacks.onStep?.('tailscale'); callbacks.onApproval?.({ url: 'https://login.tailscale.com/a/l1' }); callbacks.onApproval?.(null) }
    await manager.command({ type: 'add', host: connection() })
    expect(manager.get().adding).toMatchObject({ phase: 'error', step: 'tailscale', tailscale: { waiting: false },
      error: 'Tailscale SSH asked you to approve this connection, and no approval came within 5 minutes, so Sotto stopped connecting. Nothing was saved. Approve it in your browser when Sotto asks, then add the host again.' })
  })
  it('renames a host everywhere its name shows', async () => {
    const remote = await add()
    await manager.command({ type: 'rename', id: remote.id, name: 'Forge' })
    expect(manager.get().hosts[0]!.name).toBe('Forge')
    expect(router.shell().connections).toEqual([expect.objectContaining({ name: 'Forge' })])
    expect(await savedFile()).toEqual([expect.objectContaining({ name: 'Forge' })])
  })
  it('switched off disconnects, cancels a pending retry, and keeps the row, its pairing and the host running', async () => {
    const remote = await add()
    const token = credentials.get('remote-host:' + remote.id)
    retryDelay = () => 60_000
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
    await manager.command({ type: 'set-enabled', id: remote.id, enabled: false })
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'disconnected', enabled: false })
    expect(manager.get().hosts[0]!.reconnecting).toBeUndefined()
    expect(stops).toEqual([])
    expect(credentials.get('remote-host:' + remote.id)).toBe(token)
    expect(await savedFile()).toEqual([expect.objectContaining({ id: remote.id, enabled: false })])
    // Switched on again, it connects now with the pairing it kept.
    const switchedOn = await manager.command({ type: 'set-enabled', id: remote.id, enabled: true })
    // A switch-on is a first connect, not a reconnect, until it has to retry.
    expect(switchedOn.hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: false })
    await vi.waitFor(() => expect(manager.get().hosts[0]).toMatchObject({ phase: 'connected', enabled: true, reconnecting: false }))
    expect(host.pairing.list()).toHaveLength(1)
    expect(await savedFile()).toEqual([expect.not.objectContaining({ enabled: false })])
  })
  it('stays off when switched off while a reconnect is still closing the dropped session', async () => {
    const remote = await add()
    retryDelay = () => 60_000
    // The dropped session's ssh takes its time to exit, as it does on a real network.
    let exited: (() => void) | undefined
    vi.spyOn(launchers[0]!, 'disconnect').mockImplementationOnce(() => new Promise<void>(resolve => { exited = resolve }))
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
    // The retry fires and starts closing the old session; the user switches the host off in that moment.
    const retry = manager.command({ type: 'connect', id: remote.id })
    await vi.waitFor(() => expect(exited).toBeTypeOf('function'))
    await manager.command({ type: 'set-enabled', id: remote.id, enabled: false })
    exited!()
    await retry
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'disconnected', enabled: false })
    expect(launchers).toHaveLength(1)
    expect(router.shell().connections ?? []).toEqual([])
  })
  it('reads Switched off, not Needs attention, when switched off while its launch connect is still running', async () => {
    await add()
    askOnConnect = 'passphrase'
    await relaunch()
    const id = manager.get().hosts[0]!.id
    await vi.waitFor(() => expect(manager.get().hosts[0]!.prompt?.id).toBe('prompt-1'))
    await manager.command({ type: 'set-enabled', id, enabled: false })
    // The cancelled connect settles, with no real waiting, after the switch has set the row; it must not report the cancel.
    await new Promise(resolve => setImmediate(resolve))
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'disconnected', enabled: false })
    expect(manager.get().hosts[0]!.error).toBeUndefined()
    expect(scheduled).toEqual([])
  })
  it('switches a host off when Stop host stops it, so the next launch does not start it again', async () => {
    const remote = await add()
    await manager.command({ type: 'stop-host', id: remote.id })
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'disconnected', enabled: false })
    await relaunch()
    expect(launchers).toHaveLength(1)
  })
  it('reconnects hosts that are on when Sotto starts, in the background, and leaves switched-off ones alone', async () => {
    const on = await add()
    const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Sotto desktop')
    const off: RemoteHost = { ...connection('elsewhere'), enabled: false }
    await credentials.set(`remote-host:${off.id}`, paired.token)
    const [saved] = await savedFile()
    // The first host is written the way a Sotto from before the switch wrote it: no flag at all.
    await relaunch([saved!, { ...off, hostId: randomUUID(), clientId: paired.clientId }])
    expect(manager.get().hosts.map(item => [item.id, item.enabled])).toEqual([[on.id, true], [off.id, false]])
    await vi.waitFor(() => expect(manager.get().hosts[0]).toMatchObject({ phase: 'connected', reconnecting: false }))
    expect(manager.get().hosts[1]).toMatchObject({ phase: 'disconnected' })
    // One launcher for the add, one for the launch reconnect: the switched-off host was never tried.
    expect(launchers).toHaveLength(2)
    expect(router.shell().connections).toEqual([expect.objectContaining({ hostId: reportedHostId })])
  })
  it('shows Reconnecting… and retries on the backoff when a host that is on cannot be reached at launch, and stops at a failure only the user can fix', async () => {
    await add()
    failures.push(new SshFailure('ssh-unreachable'), new SshFailure('auth-failed'))
    await relaunch()
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
    await vi.waitFor(() => expect(manager.get().hosts[0]).toMatchObject({ phase: 'error', reconnecting: false, error: expect.stringContaining('refused your sign-in') }))
    // The launch attempt, then one retry on the first delay, which met the final failure and stopped.
    expect(scheduled).toEqual([0])
    expect(launchers).toHaveLength(3)
    // Switching it on again is how it is tried once the cause is fixed.
    await manager.command({ type: 'set-enabled', id: manager.get().hosts[0]!.id, enabled: true })
    await vi.waitFor(() => expect(manager.get().hosts[0]).toMatchObject({ phase: 'connected' }))
  })
  it('stops retrying when the boot unit would not start it or keep it running, which only its journal explains', async () => {
    await add()
    for (const code of ['boot-start-refused', 'boot-unit-failed'] as const) {
      scheduled.length = 0
      const launched = launchers.length
      failures.push(new SshFailure(code))
      await relaunch()
      await vi.waitFor(() => expect(manager.get().hosts[0]).toMatchObject({ phase: 'error', reconnecting: false, error: expect.stringContaining('systemd unit') }))
      expect(scheduled).toEqual([])
      expect(launchers.length - launched).toBe(1)
    }
  })
  it('reads a saved-hosts file written before the switch and the port existed', async () => {
    const legacy = { id: randomUUID(), name: 'forge', target: 'zach@forge', identityFile: '', installPath: '~/.local/share/sotto-host', dataDirectory: '~/.sotto' }
    failures.push(new SshFailure('auth-failed'))
    await relaunch([legacy])
    expect(manager.get().hosts).toEqual([expect.objectContaining({ id: legacy.id, enabled: true })])
    await vi.waitFor(() => expect(manager.get().hosts[0]!.phase).toBe('error'))
  })
})

describe('a host from before protocol v1 froze', () => {
  let old: Server | undefined
  afterEach(async () => { await new Promise<void>(resolve => old ? old.close(() => resolve()) : resolve()); old = undefined })
  /** The tunnel reaches a host that answers health the way 0.1.15 did: protocol 1, with no Sotto version or features. */
  async function connectToOldHost(): Promise<RemoteHost> {
    old = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ v: 1, status: 'ready', hostId: reportedHostId, pid: 4242, port: 4319 })) })
    await new Promise<void>(resolve => old!.listen(0, '127.0.0.1', resolve))
    const address = old.address()
    if (!address || typeof address === 'string') throw new Error('No loopback port.')
    tunnelUrl = () => 'http://127.0.0.1:' + address.port
    // Saved and paired by an earlier Sotto, and switched off, so the only thing the old host is asked is its health.
    const remote: RemoteHost = { ...connection(), enabled: false }
    const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Sotto desktop')
    await credentials.set(`remote-host:${remote.id}`, paired.token)
    await relaunch([{ ...remote, hostId: reportedHostId, clientId: paired.clientId }])
    await manager.command({ type: 'connect', id: remote.id })
    return remote
  }
  it('says to install this version, stop the host and connect again, keeps Stop host for a host Sotto started, and does not retry', async () => {
    const remote = await connectToOldHost()
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'error', owned: true, error: hostVersionMismatch(packageVersion, undefined, true) })
    expect(manager.get().hosts[0]!.error).toContain('press Stop host, then connect again.')
    expect(scheduled).toEqual([])
    await manager.command({ type: 'stop-host', id: remote.id })
    expect(stops).toEqual([reportedHostId])
    expect(manager.get().hosts[0]!.phase).toBe('disconnected')
  })
  it('stops a host Sotto started when it is forgotten while its session is kept for Stop host', async () => {
    const remote = await connectToOldHost()
    await manager.command({ type: 'forget', id: remote.id })
    expect(stops).toEqual([reportedHostId])
    expect(manager.get().hosts).toEqual([])
  })
  it('lets Edit connection change the installation folder while the session is kept for Stop host, and offers Stop host again on the next connect', async () => {
    const remote = await connectToOldHost()
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'error', owned: true })
    await manager.command({ type: 'save', host: { ...connection(), id: remote.id, installPath: '/opt/sotto-new' } })
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'disconnected', installPath: '/opt/sotto-new', enabled: false, name: 'Forge fixture' })
    expect(manager.get().hosts[0]!.owned).toBeUndefined()
    await manager.command({ type: 'connect', id: remote.id })
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'error', owned: true })
  })
  it('sends the user to the host machine for a host Sotto did not start', async () => {
    owned = false
    await connectToOldHost()
    expect(manager.get().hosts[0]!.phase).toBe('error')
    expect(manager.get().hosts[0]!.owned).toBeUndefined()
    expect(manager.get().hosts[0]!.error).toBe(hostVersionMismatch(packageVersion, undefined, false))
    expect(scheduled).toEqual([])
  })
})

describe('start at boot (ADR-0054)', () => {
  const on: BootStatus = { supported: true, installed: true, enabled: true, active: true, linger: true, nodeDrift: false }
  const off: BootStatus = { supported: true, installed: false, enabled: false, active: false, linger: true, nodeDrift: false }
  const row = (id: string) => router.shell().host.threads.find(thread => thread.id === id)

  it('shows start at boot as the launch found it, and keeps the threads through the restart installing it causes', async () => {
    bootStart = off
    const remote = await add()
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'connected', bootStart: off })
    const thread = await remoteThread()
    boot = async () => {
      // The unit takes the host over: the host Sotto started stops, which drops this computer's socket, and the unit starts it.
      await host.close()
      await vi.waitFor(() => expect(row(thread)).toMatchObject({ clientConnected: false, clientReconnecting: true }))
      host = await startHeadlessHost({ dataDirectory: join(root, 'remote'), port: 0, providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner })
      bootStart = on
      return { type: 'boot-installed', installed: true, stopped: true, pid: process.pid, bootStart: on }
    }
    expect(await manager.setBootStart(remote.id, 'install')).toMatchObject({ type: 'boot-installed', stopped: true })
    expect(boots).toEqual([{ op: 'boot-install' }])
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'connected', bootStart: on })
    expect(row(thread)).toMatchObject({ id: thread })
    expect(row(thread)!.clientReconnecting).toBeUndefined()
    expect(launchers).toHaveLength(2)
    expect(scheduled).toEqual([])
  })

  it('carries on over the same connection when nothing was stopped, as when linger needs an administrator', async () => {
    bootStart = off
    const remote = await add()
    const refused: BootStatus = { ...off, linger: false, fix: 'sudo loginctl enable-linger user' }
    boot = async () => ({ type: 'boot-installed', installed: false, stopped: false, bootStart: refused })
    expect(await manager.setBootStart(remote.id, 'install')).toMatchObject({ installed: false })
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'connected', bootStart: refused })
    expect(launchers).toHaveLength(1)
  })

  it('asks the host to start again after removing the unit only while the saved host is switched on', async () => {
    bootStart = on
    const remote = await add()
    boot = async () => ({ type: 'boot-removed', stopped: false, bootStart: off })
    await manager.setBootStart(remote.id, 'remove')
    expect(boots).toEqual([{ op: 'boot-remove', restart: true }])
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'connected', bootStart: off })
    // A host that is switched off has no connection to send it over, and nothing is started for it.
    await manager.command({ type: 'set-enabled', id: remote.id, enabled: false })
    await expect(manager.setBootStart(remote.id, 'remove')).rejects.toThrow('Connect to Forge fixture before changing whether its host starts at boot. Nothing was changed.')
    expect(boots).toHaveLength(1)
    expect(launchers).toHaveLength(1)
  })

  it('removes the unit on Forget after the revoke and before the stop, and starts nothing', async () => {
    bootStart = on
    const remote = await add()
    const token = credentials.get('remote-host:' + remote.id)
    boot = async () => {
      expect(host.pairing.verifyToken(token)).toBeUndefined()
      expect(stops).toEqual([])
      return { type: 'boot-removed', stopped: true, bootStart: off }
    }
    await manager.command({ type: 'forget', id: remote.id })
    expect(boots).toEqual([{ op: 'boot-remove', restart: false }])
    expect(stops).toEqual([reportedHostId])
    expect(operations).toEqual(['ssh revoke-client', 'ssh boot-remove', 'ssh stop-host'])
    expect(manager.get().hosts).toEqual([])
  })

  it('asks nothing about a unit on Forget when the host has none', async () => {
    bootStart = off
    const remote = await add()
    await manager.command({ type: 'forget', id: remote.id })
    expect(boots).toEqual([])
  })
})

describe('updating a host from the Threads page (ADR-0040)', () => {
  const providers = () => ({ codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() })
  beforeEach(async () => {
    // The fixture host runs an older Sotto than this computer.
    await manager.close(); await host.close()
    host = await startHeadlessHost({ dataDirectory: join(root, 'remote'), port: 0, providers: providers(), reasoner: e2eAgentReasoner, sottoVersion: '0.0.1' })
    manager = newManager(); await manager.start()
  })
  it('knows which Sotto a connected host runs, and offers it to an update with the folders it is installed in', async () => {
    const remote = await add()
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'connected', version: '0.0.1' })
    expect(manager.updateCandidates()).toEqual([{ id: remote.id, name: 'Forge fixture', hostId: reportedHostId, version: '0.0.1', owned: true, installPath: '/opt/sotto', dataDirectory: '/data/sotto' }])
    await manager.command({ type: 'disconnect', id: remote.id })
    expect(manager.get().hosts[0]!.version).toBeUndefined()
    expect(manager.updateCandidates()).toEqual([])
  })
  it('keeps the host\'s threads on the page through the restart, reading Reconnecting, and connects to the new version in their place', async () => {
    const remote = await add()
    const thread = await remoteThread()
    expect(row(thread)).toMatchObject({ clientConnected: true })
    updateHost = async operation => {
      expect(operation).toEqual({ op: 'update-restart', version: packageVersion })
      // The old host stops, which drops this computer's socket; its thread stays, and says why it cannot send.
      await host.close()
      await vi.waitFor(() => expect(row(thread)).toMatchObject({ clientConnected: false, clientReconnecting: true }))
      expect(router.shell().activeThreadId).toBe(thread)
      host = await startHeadlessHost({ dataDirectory: join(root, 'remote'), port: 0, providers: providers(), reasoner: e2eAgentReasoner })
      return { type: 'ready', v: 1, status: 'ready', hostId: reportedHostId, pid: process.pid, port: host.descriptor!.port, owned: true }
    }
    expect(await manager.restartForUpdate(remote.id, packageVersion)).toMatchObject({ type: 'ready' })
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'connected', version: packageVersion })
    expect(row(thread)).toMatchObject({ id: thread })
    expect(row(thread)!.clientReconnecting).toBeUndefined()
    // The same thread, still selected, on a fresh connection, with no retry left behind.
    expect(router.shell().activeThreadId).toBe(thread)
    const composed = await router.command({ type: 'compose', text: 'Draft after restart' }, desktopWindowClient('desktop-test'))
    expect(composed.error).toBeNull()
    expect(composed.threadDrafts).toContainEqual(expect.objectContaining({ threadId: thread, text: 'Draft after restart' }))
    expect(launchers).toHaveLength(2)
    expect(scheduled).toEqual([])
    expect(manager.updateCandidates()[0]!.version).toBe(packageVersion)
  })
  it('takes the threads off the page once the host cannot be reached again, and says why on its row', async () => {
    const remote = await add()
    const thread = await remoteThread()
    updateHost = async () => { await host.close(); throw new SshFailure('update-failed') }
    failures.push(new SshFailure('archive-missing'))
    await expect(manager.restartForUpdate(remote.id, packageVersion)).rejects.toMatchObject({ code: 'update-failed' })
    expect(row(thread)).toBeUndefined()
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'error', error: 'The host installation was not found. Check its folder on the SSH host and reconnect.' })
  })
  it('carries on over the same connection when the host refuses the restart before stopping anything', async () => {
    const remote = await add()
    const thread = await remoteThread()
    updateHost = async () => ({ type: 'error', reason: 'update-stop-failed' })
    expect(await manager.restartForUpdate(remote.id, packageVersion)).toEqual({ type: 'error', reason: 'update-stop-failed' })
    expect(launchers).toHaveLength(1)
    expect(row(thread)).toMatchObject({ clientConnected: true })
    expect(row(thread)!.clientReconnecting).toBeUndefined()
    // The connection is still the host's: a later drop reconnects as any drop does.
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    await vi.waitFor(() => expect(manager.get().hosts[0]!.phase).toBe('connected'))
    expect(launchers).toHaveLength(2)
  })
  it('reconnects a connection dropped while an update is under way, although the user\'s own commands on the host wait', async () => {
    const remote = await add()
    manager.useUpdates({ state: () => [], command: async () => undefined, subscribe: () => () => undefined,
      busy: id => id === remote.id ? 'Sotto is updating the host on Forge fixture. Nothing was changed. Wait for the update to finish, then try again.' : undefined })
    await expect(manager.command({ type: 'disconnect', id: remote.id })).rejects.toThrow('Sotto is updating the host on Forge fixture.')
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    await vi.waitFor(() => expect(manager.get().hosts[0]!.phase).toBe('connected'))
    expect(launchers).toHaveLength(2)
  })
  it('refuses a restart for a host Sotto did not start', async () => {
    owned = false
    const remote = await add()
    await expect(manager.restartForUpdate(remote.id, packageVersion)).rejects.toThrow('Sotto did not start the host on Forge fixture')
    expect(manager.get().hosts[0]!.phase).toBe('connected')
  })
})

describe('a drop keeps the host’s threads on the page (ADR-0053)', () => {
  /** Every socket the manager opened, so a test can drop one the way a lost network does. */
  const sockets: SocketHostService[] = []
  beforeEach(() => {
    sockets.length = 0
    const connect = SocketHostService.prototype.connect
    vi.spyOn(SocketHostService.prototype, 'connect').mockImplementation(function (this: SocketHostService) { sockets.push(this); return connect.call(this) })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('keeps the threads and the selection, reading Reconnecting, until the next connection takes their place', async () => {
    const remote = await add()
    const thread = await remoteThread()
    retryDelay = () => 60_000
    await sockets.at(-1)!.close()
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
    expect(row(thread)).toMatchObject({ clientReconnecting: true })
    expect(router.shell().activeThreadId).toBe(thread)
    // The retry, pressed rather than waited for: the new connection takes the same place.
    await manager.command({ type: 'connect', id: remote.id })
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'connected', reconnecting: false })
    expect(row(thread)).toMatchObject({ id: thread, clientConnected: true })
    expect(row(thread)!.clientReconnecting).toBeUndefined()
    expect(router.shell().activeThreadId).toBe(thread)
    expect(router.shell().connections).toEqual([expect.objectContaining({ hostId: reportedHostId, connected: true })])
  })

  it('takes the threads away when the reconnect meets a failure only the user can fix', async () => {
    await add()
    const thread = await remoteThread()
    failures.push(new SshFailure('host-key-changed'))
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    await vi.waitFor(() => expect(manager.get().hosts[0]).toMatchObject({ phase: 'error', reconnecting: false }), { timeout: 20_000 })
    expect(row(thread)).toBeUndefined()
    expect(router.shell().connections).toEqual([])
  })

  it('takes the threads away when the user disconnects while it reconnects', async () => {
    const remote = await add()
    const thread = await remoteThread()
    retryDelay = () => 60_000
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    expect(row(thread)).toBeDefined()
    await manager.command({ type: 'disconnect', id: remote.id })
    expect(row(thread)).toBeUndefined()
  })
})

describe('admin connections and Forget (ADR-0053)', () => {
  it('sends an admin press on a host on its SSH connection over that connection, opening no second ssh', async () => {
    const phones = new HostPhones({ hosts: { links: () => manager.phonesLinks(), subscribe: listener => manager.subscribe(() => listener()) }, openExternal: async () => undefined })
    manager.usePhones(phones)
    try {
      const remote = await add()
      await vi.waitFor(() => expect(manager.get().phones?.[0]?.state).toBeDefined(), { timeout: 20_000 })
      await manager.command({ type: 'host-phones', id: remote.id, command: { type: 'retry' } })
      updateHost = async () => ({ type: 'update-fetched', file: 'Sotto-host-0.1.31-linux-x64.tar.gz', sha256: 'a'.repeat(64) })
      await manager.runUpdate(remote.id, { op: 'update-fetch', version: packageVersion, releasesUrl: 'https://releases.example/download' })
      await manager.command({ type: 'stop-host', id: remote.id })
      expect(launchers).toHaveLength(1)
      expect(operations).toEqual(['ssh update-fetch', 'ssh stop-host'])
    } finally { phones.close() }
  })

  it('opens no admin connection for a Phones press on a link whose connect has ended', async () => {
    const remote = await add()
    const [link] = manager.phonesLinks()
    await manager.command({ type: 'disconnect', id: remote.id })
    await expect(link!.press(async () => 'sent')).rejects.toThrow('Forge fixture is not connected. Nothing was changed.')
    expect(launchers).toHaveLength(1)
  })

  it('revokes over the SSH connection the socket is on, before the stop, with no second ssh, and never pairs again', async () => {
    const remote = await add()
    const token = credentials.get('remote-host:' + remote.id)
    const state = await manager.command({ type: 'forget', id: remote.id })
    expect(operations).toEqual(['ssh revoke-client', 'ssh stop-host'])
    expect(launchers).toHaveLength(1)
    expect(host.pairing.verifyToken(token)).toBeUndefined()
    expect(state.forgotten).toBeUndefined()
    expect(scheduled).toEqual([])
    expect(host.pairing.list()).toEqual([])
  })

  it('opens one admin connection for a host on no SSH connection, which starts nothing, and revokes and stops over it', async () => {
    const remote = await add()
    const token = credentials.get('remote-host:' + remote.id)
    await manager.command({ type: 'set-enabled', id: remote.id, enabled: false })
    const state = await manager.command({ type: 'forget', id: remote.id })
    // One ssh for the add, and one admin connection for both of Forget's presses.
    expect(launchers).toHaveLength(2)
    // Forget's own: a host found stopped would have its boot unit taken away before the connect failed.
    expect(launchers[1]!.options).toEqual({ start: false, removeBoot: true })
    expect(operations).toEqual(['admin revoke-client', 'admin stop-host'])
    expect(host.pairing.verifyToken(token)).toBeUndefined()
    expect(state.hosts).toEqual([]); expect(state.forgotten).toBeUndefined()
    expect(credentials.has('remote-host:' + remote.id)).toBe(false)
    expect(scheduled).toEqual([])
  })

  it('ends a connect still opening its socket before it revokes, and revokes and stops over an admin connection instead', async () => {
    const remote = await add()
    await manager.command({ type: 'set-enabled', id: remote.id, enabled: false })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let held = false
    const connect = SocketHostService.prototype.connect
    const opening = vi.spyOn(SocketHostService.prototype, 'connect').mockImplementation(async function (this: SocketHostService) {
      held = true
      await gate
      return connect.call(this)
    })
    try {
      await manager.command({ type: 'set-enabled', id: remote.id, enabled: true })
      await vi.waitFor(() => expect(held).toBe(true), { timeout: 20_000 })
      const state = await manager.command({ type: 'forget', id: remote.id })
      // The connect's SSH is past its sign-in, but the press does not go over it: the connect ended first.
      expect(operations).toEqual(['admin revoke-client', 'admin stop-host'])
      expect(state.hosts).toEqual([]); expect(state.forgotten).toBeUndefined()
    } finally { release(); opening.mockRestore() }
    expect(scheduled).toEqual([])
  })

  it('stops no host it did not start, over either connection', async () => {
    owned = false
    const remote = await add()
    await manager.command({ type: 'disconnect', id: remote.id })
    await manager.command({ type: 'forget', id: remote.id })
    expect(operations).toEqual(['admin revoke-client'])
    expect(stops).toEqual([])
  })

  it('counts an answer that the host no longer knew this computer as revoked', async () => {
    const remote = await add()
    await manager.command({ type: 'disconnect', id: remote.id })
    await host.pairing.revoke(manager.get().hosts[0]!.clientId!)
    const state = await manager.command({ type: 'forget', id: remote.id })
    expect(operations).toEqual(['admin revoke-client', 'admin stop-host'])
    expect(state.forgotten).toBeUndefined()
  })

  for (const [what, cause, arrange] of [
    ['finds its host stopped', 'not-running', () => { hostRunning = false }],
    ['is refused the revoke by a host Sotto did not start', 'refused', () => { revokeFails = true; owned = false }],
    // The host stays running, so the command the notice gives can be run there now.
    ['is refused the revoke by a host Sotto started, which it leaves running', 'refused', () => { revokeFails = true }],
  ] as const) {
    it(`removes a host whose admin connection ${what}, clears its credential and says why it was not revoked`, async () => {
      const remote = await add()
      const token = credentials.get('remote-host:' + remote.id)
      await manager.command({ type: 'disconnect', id: remote.id })
      arrange()
      const state = await manager.command({ type: 'forget', id: remote.id })
      expect(state.hosts).toEqual([]); expect(await savedFile()).toEqual([])
      expect(credentials.has('remote-host:' + remote.id)).toBe(false)
      expect(host.pairing.verifyToken(token)).toBeDefined()
      expect(state.forgotten).toEqual([expect.objectContaining({ id: remote.id, name: 'Forge fixture', cause, command: expect.stringContaining('--revoke-client') })])
      expect(stops).toEqual([])
      // A stopped host's launch takes its boot unit away before it fails, so the forgotten host does not start at the next boot.
      expect(launchers.at(-1)!.options).toEqual({ start: false, removeBoot: true })
    })
  }

  it('counts a revoke that never got an answer as the host not reached, not refused, and still stops a host Sotto started', async () => {
    const remote = await add()
    const token = credentials.get('remote-host:' + remote.id)
    await manager.command({ type: 'disconnect', id: remote.id })
    revokeError = new SshFailure('request-busy')
    const state = await manager.command({ type: 'forget', id: remote.id })
    expect(operations).toEqual(['admin revoke-client', 'admin stop-host'])
    expect(state.hosts).toEqual([])
    expect(host.pairing.verifyToken(token)).toBeDefined()
    expect(state.forgotten).toEqual([expect.objectContaining({ id: remote.id, cause: 'unreachable' })])
  })

  it('keeps a host Sotto started when its revoke never got an answer and its stop failed too', async () => {
    const remote = await add()
    await manager.command({ type: 'disconnect', id: remote.id })
    revokeError = new SshFailure('not-connected'); stopResult = false
    await expect(manager.command({ type: 'forget', id: remote.id })).rejects.toThrow('may still be running')
    expect(manager.get().hosts).toEqual([expect.objectContaining({ id: remote.id })])
    expect(manager.get().forgotten).toBeUndefined()
  })

  it('keeps every not-revoked notice until its own Dismiss, whatever later Forgets do', async () => {
    const first = await add()
    await manager.command({ type: 'disconnect', id: first.id })
    failures.push(new SshFailure('ssh-unreachable'))
    await manager.command({ type: 'forget', id: first.id })
    // A Forget that revokes leaves the earlier notice alone.
    const second = await add()
    expect((await manager.command({ type: 'forget', id: second.id })).forgotten).toEqual([expect.objectContaining({ id: first.id })])
    // Another Forget that could not revoke adds its own beside it.
    const third = await add()
    await manager.command({ type: 'disconnect', id: third.id })
    hostRunning = false
    const state = await manager.command({ type: 'forget', id: third.id })
    expect(state.forgotten).toEqual([expect.objectContaining({ id: first.id, cause: 'unreachable' }), expect.objectContaining({ id: third.id, cause: 'not-running' })])
    expect((await manager.command({ type: 'dismiss-forgotten', id: first.id })).forgotten).toEqual([expect.objectContaining({ id: third.id })])
    expect((await manager.command({ type: 'dismiss-forgotten', id: third.id })).forgotten).toBeUndefined()
  })

  it('changes nothing when the user stops Forget’s sign-in while SSH waits for an answer', async () => {
    const remote = await add()
    const token = credentials.get('remote-host:' + remote.id)
    await manager.command({ type: 'set-enabled', id: remote.id, enabled: false })
    askOnConnect = 'passphrase'
    const forgetting = manager.command({ type: 'forget', id: remote.id })
    await vi.waitFor(() => expect(manager.get().hosts[0]).toMatchObject({ adminSignIn: true, prompt: { id: 'prompt-1' } }), { timeout: 20_000 })
    await manager.command({ type: 'stop-admin-sign-in', id: remote.id })
    const state = await forgetting
    expect(state.hosts).toEqual([expect.objectContaining({ id: remote.id, phase: 'disconnected', enabled: false })])
    expect(state.hosts[0]!.prompt).toBeUndefined(); expect(state.hosts[0]!.adminSignIn).toBeUndefined()
    expect(state.forgotten).toBeUndefined()
    expect(operations).toEqual([])
    expect(host.pairing.verifyToken(token)).toBeDefined()
    expect(credentials.get('remote-host:' + remote.id)).toBe(token)
    // Stopping a sign-in that is not under way changes nothing either.
    await manager.command({ type: 'stop-admin-sign-in', id: remote.id })
    expect(manager.get().hosts).toHaveLength(1)
  })

  describe('a host whose socket is on no SSH connection', () => {
    /** Stands in for a host on its tailnet connection (pull request 4): the SSH connection is gone and the socket stays up. */
    const offSsh = (id: string): void => {
      const live = (manager as unknown as { live: Map<string, { sshClosed?: boolean }> }).live.get(id)!
      live.sshClosed = true
    }

    it('sends Phones and Update presses over one admin connection, which starts nothing', async () => {
      const phones = new HostPhones({ hosts: { links: () => manager.phonesLinks(), subscribe: listener => manager.subscribe(() => listener()) }, openExternal: async () => undefined })
      manager.usePhones(phones)
      try {
        const remote = await add()
        await vi.waitFor(() => expect(manager.get().phones?.[0]?.state).toBeDefined(), { timeout: 20_000 })
        offSsh(remote.id)
        await manager.command({ type: 'host-phones', id: remote.id, command: { type: 'retry' } })
        updateHost = async () => ({ type: 'update-fetched', file: 'Sotto-host-0.1.31-linux-x64.tar.gz', sha256: 'a'.repeat(64) })
        await manager.runUpdate(remote.id, { op: 'update-fetch', version: packageVersion, releasesUrl: 'https://releases.example/download' })
        expect(launchers).toHaveLength(2)
        expect(launchers[1]!.options).toEqual({ start: false })
        expect(operations).toEqual(['admin update-fetch'])
      } finally { phones.close() }
    })

    it('says an update’s restart never went when the admin connection cannot open, and keeps the threads as they were', async () => {
      const remote = await add()
      const thread = await remoteThread()
      offSsh(remote.id)
      hostRunning = false
      await expect(manager.restartForUpdate(remote.id, packageVersion)).rejects.toMatchObject({ code: 'not-connected', message: expect.stringContaining('The host is not running on the SSH host, so nothing was changed there.') })
      expect(operations).toEqual([])
      expect(row(thread)).toMatchObject({ id: thread, clientConnected: true })
      expect(row(thread)!.clientReconnecting).toBeUndefined()
      expect(manager.get().hosts[0]).toMatchObject({ phase: 'connected' })
    })
  })

  it('asks an admin connection’s SSH question wherever the user is, and sends the answer to that connection', async () => {
    const remote = await add()
    await manager.command({ type: 'disconnect', id: remote.id })
    askOnConnect = 'passphrase'
    const forgetting = manager.command({ type: 'forget', id: remote.id })
    await vi.waitFor(() => expect(manager.get().hosts[0]?.prompt).toMatchObject({ id: 'prompt-1', kind: 'passphrase' }), { timeout: 20_000 })
    await manager.command({ type: 'ssh-answer', id: remote.id, promptId: 'prompt-1', answer: 'synthetic passphrase' })
    expect((await forgetting).forgotten).toBeUndefined()
    expect(answers).toEqual(['synthetic passphrase'])
    expect(operations).toEqual(['admin revoke-client', 'admin stop-host'])
  })

  it('shows Tailscale’s approval for an admin connection on the host’s row, and opens its page on a press', async () => {
    const remote = await add()
    await manager.command({ type: 'disconnect', id: remote.id })
    const url = 'https://login.tailscale.com/a/l1a2b3c4'
    const approved = Promise.withResolvers<void>()
    onConnect = async callbacks => { callbacks.onApproval?.({ url }); await approved.promise; callbacks.onApproval?.(null) }
    const forgetting = manager.command({ type: 'forget', id: remote.id })
    await vi.waitFor(() => expect(manager.get().hosts[0]).toMatchObject({ phase: 'disconnected', tailscale: { waiting: true, url } }), { timeout: 20_000 })
    await manager.command({ type: 'open-approval', id: remote.id })
    expect(opened).toEqual([url])
    approved.resolve()
    expect((await forgetting).hosts).toEqual([])
  })
})
