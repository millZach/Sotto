import type { CommandResult, UpdatePhase, UpdateStatus } from '../../shared/contracts'
import type { AppSettings } from '../../shared/settings'

/**
 * The first check waits until the window has settled and the launch's own
 * network traffic (settings, keys, models) is out of the way.
 */
export const UPDATE_STARTUP_DELAY_MS = 15_000
/**
 * After that Sotto asks every few minutes, the same cadence as T3 Code, so a
 * release published while the app is open is offered within minutes rather
 * than hours. Each check is one small request for the feed's manifest.
 */
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 1_000

const MAX_PROBLEM_LENGTH = 240

/**
 * The updater collapsed to six facts. Everything electron-updater reports that
 * Sotto cannot act on — logger noise, differential-download detail, the release
 * notes body — is deliberately absent, so the service can be exercised without
 * electron-updater, Electron, or a network.
 */
export type UpdaterEvent =
  | Readonly<{ type: 'checking' }>
  | Readonly<{ type: 'available'; version: unknown }>
  | Readonly<{ type: 'not-available' }>
  | Readonly<{ type: 'progress'; percent: unknown }>
  | Readonly<{ type: 'downloaded'; version: unknown }>
  | Readonly<{ type: 'error'; message?: unknown }>

export interface UpdaterAdapter {
  subscribe(listener: (event: UpdaterEvent) => void): void
  check(): Promise<void>
  download(): Promise<void>
  /**
   * Hands off to the installer and quits. A refusal (no installer on disk,
   * the installer failing to start) may arrive either as a throw or as an
   * `error` event dispatched before this returns.
   */
  quitAndInstall(): void
}

export type UpdateCheckTrigger = 'automatic' | 'manual'

export interface UpdateServiceDependencies {
  readonly currentVersion: string
  readonly getSettings: () => AppSettings | Promise<AppSettings>
  /**
   * Absent in development, in E2E runs, and on builds with no release feed.
   * Without it every operation resolves to the `unsupported` phase and no
   * network request is ever made.
   */
  readonly createUpdater?: () => UpdaterAdapter | null
  readonly onStatusChanged?: (status: UpdateStatus) => void
  readonly now?: () => number
  readonly startupDelayMs?: number
  readonly intervalMs?: number
  /** Both return their own cancellation, so tests never touch real timers. */
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => () => void
  readonly scheduleInterval?: (callback: () => void, intervalMs: number) => () => void
}

const OK = Object.freeze({ ok: true as const })
const UNAVAILABLE = Object.freeze({ ok: false as const, reason: 'unavailable' as const })

function defaultScheduleTimeout(callback: () => void, delayMs: number): () => void {
  const handle: NodeJS.Timeout = setTimeout(callback, delayMs)
  handle.unref?.()
  return () => clearTimeout(handle)
}

function defaultScheduleInterval(callback: () => void, intervalMs: number): () => void {
  const handle: NodeJS.Timeout = setInterval(callback, intervalMs)
  // A pending update check must never be the reason the process stays alive.
  handle.unref?.()
  return () => clearInterval(handle)
}

/** A feed that answers with anything but a plausible version string is ignored. */
function normalizeVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : null
}

function normalizePercent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

/**
 * The one line of an error worth showing. electron-updater's messages are
 * often a status line followed by headers or a stack; the first line is the
 * part a person can act on. Anything unreadable becomes null, and the UI
 * falls back to its own sentence.
 */
export function describeProblem(error: unknown): string | null {
  const raw = typeof error === 'string'
    ? error
    : error !== null && typeof error === 'object' && 'message' in error
      ? (error as { message?: unknown }).message
      : null
  if (typeof raw !== 'string') return null
  const firstLine = raw.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0)
  if (firstLine === undefined) return null
  return firstLine.length > MAX_PROBLEM_LENGTH ? `${firstLine.slice(0, MAX_PROBLEM_LENGTH - 1).trimEnd()}…` : firstLine
}

function samePhase(left: UpdatePhase, right: UpdatePhase): boolean {
  if (left.phase !== right.phase) return false
  if (left.phase === 'available' && right.phase === 'available') {
    return left.version === right.version && left.problem === right.problem
  }
  if (left.phase === 'downloaded' && right.phase === 'downloaded') {
    return left.version === right.version && left.problem === right.problem
  }
  if (left.phase === 'downloading' && right.phase === 'downloading') {
    return left.version === right.version && left.percent === right.percent
  }
  if (left.phase === 'failed' && right.phase === 'failed') return left.problem === right.problem
  return true
}

