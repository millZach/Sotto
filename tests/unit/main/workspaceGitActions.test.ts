// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

import { ThreadWorktrees } from '../../../src/main/agents/threadWorktrees'
import { GitActions } from '../../../src/main/agents/gitActions'
import type { GitStatus } from '../../../src/shared/gitStatus'
import { fixture, send, deferred } from '../../fixtures/workspaceTestFixture'

describe("durable project/thread organization", () => {
  it('keeps the sent branch in step with a switch made here, so the branch notice is for changes made elsewhere', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    let branch = 'main'
    const record = { mode: 'shared' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, baseCommit: 'fixture' }
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, branch, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockImplementation(async () => ({ ...record, branch }))
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready', branch }))
    const status = () => ({ isRepository: true, branch, upstream: null, hasRemote: false, defaultBranch: 'main', isDefaultBranch: branch === 'main', dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: null, pullRequest: null, fetchedAt: null, readAt: '2026-09-23T00:00:00.000Z' })
    f.host.setGitStatus({ read: vi.fn(async () => status()), invalidate: vi.fn() }, { pollIntervalMs: () => 0 })
    const switchBranch = vi.fn(async (_cwd: string, ref: string) => { branch = ref; return { branch: ref } })
    f.host.setGitActions({ switchBranch } as never)
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    const record_ = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')
    const session = f.adapters.codex.state.threads.at(-1)!
    session.status = 'idle'; f.adapters.codex.emit()
    await vi.waitFor(() => expect(record_()?.status).toBe('idle'))
    await vi.waitFor(() => expect(record_()?.worktree?.sentBranch).toBe('main'))
    await f.host.switchThreadBranch('local', 'topic', true)
    expect(switchBranch).toHaveBeenCalledWith(project.path, 'topic', { create: true })
    expect(record_()?.worktree).toMatchObject({ branch: 'topic', sentBranch: 'topic' })
    expect(record_()?.worktree?.git?.branch).toBe('topic')
  })

  it('refuses a Git action on the same folder while an automatic pull runs, rather than racing it', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const record = { mode: 'shared' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, branch: 'main', baseCommit: 'fixture' }
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockResolvedValue(record)
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready', branch: 'main' }))
    let behind = 1
    const status = (): GitStatus => ({ isRepository: true, branch: 'main', upstream: 'origin/main', hasRemote: true, defaultBranch: 'main', isDefaultBranch: true, dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind, aheadOfDefault: null, pullRequest: null, fetchedAt: null, readAt: '2026-09-23T00:00:00.000Z' })
    const source = { read: vi.fn(async () => status()), invalidate: vi.fn() }
    // The real GitActions run under the host's checkout guard; only Git is scripted.
    const pulling = deferred(), started = deferred()
    let head = 'aaa'
    const run = vi.fn(async (_cwd: string, _command: 'git' | 'gh', args: readonly string[]) => {
      if (args[0] === 'rev-parse') return `${head}\n`
      if (args[0] === 'pull') { started.release(); await pulling.promise; head = 'bbb'; behind = 0; return '' }
      return ''
    })
    f.host.setGitStatus(source, { pollIntervalMs: () => 0, autoPull: () => true })
    f.host.setGitActions(new GitActions({ status: source, run, writeCommitMessage: async () => null, writePullRequestText: async () => null }))
    for (const id of ['local', 'second']) {
      await f.host.execute({ type: 'create-thread', commandId: `create-${id}`, threadId: id, projectId: project.id, title: id, modelId: model.id })
      await f.host.execute(send(id))
    }
    for (const session of f.adapters.codex.state.threads) session.status = 'idle'
    f.adapters.codex.emit()
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.filter(thread => ['local', 'second'].includes(thread.id)).every(thread => thread.status === 'idle')).toBe(true))
    const refresh = f.host.updateThreadWorktree('local', false)
    await started.promise
    // Mid-pull, the other thread in the same folder presses Commit & push: refused, not run beside the pull, and told
    // what holds the folder, since the automatic pull shows nothing on screen.
    await expect(f.host.runGitAction({ threadId: 'second', actionId: 'press', action: 'commit_push' })).rejects.toThrow('Sotto is pulling this folder. Try again in a moment.')
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'second')?.gitAction).toBeUndefined()
    expect(run.mock.calls.filter(call => call[2][0] === 'commit')).toHaveLength(0)
    pulling.release()
    await refresh
    // The pull shows only as the status changing.
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree?.git?.behind).toBe(0))
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.gitAction).toBeUndefined()
  })

  it('refuses Worktree for a thread that has started, and links the pull request a Git action created', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const record = { mode: 'shared' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, branch: 'feat/x', baseCommit: 'fixture' }
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockResolvedValue(record)
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready', branch: 'feat/x' }))
    const status = { isRepository: true, branch: 'feat/x', upstream: 'origin/feat/x', hasRemote: true, defaultBranch: 'main', isDefaultBranch: false, dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: 1,
      pullRequest: { number: 9, title: 'Branch PR', url: 'https://github.com/o/r/pull/9', state: 'open' as const, draft: false }, fetchedAt: null, readAt: '2026-09-23T00:00:00.000Z' }
    f.host.setGitStatus({ read: vi.fn(async () => status), invalidate: vi.fn() }, { pollIntervalMs: () => 0 })
    f.host.setGitActions({ runStackedAction: vi.fn(async () => ({ action: 'create_pr', branch: { status: 'skipped_not_requested' }, commit: { status: 'skipped_not_requested' }, push: { status: 'skipped_not_requested' },
      pr: { status: 'created', url: 'https://github.com/o/r/pull/9', number: 9, title: 'Branch PR' }, toast: { title: 'Created PR #9', cta: { kind: 'none' } } })) } as never)
    const service = { view: vi.fn(async () => ({ number: 9, url: 'https://github.com/o/r/pull/9', title: 'Branch PR', body: '', state: 'open', draft: false, baseBranch: 'main', headBranch: 'feat/x', crossRepository: false, headOwner: 'o', reviewDecision: null, mergeable: 'unknown', checks: [], mergeMethods: [], autoMerge: null, behindBy: null, canUpdateBranch: false })),
      act: vi.fn(async () => null), checkoutLocal: vi.fn(), prepareWorktreeBranch: vi.fn() }
    f.host.setGitPullRequests(service as never)
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    const session = f.adapters.codex.state.threads.at(-1)!
    session.status = 'idle'; f.adapters.codex.emit()
    const thread = () => f.host.workspaceSnapshot().threads.find(item => item.id === 'local')!
    await vi.waitFor(() => expect(thread().status).toBe('idle'))
    await expect(f.host.checkoutThreadPullRequest('local', '#9', 'worktree')).rejects.toThrow('This thread already has a working folder. Use Local')
    expect(service.prepareWorktreeBranch).not.toHaveBeenCalled()
    await f.host.gitActionFinished('local')
    // The branch's own pull request is known without a link, and the surface says it is the branch's.
    await expect(f.host.readThreadPullRequest({ threadId: 'local' })).resolves.toMatchObject({ number: 9, branch: true, linked: null })
    await f.host.runPullRequestAction({ threadId: 'local', url: 'https://github.com/o/r/pull/9', action: 'ready' })
    expect(service.act).toHaveBeenCalledWith(project.path, 'https://github.com/o/r/pull/9', 'ready', undefined)
    await f.host.runGitAction({ threadId: 'local', actionId: 'action-1', action: 'create_pr' })
    expect(thread().pullRequests).toEqual([expect.objectContaining({ number: 9, source: 'created', title: 'Branch PR' })])
  })

  it('runs a Git action on the thread lane, reports it on the record as it goes, and refuses one while the thread works', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const record = { mode: 'shared' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, branch: 'main', baseCommit: 'fixture' }
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...record, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockResolvedValue(record)
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready', branch: 'main' }))
    const base = { isRepository: true, branch: 'main', upstream: 'origin/main', hasRemote: true, defaultBranch: 'main', isDefaultBranch: true, dirty: true, changedFiles: 1, insertions: 1, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: null, pullRequest: null, fetchedAt: null, readAt: '2026-09-23T00:00:00.000Z' }
    const source = { read: vi.fn(async () => base), readRemote: vi.fn(async () => true), invalidate: vi.fn() }
    f.host.setGitStatus(source, { pollIntervalMs: () => 0 })
    const seen: string[] = []
    const actions = {
      runStackedAction: vi.fn(async (input: { cwd: string; onProgress?: (event: unknown) => void }) => {
        seen.push(input.cwd)
        input.onProgress?.({ kind: 'action_started', phases: ['commit'], stages: ['Committing...'] })
        input.onProgress?.({ kind: 'phase_started', phase: 'commit', stage: 'Committing...' })
        input.onProgress?.({ kind: 'hook_started', hookName: 'pre-commit' })
        input.onProgress?.({ kind: 'hook_output', hookName: 'pre-commit', text: 'checking' })
        await new Promise(resolve => setTimeout(resolve, 30))
        return { action: 'commit', branch: { status: 'skipped_not_requested' }, commit: { status: 'created', sha: 'abc1234def', subject: 'Second' }, push: { status: 'skipped_not_requested' }, pr: { status: 'skipped_not_requested' }, toast: { title: 'Committed abc1234', description: 'Second', cta: { kind: 'run_action', label: 'Push', action: 'push' } } }
      }),
      pull: vi.fn(async () => ({ status: 'pulled' as const, branch: 'main', upstream: 'origin/main' })),
    }
    f.host.setGitActions(actions as never)
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await f.host.execute(send())
    const record_ = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')
    const session = f.adapters.codex.state.threads.at(-1)!
    session.status = 'idle'; f.adapters.codex.emit()
    await vi.waitFor(() => expect(record_()?.status).toBe('idle'))
    const published: string[] = []
    f.host.subscribe(snapshot => { const action = snapshot.threads.find(thread => thread.id === 'local')?.gitAction; if (action) published.push(`${action.status}:${action.stage ?? ''}:${action.hook?.output ?? ''}`) })
    const done = await f.host.runGitAction({ threadId: 'local', actionId: 'action-1', action: 'commit', commitMessage: 'Second' })
    expect(done.threads.find(thread => thread.id === 'local')?.gitAction).toMatchObject({ actionId: 'action-1', status: 'done', result: { commit: { sha: 'abc1234def' }, toast: { title: 'Committed abc1234' } }, error: null })
    expect(seen).toEqual([project.path])
    expect(published.some(entry => entry.startsWith('running:Committing...'))).toBe(true)
    expect(published.some(entry => entry === 'running:Committing...:checking')).toBe(true)
    expect(source.invalidate).toHaveBeenCalledWith(project.path)
    // The folder is read in the thread's lane once the action is done, so the remote half outside the lane asks about
    // the branch it is on now; a read of its own after it takes what the remote half brought.
    expect(source.read).toHaveBeenCalledWith(project.path, { remote: false })
    expect(source.readRemote).toHaveBeenCalledWith(project.path, {})
    expect(source.read.mock.invocationCallOrder[0]).toBeLessThan(source.readRemote.mock.invocationCallOrder[0]!)
    await vi.waitFor(() => expect(source.read).toHaveBeenCalledWith(project.path, { remote: false, fresh: true }))
    // The record is Sotto's: a provider snapshot that follows keeps it.
    f.adapters.codex.emit()
    await vi.waitFor(() => expect(record_()?.gitAction).toMatchObject({ actionId: 'action-1', status: 'done' }))
    // A refusal from the service becomes the record's error, not a thrown exception.
    actions.runStackedAction.mockRejectedValueOnce(new Error('Commit local changes before creating a PR.'))
    await f.host.runGitAction({ threadId: 'local', actionId: 'action-2', action: 'create_pr' })
    expect(record_()?.gitAction).toMatchObject({ actionId: 'action-2', status: 'failed', error: 'Commit local changes before creating a PR.' })
    // A thread mid-turn keeps its folder to itself.
    session.status = 'running'; f.adapters.codex.emit()
    await vi.waitFor(() => expect(record_()?.status).toBe('running'))
    await expect(f.host.runGitAction({ threadId: 'local', actionId: 'action-3', action: 'commit' })).rejects.toThrow('is working in this folder')
    expect(record_()?.gitAction).toMatchObject({ actionId: 'action-2', status: 'failed', error: 'Commit local changes before creating a PR.' })
    session.status = 'idle'; f.adapters.codex.emit()
    await vi.waitFor(() => expect(record_()?.status).toBe('idle'))
    expect((await f.host.pullThreadBranch('local')).result).toEqual({ status: 'pulled', branch: 'main', upstream: 'origin/main' })
  })

})
