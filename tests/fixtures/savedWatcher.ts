import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { savedWatcherFile, WATCHER_RECORD_FILE } from '../../src/main/agents/watcherRecordFile'

/**
 * Watcher's record as the next start reads it from `root`: its own file, or `agents.json` for a store saved before it had
 * one (ADR-0073, October 30, 2026 amendment). Undefined when neither holds one.
 */
export async function savedWatcherRecord<Record = unknown>(root: string): Promise<Record | undefined> {
  const { path } = await savedWatcherFile(root)
  return (JSON.parse(await readFile(path, 'utf8')) as { watcher?: Record }).watcher
}

/**
 * Leaves `root` as a build from before Watcher's record had a file of its own left it, so the record a test wrote into
 * `agents.json` is the one the next start reads, and moves across.
 */
export async function withoutWatcherFile(root: string): Promise<void> {
  await rm(join(root, WATCHER_RECORD_FILE), { force: true })
}

/**
 * The coordinator's saved state as the next start reads it from `root`: `agents.json`, with Watcher's record wherever it
 * is, read as loosely as `JSON.parse` reads the file.
 */
export async function savedAgentsState(root: string): Promise<ReturnType<typeof JSON.parse>> {
  const agents = JSON.parse(await readFile(join(root, 'agents.json'), 'utf8')) as object
  const watcher = await savedWatcherRecord(root)
  return watcher === undefined ? agents : { ...agents, watcher }
}
