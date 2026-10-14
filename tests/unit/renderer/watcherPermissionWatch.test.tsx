import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentRuntimeMode, AgentState, AgentThread } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import type { WatcherIdentity, WatcherOwnChange, WatcherThreadTarget } from '../../../src/shared/watcher'
import type { WatcherBridge, WatcherRoomResult, WatcherRoomState } from '../../../src/shared/watcherRoom'
import type { AppContextValue, AppNavigation } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useAgents, useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { SidebarChromeProvider } from '../../../src/renderer/src/agents/SidebarFrame'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { WatcherRoomProvider, targetForThread, watchedTargets } from '../../../src/renderer/src/watcher/watcherRoom'
import { roomView } from '../../../src/renderer/src/watcher/WatcherBeside'
import { WatcherView } from '../../../src/renderer/src/watcher/WatcherView'
import { WatcherOwnChangeLine } from '../../../src/renderer/src/watcher/WatcherOwnChange'
import { watcherModeDescriptions, WATCHER_PERMISSIONS_FOOT } from '../../../src/renderer/src/watcher/WatcherPermissionChip'
import { watchedDoing, watchedLead } from '../../../src/renderer/src/watcher/WatcherWatched'
import { watchNotices } from '../../../src/renderer/src/watcher/watchNotice'
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
const WATCH = '5d1f0a6e-2c3b-4a59-8e7d-6f5e4d3c2b1a'
const target = (threadId: string): WatcherThreadTarget => ({ hostId: HOST, threadId })
const at = new Date(NOW).toISOString()
const identity: WatcherIdentity = { target: target('watcher'), projectId: 'workshop', provider: 'codex', creationOperationId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', createdAt: at }

function watcherThread(): AgentThread {
  return { id: 'watcher', kind: 'watcher', title: 'Watcher', projectId: 'workshop', modelId: 'codex:gpt', providerId: 'codex', status: 'idle', requests: [],
    messages: [{ id: 'watcher-1', role: 'user', text: 'Fix the install line.', createdAt: at }, { id: 'watcher-2', role: 'assistant', text: 'Fixed it in two files.', createdAt: at }] }
}

function stateWithWatcher(): AgentState {
  const state = threadsStateFixture()
  state.hostId = HOST
  state.host.threads.push(watcherThread())
  openSidebarFolders(state)
  return state
}

const row = (threadId: string, title: string, patch: Partial<WatcherRoomState['watchedThreads'][number]> = {}): WatcherRoomState['watchedThreads'][number] =>
  ({ target: target(threadId), title, watched: true, paused: false, status: 'running', connected: true, settled: false, backgroundWorkCount: 0, waitsOn: [], participation: [], ...patch })

/** Watcher on Ask for approval, watching Footer links with a standing watch. */
function roomState(patch: Partial<WatcherRoomState> = {}): WatcherRoomState {
  return {
    current: identity, currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, runtimeMode: 'approval-required', status: 'idle', connected: true }, history: [],
    runtimeMode: 'approval-required', standingWatches: [{ id: WATCH, target: target('footer-links'), createdAt: at, generation: 0 }], ownChanges: [],
    requests: [], watchedThreads: [row('footer-links', 'Footer links')],
    inFlight: 0, inFlightLimit: 4, receipts: [], recoveryNotice: null, observedAt: at, ...patch,
  }
}

const later = (seconds: number): string => new Date(NOW + seconds * 1_000).toISOString()

