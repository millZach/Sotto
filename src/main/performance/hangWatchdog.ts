import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import type { MainLoopReading } from '../../shared/mainActivity'
import { sweepPartialHangRecordings, type HangProcess, type HangRecord } from './hangRecording'
import { ASLEEP_GAP_MS, HANG_RECORDING_GAP_MS, QUIT_FORCE_MS } from './mainHangWatch'
import { HEARTBEAT_MS, HEARTBEAT_SLOT, monotonicMs, QUIT_SLOT, SHARED_SLOTS, type HangWatchdogWorkerData } from './hangWatchdogShared'

/** The worker's file, built beside main's index.js. Under the test runner there is none, and no watch starts. */
export const BUILT_HANG_WATCHDOG_WORKER = join(__dirname, 'hangWatchdogWorker.js')

export type HangWatchdogLogEvent = 'hang-recording-saved' | 'hang-recording-failed' | 'quit-forced'
const LOG_EVENTS: ReadonlySet<string> = new Set<HangWatchdogLogEvent>(['hang-recording-saved', 'hang-recording-failed', 'quit-forced'])

/**
 * Main's heartbeat and the Quit stamp, written into memory main shares with the watch's worker, on the monotonic clock
 * both read. A Quit stamp that main outlives by twice the deadline, running all along, belonged to a quit that did not
 * happen, so main takes it back; a quit Sotto knows it called off takes it back at once.
 */
export class MainHeartbeat {
  private quitRanMs = 0
  private lastBeat: number | undefined

  constructor(private readonly shared: BigInt64Array, private readonly now: () => number = monotonicMs,
    private readonly quitForceMs: number = QUIT_FORCE_MS) {}

  beat(): void {
    const now = this.now()
    const gap = this.lastBeat === undefined ? 0 : now - this.lastBeat
    this.lastBeat = now
    Atomics.store(this.shared, HEARTBEAT_SLOT, BigInt(now))
    if (Atomics.load(this.shared, QUIT_SLOT) === 0n) return
    // Time asleep does not count: only time main ran past the stamp says the quit did not happen.
    if (gap <= ASLEEP_GAP_MS) this.quitRanMs += gap
    if (this.quitRanMs >= 2 * this.quitForceMs) this.quitCancelled()
  }

  quitReceived(): void {
    if (Atomics.load(this.shared, QUIT_SLOT) !== 0n) return
    this.quitRanMs = 0
    Atomics.store(this.shared, QUIT_SLOT, BigInt(Math.max(1, this.now())))
  }

  quitCancelled(): void {
    this.quitRanMs = 0
    Atomics.store(this.shared, QUIT_SLOT, 0n)
  }
}

/**
 * Main's side of the hang watch (#1581, ADR-0098's October 26 amendment). Main writes a heartbeat into memory it shares
 * with the watch's worker, which notices when the heartbeat stops and records main's stack. Main also tells it when Quit
 * was received, so the worker can end Sotto if main stops partway through quitting.
 */
export class HangWatchdog {
  private readonly beat: ReturnType<typeof setInterval>
  private readonly heartbeat: MainHeartbeat

  private constructor(private readonly worker: Worker, shared: BigInt64Array, quitForceMs: number) {
    this.heartbeat = new MainHeartbeat(shared, monotonicMs, quitForceMs)
    this.heartbeat.beat()
    this.beat = setInterval(() => this.heartbeat.beat(), HEARTBEAT_MS)
    this.beat.unref()
  }

  /** Starts the worker, or answers undefined where it cannot be had: Sotto then runs without the watch. */
  static start(data: Omit<HangWatchdogWorkerData, 'shared'>, log: (event: HangWatchdogLogEvent) => void,
    workerPath: string = BUILT_HANG_WATCHDOG_WORKER): HangWatchdog | undefined {
    if (!existsSync(workerPath)) return undefined
    // Folders a save left half-written when Sotto last ended; no save is running yet to be caught by this.
    void sweepPartialHangRecordings(data.directory)
    const shared = new BigInt64Array(new SharedArrayBuffer(SHARED_SLOTS * BigInt64Array.BYTES_PER_ELEMENT))
    let worker: Worker
    try { worker = new Worker(workerPath, { workerData: { ...data, shared: shared.buffer as SharedArrayBuffer }, stdout: false, stderr: false }) } catch { return undefined }
    worker.on('message', (event: unknown) => { if (typeof event === 'string' && LOG_EVENTS.has(event)) log(event as HangWatchdogLogEvent) })
    worker.on('error', () => undefined)
    // It never keeps Sotto running; it ends with the process.
    worker.unref()
    return new HangWatchdog(worker, shared, data.quitForceMs ?? QUIT_FORCE_MS)
  }

  /** Quit was received. From here a main that stops for good is ended rather than waited on. */
  quitReceived(): void {
    this.heartbeat.quitReceived()
  }

  /** A quit was called off, as a refused update restart is: Sotto goes on, and the Quit stamp is taken back. */
  quitCancelled(): void {
    this.heartbeat.quitCancelled()
  }

  /**
   * Sotto is ending. The heartbeat and the worker run on until the process ends, unreferenced, so a main that stops on
   * the way out is still seen, recorded and ended, and a main that exits on time is never taken for a hang.
   */
  dispose(): void {
    this.quitReceived()
  }
}

/** The main window as the window watch sees it. */
export interface WatchedWindow {
  executeJavaScript(code: string): Promise<unknown>
  isDestroyed(): boolean
  /** A page still loading answers `executeJavaScript` only once it has loaded, so it is not asked meanwhile. */
  isLoading(): boolean
}

