// @vitest-environment node

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { removeFolderContents } from '../../../src/main/agents/folderRemoval'

/** How many of the removal's file system calls are running at once, and the most there ever were. */
const calls = vi.hoisted(() => ({ active: 0, peak: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const counted = <F extends (...args: never[]) => Promise<unknown>>(call: F): F => (async (...args: Parameters<F>) => {
    calls.active++; calls.peak = Math.max(calls.peak, calls.active)
    try { return await call(...args) } finally { calls.active-- }
  }) as F
  return { ...real, readdir: counted(real.readdir), lstat: counted(real.lstat), unlink: counted(real.unlink), rmdir: counted(real.rmdir) }
})

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('keeps at most 16 file system calls running across a wide, nested tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-folder-removal-')); roots.push(root)
  // Wide at every level, the way an installed dependency tree is: a per-folder limit would run hundreds at once here.
  for (let a = 0; a < 20; a++) {
    for (let b = 0; b < 20; b++) {
      const folder = join(root, `a${a}`, `b${b}`)
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, 'index.js'), '')
    }
  }
  calls.peak = 0
  await removeFolderContents(root)
  expect(await readdir(root)).toEqual([])
  expect(calls.peak).toBeLessThanOrEqual(16)
  expect(calls.peak).toBeGreaterThan(1)
})
