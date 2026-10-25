import { randomUUID } from 'node:crypto'
import { isThreadProviderConnected, type AgentHostSnapshot, type AgentThread } from '../../shared/agents'
import { failedTurnReason, failedWithoutRequest, lastTurnRecord } from '../../shared/threadFailures'
import { settledIn } from './finishedUnread'

/**
 * How many marks are kept for threads that are gone from the host's list, newest last. A thread still listed keeps its
 * mark whatever the count, since dropping it would bring back a failure the user already saw or dismissed.
 */
export const FAILURES_SEEN_MAX = 200

/** One saved mark: the thread, the failure of it that a client showed or Dismiss all named, and that failure's turn. */
export interface SavedFailureSeen {
  readonly threadId: string; readonly failure: string; readonly turn?: string | undefined
  /** When the record named the failure, in milliseconds since the epoch; absent from marks saved before it was kept. */
  readonly since?: number | undefined
}

/**
 * One failure of one thread. `id` is the host's own name for it, made when the record first sees the thread in error,
 * or in error on a different failed turn, so it stays the same however the provider describes the failure afterwards.
 * `turn` is the provider's failed turn, once one is known: a failure first seen with none, as a resume that fails, is
 * the same failure when history later names its turn.
 */
interface Failure { readonly id: string; turn: string | undefined; seen: boolean; reason?: string | undefined; readonly since?: number | undefined }

/** The longest reason published with a failure, as `failureReason` allows. */
const REASON_MAX = 600

const failedTurnOf = (thread: Pick<AgentThread, 'lastTurn'>): string | undefined => thread.lastTurn?.status === 'failed' ? thread.lastTurn.id : undefined

/**
 * The failed threads some client has shown since they failed (ADR-0092). A failed turn is attention until a client
 * shows the thread or the user dismisses it; after that the row reads Done and the pane still says why the turn failed.
 * The coordinator owns the record for the reason it owns `FinishedUnread` (ADR-0046): every client reads one answer, a
 * thread opened on the phone is seen on the desktop too, and a restart keeps it.
 *
 * What a client shows is what it observes, as for the finished mark. A thread shown when it fails is seen at once. A
 * failure ends once the thread works or rests again with its provider connected, so its next failure is news; a
 * provider that disconnects says nothing new about the thread, so its failure stands. A thread settled in Sotto's
 * workspace, by itself, its project or the thread that delegated to it, has its failure seen too (#1279): settled is quiet.
 */
export class FailuresSeen {
  private shown: ReadonlySet<string> = new Set()
  /** The threads in the latest list read; until one is read, every saved mark is kept. Its own, changed by a change read. */
  private present: Set<string> | undefined
  /** Each thread in error and the failure it stands in, oldest first: a map keeps the order things were added in. */
  private readonly failures = new Map<string, Failure>()

  constructor(saved: readonly SavedFailureSeen[] = [], private readonly dormant?: (threadId: string) => boolean,
    private readonly newId: () => string = randomUUID, private readonly now: () => number = Date.now) { this.restore(saved) }

  /** Takes the saved marks back at start. Nothing is dropped until a list of threads says which are gone. */
  restore(saved: readonly SavedFailureSeen[]): void {
    for (const id of this.failures.keys()) this.onMoved?.(id)
    this.failures.clear()
    for (const { threadId, failure, turn, since } of saved) {
      this.failures.delete(threadId); this.failures.set(threadId, { id: failure, turn, seen: true, ...(since === undefined ? {} : { since }) })
      this.onMoved?.(threadId)
    }
  }

  /**
   * Told of each thread whose published failure, reason or seen mark may have moved, from any path, so a caller that lists
   * threads by what changed knows which to list again (#925). Unset, nothing is told.
   */
  onMoved: ((threadId: string) => void) | undefined

  /** Reads one snapshot of the threads; true when a saved mark was made, changed or dropped. */
  track(snapshot: AgentHostSnapshot): boolean {
    let changed = false
    this.present = new Set(snapshot.threads.map(thread => thread.id))
    const settled = settledIn(snapshot)
    for (const thread of snapshot.threads) changed = this.read(snapshot, thread, settled) || changed
    // A failure nobody has seen is not saved, so one for a thread no longer listed has nothing left to say.
    for (const [id, failure] of this.failures) if (!failure.seen && !this.present.has(id) && !this.dormant?.(id)) this.drop(id)
    this.trim()
    return changed
  }

