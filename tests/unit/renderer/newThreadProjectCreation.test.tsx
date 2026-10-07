import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewThreadDialog, type ThreadCreationStart } from '../../../src/renderer/src/agents/NewThreadDialog'
import { defaultAgentConfiguration, type AgentCommand, type AgentState } from '../../../src/shared/agents'

const path = 'C:/Users/zache/Documents/Codex'
const actual = { id: 'actual-project', title: 'Codex', path: 'C:\\Users\\zache\\Documents\\Codex' }
const unrelated = { id: 'other-project', title: 'Other', path: 'C:/Other' }
function fixture(projects: AgentState['host']['projects'] = [unrelated], activeProjectId: string | null = unrelated.id): AgentState {
  return {
    configuration: defaultAgentConfiguration(), connection: 'connected',
    host: { connected: true, name: 'Codex', version: 'test',
      capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true },
      projects, threads: [], models: [{ id: 'codex:model', name: 'Model', provider: 'Codex', providerId: 'codex', ready: true, reasoningEfforts: ['low', 'high'], runtimeModes: ['approval-required', 'full-access'] }] },
    activeProjectId, activeThreadId: null, assignments: [], queue: [], draft: '', draftThreadId: null, draftRequestId: null, composing: false,
    pendingRequest: '', globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' },
    voice: { status: 'off', error: null, action: 'none', revision: 0 }, credentials: { reasoning: false, grokSpeech: false, secure: true },
    reasoningAccounts: [],
  }
}
function setup(command: (command: AgentCommand) => Promise<AgentState | null>, state = fixture()) {
  vi.stubGlobal('sotto', { agents: { chooseProjectDirectory: vi.fn(async () => path) } })
  const onCreated = vi.fn()
  const props = { state, command, onCreated, onClose: vi.fn() }
  const view = render(<NewThreadDialog {...props} />)
  return { ...view, onCreated, update: (next: AgentState) => view.rerender(<NewThreadDialog {...props} state={next} />) }
}
/** Choose a folder with the Local folder source's File Explorer button, the only step left before the thread opens on its own (issue #347). */
async function browse() {
  fireEvent.click(screen.getByRole('button', { name: /Local folder/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'Browse with File Explorer' }))
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('native folder project resolution', () => {
  it('ignores repeated project choices while creation is waiting', async () => {
    let release!: (state: AgentState) => void
    const state = fixture([actual, unrelated])
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(() => new Promise(resolve => { release = resolve }))
    const view = setup(command, state)
    const choice = screen.getByRole('button', { name: /^CodexC:/ })
    const other = screen.getByRole('button', { name: /^OtherC:/ })
    act(() => { fireEvent.click(choice); fireEvent.click(choice); fireEvent.click(other) })
    const search = screen.getByRole('searchbox', { name: 'Search projects' })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(command).toHaveBeenCalled())
    expect(command.mock.calls.filter(([request]) => request.type === 'create-thread')).toHaveLength(1)
    release(state)
    await waitFor(() => expect(view.onCreated).toHaveBeenCalledOnce())
  })

  it('allows another choice after a refused creation', async () => {
    const state = fixture([actual])
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => ({ ...state, error: 'Creation refused.' }))
    const view = setup(command, state)
    fireEvent.click(screen.getByRole('button', { name: /^CodexC:/ }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: /^CodexC:/ }))
    await waitFor(() => expect(command.mock.calls.filter(([request]) => request.type === 'create-thread')).toHaveLength(2))
    expect(view.onCreated).not.toHaveBeenCalled()
  })

  it.each(['requested-id', unrelated.id])('uses the returned folder project when activeProjectId is %s', async activeId => {
    const acknowledged = fixture([unrelated, actual], activeId)
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => acknowledged)
    const view = setup(command)
    await browse()
    await waitFor(() => expect(view.onCreated).toHaveBeenCalledOnce())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'create-thread', projectId: actual.id, title: 'New thread', modelId: 'codex:model', managed: false, workingCopy: 'shared', titleSource: 'default' }))
  })

  it('uses the Agents model even when an older saved thread default and model order prefer Grok', async () => {
    const state = fixture([actual])
    state.configuration = { ...state.configuration, reasoning: 'claude', reasoningModel: 'opus[1m]', defaultModelId: 'native:grok:model:grok-4.6' }
    // Grok comes first in the saved model order, as in an installed profile.
    state.host.models = [{ id: 'native:grok:model:grok-4.6', name: 'Grok 4.6', provider: 'Grok', providerId: 'grok', ready: true },
      { id: 'native:claude:model:default', name: 'Default', provider: 'Claude', providerId: 'claude', ready: true },
      { id: 'native:claude:model:opus%5B1m%5D', name: 'Opus', provider: 'Claude', providerId: 'claude', ready: true }]
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => state)
    setup(command, state)
    await browse()
    await waitFor(() => expect(command).toHaveBeenCalled())
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'create-thread', modelId: 'native:claude:model:opus%5B1m%5D' }))
  })

  it('follows the Agents account default at the moment the thread opens', async () => {
    const state = fixture([actual])
    state.configuration = { ...state.configuration, reasoning: 'claude', reasoningModel: '' }
    state.host.models = [
      { id: 'native:claude:model:sonnet', name: 'Sonnet', provider: 'Claude', providerId: 'claude', ready: true },
      { id: 'native:claude:model:opus', name: 'Opus', provider: 'Claude', providerId: 'claude', ready: true },
    ]
    const account = { provider: 'claude' as const, label: 'Claude', installed: true, ready: true, detail: '', models: [{ id: 'sonnet', name: 'Sonnet' }, { id: 'opus', name: 'Opus' }], defaultModelId: 'opus' }
    state.reasoningAccounts = [account]
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => state)
    setup(command, state)
    await browse()
    await waitFor(() => expect(command).toHaveBeenCalled())
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'create-thread', modelId: 'native:claude:model:opus' }))
  })
  it('creates on a long-context Agents model the catalog lists only by its base model', async () => {
    // Claude Code 2.1.283 lists `opus` and no `opus[1m]`; Settings still names the variant (#344).
    const state = fixture([actual])
    state.configuration = { ...state.configuration, reasoning: 'claude', reasoningModel: 'opus[1m]' }
    state.host.models = [
      { id: 'native:claude:model:opus', name: 'Opus 5.5', provider: 'Claude', providerId: 'claude', ready: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high' },
      { id: 'native:claude:model:sonnet', name: 'Sonnet 4.6', provider: 'Claude', providerId: 'claude', ready: true },
    ]
    state.reasoningAccounts = [{ provider: 'claude', label: 'Claude', installed: true, ready: true, detail: '', models: [{ id: 'opus', name: 'Opus 5.5' }, { id: 'sonnet', name: 'Sonnet 4.6' }] }]
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => state)
    setup(command, state)
    await browse()
    await waitFor(() => expect(command).toHaveBeenCalled())
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'create-thread', modelId: 'native:claude:model:opus%5B1m%5D' }))
  })
  it('reuses an existing Windows path without creating a duplicate project', async () => {
    const state = fixture([{ ...actual, path: actual.path.toUpperCase() + '\\' }])
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => state)
    setup(command, state)
    await browse()
    await waitFor(() => expect(command.mock.calls.map(([request]) => request.type)).toEqual(['create-thread']))
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ projectId: actual.id }))
  })

  it('refreshes a delayed acknowledgement without submitting project creation again on retry', async () => {
    const pending = fixture([unrelated], 'requested-id')
    const snapshot = pending
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => snapshot)
    const view = setup(command)
    await browse()
    await waitFor(() => expect(command.mock.calls.map(([request]) => request.type)).toEqual(['create-project', 'refresh']))
    expect(view.onCreated).not.toHaveBeenCalled()
    // A missing acknowledgement is not permission to submit again: choosing the same source only checks.
    await browse()
    await waitFor(() => expect(command.mock.calls.filter(([request]) => request.type === 'create-project')).toHaveLength(1))
    expect(command.mock.calls.filter(([request]) => request.type === 'create-thread')).toHaveLength(0)
  })

  it('continues the original submission when refresh delivers the project', async () => {
    const command = vi.fn(async (request: AgentCommand) => request.type === 'create-project' ? fixture([], 'requested-id') : fixture([actual]))
    const view = setup(command)
    await browse()
    await waitFor(() => expect(command.mock.calls.map(([request]) => request.type)).toEqual(['create-project', 'refresh', 'create-thread']))
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: actual.id, title: 'New thread' }))
    await waitFor(() => expect(view.onCreated).toHaveBeenCalledOnce())
  })

  it('retains the project and says why when the controller rejects thread creation', async () => {
    let rejectThread = true
    const command = vi.fn(async (request: AgentCommand) => ({ ...fixture([actual]), error: request.type === 'create-thread' && rejectThread ? 'Send or clear your draft before creating another thread.' : null }))
    const view = setup(command)
    await browse()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Send or clear your draft'))
    expect(view.onCreated).not.toHaveBeenCalled()
    rejectThread = false
    // The chooser is still open after a refusal, so nothing is lost: choosing the same source retries.
    await browse()
    await waitFor(() => expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: actual.id, title: 'New thread' })))
    await waitFor(() => expect(view.onCreated).toHaveBeenCalledOnce())
  })
})

