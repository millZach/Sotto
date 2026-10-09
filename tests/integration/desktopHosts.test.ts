// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { version as packageVersion } from '../../package.json'
import { REMOTE_PERMISSION_DENIED } from '../../src/main/agents/authority'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { reconnectDelayMs } from '../../src/main/hosts/desktopHosts'
import { HostPhones } from '../../src/main/hosts/hostPhones'
import { SshFailure } from '../../src/main/hosts/sshLauncher'
import { AtomicJsonStore } from '../../src/main/storage/atomicJsonStore'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import { HOST_BUSY, hostVersionMismatch } from '../../src/shared/hostProtocol'
import type { RemoteHost } from '../../src/shared/hosts'
import { useDesktopHostFixture } from '../fixtures/desktopHostFixture'
import { ensureFixtureDesktopAnswers } from '../fixtures/sshDesktopAnswers'

const fixture = useDesktopHostFixture()

const { FIXTURE_NODE, add, connection, failures, launchers, liveSocket, pause, relaunch, remoteThread, row, savedFile, scheduled, stops } = fixture

describe('phones on a remote host (ADR-0050)', () => {
  it('reads a connected host’s phone access through its tunnel, and turns it on there from the Phones dialog', async () => {
    fixture.hostTailscaleRunning = true
    const phones = new HostPhones({ hosts: { links: () => fixture.manager.phonesLinks(), subscribe: listener => fixture.manager.subscribe(() => listener()) }, openExternal: async () => undefined })
    fixture.manager.usePhones(phones)
    try {
      const remote = await add()
      await vi.waitFor(() => expect(fixture.manager.get().phones).toMatchObject([{ id: remote.id, state: { enabled: false, phase: 'off' } }]))
      await fixture.manager.command({ type: 'host-phones', id: remote.id, command: { type: 'set-enabled', enabled: true } })
      // The open dialog's reads every couple of seconds are what show the host finishing its setup.
      await fixture.manager.command({ type: 'watch-host-phones', id: remote.id, watching: true })
      await vi.waitFor(() => expect(fixture.manager.get().phones?.[0]?.state).toMatchObject({ enabled: true, phase: 'on', address: 'https://forge.tail5728ca.ts.net:8443' }), { timeout: 20_000 })
      expect(fixture.hostTailscale.proxied()).toBeDefined()
      await expect(fixture.manager.command({ type: 'host-phones', id: randomUUID(), command: { type: 'retry' } })).rejects.toThrow('no longer saved')
    } finally { phones.close() }
  })
})

