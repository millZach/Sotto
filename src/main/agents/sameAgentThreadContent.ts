import { isDeepStrictEqual } from 'node:util'
import type { AgentThread } from '../../shared/agents'
import { cloneAgentThread } from '../../shared/cloneAgentThread'

interface OwnedShape { prototype: unknown; array: boolean; length?: number; keys: string[] }
// Only private comparison snapshots enter as the left operand. They are never edited or exposed;
// weak keys release this metadata when deletion or changed content replaces those snapshots.
let ownedShapes: WeakMap<object, OwnedShape> | undefined

export function ownAgentThreadSnapshot(thread: AgentThread): AgentThread {
  const cache = ownedShapes ??= new WeakMap<object, OwnedShape>()
  return cloneAgentThread(thread, (container, keys, array) => {
    cache.set(container, { prototype: array ? Array.prototype : Object.prototype, array, ...(array ? { length: (container as unknown[]).length } : {}), keys })
  })
}

function shapeOf(owned: object): OwnedShape {
  const cache = ownedShapes ??= new WeakMap<object, OwnedShape>()
  let shape = cache.get(owned)
  if (!shape) {
    const array = Array.isArray(owned)
    shape = { prototype: Object.getPrototypeOf(owned), array, ...(array ? { length: owned.length } : {}), keys: Object.keys(owned) }
    cache.set(owned, shape)
  }
  return shape
}

/** Main-only equality for inert shell data. Local control.shell and remote shell reads materialize
 * their data with structuredClone before the router projects it. This does not compare arbitrary
 * accessor-bearing JavaScript objects, certify incoming references, or ignore unknown fields. */
export function sameAgentThreadContent(owned: AgentThread, incoming: AgentThread): boolean {
  const compare = (left: unknown, right: unknown, depth: number): boolean | undefined => {
    if (Object.is(left, right)) return true
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
    if (depth > 64) return undefined // Cycles and unusually deep data restart at the native root.
    const shape = shapeOf(left), prototype = shape.prototype
    if (prototype !== Object.getPrototypeOf(right)) return false
    const array = shape.array
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return undefined
    // Owned plain copies have no symbol keys. Incoming symbols retain native equality semantics.
    if (Object.getOwnPropertySymbols(right).length) return undefined
    if (array && shape.length !== (right as unknown[]).length) return false
    const keys = shape.keys
    const incomingKeys = Object.keys(right)
    if (keys.length !== incomingKeys.length) return false
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!
      // The normal projection preserves key order. A different order is not a content change;
      // compare the original roots natively instead of allocating a per-object key set.
      if (incomingKeys[index] !== key) return undefined
      const equal = compare((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], depth + 1)
      if (equal !== true) return equal
    }
    return true
  }
  return compare(owned, incoming, 0) ?? isDeepStrictEqual(owned, incoming)
}
