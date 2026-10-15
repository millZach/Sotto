import { createHash } from 'node:crypto'
import { hostIsNewer, hostIsOlder, LEGACY_MANAGEMENT_UPDATE } from '../../shared/hostProtocol'
import { HOST_ARCHIVE_PATTERN, HOST_VERSION_PATTERN, HOST_RELEASES_URL, hostArchiveName, type HostUpdateAction, type HostUpdateFailure, type HostUpdatePhase, type HostUpdateRoute, type HostUpdateState, type HostUpdateStep } from '../../shared/hostUpdates'
import { getReleaseTrack } from '../../shared/releaseTrack'
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
  /** This computer's Sotto version: what an update installs, unless Update all has a later one waiting (`pending`). */
  readonly version: string
  /** Where releases are published; tests serve their own. */
  readonly releasesUrl?: string
  /** This computer's own download, for a host that cannot reach the releases page. */
  readonly download?: (url: string, limit: number, signal: AbortSignal) => Promise<Uint8Array>
  /**
   * Whether a release file is published: true, false for a 404, or undefined when the releases page did not say. A HEAD
   * request from this computer unless a test says.
   */
  readonly probe?: (url: string, signal: AbortSignal) => Promise<boolean | undefined>
}
/**
 * The systems a host archive is published for, as the launch script names its own (`process.platform-process.arch`).
 * Before Sotto has heard which one a host runs, any of them published for a version says the release has host archives.
 */
