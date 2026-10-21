// @vitest-environment node
/**
 * The trailing re-read after finished work, for threads that share one folder (ADR-0014): one round for the folder,
 * one inspection and one status read for the round, and never an inspection begun before a Git action for a thread
 * reading after it.
 */
import { describe, expect, it, vi } from 'vitest'
import { ThreadWorktrees } from '../../../src/main/agents/threadWorktrees'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentWorktree } from '../../../src/shared/agents'
import type { GitStatus } from '../../../src/shared/gitStatus'
import { fixture, send } from '../../fixtures/workspaceTestFixture'

const STATUS: GitStatus = { isRepository: true, branch: 'feat/agent', upstream: null, hasRemote: false, defaultBranch: 'main', isDefaultBranch: false, dirty: true, changedFiles: 1, insertions: 1, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: 1, pullRequest: null, fetchedAt: null, readAt: '2026-10-19T00:00:00.000Z' }
const finished = (id: string, sequence: number): AgentActivity => ({ id, turnId: 'turn', sequence, kind: 'command', status: 'completed', title: 'Ran a command' })

async function twoThreadsInOneFolder() {
  const f = await fixture({ worktreeRefreshDelayMs: 20 })
  const snapshot = await f.host.connect()
  const project = snapshot.projects.find(item => item.providerId === 'codex')!
  const model = snapshot.models.find(item => item.providerId === 'codex')!
  const record: AgentWorktree = { mode: 'shared', status: 'ready', path: project.path, repositoryRoot: project.path, branch: 'main', dirty: false }
  vi.spyOn(ThreadWorktrees.prototype, 'discover').mockResolvedValue(record)
  vi.spyOn(ThreadWorktrees.prototype, 'inspect').mockImplementation(async metadata => ({ ...metadata, status: 'ready' }))
  for (const id of ['one', 'two']) {
    await f.host.execute({ type: 'create-thread', commandId: `create-${id}`, threadId: id, projectId: project.id, title: id, modelId: model.id, workingCopy: 'shared' })
    await f.host.execute(send(id))
  }
  const source = { read: vi.fn<(cwd: string, options: { remote: boolean; startedAfter?: number }) => Promise<GitStatus>>(async () => STATUS), invalidate: vi.fn() }
  f.host.setGitStatus(source, { pollIntervalMs: () => 0 })
  const sessions = f.adapters.codex.state.threads.slice(-2)
  const worktree = (id: string) => f.host.workspaceSnapshot().threads.find(thread => thread.id === id)?.worktree
  return { f, project, sessions, source, worktree }
}

describe('a re-read round in a shared folder', () => {
  it('inspects the folder once and reads its status once for every thread of the round', async () => {
    const { f, sessions, source, worktree } = await twoThreadsInOneFolder()
    const folder = vi.spyOn(ThreadWorktrees.prototype, 'inspectSharedFolder').mockImplementation(async () => metadata => ({ ...metadata, branch: 'feat/agent', dirty: true, status: 'ready', error: undefined }))
    source.read.mockClear()
    sessions[0]!.activities = [finished('first', 0)]
    f.adapters.codex.emit()
    sessions[1]!.activities = [finished('second', 0)]
    f.adapters.codex.emit()
    await vi.waitFor(() => { for (const id of ['one', 'two']) expect(worktree(id)).toMatchObject({ branch: 'feat/agent', dirty: true, git: { branch: 'feat/agent' } }) })
    expect(folder).toHaveBeenCalledTimes(1)
    // Both threads asked with the moment the round's timer fired, so the reader may give the second the first's read.
    const moments = source.read.mock.calls.map(([, options]) => options.startedAfter)
    expect(moments).toHaveLength(2)
    expect(moments[0]).toBeTypeOf('number')
    expect(moments[1]).toBe(moments[0])
  })

  it('inspects again for a thread of the round when a Git action ran after the first inspection began', async () => {
    const { f, sessions, worktree } = await twoThreadsInOneFolder()
    let calls = 0
    const folder = vi.spyOn(ThreadWorktrees.prototype, 'inspectSharedFolder').mockImplementation(async () => {
      const branch = ++calls === 1 ? 'before-the-action' : 'after-the-action'
      // A Git action finishes in the folder while the first thread's inspection runs.
      if (calls === 1) void f.host.gitActionFinished('one')
      return metadata => ({ ...metadata, branch, status: 'ready', error: undefined })
    })
    sessions[0]!.activities = [finished('first', 0)]
    sessions[1]!.activities = [finished('second', 0)]
    f.adapters.codex.emit()
    await vi.waitFor(() => expect(folder).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(worktree('two')?.branch).toBe('after-the-action'))
  })
})
