// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadWorktrees } from '../../../src/main/agents/threadWorktrees'
import { tellWatcherTools } from '../../../src/main/agents/tellWatcherTools'
import { GIT_PULL_REQUEST_LINKS_MAX } from '../../../src/shared/gitPullRequests'
import type { GitStatus } from '../../../src/shared/gitStatus'
import { READY_TO_MERGE_TOOL, type ReadyToMerge } from '../../../src/shared/tellWatcher'
import { cleanup, fixture, send } from '../../fixtures/workspaceTestFixture'
import { workspaceFixture } from '../../fixtures/workspaceFixture'

afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

const prUrl = (number: number) => `https://github.com/o/r/pull/${number}`
const prSummary = (number: number, state: 'open' | 'closed' | 'merged' = 'open', draft = false) => ({
  number,
  url: prUrl(number),
  title: `PR ${number}`,
  state,
  draft,
})
const pullView = (number: number, address: string, extra: { state?: 'open' | 'closed' | 'merged'; draft?: boolean; createdAt?: string } = {}) => ({
  number,
  url: address,
  title: `PR ${number}`,
  body: '',
  state: extra.state ?? 'open' as const,
  draft: extra.draft ?? false,
  baseBranch: 'main',
  headBranch: `feat/${number}`,
  crossRepository: false,
  reviewDecision: null,
  reviews: [],
  mergeable: 'mergeable' as const,
  checks: [],
  checksUnknown: false,
  mergeMethods: ['merge' as const],
  autoMergeAllowed: true,
  autoMerge: null,
  mergedAt: null,
  behindBy: 0,
  canUpdateBranch: true,
  createdAt: extra.createdAt ?? '2026-11-10T00:00:00.000Z',
})
const gitStatus = (branch: string, pullRequest: ReturnType<typeof prSummary> | null): GitStatus => ({
  isRepository: true,
  branch,
  upstream: `origin/${branch}`,
  hasRemote: true,
  defaultBranch: 'main',
  isDefaultBranch: branch === 'main',
  dirty: false,
  changedFiles: 0,
  insertions: 0,
  deletions: 0,
  ahead: 0,
  behind: 0,
  aheadOfDefault: branch === 'main' ? 0 : 1,
  pullRequest,
  fetchedAt: null,
  readAt: new Date().toISOString(),
})

