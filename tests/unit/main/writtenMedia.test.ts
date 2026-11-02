// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadMediaStore } from '../../../src/main/agents/threadMedia'
import { listMediaFiles, readVideo, videoHandle, videoTypeOf, writtenMedia, writtenSince } from '../../../src/main/agents/writtenMedia'
import { AGENT_VIDEO_MAX_BYTES } from '../../../src/shared/agentActivity'
import { agentThreadMediaPartSchema } from '../../../src/shared/agents'
import { agentControlFixture } from '../../fixtures/agentControlFixture'
import { pngHeader } from '../../fixtures/stagedImages'
import { workspaceFixture } from '../../fixtures/workspaceFixture'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))) })
async function folder(): Promise<string> { const made = await mkdtemp(join(tmpdir(), 'sotto-written-media-')); folders.push(made); return made }
/** A Git working copy that ignores `test-results/`, as a project with Playwright does. */
async function repository(): Promise<string> {
  const root = await folder()
  execFileSync('git', ['init', '-q'], { cwd: root })
  await writeFile(join(root, '.gitignore'), 'test-results/\nnode_modules/\n')
  return root
}
/** The first bytes of an MP4 (an `ftyp` box), a QuickTime movie and a WebM, padded to `size`. */
const mp4 = (size = 4096, brand = 'isom'): Buffer => { const bytes = Buffer.alloc(size, 7); bytes.writeUInt32BE(24, 0); bytes.write('ftyp', 4, 'latin1'); bytes.write(brand, 8, 'latin1'); return bytes }
const webm = (): Buffer => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm', 'latin1'), Buffer.alloc(2048, 3)])
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

describe('the picture and video files a turn could have written', () => {
  it('lists changed and new ones, git-ignored ones too, and never node_modules or a committed one', async () => {
    const root = await repository()
    await writeFile(join(root, 'committed.png'), pngHeader(2, 2))
    execFileSync('git', ['add', '.'], { cwd: root }); execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], { cwd: root })
    await mkdir(join(root, 'test-results', 'run'), { recursive: true }); await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(root, 'test-results', 'run', 'Shot.PNG'), pngHeader(4, 3))
    await writeFile(join(root, 'test-results', 'run', 'recording.webm'), webm())
    await writeFile(join(root, 'node_modules', 'pkg', 'icon.png'), pngHeader(1, 1))
    await writeFile(join(root, 'new.gif'), Buffer.from('GIF89a'))
    await writeFile(join(root, 'notes.txt'), 'words')
    expect((await listMediaFiles(root))!.sort()).toEqual(['new.gif', 'test-results/run/Shot.PNG', 'test-results/run/recording.webm'])
    // Changed since the last commit, staged or not, it is one a turn could have written.
    await writeFile(join(root, 'committed.png'), pngHeader(3, 3))
    expect(await listMediaFiles(root)).toContain('committed.png')
    execFileSync('git', ['add', 'committed.png', 'new.gif'], { cwd: root })
    expect((await listMediaFiles(root))!.sort()).toEqual(['committed.png', 'new.gif', 'test-results/run/Shot.PNG', 'test-results/run/recording.webm'])
  })

  it('lists nothing in a folder that is no Git working copy', async () => {
    expect(await listMediaFiles(await folder())).toBeUndefined()
  })

  it('keeps those changed since the turn began, newest first, at most eight', async () => {
    const root = await folder()
    const since = Date.now()
    await writeFile(join(root, 'old.png'), pngHeader(1, 1)); await utimes(join(root, 'old.png'), new Date(since - 60_000), new Date(since - 60_000))
    for (let index = 0; index < 10; index++) {
      await writeFile(join(root, `shot-${index}.png`), pngHeader(1, 1, index))
      await utimes(join(root, `shot-${index}.png`), new Date(since + index * 1_000), new Date(since + index * 1_000))
    }
    const found = await writtenSince(root, ['old.png', 'gone.png', ...Array.from({ length: 10 }, (_, index) => `shot-${index}.png`)], since)
    expect(found.map(file => file.path)).toEqual(['shot-9.png', 'shot-8.png', 'shot-7.png', 'shot-6.png', 'shot-5.png', 'shot-4.png', 'shot-3.png', 'shot-2.png'])
  })
})

