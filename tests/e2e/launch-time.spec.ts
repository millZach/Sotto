/**
 * How long the built app takes to show its window, and what it holds at rest (November 10, 2026 audit, #995). Each run
 * launches `out/main/index.js` on a new, empty profile and reads three clocks: when Playwright asked for the launch, when
 * the main window's page began to load (`performance.timeOrigin`), and its first contentful paint. Launch to page start
 * is Electron starting, main's bundle loading and its runtime starting; page start to paint is the preload and the
 * renderer's bundle. Then it leaves the app alone for five seconds and reads each process's memory and CPU from
 * `app.getAppMetrics()`.
 *
 * It prints JSON and asserts no time, so it runs only when asked, after `npm run build`, like the other timing
 * benchmarks (`docs/ci.md`):
 *
 *   SOTTO_PERF_BENCH=1 SOTTO_LAUNCH_RUNS=7 xvfb-run -a -s '-screen 0 1920x1080x24' npx playwright test tests/e2e/launch-time.spec.ts
 *
 * An empty profile opens on first-run setup, so this times the shell of the app, not a profile with threads in it.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from '@playwright/test'
import { PERF_BENCH, median, round } from '../fixtures/perfBench'
import { closeSotto, launchSotto } from './support/sottoLaunch'

const RUNS = Number(process.env.SOTTO_LAUNCH_RUNS ?? 5)

test('times the launch of the built app on an empty profile', async () => {
  test.skip(!PERF_BENCH, 'A timing benchmark: run it with SOTTO_PERF_BENCH=1.')
  test.setTimeout(RUNS * 60_000)
  const runs: Record<string, number>[] = []
  for (let run = 0; run < RUNS + 1; run++) {
    const asked = Date.now()
    const launched = await launchSotto()
    try {
      const windowAt = Date.now()
      const page = await launched.page.evaluate(async () => {
        const paint = async (): Promise<number> => {
          for (let waited = 0; waited < 200; waited++) {
            const entry = performance.getEntriesByType('paint').find(item => item.name === 'first-contentful-paint')
            if (entry) return entry.startTime
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          return -1
        }
        const firstPaint = await paint()
        const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
        return { origin: performance.timeOrigin, firstPaint, domContentLoaded: navigation?.domContentLoadedEventEnd ?? -1 }
      })
      await sleep(5_000)
      // The first reading starts the CPU counters; the second, a second later, is the rest in between.
      await launched.app.evaluate(({ app }) => app.getAppMetrics().length)
      await sleep(2_000)
      const rest = await launched.app.evaluate(({ app }) => app.getAppMetrics().map(item => ({ type: item.type, name: item.name ?? '', cpu: item.cpu.percentCPUUsage, memoryKb: item.memory.workingSetSize })))
      const of = (type: string): typeof rest => rest.filter(item => item.type === type)
      const sum = (items: typeof rest, key: 'cpu' | 'memoryKb'): number => items.reduce((total, item) => total + item[key], 0)
      // The first launch warms the disk cache and is left out.
      if (run > 0) runs.push({
        askedToWindowMs: windowAt - asked,
        askedToPageStartMs: page.origin - asked,
        pageStartToDomMs: page.domContentLoaded,
        pageStartToFirstPaintMs: page.firstPaint,
        askedToFirstPaintMs: page.origin + page.firstPaint - asked,
        processes: rest.length,
        mainMemoryMb: sum(of('Browser'), 'memoryKb') / 1024, mainCpuPercent: sum(of('Browser'), 'cpu'),
        rendererMemoryMb: sum(of('Tab'), 'memoryKb') / 1024, rendererCpuPercent: sum(of('Tab'), 'cpu'), renderers: of('Tab').length,
        gpuMemoryMb: sum(of('GPU'), 'memoryKb') / 1024,
        allMemoryMb: sum(rest, 'memoryKb') / 1024, allCpuPercent: sum(rest, 'cpu'),
      })
    } finally { await closeSotto(launched) }
  }
  const keys = Object.keys(runs[0] ?? {})
  const summary = Object.fromEntries(keys.map(key => { const values = runs.map(item => item[key]!); return [key, { median: round(median(values)), min: round(Math.min(...values)), max: round(Math.max(...values)) }] }))
  console.log(`LAUNCH-TIME ${JSON.stringify({ runs: runs.length, platform: process.platform, summary }, null, 1)}`)
})
