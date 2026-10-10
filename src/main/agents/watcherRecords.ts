import { watcherRecordSchema, emptyWatcherRecord, type WatcherRecord } from '../../shared/watcher'

/** Older stores carry no Watcher record. Migration never adopts a thread by its title or legacy assignment. */
export function migrateWatcherRecord(input: unknown): WatcherRecord {
  return input === undefined ? emptyWatcherRecord() : watcherRecordSchema.parse(input)
}

/** Older workspace records are ordinary projects; explicit special kinds must survive validation. */
export function migrateWorkspaceThreadKinds(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const snapshot = input as Record<string, unknown>
  if (!Array.isArray(snapshot.threads)) return input
  return { ...snapshot, threads: snapshot.threads.map((thread: unknown) => {
    if (!thread || typeof thread !== 'object' || Array.isArray(thread)) return thread
    const record = thread as Record<string, unknown>
    return record.kind === undefined ? { ...record, kind: 'project' } : record
  }) }
}