describe('a written video', () => {
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

describe('what a turn wrote', () => {
  it('keeps each picture in the store and each video by its file, newest first, numbered in that order', async () => {
    const root = await repository(), media = new ThreadMediaStore(await folder()); await media.load()
    const since = Date.now() - 1_000
    await mkdir(join(root, 'test-results'), { recursive: true })
    await writeFile(join(root, 'test-results', 'shot.png'), pngHeader(640, 480)); await utimes(join(root, 'test-results', 'shot.png'), new Date(), new Date(since + 100))
    await writeFile(join(root, 'test-results', 'flow.webm'), webm()); await utimes(join(root, 'test-results', 'flow.webm'), new Date(), new Date(since + 200))
    await writeFile(join(root, 'broken.mp4'), 'not a video'); await utimes(join(root, 'broken.mp4'), new Date(), new Date(since + 300))
    const found = (await writtenMedia(root, since, media))!
    expect(found.changes).toEqual([{ path: 'test-results/flow.webm', kind: 'Write' }, { path: 'test-results/shot.png', kind: 'Write' }])
    expect(found.media).toEqual([
      expect.objectContaining({ id: 'm0', kind: 'video', mimeType: 'video/webm', name: 'flow.webm', source: 'file' }),
      expect.objectContaining({ id: 'm1', kind: 'image', mimeType: 'image/png', width: 640, height: 480, name: 'shot.png', source: 'file' }),
    ])
    // No handle carries a path: the store remembers where the video is, by its digest.
    expect(JSON.stringify(found.media)).not.toContain(root)
    expect(media.videoFile(found.media[0]!.digest, found.media[0]!.sizeBytes)?.path).toBe(join(root, 'test-results', 'flow.webm'))
    expect(await media.read({ id: 'a', turnId: 't', sequence: 0, kind: 'file-change', status: 'completed', title: 'T', media: found.media }, 'm1')).toBe(`data:image/png;base64,${pngHeader(640, 480).toString('base64')}`)
  })

  it('is nothing when the turn wrote no picture or video', async () => {
    const root = await repository(), media = new ThreadMediaStore(await folder()); await media.load()
    await writeFile(join(root, 'notes.md'), 'words')
    expect(await writtenMedia(root, Date.now() - 1_000, media)).toBeUndefined()
  })
})

describe('a turn that wrote pictures and a video, through the workspace and the coordinator', () => {
  it('ends with one step that shows them, and its video is read in parts while it is still the file', async () => {
    const f = await workspaceFixture(); folders.push(f.root)
    const media = new ThreadMediaStore(join(f.root, 'media')); await media.load()
    f.host.keepWrittenMedia(media)
    const project = f.adapters.codex.state.projects[0]!.path!
    execFileSync('git', ['init', '-q'], { cwd: project })
    await writeFile(join(project, '.gitignore'), 'test-results/\n')
    const control = await agentControlFixture({ host: f.host, directory: f.root, credentialOptions: { mode: 'unavailable' }, control: { threadMedia: media } })
    try {
      await control.control.start(); await control.control.command({ type: 'connect' })
      const thread = control.control.get().host.threads.find(item => item.providerId === 'codex')!
      await writeFile(join(project, 'before.png'), pngHeader(1, 1)); await utimes(join(project, 'before.png'), new Date(), new Date(Date.now() - 60_000))
      expect((await control.control.command({ type: 'manual-send', threadId: thread.id, draftId: randomUUID(), text: 'Record the sign-up flow' })).error).toBeNull()
      const session = f.adapters.codex.state.threads.find(item => item.status === 'running')!
      // The agent writes a screenshot and a recording into an ignored folder, then its turn ends.
      await mkdir(join(project, 'test-results'), { recursive: true })
      const video = mp4(9 * 1024 * 1024)
      await writeFile(join(project, 'test-results', 'signup.png'), pngHeader(1280, 800))
      await writeFile(join(project, 'test-results', 'signup.mp4'), video)
      session.status = 'idle'; f.adapters.codex.emit()
      await control.control.command({ type: 'observe-threads', threadIds: [thread.id] })
      const step = () => control.control.threadDetail(thread.id)?.activities?.find(record => record.id.startsWith('sotto-written-'))
      await expect.poll(step, { timeout: 15_000 }).toBeDefined()
      const written = step()!
      expect(written).toMatchObject({ kind: 'file-change', status: 'completed', title: 'Pictures and videos it wrote', afterMessageId: expect.any(String) })
      expect(written.changes!.map(change => change.path).sort()).toEqual(['test-results/signup.mp4', 'test-results/signup.png'])
      const handle = written.media!.find(item => item.kind === 'video')!
      expect(handle).toMatchObject({ mimeType: 'video/mp4', sizeBytes: video.byteLength, digest: sha(video) })
      // Two parts of 8 MiB: the second holds the rest.
      const parts = [0, 1].map(part => control.control.threadMediaPart({ threadId: thread.id, activityId: written.id, mediaId: handle.id, part }))
      const [first, second] = await Promise.all(parts)
      expect(agentThreadMediaPartSchema.parse(first)).toMatchObject({ part: 0, parts: 2, sizeBytes: video.byteLength, digest: sha(video) })
      // Compared by digest: a byte-by-byte comparison of 9 MiB is most of a test's time.
      expect(sha(Buffer.concat([Buffer.from(first!.data, 'base64'), Buffer.from(second!.data, 'base64')]))).toBe(sha(video))
      expect(await control.control.threadMediaPart({ threadId: thread.id, activityId: written.id, mediaId: handle.id, part: 2 })).toBeNull()
      // Once the agent writes over it, the file is no longer the video the step names.
      await writeFile(join(project, 'test-results', 'signup.mp4'), mp4(4096)); await utimes(join(project, 'test-results', 'signup.mp4'), new Date(), new Date(Date.now() + 5_000))
      expect(await control.control.threadMediaPart({ threadId: thread.id, activityId: written.id, mediaId: handle.id, part: 0 })).toBeNull()
    } finally { await control.dispose(); await f.stop() }
  })
})
