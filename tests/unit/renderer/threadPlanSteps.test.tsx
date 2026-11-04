import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentState, AgentThread } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

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

  state.activeThreadId = THREAD
  state.host.connected = true
  Object.assign(state.host.threads.find(item => item.id === THREAD)!, { modelId: 'codex:gpt' }, patch)
  return state
}

function mount(state: AgentState) {
  vi.mocked(useAgents).mockImplementation(liveAgentState(state).useLive)
  render(<ThreadsView now={NOW} />)
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
    fireEvent.click(within(transcript).getByRole('button', { name: 'Working, 1 step so far' }))
    const row = within(transcript).getByRole('button', { name: /^Plan, 1 of 3 done/u })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(row)
    const steps = within(transcript).getByRole('list', { name: 'Plan, 1 of 3 done' })
    expect([...steps.querySelectorAll('li')].map(step => [step.dataset.status, step.textContent])).toEqual([
      ['completed', 'Read the failing testDone'], ['running', 'Fix the adapterIn progress'], ['pending', 'Run the suiteTo do'],
    ])
    // A done step has its tick and the others their rings, so the three never read alike.
    expect(steps.querySelectorAll('.thread-activity__step-done')).toHaveLength(1)
    expect(steps.querySelectorAll('.thread-activity__step-mark')).toHaveLength(2)
  })

  it('counts the plan as one of the newest six, and folds it under Show earlier once six newer rows follow', () => {
    const { transcript } = mount(stateWith({ status: 'running', activities: [
      lifecycle({ status: 'running', startedAt: iso(-5_000) }),
      activity({ id: 'plan', kind: 'plan', title: 'Plan', status: 'running', steps: [{ text: 'Fix the adapter', status: 'running' }] }),
      ...Array.from({ length: 9 }, (_, index) => activity({ id: `c${index}`, command: `step ${index}` })),
    ] }))
    fireEvent.click(within(transcript).getByRole('button', { name: 'Working, 10 steps so far' }))
    const rows = within(transcript).getByTestId('thread-activity-live').querySelector('.thread-activity__rows')!
    // Ten steps, six in view: the plan is first of the four earlier, and nothing stands above the button.
    expect(rows.firstElementChild).toHaveTextContent('Show 4 earlier')
    expect(rows.children).toHaveLength(7)
    expect(within(transcript).queryByRole('button', { name: /^Plan, /u })).toBeNull()
    expect(within(transcript).getByRole('button', { name: /step 8/u })).toBeVisible()
    fireEvent.click(within(transcript).getByRole('button', { name: 'Show 4 earlier' }))
    expect(within(transcript).getByRole('button', { name: /^Plan, /u })).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps the plan in the order it was reported while it is among the newest six', () => {
    const { transcript } = mount(stateWith({ status: 'running', activities: [
      lifecycle({ status: 'running', startedAt: iso(-5_000) }),
      activity({ id: 'c0', command: 'step 0' }),
      activity({ id: 'plan', kind: 'plan', title: 'Plan', status: 'running', steps: [{ text: 'Fix the adapter', status: 'running' }] }),
      activity({ id: 'c1', command: 'step 1' }),
    ] }))
    fireEvent.click(within(transcript).getByRole('button', { name: 'Working, 3 steps so far' }))
    const rows = within(transcript).getByTestId('thread-activity-live').querySelector('.thread-activity__rows')!
    expect([...rows.children].map(row => /Plan/u.test(row.textContent ?? ''))).toEqual([false, true, false])
    expect(within(transcript).queryByRole('button', { name: /earlier/u })).toBeNull()
  })
})
