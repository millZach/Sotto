// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { initializeGitRepository } from '../fixtures/gitRepository'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWorktreeGit as git, ThreadWorktrees } from '../../src/main/agents/threadWorktrees'
import { WorktreeCleanup } from '../../src/main/agents/worktreeCleanup'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread, type AgentWorktree } from '../../src/shared/agents'
import { DEFAULT_WORKTREE_CLEANUP, type WorktreeCleanupRules } from '../../src/shared/settings'
import type { GitPullRequestLink } from '../../src/shared/gitPullRequests'
import type { PullRequestObservation } from '../../src/main/agents/watcherEvidence'
import type { MergedSettleExpectation, PullRequestState } from '../../src/main/agents/worktreeCleanup'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-cleanup-test-')) throw new Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
const commit = (cwd: string, message: string) => git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', message])

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-cleanup-test-')); roots.push(root)
  const project = join(root, 'project'); await mkdir(project)
  await initializeGitRepository(project, { files: { 'tracked.txt': 'baseline', '.gitignore': 'node_modules/\n' } })
  const worktrees = new ThreadWorktrees(root)
  const checkout = async () => worktrees.inspect(await worktrees.ensure(await worktrees.allocate(project, 'independent')))
  return { root, project, worktrees, checkout }
}
function thread(id: string, worktree: AgentWorktree, extra: Partial<AgentThread> = {}): AgentThread {
  return { id, projectId: 'project', title: id, modelId: 'model', status: 'idle', messages: [], requests: [], worktree, nativeSessionStarted: true, ...extra }
}
/** A stand-in for WorkspaceHost: the threads, the reclaim it is asked for, and the settle it is told about. */
function fakeHost(threads: AgentThread[], worktrees: ThreadWorktrees) {
  const listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  const snapshot = (): AgentHostSnapshot => ({ ...EMPTY_AGENT_HOST, projects: [{ id: 'project', providerId: 'codex', title: 'Project', path: '' }], threads })
  const reclaimed: string[] = []
  return {
    reclaimed,
    workspaceSnapshot: snapshot,
    subscribe: (listener: (snapshot: AgentHostSnapshot) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    async reclaimThreadWorktree(threadId: string, options: { automatic: true }) {
      const target = threads.find(item => item.id === threadId)!
      target.worktree = await worktrees.reclaim(target.worktree!, options)
      reclaimed.push(threadId)
    },
    publish: () => { for (const listener of listeners) listener(snapshot()) },
  }
}

describe('worktree cleanup rules', () => {
  it('does nothing while every rule is off', async () => {
    const r = await repository()
    const a = await r.checkout()
    const host = fakeHost([thread('a', a, { workspaceSettledAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' })], r.worktrees)
    await new WorktreeCleanup({ host, rules: () => DEFAULT_WORKTREE_CLEANUP }).sweep()
    expect(host.reclaimed).toEqual([])
    expect((await git(r.project, ['worktree', 'list', '--porcelain'])).match(/worktree /gu)).toHaveLength(2)
  })
  it('reclaims an idle thread’s clean folder after the chosen days, and leaves a busy or recent one', async () => {
    const r = await repository()
    const [old, recent, running, background] = [await r.checkout(), await r.checkout(), await r.checkout(), await r.checkout()]
    const now = Date.parse('2026-09-22T12:00:00.000Z')
    const host = fakeHost([
      thread('old', old, { updatedAt: '2026-08-01T00:00:00.000Z' }),
      thread('recent', recent, { updatedAt: '2026-09-20T00:00:00.000Z' }),
      thread('running', running, { status: 'running', updatedAt: '2026-08-01T00:00:00.000Z' }),
      // Its turn is over, but background agents it started still work in the folder.
      thread('background', background, { backgroundWork: [{ id: randomUUID(), type: 'subagent', label: 'Synthetic agent' }], updatedAt: '2026-08-01T00:00:00.000Z' }),
    ], r.worktrees)
    await new WorktreeCleanup({ host, rules: () => ({ ...DEFAULT_WORKTREE_CLEANUP, afterDays: 30 }), now: () => now }).sweep()
    expect(host.reclaimed).toEqual(['old'])
    expect((await git(r.project, ['worktree', 'list', '--porcelain'])).match(/worktree /gu)).toHaveLength(4)
  })
  it('reclaims a folder whose commits are already in the default branch, never one with work of its own', async () => {
    const r = await repository()
    const integrated = await r.checkout()
    const ahead = await r.checkout()
    await writeFile(join(ahead.path!, 'tracked.txt'), 'new work'); await git(ahead.path!, ['add', '.']); await commit(ahead.path!, 'Work')
    const host = fakeHost([thread('integrated', integrated), thread('ahead', ahead)], r.worktrees)
    await new WorktreeCleanup({ host, rules: () => ({ ...DEFAULT_WORKTREE_CLEANUP, unchanged: true }) }).sweep()
    expect(host.reclaimed).toEqual(['integrated'])
    expect((await git(r.project, ['rev-parse', ahead.branch!])).trim()).toBe((await git(ahead.path!, ['rev-parse', 'HEAD'])).trim())
  })
  it('does not reuse a merged answer after auto-settle advances the branch during the sweep', async () => {
    const r = await repository(), copy = await r.checkout()
    const tip = (await git(r.project, ['rev-parse', `refs/heads/${copy.branch}`])).trim()
    const base = fakeHost([thread('a', copy)], r.worktrees)
    const host = { ...base, setWorkspaceSettled: async () => {
      await writeFile(join(copy.path!, 'tracked.txt'), 'new work')
      await git(copy.path!, ['add', '.']); await commit(copy.path!, 'More work')
    } }
    const pullRequestMerged = vi.fn(async () => (await git(r.project, ['rev-parse', `refs/heads/${copy.branch}`])).trim() === tip)
    await new WorktreeCleanup({ host, rules: () => ({ ...DEFAULT_WORKTREE_CLEANUP, merged: true }), autoSettleMerged: () => true, pullRequestMerged }).sweep()
    expect(host.reclaimed).toEqual([])
    expect(pullRequestMerged).toHaveBeenCalledTimes(2)
  })
  it('asks GitHub only for the merged rule and skips a folder a rule may not touch', async () => {
    const r = await repository()
    const merged = await r.checkout()
    const dirty = await r.checkout(); await writeFile(join(dirty.path!, 'tracked.txt'), 'unsaved')
    const built = await r.checkout(); await mkdir(join(built.path!, 'node_modules')); await writeFile(join(built.path!, 'stray.log'), '')
    await writeFile(join(built.path!, '.gitignore'), 'node_modules/\n*.log\n')
    const pullRequestMerged = vi.fn(async () => true)
    const host = fakeHost([thread('merged', merged), thread('dirty', dirty), thread('built', built)], r.worktrees)
    const skipped: string[] = []
    await new WorktreeCleanup({ host, rules: () => ({ ...DEFAULT_WORKTREE_CLEANUP, merged: true }), pullRequestMerged, log: code => skipped.push(code) }).sweep()
    // The dirty folder and the one with build output are refused by the folder itself; uncommitted work is never a rule's to lose.
    expect(host.reclaimed).toEqual(['merged'])
    expect(skipped.filter(code => code === 'worktree-cleanup-skipped')).toHaveLength(2)
    expect(pullRequestMerged).toHaveBeenCalledWith(merged.repositoryRoot, merged.branch)
    await new WorktreeCleanup({ host, rules: () => ({ ...DEFAULT_WORKTREE_CLEANUP, unchanged: true }), pullRequestMerged }).sweep()
    expect(pullRequestMerged).toHaveBeenCalledTimes(3)
  })
  it('acts on a settle only with the on-settle rule, and looks again when the rules change', async () => {
    const r = await repository()
    const a = await r.checkout()
    const threads = [thread('a', a)]
    const host = fakeHost(threads, r.worktrees)
    let rules: WorktreeCleanupRules = DEFAULT_WORKTREE_CLEANUP
    const cleanup = new WorktreeCleanup({ host, rules: () => rules, intervalMs: 60_000_000 })
    cleanup.start()
    await cleanup.request()
    threads[0]!.workspaceSettledAt = new Date().toISOString(); host.publish()
    await cleanup.request()
    expect(host.reclaimed).toEqual([])
    rules = { ...DEFAULT_WORKTREE_CLEANUP, onSettle: true }
    cleanup.settingsChanged()
    await cleanup.request()
    expect(host.reclaimed).toEqual(['a'])
    cleanup.dispose()
  })
  it('sweeps on a settings save only when the rules or Auto-settle merged threads changed (#820)', async () => {
    let rules: WorktreeCleanupRules = { ...DEFAULT_WORKTREE_CLEANUP, merged: true }
    let autoSettle = false
    const pullRequestMerged = vi.fn(async () => false)
    const own: AgentWorktree = { mode: 'independent', status: 'ready', path: '/w/feature', repositoryRoot: '/repo', branch: 'feature' }
    const host = { ...fakeHost([thread('a', own)], new ThreadWorktrees('/unused')), reclaimThreadWorktree: vi.fn(async () => undefined) }
    // The branch's tip is all the merged check reads of Git here; GitHub is the scripted answer above.
    const cleanup = new WorktreeCleanup({ host, rules: () => rules, autoSettleMerged: () => autoSettle, pullRequestMerged, git: async () => `${'a'.repeat(40)}\n`, intervalMs: 60_000_000 })
    cleanup.start()
    await cleanup.request() // the sweep start asked for
    expect(pullRequestMerged).toHaveBeenCalledTimes(1)
    // Every sweep a save asks for goes through request, which decides at once whether one runs.
    const requested = vi.spyOn(cleanup, 'request')
    const sweptAfter = async (index: number) => { await requested.mock.results[index]!.value }
    // Saves that changed something else, such as the theme: no sweep is asked for, so GitHub is not asked.
    cleanup.settingsChanged(); cleanup.settingsChanged()
    expect(requested).not.toHaveBeenCalled()
    expect(pullRequestMerged).toHaveBeenCalledTimes(1)
    // A rule changed, then Auto-settle merged threads: each sweeps once.
    rules = { ...rules, afterDays: 30 }
    cleanup.settingsChanged()
    expect(requested).toHaveBeenCalledTimes(1)
    await sweptAfter(0)
    expect(pullRequestMerged).toHaveBeenCalledTimes(2)
    autoSettle = true
    cleanup.settingsChanged()
    expect(requested).toHaveBeenCalledTimes(2)
    await sweptAfter(1)
    expect(pullRequestMerged).toHaveBeenCalledTimes(3)
    cleanup.dispose()
  })
})

describe('auto-settle merged threads', () => {
  const own = (branch: string, extra: Partial<AgentWorktree> = {}): AgentWorktree => ({ mode: 'independent', status: 'ready', path: `/w/${branch}`, repositoryRoot: '/repo', branch, sentBranch: branch, ...extra })
  /** Records only: settling touches no folder, so no repository is needed. */
  function settlingHost(threads: AgentThread[]) {
    const settled: string[] = [], reclaimed: string[] = [], expected: (MergedSettleExpectation | undefined)[] = [], noted: PullRequestObservation[] = []
    return {
      settled, reclaimed, expected, noted,
      workspaceSnapshot: (): AgentHostSnapshot => ({ ...EMPTY_AGENT_HOST, projects: [{ id: 'project', providerId: 'codex', title: 'Project', path: '/repo' }], threads }),
      subscribe: () => () => undefined,
      async reclaimThreadWorktree(threadId: string) { reclaimed.push(threadId) },
      async setWorkspaceSettled(_kind: 'thread', id: string, _settled: true, options?: MergedSettleExpectation) {
        settled.push(id); expected.push(options); threads.find(item => item.id === id)!.workspaceSettledAt = new Date().toISOString()
      },
      notePullRequestState(read: PullRequestObservation) { noted.push(read) },
    }
  }
  /** A repository whose default branch is `trunk`, as origin's HEAD records it; nothing else answers. */
  const trunkGit = vi.fn(async (_cwd: string, args: string[]) => {
    if (args[0] === 'symbolic-ref') return 'origin/trunk\n'
    if (args[0] === 'rev-parse' && args.at(-1) === 'refs/heads/trunk') return 'abc123\n'
    if (args[0] === 'rev-parse' && args.at(-1)?.endsWith('^{commit}')) return 'fixture-tip\n'
    throw new Error('not in this fixture')
  })
  it('settles an idle thread whose branch merged, once, and leaves the rest where they are', async () => {
    const threads = [
      thread('merged', own('feature/merged')),
      thread('open', own('feature/open')),
      thread('running', own('feature/merged-too'), { status: 'running' }),
      thread('shared-sent', { mode: 'shared', status: 'ready', path: '/repo', repositoryRoot: '/repo', branch: 'trunk', sentBranch: 'feature/shared' }),
      thread('shared-default', { mode: 'shared', status: 'ready', path: '/repo', repositoryRoot: '/repo', branch: 'trunk', sentBranch: 'trunk' }),
      // `main` is an ordinary branch in a repository whose default is `trunk`.
      thread('shared-main', { mode: 'shared', status: 'ready', path: '/repo', repositoryRoot: '/repo', branch: 'main', sentBranch: 'main' }),
      thread('draft', own('sotto/draft'), { nativeSessionStarted: false }),
      thread('reclaimed', own('feature/reclaimed', { reclaimedAt: '2026-09-20T00:00:00.000Z' })),
    ]
    const host = settlingHost(threads)
    const pullRequestMerged = vi.fn(async (_root: string, branch: string) => branch !== 'feature/open')
    const log: string[] = []
    let on = true
    trunkGit.mockClear()
    const cleanup = new WorktreeCleanup({ host, git: trunkGit, rules: () => DEFAULT_WORKTREE_CLEANUP, autoSettleMerged: () => on, pullRequestMerged, log: code => log.push(code) })
    await cleanup.sweep()
    expect(host.settled).toEqual(['merged', 'shared-sent', 'shared-main', 'reclaimed'])
    // Settling removed nothing: no cleanup rule is on.
    expect(host.reclaimed).toEqual([])
    // The default branch is never asked about, and it is looked up once for the repository.
    expect(pullRequestMerged).not.toHaveBeenCalledWith('/repo', 'trunk')
    expect(trunkGit.mock.calls.filter(call => call[1][0] === 'symbolic-ref')).toHaveLength(1)
    expect(log).toEqual(['thread-auto-settled', 'thread-auto-settled', 'thread-auto-settled', 'thread-auto-settled'])
    // A thread the user restores stays restored for the rest of the run.
    threads[0]!.workspaceSettledAt = null
    await cleanup.sweep()
    expect(host.settled).toEqual(['merged', 'shared-sent', 'shared-main', 'reclaimed'])
    // Off, nothing is asked at all.
    on = false
    pullRequestMerged.mockClear()
    await cleanup.sweep()
    expect(pullRequestMerged).not.toHaveBeenCalled()
  })
  it('leaves a merged thread alone while its background work, sub-agents or monitoring still run', async () => {
    const threads = [
      thread('background', own('feature/background'), { backgroundWork: [{ id: randomUUID(), type: 'subagent', label: 'Synthetic agent' }] }),
      thread('subagents', own('feature/subagents'), { subagentSummary: { total: 3, working: 3, completed: 0, failed: 0, interrupted: 0, unknown: 0 } }),
      thread('unknown', own('feature/unknown'), { subagentSummary: { total: 1, working: 0, completed: 0, failed: 0, interrupted: 0, unknown: 1 } }),
      thread('monitoring', own('feature/monitoring'), { monitoring: [{ id: randomUUID(), label: 'Synthetic monitor' }] }),
      thread('turn', own('feature/turn'), { lastTurn: { id: randomUUID(), status: 'running' } }),
      thread('done', own('feature/done')),
    ]
    const host = settlingHost(threads)
    const pullRequestMerged = vi.fn(async () => true)
    await new WorktreeCleanup({ host, git: trunkGit, rules: () => DEFAULT_WORKTREE_CLEANUP, autoSettleMerged: () => true, pullRequestMerged }).sweep()
    // Settling ends what the thread babysits and reads its work as put aside, so only a thread with nothing running goes.
    expect(host.settled).toEqual(['done'])
  })

  it('leaves a merged thread alone while a thread it delegated to still works, or once work starts while GitHub is asked', async () => {
    const threads = [
      thread('parent', own('feature/parent')),
      thread('child', { mode: 'shared', status: 'ready', path: '/repo', repositoryRoot: '/repo', branch: 'trunk', sentBranch: 'trunk' },
        { delegatedBy: 'parent', subagentSummary: { total: 3, working: 3, completed: 0, failed: 0, interrupted: 0, unknown: 0 } }),
      thread('late', own('feature/late')),
      thread('done', own('feature/done')),
    ]
    const host = settlingHost(threads)
    // Background agents start in one thread while GitHub is asked about its branch.
    const pullRequestMerged = vi.fn(async (_root: string, branch: string) => {
      if (branch === 'feature/late') threads[2]!.backgroundWork = [{ id: randomUUID(), type: 'subagent', label: 'Synthetic agent' }]
      return true
    })
    await new WorktreeCleanup({ host, git: trunkGit, rules: () => DEFAULT_WORKTREE_CLEANUP, autoSettleMerged: () => true, pullRequestMerged }).sweep()
    expect(host.settled).toEqual(['done'])
  })

  const link = (number: number): GitPullRequestLink => ({ number, url: `https://github.com/o/r/pull/${number}`, title: `PR ${number}`, state: 'open', draft: false, source: 'linked', linkedAt: '2026-10-26T00:00:00.000Z' })
  /** Like `trunkGit`, but every branch under `gone/` was deleted after its pull request merged. */
  const goneGit = vi.fn(async (cwd: string, args: string[]) => {
    if (args[0] === 'rev-parse' && args.at(-1)?.startsWith('refs/heads/gone/')) throw new Error('unknown revision')
    if (args[0] === 'rev-parse' && args[1] === '--git-dir') return '.git\n'
    return trunkGit(cwd, args)
  })
  it('settles a thread whose branch was deleted after its pull request merged, or that never recorded one, from its own links', async () => {
    const threads = [
      thread('gone-merged', own('gone/merged'), { pullRequests: [link(1)] }),
      thread('gone-open', own('gone/open'), { pullRequests: [link(2)] }),
      thread('gone-elsewhere', own('gone/elsewhere'), { pullRequests: [link(3)] }),
      thread('gone-unlinked', own('gone/unlinked')),
      // A shared folder that is not a repository, and a worktree never on a branch, as the merge flow can leave them.
      thread('no-repository', { mode: 'shared', status: 'ready', path: '/home' }, { pullRequests: [link(4)] }),
      thread('detached', { mode: 'independent', status: 'ready', path: '/w/detached', repositoryRoot: '/repo' }, { pullRequests: [link(5), { ...link(6), state: 'closed' }] }),
      thread('present', own('feature/present'), { pullRequests: [link(7)] }),
    ]
    const host = settlingHost(threads)
    const answers: Record<number, PullRequestState> = {
      1: { state: 'merged', headRefName: 'gone/merged', headRefOid: 'a1' }, 2: { state: 'open', headRefName: 'gone/open', headRefOid: 'a2' },
      3: { state: 'merged', headRefName: 'feature/other', headRefOid: 'a3' }, 4: { state: 'merged', headRefName: 'any', headRefOid: 'a4' },
      5: { state: 'merged', headRefName: 'any', headRefOid: 'a5' },
    }
    const pullRequestState = vi.fn(async (url: string) => answers[Number(url.split('/').at(-1))]!)
    const pullRequestMerged = vi.fn(async () => false)
    const log: string[] = []
    const cleanup = new WorktreeCleanup({ host, git: goneGit, rules: () => DEFAULT_WORKTREE_CLEANUP, autoSettleMerged: () => true, pullRequestMerged, pullRequestState, log: code => log.push(code) })
    await cleanup.sweep()
    expect(host.settled).toEqual(['gone-merged', 'no-repository', 'detached'])
    expect(host.expected).toEqual([{ expectedMergedBranch: 'gone/merged', expectedMergedTip: null },
      { expectedMergedBranch: null, expectedMergedTip: null }, { expectedMergedBranch: null, expectedMergedTip: null }])
    // A branch still there is asked about as before, at its tip, never through its links; a closed link is not asked.
    expect(pullRequestMerged).toHaveBeenCalledTimes(1)
    expect(pullRequestState.mock.calls.map(call => call[0]).sort()).toEqual([1, 2, 3, 4, 5].map(number => link(number).url))
    // Every answer brings the thread's link up to date, so a merged one stops reading open.
    expect(host.noted.map(read => [read.url.split('/').at(-1), read.state])).toEqual([['1', 'merged'], ['2', 'open'], ['3', 'merged'], ['4', 'merged'], ['5', 'merged']])
    // Each reason once a sweep, by name only.
    expect(log).toEqual(['thread-auto-settle-branch-gone', 'thread-auto-settled', 'thread-auto-settle-pull-request-open', 'thread-auto-settle-branch-differs', 'thread-auto-settled', 'thread-auto-settled'])
    // Merged is final: the next sweep asks again only about the one still open.
    pullRequestState.mockClear()
    await cleanup.sweep()
    expect(pullRequestState.mock.calls.map(call => call[0])).toEqual([link(2).url])
    expect(host.settled).toEqual(['gone-merged', 'no-repository', 'detached'])
  })
  it('leaves a thread whose branch moved while GitHub answered, links or not', async () => {
    let moved = false
    const movingGit = vi.fn(async (cwd: string, args: string[]) => args[0] === 'rev-parse' && args.at(-1) === 'refs/heads/feature/moving^{commit}' ? (moved ? 'later-tip\n' : 'merged-tip\n') : trunkGit(cwd, args))
    const host = settlingHost([thread('moving', own('feature/moving'), { pullRequests: [link(1)] })])
    const pullRequestState = vi.fn(async (): Promise<PullRequestState> => ({ state: 'merged', headRefName: 'feature/moving', headRefOid: 'merged-tip' }))
    await new WorktreeCleanup({ host, git: movingGit, rules: () => DEFAULT_WORKTREE_CLEANUP, autoSettleMerged: () => true,
      pullRequestMerged: async () => { moved = true; return true }, pullRequestState }).sweep()
    expect(host.settled).toEqual([])
    // A branch that is there is current work: its links do not stand in for its tip.
    expect(pullRequestState).not.toHaveBeenCalled()
  })
  it('settles from links only when Git can read the repository and no pull request was linked meanwhile, asking once for a shared one', async () => {
    const unreadableGit = vi.fn(async (_cwd: string, args: string[]) => { if (args[0] === 'symbolic-ref') return 'origin/trunk\n'; if (args.at(-1) === 'refs/heads/trunk') return 'abc\n'; throw new Error('not a git repository') })
    const unreadable = settlingHost([thread('unreadable', own('feature/unreadable'), { pullRequests: [link(1)] })])
    const merged = vi.fn(async (): Promise<PullRequestState> => ({ state: 'merged', headRefName: 'feature/unreadable', headRefOid: 'a' }))
    await new WorktreeCleanup({ host: unreadable, git: unreadableGit, rules: () => DEFAULT_WORKTREE_CLEANUP, autoSettleMerged: () => true, pullRequestMerged: async () => true, pullRequestState: merged }).sweep()
    // A folder Git cannot read is not a deleted branch: nothing is asked or settled.
    expect(unreadable.settled).toEqual([])
    expect(merged).not.toHaveBeenCalled()
    const threads = [thread('late', own('gone/late'), { pullRequests: [link(1)] }), thread('shared-a', own('gone/a'), { pullRequests: [link(2)] }), thread('shared-b', own('gone/b'), { pullRequests: [link(2)] })]
    const host = settlingHost(threads)
    const pullRequestState = vi.fn(async (url: string): Promise<PullRequestState> => {
      // A new pull request is linked to the thread while GitHub answers about its old one.
      if (url === link(1).url) threads[0]!.pullRequests = [link(1), link(8)]
      return url === link(1).url ? { state: 'merged', headRefName: 'gone/late', headRefOid: 'a' } : { state: 'open', headRefName: 'gone/a', headRefOid: 'b' }
    })
    await new WorktreeCleanup({ host, git: goneGit, rules: () => DEFAULT_WORKTREE_CLEANUP, autoSettleMerged: () => true, pullRequestMerged: async () => true, pullRequestState }).sweep()
    expect(host.settled).toEqual([])
    expect(pullRequestState.mock.calls.map(call => call[0])).toEqual([link(1).url, link(2).url])
  })
  it('leaves a thread whose branch is gone while GitHub is limiting the sign-in', async () => {
    const host = settlingHost([thread('gone', own('gone/limited'), { pullRequests: [link(1)] })])
    const log: string[] = []
    await new WorktreeCleanup({ host, git: goneGit, rules: () => DEFAULT_WORKTREE_CLEANUP, autoSettleMerged: () => true, pullRequestMerged: async () => true,
      pullRequestState: async () => { throw new Error('GitHub is limiting requests from this sign-in.') }, log: code => log.push(code) }).sweep()
    expect(host.settled).toEqual([])
    expect(log).toEqual(['thread-auto-settle-branch-gone', 'thread-auto-settle-skipped'])
  })

  it('asks GitHub once per branch when the merged rule wants the same answer, and never without gh', async () => {
    const threads = [thread('merged', own('feature/merged'))]
    const host = settlingHost(threads)
    const pullRequestMerged = vi.fn(async () => true)
    await new WorktreeCleanup({ host, git: trunkGit, rules: () => ({ ...DEFAULT_WORKTREE_CLEANUP, merged: true }), autoSettleMerged: () => true, pullRequestMerged }).sweep()
    expect(pullRequestMerged).toHaveBeenCalledTimes(1)
    expect(host.settled).toEqual(['merged'])
    const without = settlingHost([thread('merged', own('feature/merged'))])
    await new WorktreeCleanup({ host: without, git: trunkGit, rules: () => DEFAULT_WORKTREE_CLEANUP, autoSettleMerged: () => true }).sweep()
    expect(without.settled).toEqual([])
  })
})
