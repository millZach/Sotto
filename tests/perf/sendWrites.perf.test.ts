// @vitest-environment node
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sourceAt } from '../fixtures/baselineSource'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import type { SendWrites } from '../fixtures/sendWritesWorkload'

// The commit #767 started from. "before" is its source; "after" is the working tree.
const BASE = 'e8a82a034c42cc3eb9b8fb3c711726353192ade9'
const exec = promisify(execFile)
const SENDS = 6

/**
 * Durable writes and time between Send and the provider hearing the prompt, before and after #767, through the
 * window's draft store, the coordinator and the real adapter over its fake client, with the provider's thread
 * store grown to the size it was on the development machine. Each run is a fresh process on a fresh profile.
 */
describe.skipIf(!PERF_BENCH)("durable writes between Send and the provider hearing the prompt (timing benchmark; requires SOTTO_PERF_BENCH=1)", () => {
  let root: string
  const bundles: Record<string, string> = {}
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sotto-send-writes-'))
    for (const label of ['before', 'after']) {
      const outfile = join(root, `${label}.mjs`)
      await build({ entryPoints: ['tests/fixtures/sendWritesBench.ts'], bundle: true, platform: 'node', format: 'esm', outfile,
        external: ['electron', 'node-pty'],
        banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
        plugins: label === 'before' ? [sourceAt(BASE)] : [],
      })
      bundles[label] = outfile
    }
  }, 120_000)
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

  for (const provider of ['claude', 'codex'] as const) {
    it(provider, async () => {
      const rows: Record<string, SendWrites[][]> = { before: [], after: [] }
      // Alternating order spreads a warm or busy disk across both; each process starts cold.
      for (let run = 0; run < 4; run++) {
        for (const label of run % 2 ? ['after', 'before'] : ['before', 'after']) {
          const { stdout } = await exec(process.execPath, [bundles[label]!, provider, String(SENDS)], { cwd: resolve('.'), maxBuffer: 1024 * 1024, timeout: 300_000 })
          rows[label]!.push(JSON.parse(stdout.trim().split('\n').at(-1)!) as SendWrites[])
        }
      }
      for (const label of ['before', 'after']) {
        // The first send of each run also starts the thread's session; the rest are the common case.
        const warm = rows[label]!.flatMap(sends => sends.slice(1))
        const first = rows[label]!.map(sends => sends[0]!)
        const files = [...new Set(warm.flatMap(send => Object.keys(send.writes)))].sort()
        console.log(JSON.stringify({ benchmark: 'send-writes', baseline: BASE, provider, label, runs: rows[label]!.length, warmSends: warm.length,
          warmMs: round(median(warm.map(send => send.ms))), warmMsRange: [round(Math.min(...warm.map(send => send.ms))), round(Math.max(...warm.map(send => send.ms)))],
          firstMs: round(median(first.map(send => send.ms))),
          warmWrites: Object.fromEntries(files.map(file => [file, median(warm.map(send => send.writes[file] ?? 0))])),
          warmBytes: Object.fromEntries(files.map(file => [file, median(warm.map(send => send.bytes[file] ?? 0))])),
          firstWrites: first[0]!.writes }))
      }
      expect(rows.after!.length).toBe(4)
    }, 1_800_000)
  }
})
