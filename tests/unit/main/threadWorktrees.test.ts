// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runWorktreeGit as git, ThreadWorktrees } from '../../../src/main/agents/threadWorktrees'
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
/** Removes only a test-owned checkout under the fixture root; the production implementation has no removal path. */
async function removeTestCheckout(root: string, path: string) {
  expect(resolve(path).startsWith(resolve(root) + '\\') || resolve(path).startsWith(resolve(root) + '/')).toBe(true)
  await rm(path, { recursive: true })
}
describe('independent working-copy allocation', () => {
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
  it('does not reuse a checkout while Git reports it locked', async () => {
    const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await git(f.project, ['worktree', 'lock', '--reason', 'initializing', a.path!])
    await expect(f.service.ensure(a)).rejects.toThrow('locked')
    await expect(f.service.inspect(a)).rejects.toThrow('locked')
    await git(f.project, ['worktree', 'unlock', a.path!])
    expect((await f.service.ensure(a)).status).toBe('ready')
  })
  it('resolves authoritative cwd before project fallback and blocks unresolved setup', () => {
    expect(resolveThreadWorkingDirectory({ workingDirectory: '/actual' }, { path: '/project' })).toBe('/actual')
    expect(resolveThreadWorkingDirectory({}, { path: '/legacy' })).toBe('/legacy')
    expect(() => resolveThreadWorkingDirectory({ worktree: { mode: 'independent', status: 'error', error: 'setup failed' } }, { path: '/project' })).toThrow('setup failed')
  })
})
