// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BringBackRefusal, GitActions } from '../../src/main/agents/gitActions'
import { GitStatusReader } from '../../src/main/agents/gitStatus'
import { initializeGitRepository, runFixtureGit } from '../fixtures/gitRepository'

/**
 * Bring changes to <branch> (#1030) as Git does it, over real repositories in a temporary folder: a project folder on
 * `main`, which is where a parent thread on the shared checkout works, and a child's worktree on its own branch made
 * from `main`. Each refusal leaves every branch and folder as it was.
 */
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
const git = (cwd: string, ...args: string[]): string => runFixtureGit(cwd, ...args).trim()
const commitFile = async (cwd: string, file: string, text: string, message: string): Promise<string> => {
  await writeFile(join(cwd, file), text)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-qm', message)
  return git(cwd, 'rev-parse', 'HEAD')
}
const same = (left: string | null, right: string): boolean => left !== null && left.replace(/\\/gu, '/').toLowerCase() === right.replace(/\\/gu, '/').toLowerCase()

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-bring-back-'))
  roots.push(root)
  const project = join(root, 'project'), child = join(root, 'child')
  await initializeGitRepository(project, { files: { 'work.txt': 'one\ntwo\nthree\n' }, message: 'Baseline' })
  git(project, 'worktree', 'add', '-q', '-b', 'sotto/child', child, 'main')
  const status = new GitStatusReader({ fetchIntervalMs: () => 0 })
  const actions = new GitActions({ status, writeCommitMessage: async () => null, writePullRequestText: async () => null })
  const main = (): string => git(project, 'rev-parse', 'main')
  /** The parent works in the project folder, as a thread on the shared checkout does. */
  const parentCheckout = async (folder: string): Promise<boolean> => same(folder, project)
  return { project, child, actions, main, parentCheckout }
}
const refused = async (promise: Promise<unknown>): Promise<BringBackRefusal> => {
  const error = await promise.then(() => undefined, (failure: unknown) => failure)
  expect(error).toBeInstanceOf(BringBackRefusal)
  return error as BringBackRefusal
}

