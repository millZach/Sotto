import type { CommandResult, UpdatePhase, UpdateStatus } from '../../shared/contracts'
import type { AppSettings } from '../../shared/settings'

/**
 * A dictation tool has no reason to poll a release feed often. Four hours keeps
 * a machine that never restarts within a working day of a fix while a laptop
 * that is opened and closed all day still only asks once per interval.
 */
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000

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
  | Readonly<{ type: 'error' }>

export interface UpdaterAdapter {
  subscribe(listener: (event: UpdaterEvent) => void): void
  check(): Promise<void>
  download(): Promise<void>
  quitAndInstall(): void
}

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
  readonly intervalMs?: number
  /** Returns its own cancellation, so tests never touch real timers. */
  readonly scheduleInterval?: (callback: () => void, intervalMs: number) => () => void
}

const OK = Object.freeze({ ok: true as const })
const UNAVAILABLE = Object.freeze({ ok: false as const, reason: 'unavailable' as const })

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

function samePhase(left: UpdatePhase, right: UpdatePhase): boolean {
  if (left.phase !== right.phase) return false
  if (left.phase === 'available' && right.phase === 'available') {
    return left.version === right.version
  }
  if (left.phase === 'downloaded' && right.phase === 'downloaded') {
    return left.version === right.version
  }
  if (left.phase === 'downloading' && right.phase === 'downloading') {
    return left.version === right.version && left.percent === right.percent
  }
  return true
}

/**
 * Owns the GitHub-Releases updater the way RemoteAsrService owns remote
 * transcription: one main-process object, every dependency injected, and no
 * failure that can escape as a rejection. An unreachable GitHub, a malformed
 * feed, or a build with no feed at all are all just phases the UI can render,
 * because nothing about updating is allowed to disturb dictation.
 */
export class UpdateService {
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly scheduleInterval: (callback: () => void, intervalMs: number) => () => void
  private adapter: UpdaterAdapter | null = null
  private adapterResolved = false
  private phase: UpdatePhase = { phase: 'idle' }
  private lastCheckStartedAt: number | null = null
  private checkInFlight: Promise<UpdateStatus> | null = null
  private cancelTimer: (() => void) | null = null
  private disposed = false

  constructor(private readonly dependencies: UpdateServiceDependencies) {
    this.now = dependencies.now ?? Date.now
    this.intervalMs = dependencies.intervalMs ?? UPDATE_CHECK_INTERVAL_MS
    this.scheduleInterval = dependencies.scheduleInterval ?? defaultScheduleInterval
  }

  /** One check on launch, then one per interval, each still gated on the setting. */
  start(): void {
    if (this.disposed || this.cancelTimer !== null) return
    try {
      this.cancelTimer = this.scheduleInterval(() => {
        void this.check('automatic')
      }, this.intervalMs)
    } catch {
      // A scheduler that refuses only costs the periodic re-check.
    }
    void this.check('automatic')
  }

  status(): UpdateStatus {
    return { currentVersion: this.dependencies.currentVersion, phase: this.phase }
  }

  /**
   * An automatic check obeys the setting and the interval. A manual one is the
   * user asking in Settings, which is consent in itself, so it runs either way.
   */
  async check(trigger: 'automatic' | 'manual'): Promise<UpdateStatus> {
    if (this.disposed) return this.status()
    const adapter = this.ensureAdapter()
    if (adapter === null) {
      this.setPhase({ phase: 'unsupported' })
      return this.status()
    }
    if (trigger === 'automatic') {
      if (!(await this.automaticChecksEnabled())) return this.status()
      const last = this.lastCheckStartedAt
      if (last !== null && this.now() - last < this.intervalMs) return this.status()
    }
    // A staged download is further along than any answer a new check could give.
    if (this.phase.phase === 'downloading' || this.phase.phase === 'downloaded') {
      return this.status()
    }
    const active = this.checkInFlight
    if (active !== null) return active

    this.lastCheckStartedAt = this.now()
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
    } catch {
      // The offer survives a failed download so the user can simply try again.
      if (this.currentPhase() === 'downloading') this.setPhase({ phase: 'available', version })
      return UNAVAILABLE
    }
    // An 'update-downloaded' event may already have moved it along.
    if (this.currentPhase() === 'downloading') this.setPhase({ phase: 'downloaded', version })
    return OK
  }

  /** Reads through the narrowing TypeScript keeps across `setPhase` and `await`. */
  private currentPhase(): UpdatePhase['phase'] {
    return this.phase.phase
  }

  /**
   * Restart-and-install. Refused unless an installer is already on disk, so the
   * app can never quit into an update that does not exist.
   */
  install(): CommandResult {
    if (this.disposed) return UNAVAILABLE
    const adapter = this.ensureAdapter()
    if (adapter === null || this.phase.phase !== 'downloaded') return UNAVAILABLE
    try {
      adapter.quitAndInstall()
    } catch {
      return UNAVAILABLE
    }
    return OK
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const cancel = this.cancelTimer
    this.cancelTimer = null
    try {
      cancel?.()
    } catch {
      // The process is going away; an uncancelled timer cannot outlive it.
    }
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
    this.setPhase({ phase: 'checking' })
    try {
      await adapter.check()
    } catch {
      if (this.currentPhase() === 'checking') this.setPhase({ phase: 'failed' })
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
          this.setPhase({ phase: 'available', version })
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
        this.setPhase({ phase: 'downloaded', version })
        return
      }
      default:
        if (current.phase === 'checking') this.setPhase({ phase: 'failed' })
        else if (current.phase === 'downloading') {
          this.setPhase({ phase: 'available', version: current.version })
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
