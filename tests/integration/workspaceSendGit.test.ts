// @vitest-environment node
/**
 * A send and Git (issue #766): a send never waits behind a background Git status read of its thread, and on a
 * ready working copy the workspace host starts no Git process before the provider hears the prompt. Real Git, a
 * real repository and a real worktree; the provider is the fake one. Git processes are counted where every caller
 * starts them, by `spawn` and `execFile` alike. The checkpoint taken before a turn is not in this host's fixture;
 * it is #764's.
 */
import { realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitStatusReader, runGitStatusCommand, type RunGitCommand } from '../../src/main/agents/gitStatus'
import { runWorktreeGit as git, ThreadWorktrees } from '../../src/main/agents/threadWorktrees'
import { idle, repositoryWithOrigin, sendAndCount, startedThread, type SendGitFixture } from '../fixtures/sendGit'

vi.mock('node:child_process', async importOriginal => (await import('../fixtures/gitSpawnCounter')).countingGit(await importOriginal()))

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

function deferred() {
  let release!: () => void
  return { promise: new Promise<void>(resolve => { release = resolve }), release }
}

async function repository(): Promise<SendGitFixture> {
  const f = await repositoryWithOrigin()
  cleanup.push(async () => { await f.stop(); await f.remove() })
  return f
}

/** A folder as the file system names it, so two spellings of one folder compare equal. */
const pathKey = async (path: string) => { const key = resolve(await realpath(path)); return process.platform === 'win32' ? key.toLowerCase() : key }

const record = (f: SendGitFixture) => f.host.workspaceSnapshot().threads.find(item => item.id === 'local')!
const send = (f: SendGitFixture, index: number) => sendAndCount(f, 'local', index)

/** Watches Git's inspections from now, so a test waits for the one a send owes rather than for a while. */
function inspections() {
  const inspect = vi.spyOn(ThreadWorktrees.prototype, 'inspect')
  return {
    inspect,
    /** Until `count` inspections have begun since the watch began, and every one begun has finished. */
    async settled(count: number) {
      await vi.waitFor(() => expect(inspect.mock.calls.length).toBeGreaterThanOrEqual(count))
      await Promise.allSettled(inspect.mock.results.map(result => result.value))
    },
  }
}

