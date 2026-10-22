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

/**
 * Each of `values` copied the way `copyUnshared` copies plain schema data, keeping every part of the item of `previous`
 * at the same place that it still equals. `previous` holds what this returned for the same records last time, undefined
 * where there was none; only its parts that `shared` says may be shared are kept, since anything else may have been
 * written into since. An item that equals its previous comes back as that previous itself, having been read rather than
 * copied. The list this returns is the caller's own and is not sealed. One call copies a whole publication's records,
 * which is how a publication shares what has not changed since the last one (#1326).
 */
export function copyOver<T>(values: readonly T[], previous: readonly (T | undefined)[], shared: (value: object) => boolean, seal: (copy: object) => void): T[] {
  return values.map((value, index) => updateValue(value, previous[index], shared, seal) as T)
}

function updateValue(value: unknown, previous: unknown, shared: (value: object) => boolean, seal: (copy: object) => void): unknown {
  if (value === null || typeof value !== 'object' || shared(value)) return value
  // Only a shared object is known not to have changed since it was made; anything else may have been written into.
  const prior = previous !== null && typeof previous === 'object' && shared(previous) ? previous : undefined
  if (Array.isArray(value)) {
    const hint = Array.isArray(prior) ? prior as readonly unknown[] : undefined
    const before = hint && hint.length === value.length ? hint : undefined
    let result: unknown[] | undefined = before ? undefined : value.slice()
    for (let index = 0; index < value.length; index++) {
      const item = updateValue(value[index], hint?.[index], shared, seal)
      if (result) result[index] = item
      else if (!Object.is(item, before![index])) {
        result = value.slice()
        for (let kept = 0; kept < index; kept++) result[kept] = before![kept]
        result[index] = item
      }
    }
    if (!result) return before
    seal(result)
    return result
  }
  const fields = value as Record<string, unknown>
  const keys = Object.keys(fields)
  const hint = prior && !Array.isArray(prior) ? prior as Readonly<Record<string, unknown>> : undefined
  let before = hint
  if (before) {
    const priorKeys = Object.keys(before)
    if (priorKeys.length !== keys.length || priorKeys.some((key, index) => key !== keys[index])) before = undefined
  }
  let result: Record<string, unknown> | undefined = before ? undefined : { ...fields }
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!
    const item = updateValue(fields[key], hint && Object.hasOwn(hint, key) ? hint[key] : undefined, shared, seal)
    if (result) result[key] = item
    else if (!Object.is(item, before![key])) {
      result = { ...fields }
      for (let kept = 0; kept < index; kept++) result[keys[kept]!] = before![keys[kept]!]
      result[key] = item
    }
  }
  if (!result) return before
  seal(result)
  return result
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