describe('a client-minted thread id', () => {
  function startCreation(command: (request: AgentCommand) => Promise<AgentState>) {
    vi.stubGlobal('sotto', { agents: { chooseProjectDirectory: vi.fn(async () => path) } })
    const onCreating = vi.fn<(start: ThreadCreationStart) => void>()
    const onCreated = vi.fn()
    render(<NewThreadDialog state={fixture([actual])} command={command} onCreated={onCreated} onClose={vi.fn()} onCreating={onCreating} />)
    return { onCreating, onCreated, start: () => onCreating.mock.calls[0]![0] }
  }

  it('hands the creation over the moment it is issued, with the record the window can show', async () => {
    let settle: () => void = () => undefined
    const command = vi.fn(() => new Promise<AgentState>(resolve => { settle = () => resolve(fixture([actual])) }))
    const view = startCreation(command)
    await browse()
    await waitFor(() => expect(view.onCreating).toHaveBeenCalledOnce())
    expect(view.onCreated).not.toHaveBeenCalled()
    const start = view.start()
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'create-thread', projectId: actual.id, title: 'New thread', threadId: start.thread.id }))
    expect(start.thread).toMatchObject({ id: expect.any(String), projectId: actual.id, title: 'New thread', modelId: 'codex:model',
      status: 'idle', messages: [], requests: [], nativeSessionStarted: false, historyStatus: 'ready', worktree: { mode: 'shared', status: 'pending' } })
    settle()
    await expect(start.created).resolves.toBeNull()
  })

  it('reports a refusal on the same creation instead of throwing it away', async () => {
    const command = vi.fn(async () => ({ ...fixture([actual]), error: 'That model or account is unavailable.' }))
    const view = startCreation(command)
    await browse()
    await waitFor(() => expect(view.onCreating).toHaveBeenCalledOnce())
    await expect(view.start().created).resolves.toBe('That model or account is unavailable.')
    expect(view.onCreated).not.toHaveBeenCalled()
  })
})

