import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultAgentConfiguration, type AgentState } from '../../../src/shared/agents'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { AgentComposer, AgentLatestResponse, AgentQueue, AgentView } from '../../../src/renderer/src/agents/AgentView'
import { AgentWidget } from '../../../src/renderer/src/agents/AgentWidget'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

function stateFixture(): AgentState {
  return {
    configuration: { ...defaultAgentConfiguration(), defaultModelId: 'model', projectsDirectory: 'D:\\Projects' },
    connection: 'connected',
    host: {
      connected: true, name: 'T3 Code', version: 'test',
      capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true },
      models: [{ id: 'model', name: 'Available model', provider: 'provider', ready: true }],
      projects: [{ id: 'project', title: 'Workshop', path: 'D:\\Workshop' }, { id: 'docs', title: 'Documentation', path: 'D:\\Docs' }],
      threads: [
        { id: 'thread', projectId: 'project', title: 'Build game', modelId: 'model', status: 'idle', messages: [], requests: [] },
        { id: 'unassigned', projectId: 'project', title: 'Review assets', modelId: 'model', status: 'running', messages: [], requests: [] },
        { id: 'guide', projectId: 'docs', title: 'Write guide', modelId: 'model', status: 'idle', messages: [], requests: [] },
      ],
    },
    assignments: [{ threadId: 'thread', mode: 'managed', instruction: '', followups: 0, paused: false, seenMessageIds: [], ownMessageIds: [], handledRequestIds: [], lastFailure: '', contextUpdatedAt: 0, startedAt: '', origin: 'unknown', stopReason: 'none', stoppedAt: '' }],
    queue: [], activeThreadId: 'thread', activeProjectId: 'project',
    draft: '', draftThreadId: null, draftRequestId: null, composing: false,
    pendingRequest: '', busy: false, notice: '', error: null,
    speech: { id: 0, text: '' }, voice: { status: 'wake', error: null, action: 'none', revision: 0 },
    credentials: { t3: true, reasoning: false, grokSpeech: false, secure: true },
    reasoningAccounts: [],
    membership: { status: 'beta', label: 'Development beta', expiresAt: null },
  }
}

function connection(state: AgentState, command = vi.fn(async () => state)): ReturnType<typeof useAgents> {
  return { state, command, error: null, voice: { status: 'wake' }, muteVoice: vi.fn(), stopSpeech: vi.fn(), retryVoice: vi.fn() }
}

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(cleanup)

