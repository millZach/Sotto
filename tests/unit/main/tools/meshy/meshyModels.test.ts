// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MeshyApiFetch } from '../../../../../src/main/tools/meshy/api'
import { ModelRecords, type ThreeDModel } from '../../../../../src/main/tools/meshy/records'
import { MeshyModels, modelFileBase, type MeshyModelsOptions, type ModelProgress, type ModelRequest } from '../../../../../src/main/tools/meshy/service'
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

  it('keeps Meshy’s percent and the time left at the rate so far in memory, and sends each change with them', async () => {
    let clock = Date.parse('2026-11-15T09:00:00.000Z')
    meshy.behaviour.readsToFinish = 5
    meshy.behaviour.progress = reads => [0, 0, 0, 20, 60][reads] ?? 0
    const seen: { readonly stage: string | undefined; readonly progress: ModelProgress | undefined }[] = []
    const { service } = models({ now: () => clock, wait: async ms => { clock += ms }, changed: (model, progress) => seen.push({ stage: model.stage, progress }) })
    const { model, done } = await service.make(photo())
    const ended = await done
    // Read every five seconds: 0% at the first and again five seconds on, which sends nothing new; 20% ten seconds
    // on, so the 80% left is about 40 seconds away; then 60% fifteen seconds on, so about 10.
    expect(seen.filter(entry => entry.progress).map(entry => entry.progress)).toEqual([{ percent: 0 }, { percent: 20, secondsLeft: 40 }, { percent: 60, secondsLeft: 10 }])
    expect(seen.every(entry => entry.progress === undefined || entry.stage === 'shape')).toBe(true)
    expect(ended!.state).toBe('done')
    // Once it ended, nothing of its progress is held, and none was ever written to its record.
    expect(service.progressOf(model.id, 'shape')).toBeUndefined()
    expect(await readFile(join(data, '3d-models.json'), 'utf8')).not.toMatch(/percent|secondsLeft|progress/u)
  })

  it('holds the shape Meshy made while it paints the texture, fetched into memory only when asked for', async () => {
    let shapeShown: boolean | undefined
    let shapeBytes: Promise<Uint8Array | null> | undefined
    const holder: { service?: MeshyModels } = {}
    const { service } = models({ changed: model => {
      if (model.stage !== 'texture' || shapeShown !== undefined) return
      shapeShown = holder.service!.hasShape(model.id)
      shapeBytes = holder.service!.shapeBytes(model.id)
    } })
    holder.service = service
    const { model, done } = await service.make(words())
    await done
    expect(shapeShown).toBe(true)
    // The fake's files are its own made-up bytes; what matters is they came from the preview task, into memory.
    expect(await shapeBytes).toEqual(new Uint8Array(64).fill('m'.charCodeAt(0)))
    expect(await readdir(join(root, 'models'))).not.toContain('model.glb')
    expect(meshy.requests.some(request => request.path === `/files/${meshy.created('preview')[0]!.id}/model.glb`)).toBe(true)
    expect(service.hasShape(model.id)).toBe(false)
    expect(await service.shapeBytes(model.id)).toBeNull()
  })

  it('tries the shape again after a fetch that failed, rather than keep the failure', async () => {
    // Bug Bot on #2599, N1.
    meshy.behaviour.holding.add('refine')
    const results: (Uint8Array | null)[] = []
    const holder: { service?: MeshyModels; id?: string } = {}
    const { service } = models({ wait: async () => {
      if (results.length > 0 || !holder.id || !holder.service?.hasShape(holder.id)) return
      meshy.behaviour.answers.push({ route: 'file', status: 500 })
      results.push(await holder.service.shapeBytes(holder.id))
      results.push(await holder.service.shapeBytes(holder.id))
      meshy.behaviour.holding.delete('refine')
    } })
    holder.service = service
    const { model, done } = await service.make(words())
    holder.id = model.id
    await done
    expect(results[0]).toBeNull()
    expect(results[1]).toEqual(new Uint8Array(64).fill('m'.charCodeAt(0)))
  })

  it('stops asking Meshy and sending progress once its thread is forgotten during the texture, and drops the shape', async () => {
    meshy.behaviour.holding.add('refine')
    const records = recordsHere()
    let forgotten = false
    let afterwards = 0
    const holder: { service?: MeshyModels; id?: string } = {}
    const { service } = models({ records,
      changed: () => { if (forgotten) afterwards++ },
      wait: async () => {
        if (forgotten || !holder.service?.hasShape(holder.id!)) return
        await records.forgetThreads(['thread-1'])
        forgotten = true
      } })
    holder.service = service
    const { model, done } = await service.make(words())
    holder.id = model.id
    expect(await done).toBeUndefined()
    const reads = meshy.requests.length
    expect(forgotten).toBe(true)
    expect(afterwards).toBe(0)
    expect(service.hasShape(model.id)).toBe(false)
    expect(service.progressOf(model.id, 'texture')).toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(meshy.requests.length).toBe(reads)
  })

  it('offers the shape again when picked up during the texture after Sotto stopped', async () => {
    meshy.behaviour.holding.add('refine')
    const first = models({ wait: async () => { if (meshy.created('refine').length === 1) first.stop.abort() } })
    const { model, done } = await first.service.make(words())
    expect(await done).toBeUndefined()
    expect(first.service.hasShape(model.id)).toBe(false)
    let shown: boolean | undefined
    const holder: { service?: MeshyModels } = {}
    const again = models({ records: recordsHere(), changed: changed => { if (changed.stage === 'texture' && shown === undefined) shown = holder.service!.hasShape(changed.id) } })
    holder.service = again.service
    await again.service.resume()
    await expect.poll(() => shown).toBe(true)
    // The shape's link came from reading the shape task Meshy keeps, once; no new task was asked for.
    expect(meshy.created().map(task => task.kind)).toEqual(['preview', 'refine'])
    meshy.behaviour.holding.delete('refine')
    expect(await again.service.whenDone(model.id)).toMatchObject({ state: 'done' })
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
    const answers = [[401, 'refused'], [402, 'no-credits'], [403, 'rejected'], [422, 'rejected']] as const
    for (const [status, failure] of answers) {
      meshy.behaviour.answers.push({ route: 'create', status })
      const { service } = models()
      expect(await (await service.make(words())).done).toMatchObject({ state: 'failed', failure, credits: 0 })
    }
    const { service } = models({ keyOf: () => undefined })
    expect(await (await service.make(words())).done).toMatchObject({ state: 'failed', failure: 'no-account' })
    // A credential store that will not hand the key over ends it, with nothing sent (Bug Bot on #2594, L2).
    const locked = models({ keyOf: () => { throw new Error('locked') } })
    expect(await (await locked.service.make(words())).done).toMatchObject({ state: 'failed', failure: 'locked', credits: 0 })
    expect(meshy.created()).toHaveLength(0)
  })

  it('keeps the credits counted, and never asks again, when Meshy may have taken it without Sotto learning its task', async () => {
    // A 5xx, an answer Sotto cannot read, and no answer at all.
    const garbled: MeshyApiFetch = async (url, init) => init.method === 'POST' ? new Response('not json', { status: 202 }) : realFetch(url, init)
    const silent: MeshyApiFetch = async (url, init) => { if (init.method === 'POST') throw new Error('timed out'); return realFetch(url, init) }
    for (const fetcher of [realFetch, garbled, silent]) {
      if (fetcher === realFetch) meshy.behaviour.answers.push({ route: 'create', status: 503 })
      const { service } = models({ fetch: fetcher })
      expect(await (await service.make(words())).done).toMatchObject({ state: 'lost', failure: 'unreachable', credits: 20 })
    }
    expect(meshy.created()).toHaveLength(0)
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

  it('is lost, and not asked for again, when Sotto stopped while Meshy was taking it, with that task still counted', async () => {
    const first = models({ changed: model => { if (model.stage === 'texture') first.stop.abort() } })
    const { model, done } = await first.service.make(words())
    expect(await done).toBeUndefined()
    const again = models({ records: recordsHere() })
    await again.service.resume()
    // Meshy may have taken the texture task just as Sotto stopped, so its 10 credits stay counted.
    expect(await again.service.whenDone(model.id)).toMatchObject({ state: 'lost', failure: 'stopped', credits: 30 })
    expect(meshy.created('refine')).toHaveLength(0)
  })

  it('starts a stopped fetch again whole, taking away what the stopped try left under its own name', async () => {
    meshy.behaviour.readsToFinish = 3
    const first = models({ wait: async () => { if (meshy.created('refine').length === 1) first.stop.abort() } })
    const { model } = await first.service.make(words())
    await first.service.whenDone(model.id)
    // As a hard stop part way through fetching would leave it: one whole file named in the record, and a part file.
    const folder = join(root, 'models')
    const records = recordsHere()
    await records.update(model.id, held => ({ ...held, files: ['Chair.png'] }))
    await writeFile(join(folder, 'Chair.png'), 'from the stopped try')
    await writeFile(join(folder, `.sotto-3d-${model.id}-Chair.glb.part`), 'half a file')
    const again = models({ records })
    await again.service.resume()
    expect(await again.service.whenDone(model.id)).toMatchObject({ state: 'done', files: ['Chair.png', 'Chair.glb', 'Chair.usdz'] })
    expect((await readdir(folder)).sort()).toEqual(['Chair.glb', 'Chair.png', 'Chair.usdz'])
  })

  it('names no files in the record once a stopped fetch took them away, so the next start removes nothing of anyone else’s', async () => {
    const first = models()
    meshy.behaviour.onFile = path => { if (path.endsWith('model.usdz')) first.stop.abort() }
    const { model } = await first.service.make(words())
    expect(await first.service.whenDone(model.id)).toBeUndefined()
    expect(await recordsHere().record(model.id)).toMatchObject({ state: 'making', files: [] })
    // The user saves a file of that name before Sotto starts again.
    delete meshy.behaviour.onFile
    const folder = join(root, 'models')
    await writeFile(join(folder, 'Chair.png'), 'mine')
    const again = models({ records: recordsHere() })
    await again.service.resume()
    expect(await again.service.whenDone(model.id)).toMatchObject({ state: 'done', files: ['Chair-2.png', 'Chair-2.glb', 'Chair-2.usdz'] })
    expect(await readFile(join(folder, 'Chair.png'), 'utf8')).toBe('mine')
  })

  it('stops asking a Meshy too busy to take it once its three days are up, and counts nothing', async () => {
    let now = Date.parse('2026-11-15T12:00:00Z')
    for (let n = 0; n < 10; n++) meshy.behaviour.answers.push({ route: 'create', status: 429, retryAfter: '600' })
    const { service } = models({ now: () => now, wait: async () => { now += 24 * 60 * 60_000 } })
    expect(await (await service.make(words())).done).toMatchObject({ state: 'lost', failure: 'expired', credits: 0 })
    expect(meshy.created()).toHaveLength(0)
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

  it('takes the words out of what Sotto holds even when the file cannot be written', async () => {
    const { service, records } = models()
    await (await service.make(words())).done
    // Something in the way of the file's next copy, so the write fails.
    await mkdir(join(data, '3d-models.json.next'))
    history = false
    await expect(records.privacyChanged()).rejects.toThrow()
    expect(JSON.stringify(await records.list())).not.toContain('a small wooden chair')
  })

  it('never writes over a file it could not read just now, and reads it again on the next change', async () => {
    const { service } = models()
    const ended = await (await service.make(photo())).done
    const kept = await readFile(join(data, '3d-models.json'), 'utf8')
    const record = (await recordsHere().record(ended!.id))!
    // Something holds the file, so reading it fails: here, a folder in its place for a moment.
    await rename(join(data, '3d-models.json'), join(data, 'held.json'))
    await mkdir(join(data, '3d-models.json'))
    const records = recordsHere()
    await expect(records.list()).rejects.toThrow()
    await expect(records.add({ ...record, id: 'another' })).rejects.toThrow()
    await rm(join(data, '3d-models.json'), { recursive: true })
    await rename(join(data, 'held.json'), join(data, '3d-models.json'))
    expect((await records.list()).map(model => model.id)).toEqual([ended!.id])
    expect(await readFile(join(data, '3d-models.json'), 'utf8')).toBe(kept)
  })

  it('writes over a file it could not read while Keep local history is off, since it may hold words', async () => {
    await writeFile(join(data, '3d-models.json'), '{"version":1,"models":[{"source":{"kind":"words","words":"a small wooden chair"}')
    history = false
    const records = recordsHere()
    expect(await records.list()).toEqual([])
    await records.privacyChanged()
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

  it('keeps counting what the oldest 3D models cost once they fall out of the record', async () => {
    const records = new ModelRecords(data, { historyEnabled: () => true, kept: 2 })
    const { service } = models({ records })
    for (const name of ['One', 'Two', 'Three']) await (await service.make(words(name))).done
    expect((await records.list()).map(model => model.name)).toEqual(['Three', 'Two'])
    expect((await records.monthCredits()).get('meshy-1')).toBe(90)
    expect((await new ModelRecords(data, { historyEnabled: () => true, kept: 2 }).monthCredits()).get('meshy-1')).toBe(90)
  })

  it('counts the month’s credits from the 1st by this computer’s clock, per account, a forgotten thread’s too', async () => {
    let now = new Date(2026, 10, 30, 23, 0).getTime()
    const { service, records } = models({ now: () => now })
    await (await service.make(words())).done
    await (await service.make(words('Lamp', { accountId: 'meshy-2' }))).done
    expect(Object.fromEntries(await records.monthCredits(new Date(now)))).toEqual({ 'meshy-1': 30, 'meshy-2': 30 })
    // Forgetting the thread takes its records, never what they cost this month (Bug Bot on #2593, L4).
    await records.forgetThreads(['thread-1'])
    expect(await records.list()).toEqual([])
    expect(Object.fromEntries(await recordsHere().monthCredits(new Date(now)))).toEqual({ 'meshy-1': 30, 'meshy-2': 30 })
    expect(await readFile(join(data, '3d-models.json'), 'utf8')).not.toContain('thread-1')
    // One still being made counts at its full cost, before its texture is asked for.
    const slow = models({ now: () => now, records, wait: async () => { slow.stop.abort() } })
    await (await slow.service.make(words('Stool'))).done
    expect((await records.monthCredits(new Date(now))).get('meshy-1')).toBe(60)
    // The next month starts at nothing.
    now = new Date(2026, 11, 1, 0, 30).getTime()
    expect(Object.fromEntries(await records.monthCredits(new Date(now)))).toEqual({})
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
