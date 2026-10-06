// @vitest-environment node
/**
 * A send and Git (issue #766): a send never waits behind a background Git status read of its thread, and on a
 * ready working copy it starts no Git process before the provider hears the prompt. Real Git, a real repository
 * and a real worktree; the provider is the fake one. Git processes are counted where every caller starts them.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitStatusReader, runGitStatusCommand, type RunGitCommand } from '../../src/main/agents/gitStatus'
import { runWorktreeGit as git, ThreadWorktrees } from '../../src/main/agents/threadWorktrees'
import { workspaceFixture } from '../fixtures/workspaceFixture'

const counted = vi.hoisted(() => ({ git: 0 }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const spawn = ((command: string, ...rest: unknown[]) => {
    if (/(^|[\\/])git(\.exe)?$/iu.test(command)) counted.git += 1
    return (actual.spawn as (...args: unknown[]) => unknown)(command, ...rest)
  }) as typeof actual.spawn
  return { ...actual, spawn, default: { ...actual, spawn } }
})

type Fixture = Awaited<ReturnType<typeof workspaceFixture>>
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

function deferred() {
  let release!: () => void
  return { promise: new Promise<void>(resolve => { release = resolve }), release }
}

/** The fake provider's project as a real repository with one commit and an origin it was pushed to. */
async function repository(): Promise<Fixture & { project: string }> {
  const f = await workspaceFixture()
  cleanup.push(async () => { await f.stop(); await f.remove() })
  const project = f.adapters.codex.state.projects[0]!.path
  const origin = join(f.root, 'origin.git'); await mkdir(origin)
  await git(origin, ['init', '--bare'])
  await git(project, ['init', '-b', 'main'])
  await writeFile(join(project, 'tracked.txt'), 'baseline')
  await git(project, ['add', '.'])
  await git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Baseline'])
  await git(project, ['remote', 'add', 'origin', origin])
  await git(project, ['push', '-u', 'origin', 'main'])
  return { ...f, project }
}

/** A thread whose first send set up its working copy, idle again, with nothing of that send still reading the folder. */
async function startedThread(f: Fixture, workingCopy: 'shared' | 'independent') {
  const snapshot = await f.host.connect()
  const project = snapshot.projects.find(item => item.providerId === 'codex')!
  const model = snapshot.models.find(item => item.providerId === 'codex')!
  await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'Local', modelId: model.id, workingCopy })
  const inspect = vi.spyOn(ThreadWorktrees.prototype, 'inspect')
  await f.host.execute({ type: 'send', commandId: 'send-0', threadId: 'local', messageId: 'message-0', text: 'First' })
  await idle(f)
  await quiet(inspect)
  inspect.mockRestore()
}

async function idle(f: Fixture) {
  for (const session of f.adapters.codex.state.threads) session.status = 'idle'
  f.adapters.codex.emit()
  await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(item => item.id === 'local')?.status).toBe('idle'))
}

const record = (f: Fixture) => f.host.workspaceSnapshot().threads.find(item => item.id === 'local')!

/** Sends one prompt and reports the Git processes started before the provider heard it. */
async function send(f: Fixture, index: number): Promise<{ gitBeforeProvider: number; heard: boolean }> {
  let gitAtHearing: number | undefined
  const execute = f.adapters.codex.execute.bind(f.adapters.codex)
  const spy = vi.spyOn(f.adapters.codex, 'execute').mockImplementation(async command => {
    if (command.type === 'send') gitAtHearing = counted.git
    return execute(command)
  })
  const before = counted.git
  try {
    await f.host.execute({ type: 'send', commandId: `send-${index}`, threadId: 'local', messageId: `message-${index}`, text: 'Next' })
  } finally { spy.mockRestore() }
  return { gitBeforeProvider: gitAtHearing === undefined ? Number.NaN : gitAtHearing - before, heard: gitAtHearing !== undefined }
}

