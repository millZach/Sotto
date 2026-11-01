// @vitest-environment node
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sourceAt } from '../fixtures/baselineSource'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

/**
 * The Codex rollout reader reading real rollouts from the start, as the first read of a thread with no saved position
 * does (#992): "before" is the source at BASE, "after" the working tree, each in a process of its own, alternated, three
 * runs each, over the same rollouts read-only. Both must emit the same messages. Needs SOTTO_PERF_BENCH=1 and
 * SOTTO_AUDIT_CODEX_HOME naming a Codex home whose sessions it may read:
 *
 *   SOTTO_PERF_BENCH=1 SOTTO_AUDIT_CODEX_HOME=$HOME/.codex NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/codexRolloutRead.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
const BASE = 'a028edc36ad537f42f6e76df04a24ca669af1b32'
const exec = promisify(execFile)
const codexHome = process.env.SOTTO_AUDIT_CODEX_HOME

describe.skipIf(!PERF_BENCH || !codexHome)('the Codex rollout reader from the start (timing benchmark)', () => {
  let root: string
  let list: string
  let sampleMB = 0
  let rollouts = 0
  const bundles: Record<string, string> = {}
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sotto-codex-rollout-bench-'))
    const files: { path: string; size: number; threadId: string }[] = []
    const walk = async (directory: string, depth = 0): Promise<void> => {
      if (depth > 3) return
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, item.name)
        if (item.isDirectory()) await walk(path, depth + 1)
        else if (item.name.startsWith('rollout-') && item.name.endsWith('.jsonl')) files.push({ path, size: (await stat(path)).size, threadId: item.name.slice(-'.jsonl'.length - 36, -'.jsonl'.length) })
      }
    }
    await walk(join(codexHome!, 'sessions'))
    // About 120 MB of rollouts under 20 MB each, newest first: a per-MB rate, not the whole history.
    const sample: typeof files = []
    let total = 0
    for (const file of files.sort((a, b) => b.path.localeCompare(a.path))) {
      if (file.size > 20_000_000 || total + file.size > 120_000_000) continue
      sample.push(file); total += file.size
    }
    sampleMB = total / 1e6; rollouts = sample.length
    list = join(root, 'threads.json')
    await writeFile(list, JSON.stringify(sample.map(file => file.threadId)))
    for (const label of ['before', 'after']) {
      const outfile = join(root, `${label}.mjs`)
      await build({ entryPoints: ['tests/fixtures/codexRolloutBench.ts'], bundle: true, platform: 'node', format: 'esm', outfile, plugins: label === 'before' ? [sourceAt(BASE)] : [] })
      bundles[label] = outfile
    }
  }, 300_000)
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

  it('reads the same messages in less time', async () => {
    const rows: Record<string, { cpuMs: number; wallMs: number; messages: number; digest: string }[]> = { before: [], after: [] }
    for (let run = 0; run < 3; run++) {
      for (const label of run % 2 ? ['after', 'before'] : ['before', 'after']) {
        const { stdout } = await exec(process.execPath, [bundles[label]!, codexHome!, list], { maxBuffer: 1024 * 1024 })
        rows[label]!.push(JSON.parse(stdout.trim().split('\n').at(-1)!))
      }
    }
    for (const label of ['before', 'after']) {
      const samples = rows[label]!
      const cpuMs = median(samples.map(row => row.cpuMs))
      console.log(JSON.stringify({ benchmark: 'codex-rollout-read', baseline: BASE, label, rollouts, sampleMB: round(sampleMB), runs: samples.length,
        cpuMs: round(cpuMs), wallMs: round(median(samples.map(row => row.wallMs))), cpuMsPerMB: round(cpuMs / sampleMB, 2), messages: samples[0]!.messages }))
    }
    // The same messages, word for word, both ways.
    expect(new Set([...rows.before!, ...rows.after!].map(row => row.digest)).size).toBe(1)
  }, 1_800_000)
})
