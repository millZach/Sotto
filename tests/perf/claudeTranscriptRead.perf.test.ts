// @vitest-environment node
/**
 * What reading one long line of a Claude transcript costs main (#992). The reader joined every 64 KiB read into one
 * string and searched it all for a line's end again after each read, so a line cost the square of its length: 10 ms for
 * the 1.4 MB longest line in forge's real transcripts, 905 ms for 14 MB. It now looks for a line's end in each read's own
 * bytes and decodes the line once. It times a fresh reader over one line of each size, the median of three, and prints
 * them; it runs only under `SOTTO_PERF_BENCH=1`. With `SOTTO_PERF_ASSERT=1` too, it fails when the longest line costs more
 * than thirty times the shortest, ten times its length: a reader in the square of the length costs about a hundred.
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/claudeTranscriptRead.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { ClaudeSessionLog } from '../../src/main/agents/claudeSessionLog'
import { median, PERF_BENCH } from '../fixtures/perfBench'

const roots: string[] = []
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })
const CWD = '/srv/synthetic-project'

it.skipIf(!PERF_BENCH)('times reading one long transcript line, in proportion to its length', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sotto-claude-line-')); roots.push(home)
  const folder = join(home, 'projects', CWD.replace(/[^a-zA-Z0-9]/gu, '-'))
  await mkdir(folder, { recursive: true })
  const report: Record<string, number> = {}
  for (const bytes of [1_400_000, 4_000_000, 13_950_000]) {
    const sessionId = `10000000-0000-4000-8000-${bytes.toString(16).padStart(12, '0')}`
    await writeFile(join(folder, `${sessionId}.jsonl`), `${JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: 'x'.repeat(bytes) } })}\n`)
    const samples: number[] = []
    for (let run = 0; run < 3; run++) {
      let entries = 0
      const reader = new ClaudeSessionLog(home, CWD, sessionId, () => { entries++ })
      const started = performance.now()
      await reader.poll()
      samples.push(performance.now() - started)
      expect(entries).toBe(1)
    }
    report[`${bytes} B`] = Math.round(median(samples) * 10) / 10
  }
  console.log(`Claude transcript line read (ms): ${JSON.stringify(report)}`)
  if (process.env.SOTTO_PERF_ASSERT === '1') expect(report['13950000 B']! / report['1400000 B']!).toBeLessThan(30)
}, 300_000)
