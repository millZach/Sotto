import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultAgentConfiguration, type AgentCommand, type AgentState } from '../../../src/shared/agents'
import { designThreadsFixture, E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { AgentView } from '../../../src/renderer/src/agents/AgentView'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { describeThreads, groupThreads, listThreads, providerKey } from '../../../src/renderer/src/agents/threadFacts'
import { liveAgentState } from './liveAgentState'
import { paneMenuItem } from './paneMenu'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { draftThreads } from '../../../src/renderer/src/agents/draftThreads'
import { requestAnswerStore } from '../../../src/renderer/src/agents/requests/requestAnswers'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

// The coordinator is hidden for the beta (ADR-0012), and ThreadsView is rendered here without an
// AppProvider, so the flag is stated per test: off is the beta, on is what a managed thread needs.
const voice = vi.hoisted(() => ({ enabled: false }))
vi.mock('../../../src/renderer/src/state/voiceCoordinator', () => ({ useVoiceCoordinatorEnabled: () => voice.enabled }))

const NOW = E2E_THREADS_NOW

/** The design fixture as the coordinator would publish it: the permission request already sits in the attention queue. */
function stateFixture(): AgentState {
  const fixture = designThreadsFixture()
  return {
    configuration: { ...defaultAgentConfiguration(), enabled: true, defaultModelId: 'claude:sonnet' },
    connection: 'connected',
    host: {
      connected: true, name: 'Codex', version: 'test',
      capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true },
      models: [...fixture.models], projects: [...fixture.projects], threads: structuredClone(fixture.threads) as AgentState['host']['threads'],
    },
    assignments: fixture.assignments.map(assignment => ({ ...assignment, contextUpdatedAt: NOW })),
    queue: [{ id: 'visual-gate:visual-gate-permission:permission', threadId: 'visual-gate', kind: 'permission', text: 'Run a command in workshop\nnpm test -- --run tests/unit/agents', requestId: 'visual-gate-permission', createdAt: new Date(NOW).toISOString(), deferred: false }],
    activeThreadId: 'visual-gate', activeProjectId: 'workshop',
    draft: '', draftThreadId: null, draftRequestId: null, composing: false,
    pendingRequest: '', globalLaneBusy: false, notice: '', error: null,
    speech: { id: 0, text: '' }, voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: true },
    reasoningAccounts: [],
    membership: { status: 'beta', label: 'Development beta', expiresAt: null },
  }
}

let connectionStores = new WeakMap<ReturnType<typeof useAgents>['command'], ThreadDraftStore>()
function connection(state: AgentState | null, command = vi.fn(async () => state)): ReturnType<typeof useAgents> {
  let threadDrafts = connectionStores.get(command)
  if (!threadDrafts) { threadDrafts = new ThreadDraftStore(command); connectionStores.set(command, threadDrafts) }
  if (state) threadDrafts.receive(state)
  return { state, command, threadDrafts, error: null, voice: { status: 'off' }, muteVoice: vi.fn(), stopSpeech: vi.fn(), retryVoice: vi.fn(), attention: { items: state?.queue ?? [], show: false, dismiss: vi.fn(), reopen: vi.fn(), next: vi.fn(async () => undefined) } }
}

function renderThreads(state: AgentState | null, command = vi.fn(async () => state)) {
  const onOpenAgents = vi.fn()
  vi.mocked(useAgents).mockReturnValue(connection(state, command))
  const view = render(<ThreadsView onOpenAgents={onOpenAgents} now={NOW} />)
  return { ...view, command, onOpenAgents }
}

beforeEach(() => {
  vi.mocked(useAgents).mockReset(); connectionStores = new WeakMap(); voice.enabled = false
  for (const thread of stateFixture().host.threads) requestAnswerStore.prune(thread.id, [])
})
afterEach(cleanup)

