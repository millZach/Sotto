// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

import { type AgentHostSnapshot } from '../../../src/shared/agents'

import { ThreadWorktrees } from '../../../src/main/agents/threadWorktrees'

import type { GitStatus } from '../../../src/shared/gitStatus'
import { fixture, send, deferred } from '../../fixtures/workspaceTestFixture'

describe("durable project/thread organization", () => {
  it('adopts the branch the worktree has checked out on send and publishes it', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    // The fixture project is a plain folder, so stand in for Git: an independent checkout whose branch moves under Sotto.
    const record = { mode: 'independent' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, branch: 'sotto/thread-fixture', baseCommit: 'fixture' }
    let checkedOut = 'sotto/thread-fixture'
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockResolvedValue(record)
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready', branch: checkedOut }))
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.threadWorkingDirectory('local')
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree).toMatchObject({ status: 'ready', branch: 'sotto/thread-fixture' })
    checkedOut = 'feat/user-chosen'
    const published: AgentHostSnapshot[] = []
    f.host.subscribe(snapshot => published.push(snapshot))
    await f.host.threadWorkingDirectory('local')
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree).toMatchObject({ status: 'ready', branch: 'feat/user-chosen' })
    expect(published.at(-1)?.threads.find(thread => thread.id === 'local')?.worktree?.branch).toBe('feat/user-chosen')
  })

  it('re-reads the worktree after finished work moved HEAD, and remembers the branch each send went to', async () => {
    const f = await fixture({ worktreeRefreshDelayMs: 5 })
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const record = { mode: 'independent' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, branch: 'sotto/thread-fixture', baseCommit: 'fixture' }
    let checkedOut = 'sotto/thread-fixture'
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockResolvedValue(record)
    const inspect = vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready', branch: checkedOut }))
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree)
      .toMatchObject({ branch: 'sotto/thread-fixture', sentBranch: 'sotto/thread-fixture' })
    // The agent switched branches inside the folder mid-turn: no send, only a finished command.
    checkedOut = 'feat/agent-chose'
    const reads = inspect.mock.calls.length
    const session = f.adapters.codex.state.threads.at(-1)!
    session.activities = [{ id: 'command-1', turnId: 'turn-1', sequence: 0, kind: 'command', status: 'completed', title: 'Ran a command' }]
    f.adapters.codex.emit()
    session.activities = [...session.activities, { id: 'command-2', turnId: 'turn-1', sequence: 1, kind: 'file-change', status: 'completed', title: 'Edited files' }]
    f.adapters.codex.emit()
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree?.branch).toBe('feat/agent-chose'))
    expect(inspect.mock.calls.length - reads).toBe(1) // one re-read for the burst, not one per record
    // The branch of the last send is what the pane compares against, so it stays where it was.
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree?.sentBranch).toBe('sotto/thread-fixture')
  })

  it('reads the folder again and asks once more when a Git action lands between the read and the remote half of a round', async () => {
    const f = await fixture({ worktreeRefreshDelayMs: 5 })
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const status: GitStatus = { isRepository: true, branch: 'main', upstream: 'origin/main', hasRemote: true, defaultBranch: 'main', isDefaultBranch: true, dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: null, pullRequest: null, fetchedAt: null, readAt: '2026-09-23T00:00:00.000Z' }
    const steps: string[] = []
    let refused = false
    const source = {
      read: vi.fn(async () => { steps.push('read'); return status }),
      // The first ask finds the folder not read since a Git action, as one landing just after the round's read leaves it.
      readRemote: vi.fn(async () => { steps.push('remote'); if (refused) return true; refused = true; return false }),
      invalidate: vi.fn(),
    }
    f.host.setGitStatus(source, { pollIntervalMs: () => 0 })
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    await f.host.updateThreadWorktree('local', false)
    await vi.waitFor(() => expect(source.readRemote).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(steps.slice(-5)).toEqual(['read', 'remote', 'read', 'remote', 'read']))
  })

  it('carries the Git status of the folder on the worktree record: the remote on a refresh, the timer while a window looks, and again after an action', async () => {
    const f = await fixture({ worktreeRefreshDelayMs: 5 })
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const base: GitStatus = { isRepository: true, branch: 'main', upstream: 'origin/main', hasRemote: true, defaultBranch: 'main', isDefaultBranch: true, dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: null, pullRequest: null, fetchedAt: null, readAt: '2026-09-23T00:00:00.000Z' }
    let current = base, inFront = true
    // A remote half is listed as a read with `remote: true`; every read the host makes itself is local.
    const reads: Array<{ cwd: string; remote: boolean }> = []
    const source = {
      read: vi.fn(async (cwd: string, options: { remote: boolean }) => { reads.push({ cwd, remote: options.remote }); return current }),
      readRemote: vi.fn(async (cwd: string) => { reads.push({ cwd, remote: true }); return true }),
      invalidate: vi.fn(),
    }
    f.host.setGitStatus(source, { pollIntervalMs: () => 10, tickMs: 5, foreground: () => inFront })
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    const record = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree
    // A refresh is an ask, so it reads the remote half too, once it has answered, and then the folder.
    await f.host.updateThreadWorktree('local', false)
    await vi.waitFor(() => expect(record()?.git).toMatchObject({ branch: 'main', ahead: 0 }))
    expect(reads.slice(-2)).toEqual([{ cwd: project.path, remote: true }, { cwd: project.path, remote: false }])
    expect(source.read).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ remote: true }))
    // A refresh is the user's read, which may pass a GitHub pause (#820).
    expect(source.readRemote).toHaveBeenLastCalledWith(project.path, {})
    // The window's own refresh, when it regains focus or a draft begins, asks GitHub as the timer does.
    await f.host.updateThreadWorktree('local', false, { background: true })
    await vi.waitFor(() => expect(source.readRemote).toHaveBeenLastCalledWith(project.path, { background: true }))
    // The timer reads only the threads a window is looking at.
    current = { ...base, ahead: 2 }
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(record()?.git?.ahead).toBe(0)
    f.host.observeThreads(['local'])
    await vi.waitFor(() => expect(record()?.git?.ahead).toBe(2))
    // The timer's remote half is a background read, which GitHub's pause and reserve hold back (#820).
    expect(source.readRemote).toHaveBeenLastCalledWith(project.path, { background: true })
    // A thread coming into view with no status yet is read at once, locally, ahead of the timer.
    f.host.observeThreads([])
    await f.host.execute({ type: 'create-thread', commandId: 'create-second', threadId: 'second', projectId: project.id, title: 'Second task', modelId: model.id })
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'second')?.worktree?.git).toBeUndefined()
    const before_ = reads.length
    f.host.observeThreads(['second'])
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'second')?.worktree?.git?.ahead).toBe(2))
    expect(reads.slice(before_)).toContainEqual({ cwd: project.path, remote: false }) // the timer's own rounds read the remote
    // A workspace change reads the chosen folder at once, so the record never loses its status between choices.
    await f.host.configureThreadWorkingCopy('second', { workingCopy: 'independent', startFromOrigin: true })
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'second')?.worktree?.git).toBeUndefined() // nothing to read yet
    current = { ...base, ahead: 4 }
    // The timer starts no round while the window is behind, so the last read is the one the change made: a round's
    // remote half runs outside the thread's lane and could otherwise be the last one listed.
    inFront = false
    await f.host.configureThreadWorkingCopy('second', { workingCopy: 'shared' })
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'second')?.worktree?.git?.ahead).toBe(4)
    expect(reads.at(-1)).toEqual({ cwd: project.path, remote: false })
    inFront = true
    f.host.observeThreads(['local'])
    current = { ...base, ahead: 2 }
    await vi.waitFor(() => expect(record()?.git?.ahead).toBe(2)) // the timer's next round puts the watched thread back where the checks below expect it
    await new Promise(resolve => setTimeout(resolve, 30)) // and a round already under way for both threads finishes
    // Nothing is read while the window is not in front.
    inFront = false
    const before = reads.length
    current = { ...base, ahead: 3 }
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(reads.length).toBe(before)
    expect(record()?.git?.ahead).toBe(2)
    // A Git action drops the caches and reads at once.
    await f.host.gitActionFinished('local')
    // Only the thread's own repository goes stale (#820).
    expect(source.invalidate).toHaveBeenCalledWith(project.path)
    expect(record()?.git?.ahead).toBe(3)
    // An unchanged status publishes nothing.
    const published: AgentHostSnapshot[] = []
    f.host.subscribe(snapshot => published.push(snapshot))
    await f.host.gitActionFinished('local')
    expect(published).toHaveLength(0)
  })

  it('lets a send go while the remote half of a status read fetches, and takes what it brought in the thread\'s lane after it', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    let branch = 'main', ahead = 0
    const record = { mode: 'shared' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, baseCommit: 'fixture' }
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, branch, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockImplementation(async () => ({ ...record, branch }))
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready', branch }))
    const status = (): GitStatus => ({ isRepository: true, branch, upstream: null, hasRemote: true, defaultBranch: 'main', isDefaultBranch: branch === 'main', dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead, behind: 0, aheadOfDefault: null, pullRequest: null, fetchedAt: null, readAt: '2026-10-06T00:00:00.000Z' })
    // The next remote half stands for a fetch and a GitHub lookup that take as long as the test holds them.
    let held: { fetching: ReturnType<typeof deferred>; fetched: ReturnType<typeof deferred> } | undefined
    const readRemote = vi.fn(async () => {
      const hold = held
      if (hold) { held = undefined; hold.fetching.release(); await hold.fetched.promise }
      return true
    })
    const read = vi.fn(async () => status())
    f.host.setGitStatus({ read, readRemote, invalidate: vi.fn() }, { pollIntervalMs: () => 0 })
    f.host.setGitActions({ switchBranch: vi.fn(async (_cwd: string, ref: string) => { branch = ref; return { branch: ref } }) } as never)
    const url = 'https://github.com/o/r/pull/74'
    const view = { number: 74, url, title: 'Pull 74', body: '', state: 'open' as const, draft: false, baseBranch: 'main', headBranch: 'feat/74', crossRepository: false, headOwner: 'o', reviewDecision: null, mergeable: 'mergeable' as const, checks: [], mergeMethods: ['merge' as const], autoMerge: null, behindBy: 0, canUpdateBranch: true }
    f.host.setGitPullRequests({ view: vi.fn(async () => view), act: vi.fn(async () => ({ ...view, state: 'merged' as const })) } as never)
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    const sends = () => f.adapters.codex.commands.filter(command => command.type === 'send').length
    const worktree = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree
    const idle = async () => {
      f.adapters.codex.state.threads.at(-1)!.status = 'idle'; f.adapters.codex.emit()
      await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.status).toBe('idle'))
    }
    const hold = () => { held = { fetching: deferred(), fetched: deferred() }; return held }
    // A refresh answers once the record is read, and its remote half fetches while a send goes.
    await idle()
    let fetch = hold()
    await f.host.updateThreadWorktree('local', false)
    await fetch.fetching.promise
    await f.host.execute({ ...send(), commandId: 'after-refresh', messageId: 'after-refresh' })
    expect(sends()).toBe(2)
    // Once the fetch is done, a local read in the thread's lane takes what it brought.
    ahead = 3
    fetch.fetched.release()
    await vi.waitFor(() => expect(worktree()?.git?.ahead).toBe(3))
    // A branch switch: the switch, and the local read of the folder after it, are made in the thread's lane, and
    // its remote half fetches outside it while a send goes.
    await idle()
    fetch = hold()
    const switched = f.host.switchThreadBranch('local', 'topic', true)
    await fetch.fetching.promise
    expect(worktree()).toMatchObject({ branch: 'topic', git: { branch: 'topic' } })
    await f.host.execute({ ...send(), commandId: 'after-switch', messageId: 'after-switch' })
    expect(sends()).toBe(3)
    fetch.fetched.release()
    expect(await switched).toBeDefined()
    // A pull request action, the same way.
    await idle()
    fetch = hold()
    await f.host.linkThreadPullRequest('local', '#74')
    const acted = f.host.runPullRequestAction({ threadId: 'local', url, action: 'merge', method: 'merge' })
    await fetch.fetching.promise
    await f.host.execute({ ...send(), commandId: 'after-pull-request', messageId: 'after-pull-request' })
    expect(sends()).toBe(4)
    fetch.fetched.release()
    expect((await acted).notice).toBe('Pull request merged.')
    // Nothing the host read itself was a remote read: the fetch and the lookup are the remote half's alone.
    expect(read).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ remote: true }))
  })

  it('pulls a clean default branch that is only behind as its remote status is read, only while Automatically pull is on', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const record = { mode: 'shared' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, branch: 'main', baseCommit: 'fixture' }
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockResolvedValue(record)
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready', branch: 'main' }))
    let behind = 2, dirty = false, autoPull = false
    const status = (): GitStatus => ({ isRepository: true, branch: 'main', upstream: 'origin/main', hasRemote: true, defaultBranch: 'main', isDefaultBranch: true, dirty, changedFiles: dirty ? 1 : 0, insertions: 0, deletions: 0, ahead: 0, behind, aheadOfDefault: null, pullRequest: null, fetchedAt: null, readAt: '2026-09-23T00:00:00.000Z' })
    f.host.setGitStatus({ read: vi.fn(async () => status()), invalidate: vi.fn() }, { pollIntervalMs: () => 0, autoPull: () => autoPull })
    const pull = vi.fn(async () => { behind = 0; return { status: 'pulled' as const, branch: 'main', upstream: 'origin/main' } })
    f.host.setGitActions({ pull } as never)
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    const session = f.adapters.codex.state.threads.at(-1)!
    session.status = 'idle'; f.adapters.codex.emit()
    const git = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree?.git
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.status).toBe('idle'))
    // A refresh answers before the read that takes its remote half; a second refresh waits in the thread's lane behind that read.
    const refreshed = async () => { await f.host.updateThreadWorktree('local', false); await f.host.updateThreadWorktree('local', false) }
    // Off: behind stays behind.
    await refreshed()
    expect(pull).not.toHaveBeenCalled()
    expect(git()?.behind).toBe(2)
    // On, with work in the tree: never.
    autoPull = true; dirty = true
    await refreshed()
    expect(pull).not.toHaveBeenCalled()
    // On and clean: fast-forwarded, and the record shows the status read after the pull.
    dirty = false
    await f.host.updateThreadWorktree('local', false)
    await vi.waitFor(() => expect(git()?.behind).toBe(0))
    expect(pull).toHaveBeenCalledExactlyOnceWith(project.path, { automatic: true })
  })

  it('decides an automatic pull in the thread\'s lane once the fetch is done, so a switch made while it fetched is seen', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    let branch = 'main'
    const record = { mode: 'shared' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, baseCommit: 'fixture' }
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, branch, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockImplementation(async () => ({ ...record, branch }))
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready', branch }))
    // Each read answers what the folder is when it is asked: behind on main, and a branch of its own after the switch.
    const status = (): GitStatus => ({ isRepository: true, branch, upstream: `origin/${branch}`, hasRemote: true, defaultBranch: 'main', isDefaultBranch: branch === 'main', dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind: 2, aheadOfDefault: null, pullRequest: null, fetchedAt: null, readAt: '2026-10-06T00:00:00.000Z' })
    const read = vi.fn(async () => status())
    // The first remote half is held, as a slow fetch would be.
    const fetching = deferred(), fetched = deferred()
    let holdNext = true
    const readRemote = vi.fn(async () => {
      if (holdNext) { holdNext = false; fetching.release(); await fetched.promise }
      return true
    })
    f.host.setGitStatus({ read, readRemote, invalidate: vi.fn() }, { pollIntervalMs: () => 0, autoPull: () => true })
    const pull = vi.fn(async () => ({ status: 'pulled' as const, branch, upstream: `origin/${branch}` }))
    f.host.setGitActions({ pull, switchBranch: vi.fn(async (_cwd: string, ref: string) => { branch = ref; return { branch: ref } }) } as never)
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    f.adapters.codex.state.threads.at(-1)!.status = 'idle'; f.adapters.codex.emit()
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.status).toBe('idle'))
    // A refresh's fetch is under way while the folder is a clean main behind its upstream, and the user switches to
    // a branch of their own meanwhile. The switch does not wait for the fetch.
    await f.host.updateThreadWorktree('local', false)
    await fetching.promise
    await f.host.switchThreadBranch('local', 'topic', true)
    const readsBefore = read.mock.calls.length
    fetched.release()
    // The read that takes what the fetch brought runs in the thread's lane after the switch, finds the folder on a
    // branch of its own, and pulls nothing.
    await vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(readsBefore))
    await f.host.updateThreadWorktree('local', false)
    expect(pull).not.toHaveBeenCalled()
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree).toMatchObject({ branch: 'topic', git: { branch: 'topic' } })
  })

  it('decides an automatic pull again from a read of its own, not one shared with a read begun before the folder moved', async () => {
    const f = await fixture({ worktreeRefreshDelayMs: 600_000 })
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    let branch = 'main'
    const record = { mode: 'shared' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, baseCommit: 'fixture' }
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, branch, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockImplementation(async () => ({ ...record, branch }))
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready', branch }))
    const status = (): GitStatus => ({ isRepository: true, branch, upstream: `origin/${branch}`, hasRemote: true, defaultBranch: 'main', isDefaultBranch: branch === 'main', dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind: 2, aheadOfDefault: null, pullRequest: null, fetchedAt: null, readAt: '2026-10-06T00:00:00.000Z' })
    // Like the status reader, a caller asking for the folder while a read of it is under way shares that read, unless
    // it asks for a fresh one. Each read answers for the folder as it was when it began.
    let underWay: Promise<GitStatus> | undefined
    const earlierRead = deferred(), joined = deferred()
    let holdLocal = false
    const read = vi.fn((_cwd: string, options: { remote: boolean; fresh?: boolean }): Promise<GitStatus> => {
      if (!options.fresh && underWay) { joined.release(); return underWay }
      const answer = status(), hold = holdLocal
      holdLocal = false
      const task = (async () => { if (hold) await earlierRead.promise; return answer })()
      if (!options.fresh) { underWay = task; void task.finally(() => { if (underWay === task) underWay = undefined }) }
      return task
    })
    f.host.setGitStatus({ read, readRemote: vi.fn(async () => true), invalidate: vi.fn() }, { pollIntervalMs: () => 0, autoPull: () => true })
    const pull = vi.fn(async () => ({ status: 'pulled' as const, branch, upstream: `origin/${branch}` }))
    f.host.setGitActions({ pull } as never)
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    f.adapters.codex.state.threads.at(-1)!.status = 'idle'; f.adapters.codex.emit()
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.status).toBe('idle'))
    // Another thread in the same folder began a read while the folder was a clean main behind its upstream, and it
    // is still running when an agent's terminal moves the folder to a branch of its own.
    holdLocal = true
    const earlier = read(project.path, { remote: false })
    branch = 'topic'
    // A refresh's remote half is done, and the read that takes it shares the earlier one.
    await f.host.updateThreadWorktree('local', false)
    await joined.promise
    earlierRead.release()
    // The pull is decided again from a read of its own, which finds the folder on its own branch.
    await vi.waitFor(() => expect(read).toHaveBeenCalledWith(project.path, { remote: false, fresh: true }))
    await f.host.updateThreadWorktree('local', false)
    await earlier
    expect(pull).not.toHaveBeenCalled()
  })

  it('runs a refresh, a switch and the status read after them one at a time in the thread\'s lane, so the switch moves the sent branch', async () => {
    const f = await fixture({ worktreeRefreshDelayMs: 600_000 })
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    let branch = 'main'
    const record = { mode: 'shared' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, baseCommit: 'fixture' }
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, branch, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockImplementation(async () => ({ ...record, branch }))
    // What reads or moves the folder, in the order it happened. The first inspection the test holds waits to be let go.
    const events: string[] = []
    let holding = false
    const held = deferred(), reached = deferred()
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => {
      events.push(`inspect ${branch}`)
      if (holding) { holding = false; reached.release(); await held.promise }
      return { ...metadata, status: 'ready', branch }
    })
    const status = (): GitStatus => ({ isRepository: true, branch, upstream: null, hasRemote: false, defaultBranch: 'main', isDefaultBranch: branch === 'main', dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: null, pullRequest: null, fetchedAt: null, readAt: '2026-10-06T00:00:00.000Z' })
    f.host.setGitStatus({ read: vi.fn(async () => { events.push(`status ${branch}`); return status() }), readRemote: vi.fn(async () => true), invalidate: vi.fn() }, { pollIntervalMs: () => 0 })
    f.host.setGitActions({ switchBranch: vi.fn(async (_cwd: string, ref: string) => { events.push(`switch ${ref}`); branch = ref; return { branch: ref } }) } as never)
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    f.adapters.codex.state.threads.at(-1)!.status = 'idle'; f.adapters.codex.emit()
    const worktree = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.status).toBe('idle'))
    expect(worktree()).toMatchObject({ branch: 'main', sentBranch: 'main' })
    // The refresh a draft starts is inspecting the folder when the user switches branch and a Git status read is asked for.
    holding = true; events.length = 0
    const refreshed = f.host.updateThreadWorktree('local', false)
    await reached.promise
    const switched = f.host.switchThreadBranch('local', 'feature', true)
    const statusRead = f.host.gitActionFinished('local')
    held.release()
    await Promise.all([refreshed, switched, statusRead])
    // Neither lands inside the refresh's inspection: the switch checks its folder once the refresh is done, and every
    // read after the switch finds the new branch.
    expect(events.slice(0, 4)).toEqual(['inspect main', 'inspect main', 'switch feature', 'inspect feature'])
    expect(events.slice(4).length).toBeGreaterThan(0)
    expect(events.slice(4).every(event => event.endsWith('feature'))).toBe(true)
    // The switch is the user's own, so the sent branch follows it and no branch notice shows (ADR-0014).
    expect(worktree()).toMatchObject({ branch: 'feature', sentBranch: 'feature', git: { branch: 'feature' } })
  })

})
