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

const counter = vi.hoisted(() => ({ threads: Number.POSITIVE_INFINITY, calls: 0, whole: 0, watcherRecord: 0, kinds: new Map<string, number>(),
  record: undefined as (() => unknown) | undefined, measuring: false, objects: 0, objectKinds: new Map<string, number>(), parses: 0, hiddenProjections: 0 }))
function count(kind: string, value: unknown): void {
  counter.calls++
  // Watcher's whole record, which grows with every prompt Watcher is sent and every wake-up it has had.
  if (counter.record && value === counter.record()) counter.watcherRecord++
  const holder = value as { host?: { threads?: unknown }; threads?: unknown } | null
  const threads = Array.isArray(holder?.host?.threads) ? holder.host.threads : Array.isArray(holder?.threads) ? holder.threads : undefined
  if (threads && threads.length >= counter.threads) { counter.whole++; counter.kinds.set(kind, (counter.kinds.get(kind) ?? 0) + 1) }
}
/** The objects a copy made: those in the copy that are not the very objects of what it copied. Shared trees cost nothing. */
const { fresh } = await vi.hoisted(() => import('./support/copyAccounting'))
/** Every copier main has, counted where it makes the objects, so a copy made inside another is counted once. */
const made = vi.hoisted(() => (kind: string, copy: unknown, original: unknown): void => {
  if (!counter.measuring) return
  const objects = fresh(copy, original)
  counter.objects += objects; counter.objectKinds.set(kind, (counter.objectKinds.get(kind) ?? 0) + objects)
})
vi.mock('../../src/main/agents/cloneHostSnapshot', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/main/agents/cloneHostSnapshot')>()
  return { ...original,
    cloneHostSnapshot: (snapshot: Parameters<typeof original.cloneHostSnapshot>[0]) => { count('cloneHostSnapshot', snapshot); const copy = original.cloneHostSnapshot(snapshot); made('cloneHostSnapshot', copy, snapshot); return copy },
    clonePlainData: <T>(value: T): T => { count('clonePlainData', value); const copy = original.clonePlainData(value); made('clonePlainData', copy, value); return copy },
    copyUnshared: <T>(value: T, shared: (value: object) => boolean, seal?: (copy: object) => void): T => {
      const copy = original.copyUnshared(value, shared, seal); made(seal ? 'certified copy' : 'activity snapshot', copy, value); return copy
    } }
})
// A shown thread's history without its hidden delegation news (ADR-0081): made again only when that history changed, never
// for another thread's update. Each one is a new array of every message, so each is counted.
vi.mock('../../src/main/agents/hiddenWakeUpDisplay', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/main/agents/hiddenWakeUpDisplay')>()
  return { ...original, withoutHiddenWakeUps: (messages: Parameters<typeof original.withoutHiddenWakeUps>[0]) => { if (counter.measuring) counter.hiddenProjections++; return original.withoutHiddenWakeUps(messages) } }
})
vi.mock('../../src/main/agents/activitySnapshots', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/main/agents/activitySnapshots')>()
  return { ...original, cloneActivitySnapshot: (snapshot: Parameters<typeof original.cloneActivitySnapshot>[0]) => { count('cloneActivitySnapshot', snapshot); return original.cloneActivitySnapshot(snapshot) } }
})
// Reading the provider out of a public model or project ID. Asked once per thread on every publish, it was a second of a busy minute.
vi.mock('../../src/shared/agents', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/shared/agents')>()
  return { ...original, parsePublicProviderEntityId: (id: string) => { if (counter.measuring) counter.parses++; return original.parsePublicProviderEntityId(id) } }
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
    globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => { count('structuredClone', value); const copy = native(value, options); made('structuredClone', copy, undefined); return copy }) as typeof structuredClone
    counter.record = owl ? () => pipeline.control.watcherRecordView() : undefined
    counter.threads = threads; counter.calls = 0; counter.whole = 0; counter.watcherRecord = 0; counter.kinds.clear(); pipeline.resetCounts()
    counter.objects = 0; counter.objectKinds.clear(); counter.parses = 0; counter.hiddenProjections = 0; counter.measuring = true
    // The thread that delegated is shown without its hidden news, before the stream and while it runs.
    const parentShown = pipeline.control.threadDetail(pipeline.parentId)!.messages.map(message => message.id)
    if (!parentShown.includes('parent-reply') || parentShown.includes('parent-news')) throw new Error(`The delegating thread is not shown as its window would show it: ${JSON.stringify(parentShown)}`)
    for (let chunk = 0; chunk < CHUNKS; chunk++) {
      pipeline.adapter.log.appendText(stream.id, 'reply', ` word${chunk}`)
      pipeline.adapter.publish(true)
      await sleep(5)
    }
    await sleep(400)
    counter.measuring = false
    const broadcasts = Math.max(1, pipeline.broadcasts())
    const per = (total: number, by: number) => Math.round(total / by * 100) / 100
    return { broadcasts, hiddenProjectionsPerUpdate: per(counter.hiddenProjections, broadcasts), objectsPerFrame: per(counter.objects, CHUNKS), objectsPerThreadPerUpdate: per(counter.objects, broadcasts * threads),
      objectsByKind: Object.fromEntries([...counter.objectKinds].map(([kind, n]) => [kind, per(n, CHUNKS)])), parsesPerUpdate: per(counter.parses, broadcasts), copiesPerUpdate: counter.calls / broadcasts, wholeStateCopiesPerUpdate: counter.whole / broadcasts, watcherRecordCopiesPerUpdate: counter.watcherRecord / broadcasts, wholeByKind: Object.fromEntries([...counter.kinds].map(([kind, n]) => [kind, Math.round(n / broadcasts * 100) / 100])) }
  } finally {
    globalThis.structuredClone = native
    counter.measuring = false
    counter.threads = Number.POSITIVE_INFINITY; counter.record = undefined
    await pipeline.stop()
  }
}

