import type { AgentActivity } from '../../shared/agentActivity'
import type { ThreadEvent } from '../../shared/threadEvents'
import type { WatcherAsk } from '../../shared/watcherAsks'
import type { StoreWorker, StoreWorkerResult, UnansweredWrite } from './storeWorker'
import type { StoredVisual, ThreadStore } from './threadStore'

/**
 * Every write the workspace makes to the thread store, as main posts it (#1457, ADR-0016's October 26 amendment). A
 * write is data, so a writer on another thread can take it as it is. Each is applied in the transactions the store
 * uses today: an event batch is one transaction with a savepoint per thread, and every removal the user asks for
 * commits waiting for the disk.
 */
export type ThreadStoreWrite =
  /** A publish's waiting events, every thread in one transaction (`appendBatches`). */
  | { readonly kind: 'event-batches'; readonly batches: ReadonlyMap<string, readonly ThreadEvent[]> }
  /** One thread's events in one transaction (`appendMany`); a reset among them commits waiting for the disk. */
  | { readonly kind: 'events'; readonly threadId: string; readonly events: readonly ThreadEvent[] }
  /** Several threads' activity lists in one transaction (`syncActivitiesMany`). */
  | { readonly kind: 'activities'; readonly entries: readonly ActivityListEntry[] }
  /** One thread's activity list (`syncActivities`), as the start moves it; `flushed` waits for the disk. */
  | ({ readonly kind: 'activity-list'; readonly flushed?: boolean | undefined } & ActivityListEntry)
  /** The store may let a thread's records go, keeping its marker and count. */
  | { readonly kind: 'activities-released'; readonly threadId: string }
  | { readonly kind: 'activity-identities-redacted'; readonly threadId: string; readonly activityIds: readonly string[] }
  | { readonly kind: 'visual'; readonly threadId: string; readonly stored: StoredVisual }
  /** The visuals drawn in these turns go, waiting for the disk; the outcome says how many went. */
  | { readonly kind: 'visuals-removed'; readonly threadId: string; readonly userMessageIds: readonly string[] }
  | { readonly kind: 'wake-up'; readonly threadId: string; readonly messageId: string; readonly asks?: readonly WatcherAsk[] | undefined; readonly hidden: boolean }
  | { readonly kind: 'wake-ups'; readonly threadId: string; readonly messageIds: readonly string[]; readonly asks?: ReadonlyMap<string, readonly WatcherAsk[]> | undefined; readonly hidden: readonly string[] }
  /** Clearing threads forgets them: one transaction waiting for the disk, and one scrub. */
  | { readonly kind: 'forget'; readonly threadIds: readonly string[] }
  | { readonly kind: 'subagent-words-moved' }
  /**
   * Keep local history turned off: each thread's activity identities are kept so a replay cannot bring the records back,
   * then the file's words are taken out and this run goes on in memory. A thread with no `activityIds` redacts the ones
   * the store holds. `reopen` opens the file first, after a switch that failed closed it.
   */
  | { readonly kind: 'history-off'; readonly reopen: boolean; readonly threads: readonly { readonly threadId: string; readonly activityIds?: readonly string[] | undefined }[] }
  /** Keep local history turned back on: the file takes over from here. */
  | { readonly kind: 'history-on' }

export interface ActivityListEntry { readonly threadId: string; readonly activities: readonly AgentActivity[]; readonly epoch?: string | undefined }

/**
 * A stored thread's activity as the store worker read it back (step 3 of docs/plans/store-worker.md): its records, frozen
 * and owned on main as they arrived; that the worker could not read them; or that the worker went or stopped first.
 */
export type ActivityReadBack =
  | { readonly activities: readonly AgentActivity[] }
  | { readonly unreadable: true }
  | { readonly lost: true }

/** What one write did, once it committed or failed. */
export interface ThreadStoreWriteOutcome {
  /** The threads whose part did not commit. Empty when all of it did. */
  readonly failed: ReadonlySet<string>
  /** Why, when the write threw. A write that names no thread fails whole with this alone. */
  readonly error?: unknown
  /** How many visuals a `visuals-removed` took out. */
  readonly removed?: number
}

