// @vitest-environment node
/**
 * Early start (#769): how long a new Claude thread's first send takes through the workspace, the Sotto thread host and
 * the adapter, over the fake CLI, when nothing started its CLI first, when typing started it and it finished starting
 * before Send, and when Send came 150 ms after the first key. The fake starts in a fraction of the real client's time,
 * so the gap here is the fake's start; `tests/integration/claudeEarlyStartLive.test.ts` measures the real one. Timers
 * only. It asserts no time, so it runs only under `SOTTO_PERF_BENCH=1` (`tests/fixtures/perfBench.ts`):
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/earlyStart.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { WorkspaceHost } from '../../src/main/agents/workspace'

const SENDS = 9

describe.skipIf(!PERF_BENCH)('a new Claude thread’s first send', () => {
  it('reports the send with and without an early start', async () => {
    const f = await claudeFixture()
    const workspace = new WorkspaceHost(new SottoThreadHost('claude', f.host, new ThreadRegistry(join(f.root, 'identity'))), join(f.root, 'workspace'))
    try {
      await workspace.connect()
      await workspace.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
      const draft = async (): Promise<string> => {
        const threadId = randomUUID()
        await workspace.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Bench', modelId: f.modelId, workingCopy: 'shared' })
        return threadId
      }
      const send = async (threadId: string): Promise<number> => {
        const startedAt = performance.now()
        expect(await workspace.execute({ type: 'send', threadId, commandId: randomUUID(), messageId: randomUUID(), text: 'Synthetic bench prompt' })).toEqual({ accepted: true })
        return performance.now() - startedAt
      }
      const samples: Record<'cold' | 'started' | 'typedBriefly', number[]> = { cold: [], started: [], typedBriefly: [] }
      const starts: number[] = []
      for (let round = 0; round < SENDS; round++) {
        samples.cold.push(await send(await draft()))
        const started = await draft()
        const startedAt = performance.now()
        await workspace.startThreadSession(started)
        starts.push(performance.now() - startedAt)
        samples.started.push(await send(started))
        const brief = await draft()
        void workspace.startThreadSession(brief)
        await delay(150)
        samples.typedBriefly.push(await send(brief))
      }
      const summary = (values: number[]) => ({ median: round(median(values)), min: round(Math.min(...values)), max: round(Math.max(...values)) })
      console.log(JSON.stringify({ sends: SENDS, earlyStartMs: summary(starts), firstSendColdMs: summary(samples.cold),
        firstSendAfterEarlyStartMs: summary(samples.started), firstSend150MsAfterFirstKeyMs: summary(samples.typedBriefly) }))
    } finally { workspace.dispose(); await f.cleanup() }
  }, 240_000)
})
