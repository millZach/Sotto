import type { WatcherOperation, WatcherThreadTarget } from '../../../shared/watcher'
import { watcherTakeovers, type WatcherRoomState, type WatcherTakeover } from '../../../shared/watcherRoom'
import type { WorkerPlacementReceipt } from '../../../shared/workerMachine'

/** What follows each message in Watcher's conversation, looked up by message: its receipt cards or its takeover lines. */
export interface ByMessage<T> {
  get(messageId: string): readonly T[] | undefined
  has(messageId: string): boolean
}
/** Where each start went, looked up by its operation. */
export interface ByOperation<T> { get(operationId: string): T | undefined }

type Recalled = NonNullable<WatcherRoomState['recalled']>
const EMPTY: readonly never[] = Object.freeze([])
const byTime = (a: { readonly createdAt: string }, b: { readonly createdAt: string }): number => Date.parse(a.createdAt) - Date.parse(b.createdAt)

/** Each message's receipts, by the room's placements of them: `replies` names where each goes, `receipts` what each is. */
function placeReceipts(receipts: readonly WatcherOperation[], replies: readonly { readonly operationId: string; readonly messageId: string }[]): Map<string, WatcherOperation[]> {
  const placed = new Map<string, WatcherOperation[]>()
  if (replies.length === 0) return placed
  const operations = new Map(receipts.map(operation => [operation.id, operation] as const))
  for (const { operationId, messageId } of replies) {
    const operation = operations.get(operationId)
    if (operation === undefined) continue
    const list = placed.get(messageId)
    if (list) list.push(operation); else placed.set(messageId, [operation])
  }
  for (const list of placed.values()) list.sort(byTime)
  return placed
}

/**
 * What a read back of Watcher's archive brings to its conversation (#1759), worked out once for that read back: its
 * receipts by message, its operations, its start placements and its takeover lines. The room hands out the same `recalled`
 * object until another read back, so a change of the record's own lists reads none of it again.
 */
export interface RecalledConversation {
  readonly receipts: ReadonlyMap<string, readonly WatcherOperation[]>
  readonly operations: ReadonlySet<string>
  readonly placements: ReadonlyMap<string, WorkerPlacementReceipt>
  readonly takeovers: readonly WatcherTakeover[]
}
const recalledIndexes = new WeakMap<Recalled, { readonly watcher: string; readonly index: RecalledConversation }>()
export function recalledConversation(recalled: Recalled | undefined, watcher: WatcherThreadTarget | undefined): RecalledConversation | undefined {
  if (!recalled) return undefined
  const key = watcher ? `${watcher.hostId}\n${watcher.threadId}` : ''
  const kept = recalledIndexes.get(recalled)
  if (kept?.watcher === key) return kept.index
  const index: RecalledConversation = { receipts: placeReceipts(recalled.receipts, recalled.receiptReplies),
    operations: new Set(recalled.receipts.map(operation => operation.id)),
    placements: new Map((recalled.receiptPlacements ?? []).map(item => [item.operationId, item.placement] as const)),
    takeovers: watcherTakeovers({ current: watcher ? { target: watcher } as WatcherRoomState['current'] : null, requests: recalled.requests }) }
  recalledIndexes.set(recalled, { watcher: key, index })
  return index
}

/**
 * Each message's receipt cards: the record's own (`live`, placed from the room's lists), and before them what the read
 * back placed there, leaving out any card the record holds too, so it shows once and as the record has it. A look-up
 * costs the cards of that message alone, and building it costs the record's lists alone, however much was read back.
 */
export function joinedReceipts(live: ReadonlyMap<string, readonly WatcherOperation[]>, liveOperations: ReadonlySet<string>, recalled: RecalledConversation | undefined): ByMessage<WatcherOperation> {
  if (!recalled) return live
  const get = (messageId: string): readonly WatcherOperation[] | undefined => {
    const own = live.get(messageId), older = recalled.receipts.get(messageId)
    if (!older) return own
    const kept = older.filter(operation => !liveOperations.has(operation.id))
    if (!own) return kept.length ? kept : undefined
    return kept.length ? [...kept, ...own].sort(byTime) : own
  }
  return { get, has: messageId => (get(messageId)?.length ?? 0) > 0 }
}

/** Each message's takeover lines: the record's and the read back's, a line both carry once. */
export function joinedTakeovers(live: ReadonlyMap<string, readonly WatcherTakeover[]>, recalled: ReadonlyMap<string, readonly WatcherTakeover[]> | undefined): ByMessage<WatcherTakeover> {
  if (!recalled || recalled.size === 0) return live
  const key = (line: WatcherTakeover): string => `${line.target.hostId}\n${line.target.threadId}\n${line.at}`
  const get = (messageId: string): readonly WatcherTakeover[] | undefined => {
    const own = live.get(messageId), older = recalled.get(messageId)
    if (!older) return own
    if (!own) return older
    const seen = new Set(own.map(key))
    return [...older.filter(line => !seen.has(key(line))), ...own].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  }
  return { get, has: messageId => (get(messageId)?.length ?? 0) > 0 }
}

/** Where each start went: the record's word, else the read back's. */
export function joinedPlacements(live: ReadonlyMap<string, WorkerPlacementReceipt>, recalled: RecalledConversation | undefined): ByOperation<WorkerPlacementReceipt> {
  if (!recalled || recalled.placements.size === 0) return live
  return { get: operationId => live.get(operationId) ?? recalled.placements.get(operationId) }
}

/** The record's own receipts placed by message, built from the record's lists alone. */
export function liveReceipts(receipts: readonly WatcherOperation[] | undefined, replies: WatcherRoomState['receiptReplies']): { readonly byMessage: Map<string, WatcherOperation[]>; readonly operations: ReadonlySet<string> } {
  return { byMessage: receipts === undefined || replies === undefined ? new Map() : placeReceipts(receipts, replies), operations: new Set((receipts ?? EMPTY).map(operation => operation.id)) }
}
