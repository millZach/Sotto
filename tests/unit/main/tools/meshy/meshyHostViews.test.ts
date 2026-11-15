// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hostModelViews } from '../../../../../src/main/tools/meshy/hostViews'
import type { ModelListSource } from '../../../../../src/main/tools/meshy/page'
import { ModelRecords, type ModelRecord } from '../../../../../src/main/tools/meshy/records'
import { MODEL_3D_HOST_BYTES_MAX, MODEL_3D_HOST_PART_BYTES, model3dHostBytesSchema, type Model3dHostNews } from '../../../../../src/shared/models3d'
import { glbBytes, selfContainedGlb } from '../../../../fixtures/glb'

/** A headless host's 3D models as a recorded desktop reads them (the Meshy plan's ticket 6, part 2). */
let root: string
let data: string
let outside: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-meshy-host-views-')))
  data = await mkdtemp(join(tmpdir(), 'sotto-meshy-host-views-data-'))
  outside = await realpath(await mkdtemp(join(tmpdir(), 'sotto-meshy-host-views-outside-')))
})
afterEach(async () => { await Promise.all([root, data, outside].map(folder => rm(folder, { recursive: true, force: true }))) })

const ACCOUNT = '22222222-2222-4222-8222-000000000001'
function record(id: string, change: Partial<ModelRecord> = {}): ModelRecord {
  return { id, threadId: 'thread-1', accountId: ACCOUNT, name: id, source: { kind: 'words', words: `A ${id}` }, root, folder: join(root, 'models'), formats: ['glb'],
    state: 'done', credits: 30, askedAt: '2026-11-15T09:00:00.000Z', files: [`${id}.glb`], job: {}, ...change }
}
function sourceOf(records: ModelRecords): ModelListSource {
  return {
    model: id => records.model(id), list: () => records.list(), remove: (id, may) => records.remove(id, may),
    progressOf: () => undefined, hasShape: () => false, shapeBytes: async () => null,
    accountNames: async () => new Map([[ACCOUNT, 'Studio']]),
  }
}
/** A GLB a little over one part, so it crosses the connection in two. */
const twoParts = (fill: number): Uint8Array => glbBytes({ asset: { version: '2.0' } }, new Uint8Array(MODEL_3D_HOST_PART_BYTES + 1_000).fill(fill))
const decoded = (data: string): Buffer => Buffer.from(data, 'base64')

