import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentRequest, AgentState, AgentThread } from '../../../src/shared/agents'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import type { WatcherIdentity } from '../../../src/shared/watcher'
import type { WatcherBridge, WatcherRoomResult, WatcherRoomState } from '../../../src/shared/watcherRoom'
import type { AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useAgents, useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { SidebarChromeProvider } from '../../../src/renderer/src/agents/SidebarFrame'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { WatcherRoomProvider } from '../../../src/renderer/src/watcher/watcherRoom'
import { roomView } from '../../../src/renderer/src/watcher/WatcherBeside'
import { WatcherView } from '../../../src/renderer/src/watcher/WatcherView'
import { WatcherAfterMessage } from '../../../src/renderer/src/watcher/WatcherReceipts'
import { placeAsks, receiptWords, type WatcherAskPlacement } from '../../../src/renderer/src/watcher/WatcherAsks'
import { answeredChoices, answerWords, chosenWords, OWN_WORDS } from '../../../src/renderer/src/agents/requests/answeredChoices'
import { requestAnswerOwnerKey, requestAnswerStore } from '../../../src/renderer/src/agents/requests/requestAnswers'
import { firstMessage } from '../../../src/renderer/src/watcher/watcherFirstMessage'
import { agentContextFixture } from '../../fixtures/agentContext'
import { threadsStateFixture } from '../../fixtures/agentState'
import { openSidebarFolders } from '../../fixtures/renderer/liveAgentState'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn(), useOptionalAgents: vi.fn() }))

/**
 * Answering in Watcher's conversation (ADR-0073, Zach's pick on October 19, 2026, variant B): a watched thread's
 * question or permission shows as that thread's own card under the reply that told of it, answered as the user's own
 * answer to that thread, and once it no longer waits one line takes its place.
 */
const NOW = E2E_THREADS_NOW
const HOST = '6c0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a10'
const REMOTE = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d'
const target = (threadId: string, hostId = HOST) => ({ hostId, threadId })
const at = new Date(NOW).toISOString()
const identity: WatcherIdentity = { target: target('watcher'), projectId: 'workshop', provider: 'codex', creationOperationId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', createdAt: at }
let sequence = 0

function question(id: string): AgentRequest {
  return { id, kind: 'question', text: 'Which should I do for the login test?', options: [],
    questions: [{ id: `${id}-q`, question: 'Which should I do for the login test?', multiSelect: false, allowFreeText: true,
      options: [{ id: 'staging', label: 'Use the staging key (recommended)' }, { id: 'mock', label: 'Mock the auth call' }] }] }
}
function permission(id: string): AgentRequest {
  return { id, kind: 'permission', text: 'Run a command?', options: [], context: { command: 'npm test' },
    permissionChoices: [{ id: 'once', label: 'Allow once', kind: 'allow-once' }, { id: 'no', label: 'Deny', kind: 'deny' }] }
}

function watcherThread(): AgentThread {
  return { id: 'watcher', kind: 'watcher', title: 'Watcher', projectId: 'workshop', modelId: 'codex:gpt', providerId: 'codex', status: 'idle', requests: [],
    messages: [{ id: 'watcher-1', role: 'user', text: 'Keep an eye on the footer work.', createdAt: new Date(NOW - 60_000).toISOString() },
      { id: 'watcher-2', role: 'assistant', text: 'Footer links stopped to ask you which key to use.', createdAt: new Date(NOW - 30_000).toISOString() }] }
}
function agentState(requests: readonly AgentRequest[] = []): AgentState {
  const state = threadsStateFixture()
  const footer = state.host.threads.find(thread => thread.id === 'footer-links')!
  footer.requests = [...requests]
  footer.status = 'idle'
  footer.messages = [{ id: 'footer-1', role: 'assistant', text: 'Staging rejects the old key. I can switch to the staging key or mock the call.', createdAt: new Date(NOW - 40_000).toISOString() }]
  state.host.threads.push(watcherThread())
  openSidebarFolders(state)
  return state
}
function roomState(asks: WatcherAskPlacement[]): WatcherRoomState {
  return { current: identity, currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, status: 'idle', connected: true }, history: [], requests: [],
    watchedThreads: [{ target: target('footer-links'), title: 'Footer links', watched: true, status: 'idle', connected: true, settled: false, backgroundWorkCount: 0, waitsOn: [], participation: [] }],
    receipts: [], recoveryNotice: null, observedAt: at, asks }
}
const place = (requestCardId: string, messageId = 'watcher-2', patch: Partial<WatcherAskPlacement> = {}): WatcherAskPlacement =>
  ({ target: target('footer-links'), requestCardId, kind: 'question', messageId, wakeUpMessageId: `wake-${messageId}`, ...patch })

