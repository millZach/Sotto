// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listModels, removeGoneModel, revealModelFile, type ModelListSource } from '../../../../../src/main/tools/meshy/page'
import { ModelRecords, type ModelRecord } from '../../../../../src/main/tools/meshy/records'
import { model3dListSchema } from '../../../../../src/shared/models3d'
import { selfContainedGlb } from '../../../../fixtures/glb'

/** The 3D models page and Tools › 3D models, from main (the Meshy plan's ticket 5). */
let root: string
let data: string
let outside: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-meshy-page-')))
  data = await mkdtemp(join(tmpdir(), 'sotto-meshy-page-data-'))
  outside = await realpath(await mkdtemp(join(tmpdir(), 'sotto-meshy-page-outside-')))
})
afterEach(async () => { await Promise.all([root, data, outside].map(folder => rm(folder, { recursive: true, force: true }))) })

const ACCOUNT = '22222222-2222-4222-8222-000000000001'
function record(id: string, change: Partial<ModelRecord> = {}): ModelRecord {
  return { id, threadId: 'thread-1', accountId: ACCOUNT, name: id, source: { kind: 'words', words: `A ${id}` }, root, folder: join(root, 'models'), formats: ['glb', 'usdz'],
    state: 'done', credits: 30, askedAt: '2026-11-15T09:00:00.000Z', files: [`${id}.glb`, `${id}.usdz`], job: {}, ...change }
}
async function filesOf(model: ModelRecord): Promise<void> {
  await mkdir(model.folder, { recursive: true })
  for (const name of model.files) await writeFile(join(model.folder, name), name.endsWith('.glb') ? selfContainedGlb() : Buffer.alloc(10))
}
function sourceOf(records: ModelRecords, making: ReadonlySet<string> = new Set()): ModelListSource {
  return {
    model: id => records.model(id), list: () => records.list(), remove: (id, may) => records.remove(id, may),
    progressOf: id => making.has(id) ? { percent: 40, secondsLeft: 30 } : undefined, hasShape: () => false, shapeBytes: async () => null,
    accountNames: async () => new Map([[ACCOUNT, 'Studio']]),
  }
}

