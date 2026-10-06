// @vitest-environment node
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NativeUsage } from '../../src/main/agents/nativeUsage'
import { sourceAt } from '../fixtures/baselineSource'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

// The commit #767 started from. "before" is its source; "after" is the working tree.
const BASE = 'e8a82a034c42cc3eb9b8fb3c711726353192ade9'
const exec = promisify(execFile)
type Row = { writes: number; bytesWritten: number; archiveBytes: number; streamedMs: number; cpuMs: number; output: number }

/**
 * Writes of the usage ledger while one reply streams: 150 output counts 20 ms apart, then the turn's end, against
 * a ledger about the 6.2 MB the development machine's Claude ledger had grown to (#555 bounds its growth).
 */
describe.skipIf(!PERF_BENCH)('usage ledger writes while a reply streams', () => {
  let root: string
  let seed: string
  const bundles: Record<string, string> = {}
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sotto-usage-stream-bench-'))
    const seeded = new NativeUsage(join(root, 'seed'), 'claude'); await seeded.load()
    for (let thread = 0; thread < 40; thread++) for (let entry = 0; entry < 600; entry++) seeded.claude(`thread-${thread}`, {
      type: 'assistant', timestamp: new Date(Date.UTC(2026, 8, 1, 0, entry)).toISOString(),
      message: { id: `message-${thread}-${entry}`, model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } },
    })
    await seeded.flushed()
    seed = join(root, 'seed', 'claude-usage.json')
    for (const label of ['before', 'after']) {
      const outfile = join(root, `${label}.mjs`)
      await build({ entryPoints: ['tests/fixtures/usageStreamBench.ts'], bundle: true, platform: 'node', format: 'esm', outfile,
        plugins: label === 'before' ? [sourceAt(BASE)] : [],
      })
      bundles[label] = outfile
    }
  }, 300_000)
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

  it('150 output counts 20 ms apart, then the turn ends', async () => {
    const rows: Record<string, Row[]> = { before: [], after: [] }
    for (let run = 0; run < 4; run++) {
      for (const label of run % 2 ? ['after', 'before'] : ['before', 'after']) {
        const { stdout } = await exec(process.execPath, [bundles[label]!, seed, '150', '20'], { maxBuffer: 1024 * 1024 })
        rows[label]!.push(JSON.parse(stdout.trim().split('\n').at(-1)!) as Row)
      }
    }
    for (const label of ['before', 'after']) {
      const samples = rows[label]!
      const med = (field: keyof Row) => round(median(samples.map(row => row[field])))
      console.log(JSON.stringify({ benchmark: 'usage-stream-writes', baseline: BASE, label, runs: samples.length, seedBytes: (await stat(seed)).size,
        writes: med('writes'), bytesWritten: med('bytesWritten'), streamedMs: med('streamedMs'), cpuMs: med('cpuMs') }))
    }
    for (const row of [...rows.before!, ...rows.after!]) expect(row.output).toBe(1500)
  }, 1_800_000)
})
