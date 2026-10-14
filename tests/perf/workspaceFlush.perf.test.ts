// @vitest-environment node
/**
 * What the workspace's 250 ms flush costs while providers publish (#991): a synthetic 874-model catalog
 * (the development machine's size when the audit measured it) over 200 threads, flushed the way the
 * write window flushes it. It reports the time `flush()` takes when a provider snapshot marked the
 * state dirty but organization is unchanged, and when one thread's usage moved so `workspace.json` is
 * written, plus the file's size. Every payload is generated here; no user profile is opened.
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/workspaceFlush.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, describe, expect, it } from 'vitest'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../src/shared/agents'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { syntheticModelCatalog } from '../fixtures/modelCatalog'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

const THREADS = 200
const MODELS = 874
const SAMPLES = 15

const roots: string[] = []
afterAll(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-workspace-flush-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})

describe.skipIf(!PERF_BENCH)('the 250 ms workspace flush over a large catalog (timing benchmark; requires SOTTO_PERF_BENCH=1)', () => {
  it('reports flush time unchanged and changed, and the size of workspace.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-workspace-flush-')); roots.push(root)
    const state: AgentHostSnapshot = {
      ...structuredClone(EMPTY_AGENT_HOST), name: 'fake', version: '1', connected: true,
      capabilities: { ...structuredClone(EMPTY_AGENT_HOST.capabilities), projects: true, threads: true, submit: true, observe: true },
      projects: [{ id: 'project', title: 'Synthetic project', path: root }],
      models: syntheticModelCatalog(MODELS),
      threads: Array.from({ length: THREADS }, (_, index): AgentThread => ({
        id: `thread-${index}`, projectId: 'project', title: `Synthetic thread ${index}`, modelId: `devin:synthetic-model-${index % 40}`,
        status: index === 0 ? 'running' : 'idle', messages: [], requests: [],
        usage: { total: { input: 1_000 + index, output: 200 }, rateVersions: [], partial: false, updatedAt: '2026-10-13T00:00:00.000Z' },
      })),
    }
    const adapter = new FakeProviderHost(state)
    const workspace = new WorkspaceHost(adapter, root, () => true, undefined, false, false, true)
    await workspace.initialize()
    await workspace.connect()
    await workspace.flush()
    const path = join(root, 'workspace.json')
    const first = await stat(path)

    const unchanged: number[] = []
    for (let index = 0; index < SAMPLES; index++) {
      adapter.emit()
      const started = performance.now()
      await workspace.flush()
      unchanged.push(performance.now() - started)
    }
    const changed: number[] = []
    for (let index = 0; index < SAMPLES; index++) {
      const thread = adapter.state.threads[0]!
      thread.usage = { ...thread.usage!, total: { input: 10_000 + index, output: 200 }, updatedAt: new Date().toISOString() }
      adapter.emit()
      const started = performance.now()
      await workspace.flush()
      changed.push(performance.now() - started)
    }
    const last = await stat(path)
    console.log(`workspace flush (${MODELS} models, ${THREADS} threads, medians of ${SAMPLES}): ${JSON.stringify({
      unchangedFlushMs: round(median(unchanged), 2), changedFlushMs: round(median(changed), 2),
      workspaceJsonBytes: last.size, firstWriteBytes: first.size })}`)
    expect(last.size).toBeGreaterThan(0)
    workspace.disconnect(); workspace.dispose()
  }, 120_000)
})
