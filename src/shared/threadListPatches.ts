/**
 * Host snapshots whose thread list was made from an earlier one's by replacing records in place (ADR-0016, #925): the same
 * threads in the same order, with the record at some positions replaced and every other the very record the earlier list
 * held. The coordinator notes how each broadcast's list was made, and the router, which made something of the earlier
 * list, remakes only those positions and notes its own the same way. A host noted nowhere is read whole, as every host
 * was. Kept by the snapshot object, never serialized, and nothing here crosses IPC or the socket.
 */
const patches = new WeakMap<object, { readonly from: object; readonly at: readonly number[] }>()
const NONE: ReadonlySet<number> = new Set()

/** `host`'s threads are `from`'s with the records at `at` replaced in place, and every other the same record. */
export function noteThreadsReplaced(host: object, from: object, at: readonly number[]): void {
  if (host !== from) patches.set(host, { from, at })
}

/**
 * The positions whose records were replaced between `from`'s threads and `host`'s, following at most `steps` notes back
 * from `host`; undefined when `host`'s threads were not made from `from`'s that way, and must be read whole.
 */
export function threadsReplacedSince(host: object, from: object, steps = 8): ReadonlySet<number> | undefined {
  if (host === from) return NONE
  const at = new Set<number>()
  let current = host
  for (let step = 0; step < steps; step++) {
    const patch = patches.get(current)
    if (!patch) return undefined
    for (const position of patch.at) at.add(position)
    if (patch.from === from) return at
    current = patch.from
  }
  return undefined
}