/**
 * The seam every thread-store write goes through. A write is posted, and confirmed once it has committed or failed;
 * writes commit in the order they were posted. A writer that commits on main confirms inside `post`, before it
 * returns, so its caller sees the outcome at once, as it did when it wrote the store itself. A writer that commits
 * later confirms from its own task, and main holds what it posted until then: a read that needs a write it just
 * posted either lays the posted events over what the store returns (`posted`) or waits for `confirmed`.
 */
export interface ThreadStoreWriter {
  /** Posts a write. `confirm` is called once, with what committed. */
  post(write: ThreadStoreWrite, confirm?: (outcome: ThreadStoreWriteOutcome) => void): void
  /** The events of every write posted for this thread and not yet confirmed, in the order posted. */
  posted(threadId: string): readonly ThreadEvent[]
  /** Whether a write posted for this thread, or for any thread when none is named, is not yet confirmed. */
  unconfirmed(threadId?: string): boolean
  /** Settles once every write posted so far for this thread, or for every thread, is confirmed. */
  confirmed(threadId?: string): Promise<void>
  /**
   * Commits and confirms everything posted before it returns: for shutdown, which cannot wait for a confirmation. A writer
   * that commits elsewhere waits at most `limitMs`, and confirms what is left then as not saved.
   */
  drain(limitMs?: number): void
  /** Commits and confirms everything posted, then closes the store, within `limitMs` as `drain` is. */
  close(limitMs?: number): void
  /**
   * Reads a stored thread's activity back off main, behind every write posted before it. Undefined where this writer
   * cannot, as with no store worker, or while writes wait unsent: the caller reads on main, as before.
   */
  readActivities?(threadId: string): Promise<ActivityReadBack> | undefined
}

export const NO_EVENTS: readonly ThreadEvent[] = Object.freeze([])
const NO_THREADS: ReadonlySet<string> = new Set()

/** The threads a write names; empty for one that covers the whole store. */
export function writeThreads(write: ThreadStoreWrite): readonly string[] {
  switch (write.kind) {
    case 'event-batches': return [...write.batches.keys()]
    case 'activities': return write.entries.map(entry => entry.threadId)
    case 'forget': return write.threadIds
    case 'history-off': return write.threads.map(thread => thread.threadId)
    case 'subagent-words-moved':
    case 'history-on': return []
    default: return [write.threadId]
  }
}

/** Whether a write changes every thread at once, so every thread's reads wait for it. */
export function writesWholeStore(write: ThreadStoreWrite): boolean {
  return write.kind === 'history-off' || write.kind === 'history-on'
}

/** The events a write carries for one thread, which a read lays over the store until it is confirmed. */
export function eventsOfWrite(write: ThreadStoreWrite, threadId: string): readonly ThreadEvent[] {
  if (write.kind === 'event-batches') return write.batches.get(threadId) ?? NO_EVENTS
  if (write.kind === 'events' && write.threadId === threadId) return write.events
  return NO_EVENTS
}

/** Applies one write to the store, on the calling thread, and says what committed. */
export function applyWrite(store: ThreadStore, write: ThreadStoreWrite): ThreadStoreWriteOutcome {
  try {
    switch (write.kind) {
      case 'event-batches': return { failed: store.appendBatches(write.batches).failed }
      case 'events': store.appendMany(write.threadId, write.events); break
      case 'activities': store.syncActivitiesMany(write.entries); break
      case 'activity-list':
        if (write.flushed) store.flushed(() => store.syncActivities(write.threadId, write.activities, write.epoch))
        else store.syncActivities(write.threadId, write.activities, write.epoch)
        break
      case 'activities-released': store.releaseActivities(write.threadId); break
      case 'activity-identities-redacted': store.redactActivityIdentities(write.threadId, write.activityIds); break
      case 'visual': store.addVisual(write.threadId, write.stored); break
      case 'visuals-removed': return { failed: NO_THREADS, removed: store.deleteVisualsForTurns(write.threadId, write.userMessageIds) }
      case 'wake-up': store.addWakeUp(write.threadId, write.messageId, write.asks, write.hidden); break
      case 'wake-ups': store.addWakeUps(write.threadId, write.messageIds, write.asks, write.hidden); break
      case 'forget': store.forgetMany(write.threadIds); break
      case 'subagent-words-moved': store.markSubagentWordsMoved(); break
      case 'history-off':
        // Reopened to take the words out here, on this connection.
        if (write.reopen) store.open({ onMain: true })
        // Identity suppression needs no output validation. Even if it fails, the durable text is erased.
        try {
          for (const thread of write.threads) store.redactActivityIdentities(thread.threadId, thread.activityIds ?? store.activityIds(thread.threadId))
        } finally { store.becomeEphemeral() }
        break
      case 'history-on': store.becomeDurable(); break
    }
    return { failed: NO_THREADS }
  } catch (error) {
    return { failed: new Set(writeThreads(write)), error }
  }
}

