// @vitest-environment node

import { initializeGitRepository } from '../fixtures/gitRepository'
import { lstat, mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runWorktreeGit as git, ThreadWorktrees, type RunGit } from '../../src/main/agents/threadWorktrees'
import { fixture } from '../fixtures/threadWorktreeFixture'

/** A junction where Windows makes one; elsewhere, or where junctions are refused, a directory link. */
async function folderLink(target: string, path: string): Promise<void> {
  try { await symlink(target, path, 'junction') }
  catch { await symlink(target, path, 'dir') }
}

/**
 * A service whose Git runs `change` once, while the `nth` `status` call in `repository` is running: the last
 * observation reclaim makes of that nested repository is inside the registry lane, after the one before it.
 */
function changingDuringStatus(root: string, repository: string, nth: number, change: () => Promise<void>): ThreadWorktrees {
  return changingOnGit(root, [{ when: (cwd, args) => cwd === repository && args[0] === 'status', nth, change }])
}

/** A service whose Git runs each step's `change` once, after the `nth` Git call `when` matches has run. */
function changingOnGit(root: string, steps: { when: (cwd: string, args: readonly string[]) => boolean; nth: number; change: () => Promise<void> }[]): ThreadWorktrees {
  const seen = steps.map(() => 0)
  const run: RunGit = async (cwd, args) => {
    const output = await git(cwd, args)
    for (const [index, step] of steps.entries()) if (step.when(cwd, args) && ++seen[index]! === step.nth) await step.change()
    return output
  }
  return new ThreadWorktrees(root, run)
}

/** A shell script for `core.fsmonitor` that leaves `sentinel` behind when Git runs it, and answers nothing. */
async function sentinelHook(directory: string, sentinel: string): Promise<string> {
  const hook = join(directory, 'fsmonitor-hook.sh')
  await writeFile(hook, `#!/bin/sh\necho ran > '${sentinel.split('\\').join('/')}'\nexit 1\n`, { mode: 0o755 })
  return hook.split('\\').join('/')
}

