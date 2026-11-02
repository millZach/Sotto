// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { requestedCaptures, ThreadMediaStore } from '../../../src/main/agents/threadMedia'
import { readVideo, shownMedia, videoHandle, videoTypeOf } from '../../../src/main/agents/shownMedia'
import { MediaToolServer, SHOW_IN_THREAD_TOOL } from '../../../src/main/agents/mediaTools'
import { AGENT_VIDEO_MAX_BYTES } from '../../../src/shared/agentActivity'
import { agentThreadMediaPartSchema } from '../../../src/shared/agents'
import { agentControlFixture } from '../../fixtures/agentControlFixture'
import { pngHeader } from '../../fixtures/stagedImages'
import { workspaceFixture } from '../../fixtures/workspaceFixture'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))) })
async function folder(): Promise<string> { const made = await mkdtemp(join(tmpdir(), 'sotto-shown-media-')); folders.push(made); return made }
/** The first bytes of an MP4 (an `ftyp` box), a QuickTime movie and a WebM, padded to `size`. */
const mp4 = (size = 4096, brand = 'isom'): Buffer => { const bytes = Buffer.alloc(size, 7); bytes.writeUInt32BE(24, 0); bytes.write('ftyp', 4, 'latin1'); bytes.write(brand, 8, 'latin1'); return bytes }
const webm = (): Buffer => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm', 'latin1'), Buffer.alloc(2048, 3)])
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

describe('what Sotto captures on its own (ADR-0170, request-only)', () => {
  it('keeps an image the agent generated, and no tool result\'s picture, viewed picture or file', async () => {
    const root = await folder(), store = new ThreadMediaStore(join(root, 'media')); await store.load()
    const { captureMedia, captureMediaFile } = requestedCaptures(store)
    const picture = { mimeType: 'image/png', data: pngHeader(640, 400).toString('base64') }
    expect(captureMedia([picture], 'tool')).toEqual([])
    await writeFile(join(root, 'viewed.png'), pngHeader(32, 32))
    expect(await captureMediaFile(join(root, 'viewed.png'), 'tool')).toEqual([])
    expect(await captureMediaFile(join(root, 'viewed.png'), 'file')).toEqual([])
    expect(captureMedia([picture], 'generated')).toEqual([expect.objectContaining({ kind: 'image', width: 640, height: 400, source: 'generated' })])
    expect(await captureMediaFile(join(root, 'viewed.png'), 'generated')).toEqual([expect.objectContaining({ kind: 'image', source: 'generated' })])
  })
})

describe('a shown video', () => {
  it('is a video by its own bytes: MP4, QuickTime and WebM, and no other Matroska or anything else', () => {
    expect(videoTypeOf(mp4())).toBe('video/mp4')
    expect(videoTypeOf(mp4(64, 'qt  '))).toBe('video/quicktime')
    expect(videoTypeOf(webm())).toBe('video/webm')
    expect(videoTypeOf(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('matroska')]))).toBeUndefined()
    expect(videoTypeOf(pngHeader(1, 1))).toBeUndefined()
  })

  it('is named by the digest of its whole file, carries no path, and is read back only while it is still that file', async () => {
    const root = await folder()
    const path = join(root, 'recording.mp4'), bytes = mp4(20_000)
    await writeFile(path, bytes)
    const { mtimeMs } = await import('node:fs/promises').then(fs => fs.stat(path))
    const { handle, file } = (await videoHandle(path, 2, { path: 'recording.mp4', sizeBytes: bytes.byteLength, modifiedMs: mtimeMs }))!
    expect(handle).toEqual({ id: 'm2', digest: sha(bytes), kind: 'video', mimeType: 'video/mp4', sizeBytes: 20_000, name: 'recording.mp4', source: 'file' })
    expect(file).toEqual({ path, sizeBytes: 20_000, modifiedMs: mtimeMs })
    expect(await readVideo(file, 1_000, 500)).toEqual(bytes.subarray(1_000, 1_500))
    expect(await readVideo(file, 19_900, 500)).toEqual(bytes.subarray(19_900))
    expect(await readVideo(file, 20_000, 1)).toBeUndefined()
    // Written again, even with the same bytes, it is no longer the file the store remembers.
    await writeFile(path, bytes); await utimes(path, new Date(), new Date(mtimeMs + 5_000))
    expect(await readVideo(file, 0, 10)).toBeUndefined()
  })

  it('is remembered by the store on this host, across a restart, and forgotten when history is turned off', async () => {
    const directory = await folder()
    const store = new ThreadMediaStore(directory); await store.load()
    const file = { path: '/repo/test-results/flow.webm', sizeBytes: 2_000, modifiedMs: 5 }
    store.keepVideo('c'.repeat(64), file)
    expect(store.videoFile('c'.repeat(64), 2_000)).toEqual(expect.objectContaining(file))
    expect(store.videoFile('c'.repeat(64), 2_001)).toBeUndefined()
    await store.sweep()
    const again = new ThreadMediaStore(directory); await again.load()
    expect(again.videoFile('c'.repeat(64), 2_000)).toEqual(expect.objectContaining(file))
    await again.clear()
    expect(again.videoFile('c'.repeat(64), 2_000)).toBeUndefined()
  })

  it('is no handle when it is too large, not a video, or changed while it was read', async () => {
    const root = await folder()
    const path = join(root, 'clip.mp4'); await writeFile(path, mp4())
    expect(await videoHandle(path, 0, { path: 'clip.mp4', sizeBytes: AGENT_VIDEO_MAX_BYTES + 1, modifiedMs: 0 })).toBeUndefined()
    expect(await videoHandle(path, 0, { path: 'clip.mp4', sizeBytes: 4096, modifiedMs: 1 })).toBeUndefined()
    const text = join(root, 'fake.mp4'); await writeFile(text, 'not a video at all')
    expect(await videoHandle(text, 0, { path: 'fake.mp4', sizeBytes: 18, modifiedMs: 0 })).toBeUndefined()
  })
})

