import type { AgentMessage } from '../../../shared/agents'
import type { WatcherOperation, WatcherThreadTarget } from '../../../shared/watcher'
import { isShownReply, watcherTakeovers, type WatcherRoomState, type WatcherTakeover } from '../../../shared/watcherRoom'
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
export function joinedTakeovers(live: ReadonlyMap<string, readonly WatcherTakeover[]>, recalled: ByMessage<WatcherTakeover> | undefined): ByMessage<WatcherTakeover> {
  if (!recalled) return live
  const key = (line: WatcherTakeover): string => `${line.target.hostId}\n${line.target.threadId}\n${line.at}`
  const get = (messageId: string): readonly WatcherTakeover[] | undefined => {
    const own = live.get(messageId), older = recalled.get(messageId)
    if (!older) return own
    if (!own) return older
    const seen = new Set(own.map(key))
    return [...older.filter(line => !seen.has(key(line))), ...own].sort(byAt)
  }
  return { get, has: messageId => (get(messageId)?.length ?? 0) > 0 }
}

/**
 * Where each takeover line goes: after the last reply of the Watcher turn it happened in, the turn begun by the last of
 * the user's messages before it, or after that message while the turn has no reply. A line from before every message
 * there is follows the first.
 */
export function placeTakeovers(messages: readonly AgentMessage[], takeovers: readonly WatcherTakeover[]): ReadonlyMap<string, readonly WatcherTakeover[]> {
  const placed = new Map<string, WatcherTakeover[]>()
  if (messages.length === 0) return placed
  for (const line of takeovers) {
    const at = Date.parse(line.at)
    add(placed, anchorAfter(messages, messages.findLastIndex(message => message.role === 'user' && Date.parse(message.createdAt) <= at)), line)
  }
  return placed
}

/** The message a line follows, by the index of the user message that began its turn, or -1 when none did. */
function anchorAfter(messages: readonly AgentMessage[], user: number): string {
  let anchor = messages[Math.max(0, user)]!.id
  if (user >= 0) for (let index = user + 1; index < messages.length && messages[index]!.role !== 'user'; index++) {
    if (isShownReply(messages[index]!)) anchor = messages[index]!.id
  }
  return anchor
}
const add = <T>(placed: Map<string, T[]>, key: string, item: T): void => { const list = placed.get(key); if (list) list.push(item); else placed.set(key, [item]) }
const byAt = (a: WatcherTakeover, b: WatcherTakeover): number => Date.parse(a.at) - Date.parse(b.at)

/**
 * The read back's takeover lines placed over the conversation (#1773), as `placeTakeovers` would place them. A read back
 * places them over the held messages once, in one pass however far back it reaches. After that, a change of the messages
 * places only the newest turn's lines, and the messages that came since, against them: a reply streaming into a
 * conversation shown far back costs what it costs in one shown from its end. A line placed in an earlier turn stays
 * where it was placed until the next read back or a whole new history: a message that changes in an earlier turn does
 * not move it.
 */
interface RecalledPlacement {
  /** The messages the lines were last placed against. */
  readonly messages: readonly AgentMessage[]
  /** The index of the newest user message among them, -1 when there is none: the turn still being written. */
  readonly newest: number
  /** The lines of the turns before it, placed once for the read back. */
  readonly settled: ReadonlyMap<string, readonly WatcherTakeover[]>
  /** The latest of those lines' times: a user message that came since and is no later would take some of them. */
  readonly settledUntil: number
  /** The newest turn's lines, placed again whenever its messages change. */
  readonly open: readonly WatcherTakeover[]
  readonly lines: ByMessage<WatcherTakeover>
}
const recalledPlacements = new WeakMap<RecalledConversation, RecalledPlacement>()

/** Each message's takeover lines from the read back, or nothing when it brought none. */
export function recalledTakeovers(messages: readonly AgentMessage[], recalled: RecalledConversation | undefined): ByMessage<WatcherTakeover> | undefined {
  if (recalled === undefined || recalled.takeovers.length === 0) return undefined
  const held = recalledPlacements.get(recalled)
  const placement = held?.messages === messages ? held
    : held !== undefined && follows(held.messages, messages) ? placeSince(held, messages, recalled.takeovers) : placeAll(messages, recalled.takeovers)
  recalledPlacements.set(recalled, placement)
  return placement.lines
}

