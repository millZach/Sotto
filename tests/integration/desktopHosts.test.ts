// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import { it } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { HostCredentialEncryption } from '../../src/host/credentials'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { DesktopHosts } from '../../src/main/hosts/desktopHosts'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { SshHostLauncher, type SshCallbacks, type SshHostConnection, type SshHostConfiguration } from '../../src/main/hosts/sshLauncher'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import type { RemoteHost } from '../../src/shared/hosts'
let root: string, host: Awaited<ReturnType<typeof startHeadlessHost>>, credentials: AgentCredentials, router: DesktopHostRouter, manager: DesktopHosts
let reportedHostId: string
const launchers: FixtureSsh[] = [], failures: Error[] = []
let retryDelay: (attempt: number) => number = () => 0
let owned = true, stopResult: boolean | Error = true
const stops: string[] = []
class FixtureSsh extends SshHostLauncher {
  callbacks?: SshCallbacks
  override async connect(_configuration: SshHostConfiguration, callbacks: SshCallbacks = {}): Promise<SshHostConnection> {
    this.callbacks = callbacks
    const failure = failures.shift()
    if (failure) throw failure
    return { url: 'http://127.0.0.1:' + host.descriptor!.port, hostId: reportedHostId, owned,
      close: async () => undefined,
      showHostPairingCode: async () => ({ ...host.pairing.issuePairingCode(), hostId: reportedHostId }),
      revokeClient: id => host.pairing.revoke(id),
      stopHost: async () => { stops.push(reportedHostId); if (stopResult instanceof Error) throw stopResult; return stopResult },
    }
  }
  override async disconnect(): Promise<void> {}
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sotto-desktop-hosts-'))
  host = await startHeadlessHost({ dataDirectory: join(root, 'remote'), port: 0, providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner })
  reportedHostId = host.descriptor!.hostId
  credentials = new AgentCredentials(join(root, 'desktop'), new HostCredentialEncryption('synthetic-desktop-credential-key')); await credentials.load()
  router = new DesktopHostRouter(emptyDesktopState)
  launchers.length = 0; failures.length = 0; stops.length = 0; retryDelay = () => 0; owned = true; stopResult = true
  manager = new DesktopHosts({ directory: join(root, 'desktop'), credentials, router, localHostRunning: false, localHostEnabled: () => false, restart: () => undefined, retryDelayMs: attempt => retryDelay(attempt), launcher: () => { const launcher = new FixtureSsh(); launchers.push(launcher); return launcher } })
  await manager.start()
})
afterEach(async () => { await manager?.close(); router?.dispose(); await host?.close(); if (root && dirname(root) === tmpdir() && root.includes('sotto-desktop-hosts-')) await rm(root, { recursive: true, force: true }) })
async function add(): Promise<RemoteHost> {
  const remote = { id: randomUUID(), name: 'Forge fixture', target: 'forge', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data/sotto' }
  await manager.command({ type: 'save', host: remote }); await manager.command({ type: 'connect', id: remote.id })
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
    stopResult = new Error('supervisor gone')
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
  it('does not remove a connected host when a duplicate saved route fails or disconnects', async () => {
    const first = await add()
    const second = await add()
    expect(manager.get().hosts.find(host => host.id === second.id)).toMatchObject({ phase: 'error', error: expect.stringContaining('already connected') })
    await manager.command({ type: 'disconnect', id: second.id })
    expect(router.shell().connections).toEqual([expect.objectContaining({ hostId: reportedHostId })])
    expect(manager.get().hosts.find(host => host.id === first.id)?.phase).toBe('connected')
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
  it('stops retrying when a reconnect fails with an error only the user can fix', async () => {
    await add()
    failures.push(new Error('The host installation was not found. Check its folder on the SSH host and reconnect.'))
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    await vi.waitFor(() => expect(manager.get().hosts[0]).toMatchObject({ phase: 'error', reconnecting: false, error: expect.stringContaining('installation was not found') }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(launchers.length).toBe(2)
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