describe('multi-PR tracking across branch switches (#2063)', () => {
  it('auto-promotes open PRs on branch switches in independent worktrees, deduplicates openPullRequestUrls, and skips auto-promotion in shared folders', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(item => item.providerId === 'codex')!
    const model = snapshot.models.find(item => item.providerId === 'codex')!

    const worktree = { mode: 'independent' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, branch: 'feat/1', baseCommit: 'fixture' }
    const sharedWorktree = { mode: 'shared' as const, status: 'ready' as const, path: project.path }
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockImplementation(async (_projectPath, mode) =>
      mode === 'shared' ? { ...sharedWorktree, path: project.path } : { ...worktree, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockImplementation(async metadata =>
      metadata.mode === 'shared' ? { ...metadata, status: 'ready' } : worktree)
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready' }))

    let currentStatus = gitStatus('feat/1', prSummary(101, 'open'))
    let sharedStatus = gitStatus('shared/1', prSummary(201, 'open'))
    f.host.setGitStatus({
      read: vi.fn(async (folder: string) => folder === project.path ? currentStatus : sharedStatus),
      readRemote: vi.fn(async () => true),
      invalidate: vi.fn(),
    }, { pollIntervalMs: () => 0 })
    void sharedStatus

    await f.host.execute({ type: 'create-thread', commandId: 'c-ind', threadId: 'ind', projectId: project.id, title: 'Worktree thread', modelId: model.id, workingCopy: 'independent' })
    await f.host.execute(send('ind'))
    await f.host.updateThreadWorktree('ind', false)
    await vi.waitFor(() => expect(f.host.threadPullRequests('ind').branch).toBe(prUrl(101)))

    // Switching to branch 2 with PR 102 retains PR 101 in durable links (source 'linked', never promoted without switching branches).
    currentStatus = gitStatus('feat/2', prSummary(102, 'open'))
    await f.host.updateThreadWorktree('ind', false)
    await vi.waitFor(() => expect(f.host.threadPullRequests('ind')).toEqual({ branch: prUrl(102), linked: [prUrl(101)] }))
    expect((await f.host.snapshot()).threads.find(t => t.id === 'ind')?.pullRequests?.find(link => link.url === prUrl(101))?.source).toBe('linked')
    expect(f.host.openPullRequestUrls('ind')).toEqual([prUrl(102), prUrl(101)])

    // Same-branch PR change or transient empty PR read (e.g. rebase / detached check) must NOT auto-promote PR 102.
    currentStatus = gitStatus('feat/2', prSummary(104, 'open'))
    await f.host.updateThreadWorktree('ind', false)
    await vi.waitFor(() => expect(f.host.threadPullRequests('ind').branch).toBe(prUrl(104)))
    currentStatus = gitStatus('feat/2', null)
    await f.host.updateThreadWorktree('ind', false)
    await vi.waitFor(() => expect(f.host.threadPullRequests('ind').branch).toBeUndefined())
    expect(f.host.threadPullRequests('ind').linked).toEqual([prUrl(101)])
    currentStatus = gitStatus('feat/2', prSummary(102, 'open'))
    await f.host.updateThreadWorktree('ind', false)
    await vi.waitFor(() => expect(f.host.threadPullRequests('ind').branch).toBe(prUrl(102)))

    // Unlinking PR 102 prevents re-promotion when switching again to branch 3; explicit re-link clears suppression.
    f.host.setGitPullRequests({ view: vi.fn(async (_cwd: string, reference: string) => { const n = Number(reference.split('/').at(-1)); return pullView(n, prUrl(n), { createdAt: '2026-11-10T00:00:00.000Z' }) }), act: vi.fn() } as never)
    // Link 102 first so unlink has a durable link to remove alongside suppression.
    await f.host.linkThreadPullRequest('ind', prUrl(102))
    expect(f.host.openPullRequestUrls('ind')).toEqual([prUrl(102), prUrl(101)]) // deduplicated even though branch AND link both hold 102
    await f.host.unlinkThreadPullRequest('ind', prUrl(102))
    currentStatus = gitStatus('feat/3', prSummary(103, 'open'))
    await f.host.updateThreadWorktree('ind', false)
    await vi.waitFor(() => expect(f.host.threadPullRequests('ind').branch).toBe(prUrl(103)))
    expect(f.host.threadPullRequests('ind').linked).toEqual([prUrl(101)])

    // Switching to feat/4 on shared checkout does not auto-promote PR 201 into durable links.
    sharedStatus = gitStatus('shared/1', prSummary(201, 'open'))
    f.host.setGitStatus({
      read: vi.fn(async () => sharedStatus),
      readRemote: vi.fn(async () => true),
      invalidate: vi.fn(),
    }, { pollIntervalMs: () => 0 })
    await f.host.execute({ type: 'create-thread', commandId: 'c-shr', threadId: 'shr', projectId: project.id, title: 'Shared thread', modelId: model.id, workingCopy: 'shared' })
    await f.host.updateThreadWorktree('shr', false)
    await vi.waitFor(() => expect(f.host.threadPullRequests('shr').branch).toBe(prUrl(201)))
    sharedStatus = gitStatus('shared/2', prSummary(202, 'open'))
    await f.host.updateThreadWorktree('shr', false)
    await vi.waitFor(() => expect(f.host.threadPullRequests('shr').branch).toBe(prUrl(202)))
    expect(f.host.threadPullRequests('shr').linked).toEqual([])
  })

  it('persists a durable link on ready_to_merge even when already known on the active branch, evicts settled links before open ones, and falls back to message timestamp on turn finish', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(item => item.providerId === 'codex')!
    const model = snapshot.models.find(item => item.providerId === 'codex')!
    const worktree = { mode: 'independent' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, branch: 'feat/ready', baseCommit: 'fixture' }
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...worktree, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockResolvedValue(worktree)
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready' }))

    const activeStatus = gitStatus('feat/ready', prSummary(301, 'open'))
    f.host.setGitStatus({ read: vi.fn(async () => activeStatus), readRemote: vi.fn(async () => true), invalidate: vi.fn() }, { pollIntervalMs: () => 0 })
    const began = Date.now()
    const view = vi.fn(async (_cwd: string, reference: string) => {
      const number = Number(reference.split('/').at(-1))
      return pullView(number, prUrl(number), { state: number === 999 ? 'closed' : 'open', createdAt: new Date(began + 500).toISOString() })
    })
    f.host.setGitPullRequests({ view, act: vi.fn() } as never)

    await f.host.execute({ type: 'create-thread', commandId: 'c-ready', threadId: 'r1', projectId: project.id, title: 'Ready thread', modelId: model.id, workingCopy: 'independent' })
    await f.host.execute(send('r1'))
    await f.host.updateThreadWorktree('r1', false)
    await vi.waitFor(() => expect(f.host.threadPullRequests('r1').branch).toBe(prUrl(301)))

    // ready_to_merge on the active branch PR still adds a durable link in thread.pullRequests.
    const ready = vi.fn(async () => ({ status: 'told' as const, requestOpened: false }))
    const tools = tellWatcherTools(f.host, { toldUserMessage: async () => undefined }, async () => ({ status: 'told' as const, requestOpened: false }), ready as (threadId: string, ready: ReadyToMerge) => Promise<{ status: 'told'; requestOpened: boolean }>)
    await tools.call('r1', READY_TO_MERGE_TOOL, { pullRequest: prUrl(301), head: 'b'.repeat(40) })
    expect(f.host.threadPullRequests('r1').linked).toContain(prUrl(301))

    // Filling past GIT_PULL_REQUEST_LINKS_MAX evicts settled PR 999 before any open PR (301 + 49 open = 50 kept, 999 evicted).
    await f.host.linkThreadPullRequest('r1', prUrl(999))
    for (let i = 0; i < GIT_PULL_REQUEST_LINKS_MAX - 1; i++) await f.host.linkThreadPullRequest('r1', prUrl(400 + i))
    const kept = f.host.threadPullRequests('r1').linked
    expect(kept).toHaveLength(GIT_PULL_REQUEST_LINKS_MAX)
    expect(kept).not.toContain(prUrl(999))
    expect(kept).toContain(prUrl(301))

    // Provider turn ending without activity startedAt uses message timestamp fallback in followTurnPullRequests.
    await f.host.execute({ type: 'create-thread', commandId: 'c-fallback', threadId: 'fb', projectId: project.id, title: 'Fallback thread', modelId: model.id })
    await f.host.execute(send('fb'))
    const session = f.adapters.codex.state.threads.at(-1)!
    session.activities = [{ id: 't-fb', turnId: 'message-fb', sequence: 0, kind: 'turn', status: 'completed', title: 'Done' }]
    session.messages.push({ id: 'reply-fb', role: 'assistant', text: `Opened ${prUrl(777)}`, createdAt: new Date(began + 1000).toISOString() })
    session.status = 'idle'
    f.adapters.codex.emit()
    await vi.waitFor(() => expect(f.host.threadPullRequests('fb').linked).toContain(prUrl(777)))

    // Linking a newly settled PR when already at 50 open links must evict an older link instead of evicting the new one.
    await f.host.execute({ type: 'create-thread', commandId: 'c-cap', threadId: 'cap', projectId: project.id, title: 'Cap thread', modelId: model.id })
    for (let i = 0; i < GIT_PULL_REQUEST_LINKS_MAX; i++) await f.host.linkThreadPullRequest('cap', prUrl(500 + i))
    expect(f.host.threadPullRequests('cap').linked).toHaveLength(GIT_PULL_REQUEST_LINKS_MAX)
    await f.host.linkThreadPullRequest('cap', prUrl(999))
    const afterCap = f.host.threadPullRequests('cap').linked
    expect(afterCap).toHaveLength(GIT_PULL_REQUEST_LINKS_MAX)
    expect(afterCap).toContain(prUrl(999))
    expect(afterCap).not.toContain(prUrl(500))
  })

  it('persists unlinked PR suppression across restarts and ignores concurrent turn-follow links during an unlink', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(item => item.providerId === 'codex')!
    const model = snapshot.models.find(item => item.providerId === 'codex')!
    const worktree = { mode: 'independent' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, branch: 'feat/1', baseCommit: 'fixture' }
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...worktree, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockResolvedValue(worktree)
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready' }))

    let currentStatus = gitStatus('feat/1', prSummary(101, 'open'))
    f.host.setGitStatus({ read: vi.fn(async () => currentStatus), readRemote: vi.fn(async () => true), invalidate: vi.fn() }, { pollIntervalMs: () => 0 })

    // Block followTurnPullRequests view so we can unlink mid-flight before onLane commits.
    let resolveView!: () => void
    const viewGate = new Promise<void>(resolve => { resolveView = resolve })
    const began = Date.now()
    f.host.setGitPullRequests({
      view: vi.fn(async (_cwd: string, reference: string) => {
        const number = Number(reference.split('/').at(-1))
        if (number === 888) await viewGate
        return pullView(number, prUrl(number), { createdAt: new Date(began + 1000).toISOString() })
      }),
      act: vi.fn(),
    } as never)

    await f.host.execute({ type: 'create-thread', commandId: 'c-persist', threadId: 'p1', projectId: project.id, title: 'Persist thread', modelId: model.id, workingCopy: 'independent' })
    await f.host.execute(send('p1'))
    const session = f.adapters.codex.state.threads.at(-1)!
    session.activities = [{ id: 't-p1', turnId: 'message-p1', sequence: 0, kind: 'turn', status: 'completed', title: 'Done' }]
    session.messages.push({ id: 'reply-p1', role: 'assistant', text: `Opened ${prUrl(888)}`, createdAt: new Date(began + 1500).toISOString() })
    session.status = 'idle'
    f.adapters.codex.emit()
    await f.host.unlinkThreadPullRequest('p1', prUrl(888))
    resolveView()
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(f.host.threadPullRequests('p1').linked).not.toContain(prUrl(888))

    // Link then unlink #101, restart WorkspaceHost over the same directory, then switch branch -> #101 must stay suppressed.
    await f.host.updateThreadWorktree('p1', false)
    await vi.waitFor(() => expect(f.host.threadPullRequests('p1').branch).toBe(prUrl(101)))
    await f.host.unlinkThreadPullRequest('p1', prUrl(101))
    await f.host.flush()
    await f.stop()

    const reopened = await workspaceFixture(f.root, { adapters: f.adapters })
    cleanup.push(() => reopened.stop())
    await reopened.host.connect()
    currentStatus = gitStatus('feat/2', prSummary(102, 'open'))
    reopened.host.setGitStatus({ read: vi.fn(async () => currentStatus), readRemote: vi.fn(async () => true), invalidate: vi.fn() }, { pollIntervalMs: () => 0 })
    await reopened.host.updateThreadWorktree('p1', false)
    await vi.waitFor(() => expect(reopened.host.threadPullRequests('p1').branch).toBe(prUrl(102)))
    expect(reopened.host.threadPullRequests('p1').linked).not.toContain(prUrl(101))
  })
})
