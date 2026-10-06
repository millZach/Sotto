/**
 * Whether two host snapshots, or any two parts of them, say the same thing. Snapshots are plain schema data, so
 * this is a structural comparison that returns as soon as it meets the same object twice, which is what makes it
 * cheap: an adapter hands back the same frozen activity records until they change (`activitySnapshots.ts`), and the
 * workspace keeps a thread's message window while nothing new arrived. A field set to `undefined` says the same as
 * one left out, since the hosts write both and neither survives a copy to disk or across a socket.
 *
 * Used where a read before a send would otherwise write and publish a state it did not change (#765).
 */
export function sameSnapshot(first: unknown, second: unknown): boolean {
  if (first === second) return true
  if (typeof first !== 'object' || typeof second !== 'object' || first === null || second === null) return Number.isNaN(first) && Number.isNaN(second)
  if (Array.isArray(first)) {
    if (!Array.isArray(second) || first.length !== second.length) return false
    for (let index = 0; index < first.length; index++) if (!sameSnapshot(first[index], second[index])) return false
    return true
  }
  if (Array.isArray(second)) return false
  const left = first as Record<string, unknown>, right = second as Record<string, unknown>
  let fields = 0
  for (const key of Object.keys(left)) {
    if (left[key] === undefined) continue
    fields++
    if (!Object.hasOwn(right, key) || !sameSnapshot(left[key], right[key])) return false
  }
  for (const key of Object.keys(right)) if (right[key] !== undefined) fields--
  return fields === 0
}
