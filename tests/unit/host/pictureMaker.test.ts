// @vitest-environment node
/**
 * The headless host's side of its picture worker process (ADR-0202): what it sends the worker and what it keeps from it,
 * how it lets an idle worker end, stops one that does not answer, and gives up on one that keeps failing. The workers
 * here are a few lines each, written for the test; the real worker's copies are `headlessPictureEdge.test.ts`'s.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PictureMaker, PICTURES_WAITING_MAX } from '../../../src/host/pictureMaker'

const roots: string[] = []
const makers: PictureMaker[] = []
afterEach(async () => {
  await Promise.all(makers.splice(0).map(maker => maker.close()))
  for (const root of roots.splice(0)) if (dirname(root) === tmpdir() && root.includes('sotto-picture-maker-')) await rm(root, { recursive: true, force: true })
})

/**
 * A worker file whose every start adds a line to `starts`, and that answers each request with `answer`, a JavaScript
 * expression over `request`, or never when `answer` is absent.
 */
async function workerFile(answer?: string): Promise<{ path: string; starts: () => Promise<number> }> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-picture-maker-')); roots.push(root)
  const path = join(root, 'pictureWorker.cjs'), starts = join(root, 'starts')
  await writeFile(path, [
    `require('node:fs').appendFileSync(${JSON.stringify(starts)}, 'start\\n')`,
    answer === undefined ? `process.on('message', () => undefined)`
      : `process.on('message', request => { process.send({ id: request.id, copy: ${answer}, pid: process.pid }) })`,
  ].join('\n'))
  return { path, starts: async () => (await readFile(starts, 'utf8').catch(() => '')).split('\n').filter(Boolean).length }
}
const maker = (path: string, options: ConstructorParameters<typeof PictureMaker>[1] = {}) => { const made = new PictureMaker(path, options); makers.push(made); return made }
const PNG = 'data:image/png;base64,iVBORw0KGgo='

describe('the picture worker, from the host\'s side', () => {
  it('hands the worker PNGs and JPEGs alone, and counts only the copies its own process made', async () => {
    const worker = await workerFile(`'data:image/jpeg;base64,' + request.edge`)
    const pictures = maker(worker.path)
    await expect(pictures.reduce(PNG, 640)).resolves.toBe('data:image/jpeg;base64,640')
    await expect(pictures.reduce('data:image/jpeg;base64,/9j/', 320)).resolves.toBe('data:image/jpeg;base64,320')
    expect(pictures.made).toBe(2)
    // A GIF, a WebP and a JPEG carrying camera details never reach the worker: each is sent whole.
    const exif = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x0a, ...Buffer.from('Exif\0\0'), 0x00, 0x00, 0xff, 0xda, 0x00, 0x02])
    for (const url of ['data:image/gif;base64,R0lG', 'data:image/webp;base64,UklG', `data:image/jpeg;base64,${exif.toString('base64')}`]) await expect(pictures.reduce(url, 640)).resolves.toBeNull()
    expect(pictures.made).toBe(2)
    expect(await worker.starts()).toBe(1)
  })

  it('sends a picture whole at once past the waiting limit, and every waiting one whole when it closes', async () => {
    const worker = await workerFile()
    const pictures = maker(worker.path)
    const waiting = Array.from({ length: PICTURES_WAITING_MAX }, () => pictures.reduce(PNG, 640))
    await expect(pictures.reduce(PNG, 640)).resolves.toBeNull()
    await pictures.close()
    await expect(Promise.all(waiting)).resolves.toEqual(Array<null>(PICTURES_WAITING_MAX).fill(null))
    await expect(pictures.reduce(PNG, 640)).resolves.toBeNull()
  })

  it('lets an idle worker end and starts another for the next picture', async () => {
    const worker = await workerFile(`'data:image/jpeg;base64,AA'`)
    const pictures = maker(worker.path, { idleMs: 20 })
    await pictures.reduce(PNG, 640)
    expect(pictures.running).toBe(true)
    await expect.poll(() => pictures.running).toBe(false)
    await pictures.reduce(PNG, 640)
    expect(await worker.starts()).toBe(2)
  })

  it('stops a worker that does not answer in time, and after three in a row starts none', async () => {
    const worker = await workerFile()
    const events: string[] = []
    const pictures = maker(worker.path, { limitMs: 20, log: event => { events.push(event) } })
    for (let attempt = 0; attempt < 3; attempt++) await expect(pictures.reduce(PNG, 640)).resolves.toBeNull()
    expect(events).toEqual(['picture-worker-stopped', 'picture-worker-stopped', 'picture-worker-stopped', 'picture-worker-unavailable'])
    // The fourth picture is sent whole at once, with no worker started for it.
    const fourth = pictures.reduce(PNG, 640)
    expect(pictures.running).toBe(false)
    await expect(fourth).resolves.toBeNull()
    expect(events).toHaveLength(4)
  })

  it('keeps the first picture’s deadline when more are asked for while it waits (review)', async () => {
    const worker = await workerFile()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const events: string[] = []
      const pictures = maker(worker.path, { limitMs: 1_000, log: event => { events.push(event) } })
      const settled: string[] = []
      const first = pictures.reduce(PNG, 640).then(copy => { settled.push('first'); return copy })
      vi.advanceTimersByTime(900)
      const second = pictures.reduce(PNG, 640).then(copy => { settled.push('second'); return copy })
      // A second after the first was asked for, with no answer, the worker is stopped and both go whole. Had the second
      // started the clock again, nothing would have gone until 1.9 seconds.
      vi.advanceTimersByTime(100)
      await expect(first).resolves.toBeNull()
      await expect(second).resolves.toBeNull()
      expect(settled).toEqual(['first', 'second'])
      expect(events).toEqual(['picture-worker-stopped'])
    } finally { vi.useRealTimers() }
  })

  it('sends every picture whole when no worker was built', async () => {
    const missing = join(tmpdir(), 'sotto-picture-maker-none', 'pictureWorker.js')
    expect(PictureMaker.available(missing)).toBe(false)
    await expect(maker(missing).reduce(PNG, 640)).resolves.toBeNull()
  })
})
