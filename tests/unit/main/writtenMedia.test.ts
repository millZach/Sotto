// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadMediaStore } from '../../../src/main/agents/threadMedia'
import { listMediaFiles, writtenMedia, writtenSince } from '../../../src/main/agents/writtenMedia'
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
const webm = (): Buffer => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm', 'latin1'), Buffer.alloc(2048, 3)])

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

describe('a turn that wrote pictures, through the workspace and the coordinator (ADR-0170, part 7)', () => {
  /** A thread whose turn is sent, writes a screenshot and then ends, with the switch as `wanted` says at each point. */
  async function turn(wanted: { on: boolean }, whileWorking: () => void = () => undefined) {
    const f = await workspaceFixture(); folders.push(f.root)
    const media = new ThreadMediaStore(join(f.root, 'media')); await media.load()
    f.host.keepWrittenMedia(media, () => wanted.on)
    const project = f.adapters.codex.state.projects[0]!.path!
    execFileSync('git', ['init', '-q'], { cwd: project })
    await writeFile(join(project, '.gitignore'), 'test-results/\n')
    const control = await agentControlFixture({ host: f.host, directory: f.root, credentialOptions: { mode: 'unavailable' }, control: { threadMedia: media } })
    await control.control.start(); await control.control.command({ type: 'connect' })
    const thread = control.control.get().host.threads.find(item => item.providerId === 'codex')!
    await writeFile(join(project, 'before.png'), pngHeader(1, 1)); await utimes(join(project, 'before.png'), new Date(), new Date(Date.now() - 60_000))
    expect((await control.control.command({ type: 'manual-send', threadId: thread.id, draftId: randomUUID(), text: 'Take a screenshot' })).error).toBeNull()
    const session = f.adapters.codex.state.threads.find(item => item.status === 'running')!
    await mkdir(join(project, 'test-results'), { recursive: true })
    await writeFile(join(project, 'test-results', 'signup.png'), pngHeader(1280, 800))
    whileWorking()
    session.status = 'idle'; f.adapters.codex.emit()
    await control.control.command({ type: 'observe-threads', threadIds: [thread.id] })
    return { step: () => control.control.threadDetail(thread.id)?.activities?.find(record => record.id.startsWith('sotto-written-')), stop: async () => { await control.dispose(); await f.stop() } }
  }

  it('with the switch on, ends with one step that shows what it wrote', async () => {
    const { step, stop } = await turn({ on: true })
    try {
      await expect.poll(step, { timeout: 15_000 }).toBeDefined()
      expect(step()).toMatchObject({ kind: 'file-change', status: 'completed', title: 'Pictures and videos it wrote', afterMessageId: expect.any(String) })
      expect(step()!.changes).toEqual([{ path: 'test-results/signup.png', kind: 'Write' }])
    } finally { await stop() }
  })

  it('with the switch off, looks at nothing', async () => {
    const { step, stop } = await turn({ on: false })
    try {
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(step()).toBeUndefined()
    } finally { await stop() }
  })

  it('turned off while the turn works, looks at nothing when it ends', async () => {
    const wanted = { on: true }
    const { step, stop } = await turn(wanted, () => { wanted.on = false })
    try {
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(step()).toBeUndefined()
    } finally { await stop() }
  })
})