function fakeBridge(state: WatcherRoomState): { bridge: WatcherBridge; publish: (next: WatcherRoomState) => void } {
  const ok = (next: WatcherRoomState): WatcherRoomResult => ({ status: 'ok', state: next })
  let current = state
  const listeners = new Set<(next: WatcherRoomState) => void>()
  const bridge = { get: vi.fn(async () => ok(current)), open: vi.fn(async () => ok(current)),
    prepareStopAll: vi.fn(), stopAll: vi.fn(), onChanged: vi.fn((listener: (next: WatcherRoomState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }) } as unknown as WatcherBridge
  return { bridge, publish: next => { current = next; for (const listener of listeners) listener(next) } }
}

function renderRoom(room: WatcherRoomState, state: AgentState) {
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'watcher', platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS,
    update: { watcherEnabled: true }, actions: { navigate: vi.fn(), minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn() } } as unknown as AppContextValue)
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => ({ ...state, error: null }))
  const use = (next: AgentState): void => {
    const connection = agentContextFixture(next, command, { threadDrafts: new ThreadDraftStore(command) })
    vi.mocked(useAgents).mockReturnValue(connection)
    vi.mocked(useOptionalAgents).mockReturnValue(connection)
  }
  use(state)
  const { bridge, publish } = fakeBridge(room)
  const tree = () => <WatcherRoomProvider bridge={bridge}><SidebarChromeProvider updateControl={null}><WatcherView now={NOW} /></SidebarChromeProvider></WatcherRoomProvider>
  const view = render(tree())
  return { ...view, command, publish, update: (next: AgentState) => { use(next); view.rerender(tree()) } }
}
const paneReady = () => screen.findByRole('tab', { name: /^Watched, / })
const askCard = (name: RegExp | string) => screen.findByRole('region', { name })

beforeEach(() => {
  vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalAgents).mockReset(); vi.mocked(useOptionalApp).mockReset()
  localStorage.clear(); sessionStorage.clear(); roomView.set({ besideId: null, share: 0.5, tab: 'conversation' }); firstMessage.clear(); answeredChoices.clear()
  sequence++
})
afterEach(() => { cleanup() })

