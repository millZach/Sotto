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
  let reads = 0
  const run: RunGit = async (cwd, args) => {
    const output = await git(cwd, args)
    if (cwd === repository && args[0] === 'status' && ++reads === nth) await change()
    return output
  }
  return new ThreadWorktrees(root, run)
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
})
