// @vitest-environment node
/**
 * What main's watch on itself costs (#1233, ADR-0098): one sample (a clock read, a subtraction, at most two
 * typed-array writes and, once a second, the frozen answer), and one reading the window asks for while the popover or
 * Settings is open. It measures a busy minute, and the worst one, where every sample is late and the window holds a
 * stretch for each. It asserts no time, so it runs only under `SOTTO_PERF_BENCH=1` (`tests/fixtures/perfBench.ts`):
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/mainLoopMonitor.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { describe, expect, it } from 'vitest'

import { MainLoopMonitor, SAMPLE_INTERVAL_MS } from '../../src/main/performance/mainLoopMonitor'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

const SAMPLES = 1_000_000
const RUNS = 5

describe.skipIf(!PERF_BENCH)('main loop watch cost (timing benchmark; requires SOTTO_PERF_BENCH=1)', () => {
  it('costs a small fraction of a millisecond for a second of samples', () => {
    const perSample: number[] = [], perReading: number[] = []
    for (let run = 0; run < RUNS; run += 1) {
      let at = 0
      const monitor = new MainLoopMonitor({ clock: { now: () => at, setInterval: () => ({}), clearInterval: () => undefined }, onFrozenChange: () => undefined })
      monitor.start()
      const started = performance.now()
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        // Mostly on time, now and then a freeze, as a busy minute looks.
        at += SAMPLE_INTERVAL_MS + (sample % 97 === 0 ? 400 : sample % 3)
        monitor.sample()
      }
      perSample.push((performance.now() - started) * 1_000 / SAMPLES)
      const readingStarted = performance.now()
      for (let read = 0; read < 10_000; read += 1) monitor.reading()
      perReading.push((performance.now() - readingStarted) * 1_000 / 10_000)
    }
    // The most stretches a minute can hold: every sample late, so the window keeps one stretch a sample.
    const busySample: number[] = [], busyReading: number[] = []
    for (let run = 0; run < RUNS; run += 1) {
      let at = 0
      const monitor = new MainLoopMonitor({ clock: { now: () => at, setInterval: () => ({}), clearInterval: () => undefined }, onFrozenChange: () => undefined })
      monitor.start()
      const started = performance.now()
      for (let sample = 0; sample < SAMPLES; sample += 1) { at += SAMPLE_INTERVAL_MS + 5; monitor.sample() }
      busySample.push((performance.now() - started) * 1_000 / SAMPLES)
      const readingStarted = performance.now()
      for (let read = 0; read < 10_000; read += 1) monitor.reading()
      busyReading.push((performance.now() - readingStarted) * 1_000 / 10_000)
    }
    const sampleUs = median(perSample)
    const samplesPerSecond = 1_000 / SAMPLE_INTERVAL_MS
    console.log(`[main loop watch] ${round(sampleUs, 3)} µs a sample; ${samplesPerSecond} samples a second = ${round(sampleUs * samplesPerSecond, 2)} µs of main a second (${round(sampleUs * samplesPerSecond / 10_000, 6)}% of one core); a reading ${round(median(perReading), 2)} µs`)
    console.log(`[main loop watch, every sample late] ${round(median(busySample), 3)} µs a sample; a reading ${round(median(busyReading), 2)} µs`)
    expect(sampleUs).toBeGreaterThan(0)
  })
})