export interface WindowHangWatchOptions {
  /** The main window while it is shown and not minimized; null otherwise, and then it is not asked. */
  readonly target: () => WatchedWindow | null
  /** A monotonic clock (`performance.now()`), so a change of the computer's clock is never taken for a hang. */
  readonly now: () => number
  /** The computer's clock, for the time a recording names. */
  readonly wallNow?: () => number
  readonly setInterval: (callback: () => void, ms: number) => { unref?: () => unknown }
  readonly clearInterval: (handle: { unref?: () => unknown }) => void
  readonly processes: () => HangProcess[]
  readonly mainLoop: () => Omit<MainLoopReading, 'frozen'> | null
  readonly save: (record: HangRecord) => Promise<string>
  readonly update: (name: string, record: HangRecord) => Promise<void>
  readonly log: (event: 'hang-recording-saved' | 'hang-recording-failed') => void
  readonly sottoVersion: string
  readonly platform: string
  readonly hangMs?: number
  readonly askEveryMs?: number
}

/** The window has not answered main for this long. Longer than main's, so a busy render is not mistaken for a hang. */
export const WINDOW_HANG_MS = 8_000
export const WINDOW_ASK_EVERY_MS = 2_000

/**
 * The watch on the main window (#1581). Main asks the shown window to evaluate a constant every couple of seconds; the
 * answer needs the window's own thread, so no answer for `hangMs` means the window stopped while main kept going. That is
 * saved as a hang recording with each Sotto process's CPU and memory and main's own minute, then given its length once
 * the window answers. A stopped window cannot be asked for its stack: the debugger needs that same thread.
 */
export class WindowHangWatch {
  private handle: { unref?: () => unknown } | null = null
  private asking: { readonly sentAt: number; readonly window: WatchedWindow } | null = null
  private recording: { readonly name: Promise<string | null>; readonly record: HangRecord; readonly window: WatchedWindow } | null = null
  private lastRecordingAt = Number.NEGATIVE_INFINITY
  private lastLook: number | undefined
  private readonly hangMs: number

  constructor(private readonly options: WindowHangWatchOptions) {
    this.hangMs = options.hangMs ?? WINDOW_HANG_MS
  }

  start(): void {
    if (this.handle) return
    this.handle = this.options.setInterval(() => this.tick(), this.options.askEveryMs ?? WINDOW_ASK_EVERY_MS)
    this.handle.unref?.()
  }

  stop(): void {
    if (this.handle) this.options.clearInterval(this.handle)
    this.handle = null
    this.asking = null
  }

  /** One look; public so tests drive it with their own clock. */
  tick(): void {
    const now = this.options.now(), askEvery = this.options.askEveryMs ?? WINDOW_ASK_EVERY_MS
    // Looks this far apart mean main itself did not run, or the computer slept: a question pending across the gap
    // says nothing of the window, and is dropped.
    const gap = this.lastLook === undefined ? 0 : now - this.lastLook
    this.lastLook = now
    if (gap > askEvery + ASLEEP_GAP_MS && this.asking) {
      if (this.recording?.window === this.asking.window && this.recording.record.answeredAfterMs === null) this.recording = null
      this.asking = null
      return
    }
    const asking = this.asking
    if (asking) {
      // A window that went, or began loading a page, while it was asked has not stopped: its question is dropped, and a
      // recording it had open is left as written.
      if (asking.window.isDestroyed() || asking.window.isLoading()) {
        this.asking = null
        if (this.recording?.window === asking.window) this.recording = null
        return
      }
      if (!this.recording && this.options.now() - asking.sentAt >= this.hangMs) this.stopped(asking)
      return
    }
    const window = this.options.target()
    if (!window || window.isDestroyed() || window.isLoading()) return
    const ask = { sentAt: this.options.now(), window }
    this.asking = ask
    window.executeJavaScript('0').then(() => this.answered(ask), () => { if (this.asking === ask) this.asking = null })
  }

  private stopped(asking: { readonly sentAt: number; readonly window: WatchedWindow }): void {
    const now = this.options.now(), sentAt = asking.sentAt
    if (now - this.lastRecordingAt < HANG_RECORDING_GAP_MS) return
    this.lastRecordingAt = now
    const mainLoop = this.options.mainLoop()
    const record: HangRecord = { format: 1, kind: 'window', sottoVersion: this.options.sottoVersion, platform: this.options.platform,
      startedAt: new Date((this.options.wallNow ?? Date.now)() - (now - sentAt)).toISOString(), answeredAfterMs: null, writtenAfterMs: now - sentAt,
      processes: this.options.processes(), ...(mainLoop ? { mainLoop } : {}) }
    const name = this.options.save(record).then(saved => { this.options.log('hang-recording-saved'); return saved },
      () => { this.options.log('hang-recording-failed'); return null })
    this.recording = { name, record, window: asking.window }
  }

  private answered(ask: { readonly sentAt: number; readonly window: WatchedWindow }): void {
    if (this.asking !== ask) return
    this.asking = null
    const recording = this.recording
    if (!recording || recording.window !== ask.window) return
    this.recording = null
    const record: HangRecord = { ...recording.record, answeredAfterMs: this.options.now() - ask.sentAt }
    void recording.name.then(name => name === null ? undefined : this.options.update(name, record)).catch(() => undefined)
  }
}
