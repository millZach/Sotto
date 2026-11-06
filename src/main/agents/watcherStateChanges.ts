import { createHash, randomUUID } from 'node:crypto'
import { WATCHER_KEPT_LISTS, WATCHER_STATE_GONE_MAX, type WatcherKeptChange, type WatcherKeptCounts, type WatcherKeptItem, type WatcherKeptList,
  type WatcherKeptState, type WatcherMergeQueueItem, type WatcherStaleNote, type WatcherStateGone, type WatcherStateWatching,
  type WatcherWaitingOnUser } from '../../shared/watcher'

/**
 * What Watcher's state tools say of what changed (#2231). Every tool result stays in Watcher's conversation and is read
 * again on each later call, and keep_state used to give back the whole kept state, about 20 KB, every time: 7.9 MB over
 * 545 calls in the audit of October 14 to November 5, 2026. keep_state now gives only the lines it changed, and a
 * read_state can give only what changed since an earlier one. The whole state is still read_state's to give, and the
 * room and a new Watcher's handover read it from the store, never from these results. Nothing here logs.
 */

/** keep_state's lines, from what was shown before the call to what is shown after it, in list order. */
export function keptChanges(before: WatcherKeptState, after: WatcherKeptState): WatcherKeptChange[] {
  const changes: WatcherKeptChange[] = []
  for (const list of WATCHER_KEPT_LISTS) {
    const earlier = new Map(before[list].map(line => [line.id, line])), now = new Set(after[list].map(line => line.id))
    for (const line of after[list]) {
      const was = earlier.get(line.id)
      if (!was) changes.push({ list, id: line.id, change: 'added', text: line.text })
      else if (was.text !== line.text) changes.push({ list, id: line.id, change: 'edited' })
      else if (was.closedAt === undefined && line.closedAt !== undefined) changes.push({ list, id: line.id, change: 'closed' })
      else if (was.touchedAt !== line.touchedAt) changes.push({ list, id: line.id, change: 'touched' })
    }
    for (const line of before[list]) if (!now.has(line.id)) changes.push({ list, id: line.id, change: 'removed' })
  }
  return changes
}

/** How many lines each list holds, open and closed. */
export function keptCounts(state: WatcherKeptState): WatcherKeptCounts {
  const count = (list: WatcherKeptList) => {
    const open = state[list].filter(line => line.closedAt === undefined).length
    return { open, closed: state[list].length - open }
  }
  return { decisions: count('decisions'), rules: count('rules'), issues: count('issues') }
}

/** The kept state without the lines already closed: read_state's openOnly. */
export function openKept(state: WatcherKeptState): WatcherKeptState {
  const open = (lines: readonly WatcherKeptItem[]) => lines.filter(line => line.closedAt === undefined)
  return { decisions: open(state.decisions), rules: open(state.rules), issues: open(state.issues), updatedAt: state.updatedAt }
}

/** What one read_state gives, the lists a changedSince read compares item by item. */
export interface WatcherStateLists {
  readonly watching: readonly WatcherStateWatching[]
  readonly mergeQueue: readonly WatcherMergeQueueItem[]
  readonly waitingOnUser: readonly WatcherWaitingOnUser[]
  readonly kept: WatcherKeptState
  readonly staleNotes: readonly WatcherStaleNote[]
}
type ListName = keyof WatcherStateLists
const LISTS: readonly ListName[] = ['watching', 'mergeQueue', 'waitingOnUser', 'kept', 'staleNotes']
/** An item as a later read finds it again: what it is, the digest of all it said, and how `gone` names it. */
interface Seen { readonly digest: string; readonly gone: unknown }
type SeenRead = Record<ListName, Map<string, Seen>>

