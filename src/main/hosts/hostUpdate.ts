import { i18n } from '@lingui/core'
import { plural, t } from '@lingui/core/macro'
import { createHash } from 'node:crypto'
import { LEGACY_MANAGEMENT_UPDATE } from '../../shared/hostProtocol'
import { compareHostToTarget } from '../../shared/hostSelfUpdate'
import { compareOwlHostTarget, HOST_ARCHIVE_PATTERN, HOST_VERSION_PATTERN, HOST_RELEASES_URL, hostArchiveName, type HostUpdateAction, type HostUpdateFailure, type HostUpdatePhase, type HostUpdateRoute, type HostUpdateState, type HostUpdateStep } from '../../shared/hostUpdates'
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
  /**
   * The host's system as its launch script named it, `linux-x64`, which names the archive an update downloads. While it
   * is absent, as before Sotto has launched or reached the host over SSH, the host is not offered a version ahead of
   * this computer's (ADR-0077).
   */
  readonly system?: string | undefined
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
/**
 * What an update needs of a host's client update line (ADR-0042): whether it is running, as last published. The router
 * answers in place, without building a state, because it is asked on every change.
 */
export interface HostUpdateClients {
  /** Whether a client waits in the host's update line or is updating there. */
  updating(hostId: string): boolean
  /** Told when the line may have moved. Main leaves it out: the router's changes already reach an update through its threads. */
  subscribe?(listener: () => void): () => void
}
export interface HostUpdatesOptions {
  readonly requiresManagementUpdate?: (hostId: string) => boolean
  readonly hosts: HostUpdateHosts
  readonly threads: HostUpdateThreads
  /**
   * The hosts' client update lines. A host's own update waits while its line is running, whatever started it, so its
   * restart cuts no client update off (ADR-0077 decision 2). Without it no line is ever running.
   */
  readonly clients?: HostUpdateClients | undefined
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
/** What the releases page said of a host archive and its checksum: not yet, both there, not both there, or no answer. */
type ArchiveAnswer = 'checking' | 'published' | 'missing' | 'unknown'
interface Entry {
  id: string; name: string; hostId: string; from: string; owned: boolean; installPath: string; dataDirectory: string; boot?: boolean | undefined
  /** The version this update installs: set while it is offered, and kept from the moment it starts. */
  to: string
  phase: HostUpdatePhase; step?: HostUpdateStep | undefined; route?: HostUpdateRoute | undefined
  /**
   * Why the update stopped, and the names its sentences use as they were then. The sentences are worded when the panel
   * reads them, in the interface language shown then (ADR-0123); `shown` keeps the last wording for that language.
   */
  stopped?: StoppedUpdate | undefined
  shown?: { readonly locale: string; readonly stopped: StoppedUpdate; readonly failure: HostUpdateFailure } | undefined
  /** Why the last press was refused: the host was not connected. Worded when the panel reads it. */
  error?: 'not-connected' | undefined
  /** The refusal as last worded: for which host name, in which language. */
  shownError?: { readonly locale: string; readonly name: string; readonly error: string } | undefined
  /** The launch script's code, or this computer's, for the failure shown. */
  reason?: string | undefined
  /** The archive the host asked for, which names its platform. */
  file?: string | undefined
  /** The update running, which Cancel update aborts. */
  run?: AbortController | undefined
  /** Set once the host has been asked to unpack: from there nothing is cancelled, whatever step the panel shows. */
  installing?: boolean | undefined
  /**
   * Pressed while the releases page was still being asked about the waiting version's host archive: the update shows as
   * started and fixes its version once the page answers, so one press downloads and restarts once.
   */
  held?: boolean | undefined
  /** The waiting version this update was installing went away partway, too late to stop: the card says so once it is done. */
  withdrawn?: boolean | undefined
}
/** A stopped update as the entry keeps it: the stop, and the host's name and versions its sentences name. */
interface StoppedUpdate { readonly stop: UpdateStopped; readonly name: string; readonly from: string; readonly to: string; readonly file?: string | undefined }
/** What a failure's sentence names: the archive, whether the old host started again, a Node range and version, a host version. */
interface StopDetail { readonly file?: string | undefined; readonly restarted?: boolean | undefined; readonly range?: string | undefined; readonly node?: string | undefined; readonly version?: string | undefined }
/** A failure the update itself found, with the launch script's code, or a code of its own for this computer's part. */
class UpdateStopped extends Error {
  constructor(readonly reason: string, readonly step: HostUpdateStep, readonly detail: StopDetail = {}) { super(reason) }
}
/** What a step that stopped for a reason of its own says, one whole sentence per step. */
const STEP_STOPPED: Readonly<Record<HostUpdateStep, (to: string, name: string) => string>> = {
  download: (to, name) => t`Sotto could not download ${to} on ${name}.`, check: (_to, name) => t`Sotto could not check the download on ${name}.`,
  install: (to, name) => t`Sotto could not install ${to} on ${name}.`, restart: (_to, name) => t`Sotto could not restart the host on ${name}.`,
}
export { compareOwlHostTarget }
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
/** Where GitHub serves a release's files from, which the README's "Privacy and cost" names beside `github.com`. */
const RELEASE_ASSET_HOST = 'release-assets.githubusercontent.com'
/**
 * What a HEAD answer says of a release file: published for a 2xx, or for a redirect to where GitHub keeps release files;
 * not published for a 404; and no answer for anything else, such as a redirect to a sign-in or error page.
 */
export function publishedAnswer(status: number, location: string | null): boolean | undefined {
  if (status === 404) return false
  if (status >= 200 && status < 300) return true
  if (status < 300 || status >= 400 || location === null) return undefined
  try {
    const target = new URL(location)
    return target.protocol === 'https:' && target.hostname === RELEASE_ASSET_HOST ? true : undefined
  } catch { return undefined }
}
/** A HEAD request. A redirect to where GitHub keeps the file counts as published, and is not followed. */
async function probeHere(url: string, signal: AbortSignal): Promise<boolean | undefined> {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
    return publishedAnswer(response.status, response.headers.get('location'))
  } catch { return undefined }
}
/** The rule a host that updates itself checks a version against too (ADR-0088). */
const compareToTarget = compareHostToTarget
const behind = (version: string, target: string): boolean => compareToTarget(version, target) === -1