/** A bridge that answers the way the contract says main does: fresh state, with the change made. */
function fakeBridge(initial: WatcherRoomState, legacy = false) {
  let state = initial
  const listeners = new Set<(next: WatcherRoomState) => void>()
  const ok = (next: WatcherRoomState): WatcherRoomResult => { state = next; return { status: 'ok', state } }
  const same = (a: WatcherThreadTarget, b: WatcherThreadTarget): boolean => a.hostId === b.hostId && a.threadId === b.threadId
  const bridge = {
    get: vi.fn(async () => ({ status: 'ok' as const, state })),
    open: vi.fn(async () => ok({ ...state, current: identity })),
    setLimit: vi.fn(async ({ limit }: { limit: number }) => ok({ ...state, inFlightLimit: limit })),
    prepareStopAll: vi.fn(),
    stopAll: vi.fn(),
    onChanged: vi.fn((listener: (next: WatcherRoomState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
    ...legacy ? {} : {
      setPermission: vi.fn(async ({ runtimeMode }: { runtimeMode: AgentRuntimeMode }) => ok({ ...state, runtimeMode })),
      // As main does: Watch keeps a standing watch, and Stop watching ends it.
      watchThread: vi.fn(async ({ target: wanted }: { target: WatcherThreadTarget }) => ok({ ...state,
        standingWatches: [...(state.standingWatches ?? []).filter(watch => !same(watch.target, wanted)), { id: crypto.randomUUID(), target: wanted, createdAt: at, generation: 0 }],
        watchedThreads: state.watchedThreads.some(entry => same(entry.target, wanted)) ? state.watchedThreads.map(entry => same(entry.target, wanted) ? { ...entry, watched: true } : entry)
          : [...state.watchedThreads, row(wanted.threadId, wanted.threadId)] })),
      unwatchThread: vi.fn(async ({ target: wanted }: { target: WatcherThreadTarget }) => ok({ ...state,
        standingWatches: (state.standingWatches ?? []).filter(watch => !same(watch.target, wanted)),
        watchedThreads: state.watchedThreads.map(entry => same(entry.target, wanted) ? { ...entry, watched: false } : entry) })),
    },
  }
  return { bridge: bridge as unknown as WatcherBridge & typeof bridge & Required<Pick<typeof bridge, 'setPermission' | 'watchThread' | 'unwatchThread'>>,
    publish: (next: WatcherRoomState) => { state = next; for (const listener of listeners) listener(next) } }
}

function mockApp(navigation: AppNavigation, watcherEnabled = true): void {
  vi.mocked(useOptionalApp).mockReturnValue({
    navigation, platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS,
    update: { watcherEnabled }, actions: { navigate: vi.fn(), minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn() },
  } as unknown as AppContextValue)
}

function mockAgents(state: AgentState) {
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => state)
  const connection = agentContextFixture(state, command, { threadDrafts: new ThreadDraftStore(command) })
  vi.mocked(useAgents).mockReturnValue(connection)
  vi.mocked(useOptionalAgents).mockReturnValue(connection)
  return command
}

function renderRoom(room: WatcherRoomState, options: { readonly state?: AgentState; readonly legacy?: boolean; readonly enabled?: boolean } = {}) {
  mockApp('watcher', options.enabled ?? true)
  mockAgents(options.state ?? stateWithWatcher())
  const { bridge, publish } = fakeBridge(room, options.legacy)
  const view = render(<WatcherRoomProvider bridge={bridge}><SidebarChromeProvider updateControl={null}><WatcherView now={NOW} /></SidebarChromeProvider></WatcherRoomProvider>)
  return { ...view, bridge, publish }
}

function renderThreads(room: WatcherRoomState, options: { readonly enabled?: boolean; readonly legacy?: boolean } = {}) {
  const state = stateWithWatcher()
  state.activeThreadId = 'footer-links'
  mockApp('threads', options.enabled ?? true)
  mockAgents(state)
  const { bridge, publish } = fakeBridge(room, options.legacy)
  render(<WatcherRoomProvider bridge={bridge}><ThreadsView now={NOW} /></WatcherRoomProvider>)
  return { bridge, publish }
}

const watcherPane = () => screen.findByRole('region', { name: 'Watcher' })

beforeEach(() => {
  vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalAgents).mockReset(); vi.mocked(useOptionalApp).mockReset()
  localStorage.clear(); roomView.set({ besideId: null, share: 0.5, tab: 'conversation' }); firstMessage.clear()
  const shown = watchNotices.get(); if (shown !== null) watchNotices.dismiss(shown.id)
})
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear() })