const at = (target: { readonly hostId: string; readonly threadId: string }) => `${target.hostId}\u0000${target.threadId}`
const digest = (item: unknown) => createHash('sha256').update(JSON.stringify(item)).digest('base64url')
/** Each list's items with the key a later read finds them by and how `gone` names them. */
function items(lists: WatcherStateLists): Record<ListName, { key: string; item: unknown; gone: unknown }[]> {
  return {
    watching: lists.watching.map(row => ({ key: at(row.target), item: row, gone: row.target })),
    mergeQueue: lists.mergeQueue.map(row => ({ key: `${at(row.target)}\u0000${row.pullRequest.url ?? row.pullRequest.number}`, item: row,
      gone: { target: row.target, pullRequest: { ...row.pullRequest.number === undefined ? {} : { number: row.pullRequest.number },
        ...row.pullRequest.url === undefined ? {} : { url: row.pullRequest.url } } } })),
    waitingOnUser: lists.waitingOnUser.map(row => ({ key: `${at(row.target)}\u0000${row.waitsFor}\u0000${row.requestCardId ?? ''}\u0000${row.delegatedThreadId ?? ''}`,
      item: row, gone: row })),
    kept: WATCHER_KEPT_LISTS.flatMap(list => lists.kept[list].map(line => ({ key: line.id, item: line, gone: line.id }))),
    staleNotes: lists.staleNotes.map(note => ({ key: note.id, item: note, gone: note.id })),
  }
}

/** What a changedSince read gives: only what changed, what it left out as unchanged, and what is gone. */
export interface WatcherStateSince {
  readonly lists: WatcherStateLists
  readonly unchanged: Record<ListName, number>
  readonly gone: WatcherStateGone
}

/** The reads a changedSince read can be compared with: the last few, in memory only, so a restart forgets them. */
const HELD = 8

/**
 * read_state's change cursors (#2231). Each final page remembers, under a new cursor, a digest of every item the read gave;
 * a later read that passes that cursor as changedSince gives only the items that are new or differ, and names those gone.
 * The digests are kept in memory, never written, and only the last few reads are held.
 */
export class WatcherStateChanges {
  private readonly reads = new Map<string, SeenRead>()

  /** Remembers what a read gave and returns the cursor a later read passes as changedSince. */
  remember(lists: WatcherStateLists): string {
    const all = items(lists), seen = {} as SeenRead
    for (const list of LISTS) seen[list] = new Map(all[list].map(entry => [entry.key, { digest: digest(entry.item), gone: entry.gone }]))
    const cursor = randomUUID()
    this.reads.set(cursor, seen)
    while (this.reads.size > HELD) this.reads.delete(this.reads.keys().next().value!)
    return cursor
  }

  /**
   * What changed in `lists` since the read `cursor` names, or undefined when Sotto no longer holds that read, or so much
   * has gone that naming it would say more than the whole state.
   */
  since(cursor: string, lists: WatcherStateLists): WatcherStateSince | undefined {
    const seen = this.reads.get(cursor)
    if (!seen) return undefined
    const all = items(lists), unchanged = {} as Record<ListName, number>, kept = new Set<string>(), gone: Record<string, unknown[]> = {}
    const changed = {} as Record<ListName, unknown[]>
    for (const list of LISTS) {
      const before = seen[list], now = new Set<string>()
      changed[list] = []
      unchanged[list] = 0
      for (const entry of all[list]) {
        now.add(entry.key)
        if (before.get(entry.key)?.digest === digest(entry.item)) unchanged[list]++
        else { changed[list].push(entry.item); if (list === 'kept') kept.add(entry.key) }
      }
      const left = [...before].filter(([key]) => !now.has(key)).map(([, item]) => item.gone)
      if (left.length > WATCHER_STATE_GONE_MAX) return undefined
      if (left.length) gone[list] = left
    }
    const lines = (list: WatcherKeptList) => lists.kept[list].filter(line => kept.has(line.id))
    return {
      lists: { watching: changed.watching as WatcherStateWatching[], mergeQueue: changed.mergeQueue as WatcherMergeQueueItem[],
        waitingOnUser: changed.waitingOnUser as WatcherWaitingOnUser[], staleNotes: changed.staleNotes as WatcherStaleNote[],
        kept: { decisions: lines('decisions'), rules: lines('rules'), issues: lines('issues'), updatedAt: lists.kept.updatedAt } },
      unchanged, gone: gone as WatcherStateGone,
    }
  }
}
