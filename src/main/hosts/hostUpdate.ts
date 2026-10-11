import { createHash } from 'node:crypto'
import { hostIsNewer, hostIsOlder, LEGACY_MANAGEMENT_UPDATE } from '../../shared/hostProtocol'
import { HOST_ARCHIVE_PATTERN, HOST_RELEASES_URL, hostArchiveName, type HostUpdateAction, type HostUpdateFailure, type HostUpdatePhase, type HostUpdateRoute, type HostUpdateState, type HostUpdateStep } from '../../shared/hostUpdates'
import { HOST_ARCHIVE_LIMIT_BYTES, HOST_DOWNLOAD_TIMEOUT_MS } from './launchScript'
import { SshFailure } from './sshFailure'
import type { SshHostUpdateOperation, SshHostUpdateOptions, SshHostUpdateResult } from './sshLauncher'
import { idleNow, stopWorkingThreads, whenIdle, type BusyHostThreads } from './busyHost'

/** A saved host that is connected, or kept reachable for Stop host, and has said which Sotto it runs. */
export interface HostUpdateCandidate {
  /** The saved host's ID. */
  readonly id: string
  readonly name: string
  /** The host's own ID, which its threads carry on the Threads page. */
  readonly hostId: string
  readonly version: string
  /** Whether Sotto started the host, and so may stop and start it. */
  readonly owned: boolean
  readonly installPath: string
  readonly dataDirectory: string
  /** The host starts at boot, so its systemd unit runs it and restarts it (ADR-0054). */
  readonly boot?: boolean
}
/** What an update needs of the saved hosts: `DesktopHosts`. */
export interface HostUpdateHosts {
  candidates(): readonly HostUpdateCandidate[]
  /** One operation of the update, over the host's SSH connection. */
  run(id: string, operation: SshHostUpdateOperation, options?: SshHostUpdateOptions): Promise<SshHostUpdateResult>
  /**
   * The restart. The host's threads stay on the Threads page, reading Reconnecting with their drafts kept, until this
   * computer has connected to the host again, which the promise waits for once.
   */
  restart(id: string, version: string, options?: SshHostUpdateOptions): Promise<SshHostUpdateResult>
  subscribe(listener: () => void): () => void
}
/** What an update needs of the threads: the busy-host question's (`busyHost.ts`). */
export type HostUpdateThreads = BusyHostThreads
export interface HostUpdatesOptions {
  readonly requiresManagementUpdate?: (hostId: string) => boolean
  readonly hosts: HostUpdateHosts
  readonly threads: HostUpdateThreads
  /** This computer's Sotto version: what every update installs. */
  readonly version: string
  /** Where releases are published; tests serve their own. */
  readonly releasesUrl?: string
  /** This computer's own download, for a host that cannot reach the releases page. */
  readonly download?: (url: string, limit: number, signal: AbortSignal) => Promise<Uint8Array>
}
interface Entry {
  id: string; name: string; hostId: string; from: string; owned: boolean; installPath: string; dataDirectory: string; boot?: boolean | undefined
  phase: HostUpdatePhase; step?: HostUpdateStep | undefined; route?: HostUpdateRoute | undefined
  failure?: HostUpdateFailure | undefined; error?: string | undefined
  /** The launch script's code, or this computer's, for the failure shown. */
  reason?: string | undefined
  /** The archive the host asked for, which names its platform. */
  file?: string | undefined
  /** The update running, which Cancel update aborts. */
  run?: AbortController | undefined
  /** Set once the host has been asked to unpack: from there nothing is cancelled, whatever step the panel shows. */
  installing?: boolean | undefined
}
/** What a failure's sentence names: the archive, whether the old host started again, a Node range and version, a host version. */
interface StopDetail { readonly file?: string | undefined; readonly restarted?: boolean | undefined; readonly range?: string | undefined; readonly node?: string | undefined; readonly version?: string | undefined }
/** A failure the update itself found, with the launch script's code, or a code of its own for this computer's part. */
class UpdateStopped extends Error {
  constructor(readonly reason: string, readonly step: HostUpdateStep, readonly detail: StopDetail = {}) { super(reason) }
}
const STEP_VERBS: Readonly<Record<HostUpdateStep, (to: string) => string>> = {
  download: to => `download ${to}`, check: () => 'check the download', install: to => `install ${to}`, restart: () => 'restart the host',
}
/** A path for a POSIX shell: as it is when it is plain, quoted otherwise, with a leading `~/` left for the shell to expand. */
function shellPath(value: string): string {
  if (/^[\w@%+=:,./~-]+$/u.test(value)) return value
  const quote = (text: string): string => `'${text.replace(/'/gu, "'\\''")}'`
  return value.startsWith('~/') ? `~/${quote(value.slice(2))}` : quote(value)
}
/** This computer's download, with a size cap and the same deadline a host gets. */
async function downloadHere(url: string, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.any([signal, AbortSignal.timeout(HOST_DOWNLOAD_TIMEOUT_MS)]) })
  if (response.status === 404) throw new UpdateStopped('archive-unavailable', 'download')
  if (!response.ok || !response.body) throw new Error('download-failed')
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength
    if (size > limit) throw new Error('download-failed')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Host updates (ADR-0040): every saved host that runs an older Sotto than this computer, and each one's update. Nothing
 * starts until the user presses Update, and each host is updated on its own. It lives in memory: Not now lasts until
 * Sotto next starts, and so does a failure's note.
 */