describe('working copy default', () => {
  it('uses the project folder by default and sends it with the creation', async () => {
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => fixture([actual]))
    const view = setup(command, fixture([actual]))
    await browse()
    await waitFor(() => expect(view.onCreated).toHaveBeenCalledOnce())
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'create-thread', workingCopy: 'shared' }))
  })

  it('honors a project override ahead of the global default and sends the worktree with its origin start', async () => {
    const state = fixture([actual])
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => state)
    vi.stubGlobal('sotto', {
      agents: { chooseProjectDirectory: vi.fn(async () => path) },
      getSettings: vi.fn(async () => ({ threadWorkingCopyDefault: 'shared', projectThreadWorkingCopyDefaults: { [actual.id]: 'independent' } })),
    })
    const onCreated = vi.fn()
    render(<NewThreadDialog state={state} command={command} onClose={vi.fn()} onCreated={onCreated} />)
    await browse()
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'create-thread', workingCopy: 'independent', startFromOrigin: true }))
    expect(command.mock.calls[0]![0]).not.toHaveProperty('baseBranch')
  })

  it('refuses to create in an unread working copy default rather than guessing shared', async () => {
    const state = fixture([actual])
    const command = vi.fn(async () => state)
    const onCreated = vi.fn()
    vi.stubGlobal('sotto', { agents: { chooseProjectDirectory: vi.fn(async () => path) }, getSettings: vi.fn().mockRejectedValue(new Error('read failed')) })
    render(<NewThreadDialog state={state} command={command} onClose={vi.fn()} onCreated={onCreated} />)
    await browse()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not read your working-copy default'))
    expect(onCreated).not.toHaveBeenCalled()
    expect(command).not.toHaveBeenCalled()
  })

  it('locks the chooser while creation is in flight', async () => {
    let finish: (state: AgentState) => void = () => undefined
    const command = vi.fn(() => new Promise<AgentState>(resolve => { finish = resolve }))
    setup(command, fixture([actual]))
    await browse()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Opening the thread…'))
    expect(screen.getByRole('button', { name: 'Close new thread dialog' })).toBeDisabled()
    finish(fixture([actual]))
    await waitFor(() => expect(command).toHaveBeenCalledOnce())
  })
})

