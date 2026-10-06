// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkoutIdentity, existingWorkingDirectory, runWorktreeGit as git, ThreadWorktrees, type RunGit } from '../../../src/main/agents/threadWorktrees'
import { resolveThreadWorkingDirectory } from '../../../src/shared/threadWorkingDirectory'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-worktree-test-')) throw new Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture(commit = true) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-worktree-test-')); roots.push(root)
  const project = join(root, 'project'); await mkdir(project)
  await git(project, ['init'])
  if (commit) {
    await writeFile(join(project, 'tracked.txt'), 'committed baseline')
    await git(project, ['add', '.'])
    await git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Baseline'])
  }
  return { root, project, service: new ThreadWorktrees(root) }
}
async function submoduleHistoryFixture(reference: 'branch' | 'tag' | 'no-remote' | 'deinitialized-branch' | 'deinitialized-tag' = 'branch', moduleName = 'module') {
  const f = await fixture()
  const origin = join(f.root, 'module-origin'); await mkdir(origin)
  await git(origin, ['init'])
  await writeFile(join(origin, 'module.txt'), 'published baseline')
  await git(origin, ['add', '.'])
  await git(origin, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Module baseline'])
  await git(f.project, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', moduleName, origin, 'module'])
  await git(f.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', 'Add module'])
  const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
  await git(a.path!, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init'])
  const module = join(a.path!, 'module')
  const recorded = (await git(module, ['rev-parse', 'HEAD'])).trim()
  const gitDirectory = (await git(module, ['rev-parse', '--absolute-git-dir'])).trim()
  await git(module, ['checkout', '-b', 'private'])
  await writeFile(join(module, 'private.txt'), 'local-only history')
  await git(module, ['add', '.'])
  await git(module, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Private module work'])
  const privateCommit = (await git(module, ['rev-parse', 'HEAD'])).trim()
  if (reference === 'tag' || reference === 'deinitialized-tag') await git(module, ['tag', 'private-save'])
  await git(module, ['checkout', '--detach', recorded])
  if (reference === 'tag' || reference === 'deinitialized-tag') await git(module, ['branch', '-D', 'private'])
  if (reference === 'no-remote') await git(module, ['remote', 'remove', 'origin'])
  if (reference.startsWith('deinitialized-')) await git(a.path!, ['submodule', 'deinit', '--', 'module'])
  return { ...f, a, module, gitDirectory, privateCommit }
}
/** Removes only a test-owned checkout under the fixture root; the production implementation has no removal path. */
async function removeTestCheckout(root: string, path: string) {
  expect(resolve(path).startsWith(resolve(root) + '\\') || resolve(path).startsWith(resolve(root) + '/')).toBe(true)
  await rm(path, { recursive: true })
}
describe('independent working-copy allocation', () => {
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
  it('reclaims a clean worktree, keeps its branch, and restore puts the folder back on it', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await git(a.path!, ['checkout', '-b', 'feat/finished'])
    await writeFile(join(a.path!, 'tracked.txt'), 'finished work')
    await git(a.path!, ['add', '.'])
    await git(a.path!, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Finish'])
    await mkdir(join(a.path!, 'node_modules', 'dep'), { recursive: true }); await writeFile(join(a.path!, 'node_modules', 'dep', 'index.js'), '')
    await writeFile(join(a.path!, '.gitignore'), 'node_modules/\n'); await git(a.path!, ['add', '.gitignore'])
    await git(a.path!, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Ignore deps'])
    const tip = (await git(f.project, ['rev-parse', 'feat/finished'])).trim()
    const recorded = await f.service.inspect(a)
    expect(await f.service.reclaimFacts(recorded)).toMatchObject({ branch: 'feat/finished', dirty: false, ignored: [], outsideLink: undefined })
    const reclaimed = await f.service.reclaim(recorded, { automatic: true })
    expect(reclaimed).toMatchObject({ status: 'ready', branch: 'feat/finished', path: a.path })
    expect(reclaimed.reclaimedAt).toBeTruthy()
    await expect(lstat(a.path!)).rejects.toThrow()
    expect((await git(f.project, ['rev-parse', 'feat/finished'])).trim()).toBe(tip)
    expect((await git(f.project, ['worktree', 'list', '--porcelain'])).match(/worktree /gu)).toHaveLength(1)
    // Nothing else in the repository moved.
    expect(await readFile(join(f.project, 'tracked.txt'), 'utf8')).toBe('committed baseline')
    const restored = await f.service.inspect(await f.service.restore(reclaimed))
    expect(restored).toMatchObject({ status: 'ready', branch: 'feat/finished', reclaimedAt: undefined })
    expect(await readFile(join(a.path!, 'tracked.txt'), 'utf8')).toBe('finished work')
  })
  it('discards uncommitted work only after the user answers, and never for a rule', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await writeFile(join(a.path!, 'tracked.txt'), 'unsaved')
    await expect(f.service.reclaim(a)).rejects.toThrow('confirm it first')
    await expect(f.service.reclaim(a, { automatic: true, withUncommittedChanges: true })).rejects.toThrow()
    expect(await readFile(join(a.path!, 'tracked.txt'), 'utf8')).toBe('unsaved')
    expect((await f.service.reclaim(a, { withUncommittedChanges: true })).reclaimedAt).toBeTruthy()
    await expect(lstat(a.path!)).rejects.toThrow()
  })
  it('leaves a folder alone when a rule finds ignored files besides dependencies, a link out of it, or no branch', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await writeFile(join(a.path!, '.gitignore'), 'node_modules/\nout/\n'); await git(a.path!, ['add', '.gitignore'])
    await git(a.path!, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Ignore'])
    await mkdir(join(a.path!, 'out')); await writeFile(join(a.path!, 'out', 'bundle.js'), '')
    expect((await f.service.reclaimFacts(a)).ignored).toEqual(['out/'])
    await expect(f.service.reclaim(a, { automatic: true })).rejects.toThrow('besides installed dependencies')
    // A link that leads out of the folder could be followed by the removal; the real folder behind it must stay whole.
    const shared = join(f.root, 'shared-deps'); await mkdir(shared); await writeFile(join(shared, 'keep.txt'), 'real install')
    await symlink(shared, join(a.path!, 'node_modules'), 'junction')
    expect((await f.service.reclaimFacts(a)).outsideLink).toBe('node_modules')
    await expect(f.service.reclaim(a, { withUncommittedChanges: true })).rejects.toThrow('link to another folder')
    expect(await readFile(join(shared, 'keep.txt'), 'utf8')).toBe('real install')
    await rm(join(a.path!, 'node_modules'), { recursive: false }).catch(() => unlink(join(a.path!, 'node_modules')))
    await rm(join(a.path!, 'out'), { recursive: true })
    await git(a.path!, ['checkout', '--detach'])
    await expect(f.service.reclaim(a)).rejects.toThrow('no branch checked out')
    expect(await readFile(join(a.path!, 'tracked.txt'), 'utf8')).toBe('committed baseline')
    await expect(f.service.reclaim({ mode: 'shared', status: 'ready', path: f.project })).rejects.toThrow('shared or reused folder stays')
    expect((await git(f.project, ['worktree', 'list', '--porcelain'])).match(/worktree /gu)).toHaveLength(2)
  })
  it('requires the exact ignored file list and refuses new files added after the confirmation', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await writeFile(join(a.path!, '.gitignore'), '.env\nlocal/\nnode_modules/\n')
    await git(a.path!, ['add', '.gitignore'])
    await git(a.path!, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Ignore local files'])
    const empty = await f.service.reclaimFacts(a)
    await writeFile(join(a.path!, '.env'), 'keep this secret')
    await mkdir(join(a.path!, 'local'))
    await writeFile(join(a.path!, 'local', 'data.txt'), 'local data')
    const facts = await f.service.reclaimFacts(a)
    expect(facts).toMatchObject({ dirty: false, ignored: ['.env', 'local/'] })
    await expect(f.service.reclaim(a)).rejects.toThrow('holds ignored files')
    await expect(f.service.reclaim(a, { confirmedItems: empty.items, confirmedIgnored: empty.ignored })).rejects.toThrow('ignored items changed')
    await expect(f.service.reclaim(a, { automatic: true, confirmedItems: facts.items, confirmedIgnored: facts.ignored })).rejects.toThrow('besides installed dependencies')
    await writeFile(join(a.path!, 'another.env'), 'new local work')
    await writeFile(join(a.path!, '.gitignore'), '.env\nanother.env\nlocal/\nnode_modules/\n')
    await git(a.path!, ['add', '.gitignore'])
    await git(a.path!, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Ignore another file'])
    await expect(f.service.reclaim(a, { confirmedItems: facts.items, confirmedIgnored: facts.ignored })).rejects.toThrow('ignored items changed')
    expect(await readFile(join(a.path!, '.env'), 'utf8')).toBe('keep this secret')
    const refreshed = await f.service.reclaimFacts(a)
    expect((await f.service.reclaim(a, { confirmedItems: refreshed.items, confirmedIgnored: refreshed.ignored })).reclaimedAt).toBeTruthy()
  })
  it.each([
    ['repository', true], ['worktree', true], ['repository', false], ['worktree', false],
  ] as const)('lists a nested %s (ignored: %s) and removes it only with the tick', async (kind, ignored) => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await writeFile(join(a.path!, '.gitignore'), ignored ? '.worktrees/\n' : '')
    await git(a.path!, ['add', '.gitignore'])
    await git(a.path!, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Ignore nested folders'])
    const nested = join(a.path!, '.worktrees', 'n')
    await mkdir(nested, { recursive: true })
    if (kind === 'repository') await git(nested, ['init'])
    else await git(f.project, ['worktree', 'add', '-b', 'nested', '--', nested, 'HEAD'])
    await writeFile(join(nested, 'unsaved.txt'), 'nested uncommitted work')
    const facts = await f.service.reclaimFacts(a)
    expect(facts.ignored).toEqual(ignored ? ['.worktrees/', '.worktrees/n/'] : ['.worktrees/n/'])
    expect(facts.repositories).toEqual([{ path: '.worktrees/n/', changeCount: 1, ...(kind === 'repository' ? { unpushedCommitCount: 0 } : {}), kind }])
    await expect(f.service.reclaim(a, { withUncommittedChanges: true })).rejects.toThrow('holds ignored files')
    await expect(f.service.reclaim(a, { withUncommittedChanges: true, confirmedItems: facts.items, confirmedIgnored: facts.ignored })).rejects.toThrow('nested work changed')
    expect(await readFile(join(nested, 'unsaved.txt'), 'utf8')).toBe('nested uncommitted work')
    expect((await f.service.reclaim(a, { withUncommittedChanges: true, confirmedItems: facts.items, confirmedIgnored: facts.ignored, confirmedRepositories: facts.repositories })).reclaimedAt).toBeTruthy()
    await expect(lstat(nested)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['added', 'removed', 'rewritten'])('checks file counts inside the confirmed ignored folder (%s)', async change => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await writeFile(join(a.path!, '.gitignore'), 'dist/\n')
    await git(a.path!, ['add', '.gitignore'])
    await git(a.path!, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Ignore cache'])
    await mkdir(join(a.path!, 'dist'))
    await writeFile(join(a.path!, 'dist', 'one.js'), '1234')
    const facts = await f.service.reclaimFacts(a)
    expect(facts.ignored).toEqual(['dist/'])
    expect(facts.items).toEqual([{ path: 'dist/', bytes: 4, fileCount: 1 }])
    if (change === 'added') await writeFile(join(a.path!, 'dist', 'two.js'), 'unseen work')
    else if (change === 'removed') await unlink(join(a.path!, 'dist', 'one.js'))
    else await writeFile(join(a.path!, 'dist', 'one.js'), 'a rewritten cache with a different size')
    const removal = f.service.reclaim(a, { confirmedItems: facts.items, confirmedIgnored: facts.ignored })
    if (change === 'rewritten') expect((await removal).reclaimedAt).toBeTruthy()
    else {
      await expect(removal).rejects.toThrow('The folder changed. Nothing was removed. Choose Remove worktree again to see the new list.')
      expect((await lstat(a.path!)).isDirectory()).toBe(true)
      if (change === 'added') expect(await readFile(join(a.path!, 'dist', 'two.js'), 'utf8')).toBe('unseen work')
      const refreshed = await f.service.reclaimFacts(a)
      expect((await f.service.reclaim(a, { confirmedItems: refreshed.items, confirmedIgnored: refreshed.ignored })).reclaimedAt).toBeTruthy()
    }
  })
  it('refuses files appearing inside an ignored folder after the first reclaim observation', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await writeFile(join(a.path!, '.gitignore'), '.local/\n')
    await git(a.path!, ['add', '.gitignore'])
    await git(a.path!, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Ignore local files'])
    await mkdir(join(a.path!, '.local'))
    await writeFile(join(a.path!, '.local', 'cache.txt'), 'cache')
    const preview = await f.service.reclaimFacts(a)
    let reads = 0
    const service = new ThreadWorktrees(f.root, async (cwd, args) => {
      if (cwd === a.path && args.includes('--ignored') && ++reads === 2) await writeFile(join(a.path!, '.local', 'secret.txt'), 'unseen secret')
      return git(cwd, args)
    })
    await expect(service.reclaim(a, { confirmedIgnored: preview.ignored, confirmedItems: preview.items })).rejects.toThrow('The folder changed')
    expect(await readFile(join(a.path!, '.local', 'secret.txt'), 'utf8')).toBe('unseen secret')
  })
  it.each(['containing', 'separate'])('clears removed nested worktree registrations in the %s repository', async owner => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    const repository = owner === 'containing' ? f.project : join(f.root, 'other')
    if (owner === 'separate') await git(f.root, ['clone', '--', f.project, repository])
    const nested = join(a.path!, 'nested')
    await git(repository, ['worktree', 'add', '-b', 'nested', '--', nested, 'HEAD'])
    await writeFile(join(nested, 'unsaved.txt'), 'nested work')
    const otherMissing = join(f.root, 'other-missing')
    await git(repository, ['worktree', 'add', '-b', 'missing', '--', otherMissing, 'HEAD'])
    await removeTestCheckout(f.root, otherMissing)
    const preview = await f.service.reclaimFacts(a)
    expect((await f.service.reclaim(a, { withUncommittedChanges: true, confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).reclaimedAt).toBeTruthy()
    const registrations = await git(repository, ['worktree', 'list', '--porcelain'])
    expect(registrations).not.toContain('refs/heads/nested')
    expect(registrations).toContain('refs/heads/missing')
    expect((await git(repository, ['branch', '--list', 'nested'])).trim()).toBe('nested')
    const replacement = join(f.root, 'replacement')
    await git(repository, ['worktree', 'add', '--', replacement, 'nested'])
    expect((await lstat(replacement)).isDirectory()).toBe(true)
  })
  it('preserves a nested worktree locked after its preview', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    const nested = join(a.path!, 'nested')
    await git(f.project, ['worktree', 'add', '-b', 'nested', '--', nested, 'HEAD'])
    const preview = await f.service.reclaimFacts(a)
    await git(f.project, ['worktree', 'lock', '--', nested])
    await expect(f.service.reclaim(a, { withUncommittedChanges: true, confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).rejects.toThrow('A nested worktree is locked. Nothing was removed.')
    expect((await lstat(nested)).isDirectory()).toBe(true)
    expect(await git(f.project, ['worktree', 'list', '--porcelain'])).toContain('refs/heads/nested')
    await git(f.project, ['worktree', 'unlock', '--', nested])
    const refreshed = await f.service.reclaimFacts(a)
    expect((await f.service.reclaim(a, { withUncommittedChanges: true, confirmedItems: refreshed.items, confirmedIgnored: refreshed.ignored, confirmedRepositories: refreshed.repositories })).reclaimedAt).toBeTruthy()
    expect(await git(f.project, ['worktree', 'list', '--porcelain'])).not.toContain('refs/heads/nested')
  })
  it('refuses an unseen ignored file inside a confirmed nested repository row', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    const nested = join(a.path!, 'nested'); await mkdir(nested); await git(nested, ['init'])
    await writeFile(join(nested, '.gitignore'), '*.secret\n')
    const preview = await f.service.reclaimFacts(a)
    expect(preview.items.find(item => item.path === 'nested/')?.fileCount).toBeGreaterThan(0)
    await writeFile(join(nested, 'unseen.secret'), 'keep this')
    const latest = await f.service.reclaimFacts(a)
    expect(latest.repositories).toEqual(preview.repositories)
    await expect(f.service.reclaim(a, { withUncommittedChanges: true, confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).rejects.toThrow('The folder changed')
    expect(await readFile(join(nested, 'unseen.secret'), 'utf8')).toBe('keep this')
  })
  it.each(['branch', 'tag', 'bare'])('counts unpublished nested history outside HEAD (%s)', async reference => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    const nested = join(a.path!, 'nested')
    await git(a.path!, ['clone', '--', f.project, nested])
    await git(nested, ['checkout', '-b', 'private'])
    await writeFile(join(nested, 'private.txt'), 'unpublished history')
    await git(nested, ['add', '.'])
    await git(nested, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Private'])
    if (reference === 'tag') await git(nested, ['tag', 'private-save'])
    await git(nested, ['checkout', '-'])
    if (reference === 'tag') await git(nested, ['branch', '-D', 'private'])
    if (reference === 'bare') {
      const bare = join(f.root, 'bare')
      await git(f.root, ['clone', '--bare', '--', nested, bare])
      await removeTestCheckout(f.root, nested)
      await rename(bare, nested)
      await git(nested, ['update-ref', 'refs/remotes/origin/main', (await git(f.project, ['rev-parse', 'HEAD'])).trim()])
      await git(nested, ['symbolic-ref', 'HEAD', 'refs/heads/unborn'])
    }
    const preview = await f.service.reclaimFacts(a)
    expect(preview.repositories.find(item => item.kind === 'repository')?.unpushedCommitCount).toBe(1)
  })
  it.each(['none', 'some', 'all'])('counts nested repository commits not on a remote (%s published)', async published => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    const nested = join(a.path!, 'nested'); await mkdir(nested); await git(nested, ['init'])
    await writeFile(join(nested, 'saved.txt'), 'first')
    await git(nested, ['add', '.'])
    await git(nested, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'First'])
    const first = (await git(nested, ['rev-parse', 'HEAD'])).trim()
    await writeFile(join(nested, 'saved.txt'), 'second')
    await git(nested, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', 'Second'])
    if (published !== 'none') {
      await git(nested, ['remote', 'add', 'origin', f.project])
      await git(nested, ['update-ref', 'refs/remotes/origin/main', published === 'some' ? first : 'HEAD'])
    }
    const preview = await f.service.reclaimFacts(a)
    expect(preview.repositories).toEqual([{ path: 'nested/', changeCount: 0, kind: 'repository', unpushedCommitCount: published === 'none' ? 2 : published === 'some' ? 1 : 0 }])
  })
  it.each(['ignored', 'untracked'])('refuses a new %s path added during the final filesystem walk', async kind => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await writeFile(join(a.path!, '.gitignore'), '*.env\n.cache/\n')
    await git(a.path!, ['add', '.gitignore'])
    await git(a.path!, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Ignore secrets'])
    const nested = join(a.path!, '.cache', 'nested'); await mkdir(nested, { recursive: true }); await git(nested, ['init'])
    const preview = await f.service.reclaimFacts(a)
    let reads = 0
    const service = new ThreadWorktrees(f.root, async (cwd, args) => {
      // Both early ls-files calls have completed by the time the walk enters this repository.
      if (cwd === nested && args[0] === 'status' && ++reads === 2) await writeFile(join(a.path!, kind === 'ignored' ? 'new.env' : 'unsaved.txt'), 'keep me')
      return git(cwd, args)
    })
    await expect(service.reclaim(a, { confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).rejects.toThrow('files changed')
    expect(await readFile(join(a.path!, kind === 'ignored' ? 'new.env' : 'unsaved.txt'), 'utf8')).toBe('keep me')
  })
  it.each(['branch', 'tag', 'no-remote'] as const)('requires acknowledgement of clean submodule history outside HEAD (%s)', async reference => {
    const f = await submoduleHistoryFixture(reference)
    expect((await lstat(join(f.module, '.git'))).isFile()).toBe(true)
    expect(await git(f.module, ['status', '--porcelain'])).toBe('')
    const preview = await f.service.reclaimFacts(f.a)
    expect(preview.dirty).toBe(false)
    expect(preview.repositories).toEqual([{ path: 'module/', changeCount: 0, kind: 'repository', unpushedCommitCount: reference === 'no-remote' ? 2 : 1 }])
    expect(preview.ignored).toEqual(['module/'])
    expect(preview.items.find(item => item.path === 'module/')?.fileCount).toBeGreaterThan(0)
    await expect(f.service.reclaim(f.a, { automatic: true })).rejects.toThrow('a rule leaves it alone')
    await expect(f.service.reclaim(f.a)).rejects.toThrow('Choose Remove worktree to review them')
    await expect(f.service.reclaim(f.a, { confirmedItems: preview.items, confirmedIgnored: preview.ignored })).rejects.toThrow('The nested work changed')
    expect((await lstat(f.gitDirectory)).isDirectory()).toBe(true)
    expect(await git(f.module, ['cat-file', '-t', f.privateCommit])).toBe('commit\n')
    expect((await f.service.reclaim(f.a, { confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).reclaimedAt).toBeTruthy()
    await expect(lstat(f.gitDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)
  it('rechecks unpublished submodule history inside the registry lane', async () => {
    const f = await submoduleHistoryFixture()
    const preview = await f.service.reclaimFacts(f.a)
    let historyReads = 0
    const service = new ThreadWorktrees(f.root, async (cwd, args) => {
      if (cwd === f.module && args[0] === 'rev-list' && ++historyReads === 2) {
        // Only refs change: the clean checkout and its file count stay the same.
        const tree = (await git(f.module, ['rev-parse', `${f.privateCommit}^{tree}`])).trim()
        const unseen = (await git(f.module, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-p', f.privateCommit, '-m', 'Unseen module history'])).trim()
        await git(f.module, ['update-ref', 'refs/heads/private', unseen])
      }
      return git(cwd, args)
    })
    await expect(service.reclaim(f.a, { confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).rejects.toThrow('The files changed')
    expect(historyReads).toBe(2)
    expect(await git(f.module, ['cat-file', '-t', f.privateCommit])).toBe('commit\n')
    expect((await lstat(f.gitDirectory)).isDirectory()).toBe(true)
  })
  it.each(['deinitialized-branch', 'deinitialized-tag'] as const)('requires acknowledgement of retained submodule history (%s)', async reference => {
    const f = await submoduleHistoryFixture(reference, reference === 'deinitialized-tag' ? 'kept.history' : 'module')
    await expect(lstat(join(f.module, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await lstat(f.gitDirectory)).isDirectory()).toBe(true)
    const preview = await f.service.reclaimFacts(f.a)
    expect(preview.dirty).toBe(false)
    expect(preview.repositories).toEqual([{ path: 'module/', changeCount: 0, kind: 'repository', unpushedCommitCount: 1 }])
    await expect(f.service.reclaim(f.a, { automatic: true })).rejects.toThrow('a rule leaves it alone')
    await expect(f.service.reclaim(f.a)).rejects.toThrow('Choose Remove worktree to review them')
    expect(await git(f.gitDirectory, ['--git-dir', f.gitDirectory, 'cat-file', '-t', f.privateCommit])).toBe('commit\n')
    expect((await f.service.reclaim(f.a, { confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).reclaimedAt).toBeTruthy()
    await expect(lstat(f.gitDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)
  it.each(['published', 'private'] as const)('inspects retained recursive submodule history without its checkout (%s)', async history => {
    const f = await fixture(), moduleOrigin = await fixture(), childOrigin = await fixture()
    await git(moduleOrigin.project, ['-c', 'protocol.file.allow=always', 'submodule', 'add', childOrigin.project, 'child'])
    await git(moduleOrigin.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', 'Add child module'])
    await git(f.project, ['-c', 'protocol.file.allow=always', 'submodule', 'add', moduleOrigin.project, 'module'])
    await git(f.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', 'Add module'])
    const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await git(a.path!, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'])
    const child = join(a.path!, 'module', 'child')
    const recorded = (await git(child, ['rev-parse', 'HEAD'])).trim()
    const childDirectory = (await git(child, ['rev-parse', '--absolute-git-dir'])).trim()
    let privateCommit = ''
    if (history === 'private') {
      await git(child, ['checkout', '-b', 'private'])
      await writeFile(join(child, 'private.txt'), 'unpublished recursive history')
      await git(child, ['add', '.'])
      await git(child, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Private child work'])
      privateCommit = (await git(child, ['rev-parse', 'HEAD'])).trim()
      await git(child, ['checkout', '--detach', recorded])
    }
    await git(a.path!, ['submodule', 'deinit', '--', 'module'])
    await expect(lstat(child)).rejects.toMatchObject({ code: 'ENOENT' })
    // Parent deinit retains the child's core.worktree pointing at the removed checkout.
    expect(await readFile(join(childDirectory, 'config'), 'utf8')).toContain('worktree =')
    const preview = await f.service.reclaimFacts(a)
    expect(preview.dirty).toBe(false)
    if (history === 'published') {
      expect(preview.repositories).toEqual([])
      expect(preview.ignored).toEqual([])
      expect((await f.service.reclaim(a, { automatic: true })).reclaimedAt).toBeTruthy()
    } else {
      expect(preview.repositories).toEqual([{ path: '.git/modules/module/modules/child/', changeCount: 0, kind: 'repository', unpushedCommitCount: 1 }])
      expect(preview.items.find(item => item.path === '.git/modules/module/modules/child/')?.fileCount).toBeGreaterThan(0)
      await expect(f.service.reclaim(a, { automatic: true })).rejects.toThrow('a rule leaves it alone')
      await expect(f.service.reclaim(a)).rejects.toThrow('Choose Remove worktree to review them')
      await expect(f.service.reclaim(a, { confirmedItems: preview.items, confirmedIgnored: preview.ignored })).rejects.toThrow('The nested work changed')
      expect(await git(childDirectory, ['--git-dir', childDirectory, '--work-tree', childDirectory, 'cat-file', '-t', privateCommit])).toBe('commit\n')
      expect((await f.service.reclaim(a, { confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).reclaimedAt).toBeTruthy()
    }
    await expect(lstat(childDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)
  it.each(['clean', 'recursive', 'dirty-hidden'])('reclaims initialized submodules safely (%s)', async mode => {
    const recursive = mode === 'recursive'
    const f = await fixture()
    const module = join(f.root, 'module'); await mkdir(module)
    await git(module, ['init'])
    await writeFile(join(module, 'module.txt'), 'committed')
    await git(module, ['add', '.'])
    await git(module, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Module'])
    if (recursive) {
      const childModule = join(f.root, 'child-module'); await mkdir(childModule)
      await git(childModule, ['init'])
      await writeFile(join(childModule, 'child.txt'), 'committed child')
      await git(childModule, ['add', '.'])
      await git(childModule, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Child'])
      await git(module, ['-c', 'protocol.file.allow=always', 'submodule', 'add', childModule, 'child'])
      await git(module, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', 'Add child module'])
    }
    await git(f.project, ['-c', 'protocol.file.allow=always', 'submodule', 'add', module, 'module'])
    await git(f.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', 'Add submodule'])
    const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await git(a.path!, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'])
    if (mode === 'dirty-hidden') {
      await git(a.path!, ['config', 'submodule.module.ignore', 'all'])
      await writeFile(join(a.path!, 'module', 'module.txt'), 'uncommitted module work')
      const facts = await f.service.reclaimFacts(a)
      expect(facts.dirty).toBe(true)
      expect(facts.repositories).toEqual([{ path: 'module/', changeCount: 1, kind: 'repository', unpushedCommitCount: 0 }])
      await expect(f.service.reclaim(a, { automatic: true })).rejects.toThrow('besides installed dependencies')
      expect((await f.service.reclaim(a, { withUncommittedChanges: true, confirmedItems: facts.items, confirmedIgnored: facts.ignored, confirmedRepositories: facts.repositories })).reclaimedAt).toBeTruthy()
      return
    }
    expect((await f.service.reclaimFacts(a)).repositories).toEqual([])
    expect((await f.service.reclaim(a, { automatic: true })).reclaimedAt).toBeTruthy()
  })
  it('lists a bare repository hidden inside dependencies and requires the tick', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await writeFile(join(a.path!, '.gitignore'), 'node_modules/\n')
    await git(a.path!, ['add', '.gitignore'])
    await git(a.path!, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Ignore dependencies'])
    const nested = join(a.path!, 'node_modules', 'local.git'); await mkdir(nested, { recursive: true })
    await git(nested, ['init', '--bare'])
    const facts = await f.service.reclaimFacts(a)
    expect(facts.repositories).toEqual([{ path: 'node_modules/local.git/', changeCount: 0, unpushedCommitCount: 0, kind: 'repository' }])
    await expect(f.service.reclaim(a, { automatic: true })).rejects.toThrow('besides installed dependencies')
    expect((await f.service.reclaim(a, { confirmedItems: facts.items, confirmedIgnored: facts.ignored, confirmedRepositories: facts.repositories })).reclaimedAt).toBeTruthy()
  })
  it('resolves authoritative cwd before project fallback and blocks unresolved setup', () => {
    expect(resolveThreadWorkingDirectory({ workingDirectory: '/actual' }, { path: '/project' })).toBe('/actual')
    expect(resolveThreadWorkingDirectory({}, { path: '/legacy' })).toBe('/legacy')
    expect(() => resolveThreadWorkingDirectory({ worktree: { mode: 'independent', status: 'error', error: 'setup failed' } }, { path: '/project' })).toThrow('setup failed')
  })
})

describe('a working folder that is gone', () => {
  it('says so in plain words, not as the file system error code', async () => {
    const missing = join(tmpdir(), `sotto-missing-${Date.now()}`)
    await expect(existingWorkingDirectory(missing)).rejects.toThrow(`The folder ${missing} is not there any more. Move it back, or add the project again from where it is now.`)
  })
})

it('groups subdirectories when checkout discovery is refused by Git ownership checks', async () => {
  const f = await fixture()
  const nested = join(f.project, 'nested'); await mkdir(nested)
  const refused: RunGit = async () => { throw new Error('fatal: detected dubious ownership in repository') }
  const service = new ThreadWorktrees(f.root, refused)
  expect(await service.checkoutIdentity(nested)).toBe(await service.checkoutIdentity(f.project))
})

describe('reading a checkout from its files (issue #766)', () => {
  const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  const counting = () => {
    const calls: string[][] = []
    const run: RunGit = async (cwd, args) => { calls.push(args); return git(cwd, args) }
    return { calls, run }
  }

  it('finds the checkout identity Git finds, without asking Git', async () => {
    const f = await fixture()
    const nested = join(f.project, 'nested', 'deeper'); await mkdir(nested, { recursive: true })
    const linked = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    const outside = join(f.root, 'plain'); await mkdir(outside)
    const { calls, run } = counting()
    const toplevel = async (folder: string) => key(await realpath((await git(folder, ['rev-parse', '--show-toplevel'])).trim()))
    expect(await checkoutIdentity(f.project, run)).toBe(await toplevel(f.project))
    expect(await checkoutIdentity(nested, run)).toBe(await toplevel(f.project))
    expect(await checkoutIdentity(linked.path!, run)).toBe(await toplevel(linked.path!))
    // Outside any repository Git finds nothing, and the folder groups with the nearest .git of any kind above it,
    // as it always has when Git's discovery was refused, or with itself when there is none.
    let marker: string | undefined
    for (let candidate = await realpath(outside); !marker; candidate = dirname(candidate)) {
      if (await lstat(join(candidate, '.git')).then(() => true, () => false)) marker = candidate
      else if (dirname(candidate) === candidate) break
    }
    expect(await checkoutIdentity(outside, run)).toBe(key(marker ?? await realpath(outside)))
    expect(calls).toEqual([])
  })

  it('passes over a .git folder that is not a repository, as Git does', async () => {
    const f = await fixture()
    const nested = join(f.project, 'nested'); await mkdir(join(nested, '.git'), { recursive: true })
    const { calls, run } = counting()
    // A .git folder with no HEAD, objects or refs is not a repository to Git, which finds the one above it.
    expect(key(await realpath((await git(nested, ['rev-parse', '--show-toplevel'])).trim()))).toBe(key(await realpath(f.project)))
    expect(await checkoutIdentity(nested, run)).toBe(key(await realpath(f.project)))
    expect(calls).toEqual([])
  })

  it('reads a ready worktree\'s branch from its files and leaves anything Git must settle to Git', async () => {
    const f = await fixture()
    const { calls, run } = counting()
    const service = new ThreadWorktrees(f.root, run)
    const ready = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    expect(await service.readyOnDisk(ready)).toEqual({ branch: ready.branch })
    await git(ready.path!, ['switch', '-c', 'feat/elsewhere'])
    expect(await service.readyOnDisk(ready)).toEqual({ branch: 'feat/elsewhere' })
    await git(ready.path!, ['switch', '--detach'])
    expect(await service.readyOnDisk(ready)).toEqual({ branch: undefined })
    expect(calls).toEqual([])
    // Locked in Git's registry, recorded as anything but ready, or reclaimed: inspect decides.
    await git(f.project, ['worktree', 'lock', '--', ready.path!])
    expect(await service.readyOnDisk(ready)).toBeNull()
    await git(f.project, ['worktree', 'unlock', '--', ready.path!])
    expect(await service.readyOnDisk({ ...ready, status: 'error' })).toBeNull()
    expect(await service.readyOnDisk({ ...ready, reclaimedAt: '2026-10-05T00:00:00.000Z' })).toBeNull()
    // A worktree of another repository is not this record's checkout.
    const other = await fixture()
    expect(await service.readyOnDisk({ ...ready, repositoryRoot: other.project })).toBeNull()
    // A .git file that no longer points at Git's registry entry for this folder.
    // Windows will not open a hidden file for writing, so the .git file is replaced rather than rewritten.
    await unlink(join(ready.path!, '.git'))
    await writeFile(join(ready.path!, '.git'), `gitdir: ${join(f.root, 'elsewhere')}\n`)
    expect(await service.readyOnDisk(ready)).toBeNull()
    // A folder that is gone.
    await removeTestCheckout(f.root, ready.path!)
    expect(await service.readyOnDisk(ready)).toBeNull()
    expect(calls).toEqual([])
  })

  it('reads a shared project folder\'s branch from its files, and a plain folder as no repository', async () => {
    const f = await fixture()
    const service = new ThreadWorktrees(f.root, async () => { throw new Error('Git was asked') })
    const shared = await f.service.inspect(await f.service.allocate(f.project, 'shared'))
    expect(await service.readyOnDisk(shared)).toEqual({ branch: shared.branch })
    const plainFolder = join(f.root, 'plain'); await mkdir(plainFolder)
    const plain = await f.service.inspect(await f.service.allocate(plainFolder, 'shared'))
    expect(plain.repositoryRoot).toBeUndefined()
    expect(await service.readyOnDisk(plain)).toEqual({ branch: undefined })
    // A plain folder that became a repository since it was inspected is Git's to read.
    await git(plainFolder, ['init'])
    expect(await service.readyOnDisk(plain)).toBeNull()
  })
})
