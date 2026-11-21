// @vitest-environment node
/**
 * What a thread's history costs to hand the main window when it is picked (#2737): each stored history as the window
 * asked for it whole, and as it is sent now, every finished record's long bodies cut (`WindowActivityBodies`). Reports
 * its size as the IPC serializes it, one copy as the IPC makes it (the context bridge makes a second), and main's cut, first
 * and on a later open, which hands it fresh copies of the same records, as main's whole reads do. Uses an explicitly selected data folder: `workspace.json`, and the stored histories in its
 * `threads.sqlite`, read from a snapshot copied to a temporary folder (`copyPerfHistory`), since opening a store may
 * migrate it.
 *
 *   Set SOTTO_PERF_BENCH=1 and SOTTO_PERF_DATA=<folder with workspace.json and threads.sqlite>.
 *   npx vitest run tests/perf/windowHistoryBytes.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deserialize, serialize } from 'node:v8'
import { describe, expect, it } from 'vitest'
import { round } from '../fixtures/perfBench'
import { copyPerfHistory, perfDataDirectory } from '../fixtures/perfWorkspace'
import { upperMedian as median } from './support/statistics.mjs'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { WindowActivityBodies } from '../../src/main/agents/windowActivityBodies'
import type { AgentHostSnapshot, AgentThreadDetail } from '../../src/shared/agents'

const RUNS = 9

function time(work: () => void): number {
  const samples: number[] = []
  for (let run = 0; run < RUNS; run++) { const started = performance.now(); work(); samples.push(performance.now() - started) }
  return median(samples)
}

/** One copy as Electron's IPC makes it: structured clone. */
const wire = (value: unknown): unknown => deserialize(serialize(value))

describe('a thread’s history as the main window is handed it', async () => {
  const dataDirectory = await perfDataDirectory()
  const store = dataDirectory === null ? null : await access(join(dataDirectory, 'threads.sqlite')).then(() => join(dataDirectory, 'threads.sqlite'), () => null)
  describe('requires SOTTO_PERF_BENCH=1 and SOTTO_PERF_DATA containing workspace.json and threads.sqlite', () => {
    it.skipIf(store === null)('reports each stored history whole and cut, in bytes and copy time', async () => {
      const workspace = JSON.parse(await readFile(join(dataDirectory!, 'workspace.json'), 'utf8')) as { snapshot: AgentHostSnapshot }
      const copy = await mkdtemp(join(tmpdir(), 'sotto-window-history-'))
      const rows: Record<string, unknown>[] = []
      let threads: ThreadStore | undefined
      try {
        await copyPerfHistory(dataDirectory!, copy)
        threads = new ThreadStore(join(copy, 'threads.sqlite'), undefined, null)
        threads.open()
        for (const thread of workspace.snapshot.threads) {
          if (!threads.hasActivities(thread.id)) continue
          const whole: AgentThreadDetail = { threadId: thread.id, revision: 1, messages: threads.readMessages(thread.id).messages, activities: threads.readActivities(thread.id) }
          const bodies = new WindowActivityBodies(() => null)
          const firstCut = (() => { const started = performance.now(); bodies.detail(whole); return performance.now() - started })()
          const cut = bodies.detail(whole)!
          const reads = Array.from({ length: RUNS }, () => ({ ...whole, activities: structuredClone(whole.activities) }))
          const laterCut = median(reads.map(read => { const started = performance.now(); bodies.detail(read); return performance.now() - started }))
          const wholeBytes = serialize(whole).byteLength, cutBytes = serialize(cut).byteLength
          rows.push({
            activities: whole.activities!.length, cutRecords: cut.activities!.filter(record => record.cut !== undefined).length,
            wholeMB: round(wholeBytes / 1048576, 2), cutMB: round(cutBytes / 1048576, 2),
            wholeCopyMs: round(time(() => { wire(whole) }), 1), cutCopyMs: round(time(() => { wire(cut) }), 1),
            firstCutMs: round(firstCut, 1), laterCutMs: round(laterCut, 1),
          })
          expect(cutBytes).toBeLessThanOrEqual(wholeBytes)
        }
      } finally { threads?.close(); await rm(copy, { recursive: true, force: true }) }
      expect(rows.length).toBeGreaterThan(0)
      rows.sort((a, b) => (b.wholeMB as number) - (a.wholeMB as number))
      console.table(rows)
    }, 600_000)
  })
})
