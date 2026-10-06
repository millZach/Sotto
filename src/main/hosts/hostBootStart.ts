import { bootChangeRestarts, bootUnsupportedSentence, type BootStatus, type HostBootAction, type HostBootFailure, type HostBootPhase, type HostBootState } from '../../shared/bootStart'
import { idleNow, stopWorkingThreads, whenIdle, type BusyHostThreads } from './busyHost'
import { shellQuoted } from './revokeCommand'
import type { SshBootResult } from './sshLauncher'

/** A saved host that is connected now, as a start at boot change needs it. */
export interface HostBootCandidate {
  /** The saved host's ID. */
  readonly id: string
  readonly name: string
  /** The host's own ID, which its threads carry on the Threads page. */
  readonly hostId: string
  /** Whether Sotto started the host, so installing the unit hands it over and restarts it. */
  readonly owned: boolean
  /** Start at boot as the host's connection last found it. */
  readonly bootStart: BootStatus
  /** The saved installation folder, which a command to run by hand names. */
  readonly installPath: string
}
/** What a start at boot change needs of the saved hosts: `DesktopHosts`. */
export interface HostBootHosts {
  candidate(id: string): HostBootCandidate | undefined
  /**
   * Whether the saved host is still saved and switched on. A change waiting for it carries on through a drop and its
   * reconnect, and goes only when the host is forgotten or switched off.
   */
  keeps(id: string): boolean
  /**
   * Installs or removes the unit over the host's SSH connection or an admin connection. The host's threads stay on the
   * Threads page through any restart it causes, and the promise waits for the first connect after it.
   */
  setBootStart(id: string, action: 'install' | 'remove'): Promise<SshBootResult>
  subscribe(listener: () => void): () => void
}
export interface HostBootChangesOptions {
  readonly hosts: HostBootHosts
  /** The threads, as an update reads them: which of a host's are working, and the Stop their composer sends. */
  readonly threads: BusyHostThreads
}
interface Entry {
  id: string; name: string; hostId: string; installPath: string; change: 'install' | 'remove'; phase: HostBootPhase; restarts: boolean
  restarted?: boolean | undefined; failure?: HostBootFailure | undefined
}

/** What every failure that left the host as it was says about it. */
const UNCHANGED = 'Nothing was changed, and the host keeps running as before.'
/** The journal of the unit, which says why it would not start or would not stay up. Sotto never runs it. */
const JOURNAL = 'journalctl --user -u sotto-host -n 50 --no-pager'

/**
 * The one line that takes start at boot away on a host by hand, for when Sotto could not (ADR-0054). Like `boot-remove`,
 * it acts only on this installation's unit, the one whose `ExecStart=` runs the installation folder's `boot-start.sh`:
 * it stops and disables it, removes the unit and the script, reloads the user manager and clears the unit's failed
 * state. A host the unit ran stops with it. A unit another installation owns is left alone. Sotto never runs it.
 */
export function bootRemovalCommand(installPath: string): string {
  const folder = installPath.length > 1 ? installPath.replace(/\/+$/u, '') : installPath
  return [
    `B=${shellQuoted(folder)}/boot-start.sh`,
    'U="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/sotto-host.service"',
    'grep -qxF "ExecStart=/bin/sh \\"$B\\"" "$U" && { systemctl --user disable --now sotto-host; rm -f "$U" "$B"; systemctl --user daemon-reload; systemctl --user reset-failed sotto-host; }',
  ].join('; ')
}

/**
 * Start at boot changes (ADR-0054): Start at boot and Stop starting at boot for each saved host, from the press in
 * Settings > Hosts to the result the dialog or Add host's connected card shows. A change that would restart a host with
 * working threads asks ADR-0040's busy-host question first. It lives in memory: a result lasts until it is put away or
 * Sotto quits.
 */