describe('reclaim walk after a nested repository’s Git checks', () => {
  it('refuses an ignored file that appears inside a nested repository during its final status', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    const nested = join(a.path!, 'nested'); await mkdir(nested); await git(nested, ['init'])
    await writeFile(join(nested, '.gitignore'), '*.secret\n')
    const preview = await f.service.reclaimFacts(a)
    // The nested repository's own Git ignores the file, so only the walk's count can see it.
    const service = changingDuringStatus(f.root, nested, 2, () => writeFile(join(nested, 'unseen.secret'), 'keep this'))
    await expect(service.reclaim(a, { withUncommittedChanges: true, confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).rejects.toThrow(/changed/u)
    expect(await readFile(join(nested, 'unseen.secret'), 'utf8')).toBe('keep this')
  })

  it('refuses a file replaced by a link out of the folder while a nested repository before it is checked', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await writeFile(join(a.path!, '.gitignore'), 'out/\n')
    await git(a.path!, ['add', '.gitignore'])
    await git(a.path!, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Ignore build output'])
    const out = join(a.path!, 'out')
    // `a-nested` is listed before `z-victim`, so the walk reaches the file only after the nested repository's checks.
    const nested = join(out, 'a-nested'); await mkdir(nested, { recursive: true }); await git(nested, ['init'])
    const victim = join(out, 'z-victim'); await writeFile(victim, 'a plain file')
    const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'not the folder’s')
    const preview = await f.service.reclaimFacts(a)
    expect(preview.outsideLink).toBeUndefined()
    const service = changingDuringStatus(f.root, nested, 2, async () => { await unlink(victim); await folderLink(outside, victim) })
    await expect(service.reclaim(a, { withUncommittedChanges: true, confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).rejects.toThrow(/link to another folder|changed/u)
    expect((await lstat(victim)).isSymbolicLink()).toBe(true)
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('not the folder’s')
    expect(await readFile(join(nested, '.git', 'HEAD'), 'utf8')).toContain('ref:')
  })

  it('refuses a nested repository whose folder is replaced by a link out of the folder during its final status', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    const nested = join(a.path!, 'nested'); await mkdir(nested); await git(nested, ['init'])
    await writeFile(join(nested, 'notes.txt'), 'nested work')
    // An outside repository shaped like the nested one, so the counts alone would still match.
    const outside = join(f.root, 'outside'); await mkdir(outside); await git(outside, ['init'])
    await writeFile(join(outside, 'notes.txt'), 'nested work')
    const preview = await f.service.reclaimFacts(a)
    const moved = join(f.root, 'moved-nested')
    const service = changingDuringStatus(f.root, nested, 2, async () => { await rename(nested, moved); await folderLink(outside, nested) })
    await expect(service.reclaim(a, { withUncommittedChanges: true, confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).rejects.toThrow(/link to another folder|changed/u)
    expect((await lstat(nested)).isSymbolicLink()).toBe(true)
    expect(await readFile(join(outside, 'notes.txt'), 'utf8')).toBe('nested work')
  })

  it('refuses a nested worktree whose .git file is replaced by a repository with its own history during its final status', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    const nested = join(a.path!, 'nested')
    await git(f.project, ['worktree', 'add', '-b', 'nested', '--', nested, 'HEAD'])
    // A repository with a commit no remote has; once its .git sits in the nested folder, that history goes with the folder.
    const history = join(f.root, 'history')
    await initializeGitRepository(history, { files: { 'tracked.txt': 'committed baseline' }, message: 'Unpublished' })
    const preview = await f.service.reclaimFacts(a)
    expect(preview.repositories).toEqual([expect.objectContaining({ path: 'nested/', kind: 'worktree' })])
    const service = changingDuringStatus(f.root, nested, 2, async () => {
      await unlink(join(nested, '.git'))
      await rename(join(history, '.git'), join(nested, '.git'))
    })
    await expect(service.reclaim(a, { withUncommittedChanges: true, confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).rejects.toThrow(/changed/u)
    expect((await lstat(join(nested, '.git'))).isDirectory()).toBe(true)
    expect(Number((await git(nested, ['rev-list', '--count', '--all'])).trim())).toBe(1)
  })

  it('refuses an uncounted file replaced by a link out of the folder while an entry found on the second listing is checked', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await writeFile(join(a.path!, '.gitignore'), 'node_modules/\n')
    await git(a.path!, ['add', '.gitignore'])
    await git(a.path!, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Ignore dependencies'])
    const dependencies = join(a.path!, 'node_modules')
    // `a-nested` gives the final walk a Git check before `m-new` exists; `z-victim` is a dependency file no row counts.
    const nested = join(dependencies, 'a-nested'); await mkdir(nested, { recursive: true }); await git(nested, ['init'])
    const victim = join(dependencies, 'z-victim'); await writeFile(victim, 'a dependency file')
    const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'not the folder’s')
    const preview = await f.service.reclaimFacts(a)
    expect(preview.outsideLink).toBeUndefined()
    // `m-new` looks like a bare repository but is not one, so checking it runs Git and adds no row of its own.
    const added = join(dependencies, 'm-new')
    const service = changingOnGit(f.root, [
      { when: (cwd, args) => cwd === nested && args[0] === 'status', nth: 2, change: async () => { await mkdir(join(added, 'objects'), { recursive: true }); await writeFile(join(added, 'HEAD'), 'not a reference') } },
      { when: (cwd, args) => cwd === added && args.includes('--is-bare-repository'), nth: 1, change: async () => { await unlink(victim); await folderLink(outside, victim) } },
    ])
    await expect(service.reclaim(a, { withUncommittedChanges: true, confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).rejects.toThrow(/link to another folder|changed/u)
    expect((await lstat(victim)).isSymbolicLink()).toBe(true)
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('not the folder’s')
  })

  it('runs no Git in a repository outside the folder when a folder after a nested repository is replaced by a link to it', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    // `a-nested` is listed before `z-folder`, so the walk reaches the folder only after the nested repository's checks.
    const nested = join(a.path!, 'a-nested'); await mkdir(nested); await git(nested, ['init'])
    const folder = join(a.path!, 'z-folder'); await mkdir(folder); await writeFile(join(folder, 'notes.txt'), 'work')
    // An outside repository whose own configuration runs a program whenever Git reads its status.
    const outside = join(f.root, 'outside')
    await initializeGitRepository(outside, { files: { 'notes.txt': 'work' } })
    const sentinel = join(f.root, 'fsmonitor-ran')
    await git(outside, ['config', 'core.fsmonitor', await sentinelHook(f.root, sentinel)])
    // The hook does run for a status in that repository, so its absence below means no status ran there.
    await git(outside, ['status', '--porcelain'])
    expect(await readFile(sentinel, 'utf8')).toContain('ran')
    await unlink(sentinel)
    const preview = await f.service.reclaimFacts(a)
    const moved = join(f.root, 'moved-folder')
    const service = changingDuringStatus(f.root, nested, 2, async () => { await rename(folder, moved); await folderLink(outside, folder) })
    await expect(service.reclaim(a, { withUncommittedChanges: true, confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).rejects.toThrow(/link to another folder|changed/u)
    await expect(lstat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await lstat(folder)).isSymbolicLink()).toBe(true)
    expect(await readFile(join(outside, 'notes.txt'), 'utf8')).toBe('work')
  })
})
