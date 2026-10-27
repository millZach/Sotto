/**
 * Host snapshots whose thread list was made from an earlier one's by replacing records in place (ADR-0016, #925): the same
 * threads in the same order, with the record at some positions replaced and every other the very record the earlier list
 * held. The coordinator notes how each broadcast's list was made, and the router, which made something of the earlier
 * list, remakes only those positions and notes its own the same way. A host noted nowhere is read whole, as every host
 * was. Kept by the snapshot object, never serialized, and nothing here crosses IPC or the socket.
 *
 * A note names the snapshots before it weakly. Each broadcast notes the one before it, so a note holding it strongly would
 * keep every broadcast since the last whole one alive, with every record each replaced (#925 review). Each note carries
 * the steps of the note it was made after, up to `STEPS` of them, each naming its snapshot weakly beside the positions
 * that step replaced. So a reader still holding the snapshot it last made something of finds it from the latest though a
 * snapshot between them has gone, as one the window's broadcast skipped while publishes were coalesced has (#925 step 6).
 * Only the positions are held, never a snapshot or a record.
 */
interface Step { readonly from: WeakRef<object>; readonly at: readonly number[] }
const patches = new WeakMap<object, readonly Step[]>()
const NONE: ReadonlySet<number> = new Set()
/** The most steps a note carries, and so the furthest back a reader can find the snapshot it holds. */
const STEPS = 8

/** `host`'s threads are `from`'s with the records at `at` replaced in place, and every other the same record. */
export function noteThreadsReplaced(host: object, from: object, at: readonly number[]): void {
  if (host === from) return
  const earlier = patches.get(from)
  patches.set(host, [{ from: new WeakRef(from), at }, ...earlier ? earlier.slice(0, STEPS - 1) : []])
}

/**
 * The positions whose records were replaced between `from`'s threads and `host`'s, following at most `steps` notes back
 * from `host`; undefined when `host`'s threads were not made from `from`'s that way within them, and must be read whole.
 */
export function threadsReplacedSince(host: object, from: object, steps = STEPS): ReadonlySet<number> | undefined {
  if (host === from) return NONE
  const chain = patches.get(host)
  if (!chain) return undefined
  const at = new Set<number>()
  for (let step = 0; step < Math.min(steps, chain.length); step++) {
    const { from: before, at: replaced } = chain[step]!
    for (const position of replaced) at.add(position)
    // A snapshot that has gone is passed over: the positions its step replaced still count, and the one it was made from
    // is the next step's.
    if (before.deref() === from) return at
  }
  return undefined
}
