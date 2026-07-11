import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ZodError } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'

import { HistoryRepository } from '../../../src/main/storage/historyRepository'
import type { HistoryEntry } from '../../../src/shared/history'

const roots: string[] = []

function createEntry(id: string, createdAt: number, text = `Transcript ${id}`): HistoryEntry {
  return {
    id,
    text,
    createdAt,
    durationMs: 500,
    language: 'en',
    modelPreset: 'balanced',
  }
}

async function createRepository(
  now: () => number = Date.now,
): Promise<{ filePath: string; repository: HistoryRepository }> {
  const root = await mkdtemp(join(tmpdir(), 'talktype-history-repository-'))
  roots.push(root)
  const filePath = join(root, 'history.json')
  return { filePath, repository: new HistoryRepository(filePath, { now }) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('HistoryRepository', () => {
  it('keeps only the newest entry when retention is one', async () => {
    const { repository } = await createRepository()
    await repository.add(createEntry('1', 1, 'one'), { enabled: true, retention: 1 })
    await repository.add(createEntry('2', 2, 'two'), { enabled: true, retention: 1 })

    expect((await repository.list()).map((entry) => entry.id)).toEqual(['2'])
  })

  it('does not create a history file when history is disabled', async () => {
    const { repository } = await createRepository()

    const entries = await repository.add(createEntry('1', 1), {
      enabled: false,
      retention: 100,
    })

    expect(entries).toEqual([])
    expect(await repository.exists()).toBe(false)
  })

  it('returns existing history without rewriting it when history is disabled', async () => {
    const { filePath, repository } = await createRepository()
    await repository.add(createEntry('1', 1), { enabled: true, retention: 'unlimited' })
    const beforeBytes = await readFile(filePath)
    const beforeStat = await stat(filePath)

    const entries = await repository.add(createEntry('2', 2), {
      enabled: false,
      retention: 'unlimited',
    })

    expect(entries.map((entry) => entry.id)).toEqual(['1'])
    expect(await readFile(filePath)).toEqual(beforeBytes)
    expect((await stat(filePath)).ino).toBe(beforeStat.ino)
  })

  it('lists persisted entries newest first with an ascending id tie-break', async () => {
    const { filePath, repository } = await createRepository()
    await writeFile(
      filePath,
      JSON.stringify([
        createEntry('b', 10),
        createEntry('older', 1),
        createEntry('a', 10),
        createEntry('newest', 20),
      ]),
      'utf8',
    )

    expect((await repository.list()).map((entry) => entry.id)).toEqual([
      'newest',
      'a',
      'b',
      'older',
    ])
  })

  it('replaces an existing entry with the same id', async () => {
    const { repository } = await createRepository()
    await repository.add(createEntry('same', 1, 'old text'), {
      enabled: true,
      retention: 'unlimited',
    })

    const entries = await repository.add(createEntry('same', 5, 'replacement text'), {
      enabled: true,
      retention: 'unlimited',
    })

    expect(entries).toEqual([createEntry('same', 5, 'replacement text')])
    expect(await repository.list()).toEqual(entries)
  })

  it('keeps every entry with unlimited retention', async () => {
    const { repository } = await createRepository()

    await repository.add(createEntry('1', 1), { enabled: true, retention: 'unlimited' })
    await repository.add(createEntry('3', 3), { enabled: true, retention: 'unlimited' })
    const entries = await repository.add(createEntry('2', 2), {
      enabled: true,
      retention: 'unlimited',
    })

    expect(entries.map((entry) => entry.id)).toEqual(['3', '2', '1'])
  })

  it.each([0, -1])('persists an empty list when retention is %i', async (retention) => {
    const { filePath, repository } = await createRepository()
    await repository.add(createEntry('old', 1), { enabled: true, retention: 'unlimited' })

    const entries = await repository.add(createEntry('new', 2), { enabled: true, retention })

    expect(entries).toEqual([])
    expect(await repository.list()).toEqual([])
    expect(await readFile(filePath, 'utf8')).toBe('[]\n')
  })

  it('searches trimmed text case-insensitively and treats an empty query as list', async () => {
    const { repository } = await createRepository()
    await repository.add(createEntry('1', 1, 'A quiet morning'), {
      enabled: true,
      retention: 'unlimited',
    })
    await repository.add(createEntry('2', 2, 'HELLO Wide World'), {
      enabled: true,
      retention: 'unlimited',
    })

    expect((await repository.search('  hello wide  ')).map((entry) => entry.id)).toEqual(['2'])
    expect((await repository.search('')).map((entry) => entry.id)).toEqual(['2', '1'])
    expect((await repository.search('   ')).map((entry) => entry.id)).toEqual(['2', '1'])
  })

  it('deletes a present id and does not rewrite when the id is absent', async () => {
    const { filePath, repository } = await createRepository()
    await repository.add(createEntry('1', 1), { enabled: true, retention: 'unlimited' })
    await repository.add(createEntry('2', 2), { enabled: true, retention: 'unlimited' })
    const beforeBytes = await readFile(filePath)
    const beforeStat = await stat(filePath)

    await expect(repository.delete('missing')).resolves.toBe(false)
    expect(await readFile(filePath)).toEqual(beforeBytes)
    expect((await stat(filePath)).ino).toBe(beforeStat.ino)

    await expect(repository.delete('1')).resolves.toBe(true)
    expect((await repository.list()).map((entry) => entry.id)).toEqual(['2'])
  })

  it('leaves history absent when clearing before a file exists', async () => {
    const { repository } = await createRepository()

    await repository.clear()

    expect(await repository.exists()).toBe(false)
  })

  it('persists an empty list when clearing an existing history file', async () => {
    const { filePath, repository } = await createRepository()
    await repository.add(createEntry('1', 1), { enabled: true, retention: 'unlimited' })

    await repository.clear()

    expect(await repository.exists()).toBe(true)
    expect(await repository.list()).toEqual([])
    expect(await readFile(filePath, 'utf8')).toBe('[]\n')
  })

  it('returns entry and array copies that callers cannot use to mutate stored history', async () => {
    const { repository } = await createRepository()
    const added = await repository.add(createEntry('1', 1, 'original'), {
      enabled: true,
      retention: 'unlimited',
    })

    added[0]!.text = 'mutated result'
    added.push(createEntry('injected', 99))
    const listed = await repository.list()
    listed[0]!.text = 'mutated list'
    const searched = await repository.search('original')
    searched[0]!.text = 'mutated search'

    expect(await repository.list()).toEqual([createEntry('1', 1, 'original')])
  })

  it('validates added entries and strips non-history fields before writing', async () => {
    const { filePath, repository } = await createRepository()
    const unsafeEntry = {
      ...createEntry('1', 1),
      rawAudio: [1, 2, 3],
      microphoneId: 'private-device',
    } as HistoryEntry

    const entries = await repository.add(unsafeEntry, {
      enabled: true,
      retention: 'unlimited',
    })

    expect(entries[0]).not.toHaveProperty('rawAudio')
    expect(entries[0]).not.toHaveProperty('microphoneId')
    const persisted = await readFile(filePath, 'utf8')
    expect(persisted).not.toContain('rawAudio')
    expect(persisted).not.toContain('microphoneId')
  })

  it('rejects an invalid added entry without creating a file', async () => {
    const { repository } = await createRepository()
    const invalid = { ...createEntry('1', 1), text: '' } as HistoryEntry

    await expect(
      repository.add(invalid, { enabled: true, retention: 'unlimited' }),
    ).rejects.toBeInstanceOf(ZodError)
    expect(await repository.exists()).toBe(false)
  })

  it('backs up syntax-corrupt history and recovers to an empty list', async () => {
    const { filePath, repository } = await createRepository(() => 1_725_000_000_004)
    const corruptBytes = Buffer.from('[{"id":"1"}', 'utf8')
    await writeFile(filePath, corruptBytes)

    await expect(repository.list()).resolves.toEqual([])

    expect(await readFile(`${filePath}.corrupt-1725000000004`)).toEqual(corruptBytes)
    expect(await repository.exists()).toBe(false)
  })

  it('backs up a history array containing an invalid entry', async () => {
    const { filePath, repository } = await createRepository(() => 1_725_000_000_005)
    const corruptBytes = Buffer.from(JSON.stringify([createEntry('1', 1), { id: '' }]), 'utf8')
    await writeFile(filePath, corruptBytes)

    await expect(repository.list()).resolves.toEqual([])

    expect(await readFile(`${filePath}.corrupt-1725000000005`)).toEqual(corruptBytes)
    expect(await repository.exists()).toBe(false)
  })

  it('serializes concurrent adds without losing entries', async () => {
    const { repository } = await createRepository()
    const entries = Array.from({ length: 20 }, (_, index) => createEntry(String(index), index))

    await Promise.all(
      entries.map((entry) => repository.add(entry, { enabled: true, retention: 'unlimited' })),
    )

    expect((await repository.list()).map((entry) => entry.id)).toEqual(
      entries.toReversed().map((entry) => entry.id),
    )
  })

  it('serializes concurrent add and delete mutations without losing the add', async () => {
    const { repository } = await createRepository()
    await repository.add(createEntry('old', 1), { enabled: true, retention: 'unlimited' })

    const add = repository.add(createEntry('new', 2), {
      enabled: true,
      retention: 'unlimited',
    })
    const remove = repository.delete('old')
    await Promise.all([add, remove])

    expect(await repository.list()).toEqual([createEntry('new', 2)])
  })
})
