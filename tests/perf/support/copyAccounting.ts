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
