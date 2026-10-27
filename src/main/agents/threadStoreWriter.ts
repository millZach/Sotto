import type { AgentActivity } from '../../shared/agentActivity'
import type { ThreadEvent } from '../../shared/threadEvents'
import type { WatcherAsk } from '../../shared/watcherAsks'
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
  | ({ readonly kind: 'activity-list'; readonly flushed?: boolean } & ActivityListEntry)
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
  /** Commits and confirms everything posted before it returns: for shutdown, which cannot wait for a confirmation. */
  drain(): void
  /** Commits and confirms everything posted, then closes the store. */
  close(): void
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
        if (write.reopen) store.open()
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
