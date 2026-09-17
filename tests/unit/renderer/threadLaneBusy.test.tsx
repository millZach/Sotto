import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { SplitLayoutStore } from '../../../src/renderer/src/agents/splitLayout'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const BUSY = { id: 'grok-previews', title: 'Grok voice previews' }
const IDLE = { id: 'wav-stall', title: 'Streaming WAV stall' }

/** Two unmanaged, unsettled threads of the same project, so both panes carry their own composer and actions. */
function laneState(): AgentState {
  const state = threadsStateFixture()
  state.assignments = []
  state.queue = []
  state.activeThreadId = BUSY.id
  return state
}

/** The window with both threads open beside each other, and whatever lane marks the test wants published. */
function mountBothPanes(state: AgentState = laneState()) {
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  // A fresh arrangement per test: the shared one outlives the page, and would already hold both panes.
  render(<ThreadsView onOpenAgents={vi.fn()} now={NOW} layoutStore={new SplitLayoutStore()} paneAreaWidth={1600} paneAreaHeight={900} />)
  fireEvent.click(screen.getByRole('button', { name: `Open ${IDLE.title} beside` }))
  const pane = (title: string): HTMLElement => screen.getByRole('region', { name: title })
  return { live, pane, busyPane: () => pane(BUSY.title), idlePane: () => pane(IDLE.title) }
}

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(cleanup)

describe('a busy thread beside an idle one in the same window', () => {
  it('locks only the busy thread’s pane and leaves the other pane’s controls live', () => {
    const { live, busyPane, idlePane } = mountBothPanes()
    // Both panes start live: nothing is running in either lane.
    expect(within(busyPane()).getByRole('button', { name: 'Settle' })).toBeEnabled()
    expect(within(idlePane()).getByRole('button', { name: 'Settle' })).toBeEnabled()

    act(() => { live.publish({ busyThreadIds: [BUSY.id] }) })

    expect(within(busyPane()).getByRole('button', { name: 'Settle' })).toBeDisabled()
    const idle = within(idlePane())
    expect(idle.getByRole('button', { name: 'Settle' })).toBeEnabled()
    const prompt = idle.getByRole('textbox', { name: 'Prompt', exact: true })
    expect(prompt).toBeEnabled()
    fireEvent.change(prompt, { target: { value: 'Keep working here' } })
    expect(idle.getByRole('button', { name: 'Send prompt' })).toBeEnabled()
  })

  it('leaves each thread’s row in the sidebar to its own lane', () => {
    const { live } = mountBothPanes()
    act(() => { live.publish({ busyThreadIds: [BUSY.id] }) })
    expect(screen.getByRole('button', { name: `Settle ${BUSY.title}` })).toBeDisabled()
    expect(screen.getByRole('button', { name: `Settle ${IDLE.title}` })).toBeEnabled()
  })

  it('still shows the global lane where provider and project work is shown, and only there', () => {
    const { live, busyPane, idlePane } = mountBothPanes()
    act(() => { live.publish({ globalLaneBusy: true }) })
    // Settling a whole project moves every thread of it at once, so it waits on the global lane.
    expect(screen.getByRole('button', { name: 'Settle project workshop' })).toBeDisabled()
    // Management moves assignment authority and the single composer draft: also global-lane work.
    expect(within(busyPane()).getByRole('button', { name: 'Manage' })).toBeDisabled()
    // A thread's own actions are untouched by the global lane.
    expect(within(idlePane()).getByRole('button', { name: 'Settle' })).toBeEnabled()
    expect(screen.getByRole('button', { name: `Settle ${IDLE.title}` })).toBeEnabled()
  })
})