/** The first writer: it commits on main at once, as the workspace did before the seam, and confirms inside `post`. */
export class ThreadStoreWriterOnMain implements ThreadStoreWriter {
  constructor(private readonly store: ThreadStore) {}
  post(write: ThreadStoreWrite, confirm?: (outcome: ThreadStoreWriteOutcome) => void): void {
    const outcome = applyWrite(this.store, write)
    confirm?.(outcome)
  }
  posted(): readonly ThreadEvent[] { return NO_EVENTS }
  unconfirmed(): boolean { return false }
  confirmed(): Promise<void> { return Promise.resolve() }
  drain(): void {}
  close(): void { this.store.close() }
}

/** Whether any part of a write did not commit. */
export function writeFailed(outcome: ThreadStoreWriteOutcome): boolean { return outcome.error !== undefined || outcome.failed.size > 0 }

/** Throws a write's failure as the store would have thrown it, for a caller that waits on a write it cannot do without. */
export function throwIfFailed(outcome: ThreadStoreWriteOutcome): void {
  if (!writeFailed(outcome)) return
  throw outcome.error ?? new Error('Thread history could not be saved')
}

interface PostedWrite {
  readonly write: ThreadStoreWrite
  readonly confirm: ((outcome: ThreadStoreWriteOutcome) => void) | undefined
  readonly threads: ReadonlySet<string>
  readonly whole: boolean
  /** The worker it went to and its identity there, once sent; a write held behind a switch waits unsent. */
  sent?: { readonly worker: StoreWorker; readonly id: number }
}

/** Where a thread's unconfirmed events start: its newest sequence before them, and the events confirmed since. */
interface EventBase { readonly seq: number; settled: number }

/**
 * The writer the workspace runs over (#1457, step 2): every write goes to the store worker, which commits it off main and
 * answers later, and main holds it until then. Where the store has no worker, as under the test runner, or once the worker
 * has gone, it commits on main and confirms inside `post`, as `ThreadStoreWriterOnMain` does, after the worker's
 * unanswered writes have been finished on main in the order posted.
 *
 * A write the worker commits shows to main's reads before its confirmation arrives. `posted` therefore leaves out the
 * events main's connection already holds: each thread's unconfirmed events start after a sequence noted when the first
 * of them was sent, so counting what the thread holds past it, inside the same read transaction as the window
 * (`ThreadStore.reading`), says which posted writes have already committed.
 */
export class ThreadStoreWriterOnWorker implements ThreadStoreWriter {
  /** Every write posted and not yet confirmed, in the order posted: each confirmation takes its own out at once. */
  private readonly queue = new Set<PostedWrite>()
  private readonly byThread = new Map<string, PostedWrite[]>()
  private readonly bases = new Map<string, EventBase>()
  private readonly waiters: { readonly threadId: string | undefined; readonly resolve: () => void }[] = []
  private wholeCount = 0
  /** Writes posted and not sent: behind a privacy switch the worker has not answered, or behind writes finished on main. */
  private held = 0
  private switching = false
  private recovering = false
  private flushing = false

  constructor(private readonly store: ThreadStore) {
    store.onUnanswered(unanswered => { this.recover(unanswered) })
  }

