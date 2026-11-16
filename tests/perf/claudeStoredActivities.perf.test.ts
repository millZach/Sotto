// @vitest-environment node
// SOTTO_PERF_BENCH=1 npx vitest run tests/perf/claudeStoredActivities.perf.test.ts --maxWorkers=1 --disable-console-intercept
/**
 * What a Claude thread's first stream frame after a restart pays to take in its stored records (#2619). The frame reads
 * up to `MAX_AGENT_ACTIVITIES` records from the thread's history, and its publication certifies the thread's list. The
 * adapter used to clone what the read handed it and the certify then copied every record again to own it; main stopped
 * for 12.5 s in that copy on the laptop. It now owns the records where they are, since the read builds them for it.
 *
 * Both ways are timed here on the same records, so one run gives the before and the after: `cloned` is the old way,
 * `owned` the new. Each round takes in a fresh read of 2,000 command records with 2 KB of output each. It reports timings
 * only, so it runs when asked.
 */
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { certifyActivityView, isImmutableActivities, ownBuiltActivities } from '../../src/main/agents/activitySnapshots'
import { MAX_AGENT_ACTIVITIES, type AgentActivity } from '../../src/shared/agentActivity'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

const ROUNDS = 7
const OUTPUT = 'synthetic output line of a command\n'.repeat(58)

/** A fresh read of a long thread's stored records, as the workspace's read builds them for the adapter. */
const read = (): AgentActivity[] => Array.from({ length: MAX_AGENT_ACTIVITIES }, (_, index) => ({ id: `claude-tool-${index}`, turnId: `turn-${Math.floor(index / 20)}`,
  sequence: index, kind: 'command', status: 'completed', title: 'Synthetic step', output: OUTPUT, startedAt: '2026-11-15T18:00:00.000Z', completedAt: '2026-11-15T18:00:01.000Z' }))

function time(takeIn: (records: AgentActivity[]) => AgentActivity[]): number {
  const samples: number[] = []
  for (let index = 0; index < ROUNDS; index++) {
    const records = read(), thread = { activities: [] as AgentActivity[] }, state = { models: [] }
    const start = performance.now()
    thread.activities = takeIn(records)
    certifyActivityView(state, [thread])
    samples.push(performance.now() - start)
    expect(isImmutableActivities(thread.activities)).toBe(true)
  }
  return median(samples)
}

describe.skipIf(!PERF_BENCH)('A Claude frame taking in its stored records (#2619)', () => {
  it('times the old clone and copy against owning them where they are', () => {
    time(records => structuredClone(records)); time(records => ownBuiltActivities(records))
    const cloned = time(records => structuredClone(records)), owned = time(records => ownBuiltActivities(records))
    console.log(JSON.stringify({ records: MAX_AGENT_ACTIVITIES, outputBytes: OUTPUT.length, msPerFrame: { cloned: round(cloned, 2), owned: round(owned, 2) } }))
  })
})
