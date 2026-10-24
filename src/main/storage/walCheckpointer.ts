import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { SAVE_SYNCHRONOUS } from './sqliteDurability'

/**
 * Checkpoints a history store's write-ahead log on a worker thread, so a save on main never runs one (ADR-0016,
 * October 23, 2026 amendment, #1451).
 *
 * With WAL, SQLite runs a checkpoint inside the commit that grows the log past its threshold: it flushes the log, copies
 * its pages into the file and flushes the file, all on the thread that committed. On an 860 MB `threads.sqlite` that
 * commit held main for over a second. Main's connection turns the automatic checkpoint off while this runs, and the
 * worker's own connection runs a PASSIVE checkpoint `CHECKPOINT_INTERVAL_MS` after its last one finished, which takes no
 * lock a save waits for. While saves keep coming, a passive checkpoint can fall behind and the log never starts over, so
 * once it holds `RESTART_PAGES` the worker also runs a RESTART, which holds the next save for as long as it takes to copy
 * and flush what the passive one just before it left. That puts the whole log in the file, so the save after it starts
 * the log over, as SQLite always does once a save finds the log all in the file. Where the worker cannot be had (no built file beside this module,
 * as under the test runner, or a worker that failed), main's connection keeps SQLite's own automatic checkpoint.
 */
export const BUILT_CHECKPOINT_WORKER = join(__dirname, 'walCheckpointWorker.js')
export const CHECKPOINT_INTERVAL_MS = 500
/** 16 MB of 4 KB pages: four times SQLite's own threshold. */
export const RESTART_PAGES = 4_096
/**
 * How long a RESTART waits for the write lock, which main's saves take in turn. Main is not held while it waits, since
 * it takes the lock only when no save has it; it is held afterwards, while the RESTART copies and flushes what the
 * passive checkpoint left. Ten milliseconds gives a RESTART several tries at the moments between saves.
 */
export const RESTART_WAIT_MS = 10
/** When a RESTART still lost to the saves, how soon the worker tries again: passive checkpoint, then RESTART. */
export const RESTART_RETRY_MS = 2
/** Main's connection, once a worker checkpoints for it. */
export const NO_AUTOMATIC_CHECKPOINT = 'PRAGMA wal_autocheckpoint=0'
/** Main's connection, once the worker is lost: SQLite's own threshold. */
export const AUTOMATIC_CHECKPOINT = 'PRAGMA wal_autocheckpoint=1000'

/**
 * The slots of the control array main and the worker share, and their values; `walCheckpointWorker.ts` keeps its own
 * copy, since it must not import this module. STATE says whether a passive checkpoint (RUNNING, 1) or a RESTART
 * (RESTARTING, 3) is running, both set by the worker alone, or main holds the worker aside (HELD). LIFE goes STARTING,
 * then OPEN once the worker opens its connection, then STOPPED once it has closed it (or never opened it); STOPPING asks
 * an open worker to close. Only the worker sets OPEN. RESTARTS and RESTARTS_BUSY count the RESTARTs that got the whole
 * log into the file and those that lost to the saves, for a test or a measurement to read.
 */
const STATE = 0, LIFE = 1, RESTARTS = 2, RESTARTS_BUSY = 3
const CONTROL_SLOTS = 4
const IDLE = 0, HELD = 2
const STARTING = 0, STOPPING = 1, STOPPED = 2, OPEN = 3
/** How long a hold or a stop waits for a checkpoint in flight before going on without it. */
const WAIT_LIMIT_MS = 10_000

export interface CheckpointWorkerData {
  readonly path: string
  readonly control: SharedArrayBuffer
  readonly intervalMs: number
  readonly restartPages: number
  readonly restartWaitMs: number
  readonly restartRetryMs: number
  readonly synchronous: string
}

export interface CheckpointTiming {
  readonly intervalMs?: number
  readonly restartPages?: number
  readonly restartWaitMs?: number
  readonly restartRetryMs?: number
}

export class WalCheckpointer {
  private stopped = false
  private constructor(private readonly worker: Worker, private readonly control: Int32Array) {}

  /**
   * Starts the worker for the database at `path`, or answers undefined where it cannot be had. `lost` is called once if
   * the worker goes without being stopped, so the caller can put the automatic checkpoint back.
   */
  static start(path: string, workerPath: string | null, lost: () => void, timing: CheckpointTiming = {}): WalCheckpointer | undefined {
    if (workerPath === null || !existsSync(workerPath)) return undefined
    const control = new Int32Array(new SharedArrayBuffer(CONTROL_SLOTS * Int32Array.BYTES_PER_ELEMENT))
    const workerData: CheckpointWorkerData = { path, control: control.buffer as SharedArrayBuffer,
      intervalMs: timing.intervalMs ?? CHECKPOINT_INTERVAL_MS, restartPages: timing.restartPages ?? RESTART_PAGES,
      restartWaitMs: timing.restartWaitMs ?? RESTART_WAIT_MS, restartRetryMs: timing.restartRetryMs ?? RESTART_RETRY_MS, synchronous: SAVE_SYNCHRONOUS }
    let worker: Worker
    try { worker = new Worker(workerPath, { workerData, stdout: false, stderr: false }) } catch { return undefined }
    const checkpointer = new WalCheckpointer(worker, control)
    const gone = (): void => {
      if (checkpointer.stopped) return
      checkpointer.stopped = true
      // A worker that went mid-checkpoint must not keep a hold waiting.
      Atomics.store(control, STATE, IDLE)
      lost()
    }
    worker.on('error', gone)
    worker.on('exit', gone)
    worker.unref()
    return checkpointer
  }

  /**
   * Runs `work` with no checkpoint of this worker's in flight, waiting for one that is: for main's own checkpoint, as a
   * redaction's scrub runs, which would otherwise find the log busy and leave removed words in it.
   */
  aside<T>(work: () => T): T {
    const held = this.hold()
    try { return work() } finally { if (held) Atomics.store(this.control, STATE, IDLE) }
  }

  /** The RESTARTs so far that got the whole log into the file, and those that lost to the saves. */
  restarts(): { readonly done: number; readonly busy: number } {
    return { done: Atomics.load(this.control, RESTARTS), busy: Atomics.load(this.control, RESTARTS_BUSY) }
  }

  /** Stops the worker, its connection closed before this returns, so main's close is the file's last. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    // A worker that has not opened its connection yet never will. One that has already stopped, as when its start-up or a
    // checkpoint failed before main heard it go, has closed its connection and answers nothing, so nothing is waited for.
    if (Atomics.compareExchange(this.control, LIFE, STARTING, STOPPED) === OPEN) {
      this.hold()
      // It may have stopped while the hold waited.
      if (Atomics.compareExchange(this.control, LIFE, OPEN, STOPPING) === OPEN) {
        this.worker.postMessage('stop')
        const deadline = performance.now() + WAIT_LIMIT_MS
        while (Atomics.load(this.control, LIFE) !== STOPPED && performance.now() < deadline) Atomics.wait(this.control, LIFE, STOPPING, 100)
      }
    }
    void this.worker.terminate().catch(() => undefined)
  }

  private hold(): boolean {
    const deadline = performance.now() + WAIT_LIMIT_MS
    for (;;) {
      const state = Atomics.compareExchange(this.control, STATE, IDLE, HELD)
      if (state === IDLE) return true
      if (state === HELD || performance.now() >= deadline) return false
      // A passive checkpoint or a RESTART is running: wait for its end.
      Atomics.wait(this.control, STATE, state, 100)
    }
  }
}
