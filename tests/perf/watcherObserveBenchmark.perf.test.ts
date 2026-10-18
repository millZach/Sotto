// @vitest-environment node
/**
 * SOTTO_PERF_BENCH=1 node node_modules/vitest/vitest.mjs run tests/perf/watcherObserveBenchmark.perf.test.ts --maxWorkers=1 --disable-console-intercept
 * Run in fresh parent/head processes with the same fixture and dependency tree; retain all rows, compare medians.
 * No elapsed-time assertion in the default suite. Deterministic work budgets live beside this benchmark.
 */
import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { PERF_BENCH, median } from '../fixtures/perfBench'
import { watcherObservePerformance } from '../fixtures/watcherObservePerformance'

describe.skipIf(!PERF_BENCH)('real local Watcher observation cost', () => {
  it('reports history, watch-count and private takeover-metadata scaling', async () => {
    const rows: Record<string, unknown>[] = []
    const metadata = process.env.SOTTO_PERF_TAKEOVER_METADATA === '1'
    for (const operationOutcome of ['unknown', 'working'] as const) for (const watches of [1, 3, 6])
      for (const olderMessages of [20, 20_000]) for (const retainedTakeovers of [0, 20, 200]) {
        const shape = { watches, olderMessages, retainedTakeovers, includeTakeoverMetadata: metadata, operationOutcome }
        const f = await watcherObservePerformance(shape)
        try {
          const rounds = [], iterations = 20
          for (let n = 0; n < 10; n++) f.observe()
          for (let round = 0; round < 5; round++) {
            const cpu = process.cpuUsage(), started = performance.now()
            for (let n = 0; n < iterations; n++) f.observe()
            const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu)
            rounds.push({ wallMsPerCall: elapsedMs / iterations, cpuMsPerCall: (used.user + used.system) / 1_000 / iterations })
          }
          expect(f.state().watches).toHaveLength(watches)
          expect(f.state().watches?.every(watch => watch.pausedByUserMessageId === null)).toBe(true)
          const roomRounds = []
          for (let n = 0; n < 10; n++) f.watcher.state()
          for (let round = 0; round < 5; round++) {
            const cpu = process.cpuUsage(), started = performance.now()
            for (let n = 0; n < iterations; n++) f.watcher.state()
            const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu)
            roomRounds.push({ wallMsPerCall: elapsedMs / iterations, cpuMsPerCall: (used.user + used.system) / 1_000 / iterations })
          }
          expect(f.watcher.state().watchedThreads.filter(thread => thread.watched)).toHaveLength(watches)
          rows.push({ shape, iterations, rounds, medianWallMs: median(rounds.map(row => row.wallMsPerCall)),
            medianCpuMs: median(rounds.map(row => row.cpuMsPerCall)), roomRounds,
            roomMedianWallMs: median(roomRounds.map(row => row.wallMsPerCall)), roomMedianCpuMs: median(roomRounds.map(row => row.cpuMsPerCall)),
            recordBytes: Buffer.byteLength(JSON.stringify(f.state())) })
        } finally { await f.close() }
      }
    const report = { at: new Date().toISOString(), label: process.env.SOTTO_PERF_REVISION_LABEL ?? 'unspecified',
      node: process.version, platform: process.platform, rows }
    const output = process.env.SOTTO_PERF_WATCHER_OBSERVE_OUTPUT
    if (output) await writeFile(output, JSON.stringify(report, null, 2), 'utf8')
    console.log(`Local Watcher observation: ${JSON.stringify(report)}`)
  }, 120_000)
})
