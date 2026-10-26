import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import type { MainLoopReading } from '../../shared/mainActivity'
import { sweepPartialHangRecordings, type HangProcess, type HangRecord } from './hangRecording'
import { HANG_RECORDING_GAP_MS } from './mainHangWatch'
import { HEARTBEAT_MS, HEARTBEAT_SLOT, QUIT_SLOT, SHARED_SLOTS, type HangWatchdogWorkerData } from './hangWatchdogShared'

/** The worker's file, built beside main's index.js. Under the test runner there is none, and no watch starts. */
export const BUILT_HANG_WATCHDOG_WORKER = join(__dirname, 'hangWatchdogWorker.js')

export type HangWatchdogLogEvent = 'hang-recording-saved' | 'hang-recording-failed' | 'quit-forced'
const LOG_EVENTS: ReadonlySet<string> = new Set<HangWatchdogLogEvent>(['hang-recording-saved', 'hang-recording-failed', 'quit-forced'])

/**
 * Main's side of the hang watch (#1581, ADR-0098's October 26 amendment). Main writes a heartbeat into memory it shares
 * with the watch's worker, which notices when the heartbeat stops and records main's stack. Main also tells it when Quit
 * was received, so the worker can end Sotto if main never finishes quitting.
 */
export class HangWatchdog {
  private readonly beat: ReturnType<typeof setInterval>

  private constructor(private readonly worker: Worker, private readonly shared: BigInt64Array) {
    const write = (): void => { Atomics.store(shared, HEARTBEAT_SLOT, BigInt(Date.now())) }
    write()
    this.beat = setInterval(write, HEARTBEAT_MS)
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
    return new HangWatchdog(worker, shared)
  }

  /** Quit was received. From here a hang is answered by ending Sotto rather than recorded. */
  quitReceived(): void {
    if (Atomics.load(this.shared, QUIT_SLOT) === 0n) Atomics.store(this.shared, QUIT_SLOT, BigInt(Date.now()))
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
  readonly now: () => number
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
      startedAt: new Date(sentAt).toISOString(), answeredAfterMs: null, writtenAfterMs: now - sentAt,
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
