import { randomUUID } from 'node:crypto'
import { isThreadProviderConnected, type AgentHostSnapshot, type AgentThread } from '../../shared/agents'
import { failedWithoutRequest } from '../../shared/threadFailures'

/**
 * How many marks are kept for threads that are gone from the host's list, newest last. A thread still listed keeps its
 * mark whatever the count, since dropping it would bring back a failure the user already saw or dismissed.
 */
export const FAILURES_SEEN_MAX = 200

/** One saved mark: the thread, the failure of it that a client showed or Dismiss all named, and that failure's turn. */
export interface SavedFailureSeen { readonly threadId: string; readonly failure: string; readonly turn?: string | undefined }

/**
 * One failure of one thread. `id` is the host's own name for it, made when the record first sees the thread in error,
 * or in error on a different failed turn, so it stays the same however the provider describes the failure afterwards.
 * `turn` is the provider's failed turn, once one is known: a failure first seen with none, as a resume that fails, is
 * the same failure when history later names its turn.
 */
interface Failure { readonly id: string; turn: string | undefined; seen: boolean }

const failedTurnOf = (thread: Pick<AgentThread, 'lastTurn'>): string | undefined => thread.lastTurn?.status === 'failed' ? thread.lastTurn.id : undefined

/**
 * The failed threads some client has shown since they failed (ADR-0092). A failed turn is attention until a client
 * shows the thread or the user dismisses it; after that the row reads Done and the pane still says why the turn failed.
 * The coordinator owns the record for the reason it owns `FinishedUnread` (ADR-0046): every client reads one answer, a
 * thread opened on the phone is seen on the desktop too, and a restart keeps it.
 *
 * What a client shows is what it observes, as for the finished mark. A thread shown when it fails is seen at once. A
 * failure ends once the thread works or rests again with its provider connected, so its next failure is news; a
 * provider that disconnects says nothing new about the thread, so its failure stands.
 */
export class FailuresSeen {
  private shown: ReadonlySet<string> = new Set()
  /** The threads in the latest list read; until one is read, every saved mark is kept. */
  private present: ReadonlySet<string> | undefined
  /** Each thread in error and the failure it stands in, oldest first: a map keeps the order things were added in. */
  private readonly failures = new Map<string, Failure>()

  constructor(saved: readonly SavedFailureSeen[] = [], private readonly dormant?: (threadId: string) => boolean,
    private readonly newId: () => string = randomUUID) { this.restore(saved) }

  /** Takes the saved marks back at start. Nothing is dropped until a list of threads says which are gone. */
  restore(saved: readonly SavedFailureSeen[]): void {
    this.failures.clear()
    for (const { threadId, failure, turn } of saved) {
      this.failures.delete(threadId); this.failures.set(threadId, { id: failure, turn, seen: true })
    }
  }

  /** Reads one snapshot of the threads; true when a saved mark was made, changed or dropped. */
  track(snapshot: AgentHostSnapshot): boolean {
    let changed = false
    this.present = new Set(snapshot.threads.map(thread => thread.id))
    for (const thread of snapshot.threads) {
      if (this.dormant?.(thread.id)) continue
      if (thread.status === 'error') {
        changed = this.identify(thread) || changed
        if (this.shown.has(thread.id)) changed = this.see(thread) || changed
        continue
      }
      const failure = this.failures.get(thread.id)
      if (failure === undefined) continue
      if (!snapshot.connected || !isThreadProviderConnected(snapshot, thread)) continue
      this.failures.delete(thread.id)
      changed = failure.seen || changed
    }
    // A failure nobody has seen is not saved, so one for a thread no longer listed has nothing left to say.
    for (const [id, failure] of this.failures) if (!failure.seen && !this.present.has(id) && !this.dormant?.(id)) this.failures.delete(id)
    this.trim()
    return changed
  }

