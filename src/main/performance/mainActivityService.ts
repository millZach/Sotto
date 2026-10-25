import { join } from 'node:path'

import { i18n } from '@lingui/core'
import { msg, t } from '@lingui/core/macro'

import { ACTIVITY_RECORDING_MS, type ActivityRecordingState, type MainActivityCommand, type MainActivityState, type MainLoopReading } from '../../shared/mainActivity'
import { ActivityRecordingSaveError, activityRecordingName, cleanCpuProfile, saveActivityRecording, sweepPartialActivityRecordings, type RecordingFileSystem, type ProfilerTarget } from './activityRecorder'
import { MainLoopMonitor, type MainLoopClock } from './mainLoopMonitor'

/** Stable event names only: nothing a recording holds, and no path, reaches a log. */
export type MainActivityLogEvent = 'activity-recording-saved' | 'activity-recording-failed' | 'activity-recording-window-unavailable'

export interface MainActivityServiceOptions {
  /** Sotto's data folder's `performance-recordings`. */
  readonly directory: string
  readonly clock: MainLoopClock
  /** Wall time, for the recording's name and its summary. */
  readonly wallClock?: () => number
  readonly windowSeconds?: number
  readonly durationMs?: number
  /** Main's own profiler; made fresh for each recording. */
  readonly mainProfiler: () => ProfilerTarget
  /** The app's folders, whose scripts a recording keeps by their place inside the app. */
  readonly appRoots: readonly string[]
  /** The development server the window loads from, in development runs only. */
  readonly devOrigins?: readonly string[]
  readonly sottoVersion: string
  readonly platform: string
  readonly revealFile: (path: string) => void
  readonly log: (event: MainActivityLogEvent) => void
  readonly setTimeout?: (callback: () => void, ms: number) => unknown
  readonly clearTimeout?: (handle: unknown) => void
  /** The file operations a save makes; tests make one fail. */
  readonly files?: RecordingFileSystem
}

const START_FAILED = msg`Sotto could not start recording. Nothing was kept. Try Record a minute again.`
const SAVE_FAILED = msg`Sotto could not save the recording. Nothing was kept. Try Record a minute again.`
/** What a failed save says when a half-written folder could not be removed: the folder, and that Sotto removes it later. */
export function saveFailedLeaving(folder: string): string {
  return t`Sotto could not save the recording, and could not remove the unfinished folder ${folder} in performance-recordings. Sotto removes it the next time it starts or saves a recording. Try Record a minute again.`
}
/** What Stop without saving says when the recording was already saved and its folder could not be removed or marked. */
export function discardLeaving(folder: string): string {
  return t`Sotto could not remove the recording you stopped. It is in performance-recordings as ${folder}, kept like a saved recording until five newer ones are saved.`
}

interface ActiveRecording {
  readonly main: ProfilerTarget
  readonly window: ProfilerTarget | null
  readonly startedAt: number
  readonly before: MainLoopReading
  timer: unknown
  /** Stop without saving was pressed, or the service was disposed. */
  discarded: boolean
}

/** The reading without its frozen flag, as a summary saves it. */
function numbers(reading: MainLoopReading): Omit<MainLoopReading, 'frozen'> {
  return { blockedShare: reading.blockedShare, longestFreezeMs: reading.longestFreezeMs, freezesOver100ms: reading.freezesOver100ms, bars: reading.bars }
}

/**
 * Main's watch on itself and Record a minute (#1233, ADR-0098). Exists only while the `main-freeze` Owl feature is on:
 * stable builds none of it, so no monitor runs there. It keeps the numbers, the notice's Not now, and one recording at a
 * time; the window reads it through the main-activity bridge.
 */