/**
 * Whether `next` holds the messages of `held` where they were, with only the newest changed or added to: the same first
 * message, the same message last held, and none gone. A whole new history, one read further back or one cut, is not.
 */
function follows(held: readonly AgentMessage[], next: readonly AgentMessage[]): boolean {
  const last = held.length - 1
  return last >= 0 && next.length > last && next[0] === held[0] && next[last]!.id === held[last]!.id
}

/** A user message's time; one that cannot be read is later than every line, as `placeTakeovers` finds it. */
const userTime = (message: AgentMessage): number => { const time = Date.parse(message.createdAt); return Number.isNaN(time) ? Infinity : time }

function placeAll(messages: readonly AgentMessage[], takeovers: readonly WatcherTakeover[]): RecalledPlacement {
  // The user messages in order and, from each on, the earliest of their times, so the last one at or before a line's time,
  // the one `placeTakeovers` looks back for from the end, is found by halving.
  const users: number[] = [], earliest: number[] = []
  for (const [index, message] of messages.entries()) if (message.role === 'user') { users.push(index); earliest.push(userTime(message)) }
  for (let index = earliest.length - 2; index >= 0; index--) earliest[index] = Math.min(earliest[index]!, earliest[index + 1]!)
  const turnOf = (at: number): number => {
    let low = 0, high = earliest.length - 1, found = -1
    while (low <= high) {
      const middle = (low + high) >> 1
      if (earliest[middle]! <= at) { found = middle; low = middle + 1 } else high = middle - 1
    }
    return found
  }
  const newestTurn = users.length - 1
  const anchors = new Map<number, string>(), settled = new Map<string, WatcherTakeover[]>(), open: WatcherTakeover[] = []
  let settledUntil = -Infinity
  if (messages.length > 0) for (const line of takeovers) {
    const at = Date.parse(line.at), turn = turnOf(at)
    if (turn === newestTurn) { open.push(line); continue }
    let anchor = anchors.get(turn)
    if (anchor === undefined) anchors.set(turn, anchor = anchorAfter(messages, turn < 0 ? -1 : users[turn]!))
    add(settled, anchor, line)
    if (at > settledUntil) settledUntil = at
  }
  return withOpen({ messages, newest: newestTurn < 0 ? -1 : users[newestTurn]!, settled, settledUntil, open })
}

/** The lines again for messages that follow the ones they were placed against: only what came since, and the newest turn while it has lines, is read. */
function placeSince(held: RecalledPlacement, messages: readonly AgentMessage[], takeovers: readonly WatcherTakeover[]): RecalledPlacement {
  let newest = held.newest
  for (let index = held.messages.length; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role !== 'user') continue
    // A new turn: the newest turn's lines may be its own now, and with clocks apart so may earlier ones.
    if (held.open.length > 0 || userTime(message) <= held.settledUntil) return placeAll(messages, takeovers)
    newest = index
  }
  const next = { messages, newest, settled: held.settled, settledUntil: held.settledUntil, open: held.open }
  return held.open.length === 0 ? { ...next, lines: held.lines } : withOpen(next)
}

/** Each message's lines: the settled ones, and the newest turn's after the message that turn has reached. */
function withOpen(placement: Omit<RecalledPlacement, 'lines'>): RecalledPlacement {
  const { messages, newest, settled, open } = placement
  if (open.length === 0) return { ...placement, lines: settled }
  const anchor = anchorAfter(messages, newest)
  const get = (messageId: string): readonly WatcherTakeover[] | undefined => {
    const older = settled.get(messageId)
    if (messageId !== anchor) return older
    return older ? [...older, ...open].sort(byAt) : open
  }
  return { ...placement, lines: { get, has: messageId => get(messageId) !== undefined } }
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