/**
 * The budgets, per coordinator update while one thread streams, with an open Watcher watching that thread on Owl.
 * Measured October 15, 2026 after the fixes: Owl 20.5 copies and 2.9 whole-state copies, stable 8.9 and 2.95; the main
 * branch before them grew with the threads on Owl and copied the whole state 7.9 times per update. The whole-state copies
 * left are the coordinator's shell for the broadcast and the workspace's activity snapshots (#925). A change that lowers
 * a count lowers its budget in the same PR; a change that needs more copies on this path asks Zach first. The October 17
 * Watcher recovery follow-up removed two more copies per Owl update (matched parent 21.4, candidate 19.4).
 *
 * October 17, 2026: Owl copied Watcher's whole record 11 times per update. The record grows with every prompt and
 * wake-up Watcher has had, so the cost grew with use rather than with threads, and the owner's 373 KB record cost main
 * about 26 ms an update. Reading it without the copy left Owl at 12.4 copies and one copy of the record, in the observe
 * pass's operations change, per update; the room still copies the records it hands out. Stable reads 9.8.
 */
/*
 * October 19, 2026: counting calls missed the copies that cost the most. The adapter's subscribers each took a copy of
 * every thread inside the module that made it, where no call is seen, and the provider switch copied what it had just
 * been handed. So this also counts the objects each copier makes, wherever it is called from, per thread per update.
 * With 200 threads it was 40 on Owl and 43 on stable, five copies of every thread on every update. A publication is now
 * copied once for all its subscribers, the switch keeps an adapter's publication and hands on its aggregate as they are,
 * and the shell a broadcast carries shares the coordinator's thread records: 17 and 19, the adapter's copy and the
 * workspace's. It also counts reading a provider out of a public ID, about 2,400 times per update with 200 threads on
 * Owl, where a held provider makes the workspace ask about every thread and model; it reads each ID once now.
 */
/*
 * October 20, 2026: Watcher's observe pass now changes the record only when something changed (#1231), so an update
 * while a thread streams copies Watcher's record no times at all, and Owl makes 10.4 to 10.7 copies per update, from
 * 12.4. The Owl budget is 11 copies and no copy of the record.
 */
/*
 * October 22, 2026 (#1327): each Watcher room publish copied the room's records twice, once in the room state and again
 * in the desktop room's capture for its publish window. The room state now hands out the record's own records, which
 * every change replaces rather than edits, so only the capture copies them: Owl makes 9.4 to 9.8 copies per update, from
 * 10.4 to 10.7. The Owl budget is 10 copies.
 */
const BUDGET = {
  Owl: { copiesPerUpdate: 10, wholeStateCopiesPerUpdate: 1.5, watcherRecordCopiesPerUpdate: 0, objectsPerThreadPerUpdate: 21, parsesPerUpdate: 5 },
  stable: { copiesPerUpdate: 9.5, wholeStateCopiesPerUpdate: 1.5, watcherRecordCopiesPerUpdate: 0, objectsPerThreadPerUpdate: 21, parsesPerUpdate: 5 },
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
    expect(many.watcherRecordCopiesPerUpdate, `an update copies Watcher's whole record more often than its budget: ${seen}`)
      .toBeLessThanOrEqual(BUDGET[track].watcherRecordCopiesPerUpdate)
    expect(many.objectsPerThreadPerUpdate, `an update copies more of every thread than its budget, so a layer copies what another already copied: ${seen}`)
      .toBeLessThanOrEqual(BUDGET[track].objectsPerThreadPerUpdate)
    expect(many.parsesPerUpdate, `an update reads a provider out of public IDs more often with 200 threads than with 20: ${seen}`)
      .toBeLessThanOrEqual(few.parsesPerUpdate * 1.2 + 1)
    expect(many.parsesPerUpdate, `an update reads a provider out of public IDs more often than its budget: ${seen}`)
      .toBeLessThanOrEqual(BUDGET[track].parsesPerUpdate)
    // October 19, 2026: a shown thread with hidden delegation news is projected again only when its own history changes.
    expect(many.hiddenProjectionsPerUpdate, `another thread's update made the delegating thread's history again without its hidden news: ${seen}`).toBe(0)
  }, 120_000)
})
