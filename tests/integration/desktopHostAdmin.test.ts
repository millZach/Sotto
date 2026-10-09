// @vitest-environment node
import { deferred } from '../fixtures/deferred'
import { describe, expect, it, vi } from 'vitest'
import { version as packageVersion } from '../../package.json'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { HostPhones } from '../../src/main/hosts/hostPhones'
import { SshFailure } from '../../src/main/hosts/sshLauncher'
import { useDesktopHostFixture } from '../fixtures/desktopHostFixture'

const fixture = useDesktopHostFixture()

const { add, answers, failures, launchers, opened, operations, remoteThread, row, savedFile, scheduled, stops } = fixture

describe('admin connections and Forget (ADR-0053)', () => {
  it('sends an admin press on a host on its SSH connection over that connection, opening no second ssh', async () => {
    const phones = new HostPhones({ hosts: { links: () => fixture.manager.phonesLinks(), subscribe: listener => fixture.manager.subscribe(() => listener()) }, openExternal: async () => undefined })
    fixture.manager.usePhones(phones)
    try {
      const remote = await add()
      await vi.waitFor(() => expect(fixture.manager.get().phones?.[0]?.state).toBeDefined(), { timeout: 20_000 })
      await fixture.manager.command({ type: 'host-phones', id: remote.id, command: { type: 'retry' } })
      fixture.updateHost = async () => ({ type: 'update-fetched', file: 'Sotto-host-0.1.31-linux-x64.tar.gz', sha256: 'a'.repeat(64) })
      await fixture.manager.runUpdate(remote.id, { op: 'update-fetch', version: packageVersion, releasesUrl: 'https://releases.example/download' })
      await fixture.manager.command({ type: 'stop-host', id: remote.id })
      expect(launchers).toHaveLength(1)
      expect(operations).toEqual(['ssh update-fetch', 'ssh stop-host'])
    } finally { phones.close() }
  })

  it('opens no admin connection for a Phones press on a link whose connect has ended', async () => {
    const remote = await add()
    const [link] = fixture.manager.phonesLinks()
    await fixture.manager.command({ type: 'disconnect', id: remote.id })
    await expect(link!.press(async () => 'sent')).rejects.toThrow('Forge fixture is not connected. Nothing was changed.')
    expect(launchers).toHaveLength(1)
  })

  it('revokes over the SSH connection the socket is on, before the stop, with no second ssh, and never pairs again', async () => {
    const remote = await add()
    const token = fixture.credentials.get('remote-host:' + remote.id)
    const state = await fixture.manager.command({ type: 'forget', id: remote.id })
    expect(operations).toEqual(['ssh revoke-client', 'ssh stop-host'])
    expect(launchers).toHaveLength(1)
    expect(fixture.host.pairing.verifyToken(token)).toBeUndefined()
    expect(state.forgotten).toBeUndefined()
    expect(scheduled).toEqual([])
    expect(fixture.host.pairing.list()).toEqual([])
  })

  it('opens one admin connection for a host on no SSH connection, which starts nothing, and revokes and stops over it', async () => {
    const remote = await add()
    const token = fixture.credentials.get('remote-host:' + remote.id)
    await fixture.manager.command({ type: 'set-enabled', id: remote.id, enabled: false })
    const state = await fixture.manager.command({ type: 'forget', id: remote.id })
    // One ssh for the add, and one admin connection for both of Forget's presses.
    expect(launchers).toHaveLength(2)
    // Forget's own: a host found stopped would have its boot unit taken away before the connect failed.
    expect(launchers[1]!.options).toEqual({ start: false, removeBoot: true })
    expect(operations).toEqual(['admin revoke-client', 'admin stop-host'])
    expect(fixture.host.pairing.verifyToken(token)).toBeUndefined()
    expect(state.hosts).toEqual([]); expect(state.forgotten).toBeUndefined()
    expect(fixture.credentials.has('remote-host:' + remote.id)).toBe(false)
    expect(scheduled).toEqual([])
  })

  it('ends a connect still opening its socket before it revokes, and revokes and stops over an admin connection instead', async () => {
    const remote = await add()
    await fixture.manager.command({ type: 'set-enabled', id: remote.id, enabled: false })
    const { promise: gate, resolve: release } = deferred<void>()
    let held = false
    const connect = SocketHostService.prototype.connect
    const opening = vi.spyOn(SocketHostService.prototype, 'connect').mockImplementation(async function (this: SocketHostService) {
      held = true
      await gate
      return connect.call(this)
    })
    try {
      await fixture.manager.command({ type: 'set-enabled', id: remote.id, enabled: true })
      await vi.waitFor(() => expect(held).toBe(true), { timeout: 20_000 })
      const state = await fixture.manager.command({ type: 'forget', id: remote.id })
      // The connect's SSH is past its sign-in, but the press does not go over it: the connect ended first.
      expect(operations).toEqual(['admin revoke-client', 'admin stop-host'])
      expect(state.hosts).toEqual([]); expect(state.forgotten).toBeUndefined()
    } finally { release(); opening.mockRestore() }
    expect(scheduled).toEqual([])
  })

  it('stops no host it did not start, over either connection', async () => {
    fixture.owned = false
    const remote = await add()
    await fixture.manager.command({ type: 'disconnect', id: remote.id })
    await fixture.manager.command({ type: 'forget', id: remote.id })
    expect(operations).toEqual(['admin revoke-client'])
    expect(stops).toEqual([])
  })

  it('counts an answer that the host no longer knew this computer as revoked', async () => {
    const remote = await add()
    await fixture.manager.command({ type: 'disconnect', id: remote.id })
    await fixture.host.pairing.revoke(fixture.manager.get().hosts[0]!.clientId!)
    const state = await fixture.manager.command({ type: 'forget', id: remote.id })
    expect(operations).toEqual(['admin revoke-client', 'admin stop-host'])
    expect(state.forgotten).toBeUndefined()
  })

  for (const [what, cause, arrange] of [
    ['finds its host stopped', 'not-running', () => { fixture.hostRunning = false }],
    ['is refused the revoke by a host Sotto did not start', 'refused', () => { fixture.revokeFails = true; fixture.owned = false }],
    // The host stays running, so the command the notice gives can be run there now.
    ['is refused the revoke by a host Sotto started, which it leaves running', 'refused', () => { fixture.revokeFails = true }],
  ] as const) {
    it(`removes a host whose admin connection ${what}, clears its credential and says why it was not revoked`, async () => {
      const remote = await add()
      const token = fixture.credentials.get('remote-host:' + remote.id)
      await fixture.manager.command({ type: 'disconnect', id: remote.id })
      arrange()
      const state = await fixture.manager.command({ type: 'forget', id: remote.id })
      expect(state.hosts).toEqual([]); expect(await savedFile()).toEqual([])
      expect(fixture.credentials.has('remote-host:' + remote.id)).toBe(false)
      expect(fixture.host.pairing.verifyToken(token)).toBeDefined()
      expect(state.forgotten).toEqual([expect.objectContaining({ id: remote.id, name: 'Forge fixture', revoke: { cause, command: expect.stringContaining('--revoke-client') } })])
      expect(stops).toEqual([])
      // A stopped host's launch takes its boot unit away before it fails, so the forgotten host does not start at the next boot.
      expect(launchers.at(-1)!.options).toEqual({ start: false, removeBoot: true })
    })
  }

  it('counts a revoke that never got an answer as the host not reached, not refused, and still stops a host Sotto started', async () => {
    const remote = await add()
    const token = fixture.credentials.get('remote-host:' + remote.id)
    await fixture.manager.command({ type: 'disconnect', id: remote.id })
    fixture.revokeError = new SshFailure('request-busy')
    const state = await fixture.manager.command({ type: 'forget', id: remote.id })
    expect(operations).toEqual(['admin revoke-client', 'admin stop-host'])
    expect(state.hosts).toEqual([])
    expect(fixture.host.pairing.verifyToken(token)).toBeDefined()
    expect(state.forgotten).toEqual([expect.objectContaining({ id: remote.id, revoke: expect.objectContaining({ cause: 'unreachable' }) })])
  })

  it('keeps a host Sotto started when its revoke never got an answer and its stop failed too', async () => {
    const remote = await add()
    await fixture.manager.command({ type: 'disconnect', id: remote.id })
    fixture.revokeError = new SshFailure('not-connected'); fixture.stopResult = false
    await expect(fixture.manager.command({ type: 'forget', id: remote.id })).rejects.toThrow('may still be running')
    expect(fixture.manager.get().hosts).toEqual([expect.objectContaining({ id: remote.id })])
    expect(fixture.manager.get().forgotten).toBeUndefined()
  })

  it('keeps every not-revoked notice until its own Dismiss, whatever later Forgets do', async () => {
    const first = await add()
    await fixture.manager.command({ type: 'disconnect', id: first.id })
    failures.push(new SshFailure('ssh-unreachable'))
    await fixture.manager.command({ type: 'forget', id: first.id })
    // A Forget that revokes leaves the earlier notice alone.
    const second = await add()
    expect((await fixture.manager.command({ type: 'forget', id: second.id })).forgotten).toEqual([expect.objectContaining({ id: first.id })])
    // Another Forget that could not revoke adds its own beside it.
    const third = await add()
    await fixture.manager.command({ type: 'disconnect', id: third.id })
    fixture.hostRunning = false
    const state = await fixture.manager.command({ type: 'forget', id: third.id })
    expect(state.forgotten).toEqual([expect.objectContaining({ id: first.id, revoke: expect.objectContaining({ cause: 'unreachable' }) }), expect.objectContaining({ id: third.id, revoke: expect.objectContaining({ cause: 'not-running' }) })])
    expect((await fixture.manager.command({ type: 'dismiss-forgotten', id: first.id })).forgotten).toEqual([expect.objectContaining({ id: third.id })])
    expect((await fixture.manager.command({ type: 'dismiss-forgotten', id: third.id })).forgotten).toBeUndefined()
  })

  it('changes nothing when the user stops Forget’s sign-in while SSH waits for an answer', async () => {
    const remote = await add()
    const token = fixture.credentials.get('remote-host:' + remote.id)
    await fixture.manager.command({ type: 'set-enabled', id: remote.id, enabled: false })
    fixture.askOnConnect = 'passphrase'
    const forgetting = fixture.manager.command({ type: 'forget', id: remote.id })
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]).toMatchObject({ adminSignIn: true, prompt: { id: 'prompt-1' } }), { timeout: 20_000 })
    await fixture.manager.command({ type: 'stop-admin-sign-in', id: remote.id })
    const state = await forgetting
    expect(state.hosts).toEqual([expect.objectContaining({ id: remote.id, phase: 'disconnected', enabled: false })])
    expect(state.hosts[0]!.prompt).toBeUndefined(); expect(state.hosts[0]!.adminSignIn).toBeUndefined()
    expect(state.forgotten).toBeUndefined()
    expect(operations).toEqual([])
    expect(fixture.host.pairing.verifyToken(token)).toBeDefined()
    expect(fixture.credentials.get('remote-host:' + remote.id)).toBe(token)
    // Stopping a sign-in that is not under way changes nothing either.
    await fixture.manager.command({ type: 'stop-admin-sign-in', id: remote.id })
    expect(fixture.manager.get().hosts).toHaveLength(1)
  })

  describe('a host whose socket is on no SSH connection', () => {
    /** Stands in for a host on its tailnet connection (pull request 4): the SSH connection is gone and the socket stays up. */
    const offSsh = (id: string): void => {
      const live = (fixture.manager as unknown as { live: Map<string, { sshClosed?: boolean }> }).live.get(id)!
      live.sshClosed = true
    }

    it('sends Phones and Update presses over one admin connection, which starts nothing', async () => {
      const phones = new HostPhones({ hosts: { links: () => fixture.manager.phonesLinks(), subscribe: listener => fixture.manager.subscribe(() => listener()) }, openExternal: async () => undefined })
      fixture.manager.usePhones(phones)
      try {
        const remote = await add()
        await vi.waitFor(() => expect(fixture.manager.get().phones?.[0]?.state).toBeDefined(), { timeout: 20_000 })
        offSsh(remote.id)
        await fixture.manager.command({ type: 'host-phones', id: remote.id, command: { type: 'retry' } })
        fixture.updateHost = async () => ({ type: 'update-fetched', file: 'Sotto-host-0.1.31-linux-x64.tar.gz', sha256: 'a'.repeat(64) })
        await fixture.manager.runUpdate(remote.id, { op: 'update-fetch', version: packageVersion, releasesUrl: 'https://releases.example/download' })
        expect(launchers).toHaveLength(2)
        expect(launchers[1]!.options).toEqual({ start: false })
        expect(operations).toEqual(['admin update-fetch'])
      } finally { phones.close() }
    })

    it('opens the next admin connection without Forget’s boot removal once the user stops Forget’s sign-in', async () => {
      const remote = await add()
      offSsh(remote.id)
      fixture.askOnConnect = 'passphrase'
      const forgetting = fixture.manager.command({ type: 'forget', id: remote.id })
      await vi.waitFor(() => expect(fixture.manager.get().hosts[0]).toMatchObject({ adminSignIn: true, prompt: { id: 'prompt-1' } }), { timeout: 20_000 })
      await fixture.manager.command({ type: 'stop-admin-sign-in', id: remote.id })
      expect((await forgetting).hosts).toEqual([expect.objectContaining({ id: remote.id })])
      await vi.waitFor(() => expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected' }), { timeout: 20_000 })
      offSsh(remote.id)
      const signIns = launchers.length
      fixture.updateHost = async () => ({ type: 'update-fetched', file: 'Sotto-host-0.1.31-linux-x64.tar.gz', sha256: 'a'.repeat(64) })
      await fixture.manager.runUpdate(remote.id, { op: 'update-fetch', version: packageVersion, releasesUrl: 'https://releases.example/download' })
      // A connection of its own, which would take a stopped host's boot unit away only for a Forget.
      expect(launchers).toHaveLength(signIns + 1)
      expect(launchers.at(-1)!.options).toEqual({ start: false })
      expect(operations).toEqual(['admin update-fetch'])
    })

    it('says an update’s restart never went when the admin connection cannot open, and keeps the threads as they were', async () => {
      const remote = await add()
      const thread = await remoteThread()
      offSsh(remote.id)
      fixture.hostRunning = false
      await expect(fixture.manager.restartForUpdate(remote.id, packageVersion)).rejects.toMatchObject({ code: 'not-connected', message: expect.stringContaining('The host is not running on the SSH host, so nothing was changed there.') })
      expect(operations).toEqual([])
      expect(row(thread)).toMatchObject({ id: thread, clientConnected: true })
      expect(row(thread)!.clientReconnecting).toBeUndefined()
      expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected' })
    })
  })

  it('asks an admin connection’s SSH question wherever the user is, and sends the answer to that connection', async () => {
    const remote = await add()
    await fixture.manager.command({ type: 'disconnect', id: remote.id })
    fixture.askOnConnect = 'passphrase'
    const forgetting = fixture.manager.command({ type: 'forget', id: remote.id })
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]?.prompt).toMatchObject({ id: 'prompt-1', kind: 'passphrase' }), { timeout: 20_000 })
    await fixture.manager.command({ type: 'ssh-answer', id: remote.id, promptId: 'prompt-1', answer: 'synthetic passphrase' })
    expect((await forgetting).forgotten).toBeUndefined()
    expect(answers).toEqual(['synthetic passphrase'])
    expect(operations).toEqual(['admin revoke-client', 'admin stop-host'])
  })

  it('shows Tailscale’s approval for an admin connection on the host’s row, and opens its page on a press', async () => {
    const remote = await add()
    await fixture.manager.command({ type: 'disconnect', id: remote.id })
    const url = 'https://login.tailscale.com/a/l1a2b3c4'
    const approved = deferred<void>()
    fixture.onConnect = async callbacks => { callbacks.onApproval?.({ url }); await approved.promise; callbacks.onApproval?.(null) }
    const forgetting = fixture.manager.command({ type: 'forget', id: remote.id })
    await vi.waitFor(() => expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'disconnected', tailscale: { waiting: true, url } }), { timeout: 20_000 })
    await fixture.manager.command({ type: 'open-approval', id: remote.id })
    expect(opened).toEqual([url])
    approved.resolve()
    expect((await forgetting).hosts).toEqual([])
  })
})
