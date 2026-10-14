// @vitest-environment node
// SOTTO_PERF_BENCH=1 npx vitest run tests/perf/certifiedDetail.perf.test.ts --maxWorkers=1 --disable-console-intercept
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { AgentControl } from '../../src/main/agents/control'
import { immutableActivities } from '../../src/main/agents/activitySnapshots'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentThread } from '../../src/shared/agents'
import { PERF_BENCH, median, round } from '../fixtures/perfBench'
import { createAgentControl } from '../fixtures/agentControlFixture'
import { E2EAgentHost } from '../../src/main/e2e/agentEffects'

describe.skipIf(!PERF_BENCH)('certified detail publishing (#991)', () => {
  it('reports revision and delta cost per window with 1, 3 and 6 viewed threads', () => {
    for (const count of [200, 1000, 2000]) for (const threads of [1, 3, 6]) {
      // Only the coordinator's measured arithmetic runs; no profile, provider or durable store is opened.
      const control = createAgentControl({ streamingPublishCost: true, directory: '', host: new E2EAgentHost(), credentials: { has: () => false, available: () => false } as never })
      const detail = control as unknown as { detailRevision(thread: AgentThread): number; detailUpdate(thread: AgentThread, revision: number): unknown }
      const values = Array.from({ length: threads }, (_, index): AgentThread => ({ id: `thread-${index}`, projectId: 'project', title: 'Synthetic', modelId: 'fake', status: 'running', requests: [], messages: [], activities: immutableActivities(Array.from({ length: count }, (_, i): AgentActivity => ({ id: `record-${i}`, turnId: 'turn', sequence: i, kind: 'command', status: 'running', title: 'Synthetic command', output: 'x'.repeat(2048), steps: [{ text: 'Synthetic step', status: 'running' }] }))) }))
      const samples: number[] = []
      for (const thread of values) detail.detailUpdate(thread, detail.detailRevision(thread))
      for (let window = 0; window < 100; window++) {
        for (const thread of values) thread.activities = immutableActivities([...thread.activities!.slice(0, -1), { ...thread.activities!.at(-1)!, output: 'x'.repeat(2048 + window + 1) }])
        const started = performance.now()
        for (const thread of values) expect(detail.detailUpdate(thread, detail.detailRevision(thread))).not.toBeNull()
        if (window >= 10) samples.push(performance.now() - started)
      }
      console.log(`certified detail (${threads} threads, ${count} records): ${JSON.stringify({ msPerWindow: round(median(samples), 4), msPerChunk: round(median(samples) / threads, 4) })}`)
      control.dispose()
    }
  })
})
