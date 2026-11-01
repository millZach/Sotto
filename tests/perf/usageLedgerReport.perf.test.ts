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

/**
 * What one usage report costs main on a long thread (#555). Claude Code reports a reply's usage on nearly every frame, and
 * each report summed every request the thread ever made again: the cost grew with the thread's length. The thread's totals
 * are now kept running, so a report on the newest request costs the same however long the thread is.
 *
 * The guard runs in the default suite and counts no walk of a long thread's requests per report. With SOTTO_PERF_BENCH=1 it
 * also times reports on Claude threads of 1,800, 10,000 and 40,000 requests, and replayed reports on Codex threads of as
 * many turns, "before" being the source at BASE and "after" the working tree, each in a process of its own, alternated:
 *
 *   SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/usageLedgerReport.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
const BASE = 'bde56ebfe86ba8bf4bf758b58de9f8c2553e4ae3'
const exec = promisify(execFile)

/** Every walk of an object or array of a long thread's size made while `work` runs, counted where it would start. */
function walksDuring(work: () => void): number {
  let count = 0
  const keys = Object.keys, values = Object.values, entries = Object.entries, includes = Array.prototype.includes
  const counted = <Walk extends (value: object) => unknown>(walk: Walk): Walk => ((value: object) => { if (value && keys(value).length >= 1_000) count++; return walk(value) }) as Walk
  Object.keys = counted(keys); Object.values = counted(values) as typeof Object.values; Object.entries = counted(entries) as typeof Object.entries
  Array.prototype.includes = function (this: unknown[], ...args: Parameters<typeof includes>) { if (this.length >= 1_000) count++; return includes.apply(this, args) }
  try { work() } finally { Object.keys = keys; Object.values = values; Object.entries = entries; Array.prototype.includes = includes }
  return count
}

const claudeReport = (id: string, output: number) => ({ type: 'assistant', message: { id, model: 'claude-opus-5-5',
  usage: { input_tokens: 1_000, output_tokens: output, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 0 } } })
const codexReport = (turn: number) => ({ turnId: `turn-${turn}`,
  tokenUsage: { total: { inputTokens: turn * 100, outputTokens: turn * 10, cachedInputTokens: 0 }, last: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 } } })

it('walks none of a long thread\'s requests for a report on a streaming reply, even with a replay adding requests after it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-usage-report-guard-'))
  try {
    const usage = new NativeUsage(root, 'claude'); await usage.load()
    for (let index = 0; index < 5_000; index++) usage.claude('thread', claudeReport(`msg_${index}`, 100))
    usage.claude('thread', { type: 'stream_event', event: { type: 'message_start', message: claudeReport('msg_streaming', 1).message } })
    const delta = (output: number) => usage.claude('thread', { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: output } } })
    expect(walksDuring(() => { for (let frame = 1; frame <= 200; frame++) delta(1 + frame) })).toBe(0)
    // A replay of the thread's history reads 50 requests it had not counted while the reply still streams.
    expect(walksDuring(() => {
      for (let index = 0; index < 50; index++) usage.claude('thread', claudeReport(`msg_replayed_${index}`, 100))
      for (let frame = 201; frame <= 400; frame++) delta(1 + frame)
    })).toBe(0)
    expect(usage.get('thread')?.total?.output).toBe(5_050 * 100 + 401)
    await usage.flushed()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('tells a replayed Codex report from a new one without scanning every key a long thread saw', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-usage-seen-guard-'))
  try {
    const usage = new NativeUsage(root, 'codex'); await usage.load()
    for (let turn = 1; turn <= 5_000; turn++) usage.codex('thread', 'gpt-5.4', codexReport(turn))
    expect(walksDuring(() => { for (let turn = 4_801; turn <= 5_000; turn++) usage.codex('thread', 'gpt-5.4', codexReport(turn)) })).toBe(0)
    expect(walksDuring(() => usage.codex('thread', 'gpt-5.4', codexReport(5_001)))).toBe(0)
    expect(usage.get('thread')?.total).toMatchObject({ input: 5_001 * 100, output: 5_001 * 10 })
    await usage.flushed()
  } finally { await rm(root, { recursive: true, force: true }) }
})

describe.skipIf(!PERF_BENCH)('a usage report on a long thread (timing benchmark; requires SOTTO_PERF_BENCH=1)', () => {
  let root: string
  const bundles: Record<string, string> = {}
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sotto-usage-report-bench-'))
    for (const label of ['before', 'after']) {
      const outfile = join(root, `${label}.mjs`)
      await build({ entryPoints: ['tests/fixtures/usageReportBench.ts'], bundle: true, platform: 'node', format: 'esm', outfile,
        plugins: label === 'before' ? [sourceAt(BASE)] : [] })
      bundles[label] = outfile
    }
  }, 300_000)
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

  it('reports on threads of 1,800, 10,000 and 40,000 requests, and replays on Codex threads of as many turns', async () => {
    for (const provider of ['claude', 'codex'] as const) for (const requests of [1_800, 10_000, 40_000]) {
      // Seeded once, with the working tree's ledger, which writes the same per-thread file the source at BASE reads.
      const seed = join(root, `seed-${provider}-${requests}`)
      const seeding = new NativeUsage(seed, provider); await seeding.load()
      for (let index = 0; index < requests; index++) {
        if (provider === 'claude') seeding.claude('thread', { type: 'assistant', timestamp: '2026-10-31T12:00:00.000Z',
          message: { id: `msg_${index}`, model: 'claude-opus-5-5', usage: { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 0 } } })
        else seeding.codex('thread', 'gpt-5.4', { turnId: `turn-${index + 1}`, tokenUsage: { total: { inputTokens: (index + 1) * 100, outputTokens: (index + 1) * 10, cachedInputTokens: 0 }, last: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 } } })
      }
      await seeding.flushed()
      const rows: Record<string, { msPerReport: number; cpuMsPerReport: number; total: number }[]> = { before: [], after: [] }
      for (let run = 0; run < 3; run++) {
        for (const label of run % 2 ? ['after', 'before'] : ['before', 'after']) {
          const { stdout } = await exec(process.execPath, [bundles[label]!, seed, '200', provider, String(requests)], { maxBuffer: 1024 * 1024, cwd: process.cwd() })
          rows[label]!.push(JSON.parse(stdout.trim().split('\n').at(-1)!))
        }
      }
      for (const label of ['before', 'after']) {
        const samples = rows[label]!
        console.log(JSON.stringify({ benchmark: 'usage-ledger-report', baseline: BASE, label, provider, requests, runs: samples.length,
          msPerReport: round(median(samples.map(row => row.msPerReport)), 3), cpuMsPerReport: round(median(samples.map(row => row.cpuMsPerReport)), 3) }))
      }
      // Both count the same tokens.
      expect(new Set([...rows.before!, ...rows.after!].map(row => row.total)).size).toBe(1)
    }
  }, 1_800_000)
})
