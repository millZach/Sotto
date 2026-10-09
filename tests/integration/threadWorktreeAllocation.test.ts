// @vitest-environment node

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'

import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runWorktreeGit as git, ThreadWorktrees, type RunGit } from '../../src/main/agents/threadWorktrees'

import { fixture, removeTestCheckout } from '../fixtures/threadWorktreeFixture'

describe("independent working-copy allocation", () => {
  it('coordinates setup and inspection without adding Git subprocesses to their existing validation', async () => {
    const f = await fixture()
    const calls: string[][] = []
    const service = new ThreadWorktrees(f.root, async (cwd, args) => { calls.push(args); return git(cwd, args) })
    const allocation = await service.allocate(f.project, 'independent')
    calls.length = 0
    const ready = await service.ensure(allocation)
    expect(calls).toHaveLength(7)
    expect(calls.filter(args => args.includes('--git-common-dir'))).toHaveLength(2)
    calls.length = 0
    expect((await service.inspect(ready)).status).toBe('ready')
    expect(calls).toHaveLength(5)
    expect(calls.filter(args => args.includes('--git-common-dir'))).toHaveLength(2)
    calls.length = 0
    expect((await service.ensure(ready)).status).toBe('ready')
    expect(calls).toHaveLength(6)
    expect(calls.filter(args => args.includes('--git-common-dir'))).toHaveLength(2)
    calls.length = 0
    expect(await service.discover(ready.path!, f.project)).toMatchObject({ mode: 'independent', path: ready.path, branch: ready.branch, reused: true })
    // The project folder's checkout identity is read from its files, not asked of Git (issue #766).
    expect(calls).toHaveLength(5)
    expect(calls.filter(args => args.includes('--git-common-dir'))).toHaveLength(2)
    await removeTestCheckout(f.root, ready.path!)
    calls.length = 0
    const restored = await service.restore(ready)
    expect(restored.status).toBe('ready')
    expect(calls).toHaveLength(5)
    expect(await readFile(join(restored.path!, 'tracked.txt'), 'utf8')).toBe('committed baseline')
    calls.length = 0
    expect((await service.reclaim(restored)).reclaimedAt).toBeDefined()
    // Reclaim adds bounded listings and repeats the ownership/content check before removal.
    expect(calls).toHaveLength(17)
  })

  it('checks the original repository independently before reading a discovered checkout status', async () => {
    const f = await fixture(), other = await fixture()
    const ready = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    let statusReads = 0
    const service = new ThreadWorktrees(f.root, async (cwd, args) => {
      if (args[0] === 'status') statusReads += 1
      if (cwd === f.project && args.includes('--git-common-dir')) return git(other.project, args)
      return git(cwd, args)
    })
    await expect(service.discover(ready.path!, f.project)).rejects.toThrow('no longer belongs to the original repository')
    expect(statusReads).toBe(0)
    expect(await readFile(join(ready.path!, 'tracked.txt'), 'utf8')).toBe('committed baseline')
  })

  it('coordinates registry access across service instances and linked project roots while another repository progresses', async () => {
    const f = await fixture()
    const other = await fixture()
    const linked = join(f.root, 'linked-project')
    await git(f.project, ['worktree', 'add', '-b', 'linked-project', '--', linked, 'HEAD'])
    await writeFile(join(f.project, 'tracked.txt'), 'source user edits')
    await writeFile(join(linked, 'tracked.txt'), 'linked user edits')
    const first = await f.service.allocate(f.project, 'independent')
    const second = await f.service.allocate(linked, 'independent')
    const independent = await other.service.allocate(other.project, 'independent')
    let started!: () => void
    const staged = new Promise<void>(resolve => { started = resolve })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let firstAdd = true
    const run: RunGit = async (cwd, args) => {
      if (cwd !== f.project || args[0] !== 'worktree' || args[1] !== 'add' || !firstAdd) return git(cwd, args)
      firstAdd = false
      const path = args[args.indexOf('--') + 1]!
      const admin = join(f.project, '.git', 'worktrees', basename(path))
      // Git creates these files before filling commondir. Hold that real registry state,
      // so an uncoordinated peer reads the same empty file as the captured failure.
      await mkdir(admin, { recursive: true }); await mkdir(path, { recursive: true })
      await writeFile(join(admin, 'locked'), 'initializing\n')
      await writeFile(join(admin, 'gitdir'), join(path, '.git') + '\n')
      await writeFile(join(path, '.git'), `gitdir: ${admin}\n`)
      await writeFile(join(admin, 'commondir'), '')
      started()
      await held
      expect(dirname(admin)).toBe(join(f.project, '.git', 'worktrees'))
      await rm(admin, { recursive: true, force: true })
      await removeTestCheckout(f.root, path)
      return git(cwd, args)
    }
    const creating = new ThreadWorktrees(f.root, run).ensure(first)
    await staged
    const queued = new ThreadWorktrees(f.root, run).ensure(second)
    // Observe rejections immediately; the assertion is the final outcomes, not elapsed time.
    const outcomes = Promise.allSettled([creating, queued])
    try {
      const separate = await new ThreadWorktrees(other.root, run).ensure(independent)
      expect(separate.status).toBe('ready')
    } finally { release() }
    const results = await outcomes
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(await readFile(join(first.path!, 'tracked.txt'), 'utf8')).toBe('committed baseline')
    expect(await readFile(join(second.path!, 'tracked.txt'), 'utf8')).toBe('committed baseline')
    expect(await readFile(join(f.project, 'tracked.txt'), 'utf8')).toBe('source user edits')
    expect(await readFile(join(linked, 'tracked.txt'), 'utf8')).toBe('linked user edits')
  })

  it('releases registry ownership after a rejected add without retrying or changing its refusal', async () => {
    const f = await fixture()
    const refused = await f.service.allocate(f.project, 'independent')
    const next = await f.service.allocate(f.project, 'independent')
    await git(f.project, ['branch', refused.branch!])
    let attempts = 0
    const run: RunGit = async (cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'add') attempts += 1
      return git(cwd, args)
    }
    await expect(new ThreadWorktrees(f.root, run).ensure(refused)).rejects.toThrow('already exists')
    expect(attempts).toBe(1)
    expect((await new ThreadWorktrees(f.root, run).ensure(next)).status).toBe('ready')
    expect(attempts).toBe(2)
    expect((await git(f.project, ['rev-parse', refused.branch!])).trim()).toBe(refused.baseCommit)
  })

  it('isolates concurrent allocations from a dirty source and retains user edits on reuse', async () => {
    const f = await fixture()
    await writeFile(join(f.project, 'tracked.txt'), 'source user edits')
    const [a, b] = await Promise.all([f.service.allocate(f.project, 'independent'), f.service.allocate(f.project, 'independent')])
    expect(a.branch).not.toBe(b.branch); expect(a.path).not.toBe(b.path)
    const [first, second] = await Promise.all([f.service.ensure(a), f.service.ensure(b)])
    expect(await readFile(join(first.path!, 'tracked.txt'), 'utf8')).toBe('committed baseline')
    await writeFile(join(first.path!, 'tracked.txt'), 'first edits')
    await writeFile(join(second.path!, 'tracked.txt'), 'second edits')
    expect(await readFile(join(f.project, 'tracked.txt'), 'utf8')).toBe('source user edits')
    expect((await new ThreadWorktrees(f.root).ensure(a)).dirty).toBe(true)
    expect(await readFile(join(first.path!, 'tracked.txt'), 'utf8')).toBe('first edits')
    expect(await readFile(join(second.path!, 'tracked.txt'), 'utf8')).toBe('second edits')
  })
  it('recovers a lost Git acknowledgement by checking exact registration before any retry', async () => {
    const f = await fixture(); const allocation = await f.service.allocate(f.project, 'independent')
    const flaky = new ThreadWorktrees(f.root, async (cwd, args) => {
      const result = await git(cwd, args)
      if (args.includes('add')) throw new Error('Lost acknowledgement')
      return result
    })
    await expect(flaky.ensure(allocation)).rejects.toThrow('Lost acknowledgement')
    expect((await f.service.ensure(allocation)).status).toBe('ready')
    expect((await git(f.project, ['worktree', 'list', '--porcelain'])).match(/worktree /gu)).toHaveLength(2)
  })
  it('keeps existing paths and branches untouched', async () => {
    const f = await fixture(); const pathCollision = await f.service.allocate(f.project, 'independent')
    await mkdir(pathCollision.path!, { recursive: true }); await writeFile(join(pathCollision.path!, 'user.txt'), 'keep')
    await expect(f.service.ensure(pathCollision)).rejects.toThrow('already exists')
    expect(await readFile(join(pathCollision.path!, 'user.txt'), 'utf8')).toBe('keep')
    const branchCollision = await f.service.allocate(f.project, 'independent')
    await git(f.project, ['branch', branchCollision.branch!])
    await expect(f.service.ensure(branchCollision)).rejects.toThrow('already exists')
    expect((await git(f.project, ['rev-parse', branchCollision.branch!])).trim()).toBe(branchCollision.baseCommit)
  })
  it('follows the branch a worktree has checked out and refuses only a folder that is not its checkout', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await git(a.path!, ['checkout', '-b', 'user-chosen-branch'])
    // Both the send path and Retry setup follow the branch the folder is on.
    expect(await f.service.inspect(a)).toMatchObject({ status: 'ready', branch: 'user-chosen-branch' })
    expect(await f.service.ensure(a)).toMatchObject({ status: 'ready', branch: 'user-chosen-branch' })
    await git(a.path!, ['checkout', '--detach'])
    const detached = await f.service.inspect(a)
    expect(detached.status).toBe('ready'); expect(detached.branch).toBeUndefined()
    expect(await readFile(join(a.path!, 'tracked.txt'), 'utf8')).toBe('committed baseline')
    const elsewhere = join(f.root, 'elsewhere'); await mkdir(elsewhere)
    await expect(f.service.inspect({ ...a, path: elsewhere })).rejects.toThrow('no longer this thread')
  })
  it('switches back to a named branch when the user asks, carrying uncommitted work and refusing anything else', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    const started = a.branch!
    await git(a.path!, ['checkout', '-b', 'feat/agent-chose'])
    await writeFile(join(a.path!, 'tracked.txt'), 'work in progress')
    const restored = await f.service.switchBranch(a, started)
    expect(restored).toMatchObject({ status: 'ready', branch: started, dirty: true })
    expect(await readFile(join(a.path!, 'tracked.txt'), 'utf8')).toBe('work in progress')
    expect(await f.service.switchBranch(restored, started)).toMatchObject({ branch: started })
    await expect(f.service.switchBranch(a, 'never-made')).rejects.toThrow('no longer exists')
    await expect(f.service.switchBranch(a, '--orphan')).rejects.toThrow('cannot be restored')
    await expect(f.service.switchBranch({ mode: 'shared', status: 'ready', path: f.project }, started)).rejects.toThrow('already used by worktree')
    expect((await f.service.inspect(a)).branch).toBe(started)
  })
  it('chooses the requested base, uses a short temporary branch, and explicitly reuses a registered checkout', async () => {
    const f = await fixture()
    await git(f.project, ['branch', 'chosen-base'])
    await writeFile(join(f.project, 'tracked.txt'), 'new main commit')
    await git(f.project, ['add', '.'])
    await git(f.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Main advanced'])
    const allocated = await f.service.allocate(f.project, 'independent', { baseBranch: 'chosen-base' })
    expect(allocated.branch).toMatch(/^sotto\/[a-f0-9]{8}$/u)
    const checkout = await f.service.ensure(allocated)
    expect(await readFile(join(checkout.path!, 'tracked.txt'), 'utf8')).toBe('committed baseline')
    const reused = await f.service.allocate(f.project, 'independent', { existingWorktreePath: checkout.path })
    expect(await f.service.ensure(reused)).toMatchObject({ path: checkout.path, branch: checkout.branch, reused: true })
    expect((await git(f.project, ['worktree', 'list', '--porcelain'])).match(/worktree /gu)).toHaveLength(2)
    await expect(f.service.allocate(f.project, 'independent', { baseBranch: 'missing' })).rejects.toThrow('base branch missing is unavailable')
    // No origin remote: Start from origin has nothing to fetch, so the worktree takes the local branch and says so.
    const noRemote = await f.service.allocate(f.project, 'independent', { baseBranch: 'chosen-base', startFromOrigin: true })
    expect(noRemote).toMatchObject({ baseBranch: 'chosen-base', startFromOrigin: true, originBase: 'no-origin' })
    expect(await readFile(join((await f.service.ensure(noRemote)).path!, 'tracked.txt'), 'utf8')).toBe('committed baseline')
  })
  it("checks a pull request's branch out as it stands in a new worktree, with no branch of its own", async () => {
    const f = await fixture()
    await git(f.project, ['branch', 'feat/pr'])
    const allocated = await f.service.allocate(f.project, 'independent', { checkoutBranch: 'feat/pr' })
    expect(allocated).toMatchObject({ status: 'pending', branch: 'feat/pr', checkoutBranch: true, temporaryBranch: false })
    const checkout = await f.service.ensure(allocated)
    expect(checkout).toMatchObject({ status: 'ready', branch: 'feat/pr' })
    expect((await git(checkout.path!, ['branch', '--show-current'])).trim()).toBe('feat/pr')
    expect((await git(f.project, ['branch', '--list', 'sotto/*'])).trim()).toBe('')
    await expect(f.service.allocate(f.project, 'independent', { checkoutBranch: 'gone' })).rejects.toThrow('The branch gone is gone.')
    // The branch is in that folder now, so a second worktree for it is refused rather than forced.
    await expect(f.service.ensure(await f.service.allocate(f.project, 'independent', { checkoutBranch: 'feat/pr' }))).rejects.toThrow('already checked out in another folder')
  })
  it('fetches the explicitly selected origin branch instead of silently using local HEAD', async () => {
    const f = await fixture()
    const remote = join(f.root, 'origin'); await mkdir(remote)
    await git(remote, ['init', '--bare'])
    await git(f.project, ['remote', 'add', 'origin', remote])
    await git(f.project, ['push', 'origin', 'HEAD:refs/heads/base'])
    await git(f.project, ['branch', 'base'])
    await writeFile(join(f.project, 'tracked.txt'), 'local-only commit')
    await git(f.project, ['add', '.'])
    await git(f.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Local'])
    await git(f.project, ['branch', '-f', 'base', 'HEAD'])
    const checkout = await f.service.ensure(await f.service.allocate(f.project, 'independent', { baseBranch: 'base', startFromOrigin: true }))
    expect(await readFile(join(checkout.path!, 'tracked.txt'), 'utf8')).toBe('committed baseline')
    expect(checkout).toMatchObject({ baseBranch: 'base', startFromOrigin: true, originBase: 'fetched' })
    // A branch origin does not have falls back to the local one, as T3 does, and the worktree records that it did.
    await git(f.project, ['branch', 'local-only', 'HEAD'])
    const local = await f.service.ensure(await f.service.allocate(f.project, 'independent', { baseBranch: 'local-only', startFromOrigin: true }))
    expect(local).toMatchObject({ baseBranch: 'local-only', startFromOrigin: true, originBase: 'not-on-origin' })
    expect(await readFile(join(local.path!, 'tracked.txt'), 'utf8')).toBe('local-only commit')
    // A fetch that fails for any other reason still stops setup: here the remote is not there to ask.
    await git(f.project, ['remote', 'set-url', 'origin', join(f.root, 'no-such-remote')])
    await expect(f.service.allocate(f.project, 'independent', { baseBranch: 'base', startFromOrigin: true })).rejects.toThrow('could not be fetched')
    const options = await f.service.options(f.project)
    expect(options.branches).toContain('base')
    expect(options.worktrees).toContainEqual({ path: checkout.path!.replaceAll('\\', '/'), branch: checkout.branch })
  })
  it('lets Git refuse a conflicting shared-checkout restore without losing current edits', async () => {
    const f = await fixture()
    const shared = await f.service.inspect(await f.service.allocate(f.project, 'shared'))
    await git(f.project, ['switch', '-c', 'different'])
    await writeFile(join(f.project, 'tracked.txt'), 'branch changes')
    await git(f.project, ['add', '.'])
    await git(f.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Different'])
    await writeFile(join(f.project, 'tracked.txt'), 'unsaved user work')
    await expect(f.service.switchBranch(shared, shared.branch!)).rejects.toThrow()
    expect(await readFile(join(f.project, 'tracked.txt'), 'utf8')).toBe('unsaved user work')
    expect((await f.service.inspect(shared)).branch).toBe('different')
  })
  it('reads and restores a shared checkout branch and clears the branch at detached HEAD', async () => {
    const f = await fixture()
    const shared = await f.service.inspect(await f.service.allocate(f.project, 'shared'))
    await git(f.project, ['switch', '-c', 'next'])
    await writeFile(join(f.project, 'tracked.txt'), 'uncommitted edits')
    expect(await f.service.inspect(shared)).toMatchObject({ branch: 'next', dirty: true })
    expect(await f.service.switchBranch(shared, shared.branch!)).toMatchObject({ branch: shared.branch, dirty: true })
    expect(await readFile(join(f.project, 'tracked.txt'), 'utf8')).toBe('uncommitted edits')
    await git(f.project, ['checkout', '--detach'])
    expect((await f.service.inspect(shared)).branch).toBeUndefined()
  })
  it('renames only a still-temporary worktree branch and preserves an agent-selected branch', async () => {
    const f = await fixture()
    const checkout = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    const named = await f.service.renameTemporaryBranch(checkout, 'sotto/fix-something')
    expect(named).toMatchObject({ branch: 'sotto/fix-something', temporaryBranch: false })
    const next = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await git(next.path!, ['switch', '-c', 'feat/agent-chose'])
    expect(await f.service.renameTemporaryBranch(next, 'sotto/do-not-use')).toMatchObject({ branch: 'feat/agent-chose', temporaryBranch: false })
  })
  it('requires an initial Git commit but permits a deliberate shared empty or non-Git folder', async () => {
    const f = await fixture(false)
    await expect(f.service.allocate(f.project, 'independent')).rejects.toThrow('no commit')
    expect(await f.service.allocate(f.project, 'shared')).toMatchObject({ mode: 'shared', status: 'ready', path: f.project })
    const ordinary = join(f.root, 'ordinary'); await mkdir(ordinary)
    expect(await f.service.allocate(ordinary, 'independent')).toMatchObject({ mode: 'shared', status: 'ready', path: ordinary })
  })
  it('does not silently share after missing Git, permission failures, or an unavailable project', async () => {
    const f = await fixture()
    for (const message of ['Git is unavailable', 'Permission denied']) {
      const unavailable = new ThreadWorktrees(f.root, async () => { throw new Error(message) })
      await expect(unavailable.allocate(f.project, 'independent')).rejects.toThrow(message)
      expect((await unavailable.allocate(f.project, 'shared')).status).toBe('ready')
    }
    await expect(f.service.allocate(join(f.root, 'missing'), 'independent')).rejects.toThrow()
  })
  it('preserves a monorepo project subdirectory and rejects uncommitted-only counterparts until committed', async () => {
    const f = await fixture()
    const app = join(f.project, 'packages', 'app'); await mkdir(app, { recursive: true })
    await writeFile(join(app, 'index.txt'), 'app contents')
    await expect(f.service.allocate(app, 'independent')).rejects.toThrow('not present in the committed source')
    await git(f.project, ['add', '.'])
    await git(f.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Add app'])
    const a = await f.service.ensure(await f.service.allocate(app, 'independent'))
    expect(a.projectRelativePath).toBe('packages/app')
    expect(await f.service.workingDirectory(a)).toBe(join(a.path!, 'packages', 'app'))
    expect(await readFile(join(await f.service.workingDirectory(a), 'index.txt'), 'utf8')).toBe('app contents')
  })
})
