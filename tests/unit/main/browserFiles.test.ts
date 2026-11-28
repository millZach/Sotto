// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { BROWSER_FILES_KEPT_MS, BrowserFiles, UPLOAD_FILES_MAX, uploadPaths } from '../../../src/main/tools/browserFiles'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sotto-browser-files-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('browser files (ADR-0220)', () => {
  it('keeps a saved picture in a folder named by a hash of the thread, never by its ID', async () => {
    const files = new BrowserFiles(join(root, 'browser-files'))
    const path = await files.save('thread-secret-name', 'screenshot', 'png', Buffer.from('png'))
    expect(path.startsWith(files.folder('thread-secret-name'))).toBe(true)
    expect(path).not.toContain('thread-secret-name')
    expect(basename(path)).toMatch(/^screenshot-\d{8}-\d{6}-[0-9a-f]{6}\.png$/u)
    expect(await readFile(path, 'utf8')).toBe('png')
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(files.folder('another')).not.toBe(files.folder('thread-secret-name'))
  })

  it('removes what is older than a week, and the folders it leaves empty', async () => {
    const files = new BrowserFiles(join(root, 'browser-files'))
    const old = await files.save('a', 'recording', 'webm', Buffer.from('old'))
    const kept = await files.save('b', 'screenshot', 'png', Buffer.from('new'))
    const now = Date.now()
    const longAgo = new Date(now - BROWSER_FILES_KEPT_MS - 60_000)
    await utimes(old, longAgo, longAgo)
    await files.sweep(now)
    await expect(stat(old)).rejects.toThrow()
    await expect(stat(files.folder('a'))).rejects.toThrow()
    expect((await stat(kept)).isFile()).toBe(true)
  })

  it('sweeps nothing when there is no folder yet', async () => {
    await expect(new BrowserFiles(join(root, 'missing')).sweep()).resolves.toBeUndefined()
  })
})

describe('files an agent may upload (ADR-0220, decision 5)', () => {
  it('takes files in the thread folder by relative or absolute path, and ones Sotto saved for the thread', async () => {
    const folder = join(root, 'work'); const saved = join(root, 'saved')
    await mkdir(join(folder, 'docs'), { recursive: true }); await mkdir(saved)
    await writeFile(join(folder, 'docs', 'a.txt'), 'a'); await writeFile(join(saved, 'shot.png'), 'b')
    const result = await uploadPaths(['docs/a.txt', join(saved, 'shot.png')], folder, saved)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.paths.map(path => basename(path))).toEqual(['a.txt', 'shot.png'])
  })

  it('refuses a file outside the thread folder, a missing one, a folder, and too many', async () => {
    const folder = join(root, 'work'); await mkdir(folder)
    await writeFile(join(root, 'outside.txt'), 'x')
    expect(await uploadPaths([join(root, 'outside.txt')], folder, undefined)).toMatchObject({ ok: false, message: expect.stringContaining('outside this thread') })
    expect(await uploadPaths(['../outside.txt'], folder, undefined)).toMatchObject({ ok: false, message: expect.stringContaining('outside this thread') })
    expect(await uploadPaths(['nope.txt'], folder, undefined)).toMatchObject({ ok: false, message: expect.stringContaining('does not exist') })
    await mkdir(join(folder, 'sub'))
    expect(await uploadPaths(['sub'], folder, undefined)).toMatchObject({ ok: false, message: expect.stringContaining('not a file') })
    expect(await uploadPaths(Array.from({ length: UPLOAD_FILES_MAX + 1 }, (_, index) => `${index}.txt`), folder, undefined)).toMatchObject({ ok: false, message: expect.stringContaining(`at most ${UPLOAD_FILES_MAX}`) })
    expect(await readdir(folder)).toEqual(['sub'])
  })

  it('follows a link to where it really is, so a link cannot reach outside', async () => {
    const folder = join(root, 'work'); await mkdir(folder)
    await writeFile(join(root, 'secret.txt'), 'x')
    try { await symlink(join(root, 'secret.txt'), join(folder, 'link.txt'), 'file') } catch { return }
    expect(await uploadPaths(['link.txt'], folder, undefined)).toMatchObject({ ok: false, message: expect.stringContaining('outside this thread') })
  })
})

