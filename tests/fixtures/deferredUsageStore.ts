/**
 * A Usage store client that answers later and in order, as the usage store worker does (ADR-0083, October 27
 * amendment), through the same request code as the store on main. It holds every request until `drain`, which answers
 * them one a turn, so a test can keep the writer busy while something else goes on.
 */
import type { UsageStore } from '../../src/main/agents/usageStore'
import { UsageStoreOnMain, type UsageStoreClient } from '../../src/main/agents/usageStoreClient'
import type { UsageStoreAnswers, UsageStoreRequest } from '../../src/main/agents/usageStoreRequests'

export class DeferredUsageStore implements UsageStoreClient {
  readonly takesHistory = true
  private readonly inner: UsageStoreOnMain
  private readonly queue: (() => void)[] = []
  constructor(store: UsageStore) { this.inner = new UsageStoreOnMain(store) }

  /** How many requests are held. */
  get held(): number { return this.queue.length }

  request<K extends UsageStoreRequest['kind']>(request: Extract<UsageStoreRequest, { kind: K }>): Promise<UsageStoreAnswers[K]> {
    return new Promise<UsageStoreAnswers[K]>((resolve, reject) => {
      this.queue.push(() => { try { resolve(this.inner.request<K>(request)) } catch (error) { reject(error) } })
    })
  }

  /** Answers what is held, and what arrives meanwhile, until nothing has arrived for a few turns. */
  async drain(): Promise<void> {
    for (let idle = 0; idle < 3;) {
      const next = this.queue.shift()
      if (next) { idle = 0; next() } else idle += 1
      await new Promise(resolve => setImmediate(resolve))
    }
  }

  close(): void { while (this.queue.length) this.queue.shift()!(); this.inner.close() }
}
