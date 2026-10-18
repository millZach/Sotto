import { watcherRecordSchema, emptyWatcherRecord, type WatcherRecord } from '../../shared/watcher'

/** Older stores carry no Watcher record. Migration never adopts a thread by its title or legacy assignment. */
export function migrateWatcherRecord(input: unknown): WatcherRecord {
  return input === undefined ? emptyWatcherRecord() : watcherRecordSchema.parse(input)
}

/** Prompt turns kept beyond those in use, so a retried send still finds the turn it opened. */
export const WATCHER_PROMPT_TURNS_KEPT = 50

/**
 * Drops the prompt turns nothing reads any more. Prompts are counted against the turn an operation names, the newest
 * turn of each Watcher is the one its next prompt counts against, and a recent turn stops a resent message opening a
 * second budget; every other turn only grew the record, which main copies on every update. Turns stay in order.
 */
export function prunePromptTurns(record: WatcherRecord): void {
  const turns = record.promptTurns
  if (!turns || turns.length <= WATCHER_PROMPT_TURNS_KEPT) return
  const counted = new Set(record.operations.flatMap(operation => operation.promptTurnId ? [operation.promptTurnId] : []))
  const newest = new Set<string>(), watchers = new Set<string>()
  for (let index = turns.length - 1; index >= 0; index--) {
    const watcher = JSON.stringify([turns[index]!.watcher.hostId, turns[index]!.watcher.threadId])
    if (!watchers.has(watcher)) { watchers.add(watcher); newest.add(turns[index]!.id) }
  }
  const recent = turns.length - WATCHER_PROMPT_TURNS_KEPT
  record.promptTurns = turns.filter((turn, index) => index >= recent || counted.has(turn.id) || newest.has(turn.id))
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
