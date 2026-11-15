// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MeshyApi, MeshyApiError, retryAfter, type MeshyApiFetch } from '../../../../../src/main/tools/meshy/api'
import { FAKE_MESHY_KEY, startFakeMeshy, type FakeMeshy } from '../../../../fixtures/fakeMeshy'

/** Meshy's API behind one adapter (ADR-0141; the Meshy plan's ticket 2), against a local fake. Nothing reaches Meshy. */
let meshy: FakeMeshy
beforeEach(async () => { meshy = await startFakeMeshy() })
afterEach(async () => { await meshy.close() })

const realFetch: MeshyApiFetch = (url, init) => fetch(url, init)
const api = (key = FAKE_MESHY_KEY, fetcher: MeshyApiFetch = realFetch) => new MeshyApi(fetcher, key, { base: meshy.base })

async function problem(promise: Promise<unknown>): Promise<string> {
  try { await promise } catch (error) { if (error instanceof MeshyApiError) return error.problem; throw error }
  throw new Error('expected a refusal')
}

describe("Meshy's API", () => {
  it('goes to api.meshy.ai unless told otherwise, with the key as a bearer token and no redirect followed', async () => {
    const asked: { url: string; init: Parameters<MeshyApiFetch>[1] }[] = []
    const fetcher: MeshyApiFetch = async (url, init) => { asked.push({ url, init }); return Response.json({ result: 'task-1' }, { status: 202 }) }
    expect(await new MeshyApi(fetcher, FAKE_MESHY_KEY).createPreview({ words: 'a small wooden chair' })).toBe('task-1')
    expect(asked[0]!.url).toBe('https://api.meshy.ai/openapi/v2/text-to-3d')
    expect(asked[0]!.init).toMatchObject({ method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${FAKE_MESHY_KEY}`, 'Content-Type': 'application/json' } })
  })

  it('makes a shape from words, then textures it in the formats asked for, and reads each task until it ends', async () => {
    const preview = await api().createPreview({ words: 'a small wooden chair', triangles: 5_000 })
    expect(meshy.tasks.get(preview)!.body).toEqual({ mode: 'preview', prompt: 'a small wooden chair', target_formats: ['glb'], should_remesh: true, topology: 'triangle', target_polycount: 5_000 })
    expect(await api().task('preview', preview)).toMatchObject({ status: 'waiting', files: {} })
    const shaped = await api().task('preview', preview)
    expect(shaped).toMatchObject({ status: 'made', progress: 100, credits: 20, pollAfterMs: 5_000 })
    const refine = await api().createRefine(preview, ['glb', 'usdz', 'obj'])
    expect(meshy.tasks.get(refine)!.body).toEqual({ mode: 'refine', preview_task_id: preview, target_formats: ['glb', 'usdz', 'obj'] })
    await api().task('refine', refine)
    const made = await api().task('refine', refine)
    expect(made.status).toBe('made')
    expect(Object.keys(made.files).sort()).toEqual(['glb', 'mtl', 'obj', 'usdz'])
    expect(made.still).toMatch(/preview\.png/u)
  })

  it('makes a model from a photo sent as a data address, and refuses any other kind of photo before sending it', async () => {
    const photo = `data:image/png;base64,${Buffer.from('made-up photo').toString('base64')}`
    const id = await api().createFromPhoto({ photo, formats: ['glb', 'usdz'] })
    expect(meshy.tasks.get(id)!.body).toEqual({ image_url: photo, should_texture: true, target_formats: ['glb', 'usdz'] })
    const before = meshy.requests.length
    for (const other of ['https://example.com/photo.png', 'data:image/svg+xml;base64,PHN2Zz4=', `data:image/png;base64,${'A'.repeat(28_000_000)}`]) {
      expect(await problem(api().createFromPhoto({ photo: other, formats: ['glb'] }))).toBe('rejected')
    }
    expect(await problem(api().createPreview({ words: 'x'.repeat(801) }))).toBe('rejected')
    expect(await problem(api().createPreview({ words: '   ' }))).toBe('rejected')
    expect(meshy.requests.length).toBe(before)
  })

  it('says in one word what went wrong, and never what Meshy wrote', async () => {
    expect(await problem(api('msy_not_this_one').createPreview({ words: 'a chair' }))).toBe('refused')
    const answers: [number, string][] = [[402, 'no-credits'], [403, 'refused'], [400, 'rejected'], [422, 'rejected'], [409, 'rejected'], [429, 'busy'], [500, 'unreachable'], [503, 'unreachable']]
    for (const [status, word] of answers) {
      meshy.behaviour.answers.push({ route: 'create', status })
      const error = await api().createPreview({ words: 'a chair' }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(MeshyApiError)
      expect((error as MeshyApiError).problem).toBe(word)
      expect((error as Error).message).not.toMatch(/made-up|msy_|127\.0\.0\.1/u)
    }
    expect(await problem(api().task('preview', 'no-such-task'))).toBe('gone')
    expect(await problem(api().task('preview', '../balance'))).toBe('rejected')
  })

  it('treats a redirect and an answer it cannot read as failures rather than following or guessing', async () => {
    const redirecting: MeshyApiFetch = async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } })
    expect(await problem(api(FAKE_MESHY_KEY, redirecting).createPreview({ words: 'a chair' }))).toBe('unreachable')
    const garbled: MeshyApiFetch = async () => new Response('not json', { status: 202 })
    expect(await problem(api(FAKE_MESHY_KEY, garbled).createPreview({ words: 'a chair' }))).toBe('unreadable')
    const unreachable: MeshyApiFetch = async () => { throw new Error('offline') }
    expect(await problem(api(FAKE_MESHY_KEY, unreachable).task('preview', 'task-1'))).toBe('unreachable')
  })

  it('paces on Retry-After, in seconds or as a date, within bounds, and five seconds when Meshy does not say', async () => {
    meshy.behaviour.retryAfter = '12'
    const id = await api().createPreview({ words: 'a chair' })
    expect((await api().task('preview', id)).pollAfterMs).toBe(12_000)
    meshy.behaviour.answers.push({ route: 'read', status: 429, retryAfter: '7' })
    const busy = await api().task('preview', id).catch((caught: unknown) => caught) as MeshyApiError
    expect([busy.problem, busy.retryAfterMs]).toEqual(['busy', 7_000])
    const at = (value: string) => retryAfter(new Response(null, { headers: { 'Retry-After': value } }), Date.parse('2026-11-15T12:00:00Z'))
    expect(at('Sun, 15 Nov 2026 12:00:30 GMT')).toBe(30_000)
    expect(at('0')).toBe(1_000)
    expect(at('86400')).toBe(600_000)
    expect(at('soon')).toBeUndefined()
  })
})
