import React from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type AgentState, type SubscriptionAccount } from '../../../src/shared/agents'
import type { TerminalWorkspaceBridge } from '../../../src/shared/terminalWorkspace'
import { useAddProject } from '../../../src/renderer/src/agents/addProject'
import { NewTerminalDialog } from '../../../src/renderer/src/terminals/NewTerminalDialog'
import { TerminalWorkspaceStore } from '../../../src/renderer/src/terminals/terminalWorkspaceStore'
import { threadsStateFixture } from './liveAgentState'

const grok = { id: 'native:grok:model:grok-4.6', name: 'Grok 4.6', provider: 'Grok Build', providerId: 'grok' as const, ready: true }
const opus = { id: 'native:claude:model:opus', name: 'Opus', provider: 'Claude Code', providerId: 'claude' as const, ready: true }
const sonnet = { ...opus, id: 'native:claude:model:sonnet', name: 'Sonnet' }
const claudeAccount = (defaultModelId: string): SubscriptionAccount => ({ provider: 'claude', label: 'Claude', installed: true, ready: true, detail: '', models: [], defaultModelId })
function fixture(): AgentState {
  const state = threadsStateFixture()
  state.configuration = { ...state.configuration, provider: 'codex', reasoning: 'claude', reasoningModel: 'opus', defaultModelId: grok.id }
  state.host.models = [grok]
  return state
}
function terminal(state = fixture()) {
  const store = new TerminalWorkspaceStore()
  const open = vi.spyOn(store, 'open').mockResolvedValue({ id: 'opened-terminal' })
  const props = { command: vi.fn(async () => state), store, bridge: {} as TerminalWorkspaceBridge, shell: 'pwsh', onClose: vi.fn(), onCreated: vi.fn(), initialProjectId: state.host.projects[0]!.id }
  const view = render(<NewTerminalDialog {...props} state={state} />)
  return { open, props, update: (next: AgentState) => view.rerender(<NewTerminalDialog {...props} state={next} />) }
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('inherited agent in terminal creation', () => {
  it.each(['missing', 'unavailable'] as const)('retains the native agent and exact CLI model when its thread catalog entry is %s', async status => {
    const state = fixture()
    if (status === 'unavailable') state.host.models.push({ ...opus, ready: false })
    const view = terminal(state)
    expect(screen.getByLabelText('Terminal provider')).toHaveValue('claude')
    expect(screen.getByLabelText('Runs')).toHaveTextContent('claude --model opus')
    fireEvent.change(screen.getByLabelText('Terminal name'), { target: { value: 'Review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    await waitFor(() => expect(view.open).toHaveBeenCalledWith(view.props.bridge, expect.objectContaining({ title: 'Review', launch: { provider: 'claude', modelId: opus.id, reasoning: null, permission: 'ask' } })))
  })

  it('follows a late account default without switching to the first discovered provider', () => {
    const state = fixture()
    state.configuration.reasoningModel = ''
    const view = terminal(state)
    expect(screen.getByLabelText('Terminal provider')).toHaveValue('claude')
    view.update({ ...state, reasoningAccounts: [claudeAccount('opus')] })
    expect(screen.getByLabelText('Runs')).toHaveTextContent('claude --model opus')
    view.update({ ...state, host: { ...state.host, models: [grok, opus, sonnet] }, reasoningAccounts: [claudeAccount('sonnet')] })
    expect(screen.getByLabelText('Runs')).toHaveTextContent('claude --model sonnet')
  })

  it('retains an explicit permission while the account default arrives', async () => {
    const state = fixture()
    state.configuration.reasoningModel = ''
    const view = terminal(state)
    fireEvent.change(screen.getByLabelText('Terminal permissions'), { target: { value: 'edits' } })
    view.update({ ...state, reasoningAccounts: [claudeAccount('opus')] })
    expect(screen.getByLabelText('Terminal permissions')).toHaveValue('edits')
    expect(screen.getByLabelText('Runs')).toHaveTextContent('claude --model opus --permission-mode acceptEdits')
    fireEvent.change(screen.getByLabelText('Terminal name'), { target: { value: 'Review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    await waitFor(() => expect(view.open).toHaveBeenCalledWith(view.props.bridge, expect.objectContaining({ launch: expect.objectContaining({ modelId: opus.id, permission: 'edits' }) })))
  })

  it('retains an explicit reasoning effort while the account default arrives', async () => {
    const state = fixture()
    state.configuration.reasoningModel = ''
    state.host.models = [grok, { ...opus, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }]
    const view = terminal(state)
    fireEvent.change(screen.getByLabelText('Terminal reasoning'), { target: { value: 'high' } })
    view.update({ ...state, host: { ...state.host, models: [...state.host.models, { ...sonnet, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }] }, reasoningAccounts: [claudeAccount('sonnet')] })
    expect(screen.getByLabelText('Terminal reasoning')).toHaveValue('high')
    expect(screen.getByLabelText('Runs')).toHaveTextContent('claude --model sonnet --effort high')
    fireEvent.change(screen.getByLabelText('Terminal name'), { target: { value: 'Review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    await waitFor(() => expect(view.open).toHaveBeenCalledWith(view.props.bridge, expect.objectContaining({ launch: expect.objectContaining({ modelId: sonnet.id, reasoning: 'high' }) })))
  })

  it.each(['inherited', 'explicit'] as const)('resets provider-specific options for an %s provider change', mode => {
    const state = fixture()
    state.configuration.reasoning = 'codex'
    state.configuration.reasoningModel = 'gpt-5'
    state.host.models = [{ id: 'native:codex:model:gpt-5', name: 'GPT-5', provider: 'Codex', providerId: 'codex', ready: true, reasoningEfforts: ['low', 'xhigh'], defaultReasoningEffort: 'low' }, { ...opus, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }]
    const view = terminal(state)
    fireEvent.change(screen.getByLabelText('Terminal reasoning'), { target: { value: 'xhigh' } })
    fireEvent.change(screen.getByLabelText('Terminal permissions'), { target: { value: 'everything' } })
    if (mode === 'inherited') view.update({ ...state, configuration: { ...state.configuration, reasoning: 'claude', reasoningModel: 'opus' } })
    else fireEvent.change(screen.getByLabelText('Terminal provider'), { target: { value: 'claude' } })
    expect(screen.getByLabelText('Terminal provider')).toHaveValue('claude')
    expect(screen.getByLabelText('Terminal reasoning')).toHaveValue('low')
    expect(screen.getByLabelText('Terminal permissions')).toHaveValue('ask')
    expect(screen.getByLabelText('Runs')).toHaveTextContent('claude --model opus --effort low')
    expect(screen.getByLabelText('Runs')).not.toHaveTextContent('xhigh')
    expect(screen.getByLabelText('Runs')).not.toHaveTextContent('skip-permissions')
  })

  it.each(['limited', 'none', 'missing'] as const)('uses the inherited model effort capabilities when metadata is %s', async metadata => {
    const state = fixture()
    state.configuration.reasoningModel = ''
    state.host.models = [grok, { ...opus, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }]
    const view = terminal(state)
    fireEvent.change(screen.getByLabelText('Terminal reasoning'), { target: { value: 'high' } })
    const nextModel = { ...sonnet, ...(metadata === 'limited' ? { reasoningEfforts: ['low'], defaultReasoningEffort: 'low' } : metadata === 'none' ? { reasoningEfforts: [] } : {}) }
    view.update({ ...state, host: { ...state.host, models: [grok, nextModel] }, reasoningAccounts: [claudeAccount('sonnet')] })
    const expectedEffort = metadata === 'limited' ? 'low' : metadata === 'none' ? null : 'high'
    fireEvent.change(screen.getByLabelText('Terminal name'), { target: { value: 'Review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    await waitFor(() => expect(view.open).toHaveBeenCalledWith(view.props.bridge, expect.objectContaining({ launch: expect.objectContaining({ modelId: sonnet.id, reasoning: expectedEffort }) })))
    if (metadata === 'limited') expect(screen.getByLabelText('Terminal reasoning')).toHaveValue('low')
    if (metadata === 'none') expect(screen.getByLabelText('Runs')).not.toHaveTextContent('--effort')
  })

  it.each(['grok', ''] as const)('keeps an explicit terminal provider choice %s through account and catalog changes', provider => {
    const state = fixture()
    const view = terminal(state)
    fireEvent.change(screen.getByLabelText('Terminal provider'), { target: { value: provider } })
    view.update({ ...state, host: { ...state.host, models: [opus] }, reasoningAccounts: [claudeAccount('sonnet')] })
    expect(screen.getByLabelText('Terminal provider')).toHaveValue(provider)
    expect(screen.getByLabelText('Runs')).toHaveTextContent(provider ? 'grok' : 'pwsh')
  })

  it('keeps an explicitly chosen model when catalog or account defaults change', async () => {
    const state = fixture()
    state.host.models = [grok, opus, sonnet]
    const view = terminal(state)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread model' }))
    fireEvent.click(screen.getByRole('option', { name: 'Sonnet' }))
    view.update({ ...state, configuration: { ...state.configuration, reasoningModel: 'opus' }, host: { ...state.host, models: [grok, opus] } })
    expect(screen.getByLabelText('Runs')).toHaveTextContent('claude --model sonnet')
    fireEvent.change(screen.getByLabelText('Terminal name'), { target: { value: 'Review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    await waitFor(() => expect(view.open).toHaveBeenCalledWith(view.props.bridge, expect.objectContaining({ launch: expect.objectContaining({ provider: 'claude', modelId: sonnet.id }) })))
  })
})

describe('inherited agent in folder registration', () => {
  it('registers the selected folder with the native agent even when its selected model is missing', async () => {
    const state = fixture()
    vi.stubGlobal('sotto', { agents: { chooseProjectDirectory: vi.fn(async () => 'C:/new-folder') } })
    const command = vi.fn(async () => state)
    const hook = renderHook(() => useAddProject(state, command))
    await act(async () => { await hook.result.current.add() })
    expect(command).toHaveBeenCalledWith({ type: 'create-project', title: 'new-folder', path: 'C:/new-folder', useExisting: true, provider: 'claude' })
  })

  it('selects an existing folder without moving it to the inherited provider', async () => {
    const state = fixture()
    const project = state.host.projects[0]!
    vi.stubGlobal('sotto', { agents: { chooseProjectDirectory: vi.fn(async () => project.path) } })
    const command = vi.fn(async () => state)
    const hook = renderHook(() => useAddProject(state, command))
    await act(async () => { await hook.result.current.add() })
    expect(command).toHaveBeenCalledExactlyOnceWith({ type: 'select-project', projectId: project.id })
  })
})