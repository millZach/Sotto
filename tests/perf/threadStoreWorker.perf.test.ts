// @vitest-environment node
/**
 * What a thread history save costs main once the store worker makes every write (#1457, ADR-0016's October 26
 * amendment). Before it, a publish committed its events on main inside `publishNow`: 0.65 s of a minute in the owner's
 * recording, and on Windows one save could wait about 0.85 s while a checkpoint flushed a large file on the same disk.
 *
 * The first test counts, so it runs in the default suite: streamed events and activity records rewritten whole, as a busy
 * Claude thread saves them, well past SQLite's checkpoint threshold, posted through the writer the workspace uses. Main's
 * connection stays read only throughout, so not one statement on main wrote, and every save committed on the worker.
 * The second times what each save holds main for, with the writer on main and with the worker, against a large store, as
 * the publish does it: the post, and apart from it the window read with what is posted laid over it. It asserts nothing:
 *
 *   PowerShell:  $env:SOTTO_PERF_BENCH = '1'; $env:SOTTO_PERF_STORE_MIB = '860'
 *                npx vitest run tests/perf/threadStoreWorker.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * Every word is random; no user profile is opened.
 */
import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyEventsToWindow } from '../../src/main/agents/storeOverlay'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { ThreadStoreWriterOnMain, ThreadStoreWriterOnWorker, writeFailed, type ThreadStoreWriter } from '../../src/main/agents/threadStoreWriter'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentMessage } from '../../src/shared/agents'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { builtStoreWorker, walIndex } from '../fixtures/storeWorker'

const at = '2026-10-26T10:00:00.000Z'
const words = (length: number): string => randomBytes(Math.ceil(length * 0.75)).toString('base64').slice(0, length)
const message = (id: string): AgentMessage => ({ id, role: 'assistant', text: words(400), createdAt: at })
/** A tool record the size of a large Claude one: rewritten whole each time it changes, its old pages zeroed. */
const record = (id: string, size: number): AgentActivity => Object.freeze({ id, turnId: 'turn', sequence: 0, kind: 'command', status: 'completed', title: 'Ran a command', output: words(size), startedAt: at }) as AgentActivity

interface Saves { failed: number; times: number[]; reads: number[]; mostFrames: number }

/**
 * One step of a few threads streaming, as the workspace does it: a publish window's events posted and the watched
 * thread's window read back with them laid over it, and every fifteenth step an activity save that rewrites each
 * thread's newest large record. Each step's time is what it held main for.
 */
function streamStep(store: ThreadStore, writer: ThreadStoreWriter, path: string, step: number, live: AgentActivity[][], saves: Saves): void {
  const heard = (outcome: Parameters<NonNullable<Parameters<ThreadStoreWriter['post']>[1]>>[0]): void => { if (writeFailed(outcome)) saves.failed++ }
  const started = performance.now()
  writer.post({ kind: 'event-batches', batches: new Map(Array.from({ length: 4 }, (_, thread) => [`thread-${thread}`, [{ kind: 'message-added' as const, at, message: message(`m-${step}-${thread}`) }]])) }, heard)
  if (step % 15 === 0) {
    for (const [thread, records] of live.entries()) {
      const id = `live-${thread}-${(step / 15) % 8}`
      live[thread] = [...records.filter(item => item.id !== id), record(id, 20_000 + (step * 131) % 40_000)].slice(-8)
    }
    writer.post({ kind: 'activities', entries: live.map((activities, thread) => ({ threadId: `thread-${thread}`, activities })) }, heard)
  }
  const read = performance.now()
  saves.times.push(read - started)
  // The watched thread's window, as the publish reads it: forty messages here, since these threads hold no user message.
  store.reading(() => applyEventsToWindow(store.readMessages('thread-0', { limit: 40 }), writer.posted('thread-0'), id => store.message('thread-0', id)))
  saves.reads.push(performance.now() - read)
  saves.mostFrames = Math.max(saves.mostFrames, walIndex(path).frames)
}
const freshSaves = (): Saves => ({ failed: 0, times: [], reads: [], mostFrames: 0 })
const freshLive = (): AgentActivity[][] => [[], [], [], []]
const queryOnly = (store: ThreadStore): number => Number((store as unknown as { db: DatabaseSync }).db.prepare('PRAGMA query_only').get()!.query_only)

