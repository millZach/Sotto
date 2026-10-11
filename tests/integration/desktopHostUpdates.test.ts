// @vitest-environment node
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { version as packageVersion } from '../../package.json'
import { startHeadlessHost } from '../../src/host'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { HostUpdates } from '../../src/main/hosts/hostUpdate'
import { SshFailure } from '../../src/main/hosts/sshLauncher'
import { useDesktopHostFixture } from '../fixtures/desktopHostFixture'

const fixture = useDesktopHostFixture()

const { add, failures, launchers, newManager, remoteThread, row, scheduled } = fixture

describe('updating a host from the Threads page (ADR-0040)', () => {
  const providers = () => ({ codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() })
  beforeEach(async () => {
    // The fixture host runs an older Sotto than this computer.
    await fixture.manager.close(); await fixture.host.close()
    fixture.host = await startHeadlessHost({ dataDirectory: join(fixture.root, 'remote'), port: 0, providers: providers(), reasoner: e2eAgentReasoner, sottoVersion: '0.0.1' })
    fixture.manager = newManager(); await fixture.manager.start()
  })
  it('knows which Sotto a connected host runs, and offers it to an update with the folders it is installed in', async () => {
    const remote = await add()
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected', version: '0.0.1' })
    expect(fixture.manager.updateCandidates()).toEqual([{ id: remote.id, name: 'Forge fixture', hostId: fixture.reportedHostId, version: '0.0.1', owned: true, installPath: '/opt/sotto', dataDirectory: '/data/sotto' }])
    await fixture.manager.command({ type: 'disconnect', id: remote.id })
    expect(fixture.manager.get().hosts[0]!.version).toBeUndefined()
    expect(fixture.manager.updateCandidates()).toEqual([])
  })
  it('says a host that starts at boot does, so the update panel can say its systemd unit restarts it', async () => {
    fixture.bootStart = { supported: true, installed: true, enabled: true, active: true, linger: true, nodeDrift: false }
    const remote = await add()
    expect(fixture.manager.updateCandidates()).toEqual([expect.objectContaining({ id: remote.id, boot: true })])
    const updates = new HostUpdates({ version: packageVersion, threads: { working: () => [], interrupt: async () => undefined, subscribe: () => () => undefined },
      hosts: { candidates: () => fixture.manager.updateCandidates(), run: async () => ({ type: 'error', reason: 'update-failed' }), restart: async () => ({ type: 'error', reason: 'update-failed' }), subscribe: listener => fixture.manager.subscribe(() => listener()) } })
    expect(updates.state()).toEqual([expect.objectContaining({ id: remote.id, phase: 'needs', boot: true })])
    updates.dispose()
  })
  it('keeps the host\'s threads on the page through the restart, reading Reconnecting, and connects to the new version in their place', async () => {
    const remote = await add()
    const thread = await remoteThread()
    expect(row(thread)).toMatchObject({ clientConnected: true })
    fixture.updateHost = async operation => {
      expect(operation).toEqual({ op: 'update-restart', version: packageVersion })
      // The old host stops, which drops this computer's socket; its thread stays, and says why it cannot send.
      await fixture.host.close()
      await vi.waitFor(() => expect(row(thread)).toMatchObject({ clientConnected: false, clientReconnecting: true }))
      expect(fixture.router.shell().activeThreadId).toBe(thread)
      fixture.host = await startHeadlessHost({ dataDirectory: join(fixture.root, 'remote'), port: 0, providers: providers(), reasoner: e2eAgentReasoner })
      return { type: 'ready', v: 1, status: 'ready', hostId: fixture.reportedHostId, pid: process.pid, port: fixture.host.descriptor!.port, owned: true }
    }
    expect(await fixture.manager.restartForUpdate(remote.id, packageVersion)).toMatchObject({ type: 'ready' })
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected', version: packageVersion })
    expect(row(thread)).toMatchObject({ id: thread })
    expect(row(thread)!.clientReconnecting).toBeUndefined()
    // The same thread, still selected, on a fresh connection, with no retry left behind.
    expect(fixture.router.shell().activeThreadId).toBe(thread)
    const composed = await fixture.router.command({ type: 'compose', text: 'Draft after restart' }, desktopWindowClient('desktop-test'))
    expect(composed.error).toBeNull()
    expect(composed.threadDrafts).toContainEqual(expect.objectContaining({ threadId: thread, text: 'Draft after restart' }))
    expect(launchers).toHaveLength(2)
    expect(scheduled).toEqual([])
    expect(fixture.manager.updateCandidates()[0]!.version).toBe(packageVersion)
  })
  it('takes the threads off the page once the host cannot be reached again, and says why on its row', async () => {
    const remote = await add()
    const thread = await remoteThread()
    fixture.updateHost = async () => { await fixture.host.close(); throw new SshFailure('update-failed') }
    failures.push(new SshFailure('archive-missing'))
    await expect(fixture.manager.restartForUpdate(remote.id, packageVersion)).rejects.toMatchObject({ code: 'update-failed' })
    expect(row(thread)).toBeUndefined()
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'error', error: 'The host installation was not found. Check its folder on the SSH host and reconnect.' })
  })
  it('carries on over the same connection when the host refuses the restart before stopping anything', async () => {
    const remote = await add()
    const thread = await remoteThread()
    fixture.updateHost = async () => ({ type: 'error', reason: 'update-stop-failed' })
    expect(await fixture.manager.restartForUpdate(remote.id, packageVersion)).toEqual({ type: 'error', reason: 'update-stop-failed' })
    expect(launchers).toHaveLength(1)
    expect(row(thread)).toMatchObject({ clientConnected: true })
    expect(row(thread)!.clientReconnecting).toBeUndefined()
    // The connection is still the host's: a later drop reconnects as any drop does.
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]!.phase).toBe('connected'))
    expect(launchers).toHaveLength(2)
  })
  it('reconnects a connection dropped while an update is under way, although the user\'s own commands on the host wait', async () => {
    const remote = await add()
    fixture.manager.useUpdates({ state: () => [], command: async () => undefined, subscribe: () => () => undefined,
      busy: id => id === remote.id ? 'Sotto is updating the host on Forge fixture. Nothing was changed. Wait for the update to finish, then try again.' : undefined })
    await expect(fixture.manager.command({ type: 'disconnect', id: remote.id })).rejects.toThrow('Sotto is updating the host on Forge fixture.')
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]!.phase).toBe('connected'))
    expect(launchers).toHaveLength(2)
  })
  it('refuses a restart for a host Sotto did not start', async () => {
    fixture.owned = false
    const remote = await add()
    await expect(fixture.manager.restartForUpdate(remote.id, packageVersion)).rejects.toThrow('Sotto did not start the host on Forge fixture')
    expect(fixture.manager.get().hosts[0]!.phase).toBe('connected')
  })
})
