// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MeshyApiFetch } from '../../../../../src/main/tools/meshy/api'
import { ModelRecords, type ThreeDModel } from '../../../../../src/main/tools/meshy/records'
import { MeshyModels, modelFileBase, type MeshyModelsOptions, type ModelRequest } from '../../../../../src/main/tools/meshy/service'
import { FAKE_MESHY_KEY, startFakeMeshy, type FakeMeshy } from '../../../../fixtures/fakeMeshy'

/**
 * Making a 3D model from the request to its files, and its record (ADR-0141; the Meshy plan's ticket 2), against a
 * local fake of Meshy. Every key is made up and nothing reaches Meshy.
 */
let meshy: FakeMeshy
let data: string
let root: string
let history: boolean
beforeEach(async () => {
  meshy = await startFakeMeshy()
  data = await mkdtemp(join(tmpdir(), 'sotto-meshy-data-'))
  root = await mkdtemp(join(tmpdir(), 'sotto-meshy-thread-'))
  history = true
})
afterEach(async () => {
  await meshy.close()
  await Promise.all([data, root].map(folder => rm(folder, { recursive: true, force: true })))
})

const realFetch: MeshyApiFetch = (url, init) => fetch(url, init)
const recordsHere = () => new ModelRecords(data, { historyEnabled: () => history })

function models(options: Partial<MeshyModelsOptions> = {}) {
  const waits: number[] = []
  const stop = new AbortController()
  const records = options.records ?? recordsHere()
  const service = new MeshyModels({
    records, fetch: realFetch, keyOf: () => FAKE_MESHY_KEY, signal: stop.signal, base: meshy.base, assets: meshy.base,
    wait: async ms => { waits.push(ms) }, ...options,
  })
  return { service, records, waits, stop }
}

const words = (name = 'Chair', more: Partial<ModelRequest> = {}): ModelRequest => ({ threadId: 'thread-1', accountId: 'meshy-1', name, root, source: { kind: 'words', words: 'a small wooden chair' }, ...more })
const photo = (): ModelRequest => ({ threadId: 'thread-1', accountId: 'meshy-1', name: 'Mug', root, source: { kind: 'photo', fileName: 'mug.jpg', photo: `data:image/jpeg;base64,${Buffer.from('made-up photo').toString('base64')}` } })

