import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState, AgentThread } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import type { WatcherIdentity, WatcherOperation } from '../../../src/shared/watcher'
import type { WatcherBridge, WatcherRoomResult, WatcherRoomState, WatcherStopAllResult } from '../../../src/shared/watcherRoom'
import type { AppContextValue, AppNavigation } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useAgents, useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { SidebarChromeProvider } from '../../../src/renderer/src/agents/SidebarFrame'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { threadAddressIndex, threadForTarget, useWatcherRoom, WatcherRoomProvider } from '../../../src/renderer/src/watcher/watcherRoom'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { roomView } from '../../../src/renderer/src/watcher/WatcherBeside'
import { WatcherView } from '../../../src/renderer/src/watcher/WatcherView'
import { firstMessage } from '../../../src/renderer/src/watcher/watcherFirstMessage'
import { agentContextFixture } from '../../fixtures/agentContext'
import { threadsStateFixture } from '../../fixtures/agentState'
import { openSidebarFolders } from '../../fixtures/renderer/liveAgentState'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn(), useOptionalAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const HOST = '6c0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a10'
const REQUEST = '2b8f3c1d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const CONFIRMATION = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a'
const target = (threadId: string) => ({ hostId: HOST, threadId })
const at = new Date(NOW).toISOString()
const identity: WatcherIdentity = { target: target('watcher'), projectId: 'workshop', provider: 'codex', creationOperationId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', createdAt: at }

function watcherThread(): AgentThread {
  return { id: 'watcher', kind: 'watcher', title: 'Watcher', projectId: 'workshop', modelId: 'codex:gpt', providerId: 'codex', status: 'idle', requests: [],
    messages: [{ id: 'watcher-1', role: 'user', text: 'Fix the footer links and keep an eye on them.', createdAt: new Date(NOW - 60_000).toISOString() },
      { id: 'watcher-2', role: 'assistant', text: 'Started Footer links on Codex.', createdAt: new Date(NOW - 30_000).toISOString() }] }
}
function agentState(): AgentState {
  const state = threadsStateFixture()
  state.host.threads.push(watcherThread())
  openSidebarFolders(state)
  return state
}
const start: WatcherOperation = { id: '1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b', requestId: REQUEST, retryKey: '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e', digest: '0'.repeat(64),
  action: 'start', target: target('footer-links'), generation: 0, deliveryState: 'accepted', createdAt: at, updatedAt: at, receiptId: 'receipt-1', cardId: 'card-1' }

/** Watcher started Footer links, which is running, in a request still active. */
function roomState(patch: Partial<WatcherRoomState> = {}): WatcherRoomState {
  const participant = { requestId: REQUEST, startedBy: 'watcher' as const, generation: 0, state: 'participating' as const, target: target('footer-links'), promptCount: 1 }
  return {
    current: identity, currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, status: 'idle', connected: true }, history: [],
    requests: [{ id: REQUEST, watcher: identity.target, rootUserMessageId: 'watcher-1', state: 'active', createdAt: at, closedAt: null, participants: [participant] }],
    watchedThreads: [{ target: target('footer-links'), title: 'Footer links', status: 'running', connected: true, settled: false, backgroundWorkCount: 0, waitsOn: [], participation: [participant] }],
    inFlight: 1, inFlightLimit: 4, receipts: [start], recoveryNotice: null, observedAt: at, ...patch,
  }
}