  /**
   * Reads only the threads a change named (#925): `threads`, each as the snapshot now shows it, and `gone`, the threads it
   * no longer shows, against the last list read, which a whole read (`track`) must have given. Every other thread is as
   * that read left it, and so are the connection, the providers and the projects `snapshot` carries, so reading it again
   * would change nothing. An unseen failure is only ever made for a thread listed, so only one of a thread that went can
   * have nothing left to say. This says what `track` would of the whole list.
   */
  trackChanged(snapshot: AgentHostSnapshot, threads: readonly AgentThread[], gone: Iterable<string>): boolean {
    const present = this.present
    if (!present) throw new Error('A change of threads is read only after a whole list was.')
    let changed = false
    const went: string[] = []
    for (const id of gone) { present.delete(id); went.push(id) }
    for (const thread of threads) present.add(thread.id)
    const settled = settledIn(snapshot)
    for (const thread of threads) changed = this.read(snapshot, thread, settled) || changed
    for (const id of went) {
      const failure = this.failures.get(id)
      if (failure && !failure.seen && !present.has(id) && !this.dormant?.(id)) this.drop(id)
    }
    this.trim()
    return changed
  }

  /** One thread read against its failure; true when a saved mark was made, changed or dropped. */
  private read(snapshot: AgentHostSnapshot, thread: AgentThread, settled: (thread: AgentThread) => boolean): boolean {
    if (this.dormant?.(thread.id)) return false
    if (thread.status === 'error') {
      let changed = this.identify(thread)
      this.recordReason(thread)
      if (this.shown.has(thread.id) || settled(thread)) changed = this.see(thread) || changed
      return changed
    }
    const failure = this.failures.get(thread.id)
    if (failure === undefined) return false
    if (!snapshot.connected || !isThreadProviderConnected(snapshot, thread)) return false
    this.drop(thread.id)
    return failure.seen
  }

  /** Forgets a thread's failure. */
  private drop(threadId: string): void {
    if (this.failures.delete(threadId)) this.onMoved?.(threadId)
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
    return [...this.failures].flatMap(([threadId, { id, turn, seen, since }]) => seen
      ? [{ threadId, failure: id, ...(turn === undefined ? {} : { turn }), ...(since === undefined ? {} : { since }) }] : [])
  }

  /**
   * The thread as clients read it: its failure's name, reason and when it was named while it stands in one, and
   * `failureSeen` while that is seen. A thread that stands in none carries none of the four.
   */
  publish<T extends Pick<AgentThread, 'id' | 'failureSeen' | 'failureId' | 'failureReason' | 'failureSince'>>(thread: T): T {
    const failure = this.failures.get(thread.id)
    const seen = failure?.seen === true
    const since = failure?.since === undefined ? undefined : new Date(failure.since).toISOString()
    if (thread.failureId === failure?.id && (thread.failureSeen === true) === seen && thread.failureReason === failure?.reason
      && thread.failureSince === since) return thread
    const { failureSeen: _seen, failureId: _id, failureReason: _reason, failureSince: _since, ...rest } = thread
    void _seen; void _id; void _reason; void _since
    return { ...rest, ...(failure ? { failureId: failure.id } : {}), ...(failure?.reason ? { failureReason: failure.reason } : {}),
      ...(since ? { failureSince: since } : {}), ...(seen ? { failureSeen: true } : {}) } as T
  }

  /** Keeps the failed turn's reason with its failure; a snapshot that carries no activity leaves what was read before. */
  private recordReason(thread: AgentThread): void {
    const failure = this.failures.get(thread.id)
    const reason = failedTurnReason(thread)
    if (failure === undefined || reason === undefined) return
    const kept = reason.slice(0, REASON_MAX)
    if (failure.reason !== kept) { failure.reason = kept; this.onMoved?.(thread.id) }
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
   * error on a different failed turn. A failure named with no turn takes the first failed turn named for it, as history
   * that loads after a resume failed does, unless that turn's record says it started after the failure was named: then it
   * is a later turn that failed, and a new failure. True when a seen failure was replaced, or gained its turn, so the
   * saved marks moved.
   */
  private identify(thread: AgentThread): boolean {
    const turn = failedTurnOf(thread)
    const known = this.failures.get(thread.id)
    const later = known?.turn === undefined && turn !== undefined && this.startedAfter(thread, known?.since)
    if (known !== undefined && !later && (turn === undefined || known.turn === undefined || known.turn === turn)) {
      if (turn === undefined || known.turn !== undefined) return false
      known.turn = turn
      return known.seen
    }
    this.failures.delete(thread.id)
    this.failures.set(thread.id, { id: this.newId(), turn, seen: false, since: this.now() })
    this.onMoved?.(thread.id)
    return known?.seen === true
  }

  /** Whether the thread's last turn record says it started after `since`; unknown either way reads as not. */
  private startedAfter(thread: AgentThread, since: number | undefined): boolean {
    const started = Date.parse(lastTurnRecord(thread)?.startedAt ?? '')
    return since !== undefined && Number.isFinite(started) && started > since
  }

  private see(thread: AgentThread): boolean {
    const failure = this.failures.get(thread.id)
    if (failure === undefined || failure.seen || !failedWithoutRequest(thread)) return false
    failure.seen = true
    this.onMoved?.(thread.id)
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
      if (gone(id)) { this.drop(id); count -= 1 }
    }
  }
}
