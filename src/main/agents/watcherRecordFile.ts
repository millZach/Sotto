import { stat } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { join } from 'node:path'

/**
 * Watcher's record has a file of its own beside `agents.json` (ADR-0073, October 30, 2026 amendment): `{ "watcher": record }`,
 * the shape `agents.json` held it in. It was most of `agents.json`, and every save rewrote it whole, a pause in typing
 * among them, so now a save that leaves the record as it was writes only the rest. The coordinator writes this file
 * before `agents.json`, so a crash between the two leaves the record ahead, never behind.
 */
export const WATCHER_RECORD_FILE = 'watcher-record.json'

/**
 * The file a saved Watcher record is read from, with its stat: Watcher's own, or `agents.json` for a store saved before
 * Watcher had one, whose record the coordinator's next save moves across. Neither there throws `ENOENT`.
 */
export async function savedWatcherFile(directory: string): Promise<{ path: string; stats: BigIntStats }> {
  const own = join(directory, WATCHER_RECORD_FILE)
  try { return { path: own, stats: await stat(own, { bigint: true }) } }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const legacy = join(directory, 'agents.json')
  return { path: legacy, stats: await stat(legacy, { bigint: true }) }
}
