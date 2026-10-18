import type { AgentHostSnapshot } from '../../shared/agents'

/**
 * Host snapshots contain plain schema data. Copy their mutable containers while
 * retaining immutable strings: structuredClone serializes large retained command
 * outputs again on every provider update, even when those outputs have not changed.
 */
export function cloneHostSnapshot(snapshot: AgentHostSnapshot): AgentHostSnapshot {
  return cloneValue(snapshot, new WeakMap()) as AgentHostSnapshot
}

/**
 * A copy of other plain schema data the same way, such as Watcher's record: several times faster than structuredClone,
 * which serializes every string again.
 */
export function clonePlainData<T>(value: T): T {
  return cloneValue(value, new WeakMap()) as T
}

function cloneValue(value: unknown, copies: WeakMap<object, object>): unknown {
  if (value === null || typeof value !== 'object') return value
  const previous = copies.get(value)
  if (previous) return previous
  // Spread creates own data properties, including __proto__, without invoking
  // Object.prototype setters. Slice preserves an array's length and empty slots.
  const copy = Array.isArray(value) ? value.slice() : { ...value }
  copies.set(value, copy)
  const fields = copy as Record<string, unknown>
  for (const key of Object.keys(fields)) fields[key] = cloneValue(fields[key], copies)
  return copy
}