const HOST_SYSTEMS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'] as const
interface Entry {
  id: string; name: string; hostId: string; from: string; owned: boolean; installPath: string; dataDirectory: string; boot?: boolean | undefined
  /** The version this update installs: set while it is offered, and kept from the moment it starts. */
  to: string
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
/** Full Owl build order for the explicit host target; protocol v1's general version comparison stays unchanged. */
export function compareOwlHostTarget(hostVersion: string, targetVersion: string): number | undefined {
  if (getReleaseTrack(targetVersion) !== 'owl' || !HOST_VERSION_PATTERN.test(hostVersion)) return undefined
  const parts = (value: string): bigint[] => value.split(/\.|-owl\./u).map(value => BigInt(value))
  const host = parts(hostVersion), target = parts(targetVersion)
  for (let i = 0; i < 3; i++) { if (host[i]! < target[i]!) return -1; if (host[i]! > target[i]!) return 1 }
  // A same-core stable host can be explicitly moved to this chosen Owl build.
  if (host.length === 3) return -1
  for (let i = 3; i < 5; i++) { if (host[i]! < target[i]!) return -1; if (host[i]! > target[i]!) return 1 }
  return 0
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
/** A HEAD request. A redirect to where GitHub keeps the file counts as published, and is not followed. */
async function probeHere(url: string, signal: AbortSignal): Promise<boolean | undefined> {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
    if (response.status === 404) return false
    return response.ok || response.status >= 300 && response.status < 400 ? true : undefined
  } catch { return undefined }
}
/** Whether `target` is later than `version`: by the Owl build order for an Owl target, and by release number otherwise. */
function laterThan(target: string, version: string): boolean {
  return getReleaseTrack(target) === 'owl' ? compareOwlHostTarget(version, target) === -1 : hostIsOlder(version, target)
}

/**
 * Host updates (ADR-0040): every saved host that runs an older Sotto than this computer, and each one's update. Nothing
 * starts until the user presses Update, and each host is updated on its own. It lives in memory: Not now lasts until
 * Sotto next starts, and so does a failure's note.
 *
 * With Update all on (ADR-0077), a host is aimed at the version this computer is downloading, or has downloaded, once
 * the releases page has its host archive, so it is updated before Sotto restarts. Until then, and for a host whose
 * archive is not published, it is aimed at this computer's own version, as before.
 */
export class HostUpdates {
  private readonly entries = new Map<string, Entry>()
  /** Saved hosts the user answered Not now for. They stay hidden until Sotto next starts, whatever reconnects meanwhile. */
  private readonly notNow = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private published = '[]'
  private readonly off: (() => void)[]
  private readonly releasesUrl: string
  /** The host version this computer's waiting update brings (ADR-0077), while it is later than this computer's own. */
  private waiting: string | undefined
  /** What the releases page said of a version's host archive, by `<version> <system>`, with `*` for a system not yet known. */
  private readonly archives = new Map<string, 'checking' | 'published' | 'missing' | 'unknown'>()
  /** Each saved host's system, as the archive name it asked for says: `linux-x64`. */
  private readonly systems = new Map<string, string>()
  private readonly probing = new AbortController()
  constructor(private readonly options: HostUpdatesOptions) {
    this.releasesUrl = options.releasesUrl ?? HOST_RELEASES_URL
    this.off = [options.hosts.subscribe(() => this.sync()), options.threads.subscribe(() => this.sync())]
    this.sync()
  }
  /**
   * The host version that the update this computer is downloading, or has downloaded, brings; undefined when there is
   * none (ADR-0077). Main calls it when the update moves to another phase, never for a download's progress, so a releases
   * page that did not answer, or had no host archive yet, is asked again at most that often.
   */
  pending(version: string | undefined): void {
    for (const [key, answer] of this.archives) if (answer === 'unknown' || answer === 'missing') this.archives.delete(key)
    this.waiting = version !== undefined && HOST_VERSION_PATTERN.test(version) && laterThan(version, this.options.version) ? version : undefined
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
    this.probing.abort()
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
    if ((entry.step !== 'download' && entry.step !== 'check') || entry.installing) throw new Error(`${entry.name} is already installing ${entry.to}, which cannot be stopped partway. Nothing was changed.`)
    const run = entry.run
    delete entry.run
    Object.assign(entry, { phase: 'needs', step: undefined, route: undefined })
    run?.abort()
  }
  private begin(entry: Entry): void {
    const run = new AbortController()
    entry.run?.abort()
    // The version is fixed here: a target that moves later is for the next update. One that has moved back while the
    // host waited for its threads may no longer be later than what the host runs, and nothing is installed then.
    const candidate = this.options.hosts.candidates().find(item => item.id === entry.id)
    if (candidate && !this.needsUpdate(candidate)) { this.entries.delete(entry.id); this.sync(true); return }
    Object.assign(entry, { phase: 'updating', step: 'download', route: 'host', failure: undefined, reason: undefined, error: undefined, installing: false, run,
      to: candidate ? this.target(candidate) : entry.to })
    this.sync(true)
    void this.carryOut(entry, run)
  }
  /** The four steps. A failure at any of them leaves the old version running, or starts it again, and says so. */
  private async carryOut(entry: Entry, run: AbortController): Promise<void> {
    const to = entry.to, signal = run.signal
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
    const to = entry.to
    const fetched = await this.options.hosts.run(entry.id, { op: 'update-fetch', version: to, releasesUrl: this.releasesUrl }, { signal, onStep })
    if (fetched.type === 'update-fetched') { this.learn(entry, fetched.file); return { file: fetched.file, sha256: fetched.sha256 } }
    if (fetched.type !== 'error') throw new UpdateStopped('update-failed', 'download')
    if (fetched.file) this.learn(entry, fetched.file)
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
    const { name, from, to } = entry
    const kept = `${name} still runs ${from}. Nothing was lost.`
    const byHand = `Try again, or update it by hand on ${name} with the commands below.`
    const say = (message: string, next = byHand, keptNow = kept): HostUpdateFailure => ({ step: stopped.step, message, kept: keptNow, next })
    const platform = (stopped.detail.file ?? entry.file)?.replace(/^Sotto-host-\d+\.\d+\.\d+(?:-owl\.\d{8}\.[1-9]\d*)?-/u, '').replace(/\.tar\.gz$/u, '')
    switch (stopped.reason) {
      case 'desktop-unreachable': return say(`${name} could not download ${to} from GitHub, and this computer could not download it either.`, `Check that this computer and ${name} are online, then try again, or update it by hand on ${name}.`)
      case 'copy-incomplete': return say(`${name} could not reach GitHub, so this computer downloaded ${to}, but copying it to ${name} over SSH stopped partway.`, `Check that ${name} is online, then try again, or update it by hand on ${name}.`)
      case 'download-unreachable': case 'download-failed': return say(`${name} could not download ${to} from GitHub.`, `Check that ${name} is online, then try again, or update it by hand on ${name}.`)
      case 'archive-unavailable': return say(`The releases page has no Sotto ${to} host for ${name}${platform ? `'s system (${platform})` : ''}.`, `Keep using ${from}, or update it by hand on ${name} once one is published.`)
      case 'checksum-mismatch': return say(`The download on ${name} did not match the release's checksum, so Sotto deleted it and installed nothing.`, `Try again to download it fresh, or update it by hand on ${name}.`)
      case 'desktop-checksum-mismatch': return say(`The download on this computer did not match the release's checksum, so Sotto installed nothing on ${name}.`, `Try again to download it fresh, or update it by hand on ${name}.`)
      case 'unpack-failed': return say(`Sotto ${to} could not be unpacked on ${name}, so nothing was installed.`)
      case 'archive-invalid': return say(`The archive on the releases page is not the Sotto ${to} host, so nothing was installed on ${name}.`, `Keep using ${from}, and tell whoever publishes Sotto's releases.`)
      case 'update-version-conflict': return say(`The existing versions/${to} folder on ${name} differs from the release. Sotto kept it unchanged.`, `Use a newer Sotto build, or stop the host on ${name}, keep that folder as a backup and move it aside before trying again.`)
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
    const to = entry.to, install = shellPath(entry.installPath), data = shellPath(entry.dataDirectory)
    if (entry.reason === 'update-start-failed') {
      return [`# On ${entry.name}, with its host stopped, to see what ${to} says:`, `cd ${install}/versions/${to}`, `node host/index.js --data ${data}`].join('\n')
    }
    if (entry.reason === 'update-version-conflict') {
      return [`# On ${entry.name}, inspect the existing folder before changing it:`, `cd ${install}`, `ls -ld versions/${to}`,
        `cat versions/${to}/package.json`, `cat versions/${to}/runtime-manifest.json`,
        '# Keep this folder as a backup. Do not unpack a different build over it.',
        '# Use a newer Sotto build, or stop the host and move this folder aside before pressing Try again.'].join('\n')
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
    return { id: entry.id, name: entry.name, from: entry.from, to: entry.to, phase: entry.phase, owned: entry.owned,
      working: this.working(entry).length, commands: this.commands(entry), ...(entry.boot ? { boot: true } : {}),
      ...(entry.step ? { step: entry.step } : {}), ...(entry.route ? { route: entry.route } : {}),
      ...(entry.failure ? { failure: entry.failure } : {}), ...(error ? { error } : {}) }
  }
  private working(entry: Entry): readonly string[] { return this.options.threads.working(entry.hostId) }
  private refresh(entry: Entry, candidate: HostUpdateCandidate): void {
    Object.assign(entry, { name: candidate.name, hostId: candidate.hostId, owned: candidate.owned, installPath: candidate.installPath, dataDirectory: candidate.dataDirectory, boot: candidate.boot === true })
    if (entry.phase !== 'done') entry.from = candidate.version
    // An offer follows the target; an update that has started, finished or failed keeps the version it was for.
    if (entry.phase === 'needs' || entry.phase === 'confirm' || entry.phase === 'waiting') entry.to = this.target(candidate)
  }
  /**
   * The version an update of this host installs: the one this computer's waiting update brings, once its host archive is
   * published for the host's system, and this computer's own otherwise (ADR-0077 decision 6).
   */
  private target(candidate: HostUpdateCandidate): string {
    const waiting = this.waiting
    return waiting && this.archives.get(this.archiveKey(waiting, candidate.id)) === 'published' ? waiting : this.options.version
  }
  private archiveKey(version: string, id: string): string { return `${version} ${this.systems.get(id) ?? '*'}` }
  /** Keeps the archive a host asked for, whose name says its system, so a later check asks for that system's alone. */
  private learn(entry: Entry, file: string): void {
    entry.file = file
    const system = /-([a-z0-9]+-[a-z0-9]+)\.tar\.gz$/u.exec(file)?.[1]
    if (system) this.systems.set(entry.id, system)
  }
  /**
   * Asks the releases page, once for each version and system, whether a host archive and its checksum are published,
   * before a host is offered that version. For a host whose system is not known yet, any system's archive answers; one
   * whose own is missing is told so by its download, as before. Nothing is offered while the page does not answer.
   */
  private checkArchive(version: string, id: string): void {
    const key = this.archiveKey(version, id)
    if (this.archives.has(key)) return
    this.archives.set(key, 'checking')
    const system = this.systems.get(id)
    void this.archivePublished(version, system ? [system] : HOST_SYSTEMS).then(found => {
      if (this.probing.signal.aborted || this.archives.get(key) !== 'checking') return
      this.archives.set(key, found === undefined ? 'unknown' : found ? 'published' : 'missing')
      this.sync()
    })
  }
  private async archivePublished(version: string, systems: readonly string[]): Promise<boolean | undefined> {
    const probe = this.options.probe ?? probeHere, signal = this.probing.signal
    // Asking for a host whose system is not known yet, each system's answer is kept too, so learning it asks nothing again.
    const answer = (system: string, published: boolean): void => { if (systems.length > 1 && !signal.aborted) this.archives.set(`${version} ${system}`, published ? 'published' : 'missing') }
    for (const system of systems) {
      const [platform, arch] = system.split('-') as [string, string]
      const url = `${this.releasesUrl.replace(/\/+$/u, '')}/v${version}/${hostArchiveName(version, platform, arch)}`
      const archive = await probe(url, signal).catch(() => undefined)
      if (archive === undefined) return undefined
      const published = archive && await probe(`${url}.sha256`, signal).catch(() => undefined)
      if (published === undefined) return undefined
      answer(system, published)
      if (published) return true
    }
    return false
  }
  private needsUpdate(candidate: HostUpdateCandidate): boolean {
    const target = this.target(candidate)
    if (getReleaseTrack(target) === 'owl') {
      const comparison = compareOwlHostTarget(candidate.version, target)
      return comparison !== undefined && (comparison < 0 || comparison === 0 && this.options.requiresManagementUpdate?.(candidate.hostId) === true)
    }
    return hostIsOlder(candidate.version, target)
      || !hostIsNewer(candidate.version, target) && this.options.requiresManagementUpdate?.(candidate.hostId) === true
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
      // A host behind the waiting update is offered it once the releases page has its archive.
      if (this.waiting && laterThan(this.waiting, candidate.version)) this.checkArchive(this.waiting, candidate.id)
      const older = this.needsUpdate(candidate)
      const entry = this.entries.get(candidate.id)
      if (!entry) {
        if (older) this.entries.set(candidate.id, { ...candidate, from: candidate.version, to: this.target(candidate), phase: 'needs' })
        continue
      }
      if (entry.phase === 'updating') continue
      // A finished update makes way for the next one, as when Sotto finds a newer version of itself later in the session.
      if (entry.phase === 'done') {
        if (older && entry.to !== this.target(candidate)) this.entries.set(candidate.id, { ...candidate, from: candidate.version, to: this.target(candidate), phase: 'needs' })
        continue
      }
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
