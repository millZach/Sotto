import type { SubscriptionAccount, SubscriptionProvider } from '../../shared/agents'
import type { SubscriptionClient } from './subscriptionTypes'

export interface AgentReasoner {
  close?(): Promise<void>
  account?(provider: SubscriptionProvider): Promise<SubscriptionAccount>
}

export class ConfiguredAgentReasoner implements AgentReasoner {
  private readonly shutdown = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private closing: Promise<void> | undefined

  /** Stop admission immediately, cancel owned I/O, then wait for process cleanup. */
  close(): Promise<void> {
    this.shutdown.abort(new Error('Sotto reasoning stopped.'))
    this.closing ??= Promise.allSettled([...this.operations]).then(() => undefined)
    return this.closing
  }
  private run<T>(work: () => Promise<T>): Promise<T> {
    if (this.shutdown.signal.aborted) return Promise.reject(this.shutdown.signal.reason)
    const pending = Promise.resolve().then(async () => {
      this.shutdown.signal.throwIfAborted()
      const value = await work()
      this.shutdown.signal.throwIfAborted()
      return value
    })
    this.operations.add(pending)
    void pending.then(() => this.operations.delete(pending), () => this.operations.delete(pending))
    return pending
  }
  constructor(private readonly subscriptions: Partial<Record<SubscriptionProvider, SubscriptionClient>> = {}) {}
  async account(provider: SubscriptionProvider): Promise<SubscriptionAccount> {
    const client = this.subscriptions[provider]
    if (!client) return { provider, label: provider, installed: false, ready: false, models: [], detail: 'This subscription client is unavailable in this build.' }
    return this.run(() => client.status(this.shutdown.signal))
  }
}
