// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWorktreeGit as git, ThreadWorktrees } from '../../../src/main/agents/threadWorktrees'
import { WorktreeCleanup } from '../../../src/main/agents/worktreeCleanup'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread, type AgentWorktree } from '../../../src/shared/agents'
import { DEFAULT_WORKTREE_CLEANUP, type WorktreeCleanupRules } from '../../../src/shared/settings'

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
  await git(project, ['init', '-b', 'main'])
  await writeFile(join(project, 'tracked.txt'), 'baseline'); await writeFile(join(project, '.gitignore'), 'node_modules/\n')
  await git(project, ['add', '.']); await commit(project, 'Baseline')
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
    const [old, recent, running] = [await r.checkout(), await r.checkout(), await r.checkout()]
    const now = Date.parse('2026-09-22T12:00:00.000Z')
    const host = fakeHost([
      thread('old', old, { updatedAt: '2026-08-01T00:00:00.000Z' }),
      thread('recent', recent, { updatedAt: '2026-09-20T00:00:00.000Z' }),
      thread('running', running, { status: 'running', updatedAt: '2026-08-01T00:00:00.000Z' }),
    ], r.worktrees)
    await new WorktreeCleanup({ host, rules: () => ({ ...DEFAULT_WORKTREE_CLEANUP, afterDays: 30 }), now: () => now }).sweep()
    expect(host.reclaimed).toEqual(['old'])
    expect((await git(r.project, ['worktree', 'list', '--porcelain'])).match(/worktree /gu)).toHaveLength(3)
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
})
