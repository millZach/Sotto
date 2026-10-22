// @vitest-environment node

import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FolderRemovalStalled, removeFolderContents } from '../../../src/main/agents/folderRemoval'
import { holdFolder } from '../../fixtures/folderHolder'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(join(root, 'folder', 'locked'), 0o700).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
async function tree() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-folder-removal-')); roots.push(root)
  const folder = join(root, 'folder')
  await mkdir(join(folder, 'node_modules', 'dep', 'lib'), { recursive: true })
  await writeFile(join(folder, 'node_modules', 'dep', 'lib', 'index.js'), '')
  await writeFile(join(folder, '.git'), 'gitdir: elsewhere\n')
  await writeFile(join(folder, 'tracked.txt'), 'tracked')
  return { root, folder }
}

describe('removeFolderContents', () => {
  it('deletes everything but the kept names and leaves the folder itself', async () => {
    const { folder } = await tree()
    await removeFolderContents(folder, { keep: new Set(['.git']) })
    expect(await readdir(folder)).toEqual(['.git'])
  })

  it('removes a link or junction as itself, never the folder it leads to', async () => {
    const { root, folder } = await tree()
    const outside = join(root, 'real-install'); await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'real')
    await symlink(outside, join(folder, 'linked'), 'junction')
    await removeFolderContents(folder)
    expect(await readdir(folder)).toEqual([])
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('real')
  })

  it('removes read-only files and folders it cannot write into', async () => {
    const { folder } = await tree()
    await mkdir(join(folder, 'locked'))
    await writeFile(join(folder, 'locked', 'object'), 'packed'); await chmod(join(folder, 'locked', 'object'), 0o444)
    await chmod(join(folder, 'locked'), 0o500)
    await removeFolderContents(folder, { keep: new Set(['.git']) })
    expect(await readdir(folder)).toEqual(['.git'])
  })

  it.runIf(process.platform !== 'win32')('changes no mode through a link in a folder it cannot write into', async () => {
    const { root, folder } = await tree()
    const outside = join(root, 'outside.txt'); await writeFile(outside, 'real'); await chmod(outside, 0o444)
    await mkdir(join(folder, 'locked')); await symlink(outside, join(folder, 'locked', 'link')); await chmod(join(folder, 'locked'), 0o500)
    await removeFolderContents(folder, { keep: new Set(['.git']) })
    expect(await readdir(folder)).toEqual(['.git'])
    expect((await stat(outside)).mode & 0o777).toBe(0o444)
  })

  it('stops when something keeps an entry past the stall, leaving the kept names', async () => {
    const { folder } = await tree()
    const busy = join(folder, 'busy'); await mkdir(busy)
    // Windows will not delete a folder a process works in; elsewhere a folder that cannot be written into stands in.
    const holder = process.platform === 'win32' ? await holdFolder(busy) : undefined
    if (!holder) { await writeFile(join(busy, 'file'), ''); await chmod(busy, 0o500) }
    // Each reading of the clock jumps past the stall, so the first refusal stops the removal and the test waits on nothing.
    let clock = 0
    try {
      await expect(removeFolderContents(folder, { keep: new Set(['.git']), stallMs: 1_000, now: () => (clock += 1_100) })).rejects.toBeInstanceOf(FolderRemovalStalled)
    } finally { await holder?.release(); await chmod(busy, 0o700).catch(() => undefined) }
    expect((await lstat(join(folder, '.git'))).isFile()).toBe(true)
  })
})