describe('the private copies an upload gives a page (ADR-0222, for Gemini\'s review)', () => {
  const setup = async () => {
    const files = new BrowserFiles(join(root, 'browser-files'))
    const work = join(root, 'work')
    await mkdir(work, { recursive: true })
    return { files, work }
  }

  it('copies each file when the agent asks, and verifies the copies are still what was shown', async () => {
    const { files, work } = await setup()
    await writeFile(join(work, 'report.pdf'), 'the report')
    const staged = await files.stage([join(work, 'report.pdf')], [work])
    if (!staged.ok) throw new Error(staged.message)
    const [copy] = staged.upload.files
    expect(copy).toMatchObject({ name: 'report.pdf', source: join(work, 'report.pdf'), size: 10 })
    expect(copy!.path.startsWith(join(root, 'browser-files'))).toBe(true)
    expect(await readFile(copy!.path, 'utf8')).toBe('the report')
    // The thread's own file changing later changes nothing given.
    await writeFile(join(work, 'report.pdf'), 'something else')
    expect(await files.verify(staged.upload)).toBe(true)
    expect(await readFile(copy!.path, 'utf8')).toBe('the report')
  })

  it('fails verification when the copy itself changes, is replaced by a link, or goes', async () => {
    const { files, work } = await setup()
    await writeFile(join(work, 'a.txt'), 'aaaa')
    for (const change of ['content', 'gone'] as const) {
      const staged = await files.stage([join(work, 'a.txt')], [work])
      if (!staged.ok) throw new Error(staged.message)
      const copy = staged.upload.files[0]!.path
      if (change === 'content') await writeFile(copy, 'bbbb')
      else await rm(copy)
      expect(await files.verify(staged.upload)).toBe(false)
    }
    const staged = await files.stage([join(work, 'a.txt')], [work])
    if (!staged.ok) throw new Error(staged.message)
    const copy = staged.upload.files[0]!.path
    await writeFile(join(root, 'elsewhere.txt'), 'aaaa')
    await rm(copy)
    if (await symlink(join(root, 'elsewhere.txt'), copy, 'file').then(() => true, () => false)) expect(await files.verify(staged.upload)).toBe(false)
  })

  it('refuses a file reached through a junction or link out of the roots, and a folder', async () => {
    const { files, work } = await setup()
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(work, 'linked'), 'junction')
    const through = await files.stage([join(work, 'linked', 'secret.txt')], [work])
    expect(through.ok).toBe(false)
    await mkdir(join(work, 'docs'))
    expect((await files.stage([join(work, 'docs')], [work])).ok).toBe(false)
    if (await symlink(join(outside, 'secret.txt'), join(work, 'link.txt'), 'file').then(() => true, () => false)) {
      expect((await files.stage([join(work, 'link.txt')], [work])).ok).toBe(false)
    }
    // Nothing refused leaves a copy behind.
    expect(await readdir(join(root, 'browser-files', 'staged-uploads')).then(entries => entries.length, () => 0)).toBe(0)
  })

  it('discards copies, never anything outside its own folder, and sweeps every copy at start', async () => {
    const { files, work } = await setup()
    await writeFile(join(work, 'a.txt'), 'a')
    const staged = await files.stage([join(work, 'a.txt')], [work])
    if (!staged.ok) throw new Error(staged.message)
    await files.discard({ folder: work, files: [] })
    expect((await stat(join(work, 'a.txt'))).isFile()).toBe(true)
    const again = await files.stage([join(work, 'a.txt')], [work])
    if (!again.ok) throw new Error(again.message)
    await files.discard(staged.upload)
    await expect(stat(staged.upload.folder)).rejects.toThrow()
    await files.sweep()
    await expect(stat(again.upload.folder)).rejects.toThrow()
    expect(await files.verify({ folder: work, files: [] })).toBe(false)
  })
})