describe('a 3D model made with Meshy', () => {
  it('from words is a shape and then a texture, with its files and still picture in models/, costing 30 credits', async () => {
    const seen: ThreeDModel[] = []
    const { service } = models({ changed: model => seen.push(model) })
    const { model, done } = await service.make(words('Chair', { formats: ['obj'] }))
    expect(model).toMatchObject({ state: 'making', stage: 'shape', credits: 0, files: [] })
    const ended = await done
    expect(ended).toMatchObject({ state: 'done', credits: 30, files: ['Chair.png', 'Chair.glb', 'Chair.usdz', 'Chair.obj', 'Chair.mtl'], still: 'Chair.png' })
    expect(ended!.endedAt).toBeDefined()
    expect(ended).not.toHaveProperty('stage')
    expect((await readdir(join(root, 'models'))).sort()).toEqual(['Chair.glb', 'Chair.mtl', 'Chair.obj', 'Chair.png', 'Chair.usdz'])
    // The texture task makes the files, in GLB and USDZ always and what was asked for besides.
    expect(meshy.created('refine')[0]!.formats).toEqual(['glb', 'usdz', 'obj'])
    expect(seen.map(entry => entry.stage ?? entry.state)).toEqual(expect.arrayContaining(['shape', 'texture', 'files', 'done']))
    // Nothing outside this folder sees Meshy's task IDs.
    for (const entry of [...seen, ended!]) expect(entry).not.toHaveProperty('job')
    expect(JSON.stringify(seen)).not.toContain(meshy.created('preview')[0]!.id)
  })

  it('from a photo is one task, costing 30 credits, and keeps the photo’s name but never the photo', async () => {
    const { service } = models()
    const ended = await (await service.make(photo())).done
    expect(ended).toMatchObject({ state: 'done', credits: 30, source: { kind: 'photo', fileName: 'mug.jpg' }, files: ['Mug.png', 'Mug.glb', 'Mug.usdz'] })
    expect(meshy.created().map(task => task.kind)).toEqual(['photo'])
    expect(await readFile(join(data, '3d-models.json'), 'utf8')).not.toContain(Buffer.from('made-up photo').toString('base64'))
  })

  it('goes into the folder its thread names, under a name of its own beside a 3D model of the same name', async () => {
    const { service } = models()
    await (await service.make(words('Chair', { folder: 'art/chairs' }))).done
    const second = await (await service.make(words('Chair', { folder: 'art/chairs' }))).done
    expect(second!.files).toEqual(['Chair-2.png', 'Chair-2.glb', 'Chair-2.usdz'])
    expect(modelFileBase('a/b: c?')).toBe('a-b- c-')
    expect(modelFileBase('...')).toBe('3d-model')
    expect(modelFileBase('CON')).toBe('CON-model')
  })

  it('is refused before anything is sent when the folder is outside the thread’s working folder', async () => {
    const { service } = models()
    await expect(service.make(words('Chair', { folder: '../elsewhere' }))).rejects.toThrow()
    expect(meshy.requests).toEqual([])
    expect(await recordsHere().list()).toEqual([])
  })

  it('reads each task at the pace Meshy asks, and backs off while Meshy does not answer', async () => {
    meshy.behaviour.retryAfter = '9'
    meshy.behaviour.readsToFinish = 3
    meshy.behaviour.answers.push({ route: 'read', status: 503 }, { route: 'read', status: 503 }, { route: 'read', status: 429, retryAfter: '4' })
    const { service, waits } = models()
    expect(await (await service.make(words())).done).toMatchObject({ state: 'done' })
    expect(waits.slice(0, 3)).toEqual([5_000, 10_000, 4_000])
    expect(waits.slice(3)).toEqual([9_000, 9_000, 9_000, 9_000])
  })

  it('asks again when Meshy is too busy to take a task, and is charged for it once', async () => {
    meshy.behaviour.answers.push({ route: 'create', status: 429, retryAfter: '3' })
    const { service, waits } = models()
    expect(await (await service.make(words())).done).toMatchObject({ state: 'done', credits: 30 })
    expect(waits[0]).toBe(3_000)
    expect(meshy.created('preview')).toHaveLength(1)
  })

  it('takes back the credits of a task Meshy failed, and keeps those of the shape it made', async () => {
    meshy.behaviour.failing.add('refine')
    const { service } = models()
    expect(await (await service.make(words())).done).toMatchObject({ state: 'failed', failure: 'failed', credits: 20, files: [] })
    meshy.behaviour.failing = new Set(['photo'])
    expect(await (await service.make(photo())).done).toMatchObject({ state: 'failed', failure: 'failed', credits: 0 })
  })

  it('says why Meshy would not take it, and charges nothing', async () => {
    const answers = [[401, 'refused'], [402, 'no-credits'], [422, 'rejected'], [500, 'unreachable']] as const
    for (const [status, failure] of answers) {
      meshy.behaviour.answers.push({ route: 'create', status })
      const { service } = models()
      expect(await (await service.make(words())).done).toMatchObject({ state: 'failed', failure, credits: 0 })
    }
    const { service } = models({ keyOf: () => undefined })
    expect(await (await service.make(words())).done).toMatchObject({ state: 'failed', failure: 'no-account' })
  })

  it('is lost, and its half-fetched files removed, when Meshy no longer has its files', async () => {
    meshy.behaviour.onFile = path => { if (path.endsWith('model.usdz')) meshy.behaviour.answers.push({ route: 'file', status: 403 }) }
    const { service } = models()
    expect(await (await service.make(words())).done).toMatchObject({ state: 'lost', failure: 'expired', files: [] })
    expect(await readdir(join(root, 'models'))).toEqual([])
  })

  it('fails without a file past the size cap', async () => {
    meshy.behaviour.fileBytes = 2_000
    meshy.behaviour.chunked = true
    const { service } = models({ fileBytesMax: 1_000 })
    expect(await (await service.make(words())).done).toMatchObject({ state: 'failed', failure: 'too-large' })
    expect(await readdir(join(root, 'models'))).toEqual([])
  })
})

