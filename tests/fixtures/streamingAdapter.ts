import * as activitySnapshots from '../../src/main/agents/activitySnapshots'
import { ActivitySubscribers, immutableActivities, isImmutableActivities } from '../../src/main/agents/activitySnapshots'
import type { ActivitySubscriptionOptions, ThreadHostEvent } from '../../src/main/agents/host'
import { adapterItemCount, ProviderSnapshotPublisher } from '../../src/main/agents/providerSnapshotPublisher'
import { ThreadMessageLog } from '../../src/main/agents/threadMessageLog'
import type { AgentHostSnapshot, AgentThread } from '../../src/shared/agents'
import { FakeProviderHost } from './fakeProviderHost'

/** An event-sourced adapter that records through the adapters' log and publishes their certified activity view. */
export class StreamingAdapter extends FakeProviderHost {
  readonly log = new ThreadMessageLog()
  private readonly activityListeners = new ActivitySubscribers()
  private readonly publisher = new ProviderSnapshotPublisher(() => {
    super.emit()
    this.activityListeners.publish(historyFromEvents => this.activityView(historyFromEvents))
  }, () => adapterItemCount(this.log, this.state.threads))
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void { return this.log.subscribeEvents(listener) }
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
    return this.activityListeners.add(listener, options)
  }
  observeThreads(threadIds: readonly string[]): void { super.observeThreads(threadIds); this.log.observe([...threadIds]) }
  publish(streaming: boolean): void { this.publisher.publish(streaming) }
  emit(): void { this.publish(false) }
  private activityView(historyFromEvents: boolean): AgentHostSnapshot {
    // As the adapters do. A revision from before #917 certified activity only.
    if ('certifyActivityView' in activitySnapshots) (activitySnapshots as { certifyActivityView: (state: AgentHostSnapshot, threads: AgentThread[]) => void }).certifyActivityView(this.state, this.state.threads)
    else for (const thread of this.state.threads) if (thread.activities && !isImmutableActivities(thread.activities)) thread.activities = immutableActivities(thread.activities)
    return { ...this.state, threads: this.state.threads.map(thread => this.log.activityThread(thread, historyFromEvents)) }
  }
}
