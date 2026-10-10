// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

import { ThreadWorktrees } from '../../src/main/agents/threadWorktrees'
import { GitActions } from '../../src/main/agents/gitActions'
import { GitStatusReader } from '../../src/main/agents/gitStatus'
import { GitPullRequestLimited } from '../../src/main/agents/gitPullRequests'
import { fixture, local } from '../fixtures/workspaceTestFixture'

describe("durable project/thread organization", () => {
  it('initializes Git in a plain project folder and leaves the record with the new repository\'s status', async () => {
    const f = await fixture()
    await local(f)
    const reader = new GitStatusReader({ fetchIntervalMs: () => 30_000 })
    f.host.setGitStatus(reader, { pollIntervalMs: () => 0 })
    f.host.setGitActions(new GitActions({ status: reader, writeCommitMessage: async () => null, writePullRequestText: async () => null }))
    const record_ = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')
    const after = await f.host.initThreadRepository('local')
    expect(after.threads.find(thread => thread.id === 'local')?.worktree?.git).toMatchObject({ isRepository: true, branch: expect.any(String), hasRemote: false, upstream: null }) // the branch is Git's own default
    expect(record_()?.worktree?.git).toMatchObject({ isRepository: true })
    await expect(f.host.initThreadRepository('local')).rejects.toThrow('This folder is already a Git repository.')
  }, 30000)

  it('lists the changed files of the folder a thread works in, for the commit dialog', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const listed = { isRepository: true, files: [{ path: 'a.txt', status: 'modified' as const, insertions: 1, deletions: 0 }], truncated: false }
    const listChangedFiles = vi.fn(async () => listed)
    f.host.setGitStatus({ read: vi.fn(async () => { throw new Error('not read here') }), invalidate: vi.fn(), listChangedFiles }, { pollIntervalMs: () => 0 })
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await expect(f.host.listThreadChangedFiles({ threadId: 'local' })).resolves.toEqual(listed)
    expect(listChangedFiles).toHaveBeenCalledWith(project.path)
    await expect(f.host.listThreadChangedFiles({ threadId: 'missing' })).rejects.toThrow()
    f.host.setGitStatus({ read: vi.fn(async () => { throw new Error('not read here') }), invalidate: vi.fn() }, { pollIntervalMs: () => 0 })
    await expect(f.host.listThreadChangedFiles({ threadId: 'local' })).rejects.toThrow('Changed files are unavailable on this host.')
  })

  it('reads, links, acts on and checks out a thread\'s pull requests, keeping the links on the record', async () => {
    const f = await fixture()
    const { project } = await local(f)
    const url = 'https://github.com/o/r/pull/74', other = 'https://github.com/o/r/pull/80'
    const view = (number: number, change: Record<string, unknown> = {}) => ({ number, url: `https://github.com/o/r/pull/${number}`, title: `Pull ${number}`, body: '', state: 'open' as const, draft: false, baseBranch: 'main',
      headBranch: `feat/${number}`, crossRepository: false, headOwner: 'o', reviewDecision: null, mergeable: 'mergeable' as const, checks: [], mergeMethods: ['merge' as const], autoMerge: null, behindBy: 0, canUpdateBranch: true, ...change })
    const service = {
      view: vi.fn(async (_cwd: string, reference: string) => view(Number(/(\d+)(?:\/files)?$/u.exec(reference)![1]))),
      act: vi.fn(async () => view(74, { state: 'merged' })),
      checkoutLocal: vi.fn(async () => undefined),
      prepareWorktreeBranch: vi.fn(async () => ({ branch: 'feat/80', worktreePath: null })),
    }
    const record = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!
    await expect(f.host.readThreadPullRequest({ threadId: 'local' })).rejects.toThrow('Pull requests are unavailable on this host.')
    f.host.setGitPullRequests(service as never)
    // Nothing on the branch and nothing linked: the surface has nothing to show.
    await expect(f.host.readThreadPullRequest({ threadId: 'local' })).resolves.toBeNull()
    // A press on a pull request the thread does not know is refused before gh is asked.
    await expect(f.host.runPullRequestAction({ threadId: 'local', url, action: 'merge', method: 'merge' })).rejects.toThrow('Link this pull request to the thread before acting on it.')
    expect(service.act).not.toHaveBeenCalled()
    await expect(f.host.linkThreadPullRequest('local', 'main')).rejects.toThrow('Use a pull request URL, 123, or #123.')
    const linked = await f.host.linkThreadPullRequest('local', '#74')
    expect(linked.link).toMatchObject({ number: 74, url, title: 'Pull 74', state: 'open', source: 'linked' })
    expect(service.view).toHaveBeenLastCalledWith(project.path, '#74')
    // With no reference the surface reads the one linked last.
    await expect(f.host.readThreadPullRequest({ threadId: 'local' })).resolves.toMatchObject({ number: 74, linked: 'linked', branch: false })
    // A read GitHub's rate limit holds back answers when to ask again, for the surface to say (#820).
    service.view.mockRejectedValueOnce(new GitPullRequestLimited(Date.parse('2026-10-07T12:00:00Z'), Date.parse('2026-10-07T11:40:00Z')))
    await expect(f.host.readThreadPullRequest({ threadId: 'local' })).resolves.toEqual({ limited: { retryAt: '2026-10-07T12:00:00.000Z' } })
    const done = await f.host.runPullRequestAction({ threadId: 'local', url, action: 'merge', method: 'squash' })
    expect(service.act).toHaveBeenCalledWith(project.path, url, 'merge', 'squash')
    expect(done.notice).toBe('Pull request merged.')
    expect(record().pullRequests).toEqual([expect.objectContaining({ number: 74, state: 'merged', source: 'linked' })])
    // Local checks the pull request out in the thread's folder and links it, as T3 does.
    const checkedOut = await f.host.checkoutThreadPullRequest('local', `${other}/files`, 'local')
    expect(service.checkoutLocal).toHaveBeenCalledWith(project.path, other)
    expect(checkedOut.notice).toMatch(/^Checked out PR #80/u)
    expect(record().pullRequests?.map(link => [link.number, link.source])).toEqual([[74, 'linked'], [80, 'checkout']])
    // Worktree records the branch the draft's new worktree will check out on first send.
    const worktree = await f.host.checkoutThreadPullRequest('local', '#80', 'worktree')
    expect(worktree.notice).toBe('PR #80 will be checked out on feat/80 in a new worktree when you send.')
    expect(record().worktree).toMatchObject({ mode: 'independent', status: 'pending', branch: 'feat/80', checkoutBranch: true })
    expect(record().pullRequests).toHaveLength(2)
    await f.host.unlinkThreadPullRequest('local', url)
    expect(record().pullRequests?.map(link => link.number)).toEqual([80])
    // The links are Sotto's record: a provider snapshot does not take them away.
    f.adapters.codex.emit()
    await vi.waitFor(() => expect(record().pullRequests?.map(link => link.number)).toEqual([80]))
  })

  it('lists the branches of the folder a thread works in, a draft reading its project folder', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const page = { refs: [{ name: 'main', current: true, isDefault: true, worktreePath: null }], isRepository: true, hasRemote: false, nextCursor: null, total: 1 }
    const listRefs = vi.fn(async () => page)
    f.host.setGitStatus({ read: vi.fn(async () => { throw new Error('not read here') }), invalidate: vi.fn(), listRefs }, { pollIntervalMs: () => 0 })
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'New task', modelId: model.id })
    await expect(f.host.listThreadRefs({ threadId: 'local', query: 'ma', limit: 10 })).resolves.toEqual(page)
    expect(listRefs).toHaveBeenCalledWith(project.path, { query: 'ma', limit: 10 })
    // A draft pointed at a worktree that exists reads that worktree's branches, and the record names its branch.
    vi.spyOn(ThreadWorktrees.prototype, 'options').mockResolvedValue({ isGit: true, currentBranch: 'main', branches: ['main', 'feat/other'], worktrees: [{ path: 'C:\\wt\\other\\', branch: 'feat/other' }] })
    await f.host.configureThreadWorkingCopy('local', { workingCopy: 'independent', existingWorktreePath: 'C:/wt/other' })
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree).toMatchObject({ mode: 'independent', status: 'pending', existingWorktreePath: 'C:/wt/other', branch: 'feat/other' })
    await f.host.listThreadRefs({ threadId: 'local' })
    expect(listRefs).toHaveBeenLastCalledWith('C:/wt/other', {})
    await expect(f.host.listThreadRefs({ threadId: 'missing' })).rejects.toThrow()
    // A status source with no listing, or none at all, refuses in plain words rather than guessing.
    f.host.setGitStatus({ read: vi.fn(async () => { throw new Error('not read here') }), invalidate: vi.fn() }, { pollIntervalMs: () => 0 })
    await expect(f.host.listThreadRefs({ threadId: 'local' })).rejects.toThrow('Branches are unavailable on this host.')
  })

})
