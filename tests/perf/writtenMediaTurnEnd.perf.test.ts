// @vitest-environment node
/**
 * What finding a turn's written pictures and videos costs (ADR-0170, part 4). It happens once, when a turn ends, off the
 * update path: two Git listings of the folder's picture and video files and a look at each one listed. Nothing runs
 * while the turn works, so a streamed update and a send do the work they did before (`streamingCopyBudget`,
 * `ownerScaleWorkBudget` and the send benchmarks hold those).
 *
 * The folder is a working copy with 300 committed pictures, a `node_modules` of 3,000 files (300 of them pictures),
 * and 40 screenshots in an ignored `test-results/`. Counted, always: a turn that wrote nothing keeps nothing; one that
 * wrote three files keeps those three; committed pictures and `node_modules` are never looked at. Timed and printed:
 * the listing and the look, median of 5; asserted only under SOTTO_PERF_ASSERT=1.
 *
 *   npx vitest run tests/perf/writtenMediaTurnEnd.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { listMediaFiles, writtenMedia, writtenSince } from '../../src/main/agents/writtenMedia'
import type { MediaFileCapture } from '../../src/main/agents/threadMedia'
import type { WrittenMediaStore } from '../../src/main/agents/writtenMedia'
import { upperMedian as median } from './support/statistics.mjs'
import { round } from '../fixtures/perfBench'
import { pngHeader } from '../fixtures/stagedImages'

const RUNS = 5
let root: string | undefined
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

async function workingCopy(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'sotto-written-perf-'))
  execFileSync('git', ['init', '-q'], { cwd: folder })
  await writeFile(join(folder, '.gitignore'), 'node_modules/\ntest-results/\n')
  await mkdir(join(folder, 'docs'), { recursive: true })
  for (let index = 0; index < 300; index++) await writeFile(join(folder, 'docs', `figure-${index}.png`), pngHeader(64, 64, index % 256))
  execFileSync('git', ['add', '.'], { cwd: folder })
  execFileSync('git', ['-c', 'user.name=Perf', '-c', 'user.email=perf@example.com', 'commit', '-qm', 'base'], { cwd: folder })
  for (let pkg = 0; pkg < 30; pkg++) {
    await mkdir(join(folder, 'node_modules', `pkg-${pkg}`), { recursive: true })
    for (let index = 0; index < 100; index++) await writeFile(join(folder, 'node_modules', `pkg-${pkg}`, index % 10 === 0 ? `icon-${index}.png` : `file-${index}.js`), 'x')
  }
  await mkdir(join(folder, 'test-results'), { recursive: true })
  const old = new Date(Date.now() - 3_600_000)
  for (let index = 0; index < 40; index++) {
    const path = join(folder, 'test-results', `old-${index}.png`)
    await writeFile(path, pngHeader(32, 32, index)); await utimes(path, old, old)
  }
  return folder
}

describe('finding what a turn wrote', () => {
  it('lists only what a turn could have written, keeps only what it did, and costs one listing at its end', async () => {
    root = await workingCopy()
    let captures = 0
    const captureFile: MediaFileCapture = async () => { captures += 1; return [{ id: 'm0', digest: 'a'.repeat(64), kind: 'image', mimeType: 'image/png', sizeBytes: 40, name: 'shot.png', source: 'file' }] }
    const capture: WrittenMediaStore = { captureFile, keepVideo: () => undefined }

    // A turn that wrote nothing: the 40 old screenshots are listed, none is new, nothing is kept.
    const since = Date.now() - 1_000
    expect(await writtenMedia(root, since, capture)).toBeUndefined()
    expect(captures).toBe(0)
    const listed = (await listMediaFiles(root))!
    expect(listed).toHaveLength(40)
    expect(listed.some(path => path.startsWith('node_modules/') || path.startsWith('docs/'))).toBe(false)

    // A turn that wrote two screenshots and changed a committed figure.
    await writeFile(join(root, 'test-results', 'new-1.png'), pngHeader(8, 8))
    await writeFile(join(root, 'test-results', 'new-2.png'), pngHeader(8, 8, 1))
    await writeFile(join(root, 'docs', 'figure-0.png'), pngHeader(8, 8, 2))
    const found = (await writtenMedia(root, since, capture))!
    expect(found.changes.map(change => change.path).sort()).toEqual(['docs/figure-0.png', 'test-results/new-1.png', 'test-results/new-2.png'])
    expect(captures).toBe(3)

    const listing: number[] = [], look: number[] = []
    for (let run = 0; run < RUNS; run++) {
      const started = performance.now()
      const paths = (await listMediaFiles(root))!
      const listedAt = performance.now()
      await writtenSince(root, paths, since)
      listing.push(listedAt - started); look.push(performance.now() - listedAt)
    }
    const result = { listedFiles: (await listMediaFiles(root))!.length, listingMs: round(median(listing), 1), lookMs: round(median(look), 1) }
    console.info(`written media at a turn's end: ${JSON.stringify(result)}`)
    if (process.env.SOTTO_PERF_ASSERT === '1') expect(result.listingMs + result.lookMs).toBeLessThan(500)
  }, 120_000)
})
