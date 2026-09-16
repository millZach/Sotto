import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentState, AgentThread } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const THREAD = 'grok-previews'
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()
let sequence = 0
const activity = (patch: Partial<AgentActivity> & Pick<AgentActivity, 'id'>): AgentActivity =>
  ({ turnId: 'turn-1', sequence: sequence++, kind: 'command', status: 'completed', title: 'Command', afterMessageId: `${THREAD}-1`, ...patch })
const lifecycle = (patch: Partial<AgentActivity> = {}): AgentActivity => activity({ id: 'lifecycle', kind: 'turn', title: 'Turn', ...patch })

function stateWith(patch: Partial<AgentThread>): AgentState {
  const state = threadsStateFixture()
  state.assignments = []
  state.activeThreadId = THREAD
  state.host.connected = true
  Object.assign(state.host.threads.find(item => item.id === THREAD)!, { modelId: 'codex:gpt' }, patch)
  return state
}

function mount(state: AgentState) {
  vi.mocked(useAgents).mockImplementation(liveAgentState(state).useLive)
  render(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
  return { transcript: screen.getByRole('log', { name: 'Thread transcript' }) }
}

beforeEach(() => { sequence = 0; vi.mocked(useAgents).mockReset() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('a plan a provider reported', () => {
  it('reads as a checklist with its progress, whoever sent it', () => {
    const { transcript } = mount(stateWith({ status: 'running', activities: [
      lifecycle({ status: 'running', startedAt: iso(-5_000) }),
      activity({ id: 'plan', kind: 'plan', title: 'Plan', status: 'running', steps: [
        { text: 'Read the failing test', status: 'completed' },
        { text: 'Fix the adapter', status: 'running' },
        { text: 'Run the suite', status: 'pending' },
      ] }),
    ] }))
    const row = within(transcript).getByRole('button', { name: /^Plan, 1 of 3 done/u })
    fireEvent.click(row)
    const steps = within(transcript).getByRole('list', { name: 'Plan, 1 of 3 done' })
    expect([...steps.querySelectorAll('li')].map(step => [step.dataset.status, step.textContent])).toEqual([
      ['completed', 'Read the failing testDone'], ['running', 'Fix the adapterIn progress'], ['pending', 'Run the suiteTo do'],
    ])
  })
})
