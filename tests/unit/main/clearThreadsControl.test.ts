// @vitest-environment node
/**
 * The coordinator's side of clearing settled threads (ADR-0140): the Owl gate, what it keeps back, the plain words of its
 * answers and notices, the automatic rule, and what of a deleted thread it lets go.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import type { AgentHost } from '../../../src/main/agents/host'
import { clearsOnItsOwn } from '../../../src/main/agents/runtime'
import { WorktreeCleanup } from '../../../src/main/agents/worktreeCleanup'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { EMPTY_AGENT_HOST, type AgentCommand, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'
import { DEFAULT_SETTINGS, DEFAULT_WORKTREE_CLEANUP, parseSettings } from '../../../src/shared/settings'
import type { ThreadClearKeptReason } from '../../../src/shared/threadClear'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { testCredentials } from '../../fixtures/testCredentials'

const roots: string[] = []
const controls = new Set<AgentControl>()
afterEach(async () => {
  for (const control of controls) control.dispose()
  controls.clear()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-clear-threads-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})

const LONG_AGO = '2026-01-01T00:00:00.000Z'
type DeleteOptions = Parameters<NonNullable<AgentHost['deleteThreads']>>[1]

/** The fixture host with the workspace's settle and delete: a deleted thread leaves its list, the way the workspace's does. */
class ClearingHost extends E2EAgentHost {
  readonly deleted: string[][] = []
  readonly asked: DeleteOptions[] = []
  /** A reason the workspace's own checks keep a thread for, by thread. */
  folderHold = new Map<string, ThreadClearKeptReason>()
  private get snapshotState(): AgentHostSnapshot { return (this as unknown as { state: AgentHostSnapshot }).state }
  private publishState(): void { (this as unknown as { emit(): void }).emit() }
  /** A thread of the fixture's project, settled long ago unless `extra` says otherwise. */
  add(id: string, extra: Partial<AgentThread> = {}): void {
    this.snapshotState.threads.push({ id, title: id, projectId: 'project', modelId: 'claude:test', status: 'idle', messages: [], requests: [],
      workspaceSettledAt: LONG_AGO, updatedAt: LONG_AGO, ...extra })
  }
  settle(id: string, at = LONG_AGO): void {
    const thread = this.snapshotState.threads.find(item => item.id === id)!
    thread.workspaceSettledAt = at; thread.updatedAt = at
  }
  async setWorkspaceSettled(_kind: 'project' | 'thread', id: string, settled: boolean): Promise<AgentHostSnapshot> {
    this.snapshotState.threads.find(item => item.id === id)!.workspaceSettledAt = settled ? LONG_AGO : null
    return this.snapshot()
  }
  async previewThreadDeletion(threadId: string) { return { kept: this.folderHold.get(threadId) ?? null, worktree: null } }
  async deleteThreads(threadIds: readonly string[], options: DeleteOptions) {
    this.asked.push(options)
    const kept: { threadId: string; reason: ThreadClearKeptReason }[] = []
    const deleted: string[] = []
    for (const id of threadIds) {
      const reason = options.hold(id) ?? this.folderHold.get(id) ?? null
      if (reason) kept.push({ threadId: id, reason }); else deleted.push(id)
    }
    this.deleted.push(deleted)
    this.snapshotState.threads = this.snapshotState.threads.filter(thread => !deleted.includes(thread.id))
    this.publishState()
    return { deleted, kept }
  }
}

