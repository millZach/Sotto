// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AgentThread } from '../../../src/shared/agents'
import { countWorkingThreads, WORKING_THREADS_QUIET_MAX, workingThreadsLead, workingThreadsWarning } from '../../../src/shared/workingThreads'

const thread = (id: string, patch: Partial<AgentThread> = {}): AgentThread =>
  ({ id, projectId: 'project', providerId: 'codex', title: id, modelId: 'model', status: 'idle', messages: [], requests: [], ...patch })

describe('working threads (#1183)', () => {
  it('counts this computer’s threads with a turn running, whoever started them', () => {
    expect(countWorkingThreads([thread('user', { status: 'running' }), thread('worker', { status: 'running' }),
      thread('delegated', { status: 'running', delegatedBy: 'user' }), thread('idle')])).toBe(3)
  })
  it('counts a last turn still reported running, as isThreadTurnRunning has it', () => {
    expect(countWorkingThreads([thread('ending', { status: 'idle', lastTurn: { id: 'turn', status: 'running' } })])).toBe(1)
    expect(countWorkingThreads([thread('ended', { status: 'idle', lastTurn: { id: 'turn', status: 'completed' } })])).toBe(0)
  })
  it('does not count Watcher’s own thread, an older Watcher’s or a thread on another computer', () => {
    expect(countWorkingThreads([thread('watcher', { status: 'running', kind: 'watcher' }), thread('earlier', { status: 'running', kind: 'watcher-history' }),
      thread('remote', { status: 'running', remoteHost: true, hostId: '22222222-2222-4222-8222-222222222222' })])).toBe(0)
  })
  it('counts a start whose first prompt is on its way before its status says so, once', () => {
    expect(countWorkingThreads([thread('new')], 'new')).toBe(1)
    expect(countWorkingThreads([thread('new', { status: 'running' })], 'new')).toBe(1)
    expect(countWorkingThreads([thread('other')], 'missing')).toBe(0)
  })
  it('warns above ten and says nothing at ten or fewer, in the same words on every computer', () => {
    expect(WORKING_THREADS_QUIET_MAX).toBe(10)
    expect(workingThreadsWarning(10)).toBeUndefined()
    expect(workingThreadsWarning(0)).toBeUndefined()
    expect(workingThreadsWarning(11)).toBe('11 threads are working. This computer may slow down or use its battery faster.')
    expect(workingThreadsLead(12)).toBe('12 threads are working.')
  })
})
