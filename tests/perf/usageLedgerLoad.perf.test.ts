// @vitest-environment node
import { execFile } from 'node:child_process'
import { cp, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NativeUsage } from '../../src/main/agents/nativeUsage'
import { sourceAt } from '../fixtures/baselineSource'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

/**
 * What reading the Claude usage ledgers costs a start (#1937). Every thread's ledger was read whole at start, every request
 * it ever made, although only the threads working that run touch their requests; start now reads each thread's view.
 *
 * A folder the size of the owner's, 290 threads of 190 requests and one of 10,000, is seeded once with the working tree.
 * Each run starts from a copy of it in a process of its own (`tests/fixtures/usageLoadBench.ts`) and times `load()`, the
 * heap it leaves behind once collected, and the long thread's first report after it. "before" is the source at BASE;
 * "upgrade" is the working tree on a folder an earlier build left, with no views; "later" is the working tree on the next
 * start, views written. Each is run again with Usage on: a `UsageService` reads every thread's saved rows once Claude
 * connects, and each task it reads them in is timed, the longest of them being the claim with the total and the heap:
 *
 *   SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/usageLedgerLoad.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * The guard that start reads no thread's requests, and a report its own thread's once, is in the default suite:
 * `tests/unit/main/nativeUsageLazyLoad.test.ts`.
 */
const BASE = 'f976052cceddad79b00542fc1caf5113e47c1b58'
const THREADS = 290, REQUESTS = 190, LONG = 10_000
const exec = promisify(execFile)
type Label = 'before' | 'upgrade' | 'later'
type Row = { loadMs: number; loadCpuMs: number; loadHeapMb: number; snapshotTaskMs?: number; visitMs?: number; visitCpuMs?: number; batches?: number
  medianBatchMs?: number; longestBatchMs?: number; longestTaskMs?: number; secondLongestTaskMs?: number; batchesOver8Ms?: number; visitHeapMb?: number
  rows?: number; firstReportMs: number; output: number }

const report = (index: number) => ({ type: 'assistant', timestamp: new Date(Date.UTC(2026, 8, 1) + index * 60_000).toISOString(),
  message: { id: `msg_${index}`, model: 'claude-opus-5-5', usage: { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 0 } } })

describe.skipIf(!PERF_BENCH)('reading the usage ledgers at start (timing benchmark; requires SOTTO_PERF_BENCH=1)', () => {
  let root: string
  let seed: string
  const bundles: Record<string, string> = {}
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sotto-usage-load-bench-'))
    seed = join(root, 'seed')
    const seeding = new NativeUsage(seed, 'claude'); await seeding.load()
    for (let thread = 0; thread < THREADS; thread++) for (let index = 0; index < REQUESTS; index++) seeding.claude(`thread-${thread}`, report(index))
    for (let index = 0; index < LONG; index++) seeding.claude('long', report(index))
    await seeding.flushed()
    for (const label of ['before', 'after']) {
      const outfile = join(root, `${label}.mjs`)
      // The usage store's worker is found beside the bundle by `__dirname`, which a module has not; the benchmark answers
      // for the store itself.
      await build({ entryPoints: ['tests/fixtures/usageLoadBench.ts'], bundle: true, platform: 'node', format: 'esm', outfile,
        define: { __dirname: '"."' }, plugins: label === 'before' ? [sourceAt(BASE)] : [] })
      bundles[label] = outfile
    }
  }, 300_000)
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

  /** A copy of the seed as `label`'s start finds it. A copy's files are new, so the seed's views no longer match them. */
  async function folderFor(label: Label, run: string): Promise<string> {
    const folder = join(root, run)
    await cp(seed, folder, { recursive: true })
    const directory = join(folder, 'claude-usage')
    if (label === 'upgrade') for (const name of await readdir(directory)) if (name.endsWith('.view.json')) await rm(join(directory, name))
    // The start before this one, by this build, which read each ledger whole and wrote its view.
    if (label === 'later') { const earlier = new NativeUsage(folder, 'claude'); await earlier.load(); await earlier.flushed() }
    return folder
  }

  it('290 threads of 190 requests and one of 10,000, with Usage off and on', async () => {
    const directory = join(seed, 'claude-usage'), names = await readdir(directory)
    const bytes = async (pattern: RegExp) => (await Promise.all(names.filter(name => pattern.test(name)).map(async name => (await stat(join(directory, name))).size))).reduce((sum, size) => sum + size, 0)
    console.log(JSON.stringify({ benchmark: 'usage-ledger-load', threads: THREADS + 1, ledgerBytes: await bytes(/^[0-9a-f]{40}\.json$/u), viewBytes: await bytes(/\.view\.json$/u) }))
    for (const visit of ['none', 'visit'] as const) {
      const rows: Record<Label, Row[]> = { before: [], upgrade: [], later: [] }
      const labels: Label[] = ['before', 'upgrade', 'later']
      for (let run = 0; run < 3; run++) {
        for (const label of run % 2 ? [...labels].reverse() : labels) {
          const folder = await folderFor(label, `${visit}-${label}-${run}`)
          try {
            const { stdout } = await exec(process.execPath, ['--expose-gc', bundles[label === 'before' ? 'before' : 'after']!, folder, String(THREADS), visit],
              { maxBuffer: 1024 * 1024, cwd: process.cwd() })
            rows[label].push(JSON.parse(stdout.trim().split('\n').at(-1)!) as Row)
          } finally { await rm(folder, { recursive: true, force: true }) }
        }
      }
      for (const label of labels) {
        const samples = rows[label]
        const med = (field: keyof Row, places = 1) => samples[0]![field] === undefined ? undefined : round(median(samples.map(row => row[field] as number)), places)
        const most = (field: keyof Row) => samples[0]![field] === undefined ? undefined : round(Math.max(...samples.map(row => row[field] as number)), 1)
        console.log(JSON.stringify({ benchmark: 'usage-ledger-load', baseline: BASE, label, usage: visit === 'visit' ? 'on' : 'off', runs: samples.length,
          loadMs: med('loadMs'), loadCpuMs: med('loadCpuMs'), loadHeapMb: med('loadHeapMb'),
          // Usage's visit: the snapshot's own task, each later task reading queued threads, and the longest of them all.
          snapshotTaskMs: med('snapshotTaskMs'), visitMs: med('visitMs'), visitCpuMs: med('visitCpuMs'), batches: med('batches', 0),
          medianBatchMs: med('medianBatchMs'), longestBatchMs: med('longestBatchMs'), longestTaskMs: med('longestTaskMs'), longestTaskMsWorstRun: most('longestTaskMs'),
          secondLongestTaskMs: med('secondLongestTaskMs'), secondLongestTaskMsWorstRun: most('secondLongestTaskMs'), batchesOver8Ms: med('batchesOver8Ms', 0),
          visitHeapMb: med('visitHeapMb'),
          firstReportMs: med('firstReportMs', 2) }))
      }
      // Every start counts the same tokens, and Usage visits the same rows.
      const all = Object.values(rows).flat()
      expect(new Set(all.map(row => row.output)).size).toBe(1)
      expect(new Set(all.map(row => row.rows)).size).toBe(1)
    }
  }, 1_800_000)
})
