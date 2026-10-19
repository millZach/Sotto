import type { DatabaseSync } from 'node:sqlite'

/**
 * How long a history store's save waits for the disk (ADR-0016, October 19, 2026 amendment).
 *
 * With WAL, `NORMAL` appends a commit to the log without flushing it to the disk. SQLite flushes the log before
 * every checkpoint and the file after it, so the file is never damaged. Sotto quitting or crashing loses nothing,
 * since the operating system still writes out what it was handed. An operating system crash or a power cut can
 * lose the newest commits, the ones made since the last flush, which is at most the last checkpoint.
 */
export const SAVE_SYNCHRONOUS = 'NORMAL'

/**
 * Runs `work` with its commits flushed to the disk (`synchronous=FULL`), then puts the connection back to
 * `SAVE_SYNCHRONOUS`. Flushing the log flushes every commit ahead of it as well. This is for what the user asked
 * to take out: a deletion a power cut undid would bring back the words. Call it outside a transaction.
 */
export function flushedCommits<T>(db: DatabaseSync, work: () => T): T {
  db.exec('PRAGMA synchronous=FULL')
  let result: T
  try { result = work() } catch (error) {
    // The work's own failure is the one to report, not a failure to put the setting back.
    try { db.exec(`PRAGMA synchronous=${SAVE_SYNCHRONOUS}`) } catch { /* Reported by the work's error below. */ }
    throw error
  }
  db.exec(`PRAGMA synchronous=${SAVE_SYNCHRONOUS}`)
  return result
}
