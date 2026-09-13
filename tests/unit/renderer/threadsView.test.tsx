import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultAgentConfiguration, type AgentCommand, type AgentState } from '../../../src/shared/agents'
import { designThreadsFixture, E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { AgentView } from '../../../src/renderer/src/agents/AgentView'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { describeThreads, groupThreads, listThreads, lookingAfterSentence, providerKey } from '../../../src/renderer/src/agents/threadFacts'
import { liveAgentState } from './liveAgentState'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

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
    pendingRequest: '', busy: false, notice: '', error: null,
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

beforeEach(() => { vi.mocked(useAgents).mockReset(); connectionStores = new WeakMap() })
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
    expect(byTitle('Visual gate flake')).toMatchObject({ state: 'needs', stateLabel: 'Waiting on you', provider: 'Claude', providerKey: 'claude', management: 'managed', attention: true })
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

  it('says in the footer how many threads Sotto is looking after and how to talk to them', () => {
    expect(lookingAfterSentence(3)).toBe('Sotto is looking after 3 threads. Say “Hey Sotto” to talk to any of them.')
    expect(lookingAfterSentence(1)).toBe('Sotto is looking after 1 thread. Say “Hey Sotto” to talk to it.')
    expect(lookingAfterSentence(0)).toBe('Nothing is running. Say “Hey Sotto” to start a thread.')
    const running = stateFixture().host.threads.filter(thread => thread.status === 'running').length
    expect(lookingAfterSentence(running)).toMatch(/^Sotto is looking after 3 threads\./u)
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
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Show this pending message immediately.')
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

  for (const edited of [false, true]) it(`handles a late manual delivery receipt with ${edited ? 'replacement images preserved' : 'the unchanged draft cleared'}`, async () => {
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
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled()
    if (edited) {
      fireEvent.click(screen.getByRole('button', { name: 'Remove same-name.png' }))
      fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: [imageFile()] } })
      await screen.findByRole('img', { name: 'same-name.png' })
    }
    vi.mocked(useAgents).mockReturnValue(connection({ ...state, deliveredDrafts: [{ threadId: 'grok-previews', draftId }] }, command))
    rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue(edited ? 'Review this' : ''))
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
    fireEvent.click(screen.getByRole('button', { name: 'Codex', exact: true }))
    fireEvent.click(screen.getByRole('option', { name: 'Alternate' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toBeEnabled())
    expect(command).toHaveBeenLastCalledWith({ type: 'configure-thread', threadId: thread.id, modelId: 'alternate' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Thread reasoning' }), { target: { value: 'high' } })
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Thread permissions' })).toBeEnabled())
    expect(command).toHaveBeenLastCalledWith({ type: 'configure-thread', threadId: thread.id, reasoningEffort: 'high' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Thread permissions' }), { target: { value: 'full-access' } })
    await waitFor(() => expect(command).toHaveBeenLastCalledWith({ type: 'configure-thread', threadId: thread.id, runtimeMode: 'full-access' }))
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

  it('retains an edited manual prompt when a retry only reconciles an earlier action', async () => {
    const state = stateFixture(); state.assignments = []; state.activeThreadId = 'grok-previews'
    const { command } = renderThreads(state)
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt', exact: true }), { target: { value: 'An edited unsent prompt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt', exact: true }))
    await screen.findByRole('button', { name: 'Check again' })
    expect(screen.getByRole('button', { name: 'Send prompt', exact: true })).toBeDisabled()
    expect(command).toHaveBeenCalledWith({ type: 'manual-send', threadId: 'grok-previews', draftId: expect.any(String), text: 'An edited unsent prompt' })
    expect(screen.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('An edited unsent prompt')
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

  it('keeps permission decisions explicit and disables them while busy', () => {
    const state = stateFixture()
    const { command, rerender } = renderThreads(state)
    fireEvent.click(screen.getByRole('button', { name: 'Allow', exact: true }))
    expect(command).toHaveBeenLastCalledWith({ type: 'answer', threadId: 'visual-gate', requestId: 'visual-gate-permission', answer: 'Approved', approved: true })
    fireEvent.click(screen.getByRole('button', { name: 'Deny', exact: true }))
    expect(command).toHaveBeenLastCalledWith({ type: 'answer', threadId: 'visual-gate', requestId: 'visual-gate-permission', answer: 'Denied', approved: false })
    vi.mocked(useAgents).mockReturnValue(connection({ ...state, busy: true }, command))
    rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(screen.getByRole('button', { name: 'Allow', exact: true })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Pause managing', exact: true })).toBeDisabled()
  })

  it('writes an answer in the selected workspace without changing pages', () => {
    const state = stateFixture()
    state.assignments = []
    state.queue[0] = { ...state.queue[0]!, kind: 'question', text: 'Which direction?' }
    const { command, onOpenAgents } = renderThreads(state)
    fireEvent.click(screen.getByRole('button', { name: 'Write an answer', exact: true }))
    expect(screen.getByRole('textbox', { name: 'Your answer', exact: true })).toHaveFocus()
    expect(command).not.toHaveBeenCalled()
    expect(onOpenAgents).not.toHaveBeenCalled()
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
