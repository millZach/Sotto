import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { WidgetPlacementRepository } from '../../../src/main/storage/widgetPlacementRepository'

const roots: string[] = []

async function createRepository(): Promise<{
  filePath: string
  repository: WidgetPlacementRepository
}> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-widget-placement-'))
  roots.push(root)
  const filePath = join(root, 'widget-placement.json')
  return { filePath, repository: new WidgetPlacementRepository(filePath) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('WidgetPlacementRepository', () => {
  it('returns no placement for a missing file', async () => {
    const { repository } = await createRepository()

    expect(await repository.get()).toBeNull()
  })

  it('writes a version 3 edge-only record', async () => {
    const { filePath, repository } = await createRepository()

    await repository.save({ edge: 'right' })

    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 3,
      placement: { edge: 'right' },
    })
  })

  it('persists an edge placement and reads it back through a fresh instance', async () => {
    const { filePath, repository } = await createRepository()

    await repository.save({ edge: 'left' })

    expect(await repository.get()).toEqual({ kind: 'edge', edge: 'left' })
    expect(await new WidgetPlacementRepository(filePath).get()).toEqual({
      kind: 'edge',
      edge: 'left',
    })
  })

  it('replaces an earlier remembered placement', async () => {
    const { repository } = await createRepository()

    await repository.save({ edge: 'top' })
    await repository.save({ edge: 'right' })

    expect(await repository.get()).toEqual({ kind: 'edge', edge: 'right' })
  })

  it('migrates a valid version 2 edge and discards its offset', async () => {
    const { filePath, repository } = await createRepository()
    await writeFile(
      filePath,
      JSON.stringify({ version: 2, placement: { edge: 'left', offset: 0.25 } }),
      'utf8',
    )

    expect(await repository.get()).toEqual({ kind: 'edge', edge: 'left' })
  })

  it('rewrites a version 2 record as version 3 during get', async () => {
    const { filePath, repository } = await createRepository()
    await writeFile(
      filePath,
      JSON.stringify({ version: 2, placement: { edge: 'right', offset: 0.9 } }),
      'utf8',
    )

    await repository.get()

    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 3,
      placement: { edge: 'right' },
    })
  })

  it('returns a version 1 point for display-aware migration', async () => {
    const { filePath, repository } = await createRepository()
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, placement: { x: 1_234, y: -56 } }),
      'utf8',
    )

    expect(await repository.get()).toEqual({ kind: 'point', x: 1_234, y: -56 })
  })

  it('returns no placement for corrupted file content', async () => {
    const { filePath, repository } = await createRepository()
    await writeFile(filePath, 'not json at all', 'utf8')

    expect(await repository.get()).toBeNull()
  })

  it('returns no placement for malformed or unknown records', async () => {
    const { filePath, repository } = await createRepository()
    const invalidRecords = [
      { version: 4, placement: { edge: 'bottom' } },
      { version: 3, placement: { edge: 'middle' } },
      { version: 2, placement: { edge: 'middle', offset: 0.5 } },
      { version: 2, placement: { edge: 'bottom', offset: 7 } },
      { version: 1, placement: { x: 3.7, y: 5 } },
    ]

    for (const record of invalidRecords) {
      await writeFile(filePath, JSON.stringify(record), 'utf8')
      expect(await repository.get()).toBeNull()
    }
  })
})
