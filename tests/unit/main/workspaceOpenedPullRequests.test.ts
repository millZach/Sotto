// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadWorktrees } from '../../../src/main/agents/threadWorktrees'
import { createdPullRequestUrls, endedTurn, openedDuringTurn, pullRequestUrlsIn } from '../../../src/main/agents/openedPullRequests'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { GitStatus } from '../../../src/shared/gitStatus'
import { cleanup, fixture, send } from '../../fixtures/workspaceTestFixture'

afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

const url = (number: number) => `https://github.com/o/r/pull/${number}`
const record = (id: string, extra: Partial<AgentActivity>): AgentActivity => ({ id, turnId: 'turn-2', sequence: 1, kind: 'command', status: 'completed', title: 'Ran a command', ...extra })

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
      return { number, url: url(number), title: `Pull ${number}`, body: '', state: 'open' as const, draft: false, baseBranch: 'main', headBranch: `feat/${number}`, crossRepository: false,
        reviewDecision: null, reviews: [], mergeable: 'mergeable' as const, checks: [], checksUnknown: false, mergeMethods: ['merge' as const], autoMergeAllowed: true, autoMerge: null,
        mergedAt: null, behindBy: 0, canUpdateBranch: true, createdAt: number === 8 ? long : opened }
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
      record('create', { turnId: 'turn-1', command: 'gh pr create --fill', output: url(7) }),
    ]
    f.adapters.codex.emit()
    // The reply names the pull request it opened in another worktree, and one opened long before, which it only cites.
    session.messages.push({ id: 'reply', role: 'assistant', text: `Opened ${url(7)} and ${url(9)}. Builds on ${url(8)}.`, createdAt: new Date().toISOString() })
    session.activities = session.activities.map(item => item.kind === 'turn' ? { ...item, status: 'completed' as const, title: 'Turn completed' } : item)
    session.status = 'idle'; f.adapters.codex.emit()
    const links = () => f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.pullRequests ?? []
    await vi.waitFor(() => expect(links().map(link => [link.number, link.source])).toEqual([[7, 'created'], [9, 'created']]))
    expect(view.mock.calls.map(([, reference]) => reference)).toEqual([url(7), url(9), url(8)])
    await vi.waitFor(() => expect(readRemote).toHaveBeenCalledWith(expect.any(String), { background: true }))
  })
})
