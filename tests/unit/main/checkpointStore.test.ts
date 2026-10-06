// @vitest-environment node
import * as fsPromises from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CheckpointStore, type CheckpointRecord } from '../../../src/main/tools/checkpointStore'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual }
})

/** Taken before any test replaces it. */
const realUnlink = fsPromises.unlink
const realOpen = fsPromises.open
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
    expect(JSON.parse(file)).toMatchObject({ version: 2, generation: expect.any(String) })
    await f.store.append([second], [first, second])
    expect(await readFile(f.store.path, 'utf8')).toBe(file)
    const loaded = await f.open().load()
    expect(ids(loaded.records)).toEqual(ids([first, second]))
    expect(loaded.setAside).toBeUndefined()
    expect(await readdir(f.directory)).not.toContain('checkpoints.journal')
  })

  it('reads a version 1 file, which has no journal', async () => {
    const f = await fixture()
    const kept = record()
    await writeFile(f.store.path, `${JSON.stringify({ version: 1, records: [kept] }, null, 2)}\n`)
    const loaded = await f.store.load()
    expect(ids(loaded.records)).toEqual([kept.id])
    expect(loaded.setAside).toBeUndefined()
    expect(f.store.mustRewrite()).toBe(true)
  })

  it('cuts off an append that failed part-way, so the next one lands on a whole line', async () => {
    const f = await fixture()
    const first = record(), second = record(), third = record()
    await f.store.write([first])
    await f.store.append([second], [first, second])
    // What a write that failed part-way leaves behind: part of a line, no newline.
    await appendFile(f.store.journal, '{"generation":"')
    await f.store.append([third], [first, second, third])
    const loaded = await f.open().load()
    expect(ids(loaded.records)).toEqual(ids([first, second, third]))
    expect(loaded.setAside).toBeUndefined()
    expect(f.report).not.toHaveBeenCalled()
  })

  it('cuts off a journal that could not be removed before appending to it', async () => {
    const f = await fixture()
    const old = record(), kept = record()
    await f.store.write([old])
    await f.store.append([kept], [old, kept])
    vi.spyOn(fsPromises, 'unlink').mockImplementation(async path => {
      if (path === f.store.journal) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      await realUnlink(path)
    })
    await f.store.write([kept])
    expect(f.report).toHaveBeenCalledWith('checkpoint-cleanup-failed')
    vi.mocked(fsPromises.unlink).mockRestore()
    const next = record()
    await f.store.append([next], [kept, next])
    expect((await readFile(f.store.journal, 'utf8')).trim().split('\n')).toHaveLength(1)
    expect(ids((await f.open().load()).records)).toEqual(ids([kept, next]))
  })

  it('rewrites the file when the journal cannot be appended to, so the record is still saved', async () => {
    const f = await fixture()
    const first = record(), second = record()
    await f.store.write([first])
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      if (args[0] === f.store.journal) throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
      return realOpen(...args)
    })
    await f.store.append([second], [first, second])
    vi.mocked(fsPromises.open).mockRestore()
    expect(ids((JSON.parse(await readFile(f.store.path, 'utf8')) as { records: CheckpointRecord[] }).records)).toEqual(ids([first, second]))
  })

  it('rewrites the file when the journal lost lines it was given', async () => {
    const f = await fixture()
    const first = record(), second = record(), third = record()
    await f.store.write([first])
    await f.store.append([second], [first, second])
    await rm(f.store.journal)
    await f.store.append([third], [first, second, third])
    expect(ids((JSON.parse(await readFile(f.store.path, 'utf8')) as { records: CheckpointRecord[] }).records)).toEqual(ids([first, second, third]))
  })

  it('puts back a checkpoint folder removed while Sotto runs', async () => {
    const f = await fixture()
    const first = record(), second = record()
    await f.store.write([first])
    await rm(f.directory, { recursive: true, force: true })
    await f.store.append([second], [first, second])
    expect(ids((await f.open().load()).records)).toEqual(ids([first, second]))
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
