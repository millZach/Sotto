import type { AgentThread } from '../../../shared/agents'

/** The thread records this window was last broadcast, as main measures the next broadcast from them. */
interface HeldThreads {
  readonly revision: number
  readonly records: ReadonlyMap<string, AgentThread>
  readonly order: readonly string[]
  readonly list: readonly AgentThread[]
}

/**
 * Puts a broadcast's whole ordered thread array back (issue #1330, ADR-0028's October 22 amendment). Main sends the
 * thread records that changed since the last broadcast this window was sent, the IDs of the threads that went and,
 * when it moved, the order; this keeps the records the window was last sent and rebuilds the array every reader
 * already expects. A record that did not change is the very record the window held, so the state sharing that follows
 * finds it by identity rather than walking it.
 *
 * A broadcast measured from a base this window does not hold, or one that names a thread it cannot find, resolves to
 * undefined and changes nothing held: the page then reads the whole state through `AGENT_GET`, which also tells main
 * to list every record in its next broadcast. A complete broadcast, with a null base, always resolves.
 *
 * Nothing downstream writes into a state it is handed, so a held record is handed out as it is, without a copy.
 */
export function createThreadReassembly(): (wire: unknown) => AgentThread[] | undefined {
  let held: HeldThreads | null = null
  return wire => {
    const next = resolve(held, wire)
    if (next === undefined) return undefined
    held = next
    return [...next.list]
  }
}

function resolve(held: HeldThreads | null, wire: unknown): HeldThreads | undefined {
  if (typeof wire !== 'object' || wire === null || Array.isArray(wire)) return undefined
  const { revision, base, changed, removed, order } = wire as { revision?: unknown; base?: unknown; changed?: unknown; removed?: unknown; order?: unknown }
  if (typeof revision !== 'number' || !Array.isArray(changed) || !changed.every(isRecord)) return undefined
  const records = changed as AgentThread[]
  if (base === null) {
    const map = new Map(records.map(thread => [thread.id, thread] as const))
    return { revision, records: map, order: records.map(thread => thread.id), list: records }
  }
  if (held === null || typeof base !== 'number' || base !== held.revision) return undefined
  if (removed !== undefined && !(Array.isArray(removed) && removed.every(id => typeof id === 'string'))) return undefined
  if (order !== undefined && !(Array.isArray(order) && order.every(id => typeof id === 'string'))) return undefined
  const updates = new Map(records.map(thread => [thread.id, thread] as const))
  if (updates.size !== records.length) return undefined
  const gone = new Set(removed as string[] | undefined)
  for (const id of gone) if (!held.records.has(id)) return undefined
  // Without a new order the threads are the ones held, in the same order: nothing went and nothing is new.
  if (order === undefined && (gone.size > 0 || records.some(thread => !held.records.has(thread.id)))) return undefined
  const ids = (order as string[] | undefined) ?? held.order
  const listed = new Set(ids)
  if (listed.size !== ids.length) return undefined
  const list: AgentThread[] = []
  for (const id of ids) {
    const record = updates.get(id) ?? (gone.has(id) ? undefined : held.records.get(id))
    if (record === undefined) return undefined
    list.push(record)
  }
  // Every changed record has its place, and every held thread is either still listed or said to have gone.
  for (const id of updates.keys()) if (!listed.has(id)) return undefined
  for (const id of held.order) if (gone.has(id) === listed.has(id)) return undefined
  return { revision, records: new Map(list.map(thread => [thread.id, thread] as const)), order: ids, list }
}

function isRecord(value: unknown): value is AgentThread {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'
}
