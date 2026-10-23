/**
 * The worker thread that checkpoints a history store's write-ahead log for main (`walCheckpointer.ts`). It opens its
 * own connection to the file and imports Node builtins alone, so the build emits it as a file of its own beside the
 * bundle that starts it. It runs a PASSIVE checkpoint every interval, and a RESTART once the log has grown past the
 * restart size, and none while main holds it aside.
 */
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import type { CheckpointWorkerData } from './walCheckpointer'

// The control values walCheckpointer.ts describes. This file must not import that module, which is main's.
const STATE = 0, LIFE = 1
const IDLE = 0, RUNNING = 1
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
    // A busy lock answers at once: a checkpoint that cannot run now runs at the next interval.
    db = new DatabaseSync(data.path, { timeout: 0 })
    db.exec(`PRAGMA synchronous=${data.synchronous}`)
  } catch (error) {
    finish()
    throw error
  }
  const passive = db.prepare('PRAGMA wal_checkpoint(PASSIVE)')
  const restart = db.prepare('PRAGMA wal_checkpoint(RESTART)')
  let timer: ReturnType<typeof setTimeout> | undefined
  const pass = (): void => {
    if (Atomics.load(control, LIFE) !== OPEN) return
    if (Atomics.compareExchange(control, STATE, IDLE, RUNNING) === IDLE) {
      try {
        const done = passive.get()
        if (Number(done?.log ?? 0) >= data.restartPages) restart.get()
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
    timer = setTimeout(pass, data.intervalMs)
  }
  parentPort?.on('message', message => {
    if (message !== 'stop') return
    clearTimeout(timer)
    try { db.close() } finally { finish() }
  })
  timer = setTimeout(pass, data.intervalMs)
}
