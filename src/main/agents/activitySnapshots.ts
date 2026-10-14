import type { AgentActivity } from '../../shared/agentActivity'
import type { AgentHostSnapshot, AgentModel } from '../../shared/agents'
import type { ActivitySubscriptionOptions, AgentHost } from './host'
import { cloneHostSnapshot } from './cloneHostSnapshot'

/** Only objects copied and recursively frozen here may cross the internal activity subscription
 * without another copy. Object.isFrozen alone says nothing about a caller's nested objects. */
const owned = new WeakSet<object>()

function copy(value: unknown, copies: WeakMap<object, object>, immutable: boolean): unknown {
  if (value === null || typeof value !== 'object' || owned.has(value)) return value
  const previous = copies.get(value)
  if (previous) return previous
  const result = Array.isArray(value) ? value.slice() : { ...value }
  copies.set(value, result)
  const fields = result as Record<string, unknown>
  for (const key of Object.keys(fields)) fields[key] = copy(fields[key], copies, immutable)
  if (immutable) { Object.freeze(result); owned.add(result) }
  return result
}

/** Take ownership without freezing or retaining mutable aliases into the caller's data. The adapter
 * installs the result as its activity array and replaces records/arrays on the next change. The
 * existing AgentActivity shape is retained for readers; writes to this internal view are forbidden. */
export function immutableActivities(activities: readonly AgentActivity[]): AgentActivity[] {
  return copy(activities, new WeakMap(), true) as AgentActivity[]
}

export function isImmutableActivities(activities: readonly AgentActivity[] | undefined): boolean {
  return activities !== undefined && owned.has(activities)
}

/** A record is trusted only when this owner recursively copied and froze it. */
export function isImmutableActivity(activity: AgentActivity): boolean { return owned.has(activity) }

/** A model catalog owned and frozen the same way. Every layer between an adapter and the window then shares one copy
 * until the catalog itself changes, where each used to copy all of it, 608 models on the owner's machine (#917). */
export function immutableModels(models: readonly AgentModel[]): AgentModel[] {
  return copy(models, new WeakMap(), true) as AgentModel[]
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
  return copy(snapshot, new WeakMap(), false) as AgentHostSnapshot
}

/** Legacy hosts can mutate their published arrays, so their updates still take the full copy path. */
export function subscribeActivitySnapshots(host: AgentHost, listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
  return host.subscribeActivitySnapshots ? host.subscribeActivitySnapshots(listener, options) : host.subscribe(listener)
}

/**
 * An adapter's activity subscribers and what each asked for. A publication builds each form of the
 * snapshot once, whichever subscribers want it, and hands every subscriber its own copy.
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
  publish(view: (historyFromEvents: boolean) => AgentHostSnapshot): void {
    const views = new Map<boolean, AgentHostSnapshot>()
    for (const [listener, historyFromEvents] of this.listeners) {
      let snapshot = views.get(historyFromEvents)
      if (!snapshot) { snapshot = view(historyFromEvents); views.set(historyFromEvents, snapshot) }
      listener(cloneActivitySnapshot(snapshot))
    }
  }
}