/**
 * Owns the GitHub-Releases updater the way OpenRouterTranscriptionService owns
 * transcription: one main-process object, every dependency injected, and no
 * failure that can escape as a rejection. An unreachable GitHub, a malformed
 * feed, or a build with no feed at all are all just phases the UI can render,
 * because nothing about updating is allowed to disturb dictation.
 *
 * Nothing happens without being asked: a check only ever offers, a download
 * runs only when the user presses Download, and the installer only runs when
 * the user chooses to restart. Sotto never installs behind a closing window.
 */
export class UpdateService {
  private readonly now: () => number
  private readonly startupDelayMs: number
  private readonly intervalMs: number
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => () => void
  private readonly scheduleInterval: (callback: () => void, intervalMs: number) => () => void
  private adapter: UpdaterAdapter | null = null
  private adapterResolved = false
  private phase: UpdatePhase = { phase: 'idle' }
  private checkedAt: number | null = null
  private checkInFlight: Promise<UpdateStatus> | null = null
  /** True from a `quitAndInstall` call until the installer refuses or the process quits. */
  private installing = false
  /** Set by an `error` event that arrives while the installer is being started. */
  private installRefusal: { problem: string | null } | null = null
  private cancelTimers: Array<() => void> = []
  private started = false
  private disposed = false

  constructor(private readonly dependencies: UpdateServiceDependencies) {
    this.now = dependencies.now ?? Date.now
    this.startupDelayMs = dependencies.startupDelayMs ?? UPDATE_STARTUP_DELAY_MS
    this.intervalMs = dependencies.intervalMs ?? UPDATE_CHECK_INTERVAL_MS
    this.scheduleTimeout = dependencies.scheduleTimeout ?? defaultScheduleTimeout
    this.scheduleInterval = dependencies.scheduleInterval ?? defaultScheduleInterval
  }

  /** One check shortly after launch, then one per interval, each still gated on the setting. */
  start(): void {
    if (this.disposed || this.started) return
    this.started = true
    const automatic = (): void => { void this.check('automatic') }
    try {
      this.cancelTimers.push(this.scheduleTimeout(automatic, this.startupDelayMs))
      this.cancelTimers.push(this.scheduleInterval(automatic, this.intervalMs))
    } catch {
      // A scheduler that refuses only costs the checks it would have run.
    }
  }

  status(): UpdateStatus {
    return { currentVersion: this.dependencies.currentVersion, phase: this.phase, checkedAt: this.checkedAt }
  }

  /**
   * An automatic check obeys the setting. A manual one is the user asking,
   * which is consent in itself, so it runs either way. A check never disturbs
   * a download in progress or an installer already on disk: both are further
   * along than any answer a new check could give.
   */
  async check(trigger: UpdateCheckTrigger): Promise<UpdateStatus> {
    if (this.disposed) return this.status()
    const adapter = this.ensureAdapter()
    if (adapter === null) {
      this.setPhase({ phase: 'unsupported' })
      return this.status()
    }
    if (trigger === 'automatic' && !(await this.automaticChecksEnabled())) return this.status()
    if (this.phase.phase === 'downloading' || this.phase.phase === 'downloaded') {
      return this.status()
    }
    // A failed download keeps its offer and its reason until the user acts on
    // it; the poll must not quietly replace that with a fresh, wordless offer.
    if (trigger === 'automatic' && this.phase.phase === 'available' && this.phase.problem !== null) {
      return this.status()
    }
    const active = this.checkInFlight
    if (active !== null) return active

    const run = this.runCheck(adapter)
    this.checkInFlight = run
    try {
      return await run
    } finally {
      if (this.checkInFlight === run) this.checkInFlight = null
    }
  }

  /** Downloads the offered version. Only meaningful once a check offered one. */
  async download(): Promise<CommandResult> {
    if (this.disposed) return UNAVAILABLE
    const adapter = this.ensureAdapter()
    if (adapter === null) return UNAVAILABLE
    if (this.phase.phase === 'downloaded') return OK
    if (this.phase.phase === 'downloading') return OK
    if (this.phase.phase !== 'available') return UNAVAILABLE

    const version = this.phase.version
    this.setPhase({ phase: 'downloading', version, percent: 0 })
    try {
      await adapter.download()
    } catch (error) {
      // The offer survives a failed download so the user can simply try again.
      if (this.currentPhase() === 'downloading') {
        this.setPhase({ phase: 'available', version, problem: describeProblem(error) })
      }
      return UNAVAILABLE
    }
    // An 'update-downloaded' event may already have moved it along.
    if (this.currentPhase() === 'downloading') this.setPhase({ phase: 'downloaded', version, problem: null })
    return OK
  }

  /** Reads through the narrowing TypeScript keeps across `setPhase` and `await`. */
  private currentPhase(): UpdatePhase['phase'] {
    return this.phase.phase
  }

