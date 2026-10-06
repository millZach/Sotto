// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { HostBootChanges, bootRemovalCommand, type HostBootCandidate, type HostBootHosts } from '../../../src/main/hosts/hostBootStart'
import type { BusyHostThreads } from '../../../src/main/hosts/busyHost'
import type { SshBootResult } from '../../../src/main/hosts/sshLauncher'
import { SshFailure } from '../../../src/main/hosts/sshFailure'
import type { BootStatus, HostBootState } from '../../../src/shared/bootStart'

const ID = '11111111-1111-4111-8111-111111111111'
const HOST_ID = '22222222-2222-4222-8222-222222222222'
const off: BootStatus = { supported: true, installed: false, enabled: false, active: false, linger: true, nodeDrift: false }
const on: BootStatus = { supported: true, installed: true, enabled: true, active: true, linger: true, nodeDrift: false }
const forge = (patch: Partial<HostBootCandidate> = {}): HostBootCandidate => ({ id: ID, name: 'forge', hostId: HOST_ID, owned: true, bootStart: off, installPath: '~/.local/share/sotto-host', ...patch })

/** The saved hosts, scripted: each change answers as `answer` says, once `release` lets it. */
class Hosts implements HostBootHosts {
  host: HostBootCandidate | undefined = forge()
  /** Whether the saved host is still saved and switched on. */
  kept = true
  readonly changes: string[] = []
  readonly listeners = new Set<() => void>()
  answer: (action: 'install' | 'remove') => Promise<SshBootResult> = async action => action === 'install'
    ? { type: 'boot-installed', installed: true, stopped: true, pid: 7, bootStart: on } : { type: 'boot-removed', stopped: true, pid: 8, bootStart: off }
  candidate(id: string): HostBootCandidate | undefined { return id === ID ? this.host : undefined }
  keeps(id: string): boolean { return id === ID && this.kept }
  async setBootStart(_id: string, action: 'install' | 'remove'): Promise<SshBootResult> { this.changes.push(action); return this.answer(action) }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit(): void { for (const listener of this.listeners) listener() }
}
class Threads implements BusyHostThreads {
  busy: string[] = []
  readonly interrupted: string[] = []
  readonly listeners = new Set<() => void>()
  working(hostId: string): readonly string[] { return hostId === HOST_ID ? this.busy : [] }
  async interrupt(threadId: string): Promise<void> { this.interrupted.push(threadId); this.busy = this.busy.filter(id => id !== threadId) }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  set(ids: string[]): void { this.busy = ids; for (const listener of this.listeners) listener() }
}
function setup() {
  const hosts = new Hosts(), threads = new Threads()
  const boot = new HostBootChanges({ hosts, threads })
  const view = (): HostBootState | undefined => boot.state()[0]
  /** Waits for the change to land: the answer is a promise main does not await in the press. */
  const settled = async (): Promise<HostBootState | undefined> => { for (let tries = 0; tries < 20 && view()?.phase === 'changing'; tries++) await Promise.resolve(); return view() }
  return { hosts, threads, boot, view, settled }
}

