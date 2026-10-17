import { createHash } from 'node:crypto'
import type { AgentThread } from '../../shared/agents'
import { WATCHER_READ_DISPATCHES_MAX, WATCHER_READ_DISPATCH_REQUESTS_MAX, WATCHER_READ_MARKS_MAX, type WatcherReadDispatch, type WatcherReadMark, type WatcherRecord,
  type WatcherThreadTarget } from '../../shared/watcher'

const key = (target: WatcherThreadTarget): string => JSON.stringify([target.hostId, target.threadId])
/** How long a dispatched turn may go without reporting its end before it is let go, unmarked. */
export const READ_DISPATCH_MAX_MS = 24 * 60 * 60 * 1_000

/**
 * The waiting requests a dispatch knows as shown: all their IDs up to the bound, and past it a digest of the whole set,
 * so the set a pass sees replaces the known one whole and an unchanged set is never written again.
 */
function knownRequests(ids: readonly string[]): Pick<WatcherReadDispatch, 'requestIds' | 'requestsDigest'> {
  const sorted = [...new Set(ids)].sort()
  return sorted.length <= WATCHER_READ_DISPATCH_REQUESTS_MAX ? { requestIds: sorted }
    : { requestIds: sorted.slice(0, WATCHER_READ_DISPATCH_REQUESTS_MAX), requestsDigest: createHash('sha256').update(JSON.stringify(sorted)).digest('hex') }
}

/** One thread as a pass reads it: where it lives, and whether its host and provider are connected now. */
export interface ReadMarkThread { readonly target: WatcherThreadTarget; readonly thread: AgentThread; readonly connected: boolean }

/**
 * A turn Sotto just dispatched to a thread (read marks, ADR-0073, Zach's pick on October 17, 2026): a user's send, Watcher's
 * or a wake-up, on this computer or routed to a paired host. `messageId` is Sotto's message for the turn when this computer
 * knows it; the turn in place and the requests showing when it went are what the turn's own end and news are told apart
 * from. Adds it to `record`, edited in place as `updateWatcher` hands it, and keeps the newest when the list is full.
 */
export function recordDispatch(record: WatcherRecord, target: WatcherThreadTarget, thread: Pick<AgentThread, 'requests'> & Partial<Pick<AgentThread, 'lastTurn'>> | undefined, at: string, messageId?: string): void {
  const kept = (record.readDispatches ?? []).filter(entry => !(key(entry.target) === key(target) && messageId !== undefined && entry.messageId === messageId))
  kept.push({ target, ...(messageId ? { messageId } : {}), priorTurnId: thread?.lastTurn?.id ?? null,
    ...knownRequests((thread?.requests ?? []).map(request => request.id)), at })
  record.readDispatches = kept.slice(-WATCHER_READ_DISPATCHES_MAX)
}

/** A thread's turns oldest first, from its turn records and its newest turn: each turn's ID, the message it began with and how it stands. */
interface TurnView { readonly id: string; messageId: string | undefined; status: string }
function turnsOf(thread: AgentThread): TurnView[] {
  const turns: TurnView[] = [], byId = new Map<string, TurnView>()
  for (const activity of thread.activities ?? []) if (activity.kind === 'turn') {
    const known = byId.get(activity.turnId)
    if (known) { known.status = activity.status; known.messageId ??= activity.afterMessageId; continue }
    const turn = { id: activity.turnId, messageId: activity.afterMessageId, status: activity.status }
    byId.set(turn.id, turn); turns.push(turn)
  }
  const last = thread.lastTurn
  if (last) {
    const known = byId.get(last.id)
    if (known) { known.status = last.status; known.messageId ??= last.messageId }
    else turns.push({ id: last.id, messageId: last.messageId, status: last.status })
  }
  return turns
}

/**
 * How a dispatch's own turn ended, from that turn alone: never from whether the thread is idle, so work the turn left
 * running in the background holds nothing back, and never from a later turn, so two dispatches whose turns end between
 * two passes each read their own. The turn is the newest that names Sotto's message (Claude Code, Grok Build, Devin, Muse,
 * and Codex's own turn records), else the first turn after the one that was the thread's newest when the send went.
 */
