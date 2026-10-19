import { isThreadProviderConnected, type AgentHostSnapshot, type AgentThread } from '../../shared/agents'
import { isThreadClosed } from '../../shared/threadActivity'

/** How many marks are kept, newest last; a thread forgotten while marked is dropped once the list is full. */
export const FAILURES_SEEN_MAX = 200

/** One saved mark: the thread, and the failure of it that a client showed or Dismiss all named. */
export interface SavedFailureSeen { readonly threadId: string; readonly failure: string }

type Failed = Pick<AgentThread, 'status' | 'requests' | 'settledAt' | 'archivedAt' | 'settledOverride'>

/**
 * A thread whose last turn failed and that asks the user nothing: the sidebar's Needs attention. One that waits on a
 * permission or a question is the user's to answer (ADR-0004), so nothing here ever stands for it.
 */
export function failedWithoutRequest(thread: Failed): boolean {
  return thread.status === 'error' && thread.requests.length === 0 && !isThreadClosed(thread)
}

/**
 * Which failure a thread stands in: its last turn as its provider reports it. A later turn is a new failure even when
 * the snapshots between them never showed the thread working, so a mark never carries over to it.
 */
const failureOf = (thread: Pick<AgentThread, 'lastTurn'>): string => thread.lastTurn ? `${thread.lastTurn.id}:${thread.lastTurn.status}` : ''

/**
 * The failed threads some client has shown since they failed (ADR-0092). A failed turn is attention until a client
 * shows the thread or the user dismisses it; after that the row reads Done and the pane still says why the turn failed.
 * The coordinator owns the record for the reason it owns `FinishedUnread` (ADR-0046): every client reads one answer, a
 * thread opened on the phone is seen on the desktop too, and a restart keeps it.
 *
 * What a client shows is what it observes, as for the finished mark. A thread shown when it fails is seen at once. The
 * mark drops once the thread works or rests again with its provider connected, so its next failure is news; a provider
 * that disconnects says nothing new about the thread, so its mark stays.
 */
export class FailuresSeen {
  private shown: ReadonlySet<string> = new Set()
  /** Marked thread IDs and the failure each was seen in, oldest first: a map keeps the order things were added in. */
  private readonly marks = new Map<string, string>()

  constructor(saved: readonly SavedFailureSeen[] = [], private readonly dormant?: (threadId: string) => boolean) { this.restore(saved) }

  /** Takes the saved marks back at start. */
  restore(saved: readonly SavedFailureSeen[]): void {
    this.marks.clear()
    for (const { threadId, failure } of saved) { this.marks.delete(threadId); this.marks.set(threadId, failure) }
    this.trim()
  }

  /** Reads one snapshot of the threads; true when a mark was made or dropped. */
  track(snapshot: AgentHostSnapshot): boolean {
    let changed = false
    for (const thread of snapshot.threads) {
      if (this.dormant?.(thread.id)) continue
      const mark = this.marks.get(thread.id)
      if (failedWithoutRequest(thread)) {
        if (mark !== undefined && mark !== failureOf(thread)) { this.marks.delete(thread.id); changed = true }
        if (this.shown.has(thread.id)) changed = this.see(thread) || changed
        continue
      }
      // A failed thread that now asks something keeps its mark: the request is the user's, the failure is still seen.
      if (mark === undefined || thread.status === 'error') continue
      if (!snapshot.connected || !isThreadProviderConnected(snapshot, thread)) continue
      this.marks.delete(thread.id); changed = true
    }
    this.trim()
    return changed
  }

  /** The threads some client shows now, out of `threads`: each that has failed is seen. True when a mark was made. */
  show(threadIds: readonly string[], threads: readonly AgentThread[]): boolean {
    this.shown = new Set(threadIds)
    return this.seeAll(this.shown, threads)
  }

  /** Dismiss all: the named threads that have failed are seen, as if a client had shown them. True when a mark was made. */
  dismiss(threadIds: readonly string[], threads: readonly AgentThread[]): boolean {
    return this.seeAll(new Set(threadIds), threads)
  }

  has(threadId: string): boolean { return this.marks.has(threadId) }

  /** The marks as the coordinator saves them. */
  saved(): SavedFailureSeen[] { return [...this.marks].map(([threadId, failure]) => ({ threadId, failure })) }

  /** The thread as clients read it: with `failureSeen` while it is marked, without it otherwise. */
  publish<T extends Pick<AgentThread, 'id' | 'failureSeen'>>(thread: T): T {
    if (this.has(thread.id)) return thread.failureSeen === true ? thread : { ...thread, failureSeen: true }
    if (thread.failureSeen === undefined) return thread
    const { failureSeen: _mark, ...rest } = thread
    void _mark
    return rest as T
  }

  private seeAll(ids: ReadonlySet<string>, threads: readonly AgentThread[]): boolean {
    let changed = false
    for (const thread of threads) if (ids.has(thread.id) && !this.dormant?.(thread.id)) changed = this.see(thread) || changed
    this.trim()
    return changed
  }

  private see(thread: AgentThread): boolean {
    if (!failedWithoutRequest(thread)) return false
    const failure = failureOf(thread)
    if (this.marks.get(thread.id) === failure) return false
    this.marks.delete(thread.id); this.marks.set(thread.id, failure)
    return true
  }

  /** Drops the oldest ordinary marks past the limit; dormant marks stay whole. */
  private trim(): void {
    let ordinary = this.dormant ? [...this.marks.keys()].filter(id => !this.dormant?.(id)).length : this.marks.size
    for (const id of this.marks.keys()) {
      if (ordinary <= FAILURES_SEEN_MAX) return
      if (!this.dormant?.(id)) { this.marks.delete(id); ordinary -= 1 }
    }
  }
}