describe('thread grouping and states from Sotto state', () => {
  it('groups explicit settled work separately from open idle and running threads', () => {
    const groups = groupThreads(describeThreads(stateFixture(), NOW), NOW)
    expect(groups.map(group => [group.label, group.rows.map(entry => entry.thread.title)])).toEqual([
      ['Unsettled', ['Visual gate flake', 'Footer links', 'Weekly note', 'Grok voice previews', 'Streaming WAV stall']],
      ['Settled', ['Release notes 1.4', 'Thread routing', 'Notes cleanup', 'Benchmark rerun']],
    ])
  })

  it('derives the state of a row from the queue, the assignment and the thread status, never from the provider', () => {
    const state = stateFixture()
    const rows = describeThreads(state, NOW)
    const byTitle = (title: string) => rows.find(entry => entry.thread.title === title)!
    expect(byTitle('Visual gate flake')).toMatchObject({ state: 'needs', stateLabel: 'Needs your approval', waitingFor: 'approval', provider: 'Claude', providerKey: 'claude', management: 'managed', attention: true })
    expect(byTitle('Visual gate flake').request?.requestId).toBe('visual-gate-permission')
    expect(byTitle('Footer links')).toMatchObject({ state: 'working', stateLabel: 'Working', provider: 'Codex', providerKey: 'codex', attention: false })
    expect(byTitle('Streaming WAV stall')).toMatchObject({ state: 'stopped', stateLabel: 'Stopped', management: 'stopped' })
    expect(byTitle('Streaming WAV stall').sentence).toMatch(/^Stopped at the follow-up limit\./u)
    expect(byTitle('Release notes 1.4')).toMatchObject({ state: 'done', stateLabel: 'Settled' })
    expect(byTitle('Notes cleanup')).toMatchObject({ state: 'done', management: 'none', assignment: undefined, providerKey: 'grok' })
    // The card under an open row is your side of the thread: the sentence already carries the provider's.
    expect(byTitle('Weekly note').lastMessage).toMatchObject({ who: 'Sotto', text: expect.stringMatching(/^It is Friday\./u) })
    expect(byTitle('Footer links').lastMessage).toMatchObject({ who: 'You', at: Date.UTC(2026, 6, 12, 19, 38) })
    // A thread with no user message yet has no card.
    const weekly = state.host.threads.find(entry => entry.id === 'weekly-note')!
    weekly.messages = weekly.messages.slice(1)
    expect(describeThreads(state, NOW).find(entry => entry.thread.id === 'weekly-note')?.lastMessage).toBeUndefined()
  })

  it('keys the badge from the provider field, not the model display name, and falls back to a neutral badge', () => {
    expect(providerKey('Claude')).toBe('claude')
    expect(providerKey('anthropic')).toBe('claude')
    expect(providerKey('Codex')).toBe('codex')
    expect(providerKey('OpenAI')).toBe('codex')
    expect(providerKey('Grok')).toBe('grok')
    expect(providerKey('xAI')).toBe('grok')
    expect(providerKey('Unknown provider')).toBe('other')
    expect(providerKey('')).toBe('other')
    const state = stateFixture()
    state.host.models = state.host.models.map(model => model.id === 'claude:sonnet' ? { ...model, provider: 'Acme', name: 'Claude-ish 9' } : model)
    const visual = describeThreads(state, NOW).find(entry => entry.thread.id === 'visual-gate')!
    expect(visual).toMatchObject({ provider: 'Acme', providerKey: 'other' })
  })

  it('ranks a manual takeover above a stale stop so the row never reads as stopped once you took over', () => {
    const state = stateFixture()
    const taken = state.assignments.find(entry => entry.threadId === 'wav-stall')!
    taken.mode = 'manual'
    const row = describeThreads(state, NOW).find(entry => entry.thread.id === 'wav-stall')!
    expect(row).toMatchObject({ state: 'done', stateLabel: 'Done', management: 'manual' })
    expect(row.sentence).not.toMatch(/stopped/iu)
    expect(row.facts.rest).toMatch(/^You took over in Codex; Sotto is watching, 5 of 5 follow-ups used\./u)
  })

  it('lists attention rows regardless of the query and matches the whole row otherwise', () => {
    const rows = describeThreads(stateFixture(), NOW)
    const titles = (entries: readonly { readonly thread: { readonly title: string } }[]) => entries.map(entry => entry.thread.title)
    const sotto = listThreads(rows, 'sotto-site')
    expect(titles(sotto.matching)).toEqual(['Footer links'])
    expect(titles(sotto.listed)).toEqual(['Visual gate flake', 'Footer links'])
    // The facts line and the last message text count as part of the row.
    expect(titles(listThreads(rows, 'typed prompt').matching)).toEqual(['Weekly note', 'Grok voice previews', 'Thread routing'])
    expect(titles(listThreads(rows, 'GPT-5.4').matching)).toEqual(['Footer links', 'Release notes 1.4', 'Streaming WAV stall'])
    expect(titles(listThreads(rows, 'Tidy the notes folder').matching)).toEqual(['Notes cleanup'])
    expect(titles(listThreads(rows, 'deploy').matching)).toEqual([])
    expect(titles(listThreads(rows, 'deploy').listed)).toEqual(['Visual gate flake'])
    expect(listThreads(rows, '  ').listed).toHaveLength(9)
  })

  it('treats a blocked queue item as needing you and a user pause as paused, and a manual assignment as yours', () => {
    const state = stateFixture()
    state.host.threads.find(thread => thread.id === 'release-notes')!.settledOverride = 'active'
    state.queue.push({ id: 'release-notes:release-notes-2:blocked', threadId: 'release-notes', kind: 'blocked', text: 'Scope changed. Decide whether to keep going.', createdAt: new Date(NOW).toISOString(), deferred: false })
    const paused = state.assignments.find(entry => entry.threadId === 'grok-previews')!
    paused.paused = true
    const manual = state.assignments.find(entry => entry.threadId === 'thread-routing')!
    manual.mode = 'manual'
    const rows = describeThreads(state, NOW)
    expect(rows.find(entry => entry.thread.id === 'release-notes')).toMatchObject({ state: 'needs', sentence: 'Scope changed. Decide whether to keep going.', request: undefined })
    expect(rows.find(entry => entry.thread.id === 'grok-previews')).toMatchObject({ state: 'done', stateLabel: 'Paused', management: 'paused' })
    expect(rows.find(entry => entry.thread.id === 'thread-routing')).toMatchObject({ management: 'manual' })
  })
})

