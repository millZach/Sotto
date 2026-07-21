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
  const root = await mkdtemp(join(tmpdir(), 'talktype-widget-placement-'))
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

  it('persists an edge placement and reads it back through a fresh instance', async () => {
    const { filePath, repository } = await createRepository()

    await repository.save({ edge: 'left', offset: 0.25 })

    expect(await repository.get()).toEqual({ kind: 'edge', edge: 'left', offset: 0.25 })
    expect(await new WidgetPlacementRepository(filePath).get()).toEqual({
      kind: 'edge',
      edge: 'left',
      offset: 0.25,
    })
  })

  it('writes a version 2 record to disk', async () => {
    const { filePath, repository } = await createRepository()

    await repository.save({ edge: 'bottom', offset: 0.5 })

    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 2,
      placement: { edge: 'bottom', offset: 0.5 },
    })
  })

  it('replaces an earlier remembered placement', async () => {
    const { repository } = await createRepository()

    await repository.save({ edge: 'top', offset: 0.1 })
    await repository.save({ edge: 'right', offset: 0.9 })

    expect(await repository.get()).toEqual({ kind: 'edge', edge: 'right', offset: 0.9 })
  })

  it('still reads a legacy version 1 point record without crashing', async () => {
    const { filePath, repository } = await createRepository()
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, placement: { x: 1_234, y: -56 } }),
      'utf8',
    )

    expect(await repository.get()).toEqual({ kind: 'point', x: 1_234, y: -56 })
  })

  it('returns no placement for corrupted or foreign file content', async () => {
    const { filePath, repository } = await createRepository()
    await writeFile(filePath, 'not json at all', 'utf8')

    expect(await repository.get()).toBeNull()
  })

  it('returns no placement for unknown record versions or malformed placements', async () => {
    const { filePath, repository } = await createRepository()

    await writeFile(filePath, JSON.stringify({ version: 3, placement: { edge: 'bottom', offset: 0.5 } }), 'utf8')
    expect(await repository.get()).toBeNull()

    await writeFile(filePath, JSON.stringify({ version: 2, placement: { edge: 'middle', offset: 0.5 } }), 'utf8')
    expect(await repository.get()).toBeNull()

    await writeFile(filePath, JSON.stringify({ version: 2, placement: { edge: 'bottom', offset: 7 } }), 'utf8')
    expect(await repository.get()).toBeNull()

    await writeFile(filePath, JSON.stringify({ version: 1, placement: { x: 3.7, y: 5 } }), 'utf8')
    expect(await repository.get()).toBeNull()
  })

  it('clamps a saved offset into the unit interval instead of storing it raw', async () => {
    const { repository } = await createRepository()

    await repository.save({ edge: 'bottom', offset: 3.5 })
    expect(await repository.get()).toEqual({ kind: 'edge', edge: 'bottom', offset: 1 })

    await repository.save({ edge: 'top', offset: Number.NaN })
    expect(await repository.get()).toEqual({ kind: 'edge', edge: 'top', offset: 0.5 })
  })
})
