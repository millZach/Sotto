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
  it('transitions an idle thread with cleared requests to running only when given a live turn id not already terminal', () => {
    const thread = baseThread({ lastTurn: { id: 'turn-prev', status: 'completed' } })
    expect(markThreadRunningAfterAnswer(thread, 'turn-next')).toBe(true)
    expect(thread.status).toBe('running')
    expect(thread.lastTurn).toEqual({ id: 'turn-next', status: 'running' })
  })

  it('refuses to mark running when no activeTurnId is live, the turn already ended, or status is error', () => {
    const idleWithEndedTurn = baseThread({ lastTurn: { id: 'turn-1', status: 'completed' } })
    expect(markThreadRunningAfterAnswer(idleWithEndedTurn, undefined)).toBe(false)
    expect(idleWithEndedTurn.status).toBe('idle')
    expect(idleWithEndedTurn.lastTurn).toEqual({ id: 'turn-1', status: 'completed' })

    expect(markThreadRunningAfterAnswer(idleWithEndedTurn, 'turn-1')).toBe(false)
    expect(idleWithEndedTurn.status).toBe('idle')

    const interrupted = baseThread({ lastTurn: { id: 'turn-2', status: 'interrupted' } })
    expect(markThreadRunningAfterAnswer(interrupted, 'turn-2')).toBe(false)
    expect(interrupted.status).toBe('idle')

    const errored = baseThread({ status: 'error', lastTurn: { id: 'turn-3', status: 'failed' } })
    expect(markThreadRunningAfterAnswer(errored, 'turn-new')).toBe(false)
    expect(errored.status).toBe('error')
  })

  it('does not mark running when other request cards remain open or already running', () => {
    const stillWaiting = baseThread({
      requests: [{ id: 'req-2', kind: 'question', text: 'Next?', options: [] }],
    })
    expect(markThreadRunningAfterAnswer(stillWaiting, 'turn-live')).toBe(false)
    expect(stillWaiting.status).toBe('idle')

    const alreadyRunning = baseThread({ status: 'running' })
    expect(markThreadRunningAfterAnswer(alreadyRunning, 'turn-live')).toBe(false)
  })
})
