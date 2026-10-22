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

/**
 * A copy of plain schema data that keeps, as they are, the objects `shared` says may be shared, and hands each object it
 * does copy to `seal` once its fields are copied. This is how an activity snapshot is copied around its certified trees.
 */
export function copyUnshared<T>(value: T, shared: (value: object) => boolean, seal?: (copy: object) => void): T {
  return copyValue(value, new WeakMap(), shared, seal) as T
}

function copyValue(value: unknown, copies: WeakMap<object, object>, shared: (value: object) => boolean, seal: ((copy: object) => void) | undefined): unknown {
  if (value === null || typeof value !== 'object' || shared(value)) return value
  const previous = copies.get(value)
  if (previous) return previous
  const result = Array.isArray(value) ? value.slice() : { ...value }
  copies.set(value, result)
  const fields = result as Record<string, unknown>
  for (const key of Object.keys(fields)) fields[key] = copyValue(fields[key], copies, shared, seal)
  seal?.(result)
  return result
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