describe('bringing a worktree’s commits to the branch it was made from', () => {
  it('fast-forwards main where it is checked out, so the clean project folder holds the commits', async () => {
    const { project, child, actions, main, parentCheckout } = await repository()
    const head = await commitFile(child, 'test.txt', 'mid-chunk\n', 'Test a stream that ends mid-chunk')
    const outcome = await actions.bringBack({ cwd: child, target: 'main', parentCheckout })
    expect(outcome).toMatchObject({ kind: 'fast-forward', branch: 'sotto/child', commits: 1, head })
    expect(same(outcome.checkout, project)).toBe(true)
    expect(main()).toBe(head)
    expect(await readFile(join(project, 'test.txt'), 'utf8')).toBe('mid-chunk\n')
    expect(git(project, 'status', '--porcelain')).toBe('')
  })

  it('asks before a merge commit and changes nothing, then makes it on yes with both tips as parents', async () => {
    const { project, child, actions, main, parentCheckout } = await repository()
    const ours = await commitFile(child, 'test.txt', 'mid-chunk\n', 'Test a stream that ends mid-chunk')
    const theirs = await commitFile(project, 'notes.txt', 'meanwhile\n', 'Note what happened meanwhile')
    const asked = await actions.bringBack({ cwd: child, target: 'main', parentCheckout })
    expect(asked).toMatchObject({ kind: 'asks', commits: 1, targetCommits: 1, targetHead: theirs, branchHead: ours })
    expect(main()).toBe(theirs)
    expect(git(project, 'status', '--porcelain')).toBe('')
    await expect(readFile(join(project, 'test.txt'), 'utf8')).rejects.toThrow()
    if (asked.kind !== 'asks') throw new Error('Expected a question')
    const merged = await actions.bringBack({ cwd: child, target: 'main', parentCheckout, mergeCommit: { targetHead: asked.targetHead, branchHead: asked.branchHead } })
    expect(merged).toMatchObject({ kind: 'merge-commit', commits: 1, targetCommits: 1, subject: 'Merge branch \'sotto/child\' into main' })
    expect(main()).toBe(merged.kind === 'merge-commit' ? merged.head : '')
    expect(git(project, 'rev-list', '--parents', '-n', '1', 'main').split(' ').slice(1)).toEqual([theirs, ours])
    expect(git(project, 'log', '-1', '--format=%s', 'main')).toBe('Merge branch \'sotto/child\' into main')
    expect(await readFile(join(project, 'test.txt'), 'utf8')).toBe('mid-chunk\n')
    expect(git(project, 'status', '--porcelain')).toBe('')
    // The worktree stays as it was: its branch has only its own commit.
    expect(git(child, 'rev-parse', 'HEAD')).toBe(ours)
  })

  it('makes no merge commit for a yes to tips that have moved since the question', async () => {
    const { project, child, actions, main, parentCheckout } = await repository()
    await commitFile(child, 'test.txt', 'mid-chunk\n', 'Test')
    await commitFile(project, 'notes.txt', 'meanwhile\n', 'Meanwhile')
    const asked = await actions.bringBack({ cwd: child, target: 'main', parentCheckout })
    if (asked.kind !== 'asks') throw new Error('Expected a question')
    const later = await commitFile(project, 'later.txt', 'later\n', 'Later still')
    const refusal = await refused(actions.bringBack({ cwd: child, target: 'main', parentCheckout, mergeCommit: { targetHead: asked.targetHead, branchHead: asked.branchHead } }))
    expect(refusal.reason).toBe('moved')
    expect(main()).toBe(later)
  })

  it('refuses uncommitted work in the worktree, tracked or new, and moves nothing', async () => {
    const { child, actions, main, parentCheckout } = await repository()
    await commitFile(child, 'test.txt', 'mid-chunk\n', 'Test')
    await writeFile(join(child, 'work.txt'), 'changed\n')
    await writeFile(join(child, 'new.txt'), 'new\n')
    const before = main()
    const refusal = await refused(actions.bringBack({ cwd: child, target: 'main', parentCheckout }))
    expect(refusal).toMatchObject({ reason: 'uncommitted', detail: { files: 2 } })
    expect(main()).toBe(before)
    expect(await readFile(join(child, 'work.txt'), 'utf8')).toBe('changed\n')
  })

  it('refuses a conflict in Git’s own words, and resolves nothing', async () => {
    const { project, child, actions, main, parentCheckout } = await repository()
    await commitFile(child, 'work.txt', 'one\nours\nthree\n', 'Change the middle line here')
    const theirs = await commitFile(project, 'work.txt', 'one\ntheirs\nthree\n', 'Change the middle line there')
    const refusal = await refused(actions.bringBack({ cwd: child, target: 'main', parentCheckout }))
    expect(refusal.reason).toBe('conflict')
    expect(refusal.detail.gitSaid).toBe('CONFLICT (content): Merge conflict in work.txt')
    expect(main()).toBe(theirs)
    expect(git(project, 'status', '--porcelain')).toBe('')
    expect(await readFile(join(project, 'work.txt'), 'utf8')).toBe('one\ntheirs\nthree\n')
    expect(() => git(project, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow()
  })

  it('leaves the project folder alone when main has uncommitted changes there', async () => {
    const { project, child, actions, main, parentCheckout } = await repository()
    await commitFile(child, 'test.txt', 'mid-chunk\n', 'Test')
    await writeFile(join(project, 'work.txt'), 'the parent is editing\n')
    const before = main()
    const refusal = await refused(actions.bringBack({ cwd: child, target: 'main', parentCheckout }))
    expect(refusal).toMatchObject({ reason: 'target-uncommitted', detail: { files: 1 } })
    expect(same(refusal.detail.checkout ?? null, project)).toBe(true)
    expect(main()).toBe(before)
    expect(await readFile(join(project, 'work.txt'), 'utf8')).toBe('the parent is editing\n')
    await expect(readFile(join(project, 'test.txt'), 'utf8')).rejects.toThrow()
  })

  it('leaves the project folder alone while a merge is half done there', async () => {
    const { project, child, actions, main, parentCheckout } = await repository()
    await commitFile(child, 'test.txt', 'mid-chunk\n', 'Test')
    // A merge whose result the user has not committed yet, with nothing else changed in the folder.
    await writeFile(join(project, '.git', 'MERGE_HEAD'), `${git(project, 'rev-parse', 'HEAD')}\n`)
    const before = main()
    const refusal = await refused(actions.bringBack({ cwd: child, target: 'main', parentCheckout }))
    expect(refusal.reason).toBe('target-uncommitted')
    expect(main()).toBe(before)
  })

  it.each([false, true])('leaves a parent’s untracked file and branch untouched whether the incoming commits overwrite it (%s)', async overwrite => {
    const { project, child, actions, main, parentCheckout } = await repository()
    await writeFile(join(project, 'scratch.txt'), 'the parent’s scratch\n')
    await commitFile(child, overwrite ? 'scratch.txt' : 'test.txt', 'the child’s file\n', 'Add a file')
    const before = main()
    const refusal = await refused(actions.bringBack({ cwd: child, target: 'main', parentCheckout }))
    expect(refusal).toMatchObject({ reason: 'target-uncommitted', detail: { files: 1 } })
    expect(main()).toBe(before)
    expect(await readFile(join(project, 'scratch.txt'), 'utf8')).toBe('the parent’s scratch\n')
  })

  it('refuses when the parent is no longer on the target, and switches no branch', async () => {
    const { project, child, actions, parentCheckout } = await repository()
    git(project, 'branch', 'feature', 'main')
    const featureBefore = git(project, 'rev-parse', 'feature')
    await commitFile(child, 'test.txt', 'mid-chunk\n', 'Test')
    const projectHead = git(project, 'rev-parse', 'HEAD')
    const refusal = await refused(actions.bringBack({ cwd: child, target: 'feature', parentCheckout }))
    expect(refusal.reason).toBe('parent-moved')
    expect(git(project, 'rev-parse', 'feature')).toBe(featureBefore)
    expect(git(project, 'rev-parse', 'HEAD')).toBe(projectHead)
    expect(git(project, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
  })

  it('never brings back a test run’s snapshot of uncommitted work as a commit', async () => {
    const { project, child, actions, main, parentCheckout } = await repository()
    // The worker began from a snapshot commit Sotto made of the parent's uncommitted work (#1033), then committed its own.
    await writeFile(join(child, 'work.txt'), 'the parent’s uncommitted edit\n')
    git(child, 'add', 'work.txt')
    git(child, '-c', 'user.name=Sotto', '-c', 'user.email=sotto@localhost', 'commit', '-qm', 'Sotto test-run snapshot')
    await commitFile(child, 'test.txt', 'mid-chunk\n', 'Test')
    const before = main()
    const refusal = await refused(actions.bringBack({ cwd: child, target: 'main', parentCheckout }))
    expect(refusal.reason).toBe('snapshot')
    expect(refusal.message).toContain('snapshot of uncommitted changes')
    expect(main()).toBe(before)
    expect(git(project, 'status', '--porcelain')).toBe('')
  })

  it('brings a branch that arrived in an incoming ref, run in the parent’s own folder', async () => {
    const { project, child, actions, main, parentCheckout } = await repository()
    const head = await commitFile(child, 'test.txt', 'mid-chunk\n', 'Test')
    const ref = 'refs/sotto/incoming/9d1c3f0e-5b8e-4d4a-8a77-1f0d2f6c4b1a/sotto/child'
    git(project, 'update-ref', ref, head)
    // The child's own branch is not what goes: only what arrived.
    git(child, 'reset', '-q', '--hard', 'main')
    const outcome = await actions.bringBack({ cwd: project, target: 'main', arrived: { ref, branch: 'sotto/child' }, parentCheckout })
    expect(outcome).toMatchObject({ kind: 'fast-forward', branch: 'sotto/child', commits: 1, head })
    expect(main()).toBe(head)
    expect(await readFile(join(project, 'test.txt'), 'utf8')).toBe('mid-chunk\n')
  })

  it('finds nothing to bring when main already has every commit', async () => {
    const { child, actions, main, parentCheckout } = await repository()
    const before = main()
    expect(await actions.bringBack({ cwd: child, target: 'main', parentCheckout })).toMatchObject({ kind: 'nothing', branch: 'sotto/child' })
    expect(main()).toBe(before)
  })
})