async function start(options: { enabled?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-clear-threads-')); roots.push(directory)
  const host = new ClearingHost()
  const credentials = await testCredentials(directory, { mode: 'unavailable' })
  const logged: string[] = []
  const control = createAgentControl({ directory, host, credentials, reasoner: e2eAgentReasoner,
    ...options.enabled === false ? {} : { clearThreadsEnabled: true }, logClear: (event, detail) => { logged.push(`${event} ${detail}`) } })
  controls.add(control)
  await control.start()
  if (!control.get().host.connected) await control.command({ type: 'connect' })
  return { host, control, logged }
}

describe('clearing settled threads in the coordinator (ADR-0140)', () => {
  it('refuses every clearing command and runs no rule while the Owl feature is off', async () => {
    const { host, control } = await start({ enabled: false })
    host.settle('workshop')
    for (const command of [{ type: 'preview-delete-thread', threadId: 'workshop' }, { type: 'delete-thread', threadId: 'workshop' },
      { type: 'preview-clear-threads', olderThanDays: 0 }, { type: 'clear-threads', olderThanDays: 0, threadIds: ['workshop'] }] satisfies AgentCommand[]) {
      expect((await control.commandShell(command)).error, command.type).toBe('Deleting threads is not available in this version of Sotto. Nothing was deleted.')
    }
    await control.clearSettledThreads(30)
    expect(host.deleted).toEqual([])
  })

  it('lists what Clear now would take and keep, and clears only what still qualifies', async () => {
    const { host, control, logged } = await start()
    host.settle('workshop'); host.settle('docs')
    host.folderHold.set('docs', 'uncommitted')
    await control.command({ type: 'refresh' })
    const preview = (await control.commandShell({ type: 'preview-clear-threads', olderThanDays: 30 })).threadClearPreview!
    expect(preview.go.map(item => [item.threadId, item.title, item.removesWorktree])).toEqual([['workshop', 'Workshop', false]])
    expect(preview.kept).toEqual([{ threadId: 'docs', title: 'Docs', projectTitle: expect.any(String), reason: 'uncommitted' }])

    const result = await control.commandShell({ type: 'clear-threads', olderThanDays: 30, threadIds: ['workshop', 'docs'] })
    expect(result.threadClearResult).toEqual({ cleared: 1, kept: [{ threadId: 'docs', title: 'Docs', projectTitle: expect.any(String), reason: 'uncommitted' }] })
    expect(result.notice).toBe('Cleared 1 thread.')
    expect(control.shell().host.threads.map(thread => thread.id)).toEqual(['docs'])
    // Clear now never answers a folder's own questions for the user.
    expect(host.asked.at(-1)?.automatic).toBe(true)
    // The log names the event and a number or a reason's code, never a title.
    expect(logged).toEqual(['threads-cleared 1', 'thread-clear-kept uncommitted'])
  })

  it('keeps a thread that is not settled, or that has something queued, and says why in plain words', async () => {
    const { host, control } = await start()
    const refused = await control.commandShell({ type: 'delete-thread', threadId: 'workshop' })
    expect(refused.error).toBe('“Workshop” was not deleted: not settled. Nothing was deleted.')
    expect((await control.commandShell({ type: 'preview-delete-thread', threadId: 'workshop' })).threadDeletePreview).toEqual({ threadId: 'workshop', kept: 'not-settled', worktree: null })
    host.settle('workshop')
    await control.command({ type: 'refresh' })
    expect((await control.commandShell({ type: 'preview-delete-thread', threadId: 'workshop' })).threadDeletePreview).toEqual({ threadId: 'workshop', kept: null, worktree: null })
    const deleted = await control.commandShell({ type: 'delete-thread', threadId: 'workshop' })
    expect(deleted.error).toBeNull()
    expect(deleted.notice).toBe('Deleted “Workshop”.')
    expect(deleted.host.threads.some(thread => thread.id === 'workshop')).toBe(false)
    // Delete thread… on its own may take the ticked folder items; it is never the automatic question.
    expect(host.asked.at(-1)?.automatic).toBe(false)
  })

  it('lets go of a deleted thread’s draft and tells its listeners', async () => {
    const { host, control } = await start()
    host.settle('workshop')
    await control.command({ type: 'refresh' })
    await control.command({ type: 'save-thread-draft', threadId: 'workshop', draftId: '11111111-1111-4111-8111-111111111111', text: 'Half a thought' })
    expect(control.shell().threadDrafts?.some(draft => draft.threadId === 'workshop')).toBe(true)
    const told = vi.fn()
    control.onThreadsDeleted(told)
    await control.commandShell({ type: 'delete-thread', threadId: 'workshop' })
    expect(control.shell().threadDrafts?.some(draft => draft.threadId === 'workshop')).toBe(false)
    expect(told).toHaveBeenCalledWith(['workshop'])
  })

  it('clears on its own only past the chosen age', async () => {
    const { host, control, logged } = await start()
    host.settle('workshop', LONG_AGO)
    host.settle('docs', new Date().toISOString())
    await control.command({ type: 'refresh' })
    await control.clearSettledThreads(30)
    expect(host.deleted).toEqual([['workshop']])
    // The rule says nothing on screen.
    expect(control.shell().notice).not.toBe('Cleared 1 thread.')
    expect(logged).toEqual(['threads-cleared 1'])
  })

  it('logs nothing from an hourly run that only kept threads back', async () => {
    const { host, control, logged } = await start()
    host.settle('workshop', LONG_AGO)
    host.folderHold.set('workshop', 'uncommitted')
    await control.command({ type: 'refresh' })
    await control.clearSettledThreads(30)
    await control.clearSettledThreads(30)
    expect(host.deleted.flat()).toEqual([])
    expect(logged).toEqual([])
  })
})

describe('the automatic rule beside the worktree sweep (ADR-0140 decision 2)', () => {
  const host = { workspaceSnapshot: (): AgentHostSnapshot => ({ ...EMPTY_AGENT_HOST, threads: [] }), reclaimThreadWorktree: async () => undefined, subscribe: () => () => undefined }
  it('takes 30 days on an upgrade with no saved value, and its first sweep clears only what nothing keeps back', async () => {
    // An Owl user who never chose has no saved value; Never stays a choice they can save.
    expect(DEFAULT_SETTINGS.clearSettledThreadsAfterDays).toBe(30)
    const afterDays = parseSettings({ onboardingComplete: true }).clearSettledThreadsAfterDays
    expect(afterDays).toBe(30)
    expect(parseSettings({ clearSettledThreadsAfterDays: null }).clearSettledThreadsAfterDays).toBeNull()

    const { host: threads, control, logged } = await start()
    const open = { url: 'https://github.com/o/r/pull/1', number: 1, state: 'open' } as NonNullable<AgentThread['pullRequests']>[number]
    const recent = new Date(Date.now() - 29 * 86_400_000).toISOString()
    threads.add('old')
    threads.add('recent', { workspaceSettledAt: recent, updatedAt: recent })
    threads.add('recently-active', { updatedAt: recent })
    threads.add('unsettled', { workspaceSettledAt: null })
    threads.add('working', { status: 'running' })
    threads.add('waiting', { requests: [{ id: 'r', kind: 'question', text: 'Which?', options: [] }] })
    threads.add('pull-request', { pullRequests: [open] })
    threads.add('babysat', { babysitting: [{ url: open.url, number: 1, startedBy: 'user', startedAt: LONG_AGO }] as AgentThread['babysitting'] })
    threads.add('delegator')
    threads.add('delegated', { delegatedBy: 'delegator', status: 'running', workspaceSettledAt: null })
    threads.add('watched')
    threads.add('uncommitted'); threads.folderHold.set('uncommitted', 'uncommitted')
    threads.add('ignored-files'); threads.folderHold.set('ignored-files', 'worktree-files')
    threads.add('in-use'); threads.folderHold.set('in-use', 'worktree-in-use')
    threads.add('watcher', { kind: 'watcher' })
    // What Sotto last read says no pull request is open; GitHub, asked as the run goes, says one is.
    const worktree = (root: string, branch: string): AgentThread['worktree'] => ({ mode: 'independent', status: 'ready', repositoryRoot: root, branch, sentBranch: branch })
    threads.add('opened-since', { worktree: worktree('/repo', 'feat/opened-since') })
    threads.add('closed-on-github', { worktree: worktree('/repo', 'feat/closed') })
    // A repository GitHub could not be asked about keeps every thread with a branch in it.
    threads.add('unasked', { worktree: worktree('/offline', 'feat/unasked') })
    await control.command({ type: 'refresh' })
    // Watcher's hooks as far as clearing reads them: the threads it watches.
    control.useWatcher({ userCommand: () => undefined, beforeDispatch: command => command, observe: () => undefined, guardOperation: () => undefined,
      preserveUserQueue: () => false, watchedThreadIds: () => ['watched'] })

    const asked: string[] = []
    const openPullRequestBranches = async (root: string): Promise<ReadonlySet<string>> => {
      asked.push(root)
      if (root === '/offline') throw new Error('gh is not signed in')
      return new Set(['feat/opened-since'])
    }
    const sweep = new WorktreeCleanup({ host, rules: () => DEFAULT_WORKTREE_CLEANUP, intervalMs: 60_000_000, openPullRequestBranches,
      clearSettledThreads: { afterDays: () => afterDays, clear: (days, keep) => control.clearSettledThreads(days, keep) } })
    await sweep.sweep()
    expect(threads.deleted.flat().sort()).toEqual(['closed-on-github', 'old'])
    // GitHub is asked once for each repository in a run, and only about threads nothing else keeps back.
    expect(asked.sort()).toEqual(['/offline', '/repo'])
    expect(control.shell().host.threads.map(thread => thread.id)).not.toContain('old')
    for (const id of ['recent', 'recently-active', 'unsettled', 'working', 'waiting', 'pull-request', 'babysat', 'delegator', 'delegated', 'watched', 'uncommitted', 'ignored-files', 'in-use', 'watcher', 'opened-since', 'unasked']) {
      expect(control.shell().host.threads.map(thread => thread.id), id).toContain(id)
    }
    // The hour after keeps the same threads back and logs nothing more.
    await sweep.sweep()
    expect(threads.deleted.flat().sort()).toEqual(['closed-on-github', 'old'])
    expect(logged).toEqual(['threads-cleared 2'])
  })
  it('clears nothing while the setting is Never, and the chosen age once it is set', async () => {
    let days: number | null = null
    const clear = vi.fn(async () => undefined)
    const sweep = new WorktreeCleanup({ host, rules: () => DEFAULT_WORKTREE_CLEANUP, clearSettledThreads: { afterDays: () => days, clear }, intervalMs: 60_000_000 })
    await sweep.sweep()
    expect(clear).not.toHaveBeenCalled()
    days = 90
    await sweep.sweep()
    expect(clear).toHaveBeenCalledWith(90, undefined)
  })
  it('looks again when the setting changes, and only then', async () => {
    let days: number | null = null
    const clear = vi.fn(async () => undefined)
    const sweep = new WorktreeCleanup({ host, rules: () => DEFAULT_WORKTREE_CLEANUP, clearSettledThreads: { afterDays: () => days, clear }, intervalMs: 60_000_000 })
    sweep.start()
    await sweep.request()
    expect(clear).not.toHaveBeenCalled()
    days = 30
    sweep.settingsChanged()
    await sweep.request()
    expect(clear).toHaveBeenCalledWith(30, undefined)
    const calls = clear.mock.calls.length
    sweep.settingsChanged()
    expect(clear.mock.calls.length).toBe(calls)
    await sweep.close()
  })
  it('runs no rule on a headless host, which has no Settings to choose it in, whatever its own file holds', () => {
    expect(clearsOnItsOwn({ clearThreadsEnabled: true })).toBe(true)
    expect(clearsOnItsOwn({ clearThreadsEnabled: true, runsAs: 'headless-host' })).toBe(false)
    expect(clearsOnItsOwn({ clearThreadsEnabled: false })).toBe(false)
    expect(clearsOnItsOwn({})).toBe(false)
  })
  it('runs no rule without the Owl feature: the runtime gives the sweep none', async () => {
    const sweep = new WorktreeCleanup({ host, rules: () => DEFAULT_WORKTREE_CLEANUP })
    await expect(sweep.sweep()).resolves.toBeUndefined()
  })
})