function fakeBridge(state: WatcherRoomState) {
  const listeners = new Set<(next: WatcherRoomState) => void>()
  const ok = (next: WatcherRoomState): WatcherRoomResult => ({ status: 'ok', state: next })
  const bridge = {
    get: vi.fn(async () => ok(state)),
    open: vi.fn(async () => ok({ ...state, current: identity })),
    setLimit: vi.fn(async () => ok(state)),
    prepareStopAll: vi.fn(async () => ({ status: 'ok' as const, confirmationId: CONFIRMATION, targets: [target('footer-links')], expiresAt: new Date(NOW + 60_000).toISOString() })),
    stopAll: vi.fn(async (): Promise<WatcherStopAllResult> => ({ status: 'ok' as const, state: { ...state, watchedThreads: state.watchedThreads.map(row => ({ ...row, status: 'idle' as const })) },
      results: [{ target: target('footer-links'), status: 'stopped' as const, message: 'Stopped.' }] })),
    markRead: vi.fn(async () => ok({ ...state, readMarks: [] })),
    onChanged: vi.fn((listener: (next: WatcherRoomState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  return { bridge: bridge as unknown as WatcherBridge & typeof bridge, publish: (next: WatcherRoomState) => { for (const listener of listeners) listener(next) } }
}

function mockApp(navigation: AppNavigation) {
  vi.mocked(useOptionalApp).mockReturnValue({
    navigation, platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS,
    update: { watcherEnabled: true }, actions: { navigate: vi.fn(), minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn() },
  } as unknown as AppContextValue)
}

function renderRoom(room: WatcherRoomState, state: AgentState = agentState()) {
  mockApp('watcher')
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => state)
  const connection = agentContextFixture(state, command, { threadDrafts: new ThreadDraftStore(command) })
  vi.mocked(useAgents).mockReturnValue(connection)
  vi.mocked(useOptionalAgents).mockReturnValue(connection)
  const { bridge, publish } = fakeBridge(room)
  const view = render(<WatcherRoomProvider bridge={bridge}><SidebarChromeProvider updateControl={null}><WatcherView now={NOW} /></SidebarChromeProvider></WatcherRoomProvider>)
  return { ...view, bridge, publish, command }
}
const paneReady = () => screen.findByRole('tab', { name: /^Watched, / })

// The window is in front unless a test says otherwise: read marks clear only while the user can see it.
beforeEach(() => { vi.spyOn(document, 'hasFocus').mockReturnValue(true) })
beforeEach(() => { vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalAgents).mockReset(); vi.mocked(useOptionalApp).mockReset(); localStorage.clear(); sessionStorage.clear(); roomView.set({ besideId: null, share: 0.5, tab: 'conversation' }); firstMessage.clear() })
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear() })

