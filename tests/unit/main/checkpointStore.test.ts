// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CheckpointStore, type CheckpointRecord } from '../../../src/main/tools/checkpointStore'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-checkpoint-store-')); roots.push(directory)
  const report = vi.fn()
  const open = () => new CheckpointStore(directory, report)
  return { directory, report, open, store: open() }
}
const record = (threadId = 'thread-a'): CheckpointRecord => ({ id: randomUUID(), threadId, workspaceId: 'workspace', cwd: '/work', providerId: 'codex', bindingId: 'codex:a',
  createdAt: new Date().toISOString(), beforeUsers: [], before: { files: {}, index: '', head: '' }, status: 'unavailable', reason: 'This working copy exceeds the checkpoint size limit (64 MiB total, 8 MiB per file).' })
const ids = (records: readonly CheckpointRecord[]) => records.map(item => item.id)

describe('checkpoint storage and its journal', () => {
  it('appends a send\'s record to the journal without rewriting the file, and reads it back folded in', async () => {
    const f = await fixture()
    const first = record(), second = record()
    await f.store.write([first])
    const file = await readFile(f.store.path, 'utf8')
    expect(JSON.parse(file)).toMatchObject({ version: 1, generation: expect.any(String) })
    await f.store.append([second], [first, second])
    expect(await readFile(f.store.path, 'utf8')).toBe(file)
    const loaded = await f.open().load()
    expect(ids(loaded.records)).toEqual(ids([first, second]))
    expect(loaded.setAside).toBeUndefined()
    expect(await readdir(f.directory)).not.toContain('checkpoints.journal')
  })

  it('asks for a rewrite once the journal outgrows the file', async () => {
    const f = await fixture()
    const all = [record()]
    await f.store.write(all, f.store.measure(all))
    expect(f.store.mustRewrite()).toBe(false)
    while (!f.store.mustRewrite()) { const next = record(); all.push(next); await f.store.append([next], all) }
    expect(f.store.journalBytes).toBeGreaterThan(64 * 1024)
    expect(ids((await f.open().load()).records)).toEqual(ids(all))
  })

  it('measures the file it writes', async () => {
    const f = await fixture()
    const records = [record(), record('thread-b')]
    await f.store.write(records)
    expect(f.store.measure(records)).toBe(Buffer.byteLength(await readFile(f.store.path)))
    await f.store.write([])
    expect(f.store.measure([])).toBe(Buffer.byteLength(await readFile(f.store.path)))
  })
})
