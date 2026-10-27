import type { ThreadStore } from '../../src/main/agents/threadStore'
import { applyWrite, eventsOfWrite, writeThreads, writesWholeStore, type ThreadStoreWrite, type ThreadStoreWriteOutcome, type ThreadStoreWriter } from '../../src/main/agents/threadStoreWriter'
import type { ThreadEvent } from '../../src/shared/threadEvents'

interface Posted {
  readonly write: ThreadStoreWrite
  readonly confirm: ((outcome: ThreadStoreWriteOutcome) => void) | undefined
  readonly threads: ReadonlySet<string>
  readonly whole: boolean
}

/**
 * A thread-store writer that holds every confirmation until the test releases it (#1457): what the store worker will be,
 * with the test deciding when each commit lands. A released write is applied to the store and confirmed in one step, in
 * the order it was posted. `holding = false` confirms inside `post`, as the writer on main does.
 */
export class DeferredStoreWriter implements ThreadStoreWriter {
  private readonly queue: Posted[] = []
  private readonly waiters: { readonly threadId: string | undefined; readonly resolve: () => void }[] = []
  /** Every write as it was posted, in order. */
  readonly log: ThreadStoreWrite[] = []
  /** Every write as it was released to the store, in order, a scripted failure included. */
  readonly attempted: ThreadStoreWrite[] = []
  /** Scripts a failure in place of the store: a write this answers true for fails whole and is not applied. */
  failing: ((write: ThreadStoreWrite) => boolean) | undefined
  holding = true

  constructor(private readonly store: ThreadStore) {}

  post(write: ThreadStoreWrite, confirm?: (outcome: ThreadStoreWriteOutcome) => void): void {
    this.log.push(write)
    if (!this.holding) {
      // Applied before the confirmation is called, which an optional call would skip with nobody to confirm to.
      const outcome = this.apply(write)
      confirm?.(outcome)
      return
    }
    this.queue.push({ write, confirm, threads: new Set(writeThreads(write)), whole: writesWholeStore(write) })
  }

  /** How many writes are posted and not yet confirmed. */
  get waiting(): number { return this.queue.length }

  /** Commits and confirms the oldest `count` writes, in the order posted. Says how many it released. */
  release(count = this.queue.length): number {
    let released = 0
    while (released < count && this.queue.length) {
      const posted = this.queue.shift()!
      const outcome = this.apply(posted.write)
      released++
      posted.confirm?.(outcome)
      this.wake()
    }
    return released
  }

  posted(threadId: string): readonly ThreadEvent[] {
    const events: ThreadEvent[] = []
    for (const { write } of this.queue) events.push(...eventsOfWrite(write, threadId))
    return events
  }

  unconfirmed(threadId?: string): boolean {
    return threadId === undefined ? this.queue.length > 0 : this.queue.some(posted => posted.whole || posted.threads.has(threadId))
  }

  confirmed(threadId?: string): Promise<void> {
    if (!this.unconfirmed(threadId)) return Promise.resolve()
    return new Promise(resolve => { this.waiters.push({ threadId, resolve }) })
  }

  drain(): void {
    // A confirmation may post again, as shutdown does once what waited behind a batch can go.
    while (this.queue.length) this.release()
  }

  close(): void {
    this.drain()
    this.store.close()
  }

  private apply(write: ThreadStoreWrite): ThreadStoreWriteOutcome {
    this.attempted.push(write)
    if (this.failing?.(write)) return { failed: new Set(writeThreads(write)), error: new Error('Synthetic writer failure') }
    return applyWrite(this.store, write)
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
