// @vitest-environment node
import { mkdir, mkdtemp, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/**
 * A 3D model's file read for the window (the Meshy plan's ticket 4; Sol on the branch, finding 1): Node opens a file by
 * its path, so a folder swapped for a link outside the thread's folder just while the file is opened, and put back
 * before anything looks again, would have the outside file read. The file that was open is bound to the one the path
 * leads to afterwards, so nothing is handed over.
 */
const swap = vi.hoisted(() => ({ during: undefined as undefined | (() => Promise<() => Promise<void>>) }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const putBack = await swap.during?.()
      try { return await actual.open(...args) } finally { await putBack?.() }
    },
  }
})
const { readModelFile } = await import('../../../../../src/main/tools/meshy/files')

let root: string
let outside: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-meshy-swap-')))
  outside = await realpath(await mkdtemp(join(tmpdir(), 'sotto-meshy-swap-outside-')))
})
afterEach(async () => {
  swap.during = undefined
  await Promise.all([root, outside].map(folder => rm(folder, { recursive: true, force: true })))
})

it('hands over nothing read through a folder swapped for an outside link while the file was opened, and put back', async () => {
  const folder = join(root, 'models')
  await mkdir(folder)
  await writeFile(join(folder, 'Barrel.glb'), 'inside')
  await writeFile(join(outside, 'Barrel.glb'), 'outside, and of another size')
  const model = { root, folder, files: ['Barrel.glb'] }
  // Untouched, the file is read.
  expect(Buffer.from((await readModelFile(model, 'Barrel.glb'))!).toString()).toBe('inside')
  swap.during = async () => {
    await rename(folder, join(root, 'moved'))
    await symlink(outside, folder, 'junction')
    return async () => { await rmdir(folder); await rename(join(root, 'moved'), folder) }
  }
  expect(await readModelFile(model, 'Barrel.glb')).toBeNull()
})
