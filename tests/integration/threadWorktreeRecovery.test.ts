// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { lstat, readFile, symlink, unlink, writeFile } from 'node:fs/promises'

import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runWorktreeGit as git, ThreadWorktrees, type RunGit } from '../../src/main/agents/threadWorktrees'

import { fixture, removeTestCheckout } from '../fixtures/threadWorktreeFixture'

describe("independent working-copy allocation", () => {
  it('inspection does not replace a missing checkout', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await removeTestCheckout(f.root, a.path!)
    await expect(f.service.inspect(a)).rejects.toThrow()
    // A detached checkout records no branch, so there is nothing to recreate it from.
    await expect(f.service.restore({ ...a, branch: undefined })).resolves.toMatchObject({ path: a.path })
    await expect(f.service.ensure({ ...a, branch: undefined })).rejects.toThrow()
  })
  it('recreates a deleted checkout from the branch it recorded, without resetting the branch', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await git(a.path!, ['checkout', '-b', 'user-chosen-branch'])
    await writeFile(join(a.path!, 'tracked.txt'), 'work on the user branch')
    await git(a.path!, ['add', '.'])
    await git(a.path!, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Work'])
    const recorded = await f.service.inspect(a)
    expect(recorded.branch).toBe('user-chosen-branch')
    const tip = (await git(f.project, ['rev-parse', 'user-chosen-branch'])).trim()
    await removeTestCheckout(f.root, a.path!)
    expect(await f.service.ensure(recorded)).toMatchObject({ status: 'ready', branch: 'user-chosen-branch' })
    expect(await readFile(join(a.path!, 'tracked.txt'), 'utf8')).toBe('work on the user branch')
    expect((await git(f.project, ['rev-parse', 'user-chosen-branch'])).trim()).toBe(tip)
    expect(await readFile(join(f.project, 'tracked.txt'), 'utf8')).toBe('committed baseline')
    expect((await git(f.project, ['worktree', 'list', '--porcelain'])).match(/worktree /gu)).toHaveLength(2)
  })
  it('restores only its missing registration and keeps another missing checkout registered', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    const elsewhere = join(f.root, 'personal-checkout')
    await git(f.project, ['worktree', 'add', '-b', 'personal-branch', '--', elsewhere, 'HEAD'])
    await removeTestCheckout(f.root, a.path!)
    await removeTestCheckout(f.root, elsewhere)
    expect((await f.service.restore(a)).status).toBe('ready')
    const listing = await git(f.project, ['worktree', 'list', '--porcelain', '-z'])
    expect(listing).toContain(`worktree ${elsewhere.replace(/\\/gu, '/')}`)
    expect(listing).toContain('branch refs/heads/personal-branch')
    expect(listing.match(/worktree /gu)).toHaveLength(3)
    expect(await readFile(join(a.path!, 'tracked.txt'), 'utf8')).toBe('committed baseline')
  })
  it('refuses to recreate a checkout whose branch is checked out in another folder and removes nothing', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await git(a.path!, ['checkout', '-b', 'user-chosen-branch'])
    const recorded = await f.service.inspect(a)
    await removeTestCheckout(f.root, a.path!)
    await git(f.project, ['worktree', 'prune'])
    const elsewhere = join(f.root, 'elsewhere')
    await git(f.project, ['worktree', 'add', '--', elsewhere, 'user-chosen-branch'])
    await writeFile(join(elsewhere, 'other.txt'), 'other folder work')
    await expect(f.service.restore(recorded)).rejects.toThrow('elsewhere')
    await expect(f.service.ensure(recorded)).rejects.toThrow('elsewhere')
    expect(await readFile(join(elsewhere, 'other.txt'), 'utf8')).toBe('other folder work')
    expect(await readFile(join(elsewhere, 'tracked.txt'), 'utf8')).toBe('committed baseline')
    expect((await git(f.project, ['rev-parse', 'user-chosen-branch'])).trim()).toBe((await git(elsewhere, ['rev-parse', 'HEAD'])).trim())
    expect((await git(f.project, ['worktree', 'list', '--porcelain'])).match(/worktree /gu)).toHaveLength(2)
  })
  it.each(['complete', 'partial'])('cleans up only its own %s initializing checkout after an add timeout and permits retry', async checkout => {
    const f = await fixture()
    const allocation = await f.service.allocate(f.project, 'independent')
    const other = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await writeFile(join(other.path!, 'keep.txt'), 'other uncommitted work')
    let timeout = true
    const run: RunGit = async (cwd, args) => {
      const result = await git(cwd, args)
      if (timeout && args[0] === 'worktree' && args[1] === 'add') {
        timeout = false
        await git(f.project, ['worktree', 'lock', '--reason', 'initializing', allocation.path!])
        if (checkout === 'partial') {
          // Git fills the folder before reset writes its index. A killed reset leaves this state.
          const admin = join(f.project, '.git', 'worktrees', basename(allocation.path!))
          await unlink(join(admin, 'index'))
          await writeFile(join(admin, 'index.lock'), 'incomplete index')
        }
        throw Object.assign(new Error('Synthetic Git timeout'), { timedOut: true })
      }
      return result
    }
    const service = new ThreadWorktrees(f.root, run)
    await expect(service.ensure(allocation)).rejects.toThrow('took too long')
    await expect(lstat(allocation.path!)).rejects.toThrow()
    const listing = await git(f.project, ['worktree', 'list', '--porcelain', '-z'])
    expect(listing).not.toContain(allocation.path!.replace(/\\/gu, '/'))
    expect(await readFile(join(other.path!, 'keep.txt'), 'utf8')).toBe('other uncommitted work')
    const ready = await service.ensure({ ...allocation, status: 'error' })
    expect(ready).toMatchObject({ status: 'ready', branch: allocation.branch })
    expect(await readFile(join(ready.path!, 'tracked.txt'), 'utf8')).toBe('committed baseline')
  })
  it.each(['keep.txt', 'tracked.txt'])('preserves local work in %s during a timed-out checkout instead of forcing cleanup', async filename => {
    const f = await fixture()
    const allocation = await f.service.allocate(f.project, 'independent')
    const run: RunGit = async (cwd, args) => {
      const result = await git(cwd, args)
      if (args[0] === 'worktree' && args[1] === 'add') {
        await git(f.project, ['worktree', 'lock', '--reason', 'initializing', allocation.path!])
        await writeFile(join(allocation.path!, filename), 'work added during setup')
        throw Object.assign(new Error('Synthetic Git timeout'), { timedOut: true })
      }
      return result
    }
    await expect(new ThreadWorktrees(f.root, run).ensure(allocation)).rejects.toThrow('could not be safely removed')
    expect(await readFile(join(allocation.path!, filename), 'utf8')).toBe('work added during setup')
    expect(await git(f.project, ['worktree', 'list', '--porcelain'])).toContain('locked initializing')
  })
  it('recovers a partial checkout even when the branch tree exceeds the Git output limit', async () => {
    const f = await fixture()
    const blob = (await git(f.project, ['rev-parse', 'HEAD:tracked.txt'])).trim()
    // A real large tree, without filling the filesystem with thousands of checkout files.
    const names = Array.from({ length: 28_000 }, (_, index) => `file-${index}-${'x'.repeat(60)}.txt`)
    const input = names.map(name => `100644 blob ${blob}\t${name}\n`).join('')
    const tree = execFileSync('git', ['mktree'], { cwd: f.project, input, encoding: 'utf8', windowsHide: true }).trim()
    const commit = (await git(f.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-p', 'HEAD', '-m', 'Large source tree'])).trim()
    await git(f.project, ['update-ref', 'HEAD', commit])
    const allocation = await f.service.allocate(f.project, 'independent')
    const run: RunGit = async (cwd, args) => {
      if (args[0] !== 'worktree' || args[1] !== 'add') return git(cwd, args)
      await git(cwd, [...args.slice(0, 2), '--no-checkout', ...args.slice(2)])
      await git(f.project, ['worktree', 'lock', '--reason', 'initializing', allocation.path!])
      await writeFile(join(allocation.path!, names[0]!), 'committed baseline')
      throw Object.assign(new Error('Synthetic Git timeout'), { timedOut: true })
    }
    await expect(new ThreadWorktrees(f.root, run).ensure(allocation)).rejects.toThrow('Retry setup to continue on the same branch')
    await expect(lstat(allocation.path!)).rejects.toThrow()
    expect((await git(f.project, ['worktree', 'list', '--porcelain'])).match(/worktree /gu)).toHaveLength(1)
    expect((await git(f.project, ['rev-parse', allocation.branch!])).trim()).toBe(commit)
  })
  it('recovers a timed-out checkout containing a committed link inside its own folder', async () => {
    const f = await fixture()
    if (process.platform === 'win32') {
      // Git's normal Windows checkout represents committed symlinks as files with the link text.
      await git(f.project, ['config', 'core.symlinks', 'false'])
      await writeFile(join(f.project, 'tracked-link'), 'tracked.txt')
      const blob = (await git(f.project, ['hash-object', '-w', '--', 'tracked-link'])).trim()
      await git(f.project, ['update-index', '--add', '--cacheinfo', '120000', blob, 'tracked-link'])
    } else {
      await symlink('tracked.txt', join(f.project, 'tracked-link'), 'file')
      await git(f.project, ['add', 'tracked-link'])
    }
    await git(f.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Add internal link'])
    const allocation = await f.service.allocate(f.project, 'independent')
    const run: RunGit = async (cwd, args) => {
      const result = await git(cwd, args)
      if (args[0] === 'worktree' && args[1] === 'add') {
        await git(f.project, ['worktree', 'lock', '--reason', 'initializing', allocation.path!])
        throw Object.assign(new Error('Synthetic Git timeout'), { timedOut: true })
      }
      return result
    }
    await expect(new ThreadWorktrees(f.root, run).ensure(allocation)).rejects.toThrow('Retry setup to continue on the same branch')
    await expect(lstat(allocation.path!)).rejects.toThrow()
    expect((await git(f.project, ['worktree', 'list', '--porcelain'])).match(/worktree /gu)).toHaveLength(1)
  })
  it('does not reuse a checkout while Git reports it locked', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await git(f.project, ['worktree', 'lock', '--reason', 'initializing', a.path!])
    await expect(f.service.ensure(a)).rejects.toThrow('locked')
    await expect(f.service.inspect(a)).rejects.toThrow('locked')
    await expect(f.service.discover(a.path!, f.project)).rejects.toThrow('locked')
    await git(f.project, ['worktree', 'unlock', a.path!])
    expect((await f.service.ensure(a)).status).toBe('ready')
  })
})
