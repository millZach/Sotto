// @vitest-environment node

import { lstat, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { queuedRemovals, REMOVING_LOCK_REASON, REPAIRING_LOCK_REASON, runWorktreeGit as git, ThreadWorktrees, type RunGit } from '../../src/main/agents/threadWorktrees'
import { removeFolderContents } from '../../src/main/agents/folderRemoval'
import { fixture } from '../fixtures/threadWorktreeFixture'

const commit = (folder: string, message: string) => git(folder, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', message])

/** A thread's worktree with committed work, a `.gitignore` for dependencies and an installed `node_modules`. */
async function installedWorktree() {
  const f = await fixture()
  const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
  await writeFile(join(a.path!, '.gitignore'), 'node_modules/\n.worktrees/\n')
  for (const name of ['a.txt', 'b.txt', 'z.txt']) await writeFile(join(a.path!, name), `${name} committed`)
  await git(a.path!, ['add', '.']); await commit(a.path!, 'Work')
  for (const name of ['alpha', 'zod']) {
    await mkdir(join(a.path!, 'node_modules', name, 'lib'), { recursive: true })
    await writeFile(join(a.path!, 'node_modules', name, 'lib', 'index.js'), 'module.exports = 1')
  }
  return { ...f, a: await f.service.inspect(a) }
}
const registrations = async (project: string) => (await git(project, ['worktree', 'list', '--porcelain'])).split(/\r?\n\r?\n/u).filter(Boolean)
/** A removal that stops before deleting anything, as a crash or a quit right after the lock would stop it. */
const stopped = async () => { throw new Error('Sotto quit.') }

describe('a worktree removal cut off partway (#1297)', () => {
  it('repairs, without deleting anything more, what a Git removal cut off in node_modules left', async () => {
    const f = await installedWorktree()
    const branch = f.a.branch!
    // What `git worktree remove` killed at its deadline left: `.git` goes first, then files in folder order, and the
    // registration Git deletes last is still there. Nothing records that the removal was decided.
    await rm(join(f.a.path!, '.git'))
    for (const name of ['.gitignore', 'a.txt', 'b.txt']) await rm(join(f.a.path!, name))
    await rm(join(f.a.path!, 'node_modules', 'alpha'), { recursive: true })
    expect((await registrations(f.project))[1]).toMatch(/prunable/u)
    await expect(f.service.inspect(f.a)).rejects.toThrow('only partly removed, so Git cannot use it')

    expect(await f.service.resumeRemoval(f.a)).toBe(f.a)
    expect(await readFile(join(f.a.path!, 'a.txt'), 'utf8')).toBe('a.txt committed')
    expect(await readFile(join(f.a.path!, '.gitignore'), 'utf8')).toBe('node_modules/\n.worktrees/\n')
    // What was still there stays, the half-deleted dependencies included.
    expect(await readdir(join(f.a.path!, 'node_modules'))).toEqual(['zod'])
    expect((await registrations(f.project))[1]).not.toMatch(/prunable|locked/u)
    expect(await f.service.inspect(f.a)).toMatchObject({ status: 'ready', branch, dirty: false })
  })

  it('keeps Git able to use a folder whose removal stopped partway, and the next start finishes it on its branch', async () => {
    const f = await installedWorktree()
    // The folder moved to another branch after its record was made; that is the branch it comes back on.
    await git(f.a.path!, ['switch', '-c', 'feat/moved'])
    const cutOff = new ThreadWorktrees(f.root, git, undefined, async root => {
      await rm(join(root, 'node_modules', 'alpha'), { recursive: true })
      throw new Error('The removal was cut off.')
    })
    await expect(cutOff.reclaim(f.a, { automatic: true })).rejects.toThrow('could not finish removing this worktree’s folder')
    expect(await readFile(join(f.a.path!, '.git'), 'utf8')).toMatch(/^gitdir: /u)
    const entry = (await registrations(f.project))[1]!
    expect(entry).toContain(`locked ${REMOVING_LOCK_REASON}`)
    expect(entry).not.toMatch(/prunable/u)
    expect((await git(f.a.path!, ['branch', '--show-current'])).trim()).toBe('feat/moved')
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
    expect(finished).toMatchObject({ status: 'ready', branch: 'feat/moved' })
    expect(finished.reclaimedAt).toBeTruthy()
    expect(seen).toEqual([['.git']])
    await expect(lstat(f.a.path!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await registrations(f.project)).toHaveLength(1)
  })

  it('finishes a half removal before a send puts the folder back', async () => {
    const f = await installedWorktree()
    await expect(new ThreadWorktrees(f.root, git, undefined, stopped).reclaim(f.a, { automatic: true })).rejects.toThrow()
    const restored = await f.service.inspect(await f.service.restore(f.a))
    expect(restored).toMatchObject({ status: 'ready', branch: f.a.branch, reclaimedAt: undefined, dirty: false })
    expect(await readFile(join(f.a.path!, 'a.txt'), 'utf8')).toBe('a.txt committed')
    await expect(lstat(join(f.a.path!, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await registrations(f.project))[1]).not.toMatch(/locked/u)
  })

  it('lets one removal of a folder run at a time, so a send never puts it back for a second remover to take', async () => {
    const f = await installedWorktree()
    // The folder moved branch after the record the send holds was made; it comes back on the branch the removal found.
    await git(f.a.path!, ['switch', '-c', 'feat/moved'])
    await expect(new ThreadWorktrees(f.root, git, undefined, stopped).reclaim(f.a, { automatic: true })).rejects.toThrow()
    // A finisher held inside its deletion, as a large folder holds one, while a send restores the same folder.
    let entered!: () => void, release!: () => void
    const inside = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const slow = new ThreadWorktrees(f.root, git, undefined, async root => { entered(); await gate; await removeFolderContents(root, { keep: new Set(['.git']) }) })
    const order: string[] = []
    const sending = new ThreadWorktrees(f.root, async (cwd, args, options) => { order.push('send asked Git'); return git(cwd, args, options) })
    const finishing = slow.resumeRemoval(f.a)
    await inside
    const restoring = sending.restore(f.a)
    // The send is seen waiting its turn behind the held finisher before the finisher is let go, and it asks Git nothing
    // about the folder until then.
    await vi.waitFor(() => expect(queuedRemovals(f.a.path!)).toBe(2))
    order.push('finisher let go')
    release()
    expect((await finishing).reclaimedAt).toBeTruthy()
    expect(await restoring).toMatchObject({ status: 'ready', branch: 'feat/moved', reclaimedAt: undefined })
    expect((await git(f.a.path!, ['branch', '--show-current'])).trim()).toBe('feat/moved')
    expect(order[0]).toBe('finisher let go')
    expect(await readFile(join(f.a.path!, 'a.txt'), 'utf8')).toBe('a.txt committed')
    expect((await registrations(f.project))[1]).not.toMatch(/locked|prunable/u)
  })

  it('takes up again a repair that was cut off, and sends nothing into the folder until it is done', async () => {
    const f = await installedWorktree()
    await rm(join(f.a.path!, '.git'))
    for (const name of ['a.txt', 'b.txt']) await rm(join(f.a.path!, name))
    const failing = new ThreadWorktrees(f.root, async (cwd, args, options) => {
      if (args[0] === 'checkout-index') throw new Error('Permission denied')
      return git(cwd, args, options)
    })
    await expect(failing.resumeRemoval(f.a)).rejects.toThrow('could not put back this worktree’s missing files')
    expect((await registrations(f.project))[1]).toContain(`locked ${REPAIRING_LOCK_REASON}`)
    await expect(f.service.inspect(f.a)).rejects.toThrow('only partly removed')
    expect(await f.service.resumeRemoval(f.a)).toBe(f.a)
    expect(await readFile(join(f.a.path!, 'b.txt'), 'utf8')).toBe('b.txt committed')
    expect((await registrations(f.project))[1]).not.toMatch(/locked|prunable/u)
    expect(await f.service.inspect(f.a)).toMatchObject({ status: 'ready', dirty: false })
  })

  it('keeps a removal unfinished, with its record, until a nested worktree’s registration is cleared', async () => {
    const f = await installedWorktree()
    const nested = join(f.a.path!, '.worktrees', 'n')
    await git(f.project, ['worktree', 'add', '-b', 'nested', '--', nested, 'HEAD'])
    const facts = await f.service.reclaimFacts(f.a)
    const refusing = new ThreadWorktrees(f.root, async (cwd, args, options) => {
      if (args[0] === 'worktree' && args[1] === 'remove' && args.includes(nested)) throw new Error('Refused')
      return git(cwd, args, options)
    })
    await expect(refusing.reclaim(f.a, { confirmedItems: facts.items, confirmedIgnored: facts.ignored, confirmedRepositories: facts.repositories }))
      .rejects.toThrow('Git would not clear the registration of a worktree that was inside it')
    expect((await registrations(f.project))[1]).toContain(`locked ${REMOVING_LOCK_REASON}`)
    expect(await registrations(f.project)).toHaveLength(3)
    expect((await f.service.resumeRemoval(f.a)).reclaimedAt).toBeTruthy()
    expect(await registrations(f.project)).toHaveLength(1)
  })

  it('keeps the removal’s record when the nested worktree’s repository cannot be read', async () => {
    const f = await installedWorktree()
    const nested = join(f.a.path!, '.worktrees', 'n')
    await git(f.project, ['worktree', 'add', '-b', 'nested', '--', nested, 'HEAD'])
    const common = (await git(f.project, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
    const facts = await f.service.reclaimFacts(f.a)
    // From the lock on, the nested worktree's repository answers nothing: neither its removal nor its listing.
    let locked = false
    const unreadable = new ThreadWorktrees(f.root, async (cwd, args, options) => {
      if (args[0] === 'worktree' && args[1] === 'lock') locked = true
      if (locked && cwd === common) throw new Error('Unreadable')
      return git(cwd, args, options)
    })
    await expect(unreadable.reclaim(f.a, { confirmedItems: facts.items, confirmedIgnored: facts.ignored, confirmedRepositories: facts.repositories })).rejects.toThrow('could not finish removing')
    expect(await registrations(f.project)).toHaveLength(3)
    expect((await registrations(f.project))[1]).toContain(`locked ${REMOVING_LOCK_REASON}`)
    expect((await f.service.resumeRemoval(f.a)).reclaimedAt).toBeTruthy()
    expect(await registrations(f.project)).toHaveLength(1)
  })

  it('repairs a `.git` file a cut-off write left empty, under Sotto’s lock', async () => {
    const f = await installedWorktree()
    await rm(join(f.a.path!, 'a.txt'))
    await git(f.project, ['worktree', 'lock', '--reason', REPAIRING_LOCK_REASON, '--', f.a.path!])
    await rm(join(f.a.path!, '.git')); await writeFile(join(f.a.path!, '.git'), '')
    expect(await f.service.resumeRemoval(f.a)).toBe(f.a)
    expect(await readFile(join(f.a.path!, '.git'), 'utf8')).toMatch(/^gitdir: /u)
    expect(await readFile(join(f.a.path!, 'a.txt'), 'utf8')).toBe('a.txt committed')
    expect((await registrations(f.project))[1]).not.toMatch(/locked|prunable/u)
  })

  it('repairs a `.git` file a cut-off write left pointing at a folder that is not there', async () => {
    const f = await installedWorktree()
    await rm(join(f.a.path!, 'a.txt'))
    await git(f.project, ['worktree', 'lock', '--reason', REPAIRING_LOCK_REASON, '--', f.a.path!])
    const whole = await readFile(join(f.a.path!, '.git'), 'utf8')
    await rm(join(f.a.path!, '.git')); await writeFile(join(f.a.path!, '.git'), whole.trim().slice(0, -4))
    expect(await f.service.resumeRemoval(f.a)).toBe(f.a)
    expect(await f.service.inspect(f.a)).toMatchObject({ status: 'ready', dirty: false })
    expect(await readFile(join(f.a.path!, 'a.txt'), 'utf8')).toBe('a.txt committed')
    expect((await registrations(f.project))[1]).not.toMatch(/locked|prunable/u)
  })

  it('removes nothing from a folder whose `.git` file points at another worktree’s registration', async () => {
    const f = await installedWorktree()
    const other = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await git(f.project, ['worktree', 'lock', '--reason', REMOVING_LOCK_REASON, '--', f.a.path!])
    await rm(join(f.a.path!, '.git')); await writeFile(join(f.a.path!, '.git'), await readFile(join(other.path!, '.git'), 'utf8'))
    expect(await f.service.resumeRemoval(f.a)).toBe(f.a)
    expect(await readFile(join(f.a.path!, 'a.txt'), 'utf8')).toBe('a.txt committed')
    expect(await readdir(join(f.a.path!, 'node_modules'))).toEqual(['alpha', 'zod'])
  })

  it('clears a nested worktree’s registration when it finishes a removal later', async () => {
    const f = await installedWorktree()
    const nested = join(f.a.path!, '.worktrees', 'n')
    await git(f.project, ['worktree', 'add', '-b', 'nested', '--', nested, 'HEAD'])
    const facts = await f.service.reclaimFacts(f.a)
    const cutOff = new ThreadWorktrees(f.root, git, undefined, stopped)
    await expect(cutOff.reclaim(f.a, { confirmedItems: facts.items, confirmedIgnored: facts.ignored, confirmedRepositories: facts.repositories })).rejects.toThrow()
    expect(await registrations(f.project)).toHaveLength(3)
    expect((await f.service.resumeRemoval(f.a)).reclaimedAt).toBeTruthy()
    expect(await registrations(f.project)).toHaveLength(1)
    expect((await git(f.project, ['branch', '--list', 'nested'])).trim()).toBe('nested')
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

  it('deletes nothing through a reserved folder that now leads somewhere else', async () => {
    const f = await installedWorktree()
    await expect(new ThreadWorktrees(f.root, git, undefined, stopped).reclaim(f.a, { automatic: true })).rejects.toThrow()
    // Sotto's worktree folder is replaced by a junction to another folder that holds the same files.
    const elsewhere = join(f.root, 'elsewhere')
    await rename(join(f.root, 'thread-worktrees'), elsewhere)
    await symlink(elsewhere, join(f.root, 'thread-worktrees'), 'junction')
    await expect(f.service.resumeRemoval(f.a)).rejects.toThrow('leads to another folder through a link')
    expect(await readFile(join(f.a.path!, 'a.txt'), 'utf8')).toBe('a.txt committed')
    await rm(join(f.root, 'thread-worktrees'))
    await rename(elsewhere, join(f.root, 'thread-worktrees'))
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

describe('removing a worktree that holds dependencies, and the folder a cut-off removal left (#1301)', () => {
  /** What `git worktree remove` killed at its deadline left: no `.git`, early files gone, part of `node_modules`. */
  const cutOffByGit = async (path: string, names: readonly string[] = ['.gitignore', 'a.txt', 'b.txt']) => {
    await rm(join(path, '.git'))
    for (const name of names) await rm(join(path, name), { recursive: true })
    await rm(join(path, 'node_modules', 'alpha'), { recursive: true })
  }
  const errorRecord = { status: 'error' as const, error: 'Git has locked this worktree or reports an incomplete checkout. Restore the checkout before continuing.' }

  it('deletes dependencies for as long as they take with no Git command running, then gives Git only the `.git` file', async () => {
    const f = await installedWorktree()
    let running = 0
    const seen: string[][] = []
    const counting: RunGit = async (cwd, args, options) => {
      if (args[0] === 'worktree' && args[1] === 'remove') seen.push(await readdir(f.a.path!))
      running++
      try { return await git(cwd, args, options) } finally { running-- }
    }
    // The deletion is held for as long as the test likes, as a 1.4 GB `node_modules` on a slow disk holds it.
    let entered!: () => void, release!: () => void
    const inside = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const slow = new ThreadWorktrees(f.root, counting, undefined, async root => { entered(); await gate; await removeFolderContents(root, { keep: new Set(['.git']) }) })
    const timer = vi.spyOn(globalThis, 'setTimeout')
    try {
      const reclaiming = slow.reclaim(f.a, { automatic: true })
      await inside
      // No Git process runs while Sotto deletes, so no Git deadline is counting down.
      expect(running).toBe(0)
      expect((await registrations(f.project))[1]).toContain(`locked ${REMOVING_LOCK_REASON}`)
      const armed = timer.mock.calls.length
      release()
      expect((await reclaiming).reclaimedAt).toBeTruthy()
      // Git's own removal, of the `.git` file alone, has no deadline to be cut off by either.
      expect(timer.mock.calls.slice(armed).some(call => typeof call[1] === 'number' && call[1] >= 30_000)).toBe(false)
    } finally { timer.mockRestore() }
    expect(seen).toEqual([['.git']])
    await expect(lstat(f.a.path!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await registrations(f.project)).toHaveLength(1)
  })

  it('unlinks a junction in node_modules when it finishes a removal, and leaves the folder it led to whole', async () => {
    const f = await installedWorktree()
    await expect(new ThreadWorktrees(f.root, git, undefined, stopped).reclaim(f.a, { automatic: true })).rejects.toThrow()
    // A link made after the checks, as a crash between the lock and the deletion could leave one.
    const outside = join(f.root, 'real-install'); await mkdir(join(outside, 'dep'), { recursive: true })
    await writeFile(join(outside, 'dep', 'index.js'), 'the real install')
    await symlink(outside, join(f.a.path!, 'node_modules', 'linked'), 'junction')
    expect((await f.service.resumeRemoval(f.a)).reclaimedAt).toBeTruthy()
    await expect(lstat(f.a.path!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(outside, 'dep', 'index.js'), 'utf8')).toBe('the real install')
  })

  it('puts back a folder Git’s cut-off removal left, so a thread whose record turned to an error can send again', async () => {
    const f = await installedWorktree()
    const branch = f.a.branch!
    await cutOffByGit(f.a.path!)
    // A send puts a missing or broken folder back before the turn, from an error record too.
    const sent = await f.service.inspect(await f.service.restore({ ...f.a, ...errorRecord }))
    expect(sent).toMatchObject({ status: 'ready', error: undefined, branch, dirty: false })
    expect(await readFile(join(f.a.path!, 'a.txt'), 'utf8')).toBe('a.txt committed')
    expect((await registrations(f.project))[1]).not.toMatch(/locked|prunable/u)
    // The thread works in it again.
    await writeFile(join(await f.service.workingDirectory(sent), 'c.txt'), 'after the repair')
    await git(f.a.path!, ['add', 'c.txt']); await commit(f.a.path!, 'After the repair')
    expect((await git(f.project, ['log', '-1', '--format=%s', branch])).trim()).toBe('After the repair')
  })

  it('keeps untracked and changed files as they are while it puts the missing ones back', async () => {
    const f = await installedWorktree()
    // Files sorting after node_modules outlive Git's cut-off removal.
    await writeFile(join(f.a.path!, 'z.txt'), 'z.txt changed, not committed')
    await writeFile(join(f.a.path!, 'notes.md'), 'my own notes')
    await cutOffByGit(f.a.path!)
    const ready = await f.service.ensure({ ...f.a, ...errorRecord })
    expect(ready).toMatchObject({ status: 'ready', error: undefined, dirty: true })
    expect(await readFile(join(f.a.path!, 'z.txt'), 'utf8')).toBe('z.txt changed, not committed')
    expect(await readFile(join(f.a.path!, 'notes.md'), 'utf8')).toBe('my own notes')
    expect(await readFile(join(f.a.path!, 'a.txt'), 'utf8')).toBe('a.txt committed')
    expect((await git(f.a.path!, ['status', '--porcelain'])).split(/\r?\n/u).filter(Boolean).sort()).toEqual([' M z.txt', '?? notes.md'])
  })

  it('refuses, and overwrites nothing, when a file of the user’s stands where Git puts back a folder', async () => {
    const f = await installedWorktree()
    await mkdir(join(f.a.path!, 'docs')); await writeFile(join(f.a.path!, 'docs', 'guide.md'), 'committed guide')
    await git(f.a.path!, ['add', 'docs']); await commit(f.a.path!, 'Docs')
    await cutOffByGit(f.a.path!, ['docs'])
    await writeFile(join(f.a.path!, 'docs'), 'a file of mine called docs')
    await expect(f.service.resumeRemoval(f.a)).rejects.toThrow('docs is in the way of the files Git puts back, and Sotto left it as it is. Move it out of the folder, then choose Refresh to try again.')
    expect(await readFile(join(f.a.path!, 'docs'), 'utf8')).toBe('a file of mine called docs')
    // The repair keeps its lock, so nothing sends into the folder until it is done.
    expect((await registrations(f.project))[1]).toContain(`locked ${REPAIRING_LOCK_REASON}`)
    await expect(f.service.ensure({ ...f.a, ...errorRecord })).rejects.toThrow('docs is in the way')
    await rename(join(f.a.path!, 'docs'), join(f.a.path!, 'docs-mine'))
    expect(await f.service.ensure({ ...f.a, ...errorRecord })).toMatchObject({ status: 'ready', error: undefined })
    expect(await readFile(join(f.a.path!, 'docs', 'guide.md'), 'utf8')).toBe('committed guide')
    expect(await readFile(join(f.a.path!, 'docs-mine'), 'utf8')).toBe('a file of mine called docs')
  })
})
