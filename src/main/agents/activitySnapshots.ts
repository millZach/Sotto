import type { AgentActivity } from '../../shared/agentActivity'
import type { AgentHostSnapshot } from '../../shared/agents'
import type { AgentHost } from './host'
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

/** A private subscription snapshot: mutable metadata belongs to this consumer, while certified
 * activity trees may be shared. Public snapshots still use cloneHostSnapshot and remain writable. */
export function cloneActivitySnapshot(snapshot: AgentHostSnapshot): AgentHostSnapshot {
  // Whole-history legacy hosts have nothing to share. Keep their established clone path
  // instead of checking ownership on every nested object in every retained record.
  if (!snapshot.threads.some(thread => isImmutableActivities(thread.activities))) return cloneHostSnapshot(snapshot)
  return copy(snapshot, new WeakMap(), false) as AgentHostSnapshot
}

/** Legacy hosts can mutate their published arrays, so their updates still take the full copy path. */
export function subscribeActivitySnapshots(host: AgentHost, listener: (snapshot: AgentHostSnapshot) => void): () => void {
  return host.subscribeActivitySnapshots ? host.subscribeActivitySnapshots(listener) : host.subscribe(listener)
}