describe('the 3D models page, from main', () => {
  it('lists only 3D models being made or done, newest first, with the account’s name, and one thread’s when asked', async () => {
    const records = new ModelRecords(data, { historyEnabled: () => true })
    const barrel = record('barrel', { askedAt: '2026-11-13T09:00:00.000Z' })
    const helmet = record('helmet', { threadId: 'thread-2', askedAt: '2026-11-14T09:00:00.000Z', source: { kind: 'photo', fileName: 'helmet.jpg' } })
    const lantern = record('lantern', { state: 'making', stage: 'texture', files: [], askedAt: '2026-11-15T09:00:00.000Z' })
    await Promise.all([barrel, helmet].map(filesOf))
    // Added out of order, so newest first is the list's own doing.
    for (const each of [helmet, lantern, barrel, record('failed', { state: 'failed', failure: 'failed', files: [] }), record('lost', { state: 'lost', failure: 'expired', files: [] })]) await records.add(each)
    const listed = model3dListSchema.parse(await listModels(sourceOf(records, new Set(['lantern']))))
    expect(listed.map(model => model.id)).toEqual(['lantern', 'helmet', 'barrel'])
    expect(listed[0]).toMatchObject({ state: 'making', stage: 'texture', percent: 40, secondsLeft: 30, threadId: 'thread-1', account: 'Studio', words: 'A lantern' })
    expect(listed[1]).toMatchObject({ source: 'photo', photo: 'helmet.jpg', threadId: 'thread-2', files: [{ name: 'helmet.glb', bytes: selfContainedGlb().byteLength }, { name: 'helmet.usdz', bytes: 10 }] })
    expect(listed[1]).not.toHaveProperty('words')
    expect(JSON.stringify(listed)).not.toContain(root)
    expect((await listModels(sourceOf(records), 'thread-2')).map(model => model.id)).toEqual(['helmet'])
    expect(await listModels(sourceOf(records), 'thread-none')).toEqual([])
  })

  it('tells which 3D models went with a forgotten thread, so the window can let them go', async () => {
    const records = new ModelRecords(data, { historyEnabled: () => true })
    for (const each of [record('barrel'), record('helmet', { threadId: 'thread-2' }), record('lantern', { state: 'making', stage: 'shape', files: [] })]) await records.add(each)
    expect([...await records.forgetThreads(['thread-1'])].sort()).toEqual(['barrel', 'lantern'])
    expect(await records.forgetThreads(['thread-1'])).toEqual([])
    expect((await listModels(sourceOf(records))).map(model => model.id)).toEqual(['helmet'])
  })

  it('lists no words once Keep local history is off', async () => {
    let history = true
    const records = new ModelRecords(data, { historyEnabled: () => history })
    await filesOf(record('barrel'))
    await records.add(record('barrel'))
    history = false
    await records.privacyChanged()
    expect((await listModels(sourceOf(records)))[0]).not.toHaveProperty('words')
  })

  it('refuses to remove a record while its files are there, and removes only the record once they are gone', async () => {
    const records = new ModelRecords(data, { historyEnabled: () => true })
    const barrel = record('barrel')
    await filesOf(barrel)
    await records.add(barrel)
    await records.add(record('lantern', { state: 'making', stage: 'shape', files: [] }))
    const source = sourceOf(records)
    // Each refusal says why, so the window can say so.
    expect(await removeGoneModel(source, 'barrel')).toBe('files-there')
    // One file left is still its files: the record stays.
    await rm(join(barrel.folder, 'barrel.glb'))
    expect(await removeGoneModel(source, 'barrel')).toBe('files-there')
    expect(await removeGoneModel(source, 'lantern')).toBe('changed')
    expect(await removeGoneModel(source, 'unknown')).toBe('no-record')
    // A file put in its folder that is not its own is left where it is.
    await writeFile(join(barrel.folder, 'notes.txt'), 'mine')
    await rm(join(barrel.folder, 'barrel.usdz'))
    expect(await removeGoneModel(source, 'barrel')).toBe('removed')
    expect(await removeGoneModel(source, 'barrel')).toBe('no-record')
    expect((await records.list()).map(model => model.id)).toEqual(['lantern'])
    expect(await readdir(barrel.folder)).toEqual(['notes.txt'])
    // What it cost stays counted for the month.
    expect((await records.monthCredits(new Date('2026-11-20T09:00:00.000Z'))).get(ACCOUNT)).toBe(30 + 30)
    expect(JSON.parse(await readFile(join(data, '3d-models.json'), 'utf8')).spent).toEqual([{ accountId: ACCOUNT, askedAt: barrel.askedAt, credits: 30 }])
  })

  it('shows a 3D model’s own file in the folder app, and refuses an unknown ID, a name it does not hold and a file outside its folder', async () => {
    const records = new ModelRecords(data, { historyEnabled: () => true })
    const barrel = record('barrel')
    await filesOf(barrel)
    await records.add(barrel)
    const source = sourceOf(records)
    const shown: string[] = []
    const reveal = (path: string): void => { shown.push(path) }
    expect(await revealModelFile(source, { id: 'barrel', file: 'barrel.usdz' }, reveal)).toBe(true)
    // With no file named, its GLB.
    expect(await revealModelFile(source, { id: 'barrel' }, reveal)).toBe(true)
    expect(shown).toEqual([join(barrel.folder, 'barrel.usdz'), join(barrel.folder, 'barrel.glb')])
    expect(await revealModelFile(source, { id: 'unknown' }, reveal)).toBe(false)
    expect(await revealModelFile(source, { id: 'barrel', file: '../../secret.txt' }, reveal)).toBe(false)
    expect(await revealModelFile(source, { id: 'barrel', file: 'notes.txt' }, reveal)).toBe(false)
    // A record whose folder is outside the thread's, as one moved since, is shown nothing.
    const moved = record('moved', { folder: outside, files: ['moved.glb'] })
    await filesOf(moved)
    await records.add(moved)
    expect(await revealModelFile(source, { id: 'moved' }, reveal)).toBe(false)
    // Nor is a file that is gone.
    await rm(join(barrel.folder, 'barrel.usdz'))
    expect(await revealModelFile(source, { id: 'barrel', file: 'barrel.usdz' }, reveal)).toBe(false)
    expect(shown).toHaveLength(2)
  })
})
