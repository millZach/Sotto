import { describe, expect, it } from 'vitest'
import { markThreadRunningAfterAnswer } from '../../../src/main/agents/postAnswerRunning'
import type { AgentThread } from '../../../src/shared/agents'

const baseThread = (overrides: Partial<AgentThread> = {}): AgentThread => ({
  id: 'thread-1',
  projectId: 'proj-1',
  title: 'Worker',
  modelId: 'model-1',
  status: 'idle',
  updatedAt: '2026-11-22T00:00:00.000Z',
  messages: [],
  requests: [],
  ...overrides,
})

describe('markThreadRunningAfterAnswer', () => {
  it('transitions an idle thread with cleared requests to running and updates lastTurn status', () => {
    const thread = baseThread({ lastTurn: { id: 'turn-1', status: 'completed' } })
    expect(markThreadRunningAfterAnswer(thread, 'turn-1')).toBe(true)
    expect(thread.status).toBe('running')
    expect(thread.lastTurn).toEqual({ id: 'turn-1', status: 'running' })
  })

  it('preserves existing lastTurn id when no activeTurnId override is given', () => {
    const thread = baseThread({ lastTurn: { id: 'turn-existing', status: 'completed' } })
    expect(markThreadRunningAfterAnswer(thread)).toBe(true)
    expect(thread.status).toBe('running')
    expect(thread.lastTurn).toEqual({ id: 'turn-existing', status: 'running' })
  })

  it('does not mark running when other request cards remain open or already running', () => {
    const stillWaiting = baseThread({
      requests: [{ id: 'req-2', kind: 'question', text: 'Next?', options: [] }],
    })
    expect(markThreadRunningAfterAnswer(stillWaiting)).toBe(false)
    expect(stillWaiting.status).toBe('idle')

    const alreadyRunning = baseThread({ status: 'running' })
    expect(markThreadRunningAfterAnswer(alreadyRunning)).toBe(false)
  })
})