// The Agents room's managed flow keeps its name, model, reasoning and permission form, unchanged from before
// issue #347: only the Threads page's own flow (above) opens a thread at once on Settings defaults.
describe('the managed flow’s own form', () => {
  function setupManaged(command: (command: AgentCommand) => Promise<AgentState | null>, state = fixture([actual])) {
    vi.stubGlobal('sotto', { agents: { chooseProjectDirectory: vi.fn(async () => path) } })
    const onCreated = vi.fn()
    const view = render(<NewThreadDialog state={state} command={command} onCreated={onCreated} onClose={vi.fn()} managed />)
    return { ...view, onCreated }
  }

  it('keeps the form after choosing a project, instead of opening the thread at once', async () => {
    const state = fixture([actual])
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => state)
    setupManaged(command, state)
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }))
    expect(await screen.findByRole('textbox', { name: 'Thread name' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create thread' })).toBeInTheDocument()
    expect(command).not.toHaveBeenCalled()
  })

  it('submits the typed name and chosen options, and sends managed: true', async () => {
    const state = fixture([actual])
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => state)
    const view = setupManaged(command, state)
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Thread name' }), { target: { value: 'Spike the flake' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create thread' }))
    await waitFor(() => expect(view.onCreated).toHaveBeenCalledOnce())
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'create-thread', projectId: actual.id, title: 'Spike the flake', titleSource: 'user', modelId: 'codex:model', managed: true }))
  })

  it('starts managed threads on the saved new-thread model too', async () => {
    const state = fixture([actual])
    state.host.models.push({ id: 'codex:other', name: 'Other model', provider: 'Codex', providerId: 'codex', ready: true })
    state.configuration.newThreadModelId = 'codex:other'
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => state)
    const view = setupManaged(command, state)
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }))
    await screen.findByRole('textbox', { name: 'Thread name' })
    fireEvent.click(screen.getByRole('button', { name: 'Create thread' }))
    await waitFor(() => expect(view.onCreated).toHaveBeenCalledOnce())
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'create-thread', modelId: 'codex:other' }))
  })

  it('names it "New thread" and says so when no name is typed', async () => {
    const state = fixture([actual])
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => state)
    const view = setupManaged(command, state)
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }))
    await screen.findByRole('textbox', { name: 'Thread name' })
    fireEvent.click(screen.getByRole('button', { name: 'Create thread' }))
    await waitFor(() => expect(view.onCreated).toHaveBeenCalledOnce())
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ title: 'New thread', titleSource: 'default' }))
  })

  it('keeps the choices and shows the refusal when the provider rejects creation', async () => {
    const state = fixture([actual])
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => ({ ...state, error: 'Send or clear your draft before creating another thread.' }))
    const view = setupManaged(command, state)
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Thread name' }), { target: { value: 'Keep me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create thread' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Send or clear your draft before creating another thread.'))
    expect(view.onCreated).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Thread name' })).toHaveValue('Keep me')
  })
})