describe('Watcher’s permissions chip', () => {
  it('sits after model and reasoning with the four modes, Sotto’s names, a line each and the line that holds in every mode', async () => {
    renderRoom(roomState())
    const pane = await watcherPane()
    // After the model (and reasoning where the model offers it), as on Threads.
    const chip = within(pane).getByRole('combobox', { name: 'Watcher’s permissions' })
    const model = pane.querySelector('.thread-prompt__footer :is(.thread-prompt__model, [aria-label="Thread model"])')!
    expect(model.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(chip).toHaveTextContent('Ask for approval')
    fireEvent.click(chip)
    const list = screen.getByRole('listbox', { name: 'Watcher’s permissions' })
    const lines = watcherModeDescriptions('Codex')
    expect(within(list).getAllByRole('option').map(option => option.textContent)).toEqual([
      `Ask for approval${lines['approval-required']}`, `Allow edits${lines['auto-accept-edits']}`, 'AutoCodex decides what to ask you about.', `Full access${lines['full-access']}`])
    expect(within(list).getByRole('option', { name: /Ask for approval/ })).toHaveAttribute('aria-selected', 'true')
    // The line under the list is read, never chosen: it sits outside the listbox.
    const foot = screen.getByText(WATCHER_PERMISSIONS_FOOT)
    expect(list.contains(foot)).toBe(false)
  })

  it('saves a choice through main, shows it at once, and marks it until the provider confirms', async () => {
    const { bridge, publish } = renderRoom(roomState())
    const pane = await watcherPane()
    const chip = within(pane).getByRole('combobox', { name: 'Watcher’s permissions' })
    fireEvent.click(chip)
    fireEvent.click(screen.getByRole('option', { name: /Allow edits/ }))
    await waitFor(() => expect(bridge.setPermission).toHaveBeenCalledWith({ runtimeMode: 'auto-accept-edits' }))
    expect(chip).toHaveFocus()
    await waitFor(() => expect(chip).toHaveTextContent('Allow edits'))
    // Remembered, but the current Watcher still reports Ask for approval: dashed, with what is in force beside it.
    expect(chip).toHaveAttribute('data-pending', 'true')
    expect(chip).toHaveAccessibleDescription('Codex still asks for approval until it confirms.')
    act(() => publish(roomState({ runtimeMode: 'auto-accept-edits', currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, runtimeMode: 'auto-accept-edits', status: 'idle', connected: true }, observedAt: later(30) })))
    await waitFor(() => expect(chip).not.toHaveAttribute('data-pending'))
    expect(chip).toHaveTextContent('Allow edits')
  })

  it('says main’s refusal in its own words and stays on the mode in force', async () => {
    const { bridge } = renderRoom(roomState())
    bridge.setPermission.mockResolvedValueOnce({ status: 'refused', code: 'PROVIDER_UNAVAILABLE', message: 'Codex is not connected. Watcher stays on Ask for approval.', retryable: true })
    const pane = await watcherPane()
    const chip = within(pane).getByRole('combobox', { name: 'Watcher’s permissions' })
    fireEvent.click(chip)
    fireEvent.click(screen.getByRole('option', { name: /Full access/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Codex is not connected. Watcher stays on Ask for approval.')
    expect(chip).toHaveTextContent('Ask for approval')
  })

  it('answers the keyboard: Enter opens the list on the mode in force, arrows move, Escape closes back to the chip', async () => {
    const user = userEvent.setup()
    const { bridge } = renderRoom(roomState())
    const pane = await watcherPane()
    const chip = within(pane).getByRole('combobox', { name: 'Watcher’s permissions' })
    chip.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('option', { name: /Ask for approval/ })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: /Allow edits/ })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox', { name: 'Watcher’s permissions' })).toBeNull()
    expect(chip).toHaveFocus()
    expect(bridge.setPermission).not.toHaveBeenCalled()
  })

  it('offers only what the provider offers, leading with an unoffered remembered mode as unchoosable', async () => {
    const state = stateWithWatcher()
    state.host.models.find(model => model.id === 'codex:gpt')!.runtimeModes = ['approval-required', 'auto-accept-edits', 'full-access']
    renderRoom(roomState({ runtimeMode: 'auto' }), { state })
    const pane = await watcherPane()
    fireEvent.click(within(pane).getByRole('combobox', { name: 'Watcher’s permissions' }))
    const options = within(screen.getByRole('listbox', { name: 'Watcher’s permissions' })).getAllByRole('option')
    expect(options).toHaveLength(4)
    expect(options[0]).toHaveTextContent('Auto')
    expect(options[0]).toBeDisabled()
    expect(options.slice(1).map(option => option.querySelector('span')?.firstChild?.textContent)).toEqual(['Ask for approval', 'Allow edits', 'Full access'])
  })

  it('is chosen before Watcher exists, and a new Watcher starts on the remembered mode', async () => {
    const { bridge } = renderRoom(roomState({ current: null, currentOptions: null, runtimeMode: 'auto-accept-edits', watchedThreads: [], standingWatches: [] }))
    const choice = await screen.findByRole('group', { name: 'Watcher’s model' })
    const chip = within(choice).getByRole('combobox', { name: 'Watcher’s permissions' })
    expect(chip).toHaveTextContent('Allow edits')
    // Nothing is in force yet, so nothing waits.
    expect(chip).not.toHaveAttribute('data-pending')
    fireEvent.click(chip)
    fireEvent.click(screen.getByRole('option', { name: /Ask for approval/ }))
    await waitFor(() => expect(bridge.setPermission).toHaveBeenCalledWith({ runtimeMode: 'approval-required' }))
    await waitFor(() => expect(chip).toHaveTextContent('Ask for approval'))
  })

  it.each([
    ['works', (thread: AgentThread) => { thread.status = 'running' }],
    ['waits on a card', (thread: AgentThread) => { thread.requests = [{ id: 'ask', kind: 'permission', text: 'Run the tests?', options: [] }] }],
  ])('is fixed while Watcher %s, as a thread’s chips are, and says why', async (_, change) => {
    const state = stateWithWatcher()
    change(state.host.threads.find(thread => thread.id === 'watcher')!)
    const { bridge } = renderRoom(roomState(), { state })
    const chip = within(await watcherPane()).getByRole('combobox', { name: 'Watcher’s permissions' })
    expect(chip).toBeDisabled()
    expect(chip).toHaveAttribute('title', 'Watcher’s permissions. Fixed while Watcher works. It can change once Watcher finishes and nothing waits on you.')
    fireEvent.click(chip)
    expect(screen.queryByRole('listbox', { name: 'Watcher’s permissions' })).toBeNull()
    expect(bridge.setPermission).not.toHaveBeenCalled()
  })

  it('says the mode as a fact where the bridge cannot change it', async () => {
    renderRoom(roomState(), { legacy: true })
    const pane = await watcherPane()
    expect(within(pane).queryByRole('combobox', { name: 'Watcher’s permissions' })).toBeNull()
    expect(within(pane).getByText('Ask for approval', { selector: '.thread-options__pinned' })).toBeInTheDocument()
  })
})

describe('Watcher’s own changes', () => {
  const change = (patch: Partial<WatcherOwnChange> = {}): WatcherOwnChange =>
    ({ replyMessageId: 'watcher-2', turnId: 'turn-1', files: ['README.md', 'docs/guide.md'], fileCount: 2, reason: 'A one-word typo in two files is smaller than briefing a thread.', source: 'provider-file-change', ...patch })

  it('puts one quiet line under the reply it belongs to, with its reason, and the files on request', async () => {
    const user = userEvent.setup()
    renderRoom(roomState({ ownChanges: [change()] }))
    const pane = await watcherPane()
    const reply = pane.querySelector('[data-message-id="watcher-2"]')!
    const line = within(reply as HTMLElement).getByText('Watcher changed 2 files itself.').closest('.watcher-own')!
    expect(line).toHaveTextContent('Its reason: “A one-word typo in two files is smaller than briefing a thread.”')
    expect(pane.querySelector('[data-message-id="watcher-1"] .watcher-own')).toBeNull()
    const toggle = within(line as HTMLElement).getByRole('button', { name: 'Show the 2 files' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: 'Files Watcher changed' })).toBeNull()
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAccessibleName('Hide the 2 files')
    expect(within(screen.getByRole('list', { name: 'Files Watcher changed' })).getAllByRole('listitem').map(item => item.textContent)).toEqual(['README.md', 'docs/guide.md'])
    // Escape folds the files again and leaves focus on the button.
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('list', { name: 'Files Watcher changed' })).toBeNull()
    expect(toggle).toHaveFocus()
  })

  it('says it gave no reason when its reply gave none, and counts files it cannot name', () => {
    render(<WatcherOwnChangeLine change={change({ reason: null, files: ['README.md'], fileCount: 3 })} />)
    expect(screen.getByText('It gave no reason.')).toBeInTheDocument()
    expect(screen.getByText('Watcher changed 3 files itself.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show the 3 files' }))
    expect(screen.getByText('and 2 files more')).toBeInTheDocument()
  })

  it('names one file as one', () => {
    render(<WatcherOwnChangeLine change={change({ files: ['README.md'], fileCount: 1 })} />)
    expect(screen.getByText('Watcher changed 1 file itself.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show the file' })).toBeInTheDocument()
  })

  it('marks nothing on another thread’s replies', async () => {
    const { publish } = renderThreads(roomState({ ownChanges: [change({ replyMessageId: 'footer-links-2' })] }))
    await screen.findByRole('region', { name: 'Footer links' })
    act(() => publish(roomState({ ownChanges: [change({ replyMessageId: 'footer-links-2' })], observedAt: later(5) })))
    expect(screen.queryByText(/Watcher changed/)).toBeNull()
  })
})