  post(write: ThreadStoreWrite, confirm?: (outcome: ThreadStoreWriteOutcome) => void): void {
    if (this.queue.size === 0 && !this.store.writer) {
      // Applied before the confirmation is called, which an optional call would skip with nobody to confirm to.
      const outcome = applyWrite(this.store, write)
      confirm?.(outcome)
      return
    }
    const posted: PostedWrite = { write, confirm, threads: new Set(writeThreads(write)), whole: writesWholeStore(write) }
    this.queue.add(posted)
    for (const threadId of posted.threads) {
      const list = this.byThread.get(threadId)
      if (list) list.push(posted)
      else this.byThread.set(threadId, [posted])
    }
    if (posted.whole) this.wholeCount++
    if (this.held === 0 && !this.switching && !this.recovering && this.store.writer) this.send(posted)
    else { this.held++; if (!this.store.writer) this.flushHeld() }
  }

  posted(threadId: string): readonly ThreadEvent[] {
    const list = this.byThread.get(threadId)
    if (!list) return NO_EVENTS
    let events: ThreadEvent[] | undefined
    let committed: number | undefined
    for (const posted of list) {
      const own = eventsOfWrite(posted.write, threadId)
      if (own.length === 0) continue
      // A write the worker has begun may have committed already, and then main's connection shows it: it is not laid twice.
      if (posted.sent && posted.sent.worker.started(posted.sent.id)) {
        const base = this.bases.get(threadId)
        if (base) committed ??= this.store.eventsAfterFrontier(threadId, base.seq) - base.settled
        if (committed !== undefined && committed >= own.length) { committed -= own.length; continue }
      }
      (events ??= []).push(...own)
    }
    return events ?? NO_EVENTS
  }

  unconfirmed(threadId?: string): boolean {
    return threadId === undefined ? this.queue.size > 0 : this.wholeCount > 0 || this.byThread.has(threadId)
  }

  /**
   * On the worker, which takes requests in the order posted, so the read comes after every write sent before it. A write
   * held unsent, behind a privacy switch or a recovery, would come after the read, so then the caller reads on main.
   */
  readActivities(threadId: string): Promise<ActivityReadBack> | undefined {
    const worker = this.store.writer
    if (!worker || this.held > 0 || this.switching || this.recovering) return undefined
    return new Promise(resolve => { worker.read(threadId, resolve) })
  }

  confirmed(threadId?: string): Promise<void> {
    if (!this.unconfirmed(threadId)) return Promise.resolve()
    return new Promise(resolve => { this.waiters.push({ threadId, resolve }) })
  }

  drain(limitMs?: number): void {
    const deadline = limitMs === undefined ? undefined : performance.now() + limitMs
    for (let rounds = 0; this.queue.size && rounds < 1_000; rounds++) {
      const worker = this.store.writer
      // Writes sent and unanswered are those not held.
      if (worker && this.queue.size > this.held) {
        if (!worker.drain(deadline === undefined ? undefined : Math.max(0, deadline - performance.now()))) { this.abandon(); return }
        continue
      }
      this.flushHeld()
      if (this.queue.size && !this.store.writer && this.held === 0) { this.abandon(); return }
    }
  }

  close(limitMs?: number): void {
    const deadline = limitMs === undefined ? undefined : performance.now() + limitMs
    try { this.drain(limitMs) } finally {
      this.store.onUnanswered(undefined)
      this.store.close(deadline === undefined ? undefined : Math.max(0, deadline - performance.now()))
    }
  }

  private send(posted: PostedWrite): void {
    const worker = this.store.writer!
    for (const threadId of posted.threads) {
      if (eventsOfWrite(posted.write, threadId).length && !this.bases.has(threadId)) this.bases.set(threadId, { seq: this.store.eventFrontier(threadId), settled: 0 })
    }
    if (posted.write.kind === 'history-off') this.switching = true
    const sent = { worker, id: 0 }
    posted.sent = sent
    sent.id = worker.post(posted.write, result => { this.answered(posted, result) }, () => this.store.preservedThreadIds())
  }

  private answered(posted: PostedWrite, result: StoreWorkerResult): void {
    if (!this.queue.has(posted)) return
    let outcome: ThreadStoreWriteOutcome & { memory?: true | undefined }
    if ('lost' in result) outcome = this.finishOnMain(posted, result.started)
    else {
      outcome = result.outcome
      // What main's connection held of the threads it names is read again; events leave nothing held there.
      if (posted.write.kind !== 'event-batches' && posted.write.kind !== 'events') this.store.committedElsewhere(posted.whole ? undefined : [...posted.threads])
    }
    this.settleEvents(posted, outcome)
    this.remove(posted)
    if (posted.write.kind === 'history-off') {
      this.switching = false
      // The worker took the file's words out and closed it: this run goes on in memory, and so do the writes held behind it.
      if (outcome.memory) this.store.enterMemory()
    }
    posted.confirm?.(outcome)
    this.flushHeld()
    this.wake()
  }

