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
