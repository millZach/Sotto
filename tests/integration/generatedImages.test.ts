// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadMediaStore } from '../../src/main/agents/threadMedia'
import { cursorFixture } from '../fixtures/fakeCursorFixture'

/** A PNG header Sotto reads as a 4x3 picture: the signature, then IHDR. */
function png(): Buffer {
  const bytes = Buffer.alloc(40)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'ascii'); bytes.writeUInt32BE(4, 16); bytes.writeUInt32BE(3, 20)
  return bytes
}

describe('an image Cursor generates (ADR-0170)', () => {
  let f: Awaited<ReturnType<typeof cursorFixture>> | undefined
  const folders: string[] = []
  afterEach(async () => {
    const previous = f; f = undefined; await previous?.cleanup()
    await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
  })

  it('makes an image step while it works, then puts the picture it saved on the step by handle', async () => {
    const media = await mkdtemp(join(tmpdir(), 'sotto-generated-')); folders.push(media)
    const store = new ThreadMediaStore(media); await store.load()
    f = await cursorFixture(undefined, undefined, {}, { captureMediaFile: store.captureFile })
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    const id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Owl' })
    f.host.observeThreads?.([id])
    const image = async () => (await f!.host.snapshot()).threads.find(item => item.id === id)?.activities?.find(row => row.generates === 'image')
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Draw an owl' })

    await f.action(id, { type: 'image', text: 'An owl at an easel' })
    await expect.poll(async () => (await image())?.status).toBe('running')
    expect((await image())?.media).toBeUndefined()

    await writeFile(join(f.root, 'owl.png'), png())
    await f.action(id, { type: 'image', text: 'An owl at an easel', filePath: 'owl.png' })
    await expect.poll(async () => (await image())?.media?.length ?? 0).toBe(1)
    const done = (await image())!
    expect(done.status).toBe('completed')
    expect(done.title).toBe('Image: An owl at an easel')
    expect(done.media![0]).toEqual(expect.objectContaining({ id: 'm0', mimeType: 'image/png', width: 4, height: 3, source: 'generated' }))
    // The record names the picture; its bytes are read by handle.
    expect(JSON.stringify(done)).not.toContain(png().toString('base64'))
    expect(await store.read(done, 'm0')).toBe(`data:image/png;base64,${png().toString('base64')}`)
  })

  it('leaves a saved file that is not a picture off the step', async () => {
    const media = await mkdtemp(join(tmpdir(), 'sotto-generated-')); folders.push(media)
    const store = new ThreadMediaStore(media); await store.load()
    const reads: Promise<unknown>[] = []
    f = await cursorFixture(undefined, undefined, {}, { captureMediaFile: (path, source) => { const read = store.captureFile(path, source); reads.push(read); return read } })
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    const id = randomUUID()
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Owl' })
    f.host.observeThreads?.([id])
    await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'm1', text: 'Draw an owl' })
    await writeFile(join(f.root, 'notes.png'), 'not a picture')
    await f.action(id, { type: 'image', text: 'An owl', filePath: join(f.root, 'notes.png') })
    const image = async () => (await f!.host.snapshot()).threads.find(item => item.id === id)?.activities?.find(row => row.generates === 'image')
    await expect.poll(async () => (await image())?.status).toBe('completed')
    // The file was read, and what it read was no picture.
    await expect.poll(() => reads.length).toBe(1)
    expect(await reads[0]).toEqual([])
    expect((await image())?.media).toBeUndefined()
  })
})
