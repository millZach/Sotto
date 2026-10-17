import { createHash } from 'node:crypto'
import type { AgentThread } from '../../shared/agents'
import { WATCHER_READ_MARKS_MAX, type WatcherReadMark, type WatcherReadMarkKind, type WatcherRecord, type WatcherThreadTarget } from '../../shared/watcher'

/** A thread's latest news for the user, and what names it, so the same news is never news twice. */
export interface ThreadNews { readonly kind: WatcherReadMarkKind; readonly newsId: string }

const key = (target: WatcherThreadTarget): string => JSON.stringify([target.hostId, target.threadId])
const named = (prefix: string, value: string): string => {
  const id = `${prefix}:${value}`
  return id.length <= 512 ? id : `${prefix}:${createHash('sha256').update(value).digest('hex')}`
}

/**
 * What a thread has for the user now, from its own state and never from anyone's words: the questions or permissions
 * it waits on, a turn that failed, or a turn that finished. A thread still at it (a turn running, or work that turn
 * left running in the background) has none yet, and nor has one whose turn was stopped.
 */
export function threadNews(thread: AgentThread): ThreadNews | null {
  if (thread.requests.length > 0) {
    return { kind: thread.requests.some(request => request.kind === 'question') ? 'question' : 'permission',
      newsId: named('requests', thread.requests.map(request => request.id).sort().join(',')) }
  }
  if (thread.status === 'running' || (thread.backgroundWork?.length ?? 0) > 0 || (thread.monitoring?.length ?? 0) > 0) return null
  if (thread.status === 'error' || thread.lastTurn?.status === 'failed') return { kind: 'failed', newsId: named('failed', thread.lastTurn?.id ?? 'error') }
  if (thread.lastTurn?.status === 'completed') return { kind: 'finished', newsId: named('finished', thread.lastTurn.id) }
  return null
}

/** A thread at work: a turn running, or work a turn left running in the background. */
const busy = (thread: AgentThread): boolean => thread.status === 'running' || (thread.backgroundWork?.length ?? 0) > 0 || (thread.monitoring?.length ?? 0) > 0

/** One thread as a pass reads it: where it lives, and whether its host and provider are connected now. */
export interface ReadMarkThread { readonly target: WatcherThreadTarget; readonly thread: AgentThread; readonly connected: boolean }

/**
 * Read marks (CONTEXT.md): which threads have news the user has not seen. Each pass reads every thread once. A thread
 * earns a mark when its news changes to something new while Sotto watches it change, so a restart, a host connecting
 * or a thread reconnecting marks nothing it already had: what changed out of reach was not seen to change. The marks it
 * saved stay until the user opens the thread or marks it read: working again, as when Watcher sends it more, keeps the
 * mark, and new news changes what it says. A disconnected thread neither earns nor loses one.
 *
 * News counts only when Sotto saw the thread at work since its news last changed, as finished unread's does (ADR-0046):
 * a turn ran. History a thread gains without running one, as a fork from here or a continued thread does when its copied
 * history is imported after it first showed empty, brings a finished turn that never ran here, and earns nothing.
 */
export class WatcherReadMarks {
  /** Each thread's news at the last pass, by target. Ephemeral: a restart starts from what it sees. */
  private readonly seen = new Map<string, string | null>()
  /** The threads Sotto saw at work (a turn running, or work it left running) since their news last changed. */
  private readonly working = new Set<string>()

  /** The record's marks after this pass, or null when nothing changed. Reads `marks` and never edits it. */
  track(marks: readonly WatcherReadMark[], threads: Iterable<ReadMarkThread>, at: string): WatcherReadMark[] | null {
    const byTarget = new Map(marks.map(mark => [key(mark.target), mark] as const))
    let changed = false
    const present = new Set<string>()
    for (const { target, thread, connected } of threads) {
      if (thread.kind === 'watcher' || thread.kind === 'watcher-history') continue
      const slot = key(target)
      present.add(slot)
      // Out of reach, Sotto cannot see its news change: when it connects again, what it has then is first sight.
      if (!connected) { this.seen.delete(slot); this.working.delete(slot); continue }
      const news = threadNews(thread)
      const before = this.seen.get(slot)
      this.seen.set(slot, news?.newsId ?? null)
      const worked = this.working.has(slot)
      if (busy(thread)) this.working.add(slot)
      else if (before !== (news?.newsId ?? null)) this.working.delete(slot)
      const mark = byTarget.get(slot)
      // Only the user reading the thread takes a mark away (markThreadsRead): Watcher sending it more work does not.
      if (news === null) continue
      if (mark) {
        if (mark.newsId !== news.newsId) { byTarget.set(slot, { target, kind: news.kind, newsId: news.newsId, at }); changed = true }
        continue
      }
      // New news earns a mark only after a turn Sotto saw run; copied or imported history brings none.
      if (before !== undefined && before !== news.newsId && (worked || busy(thread))) { byTarget.set(slot, { target, kind: news.kind, newsId: news.newsId, at }); changed = true }
    }
    // A thread no pass lists any more, as when its host is put away before its connection closes, is out of reach like a
    // disconnected one: what it has when it is listed again is first sight. Its unread mark, if any, stays.
    for (const slot of this.seen.keys()) if (!present.has(slot)) { this.seen.delete(slot); this.working.delete(slot) }
    if (!changed) return null
    // Oldest first, as saved; a changed mark keeps its place.
    const order = new Map(marks.map((mark, index) => [key(mark.target), index] as const))
    return [...byTarget.values()].sort((a, b) => (order.get(key(a.target)) ?? Number.MAX_SAFE_INTEGER) - (order.get(key(b.target)) ?? Number.MAX_SAFE_INTEGER))
      .slice(-WATCHER_READ_MARKS_MAX)
  }
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
