// @vitest-environment node
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { HistoryRepository } from '../../../src/main/storage/historyRepository'
import type { HistoryEntry } from '../../../src/shared/history'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-dictation-records-'))
  roots.push(root)
  return root
}

function entry(id: string, createdAt: number, text = 'one two three', app?: string): HistoryEntry {
  return { id, text, createdAt, durationMs: createdAt * 10, language: 'en', modelPreset: 'parakeet', ...(app === undefined ? {} : { app }) }
}

const ON = { enabled: true, retention: 'unlimited' } as const
const OFF = { enabled: false, retention: 'unlimited' } as const

async function recordsFile(root: string): Promise<string> {
  return readFile(join(root, 'dictation-records.jsonl'), 'utf8')
}

describe('dictation records', () => {
  it('keeps a record with history on and off, and text only while it is on', async () => {
    const root = await folder()
    const history = new HistoryRepository(join(root, 'history.json'))
    await history.initialize()

    await history.add(entry('on', 2, 'kept words here', 'Microsoft Outlook'), ON)
    await expect(history.add(entry('off', 3, 'private spoken words', 'Windows Terminal'), OFF)).resolves.toEqual([entry('on', 2, 'kept words here', 'Microsoft Outlook')])
    await history.add(entry('no-app', 1, 'two words'), OFF)

    expect(await history.list()).toEqual([entry('on', 2, 'kept words here', 'Microsoft Outlook')])
    expect(await history.listRecords()).toEqual([
      { id: 'off', createdAt: 3, durationMs: 30, words: 3, app: 'Windows Terminal' },
      { id: 'on', createdAt: 2, durationMs: 20, words: 3, app: 'Microsoft Outlook' },
      { id: 'no-app', createdAt: 1, durationMs: 10, words: 2 },
    ])
    const onDisk = await recordsFile(root)
    expect(onDisk).not.toContain('private')
    expect(onDisk).not.toContain('spoken')
    expect(JSON.parse(await readFile(join(root, 'history.json'), 'utf8'))).toEqual([entry('on', 2, 'kept words here', 'Microsoft Outlook')])
  })

  it('trims transcripts to the retention and keeps every record', async () => {
    const root = await folder()
    const history = new HistoryRepository(join(root, 'history.json'))
    for (const [index, id] of ['a', 'b', 'c'].entries()) await history.add(entry(id, index + 1), { enabled: true, retention: 1 })

    expect((await history.list()).map(saved => saved.id)).toEqual(['c'])
    expect((await history.listRecords()).map(record => record.id)).toEqual(['c', 'b', 'a'])
    expect((await new HistoryRepository(join(root, 'history.json')).listRecords()).map(record => record.id)).toEqual(['c', 'b', 'a'])
  })

  it('deletes a transcript with its record, and a record whose transcript retention already trimmed', async () => {
    const root = await folder()
    const history = new HistoryRepository(join(root, 'history.json'))
    await history.add(entry('trimmed', 1), { enabled: true, retention: 1 })
    await history.add(entry('kept', 2), { enabled: true, retention: 1 })
    await history.add(entry('other', 3), OFF)

    await expect(history.delete('kept')).resolves.toBe(true)
    await expect(history.delete('trimmed')).resolves.toBe(true)
    await expect(history.delete('missing')).resolves.toBe(false)

    expect(await history.list()).toEqual([])
    expect((await history.listRecords()).map(record => record.id)).toEqual(['other'])
    const reopened = new HistoryRepository(join(root, 'history.json'))
    expect((await reopened.listRecords()).map(record => record.id)).toEqual(['other'])
  })

  it('clears every transcript and every record, and does not fill the records again after a restart', async () => {
    const root = await folder()
    const history = new HistoryRepository(join(root, 'history.json'))
    await history.add(entry('one', 1), ON)
    await history.add(entry('two', 2), OFF)
    await writeFile(join(root, 'dictation-records.jsonl.tmp-1-12345678-1234-1234-1234-123456789abc'), 'abandoned')
    await writeFile(join(root, 'dictation-records.jsonl.corrupt-1'), 'backup')

    await history.clear()

    expect(await history.list()).toEqual([])
    expect(await history.listRecords()).toEqual([])
    expect((await readdir(root)).sort()).toEqual(['history.json'])
    const restarted = new HistoryRepository(join(root, 'history.json'))
    await restarted.initialize()
    expect(await restarted.listRecords()).toEqual([])
  })

  it('lists and deletes transcripts kept from before history was turned off, after a restart with it off', async () => {
    const root = await folder()
    const before = new HistoryRepository(join(root, 'history.json'))
    await before.add(entry('older', 1), ON)
    await before.add(entry('newer', 2), ON)

    const restarted = new HistoryRepository(join(root, 'history.json'))
    await restarted.initialize()
    await restarted.add(entry('while-off', 3), OFF)

    expect((await restarted.list()).map(saved => saved.id)).toEqual(['newer', 'older'])
    await expect(restarted.search('one')).resolves.toHaveLength(2)
    await expect(restarted.delete('older')).resolves.toBe(true)
    expect((await restarted.list()).map(saved => saved.id)).toEqual(['newer'])
    expect((await restarted.listRecords()).map(record => record.id)).toEqual(['while-off', 'newer'])
  })

  it('fills the records from saved transcripts once, on the first start without them', async () => {
    const root = await folder()
    const transcripts = [entry('new', 2, 'Hello, world. It works!', 'Outlook'), entry('old', 1, 'Ünïcödé wörds')]
    await writeFile(join(root, 'history.json'), JSON.stringify(transcripts))
    const log = vi.fn()

    const first = new HistoryRepository(join(root, 'history.json'), { log })
    await first.initialize()
    expect(await first.listRecords()).toEqual([
      { id: 'new', createdAt: 2, durationMs: 20, words: 4, app: 'Outlook' },
      { id: 'old', createdAt: 1, durationMs: 10, words: 2 },
    ])
    const filled = await recordsFile(root)
    expect(filled).not.toContain('Hello')

    // A transcript that reaches history.json without a record later is not filled in again.
    await writeFile(join(root, 'history.json'), JSON.stringify([entry('unrecorded', 3), ...transcripts]))
    const second = new HistoryRepository(join(root, 'history.json'), { log })
    await second.initialize()
    expect((await second.listRecords()).map(record => record.id)).toEqual(['new', 'old'])
    expect(await recordsFile(root)).toBe(filled)
    expect(log).not.toHaveBeenCalled()
  })

  it('fills the records from saved transcripts on a later save when the first start could not write them', async () => {
    const root = await folder()
    await writeFile(join(root, 'history.json'), JSON.stringify([entry('older', 1)]))
    const log = vi.fn()
    // A folder standing where the records file goes makes the first start fail to read or write it.
    await mkdir(join(root, 'dictation-records.jsonl'))
    const history = new HistoryRepository(join(root, 'history.json'), { log })
    await history.initialize()
    expect(log.mock.calls).toEqual([['dictation-records-backfill-failed']])
    await rm(join(root, 'dictation-records.jsonl'), { recursive: true })

    await history.add(entry('newer', 2), OFF)

    expect((await history.listRecords()).map(record => record.id)).toEqual(['newer', 'older'])
    expect((await new HistoryRepository(join(root, 'history.json')).listRecords()).map(record => record.id)).toEqual(['newer', 'older'])
  })

  it('deletes the record before the transcript, so a failed delete leaves the transcript to delete again', async () => {
    const root = await folder()
    const history = new HistoryRepository(join(root, 'history.json'))
    await history.add(entry('one', 1), ON)
    const writes = vi.spyOn((history as unknown as { store: { write: (value: unknown) => Promise<void> } }).store, 'write')
      .mockRejectedValueOnce(new Error('disk full'))

    await expect(history.delete('one')).rejects.toThrow('disk full')
    expect(await history.listRecords()).toEqual([])
    expect((await history.list()).map(saved => saved.id)).toEqual(['one'])

    await expect(history.delete('one')).resolves.toBe(true)
    expect(await history.list()).toEqual([])
    expect(writes).toHaveBeenCalledTimes(2)
  })

  it('only reads a corrupt history file while history is off, and fills no records from it', async () => {
    const root = await folder()
    const corrupt = '[{"text":"private words"'
    await writeFile(join(root, 'history.json'), corrupt)
    const onRecovery = vi.fn()
    const history = new HistoryRepository(join(root, 'history.json'), { onRecovery })
    await history.initialize()

    await expect(history.list({ enabled: false })).resolves.toEqual([])
    await expect(history.search('private', { enabled: false })).resolves.toEqual([])
    await history.add(entry('off', 1), OFF)

    expect(onRecovery).not.toHaveBeenCalled()
    expect(await readFile(join(root, 'history.json'), 'utf8')).toBe(corrupt)
    expect((await history.listRecords()).map(record => record.id)).toEqual(['off'])
    await expect(history.getRecord('off')).resolves.toEqual({ id: 'off', createdAt: 1, durationMs: 10, words: 3 })
    await expect(history.getRecord('missing')).resolves.toBeNull()
  })

  it('writes no records file on a first start without transcripts', async () => {
    const root = await folder()
    const history = new HistoryRepository(join(root, 'history.json'))
    await history.initialize()
    expect(await readdir(root)).toEqual([])
    expect(await history.listRecords()).toEqual([])
  })

  it('appends one line per dictation instead of rewriting the records', async () => {
    const root = await folder()
    const history = new HistoryRepository(join(root, 'history.json'))
    await history.add(entry('one', 1), OFF)
    const firstLine = await recordsFile(root)
    const inode = (await stat(join(root, 'dictation-records.jsonl'))).ino

    await history.add(entry('two', 2), OFF)

    const lines = await recordsFile(root)
    expect(lines.startsWith(firstLine)).toBe(true)
    expect(lines.trim().split('\n')).toHaveLength(2)
    expect((await stat(join(root, 'dictation-records.jsonl'))).ino).toBe(inode)
  })

  it('skips a line cut short by a crash, logging only a stable event', async () => {
    const root = await folder()
    const history = new HistoryRepository(join(root, 'history.json'))
    await history.add(entry('whole', 1), OFF)
    await appendFile(join(root, 'dictation-records.jsonl'), '{"id":"cut","createdAt":2,"text":"private')
    const log = vi.fn()

    const restarted = new HistoryRepository(join(root, 'history.json'), { log })
    await restarted.initialize()

    expect((await restarted.listRecords()).map(record => record.id)).toEqual(['whole'])
    expect(log.mock.calls).toEqual([['dictation-records-lines-skipped']])
    await restarted.add(entry('next', 3), OFF)
    expect((await new HistoryRepository(join(root, 'history.json')).listRecords()).map(record => record.id)).toEqual(['next', 'whole'])
  })

  it('saves the transcript when its record cannot be saved, logging only a stable event', async () => {
    const root = await folder()
    const log = vi.fn()
    // A folder where the records file should be cannot be appended to.
    const history = new HistoryRepository(join(root, 'history.json'), { log, recordsPath: root })

    await expect(history.add(entry('saved', 1, 'private words'), ON)).resolves.toEqual([entry('saved', 1, 'private words')])

    expect(log.mock.calls).toEqual([['dictation-record-not-saved']])
  })

  it('refuses a transcript whose app is not a delivered app name', async () => {
    const root = await folder()
    const history = new HistoryRepository(join(root, 'history.json'))
    await expect(history.add(entry('long', 1, 'words', 'x'.repeat(65)), ON)).rejects.toThrow()
    await expect(history.add(entry('empty', 1, 'words', ''), ON)).rejects.toThrow()
    expect(await history.listRecords()).toEqual([])
  })
})