  /** The threads some client shows now, out of `threads`: each that has failed is seen. True when a mark was made. */
  show(threadIds: readonly string[], threads: readonly AgentThread[]): boolean {
    this.shown = new Set(threadIds)
    return this.seeAll(threads, thread => this.shown.has(thread.id))
  }

  /**
   * Dismiss all: each named thread is seen, as if a client had shown it, when it still stands in the failure the client
   * named. One that has failed again since the press is news the user has not seen, so it keeps its Needs attention.
   * True when a mark was made.
   */
  dismiss(failures: readonly { readonly threadId: string; readonly failure: string }[], threads: readonly AgentThread[]): boolean {
    const named = new Map(failures.map(item => [item.threadId, item.failure]))
    return this.seeAll(threads, thread => named.has(thread.id), thread => this.failures.get(thread.id)?.id === named.get(thread.id))
  }

  has(threadId: string): boolean { return this.failures.get(threadId)?.seen === true }

  /** The host's name for the failure the thread stands in, or undefined when it stands in none. */
  failureOf(threadId: string): string | undefined { return this.failures.get(threadId)?.id }

  /** The marks as the coordinator saves them. */
  saved(): SavedFailureSeen[] {
    return [...this.failures].flatMap(([threadId, { id, turn, seen }]) => seen ? [{ threadId, failure: id, ...(turn === undefined ? {} : { turn }) }] : [])
  }

  /** The thread as clients read it: its failure's name while it stands in one, and `failureSeen` while that is seen. */
  publish<T extends Pick<AgentThread, 'id' | 'failureSeen' | 'failureId'>>(thread: T): T {
    const failure = this.failures.get(thread.id)
    const seen = failure?.seen === true
    if (thread.failureId === failure?.id && (thread.failureSeen === true) === seen) return thread
    const { failureSeen: _seen, failureId: _id, ...rest } = thread
    void _seen; void _id
    return { ...rest, ...(failure ? { failureId: failure.id } : {}), ...(seen ? { failureSeen: true } : {}) } as T
  }

  private seeAll(threads: readonly AgentThread[], named: (thread: AgentThread) => boolean, still: (thread: AgentThread) => boolean = () => true): boolean {
    let changed = false
    this.present = new Set([...this.present ?? [], ...threads.map(thread => thread.id)])
    for (const thread of threads) {
      if (!named(thread) || this.dormant?.(thread.id) || thread.status !== 'error') continue
      changed = this.identify(thread) || changed
      if (still(thread)) changed = this.see(thread) || changed
    }
    this.trim()
    return changed
  }

  /**
   * The failure a thread in error stands in, named when it is new: the thread was not in error before, or it is now in
   * error on a different failed turn. True when a seen failure was replaced, or gained its turn, so the saved marks moved.
   */
  private identify(thread: AgentThread): boolean {
    const turn = failedTurnOf(thread)
    const known = this.failures.get(thread.id)
    if (known !== undefined && (turn === undefined || known.turn === undefined || known.turn === turn)) {
      if (turn === undefined || known.turn !== undefined) return false
      known.turn = turn
      return known.seen
    }
    this.failures.delete(thread.id)
    this.failures.set(thread.id, { id: this.newId(), turn, seen: false })
    return known?.seen === true
  }

  private see(thread: AgentThread): boolean {
    const failure = this.failures.get(thread.id)
    if (failure === undefined || failure.seen || !failedWithoutRequest(thread)) return false
    failure.seen = true
    return true
  }

  /** Drops the oldest marks of threads gone from the list past the limit; listed and dormant threads' marks stay whole. */
  private trim(): void {
    const present = this.present
    if (present === undefined) return
    const gone = (id: string): boolean => !present.has(id) && !this.dormant?.(id)
    let count = [...this.failures.keys()].filter(gone).length
    for (const id of this.failures.keys()) {
      if (count <= FAILURES_SEEN_MAX) return
      if (gone(id)) { this.failures.delete(id); count -= 1 }
    }
  }
}
