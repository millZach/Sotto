import { describe, expect, it } from 'vitest'
import { resolveFilesBinding } from '../../../src/main/files/binding'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot } from '../../../src/shared/agents'

const host = (): AgentHostSnapshot => ({ ...EMPTY_AGENT_HOST,
  projects: [{ id: 'project', title: 'Project', path: 'D:/project' }],
  threads: [{ id: 'thread', projectId: 'project', title: 'Thread', modelId: 'model', status: 'idle', messages: [], requests: [] }],
})
describe('Files working-directory binding integration', () => {
  it('uses the existing thread project fallback while keeping Sotto identity', () => {
    expect(resolveFilesBinding(host(), 'thread')).toEqual({ threadId: 'thread', projectId: 'project', workingDirectory: 'D:/project' })
    expect(resolveFilesBinding(host(), 'missing')).toBeNull()
  })
  it('uses native cwd, then recorded worktree path, with no project identity reassignment', () => {
    const state = host(), thread = state.threads[0]!
    thread.worktree = { mode: 'independent', status: 'ready', path: 'D:/worktrees/task' }
    expect(resolveFilesBinding(state, 'thread')).toMatchObject({ projectId: 'project', workingDirectory: 'D:/worktrees/task' })
    thread.workingDirectory = 'D:/native/actual'
    expect(resolveFilesBinding(state, 'thread')).toMatchObject({ projectId: 'project', workingDirectory: 'D:/native/actual' })
  })
  it('does not replace explicit missing cwd or failed/pending setup with the project folder', () => {
    const state = host(), thread = state.threads[0]!
    thread.workingDirectory = 'D:/does-not-exist'
    expect(resolveFilesBinding(state, 'thread')?.workingDirectory).toBe('D:/does-not-exist')
    for (const status of ['pending', 'error'] as const) {
      thread.worktree = { mode: 'independent', status }
      expect(() => resolveFilesBinding(state, 'thread')).toThrow()
    }
  })
})