describe('desktop remote host management over a real socket', () => {
  it('retries a socket that drops while the connected host identity is saved', async () => {
    const remote = await add()
    await fixture.manager.command({ type: 'set-enabled', id: remote.id, enabled: false })
    fixture.retryDelay = () => 60_000
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
      await fixture.manager.command({ type: 'set-enabled', id: remote.id, enabled: true })
      await vi.waitFor(() => expect(scheduled).toEqual([0]))
    } finally { opening.mockRestore(); saving.mockRestore() }
    expect(dropped).toBe(true)
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
    expect(scheduled).toEqual([0])
    expect(fixture.router.shell().connections).not.toContainEqual(expect.objectContaining({ hostId: fixture.reportedHostId, connected: true }))
  })

  it('refuses pairing before spending a code when secure storage is unavailable', async () => {
    const available = vi.spyOn(fixture.credentials, 'available').mockReturnValue(false)
    try { await add() } finally { available.mockRestore() }
    expect(fixture.host.pairing.list()).toHaveLength(0)
    expect(fixture.manager.get().adding).toMatchObject({ phase: 'error', error: expect.stringContaining('Secure credential storage is unavailable') })
  })

  it('revokes a fresh pairing when saving its credential fails', async () => {
    const saving = vi.spyOn(fixture.credentials, 'set').mockRejectedValueOnce(new Error('Fixture storage failure'))
    try { await add() } finally { saving.mockRestore() }
    expect(fixture.host.pairing.list()).toHaveLength(0)
    expect(await savedFile()).toEqual([])
    expect(fixture.manager.get().adding).toMatchObject({ phase: 'error' })
  })

  it('lets a new SSH desktop change permission modes immediately, leaves phone pairing unprivileged, and preserves revocation on reconnect', async () => {
    const remote = await add()
    const local = desktopWindowClient('desktop-test')
    await fixture.router.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } }, local)
    await fixture.router.command({ type: 'connect', provider: 'codex' }, local)
    const state = await fixture.router.command({ type: 'create-project', provider: 'codex', title: 'Remote', path: fixture.root, useExisting: true }, local)
    const project = state.host.projects.find(item => item.path === fixture.root)!
    const created = await fixture.router.command({ type: 'create-thread', projectId: project.id, modelId: state.host.models[0]!.id, title: 'Remote permissions', managed: false }, local)
    expect(created.error).toBeNull()
    const threadId = created.host.threads.find(item => item.title === 'Remote permissions')!.id
    for (const runtimeMode of ['full-access', 'auto', 'auto-accept-edits', 'approval-required'] as const) {
      const next = await fixture.router.command({ type: 'configure-thread', threadId, runtimeMode }, local)
      expect(next.error).toBeNull()
      expect(next.host.threads.find(item => item.id === threadId)?.runtimeMode).toBe(runtimeMode)
    }
    // A paired client's name supplies no authority, even when it claims to be a desktop.
    const url = 'http://127.0.0.1:' + fixture.host.descriptor!.port
    const paired = await SocketHostService.pair(url, fixture.host.pairing.issuePairingCode().code, 'Sotto desktop')
    const phone = new SocketHostService({ url, token: paired.token })
    try { expect((await phone.connect()).capabilities.mayAnswer).toBe(false) } finally { await phone.close() }
    const descriptor = JSON.parse(await readFile(join(fixture.root, 'remote', 'host-listener.json'), 'utf8')) as { adminToken: string }
    const response = await fetch(url + '/v1/admin/deny-answers', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: fixture.manager.get().hosts[0]!.clientId }) })
    expect(response.status).toBe(200)
    await fixture.manager.command({ type: 'disconnect', id: remote.id })
    await fixture.manager.command({ type: 'connect', id: remote.id })
    expect(fixture.manager.get().hosts[0]!.phase).toBe('connected')
    expect((await fixture.router.command({ type: 'configure-thread', threadId, runtimeMode: 'full-access' }, local)).error).toBe(REMOTE_PERMISSION_DENIED)
  })

  it('repairs an existing desktop pairing with no policy on the next connection', async () => {
    const remote = connection()
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Sotto desktop')
    await fixture.credentials.set('remote-host:' + remote.id, paired.token)
    // A saved connection can omit the client ID; setup must use the host's authenticated hello.
    await relaunch([{ ...remote, hostId: fixture.reportedHostId }])
    await expect.poll(() => fixture.manager.get().hosts[0]!.phase).toBe('connected')
    const probe = new SocketHostService({ url: 'http://127.0.0.1:' + fixture.host.descriptor!.port, token: paired.token })
    try { expect((await probe.connect()).capabilities.mayAnswer).toBe(true) } finally { await probe.close() }
    expect(fixture.host.pairing.list()).toHaveLength(1)
  })

  it('records a desktop that may already answer as a desktop on its next SSH connect, so the host’s tailnet listener knows it (ADR-0053)', async () => {
    const remote = connection()
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Sotto desktop')
    await fixture.credentials.set('remote-host:' + remote.id, paired.token)
    // Granted before this build, so its grant is there and no record of desktops is.
    await ensureFixtureDesktopAnswers(join(fixture.root, 'remote'), fixture.reportedHostId, paired.clientId)
    await rm(join(fixture.root, 'remote', 'desktop-clients.json'))
    const probe = new SocketHostService({ url: 'http://127.0.0.1:' + fixture.host.descriptor!.port, token: paired.token })
    try { expect((await probe.connect()).capabilities.mayAnswer).toBe(true) } finally { await probe.close() }
    await relaunch([{ ...remote, hostId: fixture.reportedHostId, clientId: paired.clientId }])
    await expect.poll(() => fixture.manager.get().hosts[0]!.phase).toBe('connected')
    expect(JSON.parse(await readFile(join(fixture.root, 'remote', 'desktop-clients.json'), 'utf8'))).toEqual([paired.clientId])
  })

  it('keeps the connection of a desktop that may already answer when recording it as a desktop fails, and retries nothing', async () => {
    const remote = connection()
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Sotto desktop')
    await fixture.credentials.set('remote-host:' + remote.id, paired.token)
    await ensureFixtureDesktopAnswers(join(fixture.root, 'remote'), fixture.reportedHostId, paired.clientId)
    // The step that used to be skipped for this desktop fails the way a failed SSH request does, which would be final.
    fixture.desktopAnswersFailure = new SshFailure('permission-setup-failed')
    await relaunch([{ ...remote, hostId: fixture.reportedHostId, clientId: paired.clientId }])
    await expect.poll(() => fixture.manager.get().hosts[0]!.phase).toBe('connected')
    expect(scheduled).toEqual([])
  })

  it('still fails the connect of a desktop that cannot answer yet when its grant cannot be written', async () => {
    const remote = connection()
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Sotto desktop')
    await fixture.credentials.set('remote-host:' + remote.id, paired.token)
    fixture.desktopAnswersFailure = new SshFailure('permission-setup-failed')
    await relaunch([{ ...remote, hostId: fixture.reportedHostId, clientId: paired.clientId }])
    await expect.poll(() => fixture.manager.get().hosts[0]!.phase).toBe('error')
    expect(scheduled).toEqual([])
  })

  it('saves, pairs itself, selects, sends only to the remote host and revokes on Forget', async () => {
    const remote = await add()
    expect(fixture.manager.get().hosts[0]!.phase).toBe('connected')
    await fixture.manager.command({ type: 'select', hostId: fixture.reportedHostId })
    const client = desktopWindowClient('desktop-test')
    await fixture.router.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } }, client)
    await fixture.router.command({ type: 'connect', provider: 'codex' }, client)
    const state = await fixture.router.command({ type: 'create-project', provider: 'codex', title: 'Remote', path: fixture.root, useExisting: true }, client)
    const project = state.host.projects.find(project => project.path === fixture.root)!
    const model = state.host.models[0]!
    const threadId = randomUUID()
    await fixture.router.command({ type: 'create-thread', projectId: project.id, threadId, title: 'Remote task', modelId: model.id, managed: false, workingCopy: 'shared' }, client)
    const qualified = hostEntityKey(fixture.reportedHostId, threadId)
    await fixture.router.command({ type: 'observe-threads', threadIds: [qualified] }, client)
    await fixture.router.command({ type: 'manual-send', threadId: qualified, draftId: randomUUID(), text: 'Synthetic remote prompt' }, client)
    await expect.poll(() => fixture.host.service.threadDetail(threadId)?.messages.some(message => message.text === 'Synthetic remote prompt')).toBe(true)
    const token = fixture.credentials.get('remote-host:' + remote.id)
    expect(token).not.toBe('')
    expect(await readFile(join(fixture.root, 'desktop', 'remote-hosts.json'), 'utf8')).not.toContain(token)
    expect(await readFile(join(fixture.root, 'desktop', 'credentials.json'), 'utf8')).not.toContain(token)
    expect(fixture.host.pairing.verifyToken(token)).toBeDefined()
    await fixture.manager.command({ type: 'forget', id: remote.id })
    expect(fixture.host.pairing.verifyToken(token)).toBeUndefined(); expect(fixture.credentials.has('remote-host:' + remote.id)).toBe(false)
    expect(stops).toEqual([fixture.reportedHostId])
    expect(fixture.manager.get().hosts).toEqual([]); expect(fixture.router.shell().host.threads).toEqual([])
    await expect(readFile(join(fixture.root, 'desktop', 'workspace.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('leaves a host Sotto started running on Disconnect and stops it only on Stop host', async () => {
    const remote = await add()
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected', owned: true })
    await fixture.manager.command({ type: 'disconnect', id: remote.id })
    expect(stops).toEqual([])
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'disconnected' })
    expect(fixture.manager.get().hosts[0]!.owned).toBeUndefined()
    await expect(fixture.manager.command({ type: 'stop-host', id: remote.id })).rejects.toThrow('Connect to Forge fixture before stopping its host.')
    await fixture.manager.command({ type: 'connect', id: remote.id })
    await fixture.manager.command({ type: 'stop-host', id: remote.id })
    expect(stops).toEqual([fixture.reportedHostId])
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'disconnected' })
    expect(fixture.router.shell().connections).toEqual([])
  })
  it('does not reconnect while a stop slower than the retry delay closes the host under it', async () => {
    const remote = await add()
    fixture.beforeStopReply = async () => { await fixture.host.close(); await pause(150) }
    await fixture.manager.command({ type: 'stop-host', id: remote.id })
    // The drop arrived while the stop was pending. No retry was ever scheduled, so none can fire later.
    expect(scheduled).toEqual([])
    expect(stops).toEqual([fixture.reportedHostId])
    expect(launchers).toHaveLength(1)
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'disconnected' })
    expect(fixture.manager.get().hosts[0]!.reconnecting).toBeUndefined()
  })
  it('forgets over a revoke that closes the socket, stops the host and never pairs again', async () => {
    const remote = await add()
    const token = fixture.credentials.get('remote-host:' + remote.id)
    fixture.beforeStopReply = () => pause(150)
    await fixture.manager.command({ type: 'forget', id: remote.id })
    // The revoke dropped the socket before the stop replied, and no retry was scheduled to pair again.
    expect(scheduled).toEqual([])
    expect(fixture.host.pairing.verifyToken(token)).toBeUndefined()
    expect(stops).toEqual([fixture.reportedHostId])
    expect(fixture.manager.get().hosts).toEqual([]); expect(fixture.credentials.has('remote-host:' + remote.id)).toBe(false)
    expect(launchers).toHaveLength(1)
    expect(fixture.host.pairing.list()).toEqual([])
  })
  it('never stops a host it discovered and says so', async () => {
    fixture.owned = false
    const remote = await add()
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected', owned: false })
    await expect(fixture.manager.command({ type: 'stop-host', id: remote.id })).rejects.toThrow('Sotto did not start the host on Forge fixture')
    expect(stops).toEqual([])
    expect(fixture.manager.get().hosts[0]!.phase).toBe('connected')
    await fixture.manager.command({ type: 'forget', id: remote.id })
    expect(stops).toEqual([]); expect(fixture.manager.get().hosts).toEqual([])
  })
  it('keeps the saved host when an owned host could not be stopped and says it may still run', async () => {
    fixture.stopResult = false
    const remote = await add()
    await expect(fixture.manager.command({ type: 'stop-host', id: remote.id })).rejects.toThrow('may still be running')
    expect(fixture.manager.get().hosts[0]!.phase).toBe('disconnected')
    fixture.stopResult = new Error('launch script gone')
    await fixture.manager.command({ type: 'connect', id: remote.id })
    await expect(fixture.manager.command({ type: 'forget', id: remote.id })).rejects.toThrow('may still be running')
    expect(fixture.manager.get().hosts).toHaveLength(1)
    expect(fixture.manager.get().hosts[0]!.phase).toBe('disconnected')
  })
  it('forgets a host it cannot reach, keeps nothing of it here, and says the host still trusts this computer and how to revoke it there', async () => {
    const remote = await add()
    const token = fixture.credentials.get('remote-host:' + remote.id)
    const clientId = fixture.manager.get().hosts[0]!.clientId!
    await fixture.manager.command({ type: 'disconnect', id: remote.id })
    failures.push(new SshFailure('ssh-unreachable'))
    const state = await fixture.manager.command({ type: 'forget', id: remote.id })
    expect(state.hosts).toEqual([]); expect(fixture.credentials.has('remote-host:' + remote.id)).toBe(false)
    expect(await savedFile()).toEqual([])
    expect(fixture.host.pairing.verifyToken(token)).toBeDefined()
    expect(stops).toEqual([])
    // The command resolves `current` on the host and runs the Node and folders this computer last saw.
    expect(state.forgotten).toEqual([{ id: remote.id, name: 'Forge fixture', revoke: { cause: 'unreachable', command: 'I="/opt/sotto"; E="$I/host/index.js"; [ -f "$I/current" ] && V=$(cat "$I/current") && [ -f "$I/versions/$V/host/index.js" ] && E="$I/versions/$V/host/index.js"; '
      + `"${FIXTURE_NODE}" "$E" --data "/data/sotto" --revoke-client "${clientId}"` } }])
    // Dismiss puts it away; a dismiss for another host changes nothing.
    expect((await fixture.manager.command({ type: 'dismiss-forgotten', id: randomUUID() })).forgotten).toBeDefined()
    expect((await fixture.manager.command({ type: 'dismiss-forgotten', id: remote.id })).forgotten).toBeUndefined()
  })
  it('refuses changed host identity before sending the saved pairing credential', async () => {
    const remote = await add()
    await fixture.manager.command({ type: 'disconnect', id: remote.id })
    fixture.reportedHostId = randomUUID()
    await fixture.manager.command({ type: 'connect', id: remote.id })
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'error', error: expect.stringContaining('identity changed') })
    expect(fixture.router.shell().connections).toEqual([])
  })
  it('keeps the verified SSH route and pairs again by itself after the saved token is revoked', async () => {
    const remote = await add()
    const token = fixture.credentials.get('remote-host:' + remote.id)
    const clientId = fixture.host.pairing.verifyToken(token)!
    await fixture.manager.command({ type: 'disconnect', id: remote.id })
    await fixture.host.pairing.revoke(clientId)
    await fixture.manager.command({ type: 'connect', id: remote.id })
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected', clientId: expect.any(String) })
    expect(fixture.host.pairing.verifyToken(fixture.credentials.get('remote-host:' + remote.id))).not.toBe(clientId)
  })
  it('refuses to add a host already saved, under the same route or another, and leaves the saved one connected', async () => {
    const first = await add()
    await expect(add()).rejects.toThrow('forge is already saved as Forge fixture. Nothing was saved.')
    const second = connection('forge-again')
    await fixture.manager.command({ type: 'add', host: second })
    expect(fixture.manager.get().adding).toMatchObject({ id: second.id, phase: 'error', error: expect.stringContaining('This is the same host as Forge fixture') })
    expect(fixture.manager.get().adding!.error).toContain('Nothing was saved.')
    expect(fixture.manager.get().hosts.map(host => host.id)).toEqual([first.id])
    expect(fixture.credentials.has('remote-host:' + second.id)).toBe(false)
    await fixture.manager.command({ type: 'cancel-add', id: second.id })
    expect(fixture.manager.get().adding).toBeUndefined()
    expect(fixture.router.shell().connections).toEqual([expect.objectContaining({ hostId: fixture.reportedHostId })])
    expect(fixture.manager.get().hosts[0]!.phase).toBe('connected')
  })
  it('reconnects a dropped established connection and resets the attempt count on success', async () => {
    await add()
    expect(fixture.manager.get().hosts[0]!.phase).toBe('connected')
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]!.phase).toBe('connected'))
    expect(launchers.length).toBe(2)
    expect(fixture.manager.get().hosts[0]!.reconnecting).toBe(false)
    launchers[1]!.callbacks!.onDisconnected!('dropped again')
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]!.phase).toBe('connected'))
    expect(launchers.length).toBe(3)
  })
  it.each([
    ['archive-missing', 'installation was not found'],
    ['ssh-too-old', "This computer's OpenSSH is too old"],
  ] as const)('stops retrying when a reconnect fails with an error only the user can fix: %s', async (code, message) => {
    await add()
    failures.push(new SshFailure(code))
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'error', reconnecting: false, error: expect.stringContaining(message) }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(launchers.length).toBe(2)
  })
  it('clears a retry left by a failed reconnect when Sotto quits, so no SSH session starts during the drain', async () => {
    const remote = await add()
    fixture.retryDelay = attempt => attempt === 0 ? 0 : 60_000
    failures.push(new SshFailure('ssh-unreachable'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      launchers[0]!.callbacks!.onDisconnected!('dropped')
      // The first retry fails, leaving a second one pending for a host that is no longer live.
      await vi.waitFor(() => expect(scheduled).toEqual([0, 1]))
      expect(launchers).toHaveLength(2)
      expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
      await fixture.manager.close()
      // Running every pending timer would fire the retry if close() had left it.
      vi.runOnlyPendingTimers()
      await fixture.manager.command({ type: 'connect', id: remote.id })
      expect(launchers).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })
  it('decides on the failure code, so rewording a message changes no retry decision', async () => {
    await add()
    // Words that once meant "stop retrying", on a failure a retry can fix: it is retried.
    failures.push(new SshFailure('ssh-unreachable', 'The host installation was not found, the host key changed and the identity changed.'))
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]!.phase).toBe('connected'))
    expect(launchers).toHaveLength(3)
    // Words that say nothing, on a failure only the user can fix: it stops.
    failures.push(new SshFailure('node-too-old', 'Something is not right.'))
    launchers[2]!.callbacks!.onDisconnected!('dropped')
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'error', reconnecting: false, error: 'Something is not right.' }))
    expect(launchers).toHaveLength(4)
    expect(scheduled).toEqual([0, 1, 0])
  })
  it('backs off 3, 4, 8 and then 16 seconds between reconnects, and keeps retrying', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(reconnectDelayMs)).toEqual([3_000, 4_000, 8_000, 16_000, 16_000, 16_000, 16_000])
  })
  it('opens and reconnects without downloading the host’s event log, and still reads the current shell', async () => {
    const client = desktopWindowClient('desktop-test')
    await fixture.host.service.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } }, client)
    await fixture.host.service.command({ type: 'connect', provider: 'codex' }, client)
    const state = await fixture.host.service.command({ type: 'create-project', provider: 'codex', title: 'Logged', path: fixture.root, useExisting: true }, client)
    const project = state.host.projects.find(project => project.path === fixture.root)!
    const threadId = randomUUID()
    await fixture.host.service.command({ type: 'create-thread', projectId: project.id, threadId, title: 'Logged task', modelId: state.host.models[0]!.id, managed: false, workingCopy: 'shared' }, client)
    await fixture.host.service.command({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic logged prompt' }, client)
    await expect.poll(() => fixture.host.service.events(0).length).toBeGreaterThan(0)
    const connect = vi.spyOn(SocketHostService.prototype, 'connect'), readEvents = vi.spyOn(SocketHostService.prototype, 'readEvents')
    try {
      const remote = await add()
      // The host sent none of the log in the hello, and a routed command reads none after it.
      // Each tailnet try answers nothing here, so only the hellos that arrived are the SSH connection's.
      const hello = async (index: number) => (await Promise.allSettled(connect.mock.results.map(result => result.value as ReturnType<SocketHostService['connect']>)))
        .flatMap(result => result.status === 'fulfilled' ? [result.value] : [])[index]
      expect(await hello(0)).toMatchObject({ events: [], latestSeq: Number.MAX_SAFE_INTEGER, hasMore: false })
      await fixture.router.command({ type: 'configure', patch: { enabled: false } }, client)
      await fixture.manager.command({ type: 'disconnect', id: remote.id })
      await fixture.host.service.command({ type: 'configure', patch: { enabled: true } }, client)
      await fixture.manager.command({ type: 'connect', id: remote.id })
      expect(fixture.manager.get().hosts[0]!.phase).toBe('connected')
      expect(fixture.router.shell().configuration.enabled).toBe(true)
      expect(fixture.router.shell().host.threads.map(thread => thread.id)).toContain(hostEntityKey(fixture.reportedHostId, threadId))
      expect(await hello(1)).toMatchObject({ events: [], latestSeq: Number.MAX_SAFE_INTEGER, hasMore: false })
      expect(readEvents).not.toHaveBeenCalled()
    } finally { connect.mockRestore(); readEvents.mockRestore() }
  })
  it('says the host is busy when this computer’s session budget is spent, and keeps retrying instead of pairing again', async () => {
    const remote = await add()
    const token = fixture.credentials.get('remote-host:' + remote.id)
    // Spend this client's session budget for the minute, the way a loop on its token would.
    const session = () => fetch('http://127.0.0.1:' + fixture.host.descriptor!.port + '/v1/session', { method: 'POST', headers: { Authorization: 'Bearer ' + token } })
    let response = await session()
    for (let index = 0; response.status === 200 && index < 200; index++) response = await session()
    expect(response.status).toBe(429)
    fixture.retryDelay = attempt => attempt === 0 ? 0 : 60_000
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    // The busy reconnect is not final: a second retry is scheduled after it.
    await vi.waitFor(() => expect(scheduled).toEqual([0, 1]))
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
    await fixture.manager.command({ type: 'disconnect', id: remote.id })
    await fixture.manager.command({ type: 'connect', id: remote.id })
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'error', error: HOST_BUSY })
    expect(fixture.credentials.get('remote-host:' + remote.id)).toBe(token)
    expect(fixture.host.pairing.list()).toHaveLength(1)
  })
  it('keeps retrying when pairing again meets a busy host, instead of calling it a failed pairing', async () => {
    const remote = await add()
    await fixture.host.pairing.revoke(fixture.host.pairing.verifyToken(fixture.credentials.get('remote-host:' + remote.id))!)
    const fetchOriginal = globalThis.fetch
    const pairingResponse = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).endsWith('/v1/pair')) return Promise.resolve(new Response(JSON.stringify({ v: 1, error: { code: 'busy', message: HOST_BUSY } }), { status: 429 }))
      return fetchOriginal(input, init)
    })
    try {
      fixture.retryDelay = attempt => attempt === 0 ? 0 : 60_000
      launchers[0]!.callbacks!.onDisconnected!('dropped')
      // The session is refused, pairing again is refused as busy, and a second retry is scheduled after it.
      await vi.waitFor(() => expect(scheduled).toEqual([0, 1]))
      expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
      await fixture.manager.command({ type: 'disconnect', id: remote.id })
      await fixture.manager.command({ type: 'connect', id: remote.id })
      expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'error', error: HOST_BUSY })
    } finally { pairingResponse.mockRestore() }
  })
  it('cancels a pending retry when the user disconnects', async () => {
    const remote = await add()
    fixture.retryDelay = () => 50
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
    await fixture.manager.command({ type: 'disconnect', id: remote.id })
    expect(fixture.manager.get().hosts[0]!.phase).toBe('disconnected')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(launchers.length).toBe(1)
  })
})