describe('watching a thread', () => {
  it('reads who is watched from main’s mark, and from participation where an older projection has none', () => {
    expect(watchedTargets(roomState({ watchedThreads: [row('footer-links', 'Footer links'), row('weekly-note', 'Weekly note', { watched: false })] })))
      .toEqual([target('footer-links')])
    const participant = { requestId: REQUEST, startedBy: 'watcher' as const, generation: 0, state: 'participating' as const, target: target('weekly-note'), promptCount: 1 }
    const older = roomState({ requests: [{ id: REQUEST, watcher: identity.target, rootUserMessageId: 'watcher-1', state: 'active', createdAt: at, closedAt: null, participants: [participant] }],
      watchedThreads: [{ target: target('weekly-note'), title: 'Weekly note', status: 'running', connected: true, settled: false, backgroundWorkCount: 0, waitsOn: [], participation: [participant] }] })
    expect(watchedTargets(older)).toEqual([target('weekly-note')])
  })

  it('addresses a thread by its owning host, whichever way the window keys it', () => {
    const state = stateWithWatcher()
    const thread = state.host.threads.find(item => item.id === 'footer-links')!
    expect(targetForThread(state, thread)).toEqual(target('footer-links'))
    expect(targetForThread(state, { ...thread, id: `host:${HOST}:footer-links` })).toEqual(target('footer-links'))
  })

  it('watches from the pane header at once, says so with Undo, and Undo stops it again', async () => {
    const user = userEvent.setup()
    const { bridge } = renderThreads(roomState({ watchedThreads: [], standingWatches: [] }))
    const pane = await screen.findByRole('region', { name: 'Footer links' })
    const watch = within(pane).getByRole('button', { name: 'Watch Footer links' })
    expect(watch).toHaveAttribute('aria-pressed', 'false')
    expect(within(pane).queryByText(/Watched by Watcher/)).toBeNull()
    await user.click(watch)
    expect(bridge.watchThread).toHaveBeenCalledWith({ target: target('footer-links') })
    await waitFor(() => expect(watch).toHaveAttribute('aria-pressed', 'true'))
    expect(watch).toHaveFocus()
    // The owl follows the logo, the composer says what watching means, and the toast says it was done.
    expect(within(pane).getByRole('img', { name: 'Watched by Watcher' })).toBeInTheDocument()
    expect(within(pane).getByText(/It keeps this thread going/)).toBeInTheDocument()
    const toast = document.querySelector('.watch-toast')
    expect(toast).toHaveAttribute('role', 'status')
    expect(toast).toHaveTextContent('Watcher is watching Footer links.')
    await user.click(screen.getByRole('button', { name: 'Undo: stop watching Footer links' }))
    expect(bridge.unwatchThread).toHaveBeenCalledWith({ target: target('footer-links') })
    await waitFor(() => expect(watch).toHaveAttribute('aria-pressed', 'false'))
    expect(document.querySelector('.watch-toast')).toHaveTextContent('Watcher stopped watching Footer links.')
  })

  it('stops watching from under the composer, and says a refusal in main’s words', async () => {
    const { bridge } = renderThreads(roomState())
    const pane = await screen.findByRole('region', { name: 'Footer links' })
    bridge.unwatchThread.mockResolvedValueOnce({ status: 'refused', code: 'HOST_DISCONNECTED', message: 'Sotto Site’s host is not connected, so Footer links is still watched.', retryable: true })
    fireEvent.click(await within(pane).findByRole('button', { name: 'Stop watching Footer links' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Sotto Site’s host is not connected, so Footer links is still watched.')
    expect(within(pane).getByRole('button', { name: 'Watch Footer links' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('promises a thread watched only for a request nothing past the user’s own send, under its composer and over Watched', async () => {
    const user = userEvent.setup()
    // Footer links takes part in Watcher's request, with no standing watch.
    const participant = { requestId: REQUEST, startedBy: 'watcher' as const, generation: 0, state: 'participating' as const, target: target('footer-links'), promptCount: 1 }
    const room = roomState({ standingWatches: [], requests: [{ id: REQUEST, watcher: identity.target, rootUserMessageId: 'watcher-1', state: 'active', createdAt: at, closedAt: null, participants: [participant] }],
      watchedThreads: [row('footer-links', 'Footer links', { participation: [participant] })] })
    renderThreads(room)
    const pane = await screen.findByRole('region', { name: 'Footer links' })
    expect(await within(pane).findByText('Watched by Watcher. If you send here, Watcher stops sending to it.')).toBeInTheDocument()
    expect(within(pane).queryByText(/keeps this thread going/)).toBeNull()
    cleanup()
    renderRoom(room)
    const room1 = await watcherPane()
    await user.click(within(room1).getByRole('tab', { name: 'Watched, 1 thread' }))
    expect(within(room1).getByRole('tabpanel', { name: 'Watched, 1 thread' })).toHaveTextContent(
      'Watcher keeps this thread going on its own and brings you its questions and permissions. It is watched for a request: if you send to it yourself, Watcher stops sending to it.')
    expect(within(room1).queryByText(/until you stop it/)).toBeNull()
    expect(watchedLead(3, 1)).toBe('Watcher keeps these 3 threads going on its own and brings you their questions and permissions. A thread you watch stays watched until you stop it. One watched for a request stops when you send to it yourself.')
  })

  it('says a paused watch waits for the user’s own turn', async () => {
    renderThreads(roomState({ watchedThreads: [row('footer-links', 'Footer links', { paused: true })] }))
    const pane = await screen.findByRole('region', { name: 'Footer links' })
    expect(await within(pane).findByText('Watched by Watcher. It waits while your own turn here runs, then keeps this thread going.')).toBeInTheDocument()
  })

  it('puts the owl among each sidebar row’s actions, pressed while watched', async () => {
    const user = userEvent.setup()
    const { bridge } = renderThreads(roomState())
    const sidebar = within(screen.getByRole('complementary', { name: 'Thread sidebar' }))
    const footer = await sidebar.findByRole('button', { name: 'Watch Footer links' })
    await waitFor(() => expect(footer).toHaveAttribute('aria-pressed', 'true'))
    const weekly = sidebar.getByRole('button', { name: 'Watch Weekly note' })
    expect(weekly).toHaveAttribute('aria-pressed', 'false')
    await user.click(weekly)
    expect(bridge.watchThread).toHaveBeenCalledWith({ target: target('weekly-note') })
    await waitFor(() => expect(weekly).toHaveAttribute('aria-pressed', 'true'))
    // Watcher itself has no owl to press.
    expect(sidebar.queryByRole('button', { name: 'Watch Watcher' })).toBeNull()
  })

  it('offers the owl as the last stop of each row in All threads', async () => {
    const user = userEvent.setup()
    const { bridge } = renderRoom(roomState())
    await watcherPane()
    await user.click(screen.getByRole('button', { name: /^All threads, \d+\. Show the list$/ }))
    const list = screen.getByRole('dialog', { name: 'All threads' })
    const weeklyRow = within(list).getByRole('button', { name: 'Open Weekly note beside Watcher' }).closest('li')!
    const stops = within(weeklyRow).getAllByRole('button')
    expect(stops.at(-1)).toHaveAccessibleName('Watch Weekly note')
    expect(stops.at(-1)).toHaveAttribute('aria-pressed', 'false')
    expect(within(list).getByRole('button', { name: 'Watch Footer links' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(stops.at(-1)!)
    expect(bridge.watchThread).toHaveBeenCalledWith({ target: target('weekly-note') })
    // Pressing the owl leaves the list open; the row now carries the owl after its logo.
    expect(screen.getByRole('dialog', { name: 'All threads' })).toBeInTheDocument()
    await waitFor(() => expect(within(weeklyRow).getByRole('button', { name: 'Watch Weekly note' })).toHaveAttribute('aria-pressed', 'true'))
    expect(within(list).getByText(/The owl watches a thread until you press it again/)).toBeInTheDocument()
  })

  it('shows Watched in Watcher’s pane: a card for each watched thread, with what Watcher last did and Stop watching', async () => {
    const user = userEvent.setup()
    const receipts = [{ id: '0b9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e', requestId: REQUEST, retryKey: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', digest: 'a'.repeat(64), action: 'send' as const,
      target: target('footer-links'), generation: 0, deliveryState: 'accepted' as const, createdAt: at, updatedAt: at, receiptId: 'receipt', cardId: 'card' }]
    const { bridge } = renderRoom(roomState({ receipts, watchedThreads: [row('footer-links', 'Footer links'), row('visual-gate', 'Visual gate flake'), row('weekly-note', 'Weekly note', { watched: false })],
      standingWatches: [{ id: WATCH, target: target('footer-links'), createdAt: at, generation: 0 }, { id: '6e2a1b0f-3d4c-4b6a-9f8e-7a6b5c4d3e2f', target: target('visual-gate'), createdAt: at, generation: 0 }] }))
    const pane = await watcherPane()
    const tabs = within(pane).getByRole('tablist', { name: 'Watcher’s view' })
    const watchedTab = within(tabs).getByRole('tab', { name: 'Watched, 2 threads' })
    await user.click(watchedTab)
    expect(watchedTab).toHaveAttribute('aria-selected', 'true')
    const panel = within(pane).getByRole('tabpanel', { name: 'Watched, 2 threads' })
    expect(within(pane).queryByRole('log', { name: 'Thread transcript' })).toBeNull()
    expect(panel).toHaveTextContent('Watcher keeps these 2 threads going on its own and brings you their questions and permissions. Each stays watched until you stop it.')
    // Grouped as the Overview groups them: Visual gate flake waits on its permission.
    expect(within(panel).getAllByRole('region').map(section => section.getAttribute('aria-label'))).toEqual(['Needs you, 1 thread', 'Working, 1 thread'])
    expect(within(panel).getByRole('button', { name: 'Open Visual gate flake to answer its permission' })).toBeInTheDocument()
    const footer = within(panel).getByRole('button', { name: 'Open Footer links beside Watcher' }).closest('li')!
    expect(footer).toHaveTextContent(/Watcher last sent to it at/)
    expect(within(panel).queryByText('Weekly note')).toBeNull()
    await user.click(within(footer).getByRole('button', { name: 'Stop watching Footer links' }))
    expect(bridge.unwatchThread).toHaveBeenCalledWith({ target: target('footer-links') })
    await waitFor(() => expect(within(pane).getByRole('tab', { name: 'Watched, 1 thread' })).toBeInTheDocument())
    // Watch a thread opens All threads, where the owl watches one.
    await user.click(within(pane).getByRole('button', { name: 'Watch a thread' }))
    expect(screen.getByRole('dialog', { name: 'All threads' })).toBeInTheDocument()
  })

  it('moves between Conversation and Watched with the arrow keys, and remembers the choice for the window', async () => {
    const user = userEvent.setup()
    const view = renderRoom(roomState())
    const pane = await watcherPane()
    const conversation = within(pane).getByRole('tab', { name: 'Conversation' })
    conversation.focus()
    await user.keyboard('{ArrowRight}')
    const watched = within(pane).getByRole('tab', { name: 'Watched, 1 thread' })
    expect(watched).toHaveFocus()
    expect(watched).toHaveAttribute('aria-selected', 'true')
    expect(watched).toHaveAttribute('tabindex', '0')
    expect(conversation).toHaveAttribute('tabindex', '-1')
    view.unmount()
    renderRoom(roomState())
    expect(within(await watcherPane()).getByRole('tab', { name: 'Watched, 1 thread' })).toHaveAttribute('aria-selected', 'true')
  })

  it('says how long a watch has run with nothing sent, or that the user’s turn holds it', () => {
    const state = roomState()
    expect(watchedDoing(row('footer-links', 'Footer links'), state)).toMatch(/^Watching since .+\. Nothing sent yet\.$/u)
    expect(watchedDoing(row('footer-links', 'Footer links', { paused: true }), state)).toBe('You sent here yourself. Watcher waits until that turn ends.')
    expect(watchedDoing(row('weekly-note', 'Weekly note'), state)).toBeNull()
  })

  it('offers no owl where the bridge cannot watch, and nothing of watching with the gate off', async () => {
    renderThreads(roomState(), { legacy: true })
    const pane = await screen.findByRole('region', { name: 'Footer links' })
    await waitFor(() => expect(within(pane).getByRole('img', { name: 'Watched by Watcher' })).toBeInTheDocument())
    expect(screen.queryAllByRole('button', { name: /^Watch |^Stop watching/ })).toEqual([])
    cleanup()
    renderThreads(roomState(), { enabled: false })
    await screen.findByRole('region', { name: 'Footer links' })
    expect(screen.queryAllByRole('button', { name: /^Watch |^Stop watching/ })).toEqual([])
    expect(screen.queryByText(/Watched by Watcher/)).toBeNull()
  })
})
