import type { AgentThread } from '../../shared/agents'
import { WATCHER_READ_DISPATCHES_MAX, WATCHER_READ_MARKS_MAX, type WatcherReadDispatch, type WatcherReadMark, type WatcherRecord,
  type WatcherThreadTarget } from '../../shared/watcher'

const key = (target: WatcherThreadTarget): string => JSON.stringify([target.hostId, target.threadId])
/** How long a dispatched turn may go without reporting its end before it is let go, unmarked. */
export const READ_DISPATCH_MAX_MS = 24 * 60 * 60 * 1_000
/** How many waiting requests one dispatch remembers as already shown. */
const REQUESTS_KEPT = 50

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
    requestIds: (thread?.requests ?? []).map(request => request.id).slice(0, REQUESTS_KEPT), at })
  record.readDispatches = kept.slice(-WATCHER_READ_DISPATCHES_MAX)
}

/**
 * Whether a thread's newest turn is the dispatched one, ended. Sotto's message names the turn where the provider reports
 * it (Claude Code, Grok Build, Devin and Muse), or the turn's own ID is Sotto's message; a Codex turn, or one sent where this
 * computer does not know the message, is the first turn to end that was not the thread's newest when the send went.
 */
function endOf(entry: WatcherReadDispatch, thread: AgentThread): 'finished' | 'failed' | 'stopped' | null {
  const turn = thread.lastTurn
  // The turn's own end, never whether the thread is idle: work the turn left running in the background holds nothing back.
  if (!turn || turn.status === 'running') return null
  const named = turn.messageId ?? turn.id
  const ours = entry.messageId === undefined ? turn.id !== entry.priorTurnId
    : named === entry.messageId || turn.id === entry.messageId || turn.messageId === undefined && turn.id !== entry.priorTurnId && thread.providerId === 'codex'
  if (!ours) return null
  return turn.status === 'interrupted' ? 'stopped' : turn.status === 'failed' || thread.status === 'error' ? 'failed' : 'finished'
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
    const shown = new Set(entry.requestIds)
    const arrived = thread.requests.filter(request => !shown.has(request.id))
    if (arrived.length) {
      const asks = arrived.find(request => request.kind === 'question') ?? arrived[0]!
      mark(entry.target, asks.kind === 'question' ? 'question' : 'permission', `request:${asks.id}`)
      next = { ...entry, requestIds: [...entry.requestIds, ...arrived.map(request => request.id)].slice(-REQUESTS_KEPT) }
      changed = true
    }
    const end = endOf(entry, thread)
    if (end === null) { kept.push(next); continue }
    changed = true
    if (end !== 'stopped') mark(entry.target, end, `${end}:${thread.lastTurn!.id}`)
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
