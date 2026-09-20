import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
      projects, threads: [], models: [{ id: 'codex:model', name: 'Model', provider: 'Codex', ready: true, reasoningEfforts: ['low', 'high'], runtimeModes: ['approval-required', 'full-access'] }] },
    activeProjectId, activeThreadId: null, assignments: [], queue: [], draft: '', draftThreadId: null, draftRequestId: null, composing: false,
    pendingRequest: '', globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' },
    voice: { status: 'off', error: null, action: 'none', revision: 0 }, credentials: { reasoning: false, grokSpeech: false, secure: true },
    reasoningAccounts: [], membership: { status: 'beta', label: 'Test', expiresAt: null },
  }
}
function setup(command: (command: AgentCommand) => Promise<AgentState | null>, state = fixture()) {
  vi.stubGlobal('sotto', { agents: { chooseProjectDirectory: vi.fn(async () => path) } })
  const onCreated = vi.fn()
  const props = { state, command, onCreated, onClose: vi.fn() }
  const view = render(<NewThreadDialog {...props} />)
  return { ...view, onCreated, update: (next: AgentState) => view.rerender(<NewThreadDialog {...props} state={next} />) }
}
async function browse() {
  fireEvent.click(screen.getByRole('button', { name: /Local folder/ }))
  await screen.findByLabelText('Thread name')
  fireEvent.change(screen.getByLabelText('Thread name'), { target: { value: 'My work' } })
}
async function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'Create thread' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create thread' })).not.toBeDisabled())
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('native folder project resolution', () => {
  it.each(['requested-id', unrelated.id])('uses the returned folder project when activeProjectId is %s', async activeId => {
    const acknowledged = fixture([unrelated, actual], activeId)
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => acknowledged)
    const view = setup(command)
    await browse()
    fireEvent.change(screen.getByLabelText('Thread reasoning'), { target: { value: 'high' } })
    fireEvent.change(screen.getByLabelText('Thread permissions'), { target: { value: 'full-access' } })
    await submit()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(command).toHaveBeenLastCalledWith({ type: 'create-thread', projectId: actual.id, title: 'My work', modelId: 'codex:model', managed: false, workingCopy: 'shared', titleSource: 'user', reasoningEffort: 'high', runtimeMode: 'full-access' })
    expect(view.onCreated).toHaveBeenCalledOnce()
  })

  it('starts with the selected agent model when no default for new threads is chosen', async () => {
    const state = fixture([actual])
    state.configuration = { ...state.configuration, reasoning: 'claude', reasoningModel: 'opus[1m]', defaultModelId: '' }
    // Grok comes first in the saved model order, as in an installed profile.
    state.host.models = [{ id: 'native:grok:model:grok-4.6', name: 'Grok 4.6', provider: 'Grok', providerId: 'grok', ready: true },
      { id: 'native:claude:model:default', name: 'Default', provider: 'Claude', providerId: 'claude', ready: true },
      { id: 'native:claude:model:opus%5B1m%5D', name: 'Opus', provider: 'Claude', providerId: 'claude', ready: true }]
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => state)
    setup(command, state)
    await browse(); await submit()
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'create-thread', modelId: 'native:claude:model:opus%5B1m%5D' }))
  })

  it('moves to the selected agent model when it becomes ready after the dialog opens, unless a model was chosen', async () => {
    const grok = { id: 'native:grok:model:grok-4.6', name: 'Grok 4.6', provider: 'Grok', providerId: 'grok' as const, ready: true }
    const claude = { id: 'native:claude:model:default', name: 'Default', provider: 'Claude', providerId: 'claude' as const, ready: false }
    const state = fixture([actual])
    state.configuration = { ...state.configuration, reasoning: 'claude', defaultModelId: '' }
    state.host.models = [grok, claude]
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => state)
    const view = setup(command, state)
    view.update({ ...state, host: { ...state.host, models: [grok, { ...claude, ready: true }] } })
    await browse(); await submit()
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'create-thread', modelId: claude.id }))
  })

  it('reuses an existing Windows path without creating a duplicate project', async () => {
    const state = fixture([{ ...actual, path: actual.path.toUpperCase() + '\\' }])
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => state)
    setup(command, state)
    await browse(); await submit()
    expect(command.mock.calls.map(([request]) => request.type)).toEqual(['create-thread'])
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ projectId: actual.id }))
  })

  it('refreshes a delayed acknowledgement without submitting project creation again on retry or late state', async () => {
    const pending = fixture([unrelated], 'requested-id')
    let snapshot = pending
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => snapshot)
    const view = setup(command)
    await browse(); await submit()
    expect(command.mock.calls.map(([request]) => request.type)).toEqual(['create-project', 'refresh'])
    expect(view.onCreated).not.toHaveBeenCalled()
    await submit()
    expect(command.mock.calls.filter(([request]) => request.type === 'create-project')).toHaveLength(1)
    expect(command.mock.calls.filter(([request]) => request.type === 'create-thread')).toHaveLength(0)
    snapshot = fixture([unrelated, actual], unrelated.id)
    view.update(snapshot)
    await submit()
    view.update(snapshot)
    expect(command.mock.calls.filter(([request]) => request.type === 'create-project')).toHaveLength(1)
    expect(command.mock.calls.filter(([request]) => request.type === 'create-thread')).toEqual([[expect.objectContaining({ projectId: actual.id, title: 'My work' })]])
    expect(view.onCreated).toHaveBeenCalledOnce()
  })

  it('continues the original submission when refresh delivers the project', async () => {
    const command = vi.fn(async (request: AgentCommand) => request.type === 'create-project' ? fixture([], 'requested-id') : fixture([actual]))
    const view = setup(command)
    await browse(); await submit()
    expect(command.mock.calls.map(([request]) => request.type)).toEqual(['create-project', 'refresh', 'create-thread'])
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: actual.id, title: 'My work' }))
    expect(view.onCreated).toHaveBeenCalledOnce()
  })

  it.each([null, { ...fixture(), error: 'The creation result is unknown.' }])('retains an unconfirmed attempt across back/reselection (%j)', async response => {
    let snapshot = fixture()
    const command = vi.fn(async (request: AgentCommand) => request.type === 'create-project' ? response : snapshot)
    const view = setup(command)
    await browse(); await submit()
    fireEvent.click(screen.getByRole('button', { name: 'Back to projects' }))
    await browse(); await submit()
    expect(command.mock.calls.filter(([request]) => request.type === 'create-project')).toHaveLength(1)
    expect(command.mock.calls.filter(([request]) => request.type === 'create-thread')).toHaveLength(0)
    snapshot = fixture([actual])
    await submit()
    expect(view.onCreated).toHaveBeenCalledOnce()
  })

  it('uses a project arriving after folder selection before submitting', async () => {
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => fixture([actual]))
    const view = setup(command)
    await browse()
    view.update(fixture([actual]))
    await submit()
    expect(command.mock.calls.map(([request]) => request.type)).toEqual(['create-thread'])
  })

  it('retains the resolved project and options when the controller rejects thread creation', async () => {
    let rejectThread = true
    const command = vi.fn(async (request: AgentCommand) => ({ ...fixture([actual]), error: request.type === 'create-thread' && rejectThread ? 'Send or clear your draft before creating another thread.' : null }))
    const view = setup(command)
    await browse(); await submit()
    expect(screen.getByRole('alert')).toHaveTextContent('Send or clear your draft')
    expect(view.onCreated).not.toHaveBeenCalled()
    rejectThread = false
    await submit()
    expect(command.mock.calls.filter(([request]) => request.type === 'create-project')).toHaveLength(1)
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: actual.id, title: 'My work' }))
    expect(view.onCreated).toHaveBeenCalledOnce()
  })

  it('does not repeat creation when the response or a late state rerender arrives after success', async () => {
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => fixture([actual]))
    const view = setup(command)
    await browse(); await submit()
    view.update(fixture([actual]))
    await submit()
    expect(command.mock.calls.map(([request]) => request.type)).toEqual(['create-project', 'create-thread'])
    expect(view.onCreated).toHaveBeenCalledOnce()
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
    fireEvent.click(screen.getByRole('button', { name: 'Create thread' }))
    expect(view.onCreating).toHaveBeenCalledOnce()
    expect(view.onCreated).not.toHaveBeenCalled()
    const start = view.start()
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'create-thread', projectId: actual.id, title: 'My work', threadId: start.thread.id }))
    expect(start.thread).toMatchObject({ id: expect.any(String), projectId: actual.id, title: 'My work', modelId: 'codex:model',
      status: 'idle', messages: [], requests: [], nativeSessionStarted: false, historyStatus: 'ready', worktree: { mode: 'shared', status: 'pending' } })
    expect(start.choices).toEqual({ projectId: actual.id, title: 'My work', modelId: 'codex:model', workingCopy: 'shared' })
    settle()
    await expect(start.created).resolves.toBeNull()
  })

  it('reports a refusal on the same creation instead of throwing it away', async () => {
    const command = vi.fn(async () => ({ ...fixture([actual]), error: 'That model or account is unavailable.' }))
    const view = startCreation(command)
    await browse()
    fireEvent.click(screen.getByRole('button', { name: 'Create thread' }))
    await expect(view.start().created).resolves.toBe('That model or account is unavailable.')
    expect(view.onCreated).not.toHaveBeenCalled()
  })

  it('reopens with the choices already made and says why the last attempt was refused', async () => {
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => fixture([actual]))
    vi.stubGlobal('sotto', { agents: { chooseProjectDirectory: vi.fn(async () => path) } })
    const onCreating = vi.fn<(start: ThreadCreationStart) => void>()
    render(<NewThreadDialog state={fixture([actual])} command={command} onCreated={vi.fn()} onClose={vi.fn()} onCreating={onCreating}
      initialChoices={{ projectId: actual.id, title: 'Second attempt', modelId: 'codex:model', workingCopy: 'shared', reasoningEffort: 'high' }}
      initialError="Send or clear your draft before creating another thread." />)
    expect(screen.getByRole('alert')).toHaveTextContent('Send or clear your draft')
    expect(screen.getByLabelText('Thread name')).toHaveValue('Second attempt')
    expect(screen.getByRole('radio', { name: 'Project folder' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Create thread' }))
    await waitFor(() => expect(onCreating).toHaveBeenCalledOnce())
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'create-thread', title: 'Second attempt', workingCopy: 'shared', reasoningEffort: 'high' }))
  })
})

