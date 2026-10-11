import { certifyActivityView, cloneActivitySnapshot } from '../../src/main/agents/activitySnapshots'
import type { AgentHostSnapshot } from '../../src/shared/agents'
import { FakeProviderHost } from './fakeProviderHost'

/** Publishes the way the adapters do since #917: its activity and its catalog certified, each subscriber handed its own snapshot. */
export class CertifyingProviderHost extends FakeProviderHost {
  private readonly activityListeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void): () => void {
    this.activityListeners.add(listener); return () => this.activityListeners.delete(listener)
  }
  emitActivity(): void {
    certifyActivityView(this.state, this.state.threads)
    for (const listener of this.activityListeners) listener(cloneActivitySnapshot(this.state))
  }
  /** A command's result publishes the same way. */
  override emit(): void { this.emitActivity() }
}