describe('ThreadsView workspace', () => {
  it('keeps a working but disconnected thread’s fact in the sidebar with a warning cue', () => {
    const state = stateFixture(); state.host.connected = false
    renderThreads(state)
    const status = screen.getByRole('button', { name: 'Footer links' }).querySelector('.thread-nav__status')!
    expect(status).toHaveTextContent('Working · Disconnected')
    expect(status).toHaveAttribute('data-state', 'working')
    expect(status).toHaveAttribute('data-disconnected', 'true')
  })

  it('shows a pending manual message immediately and follows only its own delivery record', async () => {
    const state = stateFixture(); state.assignments = []; state.activeThreadId = 'grok-previews'
    const live = liveAgentState(state)
    vi.mocked(useAgents).mockImplementation(live.useLive)
    render(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Show this pending message immediately.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }))
    expect(screen.getByLabelText('Pending message')).toHaveTextContent('Show this pending message immediately.')
    expect(screen.getByLabelText('Pending message')).toHaveTextContent('Queued')
    act(() => live.deliver('grok-previews', 'submitting'))
    expect(screen.getByLabelText('Pending message')).toHaveTextContent('Sending')
    act(() => live.deliver('grok-previews', 'uncertain'))
    await waitFor(() => expect(screen.getByLabelText('Pending message')).toHaveTextContent('Unconfirmed'))
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled()
    // The prompt is in its message, not the composer: an unconfirmed send is never written twice.
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Keep my replacement draft.' } })
    // Another revision's receipt is not this message's receipt.
    act(() => { live.publish({ deliveredDrafts: [{ threadId: 'grok-previews', draftId: crypto.randomUUID() }] }) })
    expect(screen.getByLabelText('Pending message')).toBeVisible()
    act(() => live.deliver('grok-previews', 'accepted', 'Show this pending message immediately.'))
    await waitFor(() => expect(screen.queryByLabelText('Pending message')).not.toBeInTheDocument())
    expect(screen.getByLabelText('Thread transcript')).toHaveTextContent('Show this pending message immediately.')
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Keep my replacement draft.')
    expect(live.manualSends()).toBe(1)
  })

  it('keeps an unmanaged composer available when another thread owns the saved draft', () => {
    const state = stateFixture()
    state.assignments = []; state.activeThreadId = 'grok-previews'
    state.draft = 'Keep the saved draft'; state.draftThreadId = 'visual-gate'
    const { rerender } = renderThreads(state)
    expect(screen.getByRole('textbox', { name: 'Prompt', exact: true })).toBeEnabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'My next prompt' } })
    state.host.threads.find(thread => thread.id === 'grok-previews')!.status = 'running'
    rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeEnabled()
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('My next prompt')
    // A running thread queues the next prompt instead of refusing it.
    expect(screen.getByRole('button', { name: 'Queue prompt' })).toBeEnabled()
    expect(state.draft).toBe('Keep the saved draft')
  })

  for (const edited of [false, true]) it(`handles a late manual delivery receipt with ${edited ? 'a newer draft and its images preserved' : 'the composer left empty'}`, async () => {
    const state = stateFixture(); state.assignments = []; state.activeThreadId = 'grok-previews'
    state.host.models.forEach(model => { model.supportsImages = true })
    let draftId = ''
    const command = vi.fn(async (...args: unknown[]) => {
      const request = args[0] as AgentCommand
      if (request.type === 'manual-send') draftId = request.draftId!
      return { ...state, error: 'Delivery not yet confirmed' }
    })
    const { rerender } = renderThreads(state, command)
    const imageFile = () => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'same-name.png', { type: 'image/png' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Review this' } })
    fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: [imageFile()] } })
    await screen.findByRole('img', { name: 'same-name.png' })
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }))
    await screen.findByRole('button', { name: 'Check again' })
    // The press emptied the composer; the prompt and its image are in the message below the conversation.
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled()
    if (edited) {
      fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'And review this too' } })
      fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: [imageFile()] } })
      await screen.findAllByRole('img', { name: 'same-name.png' })
    }
    vi.mocked(useAgents).mockReturnValue(connection({ ...state, deliveredDrafts: [{ threadId: 'grok-previews', draftId }] }, command))
    rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue(edited ? 'And review this too' : ''))
    expect(screen.queryAllByRole('img', { name: 'same-name.png' })).toHaveLength(edited ? 1 : 0)
    expect(command.mock.calls.filter(([request]) => (request as AgentCommand).type === 'manual-send')).toHaveLength(1)
  })

  it('reconciles a late manual receipt while a managed thread has unmounted its composer', async () => {
    const state = stateFixture(); state.activeThreadId = 'grok-previews'
    state.assignments = state.assignments.filter(assignment => assignment.threadId === 'footer-links')
    let draftId = ''
    const command = vi.fn(async (...args: unknown[]) => {
      const request = args[0] as AgentCommand
      if (request.type === 'manual-send') draftId = request.draftId!
      return { ...state, error: 'Not confirmed yet' }
    })
    const { rerender } = renderThreads(state, command)
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Deliver this only once' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }))
    await screen.findByRole('button', { name: 'Check again' })
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled()
    state.activeThreadId = 'footer-links'
    rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(screen.queryByRole('button', { name: 'Send prompt' })).not.toBeInTheDocument()
    vi.mocked(useAgents).mockReturnValue(connection({ ...state, deliveredDrafts: [{ threadId: 'grok-previews', draftId }] }, command))
    rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    vi.mocked(useAgents).mockReturnValue(connection({ ...state, activeThreadId: 'grok-previews', deliveredDrafts: [{ threadId: 'grok-previews', draftId }] }, command))
    rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue(''))
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled()
    expect(command.mock.calls.filter(([request]) => (request as AgentCommand).type === 'manual-send')).toHaveLength(1)
  })

  it('shows loading and retry states instead of describing unfetched history as empty', () => {
    const state = stateFixture()
    const thread = state.host.threads.find(item => item.id === state.activeThreadId)!
    thread.messages = []; thread.historyStatus = 'loading'
    const { rerender, command } = renderThreads(state)
    expect(screen.getByRole('status')).toHaveTextContent('Loading messages')
    expect(screen.queryByText('What is next for this thread?')).not.toBeInTheDocument()
    thread.historyStatus = 'error'; thread.historyError = 'Connection interrupted'
    rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Connection interrupted')
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading messages' }))
    expect(command).toHaveBeenCalledWith({ type: 'refresh' })
  })

  it('bounds initial transcript rendering and reveals earlier messages on request', () => {
    const state = stateFixture()
    state.host.threads.find(item => item.id === state.activeThreadId)!.messages = Array.from({ length: 100 }, (_, index) => ({ id: `message-${index}`, role: 'assistant', text: `History item ${index}`, createdAt: new Date(NOW).toISOString() }))
    renderThreads(state)
    expect(screen.queryByText('History item 0', { exact: true })).not.toBeInTheDocument()
    expect(screen.getByText('History item 99', { exact: true })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier messages (20)' }))
    expect(screen.getByText('History item 0', { exact: true })).toBeVisible()
  })

  it('submits provider model, reasoning, and permissions from the thread controls', async () => {
    const state = stateFixture()
    state.activeThreadId = 'grok-previews'
    const thread = state.host.threads.find(item => item.id === state.activeThreadId)!
    thread.status = 'idle'; thread.requests = []
    state.host.capabilities.configureThread = true
    state.host.models = [{ id: thread.modelId, provider: 'Grok', name: 'Current', ready: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low', runtimeModes: ['approval-required', 'full-access'] }, { id: 'alternate', name: 'Alternate', provider: 'Codex', ready: true }]
    const { command } = renderThreads(state)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread model' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Codex', exact: true }))
    fireEvent.click(screen.getByRole('option', { name: 'Alternate' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toBeEnabled())
    expect(command).toHaveBeenLastCalledWith({ type: 'configure-thread', threadId: thread.id, modelId: 'alternate' })
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Thread reasoning effort' }), { key: 'End' })
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Thread permissions' })).toBeEnabled())
    expect(command).toHaveBeenLastCalledWith({ type: 'configure-thread', threadId: thread.id, reasoningEffort: 'high' })
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread permissions' }))
    fireEvent.click(screen.getByRole('option', { name: 'Full access' }))
    await waitFor(() => expect(command).toHaveBeenLastCalledWith({ type: 'configure-thread', threadId: thread.id, runtimeMode: 'full-access' }))
  })

  it('puts Ultrathink in the visible Claude prompt and sends exactly that draft once', async () => {
    const state = stateFixture()
    state.activeThreadId = 'grok-previews'; state.assignments = []
    const thread = state.host.threads.find(item => item.id === state.activeThreadId)!
    thread.providerId = 'claude'; thread.modelId = 'claude:sonnet'; thread.status = 'idle'; thread.requests = []
    state.host.capabilities.configureThread = true
    state.host.models = [{ id: thread.modelId, provider: 'claude', providerId: 'claude', name: 'Claude', ready: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }]
    const { command } = renderThreads(state)
    const prompt = screen.getByRole('textbox', { name: 'Prompt' })
    fireEvent.change(prompt, { target: { value: 'Review this plan.' } })
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add Ultrathink to prompt' }))
    expect(prompt).toHaveValue('Review this plan.\n\nultrathink')
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'manual-send', threadId: thread.id, draftId: expect.any(String), text: 'Review this plan.\n\nultrathink' }))
    expect(prompt).toHaveValue('')
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'configure-thread' }))
  })

  it('lists open work and expands settled history without changing its lifecycle', async () => {
    const state = stateFixture()
    const { command, rerender } = renderThreads(state)
    expect(screen.getByRole('complementary', { name: 'Thread sidebar' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Footer links', exact: true })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Release notes 1.4', exact: true })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Settled 4/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Release notes 1.4', exact: true }))
    state.activeThreadId = 'release-notes'
    rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    await screen.findByRole('heading', { name: 'Release notes 1.4', exact: true })
    expect(screen.getByLabelText('Thread transcript')).toHaveTextContent('Release notes are in the draft release.')
    expect(command).toHaveBeenCalledExactlyOnceWith({ type: 'select-thread', threadId: 'release-notes' })
    expect(screen.getByRole('textbox', { name: 'Prompt', exact: true })).toBeEnabled()
  })

  it('follows the coordinator selection and protects a saved draft from another thread', () => {
    voice.enabled = true
    const state = stateFixture()
    const view = renderThreads(state)
    state.activeThreadId = 'footer-links'
    view.rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(screen.getByRole('heading', { name: 'Footer links', exact: true })).toBeVisible()
    state.draft = 'Bound to the first thread'; state.draftThreadId = 'visual-gate'
    view.rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(screen.queryByRole('textbox', { name: 'Prompt', exact: true })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open draft thread', exact: true })).toBeVisible()
  })

  it('keeps an unconfirmed manual prompt in its message, with the composer empty and blocked', async () => {
    const state = stateFixture(); state.assignments = []; state.activeThreadId = 'grok-previews'
    const { command } = renderThreads(state)
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt', exact: true }), { target: { value: 'An edited unsent prompt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt', exact: true }))
    await screen.findByRole('button', { name: 'Check again' })
    expect(screen.getByRole('button', { name: 'Send prompt', exact: true })).toBeDisabled()
    expect(command).toHaveBeenCalledWith({ type: 'manual-send', threadId: 'grok-previews', draftId: expect.any(String), text: 'An edited unsent prompt' })
    expect(screen.getByLabelText('Pending message')).toHaveTextContent('An edited unsent prompt')
    expect(screen.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('')
  })

  it('offers New thread without submitting or assigning any work', () => {
    const { command, onOpenAgents } = renderThreads(stateFixture())
    fireEvent.click(screen.getByRole('button', { name: 'New thread', exact: true }))
    expect(onOpenAgents).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'New thread' })).toBeVisible()
    expect(command).not.toHaveBeenCalled()
  })

  it('shows an empty workspace and a way to create a thread', () => {
    const state = stateFixture(); state.host.threads = []; state.queue = []
    renderThreads(state)
    expect(screen.getByRole('heading', { name: 'No threads yet.' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'Projects', exact: true })).toHaveTextContent('No open threads.')
  })

  it('searches settled history while preserving live attention in the sidebar', () => {
    renderThreads(stateFixture())
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search threads' }), { target: { value: 'codex' } })
    expect(screen.getByRole('button', { name: 'Visual gate flake', exact: true })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Release notes 1.4', exact: true })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Weekly note', exact: true })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search threads' }), { target: { value: 'not-found' } })
    expect(screen.getByText('Nothing matches "not-found".')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Visual gate flake', exact: true })).toBeVisible()
  })

  it.each([
    ['Allow', 'Approved', true],
    ['Deny', 'Denied', false],
  ] as const)('sends %s once and keeps permission decisions disabled while busy', async (choice, answer, approved) => {
    // With the coordinator on, the busy lane must also hold the pane menu's management item.
    voice.enabled = true
    const state = stateFixture()
    const { command, rerender } = renderThreads(state)
    fireEvent.click(screen.getByRole('button', { name: choice, exact: true }))
    expect(command).toHaveBeenLastCalledWith({ type: 'answer', threadId: 'visual-gate', requestId: 'visual-gate-permission', answer, approved })
    expect(screen.getByRole('button', { name: 'Allow', exact: true })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deny', exact: true })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Deny', exact: true }))
    expect(command).toHaveBeenCalledTimes(1)
    await act(async () => { await Promise.resolve() })
    vi.mocked(useAgents).mockReturnValue(connection({ ...state, globalLaneBusy: true }, command))
    rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(screen.getByRole('button', { name: 'Allow', exact: true })).toBeDisabled()
    expect(paneMenuItem(document.body, 'Pause managing')).toBeDisabled()
  })

  it('writes an answer in the selected workspace without changing pages', () => {
    const state = stateFixture()
    state.assignments = []
    state.queue[0] = { ...state.queue[0]!, kind: 'question', text: 'Which direction?' }
    state.host.threads.find(thread => thread.id === state.activeThreadId)!.requests = [{ id: 'visual-gate-permission', kind: 'question', text: 'Which direction?', options: [] }]
    const { command, onOpenAgents } = renderThreads(state)
    fireEvent.click(screen.getByRole('button', { name: 'Write an answer', exact: true }))
    expect(screen.getByRole('textbox', { name: 'Your answer', exact: true })).toHaveFocus()
    expect(command).not.toHaveBeenCalled()
    expect(onOpenAgents).not.toHaveBeenCalled()
  })
})

