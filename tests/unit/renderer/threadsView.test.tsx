import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { defaultAgentConfiguration, type AgentCommand, type AgentState } from '../../../src/shared/agents'
import { designThreadsFixture, E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { AgentView } from '../../../src/renderer/src/agents/AgentView'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { describeThreads, groupThreads, listThreads, providerKey } from '../../../src/renderer/src/agents/threadFacts'
import { liveAgentState, openSidebarFolders } from './liveAgentState'
import { paneMenuItem } from './paneMenu'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { draftThreads } from '../../../src/renderer/src/agents/draftThreads'
import { requestAnswerStore } from '../../../src/renderer/src/agents/requests/requestAnswers'
import { handleOf } from '../../fixtures/stagedImages'
import type { AgentAttachmentStageRequest } from '../../../src/shared/agents'
import { agentContextFixture } from '../../fixtures/agentContext'

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
  }
}

let connectionStores = new WeakMap<ReturnType<typeof useAgents>['command'], ThreadDraftStore>()
function connection(state: AgentState | null, command = vi.fn(async () => state)): ReturnType<typeof useAgents> {
  let threadDrafts = connectionStores.get(command)
  if (!threadDrafts) { threadDrafts = new ThreadDraftStore(command); connectionStores.set(command, threadDrafts) }
  if (state) { threadDrafts.receive(state); openSidebarFolders(state) }
  return { ...agentContextFixture(state, command), threadDrafts }
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
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeEnabled()
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
    // The composer stages each screenshot with main; this stands in for main's answer (ADR-0031).
    const bridge = window.sotto
    vi.stubGlobal('sotto', { ...bridge, agents: { ...bridge?.agents, stageAttachment: async (request: AgentAttachmentStageRequest) => handleOf(request.bytes, crypto.randomUUID(), request.name) } })
    onTestFinished(() => { vi.unstubAllGlobals() })
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

  it('keeps a screenshot pasted just before moving to another thread in the draft it was pasted into', async () => {
    // The composer stages each screenshot with main; this stands in for main's answer (ADR-0031).
    const bridge = window.sotto
    vi.stubGlobal('sotto', { ...bridge, agents: { ...bridge?.agents, stageAttachment: async (request: AgentAttachmentStageRequest) => handleOf(request.bytes, crypto.randomUUID(), request.name) } })
    onTestFinished(() => { vi.unstubAllGlobals() })
    const state = stateFixture(); state.assignments = []; state.activeThreadId = 'grok-previews'
    state.host.models.forEach(model => { model.supportsImages = true })
    const { command, rerender } = renderThreads(state)
    const drafts = connectionStores.get(command)!
    fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: [new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'moving.png', { type: 'image/png' })] } })
    // The user moves on before the screenshot has been read.
    state.activeThreadId = 'release-notes'
    rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    await waitFor(() => expect(drafts.draft('grok-previews').attachments).toEqual([expect.objectContaining({ name: 'moving.png' })]))
    expect(drafts.draft('release-notes').attachments).toEqual([])
    expect(screen.queryByRole('img', { name: 'moving.png' })).not.toBeInTheDocument()
    state.activeThreadId = 'grok-previews'
    rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    // The chip names the image while its thumbnail is drawn, then shows the thumbnail under the same name.
    await waitFor(() => expect(screen.getByRole('img', { name: 'moving.png' })).toBeVisible())
  })

  it('holds Send on a thread left and returned to until the screenshot pasted before leaving has landed', async () => {
    // The decode waits until the test lets it finish, so the read outlasts the move away and back.
    let decoded: () => void = () => undefined
    const bridge = window.sotto
    vi.stubGlobal('sotto', { ...bridge, agents: { ...bridge?.agents, stageAttachment: async (request: AgentAttachmentStageRequest) => handleOf(request.bytes, crypto.randomUUID(), request.name) } })
    onTestFinished(() => { vi.unstubAllGlobals() })
    vi.stubGlobal('createImageBitmap', async () => { await new Promise<void>(resolve => { decoded = resolve }); return { width: 3840, height: 2160, close: () => undefined } })
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(readonly width: number, readonly height: number) {}
      getContext() { return { drawImage: () => undefined } }
      async convertToBlob({ type }: { type: string }) { return new Blob([new Uint8Array(4)], { type }) }
    })
    try {
      const state = stateFixture(); state.assignments = []; state.activeThreadId = 'grok-previews'
      state.host.models.forEach(model => { model.supportsImages = true })
      const { command, rerender } = renderThreads(state)
      const drafts = connectionStores.get(command)!
      fireEvent.change(screen.getByRole('textbox', { name: /prompt/i }), { target: { value: 'Look at this' } })
      fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: [new File([new Uint8Array(64)], 'moving.png', { type: 'image/png' })] } })
      state.activeThreadId = 'release-notes'
      rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
      state.activeThreadId = 'grok-previews'
      rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
      // Back on the thread with the screenshot still being read: the text alone must not go out without it.
      expect(await screen.findByText('Adding screenshots...')).toBeVisible()
      expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled()
      decoded()
      expect(await screen.findByRole('img', { name: 'moving.png' })).toBeVisible()
      expect(drafts.draft('grok-previews').attachments).toEqual([expect.objectContaining({ name: 'moving.png' })])
      await waitFor(() => expect(screen.getByRole('button', { name: 'Send prompt' })).toBeEnabled())
    } finally { vi.unstubAllGlobals() }
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
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }))
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
    expect(screen.getByRole('button', { name: 'Footer links' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Release notes 1.4' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Settled 4/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Release notes 1.4' }))
    state.activeThreadId = 'release-notes'
    rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    await screen.findByRole('heading', { name: 'Release notes 1.4' })
    expect(screen.getByLabelText('Thread transcript')).toHaveTextContent('Release notes are in the draft release.')
    expect(command).toHaveBeenCalledExactlyOnceWith({ type: 'select-thread', threadId: 'release-notes' })
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeEnabled()
  })

  it('follows the coordinator selection and protects a saved draft from another thread', () => {
    voice.enabled = true
    const state = stateFixture()
    const view = renderThreads(state)
    state.activeThreadId = 'footer-links'
    view.rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(screen.getByRole('heading', { name: 'Footer links' })).toBeVisible()
    state.draft = 'Bound to the first thread'; state.draftThreadId = 'visual-gate'
    view.rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(screen.queryByRole('textbox', { name: 'Prompt' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open draft thread' })).toBeVisible()
  })

  it('keeps an unconfirmed manual prompt in its message, with the composer empty and blocked', async () => {
    const state = stateFixture(); state.assignments = []; state.activeThreadId = 'grok-previews'
    const { command } = renderThreads(state)
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'An edited unsent prompt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }))
    await screen.findByRole('button', { name: 'Check again' })
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled()
    expect(command).toHaveBeenCalledWith({ type: 'manual-send', threadId: 'grok-previews', draftId: expect.any(String), text: 'An edited unsent prompt' })
    expect(screen.getByLabelText('Pending message')).toHaveTextContent('An edited unsent prompt')
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('')
  })

  it('offers New thread without submitting or assigning any work', () => {
    const { command, onOpenAgents } = renderThreads(stateFixture())
    fireEvent.click(screen.getByRole('button', { name: 'New thread' }))
    expect(onOpenAgents).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'New thread' })).toBeVisible()
    expect(command).not.toHaveBeenCalled()
  })

  it('shows an empty workspace and a way to create a thread', () => {
    const state = stateFixture(); state.host.threads = []; state.queue = []
    renderThreads(state)
    expect(screen.getByRole('heading', { name: 'No threads yet.' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'Projects' })).toHaveTextContent('No open threads.')
  })

  it('opens a thread in the active project at once from the empty workspace’s own button', async () => {
    const state = stateFixture(); state.host.threads = []; state.queue = []
    const { command } = renderThreads(state)
    const emptyPageButton = screen.getAllByRole('button', { name: 'New thread' }).find(button => button.closest('.thread-workspace__empty'))!
    fireEvent.click(emptyPageButton)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'New thread' })).toBeVisible())
    expect(screen.queryByRole('dialog', { name: 'New thread' })).not.toBeInTheDocument()
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'create-thread', projectId: 'workshop' }))
    // The fixture's command never carries the draft into main's own state, so it is forgotten by hand here.
    draftThreads.reset()
  })

  it('shows a failed provider connection on the empty workspace and leaves Connect providers usable', () => {
    const state = stateFixture()
    state.host.threads = []; state.host.connected = false; state.queue = []; state.activeThreadId = null
    state.connection = 'disconnected'
    state.error = 'Install Codex and sign in before connecting this provider.'
    const view = renderThreads(state)
    expect(screen.getByRole('alert')).toHaveTextContent('Install Codex and sign in before connecting this provider.')
    expect(screen.getByRole('button', { name: 'Connect providers' })).toBeEnabled()
    state.connection = 'connecting'; state.error = null
    view.rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(screen.getByRole('button', { name: 'Connecting...' })).toBeDisabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('searches settled history while preserving live attention in the sidebar', () => {
    renderThreads(stateFixture())
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search threads' }), { target: { value: 'codex' } })
    expect(screen.getByRole('button', { name: 'Visual gate flake' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Release notes 1.4' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Weekly note' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search threads' }), { target: { value: 'not-found' } })
    expect(screen.getByText('Nothing matches "not-found".')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Visual gate flake' })).toBeVisible()
  })

  it.each([
    ['Allow', 'Approved', true],
    ['Deny', 'Denied', false],
  ] as const)('sends %s once and keeps permission decisions disabled while busy', async (choice, answer, approved) => {
    // With the coordinator on, the busy lane must also hold the pane menu's management item.
    voice.enabled = true
    const state = stateFixture()
    const { command, rerender } = renderThreads(state)
    fireEvent.click(screen.getByRole('button', { name: choice }))
    expect(command).toHaveBeenLastCalledWith({ type: 'answer', threadId: 'visual-gate', requestId: 'visual-gate-permission', answer, approved })
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(command).toHaveBeenCalledTimes(1)
    await act(async () => { await Promise.resolve() })
    vi.mocked(useAgents).mockReturnValue(connection({ ...state, globalLaneBusy: true }, command))
    rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled()
    expect(paneMenuItem(document.body, 'Pause managing')).toBeDisabled()
  })

  it('writes an answer in the selected workspace without changing pages', () => {
    const state = stateFixture()
    state.assignments = []
    state.queue[0] = { ...state.queue[0]!, kind: 'question', text: 'Which direction?' }
    state.host.threads.find(thread => thread.id === state.activeThreadId)!.requests = [{ id: 'visual-gate-permission', kind: 'question', text: 'Which direction?', options: [] }]
    const { command, onOpenAgents } = renderThreads(state)
    fireEvent.click(screen.getByRole('button', { name: 'Write an answer' }))
    expect(screen.getByRole('textbox', { name: 'Your answer' })).toHaveFocus()
    expect(command).not.toHaveBeenCalled()
    expect(onOpenAgents).not.toHaveBeenCalled()
  })
})

describe('a thread created without a round trip', () => {
  afterEach(() => draftThreads.reset())

  /** Press the pen on the workshop project row: no dialog, the thread opens on defaults at once (issue #347). */
  function createThread(): void {
    fireEvent.click(screen.getByRole('button', { name: 'New thread in workshop' }))
  }
  const createRequest = (command: { mock: { calls: unknown[][] } }): (AgentCommand & { threadId?: string }) | undefined =>
    command.mock.calls.map(([request]) => request as AgentCommand).find(request => request.type === 'create-thread') as (AgentCommand & { threadId?: string }) | undefined

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
    createThread()
    // Nothing is typed and no dialog opens: the thread is on screen, named and focused, before main answers.
    expect(screen.queryByRole('dialog', { name: 'New thread' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'New thread' })).toBeVisible())
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeEnabled()
    const request = await waitFor(() => { const found = createRequest(command); expect(found).toBeDefined(); return found! })
    expect(request).toMatchObject({ type: 'create-thread', projectId: 'workshop', title: 'New thread', titleSource: 'default', managed: false, threadId: expect.any(String) })
    const threadId = request.threadId!
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Start on the failing test.' } })
    const arrived: AgentState['host']['threads'][number] = { id: threadId, projectId: 'workshop', title: 'New thread', modelId: 'claude:sonnet',
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
    expect(within(screen.getByRole('region', { name: 'Projects' })).getAllByRole('button', { name: 'New thread' })).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'New thread' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Start on the failing test.')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the refusal in the sidebar and takes the thread away again without repeating the creation', async () => {
    const state = stateFixture()
    const command = vi.fn(async (...args: unknown[]) => {
      const request = args[0] as AgentCommand
      return request.type === 'create-thread' ? { ...state, error: 'Send or clear your draft before creating another thread.' } : state
    })
    renderThreads(state, command)
    createThread()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'New thread' })).toBeVisible())
    expect(screen.queryByRole('dialog', { name: 'New thread' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Send or clear your draft before creating another thread.'))
    expect(screen.getByRole('alert')).not.toHaveTextContent('are kept')
    expect(screen.queryByRole('heading', { name: 'New thread' })).not.toBeInTheDocument()
    expect(draftThreads.get()).toEqual([])
    // The selection returns to the thread that had it, and creation is never repeated on its own.
    expect(screen.getByRole('heading', { name: 'Visual gate flake' })).toBeVisible()
    expect(command.mock.calls.filter(([request]) => (request as AgentCommand).type === 'create-thread')).toHaveLength(1)
  })

  it.each(['unsent', 'sent', 'sent with newer typing', 'sent with overflow', 'sent after navigation', 'sent into reused thread'])('recovers the %s prompt and staged images after creation is refused', async mode => {
    const state = stateFixture()
    let settle: (value: AgentState) => void = () => undefined
    const refusing = new Promise<AgentState>(resolve => { settle = resolve })
    let creations = 0
    const command = vi.fn(async (...args: unknown[]) => {
      const request = args[0] as AgentCommand
      return request.type === 'create-thread' && ++creations === 1 ? refusing : state
    })
    const view = renderThreads(state, command)
    createThread()
    await screen.findByRole('heading', { name: 'New thread' })
    const firstId = createRequest(command)!.threadId!
    const newThread = draftThreads.get().find(thread => thread.id === firstId)!
    const store = connectionStores.get(command)!
    const image = handleOf(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 'recover-image', 'recover.png')
    const images = mode === 'sent with overflow' ? Array.from({ length: 8 }, (_, index) => ({ ...image, id: `recover-${index}`, name: `recover-${index}.png` })) : [image]
    act(() => store.edit(firstId, { text: 'Keep this prompt.', attachments: images }))
    if (mode !== 'unsent') fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }))
    if (mode === 'sent with newer typing' || mode === 'sent with overflow') {
      act(() => store.edit(firstId, { text: 'And this next thought.', attachments: [{ ...image, id: 'newer-image', name: 'newer.png' }] }))
    }
    await act(async () => { settle({ ...state, error: 'That model is unavailable.' }) })
    await screen.findByRole('alert')
    expect(screen.getByRole('alert')).toHaveTextContent('That model is unavailable. Your prompt and screenshots are kept. Open New thread in workshop to get them back.')
    expect(screen.queryByRole('heading', { name: 'New thread' })).not.toBeInTheDocument()
    if (mode === 'sent after navigation') { view.unmount(); renderThreads(state, command) }
    if (mode === 'sent into reused thread') {
      const reusedState: AgentState = { ...state, activeThreadId: 'reusable', host: { ...state.host, threads: [...state.host.threads, { ...newThread, id: 'reusable', titleSource: 'default' }] } }
      act(() => store.edit('reusable', { text: 'Already here.' }))
      vi.mocked(useAgents).mockReturnValue(connection(reusedState, command))
      view.rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    }
    createThread()
    await screen.findByRole('heading', { name: 'New thread' })
    const requests = command.mock.calls.map(([request]) => request as AgentCommand).filter(request => request.type === 'create-thread')
    const nextId = mode === 'sent into reused thread' ? 'reusable' : (requests[1] as Extract<AgentCommand, { type: 'create-thread' }>).threadId!
    expect(requests).toHaveLength(mode === 'sent into reused thread' ? 1 : 2)
    expect(store.draft(nextId).text).toBe(mode === 'sent with newer typing' ? 'Keep this prompt.\n\nAnd this next thought.' : mode === 'sent into reused thread' ? 'Keep this prompt.\n\nAlready here.' : 'Keep this prompt.')
    expect(store.draft(nextId).attachments.map(attachment => attachment.name)).toEqual(mode === 'sent with newer typing' ? ['recover.png', 'newer.png'] : images.map(image => image.name))
    if (mode === 'sent with overflow') {
      expect(screen.getAllByRole('status').some(status => status.textContent === 'Not sent')).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: 'Restore prompt' }))
      expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('And this next thought.')
      expect(store.draft(nextId).attachments.map(attachment => attachment.name)).toEqual(['newer.png'])
      fireEvent.click(screen.getByRole('button', { name: 'Restore prompt' }))
      expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Keep this prompt.')
      expect(store.draft(nextId).attachments).toEqual(images)
    }
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'manual-send' }))
  })

  it('does not recover a sent prompt when published creation precedes a lost command reply', async () => {
    const state = stateFixture()
    let settle: (value: AgentState | null) => void = () => undefined
    const creating = new Promise<AgentState | null>(resolve => { settle = resolve })
    const command = vi.fn(async (...args: unknown[]) => (args[0] as AgentCommand).type === 'create-thread' ? creating : state)
    vi.mocked(useAgents).mockReturnValue(connection(state, command))
    const { rerender } = render(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    createThread()
    await screen.findByRole('heading', { name: 'New thread' })
    const threadId = createRequest(command)!.threadId!
    const arrived = { ...draftThreads.get()[0]!, nativeSessionStarted: true }
    const published = { ...state, activeThreadId: threadId, host: { ...state.host, threads: [...state.host.threads, arrived] } }
    const connected = connection(published, command)
    vi.mocked(useAgents).mockReturnValue(connected)
    rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    await waitFor(() => expect(draftThreads.get()).toEqual([]))
    connected.threadDrafts.edit(threadId, { text: 'Already sent to the live thread.' })
    connected.threadDrafts.submit(threadId, NOW)
    await act(async () => { settle(null) })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    connected.threadDrafts.restoreRefusedCreation('another-thread', 'workshop')
    expect(connected.threadDrafts.draft('another-thread').text).toBe('')
  })

  it.each([false, true])('keeps a screenshot whose staging finishes after refusal (after reopening: %s)', async reopenFirst => {
    const state = stateFixture()
    state.host.models.forEach(model => { model.supportsImages = true })
    let refuse: (state: AgentState) => void = () => undefined
    const creating = new Promise<AgentState>(resolve => { refuse = resolve })
    let creations = 0
    const command = vi.fn(async (...args: unknown[]) => (args[0] as AgentCommand).type === 'create-thread' && ++creations === 1 ? creating : state)
    let finishStaging: (handle: ReturnType<typeof handleOf>) => void = () => undefined
    const stageAttachment = vi.fn(() => new Promise<ReturnType<typeof handleOf>>(resolve => { finishStaging = resolve }))
    vi.stubGlobal('sotto', { agents: { stageAttachment } })
    onTestFinished(() => { vi.unstubAllGlobals() })
    renderThreads(state, command)
    createThread()
    await screen.findByRole('heading', { name: 'New thread' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Keep the pending screenshot.' } })
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: [new File([bytes], 'late.png', { type: 'image/png' })] } })
    await waitFor(() => expect(stageAttachment).toHaveBeenCalledOnce())
    await act(async () => { refuse({ ...state, error: 'That model is unavailable.' }) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Your prompt and screenshots are kept. Open New thread in workshop to get them back.')
    await screen.findByRole('alert')
    if (reopenFirst) {
      createThread()
      await screen.findByRole('heading', { name: 'New thread' })
      expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled()
    }
    await act(async () => { finishStaging(handleOf(bytes, 'late', 'late.png')) })
    if (!reopenFirst) { createThread(); await screen.findByRole('heading', { name: 'New thread' }) }
    await waitFor(() => expect(screen.getByRole('img', { name: 'late.png' })).toBeVisible())
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Keep the pending screenshot.')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send prompt' })).toBeEnabled())
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'manual-send' }))
  })

  it('carries text typed before a refusal to the next new thread opened in the same project', async () => {
    const state = stateFixture()
    let settle: (value: AgentState) => void = () => undefined
    const refusing = new Promise<AgentState>(resolve => { settle = resolve })
    let creations = 0
    const command = vi.fn(async (...args: unknown[]) => {
      const request = args[0] as AgentCommand
      if (request.type !== 'create-thread') return state
      creations += 1
      return creations === 1 ? refusing : state
    })
    renderThreads(state, command)
    createThread()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'New thread' })).toBeVisible())
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeEnabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Do not lose this.' } })
    await act(async () => { settle({ ...state, error: 'Send or clear your draft before creating another thread.' }) })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Send or clear your draft before creating another thread.'))
    expect(screen.queryByRole('heading', { name: 'New thread' })).not.toBeInTheDocument()
    // The refused draft's own pane is gone, but its text opens with the project's next new thread.
    createThread()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'New thread' })).toBeVisible())
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Do not lose this.')
  })
})

