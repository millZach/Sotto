// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { MAX_AGENT_ACTIVITIES } from '../../src/shared/agentActivity'
import { activityRecordMix } from '../fixtures/activityRecordMix'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { PERF_ASSERT } from '../fixtures/perfBudget'

/**
 * What reading a thread's saved activity back costs main (#1333): `readActivities` over a thread holding the record
 * limit, first from the disk (the read `holdActivities` makes when a stored thread is looked at), then again from the
 * records the store holds, and once without keeping them (`keep: false`, as an adapter's or Watcher's read is).
 * Every word is random; nothing a user said is opened.
 *
 *   PowerShell:  $env:SOTTO_PERF_BENCH = '1'; npx vitest run tests/perf/storedActivityRead.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * `SOTTO_PERF_RECORD_SCALE` multiplies every body's size (1 by default). `SOTTO_PERF_ASSERT=1` also checks that a read of held records costs well under a read from the disk.
 */
const SAMPLES = 9
/** Multiplies every body's size; the record mix at 1 averages about 1 KB of words. */
const SCALE = Number(process.env.SOTTO_PERF_RECORD_SCALE ?? 1)

const record = activityRecordMix(SCALE)

describe.skipIf(!PERF_BENCH && !PERF_ASSERT)('Reading a thread\'s saved activity back (requires SOTTO_PERF_BENCH=1 or SOTTO_PERF_ASSERT=1)', () => {
  let root: string
  let path: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sotto-activity-read-bench-'))
    path = join(root, 'threads.sqlite')
    const store = new ThreadStore(path)
    store.open()
    store.syncActivities('thread', Array.from({ length: MAX_AGENT_ACTIVITIES }, (_, index) => record(index)))
    store.close()
  }, 120_000)
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

  it('times a read from the disk, a read of held records and a read not kept', () => {
    const cold: number[] = [], held: number[] = [], unkept: number[] = []
    for (let sample = 0; sample <= SAMPLES; sample++) {
      const store = new ThreadStore(path)
      store.open()
      try {
        let started = performance.now()
        const unkeptRead = store.readActivities('thread', { keep: false })
        const unkeptTime = performance.now() - started
        started = performance.now()
        const first = store.readActivities('thread')
        const coldTime = performance.now() - started
        started = performance.now()
        const second = store.readActivities('thread')
        const heldTime = performance.now() - started
        expect(first).toHaveLength(MAX_AGENT_ACTIVITIES)
        expect(second).toEqual(first)
        expect(unkeptRead).toEqual(first)
        // The first sample warms the statements and the JIT; it is not reported.
        if (sample > 0) { cold.push(coldTime); held.push(heldTime); unkept.push(unkeptTime) }
      } finally { store.close() }
    }
    const result = { records: MAX_AGENT_ACTIVITIES, samples: SAMPLES, scale: SCALE,
      fromDiskMs: round(median(cold)), heldMs: round(median(held)), notKeptMs: round(median(unkept)) }
    console.log(`stored activity read ${JSON.stringify(result)}`)
    if (PERF_ASSERT) expect(result.heldMs).toBeLessThan(result.fromDiskMs / 2)
  }, 120_000)
})
