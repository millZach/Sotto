// @vitest-environment node
/**
 * What thirty seconds of dictation publishes (#993). The microphone reports a level about every 33 ms; each snapshot
 * the dictation controller publishes re-renders the window from its root (the Threads page included, whether or not it
 * shows), crosses to main with a schema check, updates the tray and the Linux shell's state, and re-renders the widget.
 * The trace is speech with the pauses between phrases and the dips between words, from a seeded generator, so every run
 * publishes the same.
 *
 * The count is a CI guard. With SOTTO_PERF_BENCH=1 it also prints the counts and what one publication's schema check
 * costs main; what one costs the window is `threadsRender.perf.test.tsx`'s "nothing changed" row.
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/dictationLevels.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { afterEach, expect, it, vi } from 'vitest'
import { widgetSnapshotSchema } from '../../src/shared/contracts'
import { createHarness, recorderOptions, snapshots } from '../fixtures/renderer/dictationControllerHarness'
import { PERF_BENCH, round } from '../fixtures/perfBench'

const LEVEL_MS = 33
const SECONDS = 30

/** A seeded generator (mulberry32), so the trace is the same on every run. */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** Phrases of 1.5 to 4 s with dips between words, then pauses of 0.4 to 1.5 s, as someone dictating speaks. */
function speechTrace(): number[] {
  const next = random(993)
  const levels: number[] = []
  const total = Math.round((SECONDS * 1_000) / LEVEL_MS)
  while (levels.length < total) {
    const phrase = Math.round((1_500 + next() * 2_500) / LEVEL_MS)
    for (let index = 0; index < phrase && levels.length < total; index++) {
      // About one frame in eight falls between words, into the band between the gate's two thresholds or under it.
      const dip = next() < 0.125
      levels.push(dip ? 0.004 + next() * 0.014 : 0.03 + next() * 0.37)
    }
    const pause = Math.round((400 + next() * 1_100) / LEVEL_MS)
    for (let index = 0; index < pause && levels.length < total; index++) levels.push(next() * 0.008)
  }
  return levels
}

afterEach(() => { vi.useRealTimers() })

it('publishes a snapshot when the speaking gate moves, not for every microphone level', async () => {
  vi.useFakeTimers()
  const harness = createHarness({ clockTimers: true })
  await harness.controller.start()
  const before = harness.publishWidgetState.mock.calls.length
  const trace = speechTrace()
  for (const level of trace) {
    recorderOptions(harness).onLevel?.(level)
    vi.advanceTimersByTime(LEVEL_MS)
  }
  const published = snapshots(harness).slice(before)
  const opened = published.filter(snapshot => snapshot.status === 'listening' && 'speaking' in snapshot && snapshot.speaking).length

  if (PERF_BENCH) {
    vi.useRealTimers()
    // What main's schema check of one publication costs, as the window sends it.
    const sample = published.at(-1) ?? snapshots(harness).at(-1)!
    const runs = 20_000
    const started = performance.now()
    for (let run = 0; run < runs; run++) widgetSnapshotSchema.parse(sample)
    const parseUs = ((performance.now() - started) / runs) * 1_000
    console.info(`dictation levels: ${JSON.stringify({ seconds: SECONDS, levels: trace.length, publications: published.length,
      publicationsPerSecond: round(published.length / SECONDS, 2), schemaParseUs: round(parseUs, 2) })}`)
  }

  // Every publication is the gate opening or closing, and there are about as many as there are phrases.
  expect(published.every(snapshot => snapshot.status === 'listening')).toBe(true)
  expect(published.length).toBeLessThanOrEqual(2 * opened)
  // The guard: 909 levels publish 19 snapshots, one for each phrase's gate opening or closing, with a tenth more room.
  expect(published.length).toBeLessThanOrEqual(21)
  expect(harness.publishLevel).toHaveBeenCalled()
})
