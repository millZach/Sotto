// @vitest-environment node
import { randomBytes } from 'node:crypto'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ThreadStore } from '../../src/main/agents/threadStore'
import type { AgentMessage } from '../../src/shared/agents'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { PERF_ASSERT } from '../fixtures/perfBudget'

/**
 * What a thread history save costs main at `synchronous=FULL` and at `NORMAL` (docs/perf/2026-10-19-history-save-sync.md).
 * It fills a real `threads.sqlite` with synthetic messages, then times each `appendMany` of a streamed-sized batch,
 * and reads SQLite's shared-memory header around it to tell the commits that ran an automatic checkpoint from
 * those that did not. Nothing a user said is opened: every word is random.
 *
 *   PowerShell:  $env:SOTTO_PERF_BENCH = '1'; npx vitest run tests/perf/historySaveSync.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * `SOTTO_PERF_STORE_MIB` sets the store's size (64 by default; the development profile's was 514).
 * `SOTTO_PERF_ASSERT=1` also checks that a NORMAL commit without a checkpoint is faster than a FULL one.
 */
const STORE_MIB = Number(process.env.SOTTO_PERF_STORE_MIB ?? 64)
const COMMITS = 600
const at = '2026-10-19T10:00:00.000Z'
const words = (): string => randomBytes(1_200).toString('base64')
const message = (id: string): AgentMessage => ({ id, role: 'assistant', text: words(), createdAt: at })

interface Run { checkpoint: number[]; plain: number[] }

describe.skipIf(!PERF_BENCH && !PERF_ASSERT)('Thread history saves at FULL and NORMAL (requires SOTTO_PERF_BENCH=1 or SOTTO_PERF_ASSERT=1)', () => {
  let root: string
  let path: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sotto-history-sync-bench-'))
    path = join(root, 'threads.sqlite')
    const store = new ThreadStore(path)
    store.open()
    let next = 0
    while (statSync(path).size < STORE_MIB * 1_048_576) {
      store.appendMany(`thread-${next % 200}`, Array.from({ length: 2_000 }, () => ({ kind: 'message-added' as const, at, message: message(`m${next++}`) })))
    }
    store.close()
  }, 600_000)
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

  function run(synchronous: 'FULL' | 'NORMAL'): Run {
    const store = new ThreadStore(path)
    store.open()
    const db = (store as unknown as { db: DatabaseSync }).db
    db.exec(`PRAGMA synchronous=${synchronous}`)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    store.append('warm', { kind: 'message-added', at, message: message('warm') })
    const shm = openSync(`${path}-shm`, 'r')
    const header = Buffer.alloc(100)
    // mxFrame and nBackfill in SQLite's wal-index header: a commit that backfilled the whole log checkpointed it.
    const read = (): { frames: number; backfilled: number } => {
      readSync(shm, header, 0, 100, 0)
      return { frames: header.readUInt32LE(16), backfilled: header.readUInt32LE(96) }
    }
    const result: Run = { checkpoint: [], plain: [] }
    try {
      for (let index = 0; index < COMMITS; index++) {
        // About what one 16 ms publish window commits for a few streaming threads.
        const batch = Array.from({ length: 6 }, (_, offset) => ({ kind: 'message-added' as const, at, message: message(`${synchronous}-${index}-${offset}`) }))
        const before = read()
        const started = performance.now()
        store.appendMany(`thread-${index % 3}`, batch)
        const elapsed = performance.now() - started
        const after = read()
        const checkpointed = after.backfilled > before.backfilled && after.backfilled === after.frames
        result[checkpointed ? 'checkpoint' : 'plain'].push(elapsed)
      }
    } finally {
      closeSync(shm)
      store.close()
    }
    return result
  }

  it('times commits with and without an automatic checkpoint', () => {
    const report = (synchronous: 'FULL' | 'NORMAL', result: Run) => {
      const all = [...result.checkpoint, ...result.plain].sort((a, b) => a - b)
      return {
        synchronous,
        medianMs: round(median(all), 2), p95Ms: round(all[Math.floor(all.length * 0.95)]!, 1), maxMs: round(all.at(-1)!, 1),
        over50: all.filter(ms => ms > 50).length,
        plainMedianMs: round(median(result.plain), 2),
        checkpoints: result.checkpoint.length,
        checkpointMedianMs: result.checkpoint.length ? round(median(result.checkpoint), 1) : null,
      }
    }
    const full = run('FULL')
    const normal = run('NORMAL')
    console.log(JSON.stringify({ storeMiB: STORE_MIB, builtMiB: round(statSync(path).size / 1_048_576, 0), commits: COMMITS, runs: [report('FULL', full), report('NORMAL', normal)] }))
    expect(full.plain.length + full.checkpoint.length).toBe(COMMITS)
    if (PERF_ASSERT) expect(median(normal.plain)).toBeLessThan(median(full.plain))
  }, 600_000)
})
