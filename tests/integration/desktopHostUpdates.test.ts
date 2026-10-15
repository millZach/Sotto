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
  it('updates a host to the version this computer is downloading, and keeps its threads usable while it runs ahead (ADR-0077)', async () => {
    const RUNNING = '0.1.38-owl.20261014.1', WAITING = '0.1.38-owl.20261014.2'
    const waiting: { version?: string } = {}
    await fixture.manager.close(); await fixture.host.close()
    fixture.host = await startHeadlessHost({ dataDirectory: join(fixture.root, 'remote'), port: 0, providers: providers(), reasoner: e2eAgentReasoner, sottoVersion: RUNNING })
    fixture.manager = newManager(undefined, { clientVersion: RUNNING, waitingClientVersion: () => waiting.version }); await fixture.manager.start()
    const remote = await add()
    const thread = await remoteThread()
    const file = `Sotto-host-${WAITING}-linux-x64.tar.gz`
    fixture.updateHost = async operation => {
      if (operation.op === 'update-fetch') return { type: 'update-fetched', file, sha256: 'a'.repeat(64) }
      if (operation.op === 'update-install') return { type: 'update-installed', version: WAITING }
      expect(operation).toEqual({ op: 'update-restart', version: WAITING })
      await fixture.host.close()
      fixture.host = await startHeadlessHost({ dataDirectory: join(fixture.root, 'remote'), port: 0, providers: providers(), reasoner: e2eAgentReasoner, sottoVersion: WAITING })
      return { type: 'ready', v: 1, status: 'ready', hostId: fixture.reportedHostId, pid: process.pid, port: fixture.host.descriptor!.port, owned: true }
    }
    const asked: string[] = []
    const updates = new HostUpdates({ version: RUNNING, releasesUrl: 'https://releases.example/download',
      probe: async url => { asked.push(url); return url.includes(`/v${WAITING}/Sotto-host-${WAITING}-linux-x64.tar.gz`) },
      threads: { working: () => [], interrupt: async () => undefined, subscribe: () => () => undefined },
      hosts: { candidates: () => fixture.manager.updateCandidates(), run: (id, operation, options) => fixture.manager.runUpdate(id, operation, options),
        restart: (id, version, options) => fixture.manager.restartForUpdate(id, version, options), subscribe: listener => fixture.manager.subscribe(() => listener()) } })
    // Nothing is behind this computer's own version; the update it is downloading brings the host's next one.
    expect(updates.state()).toEqual([])
    waiting.version = WAITING
    updates.pending(WAITING)
    await vi.waitFor(() => expect(updates.state()).toMatchObject([{ id: remote.id, from: RUNNING, to: WAITING, phase: 'needs' }]))
    await updates.command(remote.id, 'update')
    await vi.waitFor(() => expect(updates.state()).toMatchObject([{ phase: 'done', to: WAITING }]), { timeout: 30_000 })
    expect(asked).toEqual([`https://releases.example/download/v${WAITING}/${file}`, `https://releases.example/download/v${WAITING}/${file}.sha256`])
    // The host reconnected on the version it was updated to, ahead of this computer, and its thread works on it.
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected', version: WAITING })
    expect(fixture.manager.get().hosts[0]!.error).toBeUndefined()
    expect(row(thread)).toMatchObject({ id: thread, clientConnected: true })
    const composed = await fixture.router.command({ type: 'compose', text: 'Draft while the host runs ahead' }, desktopWindowClient('desktop-test'))
    expect(composed.error).toBeNull()
    expect(composed.threadDrafts).toContainEqual(expect.objectContaining({ threadId: thread, text: 'Draft while the host runs ahead' }))
    // A drop while it runs ahead, as Later leaves it until Sotto restarts, reconnects as any drop does.
    launchers.at(-1)!.callbacks!.onDisconnected!('dropped')
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected', version: WAITING }))
    await updates.command(remote.id, 'dismiss')
    expect(updates.state()).toEqual([])
    updates.dispose()
  })
  it('refuses a restart for a host Sotto did not start', async () => {
    fixture.owned = false
    const remote = await add()
    await expect(fixture.manager.restartForUpdate(remote.id, packageVersion)).rejects.toThrow('Sotto did not start the host on Forge fixture')
    expect(fixture.manager.get().hosts[0]!.phase).toBe('connected')
  })
})