export class HostBootChanges {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private readonly off: (() => void)[]
  private published = '[]'
  constructor(private readonly options: HostBootChangesOptions) {
    this.off = [options.hosts.subscribe(() => this.sync()), options.threads.subscribe(() => this.sync())]
  }
  /** Every change to show, in the order they were pressed. */
  state(): HostBootState[] { return [...this.entries.values()].map(entry => this.view(entry)) }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  /** Why another command on this saved host must wait, while its start at boot change runs. */
  busy(id: string): string | undefined {
    const entry = this.entries.get(id)
    return entry?.phase === 'changing' ? `Sotto is changing whether the host on ${entry.name} starts at boot. Nothing was changed. Wait for it to finish, then try again.` : undefined
  }
  dispose(): void {
    for (const off of this.off) off()
    this.listeners.clear()
  }

  async command(id: string, action: HostBootAction): Promise<void> {
    const entry = this.entries.get(id)
    if (action === 'install' || action === 'remove') this.press(id, action)
    else if (!entry) throw new Error('This start at boot change is no longer there. Nothing was changed.')
    else if (action === 'when-idle') { if (entry.phase === 'confirm') { if (whenIdle(this.working(entry).length) === 'waiting') entry.phase = 'waiting'; else this.begin(entry) } }
    else if (action === 'stop-threads') {
      if (this.asking(entry)) {
        await stopWorkingThreads(this.options.threads, entry.hostId)
        // A Cancel, or another press, that came while the turns stopped wins: only the question still on screen goes ahead.
        if (this.asking(entry)) this.begin(entry)
      }
    } else if (entry.phase === 'changing') throw new Error(`Sotto is already changing whether the host on ${entry.name} starts at boot. Wait for it to finish.`)
    // Cancel before anything was sent, and Dismiss once it is over, both put it away.
    else this.entries.delete(id)
    this.emit()
  }

