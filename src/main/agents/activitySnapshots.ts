import type { AgentActivity } from '../../shared/agentActivity'
import type { AgentHostSnapshot, AgentModel } from '../../shared/agents'
import type { ActivitySubscriptionOptions, AgentHost } from './host'
import { cloneHostSnapshot, copyUnshared } from './cloneHostSnapshot'

/** Only objects copied and recursively frozen here may cross the internal activity subscription
 * without another copy. Object.isFrozen alone says nothing about a caller's nested objects. */
const owned = new WeakSet<object>()

const isOwned = (value: object): boolean => owned.has(value)
const own = (value: object): void => { Object.freeze(value); owned.add(value) }

function copy(value: unknown, immutable: boolean): unknown {
  return copyUnshared(value, isOwned, immutable ? own : undefined)
}

/** Take ownership without freezing or retaining mutable aliases into the caller's data. The adapter
 * installs the result as its activity array and replaces records/arrays on the next change. The
 * existing AgentActivity shape is retained for readers; writes to this internal view are forbidden. */
export function immutableActivities(activities: readonly AgentActivity[]): AgentActivity[] {
  return copy(activities, true) as AgentActivity[]
}

export function isImmutableActivities(activities: readonly AgentActivity[] | undefined): boolean {
  return activities !== undefined && owned.has(activities)
}

/** A record is trusted only when this owner recursively copied and froze it. */
export function isImmutableActivity(activity: AgentActivity): boolean { return owned.has(activity) }

/** Owns a record its caller has just built and nobody else holds, such as one the schema parsed off the disk: with no
 * alias to keep apart from, it is frozen and owned where it is rather than copied first (#1333). */
export function ownBuiltActivity(activity: AgentActivity): AgentActivity {
  ownInPlace(activity)
  return activity
}

function ownInPlace(value: unknown): void {
  if (value === null || typeof value !== 'object' || owned.has(value)) return
  for (const child of Object.values(value)) ownInPlace(child)
  own(value)
}

/** A model catalog owned and frozen the same way. Every layer between an adapter and the window then shares one copy
 * until the catalog itself changes, where each used to copy all of it, 608 models on the owner's machine (#917). */
export function immutableModels(models: readonly AgentModel[]): AgentModel[] {
  return copy(models, true) as AgentModel[]
}

export function isImmutableModels(models: readonly AgentModel[] | undefined): boolean {
  return models !== undefined && owned.has(models)
}

/** What an adapter does before it builds its activity view: it takes ownership of each thread's activity and of its
 * model catalog, which it only ever replaces, never edits. */
export function certifyActivityView(state: { models: AgentModel[] }, threads: Iterable<{ activities?: AgentActivity[] | undefined }>): void {
  for (const thread of threads) if (thread.activities && !isImmutableActivities(thread.activities)) thread.activities = immutableActivities(thread.activities)
  if (!isImmutableModels(state.models)) state.models = immutableModels(state.models)
}

/** A private subscription snapshot: mutable metadata belongs to this consumer, while certified
 * activity trees may be shared. It is also what an adapter hands back for a thread refresh or settings
 * result that asked for history from events (#368). Every other public snapshot still uses
 * cloneHostSnapshot and remains writable. */
export function cloneActivitySnapshot(snapshot: AgentHostSnapshot): AgentHostSnapshot {
  // Whole-history legacy hosts have nothing to share. Keep their established clone path
  // instead of checking ownership on every nested object in every retained record.
  if (!isImmutableModels(snapshot.models) && !snapshot.threads.some(thread => isImmutableActivities(thread.activities))) return cloneHostSnapshot(snapshot)
  return copy(snapshot, false) as AgentHostSnapshot
}

/** Legacy hosts can mutate their published arrays, so their updates still take the full copy path. */
export function subscribeActivitySnapshots(host: AgentHost, listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
  return host.subscribeActivitySnapshots ? host.subscribeActivitySnapshots(listener, options) : host.subscribe(listener)
}

/**
 * Snapshots an activity subscription handed out as a publication: copied once for all its subscribers, so none of its
 * containers is the publisher's own, and read by each without being written into (ADR-0016, October 19 amendment).
 * A subscriber may keep one as it is rather than copy it again, as long as it changes only containers it made itself.
 * Like the certificate on activity trees, this mark is held in a weak set and never serialized.
 */
const publications = new WeakSet<AgentHostSnapshot>()

/** Whether this snapshot is a publication: one its subscribers share and may keep without a copy. */
export function isActivityPublication(snapshot: AgentHostSnapshot): boolean { return publications.has(snapshot) }

/** A snapshot a subscriber built over a publication's data, such as new thread records naming Sotto's IDs, is one too. */
export function asActivityPublication(snapshot: AgentHostSnapshot, from: AgentHostSnapshot): AgentHostSnapshot {
  if (publications.has(from)) publications.add(snapshot)
  return snapshot
}

/**
 * An adapter's activity subscribers and what each asked for. A publication builds each form of the snapshot once,
 * whichever subscribers want it, copies it once, and hands that one copy to every subscriber of the form. Every
 * subscriber only reads it: one that changed it would change it for the others, so a subscriber changes only containers
 * it made itself. It was a copy per subscriber, and every one copied every thread (October 19, 2026).
 */
export class ActivitySubscribers {
  private readonly listeners = new Map<(snapshot: AgentHostSnapshot) => void, boolean>()
  get size(): number { return this.listeners.size }
  /** True when there is a subscriber and every one keeps history from events. */
  everyAsked(): boolean { return this.listeners.size > 0 && [...this.listeners.values()].every(Boolean) }
  add(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
    this.listeners.set(listener, options?.historyFromEvents === true)
    return () => this.listeners.delete(listener)
  }
  /**
   * `detached`: the view is already a snapshot of its own, its containers built for this publication over data that is
   * only ever replaced, never edited, so it goes out without a copy. The provider switch's aggregate is one.
   */
  publish(view: (historyFromEvents: boolean) => AgentHostSnapshot, detached = false): void {
    const views = new Map<boolean, AgentHostSnapshot>()
    for (const [listener, historyFromEvents] of this.listeners) {
      let snapshot = views.get(historyFromEvents)
      if (!snapshot) {
        snapshot = detached ? view(historyFromEvents) : cloneActivitySnapshot(view(historyFromEvents))
        publications.add(snapshot); views.set(historyFromEvents, snapshot)
      }
      listener(snapshot)
    }
  }
}