describe('the files an agent shows', () => {
  it('keeps each picture in the store and each video by its file, in the order named, and says why the rest are not shown', async () => {
    const root = await folder(), media = new ThreadMediaStore(await folder()); await media.load()
    await mkdir(join(root, 'test-results'), { recursive: true })
    await writeFile(join(root, 'test-results', 'flow.webm'), webm())
    await writeFile(join(root, 'test-results', 'shot.png'), pngHeader(640, 480))
    await writeFile(join(root, 'notes.md'), 'words')
    const elsewhere = join(await folder(), 'outside.png'); await writeFile(elsewhere, pngHeader(8, 8))
    const found = await shownMedia(root, ['test-results/flow.webm', 'test-results/shot.png', 'notes.md', 'gone.png', elsewhere, 'test-results/shot.png'], media)
    expect(found.media).toEqual([
      expect.objectContaining({ id: 'm0', kind: 'video', mimeType: 'video/webm', name: 'flow.webm', source: 'file' }),
      expect.objectContaining({ id: 'm1', kind: 'image', mimeType: 'image/png', width: 640, height: 480, name: 'shot.png', source: 'file' }),
      expect.objectContaining({ id: 'm2', kind: 'image', name: 'outside.png' }),
    ])
    expect(found.refused).toEqual([{ path: 'notes.md', reason: 'not-media' }, { path: 'gone.png', reason: 'missing' }])
    // No handle carries a path: the store remembers where the video is, by its digest.
    expect(JSON.stringify(found.media)).not.toContain(root)
    expect(media.videoFile(found.media[0]!.digest, found.media[0]!.sizeBytes)?.path).toBe(join(root, 'test-results', 'flow.webm'))
    expect(await media.read({ id: 'a', turnId: 't', sequence: 0, kind: 'tool', status: 'completed', title: 'T', media: found.media }, 'm1')).toBe(`data:image/png;base64,${pngHeader(640, 480).toString('base64')}`)
  })

  it('refuses a video past the limit and a relative path with no folder', async () => {
    const root = await folder(), media = new ThreadMediaStore(await folder()); await media.load()
    const big = join(root, 'long.mp4'); await writeFile(big, mp4()); await import('node:fs/promises').then(fs => fs.truncate(big, AGENT_VIDEO_MAX_BYTES + 1))
    expect((await shownMedia(root, ['long.mp4'], media)).refused).toEqual([{ path: 'long.mp4', reason: 'too-large' }])
    expect((await shownMedia(undefined, ['shot.png'], media)).refused).toEqual([{ path: 'shot.png', reason: 'missing' }])
    // A network path is never looked at: reading it would reach another computer.
    expect((await shownMedia(root, ['\\\\server\\share\\shot.png', '//server/share/shot.png'], media)).refused)
      .toEqual([{ path: '\\\\server\\share\\shot.png', reason: 'not-local' }, { path: '//server/share/shot.png', reason: 'not-local' }])
  })
})

