// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { SshFailure } from '../../src/main/hosts/sshLauncher'
import type { BootStatus } from '../../src/shared/bootStart'
import { useDesktopHostFixture } from '../fixtures/desktopHostFixture'

const fixture = useDesktopHostFixture()

const { add, boots, launchers, operations, remoteThread, scheduled, stops } = fixture

describe('start at boot (ADR-0054)', () => {
  const on: BootStatus = { supported: true, installed: true, enabled: true, active: true, linger: true, nodeDrift: false }
  const off: BootStatus = { supported: true, installed: false, enabled: false, active: false, linger: true, nodeDrift: false }
  const row = (id: string) => fixture.router.shell().host.threads.find(thread => thread.id === id)

  it('shows start at boot as the launch found it, and keeps the threads through the restart installing it causes', async () => {
    fixture.bootStart = off
    const remote = await add()
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected', bootStart: off })
    const thread = await remoteThread()
    fixture.boot = async () => {
      // The unit takes the host over: the host Sotto started stops, which drops this computer's socket, and the unit starts it.
      await fixture.host.close()
      await vi.waitFor(() => expect(row(thread)).toMatchObject({ clientConnected: false, clientReconnecting: true }))
      fixture.host = await startHeadlessHost({ dataDirectory: join(fixture.root, 'remote'), port: 0, providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner })
      fixture.bootStart = on
      return { type: 'boot-installed', installed: true, stopped: true, pid: process.pid, bootStart: on }
    }
    expect(await fixture.manager.setBootStart(remote.id, 'install')).toMatchObject({ type: 'boot-installed', stopped: true })
    expect(boots).toEqual([{ op: 'boot-install' }])
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected', bootStart: on })
    expect(row(thread)).toMatchObject({ id: thread })
    expect(row(thread)!.clientReconnecting).toBeUndefined()
    expect(launchers).toHaveLength(2)
    expect(scheduled).toEqual([])
  })

  it('carries on over the same connection when nothing was stopped, as when linger needs an administrator', async () => {
    fixture.bootStart = off
    const remote = await add()
    const refused: BootStatus = { ...off, linger: false, fix: 'sudo loginctl enable-linger user' }
    fixture.boot = async () => ({ type: 'boot-installed', installed: false, stopped: false, bootStart: refused })
    expect(await fixture.manager.setBootStart(remote.id, 'install')).toMatchObject({ installed: false })
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected', bootStart: refused })
    expect(launchers).toHaveLength(1)
  })

  it('asks the host to start again after removing the unit only while the saved host is switched on', async () => {
    fixture.bootStart = on
    const remote = await add()
    fixture.boot = async () => ({ type: 'boot-removed', stopped: false, bootStart: off })
    await fixture.manager.setBootStart(remote.id, 'remove')
    expect(boots).toEqual([{ op: 'boot-remove', restart: true }])
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected', bootStart: off })
    // A host that is switched off has no connection to send it over, and nothing is started for it.
    await fixture.manager.command({ type: 'set-enabled', id: remote.id, enabled: false })
    await expect(fixture.manager.setBootStart(remote.id, 'remove')).rejects.toThrow('Connect to Forge fixture before changing whether its host starts at boot. Nothing was changed.')
    expect(boots).toHaveLength(1)
    expect(launchers).toHaveLength(1)
  })

  it('removes the unit on Forget after the revoke and before the stop, and starts nothing', async () => {
    fixture.bootStart = on
    const remote = await add()
    const token = fixture.credentials.get('remote-host:' + remote.id)
    fixture.boot = async () => {
      expect(fixture.host.pairing.verifyToken(token)).toBeUndefined()
      expect(stops).toEqual([])
      return { type: 'boot-removed', stopped: true, bootStart: off }
    }
    await fixture.manager.command({ type: 'forget', id: remote.id })
    expect(boots).toEqual([{ op: 'boot-remove', restart: false }])
    expect(stops).toEqual([fixture.reportedHostId])
    expect(operations).toEqual(['ssh revoke-client', 'ssh boot-remove', 'ssh stop-host'])
    expect(fixture.manager.get().hosts).toEqual([])
  })

  it('asks nothing about a unit on Forget when the host has none', async () => {
    fixture.bootStart = off
    const remote = await add()
    await fixture.manager.command({ type: 'forget', id: remote.id })
    expect(boots).toEqual([])
  })

  it('says Forget left the unit behind when the host would not remove it, with the line that does, though the revoke went through', async () => {
    fixture.bootStart = on
    const remote = await add()
    fixture.boot = async () => ({ type: 'error', reason: 'boot-remove-failed' })
    await fixture.manager.command({ type: 'forget', id: remote.id })
    expect(fixture.manager.get().hosts).toEqual([])
    const [notice] = fixture.manager.get().forgotten ?? []
    expect(notice).toEqual({ id: remote.id, name: 'Forge fixture', bootCommand: expect.stringContaining('systemctl --user disable --now sotto-host') as unknown })
    expect(notice!.bootCommand).toContain('B="/opt/sotto/boot-start.sh"')
  })

  it('says a host that refused the revoke still has its unit, since Forget left it running as it was', async () => {
    fixture.bootStart = on
    const remote = await add()
    fixture.revokeFails = true
    await fixture.manager.command({ type: 'forget', id: remote.id })
    expect(boots).toEqual([])
    expect(fixture.manager.get().forgotten?.[0]).toMatchObject({ revoke: { cause: 'refused', command: expect.stringContaining('--revoke-client') as unknown }, bootCommand: expect.stringContaining('sotto-host') as unknown })
  })

  it('says the unit stays when the host stops answering partway through Forget', async () => {
    fixture.bootStart = on
    const remote = await add()
    // The revoke and the unit's removal both go unanswered, the way they do over a connection that has just died.
    fixture.revokeError = new SshFailure('admin-failed')
    fixture.boot = async () => { throw new SshFailure('boot-failed') }
    await fixture.manager.command({ type: 'forget', id: remote.id })
    expect(fixture.manager.get().hosts).toEqual([])
    expect(fixture.manager.get().forgotten?.[0]).toMatchObject({ revoke: { cause: 'unreachable' }, bootCommand: expect.stringContaining('sotto-host') as unknown })
  })

  it('says the unit stays when a stopped host’s launch could not take it away, though this computer did not know of it', async () => {
    const remote = await add()
    await fixture.manager.command({ type: 'disconnect', id: remote.id })
    fixture.hostRunning = false
    fixture.bootLeftOnStop = true
    await fixture.manager.command({ type: 'forget', id: remote.id })
    expect(launchers.at(-1)!.options).toEqual({ start: false, removeBoot: true })
    expect(fixture.manager.get().forgotten?.[0]).toMatchObject({ revoke: { cause: 'not-running' }, bootCommand: expect.stringContaining('sotto-host') as unknown })
  })

  it('says nothing of a unit when a stopped host’s launch took it away', async () => {
    fixture.bootStart = on
    const remote = await add()
    await fixture.manager.command({ type: 'disconnect', id: remote.id })
    fixture.hostRunning = false
    await fixture.manager.command({ type: 'forget', id: remote.id })
    expect(fixture.manager.get().forgotten?.[0]?.bootCommand).toBeUndefined()
  })

  it('offers the boot state of a connected host to a change, and none for a host whose launch did not say', async () => {
    const remote = await add()
    expect(fixture.manager.bootCandidate(remote.id)).toBeUndefined()
    await fixture.manager.command({ type: 'forget', id: remote.id })
    fixture.bootStart = off
    const again = await add()
    expect(fixture.manager.bootCandidate(again.id)).toMatchObject({ id: again.id, name: 'Forge fixture', hostId: fixture.reportedHostId, owned: true, bootStart: off, installPath: '/opt/sotto' })
    await fixture.manager.command({ type: 'set-enabled', id: again.id, enabled: false })
    expect(fixture.manager.bootCandidate(again.id)).toBeUndefined()
  })

  it('offers no start at boot change while Forget closes the host, so a change waiting for its threads does not start then', async () => {
    fixture.bootStart = off
    const remote = await add()
    expect(fixture.manager.bootCandidate(remote.id)).toBeDefined()
    const during: unknown[] = []
    fixture.beforeStopReply = async () => { during.push(fixture.manager.bootCandidate(remote.id)) }
    await fixture.manager.command({ type: 'forget', id: remote.id })
    expect(during).toEqual([undefined])
  })

  it('hands Start at boot to the start at boot changes, and keeps Stop host and Forget waiting while one runs', async () => {
    fixture.bootStart = off
    const remote = await add()
    const pressed: string[] = []
    const changing: { sentence?: string } = {}
    fixture.manager.useBoot({ state: () => [], subscribe: () => () => undefined, busy: () => changing.sentence,
      command: async (id, action) => { pressed.push(`${id} ${action}`) } })
    await fixture.manager.command({ type: 'host-boot', id: remote.id, action: 'install' })
    expect(pressed).toEqual([`${remote.id} install`])
    const busy = changing.sentence = 'Sotto is changing whether the host on Forge fixture starts at boot. Nothing was changed. Wait for it to finish, then try again.'
    await expect(fixture.manager.command({ type: 'stop-host', id: remote.id })).rejects.toThrow(busy)
    await expect(fixture.manager.command({ type: 'forget', id: remote.id })).rejects.toThrow(busy)
    expect(fixture.manager.get().hosts).toHaveLength(1)
  })

  it('keeps Update waiting while a start at boot change runs, and a start at boot press waiting while an update runs', async () => {
    fixture.bootStart = off
    const remote = await add()
    const pressed: string[] = []
    const changing: { boot?: string; update?: string } = {}
    fixture.manager.useBoot({ state: () => [], subscribe: () => () => undefined, busy: () => changing.boot, command: async (id, action) => { pressed.push(`boot ${action}`) } })
    fixture.manager.useUpdates({ state: () => [], subscribe: () => () => undefined, busy: () => changing.update, command: async (id, action) => { pressed.push(`update ${action}`) } })
    changing.boot = 'Sotto is changing whether the host on Forge fixture starts at boot. Nothing was changed. Wait for it to finish, then try again.'
    await expect(fixture.manager.command({ type: 'host-update', id: remote.id, action: 'update' })).rejects.toThrow(changing.boot)
    // Only Update waits: the update panel's other answers change nothing on the host.
    await fixture.manager.command({ type: 'host-update', id: remote.id, action: 'not-now' })
    delete changing.boot
    changing.update = 'Sotto is updating the host on Forge fixture. Nothing was changed. Wait for the update to finish, then try again.'
    await expect(fixture.manager.command({ type: 'host-boot', id: remote.id, action: 'install' })).rejects.toThrow(changing.update)
    await expect(fixture.manager.command({ type: 'host-boot', id: remote.id, action: 'remove' })).rejects.toThrow(changing.update)
    // An answer to the question, or a Dismiss, still goes through.
    await fixture.manager.command({ type: 'host-boot', id: remote.id, action: 'dismiss' })
    expect(pressed).toEqual(['update not-now', 'boot dismiss'])
  })

  it('keeps a start at boot change for a saved host that is switched on, and lets it go once the host is switched off', async () => {
    const remote = await add()
    expect(fixture.manager.bootKeeps(remote.id)).toBe(true)
    expect(fixture.manager.bootKeeps(randomUUID())).toBe(false)
    await fixture.manager.command({ type: 'set-enabled', id: remote.id, enabled: false })
    expect(fixture.manager.bootKeeps(remote.id)).toBe(false)
  })
})