describe('a thread created without a round trip', () => {
  afterEach(() => draftThreads.reset())

  /** Create a thread in the workshop project from the sidebar, without waiting for anything. */
  function createThread(title: string): void {
    fireEvent.click(screen.getByRole('button', { name: 'New thread in workshop' }))
    fireEvent.change(screen.getByLabelText('Thread name'), { target: { value: title } })
    fireEvent.click(screen.getByRole('button', { name: 'Create thread' }))
  }
  const createRequest = (command: { mock: { calls: unknown[][] } }): AgentCommand & { threadId?: string } =>
    command.mock.calls.map(([request]) => request as AgentCommand).find(request => request.type === 'create-thread')! as AgentCommand & { threadId?: string }

  it('shows the pane and its composer before main answers, and keeps a draft typed meanwhile', async () => {
    const state = stateFixture()
    let settle: (value: AgentState) => void = () => undefined
    const creating = new Promise<AgentState>(resolve => { settle = resolve })
    const command = vi.fn(async (...args: unknown[]) => {
      const request = args[0] as AgentCommand
      return request.type === 'create-thread' ? creating : state
    })
    const observed: string[][] = []
    const view = (): React.ReactElement => <ThreadsView onOpenAgents={vi.fn()} now={NOW} onPaneThreadsChange={ids => observed.push([...ids])} />
    vi.mocked(useAgents).mockReturnValue(connection(state, command))
    const { rerender } = render(view())
    createThread('Fast start')
    // Nothing is awaited here: the dialog is gone and the thread is on screen already.
    expect(screen.queryByRole('dialog', { name: 'New thread' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Fast start', exact: true })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Prompt', exact: true })).toBeEnabled()
    const request = createRequest(command)
    expect(request).toMatchObject({ type: 'create-thread', projectId: 'workshop', title: 'Fast start', threadId: expect.any(String) })
    const threadId = request.threadId!
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt', exact: true }), { target: { value: 'Start on the failing test.' } })
    const arrived: AgentState['host']['threads'][number] = { id: threadId, projectId: 'workshop', title: 'Fast start', modelId: 'claude:sonnet',
      status: 'idle', messages: [], requests: [], nativeSessionStarted: false, worktree: { mode: 'independent', status: 'ready', path: 'C:/workshop-1' } }
    const published: AgentState = { ...state, activeThreadId: threadId, host: { ...state.host, threads: [...state.host.threads, arrived] } }
    // Until main has the thread, naming it to main would say nothing, so the panes reported exclude it.
    expect(observed.flat()).not.toContain(threadId)
    await act(async () => { settle(published) })
    vi.mocked(useAgents).mockReturnValue(connection(published, command))
    rerender(view())
    // Main's own record replaces the local one; the thread is listed once and the draft is untouched.
    await waitFor(() => expect(draftThreads.get()).toEqual([]))
    rerender(view())
    expect(observed.at(-1)).toEqual([threadId])
    expect(screen.getAllByRole('button', { name: 'Fast start', exact: true })).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Fast start', exact: true })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Start on the failing test.')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('takes the thread away again and reopens the dialog with the choices and the reason when main refuses', async () => {
    const state = stateFixture()
    const command = vi.fn(async (...args: unknown[]) => {
      const request = args[0] as AgentCommand
      return request.type === 'create-thread' ? { ...state, error: 'Send or clear your draft before creating another thread.' } : state
    })
    renderThreads(state, command)
    createThread('Refused thread')
    expect(screen.getByRole('heading', { name: 'Refused thread', exact: true })).toBeVisible()
    await screen.findByRole('dialog', { name: 'New thread' })
    expect(screen.getByRole('alert')).toHaveTextContent('Send or clear your draft before creating another thread.')
    expect(screen.getByLabelText('Thread name')).toHaveValue('Refused thread')
    expect(screen.getByText('Starts in the project folder. Change it under the composer.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Refused thread', exact: true })).not.toBeInTheDocument()
    expect(draftThreads.get()).toEqual([])
    // The selection returns to the thread that had it, and creation is never repeated on its own.
    expect(screen.getByRole('heading', { name: 'Visual gate flake', exact: true })).toBeVisible()
    expect(command.mock.calls.filter(([request]) => (request as AgentCommand).type === 'create-thread')).toHaveLength(1)
  })
})