describe('a host from before protocol v1 froze', () => {
  let old: Server | undefined
  afterEach(async () => { await new Promise<void>(resolve => old ? old.close(() => resolve()) : resolve()); old = undefined })
  /** The tunnel reaches a host that answers health the way 0.1.15 did: protocol 1, with no Sotto version or features. */
  async function connectToOldHost(): Promise<RemoteHost> {
    old = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ v: 1, status: 'ready', hostId: fixture.reportedHostId, pid: 4242, port: 4319 })) })
    await new Promise<void>(resolve => old!.listen(0, '127.0.0.1', resolve))
    const address = old.address()
    if (!address || typeof address === 'string') throw new Error('No loopback port.')
    fixture.tunnelUrl = () => 'http://127.0.0.1:' + address.port
    // Saved and paired by an earlier Sotto, and switched off, so the only thing the old host is asked is its health.
    const remote: RemoteHost = { ...connection(), enabled: false }
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Sotto desktop')
    await fixture.credentials.set(`remote-host:${remote.id}`, paired.token)
    await relaunch([{ ...remote, hostId: fixture.reportedHostId, clientId: paired.clientId }])
    await fixture.manager.command({ type: 'connect', id: remote.id })
    return remote
  }
  it('says to install this version, stop the host and connect again, keeps Stop host for a host Sotto started, and does not retry', async () => {
    const remote = await connectToOldHost()
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'error', owned: true, error: hostVersionMismatch(packageVersion, undefined, true) })
    expect(fixture.manager.get().hosts[0]!.error).toContain('press Stop host, then connect again.')
    expect(scheduled).toEqual([])
    await fixture.manager.command({ type: 'stop-host', id: remote.id })
    expect(stops).toEqual([fixture.reportedHostId])
    expect(fixture.manager.get().hosts[0]!.phase).toBe('disconnected')
  })
  it('stops a host Sotto started when it is forgotten while its session is kept for Stop host', async () => {
    const remote = await connectToOldHost()
    await fixture.manager.command({ type: 'forget', id: remote.id })
    expect(stops).toEqual([fixture.reportedHostId])
    expect(fixture.manager.get().hosts).toEqual([])
  })
  it('lets Edit connection change the installation folder while the session is kept for Stop host, and offers Stop host again on the next connect', async () => {
    const remote = await connectToOldHost()
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'error', owned: true })
    await fixture.manager.command({ type: 'save', host: { ...connection(), id: remote.id, installPath: '/opt/sotto-new' } })
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'disconnected', installPath: '/opt/sotto-new', enabled: false, name: 'Forge fixture' })
    expect(fixture.manager.get().hosts[0]!.owned).toBeUndefined()
    await fixture.manager.command({ type: 'connect', id: remote.id })
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'error', owned: true })
  })
  it('sends the user to the host machine for a host Sotto did not start', async () => {
    fixture.owned = false
    await connectToOldHost()
    expect(fixture.manager.get().hosts[0]!.phase).toBe('error')
    expect(fixture.manager.get().hosts[0]!.owned).toBeUndefined()
    expect(fixture.manager.get().hosts[0]!.error).toBe(hostVersionMismatch(packageVersion, undefined, false))
    expect(scheduled).toEqual([])
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
    fixture.retryDelay = () => 60_000
    await liveSocket(remote.id).close()
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
    expect(row(thread)).toMatchObject({ clientReconnecting: true })
    expect(fixture.router.shell().activeThreadId).toBe(thread)
    // The retry, pressed rather than waited for: the new connection takes the same place.
    await fixture.manager.command({ type: 'connect', id: remote.id })
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected', reconnecting: false })
    expect(row(thread)).toMatchObject({ id: thread, clientConnected: true })
    expect(row(thread)!.clientReconnecting).toBeUndefined()
    expect(fixture.router.shell().activeThreadId).toBe(thread)
    expect(fixture.router.shell().connections).toEqual([expect.objectContaining({ hostId: fixture.reportedHostId, connected: true })])
  })

  it('takes the threads away when the reconnect meets a failure only the user can fix', async () => {
    await add()
    const thread = await remoteThread()
    failures.push(new SshFailure('host-key-changed'))
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'error', reconnecting: false }), { timeout: 20_000 })
    expect(row(thread)).toBeUndefined()
    expect(fixture.router.shell().connections).toEqual([])
  })

  it('takes the threads away when the user disconnects while it reconnects', async () => {
    const remote = await add()
    const thread = await remoteThread()
    fixture.retryDelay = () => 60_000
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    expect(row(thread)).toBeDefined()
    await fixture.manager.command({ type: 'disconnect', id: remote.id })
    expect(row(thread)).toBeUndefined()
  })
})
