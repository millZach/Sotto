import { threadsStateFixture } from '../../fixtures/agentState'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, type AgentState } from '../../../src/shared/agents'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { AgentSetupFields } from '../../../src/renderer/src/agents/AgentAccountSettings'
import { agentContextFixture } from '../../fixtures/agentContext'

vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn() }))

const caps = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }

function fixture(configuration: Partial<AgentState['configuration']> = {}): AgentState {
  return threadsStateFixture({ cloneOverrides: false,
    configuration: { ...defaultAgentConfiguration(), ...configuration },
    host: {
      connected: true, name: 'Agents', version: '', capabilities: caps, projects: [],
      models: [
        { id: 'claude:sonnet', name: 'Claude Sonnet', provider: 'Claude', providerId: 'claude', ready: true, reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium', runtimeModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] },
        { id: 'grok:test', name: 'Grok Test', provider: 'Grok', providerId: 'grok', ready: true, reasoningEfforts: ['low', 'high'], runtimeModes: ['approval-required', 'auto', 'full-access'] },
      ],
      threads: [],
    },
    topLevel: { assignments: [], queue: [], activeThreadId: null, activeProjectId: null } })
}
function provide(state: AgentState) {
  const command = vi.fn(async (): Promise<AgentState> => state)
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, command))
  return { state, command }
}
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('New threads start with (issue #347)', () => {
  it('shows the configured default model and saves a chosen one to Settings', async () => {
    const { command } = provide(fixture({ newThreadModelId: 'claude:sonnet' }))
    render(<AgentSetupFields />)
    expect(screen.getByRole('heading', { name: 'New threads' })).toBeInTheDocument()
    const chip = screen.getByRole('combobox', { name: 'Thread model' })
    expect(chip).toHaveTextContent('Claude Sonnet')
    fireEvent.click(chip)
    fireEvent.click(screen.getByRole('tab', { name: 'Grok' }))
    fireEvent.click(screen.getByRole('option', { name: 'Grok Test' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure', patch: { newThreadModelId: 'grok:test' } }))
  })

  it('saves a chosen default reasoning effort', async () => {
    const { command } = provide(fixture({ newThreadModelId: 'claude:sonnet' }))
    render(<AgentSetupFields />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    const slider = screen.getByRole('slider', { name: 'Thread reasoning effort' })
    fireEvent.keyDown(slider, { key: 'End' })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure', patch: { newThreadReasoningEffort: 'high' } }))
  })

  it('saves a chosen default permission from Sotto’s four modes', async () => {
    const { command } = provide(fixture({ newThreadModelId: 'claude:sonnet' }))
    render(<AgentSetupFields />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Default permissions for new threads' }))
    fireEvent.click(screen.getByRole('option', { name: 'Full access' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure', patch: { newThreadRuntimeMode: 'full-access' } }))
  })

  it('goes back to Provider default once a permission is chosen, instead of being stuck on it', async () => {
    const { command } = provide(fixture({ newThreadModelId: 'claude:sonnet', newThreadRuntimeMode: 'full-access' }))
    render(<AgentSetupFields />)
    const chip = screen.getByRole('combobox', { name: 'Default permissions for new threads' })
    expect(chip).toHaveTextContent('Full access')
    fireEvent.click(chip)
    fireEvent.click(screen.getByRole('option', { name: 'Provider default' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure', patch: { newThreadRuntimeMode: undefined } }))
  })

  it('notes the nearest fit when the chosen model’s provider lacks the chosen permission', () => {
    provide(fixture({ newThreadModelId: 'grok:test', newThreadRuntimeMode: 'auto-accept-edits' }))
    render(<AgentSetupFields />)
    expect(screen.getByText('Grok Build has no "Allow edits", so its threads start on "Ask for approval".')).toBeInTheDocument()
  })

  it('notes that a provider with its own permission profiles starts on its first', () => {
    const devinModel = { id: 'devin:swe', name: 'SWE-1.6', provider: 'Devin', providerId: 'devin' as const, ready: true,
      providerModes: [{ id: 'ask-first', name: 'Ask first' }, { id: 'bypass', name: 'Bypass Permissions', asks: 'Sotto asks about nothing.' }] }
    const state = fixture({ newThreadModelId: devinModel.id, newThreadRuntimeMode: 'full-access' })
    state.host.models = [...state.host.models, devinModel]
    provide(state)
    render(<AgentSetupFields />)
    expect(screen.getByText('Devin uses its own permission profiles; a new thread starts on its first.')).toBeInTheDocument()
  })
})
