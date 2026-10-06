// @vitest-environment node
import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

/**
 * What a send pays for its file checkpoint (#764), before and after. "Before" is `src/` as of `BASE`, the commit
 * this work started from; "after" is the working tree. Each run is a fresh process that sends `SENDS` turns into
 * one working copy and times the checkpoint taken before each send and the one taken when its turn completes.
 * The copies: a synthetic one under the limits, a synthetic one over them (once more with a saved checkpoint file
 * the size of the development machine's, and once with a commit each turn, which turns a held verdict around), a folder Git does not know, and this repository's own checkout
 * (`SOTTO_PERF_CHECKPOINT_REPO` names another). `SOTTO_PERF_CHECKPOINT_ONLY` runs the copies whose names contain it.
 */
const BASE = process.env.SOTTO_PERF_CHECKPOINT_BASE ?? 'e8a82a034c42cc3eb9b8fb3c711726353192ade9'
const SENDS = 6
const RUNS = 3
const exec = promisify(execFile)
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
interface Row { beforeMs: number; afterMs: number; beforeReads: number; beforeReadBytes: number; beforeListings: number; afterReads: number; rewrote: boolean }

describe.skipIf(!PERF_BENCH)('the checkpoint step of a send', () => {
  let root: string
  const bundles: Record<string, string> = {}
  const copies: Record<string, { path: string; mode: 'unchanged' | 'edit' | 'commit'; seeded?: boolean }> = {}
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sotto-checkpoint-send-'))
    for (const label of ['before', 'after']) {
      const outfile = join(root, `${label}.mjs`)
      await build({ entryPoints: ['tests/fixtures/checkpointSendBench.ts'], bundle: true, platform: 'node', format: 'esm', outfile,
        plugins: label === 'before' ? [{ name: 'fixed-baseline', setup(builder) {
          builder.onLoad({ filter: /\.[cm]?tsx?$/ }, args => {
            const path = relative(resolve('.'), args.path).replaceAll('\\', '/')
            if (!path.startsWith('src/')) return undefined
            return { contents: execFileSync('git', ['show', `${BASE}:${path}`], { encoding: 'utf8' }), loader: 'ts' }
          })
        } }] : [],
      })
      bundles[label] = outfile
    }
    const synthetic = async (name: string, count: number, bytes: number, repository = true): Promise<string> => {
      const folder = join(root, name); await mkdir(folder)
      for (let index = 0; index < count; index++) {
        const directory = join(folder, `area-${index % 40}`, `part-${index % 7}`)
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, `file-${index}.txt`), `${index} `.padEnd(bytes, 'x'))
      }
      await writeFile(join(folder, 'bench-edit.txt'), 'first\n')
      if (repository) {
        git(folder, 'init', '-q'); git(folder, 'config', 'core.autocrlf', 'false')
        git(folder, 'add', '.'); git(folder, '-c', 'user.name=Bench', '-c', 'user.email=bench@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Bench')
      }
      return folder
    }
    copies['under the limits, unchanged'] = { path: await synthetic('under', 2_000, 4 * 1024), mode: 'unchanged' }
    copies['under the limits, one file edited a turn'] = { path: copies['under the limits, unchanged']!.path, mode: 'edit' }
    copies['over the limits'] = { path: await synthetic('over', 3_000, 32 * 1024), mode: 'unchanged' }
    copies['over the limits, 1.5 MB of saved checkpoints'] = { path: copies['over the limits']!.path, mode: 'unchanged', seeded: true }
    // Its own copy, since each turn commits to it.
    copies['over the limits, a commit each turn'] = { path: await synthetic('over-committed', 3_000, 32 * 1024), mode: 'commit' }
    copies['not a Git repository'] = { path: await synthetic('plain', 200, 1024, false), mode: 'unchanged' }
    copies['this repository'] = { path: resolve(process.env.SOTTO_PERF_CHECKPOINT_REPO ?? '.'), mode: 'unchanged' }
    // A file written in the last few seconds is read again whatever its lstat says, so the copies settle first.
    await delay(3_500)
  }, 600_000)
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

  it('times each send\'s checkpoint, first send and later ones', async () => {
    const table: string[] = []
    for (const [name, copy] of Object.entries(copies).filter(([name]) => name.includes(process.env.SOTTO_PERF_CHECKPOINT_ONLY ?? ''))) {
      const runs: Record<string, Row[][]> = { before: [], after: [] }
      for (let run = 0; run < RUNS; run++) {
        for (const label of run % 2 ? ['after', 'before'] : ['before', 'after']) {
          const { stdout } = await exec(process.execPath, [bundles[label]!, copy.path, String(SENDS), copy.mode, copy.seeded ? 'seeded' : ''], { maxBuffer: 16 * 1024 * 1024 })
          runs[label]!.push((JSON.parse(stdout.trim()) as { rows: Row[] }).rows)
        }
      }
      for (const label of ['before', 'after']) {
        const all = runs[label]!
        const first = all.map(rows => rows[0]!), later = all.flatMap(rows => rows.slice(1))
        const summary = {
          copy: name, label,
          firstSendMs: round(median(first.map(row => row.beforeMs))),
          laterSendMs: round(median(later.map(row => row.beforeMs))),
          laterSendMsRange: [round(Math.min(...later.map(row => row.beforeMs))), round(Math.max(...later.map(row => row.beforeMs)))],
          firstSendReads: median(first.map(row => row.beforeReads)),
          laterSendReads: median(later.map(row => row.beforeReads)),
          laterSendReadMiB: round(median(later.map(row => row.beforeReadBytes)) / 1024 / 1024, 2),
          turnEndMs: round(median(later.map(row => row.afterMs))),
          laterSendListings: later.reduce((sum, row) => sum + row.beforeListings, 0),
          laterSends: later.length,
          turnEndReads: median(later.map(row => row.afterReads)),
          fileRewritesPerSend: round(later.filter(row => row.rewrote).length / later.length, 2),
        }
        table.push(JSON.stringify(summary))
        expect(summary.laterSendMs).toBeGreaterThan(0)
      }
    }
    console.log(table.join('\n'))
  }, 1_800_000)
})
