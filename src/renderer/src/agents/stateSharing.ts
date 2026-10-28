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
 * (a class instance, a function, a Date) is taken from the new value as it is. Values compare as `Object.is` does, so
 * a part holding NaN, such as a row's unknown activity time, is unchanged when it is NaN on both sides.
 */

type Plain = Record<string, unknown>
type SharedArrays = WeakMap<object, unknown>

function isPlain(value: unknown): value is Plain {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/**
 * How an array's elements are matched across two states: by their own identity where they carry one, so an
 * item that moved keeps its reference. Sotto's lists are keyed by `id`, by the thread they belong to, or by
 * the draft a delivery reports on. An item the old array already held, the same reference, is matched to itself
 * wherever it moved, so a list of derived facts re-sorted around one changed item (a project folder's rows) is not
 * walked item against neighbour.
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
  const held = new Set<unknown>()
  for (const item of previous) {
    held.add(item)
    const key = keyOf(item)
    if (key !== undefined && !byKey.has(key)) byKey.set(key, item)
  }
  let same = previous.length === next.length
  let borrowed = false
  const shared = next.map((item, index) => {
    if (held.has(item)) {
      if (!Object.is(item, previous[index])) same = false
      return item
    }
    const key = keyOf(item)
    const candidate = key !== undefined && byKey.has(key) ? byKey.get(key) : previous[index]
    const value = shareValue(candidate, item, arrays)
    if (!Object.is(value, previous[index])) same = false
    if (!Object.is(value, item)) borrowed = true
    return value
  })
  return same ? previous : borrowed ? shared : next
}

function shareMap(previous: ReadonlyMap<unknown, unknown>, next: ReadonlyMap<unknown, unknown>, arrays?: SharedArrays): ReadonlyMap<unknown, unknown> {
  let same = previous.size === next.size
  let borrowed = false
  const shared = new Map<unknown, unknown>()
  for (const [key, value] of next) {
    const held = shareValue(previous.get(key), value, arrays)
    if (!previous.has(key) || !Object.is(previous.get(key), held)) same = false
    if (!Object.is(held, value)) borrowed = true
    shared.set(key, held)
  }
  return same ? previous : borrowed ? shared : next
}

function shareObject(previous: Plain, next: Plain, arrays?: SharedArrays): Plain {
  const keys = Object.keys(next)
  let same = keys.length === Object.keys(previous).length
  let borrowed = false
  const shared: Plain = {}
  for (const key of keys) {
    const value = shareValue(previous[key], next[key], arrays)
    if (!(key in previous) || !Object.is(previous[key], value)) same = false
    if (!Object.is(value, next[key])) borrowed = true
    shared[key] = value
  }
  return same ? previous : borrowed ? shared : next
}

/**
 * The new value with every unchanged part replaced by the old value's reference for it. A new value that borrows
 * nothing is handed back as it is, so a value already shared against the old one comes back the same reference when
 * shared against it again (a page's described rows, then `useShared` over them).
 */
export function share<T>(previous: unknown, next: T): T {
  return shareValue(previous, next)
}

/**
 * One connection's immutable snapshots reuse catalog and retained-history arrays.
 * Remember their reconciled arrays, so a later shell can compare identities rather
 * than walk the same history again. Weak keys release histories when their source
 * arrays leave the connection's cache. Each new array still reconciles normally.
 *
 * A plain object reconciled into another one is remembered the same way. The page hands
 * every broadcast the thread records it was last sent for threads that did not change
 * (issue #1330), so a record once reconciled meets the state's own record by identity
 * on every broadcast after it, rather than being walked again each time.
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
  if (isPlain(previous) && isPlain(next)) {
    const remembered = arrays?.get(next)
    if (remembered !== undefined) return shareValue(previous, remembered) as T
    const result = shareObject(previous, next, arrays)
    if (result !== next) arrays?.set(next, result)
    return result as T
  }
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