describe('thread history saves on the store worker', () => {
  let worker: Awaited<ReturnType<typeof builtStoreWorker>>
  const roots: string[] = []
  beforeAll(async () => { worker = await builtStoreWorker() }, 120_000)
  afterAll(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
    await worker?.dispose()
  })

  it('writes nothing on main, however far the saves grow the log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-store-worker-budget-')); roots.push(root)
    const path = join(root, 'threads.sqlite')
    // The worker's checkpoints are held off, so the log grows past SQLite's own threshold however fast the disk: on a fast
    // one a checkpoint every half second keeps it far below, and the case this holds main to never comes (#1626's CI).
    const store = new ThreadStore(path, undefined, { path: worker.path, timing: { intervalMs: 600_000 } })
    store.open()
    const writer = new ThreadStoreWriterOnWorker(store)
    try {
      const saves = freshSaves(), live = freshLive()
      // Steps go on until the log the worker committed is past SQLite's own threshold of 1,000 pages, where it would have
      // checkpointed inside a save: counted, not timed, since main posts faster than a runner's disk commits.
      let steps = 0
      while (steps < 300 || walIndex(path).frames <= 1_000) {
        if (steps >= 3_000) break
        streamStep(store, writer, path, steps, live, saves)
        steps++
        // Main's connection cannot write while the worker does, so every commit above was the worker's.
        expect(queryOnly(store)).toBe(1)
        if (steps % 20 === 0) await writer.confirmed()
      }
      await writer.confirmed()
      expect(queryOnly(store)).toBe(1)
      saves.mostFrames = Math.max(saves.mostFrames, walIndex(path).frames)
      expect(saves.failed).toBe(0)
      expect(saves.mostFrames).toBeGreaterThan(1_000)
      expect(store.messageCount('thread-0')).toBe(steps)
    } finally { writer.close() }
  }, 120_000)

  describe.skipIf(!PERF_BENCH)('timed against a large store (requires SOTTO_PERF_BENCH=1)', () => {
    const STORE_MIB = Number(process.env.SOTTO_PERF_STORE_MIB ?? 256)
    let path: string
    beforeAll(async () => {
      const root = await mkdtemp(join(tmpdir(), 'sotto-store-worker-bench-')); roots.push(root)
      path = join(root, 'threads.sqlite')
      const store = new ThreadStore(path, undefined, null)
      store.open()
      let next = 0
      while (statSync(path).size < STORE_MIB * 1_048_576) {
        store.appendMany(`thread-${next % 529}`, Array.from({ length: 500 }, () => ({ kind: 'message-added' as const, at, message: message(`seed-${next++}`) })))
        store.syncActivities(`seed-${next % 529}`, Array.from({ length: 40 }, (_, index) => record(`seed-${next}-${index}`, 1_000 + (index * 7_919) % 6_000)))
      }
      store.close()
    }, 1_800_000)

    it('times what each save holds main for with the writer on main and with the worker', async () => {
      const runs: Record<string, unknown>[] = []
      for (const label of ['main', 'worker', 'main', 'worker'] as const) {
        const store = new ThreadStore(path, undefined, label === 'worker' ? worker.path : null)
        store.open()
        const writer = label === 'worker' ? new ThreadStoreWriterOnWorker(store) : new ThreadStoreWriterOnMain(store)
        const saves = freshSaves(), live = freshLive()
        try {
          for (let step = 0; step < 2_000; step++) { streamStep(store, writer, path, step, live, saves); await delay(16) }
          await writer.confirmed()
        } finally { writer.close() }
        const sorted = [...saves.times].sort((a, b) => a - b), reads = [...saves.reads].sort((a, b) => a - b)
        runs.push({ label, saves: sorted.length, failed: saves.failed, medianMs: round(median(sorted), 2), p99Ms: round(sorted[Math.floor(sorted.length * 0.99)]!, 1),
          maxMs: round(sorted.at(-1)!, 1), over16: sorted.filter(ms => ms > 16).length, over100: sorted.filter(ms => ms > 100).length,
          totalMs: Math.round(sorted.reduce((sum, ms) => sum + ms, 0)), readMedianMs: round(median(reads), 2), readP99Ms: round(reads[Math.floor(reads.length * 0.99)]!, 1),
          readMaxMs: round(reads.at(-1)!, 1), readTotalMs: Math.round(reads.reduce((sum, ms) => sum + ms, 0)), mostLogMiB: round(saves.mostFrames * 4_120 / 1_048_576, 1) })
      }
      console.log(JSON.stringify({ benchmark: 'thread-store-worker', storeMiB: round(statSync(path).size / 1_048_576, 0), runs }))
      expect(runs).toHaveLength(4)
    }, 1_800_000)
  })
})
