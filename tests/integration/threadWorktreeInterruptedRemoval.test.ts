// @vitest-environment node

import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REMOVING_LOCK_REASON, runWorktreeGit as git, ThreadWorktrees, type RunGit } from '../../src/main/agents/threadWorktrees'
import { fixture } from '../fixtures/threadWorktreeFixture'

const commit = (folder: string, message: string) => git(folder, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', message])

/** A thread's worktree with committed work, a `.gitignore` for dependencies and an installed `node_modules`. */
async function installedWorktree() {
  const f = await fixture()
  const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
  await writeFile(join(a.path!, '.gitignore'), 'node_modules/\n')
  for (const name of ['a.txt', 'b.txt', 'z.txt']) await writeFile(join(a.path!, name), `${name} committed`)
  await git(a.path!, ['add', '.']); await commit(a.path!, 'Work')
  for (const name of ['alpha', 'zod']) {
    await mkdir(join(a.path!, 'node_modules', name, 'lib'), { recursive: true })
    await writeFile(join(a.path!, 'node_modules', name, 'lib', 'index.js'), 'module.exports = 1')
  }
  return { ...f, a: await f.service.inspect(a) }
}
const registrations = async (project: string) => (await git(project, ['worktree', 'list', '--porcelain'])).split(/\r?\n\r?\n/u).filter(Boolean)

describe('a worktree removal cut off partway (#1297)', () => {
  it('finishes what a Git removal cut off in node_modules left, which Git reports prunable', async () => {
    const f = await installedWorktree()
    const branch = f.a.branch!
    const tip = (await git(f.project, ['rev-parse', branch])).trim()
    // What `git worktree remove` killed at its deadline left: `.git` goes first, then files in folder order, and the
    // registration Git deletes last is still there.
    await rm(join(f.a.path!, '.git'))
    for (const name of ['.gitignore', 'a.txt', 'b.txt']) await rm(join(f.a.path!, name))
    await rm(join(f.a.path!, 'node_modules', 'alpha'), { recursive: true })
    expect((await registrations(f.project))[1]).toMatch(/prunable/u)

    await expect(f.service.inspect(f.a)).rejects.toThrow('did not finish, so Git cannot use it')
    const finished = await f.service.resumeRemoval(f.a)
    expect(finished).toMatchObject({ status: 'ready', branch, path: f.a.path })
    expect(finished.reclaimedAt).toBeTruthy()
    await expect(lstat(f.a.path!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await registrations(f.project)).toHaveLength(1)
    expect((await git(f.project, ['rev-parse', branch])).trim()).toBe(tip)

    // The next send puts it back whole on its branch.
    const restored = await f.service.inspect(await f.service.restore(finished))
    expect(restored).toMatchObject({ status: 'ready', branch, reclaimedAt: undefined })
    expect(await readFile(join(f.a.path!, 'a.txt'), 'utf8')).toBe('a.txt committed')
  })

  it('keeps Git able to use a folder whose removal stopped partway, and the next start finishes it', async () => {
    const f = await installedWorktree()
    const branch = f.a.branch!
    // The removal stops after one dependency, as a deadline, a crash or a quit would stop it.
    const cutOff = new ThreadWorktrees(f.root, git, undefined, async root => {
      await rm(join(root, 'node_modules', 'alpha'), { recursive: true })
      throw new Error('The removal was cut off.')
    })
    await expect(cutOff.reclaim(f.a, { automatic: true })).rejects.toThrow('could not finish removing this worktree’s folder')
    expect(await readFile(join(f.a.path!, '.git'), 'utf8')).toMatch(/^gitdir: /u)
    const entry = (await registrations(f.project))[1]!
    expect(entry).toContain(`locked ${REMOVING_LOCK_REASON}`)
    expect(entry).not.toMatch(/prunable/u)
    expect((await git(f.a.path!, ['branch', '--show-current'])).trim()).toBe(branch)
    // Nothing sends into it while it is half removed, and the words say what to do.
    await expect(f.service.inspect(f.a)).rejects.toThrow('Choose Refresh to finish removing it')

    // Sotto started again: its own lock says the removal was decided, so it is finished, not undone. Git is handed
    // only the `.git` file to remove.
    const seen: string[][] = []
    const watching: RunGit = async (cwd, args, options) => {
      if (args[0] === 'worktree' && args[1] === 'remove') seen.push(await readdir(f.a.path!))
      return git(cwd, args, options)
    }
    const finished = await new ThreadWorktrees(f.root, watching).resumeRemoval(f.a)
    expect(finished.reclaimedAt).toBeTruthy()
    expect(seen).toEqual([['.git']])
    await expect(lstat(f.a.path!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await registrations(f.project)).toHaveLength(1)
  })

  it('finishes a half removal before a send puts the folder back', async () => {
    const f = await installedWorktree()
    const cutOff = new ThreadWorktrees(f.root, git, undefined, async () => { throw new Error('Sotto quit.') })
    await expect(cutOff.reclaim(f.a, { automatic: true })).rejects.toThrow()
    await writeFile(join(f.a.path!, 'a.txt'), 'changed after the removal began')
    const restored = await f.service.inspect(await f.service.restore(f.a))
    expect(restored).toMatchObject({ status: 'ready', branch: f.a.branch, reclaimedAt: undefined, dirty: false })
    expect(await readFile(join(f.a.path!, 'a.txt'), 'utf8')).toBe('a.txt committed')
    await expect(lstat(join(f.a.path!, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await registrations(f.project))[1]).not.toMatch(/locked/u)
  })

  it('removes a large folder whole when nothing stops it', async () => {
    const f = await installedWorktree()
    const seen: string[][] = []
    const service = new ThreadWorktrees(f.root, async (cwd, args, options) => {
      if (args[0] === 'worktree' && args[1] === 'remove') seen.push(await readdir(f.a.path!))
      return git(cwd, args, options)
    })
    expect((await service.reclaim(f.a, { automatic: true })).reclaimedAt).toBeTruthy()
    expect(seen).toEqual([['.git']])
    await expect(lstat(f.a.path!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await registrations(f.project)).toHaveLength(1)
  })

  it('leaves alone a worktree someone else locked, and an ordinary one', async () => {
    const f = await installedWorktree()
    expect(await f.service.resumeRemoval(f.a)).toBe(f.a)
    await git(f.project, ['worktree', 'lock', '--reason', 'Kept on purpose', '--', f.a.path!])
    await rm(join(f.a.path!, '.git'))
    expect(await f.service.resumeRemoval(f.a)).toBe(f.a)
    expect(await readFile(join(f.a.path!, 'a.txt'), 'utf8')).toBe('a.txt committed')
    expect((await registrations(f.project))[1]).toContain('locked Kept on purpose')
  })
})
