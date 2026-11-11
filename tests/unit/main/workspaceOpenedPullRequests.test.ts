// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadWorktrees } from '../../../src/main/agents/threadWorktrees'
import { createdPullRequestUrls, endedTurn, openedDuringTurn, pullRequestUrlsIn } from '../../../src/main/agents/openedPullRequests'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { GitStatus } from '../../../src/shared/gitStatus'
import { cleanup, fixture, send } from '../../fixtures/workspaceTestFixture'
import { tellWatcherTools } from '../../../src/main/agents/tellWatcherTools'
import { READY_TO_MERGE_TOOL, type ReadyToMerge } from '../../../src/shared/tellWatcher'

afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

const url = (number: number) => `https://github.com/o/r/pull/${number}`
const record = (id: string, extra: Partial<AgentActivity>): AgentActivity => ({ id, turnId: 'turn-2', sequence: 1, kind: 'command', status: 'completed', title: 'Ran a command', ...extra })
/** What gh says of pull request `number` at `address`, open and not a draft unless told otherwise. */
const pullView = (number: number, address: string, extra: { state?: 'open' | 'closed'; draft?: boolean; createdAt?: string } = {}) => ({ number, url: address, title: `Pull ${number}`, body: '',
  state: extra.state ?? 'open' as const, draft: extra.draft ?? false, baseBranch: 'main', headBranch: `feat/${number}`, crossRepository: false, reviewDecision: null, reviews: [],
  mergeable: 'mergeable' as const, checks: [], checksUnknown: false, mergeMethods: ['merge' as const], autoMergeAllowed: true, autoMerge: null, mergedAt: null, behindBy: 0,
  canUpdateBranch: true, createdAt: extra.createdAt ?? '2026-11-10T00:00:00.000Z' })