describe('start at boot changes (ADR-0054)', () => {
  it('starts a host at boot at once when none of its threads is working, and says it restarted', async () => {
    const { boot, hosts, settled } = setup()
    await boot.command(ID, 'install')
    expect(hosts.changes).toEqual(['install'])
    expect(await settled()).toEqual({ id: ID, name: 'forge', change: 'install', phase: 'done', working: 0, restarts: true, restarted: true })
    await boot.command(ID, 'dismiss')
    expect(boot.state()).toEqual([])
  })

  it('asks the busy-host question before a restart would stop working threads, and waits for them when asked', async () => {
    const { boot, hosts, threads, view, settled } = setup()
    threads.set(['a', 'b'])
    await boot.command(ID, 'install')
    expect(view()).toMatchObject({ phase: 'confirm', working: 2, restarts: true })
    expect(hosts.changes).toEqual([])
    await boot.command(ID, 'when-idle')
    expect(view()).toMatchObject({ phase: 'waiting', working: 2 })
    threads.set(['b'])
    expect(view()).toMatchObject({ phase: 'waiting', working: 1 })
    threads.set([])
    expect(hosts.changes).toEqual(['install'])
    expect(await settled()).toMatchObject({ phase: 'done', restarted: true })
  })

  it('stops the working threads the way their Stop does, then changes start at boot at once', async () => {
    const { boot, hosts, threads, settled } = setup()
    threads.set(['a', 'b'])
    await boot.command(ID, 'install')
    await boot.command(ID, 'stop-threads')
    expect(threads.interrupted).toEqual(['a', 'b'])
    expect(hosts.changes).toEqual(['install'])
    expect(await settled()).toMatchObject({ phase: 'done' })
  })

  it('changes nothing on Cancel', async () => {
    const { boot, hosts, threads } = setup()
    threads.set(['a'])
    hosts.host = forge({ bootStart: on })
    await boot.command(ID, 'remove')
    await boot.command(ID, 'cancel')
    expect(boot.state()).toEqual([])
    threads.set([])
    expect(hosts.changes).toEqual([])
  })

  it('asks nothing when the change restarts nothing: a host Sotto did not start, or a unit that runs no host', async () => {
    const { boot, hosts, threads, settled } = setup()
    threads.set(['a'])
    hosts.host = forge({ owned: false })
    hosts.answer = async () => ({ type: 'boot-installed', installed: true, stopped: false, bootStart: { ...on, active: false } })
    await boot.command(ID, 'install')
    expect(await settled()).toMatchObject({ phase: 'done', restarts: false, restarted: false })
    hosts.host = forge({ bootStart: { ...on, active: false } })
    hosts.answer = async () => ({ type: 'boot-removed', stopped: false, bootStart: off })
    await boot.command(ID, 'remove')
    expect(await settled()).toMatchObject({ change: 'remove', phase: 'done', restarts: false })
    expect(hosts.changes).toEqual(['install', 'remove'])
  })

  it('asks before removing a unit that runs the host', async () => {
    const { boot, hosts, threads, view } = setup()
    threads.set(['a'])
    hosts.host = forge({ bootStart: on })
    await boot.command(ID, 'remove')
    expect(view()).toMatchObject({ change: 'remove', phase: 'confirm', restarts: true, working: 1 })
  })

  it('says linger needs an administrator, with the command to run there, and that nothing changed', async () => {
    const { boot, hosts, settled } = setup()
    hosts.answer = async () => ({ type: 'boot-installed', installed: false, stopped: false, bootStart: { ...off, linger: false, fix: 'sudo loginctl enable-linger zach' } })
    await boot.command(ID, 'install')
    expect(await settled()).toMatchObject({ phase: 'failed', failure: { kind: 'linger', fix: { text: 'Run this on forge, then press Start at boot again. Sotto never runs sudo.', command: 'sudo loginctl enable-linger zach' } } })
    expect((await settled())!.failure!.message).toBe('forge would not turn on linger without an administrator. Without it, a unit would stop forge’s host whenever its account signs out, so Sotto installed nothing.')
    // Start at boot again, once the owner has run it, starts over.
    hosts.answer = async () => ({ type: 'boot-installed', installed: true, stopped: true, bootStart: on })
    await boot.command(ID, 'install')
    expect(await settled()).toMatchObject({ phase: 'done', restarted: true })
  })

  it('says in one sentence why a host cannot start at boot', async () => {
    const { boot, hosts, settled } = setup()
    hosts.answer = async () => ({ type: 'boot-installed', installed: false, stopped: false, bootStart: { ...off, supported: false, reason: 'no-user-manager' } })
    await boot.command(ID, 'install')
    expect((await settled())!.failure).toEqual({ kind: 'unsupported', message: 'This host has no systemd user manager, so Sotto cannot start it at boot. Nothing was changed on forge.' })
  })

  it('says what each refusal means for the host, with the unit’s journal when the unit would not start it', async () => {
    const { boot, hosts, settled } = setup()
    const refusal = async (reason: string, restarted?: boolean) => {
      hosts.answer = async () => ({ type: 'error', reason, ...(restarted === undefined ? {} : { restarted }) })
      await boot.command(ID, 'install')
      return (await settled())!.failure!
    }
    expect((await refusal('boot-unit-taken')).message).toBe('Another Sotto installation on forge already has a unit named sotto-host. Nothing was changed, and the host keeps running as before. Remove that unit on forge, then try again.')
    expect((await refusal('boot-stop-failed')).message).toContain('The host keeps running, and nothing was lost.')
    const gone = await refusal('boot-start-failed', false)
    expect(gone.message).toContain('the host did not start without it either. Nothing in its data folder was lost.')
    expect(gone.fix).toEqual({ text: 'To see why the unit failed, run this on forge:', command: 'journalctl --user -u sotto-host -n 50 --no-pager' })
    expect((await refusal('boot-start-failed', true)).message).toContain('started the host the way it always has')
    expect((await refusal('update-busy')).message).toBe('Sotto is already updating or changing the host on forge. Nothing was changed, and the host keeps running as before. Wait a minute, then try again.')
    hosts.host = forge({ bootStart: on })
    hosts.answer = async () => ({ type: 'error', reason: 'boot-remove-failed' })
    await boot.command(ID, 'remove')
    expect((await settled())!.failure!.fix).toEqual({ text: 'To remove them, run this on forge:', command: bootRemovalCommand('~/.local/share/sotto-host') })
    hosts.answer = async () => ({ type: 'error', reason: 'host-timeout' })
    await boot.command(ID, 'remove')
    expect((await settled())!.failure!.message).toBe('Start at boot is off on forge, but its host did not start again. Nothing in its data folder was lost. Sotto starts it again when it next connects.')
  })

  it('says a lost connection in its own words, and refuses another change while one runs', async () => {
    const { boot, hosts, settled } = setup()
    let finish!: (result: SshBootResult) => void
    hosts.answer = () => new Promise(resolve => { finish = resolve })
    await boot.command(ID, 'install')
    expect(boot.busy(ID)).toBe('Sotto is changing whether the host on forge starts at boot. Nothing was changed. Wait for it to finish, then try again.')
    await expect(boot.command(ID, 'remove')).rejects.toThrow('Sotto is already changing whether the host on forge starts at boot. Wait for it to finish.')
    finish({ type: 'boot-installed', installed: true, stopped: true, bootStart: on })
    await settled()
    expect(boot.busy(ID)).toBeUndefined()
    hosts.answer = async () => { throw new SshFailure('boot-failed') }
    await boot.command(ID, 'install')
    await Promise.resolve(); await Promise.resolve()
    expect((await settled())!.failure!.message).toBe('The connection to the host closed before start at boot was changed. Connect again to see whether it changed.')
  })

  it('refuses a host that is not connected', async () => {
    const { boot, hosts } = setup()
    hosts.host = undefined
    await expect(boot.command(ID, 'install')).rejects.toThrow('Connect to this host before changing whether it starts at boot. Nothing was changed.')
    expect(hosts.changes).toEqual([])
  })

  it('keeps waiting for the threads through a drop and its reconnect, and goes ahead once the host is back and idle', async () => {
    const { boot, hosts, threads, view, settled } = setup()
    threads.set(['a'])
    await boot.command(ID, 'install')
    await boot.command(ID, 'when-idle')
    hosts.host = undefined
    hosts.emit()
    // The threads finish while the host is away: nothing is sent to a host that is not there.
    threads.set([])
    expect(view()).toMatchObject({ phase: 'waiting', working: 0 })
    expect(hosts.changes).toEqual([])
    hosts.host = forge()
    hosts.emit()
    expect(hosts.changes).toEqual(['install'])
    expect(await settled()).toMatchObject({ phase: 'done' })
  })

  it('ends a wait, saying nothing changed, when the host is switched off or forgotten', async () => {
    const { boot, hosts, threads, view } = setup()
    threads.set(['a'])
    await boot.command(ID, 'install')
    await boot.command(ID, 'when-idle')
    hosts.host = undefined
    hosts.kept = false
    hosts.emit()
    expect(view()).toMatchObject({ phase: 'failed', failure: { kind: 'failed', message: 'forge was switched off or removed before start at boot changed. Nothing was changed. Switch it on, then try again.' } })
    expect(hosts.changes).toEqual([])
  })

  it('goes ahead when the last working thread ends while the question is still on screen, since the user already pressed', async () => {
    const { boot, hosts, threads, settled } = setup()
    threads.set(['a'])
    await boot.command(ID, 'install')
    threads.set([])
    expect(hosts.changes).toEqual(['install'])
    expect(await settled()).toMatchObject({ phase: 'done', working: 0 })
  })

  it('changes nothing when Cancel comes while Stop N threads now is still stopping them', async () => {
    const { boot, hosts, threads } = setup()
    threads.set(['a'])
    let stopped!: () => void
    threads.interrupt = threadId => { threads.interrupted.push(threadId); return new Promise(resolve => { stopped = () => { threads.busy = []; resolve() } }) }
    await boot.command(ID, 'install')
    const stopping = boot.command(ID, 'stop-threads')
    await Promise.resolve()
    expect(threads.interrupted).toEqual(['a'])
    await boot.command(ID, 'cancel')
    stopped()
    await stopping
    expect(hosts.changes).toEqual([])
    expect(boot.state()).toEqual([])
    expect(boot.busy(ID)).toBeUndefined()
  })
})

describe('the command that removes start at boot by hand', () => {
  it('acts only on the unit that runs this installation’s script, as boot-remove does, and clears its failed state', () => {
    expect(bootRemovalCommand('~/.local/share/sotto-host/')).toBe('B="$HOME/.local/share/sotto-host"/boot-start.sh; U="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/sotto-host.service"; '
      + 'grep -qxF "ExecStart=/bin/sh \\"$B\\"" "$U" && { systemctl --user disable --now sotto-host; rm -f "$U" "$B"; systemctl --user daemon-reload; systemctl --user reset-failed sotto-host; }')
    expect(bootRemovalCommand('/opt/my "sotto" $x')).toContain('B="/opt/my \\"sotto\\" \\$x"/boot-start.sh;')
  })
})
