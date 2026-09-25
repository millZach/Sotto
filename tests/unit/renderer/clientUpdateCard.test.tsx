import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, PROVIDER_LABELS, providerIdSchema, type AgentState, type ProviderClientUpdate } from '../../../src/shared/agents'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ClientUpdateCard } from '../../../src/renderer/src/agents/ClientUpdateCard'

vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn() }))
const caps = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
const behind = (patch: Partial<ProviderClientUpdate> = {}): ProviderClientUpdate => ({
  id: 'grok', installed: '1.0.5', published: '1.0.40', behind: true, channel: 'npm',
  command: 'npm install -g @xai-official/grok@latest', canInstall: true, checkedAt: new Date().toISOString(), state: 'idle', ...patch,
})
function fixture(clientUpdates: ProviderClientUpdate[], running = false): AgentState {
  return {
    configuration: defaultAgentConfiguration(), connection: 'connected', clientUpdates,
    host: { connected: true, name: 'Providers', version: '', capabilities: caps, projects: [], models: [],
      providers: providerIdSchema.options.map(id => ({ id, name: PROVIDER_LABELS[id], version: '1.0.5', connection: 'connected' as const, capabilities: caps })),
      threads: [{ id: 'thread', providerId: 'grok', projectId: 'project', title: 'Grok work', modelId: 'grok:4.7', status: running ? 'running' : 'idle', messages: [], requests: [] }],
    }, assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null, composing: false,
    pendingRequest: '', globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' }, voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: true }, reasoningAccounts: [], membership: { status: 'beta', label: 'Test', expiresAt: null },
  }
}
function provide(state: AgentState) {
  const command = vi.fn(async () => state)
  vi.mocked(useOptionalAgents).mockReturnValue({ state, command, error: null, voice: { status: 'off' }, muteVoice: vi.fn(), stopSpeech: vi.fn(), retryVoice: vi.fn(), attention: { items: [], show: false, dismiss: vi.fn(), reopen: vi.fn(), next: vi.fn(async () => undefined) } })
  return command
}
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('the client update card', () => {
  it('says nothing when every client is current', () => {
    provide(fixture([behind({ behind: false, published: '1.0.5', installed: '1.0.5', canInstall: false })]))
    const { container } = render(<ClientUpdateCard />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names the installed and published versions and updates that client on a press', async () => {
    const command = provide(fixture([behind()]))
    render(<ClientUpdateCard />)
    expect(screen.getByText('Client updates')).toBeTruthy()
    expect(screen.getByText(/1\.0\.5 → 1\.0\.40/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'update-client', provider: 'grok' }))
  })

  it('says a working thread will stop, and sends that press as the word for it', async () => {
    const command = provide(fixture([behind()], true))
    render(<ClientUpdateCard />)
    expect(screen.getByText(/a thread is working now; updating stops it/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Update anyway' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'update-client', provider: 'grok', force: true }))
  })

  it('offers the command instead of a button for an install it will not drive', () => {
    provide(fixture([behind({ channel: 'unknown', canInstall: false, command: 'brew upgrade grok' })]))
    render(<ClientUpdateCard />)
    expect(screen.getByText(/update it with brew upgrade grok/u)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
  })

  it('reports a failure in one line, keeps the installer’s own words under Details and offers to try again', async () => {
    const command = provide(fixture([behind({ state: 'failed', error: 'npm ERR! code EACCES' })]))
    render(<ClientUpdateCard />)
    expect(screen.getByText('Grok Build did not update.')).toBeTruthy()
    expect(screen.getByText('Nothing was changed.')).toBeTruthy()
    expect(screen.getByText('Details')).toBeTruthy()
    expect(screen.getByText(/The installer said: npm ERR! code EACCES\./u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'update-client', provider: 'grok' }))
  })

  it('offers to try again when the version did not move, and says it once', async () => {
    const command = provide(fixture([behind({ state: 'unchanged' })]))
    render(<ClientUpdateCard />)
    expect(screen.getByText('Grok Build is still on 1.0.5.')).toBeTruthy()
    expect(screen.getByText('1.0.40 is published.')).toBeTruthy()
    expect(screen.getAllByText(/still reports 1\.0\.5 when Sotto connects/u)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'update-client', provider: 'grok' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'dismiss-client-updates' }))
  })

  it('says a working thread will stop before trying again, and sends that press as the word for it', async () => {
    const command = provide(fixture([behind({ state: 'unchanged' })], true))
    render(<ClientUpdateCard />)
    expect(screen.getByText(/A thread is working now; updating stops it/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Update anyway' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'update-client', provider: 'grok', force: true }))
  })

  it('says a refused press out loud rather than under Details', async () => {
    const state = fixture([behind({ state: 'unchanged' })])
    const command = provide(state)
    command.mockResolvedValueOnce({ ...state, error: 'Another client is updating. Wait for it to finish.' })
    render(<ClientUpdateCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Another client is updating. Wait for it to finish.')).toBeTruthy()
  })

  it('does not repeat an outcome the card already shows', async () => {
    const state = fixture([behind({ state: 'unchanged', ranAt: '2026-09-25T09:40:00.000Z' })])
    const command = provide(state)
    command.mockResolvedValueOnce({ ...state, clientUpdates: [behind({ state: 'unchanged', ranAt: '2026-09-25T09:45:00.000Z' })], error: 'The installer finished, but Grok Build still reports 1.0.5 when Sotto connects. Another app may still have the old Grok Build open. Close it, then try again.' })
    render(<ClientUpdateCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(command).toHaveBeenCalled())
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(screen.getAllByText(/still reports 1\.0\.5 when Sotto connects/u)).toHaveLength(1)
  })

  it('offers no press while an update is running', () => {
    provide(fixture([behind({ state: 'updating' })]))
    render(<ClientUpdateCard />)
    expect(screen.getByText('Updating Grok Build to 1.0.40…')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('keeps the list for several clients, with Try again on a row that did not change', () => {
    provide(fixture([behind({ state: 'unchanged' }), behind({ id: 'codex', installed: '0.155.1', published: '0.156.0' })]))
    render(<ClientUpdateCard />)
    expect(screen.getByText('A client did not change')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy()
  })

  it('goes down on Escape while it holds focus, and leaves Escape alone otherwise', async () => {
    const command = provide(fixture([behind()]))
    render(<ClientUpdateCard />)
    // Escape belongs to whatever the user is in: a press elsewhere is not for this card.
    fireEvent.keyDown(window, { key: 'Escape' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(command).not.toHaveBeenCalled()
    screen.getByRole('button', { name: 'Update' }).focus()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'dismiss-client-updates' }))
  })

  it('takes a failed reading down with the rest when it is dismissed', () => {
    provide({ ...fixture([behind({ state: 'failed', error: 'npm ERR! code EACCES' })]), clientUpdatesDismissedAt: new Date().toISOString() })
    const { container } = render(<ClientUpdateCard />)
    expect(container).toBeEmptyDOMElement()
  })

  it('updates every behind client without answering the working-thread question for any of them', async () => {
    const command = provide(fixture([behind(), behind({ id: 'codex', installed: '0.155.1', published: '0.156.0' })], true))
    render(<ClientUpdateCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Update all 2' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'update-client', provider: 'grok' }))
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ force: true }))
  })
})