describe('the pull requests a turn opened (#2307)', () => {
  it('reads the URLs a gh pr create printed, the newest turn alone, and only pull requests opened since the turn began', () => {
    const turn = endedTurn([
      { id: 'old-turn', turnId: 'turn-1', sequence: 0, kind: 'turn', status: 'completed', title: 'Turn completed', startedAt: '2026-11-06T09:00:00.000Z' },
      record('old-create', { turnId: 'turn-1', command: 'gh pr create --fill', output: url(1) }),
      { id: 'turn', turnId: 'turn-2', sequence: 2, kind: 'turn', status: 'completed', title: 'Turn completed', startedAt: '2026-11-06T10:00:00.000Z' },
      record('push', { command: 'git push -u origin feat/x', output: `remote: Create a pull request: ${url(2)}` }),
      record('create', { command: 'cd ../lane && gh pr create --title "Fix" --body-file body.md', output: `Warning: 1 uncommitted change\n${url(3)}\n` }),
    ])
    expect(turn.startedAt).toBe(Date.parse('2026-11-06T10:00:00.000Z'))
    expect(createdPullRequestUrls(turn.records)).toEqual([url(3)])
    expect(pullRequestUrlsIn(`Opened ${url(4)}/files and (${url(4)}), see https://github.com/o/r/issues/5 and ${url(6)}.`)).toEqual([url(4), url(6)])
    expect(openedDuringTurn('2026-11-06T10:05:00Z', turn.startedAt)).toBe(true)
    expect(openedDuringTurn('2026-11-05T10:05:00Z', turn.startedAt)).toBe(false)
    expect(openedDuringTurn(undefined, turn.startedAt)).toBe(false)
  })

  it('links what a lane opened from its own shell as created from the thread, and asks GitHub for its branch’s own as its turn ends', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const worktree = { mode: 'independent' as const, status: 'ready' as const, path: project.path, repositoryRoot: project.path, branch: 'feat/lane', baseCommit: 'fixture' }
    vi.spyOn(ThreadWorktrees.prototype, 'allocate').mockResolvedValue({ ...worktree, status: 'pending' })
    vi.spyOn(ThreadWorktrees.prototype, 'ensure').mockResolvedValue(worktree)
    vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready', branch: 'feat/lane' }))
    const status: GitStatus = { isRepository: true, branch: 'feat/lane', upstream: 'origin/feat/lane', hasRemote: true, defaultBranch: 'main', isDefaultBranch: false, dirty: false,
      changedFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: 2, pullRequest: null, fetchedAt: null, readAt: '2026-11-06T00:00:00.000Z' }
    const readRemote = vi.fn(async () => true)
    f.host.setGitStatus({ read: vi.fn(async () => status), readRemote, invalidate: vi.fn() }, { pollIntervalMs: () => 0 })
    const began = Date.now()
    const opened = new Date(began + 1_000).toISOString(), long = new Date(began - 86_400_000).toISOString()
    const view = vi.fn(async (_cwd: string, reference: string) => {
      const number = Number(reference.split('/').at(-1))
      return pullView(number, url(number), { createdAt: number === 8 ? long : opened })
    })
    f.host.setGitPullRequests({ view, act: vi.fn() } as never)
    await f.host.execute({ type: 'create-thread', commandId: 'create-local', threadId: 'local', projectId: project.id, title: 'Lane', modelId: model.id })
    await f.host.execute(send())
    // The lane's folder as a Git read last found it: its own branch, pushed, not the default.
    await f.host.updateThreadWorktree('local', false)
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree?.git?.branch).toBe('feat/lane'))
    readRemote.mockClear()
    const session = f.adapters.codex.state.threads.at(-1)!
    session.activities = [
      { id: 'turn', turnId: 'turn-1', sequence: 0, kind: 'turn', status: 'running', title: 'Working', startedAt: new Date(began).toISOString() },
      // A compound command prints an older pull request after the one it opened; only the one opened during the turn links.
      record('create', { turnId: 'turn-1', command: 'gh pr create --fill && gh pr view 8 --json url', output: `${url(7)}\n${url(8)}` }),
    ]
    f.adapters.codex.emit()
    // The reply names the pull request it opened in another worktree, and one opened long before, which it only cites.
    session.messages.push({ id: 'reply', role: 'assistant', text: `Opened ${url(7)} and ${url(9)}. Builds on ${url(8)}.`, createdAt: new Date().toISOString() })
    session.activities = session.activities.map(item => item.kind === 'turn' ? { ...item, status: 'completed' as const, title: 'Turn completed' } : item)
    session.status = 'idle'; f.adapters.codex.emit()
    const links = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.pullRequests ?? []
    await vi.waitFor(() => expect(links().map(link => [link.number, link.source])).toEqual([[7, 'created'], [9, 'created']]))
    expect(view.mock.calls.map(([, reference]) => reference)).toEqual([url(7), url(8), url(9)])
    await vi.waitFor(() => expect(readRemote).toHaveBeenCalledWith(expect.any(String), { background: true }))
  })

  // November 10, 2026 (#2430): READY TO MERGE for pull requests a thread opened from other branches, or in other
  // repositories, came back "Sotto does not hold it in the merge train", since nothing had linked them to the thread.
  it('links the open pull request a READY TO MERGE names before Watcher hears of it, and not a closed one', async () => {
    const f = await fixture()
    const snapshot = await f.host.connect()
    const project = snapshot.projects.find(project => project.providerId === 'codex')!
    const model = snapshot.models.find(model => model.providerId === 'codex')!
    const other = (number: number) => `https://github.com/o/other/pull/${number}`
    // #5 is a draft until the worker makes it ready.
    let fiveDraft = true
    const view = vi.fn(async (_cwd: string, reference: string) => {
      const number = Number(reference.split('/').at(-1))
      return pullView(number, other(number), { state: number === 4 ? 'closed' : 'open', draft: number === 5 && fiveDraft })
    })
    f.host.setGitPullRequests({ view, act: vi.fn() } as never)
    await f.host.execute({ type: 'create-thread', commandId: 'create-ready', threadId: 'ready', projectId: project.id, title: 'Ready', modelId: model.id })
    const links = () => (f.host.workspaceSnapshot().threads.find(thread => thread.id === 'ready')?.pullRequests ?? []).map(link => [link.number, link.source])
    // Watcher takes a read only for a pull request a thread has, so GitHub's answer goes after the link.
    const observed: (readonly (string | number)[])[][] = []
    f.host.setWatcherPrObserver(() => { observed.push(links()) })
    const heard: (readonly (string | number)[])[][] = []
    const ready = vi.fn<(threadId: string, ready: ReadyToMerge) => Promise<{ status: 'told'; requestOpened: boolean }>>(async () => { heard.push(links()); return { status: 'told' as const, requestOpened: false } })
    const tools = tellWatcherTools(f.host, { toldUserMessage: async () => undefined }, async () => ({ status: 'told' as const, requestOpened: false }), ready)
    const head = 'a'.repeat(40)
    await tools.call('ready', READY_TO_MERGE_TOOL, { pullRequest: other(3), head })
    expect(heard).toEqual([[[3, 'linked']]])
    // A closed one is not linked, and READY TO MERGE goes all the same; one already linked keeps its link.
    await tools.call('ready', READY_TO_MERGE_TOOL, { pullRequest: other(4), head })
    await tools.call('ready', READY_TO_MERGE_TOOL, { pullRequest: other(3), head })
    expect(ready).toHaveBeenCalledTimes(3)
    expect(links()).toEqual([[3, 'linked']])
    expect(observed[0]).toEqual([[3, 'linked']])
    // A draft linked earlier is read again when it is ready, so the train no longer leaves it out.
    await tools.call('ready', READY_TO_MERGE_TOOL, { pullRequest: other(5), head })
    const draftOf = (number: number) => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'ready')?.pullRequests?.find(link => link.number === number)?.draft
    expect(draftOf(5)).toBe(true)
    fiveDraft = false
    await tools.call('ready', READY_TO_MERGE_TOOL, { pullRequest: other(5), head })
    expect(draftOf(5)).toBe(false)
    expect(view.mock.calls.map(([, reference]) => reference)).toEqual([other(3), other(4), other(3), other(5), other(5)])
  })
})
