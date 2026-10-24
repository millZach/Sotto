/**
 * The worker thread that checkpoints a history store's write-ahead log for main (`walCheckpointer.ts`). It opens its
 * own connection to the file and imports Node builtins alone, so the build emits it as a file of its own beside the
 * bundle that starts it. It runs a PASSIVE checkpoint an interval after its last one finished, and a RESTART once the
 * log has grown past the restart size, and none while main holds it aside.
 */
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import type { CheckpointWorkerData } from './walCheckpointer'

// The control values walCheckpointer.ts describes. This file must not import that module, which is main's.
const STATE = 0, LIFE = 1, RESTARTS = 2, RESTARTS_BUSY = 3
const IDLE = 0, RUNNING = 1, RESTARTING = 3
const STARTING = 0, STOPPED = 2, OPEN = 3

const data = workerData as CheckpointWorkerData
const control = new Int32Array(data.control)

function finish(): void {
  Atomics.store(control, LIFE, STOPPED)
  Atomics.notify(control, LIFE)
}

// Main stopped it before it started: it never opens the file.
if (Atomics.compareExchange(control, LIFE, STARTING, OPEN) === STARTING) {
  let db: DatabaseSync
  try {
    // A busy lock answers at once, except for the RESTART's own short wait below.
    db = new DatabaseSync(data.path, { timeout: 0 })
    db.exec(`PRAGMA synchronous=${data.synchronous}`)
  } catch (error) {
    finish()
    throw error
  }
  const passive = db.prepare('PRAGMA wal_checkpoint(PASSIVE)')
  const restart = db.prepare('PRAGMA wal_checkpoint(RESTART)')
  const waitFor = (ms: number): void => { db.exec(`PRAGMA busy_timeout=${ms}`) }
  /**
   * A RESTART needs the write lock, which each of main's saves holds for a moment. Answering busy at once, it lost to a
   * steady stream of saves nearly every time and the log grew without end (#1451). It now waits up to `restartWaitMs`
   * for the lock, which costs main nothing while it waits: the lock is free between saves, and that is when it takes
   * it. Main's next save then waits while the RESTART copies and flushes what the passive checkpoint left.
   */
  const restartOnce = (): boolean => {
    waitFor(data.restartWaitMs)
    try { return Number(restart.get()?.busy ?? 0) === 0 } finally { waitFor(0) }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const pass = (): void => {
    if (Atomics.load(control, LIFE) !== OPEN) return
    let next = data.intervalMs
    if (Atomics.compareExchange(control, STATE, IDLE, RUNNING) === IDLE) {
      try {
        const done = passive.get()
        if (Number(done?.log ?? 0) >= data.restartPages) {
          Atomics.store(control, STATE, RESTARTING)
          if (restartOnce()) Atomics.add(control, RESTARTS, 1)
          else {
            // Lost to the saves again: the next pass, passive and RESTART, comes soon rather than an interval later.
            Atomics.add(control, RESTARTS_BUSY, 1)
            next = data.restartRetryMs
          }
        }
      } catch {
        // A checkpoint that failed, as on a disk that went away, ends the worker; main then checkpoints as SQLite does.
        try { db.close() } catch { /* The worker is ending either way. */ }
        Atomics.store(control, STATE, IDLE)
        Atomics.notify(control, STATE)
        finish()
        process.exit(1)
      }
      Atomics.store(control, STATE, IDLE)
      Atomics.notify(control, STATE)
    }
    timer = setTimeout(pass, next)
  }
  parentPort?.on('message', message => {
    if (message !== 'stop') return
    clearTimeout(timer)
    try { db.close() } finally { finish() }
  })
  timer = setTimeout(pass, data.intervalMs)
}
