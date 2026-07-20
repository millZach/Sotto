import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

  it('persists a placement and reads it back through a fresh instance', async () => {
    const { filePath, repository } = await createRepository()

    await repository.save({ x: 1_234, y: -56 })

    expect(await repository.get()).toEqual({ x: 1_234, y: -56 })
    expect(await new WidgetPlacementRepository(filePath).get()).toEqual({ x: 1_234, y: -56 })
  })

  it('replaces an earlier remembered placement', async () => {
    const { repository } = await createRepository()

    await repository.save({ x: 10, y: 20 })
    await repository.save({ x: 30, y: 40 })

    expect(await repository.get()).toEqual({ x: 30, y: 40 })
  })

  it('returns no placement for corrupted or foreign file content', async () => {
    const { filePath, repository } = await createRepository()
    await writeFile(filePath, 'not json at all', 'utf8')

    expect(await repository.get()).toBeNull()
  })

  it('rejects non-finite or non-integer coordinates instead of storing them', async () => {
    const { repository } = await createRepository()

    await repository.save({ x: Number.NaN, y: 5 })
    expect(await repository.get()).toBeNull()

    await repository.save({ x: 3.7, y: 5 })
    expect(await repository.get()).toBeNull()
  })
})