type Watched = { mock: { results: Array<{ value: unknown }> } }
/** Waits until the inspection a send started has finished, by watching it through `inspect`. */
async function settled(inspect: Watched, calls: number) {
  await vi.waitFor(() => expect(inspect.mock.results.length).toBeGreaterThanOrEqual(calls))
  await quiet(inspect)
}
/** Waits until every inspection begun has finished and no other has begun after it. */
async function quiet(inspect: Watched) {
  for (let seen = -1; seen !== inspect.mock.results.length;) {
    seen = inspect.mock.results.length
    await Promise.allSettled(inspect.mock.results.map(result => result.value))
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe('a send and Git', () => {
  it.each(['independent', 'shared'] as const)('starts no Git process before the provider hears the prompt on a ready %s working copy', async workingCopy => {
    const f = await repository()
    await startedThread(f, workingCopy)
    const inspect = vi.spyOn(ThreadWorktrees.prototype, 'inspect')
    const sent = await send(f, 1)
    expect(sent.heard).toBe(true)
    expect(sent.gitBeforeProvider).toBe(0)
    expect(record(f).worktree).toMatchObject({ status: 'ready', branch: workingCopy === 'shared' ? 'main' : expect.stringMatching(/^sotto\//u) })
    expect(record(f).worktree?.sentBranch).toBe(record(f).worktree?.branch)
    // Git's own inspection follows once the prompt is out.
    await settled(inspect, 1)
  })

  it('reaches the provider while a background status read of the same thread waits on a slow fetch, and keeps what the send recorded', async () => {
    const f = await repository()
    const fetchStarted = deferred(), fetchDone = deferred()
    const run: RunGitCommand = async (cwd, command, args, options) => {
      if (command === 'git' && args[0] === 'fetch') { fetchStarted.release(); await fetchDone.promise; return '' }
      // Nothing here asks GitHub; the branch's pull request lookup fails quietly, as it does signed out.
      if (command === 'gh') throw new Error('gh is not used in this test.')
      return runGitStatusCommand(cwd, command, args, options)
    }
    f.host.setGitStatus(new GitStatusReader({ run, fetchIntervalMs: () => 30_000 }), { pollIntervalMs: () => 0 })
    await startedThread(f, 'independent')
    const worktree = record(f).worktree!
    // Someone switched the worktree's branch in a terminal, so this send records a new branch.
    await git(worktree.path!, ['switch', '-c', 'feat/terminal'])
    // A Git action finishing elsewhere asks for a remote read, which fetches first and is held there.
    const read = f.host.gitActionFinished('local')
    await fetchStarted.promise
    const sent = await send(f, 1)
    expect(sent.heard).toBe(true)
    expect(sent.gitBeforeProvider).toBe(0)
    expect(record(f).worktree).toMatchObject({ branch: 'feat/terminal', sentBranch: 'feat/terminal' })
    // The read finishes after the send and lands its status without undoing what the send recorded.
    fetchDone.release()
    await read
    expect(record(f).worktree).toMatchObject({ branch: 'feat/terminal', sentBranch: 'feat/terminal', git: expect.objectContaining({ branch: 'feat/terminal' }) })
  })

  it('takes uncommitted changes onto the record from the inspection after the prompt is out', async () => {
    const f = await repository()
    await startedThread(f, 'independent')
    const inspect = vi.spyOn(ThreadWorktrees.prototype, 'inspect')
    expect(record(f).worktree?.dirty).toBe(false)
    await writeFile(join(record(f).worktree!.path!, 'draft.txt'), 'unsaved work')
    const sent = await send(f, 1)
    expect(sent.gitBeforeProvider).toBe(0)
    await settled(inspect, 1)
    await vi.waitFor(() => expect(record(f).worktree?.dirty).toBe(true))
  })

  it('asks Git before the prompt when an inspection after a send could not confirm the folder', async () => {
    const f = await repository()
    await startedThread(f, 'independent')
    const inspect = vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockRejectedValueOnce(new Error('The working folder no longer belongs to the original repository.'))
    await send(f, 1)
    await settled(inspect, 1)
    await idle(f)
    inspect.mockClear()
    const sent = await send(f, 2)
    // The next send inspected with Git before the provider heard it, found the folder sound, and went.
    expect(sent.gitBeforeProvider).toBeGreaterThan(0)
    expect(inspect).toHaveBeenCalled()
    await idle(f)
    await quiet(inspect)
    expect((await send(f, 3)).gitBeforeProvider).toBe(0)
  })

  it('refuses a send into a worktree Git has locked, as it did before', async () => {
    const f = await repository()
    await startedThread(f, 'independent')
    await git(f.project, ['worktree', 'lock', '--', record(f).worktree!.path!])
    const heard = vi.spyOn(f.adapters.codex, 'execute')
    await expect(f.host.execute({ type: 'send', commandId: 'send-locked', threadId: 'local', messageId: 'message-locked', text: 'Next' })).rejects.toThrow('Git has locked this worktree')
    expect(heard.mock.calls.filter(([command]) => command.type === 'send')).toHaveLength(0)
  })

  it('puts a deleted worktree back on its branch before the prompt, as it did before', async () => {
    const f = await repository()
    await startedThread(f, 'independent')
    const worktree = record(f).worktree!
    await rm(worktree.path!, { recursive: true, force: true })
    const sent = await send(f, 1)
    expect(sent.heard).toBe(true)
    expect(sent.gitBeforeProvider).toBeGreaterThan(0)
    expect(record(f).worktree).toMatchObject({ status: 'ready', path: worktree.path, branch: worktree.branch })
  })
})
