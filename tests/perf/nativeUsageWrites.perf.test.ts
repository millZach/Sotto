// @vitest-environment node
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NativeUsage } from '../../src/main/agents/nativeUsage'
import { sourceAt } from '../fixtures/baselineSource'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

const BASE = '7b5fdb843c46ca9fbd21d0ea6acc6656d7f72def'
const exec = promisify(execFile)
type Measurement = { writes: number; entriesWritten: number; observedMs: number; drainedMs: number; cpuMs: number;
  heapBefore: number; heapAfterObservations: number; heapAfterDrain: number; archiveBytes: number; result: unknown }

describe.skipIf(!PERF_BENCH)('isolated native usage archive writes', () => {
  let root: string
  const bundles: Record<string, string> = {}
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sotto-usage-comparison-'))
    for (const label of ['before', 'after']) {
      const outfile = join(root, `${label}.mjs`)
      await build({ entryPoints: ['tests/fixtures/nativeUsageBench.ts'], bundle: true, platform: 'node', format: 'esm', outfile,
        plugins: label === 'before' ? [sourceAt(BASE)] : [],
      })
      bundles[label] = outfile
    }
  })
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

  for (const [threads, entries] of [[1, 100], [4, 250], [20, 250]] as const) {
    for (const scenario of ['replay', 'stream', 'turns']) {
      it(`${scenario}: ${threads} threads x ${entries} entries`, async () => {
        const seedRoot = join(root, `seed-${threads}-${scenario}`)
        const seed = new NativeUsage(seedRoot, 'claude'); await seed.load()
        for (let thread = 0; thread < threads; thread++) {
          for (let entry = 0; entry < entries; entry++) seed.claude(`thread-${thread}`, {
            type: 'assistant', timestamp: new Date(Date.UTC(2026, 8, 1, 0, entry)).toISOString(),
            message: { id: `message-${entry}`, model: 'claude-sonnet-4-6', usage: {
              input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0,
            } },
          })
        }
        await seed.flushed()
        const rows: Record<string, Measurement[]> = { before: [], after: [] }
        // Fresh processes isolate heaps and module state; alternating order reduces warm filesystem bias.
        // The first pair is warm-up and is not included in medians.
        for (let run = 0; run < 4; run++) {
          for (const label of run % 2 ? ['after', 'before'] : ['before', 'after']) {
            const { stdout } = await exec(process.execPath, [bundles[label]!, join(seedRoot, 'claude-usage.json'), String(threads), scenario], { maxBuffer: 1024 * 1024 })
            const row = JSON.parse(stdout.trim()) as Measurement
            if (run) rows[label]!.push(row)
          }
        }
        for (let sample = 0; sample < 3; sample++) {
          expect(rows.after![sample]!.result).toEqual(rows.before![sample]!.result)
          expect(rows.before![sample]!.writes).toBe(100)
          expect(rows.after![sample]!.writes).toBeLessThanOrEqual(scenario === 'replay' ? 0 : 10)
        }
        for (const label of ['before', 'after']) {
          const samples = rows[label]!
          const med = (field: keyof Omit<Measurement, 'result'>) => round(median(samples.map(row => row[field])))
          console.log(JSON.stringify({ benchmark: 'native-usage-writes', baseline: BASE, label, threads, entries, scenario, samples: samples.length,
            writes: med('writes'), entriesWritten: med('entriesWritten'), observedMs: med('observedMs'), drainedMs: med('drainedMs'), cpuMs: med('cpuMs'),
            heapBefore: med('heapBefore'), heapAfterObservations: med('heapAfterObservations'), heapAfterDrain: med('heapAfterDrain'), archiveBytes: med('archiveBytes') }))
        }
      }, 180_000)
    }
  }
})