describe('receipt cards', () => {
  it('put one card under the reply that took the action, whose name opens the thread beside Watcher', async () => {
    renderRoom(roomState({ receiptReplies: [{ operationId: start.id, messageId: 'watcher-2' }] }))
    await paneReady()
    const reply = document.querySelector('[data-message-id="watcher-2"]')!
    const cards = await screen.findByRole('list', { name: 'What Watcher did' })
    expect(reply.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const card = within(cards).getByRole('listitem')
    expect(card).toHaveTextContent('Started')
    expect(card).toHaveTextContent('Codex')
    expect(card).toHaveTextContent('This computer')
    expect(card).toHaveTextContent('sotto-site')
    const open = within(card).getByRole('button', { name: 'Open Footer links beside Watcher' })
    fireEvent.click(open)
    await waitFor(() => expect(roomView.get().besideId).toBe('footer-links'))
  })

  it('never turn a name in Watcherâ€™s words into a link: without the receiptâ€™s place there is no card', async () => {
    renderRoom(roomState())
    await paneReady()
    expect(screen.getByText('Started Footer links on Codex.')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'What Watcher did' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open Footer links beside Watcher' })).toBeNull()
  })

  it('keep the reply that took the action in view when a later reply of the same turn on screen would fold it away', async () => {
    // A wake-up the user is not shown began a second turn whose reply came after it: on screen the two replies share a turn.
    const state = agentState()
    const watcher = state.host.threads.find(thread => thread.id === 'watcher')!
    watcher.messages = [...watcher.messages, { id: 'watcher-3', role: 'assistant', text: 'Footer links is half done.', createdAt: new Date(NOW - 10_000).toISOString() }]
    renderRoom(roomState({ receiptReplies: [{ operationId: start.id, messageId: 'watcher-2' }] }), state)
    await paneReady()
    const cards = await screen.findByRole('list', { name: 'What Watcher did' })
    expect(cards.closest('.thread-work')).toBeNull()
    expect(screen.getByText('Started Footer links on Codex.')).toBeVisible()
    const took = document.querySelector('[data-message-id="watcher-2"]')!, later = document.querySelector('[data-message-id="watcher-3"]')!
    expect(took.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it('say when an action did not reach its thread', async () => {
    renderRoom(roomState({ receipts: [{ ...start, action: 'send', deliveryState: 'failed' }], receiptReplies: [{ operationId: start.id, messageId: 'watcher-2' }] }))
    await paneReady()
    expect(within(await screen.findByRole('list', { name: 'What Watcher did' })).getByRole('listitem')).toHaveTextContent('Could not send to')
  })
})

describe('the takeover line', () => {
  it('lands in Watcherâ€™s conversation when the user sent in a thread Watcher drove, with the name opening it beside Watcher', async () => {
    const room = roomState()
    const taken = { ...room.requests[0]!.participants[0]!, state: 'taken-over' as const, takeover: { reason: 'user-send' as const, at: new Date(NOW - 10_000).toISOString() } }
    renderRoom({ ...room, requests: [{ ...room.requests[0]!, participants: [taken] }], watchedThreads: room.watchedThreads.map(row => ({ ...row, watched: false, participation: [taken] })) })
    await paneReady()
    const line = await screen.findByText((_, element) => element?.tagName === 'P' && element.textContent === 'You took over Footer links. Watcher stopped sending to it.')
    expect(within(line).getByRole('button', { name: 'Open Footer links beside Watcher' })).toBeInTheDocument()
    expect(line.closest('.sotto-line')?.querySelector('time')).toHaveAttribute('dateTime', taken.takeover.at)
    // A thread taken over is not Watcher's to stop.
    expect(screen.queryByRole('button', { name: /^Stop all threads Watcher started/ })).toBeNull()
  })
})

describe('Stop all', () => {
  it('shows only while a thread Watcher started runs', async () => {
    const view = renderRoom(roomState())
    await paneReady()
    expect(screen.getByRole('button', { name: 'Stop all threads Watcher started, 1 thread' })).toBeInTheDocument()
    act(() => view.publish(roomState({ observedAt: new Date(NOW + 1_000).toISOString(), watchedThreads: roomState().watchedThreads.map(row => ({ ...row, status: 'idle' })) })))
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Stop all threads Watcher started/ })).toBeNull())
  })

  it('asks first, naming each thread, stops through mainâ€™s preview, says what came of each, and Escape returns to the button', async () => {
    const { bridge } = renderRoom(roomState())
    await paneReady()
    const button = screen.getByRole('button', { name: 'Stop all threads Watcher started, 1 thread' })
    fireEvent.click(button)
    const dialog = await screen.findByRole('dialog', { name: 'Stop the thread Watcher started?' })
    expect(bridge.prepareStopAll).toHaveBeenCalledTimes(1)
    expect(dialog).toHaveTextContent('Footer links')
    expect(dialog).toHaveTextContent('Each stops its current turn and keeps the work it has done. Threads you started or took over keep running.')
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus())
    expect(bridge.stopAll).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop 1 thread' }))
    await waitFor(() => expect(bridge.stopAll).toHaveBeenCalledWith({ confirmationId: CONFIRMATION }))
    const done = await screen.findByRole('dialog', { name: 'Stopped Footer links.' })
    expect(done).toHaveTextContent('Stopped.')
    fireEvent.keyDown(within(done).getByRole('button', { name: 'Close' }), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Stopped Footer links.' })).toBeNull())
    // Its threads stopped, so Stop all is gone, and focus goes to More Watcher actions beside it.
    await waitFor(() => expect(screen.getByRole('button', { name: 'More Watcher actions' })).toHaveFocus())
  })

  it('stays while the stop runs, so Escape cannot lose what came of each thread', async () => {
    const { bridge } = renderRoom(roomState())
    let answer: (result: WatcherStopAllResult) => void = () => undefined
    bridge.stopAll.mockImplementationOnce(() => new Promise<WatcherStopAllResult>(resolve => { answer = resolve }))
    await paneReady()
    fireEvent.click(screen.getByRole('button', { name: 'Stop all threads Watcher started, 1 thread' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop 1 thread' }))
    const stopping = await screen.findByRole('button', { name: 'Stopping…' })
    fireEvent.keyDown(stopping, { key: 'Escape' })
    fireEvent.pointerDown(document.body)
    expect(screen.getByRole('dialog', { name: 'Stop the thread Watcher started?' })).toBeInTheDocument()
    await act(async () => { answer({ status: 'ok', state: roomState(), results: [{ target: target('footer-links'), status: 'stopped', message: 'Stopped.' }] }) })
    expect(await screen.findByRole('dialog', { name: 'Stopped Footer links.' })).toHaveTextContent('Stopped.')
  })
  it('says it cannot tell what stopped when the stop’s answer is lost, never that nothing was stopped', async () => {
    const { bridge } = renderRoom(roomState())
    bridge.stopAll.mockRejectedValueOnce(new Error('The reply was lost.'))
    await paneReady()
    fireEvent.click(screen.getByRole('button', { name: 'Stop all threads Watcher started, 1 thread' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop 1 thread' }))
    const unknown = await screen.findByRole('dialog', { name: 'Sotto can’t tell what stopped' })
    expect(unknown).toHaveTextContent('the stop may or may not have reached these threads. Open each one to see whether its turn stopped')
    expect(unknown).not.toHaveTextContent('Nothing was stopped')
    expect(within(unknown).getByRole('button', { name: 'Open Footer links beside Watcher' })).toBeInTheDocument()
  })

  it('names a thread still waiting on its computer to confirm', async () => {
    const { bridge } = renderRoom(roomState())
    bridge.stopAll.mockResolvedValueOnce({ status: 'ok', state: roomState(), results: [{ target: target('footer-links'), status: 'requested', message: 'Stop requested.' }] })
    await paneReady()
    fireEvent.click(screen.getByRole('button', { name: 'Stop all threads Watcher started, 1 thread' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop 1 thread' }))
    expect(await screen.findByText('Stop requested. Waiting for it to confirm.')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close' }), { key: 'Escape' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop all threads Watcher started, 1 thread' })).toHaveFocus())
  })
})

describe('read marks', () => {
  const marked = (): Partial<WatcherRoomState> => ({ readMarks: [{ target: target('footer-links'), kind: 'finished', at }, { target: target('wav-stall'), kind: 'failed', at }] })

  it('put a dot before a rowâ€™s name in All threads, count what is new, and Mark all read clears them through main', async () => {
    const { bridge } = renderRoom(roomState(marked()))
    await paneReady()
    fireEvent.click(screen.getByRole('button', { name: /^All threads, \d+\. Show the list$/ }))
    const list = await screen.findByRole('dialog', { name: 'All threads' })
    const row = within(list).getByRole('button', { name: 'Open Footer links beside Watcher' })
    expect(row.querySelector('.watcher-row__dot')).not.toBeNull()
    expect(row.querySelector('.watcher-row__dot')!.nextElementSibling).toHaveTextContent('Footer links')
    expect(row).toHaveAccessibleDescription(/^New: a finished turn, /)
    expect(within(list).getByRole('button', { name: 'Open Streaming WAV stall beside Watcher' })).toHaveAccessibleDescription(/^New: a failed turn, /)
    expect(within(list).getByRole('button', { name: 'Open Weekly note beside Watcher' }).querySelector('.watcher-row__dot')).toBeNull()
    expect(list).toHaveTextContent('2 new')
    fireEvent.click(within(list).getByRole('button', { name: 'Mark all read, 2 threads' }))
    await waitFor(() => expect(bridge.markRead).toHaveBeenCalledWith({ targets: [target('wav-stall'), target('footer-links')] }))
    await waitFor(() => expect(within(list).queryByText('2 new')).toBeNull())
    expect(within(list).getByRole('searchbox')).toHaveFocus()
  })

  it('stay on a thread open while the window is behind another app or minimised, and go once it is in front again', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false)
    const { bridge } = renderRoom(roomState(marked()))
    await paneReady()
    act(() => { window.dispatchEvent(new Event('blur')) })
    // The thread is open beside Watcher, but nobody can see it.
    act(() => { roomView.set({ besideId: 'footer-links' }) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    expect(bridge.markRead).not.toHaveBeenCalled()
    vi.mocked(document.hasFocus).mockReturnValue(true)
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(bridge.markRead).toHaveBeenCalledWith({ targets: [target('footer-links')] }))
  })

  it('go when the thread opens beside Watcher', async () => {
    const { bridge } = renderRoom(roomState(marked()))
    await paneReady()
    fireEvent.click(screen.getByRole('button', { name: /^All threads, \d+\. Show the list$/ }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'All threads' })).getByRole('button', { name: 'Open Footer links beside Watcher' }))
    await waitFor(() => expect(bridge.markRead).toHaveBeenCalledWith({ targets: [target('footer-links')] }))
  })
})

describe('the room’s thread addresses', () => {
  it('answer as a search of the threads would, for threads keyed by host, by their own ID and with no host named', () => {
    const state = agentState()
    const remote = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d'
    state.host.threads.push({ ...state.host.threads[0]!, id: hostEntityKey(remote, 'far'), hostId: remote },
      { ...state.host.threads[0]!, id: 'local-host', hostId: HOST })
    const idOf = threadAddressIndex(state)
    for (const address of [target('footer-links'), target('local-host'), { hostId: remote, threadId: 'far' }, { hostId: remote, threadId: 'footer-links' }, target('missing')]) {
      expect(idOf(address)).toBe(threadForTarget(state, address)?.id)
    }
  })

  it('resolve every read mark without searching the threads once per mark', async () => {
    mockApp('watcher')
    const state = agentState()
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => state)
    const connection = agentContextFixture(state, command, { threadDrafts: new ThreadDraftStore(command) })
    vi.mocked(useAgents).mockReturnValue(connection)
    vi.mocked(useOptionalAgents).mockReturnValue(connection)
    const marks = state.host.threads.filter(thread => thread.kind !== 'watcher').map(thread => ({ target: target(thread.id), kind: 'finished' as const, at }))
    const { bridge } = fakeBridge(roomState({ readMarks: marks }))
    const find = vi.spyOn(state.host.threads, 'find')
    let size = 0
    const Probe = (): null => { size = useWatcherRoom()?.readMarks.size ?? 0; return null }
    render(<WatcherRoomProvider bridge={bridge}><Probe /></WatcherRoomProvider>)
    await waitFor(() => expect(size).toBe(marks.length))
    expect(find).not.toHaveBeenCalled()
  })
})