describe('Agents room link', () => {
  it('offers All threads beside the room controls', () => {
    const state = stateFixture()
    const onOpenThreads = vi.fn()
    vi.mocked(useAgents).mockReturnValue(connection(state))
    render(<AgentView onOpenThreads={onOpenThreads} />)
    fireEvent.click(screen.getByRole('button', { name: 'All threads' }))
    expect(onOpenThreads).toHaveBeenCalledTimes(1)
  })
})

describe('sidebar foot rooms', () => {
  it('offers Dictate and Threads for the beta, and Agents only with the voice coordinator on', () => {
    const view = renderThreads(stateFixture())
    const rooms = () => within(screen.getByRole('tablist', { name: 'Page' })).getAllByRole('tab').map(tab => tab.textContent)
    expect(rooms()).toEqual(['Dictate', 'Threads'])
    voice.enabled = true
    view.rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(rooms()).toEqual(['Dictate', 'Agents', 'Threads'])
  })
})


describe('monitoring in the thread composer', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('keeps the draft and creature while live evidence updates, then removes only the perch', () => {
    const state = stateFixture(); state.assignments = []; state.activeThreadId = 'footer-links'
    const thread = state.host.threads.find(item => item.id === 'footer-links')!
    thread.monitoring = [{ id: '56d13d2c-f6d0-4968-a9ed-18c87a7d5b5a', label: 'Watch the build' }]
    const view = renderThreads(state)
    const prompt = screen.getByRole('textbox', { name: 'Prompt', exact: true })
    fireEvent.change(prompt, { target: { value: 'Keep my draft' } })
    const creature = view.container.querySelector('.thread-monitor__creature')
    expect(creature).not.toBeNull()
    thread.monitoring[0]!.label = 'Waiting for build completion'
    view.rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(view.container.querySelector('.thread-monitor__creature')).toBe(creature)
    expect(screen.getByText('Waiting for build completion')).toBeVisible()
    thread.monitoring = []
    view.rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(view.container.querySelector('.thread-monitor')).toBeNull()
    expect(prompt).toHaveValue('Keep my draft')
  })

  it.each(['unconfirmed', 'disconnected', 'settled', 'archived', 'error', 'permission', 'question', 'blocked'] as const)(
    'hides the creature for %s even if old evidence is present', reason => {
      const state = stateFixture(); state.assignments = []; state.activeThreadId = 'footer-links'
      const thread = state.host.threads.find(item => item.id === 'footer-links')!
      thread.monitoring = [{ id: '56d13d2c-f6d0-4968-a9ed-18c87a7d5b5a', label: 'Watch the build' }]
      if (reason === 'unconfirmed') delete thread.monitoring
      if (reason === 'disconnected') state.host.connected = false
      if (reason === 'settled') thread.settledOverride = 'settled'
      if (reason === 'archived') thread.archivedAt = new Date(NOW).toISOString()
      if (reason === 'error') thread.status = 'error'
      if (reason === 'blocked') state.queue.push({ id: 'monitor-blocked', threadId: thread.id, kind: 'blocked', text: 'Your decision is needed.', createdAt: new Date(NOW).toISOString(), deferred: false })
      if (reason === 'permission' || reason === 'question') thread.requests = [{ id: 'monitor-attention', kind: reason, text: 'Your answer is needed.', options: [] }]
      const view = renderThreads(state)
      expect(view.container.querySelector('.thread-monitor')).toBeNull()
    })
})

