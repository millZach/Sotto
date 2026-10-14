import type { AgentThread } from './agents'

/** Shell threads contain plain schema data. Own their containers without serializing strings again. */
export function cloneAgentThread(thread: AgentThread, ownContainer?: (container: object, keys: string[], array: boolean) => void): AgentThread {
  const copies = new WeakMap<object, object>()
  const native = {}
  const copy = (value: unknown): unknown => {
    if (typeof value === 'function' || typeof value === 'symbol') throw native
    if (value === null || typeof value !== 'object') return value
    const previous = copies.get(value)
    if (previous) return previous
    const array = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw native
    const result = array ? new Array(value.length) : {}
    copies.set(value, result)
    const fields = result as Record<string, unknown>
    const keys = Object.keys(value)
    for (const key of keys) {
      const owned = copy((value as Record<string, unknown>)[key])
      // Native clone ignores symbol keys and preserves own __proto__ without its inherited setter.
      if (key === '__proto__') Object.defineProperty(fields, key, { value: owned, enumerable: true, writable: true, configurable: true })
      else fields[key] = owned
    }
    ownContainer?.(result, keys, array)
    return result
  }
  try { return copy(thread) as AgentThread } catch (error) {
    if (error !== native) throw error
    // Unknown non-schema fields retain native clone semantics, including graph ownership and errors.
    return structuredClone(thread)
  }
}