describe('working copy choice', () => {
  it('does not guess defaults after a settings read fails and allows a retry', async () => {
    const state = fixture([actual])
    const command = vi.fn(async () => state)
    const getSettings = vi.fn().mockRejectedValueOnce(new Error('read failed')).mockResolvedValue({ threadWorkingCopyDefault: 'independent', projectThreadWorkingCopyDefaults: {} })
    vi.stubGlobal('sotto', { getSettings })
    render(<NewThreadDialog state={state} command={command} onClose={vi.fn()} onCreated={vi.fn()} initialProjectId={actual.id} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read your working-copy defaults.')
    expect(screen.getByRole('button', { name: 'Create thread' })).toBeDisabled()
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry defaults' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: 'New worktree' })).toBeChecked())
    expect(screen.getByRole('button', { name: 'Create thread' })).not.toBeDisabled()
  })

  it('honors a project override ahead of the global default and sends selected base and origin', async () => {
    const state = fixture([actual])
    const command = vi.fn(async () => state)
    vi.stubGlobal('sotto', {
      getSettings: vi.fn(async () => ({ threadWorkingCopyDefault: 'shared', projectThreadWorkingCopyDefaults: { [actual.id]: 'independent' } })),
      agents: { workingCopyOptions: vi.fn(async () => ({ isGit: true, currentBranch: 'main', branches: ['main', 'develop'], worktrees: [] })) },
    })
    render(<NewThreadDialog state={state} command={command} onClose={vi.fn()} onCreated={vi.fn()} initialProjectId={actual.id} />)
    await waitFor(() => expect(screen.getByRole('radio', { name: 'New worktree' })).toBeChecked())
    fireEvent.change(await screen.findByLabelText('Base branch'), { target: { value: 'develop' } })
    expect(screen.getByLabelText('Start from origin')).toBeChecked()
    expect(command).not.toHaveBeenCalled()
    await submit()
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'create-thread', workingCopy: 'independent', baseBranch: 'develop', startFromOrigin: true }))
  })

  it('explicitly chooses an existing checkout and explains that its files and branch are shared', async () => {
    const state = fixture([actual])
    const command = vi.fn(async () => state)
    vi.stubGlobal('sotto', { agents: { workingCopyOptions: vi.fn(async () => ({ isGit: true, currentBranch: 'main', branches: ['main'], worktrees: [{ path: 'C:/work/task', branch: 'feat/task' }] })) } })
    render(<NewThreadDialog state={state} command={command} onClose={vi.fn()} onCreated={vi.fn()} initialProjectId={actual.id} />)
    fireEvent.click(screen.getByRole('radio', { name: 'New worktree' }))
    fireEvent.change(await screen.findByLabelText('Worktree'), { target: { value: 'C:/work/task' } })
    expect(screen.getByRole('group', { name: 'Working copy' })).toHaveAccessibleDescription('Shares files and branch with other threads using this worktree.')
    expect(screen.queryByLabelText('Base branch')).toBeNull()
    await submit()
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'create-thread', workingCopy: 'independent', existingWorktreePath: 'C:/work/task' }))
  })

  it('preserves an explicit local base without origin through creation', async () => {
    const state = fixture([actual])
    const command = vi.fn(async () => state)
    vi.stubGlobal('sotto', { agents: { workingCopyOptions: vi.fn(async () => ({ isGit: true, currentBranch: 'main', branches: ['main'], worktrees: [] })) } })
    render(<NewThreadDialog state={state} command={command} onClose={vi.fn()} onCreated={vi.fn()} initialProjectId={actual.id} />)
    fireEvent.click(screen.getByRole('radio', { name: 'New worktree' }))
    fireEvent.click(await screen.findByLabelText('Start from origin'))
    await submit()
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'create-thread', workingCopy: 'independent', startFromOrigin: false }))
  })

  it('saves and clears a project override without changing a global preference', async () => {
    const state = fixture([actual])
    const getSettings = vi.fn(async () => ({ threadWorkingCopyDefault: 'shared', projectThreadWorkingCopyDefaults: {} }))
    const updateSettings = vi.fn(async (patch: object) => ({ ...await getSettings(), ...patch }))
    vi.stubGlobal('sotto', { getSettings, updateSettings })
    render(<NewThreadDialog state={state} command={vi.fn()} onClose={vi.fn()} onCreated={vi.fn()} initialProjectId={actual.id} />)
    fireEvent.change(screen.getByLabelText('Default for this project'), { target: { value: 'independent' } })
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ projectThreadWorkingCopyDefaults: { [actual.id]: 'independent' } }))
    await waitFor(() => expect(screen.getByRole('radio', { name: 'New worktree' })).toBeChecked())
    fireEvent.change(screen.getByLabelText('Default for this project'), { target: { value: 'inherit' } })
    await waitFor(() => expect(updateSettings).toHaveBeenLastCalledWith({ projectThreadWorkingCopyDefaults: {} }))
  })

  it('uses the project folder by default and explains shared files and branch', async () => {
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => fixture([actual]))
    setup(command, fixture([actual]))
    await browse()
    const group = screen.getByRole('group', { name: 'Working copy' })
    expect(screen.getByRole('radio', { name: 'Project folder' })).toBeChecked()
    expect(group).toHaveAccessibleDescription(/Shares files and branch/)
    expect(group.textContent).not.toMatch(/isolat|memory/i)
    await submit()
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'create-thread', workingCopy: 'shared' }))
  })

  it('sends a deliberately chosen shared project folder and keeps the choice after a rejected create', async () => {
    let reject = true
    const command = vi.fn(async (request: AgentCommand) => ({ ...fixture([actual]), error: request.type === 'create-thread' && reject ? 'Provider unavailable.' : null }))
    const view = setup(command, fixture([actual]))
    await browse()
    fireEvent.click(screen.getByRole('radio', { name: 'Project folder' }))
    expect(screen.getByRole('group', { name: 'Working copy' })).toHaveAccessibleDescription('Shares files and branch with other threads using this folder.')
    await submit()
    expect(screen.getByRole('alert')).toHaveTextContent('Provider unavailable.')
    expect(screen.getByRole('radio', { name: 'Project folder' })).toBeChecked()
    reject = false
    await submit()
    expect(command.mock.calls.filter(([request]) => request.type === 'create-thread').map(([request]) => request))
      .toEqual([expect.objectContaining({ workingCopy: 'shared' }), expect.objectContaining({ workingCopy: 'shared' })])
    expect(view.onCreated).toHaveBeenCalledOnce()
  })

  it('continues keyboard creation in the thread name once a folder is chosen', async () => {
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => fixture([actual]))
    setup(command, fixture([actual]))
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search projects' }), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search projects' }), { key: 'Enter' })
    await waitFor(() => expect(screen.getByLabelText('Thread name')).toHaveFocus())
  })

  it('locks the choice while creation is in flight', async () => {
    let finish: (state: AgentState) => void = () => undefined
    const command = vi.fn(() => new Promise<AgentState>(resolve => { finish = resolve }))
    setup(command, fixture([actual]))
    await browse()
    fireEvent.click(screen.getByRole('button', { name: 'Create thread' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Project folder' })).toBeDisabled())
    finish(fixture([actual]))
    await waitFor(() => expect(command).toHaveBeenCalledOnce())
  })
})
