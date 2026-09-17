import { expect } from 'vitest'

/**
 * An absolute wall-clock budget measures the machine, not the code: a shared CI runner interleaves
 * two vitest workers with a virus scanner and whatever else the host is doing, and the same assertion
 * that holds in 3 ms on a developer machine has been seen take 337 ms there. The budget is therefore
 * opt-in, so the behaviour around it still runs everywhere and only the stopwatch is gated.
 *
 * Run the budgets by hand on an idle machine:
 *
 *   PowerShell:  $env:SOTTO_PERF_ASSERT = '1'; npx vitest run <file>
 *   sh:          SOTTO_PERF_ASSERT=1 npx vitest run <file>
 */
export const PERF_ASSERT = process.env.SOTTO_PERF_ASSERT === '1'

/** Asserts `elapsedMs` is inside `budgetMs`, but only when the budgets are switched on. */
export function expectWithinBudget(elapsedMs: number, budgetMs: number, what: string): void {
  if (!PERF_ASSERT) return
  expect(elapsedMs, `${what}: ${Math.round(elapsedMs)} ms against a ${budgetMs} ms budget`).toBeLessThan(budgetMs)
}