function endOf(entry: WatcherReadDispatch, thread: AgentThread): { readonly end: 'finished' | 'failed' | 'stopped'; readonly turnId: string } | null {
  const turns = turnsOf(thread)
  const id = entry.messageId
  let turn = id === undefined ? undefined : turns.findLast(item => item.id === id || item.messageId === id)
  if (turn === undefined) {
    // Every provider but Codex names its turns by Sotto's message: wait for that turn.
    if (id !== undefined && thread.providerId !== 'codex') return null
    const at = entry.priorTurnId === null ? -1 : turns.findIndex(item => item.id === entry.priorTurnId)
    turn = at >= 0 ? turns[at + 1] : entry.priorTurnId === null ? turns.at(-1) : turns.findLast(item => item.id !== entry.priorTurnId)
  }
  if (turn === undefined || turn.id === entry.priorTurnId) return null
  if (turn.status === 'completed') return { end: 'finished', turnId: turn.id }
  if (turn.status === 'failed') return { end: 'failed', turnId: turn.id }
  return turn.status === 'interrupted' ? { end: 'stopped', turnId: turn.id } : null
}
/**
 * Read marks (CONTEXT.md) from Sotto's own dispatches. A thread earns a mark when a turn Sotto dispatched ends, finished
 * or failed, and when a question or permission appears while such a turn is in flight. Nothing else marks: history a
 * thread loads, a fork's or a continued thread's copy, a reconnect, a restart and a provider's reload carry no dispatch.
 * A turn started outside this desktop, at a provider's own command line or by a phone talking straight to a paired host,
 * earns none. Each pass reads only the threads with a dispatch in flight. A stopped turn ends its dispatch unmarked, and
 * one that never reports an end is let go after a day. Null when nothing changed; never edits what it is given.
 */
export function trackDispatches(dispatches: readonly WatcherReadDispatch[], marks: readonly WatcherReadMark[],
  threadOf: (target: WatcherThreadTarget) => ReadMarkThread | undefined, now: number, at: string): { dispatches: WatcherReadDispatch[]; marks: WatcherReadMark[] } | null {
  if (dispatches.length === 0) return null
  const byTarget = new Map(marks.map(mark => [key(mark.target), mark] as const))
  let changed = false
  const mark = (target: WatcherThreadTarget, kind: WatcherReadMark['kind'], newsId: string): void => {
    const slot = key(target), before = byTarget.get(slot)
    if (before?.newsId === newsId) return
    byTarget.set(slot, { target, kind, newsId, at: before?.kind === kind ? before.at : at }); changed = true
  }
  const kept: WatcherReadDispatch[] = []
  for (const entry of dispatches) {
    if (now - Date.parse(entry.at) > READ_DISPATCH_MAX_MS) { changed = true; continue }
    const found = threadOf(entry.target)
    // Out of reach for now: the dispatch waits, and its turn's end is read when the thread is back.
    if (!found || !found.connected) { kept.push(entry); continue }
    const { thread } = found
    let next = entry
    // The requests showing now replace those known before, whole, so a pass that changes nothing writes nothing.
    const showing = knownRequests(thread.requests.map(request => request.id))
    if (showing.requestsDigest !== entry.requestsDigest || JSON.stringify(showing.requestIds) !== JSON.stringify(entry.requestIds)) {
      const shown = new Set(entry.requestIds)
      const arrived = thread.requests.filter(request => !shown.has(request.id))
      const asks = arrived.find(request => request.kind === 'question') ?? arrived[0]
      if (asks) mark(entry.target, asks.kind === 'question' ? 'question' : 'permission', `request:${asks.id}`)
      const { requestsDigest: _digest, ...rest } = entry; void _digest
      next = { ...rest, requestIds: showing.requestIds, ...showing.requestsDigest ? { requestsDigest: showing.requestsDigest } : {} }
      changed = true
    }
    const ended = endOf(entry, thread)
    if (ended === null) { kept.push(next); continue }
    changed = true
    if (ended.end !== 'stopped') mark(entry.target, ended.end, `${ended.end}:${ended.turnId}`)
  }
  if (!changed) return null
  // Oldest first, as saved; a changed mark keeps its place.
  const order = new Map(marks.map((item, index) => [key(item.target), index] as const))
  return { dispatches: kept, marks: [...byTarget.values()].sort((a, b) => (order.get(key(a.target)) ?? Number.MAX_SAFE_INTEGER) - (order.get(key(b.target)) ?? Number.MAX_SAFE_INTEGER))
    .slice(-WATCHER_READ_MARKS_MAX) }
}

/**
 * The user has seen these threads' news: their marks go, and each one's read time is now. Edits `record` in place, as
 * `updateWatcher` hands it; true when a mark went.
 */
export function markThreadsRead(record: WatcherRecord, targets: readonly WatcherThreadTarget[], at: string): boolean {
  const read = new Set(targets.map(key))
  const before = record.readMarks?.length ?? 0
  if (record.readMarks) record.readMarks = record.readMarks.filter(mark => !read.has(key(mark.target)))
  record.userReads = [...(record.userReads ?? []).filter(entry => !read.has(key(entry.target))),
    ...[...new Map(targets.map(target => [key(target), target] as const)).values()].map(target => ({ target, readAt: at }))].slice(-WATCHER_READ_MARKS_MAX)
  return (record.readMarks?.length ?? 0) !== before
}