  /** The worker went without answering this write: what it had begun is checked in the file, and the rest is done here. */
  private finishOnMain(posted: PostedWrite, started: boolean): ThreadStoreWriteOutcome {
    const { write } = posted
    if (started && (write.kind === 'event-batches' || write.kind === 'events')) {
      const carried = [...posted.threads].filter(threadId => eventsOfWrite(write, threadId).length)
      const landed = carried.filter(threadId => {
        const base = this.bases.get(threadId)
        return base !== undefined && this.store.eventsAfterFrontier(threadId, base.seq) - base.settled > 0
      })
      // Its transaction committed: a thread whose events are not there failed inside it, and is retried as such.
      if (landed.length) return { failed: new Set(carried.filter(threadId => !landed.includes(threadId))) }
    }
    if (started && write.kind === 'visual' && this.store.hasVisual(write.threadId, write.stored.visual.id)) return { failed: NO_THREADS }
    // Not begun, or a write that may be applied again: it is applied here.
    return applyWrite(this.store, write)
  }

  /** Counts the events a thread now holds from this write, so later checks of what has committed start after them. */
  private settleEvents(posted: PostedWrite, outcome: ThreadStoreWriteOutcome): void {
    if (posted.write.kind !== 'event-batches' && posted.write.kind !== 'events') return
    const whole = outcome.error !== undefined && outcome.failed.size === 0
    for (const threadId of posted.threads) {
      const base = this.bases.get(threadId)
      if (base && !whole && !outcome.failed.has(threadId)) base.settled += eventsOfWrite(posted.write, threadId).length
    }
  }

  private remove(posted: PostedWrite): void {
    if (!this.queue.delete(posted)) return
    if (posted.whole) this.wholeCount--
    if (!posted.sent) this.held--
    for (const threadId of posted.threads) {
      const list = this.byThread.get(threadId)
      if (!list) continue
      const at = list.indexOf(posted)
      if (at >= 0) list.splice(at, 1)
      if (list.length === 0) this.byThread.delete(threadId)
      if (!list.some(other => eventsOfWrite(other.write, threadId).length)) this.bases.delete(threadId)
    }
  }

  /** Sends what waited behind a switch or a recovery, or, with no worker, commits it here, in the order posted. */
  private flushHeld(): void {
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.held > 0 && !this.switching && !this.recovering) {
        let next: PostedWrite | undefined
        for (const posted of this.queue) if (!posted.sent) { next = posted; break }
        if (!next) { this.held = 0; break }
        if (this.store.writer) { this.held--; this.send(next); continue }
        // Without a worker it commits here, once nothing posted ahead of it is still unanswered.
        if (this.queue.values().next().value !== next) break
        const outcome = applyWrite(this.store, next.write)
        this.remove(next)
        next.confirm?.(outcome)
        this.wake()
      }
    } finally { this.flushing = false }
  }

  /** The worker went: this connection writes again, and finishes what the worker had not answered, in order. */
  private recover(unanswered: readonly UnansweredWrite[]): void {
    this.recovering = true
    try { for (const write of unanswered) write.settle({ lost: true, started: write.started }) } finally { this.recovering = false }
    this.flushHeld()
    this.wake()
  }

  /** The worker never answered: shutdown cannot wait longer, so what is left is confirmed as not saved. */
  private abandon(): void {
    console.warn('thread-store-worker-unanswered')
    for (const posted of [...this.queue]) {
      this.remove(posted)
      posted.confirm?.({ failed: new Set(posted.threads), error: new Error('Thread history could not be saved') })
    }
    this.held = 0
    this.switching = false
    this.wake()
  }

  private wake(): void {
    for (let index = this.waiters.length - 1; index >= 0; index--) {
      const waiter = this.waiters[index]!
      if (this.unconfirmed(waiter.threadId)) continue
      this.waiters.splice(index, 1)
      waiter.resolve()
    }
  }
}
