// @vitest-environment node
/**
 * What a thread history save costs main once the log's checkpoints run on a worker (#1451, ADR-0016's October 23
 * amendment). A one-minute profile of the owner's Owl build had main held for 1.19 s by one event commit, nearly all of
 * it under the commit itself: the commit that grows the log past SQLite's threshold runs the checkpoint inline, flushing
 * the log and an 860 MB file on main.
 *
 * The first test counts, so it runs in the default suite: streamed events and activity records rewritten whole, as a
 * busy Claude thread saves them, well past SQLite's threshold, and not one save on main may put pages into the file.
 * The second times saves against a large store with SQLite's own checkpoint and with the worker's, and asserts nothing:
 *
 *   PowerShell:  $env:SOTTO_PERF_BENCH = '1'; $env:SOTTO_PERF_STORE_MIB = '860'
 *                npx vitest run tests/perf/historyCheckpointOffMain.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * Every word is random; no user profile is opened.
 */
import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ThreadStore } from '../../src/main/agents/threadStore'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentMessage } from '../../src/shared/agents'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { builtCheckpointWorker, walIndex } from '../fixtures/walCheckpointWorker'

const at = '2026-10-23T10:00:00.000Z'
const words = (length: number): string => randomBytes(Math.ceil(length * 0.75)).toString('base64').slice(0, length)
const message = (id: string): AgentMessage => ({ id, role: 'assistant', text: words(400), createdAt: at })
/** A tool record the size of a large Claude one: rewritten whole each time it changes, its old pages zeroed. */
const record = (id: string, size: number): AgentActivity => ({ id, turnId: 'turn', sequence: 0, kind: 'command', status: 'completed', title: 'Ran a command', output: words(size), startedAt: at })

interface Saves { inline: number; times: number[]; mostFrames: number }

/**
 * One step of a few threads streaming: about a publish window's events, and every fifteenth step an activity save that
 * rewrites each thread's newest large record.
 */
function streamStep(store: ThreadStore, path: string, step: number, live: AgentActivity[][], saves: Saves): void {
  const save = (work: () => void): void => {
    const before = walIndex(path)
    const started = performance.now()
    work()
    saves.times.push(performance.now() - started)
    const after = walIndex(path)
    // Pages reached the file during the save: it ran a checkpoint. A worker's checkpoint could land inside the
    // window too, so the count is taken with the worker held aside (below), or read as an upper bound.
    if (after.backfilled > before.backfilled) saves.inline++
    saves.mostFrames = Math.max(saves.mostFrames, after.frames)
  }
  save(() => store.appendBatches(new Map(Array.from({ length: 4 }, (_, thread) => [`thread-${thread}`, [{ kind: 'message-added' as const, at, message: message(`m-${step}-${thread}`) }]]))))
  if (step % 15 === 0) {
    for (const [thread, records] of live.entries()) {
      const id = `live-${thread}-${(step / 15) % 8}`
      live[thread] = [...records.filter(item => item.id !== id), record(id, 20_000 + (step * 131) % 40_000)].slice(-8)
    }
    save(() => store.syncActivitiesMany(live.map((activities, thread) => ({ threadId: `thread-${thread}`, activities }))))
  }
}
const freshSaves = (): Saves => ({ inline: 0, times: [], mostFrames: 0 })
const freshLive = (): AgentActivity[][] => [[], [], [], []]

describe('thread history saves with the log checkpointed off main', () => {
  let worker: Awaited<ReturnType<typeof builtCheckpointWorker>>
  const roots: string[] = []
  beforeAll(async () => { worker = await builtCheckpointWorker() })
  afterAll(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
    await worker?.dispose()
  })

  it('runs no checkpoint in any save on main, however far the saves grow the log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-checkpoint-budget-')); roots.push(root)
    const path = join(root, 'threads.sqlite')
    const store = new ThreadStore(path, undefined, worker.path)
    store.open()
    try {
      const checkpointer = (store as unknown as { checkpointer: { aside<T>(work: () => T): T } }).checkpointer
      // Held aside, the worker cannot checkpoint, so any page that reaches the file during a save was the save's own.
      const saves = freshSaves(), live = freshLive()
      checkpointer.aside(() => { for (let step = 0; step < 300; step++) streamStep(store, path, step, live, saves) })
      // Well past SQLite's own threshold of 1,000 pages, where it would have checkpointed inside a save.
      expect(saves.mostFrames).toBeGreaterThan(2_000)
      expect(saves.inline).toBe(0)
    } finally { store.close() }
  }, 120_000)

  describe.skipIf(!PERF_BENCH)('timed against a large store (requires SOTTO_PERF_BENCH=1)', () => {
    const STORE_MIB = Number(process.env.SOTTO_PERF_STORE_MIB ?? 256)
    let path: string
    beforeAll(async () => {
      const root = await mkdtemp(join(tmpdir(), 'sotto-checkpoint-bench-')); roots.push(root)
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

    it('times each save with SQLite\'s checkpoint and with the worker\'s', async () => {
      const runs: Record<string, unknown>[] = []
      for (const [label, checkpointWorker] of [['inline', null], ['worker', worker.path], ['inline', null], ['worker', worker.path]] as const) {
        const store = new ThreadStore(path, undefined, checkpointWorker)
        store.open()
        const saves = freshSaves(), live = freshLive()
        try {
          for (let step = 0; step < 2_000; step++) { streamStep(store, path, step, live, saves); await delay(16) }
        } finally { store.close() }
        const sorted = [...saves.times].sort((a, b) => a - b)
        runs.push({ label, saves: sorted.length, medianMs: round(median(sorted), 2), p99Ms: round(sorted[Math.floor(sorted.length * 0.99)]!, 1),
          maxMs: round(sorted.at(-1)!, 1), over16: sorted.filter(ms => ms > 16).length, over100: sorted.filter(ms => ms > 100).length,
          heldMs: Math.round(sorted.filter(ms => ms > 16).reduce((sum, ms) => sum + ms, 0)), savesThatCheckpointed: saves.inline, mostLogMiB: round(saves.mostFrames * 4_120 / 1_048_576, 1) })
      }
      console.log(JSON.stringify({ benchmark: 'history-checkpoint-off-main', storeMiB: round(statSync(path).size / 1_048_576, 0), runs }))
      expect(runs).toHaveLength(4)
    }, 1_800_000)
  })
})
