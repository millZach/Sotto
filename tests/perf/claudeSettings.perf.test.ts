// @vitest-environment node
/**
 * How long a chip press on a Claude thread waits for the adapter to accept it (#317): from `configure-thread`
 * reaching the adapter to its result, against the scripted Claude process in `tests/fixtures/`. Two cases:
 * a thread whose CLI is not running (reaped, or never opened) and a thread whose CLI is running and idle.
 * Each press alternates the thread's effort between two levels. Alongside the time it counts the CLI starts
 * and settings requests each press cost. Counters and timers only: no prompt, reply or setting value is
 * recorded. It asserts no time, so it runs only under `SOTTO_PERF_BENCH=1` (`tests/fixtures/perfBench.ts`):
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/claudeSettings.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

const PRESSES = 9
const SETTINGS = new Set(['set_model', 'apply_flag_settings', 'set_permission_mode'])
type Fixture = Awaited<ReturnType<typeof claudeFixture>>

async function counts(f: Fixture): Promise<{ starts: number; requests: number }> {
  const records = await f.driver.requests()
  return { starts: records.filter(record => record.method === 'launch' || record.method === 'resume').length, requests: records.filter(record => SETTINGS.has(record.method ?? '')).length }
}

/** Press the effort chip on each thread in turn, timing each press to the adapter's result. */
async function press(f: Fixture, threads: readonly string[]): Promise<{ ms: number[]; startsPerPress: number; requestsPerPress: number }> {
  const before = await counts(f)
  const ms: number[] = []
  for (const [index, id] of threads.entries()) {
    const startedAt = performance.now()
    const result = await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, reasoningEffort: index % 2 === 0 ? 'high' : 'low' })
    ms.push(performance.now() - startedAt)
    expect(result.accepted).toBe(true)
  }
  const after = await counts(f)
  return { ms, startsPerPress: (after.starts - before.starts) / threads.length, requestsPerPress: (after.requests - before.requests) / threads.length }
}
const report = (label: string, measured: Awaited<ReturnType<typeof press>>): void => {
  console.info(`claude settings: ${JSON.stringify({ session: label, presses: measured.ms.length, medianMs: round(median(measured.ms)),
    minMs: round(Math.min(...measured.ms)), maxMs: round(Math.max(...measured.ms)), cliStartsPerPress: measured.startsPerPress, settingsRequestsPerPress: measured.requestsPerPress })}`)
}

describe.skipIf(!PERF_BENCH)('Claude chip press to adapter accepted', () => {
  it('on a thread whose CLI is not running', async () => {
    let f = await claudeFixture(undefined, 15_000)
    try {
      await f.host.connect()
      await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Bench', path: f.root })
      const threads = Array.from({ length: PRESSES }, () => randomUUID())
      for (const id of threads) await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Bench', modelId: f.modelId, reasoningEffort: 'low' })
      // A fresh adapter over the same saved threads starts none of them until something acts on one.
      f = await f.driver.restart() as Fixture
      await f.host.connect()
      report('not running', await press(f, threads))
    } finally { await f.cleanup() }
  })

  it('on a thread whose CLI is running and idle', async () => {
    const f = await claudeFixture(undefined, 15_000)
    try {
      await f.host.connect()
      await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Bench', path: f.root })
      const id = randomUUID()
      await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, title: 'Bench', modelId: f.modelId, reasoningEffort: 'low' })
      f.host.observeThreads?.([id])
      report('running', await press(f, Array.from({ length: PRESSES }, () => id)))
    } finally { await f.cleanup() }
  })
})