describe('background work in the thread composer', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const work = (count: number) => Array.from({ length: count }, (_, index) => ({
    id: `6f0c1a2e-8f4b-4d3c-9a1e-${String(index).padStart(12, '0')}`, label: `Agent ${index + 1}`, type: 'subagent' as const,
  }))
  const watched = () => {
    const state = stateFixture(); state.assignments = []; state.activeThreadId = 'footer-links'
    return { state, thread: state.host.threads.find(item => item.id === 'footer-links')! }
  }
  const ornament = (view: ReturnType<typeof renderThreads>) => view.container.querySelector<HTMLElement>('.thread-monitor')

  it('reads Working for one task, names every task in the title and keeps the polite status region', () => {
    const { state, thread } = watched()
    thread.backgroundWork = [{ id: '6f0c1a2e-8f4b-4d3c-9a1e-000000000000', label: 'Review the diff for standards', type: 'workflow' }]
    const view = renderThreads(state)
    const node = ornament(view)!
    expect(node.dataset.ornament).toBe('working')
    expect(node).toHaveAttribute('role', 'status')
    expect(node).toHaveAttribute('aria-live', 'polite')
    expect(node.querySelector('.thread-monitor__label')).toHaveTextContent('Review the diff for standards')
    expect(node.querySelector('.thread-monitor__status')).toHaveTextContent(/^Working$/u)
    expect(node.querySelectorAll('.thread-monitor__mini')).toHaveLength(1)
    expect(node.querySelector('.thread-monitor__mini')).toHaveAttribute('aria-hidden', 'true')
  })

  it('counts every agent in the readout but sends out no more than six', () => {
    const { state, thread } = watched()
    thread.backgroundWork = work(3)
    const view = renderThreads(state)
    expect(ornament(view)!.querySelector('.thread-monitor__status')).toHaveTextContent('Working · 3 agents')
    expect(ornament(view)!.querySelector('.thread-monitor__task')).toHaveAttribute('title', 'Agent 1\nAgent 2\nAgent 3')
    expect(ornament(view)!.querySelectorAll('.thread-monitor__mini')).toHaveLength(3)
    thread.backgroundWork = work(9)
    view.rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(ornament(view)!.querySelector('.thread-monitor__status')).toHaveTextContent('Working · 9 agents')
    expect(ornament(view)!.querySelectorAll('.thread-monitor__mini')).toHaveLength(6)
    thread.backgroundWork = []
    view.rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(ornament(view)).toBeNull()
  })

  it('gives the track to a confirmed watch first, then to background work, then to a held action', () => {
    const { state, thread } = watched()
    thread.status = 'running'
    thread.activities = [
      { id: 'held-turn', turnId: 'held-turn', sequence: 0, kind: 'turn', status: 'running', title: 'Turn' },
      { id: 'held-command', turnId: 'held-turn', sequence: 1, kind: 'command', status: 'running', title: 'Bash', command: 'npm run build', startedAt: new Date(NOW - 60_000).toISOString() },
    ]
    thread.backgroundWork = work(2)
    thread.monitoring = [{ id: '56d13d2c-f6d0-4968-a9ed-18c87a7d5b5a', label: 'Watch the build' }]
    const view = renderThreads(state)
    expect(view.container.querySelectorAll('.thread-monitor')).toHaveLength(1)
    expect(ornament(view)!.dataset.ornament).toBe('monitoring')
    thread.monitoring = []
    view.rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(ornament(view)!.dataset.ornament).toBe('working')
    thread.backgroundWork = []
    view.rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(ornament(view)!.dataset.ornament).toBe('held')
  })

  it.each(['disconnected', 'settled', 'archived', 'error', 'permission', 'question', 'blocked'] as const)(
    'hides the working creature for %s even though the work is still reported', reason => {
      const { state, thread } = watched()
      thread.backgroundWork = work(2)
      if (reason === 'disconnected') state.host.connected = false
      if (reason === 'settled') thread.settledOverride = 'settled'
      if (reason === 'archived') thread.archivedAt = new Date(NOW).toISOString()
      if (reason === 'error') thread.status = 'error'
      if (reason === 'blocked') state.queue.push({ id: 'working-blocked', threadId: thread.id, kind: 'blocked', text: 'Your decision is needed.', createdAt: new Date(NOW).toISOString(), deferred: false })
      if (reason === 'permission' || reason === 'question') thread.requests = [{ id: 'working-attention', kind: reason, text: 'Your answer is needed.', options: [] }]
      const view = renderThreads(state)
      expect(ornament(view)).toBeNull()
    })
})