  /** Start at boot or Stop starting at boot: at once, or the busy-host question first when it would stop working threads. */
  private press(id: string, change: 'install' | 'remove'): void {
    const current = this.entries.get(id)
    if (current?.phase === 'changing') throw new Error(`Sotto is already changing whether the host on ${current.name} starts at boot. Wait for it to finish.`)
    const host = this.options.hosts.candidate(id)
    if (!host) throw new Error('Connect to this host before changing whether it starts at boot. Nothing was changed.')
    const restarts = bootChangeRestarts(change, host)
    const entry: Entry = { id, name: host.name, hostId: host.hostId, installPath: host.installPath, change, phase: 'confirm', restarts }
    this.entries.set(id, entry)
    if (!restarts || !this.working(entry).length) this.begin(entry)
  }
  private begin(entry: Entry): void {
    entry.phase = 'changing'
    delete entry.failure; delete entry.restarted
    this.emit()
    void this.options.hosts.setBootStart(entry.id, entry.change).then(result => this.finish(entry, result), (error: unknown) => {
      this.fail(entry, { kind: 'failed', message: error instanceof Error && error.message ? error.message : `The host on ${entry.name} did not answer. Connect to it again to see whether start at boot changed.` })
    })
  }
  private finish(entry: Entry, result: SshBootResult): void {
    if (this.entries.get(entry.id) !== entry) return
    if (result.type === 'boot-installed' && result.installed) { entry.phase = 'done'; entry.restarted = result.stopped }
    else if (result.type === 'boot-removed') { entry.phase = 'done'; entry.restarted = result.stopped }
    else if (result.type === 'boot-installed' || result.type === 'boot-status') this.fail(entry, this.notInstalled(entry.name, result.bootStart))
    else this.fail(entry, this.refused(entry, result.reason, result.restarted === true))
    this.emit()
  }
  /** Whether this entry is still the host's, asking its question or waiting for its threads. */
  private asking(entry: Entry): boolean {
    return this.entries.get(entry.id) === entry && (entry.phase === 'confirm' || entry.phase === 'waiting')
  }
  private fail(entry: Entry, failure: HostBootFailure): void {
    if (this.entries.get(entry.id) !== entry) return
    entry.phase = 'failed'
    entry.failure = failure
    this.emit()
  }
  /** The install wrote nothing: the host would not turn linger on, or cannot start at boot at all. */
  private notInstalled(name: string, status: BootStatus): HostBootFailure {
    if (status.supported && !status.linger) {
      return { kind: 'linger', message: `${name} would not turn on linger without an administrator. Without it, a unit would stop ${name}’s host whenever its account signs out, so Sotto installed nothing.`,
        ...(status.fix ? { fix: { text: `Run this on ${name}, then press Start at boot again. Sotto never runs sudo.`, command: status.fix } } : {}) }
    }
    return { kind: 'unsupported', message: `${bootUnsupportedSentence(status.reason)} Nothing was changed on ${name}.` }
  }
  /** What the launch script's refusal means for this host, in plain words. */
  private refused(entry: Entry, reason: string, restarted: boolean): HostBootFailure {
    const { name } = entry
    const failed = (message: string, fix?: HostBootFailure['fix']): HostBootFailure => ({ kind: 'failed', message, ...(fix ? { fix } : {}) })
    const journal = { text: `To see why the unit failed, run this on ${name}:`, command: JOURNAL }
    switch (reason) {
      case 'boot-unit-taken': return failed(`Another Sotto installation on ${name} already has a unit named sotto-host. ${UNCHANGED} Remove that unit on ${name}, then try again.`)
      case 'boot-install-failed': return failed(`${name}’s systemd would not take the unit, so Sotto took it away again. ${UNCHANGED} Check systemd for ${name}’s account, then try again.`)
      case 'boot-stop-failed': return failed(`The host Sotto started on ${name} would not stop, so Sotto took the unit away again. The host keeps running, and nothing was lost. Try again in a minute.`)
      case 'boot-start-failed': return failed(restarted
        ? `The unit did not bring ${name}’s host back, so Sotto took the unit away again and started the host the way it always has. Turns that were running stopped; drafts and history stay.`
        : `The unit did not bring ${name}’s host back, so Sotto took the unit away again, and the host did not start without it either. Nothing in its data folder was lost. Sotto starts it again when it next connects.`, journal)
      case 'update-busy': return failed(`Sotto is already updating or changing the host on ${name}. ${UNCHANGED} Wait a minute, then try again.`)
      case 'archive-missing': return failed(`The host installation on ${name} is missing files the unit would run. ${UNCHANGED} Update the host, then try again.`)
      case 'boot-remove-failed': return failed(`Sotto turned off start at boot on ${name} but could not remove the unit’s files there. Nothing was lost, and this computer starts the host again when it connects.`,
        { text: `To remove them, run this on ${name}:`, command: bootRemovalCommand(entry.installPath) })
      case 'boot-failed': return failed(`The connection to ${name} closed before start at boot changed. Nothing was lost. Its row shows whether start at boot changed once it connects again.`)
      default:
        // Removing took the unit away, and the host it ran did not start again outside it.
        if (entry.change === 'remove') return failed(`Start at boot is off on ${name}, but its host did not start again. Nothing in its data folder was lost. Sotto starts it again when it next connects.`)
        return failed(`Start at boot on ${name} did not change. ${UNCHANGED} Try again, and if it fails again, check the host on ${name}.`)
    }
  }
  private working(entry: Entry): readonly string[] { return this.options.threads.working(entry.hostId) }
  private view(entry: Entry): HostBootState {
    return { id: entry.id, name: entry.name, change: entry.change, phase: entry.phase, working: this.working(entry).length, restarts: entry.restarts,
      ...(entry.restarted !== undefined ? { restarted: entry.restarted } : {}), ...(entry.failure ? { failure: entry.failure } : {}) }
  }
  /**
   * Follows the hosts and the threads. A question, or a wait, goes ahead once none of the host's threads is working,
   * since the user has already pressed. Through a drop it waits for the host to connect again; a host forgotten or
   * switched off ends it, and nothing was sent.
   */
  private sync(): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.phase !== 'confirm' && entry.phase !== 'waiting') continue
      if (!this.options.hosts.keeps(entry.id)) {
        this.fail(entry, { kind: 'failed', message: `${entry.name} was switched off or removed before start at boot changed. Nothing was changed. Switch it on, then try again.` })
        continue
      }
      if (this.options.hosts.candidate(entry.id) && idleNow(entry.phase, this.working(entry).length)) this.begin(entry)
    }
    this.emit()
  }
  private emit(): void {
    const published = JSON.stringify(this.state())
    if (published === this.published) return
    this.published = published
    for (const listener of this.listeners) listener()
  }
}
