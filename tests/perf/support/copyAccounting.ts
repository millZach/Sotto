/**
 * How the work budgets size a copy. `streamingCopyBudget.perf.test.ts` and `ownerScaleWorkBudget.perf.test.ts` both
 * count the objects a copier made, wherever it was called from, so a copy made inside another is counted once and a
 * copy that shares its source's trees costs nothing for them. Load it from a `vi.hoisted` block, since the copiers it
 * sizes are mocked before the test's imports run:
 *
 *   const { fresh } = await vi.hoisted(() => import('./support/copyAccounting'))
 */

/** The objects a copy made: those in `copy` that are not the very objects of `original` at the same place. */
export function fresh(copy: unknown, original: unknown, seen = new Set<object>()): number {
  if (copy === null || typeof copy !== 'object' || copy === original || seen.has(copy)) return 0
  seen.add(copy)
  let made = 1
  const from = original !== null && typeof original === 'object' ? original as Record<string, unknown> : undefined
  for (const [key, field] of Object.entries(copy)) made += fresh(field, from?.[key], seen)
  return made
}

/**
 * The objects a copy made over an earlier one (`copyOver`): those in `copy` that are neither the very objects of
 * `original` nor those of `previous` at the same place. A copy that kept all of `previous` made nothing.
 */
export function freshOver(copy: unknown, original: unknown, previous: unknown, seen = new Set<object>()): number {
  if (copy === null || typeof copy !== 'object' || copy === original || copy === previous || seen.has(copy)) return 0
  seen.add(copy)
  let made = 1
  const from = original !== null && typeof original === 'object' ? original as Record<string, unknown> : undefined
  const before = previous !== null && typeof previous === 'object' ? previous as Record<string, unknown> : undefined
  for (const [key, field] of Object.entries(copy)) made += freshOver(field, from?.[key], before?.[key], seen)
  return made
}

/**
 * The objects a `copyOver` call made: for each record, those `freshOver` finds, or those `fresh` finds where it had no
 * previous record. A record kept as its previous made nothing. The list the call returns is its caller's own, built as a
 * snapshot's thread list always is, and is not counted.
 */
export function freshEachOver(copies: readonly unknown[], originals: readonly unknown[], previous: readonly unknown[]): number {
  let made = 0
  for (let index = 0; index < copies.length; index++) {
    const copy = copies[index], before = previous[index]
    if (copy === before) continue
    made += before === undefined ? fresh(copy, originals[index]) : freshOver(copy, originals[index], before)
  }
  return made
}
