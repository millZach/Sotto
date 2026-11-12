// @vitest-environment node
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { makeProjectFolder, PROJECT_FOLDER_APPEARED, PROJECT_GIT_NOT_SET_UP, PROJECT_GIT_NOT_SET_UP_KEPT } from '../../../src/main/agents/projectFolders'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const root = async () => { const made = await mkdtemp(join(tmpdir(), 'sotto-project-folders-')); roots.push(made); return made }

it('never sets up Git in a folder that was there when it came to make it', async () => {
  const path = join(await root(), 'appeared')
  await mkdir(path)
  const init = vi.fn(async () => undefined)
  await expect(makeProjectFolder(path, init)).rejects.toThrow(PROJECT_FOLDER_APPEARED)
  expect(init).not.toHaveBeenCalled()
  expect((await stat(path)).isDirectory()).toBe(true)
})

it('takes back the folders a failed git init made, and says so only when they are gone', async () => {
  const base = await root(), path = join(base, 'outer', 'fresh')
  await expect(makeProjectFolder(path, async () => { throw new Error('Synthetic git failure') })).rejects.toThrow(PROJECT_GIT_NOT_SET_UP)
  await expect(stat(join(base, 'outer'))).rejects.toMatchObject({ code: 'ENOENT' })
  const busy = join(base, 'busy')
  await expect(makeProjectFolder(busy, async folder => { await writeFile(join(folder, 'notes.txt'), 'kept'); throw new Error('Synthetic git failure') }))
    .rejects.toThrow(PROJECT_GIT_NOT_SET_UP_KEPT)
  expect((await stat(join(busy, 'notes.txt'))).isFile()).toBe(true)
})