  /**
   * Restart-and-install. Refused unless an installer is already on disk, so the
   * app can never quit into an update that does not exist. When the installer
   * cannot be started the download is kept, the failure is carried on the
   * phase, and the same action offers to try again. A refusal may be thrown,
   * dispatched before `quitAndInstall` returns, or (when the installer process
   * fails to spawn) dispatched afterwards; the service stays armed for the
   * late one until the process quits or the user asks again.
   */
  install(): CommandResult {
    if (this.disposed) return UNAVAILABLE
    const adapter = this.ensureAdapter()
    if (adapter === null || this.phase.phase !== 'downloaded') return UNAVAILABLE
    this.installing = true
    this.installRefusal = null
    let thrown: string | null = null
    try {
      adapter.quitAndInstall()
    } catch (error) {
      thrown = describeProblem(error)
    }
    const refusal = this.takeInstallRefusal()
    if (thrown === null && refusal === null) return OK
    this.installing = false
    if (thrown !== null) this.recordInstallRefusal(thrown)
    return UNAVAILABLE
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const cancels = this.cancelTimers
    this.cancelTimers = []
    for (const cancel of cancels) {
      try {
        cancel()
      } catch {
        // The process is going away; an uncancelled timer cannot outlive it.
      }
    }
  }

  /** Read through a method: the event lands during the call TypeScript treats as opaque. */
  private takeInstallRefusal(): { problem: string | null } | null {
    const refusal = this.installRefusal
    this.installRefusal = null
    return refusal
  }

  /** The download stays; the phase carries why the installer did not start. */
  private recordInstallRefusal(problem: string | null): void {
    const current = this.phase
    if (current.phase !== 'downloaded') return
    this.setPhase({ phase: 'downloaded', version: current.version, problem: problem ?? 'The installer could not be started.' })
  }

  private async automaticChecksEnabled(): Promise<boolean> {
    try {
      return (await this.dependencies.getSettings()).autoUpdateCheck
    } catch {
      // Unreadable settings mean unknown consent, and unknown consent is no.
      return false
    }
  }

  private async runCheck(adapter: UpdaterAdapter): Promise<UpdateStatus> {
    this.checkedAt = this.now()
    this.setPhase({ phase: 'checking' })
    try {
      await adapter.check()
    } catch (error) {
      if (this.currentPhase() === 'checking') this.setPhase({ phase: 'failed', problem: describeProblem(error) })
      return this.status()
    }
    // A check that completed without offering a version found nothing newer.
    if (this.currentPhase() === 'checking') this.setPhase({ phase: 'up-to-date' })
    return this.status()
  }

  private ensureAdapter(): UpdaterAdapter | null {
    if (this.adapterResolved) return this.adapter
    this.adapterResolved = true
    const createUpdater = this.dependencies.createUpdater
    if (createUpdater === undefined) return null
    try {
      this.adapter = createUpdater()
    } catch {
      this.adapter = null
    }
    const adapter = this.adapter
    if (adapter === null) return null
    try {
      adapter.subscribe((event) => this.handleEvent(event))
    } catch {
      // Without events the promise outcomes still drive every phase transition.
    }
    return adapter
  }

  private handleEvent(event: UpdaterEvent): void {
    if (this.disposed) return
    const current = this.phase
    switch (event.type) {
      case 'checking':
        if (current.phase !== 'downloading' && current.phase !== 'downloaded') {
          this.setPhase({ phase: 'checking' })
        }
        return
      case 'available': {
        const version = normalizeVersion(event.version)
        if (version === null) return
        if (current.phase !== 'downloading' && current.phase !== 'downloaded') {
          this.setPhase({ phase: 'available', version, problem: null })
        }
        return
      }
      case 'not-available':
        if (current.phase === 'checking') this.setPhase({ phase: 'up-to-date' })
        return
      case 'progress':
        if (current.phase === 'downloading') {
          this.setPhase({
            phase: 'downloading',
            version: current.version,
            percent: normalizePercent(event.percent),
          })
        }
        return
      case 'downloaded': {
        const version = normalizeVersion(event.version)
        if (version === null) return
        this.setPhase({ phase: 'downloaded', version, problem: null })
        return
      }
      default: {
        const problem = describeProblem(event.message)
        if (this.installing) {
          // electron-updater reports a refused install as an event, not a throw,
          // sometimes only after `quitAndInstall` has already returned.
          this.installing = false
          this.installRefusal = { problem }
          this.recordInstallRefusal(problem)
        } else if (current.phase === 'checking') this.setPhase({ phase: 'failed', problem })
        else if (current.phase === 'downloading') {
          this.setPhase({ phase: 'available', version: current.version, problem })
        }
      }
    }
  }

  private setPhase(next: UpdatePhase): void {
    if (samePhase(this.phase, next)) return
    this.phase = next
    try {
      this.dependencies.onStatusChanged?.(this.status())
    } catch {
      // A renderer that cannot be reached only misses one repaint.
    }
  }
}
