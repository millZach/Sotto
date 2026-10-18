// @vitest-environment node
/**
 * What main copies for each update while a thread streams, counted rather than timed (#991 follow-up). A whole-state
 * copy on the update path was how main came to spend most of its time copying: Watcher's observe pass copied its record
 * for every thread, the host-update pill rebuilt every host's shell on every change, and the local host forwarded a
 * fresh shell for every Watcher publish. Each looked harmless where it was written and only cost anything with a few
 * hundred threads, so this runs the real update path at 20 and at 200 threads and fails when what one update copies
 * grows with the thread count or passes its budget. It counts calls, never time, so it runs in the default suite.
 *
 * A failure names what grew. Read the state without copying it, or move the copy off the update path. The budgets only
 * tighten; docs/perf/2026-10-15-copy-budget.md has the numbers and how to read them.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { copyBudgetPipeline } from '../fixtures/copyBudgetPipeline'

const counter = vi.hoisted(() => ({ threads: Number.POSITIVE_INFINITY, calls: 0, whole: 0, kinds: new Map<string, number>() }))
function count(kind: string, value: unknown): void {
  counter.calls++
  const holder = value as { host?: { threads?: unknown }; threads?: unknown } | null
  const threads = Array.isArray(holder?.host?.threads) ? holder.host.threads : Array.isArray(holder?.threads) ? holder.threads : undefined
  if (threads && threads.length >= counter.threads) { counter.whole++; counter.kinds.set(kind, (counter.kinds.get(kind) ?? 0) + 1) }
}
vi.mock('../../src/main/agents/cloneHostSnapshot', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/main/agents/cloneHostSnapshot')>()
  return { ...original, cloneHostSnapshot: (snapshot: Parameters<typeof original.cloneHostSnapshot>[0]) => { count('cloneHostSnapshot', snapshot); return original.cloneHostSnapshot(snapshot) } }
})
vi.mock('../../src/main/agents/activitySnapshots', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/main/agents/activitySnapshots')>()
  return { ...original, cloneActivitySnapshot: (snapshot: Parameters<typeof original.cloneActivitySnapshot>[0]) => { count('cloneActivitySnapshot', snapshot); return original.cloneActivitySnapshot(snapshot) } }
})

const sleep = (ms: number) => new Promise<void>(done => { setTimeout(done, ms) })
const roots: string[] = []
afterAll(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) })

const CHUNKS = 40

/** Streams one reply and reports what each coordinator update copied. */
async function measure(threads: number, owl: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-copy-budget-')); roots.push(root)
  const pipeline = await copyBudgetPipeline(root, threads, owl)
  const native = globalThis.structuredClone
  try {
    const stream = pipeline.adapter.state.threads.find(thread => thread.id === 'stream-0')!
    const at = new Date().toISOString()
    pipeline.adapter.log.add(stream.id, { id: 'prompt', role: 'user', text: 'Synthetic prompt', createdAt: at }); stream.status = 'running'
    pipeline.adapter.publish(false)
    pipeline.adapter.log.add(stream.id, { id: 'reply', role: 'assistant', text: 'First', createdAt: at })
    pipeline.adapter.publish(true)
    await sleep(300)
    globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => { count('structuredClone', value); return native(value, options) }) as typeof structuredClone
    counter.threads = threads; counter.calls = 0; counter.whole = 0; counter.kinds.clear(); pipeline.resetCounts()
    for (let chunk = 0; chunk < CHUNKS; chunk++) {
      pipeline.adapter.log.appendText(stream.id, 'reply', ` word${chunk}`)
      pipeline.adapter.publish(true)
      await sleep(5)
    }
    await sleep(400)
    const broadcasts = Math.max(1, pipeline.broadcasts())
    return { broadcasts, copiesPerUpdate: counter.calls / broadcasts, wholeStateCopiesPerUpdate: counter.whole / broadcasts, wholeByKind: Object.fromEntries([...counter.kinds].map(([kind, n]) => [kind, Math.round(n / broadcasts * 100) / 100])) }
  } finally {
    globalThis.structuredClone = native
    counter.threads = Number.POSITIVE_INFINITY
    await pipeline.stop()
  }
}

/**
 * The budgets, per coordinator update while one thread streams, with an open Watcher watching that thread on Owl.
 * Measured October 15, 2026 after the fixes: Owl 20.5 copies and 2.9 whole-state copies, stable 8.9 and 2.95; the main
 * branch before them grew with the threads on Owl and copied the whole state 7.9 times per update. The whole-state copies
 * left are the coordinator's shell for the broadcast and the workspace's activity snapshots (#925). A change that lowers
 * a count lowers its budget in the same PR; a change that needs more copies on this path asks Zach first. The October 17
 * Watcher recovery follow-up removed two more copies per Owl update (matched parent 21.4, candidate 19.4); its budget
 * falls by the same two copies. Stable's measured count and budget are unchanged.
 */
const BUDGET = {
  Owl: { copiesPerUpdate: 21.5, wholeStateCopiesPerUpdate: 3.5 },
  stable: { copiesPerUpdate: 10.5, wholeStateCopiesPerUpdate: 3.5 },
} as const

describe.each([['Owl', true], ['stable', false]] as const)('what one streaming update copies on %s', (track, owl) => {
  it('does not grow with the number of threads, and stays within its budget', async () => {
    const few = await measure(20, owl), many = await measure(200, owl)
    const seen = JSON.stringify({ few, many })
    if (process.env.SOTTO_PERF_BENCH === '1') console.log(`Streaming copy budget ${track}: ${seen}`)
    expect(many.broadcasts, `the stream produced no updates to count: ${seen}`).toBeGreaterThan(1)
    expect(many.copiesPerUpdate, `an update copies more with 200 threads than with 20, so something copies per thread on every update: ${seen}`)
      .toBeLessThanOrEqual(few.copiesPerUpdate * 1.2 + 1)
    expect(many.wholeStateCopiesPerUpdate, `an update copies the whole state more often than its budget: ${seen}`)
      .toBeLessThanOrEqual(BUDGET[track].wholeStateCopiesPerUpdate)
    expect(many.copiesPerUpdate, `an update makes more copies than its budget: ${seen}`)
      .toBeLessThanOrEqual(BUDGET[track].copiesPerUpdate)
  }, 120_000)
})
