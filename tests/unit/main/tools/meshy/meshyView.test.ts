// @vitest-environment node
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ThreeDModel } from '../../../../../src/main/tools/meshy/records'
import { modelBytes, modelView, modelViewOf, type ModelViewSource } from '../../../../../src/main/tools/meshy/view'
import { model3dViewSchema } from '../../../../../src/shared/models3d'
import { glbBytes, selfContainedGlb } from '../../../../fixtures/glb'

/** A 3D model as its thread draws it, and the bytes the window is handed by its ID alone (the Meshy plan's ticket 4). */
let root: string
let outside: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-meshy-view-')))
  outside = await realpath(await mkdtemp(join(tmpdir(), 'sotto-meshy-outside-')))
})
afterEach(async () => { await Promise.all([root, outside].map(folder => rm(folder, { recursive: true, force: true }))) })

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)])

async function done(glb: Uint8Array = selfContainedGlb()): Promise<ThreeDModel> {
  const folder = join(root, 'models')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'Barrel.png'), PNG)
  await writeFile(join(folder, 'Barrel.glb'), glb)
  await writeFile(join(folder, 'Barrel.usdz'), Buffer.alloc(10))
  return { id: 'model-1', threadId: 'thread-1', accountId: 'meshy-1', name: 'Barrel', source: { kind: 'words' }, root, folder, formats: ['glb', 'usdz'],
    state: 'done', credits: 30, askedAt: '2026-11-15T09:00:00.000Z', endedAt: '2026-11-15T09:03:00.000Z', files: ['Barrel.png', 'Barrel.glb', 'Barrel.usdz'], still: 'Barrel.png' }
}

const sourceOf = (model: ThreeDModel | undefined, shape: Uint8Array | null = null): ModelViewSource => ({
  model: async id => model?.id === id ? model : undefined,
  progressOf: () => ({ percent: 68, secondsLeft: 40 }),
  hasShape: () => shape !== null,
  shapeBytes: async () => shape,
})

describe('a 3D model in its thread', () => {
  it('is viewed by its name, credits and files with their sizes, and never a path', async () => {
    const model = await done()
    const view = await modelView(model, undefined, false)
    expect(model3dViewSchema.parse(view)).toEqual({ id: 'model-1', name: 'Barrel', source: 'words', state: 'done', credits: 30, folder: 'models', still: 'Barrel.png',
      files: [{ name: 'Barrel.png', bytes: PNG.byteLength }, { name: 'Barrel.glb', bytes: selfContainedGlb().byteLength }, { name: 'Barrel.usdz', bytes: 10 }] })
    expect(JSON.stringify(view)).not.toContain(root)
  })

  it('carries Meshy’s percent and the time left while it works, and the shape while the texture is painted', async () => {
    const making: ThreeDModel = { ...await done(), state: 'making', stage: 'texture', credits: 30, files: [] }
    delete (making as { still?: string }).still
    delete (making as { endedAt?: string }).endedAt
    expect(await modelViewOf(sourceOf(making, selfContainedGlb()), 'model-1')).toEqual({ id: 'model-1', name: 'Barrel', source: 'words', state: 'making', stage: 'texture', percent: 68, secondsLeft: 40, shape: true, credits: 30, folder: 'models', files: [] })
    expect(await modelViewOf(sourceOf(making), 'unknown')).toBeNull()
  })

  it('hands over its GLB and still picture by its ID, and nothing for an unknown ID', async () => {
    const source = sourceOf(await done())
    expect(await modelBytes(source, { id: 'model-1', part: 'model' })).toEqual(selfContainedGlb())
    expect(Buffer.from((await modelBytes(source, { id: 'model-1', part: 'still' }))!)).toEqual(PNG)
    expect(await modelBytes(source, { id: 'unknown', part: 'model' })).toBeNull()
    expect(await modelBytes(source, { id: 'unknown', part: 'still' })).toBeNull()
  })

  it('refuses a GLB that points outside itself, and a shape that does', async () => {
    const external = glbBytes({ asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: 'https://example.com/model.bin' }] })
    expect(await modelBytes(sourceOf(await done(external)), { id: 'model-1', part: 'model' })).toBeNull()
    const making: ThreeDModel = { ...await done(), state: 'making', stage: 'texture' }
    expect(await modelBytes(sourceOf(making, external), { id: 'model-1', part: 'shape' })).toBeNull()
    expect(await modelBytes(sourceOf(making, selfContainedGlb()), { id: 'model-1', part: 'shape' })).toEqual(selfContainedGlb())
    // A 3D model still being made has no files to hand over yet.
    expect(await modelBytes(sourceOf(making), { id: 'model-1', part: 'model' })).toBeNull()
  })

  it('hands over no shape once the 3D model’s record is gone, before its bytes come or while they do', async () => {
    const making: ThreeDModel = { ...await done(), state: 'making', stage: 'texture' }
    expect(await modelBytes(sourceOf(undefined, selfContainedGlb()), { id: 'model-1', part: 'shape' })).toBeNull()
    // Its thread forgotten while the shape was being fetched.
    let held: ThreeDModel | undefined = making
    const forgottenMeanwhile: ModelViewSource = { ...sourceOf(making), model: async () => held, shapeBytes: async () => { held = undefined; return selfContainedGlb() } }
    expect(await modelBytes(forgottenMeanwhile, { id: 'model-1', part: 'shape' })).toBeNull()
    // And one past its texture step has none either.
    expect(await modelBytes(sourceOf({ ...making, stage: 'files' }, selfContainedGlb()), { id: 'model-1', part: 'shape' })).toBeNull()
  })

  it('refuses its folder once it was swapped for a link outside the thread’s folder', async () => {
    const model = await done()
    await writeFile(join(outside, 'Barrel.glb'), selfContainedGlb())
    await writeFile(join(outside, 'Barrel.png'), PNG)
    await rename(model.folder, join(root, 'moved'))
    await symlink(outside, model.folder, 'junction')
    expect(await modelBytes(sourceOf(model), { id: 'model-1', part: 'model' })).toBeNull()
    expect(await modelBytes(sourceOf(model), { id: 'model-1', part: 'still' })).toBeNull()
    // Nor are its files' sizes read there.
    expect((await modelView(model, undefined, false)).files).toEqual(model.files.map(name => ({ name })))
  })

  it('refuses one of its files swapped for a link outside the thread’s folder, and a name its record does not hold', async () => {
    const model = await done()
    await mkdir(join(outside, 'elsewhere'))
    await writeFile(join(outside, 'elsewhere', 'Barrel.glb'), selfContainedGlb())
    await rm(join(model.folder, 'Barrel.glb'))
    // A folder link stands in for a file link, which Windows gives only to an administrator.
    await symlink(join(outside, 'elsewhere'), join(model.folder, 'Barrel.glb'), 'junction')
    expect(await modelBytes(sourceOf(model), { id: 'model-1', part: 'model' })).toBeNull()
    expect(await modelBytes(sourceOf({ ...model, files: ['Other.glb'] }), { id: 'model-1', part: 'model' })).toBeNull()
  })
})
