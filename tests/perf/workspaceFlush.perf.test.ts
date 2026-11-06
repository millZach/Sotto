// @vitest-environment node
/**
 * What the workspace's 250 ms flush costs while providers publish (#991): a synthetic 874-model catalog
 * (the development machine's size when the audit measured it) over 200 threads, flushed the way the
 * write window flushes it. It reports the time `flush()` takes when a provider snapshot marked the
 * state dirty but organization is unchanged, and when one thread's usage moved so `workspace.json` is
 * written, plus the file's size. Every payload is generated here; no user profile is opened.
 *
 * Since #1332 each thread carries a worktree the way the owner's do, and the bench also reports the characters
 * `JSON.stringify` made per flush: before #1332 every flush serialized every thread to find out whether anything changed.
 * Run it on a checkout from before #1332 for the earlier numbers.
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

const THREADS = 250
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
        workingDirectory: join(root, 'worktrees', `thread-${index}`),
        worktree: { mode: 'independent', status: 'ready', path: join(root, 'worktrees', `thread-${index}`), repositoryRoot: root, branch: `fix/synthetic-branch-${index}`,
          baseCommit: '0123456789abcdef0123456789abcdef01234567', baseBranch: 'main', startFromOrigin: true, originBase: 'fetched', sentBranch: `fix/synthetic-branch-${index}` },
      })),
    }
    const adapter = new FakeProviderHost(state)
    const workspace = new WorkspaceHost(adapter, root, () => true, undefined, false, false, true)
    await workspace.initialize()
    await workspace.connect()
    await workspace.flush()
    const path = join(root, 'workspace.json')
    const first = await stat(path)
    // The first publication after a connect is taken in whole and marks every thread; the samples are the ones after it.
    adapter.emit()
    await workspace.flush()

    // What every flush serialized, counted around the flush alone.
    const native = JSON.stringify
    let characters = 0
    const timed = async (): Promise<number> => {
      JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => { const text = native(...args); characters += text?.length ?? 0; return text }) as typeof JSON.stringify
      const started = performance.now()
      try { await workspace.flush() } finally { JSON.stringify = native }
      return performance.now() - started
    }
    const unchanged: number[] = []
    characters = 0
    for (let index = 0; index < SAMPLES; index++) {
      adapter.emit()
      unchanged.push(await timed())
    }
    const unchangedCharacters = characters / SAMPLES
    const changed: number[] = []
    characters = 0
    for (let index = 0; index < SAMPLES; index++) {
      const thread = adapter.state.threads[0]!
      thread.usage = { ...thread.usage!, total: { input: 10_000 + index, output: 200 }, updatedAt: new Date().toISOString() }
      adapter.emit()
      changed.push(await timed())
    }
    const changedCharacters = characters / SAMPLES
    const last = await stat(path)
    console.log(`workspace flush (${MODELS} models, ${THREADS} threads, medians of ${SAMPLES}): ${JSON.stringify({
      unchangedFlushMs: round(median(unchanged), 2), changedFlushMs: round(median(changed), 2),
      unchangedSerializedChars: Math.round(unchangedCharacters), changedSerializedChars: Math.round(changedCharacters),
      workspaceJsonBytes: last.size, firstWriteBytes: first.size })}`)
    expect(last.size).toBeGreaterThan(0)
    workspace.disconnect(); workspace.dispose()
  }, 120_000)
})