describe('a watched thread’s request in Watcher’s conversation', () => {
  it('shows the thread’s own card under the reply that told of it, with whose it is and its last reply folded', async () => {
    const id = `ask-${sequence}`
    renderRoom(roomState([place(id)]), agentState([question(id)]))
    await paneReady()
    const card = await askCard('Question from Footer links')
    const reply = document.querySelector('[data-message-id="watcher-2"]')!
    expect(reply.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(card).toHaveTextContent('Codex')
    expect(card).toHaveTextContent('This computer')
    expect(within(card).getByRole('button', { name: 'Open Footer links beside Watcher' })).toBeInTheDocument()
    expect(within(card).getByRole('radio', { name: /Use the staging key/ })).toBeInTheDocument()
    // The thread's last reply is folded until asked for, and Escape folds it again onto its toggle.
    expect(within(card).queryByText(/Staging rejects the old key/)).toBeNull()
    // Its name says whose reply it unfolds, since several cards may wait at once.
    const toggle = within(card).getByRole('button', { name: 'Show what it said, Footer links' })
    fireEvent.click(toggle)
    expect(await within(card).findByText(/Staging rejects the old key/)).toBeInTheDocument()
    fireEvent.keyDown(within(card).getByRole('group', { name: 'What Footer links said last' }), { key: 'Escape' })
    expect(within(card).queryByText(/Staging rejects the old key/)).toBeNull()
    expect(within(card).getByRole('button', { name: 'Show what it said, Footer links' })).toHaveFocus()
  })

  it('answers the watched thread’s request with the user’s own answer, never Watcher’s, and the line after names the choice', async () => {
    const id = `ask-${sequence}`
    const view = renderRoom(roomState([place(id)]), agentState([question(id)]))
    await paneReady()
    const card = await askCard('Question from Footer links')
    fireEvent.click(within(card).getByRole('radio', { name: /Use the staging key/ }))
    fireEvent.click(within(card).getByRole('button', { name: 'Send answer' }))
    await waitFor(() => expect(view.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'answer', threadId: 'footer-links', requestId: id })))
    expect(view.command.mock.calls.some(([request]) => request.type === 'answer' && request.threadId === 'watcher')).toBe(false)
    await waitFor(() => expect(within(card).getByText('Answer sent.')).toBeInTheDocument())
    // The thread no longer waits: the card leaves, and one line says what this window sent, in the card's own words.
    view.update(agentState())
    expect(await screen.findByText('You answered Footer links: Use the staging key.')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Question from Footer links' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open Footer links beside Watcher' })).toBeInTheDocument()
  })

  it('still names the choice when the request leaves before main’s reply to the answer comes back', async () => {
    const id = `ask-${sequence}`
    const view = renderRoom(roomState([place(id, 'watcher-2', { kind: 'permission' })]), agentState([permission(id)]))
    let reply: (state: AgentState) => void = () => undefined
    view.command.mockImplementation(request => request.type === 'answer' ? new Promise(resolve => { reply = resolve }) : Promise.resolve({ ...agentState(), error: null }))
    const card = await askCard('Permission request from Footer links')
    fireEvent.click(within(card).getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(view.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'answer', threadId: 'footer-links', requestId: id, permissionChoice: 'once' })))
    view.update(agentState())
    expect(await screen.findByText('Footer links no longer waits on you.')).toBeInTheDocument()
    reply({ ...agentState(), error: null })
    expect(await screen.findByText('You answered Footer links: Allow once.')).toBeInTheDocument()
  })

  it('still names the choice when the answer’s state is cleared a moment before the card leaves', async () => {
    const id = `ask-${sequence}`
    const asked = permission(id)
    const view = renderRoom(roomState([place(id, 'watcher-2', { kind: 'permission' })]), agentState([asked]))
    const card = await askCard('Permission request from Footer links')
    fireEvent.click(within(card).getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(view.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'answer', threadId: 'footer-links', requestId: id })))
    await waitFor(() => expect(within(card).getByText('Answer sent.')).toBeInTheDocument())
    // The store lets the answer go as the request leaves the thread, while this card is still drawn for it.
    requestAnswerStore.prune(requestAnswerOwnerKey('footer-links', asked, { kind: 'thread', ownerId: 'footer-links', providerId: 'codex' }), [])
    await waitFor(() => expect(within(card).queryByText('Answer sent.')).toBeNull())
    view.update(agentState())
    expect(await screen.findByText('You answered Footer links: Allow once.')).toBeInTheDocument()
  })

  it('says only that the thread no longer waits when it was answered somewhere else', async () => {
    const id = `ask-${sequence}`
    const view = renderRoom(roomState([place(id)]), agentState([question(id)]))
    await askCard('Question from Footer links')
    view.update(agentState())
    expect(await screen.findByText('Footer links no longer waits on you.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open Footer links beside Watcher' }))
    await waitFor(() => expect(roomView.get().besideId).toBe('footer-links'))
  })

  it('answers a permission of a thread on a paired host through that thread’s own row', async () => {
    const id = `ask-${sequence}`
    const state = agentState()
    const footer = state.host.threads.find(thread => thread.id === 'footer-links')!
    const far = hostEntityKey(REMOTE, 'far')
    state.host.threads.push({ ...footer, id: far, hostId: REMOTE, remoteHost: true, hostLabel: 'forge', title: 'Bump dependencies', requests: [permission(id)] })
    const view = renderRoom(roomState([place(id, 'watcher-2', { target: target('far', REMOTE), kind: 'permission' })]), state)
    const card = await askCard('Permission request from Bump dependencies')
    expect(card).toHaveTextContent('forge')
    fireEvent.click(within(card).getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(view.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'answer', threadId: far, requestId: id, permissionChoice: 'once' })))
  })

  it('shows one card for a request two wake-ups named, under the newer', async () => {
    const id = `ask-${sequence}`
    renderRoom(roomState([place(id, 'watcher-1'), place(id, 'watcher-2')]), agentState([question(id)]))
    const card = await askCard('Question from Footer links')
    expect(screen.getAllByRole('region', { name: 'Question from Footer links' })).toHaveLength(1)
    const reply = document.querySelector('[data-message-id="watcher-2"]')!
    expect(reply.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('names the choice after an answer given in the thread’s own pane, with Watcher’s card not on screen', async () => {
    const id = `ask-${sequence}`
    roomView.set({ besideId: 'footer-links', share: 0.5, tab: 'conversation' })
    const view = renderRoom(roomState([]), agentState([question(id)]))
    await paneReady()
    const beside = await waitFor(() => { const pane = document.getElementById('watcher-beside-pane'); if (!pane) throw new Error('No beside pane yet.'); return pane })
    fireEvent.click(await within(beside).findByRole('radio', { name: /Use the staging key/ }))
    fireEvent.click(within(beside).getByRole('button', { name: 'Send answer' }))
    await waitFor(() => expect(view.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'answer', threadId: 'footer-links', requestId: id })))
    // Watcher then tells of it, after the thread no longer waits.
    view.update(agentState())
    view.publish(roomState([place(id)]))
    expect(await screen.findByText('You answered Footer links: Use the staging key.')).toBeInTheDocument()
  })

  it('never tells an earlier answer of a request a provider asks again under the same ID', async () => {
    const id = `ask-${sequence}`
    // Answered here before, then gone from the thread, as the window reads it whether or not Watcher is on screen.
    answeredChoices.note('footer-links', id, 'Mock the auth call', true)
    answeredChoices.observe('footer-links', [])
    answeredChoices.observe('footer-links', [question(id)])
    const view = renderRoom(roomState([place(id)]), agentState([question(id)]))
    await askCard('Question from Footer links')
    view.update(agentState())
    expect(await screen.findByText('Footer links no longer waits on you.')).toBeInTheDocument()
    expect(screen.queryByText(/Mock the auth call/)).toBeNull()
  })

  it('draws nothing for a thread the window does not hold, such as one on a host still joining', async () => {
    const id = `ask-${sequence}`
    renderRoom(roomState([place(id, 'watcher-2', { target: target('far', REMOTE) })]), agentState())
    await paneReady()
    await waitFor(() => expect(document.querySelector('[data-message-id="watcher-2"]')).not.toBeNull())
    expect(document.querySelector('.watcher-asks')?.textContent ?? '').toBe('')
  })

  it('says when the reply it unfolds was shortened, read from the row’s excerpt', async () => {
    const id = `ask-${sequence}`
    const state = agentState([question(id)])
    const footer = state.host.threads.find(thread => thread.id === 'footer-links')!
    footer.messages = []
    footer.summary = { messageCount: 4, activityCount: 0, lastAssistant: { id: 'footer-9', text: 'Long. '.repeat(400).slice(0, 2_000), createdAt: at } }
    renderRoom(roomState([place(id)]), state)
    const card = await askCard('Question from Footer links')
    fireEvent.click(within(card).getByRole('button', { name: 'Show what it said, Footer links' }))
    expect(await within(card).findByText('Shortened here. Open the thread for the rest.')).toBeInTheDocument()
  })

  it('reads a thread once for Check again, then lets it go, so it is not kept as seen', async () => {
    const id = `ask-${sequence}`
    const view = renderRoom(roomState([place(id)]), agentState([{ ...question(id), delivery: 'uncertain' }]))
    const card = await askCard('Question from Footer links')
    fireEvent.click(within(card).getByRole('button', { name: 'Check again' }))
    const observed = () => view.command.mock.calls.flatMap(([request]) => request.type === 'observe-threads' ? [request.threadIds] : [])
    await waitFor(() => expect(observed()).toContainEqual(['watcher', 'footer-links']))
    await waitFor(() => expect(observed().at(-1)).toEqual(['watcher']))
  })

  it('draws no card for a request of a thread that is settled, and the needs-you line does not offer one', async () => {
    const id = `ask-${sequence}`
    const state = agentState([question(id)])
    const footer = state.host.threads.find(thread => thread.id === 'footer-links')!
    footer.settledAt = at
    renderRoom(roomState([place(id)]), state)
    await paneReady()
    await waitFor(() => expect(document.querySelector('[data-message-id="watcher-2"]')).not.toBeNull())
    expect(screen.queryByRole('region', { name: 'Question from Footer links' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Go to the question from Footer links/ })).toBeNull()
  })

  it('answers only the thread the ask names, by its host as well as its ID', async () => {
    const id = `ask-${sequence}`
    // Footer links lives on this computer, which the window knows by its host ID; an ask for the same thread ID on
    // another host is not its request.
    const state = agentState([question(id)])
    state.hostId = HOST
    renderRoom(roomState([place(id, 'watcher-2', { target: target('footer-links', REMOTE) })]), state)
    await paneReady()
    await waitFor(() => expect(document.querySelector('[data-message-id="watcher-2"]')).not.toBeNull())
    expect(screen.queryByRole('region', { name: 'Question from Footer links' })).toBeNull()
  })

  it('draws nothing outside Watcher’s own pane', () => {
    const { container } = render(<WatcherAfterMessage message={watcherThread().messages[1]!} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('the needs-you line', () => {
  it('goes to the card in the conversation and focuses it when the card is there', async () => {
    const id = `ask-${sequence}`
    renderRoom(roomState([place(id)]), agentState([question(id)]))
    const card = await askCard('Question from Footer links')
    const name = await screen.findByRole('button', { name: 'Go to the question from Footer links in this conversation' })
    fireEvent.click(name)
    expect(card).toHaveFocus()
    expect(roomView.get().besideId).toBeNull()
  })

  it('opens the thread beside Watcher, as before, when the conversation holds no card for it', async () => {
    const id = `ask-${sequence}`
    renderRoom(roomState([]), agentState([question(id)]))
    await paneReady()
    fireEvent.click(await screen.findByRole('button', { name: 'Open Footer links to answer its question' }))
    await waitFor(() => expect(roomView.get().besideId).toBe('footer-links'))
  })
})

describe('what a receipt says was chosen', () => {
  it('names the choice the card offered, never the user’s own words', () => {
    const asked = question('q')
    expect(chosenWords(asked, { choice: null, selections: { 'q-q': { optionIds: ['staging'], other: false, text: '' } } })).toBe('Use the staging key')
    expect(chosenWords(asked, { choice: null, selections: { 'q-q': { optionIds: [], other: true, text: 'Private words' } } })).toBe(OWN_WORDS)
    expect(chosenWords(permission('p'), { choice: 'once', selections: {} })).toBe('Allow once')
    expect(answerWords(asked, { answer: '', questionAnswers: { 'q-q': { optionIds: ['mock'] } } })).toBe('Mock the auth call')
    expect(answerWords(asked, { answer: '', questionAnswers: { 'q-q': { optionIds: [], text: 'Private words' } } })).toBe(OWN_WORDS)
    expect(answerWords(permission('p'), { answer: 'Deny', approved: false, permissionChoice: 'no' })).toBe('Deny')
    expect(receiptWords('Footer links', OWN_WORDS)).toBe('You answered Footer links in your own words.')
    expect(receiptWords('Footer links', undefined)).toBe('Footer links no longer waits on you.')
    // A title named from a first message keeps its full stop; the line does not say it twice.
    expect(receiptWords('Pick the badge colour.', 'Blue')).toBe('You answered Pick the badge colour: Blue.')
    expect(receiptWords('Pick the badge colour.', undefined)).toBe('Pick the badge colour no longer waits on you.')
  })

  it('places each request once, under the newest wake-up that named it', () => {
    const placed = placeAsks([place('a', 'm1'), place('b', 'm1'), place('a', 'm2')])
    expect([...placed].map(([message, asks]) => [message, asks.map(ask => ask.requestCardId)])).toEqual([['m1', ['b']], ['m2', ['a']]])
  })
})
