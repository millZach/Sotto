// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { SshFailure } from '../../src/main/hosts/sshLauncher'
import type { RemoteHost } from '../../src/shared/hosts'
import { useDesktopHostFixture } from '../fixtures/desktopHostFixture'

const fixture = useDesktopHostFixture()

const { add, answers, connection, failures, launchers, opened, relaunch, savedFile, scheduled, stops } = fixture

describe('Add host, the switch and reconnect on launch', () => {
  it('connects, pairs and only then saves the host, switched on, with the SSH user and port it was given', async () => {
    const remote = { ...connection('zach@forge'), sshPort: 2222 }
    const pending = fixture.manager.command({ type: 'add', host: remote })
    // Until the host answers, the host is Add host's alone: no row, nothing on disk.
    expect(fixture.manager.get().hosts).toEqual([])
    expect(fixture.manager.get().adding).toMatchObject({ id: remote.id, phase: 'connecting' })
    const state = await pending
    expect(state.adding).toBeUndefined()
    expect(state.hosts).toEqual([expect.objectContaining({ id: remote.id, phase: 'connected', enabled: true, target: 'zach@forge', sshPort: 2222 })])
    expect(launchers[0]!.configuration).toMatchObject({ target: 'zach@forge', sshPort: 2222 })
    const [saved] = await savedFile() as Record<string, unknown>[]
    expect(saved).toMatchObject({ id: remote.id, target: 'zach@forge', sshPort: 2222, hostId: fixture.reportedHostId })
    // On is the default, so a saved host carries no flag until it is switched off.
    expect(saved).not.toHaveProperty('enabled')
    expect(fixture.credentials.has('remote-host:' + remote.id)).toBe(true)
  })
  it('saves nothing and keeps no credential when the host cannot be reached, and says so in the dialog', async () => {
    failures.push(new SshFailure('ssh-unreachable'))
    const remote = connection()
    await fixture.manager.command({ type: 'add', host: remote })
    expect(fixture.manager.get().hosts).toEqual([])
    expect(fixture.manager.get().adding).toMatchObject({ id: remote.id, phase: 'error', error: 'SSH could not reach the host. Nothing was saved. Check the host name and your network, then add the host again.' })
    expect(await savedFile()).toEqual([])
    expect(fixture.credentials.has('remote-host:' + remote.id)).toBe(false)
    // A failed add is not retried, since nothing asked for this host to stay connected.
    expect(scheduled).toEqual([])
    // Adding again replaces the failed attempt.
    await fixture.manager.command({ type: 'add', host: { ...remote, id: randomUUID() } })
    expect(fixture.manager.get().adding).toBeUndefined()
    expect(fixture.manager.get().hosts).toHaveLength(1)
  })
  it('revokes the pairing and keeps no credential when the host fails after pairing', async () => {
    // Pairing succeeds, and then the host refuses the session.
    const remote = connection()
    const refuse = vi.spyOn(SocketHostService.prototype, 'connect').mockRejectedValueOnce(new Error('The host closed the connection. Try again.'))
    try { await fixture.manager.command({ type: 'add', host: remote }) } finally { refuse.mockRestore() }
    expect(fixture.manager.get().hosts).toEqual([])
    // Past the tunnel, a failure is the pairing's.
    expect(fixture.manager.get().adding).toMatchObject({ phase: 'error', step: 'pair', error: expect.stringContaining('Nothing was saved.') })
    expect(fixture.credentials.has('remote-host:' + remote.id)).toBe(false)
    expect(fixture.host.pairing.list()).toEqual([])
  })
  for (const ending of ['Cancel', 'quitting Sotto'] as const) {
    it(`revokes the pairing and keeps no credential when ${ending} ends an add after pairing`, async () => {
      const remote = connection()
      // Pairing succeeds, and the session is still opening when the add is ended.
      let refuse: ((error: Error) => void) | undefined
      const opening = vi.spyOn(SocketHostService.prototype, 'connect').mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject }))
      try {
        const pending = fixture.manager.command({ type: 'add', host: remote })
        await vi.waitFor(() => expect(refuse).toBeTypeOf('function'))
        expect(fixture.credentials.has('remote-host:' + remote.id)).toBe(true)
        expect(fixture.host.pairing.list()).toHaveLength(1)
        const ended = ending === 'Cancel' ? fixture.manager.command({ type: 'cancel-add', id: remote.id }) : fixture.manager.close()
        // The session gives up only once the add has let go of it, as a socket to a closed tunnel does.
        await vi.waitFor(() => expect(fixture.host.pairing.list()).toEqual([]))
        refuse!(new Error('The host closed the connection. Try again.'))
        await ended
        // Quitting waits for the add to finish letting go, so the credential is gone before the quit drain ends.
        expect(fixture.credentials.has('remote-host:' + remote.id)).toBe(false)
        await pending
      } finally { opening.mockRestore() }
      expect(fixture.manager.get().adding).toBeUndefined()
      expect(fixture.manager.get().hosts).toEqual([])
      expect(await savedFile()).toEqual([])
    })
  }
  it('asks its SSH question in the dialog, and Cancel there leaves nothing behind', async () => {
    fixture.askOnConnect = 'passphrase'
    const remote = connection()
    const pending = fixture.manager.command({ type: 'add', host: remote })
    await vi.waitFor(() => expect(fixture.manager.get().adding?.prompt).toMatchObject({ id: 'prompt-1', kind: 'passphrase' }))
    expect(fixture.manager.get().hosts).toEqual([])
    await fixture.manager.command({ type: 'cancel-add', id: remote.id })
    await pending
    expect(fixture.manager.get().adding).toBeUndefined()
    expect(fixture.manager.get().hosts).toEqual([])
    expect(await savedFile()).toEqual([])
    expect(fixture.credentials.has('remote-host:' + remote.id)).toBe(false)
    // Answered instead, the question goes to this attempt's SSH session and the host is saved.
    fixture.askOnConnect = 'passphrase'
    const second = connection()
    const adding = fixture.manager.command({ type: 'add', host: second })
    await vi.waitFor(() => expect(fixture.manager.get().adding?.prompt?.id).toBe('prompt-1'))
    await fixture.manager.command({ type: 'ssh-answer', id: second.id, promptId: 'prompt-1', answer: 'synthetic passphrase' })
    await adding
    expect(answers).toEqual(['synthetic passphrase'])
    expect(fixture.manager.get().hosts).toEqual([expect.objectContaining({ id: second.id, phase: 'connected' })])
    expect(JSON.stringify(await savedFile())).not.toContain('synthetic passphrase')
  })
  it('reports each step and Tailscale\'s approval page, opens the page only while it waits, and saves the host once approved', async () => {
    const url = 'https://login.tailscale.com/a/l1a2b3c4'
    const approved = Promise.withResolvers<void>()
    fixture.onConnect = async callbacks => {
      callbacks.onStep?.('reach'); callbacks.onStep?.('tailscale'); callbacks.onApproval?.({ url })
      await approved.promise
      callbacks.onApproval?.(null); callbacks.onStep?.('install'); callbacks.onStep?.('start')
    }
    const remote = connection()
    const pending = fixture.manager.command({ type: 'add', host: remote })
    await vi.waitFor(() => expect(fixture.manager.get().adding).toMatchObject({ phase: 'connecting', step: 'tailscale', tailscale: { waiting: true, url } }))
    expect(opened).toEqual([])
    await fixture.manager.command({ type: 'open-approval', id: remote.id })
    expect(opened).toEqual([url])
    approved.resolve()
    await pending
    // The pairing is Sotto's own step, after the launcher's.
    expect(fixture.manager.get().hosts).toEqual([expect.objectContaining({ id: remote.id, phase: 'connected', step: 'pair', tailscale: { waiting: false } })])
    await expect(fixture.manager.command({ type: 'open-approval', id: remote.id })).rejects.toThrow('Tailscale is no longer waiting for this approval. Nothing was opened.')
    expect(opened).toHaveLength(1)
    expect(JSON.stringify(await savedFile())).not.toContain('tailscale.com')
  })
  it('opens no page but Tailscale\'s own, whatever reached the state', async () => {
    const held = Promise.withResolvers<void>()
    fixture.onConnect = async callbacks => { callbacks.onApproval?.({ url: 'https://login.tailscale.com.example.net/a/l1' }); await held.promise }
    const remote = connection()
    const pending = fixture.manager.command({ type: 'add', host: remote })
    await vi.waitFor(() => expect(fixture.manager.get().adding?.tailscale?.waiting).toBe(true))
    await expect(fixture.manager.command({ type: 'open-approval', id: remote.id })).rejects.toThrow('Nothing was opened.')
    expect(opened).toEqual([])
    held.resolve(); await pending
  })
  it('puts a failure on the step it belongs to, with its fix, and a Tailscale approval that never came stops the retries', async () => {
    const changed = new SshFailure('host-key-changed')
    changed.fix = { text: 'Remove the old key:', command: 'ssh-keygen -R forge.example.net' }
    failures.push(changed)
    fixture.onConnect = async callbacks => { callbacks.onStep?.('reach') }
    const remote = connection()
    await fixture.manager.command({ type: 'add', host: remote })
    expect(fixture.manager.get().adding).toMatchObject({ phase: 'error', step: 'sign-in', fix: { text: 'Remove the old key:', command: 'ssh-keygen -R forge.example.net' },
      error: 'The SSH host key changed. Nothing was saved. Verify the host identity and update your SSH known hosts before adding the host again.' })
    // A failure with no step of its own stays where the connect had reached.
    failures.push(new SshFailure('connect-timeout'))
    fixture.onConnect = async callbacks => { callbacks.onStep?.('reach'); callbacks.onStep?.('sign-in') }
    await fixture.manager.command({ type: 'add', host: connection() })
    expect(fixture.manager.get().adding).toMatchObject({ phase: 'error', step: 'sign-in' })
    await fixture.manager.command({ type: 'cancel-add', id: fixture.manager.get().adding!.id })
    await add()
    const unapproved = new SshFailure('tailscale-unapproved')
    failures.push(unapproved)
    await relaunch()
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'error', reconnecting: false, step: 'tailscale',
      error: 'Tailscale SSH asked you to approve this connection, and no approval came within 5 minutes, so Sotto stopped connecting. Approve it in your browser when Sotto asks, then reconnect.' }))
    expect(scheduled).toEqual([])
  })
  it('says in the dialog that nothing was saved when Tailscale\'s approval never came', async () => {
    failures.push(new SshFailure('tailscale-unapproved'))
    fixture.onConnect = async callbacks => { callbacks.onStep?.('reach'); callbacks.onStep?.('tailscale'); callbacks.onApproval?.({ url: 'https://login.tailscale.com/a/l1' }); callbacks.onApproval?.(null) }
    await fixture.manager.command({ type: 'add', host: connection() })
    expect(fixture.manager.get().adding).toMatchObject({ phase: 'error', step: 'tailscale', tailscale: { waiting: false },
      error: 'Tailscale SSH asked you to approve this connection, and no approval came within 5 minutes, so Sotto stopped connecting. Nothing was saved. Approve it in your browser when Sotto asks, then add the host again.' })
  })
  it('renames a host everywhere its name shows', async () => {
    const remote = await add()
    await fixture.manager.command({ type: 'rename', id: remote.id, name: 'Forge' })
    expect(fixture.manager.get().hosts[0]!.name).toBe('Forge')
    expect(fixture.router.shell().connections).toEqual([expect.objectContaining({ name: 'Forge' })])
    expect(await savedFile()).toEqual([expect.objectContaining({ name: 'Forge' })])
  })
  it('switched off disconnects, cancels a pending retry, and keeps the row, its pairing and the host running', async () => {
    const remote = await add()
    const token = fixture.credentials.get('remote-host:' + remote.id)
    fixture.retryDelay = () => 60_000
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
    await fixture.manager.command({ type: 'set-enabled', id: remote.id, enabled: false })
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'disconnected', enabled: false })
    expect(fixture.manager.get().hosts[0]!.reconnecting).toBeUndefined()
    expect(stops).toEqual([])
    expect(fixture.credentials.get('remote-host:' + remote.id)).toBe(token)
    expect(await savedFile()).toEqual([expect.objectContaining({ id: remote.id, enabled: false })])
    // Switched on again, it connects now with the pairing it kept.
    const switchedOn = await fixture.manager.command({ type: 'set-enabled', id: remote.id, enabled: true })
    // A switch-on is a first connect, not a reconnect, until it has to retry.
    expect(switchedOn.hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: false })
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected', enabled: true, reconnecting: false }))
    expect(fixture.host.pairing.list()).toHaveLength(1)
    expect(await savedFile()).toEqual([expect.not.objectContaining({ enabled: false })])
  })
  it('stays off when switched off while a reconnect is still closing the dropped session', async () => {
    const remote = await add()
    fixture.retryDelay = () => 60_000
    // The dropped session's ssh takes its time to exit, as it does on a real network.
    let exited: (() => void) | undefined
    vi.spyOn(launchers[0]!, 'disconnect').mockImplementationOnce(() => new Promise<void>(resolve => { exited = resolve }))
    launchers[0]!.callbacks!.onDisconnected!('dropped')
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
    // The retry fires and starts closing the old session; the user switches the host off in that moment.
    const retry = fixture.manager.command({ type: 'connect', id: remote.id })
    await vi.waitFor(() => expect(exited).toBeTypeOf('function'))
    await fixture.manager.command({ type: 'set-enabled', id: remote.id, enabled: false })
    exited!()
    await retry
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'disconnected', enabled: false })
    expect(launchers).toHaveLength(1)
    expect(fixture.router.shell().connections ?? []).toEqual([])
  })
  it('reads Switched off, not Needs attention, when switched off while its launch connect is still running', async () => {
    await add()
    fixture.askOnConnect = 'passphrase'
    await relaunch()
    const id = fixture.manager.get().hosts[0]!.id
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]!.prompt?.id).toBe('prompt-1'))
    await fixture.manager.command({ type: 'set-enabled', id, enabled: false })
    // The cancelled connect settles, with no real waiting, after the switch has set the row; it must not report the cancel.
    await new Promise(resolve => setImmediate(resolve))
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'disconnected', enabled: false })
    expect(fixture.manager.get().hosts[0]!.error).toBeUndefined()
    expect(scheduled).toEqual([])
  })
  it('switches a host off when Stop host stops it, so the next launch does not start it again', async () => {
    const remote = await add()
    await fixture.manager.command({ type: 'stop-host', id: remote.id })
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'disconnected', enabled: false })
    await relaunch()
    expect(launchers).toHaveLength(1)
  })
  it('reconnects hosts that are on when Sotto starts, in the background, and leaves switched-off ones alone', async () => {
    const on = await add()
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Sotto desktop')
    const off: RemoteHost = { ...connection('elsewhere'), enabled: false }
    await fixture.credentials.set(`remote-host:${off.id}`, paired.token)
    const [saved] = await savedFile()
    // The first host is written the way a Sotto from before the switch wrote it: no flag at all.
    await relaunch([saved!, { ...off, hostId: randomUUID(), clientId: paired.clientId }])
    expect(fixture.manager.get().hosts.map(item => [item.id, item.enabled])).toEqual([[on.id, true], [off.id, false]])
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected', reconnecting: false }))
    expect(fixture.manager.get().hosts[1]).toMatchObject({ phase: 'disconnected' })
    // One launcher for the add, one for the launch reconnect: the switched-off host was never tried.
    expect(launchers).toHaveLength(2)
    expect(fixture.router.shell().connections).toEqual([expect.objectContaining({ hostId: fixture.reportedHostId })])
  })
  it('shows Reconnecting… and retries on the backoff when a host that is on cannot be reached at launch, and stops at a failure only the user can fix', async () => {
    await add()
    failures.push(new SshFailure('ssh-unreachable'), new SshFailure('auth-failed'))
    await relaunch()
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connecting', reconnecting: true })
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'error', reconnecting: false, error: expect.stringContaining('refused your sign-in') }))
    // The launch attempt, then one retry on the first delay, which met the final failure and stopped.
    expect(scheduled).toEqual([0])
    expect(launchers).toHaveLength(3)
    // Switching it on again is how it is tried once the cause is fixed.
    await fixture.manager.command({ type: 'set-enabled', id: fixture.manager.get().hosts[0]!.id, enabled: true })
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected' }))
  })
  it('stops retrying when the boot unit would not start it or keep it running, which only its journal explains', async () => {
    await add()
    for (const code of ['boot-start-refused', 'boot-unit-failed'] as const) {
      scheduled.length = 0
      const launched = launchers.length
      failures.push(new SshFailure(code))
      await relaunch()
      await vi.waitFor(() => expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'error', reconnecting: false, error: expect.stringContaining('systemd unit') }))
      expect(scheduled).toEqual([])
      expect(launchers.length - launched).toBe(1)
    }
  })
  it('reads a saved-hosts file written before the switch and the port existed', async () => {
    const legacy = { id: randomUUID(), name: 'forge', target: 'zach@forge', identityFile: '', installPath: '~/.local/share/sotto-host', dataDirectory: '~/.sotto' }
    failures.push(new SshFailure('auth-failed'))
    await relaunch([legacy])
    expect(fixture.manager.get().hosts).toEqual([expect.objectContaining({ id: legacy.id, enabled: true })])
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]!.phase).toBe('error'))
  })
})
