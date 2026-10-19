import { isThreadProviderConnected, type AgentHostSnapshot, type AgentThread } from '../../shared/agents'
import { failedWithoutRequest } from '../../shared/threadFailures'

/**
 * How many marks are kept for threads that are gone from the host's list, newest last. A thread still listed keeps its
 * mark whatever the count, since dropping it would bring back a failure the user already saw or dismissed.
 */
export const FAILURES_SEEN_MAX = 200

/** One saved mark: the thread, and the failure of it that a client showed or Dismiss all named. */
export interface SavedFailureSeen { readonly threadId: string; readonly failure: string }

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
  /** The threads in the latest list read; until one is read, every saved mark is kept. */
  private present: ReadonlySet<string> | undefined
  /** Marked thread IDs and the failure each was seen in, oldest first: a map keeps the order things were added in. */
  private readonly marks = new Map<string, string>()

  constructor(saved: readonly SavedFailureSeen[] = [], private readonly dormant?: (threadId: string) => boolean) { this.restore(saved) }

  /** Takes the saved marks back at start. Nothing is dropped until a list of threads says which are gone. */
  restore(saved: readonly SavedFailureSeen[]): void {
    this.marks.clear()
    for (const { threadId, failure } of saved) { this.marks.delete(threadId); this.marks.set(threadId, failure) }
  }

  /** Reads one snapshot of the threads; true when a mark was made or dropped. */
  track(snapshot: AgentHostSnapshot): boolean {
    let changed = false
    this.present = new Set(snapshot.threads.map(thread => thread.id))
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
    this.present = new Set([...this.present ?? [], ...threads.map(thread => thread.id)])
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

  /** Drops the oldest marks of threads gone from the list past the limit; listed and dormant threads' marks stay whole. */
  private trim(): void {
    const present = this.present
    if (present === undefined) return
    const gone = (id: string): boolean => !present.has(id) && !this.dormant?.(id)
    let count = [...this.marks.keys()].filter(gone).length
    for (const id of this.marks.keys()) {
      if (count <= FAILURES_SEEN_MAX) return
      if (gone(id)) { this.marks.delete(id); count -= 1 }
    }
  }
}
