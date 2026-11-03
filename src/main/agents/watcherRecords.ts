import { watcherRecordSchema, emptyWatcherRecord, type WatcherRecord } from '../../shared/watcher'

const targetKey = (target: { readonly hostId: string; readonly threadId: string }): string => JSON.stringify([target.hostId, target.threadId])

/**
 * The most reservations the saved record holds. A build from before #1183 reads the Watcher record with at most eight, the
 * most its Threads in flight limit allowed, and a record it cannot read in `agents.json` costs it the whole file: drafts,
 * outbox and configuration go with it. So Sotto still writes no more than eight, whatever is in flight now, and rebuilds
 * the rest when it reads the record again (`rebuildReservations`). They only count Watcher's starts still working; none
 * holds anything back. Since the record has a file of its own (`WATCHER_RECORD_FILE`), such a build reads none of it.
 */
export const WATCHER_SAVED_RESERVATIONS_MAX = 8

/**
 * The Watcher record as its saved file holds it: the live record itself while it has eight reservations or fewer, so
 * nothing is copied, and otherwise a shallow copy with eight, those whose delivery is still unresolved first.
 */
export function watcherRecordForDisk(record: WatcherRecord): WatcherRecord {
  if (record.reservations.length <= WATCHER_SAVED_RESERVATIONS_MAX) return record
  const unresolved = new Set<string>()
  for (const operation of record.operations) {
    if (operation.creationUncertain || operation.deliveryState === 'queued' || operation.deliveryState === 'dispatching' || operation.deliveryState === 'uncertain') unresolved.add(targetKey(operation.target))
  }
  const first = record.reservations.filter(item => unresolved.has(targetKey(item.target)))
  const rest = record.reservations.filter(item => !unresolved.has(targetKey(item.target)))
  return { ...record, reservations: [...first, ...rest].slice(0, WATCHER_SAVED_RESERVATIONS_MAX) }
}

/**
 * Puts back the reservations `watcherRecordForDisk` left off: one for each thread a start of an active request's
 * participating thread still names, unless it failed. It runs on every recovery, not only on a record saved at the cap:
 * the threads Sotto observes before Watcher recovers can already have pruned one that was. Says whether it put any back,
 * for the caller to prune what its threads no longer need, as it does after every snapshot.
 */
export function rebuildReservations(record: WatcherRecord): boolean {
  const before = record.reservations.length
  const reserved = new Set(record.reservations.map(item => targetKey(item.target)))
  const requests = new Map(record.requests.map(request => [request.id, request]))
  for (const operation of record.operations) {
    if (operation.action !== 'start' || operation.deliveryState === 'failed' || reserved.has(targetKey(operation.target))) continue
    const request = requests.get(operation.requestId)
    const participant = request?.state === 'active' ? request.participants.find(item => targetKey(item.target) === targetKey(operation.target)) : undefined
    if (participant?.state !== 'participating') continue
    record.reservations.push({ target: operation.target, requestId: operation.requestId, operationId: operation.id, generation: participant.generation, reason: 'creation' })
    reserved.add(targetKey(operation.target))
  }
  return record.reservations.length > before
}

/** Older stores carry no Watcher record. Migration never adopts a thread by its title or legacy assignment. */
export function migrateWatcherRecord(input: unknown): WatcherRecord {
  return input === undefined ? emptyWatcherRecord() : watcherRecordSchema.parse(input)
}

/**
 * Prompt turns kept beyond those in use, so a retried send still finds the turn it opened. A message sent again only after
 * this many newer turns, whose own turn Watcher never acted in, opens a second budget; nothing was spent from the first.
 */
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