export class HostUpdates {
  private readonly entries = new Map<string, Entry>()
  /** Saved hosts the user answered Not now for. They stay hidden until Sotto next starts, whatever reconnects meanwhile. */
  private readonly notNow = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private published = '[]'
  private readonly off: (() => void)[]
  private readonly releasesUrl: string
  constructor(private readonly options: HostUpdatesOptions) {
    this.releasesUrl = options.releasesUrl ?? HOST_RELEASES_URL
    this.off = [options.hosts.subscribe(() => this.sync()), options.threads.subscribe(() => this.sync())]
    this.sync()
  }
  /** Every host update to show, in the order the hosts were saved. A host the user said Not now to is left out. */
  state(): HostUpdateState[] {
    return [...this.entries.values()].filter(entry => !this.notNow.has(entry.id)).map(entry => this.view(entry))
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  /** Why another command on this saved host must wait, while its update is under way. */
  busy(id: string): string | undefined {
    const entry = this.entries.get(id)
    return entry?.phase === 'updating' ? `Sotto is updating the host on ${entry.name}. Nothing was changed. Wait for the update to finish, then try again.` : undefined
  }
  dispose(): void {
    for (const off of this.off) off()
    for (const entry of this.entries.values()) entry.run?.abort()
    this.listeners.clear()
  }

  async command(id: string, action: HostUpdateAction): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error('This host no longer needs an update. Nothing was changed.')
    delete entry.error
    try {
      if (action === 'update') this.update(entry)
      else if (action === 'when-idle') { if (entry.phase === 'confirm') { if (whenIdle(this.working(entry).length) === 'waiting') entry.phase = 'waiting'; else this.begin(entry) } }
      else if (action === 'stop-threads') { if (entry.phase === 'confirm' || entry.phase === 'waiting') await this.stopThreadsAndUpdate(entry) }
      else if (action === 'cancel') this.cancel(entry)
      else if (action === 'not-now') {
        if (entry.phase === 'updating') throw new Error(`The update of ${entry.name} is under way and cannot be hidden. Nothing was changed.`)
        this.notNow.add(id)
        if (entry.phase === 'confirm' || entry.phase === 'waiting') entry.phase = 'needs'
      }
      else if (entry.phase === 'done' || entry.phase === 'failed') this.entries.delete(id)
    } finally { this.sync(true) }
  }