describe('a turn that wrote pictures and a video, through the workspace, the media tool and the coordinator', () => {
  it('shows nothing on its own, and one step with them once the agent calls show_in_thread; its video is read in parts while it is still the file', async () => {
    const f = await workspaceFixture(); folders.push(f.root)
    const media = new ThreadMediaStore(join(f.root, 'media')); await media.load()
    f.host.keepShownMedia(media)
    const tools = new MediaToolServer({ admits: threadId => f.host.admitsShownMedia(threadId), show: (threadId, input) => f.host.showMedia(threadId, input) })
    const project = f.adapters.codex.state.projects[0]!.path!
    execFileSync('git', ['init', '-q'], { cwd: project })
    await writeFile(join(project, '.gitignore'), 'test-results/\n')
    const control = await agentControlFixture({ host: f.host, directory: f.root, credentialOptions: { mode: 'unavailable' }, control: { threadMedia: media } })
    try {
      await control.control.start(); await control.control.command({ type: 'connect' })
      const thread = control.control.get().host.threads.find(item => item.providerId === 'codex')!
      expect((await control.control.command({ type: 'manual-send', threadId: thread.id, draftId: randomUUID(), text: 'Record the sign-up flow and show it to me' })).error).toBeNull()
      const session = f.adapters.codex.state.threads.find(item => item.status === 'running')!
      // The agent writes a screenshot and a recording into an ignored folder, then its turn ends.
      await mkdir(join(project, 'test-results'), { recursive: true })
      const video = mp4(9 * 1024 * 1024)
      await writeFile(join(project, 'test-results', 'signup.png'), pngHeader(1280, 800))
      await writeFile(join(project, 'test-results', 'signup.mp4'), video)
      session.status = 'idle'; f.adapters.codex.emit()
      await control.control.command({ type: 'observe-threads', threadIds: [thread.id] })
      const step = () => control.control.threadDetail(thread.id)?.activities?.find(record => record.id.startsWith('sotto-shown-') || record.id.startsWith('sotto-written-'))
      // Written files are not looked for: the turn's end adds nothing.
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(step()).toBeUndefined()
      expect((await tools.mcpServer(thread.id))?.name).toBe('sotto_media')
      const answer = await tools.call(thread.id, SHOW_IN_THREAD_TOOL, { paths: ['test-results/signup.png', 'test-results/signup.mp4', 'test-results/missing.png'], title: 'The sign-up flow' })
      expect(answer).toEqual({ content: [{ type: 'text', text: 'Shown in the thread as "The sign-up flow": 2 files. Not shown: test-results/missing.png (there is no such file).' }] })
      await expect.poll(step, { timeout: 15_000 }).toBeDefined()
      const shown = step()!
      expect(shown).toMatchObject({ kind: 'tool', status: 'completed', title: 'The sign-up flow' })
      expect(shown.media!.map(item => item.name)).toEqual(['signup.png', 'signup.mp4'])
      const handle = shown.media!.find(item => item.kind === 'video')!
      expect(handle).toMatchObject({ mimeType: 'video/mp4', sizeBytes: video.byteLength, digest: sha(video) })
      // Two parts of 8 MiB: the second holds the rest.
      const parts = [0, 1].map(part => control.control.threadMediaPart({ threadId: thread.id, activityId: shown.id, mediaId: handle.id, part }))
      const [first, second] = await Promise.all(parts)
      expect(agentThreadMediaPartSchema.parse(first)).toMatchObject({ part: 0, parts: 2, sizeBytes: video.byteLength, digest: sha(video) })
      // Compared by digest: a byte-by-byte comparison of 9 MiB is most of a test's time.
      expect(sha(Buffer.concat([Buffer.from(first!.data, 'base64'), Buffer.from(second!.data, 'base64')]))).toBe(sha(video))
      expect(await control.control.threadMediaPart({ threadId: thread.id, activityId: shown.id, mediaId: handle.id, part: 2 })).toBeNull()
      // Once the agent writes over it, the file is no longer the video the step names.
      await writeFile(join(project, 'test-results', 'signup.mp4'), mp4(4096)); await utimes(join(project, 'test-results', 'signup.mp4'), new Date(), new Date(Date.now() + 5_000))
      expect(await control.control.threadMediaPart({ threadId: thread.id, activityId: shown.id, mediaId: handle.id, part: 0 })).toBeNull()
      // A new turn's call before that turn has a record of its own goes with the new turn, not the last one's records.
      expect((await control.control.command({ type: 'manual-send', threadId: thread.id, draftId: randomUUID(), text: 'Show me the screenshot again' })).error).toBeNull()
      const newest = () => control.control.threadDetail(thread.id)?.messages.findLast(message => message.role === 'user' && message.text === 'Show me the screenshot again')?.id
      await expect.poll(newest, { timeout: 15_000 }).toBeDefined()
      expect((await tools.call(thread.id, SHOW_IN_THREAD_TOOL, { paths: ['test-results/signup.png'], title: 'Again' })).isError).toBeFalsy()
      const again = () => control.control.threadDetail(thread.id)?.activities?.find(record => record.title === 'Again')
      await expect.poll(again, { timeout: 15_000 }).toBeDefined()
      expect(again()).toMatchObject({ turnId: newest(), afterMessageId: newest() })
      // A call that names nothing Sotto shows shows nothing and says why; a bad call says what to send.
      expect(await tools.call(thread.id, SHOW_IN_THREAD_TOOL, { paths: ['.gitignore'], title: 'Ignore list' })).toEqual({ isError: true, content: [{ type: 'text', text: 'Nothing was shown. .gitignore (it is not a picture or video Sotto shows).' }] })
      expect((await tools.call(thread.id, SHOW_IN_THREAD_TOOL, { paths: [] , title: 'x' })).isError).toBe(true)
      expect((await tools.call('no-such-thread', SHOW_IN_THREAD_TOOL, { paths: ['a.png'], title: 'x' })).content).toEqual([{ type: 'text', text: 'This thread cannot show pictures. Nothing was shown.' }])
    } finally { await tools.close(); await control.dispose(); await f.stop() }
  })
})