describe('a 3D model still being made when Sotto stops', () => {
  it('is picked up when Sotto starts, carrying on from the task Meshy has, never asking for one again', async () => {
    meshy.behaviour.readsToFinish = 3
    const first = models({ wait: async () => { if (meshy.created('refine').length === 1) first.stop.abort() } })
    const { model, done } = await first.service.make(words())
    expect(await done).toBeUndefined()
    expect(await recordsHere().record(model.id)).toMatchObject({ state: 'making', stage: 'texture' })
    // Sotto starts again, with the record as it was left.
    const again = models({ records: recordsHere() })
    await again.service.resume()
    expect(await again.service.whenDone(model.id)).toMatchObject({ state: 'done', credits: 30 })
    expect(meshy.created().map(task => task.kind)).toEqual(['preview', 'refine'])
  })

  it('is lost, and not asked for again, when Sotto stopped while Meshy was taking it', async () => {
    const first = models({ changed: model => { if (model.stage === 'texture') first.stop.abort() } })
    const { model, done } = await first.service.make(words())
    expect(await done).toBeUndefined()
    const again = models({ records: recordsHere() })
    await again.service.resume()
    expect(await again.service.whenDone(model.id)).toMatchObject({ state: 'lost', failure: 'stopped', credits: 20 })
    expect(meshy.created('refine')).toHaveLength(0)
  })

  it('is lost after Meshy’s three days, and nothing more is asked of Meshy', async () => {
    let now = Date.parse('2026-11-15T12:00:00Z')
    const first = models({ now: () => now, wait: async () => { first.stop.abort() } })
    const { model } = await first.service.make(photo())
    await first.service.whenDone(model.id)
    const asked = meshy.requests.length
    now += 3 * 24 * 60 * 60_000 + 1
    const again = models({ records: recordsHere(), now: () => now })
    await again.service.resume()
    expect(await again.service.whenDone(model.id)).toMatchObject({ state: 'lost', failure: 'expired', credits: 30 })
    expect(meshy.requests.length).toBe(asked)
  })
})

describe('the record of 3D models', () => {
  it('keeps the words only while Keep local history is on, and takes them out when it is turned off', async () => {
    const { service, records } = models()
    await (await service.make(words())).done
    expect(await readFile(join(data, '3d-models.json'), 'utf8')).toContain('a small wooden chair')
    history = false
    await records.privacyChanged()
    const file = await readFile(join(data, '3d-models.json'), 'utf8')
    expect(file).not.toContain('a small wooden chair')
    // The rest stays: the files and the credits the month's limit is counted from.
    expect((await records.list())[0]).toMatchObject({ state: 'done', credits: 30, source: { kind: 'words' } })
    expect((await records.list())[0]!.source).not.toHaveProperty('words')
    // A 3D model asked for with history off is made from the words it was handed, which are never kept.
    const later = await (await service.make(words('Table'))).done
    expect(later).toMatchObject({ state: 'done', source: { kind: 'words' } })
    expect(await readFile(join(data, '3d-models.json'), 'utf8')).not.toContain('a small wooden chair')
  })

  it('does not read words a failed clearing left in the file while Keep local history is off, and clears them next time', async () => {
    const { service } = models()
    await (await service.make(words())).done
    history = false
    const reopened = recordsHere()
    expect((await reopened.list())[0]!.source).toEqual({ kind: 'words' })
    await reopened.privacyChanged()
    expect(await readFile(join(data, '3d-models.json'), 'utf8')).not.toContain('a small wooden chair')
  })

  it('forgets a forgotten thread’s 3D models and leaves their files where they are', async () => {
    const { service, records } = models()
    await (await service.make(words())).done
    await (await service.make(words('Lamp', { threadId: 'thread-2' }))).done
    await records.forgetThreads(['thread-1'])
    expect((await records.list()).map(model => model.threadId)).toEqual(['thread-2'])
    expect(await readdir(join(root, 'models'))).toContain('Chair.glb')
  })

  it('stops a 3D model whose thread was forgotten while it was being made, writing nothing more', async () => {
    const records = recordsHere()
    const { service } = models({ records, wait: async () => { await records.forgetThreads(['thread-1']) } })
    expect(await (await service.make(words())).done).toBeUndefined()
    expect(await records.list()).toEqual([])
  })

  it('leaves out a record this version cannot read rather than refusing the rest', async () => {
    const { service } = models()
    const ended = await (await service.make(photo())).done
    const file = JSON.parse(await readFile(join(data, '3d-models.json'), 'utf8')) as { models: unknown[] }
    await writeFile(join(data, '3d-models.json'), JSON.stringify({ version: 1, models: [{ id: 'odd', state: 'melted' }, ...file.models] }))
    expect((await recordsHere().list()).map(model => model.id)).toEqual([ended!.id])
  })
})
