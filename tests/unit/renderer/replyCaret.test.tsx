import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentThread } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadPane } from '../../../src/renderer/src/agents/ThreadPane'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { describeThreads } from '../../../src/renderer/src/agents/threadFacts'
import { liveAgentState } from '../../fixtures/renderer/liveAgentState'
import { threadsStateFixture } from '../../fixtures/agentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))
afterEach(cleanup)

const asked = '2026-09-12T10:00:00.000Z'
const answered = '2026-09-12T10:00:05.000Z'
const turnRecord = (status: AgentActivity['status']): AgentActivity =>
  ({ id: 'claude-turn-t1', turnId: 't1', afterMessageId: 'u1', sequence: 0, kind: 'turn', status, title: 'Turn', startedAt: asked })

/** A running thread's reply, half written, as the pane draws it. */
function caretShown(patch: Partial<AgentThread>): boolean {
  const state = threadsStateFixture()
  state.activeThreadId = 'grok-previews'
  const thread = state.host.threads.find(item => item.id === state.activeThreadId)!
  Object.assign(thread, {
    status: 'running', requests: [], clientConnected: true, activities: [turnRecord('running')],
    messages: [{ id: 'u1', role: 'user', text: 'Look around the repo.', createdAt: asked }, { id: 'a1', role: 'assistant', text: 'I am reading the', createdAt: answered }],
  }, patch)
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  const row = describeThreads(state, E2E_THREADS_NOW).find(item => item.thread.id === thread.id)!
  render(<ThreadPane row={row} state={state} command={live.command} store={new ThreadDraftStore(live.command)} focused promptId="prompt" error={null} />)
  const shown = document.querySelector('[data-message-id="a1"] .rich-message[data-streaming]') !== null
  cleanup()
  return shown
}

describe('the writing caret', () => {
  it('blinks after a reply only while the provider is writing it now', () => {
    expect(caretShown({})).toBe(true)
  })

  it('goes once Sotto lost the provider, while the line reads Last seen working', () => {
    expect(caretShown({ clientConnected: false })).toBe(false)
  })

  it('goes once the turn failed, stopped or lost its outcome, even while the thread still reads as running', () => {
    for (const status of ['unknown', 'failed', 'interrupted'] as const) {
      expect(caretShown({ activities: [turnRecord(status)] })).toBe(false)
    }
  })
})