  /** Update and Try again: at once on a host with nothing working, or a question first when something is. */
  private update(entry: Entry): void {
    if (entry.phase !== 'needs' && entry.phase !== 'failed') return
    if (!entry.owned) throw new Error(`Sotto did not start the host on ${entry.name}, so it cannot restart it. Nothing was changed. Update it on ${entry.name} with the commands below.`)
    const candidate = this.options.hosts.candidates().find(item => item.id === entry.id)
    if (!candidate) { entry.error = `${entry.name} is not connected, so nothing was updated. Switch it on in Settings > Hosts, then try again.`; return }
    this.refresh(entry, candidate)
    if (!this.needsUpdate(candidate)) { this.entries.delete(entry.id); return }
    if (this.working(entry).length) { entry.phase = 'confirm'; delete entry.failure; return }
    this.begin(entry)
  }
  private async stopThreadsAndUpdate(entry: Entry): Promise<void> {
    await stopWorkingThreads(this.options.threads, entry.hostId)
    if (entry.phase === 'confirm' || entry.phase === 'waiting') this.begin(entry)
  }
  private cancel(entry: Entry): void {
    if (entry.phase === 'confirm' || entry.phase === 'waiting') { entry.phase = 'needs'; return }
    if (entry.phase !== 'updating') return
    if ((entry.step !== 'download' && entry.step !== 'check') || entry.installing) throw new Error(`${entry.name} is already installing ${this.options.version}, which cannot be stopped partway. Nothing was changed.`)
    const run = entry.run
    delete entry.run
    Object.assign(entry, { phase: 'needs', step: undefined, route: undefined })
    run?.abort()
  }
  private begin(entry: Entry): void {
    const run = new AbortController()
    entry.run?.abort()
    Object.assign(entry, { phase: 'updating', step: 'download', route: 'host', failure: undefined, reason: undefined, error: undefined, installing: false, run })
    this.sync(true)
    void this.carryOut(entry, run)
  }
  /** The four steps. A failure at any of them leaves the old version running, or starts it again, and says so. */
  private async carryOut(entry: Entry, run: AbortController): Promise<void> {
    const to = this.options.version, signal = run.signal
    const current = (): boolean => entry.run === run && this.entries.get(entry.id) === entry
    const step = (next: HostUpdateStep): void => { if (current() && entry.step !== next) { entry.step = next; this.sync(true) } }
    const onStep = (next: HostUpdateStep): void => step(next)
    try {
      const { file, sha256 } = await this.fetch(entry, signal, onStep)
      if (!current()) return
      // Past this point the update cannot be cancelled: the host unpacks, then restarts. The panel moves on first, so
      // it never offers Cancel update for a step that would refuse it.
      entry.installing = true
      step('install')
      const installed = await this.options.hosts.run(entry.id, { op: 'update-install', version: to, file, sha256 }, { onStep })
      if (installed.type === 'error') throw new UpdateStopped(installed.reason, installed.reason === 'checksum-mismatch' ? 'check' : 'install', installed)
      if (installed.type !== 'update-installed') throw new UpdateStopped('update-failed', 'install')
      step('restart')
      let restarted: SshHostUpdateResult | undefined
      try { restarted = await this.options.hosts.restart(entry.id, to) }
      catch (error) {
        // Refused before it was sent (the host is not Sotto's any more, or not connected): nothing was stopped.
        if (!(error instanceof SshFailure) || error.code === 'request-busy' || error.code === 'not-connected') throw new UpdateStopped('restart-not-sent', 'restart')
        restarted = undefined
      }
      if (restarted?.type === 'error') throw new UpdateStopped(restarted.reason, 'restart', restarted)
      // Connected again, the host says what it runs; a connection lost during the restart is decided by that alone.
      const now = this.options.hosts.candidates().find(item => item.id === entry.id)
      if (now && now.version !== to) throw new UpdateStopped(restarted ? 'update-wrong-version' : 'update-lost', 'restart', { version: now.version })
      if (!now && !restarted) throw new UpdateStopped('update-lost', 'restart')
      if (!current()) return
      Object.assign(entry, { phase: 'done', step: undefined, run: undefined, from: now?.version ?? to })
    } catch (error) {
      if (!current()) return
      delete entry.run
      if (signal.aborted) { Object.assign(entry, { phase: 'needs', step: undefined, route: undefined }); return }
      const stopped = error instanceof UpdateStopped ? error : new UpdateStopped('update-lost', entry.step ?? 'download')
      Object.assign(entry, { phase: 'failed', failure: this.describe(entry, stopped), reason: stopped.reason, step: undefined })
    } finally { this.sync(true) }
  }
  /** Download and check: on the host, or on this computer and copied over SSH when the host cannot reach the releases page. */
  private async fetch(entry: Entry, signal: AbortSignal, onStep: (step: HostUpdateStep) => void): Promise<{ file: string; sha256: string }> {
    // `check` arrives from the host once its download is in: the checksum is next.
    const to = this.options.version
    const fetched = await this.options.hosts.run(entry.id, { op: 'update-fetch', version: to, releasesUrl: this.releasesUrl }, { signal, onStep })
    if (fetched.type === 'update-fetched') { entry.file = fetched.file; return { file: fetched.file, sha256: fetched.sha256 } }
    if (fetched.type !== 'error') throw new UpdateStopped('update-failed', 'download')
    if (fetched.file) entry.file = fetched.file
    if ((fetched.reason !== 'download-unreachable' && fetched.reason !== 'download-failed') || !fetched.file) {
      throw new UpdateStopped(fetched.reason, fetched.reason === 'checksum-mismatch' ? 'check' : 'download', fetched)
    }
    // The host could not reach the releases page: this computer downloads the same archive for it and copies it over,
    // which is the download step, then checks it against the release's checksum. The host checks it again before unpacking.
    entry.route = 'desktop'
    this.sync(true)
    const file = fetched.file
    if (!HOST_ARCHIVE_PATTERN.test(file)) throw new UpdateStopped('update-failed', 'download')
    const url = `${this.releasesUrl.replace(/\/+$/u, '')}/v${to}/${file}`
    const download = this.options.download ?? downloadHere
    let archive: Uint8Array, sidecar: Uint8Array
    try {
      archive = await download(url, HOST_ARCHIVE_LIMIT_BYTES, signal)
      sidecar = await download(`${url}.sha256`, 4096, signal)
    } catch (error) {
      if (signal.aborted) throw error
      throw error instanceof UpdateStopped ? error : new UpdateStopped('desktop-unreachable', 'download', { file })
    }
    let received: SshHostUpdateResult
    try { received = await this.options.hosts.run(entry.id, { op: 'update-receive', file, size: archive.byteLength, archive }, { signal }) }
    catch (error) { if (signal.aborted) throw error; throw new UpdateStopped('copy-incomplete', 'download') }
    if (received.type !== 'update-received') throw new UpdateStopped(received.type === 'error' ? received.reason : 'copy-incomplete', 'download')
    onStep('check')
    const sha256 = createHash('sha256').update(archive).digest('hex')
    const published = /^([0-9a-fA-F]{64})\s+\*?(\S+)/u.exec(Buffer.from(sidecar).toString('utf8').trim())
    if (!published || published[2] !== file || published[1]!.toLowerCase() !== sha256) throw new UpdateStopped('desktop-checksum-mismatch', 'check')
    return { file, sha256 }
  }
  /** What happened, what runs now, and what to do: the three sentences a failure shows. */
  private describe(entry: Entry, stopped: UpdateStopped): HostUpdateFailure {
    const { name, from } = entry, to = this.options.version
    const kept = `${name} still runs ${from}. Nothing was lost.`
    const byHand = `Try again, or update it by hand on ${name} with the commands below.`
    const say = (message: string, next = byHand, keptNow = kept): HostUpdateFailure => ({ step: stopped.step, message, kept: keptNow, next })
    const platform = (stopped.detail.file ?? entry.file)?.replace(/^Sotto-host-[\d.]+-/u, '').replace(/\.tar\.gz$/u, '')
    switch (stopped.reason) {
      case 'desktop-unreachable': return say(`${name} could not download ${to} from GitHub, and this computer could not download it either.`, `Check that this computer and ${name} are online, then try again, or update it by hand on ${name}.`)
      case 'copy-incomplete': return say(`${name} could not reach GitHub, so this computer downloaded ${to}, but copying it to ${name} over SSH stopped partway.`, `Check that ${name} is online, then try again, or update it by hand on ${name}.`)
      case 'download-unreachable': case 'download-failed': return say(`${name} could not download ${to} from GitHub.`, `Check that ${name} is online, then try again, or update it by hand on ${name}.`)
      case 'archive-unavailable': return say(`The releases page has no Sotto ${to} host for ${name}${platform ? `'s system (${platform})` : ''}.`, `Keep using ${from}, or update it by hand on ${name} once one is published.`)
      case 'checksum-mismatch': return say(`The download on ${name} did not match the release's checksum, so Sotto deleted it and installed nothing.`, `Try again to download it fresh, or update it by hand on ${name}.`)
      case 'desktop-checksum-mismatch': return say(`The download on this computer did not match the release's checksum, so Sotto installed nothing on ${name}.`, `Try again to download it fresh, or update it by hand on ${name}.`)
      case 'unpack-failed': return say(`Sotto ${to} could not be unpacked on ${name}, so nothing was installed.`)
      case 'archive-invalid': return say(`The archive on the releases page is not the Sotto ${to} host, so nothing was installed on ${name}.`, `Keep using ${from}, and tell whoever publishes Sotto's releases.`)
      case 'node-unsupported': return say(`Sotto ${to}'s host needs Node ${stopped.detail.range ?? 'another version'}, and ${name} runs Node ${stopped.detail.node ?? 'another version'}, so nothing was installed.`, `Install that Node for the SSH account on ${name}, then try again.`)
      case 'update-busy': return say(`Another Sotto is updating the host on ${name} right now, so this one stopped before changing anything.`, 'Wait a minute, then try again.')
      case 'update-not-owned': return say(`Sotto did not start the host now running on ${name}, so it did not restart it. ${to} is installed beside ${from}.`, `Stop the host on ${name}, then connect to it again from Settings > Hosts, and Sotto starts ${to}.`)
      case 'restart-not-sent': return say(`Sotto could not ask ${name}'s host to restart, so ${to} is installed beside ${from}, which still runs.`, `Try again, or press Stop host for ${name} in Settings > Hosts and switch it on again, which starts ${to}.`)
      case 'update-stop-failed': return say(`${name}'s host did not stop, so Sotto left ${from} running.`, `Try again, or stop the host on ${name} by hand, then connect to it again.`)
      case 'update-start-failed': return stopped.detail.restarted
        ? say(`${to} installed on ${name}, but its host did not start, so Sotto started ${from} again.`, `Try again, or see what the new host says: press Stop host for ${name} in Settings > Hosts, then run the commands below on ${name}.`, `${name}'s threads are back. Nothing was lost.`)
        : say(`${to} installed on ${name}, but its host did not start, and ${from} did not start again either.`, `Run the commands below on ${name} to see what the host says, then connect to it again from Settings > Hosts.`, `Nothing on ${name} was lost: its threads are saved there.`)
      case 'update-wrong-version': return say(`${name} restarted, but its host says it runs ${stopped.detail.version ?? from}.`, byHand, `${name}'s threads are back. Nothing was lost.`)
      case 'update-lost':
        if (stopped.step !== 'restart') return say(`The connection to ${name} closed during the update, before anything was switched.`)
        return stopped.detail.version
          ? say(`The connection to ${name} closed while its host restarted, and it came back on ${stopped.detail.version}.`, byHand, `${name}'s threads are back. Nothing was lost.`)
          : say(`The connection to ${name} closed while its host restarted, so Sotto cannot tell which version is running.`, `Sotto keeps connecting to ${name}. If it still runs ${from}, it shows here again.`, `Nothing on ${name} was lost.`)
      default: return say(`Sotto could not ${STEP_VERBS[stopped.step](to)} on ${name}.`)
    }
  }
  /** The commands that update the host by hand, which the panel offers to copy. Sotto never runs them. */
  private commands(entry: Entry): string {
    const to = this.options.version, install = shellPath(entry.installPath), data = shellPath(entry.dataDirectory)
    if (entry.reason === 'update-start-failed') {
      return [`# On ${entry.name}, with its host stopped, to see what ${to} says:`, `cd ${install}/versions/${to}`, `node host/index.js --data ${data}`].join('\n')
    }
    const file = entry.file ?? hostArchiveName(to)
    const url = `${this.releasesUrl.replace(/\/+$/u, '')}/v${to}/${file}`
    return [`# On ${entry.name}:`, `cd ${install}`, `curl -fLO ${url}`, `curl -fLO ${url}.sha256`, `${file.includes('-darwin-') ? 'shasum -a 256 -c' : 'sha256sum -c'} ${file}.sha256`,
      `mkdir -p versions/${to} && tar -xzf ${file} -C versions/${to}`, `printf '${to}\\n' > current`,
      entry.owned ? `# Then press Stop host for ${entry.name} in Settings > Hosts, and switch ${entry.name} on again.`
        : `# Then stop the host on ${entry.name}, and connect to it again from Settings > Hosts.`].join('\n')
  }
  private view(entry: Entry): HostUpdateState {
    const error = entry.error ?? (this.options.requiresManagementUpdate?.(entry.hostId) ? LEGACY_MANAGEMENT_UPDATE : undefined)
    return { id: entry.id, name: entry.name, from: entry.from, to: this.options.version, phase: entry.phase, owned: entry.owned,
      working: this.working(entry).length, commands: this.commands(entry), ...(entry.boot ? { boot: true } : {}),
      ...(entry.step ? { step: entry.step } : {}), ...(entry.route ? { route: entry.route } : {}),
      ...(entry.failure ? { failure: entry.failure } : {}), ...(error ? { error } : {}) }
  }
  private working(entry: Entry): readonly string[] { return this.options.threads.working(entry.hostId) }
  private refresh(entry: Entry, candidate: HostUpdateCandidate): void {
    Object.assign(entry, { name: candidate.name, hostId: candidate.hostId, owned: candidate.owned, installPath: candidate.installPath, dataDirectory: candidate.dataDirectory, boot: candidate.boot === true })
    if (entry.phase !== 'done') entry.from = candidate.version
  }
  private needsUpdate(candidate: HostUpdateCandidate): boolean {
    return hostIsOlder(candidate.version, this.options.version)
      || !hostIsNewer(candidate.version, this.options.version) && this.options.requiresManagementUpdate?.(candidate.hostId) === true
  }
  /**
   * Follows the saved hosts and their threads: a host that answers with an older Sotto needs an update, one that no
   * longer does, or has gone, drops out unless its update is running or has something to say, and a host waiting for
   * its threads starts once none is working.
   */
  private sync(changed = false): void {
    const candidates = this.options.hosts.candidates()
    const seen = new Set<string>()
    for (const candidate of candidates) {
      seen.add(candidate.id)
      const older = this.needsUpdate(candidate)
      const entry = this.entries.get(candidate.id)
      if (!entry) {
        if (older) this.entries.set(candidate.id, { ...candidate, from: candidate.version, phase: 'needs' })
        continue
      }
      if (entry.phase === 'updating' || entry.phase === 'done') continue
      if (!older) { this.entries.delete(candidate.id); this.notNow.delete(candidate.id); continue }
      this.refresh(entry, candidate)
      // Waiting, or asking, for threads that have all finished: the user has already pressed Update.
      if (idleNow(entry.phase, this.working(entry).length)) { this.begin(entry); return }
    }
    for (const [id, entry] of this.entries) {
      if (!seen.has(id) && (entry.phase === 'needs' || entry.phase === 'confirm' || entry.phase === 'waiting')) this.entries.delete(id)
    }
    const next = JSON.stringify(this.state())
    if (!changed && next === this.published) return
    this.published = next
    for (const listener of this.listeners) listener()
  }
}
