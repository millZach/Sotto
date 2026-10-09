import { commandCenterRecordSchema, emptyCommandCenterRecord, type CommandCenterRecord } from '../../shared/commandCenter'

/** Older stores carry no center. Migration never adopts a thread by its title or legacy assignment. */
export function migrateCommandCenterRecord(input: unknown): CommandCenterRecord {
  return input === undefined ? emptyCommandCenterRecord() : commandCenterRecordSchema.parse(input)
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