export class MainActivityService {
  private readonly monitor: MainLoopMonitor
  private readonly listeners = new Set<(state: MainActivityState) => void>()
  private recording: ActivityRecordingState = { phase: 'idle' }
  private noticeHidden = false
  /** The recording running or being saved. Stop without saving marks it discarded, which wins until it is published. */
  private active: ActiveRecording | null = null
  /**
   * A recording whose profilers are still starting. It is claimed before the first wait, so a second Record a minute
   * (a double press, or two presses queued behind a frozen main) starts nothing, and Stop without saving or closing
   * Sotto marks it cancelled, so it stops as soon as its start resolves.
   */
  private starting: { cancelled: boolean } | null = null
  /** The start sweep and the end of the latest recording (its save, or the throw-away after Stop without saving). */
  private sweeping: Promise<unknown> = Promise.resolve()
  private finishing: Promise<void> = Promise.resolve()
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly options: MainActivityServiceOptions) {
    this.monitor = new MainLoopMonitor({ clock: options.clock, ...(options.windowSeconds ? { windowSeconds: options.windowSeconds } : {}), onFrozenChange: frozen => this.frozenChanged(frozen) })
    this.setTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer = options.clearTimeout ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  start(): void {
    this.monitor.start()
    // A save cut short by a crash or a quit can leave a half-written folder; it goes now, off the start path.
    this.sweeping = sweepPartialActivityRecordings(this.options.directory, this.options.files)
  }

  /**
   * Resolves once the start sweep and the end of the latest recording have finished: its save, its failure, or the
   * throw-away after Stop without saving. Never rejects. Tests await this rather than waiting a while.
   */
  async settled(): Promise<void> {
    await Promise.allSettled([this.sweeping, this.finishing])
  }

  dispose(): void {
    this.monitor.stop()
    const active = this.active
    this.active = null
    if (active) { active.discarded = true; this.clearTimer(active.timer); void active.main.cancel(); void active.window?.cancel() }
    if (this.starting) this.starting.cancelled = true
    this.listeners.clear()
  }

  /** For tests: the monitor the service reads. */
  get loop(): MainLoopMonitor { return this.monitor }

  state(): MainActivityState {
    return { reading: this.monitor.reading(), recording: this.recording, noticeHidden: this.noticeHidden }
  }

  subscribe(listener: (state: MainActivityState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** `window` is the main window's profiler, when it can be had; a recording without it keeps main's profile alone. */
  async command(command: MainActivityCommand, window: () => ProfilerTarget | null = () => null): Promise<MainActivityState> {
    switch (command.type) {
      case 'record': await this.record(window()); break
      case 'discard': await this.discard(); break
      case 'not-now':
        if (this.monitor.isFrozen() && !this.noticeHidden) { this.noticeHidden = true; this.changed() }
        break
      case 'close':
        if (this.recording.phase === 'saved' || this.recording.phase === 'failed') {
          this.recording = { phase: 'idle' }
          // Closing a saved recording during a freeze is an answer to the notice too, as Not now is.
          this.noticeHidden = this.monitor.isFrozen()
          this.changed()
        }
        break
      case 'show-in-folder':
        if (this.recording.phase === 'saved') this.options.revealFile(join(this.recording.folder, this.recording.files[0]!))
        break
    }
    return this.state()
  }

  private frozenChanged(frozen: boolean): void {
    // Not now lasts until main recovers; the next freeze shows the notice again.
    if (!frozen) this.noticeHidden = false
    this.changed()
  }

  private changed(): void {
    if (!this.listeners.size) return
    const state = this.state()
    for (const listener of this.listeners) listener(state)
  }

  private async record(window: ProfilerTarget | null): Promise<void> {
    if (this.recording.phase === 'recording' || this.starting || this.active) return
    const starting = { cancelled: false }
    this.starting = starting
    try { await this.begin(window, starting) } finally { if (this.starting === starting) this.starting = null }
  }

  private async begin(window: ProfilerTarget | null, starting: { readonly cancelled: boolean }): Promise<void> {
    const durationMs = this.options.durationMs ?? ACTIVITY_RECORDING_MS
    const main = this.options.mainProfiler()
    try {
      await main.start()
    } catch {
      await main.cancel()
      if (!starting.cancelled) this.fail(i18n._(START_FAILED))
      return
    }
    if (starting.cancelled) { await main.cancel(); return }
    let windowTarget = window
    if (windowTarget) {
      try { await windowTarget.start() } catch {
        await windowTarget.cancel()
        windowTarget = null
        this.options.log('activity-recording-window-unavailable')
      }
    }
    if (starting.cancelled) { await Promise.all([main.cancel(), windowTarget?.cancel()]); return }
    const startedAt = this.wallNow()
    const active: ActiveRecording = { main, window: windowTarget, startedAt, before: this.monitor.reading(), timer: null, discarded: false }
    active.timer = this.setTimer(() => { this.finishing = this.finish(active) }, durationMs)
    this.active = active
    this.recording = { phase: 'recording', startedAt, durationMs }
    this.changed()
  }

  private async discard(): Promise<void> {
    // Pressed while the profilers are still starting: they stop as soon as they have started, and nothing is kept.
    if (this.starting) this.starting.cancelled = true
    const active = this.active
    if (!active) return
    this.active = null
    active.discarded = true
    this.clearTimer(active.timer)
    await Promise.all([active.main.cancel(), active.window?.cancel()])
    this.recording = { phase: 'idle' }
    this.changed()
  }

  private async finish(active: ActiveRecording): Promise<void> {
    // The recording stays active, and Stop without saving can still throw it away, until its folder is published.
    if (this.active !== active) return
    const during = this.monitor.reading()
    let saved: Awaited<ReturnType<typeof saveActivityRecording>>
    let windowProfile = null
    try {
      const mainProfile = await active.main.stop()
      if (active.window && !active.discarded) {
        try { windowProfile = await active.window.stop() } catch {
          await active.window.cancel()
          this.options.log('activity-recording-window-unavailable')
        }
      }
      if (active.discarded) return
      const roots = this.options.appRoots, origins = this.options.devOrigins ?? []
      saved = await saveActivityRecording(this.options.directory, activityRecordingName(new Date(active.startedAt)), {
        main: cleanCpuProfile(mainProfile, roots, origins),
        window: windowProfile === null ? null : cleanCpuProfile(windowProfile, roots, origins),
      }, {
        format: 1, sottoVersion: this.options.sottoVersion, platform: this.options.platform, startedAt: new Date(active.startedAt).toISOString(),
        durationMs: Math.max(0, this.wallNow() - active.startedAt), before: numbers(active.before), during: numbers(during),
      }, { keep: () => !active.discarded, ...(this.options.files ? { fs: this.options.files } : {}) })
    } catch (error) {
      if (!active.discarded) await Promise.all([active.main.cancel(), active.window?.cancel()])
      if (this.active === active) this.active = null
      const saveError = error instanceof ActivityRecordingSaveError ? error : null
      const left = saveError?.left ?? null
      // Stopped without saving, and the throw-away removed everything: nothing to say.
      if (active.discarded && left === null) return
      this.fail(left === null ? i18n._(SAVE_FAILED) :
 saveError!.removedLater ? saveFailedLeaving(left) : discardLeaving(left))
      return
    }
    if (saved === null || active.discarded) return
    this.active = null
    this.recording = { phase: 'saved', name: saved.name, folder: saved.folder, files: [...saved.files], bytes: saved.bytes, windowRecorded: windowProfile !== null }
    this.options.log('activity-recording-saved')
    this.changed()
  }

  private fail(message: string): void {
    this.recording = { phase: 'failed', message }
    this.options.log('activity-recording-failed')
    this.changed()
  }

  private wallNow(): number { return (this.options.wallClock ?? Date.now)() }
}