describe('Ctrl+Shift+N opens a new thread (issue #347)', () => {
  afterEach(() => draftThreads.reset())

  it('opens a thread in the focused thread’s project, with no dialog', async () => {
    const state = stateFixture()
    const { command } = renderThreads(state)
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'New thread' })).toBeVisible())
    expect(screen.queryByRole('dialog', { name: 'New thread' })).not.toBeInTheDocument()
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'create-thread', projectId: 'workshop' }))
  })

  it('opens the project chooser when no thread is focused', () => {
    const state = { ...stateFixture(), activeThreadId: null }
    renderThreads(state)
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true, shiftKey: true })
    expect(screen.getByRole('dialog', { name: 'New thread' })).toBeInTheDocument()
  })

  it('leaves an already-open dialog its own keys', () => {
    const state = { ...stateFixture(), activeThreadId: null }
    renderThreads(state)
    fireEvent.click(within(screen.getByRole('complementary')).getByRole('button', { name: 'New thread' }))
    const dialog = screen.getByRole('dialog', { name: 'New thread' })
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true, shiftKey: true })
    // Still exactly one dialog: the shortcut did nothing while one was already open.
    expect(screen.getAllByRole('dialog', { name: 'New thread' })).toEqual([dialog])
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
    const prompt = screen.getByRole('textbox', { name: 'Prompt' })
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

  const command = (label: string, index = 0, startedAt = new Date(NOW - 252_000).toISOString()) => ({
    id: `7a1d2b3c-8f4b-4d3c-9a1e-${String(index).padStart(12, '0')}`, label, type: 'command' as const, startedAt,
  })

  it('waits on a command left running once the turn is over, named by its description and counted from its start', () => {
    const { state, thread } = watched()
    thread.status = 'idle'
    thread.backgroundWork = [command('Run all CI gates')]
    const view = renderThreads(state)
    const node = ornament(view)!
    expect(node.dataset.ornament).toBe('held')
    expect(node.querySelector('.thread-monitor__label')).toHaveTextContent('Run all CI gates')
    expect(node.querySelector('.thread-monitor__status')).toHaveTextContent('Waiting · 4m 12s')
    thread.backgroundWork = [command('Run all CI gates'), command('Watch the dev server', 1)]
    view.rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(ornament(view)!.querySelector('.thread-monitor__status')).toHaveTextContent('Waiting · 2 commands · 4m 12s')
    expect(ornament(view)!.querySelector('.thread-monitor__task')).toHaveAttribute('title', 'Run all CI gates\nWatch the dev server')
    thread.backgroundWork = []
    view.rerender(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(ornament(view)).toBeNull()
  })

  it('leaves a live turn to its own held action, even with a command in the background', () => {
    const { state, thread } = watched()
    thread.status = 'running'
    thread.backgroundWork = [command('Run all CI gates')]
    const view = renderThreads(state)
    expect(ornament(view)).toBeNull()
  })

  it('lets agents lead and counts a command running beside them', () => {
    const { state, thread } = watched()
    thread.status = 'idle'
    thread.backgroundWork = [...work(2), command('Run all CI gates')]
    const view = renderThreads(state)
    const node = ornament(view)!
    expect(node.dataset.ornament).toBe('working')
    expect(node.querySelector('.thread-monitor__label')).toHaveTextContent('Agent 1')
    expect(node.querySelector('.thread-monitor__status')).toHaveTextContent('Working · 2 agents · 1 command')
    expect(node.querySelectorAll('.thread-monitor__mini')).toHaveLength(2)
    expect(node.querySelector('.thread-monitor__task')).toHaveAttribute('title', 'Agent 1\nAgent 2\nRun all CI gates')
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
