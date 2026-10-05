import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultAgentConfiguration, type AgentCommand, type AgentState } from '../../../src/shared/agents'
import { designThreadsFixture, E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { draftThreads } from '../../../src/renderer/src/agents/draftThreads'
import { SplitLayoutStore } from '../../../src/renderer/src/agents/splitLayout'
import { openSidebarFolders } from './liveAgentState'
import { agentContextFixture } from '../../fixtures/agentContext'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))
// Voice is off, as in the beta (ADR-0012): the saved draft is shown and handled without it.
vi.mock('../../../src/renderer/src/state/voiceCoordinator', () => ({ useVoiceCoordinatorEnabled: () => false }))

const NOW = E2E_THREADS_NOW
const LEFTOVER = 'Change every link in docs/release to the new releases repository, then run the link check and list what it could not reach.'

/** The design fixture with no pane open, and the coordinator holding a draft written for `draftThreadId`. */
function withDraft(draftThreadId: string | null, connection: AgentState['connection'] = 'connected'): AgentState {
  const fixture = designThreadsFixture()
  return {
    configuration: { ...defaultAgentConfiguration(), enabled: true, defaultModelId: 'claude:sonnet' },
    connection,
    host: {
      connected: connection === 'connected', name: 'Codex', version: 'test',
      capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true },
      models: [...fixture.models], projects: [...fixture.projects], threads: structuredClone(fixture.threads) as AgentState['host']['threads'],
    },
    assignments: [], queue: [],
    activeThreadId: null, activeProjectId: 'workshop',
    draft: LEFTOVER, draftThreadId, draftRequestId: null, composing: false,
    pendingRequest: '', globalLaneBusy: false, notice: '', error: null,
    speech: { id: 0, text: '' }, voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: true },
    reasoningAccounts: [],
  }
}

type Command = (request: AgentCommand) => Promise<AgentState | null>
function renderEmpty(state: AgentState, respond?: (request: AgentCommand) => AgentState | null) {
  const command = vi.fn<Command>(async request => respond ? respond(request) : state)
  const threadDrafts = new ThreadDraftStore(command, 0)
  threadDrafts.receive(state); openSidebarFolders(state)
  vi.mocked(useAgents).mockReturnValue({ ...agentContextFixture(state, command), threadDrafts })
  render(<ThreadsView onOpenAgents={vi.fn()} now={NOW} layoutStore={new SplitLayoutStore()} />)
  return command
}
const sent = <T extends AgentCommand['type']>(command: { mock: { calls: [AgentCommand][] } }, type: T): Extract<AgentCommand, { type: T }>[] =>
  command.mock.calls.map(([request]) => request).filter((request): request is Extract<AgentCommand, { type: T }> => request.type === type)

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(() => { cleanup(); draftThreads.reset() })

describe('a saved draft on the empty Threads page (issue #736)', () => {
  it('asks to reconnect only while disconnected, and keeps the draft in sight', () => {
    renderEmpty(withDraft('gone-thread', 'disconnected'))
    expect(screen.getByRole('heading', { name: 'Your draft is saved.' })).toBeVisible()
    expect(screen.getByText('Reconnect to continue your saved draft.')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Saved draft' })).toHaveValue(LEFTOVER)
    expect(screen.getByRole('button', { name: 'Connect providers' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument()
  })

  it('never asks to reconnect while connected when the draft’s thread is gone', () => {
    renderEmpty(withDraft('gone-thread'))
    expect(screen.getByRole('heading', { name: 'A draft from an earlier thread is saved.' })).toBeVisible()
    expect(screen.queryByText(/Reconnect/u)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect providers' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Saved draft' })).toHaveValue(LEFTOVER)
    expect(screen.getByRole('button', { name: 'New thread with this draft' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Discard draft' })).toBeEnabled()
  })

  it('starts a new thread with the leftover draft in its composer, and lets the old copy go once that is saved', async () => {
    const state = withDraft('gone-thread')
    const command = renderEmpty(state, request => request.type === 'save-thread-draft'
      ? { ...state, threadDraftPersistence: [{ threadId: request.threadId, draftId: request.draftId, status: 'saved' }] }
      : state)
    fireEvent.click(screen.getByRole('button', { name: 'New thread with this draft' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue(LEFTOVER))
    const [created] = sent(command, 'create-thread')
    expect(created).toMatchObject({ projectId: 'workshop', managed: false })
    await waitFor(() => expect(sent(command, 'cancel-draft')).toHaveLength(1))
    // The new thread's composer was saved with the draft before the coordinator's copy was let go.
    expect(sent(command, 'save-thread-draft').at(-1)).toMatchObject({ threadId: created!.threadId, text: LEFTOVER })
    const order = command.mock.calls.map(([request]) => request.type)
    expect(order.indexOf('save-thread-draft')).toBeLessThan(order.indexOf('cancel-draft'))
  })

  it('keeps the leftover draft when the new thread’s composer could not be saved', async () => {
    const state = withDraft('gone-thread')
    const command = renderEmpty(state, request => request.type === 'save-thread-draft' ? null : state)
    fireEvent.click(screen.getByRole('button', { name: 'New thread with this draft' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue(LEFTOVER))
    await waitFor(() => expect(sent(command, 'save-thread-draft').length).toBeGreaterThan(0))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(sent(command, 'cancel-draft')).toHaveLength(0)
  })

  it('offers to open the thread a saved draft belongs to while that thread is still here', () => {
    const command = renderEmpty(withDraft('footer-links'))
    expect(screen.getByRole('heading', { name: 'Your draft for Footer links is saved.' })).toBeVisible()
    expect(screen.queryByText(/Reconnect/u)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open thread' }))
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: 'footer-links' })
  })

  it('discards the draft only after asking, and Escape keeps it', async () => {
    const command = renderEmpty(withDraft('gone-thread'))
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }))
    const dialog = screen.getByRole('dialog', { name: 'Discard this draft?' })
    expect(within(dialog).getByRole('button', { name: 'Keep draft' })).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(sent(command, 'cancel-draft')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Discard this draft?' })).getByRole('button', { name: 'Discard draft' }))
    await waitFor(() => expect(sent(command, 'cancel-draft')).toHaveLength(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('leaves a recovered draft after a provider upgrade to its own notice', () => {
    renderEmpty({ ...withDraft(null), providerUpgrade: { migratedAt: NOW, recoveryPath: 'C:/recovery' } })
    expect(screen.getByRole('heading', { name: 'Choose a thread.' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'Recovered work' })).toBeVisible()
  })
})