describe('a send and Git', () => {
  it.each(['independent', 'shared'] as const)('starts no Git process before the provider hears the prompt on a ready %s working copy', async workingCopy => {
    const f = await repository()
    await startedThread(f, 'local', workingCopy)
    const watch = inspections()
    const sent = await send(f, 1)
    expect(sent.heard).toBe(true)
    expect(sent.git).toBe(0)
    expect(record(f).worktree).toMatchObject({ status: 'ready', branch: workingCopy === 'shared' ? 'main' : expect.stringMatching(/^sotto\//u) })
    expect(record(f).worktree?.sentBranch).toBe(record(f).worktree?.branch)
    // Git's own inspection follows once the prompt is out.
    await watch.settled(1)
  })

  it.each([
    { held: 'fetch', workingCopy: 'independent' },
    { held: 'GitHub lookup', workingCopy: 'shared' },
  ] as const)('reaches the provider while the remote half a refresh started waits on a slow $held, which runs outside the thread\'s lane', async ({ held, workingCopy }) => {
    const f = await repository()
    await startedThread(f, 'local', workingCopy)
    // The remote call the test holds, and the folder it was started in.
    const started = deferred(), done = deferred()
    let startedIn: string | undefined
    const run: RunGitCommand = async (cwd, command, args, options) => {
      const call = command === 'gh' ? 'GitHub lookup' : command === 'git' && args[0] === 'fetch' ? 'fetch' : undefined
      if (call === held) { startedIn = cwd; started.release(); await done.promise; return command === 'gh' ? '{"data":{"repository":{}}}' : '' }
      // Nothing else asks GitHub; a lookup the test does not hold fails quietly, as it does signed out.
      if (command === 'gh') throw new Error('gh is not used here.')
      return runGitStatusCommand(cwd, command, args, options)
    }
    // GitHub is asked only about a repository on GitHub (#820): origin is written as GitHub's URL, which Git rewrites
    // to the owned remote.
    const origin = (await git(f.project, ['remote', 'get-url', 'origin'])).trim()
    await git(f.project, ['config', `url.${origin}.insteadOf`, 'https://github.com/sotto-fixture/owned'])
    await git(f.project, ['remote', 'set-url', 'origin', 'https://github.com/sotto-fixture/owned'])
    f.host.setGitStatus(new GitStatusReader({ run, fetchIntervalMs: () => 30_000 }), { pollIntervalMs: () => 0 })
    // The refresh a draft starts answers once the record is read, and leaves its remote half running.
    await f.host.updateThreadWorktree('local', false)
    await started.promise
    // It runs in the thread's folder, as a terminal there would, but not in the thread's lane.
    const folder = record(f).worktree!.path!
    expect(await pathKey(startedIn!)).toBe(await pathKey(folder))
    // Someone switched the folder's branch in a terminal meanwhile, so this send records a new branch.
    await git(folder, ['switch', '-c', 'feat/terminal'])
    const sent = await send(f, 1)
    expect(sent.heard).toBe(true)
    expect(sent.git).toBe(0)
    expect(record(f).worktree).toMatchObject({ branch: 'feat/terminal', sentBranch: 'feat/terminal' })
    // Once the remote call is done, the read that takes what it brought lands in the thread's lane after the send and
    // the inspection the send owes, and finds the branch the send went to.
    done.release()
    await vi.waitFor(() => expect(record(f).worktree?.git?.branch).toBe('feat/terminal'))
    expect(record(f).worktree).toMatchObject({ branch: 'feat/terminal', sentBranch: 'feat/terminal' })
  })

  it('takes uncommitted changes onto the record from the inspection after the prompt is out', async () => {
    const f = await repository()
    await startedThread(f, 'local', 'independent')
    const watch = inspections()
    expect(record(f).worktree?.dirty).toBe(false)
    await writeFile(join(record(f).worktree!.path!, 'draft.txt'), 'unsaved work')
    const sent = await send(f, 1)
    expect(sent.git).toBe(0)
    await watch.settled(1)
    await vi.waitFor(() => expect(record(f).worktree?.dirty).toBe(true))
  })

  it('asks Git before the prompt when an inspection after a send could not confirm the folder', async () => {
    const f = await repository()
    await startedThread(f, 'local', 'independent')
    const watch = inspections()
    watch.inspect.mockRejectedValueOnce(new Error('The working folder no longer belongs to the original repository.'))
    await send(f, 1)
    await watch.settled(1)
    await idle(f, 'local')
    watch.inspect.mockClear()
    const sent = await send(f, 2)
    // The next send inspected with Git before the provider heard it, found the folder sound, and went.
    expect(sent.git).toBeGreaterThan(0)
    expect(watch.inspect).toHaveBeenCalled()
    // That inspection confirmed the folder, so the send after it reads the files again.
    await idle(f, 'local')
    expect((await send(f, 3)).git).toBe(0)
  })

  it('marks the folder as an error when a refresh finds Git will not take it, as before, and asks Git again on the next send', async () => {
    const f = await repository()
    await startedThread(f, 'local', 'independent')
    const folder = record(f).worktree!.path!
    await git(f.project, ['worktree', 'lock', '--', folder])
    await f.host.updateThreadWorktree('local', false)
    // The pane says what is wrong and offers Retry, rather than showing a ready folder every send is refused from.
    expect(record(f).worktree).toMatchObject({ status: 'error', error: expect.stringContaining('Git has locked this worktree') })
    // Unlocked, the next send asks Git before the provider hears it, finds the folder sound, and goes.
    await git(f.project, ['worktree', 'unlock', '--', folder])
    const sent = await send(f, 1)
    expect(sent.heard).toBe(true)
    expect(sent.git).toBeGreaterThan(0)
    expect(record(f).worktree?.status).toBe('ready')
    expect(record(f).worktree?.error).toBeUndefined()
  })

  it('refuses a send into a worktree Git has locked, as it did before', async () => {
    const f = await repository()
    await startedThread(f, 'local', 'independent')
    await git(f.project, ['worktree', 'lock', '--', record(f).worktree!.path!])
    const heard = vi.spyOn(f.adapters.codex, 'execute')
    await expect(f.host.execute({ type: 'send', commandId: 'send-locked', threadId: 'local', messageId: 'message-locked', text: 'Next' })).rejects.toThrow('Git has locked this worktree')
    expect(heard.mock.calls.filter(([command]) => command.type === 'send')).toHaveLength(0)
  })

  it('puts a deleted worktree back on its branch before the prompt, as it did before', async () => {
    const f = await repository()
    await startedThread(f, 'local', 'independent')
    const worktree = record(f).worktree!
    await rm(worktree.path!, { recursive: true, force: true })
    const sent = await send(f, 1)
    expect(sent.heard).toBe(true)
    expect(sent.git).toBeGreaterThan(0)
    expect(record(f).worktree).toMatchObject({ status: 'ready', path: worktree.path, branch: worktree.branch })
  })
})
