import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { SplitLayoutStore } from '../../../src/renderer/src/agents/splitLayout'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const THREAD = 'grok-previews'

/**
 * A thread on a long-context variant its provider's catalog no longer lists (#344): Claude Code's catalog has
 * `sonnet` and no `sonnet[1m]`, and the thread keeps the ID it was created with.
 */
function mount() {
  const state = threadsStateFixture()
  state.host.models = state.host.models.map(model => model.id === 'claude:sonnet' ? { ...model, supportsImages: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' } : model)
  const thread = state.host.threads.find(item => item.id === THREAD)!
  thread.modelId = 'claude:sonnet[1m]'
  state.activeThreadId = THREAD
  state.host.capabilities = { ...state.host.capabilities, configureThread: true }
  state.queue = []
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(() => live.useLive())
  render(<ThreadsView now={E2E_THREADS_NOW} layoutStore={new SplitLayoutStore()} paneAreaWidth={1200} />)
  return screen.getByRole('region', { name: 'Grok voice previews' })
}

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(cleanup)

describe('a thread on a long-context model the catalog does not list', () => {
  it('takes screenshots and shows its base model by name, with that model’s efforts', () => {
    const pane = mount()
    expect(within(pane).getByRole('button', { name: 'Attach screenshots' })).toBeEnabled()
    expect(within(pane).queryByText(/does not support screenshots/u)).toBeNull()
    const model = within(pane).getByRole('combobox', { name: 'Thread model' })
    expect(model).toHaveTextContent('Sonnet 4.5')
    expect(model).not.toHaveTextContent('[1m]')
    expect(within(pane).getByRole('combobox', { name: 'Thread reasoning' })).toHaveTextContent('High')
  })
})