describe('a host’s 3D models for a recorded desktop', () => {
  it('lists and views them by the host’s own IDs, with no path', async () => {
    const records = new ModelRecords(data, { historyEnabled: () => true })
    await mkdir(join(root, 'models'), { recursive: true })
    await writeFile(join(root, 'models', 'barrel.glb'), selfContainedGlb())
    await records.add(record('barrel'))
    const views = hostModelViews(sourceOf(records))
    const listed = await views.list()
    expect(listed).toMatchObject([{ id: 'barrel', threadId: 'thread-1', account: 'Studio', files: [{ name: 'barrel.glb', bytes: selfContainedGlb().byteLength }] }])
    expect(listed[0]).not.toHaveProperty('computer')
    expect(JSON.stringify(listed)).not.toContain(root)
    expect(await views.list('thread-2')).toEqual([])
    await expect(views.view('barrel')).resolves.toMatchObject({ id: 'barrel', state: 'done' })
    await expect(views.view('nothing')).resolves.toBeNull()
  })

  it('hands over a GLB in parts cut from the one file it checked, and refuses an unknown ID or a folder outside the thread’s', async () => {
    const records = new ModelRecords(data, { historyEnabled: () => true })
    const glb = twoParts(7)
    await mkdir(join(root, 'models'), { recursive: true })
    await writeFile(join(root, 'models', 'barrel.glb'), glb)
    await mkdir(join(outside, 'models'), { recursive: true })
    await writeFile(join(outside, 'models', 'away.glb'), selfContainedGlb())
    await records.add(record('barrel'))
    await records.add(record('away', { folder: join(outside, 'models') }))
    const views = hostModelViews(sourceOf(records))
    const first = model3dHostBytesSchema.parse(await views.bytes({ id: 'barrel', part: 'model', offset: 0 }, 'desktop'))!
    expect(first.total).toBe(glb.byteLength)
    expect(first.digest).toBe(createHash('sha256').update(glb).digest('hex'))
    expect(decoded(first.data).byteLength).toBe(MODEL_3D_HOST_PART_BYTES)
    // The file changes on disk; the rest still comes from what was checked.
    await writeFile(join(root, 'models', 'barrel.glb'), twoParts(9))
    const second = model3dHostBytesSchema.parse(await views.bytes({ id: 'barrel', part: 'model', offset: MODEL_3D_HOST_PART_BYTES, digest: first.digest }, 'desktop'))!
    expect(Buffer.concat([decoded(first.data), decoded(second.data)]).equals(Buffer.from(glb))).toBe(true)
    // With nothing held, a later part of a file that changed since its first is refused rather than mixed.
    await expect(views.bytes({ id: 'barrel', part: 'model', offset: MODEL_3D_HOST_PART_BYTES, digest: first.digest }, 'desktop')).resolves.toBeNull()
    await expect(views.bytes({ id: 'nothing', part: 'model', offset: 0 }, 'desktop')).resolves.toBeNull()
    await expect(views.bytes({ id: 'away', part: 'model', offset: 0 }, 'desktop')).resolves.toBeNull()
    await expect(views.bytes({ id: 'barrel', part: 'still', offset: 0 }, 'desktop')).resolves.toBeNull()
    views.close()
  })

  it('hands over nothing past the cap over the connection', async () => {
    const records = new ModelRecords(data, { historyEnabled: () => true })
    await mkdir(join(root, 'models'), { recursive: true })
    await writeFile(join(root, 'models', 'huge.glb'), glbBytes({ asset: { version: '2.0' } }, new Uint8Array(MODEL_3D_HOST_BYTES_MAX)))
    await records.add(record('huge'))
    await expect(hostModelViews(sourceOf(records)).bytes({ id: 'huge', part: 'model', offset: 0 }, 'desktop')).resolves.toBeNull()
  })

  it('removes the record only once its files are gone, never a file, and tells its listeners', async () => {
    const records = new ModelRecords(data, { historyEnabled: () => true })
    await mkdir(join(root, 'models'), { recursive: true })
    await writeFile(join(root, 'models', 'barrel.glb'), selfContainedGlb())
    await records.add(record('barrel'))
    const views = hostModelViews(sourceOf(records))
    const news: Model3dHostNews[] = []
    views.subscribe(item => { news.push(item) })
    await expect(views.remove('barrel')).resolves.toBe('files-there')
    await expect(records.model('barrel')).resolves.toBeDefined()
    await rm(join(root, 'models', 'barrel.glb'))
    await expect(views.remove('barrel')).resolves.toBe('removed')
    await expect(records.model('barrel')).resolves.toBeUndefined()
    await expect(views.remove('barrel')).resolves.toBe('no-record')
    views.removed(['forgotten'])
    expect(news).toEqual([{ removed: ['barrel'] }, { removed: ['forgotten'] }])
  })

  it('tells its listeners each change as a view with the thread that made it, while the record is there', async () => {
    const records = new ModelRecords(data, { historyEnabled: () => true })
    const making = record('lantern', { state: 'making', stage: 'shape', files: [] })
    const other = record('helmet', { threadId: 'thread-2', state: 'making', stage: 'shape', files: [] })
    await records.add(making)
    await records.add(other)
    const views = hostModelViews(sourceOf(records))
    const news: Model3dHostNews[] = []
    views.subscribe(item => { news.push(item) })
    views.changed(making, { percent: 40, secondsLeft: 30 })
    await expect.poll(() => news.length).toBe(1)
    expect(news[0]).toEqual({ changed: { threadId: 'thread-1', view: expect.objectContaining({ id: 'lantern', state: 'making', stage: 'shape', percent: 40 }) as unknown } })
    await records.forgetThreads(['thread-1'])
    // Its thread was forgotten: its next change is not told, and views go in order, so the next one told is the other's.
    views.changed(making, { percent: 50, secondsLeft: 20 })
    views.changed(other, undefined)
    await expect.poll(() => news.length).toBe(2)
    expect(news[1]).toMatchObject({ changed: { threadId: 'thread-2', view: { id: 'helmet' } } })
  })
})
