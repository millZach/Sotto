/**
 * What a benchmark under `tests/perf/` that only reports timings shares with the others: the switch that
 * runs it and the statistics it reports. Such a benchmark asserts no stopwatch, so it tells the default run
 * nothing and only costs it time; it runs when asked, on an idle machine:
 *
 *   PowerShell:  $env:SOTTO_PERF_BENCH = '1'; npx vitest run tests/perf/<file> --maxWorkers=1 --disable-console-intercept
 *   sh:          SOTTO_PERF_BENCH=1 npx vitest run tests/perf/<file> --maxWorkers=1 --disable-console-intercept
 *
 * Gate the whole file with `describe.skipIf(!PERF_BENCH)`. A benchmark that asserts a count or a work bound
 * rather than a time stays in the default run, like `markdownRender.perf.test.tsx`, and a stopwatch budget is
 * `SOTTO_PERF_ASSERT`'s (`perfBudget.ts`).
 */
export const PERF_BENCH = process.env.SOTTO_PERF_BENCH === '1'

/** The middle sample, or the mean of the two middle samples when there is an even number of them. */
export function median(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error('A median needs at least one sample.')
  const sorted = [...samples].sort((first, second) => first - second)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

/** `value` rounded to `places` decimal places, for a figure a benchmark reports. */
export function round(value: number, places = 1): number {
  const scale = 10 ** places
  return Math.round(value * scale) / scale
}
