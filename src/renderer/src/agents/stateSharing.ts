import { useRef } from 'react'

/**
 * Structural sharing for the state the window receives and the facts it derives from it.
 *
 * Main publishes a whole new state object on every provider event, streaming chunks included, so every
 * object in it is new even when nothing in that part changed. `share` walks the new value against the old
 * one and keeps the old reference wherever the two are equal, so a `useMemo` over a thread, a message or a
 * project hits and a `memo` child skips. The result is always equal to the new value; only identity is
 * borrowed from the old one.
 *
 * It covers what agent state is made of: plain objects, arrays, maps and primitives. Anything else
 * (a class instance, a function, a Date) is taken from the new value as it is.
 */

type Plain = Record<string, unknown>
type SharedArrays = WeakMap<readonly unknown[], readonly unknown[]>

function isPlain(value: unknown): value is Plain {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/**
 * How an array's elements are matched across two states: by their own identity where they carry one, so an
 * item that moved keeps its reference. Sotto's lists are keyed by `id`, by the thread they belong to, or by
 * the draft a delivery reports on.
 */
function keyOf(value: unknown): string | undefined {
  if (!isPlain(value)) return undefined
  const { id, threadId, draftId, requestId, projectId } = value
  if (typeof id === 'string') return id
  const parts = [threadId, draftId, requestId, projectId].filter(part => typeof part === 'string')
  return parts.length > 0 ? parts.join('|') : undefined
}

function shareArray(previous: readonly unknown[], next: readonly unknown[], arrays?: SharedArrays): readonly unknown[] {
  const byKey = new Map<string, unknown>()
  for (const item of previous) {
    const key = keyOf(item)
    if (key !== undefined && !byKey.has(key)) byKey.set(key, item)
  }
  let same = previous.length === next.length
  const shared = next.map((item, index) => {
    const key = keyOf(item)
    const candidate = key !== undefined && byKey.has(key) ? byKey.get(key) : previous[index]
    const value = shareValue(candidate, item, arrays)
    if (value !== previous[index]) same = false
    return value
  })
  return same ? previous : shared
}

function shareMap(previous: ReadonlyMap<unknown, unknown>, next: ReadonlyMap<unknown, unknown>, arrays?: SharedArrays): ReadonlyMap<unknown, unknown> {
  let same = previous.size === next.size
  const shared = new Map<unknown, unknown>()
  for (const [key, value] of next) {
    const held = shareValue(previous.get(key), value, arrays)
    if (!previous.has(key) || previous.get(key) !== held) same = false
    shared.set(key, held)
  }
  return same ? previous : shared
}

function shareObject(previous: Plain, next: Plain, arrays?: SharedArrays): Plain {
  const keys = Object.keys(next)
  let same = keys.length === Object.keys(previous).length
  const shared: Plain = {}
  for (const key of keys) {
    const value = shareValue(previous[key], next[key], arrays)
    if (!(key in previous) || previous[key] !== value) same = false
    shared[key] = value
  }
  return same ? previous : shared
}

/** The new value with every unchanged part replaced by the old value's reference for it. */
export function share<T>(previous: unknown, next: T): T {
  return shareValue(previous, next)
}

/**
 * One connection's immutable snapshots reuse catalog and retained-history arrays.
 * Remember their reconciled arrays, so a later shell can compare identities rather
 * than walk the same history again. Weak keys release histories when their source
 * arrays leave the connection's cache. Each new array still reconciles normally.
 */
export function createStateSharing(): typeof share {
  const arrays: SharedArrays = new WeakMap()
  return (previous, next) => shareValue(previous, next, arrays)
}

function shareValue<T>(previous: unknown, next: T, arrays?: SharedArrays): T {
  if (Object.is(previous, next)) return next
  if (Array.isArray(previous) && Array.isArray(next)) {
    const remembered = arrays?.get(next)
    const result = remembered === undefined ? shareArray(previous, next, arrays) : shareValue(previous, remembered)
    arrays?.set(next, result)
    return result as T
  }
  if (previous instanceof Map && next instanceof Map) return shareMap(previous, next, arrays) as T
  if (isPlain(previous) && isPlain(next)) return shareObject(previous, next, arrays) as T
  return next
}

/**
 * Holds the last value this component saw and borrows its identity for everything the new one repeats.
 * For derived facts (rows, project folders, activity placement) whose inputs are already shared, so a
 * memoised child sees the same props it saw before.
 */
export function useShared<T>(value: T): T {
  const held = useRef<T | undefined>(undefined)
  const shared = share(held.current, value)
  held.current = shared
  return shared
}