/**
 * Host updates (ADR-0040): every saved host that runs an older Sotto than this computer, and each one's update. Nothing
 * starts until the user presses Update, and each host is updated on its own. It lives in memory: Not now lasts until
 * Sotto next starts, and so does a failure's note.
 *
 * With Update all on (ADR-0077), a host is aimed at the version this computer is downloading, or has downloaded, once
 * the releases page has the host archive for the host's own system, so it is updated before Sotto restarts. Until then,
 * for a host whose archive is not published, and for one whose system Sotto has not heard, it is aimed at this
 * computer's own version, as before.
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
  /** What the releases page said of a version's host archive, by `<version> <system>`. */
  private readonly archives = new Map<string, ArchiveAnswer>()
  /** Each saved host's system as the archive name its download asked for says, `linux-x64`, when its launch did not say. */
  private readonly systems = new Map<string, string>()
  private readonly probing = new AbortController()
  /** Installed updates holding their restart for the host's client update line, each told on every change to look again. */
  private readonly restarts = new Set<() => void>()
  constructor(private readonly options: HostUpdatesOptions) {
    this.releasesUrl = options.releasesUrl ?? HOST_RELEASES_URL
    this.off = [options.hosts.subscribe(() => this.sync()), options.threads.subscribe(() => this.sync())]
    if (options.clients?.subscribe) this.off.push(options.clients.subscribe(() => this.sync()))
    this.sync()
  }
  /**
   * The host version that the update this computer is downloading, or has downloaded, brings; undefined when there is
   * none (ADR-0077). Main calls it when the update moves to another phase, never for a download's progress, so a releases
   * page that did not answer, or had no host archive yet, is asked again at most that often.
   */
  pending(version: string | undefined): void {
    for (const [key, answer] of this.archives) if (answer === 'unknown' || answer === 'missing') this.archives.delete(key)
    const before = this.waiting
    this.waiting = version !== undefined && HOST_VERSION_PATTERN.test(version) && behind(this.options.version, version) ? version : undefined
    // The version this computer was downloading went away or changed: an update still downloading it stops, as Cancel
    // update would, and is offered again for the new target. One the host has begun to unpack finishes, and says so.
    if (before !== undefined && this.waiting !== before) {
      for (const entry of this.entries.values()) {
        if (entry.phase !== 'updating' || entry.held || entry.to !== before) continue
        if (entry.installing) { entry.withdrawn = true; continue }
        const run = entry.run
        delete entry.run
        Object.assign(entry, { phase: 'needs', step: undefined, route: undefined })
        run?.abort()
      }
    }
    this.sync()
  }
  /** Every host update to show, in the order the hosts were saved. A host the user said Not now to is left out. */
  state(): HostUpdateState[] {
    return [...this.entries.values()].filter(entry => !this.notNow.has(entry.id)).map(entry => this.view(entry))
  }
  /**
   * Saved hosts behind the version this computer is downloading whose host archive the releases page has not answered
   * for yet (ADR-0077): each may be offered that version in a moment, so Update all counts it in and the restart waits.
   */
  checking(): string[] {
    const waiting = this.waiting
    if (!waiting) return []
    return this.options.hosts.candidates()
      .filter(candidate => !this.notNow.has(candidate.id) && behind(candidate.version, waiting) && this.archive(waiting, candidate) === 'checking')
      .map(candidate => candidate.id)
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  /** Why another command on this saved host must wait, while its update is under way. */
  busy(id: string): string | undefined {
    const entry = this.entries.get(id)
    return entry?.phase === 'updating' ? t`Sotto is updating the host on ${{ host: entry.name }}. Nothing was changed. Wait for the update to finish, then try again.` : undefined
  }
  /**
   * Why Sotto must not restart into its update now: a host update is under way, and the restart would close the SSH
   * connection it runs over. Undefined when none is.
   */
  restartHold(): string | undefined {
    const names = [...this.entries.values()].filter(entry => entry.phase === 'updating').map(entry => entry.name)
    if (!names.length) return undefined
    const one = names.length === 1
    const host = names[0]!, hosts = names.slice(0, -1).join(', '), last = names.at(-1)!, count = names.length
    const named = one
      ? t`Sotto did not restart while it was updating the host on ${host}. Nothing was lost. Restart again once that update has finished.`
      : t`Sotto did not restart while it was updating the hosts on ${hosts} and ${last}. Nothing was lost. Restart again once those updates have finished.`
    // An update's problem is at most 240 characters; long host names give way to a count.
    return named.length <= 240 ? named : one
      ? t`Sotto did not restart while it was updating a host. Nothing was lost. Restart again once that update has finished.`
      : plural(count, {
        one: 'Sotto did not restart while it was updating # host. Nothing was lost. Restart again once that update has finished.',
        other: 'Sotto did not restart while it was updating # hosts. Nothing was lost. Restart again once those updates have finished.',
      })
  }
  /**
   * Sotto is quitting. A download still under way stops, as Cancel update would. An update the host has begun to unpack
   * is left alone: its launch script finishes the install and the restart on the host after the connection closes, so
   * the host is left on one version or the other, never between them.
   */
  dispose(): void {
    for (const off of this.off) off()
    for (const entry of this.entries.values()) if (!entry.installing) entry.run?.abort()
    this.probing.abort()
    this.restarts.clear()
    this.listeners.clear()
  }

  async command(id: string, action: HostUpdateAction): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(t`This host no longer needs an update. Nothing was changed.`)
    delete entry.error
    try {
      if (action === 'update') this.update(entry)
      else if (action === 'when-idle') { if (entry.phase === 'confirm') { if (whenIdle(this.workingNow(entry).length) === 'waiting' || this.clientsUpdating(entry)) entry.phase = 'waiting'; else this.begin(entry) } }
      else if (action === 'stop-threads') { if (entry.phase === 'confirm' || entry.phase === 'waiting') await this.stopThreadsAndUpdate(entry) }
      else if (action === 'cancel') this.cancel(entry)
      else if (action === 'not-now') {
        if (entry.phase === 'updating') throw new Error(t`The update of ${{ host: entry.name }} is under way and cannot be hidden. Nothing was changed.`)
        this.notNow.add(id)
        if (entry.phase === 'confirm' || entry.phase === 'waiting') entry.phase = 'needs'
      }
      else if (entry.phase === 'done' || entry.phase === 'failed') this.entries.delete(id)
    } finally { this.sync(true) }
  }

  /**
   * Update and Try again: at once on a host with nothing working, or a question first when something is. A host whose
   * client update line is running waits for it either way (`begin`).
   */
  private update(entry: Entry): void {
    if (entry.phase !== 'needs' && entry.phase !== 'failed') return
    if (!entry.owned) throw new Error(t`Sotto did not start the host on ${{ host: entry.name }}, so it cannot restart it. Nothing was changed. Update it on ${{ host: entry.name }} with the commands below.`)
    const candidate = this.options.hosts.candidates().find(item => item.id === entry.id)
    if (!candidate) { entry.error = 'not-connected'; return }
    this.refresh(entry, candidate)
    if (!this.needsUpdate(candidate)) { this.entries.delete(entry.id); return }
    if (this.workingNow(entry).length) { entry.phase = 'confirm'; delete entry.stopped; return }
    this.begin(entry)
  }
  private async stopThreadsAndUpdate(entry: Entry): Promise<void> {
    await stopWorkingThreads(this.options.threads, entry.hostId)
    if (entry.phase === 'confirm' || entry.phase === 'waiting') this.begin(entry)
  }
  private cancel(entry: Entry): void {
    if (entry.phase === 'confirm' || entry.phase === 'waiting') { entry.phase = 'needs'; return }
    if (entry.phase !== 'updating') return
    if ((entry.step !== 'download' && entry.step !== 'check') || entry.installing) throw new Error(t`${{ host: entry.name }} is already installing ${{ to: entry.to }}, which cannot be stopped partway. Nothing was changed.`)
    const run = entry.run
    delete entry.run
    Object.assign(entry, { phase: 'needs', step: undefined, route: undefined, held: undefined })
    run?.abort()
  }
  private begin(entry: Entry): void {
    // The host's client update line is running: the restart would cut its client off partway (ADR-0077 decision 2). The
    // update waits, and sync begins it once the line is empty. One pressed during the archive check has run nothing yet.
    if (this.clientsUpdating(entry)) {
      entry.run?.abort()
      Object.assign(entry, { phase: 'waiting', step: undefined, route: undefined, held: undefined, run: undefined, stopped: undefined, reason: undefined })
      this.sync(true)
      return
    }
    const run = new AbortController()
    entry.run?.abort()
    const candidate = this.options.hosts.candidates().find(item => item.id === entry.id)
    const start = { phase: 'updating', step: 'download', route: 'host', stopped: undefined, reason: undefined, error: undefined, installing: false, withdrawn: undefined, run } as const
    // The releases page has not yet said whether the waiting version's host is published: the update waits for its
    // answer before fixing the version, rather than installing this computer's and then the waiting one (sync resumes it).
    if (candidate && this.checkingFor(candidate)) { Object.assign(entry, start, { held: true }); this.sync(true); return }
    // The version is fixed here: a target that moves later is for the next update. One that has moved back while the
    // host waited for its threads may no longer be later than what the host runs, and nothing is installed then.
    if (candidate && !this.needsUpdate(candidate)) { this.entries.delete(entry.id); this.sync(true); return }
    Object.assign(entry, start, { held: undefined, to: candidate ? this.target(candidate) : entry.to })
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
      // A client put in the host's line after the download began would be cut off by the restart (ADR-0077 decision 2).
      // The install is done and stays: the restart waits for the line to empty, and Cancel update still refuses.
      await this.lineEmpty(entry, current)
      if (!current()) return
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
      Object.assign(entry, { phase: 'failed', stopped: { stop: stopped, name: entry.name, from: entry.from, to: entry.to, file: entry.file }, reason: stopped.reason, step: undefined })
    } finally { this.sync(true) }
  }
  /** Resolves once the host's client update line is empty, or the update is no longer the one running. */
  private lineEmpty(entry: Entry, current: () => boolean): Promise<void> {
    if (!this.clientsUpdating(entry)) return Promise.resolve()
    return new Promise(resolve => {
      const look = (): void => { if (current() && this.clientsUpdating(entry)) return; this.restarts.delete(look); resolve() }
      this.restarts.add(look)
    })
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
  private describe({ stop: stopped, name, from, to, file }: StoppedUpdate): HostUpdateFailure {
    const kept = t`${name} still runs ${from}. Nothing was lost.`
    const byHand = t`Try again, or update it by hand on ${name} with the commands below.`
    const back = (): string => t`${name}'s threads are back. Nothing was lost.`
    const say = (message: string, next = byHand, keptNow = kept): HostUpdateFailure => ({ step: stopped.step, message, kept: keptNow, next })
    const platform = (stopped.detail.file ?? file)?.replace(/^Sotto-host-\d+\.\d+\.\d+(?:-owl\.\d{8}\.[1-9]\d*)?-/u, '').replace(/\.tar\.gz$/u, '')
    switch (stopped.reason) {
      case 'desktop-unreachable': return say(t`${name} could not download ${to} from GitHub, and this computer could not download it either.`, t`Check that this computer and ${name} are online, then try again, or update it by hand on ${name}.`)
      case 'copy-incomplete': return say(t`${name} could not reach GitHub, so this computer downloaded ${to}, but copying it to ${name} over SSH stopped partway.`, t`Check that ${name} is online, then try again, or update it by hand on ${name}.`)
      case 'download-unreachable': case 'download-failed': return say(t`${name} could not download ${to} from GitHub.`, t`Check that ${name} is online, then try again, or update it by hand on ${name}.`)
      case 'archive-unavailable': return say(platform ? t`The releases page has no Sotto ${to} host for ${name}'s system (${platform}).` : t`The releases page has no Sotto ${to} host for ${name}.`, t`Keep using ${from}, or update it by hand on ${name} once one is published.`)
      case 'checksum-mismatch': return say(t`The download on ${name} did not match the release's checksum, so Sotto deleted it and installed nothing.`, t`Try again to download it fresh, or update it by hand on ${name}.`)
      case 'desktop-checksum-mismatch': return say(t`The download on this computer did not match the release's checksum, so Sotto installed nothing on ${name}.`, t`Try again to download it fresh, or update it by hand on ${name}.`)
      case 'unpack-failed': return say(t`Sotto ${to} could not be unpacked on ${name}, so nothing was installed.`)
      case 'archive-invalid': return say(t`The archive on the releases page is not the Sotto ${to} host, so nothing was installed on ${name}.`, t`Keep using ${from}, and tell whoever publishes Sotto's releases.`)
      case 'update-version-conflict': return say(t`The existing versions/${to} folder on ${name} differs from the release. Sotto kept it unchanged.`, t`Use a newer Sotto build, or stop the host on ${name}, keep that folder as a backup and move it aside before trying again.`)
      case 'node-unsupported': {
        const another = t({ message: 'another version', comment: 'Stands for a Node version Sotto could not read: "needs Node another version".' })
        const range = stopped.detail.range ?? another, node = stopped.detail.node ?? another
        return say(t`Sotto ${to}'s host needs Node ${range}, and ${name} runs Node ${node}, so nothing was installed.`, t`Install that Node for the SSH account on ${name}, then try again.`)
      }
      case 'update-busy': return say(t`Another Sotto is updating the host on ${name} right now, so this one stopped before changing anything.`, t`Wait a minute, then try again.`)
      case 'update-not-owned': return say(t`Sotto did not start the host now running on ${name}, so it did not restart it. ${to} is installed beside ${from}.`, t`Stop the host on ${name}, then connect to it again from Settings > Hosts & phones, and Sotto starts ${to}.`)
      case 'restart-not-sent': return say(t`Sotto could not ask ${name}'s host to restart, so ${to} is installed beside ${from}, which still runs.`, t`Try again, or press Stop host for ${name} in Settings > Hosts & phones and switch it on again, which starts ${to}.`)
      case 'update-stop-failed': return say(t`${name}'s host did not stop, so Sotto left ${from} running.`, t`Try again, or stop the host on ${name} by hand, then connect to it again.`)
      case 'update-start-failed': return stopped.detail.restarted
        ? say(t`${to} installed on ${name}, but its host did not start, so Sotto started ${from} again.`, t`Try again, or see what the new host says: press Stop host for ${name} in Settings > Hosts & phones, then run the commands below on ${name}.`, back())
        : say(t`${to} installed on ${name}, but its host did not start, and ${from} did not start again either.`, t`Run the commands below on ${name} to see what the host says, then connect to it again from Settings > Hosts & phones.`, t`Nothing on ${name} was lost: its threads are saved there.`)
      case 'update-wrong-version': {
        const version = stopped.detail.version ?? from
        return say(t`${name} restarted, but its host says it runs ${version}.`, byHand, back())
      }
      case 'update-lost':
        if (stopped.step !== 'restart') return say(t`The connection to ${name} closed during the update, before anything was switched.`)
        return stopped.detail.version
          ? say(t`The connection to ${name} closed while its host restarted, and it came back on ${{ version: stopped.detail.version }}.`, byHand, back())
          : say(t`The connection to ${name} closed while its host restarted, so Sotto cannot tell which version is running.`, t`Sotto keeps connecting to ${name}. If it still runs ${from}, it shows here again.`, t`Nothing on ${name} was lost.`)
      default: return say(STEP_STOPPED[stopped.step](to, name))
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
      entry.owned ? `# Then press Stop host for ${entry.name} in Settings > Hosts & phones, and switch ${entry.name} on again.`
        : `# Then stop the host on ${entry.name}, and connect to it again from Settings > Hosts & phones.`].join('\n')
  }
  private view(entry: Entry): HostUpdateState {
    const withdrawn = entry.phase === 'done' && entry.withdrawn
      ? t`${{ host: entry.name }} was already installing ${{ to: entry.to }} when this computer stopped updating to it, so it finished. Nothing was lost. ${{ host: entry.name }} runs a newer Sotto than this computer until this computer updates too.`
      : undefined
    const refused = entry.error === 'not-connected' ? this.notConnected(entry) : undefined
    const error = refused ?? withdrawn ?? (this.options.requiresManagementUpdate?.(entry.hostId) ? LEGACY_MANAGEMENT_UPDATE : undefined)
    const failure = entry.stopped ? this.failure(entry, entry.stopped) : undefined
    return { id: entry.id, name: entry.name, from: entry.from, to: entry.to, phase: entry.phase, owned: entry.owned,
      working: this.working(entry).length, commands: this.commands(entry), ...(entry.boot ? { boot: true } : {}),
      ...(this.clientsUpdating(entry) ? { clientsUpdating: true } : {}),
      ...(entry.step ? { step: entry.step } : {}), ...(entry.route ? { route: entry.route } : {}),
      ...(failure ? { failure } : {}), ...(error ? { error } : {}) }
  }
  /**
   * A stopped update's three sentences, worded once for each stop and interface language. The panel's state is read on
   * every change while a host waits for its clients, so the wording is not done again on each read.
   */
  private failure(entry: Entry, stopped: StoppedUpdate): HostUpdateFailure {
    if (entry.shown?.stopped === stopped && entry.shown.locale === i18n.locale) return entry.shown.failure
    const failure = this.describe(stopped)
    entry.shown = { locale: i18n.locale, stopped, failure }
    return failure
  }
  /** Retry's refusal for a host that is not connected, worded once for its name and the interface language. */
  private notConnected(entry: Entry): string {
    const shown = entry.shownError
    if (shown?.name === entry.name && shown.locale === i18n.locale) return shown.error
    const error = t`${{ host: entry.name }} is not connected, so nothing was updated. Switch it on in Settings > Hosts & phones, then try again.`
    entry.shownError = { locale: i18n.locale, name: entry.name, error }
    return error
  }
  /** The interface language changed: a failure or refusal on the panel is worded again in it (ADR-0123). */
  languageChanged(): void {
    if ([...this.entries.values()].some(entry => entry.stopped || entry.error || entry.withdrawn)) this.sync(true)
  }
  private working(entry: Entry): readonly string[] { return this.options.threads.working(entry.hostId) }
  private workingNow(entry: Entry): readonly string[] { return this.options.threads.workingNow(entry.hostId) }
  private clientsUpdating(entry: Entry): boolean { return this.options.clients?.updating(entry.hostId) === true }
  private refresh(entry: Entry, candidate: HostUpdateCandidate): void {
    Object.assign(entry, { name: candidate.name, hostId: candidate.hostId, owned: candidate.owned, installPath: candidate.installPath, dataDirectory: candidate.dataDirectory, boot: candidate.boot === true })
    if (entry.phase !== 'done') entry.from = candidate.version
    // An offer follows the target; an update that has started, finished or failed keeps the version it was for.
    if (entry.phase === 'needs' || entry.phase === 'confirm' || entry.phase === 'waiting') entry.to = this.target(candidate)
  }
  /**
   * The version an update of this host installs: the one this computer's waiting update brings, once its host archive is
   * published for the host's own system, and this computer's own otherwise (ADR-0077 decision 6).
   */
  private target(candidate: HostUpdateCandidate): string {
    const waiting = this.waiting
    return waiting && this.archive(waiting, candidate) === 'published' ? waiting : this.options.version
  }
  /** The host's system: as its launch named it, or as its last download did. Undefined until Sotto has heard either. */
  private system(candidate: HostUpdateCandidate): string | undefined { return candidate.system ?? this.systems.get(candidate.id) }
  /** What the releases page said of `version`'s archive for the host's own system; undefined until it has been asked. */
  private archive(version: string, candidate: HostUpdateCandidate): ArchiveAnswer | undefined {
    const system = this.system(candidate)
    return system === undefined ? undefined : this.archives.get(`${version} ${system}`)
  }
  /** Keeps the archive a host asked for, whose name says its system, so a later check asks for that system's alone. */
  private learn(entry: Entry, file: string): void {
    entry.file = file
    const system = /-([a-z0-9]+-[a-z0-9]+)\.tar\.gz$/u.exec(file)?.[1]
    if (system) this.systems.set(entry.id, system)
  }
  /**
   * Asks the releases page, once for each version and system, whether the host archive for the host's own system and its
   * checksum are published, before the host is offered that version. A host whose system Sotto has not heard is asked
   * nothing and keeps this computer's version: another system's archive says nothing about its own. Nothing is offered
   * while the page does not answer.
   */
  private checkArchive(version: string, candidate: HostUpdateCandidate): void {
    const system = this.system(candidate)
    if (system === undefined) return
    const key = `${version} ${system}`
    if (this.archives.has(key)) return
    this.archives.set(key, 'checking')
    void this.archivePublished(version, system).then(found => {
      if (this.probing.signal.aborted || this.archives.get(key) !== 'checking') return
      this.archives.set(key, found === undefined ? 'unknown' : found ? 'published' : 'missing')
      this.sync()
    })
  }
  private async archivePublished(version: string, system: string): Promise<boolean | undefined> {
    const probe = this.options.probe ?? probeHere, signal = this.probing.signal
    const [platform, arch] = system.split('-') as [string, string]
    const url = `${this.releasesUrl.replace(/\/+$/u, '')}/v${version}/${hostArchiveName(version, platform, arch)}`
    const archive = await probe(url, signal).catch(() => undefined)
    if (!archive) return archive
    return probe(`${url}.sha256`, signal).catch(() => undefined)
  }
  /** Whether the releases page is still being asked whether this host can be offered the waiting version. */
  private checkingFor(candidate: HostUpdateCandidate): boolean {
    const waiting = this.waiting
    return waiting !== undefined && behind(candidate.version, waiting) && this.archive(waiting, candidate) === 'checking'
  }
  private needsUpdate(candidate: HostUpdateCandidate): boolean {
    const order = compareToTarget(candidate.version, this.target(candidate))
    return order === -1 || order === 0 && this.options.requiresManagementUpdate?.(candidate.hostId) === true
  }
  /**
   * Follows the saved hosts and their threads: a host that answers with an older Sotto needs an update, one that no
   * longer does, or has gone, drops out unless its update is running or has something to say, and a host waiting for
   * its threads starts once none is working and its client update line is empty.
   */
  private sync(changed = false): void {
    // An installed update holding its restart for the client update line looks again: the router's changes arrive here.
    for (const look of [...this.restarts]) look()
    const candidates = this.options.hosts.candidates()
    const seen = new Set<string>()
    for (const candidate of candidates) {
      seen.add(candidate.id)
      // A host behind the waiting update is offered it once the releases page has its archive.
      if (this.waiting && behind(candidate.version, this.waiting)) this.checkArchive(this.waiting, candidate)
      const older = this.needsUpdate(candidate)
      const entry = this.entries.get(candidate.id)
      if (!entry) {
        if (older) this.entries.set(candidate.id, { ...candidate, from: candidate.version, to: this.target(candidate), phase: 'needs' })
        continue
      }
      if (entry.phase === 'updating') {
        // Pressed during the archive check, which has now answered: the update starts, aimed by that answer.
        if (entry.held && !this.checkingFor(candidate)) { this.begin(entry); return }
        continue
      }
      // A finished update makes way for the next one, as when Sotto finds a newer version of itself later in the session.
      if (entry.phase === 'done') {
        if (older && entry.to !== this.target(candidate)) this.entries.set(candidate.id, { ...candidate, from: candidate.version, to: this.target(candidate), phase: 'needs' })
        continue
      }
      if (!older) { this.entries.delete(candidate.id); this.notNow.delete(candidate.id); continue }
      this.refresh(entry, candidate)
      // Waiting, or asking, for threads that have all finished: the user has already pressed Update. A client update line
      // still running keeps it waiting. That is read first: it is read in place, where the threads as they are this moment
      // build every host's shell, and this runs on every change while a host waits for its clients.
      if (idleNow(entry.phase, this.working(entry).length)) {
        if (this.clientsUpdating(entry)) entry.phase = 'waiting'
        else if (!this.workingNow(entry).length) { this.begin(entry); return }
      }
    }
    for (const [id, entry] of this.entries) {
      if (!seen.has(id) && (entry.phase === 'needs' || entry.phase === 'confirm' || entry.phase === 'waiting' || entry.held)) { entry.run?.abort(); this.entries.delete(id) }
    }
    const next = JSON.stringify([this.state(), this.checking()])
    if (!changed && next === this.published) return
    this.published = next
    for (const listener of this.listeners) listener()
  }
}