describe('AgentView user workflows', () => {
  it('lets an obsolete saved reasoning effort be cleared when the model stops advertising effort levels', async () => {
    const state = stateFixture()
    state.configuration.reasoning = 'claude'
    state.configuration.reasoningModel = 'available'
    state.configuration.reasoningEffort = 'high'
    state.reasoningAccounts = [{ provider: 'claude', label: 'Claude', installed: true, ready: true, detail: 'Connected', models: [{ id: 'available', name: 'Available model' }] }]
    const command = vi.fn(async () => state)
    vi.mocked(useAgents).mockReturnValue(connection(state, command))
    render(<AgentView />)
    fireEvent.click(screen.getByRole('button', { name: 'Connection settings' }))
    expect(screen.getByLabelText('Reasoning effort')).toBeEnabled()
    fireEvent.change(screen.getByLabelText('Reasoning effort'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection settings' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure', patch: expect.objectContaining({ reasoningEffort: '' }) }))
  })

  it('does not invent a provider default from the first catalog entry', () => {
    const state = stateFixture()
    state.configuration.reasoning = 'codex'
    state.reasoningAccounts = [{ provider: 'codex', label: 'ChatGPT', installed: true, ready: true, detail: 'Connected',
      models: [{ id: 'first', name: 'First model', reasoningEfforts: ['high'] }] }]
    vi.mocked(useAgents).mockReturnValue(connection(state))
    render(<AgentView />)
    fireEvent.click(screen.getByRole('button', { name: 'Connection settings' }))
    expect(screen.queryByRole('option', { name: 'Default (First model)' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Reasoning effort')).toBeDisabled()
    expect(screen.queryByRole('option', { name: 'High' })).not.toBeInTheDocument()
  })

  it('lets a subscription choose every advertised model and its supported reasoning effort', async () => {
    const state = stateFixture()
    state.configuration.reasoning = 'codex'
    state.reasoningAccounts = [{ provider: 'codex', label: 'ChatGPT', installed: true, ready: true, detail: 'Connected',
      defaultModelId: 'gpt-6-astra', models: [
        { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'low' },
        { id: 'gpt-6-astra', name: 'GPT-6 Astra', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoningEffort: 'medium' },
      ] }]
    const command = vi.fn(async () => state)
    vi.mocked(useAgents).mockReturnValue(connection(state, command))
    render(<AgentView />)
    fireEvent.click(screen.getByRole('button', { name: 'Connection settings' }))
    expect(screen.getByRole('option', { name: 'Default (GPT-6 Astra)' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Reasoning model'), { target: { value: 'gpt-6-astra' } })
    fireEvent.change(screen.getByLabelText('Reasoning effort'), { target: { value: 'ultra' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection settings' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure', patch: expect.objectContaining({
      reasoning: 'codex', reasoningModel: 'gpt-6-astra', reasoningEffort: 'ultra',
    }) }))
    fireEvent.change(screen.getByLabelText('Reasoning model'), { target: { value: 'gpt-5.6-luna' } })
    expect(screen.getByLabelText('Reasoning effort')).toHaveValue('')
    expect(screen.queryByRole('option', { name: 'Ultra' })).not.toBeInTheDocument()
  })

  it('retains a failed project form, then closes and clears it after confirmed creation', async () => {
    const state = stateFixture()
    const command = vi.fn().mockResolvedValueOnce({ ...state, error: 'Folder is unavailable' }).mockResolvedValue(state)
    vi.mocked(useAgents).mockReturnValue(connection(state, command))
    render(<AgentView />)
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'New workspace' } })
    fireEvent.change(screen.getByLabelText('Project folder'), { target: { value: 'D:\\New workspace' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    expect(screen.getByLabelText('Project name')).toHaveValue('New workspace')
    expect(screen.getByLabelText('Project folder')).toHaveValue('D:\\New workspace')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create project' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    await waitFor(() => expect(screen.queryByLabelText('Project name')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    expect(screen.getByLabelText('Project name')).toHaveValue('')
    expect(screen.getByLabelText('Project folder')).toHaveValue('')
  })

  it('opens a thread beside the project selection and resets the form only after success', async () => {
    const state = stateFixture()
    const command = vi.fn().mockResolvedValueOnce({ ...state, error: 'Could not open thread' }).mockResolvedValue(state)
    vi.mocked(useAgents).mockReturnValue(connection(state, command))
    render(<AgentView />)
    const summary = screen.getByText('Open a new thread in Workshop')
    fireEvent.click(summary)
    fireEvent.change(screen.getByLabelText('Thread name'), { target: { value: 'Gameplay' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open thread' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    expect(screen.getByLabelText('Thread name')).toHaveValue('Gameplay')
    expect(summary.closest('details')).toHaveAttribute('open')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open thread' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Open thread' }))
    await waitFor(() => expect(summary.closest('details')).not.toHaveAttribute('open'))
    fireEvent.click(summary)
    expect(screen.getByLabelText('Thread name')).toHaveValue('')
    expect(command).toHaveBeenLastCalledWith({ type: 'create-thread', projectId: 'project', title: 'Gameplay', modelId: 'model' })
  })

  it('finds threads by thread or project name without changing the selected thread', () => {
    const state = stateFixture()
    const command = vi.fn(async () => state)
    vi.mocked(useAgents).mockReturnValue(connection(state, command))
    render(<AgentView />)
    const search = screen.getByRole('searchbox', { name: 'Search projects and threads' })
    fireEvent.change(search, { target: { value: 'guide' } })
    expect(screen.getByRole('button', { name: 'Select Write guide' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Select Build game' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Build game' })).toBeInTheDocument()
    expect(command).not.toHaveBeenCalled()
    fireEvent.change(search, { target: { value: 'Workshop' } })
    expect(screen.getByRole('button', { name: 'Select Build game' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select Review assets' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Select Write guide' })).not.toBeInTheDocument()
  })

  it('requires assignment before showing a composer or a stop action for a running thread', () => {
    const state = { ...stateFixture(), activeThreadId: 'unassigned' }
    const command = vi.fn(async () => state)
    vi.mocked(useAgents).mockReturnValue(connection(state, command))
    render(<AgentView />)
    expect(screen.queryByLabelText('Prompt')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop agent' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Manage this thread' }))
    expect(command).toHaveBeenCalledWith({ type: 'assign', threadId: 'unassigned' })
  })

  it('keeps an existing draft visibly pinned when another unassigned thread is selected', () => {
    const state = { ...stateFixture(), activeThreadId: 'unassigned', draftThreadId: 'thread', composing: true, draft: 'Keep this target' }
    const command = vi.fn(async () => state)
    vi.mocked(useAgents).mockReturnValue(connection(state, command))
    render(<AgentView />)
    expect(screen.getByLabelText('Prompt')).toHaveValue('Keep this target')
    expect(screen.getByText('This draft stays with Build game.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Return to draft thread' }))
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: 'thread' })
  })

  it('explains missing reasoning and directs setup without enabling an account', () => {
    const state = stateFixture()
    const command = vi.fn(async () => state)
    vi.mocked(useAgents).mockReturnValue(connection(state, command))
    render(<AgentView />)
    expect(screen.getByText(/Creating projects and threads by voice and automatic follow-ups need/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Set up reasoning' }))
    expect(screen.getByLabelText('Sotto reasoning')).toHaveFocus()
    expect(screen.getByRole('option', { name: 'Not configured' })).toBeInTheDocument()
    expect(command).not.toHaveBeenCalled()
  })

  it('offers an existing subscription for Sotto reasoning', () => {
    const state = stateFixture()
    vi.mocked(useAgents).mockReturnValue(connection(state))
    render(<AgentView />)
    fireEvent.click(screen.getByRole('button', { name: 'Connection settings' }))
    expect(screen.getByRole('option', { name: 'ChatGPT subscription · Codex' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Claude subscription · Claude Code' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Grok subscription · Grok Build' })).toBeInTheDocument()
  })

  it('does not present a saved or unsaved API key as belonging to a different provider', () => {
    const state = stateFixture()
    state.configuration.reasoning = 'openrouter'
    state.credentials.reasoning = true
    vi.mocked(useAgents).mockReturnValue(connection(state))
    render(<AgentView />)
    fireEvent.click(screen.getByRole('button', { name: 'Connection settings' }))
    expect(screen.getByLabelText('Reasoning API key')).toHaveAttribute('placeholder', expect.stringContaining('Saved securely'))
    fireEvent.change(screen.getByLabelText('Reasoning API key'), { target: { value: 'unsaved-openrouter-key' } })
    fireEvent.change(screen.getByLabelText('Sotto reasoning'), { target: { value: 'openai' } })
    expect(screen.getByLabelText('Reasoning API key')).toHaveValue('')
    expect(screen.getByLabelText('Reasoning API key')).toHaveAttribute('placeholder', 'Your provider API key')
  })

  it('checks and saves a subscription without asking for an API key or retaining another provider model', async () => {
    const state = stateFixture()
    state.configuration.reasoning = 'openrouter'
    state.configuration.reasoningModel = 'old-provider-model'
    state.reasoningAccounts = [{ provider: 'claude', label: 'Claude Max', installed: true, ready: true,
      detail: 'Uses the subscription signed into Claude Code.', models: [{ id: 'sonnet', name: 'Sonnet' }] }]
    const command = vi.fn(async () => state)
    vi.mocked(useAgents).mockReturnValue(connection(state, command))
    render(<AgentView />)
    fireEvent.click(screen.getByRole('button', { name: 'Connection settings' }))
    fireEvent.change(screen.getByLabelText('Reasoning API key'), { target: { value: 'unsaved-api-key' } })
    fireEvent.change(screen.getByLabelText('Sotto reasoning'), { target: { value: 'claude' } })
    await waitFor(() => expect(screen.getByText('Claude Max connected')).toBeInTheDocument())
    expect(command).toHaveBeenCalledWith({ type: 'check-reasoning', provider: 'claude' })
    expect(screen.queryByLabelText('Reasoning API key')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Reasoning model')).toHaveValue('')
    fireEvent.change(screen.getByLabelText('Reasoning model'), { target: { value: 'sonnet' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection settings' }))
    await waitFor(() => expect(screen.getByText('Settings saved')).toBeInTheDocument())
    expect(command).toHaveBeenLastCalledWith({ type: 'configure', patch: expect.objectContaining({ reasoning: 'claude', reasoningModel: 'sonnet' }) })
    expect(command).toHaveBeenCalledTimes(2)
  })

  it('recognizes a ready subscription without an API key and retains setup for an unavailable account', () => {
    const state = stateFixture()
    state.configuration.reasoning = 'codex'
    state.reasoningAccounts = [{ provider: 'codex', label: 'ChatGPT', installed: true, ready: true, detail: 'Connected', models: [] }]
    vi.mocked(useAgents).mockReturnValue(connection(state))
    const view = render(<AgentView />)
    expect(screen.queryByLabelText('Reasoning setup')).not.toBeInTheDocument()
    state.reasoningAccounts[0]!.ready = false
    view.rerender(<AgentView />)
    expect(screen.getByLabelText('Reasoning setup')).toBeInTheDocument()
  })

  it('allows unrelated settings to be saved when the existing subscription is unavailable', async () => {
    const state = stateFixture()
    state.configuration.reasoning = 'claude'
    state.reasoningAccounts = [{ provider: 'claude', label: 'Claude', installed: true, ready: false, detail: 'Sign in again.', models: [] }]
    const command = vi.fn(async () => state)
    vi.mocked(useAgents).mockReturnValue(connection(state, command))
    render(<AgentView />)
    fireEvent.click(screen.getByRole('button', { name: 'Connection settings' }))
    fireEvent.change(screen.getByLabelText('Default projects directory'), { target: { value: 'D:\\New projects' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection settings' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure', patch: expect.objectContaining({ reasoning: 'claude', projectsDirectory: 'D:\\New projects' }) }))
  })
})

describe('Agent prompt and response controls', () => {
  it.each([false, true])('bounds a long completion preview with the full update available on demand (compact=%s)', compact => {
    const state = stateFixture()
    const text = `${'Completed an implementation step.\n'.repeat(200)}Final verification details.`
    state.queue = [{ id: 'ready', threadId: 'thread', kind: 'ready', text, createdAt: '1', deferred: false }]
    const command = vi.fn(async () => state)
    const { container } = render(<><AgentQueue state={state} command={command} compact={compact} /><AgentComposer state={state} command={command} compact={compact} /></>)
    const preview = container.querySelector('.agent-queue__question > p')!
    expect(preview.textContent!.length).toBeLessThanOrEqual(compact ? 201 : 321)
    expect(preview.textContent).not.toContain('\n')
    expect(preview.textContent).not.toContain('Final verification details.')
    expect(screen.getByLabelText('Prompt')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Read full update' }))
    expect(preview.textContent).toBe(text)
    expect(preview).toHaveClass('agent-queue__update-full')
    fireEvent.click(screen.getByRole('button', { name: 'Show less update' }))
    expect(preview.textContent!.length).toBeLessThanOrEqual(compact ? 201 : 321)
  })

  it.each(['question', 'permission'] as const)('retains the full %s detail without a completion preview', kind => {
    const state = stateFixture()
    const text = `${'Review this decision carefully.\n'.repeat(100)}Required final condition.`
    state.queue = [{ id: 'request', threadId: 'thread', kind, text, requestId: 'request', createdAt: '1', deferred: false }]
    state.host.threads[0]!.requests = [{ id: 'request', kind, text, options: [] }]
    const { container } = render(<AgentQueue state={state} command={vi.fn(async () => state)} compact />)
    expect(container.querySelector('.agent-queue__question > p')?.textContent).toBe(text)
    expect(screen.queryByRole('button', { name: 'Read full update' })).not.toBeInTheDocument()
    if (kind === 'permission') expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('lets the user exit an empty composing session', () => {
    const state = { ...stateFixture(), composing: true }
    const command = vi.fn(async () => state)
    render(<AgentComposer state={state} command={command} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(command).toHaveBeenCalledWith({ type: 'cancel-draft' })
  })

  it('shows only the latest assistant response with an optional full text view', () => {
    const thread = stateFixture().host.threads[0]!
    const answer = `${'A useful result. '.repeat(60)}Final details.`
    thread.messages = [
      { id: 'old', role: 'assistant', text: 'Earlier answer', createdAt: '1' },
      { id: 'user', role: 'user', text: 'Private user prompt', createdAt: '2' },
      { id: 'last', role: 'assistant', text: answer, createdAt: '3' },
    ]
    render(<AgentLatestResponse thread={thread} />)
    expect(screen.queryByText('Earlier answer')).not.toBeInTheDocument()
    expect(screen.queryByText('Private user prompt')).not.toBeInTheDocument()
    expect(screen.queryByText(/Final details/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Read full response' }))
    expect(screen.getByText(/Final details/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.queryByText(/Final details/)).not.toBeInTheDocument()
  })
})

describe('AgentWidget attention behavior', () => {
  it('stays compact for main-window typing and respects collapse during an ongoing voice draft', () => {
    let state = stateFixture()
    const command = vi.fn(async () => state)
    const props = { command, visibilityGeneration: 0, dragCancellationVersion: 0 }
    const { rerender } = render(<AgentWidget state={state} {...props} />)
    state = { ...state, composing: true, draftThreadId: 'thread', draft: 'Typed in main window' }
    rerender(<AgentWidget state={state} {...props} />)
    expect(screen.getByRole('button', { name: 'Expand agent controls' })).toBeInTheDocument()
    state = { ...state, voice: { ...state.voice, status: 'listening' } }
    rerender(<AgentWidget state={state} {...props} />)
    expect(screen.getByRole('button', { name: 'Expand agent controls' })).toBeInTheDocument()
    state = { ...state, composing: false, draftThreadId: null, draft: '' }
    rerender(<AgentWidget state={state} {...props} />)
    state = { ...state, composing: true, draftThreadId: 'thread', draft: 'Spoken prompt' }
    rerender(<AgentWidget state={state} {...props} />)
    expect(screen.getByLabelText('Prompt')).toHaveValue('Spoken prompt')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse agent controls' }))
    state = { ...state, voice: { ...state.voice, status: 'speaking' } }
    rerender(<AgentWidget state={state} {...props} />)
    state = { ...state, voice: { ...state.voice, status: 'listening' } }
    rerender(<AgentWidget state={state} {...props} />)
    expect(screen.getByRole('button', { name: 'Expand agent controls' })).toBeInTheDocument()
  })

  it('still brings a newly ready thread to attention', () => {
    const state = stateFixture()
    const command = vi.fn(async () => state)
    const props = { command, visibilityGeneration: 0, dragCancellationVersion: 0 }
    const { rerender } = render(<AgentWidget state={state} {...props} />)
    const next: AgentState = { ...state, queue: [{ id: 'ready', threadId: 'thread', kind: 'ready', text: 'Build complete', createdAt: '1', deferred: false }] }
    rerender(<AgentWidget state={next} {...props} />)
    expect(screen.getByRole('button', { name: 'Collapse agent controls' })).toBeInTheDocument()
    expect(screen.getByText('Build complete')).toBeInTheDocument()
  })
})
