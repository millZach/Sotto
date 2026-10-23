// @vitest-environment node
// #1033 over ADR-0081: a delegating thread starts a new thread from its own branch, in a worktree of its own, and a test
// run carries its uncommitted work as a snapshot. Delegated threads start on This computer for now (#1316).
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { branchMoveWords } from '../../src/shared/branchMoves'
import { commitFile, git } from '../fixtures/branchRepositories'
import { delegationFixture } from '../fixtures/delegationFixture'

/** A checkout's text as committed: this computer's own `core.autocrlf` may give it CRLF on the way out. */
const lf = (text: string): string => text.replace(/\r\n/gu, '\n')
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** A delegating thread working in its project's checkout, which is a repository on `feat/p`. */
async function fixture(branchStarts = true) {
  const f = await delegationFixture(cleanups, { branchStarts })
  const parent = await f.userThread('claude')
  const folder = f.control.shell().host.threads.find(thread => thread.id === parent)!.workingDirectory!
  git(folder, 'init', '-q'); await commitFile(folder, 'README.md', '# Project\n', 'Start the project')
  git(folder, 'switch', '-q', '-c', 'feat/p')
  const commit = await commitFile(folder, 'p.txt', 'p\n')
  const start = (input: Record<string, unknown> = {}) => f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0, from_my_branch: true, ...input })
  const worktreeOf = async (threadId: string) => {
    await expect.poll(() => f.control.shell().host.threads.find(thread => thread.id === threadId)?.worktree?.status, { timeout: 20_000 }).toBe('ready')
    return f.control.shell().host.threads.find(thread => thread.id === threadId)!.worktree!
  }
  return { ...f, parent, folder, commit, start, worktreeOf }
}

it('starts a delegated thread in its own worktree on the delegating thread’s branch, and says so (#1033)', async () => {
  const f = await fixture()
  const started = f.ok(await f.start()) as ReturnType<typeof f.ok> & { startedFrom?: unknown }
  expect(started.startedFrom).toEqual({ hostId: f.control.hostId(), name: 'This computer', branch: 'feat/p', note: 'Started on This computer from feat/p.' })
  const worktree = await f.worktreeOf(started.delegation.thread)
  // The delegating thread holds feat/p, so the new thread's branch takes the next name, at the same commit.
  expect(worktree).toMatchObject({ mode: 'independent', branch: 'feat/p-2', baseCommit: f.commit })
  expect(git(worktree.path!, 'rev-parse', 'HEAD')).toBe(f.commit)
  expect(git(f.folder, 'symbolic-ref', '--short', 'HEAD')).toBe('feat/p')
})

it('refuses and records uncommitted work unless it is a test run, which starts from a snapshot and changes nothing here (#1033)', async () => {
  const f = await fixture()
  await writeFile(join(f.folder, 'p.txt'), 'edited\n'); await writeFile(join(f.folder, 'scratch.txt'), 'scratch\n')
  const refused = await f.start()
  expect(refused).toMatchObject({ status: 'refused', code: 'BRANCH_UNAVAILABLE', message: branchMoveWords.uncommitted, delegation: expect.any(String) })
  expect(git(f.folder, 'for-each-ref', 'refs/sotto')).toBe('')
  const status = git(f.folder, 'status', '--porcelain')
  const tested = f.ok(await f.start({ test_run: true })) as ReturnType<typeof f.ok> & { startedFrom?: unknown }
  expect(tested.startedFrom).toEqual({ hostId: f.control.hostId(), name: 'This computer', branch: 'feat/p', snapshot: { untracked: ['scratch.txt'], untrackedCount: 1 },
    note: 'Started on This computer from feat/p with your uncommitted changes (1 untracked file).' })
  const worktree = await f.worktreeOf(tested.delegation.thread)
  expect(lf(await readFile(join(worktree.path!, 'p.txt'), 'utf8'))).toBe('edited\n')
  expect(lf(await readFile(join(worktree.path!, 'scratch.txt'), 'utf8'))).toBe('scratch\n')
  expect(git(worktree.path!, 'rev-parse', 'HEAD^')).toBe(f.commit)
  expect(git(f.folder, 'status', '--porcelain')).toBe(status)
  expect(git(f.folder, 'stash', 'list')).toBe('')
})

it('takes from_my_branch and test_run only for a new thread in a worktree of its own, and not at all while Work across machines is off (#1033)', async () => {
  const f = await fixture()
  expect(await f.start({ working_copy: 'shared' })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  const off = await fixture(false)
  expect(await off.start()).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect(await off.start({ from_my_branch: undefined, test_run: true })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect(git(off.folder, 'for-each-ref', 'refs/sotto')).toBe('')
})
