// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import { it } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { HostCredentialEncryption } from '../../src/host/credentials'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { DesktopHosts, reconnectDelayMs } from '../../src/main/hosts/desktopHosts'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { SshFailure, SshHostLauncher, type SshCallbacks, type SshHostConnection, type SshHostConfiguration } from '../../src/main/hosts/sshLauncher'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import type { RemoteHost } from '../../src/shared/hosts'
import { hostVersionMismatch } from '../../src/shared/hostProtocol'
import { version as packageVersion } from '../../package.json'
import { createServer, type Server } from 'node:http'
import { HOST_BUSY } from '../../src/shared/hostProtocol'
import { SocketHostService } from '../../src/main/agents/socketHostService'
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
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
/** Revokes the way the launch script does, through the host's admin endpoint, which closes the revoked peer before replying. */
async function adminRevoke(clientId: string): Promise<boolean> {
  const descriptor = JSON.parse(await readFile(join(root, 'remote', 'host-listener.json'), 'utf8')) as { adminToken: string }
  const response = await fetch('http://127.0.0.1:' + host.descriptor!.port + '/v1/admin/revoke-client', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId }) })
  return ((await response.json()) as { revoked: boolean }).revoked
}
const stops: string[] = []
/** When set, the next connect asks this SSH question and waits for its answer, or for the attempt to be cancelled. */
let askOnConnect: 'passphrase' | undefined
/** Every answer given to an SSH question, to prove where the dialog's answer went. */
const answers: string[] = []
class FixtureSsh extends SshHostLauncher {
  callbacks?: SshCallbacks
  configuration?: SshHostConfiguration
  private waiting?: { resolve: () => void; reject: (error: Error) => void }
  override async connect(configuration: SshHostConfiguration, callbacks: SshCallbacks = {}): Promise<SshHostConnection> {
    this.callbacks = callbacks; this.configuration = configuration
    if (askOnConnect) {
      askOnConnect = undefined
      callbacks.onPrompt?.({ id: 'prompt-1', kind: 'passphrase', text: 'Enter passphrase for key' })
      await new Promise<void>((resolve, reject) => { this.waiting = { resolve, reject } })
    }
    const failure = failures.shift()
    if (failure) throw failure
    return { url: tunnelUrl?.() ?? 'http://127.0.0.1:' + host.descriptor!.port, hostId: reportedHostId, owned, route: { hostname: 'forge', identityFiles: [] },
      close: async () => undefined,
      showHostPairingCode: async () => ({ ...host.pairing.issuePairingCode(), hostId: reportedHostId }),
      revokeClient: adminRevoke,
      stopHost: async () => { stops.push(reportedHostId); await beforeStopReply(); if (stopResult instanceof Error) throw stopResult; return stopResult },
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
  host = await startHeadlessHost({ dataDirectory: join(root, 'remote'), port: 0, providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner })
  reportedHostId = host.descriptor!.hostId
  credentials = new AgentCredentials(join(root, 'desktop'), new HostCredentialEncryption('synthetic-desktop-credential-key')); await credentials.load()
  router = new DesktopHostRouter(emptyDesktopState)
  launchers.length = 0; failures.length = 0; stops.length = 0; answers.length = 0; askOnConnect = undefined; scheduled.length = 0; retryDelay = () => 0; owned = true; stopResult = true; beforeStopReply = async () => undefined; tunnelUrl = undefined
  manager = newManager()
  await manager.start()
})
function newManager(): DesktopHosts {
  return new DesktopHosts({ directory: join(root, 'desktop'), credentials, router, localHostRunning: false, localHostEnabled: () => false, restart: () => undefined, retryDelayMs: attempt => { scheduled.push(attempt); return retryDelay(attempt) }, launcher: () => { const launcher = new FixtureSsh(); launchers.push(launcher); return launcher } })
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
describe('desktop remote host management over a real socket', () => {
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
  it('forgets a host it cannot reach without revoking anything on it', async () => {
    const remote = await add()
    const token = credentials.get('remote-host:' + remote.id)
    await manager.command({ type: 'disconnect', id: remote.id })
    await manager.command({ type: 'forget', id: remote.id })
    expect(manager.get().hosts).toEqual([]); expect(credentials.has('remote-host:' + remote.id)).toBe(false)
    expect(host.pairing.verifyToken(token)).toBeDefined()
    expect(stops).toEqual([])
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
    // Spend the host's pairing budget for the minute, the way a loop guessing codes would.
    const guess = () => fetch('http://127.0.0.1:' + host.descriptor!.port + '/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, code: 'WRONG', name: 'Guess' }) })
    let response = await guess()
    for (let index = 0; response.status !== 429 && index < 20; index++) response = await guess()
    expect(response.status).toBe(429)
    retryDelay = attempt => attempt === 0 ? 0 : 60_000
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    // The session is refused, pairing again is refused as busy, and a second retry is scheduled after it.
    await vi.waitFor(() => expect(scheduled).toEqual([0, 1]))
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
    await manager.command({ type: 'disconnect', id: remote.id })
    await manager.command({ type: 'connect', id: remote.id })
    expect(manager.get().hosts[0]).toMatchObject({ phase: 'error', error: HOST_BUSY })
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
    expect(manager.get().adding).toMatchObject({ phase: 'error', error: expect.stringContaining('Nothing was saved.') })
    expect(credentials.has('remote-host:' + remote.id)).toBe(false)
    expect(host.pairing.list()).toEqual([])
  })
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
    await manager.command({ type: 'set-enabled', id: remote.id, enabled: true })
    await vi.waitFor(() => expect(manager.get().hosts[0]).toMatchObject({ phase: 'connected', enabled: true, reconnecting: false }))
    expect(host.pairing.list()).toHaveLength(1)
    expect(await savedFile()).toEqual([expect.not.objectContaining({ enabled: false })])
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
