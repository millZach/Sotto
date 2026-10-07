/**
 * A Map kept as a small most-recent-first cache: a Map iterates in insertion order, so moving an entry to the end marks
 * it as the most recent and the first entry is the one to drop.
 */

/** Keeps `value` under `key` as the most recent entry, dropping the oldest entries past `limit`. Returns `value`. */
export function keepRecent<K, V>(map: Map<K, V>, key: K, value: V, limit: number): V {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) map.delete(map.keys().next().value!)
  return value
}

/** The value under `key`, marked as the most recent entry, or undefined when there is none. */
export function readRecent<K, V>(map: Map<K, V>, key: K): V | undefined {
  if (!map.has(key)) return undefined
  const value = map.get(key)!
  map.delete(key)
  map.set(key, value)
  return value
}
