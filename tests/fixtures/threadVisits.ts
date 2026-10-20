/**
 * Counting every read of a thread out of a snapshot's or a shell's thread list, as `watcherAtScale.ts` counts Watcher's:
 * each loop step, search step and spread reads an index, and each is one visit. A list is wrapped in a Proxy that counts
 * those reads while `threadVisits.on`. The same list always gets the same Proxy, so code that compares lists by identity
 * behaves as it does on the plain list.
 *
 * `structuredClone` cannot copy a Proxy, so a copier handed a wrapped list must copy `uncounted(value)` instead.
 * `visited`, when set, runs on each counted read, for a test that wants to know where the reads come from.
 */
export const threadVisits = { on: false, count: 0, visited: undefined as (() => void) | undefined }

const plainOf = new WeakMap<object, unknown[]>()
const countedOf = new WeakMap<unknown[], unknown[]>()

/** `threads`, with every read of a thread counted. A list already counted is returned as it is. */
export function countedThreads<T>(threads: T[]): T[] {
  if (plainOf.has(threads)) return threads
  let counted = countedOf.get(threads)
  if (!counted) {
    counted = new Proxy(threads, { get(target, property, receiver) {
      if (threadVisits.on && typeof property === 'string' && /^\d+$/u.test(property)) { threadVisits.count++; threadVisits.visited?.() }
      return Reflect.get(target, property, receiver)
    } })
    countedOf.set(threads, counted); plainOf.set(counted, threads)
  }
  return counted as T[]
}

function plain(list: unknown): unknown[] | undefined { return list !== null && typeof list === 'object' ? plainOf.get(list) : undefined }

/**
 * `value` with its counted thread lists swapped for the plain ones, where a snapshot (`threads`) or a shell
 * (`host.threads`) holds them, so `structuredClone` can copy it. Anything without a counted list is returned as it is.
 */
export function uncounted<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return (plain(value) ?? (value.some(item => uncounted(item) !== item) ? value.map(item => uncounted(item)) : value)) as T
  const holder = value as { threads?: unknown; host?: { threads?: unknown } }
  const threads = plain(holder.threads), host = holder.host && typeof holder.host === 'object' ? uncounted(holder.host) : undefined
  if (!threads && host === holder.host) return value
  return { ...value, ...threads ? { threads } : {}, ...host !== holder.host ? { host } : {} } as T
}
