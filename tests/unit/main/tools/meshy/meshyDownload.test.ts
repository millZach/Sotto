// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DownloadError, downloadModelFile, modelFolder, type MeshyDownloadFetch } from '../../../../../src/main/tools/meshy/download'
import { startFakeMeshy, type FakeMeshy } from '../../../../fixtures/fakeMeshy'

/** A 3D model's files come from Meshy's file server only, capped, into the thread's own folder (ADR-0141; ticket 2). */
let meshy: FakeMeshy
let root: string
let outside: string
beforeEach(async () => {
  meshy = await startFakeMeshy()
  root = await mkdtemp(join(tmpdir(), 'sotto-meshy-thread-'))
  outside = await mkdtemp(join(tmpdir(), 'sotto-meshy-outside-'))
})
afterEach(async () => {
  await meshy.close()
  await Promise.all([root, outside].map(folder => rm(folder, { recursive: true, force: true })))
})

const fetcher: MeshyDownloadFetch = (url, init) => fetch(url, init)
const fileOf = (name: string) => `${meshy.base}/files/task-1/${name}?Expires=1&Signature=made-up`

async function problem(promise: Promise<unknown>): Promise<string> {
  try { await promise } catch (error) { if (error instanceof DownloadError) return error.problem; throw error }
  throw new Error('expected a refusal')
}

describe("a 3D model's files", () => {
  it('fetch a link on the file server into the folder, sending no key and following no redirect', async () => {
    const folder = await modelFolder(root, 'models')
    const asked: Parameters<MeshyDownloadFetch>[1][] = []
    await downloadModelFile((url, init) => { asked.push(init); return fetcher(url, init) }, fileOf('model.glb'), { root, folder, fileName: 'chair.glb' }, { assets: meshy.base })
    expect(await readFile(join(folder, 'chair.glb'))).toHaveLength(64)
    expect(asked).toEqual([expect.objectContaining({ method: 'GET', headers: {}, redirect: 'manual' })])
  })

  it('come only from assets.meshy.ai over HTTPS: any other link is refused and never fetched', async () => {
    const folder = await modelFolder(root, 'models')
    let fetched = 0
    const counting: MeshyDownloadFetch = async () => { fetched++; return new Response('x') }
    for (const address of ['http://assets.meshy.ai/x.glb', 'https://assets.meshy.ai.example.com/x.glb', 'https://api.meshy.ai/x.glb', 'https://user:pass@assets.meshy.ai/x.glb', 'file:///etc/passwd', 'not a link']) {
      expect(await problem(downloadModelFile(counting, address, { root, folder, fileName: 'x.glb' }))).toBe('refused')
    }
    expect(fetched).toBe(0)
    // The file server itself is let through.
    await downloadModelFile(async () => new Response('glb'), 'https://assets.meshy.ai/abc/model.glb?Expires=1', { root, folder, fileName: 'x.glb' })
    expect(await readFile(join(folder, 'x.glb'), 'utf8')).toBe('glb')
  })

  it('stop at the cap, whether Meshy says the length or not, and leave no part of the file', async () => {
    const folder = await modelFolder(root, 'models')
    meshy.behaviour.fileBytes = 2_000
    expect(await problem(downloadModelFile(fetcher, fileOf('model.glb'), { root, folder, fileName: 'a.glb' }, { assets: meshy.base, maxBytes: 1_000 }))).toBe('too-large')
    meshy.behaviour.chunked = true
    expect(await problem(downloadModelFile(fetcher, fileOf('model.glb'), { root, folder, fileName: 'b.glb' }, { assets: meshy.base, maxBytes: 1_000 }))).toBe('too-large')
    expect(await readdir(folder)).toEqual([])
  })

  it('say a file Meshy no longer has is gone, and one it would not send could not be reached', async () => {
    const folder = await modelFolder(root, 'models')
    for (const [status, word] of [[400, 'gone'], [403, 'gone'], [404, 'gone'], [500, 'unreachable'], [302, 'unreachable']] as const) {
      meshy.behaviour.answers.push({ route: 'file', status })
      expect(await problem(downloadModelFile(fetcher, fileOf('model.glb'), { root, folder, fileName: 'a.glb' }, { assets: meshy.base }))).toBe(word)
    }
    expect(await readdir(folder)).toEqual([])
  })

  it('never write over a file that is already there', async () => {
    const folder = await modelFolder(root, 'models')
    await writeFile(join(folder, 'chair.glb'), 'mine')
    expect(await problem(downloadModelFile(fetcher, fileOf('model.glb'), { root, folder, fileName: 'chair.glb' }, { assets: meshy.base }))).toBe('taken')
    expect(await readFile(join(folder, 'chair.glb'), 'utf8')).toBe('mine')
  })

  it("go only inside the thread's working folder, by name or through a link", async () => {
    for (const folder of ['../elsewhere', join(outside, 'models'), 'models/../../elsewhere']) expect(await problem(modelFolder(root, folder))).toBe('folder')
    await symlink(outside, join(root, 'linked'), 'junction')
    expect(await problem(modelFolder(root, 'linked'))).toBe('folder')
    expect(await problem(modelFolder(root, 'linked/models'))).toBe('folder')
    // A folder that was inside when the 3D model was asked for, and was swapped for a link since.
    const folder = await modelFolder(root, 'later')
    await rm(folder, { recursive: true })
    await symlink(outside, folder, 'junction')
    expect(await problem(downloadModelFile(fetcher, fileOf('model.glb'), { root, folder, fileName: 'a.glb' }, { assets: meshy.base }))).toBe('folder')
    for (const fileName of ['../a.glb', 'sub/a.glb', 'sub\\a.glb', '..', 'a:b.glb', ' a.glb']) {
      expect(await problem(downloadModelFile(fetcher, fileOf('model.glb'), { root, folder: await modelFolder(root, 'models'), fileName }, { assets: meshy.base }))).toBe('folder')
    }
    expect(await readdir(outside)).toEqual([])
    // A folder inside it, however deep, is made.
    await mkdir(join(root, 'art'), { recursive: true })
    expect(await modelFolder(root, 'art/3d/chairs')).toBe(join(await realpath(root), 'art', '3d', 'chairs'))
  })
})
