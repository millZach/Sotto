import React from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, PROVIDER_LABELS, providerIdSchema, type AgentBridge, type AgentState } from '../../../src/shared/agents'
import { useAgentConnection, useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ProvidersSettings } from '../../../src/renderer/src/agents/ProvidersSettings'
import { ThreadOptions } from '../../../src/renderer/src/agents/ThreadOptions'
import { AgentSetupFields } from '../../../src/renderer/src/agents/AgentAccountSettings'

vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn() }))
const caps = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
function fixture(): AgentState {
  return {
    configuration: { ...defaultAgentConfiguration(), enabledProviders: ['codex', 'claude', 'grok'], reasoning: 'claude', reasoningModel: 'coordinator-model' }, connection: 'connected',
    host: { connected: true, name: 'Providers', version: '', capabilities: caps, projects: [],
      providers: providerIdSchema.options.map(id => ({ id, name: PROVIDER_LABELS[id], version: '1.2.3', connection: 'connected', capabilities: caps })),
      models: providerIdSchema.options.map(id => ({ id: `${id}:same-native-model`, name: `${id} model`, provider: PROVIDER_LABELS[id], providerId: id, ready: true })),
      threads: [{ id: 'thread', providerId: 'codex', projectId: 'project', title: 'Codex work', modelId: 'codex:same-native-model', status: 'idle', messages: [], requests: [] }],
    }, assignments: [], queue: [], activeThreadId: 'thread', activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null, composing: false,
    pendingRequest: '', busy: false, notice: '', error: null, speech: { id: 0, text: '' }, voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: true }, reasoningAccounts: [], membership: { status: 'beta', label: 'Test', expiresAt: null },
  }
}
function provide(state = fixture()) {
  const command = vi.fn(async () => state)
  vi.mocked(useOptionalAgents).mockReturnValue({ state, command, error: null, voice: { status: 'off' }, muteVoice: vi.fn(), stopSpeech: vi.fn(), retryVoice: vi.fn(), attention: { items: [], show: false, dismiss: vi.fn(), reopen: vi.fn(), next: vi.fn(async () => undefined) } })
  return { state, command }
}
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('independent provider settings', () => {
  it('shows three enabled connections and disconnects only the selected provider', async () => {
    const { state, command } = provide()
    render(<ProvidersSettings />)
    for (const label of Object.values(PROVIDER_LABELS)) expect(screen.getByRole('switch', { name: `Enable ${label}` })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Grok Build', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Grok Build' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'disconnect', provider: 'grok' }))
    expect(state.configuration.reasoning).toBe('claude')
    expect(command).toHaveBeenCalledTimes(1)
  })
  it('shows a provider-specific failure and retries it while others stay connected', async () => {
    const state = fixture()
    state.host.providers![1] = { ...state.host.providers![1]!, connection: 'error', error: 'Sign in to Claude Code.' }
    const { command } = provide(state)
    render(<ProvidersSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code', exact: true }))
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in to Claude Code.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry Claude Code' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'connect', provider: 'claude' }))
    expect(state.host.providers![0]!.connection).toBe('connected')
  })
  it('shows only the selected provider catalog and keeps coordinator choices in Agents settings', () => {
    provide()
    const view = render(<ProvidersSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code', exact: true }))
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    const panel = screen.getByRole('tabpanel')
    expect(within(panel).getByText('claude model')).toBeVisible()
    expect(within(panel).queryByText('codex model')).toBeNull()
    expect(screen.queryByLabelText('Reasoning account')).toBeNull()
    view.unmount()
    render(<AgentSetupFields />)
    expect(screen.getByLabelText('Reasoning account')).toHaveValue('claude')
    expect(screen.queryByLabelText('Thread provider')).toBeNull()
  })
  it('keeps existing thread model choices in its provider and disables them when that provider is offline', () => {
    const state = fixture()
    const command = vi.fn(async () => state)
    const view = render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread model' }))
    expect(screen.getByRole('option', { name: 'codex model' })).toBeVisible()
    expect(screen.queryByRole('option', { name: 'claude model' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close model picker' }))
    state.host.providers![0]!.connection = 'disconnected'
    view.rerender(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    expect(screen.getByRole('combobox', { name: 'Thread model' })).toBeDisabled()
  })
  it.each([undefined, 'grok'] as const)('does not queue a healthy send behind provider connection %s in the renderer', async provider => {
    const state = fixture()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const bridge: AgentBridge = { get: async () => state, onState: () => () => undefined,
      command: vi.fn(async command => { if (command.type === 'connect') await gate; return state }) }
    const { result } = renderHook(() => useAgentConnection(bridge))
    await waitFor(() => expect(result.current.state).not.toBeNull())
    let connecting!: Promise<AgentState | null>
    let sending!: Promise<AgentState | null>
    try {
      act(() => { connecting = result.current.command({ type: 'connect', ...(provider ? { provider } : {}) }) })
      act(() => { sending = result.current.command({ type: 'manual-send', threadId: 'thread', text: 'Hello', draftId: '00000000-0000-4000-8000-000000000001' }) })
      await waitFor(() => expect(bridge.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'manual-send' })))
    } finally { await act(async () => { release(); await connecting; await sending }) }
  })
})
