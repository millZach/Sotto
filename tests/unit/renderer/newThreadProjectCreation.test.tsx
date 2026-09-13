import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewThreadDialog } from '../../../src/renderer/src/agents/NewThreadDialog'
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
    pendingRequest: '', busy: false, notice: '', error: null, speech: { id: 0, text: '' },
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
    expect(command).toHaveBeenLastCalledWith({ type: 'create-thread', projectId: actual.id, title: 'My work', modelId: 'codex:model', managed: false, workingCopy: 'independent', reasoningEffort: 'high', runtimeMode: 'full-access' })
    expect(view.onCreated).toHaveBeenCalledOnce()
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

describe('working copy choice', () => {
  it('asks for a new worktree by default and says what an ordinary folder does', async () => {
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => fixture([actual]))
    setup(command, fixture([actual]))
    await browse()
    const group = screen.getByRole('group', { name: 'Working copy' })
    expect(screen.getByRole('radio', { name: 'New worktree' })).toBeChecked()
    expect(group).toHaveAccessibleDescription(/Folders without Git are used as they are/)
    expect(group.textContent).not.toMatch(/isolat|memory/i)
    await submit()
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'create-thread', workingCopy: 'independent' }))
  })

  it('sends a deliberately chosen shared project folder and keeps the choice after a rejected create', async () => {
    let reject = true
    const command = vi.fn(async (request: AgentCommand) => ({ ...fixture([actual]), error: request.type === 'create-thread' && reject ? 'Provider unavailable.' : null }))
    const view = setup(command, fixture([actual]))
    await browse()
    fireEvent.click(screen.getByRole('radio', { name: 'Project folder' }))
    expect(screen.getByRole('group', { name: 'Working copy' })).toHaveAccessibleDescription('Works in the project folder alongside its other threads.')
    await submit()
    expect(screen.getByRole('alert')).toHaveTextContent('Provider unavailable.')
    expect(screen.getByRole('radio', { name: 'Project folder' })).toBeChecked()
    reject = false
    await submit()
    expect(command.mock.calls.filter(([request]) => request.type === 'create-thread').map(([request]) => request))
      .toEqual([expect.objectContaining({ workingCopy: 'shared' }), expect.objectContaining({ workingCopy: 'shared' })])
    expect(view.onCreated).toHaveBeenCalledOnce()
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
