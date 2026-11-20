// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { THREAD_SWITCHES_FILE, THREAD_SWITCHES_PER_RUN, threadSwitchTimings } from '../../../src/main/performance/threadSwitchTimings'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const done of cleanup.splice(0).reverse()) await done() })

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-thread-switches-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  return root
}

const timing = { inputMs: 4, replyMs: 120, historyMs: 300, frameMs: 610, paintedMs: 640, held: false, remote: false, messages: 80, activities: 2_000, threads: 1_065, commits: 3, shareMs: 260, newThreadRecords: 6, newFields: ['deliveries', 'host.projects'] }

describe('the window’s thread switches noted on this computer', () => {
  it('appends one line per switch in the order heard, and stops at the run’s limit', async () => {
    const root = await directory()
    const lines: string[] = []
    const note = threadSwitchTimings(root, async (path, line) => { expect(path).toBe(join(root, THREAD_SWITCHES_FILE)); lines.push(line) }, () => new Date('2026-11-20T18:29:14.000Z'))
    for (let at = 0; at < THREAD_SWITCHES_PER_RUN + 5; at++) note({ ...timing, paintedMs: at })
    await vi.waitFor(() => { expect(lines).toHaveLength(THREAD_SWITCHES_PER_RUN) })
    expect(JSON.parse(lines[0]!)).toEqual({ at: '2026-11-20T18:29:14.000Z', ...timing, paintedMs: 0 })
    expect(JSON.parse(lines.at(-1)!).paintedMs).toBe(THREAD_SWITCHES_PER_RUN - 1)
  })

  it('writes the file in the folder it is given, and a failed write loses only that line', async () => {
    const root = await directory()
    threadSwitchTimings(root)(timing)
    await vi.waitFor(async () => { expect(await readFile(join(root, THREAD_SWITCHES_FILE), 'utf8')).toContain('"paintedMs":640') })
    const lines: string[] = []
    let first = true
    const note = threadSwitchTimings(root, async (_path, line) => { if (first) { first = false; throw new Error('disk full') } lines.push(line) })
    note(timing)
    note({ ...timing, paintedMs: 900 })
    await vi.waitFor(() => { expect(lines).toHaveLength(1) })
    expect(JSON.parse(lines[0]!).paintedMs).toBe(900)
  })
})
