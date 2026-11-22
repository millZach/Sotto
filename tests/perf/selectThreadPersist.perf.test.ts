// @vitest-environment node
/**
 * Measures `select-thread` latency while a 200 ms `agents.json` or `watcher-record.json` write is in flight (#2733).
 *
 *   PowerShell:  $env:SOTTO_PERF_BENCH = '1'; npx vitest run tests/perf/selectThreadPersist.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *   sh:          SOTTO_PERF_BENCH=1 npx vitest run tests/perf/selectThreadPersist.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { randomUUID } from 'node:crypto'
import { rename } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { deferred } from '../fixtures/deferred'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

const WRITE_DELAY_MS = 200
const SAMPLES = 5

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(rename).mockReset().mockImplementation(actual.rename)
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe.skipIf(!PERF_BENCH)('select-thread latency behind an in-flight 200 ms store write (requires SOTTO_PERF_BENCH=1)', () => {
  it('measures select-thread behind a 200 ms agents.json write', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const host = new E2EAgentHost()
    const f = await agentControlFixture({ host, reasoner: e2eAgentReasoner, credentialOptions: { mode: 'unavailable' } })
    cleanups.push(f.dispose)
    await f.control.start()
    await f.control.command({ type: 'connect' })

    const samples: number[] = []
    const targets = ['docs', 'workshop'] as const

    for (let index = 0; index < SAMPLES; index++) {
      const entered = deferred<void>()
      let delayed = false
      vi.mocked(rename).mockImplementation(async (oldPath, newPath) => {
        if (!delayed && String(newPath).endsWith('agents.json')) {
          delayed = true
          entered.resolve()
          await sleep(WRITE_DELAY_MS)
        }
        return actual.rename(oldPath, newPath)
      })
      const savingDraft = f.control.command({
        type: 'save-thread-draft',
        threadId: 'workshop',
        draftId: randomUUID(),
        text: `Sample ${index}`,
      })
      await entered.promise

      const started = performance.now()
      const reply = await f.control.command({ type: 'select-thread', threadId: targets[index % 2]! })
      const elapsed = performance.now() - started
      expect(reply.activeThreadId).toBe(targets[index % 2])
      samples.push(elapsed)

      await savingDraft
      vi.mocked(rename).mockImplementation(actual.rename)
    }

    console.log(
      `select-thread behind ${WRITE_DELAY_MS} ms agents.json write: median ${round(median(samples), 2)} ms (min ${round(Math.min(...samples), 2)}, max ${round(Math.max(...samples), 2)})`,
    )
  }, 30_000)

  it('measures select-thread behind a 200 ms watcher-record.json write', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const host = new E2EAgentHost()
    const f = await agentControlFixture({ host, reasoner: e2eAgentReasoner, credentialOptions: { mode: 'unavailable' } })
    cleanups.push(f.dispose)
    await f.control.start()
    await f.control.command({ type: 'connect' })

    const samples: number[] = []
    const targets = ['docs', 'workshop'] as const

    for (let index = 0; index < SAMPLES; index++) {
      const entered = deferred<void>()
      let delayed = false
      vi.mocked(rename).mockImplementation(async (oldPath, newPath) => {
        if (!delayed && String(newPath).endsWith('watcher-record.json')) {
          delayed = true
          entered.resolve()
          await sleep(WRITE_DELAY_MS)
        }
        return actual.rename(oldPath, newPath)
      })

      const updatingWatcher = f.control.watcherRecords.update(record => {
        record.wakeEventIds = [`wake-bench-${index}`]
      })
      await entered.promise

      const started = performance.now()
      const reply = await f.control.command({ type: 'select-thread', threadId: targets[index % 2]! })
      const elapsed = performance.now() - started
      expect(reply.activeThreadId).toBe(targets[index % 2])
      samples.push(elapsed)

      await updatingWatcher
      vi.mocked(rename).mockImplementation(actual.rename)
    }

    console.log(
      `select-thread behind ${WRITE_DELAY_MS} ms watcher-record.json write: median ${round(median(samples), 2)} ms (min ${round(Math.min(...samples), 2)}, max ${round(Math.max(...samples), 2)})`,
    )
  }, 30_000)
})
