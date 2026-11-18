// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SLOW_READS_FILE, SLOW_READS_PER_RUN, slowStoreReads } from '../../../src/main/agents/slowStoreReads'
import { SLOW_READ_MS, ThreadStore } from '../../../src/main/agents/threadStore'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const done of cleanup.splice(0).reverse()) await done() })

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-slow-reads-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  return root
}

describe('main’s slow reads of the thread store', () => {
  it('names a read that held main for the threshold or longer by its SQL, and stays quiet for a quick one', async () => {
    const store = new ThreadStore(join(await directory(), 'threads.sqlite'), undefined, null)
    const heard: [string, number][] = []
    store.onSlowRead((statement, ms) => heard.push([statement, ms]))
    store.open()
    cleanup.push(async () => { store.close() })
    store.replaceThreadMessages('thread', [{ id: 'u1', role: 'user', text: 'Private words', createdAt: '2026-11-17T22:11:10.000Z' }], 'epoch')
    store.readMessages('thread', { turns: 10 })
    expect(heard).toEqual([])
    // The clock jumps across every read from here, as a store that stopped answering would hold main.
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (now += SLOW_READ_MS))
    try { store.readMessages('thread', { turns: 10 }) } finally { clock.mockRestore() }
    expect(heard.length).toBeGreaterThan(0)
    expect(heard.map(([statement]) => statement)).toContain('SELECT * FROM messages WHERE thread_id = ? AND position BETWEEN ? AND ? ORDER BY position')
    expect(heard.every(([statement, ms]) => !statement.includes('Private words') && !statement.includes('\n') && ms >= SLOW_READ_MS)).toBe(true)
  })

  it('appends one line per slow read in the order heard, and stops at the run’s limit', async () => {
    const root = await directory()
    const lines: string[] = []
    const report = slowStoreReads(root, async (path, line) => { expect(path).toBe(join(root, SLOW_READS_FILE)); lines.push(line) }, () => new Date('2026-11-17T22:11:12.000Z'))
    for (let read = 0; read < SLOW_READS_PER_RUN + 5; read++) report(`SELECT ${read}`, 1_834.4)
    await vi.waitFor(() => { expect(lines).toHaveLength(SLOW_READS_PER_RUN) })
    expect(JSON.parse(lines[0]!)).toEqual({ at: '2026-11-17T22:11:12.000Z', statement: 'SELECT 0', ms: 1_834 })
    expect(JSON.parse(lines.at(-1)!).statement).toBe(`SELECT ${SLOW_READS_PER_RUN - 1}`)
  })

  it('writes the file in the folder it is given', async () => {
    const root = await directory()
    slowStoreReads(root)('SELECT 1', 300)
    await vi.waitFor(async () => { expect(await readFile(join(root, SLOW_READS_FILE), 'utf8')).toContain('"statement":"SELECT 1","ms":300') })
  })
})
