import * as activitySnapshots from '../../src/main/agents/activitySnapshots'
import { ActivitySubscribers, immutableActivities, isImmutableActivities } from '../../src/main/agents/activitySnapshots'
import { AdapterThreadChanges, restOf } from '../../src/main/agents/adapterThreadChanges'
import type { ActivitySubscriptionOptions, ThreadHostEvent } from '../../src/main/agents/host'
import { adapterItemCount, ProviderSnapshotPublisher } from '../../src/main/agents/providerSnapshotPublisher'
import type { ActivityChangesListener, ActivityChangesSubscription } from '../../src/main/agents/threadChanges'
import { ThreadMessageLog } from '../../src/main/agents/threadMessageLog'
import type { AgentHostSnapshot, AgentThread } from '../../src/shared/agents'
import { FakeProviderHost } from './fakeProviderHost'

/**
 * An event-sourced adapter that records through the adapters' log and publishes their certified activity view, with its
 * thread changes beside it (ADR-0016, #925), marking the threads it changes as Claude's adapter does.
 *
 * A test that writes into one of `state.threads` itself calls `mark` with its ID before it publishes, as an adapter's own
 * paths mark what they change; what goes through `log` is marked by the log. The fake host's own commands publish through
 * `emit`, which marks every thread, since they are not instrumented.
 */
export class StreamingAdapter extends FakeProviderHost {
  readonly log = new ThreadMessageLog(id => this.threadChanges.mark(id))
  /** Runs the work of publishing thread changes. The owner-scale fixture leaves it out of what it counts (`ownerScalePipeline`). */
  changesWork: <T>(work: () => T) => T = work => work()
  private readonly activityListeners = new ActivitySubscribers()
  private readonly threadChanges = new AdapterThreadChanges({
    view: historyFromEvents => this.activityView(historyFromEvents),
    thread: (id, historyFromEvents) => {
      const thread = this.state.threads.find(item => item.id === id)
      if (!thread) return undefined
      this.certify([thread])
      return this.log.activityThread(thread, historyFromEvents)
    },
    rest: () => { this.certify([]); return restOf(this.state) },
  })
  private readonly publisher = new ProviderSnapshotPublisher(() => {
    super.emit()
    this.activityListeners.publish(historyFromEvents => this.activityView(historyFromEvents))
    this.changesWork(() => this.threadChanges.publish())
  }, () => adapterItemCount(this.log, this.state.threads))
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void { return this.log.subscribeEvents(listener) }
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
    return this.activityListeners.add(listener, options)
  }
  subscribeActivityChanges(listener: ActivityChangesListener, options?: ActivitySubscriptionOptions): ActivityChangesSubscription {
    return this.threadChanges.subscribeActivityChanges(listener, options)
  }
  observeThreads(threadIds: readonly string[]): void { super.observeThreads(threadIds); this.log.observe([...threadIds]) }
  /** A test changed this thread itself. */
  mark(threadId: string): void { this.threadChanges.mark(threadId) }
  publish(streaming: boolean): void { this.publisher.publish(streaming) }
  emit(): void { this.threadChanges.markAll(); this.publish(false) }
  private certify(threads: AgentThread[]): void {
    // As the adapters do. A revision from before #917 certified activity only.
    if ('certifyActivityView' in activitySnapshots) (activitySnapshots as { certifyActivityView: (state: AgentHostSnapshot, threads: AgentThread[]) => void }).certifyActivityView(this.state, threads)
    else for (const thread of threads) if (thread.activities && !isImmutableActivities(thread.activities)) thread.activities = immutableActivities(thread.activities)
  }
  private activityView(historyFromEvents: boolean): AgentHostSnapshot {
    this.certify(this.state.threads)
    return { ...this.state, threads: this.state.threads.map(thread => this.log.activityThread(thread, historyFromEvents)) }
  }
}
