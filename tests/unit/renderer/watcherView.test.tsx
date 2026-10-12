import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState, AgentThread } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import type { WatcherIdentity } from '../../../src/shared/watcher'
import type { WatcherBridge, WatcherRoomResult, WatcherRoomState } from '../../../src/shared/watcherRoom'
import type { AppContextValue, AppNavigation } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useAgents, useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { SidebarChromeProvider, SidebarFoot } from '../../../src/renderer/src/agents/SidebarFrame'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { withoutRoomWatcher } from '../../../src/renderer/src/agents/watcherVisibility'
import { WatcherRoomProvider, threadForTarget } from '../../../src/renderer/src/watcher/watcherRoom'
import { roomView } from '../../../src/renderer/src/watcher/WatcherBeside'
import { WatcherDock } from '../../../src/renderer/src/watcher/WatcherDock'
import { WatcherView } from '../../../src/renderer/src/watcher/WatcherView'
import { firstMessage } from '../../../src/renderer/src/watcher/watcherFirstMessage'
import { agentContextFixture } from '../../fixtures/agentContext'
import { threadsStateFixture } from '../../fixtures/agentState'
import { openSidebarFolders } from '../../fixtures/renderer/liveAgentState'
import { promptText, setPromptText } from './helpers/promptEditor'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn(), useOptionalAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const HOST = '6c0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a10'
const REQUEST = '2b8f3c1d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const target = (threadId: string) => ({ hostId: HOST, threadId })
const at = new Date(NOW).toISOString()
const identity: WatcherIdentity = { target: target('watcher'), projectId: 'workshop', provider: 'codex', creationOperationId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', createdAt: at }

function watcherThread(): AgentThread {
  return { id: 'watcher', kind: 'watcher', title: 'Watcher', projectId: 'workshop', modelId: 'codex:gpt', providerId: 'codex', status: 'idle', requests: [],
    messages: [{ id: 'watcher-1', role: 'user', text: 'Keep an eye on the footer links.', createdAt: at }, { id: 'watcher-2', role: 'assistant', text: 'Watching Footer links.', createdAt: at }] }
}

function stateWithWatcher(): AgentState {
  const state = threadsStateFixture()
  state.host.models.push({ id: 'devin:agent', provider: 'Devin', name: 'Devin', ready: true })
  state.host.threads.push(watcherThread())
  openSidebarFolders(state)
  return state
}

/** Watcher watches Footer links, a thread it started, and counts it among two in flight. */
function roomState(patch: Partial<WatcherRoomState> = {}): WatcherRoomState {
  const participant = { requestId: REQUEST, startedBy: 'watcher' as const, generation: 0, state: 'participating' as const, target: target('footer-links'), promptCount: 1 }
  return {
    current: identity, currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, status: 'idle', connected: true }, history: [],
    requests: [{ id: REQUEST, watcher: identity.target, rootUserMessageId: 'watcher-1', state: 'active', createdAt: at, closedAt: null, participants: [participant] }],
    watchedThreads: [{ target: target('footer-links'), title: 'Footer links', status: 'running', connected: true, settled: false, backgroundWorkCount: 0, waitsOn: [], participation: [participant] }],
    inFlight: 2, inFlightLimit: 4, receipts: [], recoveryNotice: null, observedAt: at, ...patch,
  }
}

function fakeBridge(state: WatcherRoomState) {
  const listeners = new Set<(next: WatcherRoomState) => void>()
  const ok = (next: WatcherRoomState): WatcherRoomResult => ({ status: 'ok', state: next })
  const bridge = {
    get: vi.fn(async () => ok(state)),
    open: vi.fn(async () => ok({ ...state, current: identity })),
    setLimit: vi.fn(async ({ limit }: { limit: number }) => ok({ ...state, inFlightLimit: limit })),
    prepareStopAll: vi.fn(),
    stopAll: vi.fn(),
    onChanged: vi.fn((listener: (next: WatcherRoomState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  return { bridge: bridge as unknown as WatcherBridge & typeof bridge, publish: (next: WatcherRoomState) => { for (const listener of listeners) listener(next) } }
}

function mockApp(navigation: AppNavigation, watcherEnabled = true) {
  const navigate = vi.fn()
  vi.mocked(useOptionalApp).mockReturnValue({
    navigation, platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS,
    update: { watcherEnabled }, actions: { navigate, minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn() },
  } as unknown as AppContextValue)
  return navigate
}

function mockAgents(state: AgentState) {
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => state)
  const connection = agentContextFixture(state, command, { threadDrafts: new ThreadDraftStore(command) })
  vi.mocked(useAgents).mockReturnValue(connection)
  vi.mocked(useOptionalAgents).mockReturnValue(connection)
  return command
}

function renderRoom(state: AgentState, room: WatcherRoomState, watcherEnabled = true) {
  const navigate = mockApp('watcher', watcherEnabled)
  const command = mockAgents(state)
  const { bridge, publish } = fakeBridge(room)
  const view = render(<WatcherRoomProvider bridge={bridge}><SidebarChromeProvider updateControl={null}><WatcherView now={NOW} /></SidebarChromeProvider></WatcherRoomProvider>)
  return { ...view, bridge, publish, command, navigate }
}

/** Waits for Watcher's own pane: until then the room shows its header over a status line, which the pane's header replaces. */
async function paneReady(): Promise<void> {
  await screen.findByRole('meter', { name: 'Watched threads' })
}

beforeEach(() => { vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalAgents).mockReset(); vi.mocked(useOptionalApp).mockReset(); localStorage.clear(); roomView.set({ besideId: null, share: 0.5 }); firstMessage.clear() })
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear() })

describe("Watcher's room", () => {
  it('starts on Watcher’s own composer the first time, and the first message starts Watcher and goes to it without selecting anything', async () => {
    const { bridge, command } = renderRoom(stateWithWatcher(), roomState({ current: null, currentOptions: null, watchedThreads: [], requests: [], inFlight: 0 }))
    expect(await screen.findByRole('heading', { level: 2, name: 'Start Watcher' })).toBeInTheDocument()
    expect(screen.getByText(/only you answer a thread’s questions and permissions/)).toBeInTheDocument()
    // No meter or actions before Watcher runs.
    expect(screen.queryByRole('meter', { name: 'Watched threads' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'More Watcher actions' })).toBeNull()
    const chosen = screen.getByRole('group', { name: 'Watcher’s model' })
    expect(within(chosen).getByRole('combobox', { name: 'Thread model' })).toHaveTextContent('Sonnet 4.5')
    expect(within(chosen).getByText('Ask before changes')).toBeInTheDocument()
    expect(screen.getByText('Your first message starts Watcher on Sonnet 4.5, with your own Claude Code account.')).toBeInTheDocument()
    const send = screen.getByRole('button', { name: 'Start Watcher and send' })
    expect(send).toBeDisabled()
    setPromptText(screen.getByRole('textbox', { name: 'Watcher message' }), 'Keep an eye on the footer links.')
    expect(send).toBeEnabled()
    fireEvent.click(send)
    await waitFor(() => expect(bridge.open).toHaveBeenCalledWith({ provider: 'claude', modelId: 'claude:sonnet' }))
    // Once main names the new Watcher, its own pane takes the first entry's place and the message goes to it.
    expect(await screen.findByRole('region', { name: 'Watcher' })).toBeInTheDocument()
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'manual-send', threadId: 'watcher', text: 'Keep an eye on the footer links.' })))
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'select-thread' }))
  })

  it('says main’s refusal in its own words and keeps the message in the composer', async () => {
    const { bridge, command } = renderRoom(stateWithWatcher(), roomState({ current: null, currentOptions: null }))
    bridge.open.mockResolvedValueOnce({ status: 'refused', code: 'PROVIDER_UNAVAILABLE', message: 'Claude Code is not connected. Nothing was started.', retryable: true })
    setPromptText(await screen.findByRole('textbox', { name: 'Watcher message' }), 'Start the release checks.')
    fireEvent.click(screen.getByRole('button', { name: 'Start Watcher and send' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Claude Code is not connected. Nothing was started.')
    expect(promptText(screen.getByRole('textbox', { name: 'Watcher message' }))).toBe('Start the release checks.')
    expect(screen.getByRole('button', { name: 'Start Watcher and send' })).toBeEnabled()
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'manual-send' }))
  })

  it('keeps the first message when the room is left while Watcher starts, and sends it to Watcher once', async () => {
    mockApp('watcher')
    const command = mockAgents(stateWithWatcher())
    const { bridge, publish } = fakeBridge(roomState({ current: null, currentOptions: null, watchedThreads: [], requests: [], inFlight: 0 }))
    let answer: (result: WatcherRoomResult) => void = () => undefined
    bridge.open.mockImplementationOnce(() => new Promise<WatcherRoomResult>(resolve => { answer = resolve }))
    const tree = (room: boolean) => <React.StrictMode><WatcherRoomProvider bridge={bridge}><SidebarChromeProvider updateControl={null}>
      {room ? <WatcherView now={NOW} /> : <p>Threads</p>}
    </SidebarChromeProvider></WatcherRoomProvider></React.StrictMode>
    const view = render(tree(true))
    setPromptText(await screen.findByRole('textbox', { name: 'Watcher message' }), 'Keep an eye on the footer links.')
    fireEvent.click(screen.getByRole('button', { name: 'Start Watcher and send' }))
    await waitFor(() => expect(bridge.open).toHaveBeenCalledTimes(1))
    // Leaving for another room while main creates Watcher, then coming back before it answers: still starting.
    view.rerender(tree(false))
    view.rerender(tree(true))
    expect(await screen.findByText('Starting Watcher…')).toBeInTheDocument()
    expect(promptText(screen.getByRole('textbox', { name: 'Watcher message' }))).toBe('Keep an eye on the footer links.')
    expect(screen.getByRole('button', { name: 'Start Watcher and send' })).toBeDisabled()
    // Away again when main answers: the message goes to the new Watcher all the same.
    view.rerender(tree(false))
    await act(async () => { answer({ status: 'ok', state: roomState() }) })
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'manual-send', threadId: 'watcher', text: 'Keep an eye on the footer links.' })))
    // Back in the room, later projections and a fresh mount send nothing more.
    view.rerender(tree(true))
    await paneReady()
    act(() => publish(roomState({ observedAt: new Date(NOW + 1_000).toISOString() })))
    expect(command.mock.calls.filter(([request]) => request.type === 'manual-send')).toHaveLength(1)
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'select-thread' }))
  })

  it('shows a refusal that came while the room was left, with the message still in the composer', async () => {
    mockApp('watcher')
    const command = mockAgents(stateWithWatcher())
    const { bridge } = fakeBridge(roomState({ current: null, currentOptions: null, watchedThreads: [], requests: [], inFlight: 0 }))
    let answer: (result: WatcherRoomResult) => void = () => undefined
    bridge.open.mockImplementationOnce(() => new Promise<WatcherRoomResult>(resolve => { answer = resolve }))
    const tree = (room: boolean) => <WatcherRoomProvider bridge={bridge}><SidebarChromeProvider updateControl={null}>
      {room ? <WatcherView now={NOW} /> : <p>Threads</p>}
    </SidebarChromeProvider></WatcherRoomProvider>
    const view = render(tree(true))
    setPromptText(await screen.findByRole('textbox', { name: 'Watcher message' }), 'Start the release checks.')
    fireEvent.click(screen.getByRole('button', { name: 'Start Watcher and send' }))
    await waitFor(() => expect(bridge.open).toHaveBeenCalledTimes(1))
    view.rerender(tree(false))
    await act(async () => { answer({ status: 'refused', code: 'PROVIDER_UNAVAILABLE', message: 'Claude Code is not connected. Nothing was started.', retryable: true }) })
    view.rerender(tree(true))
    expect(await screen.findByRole('alert')).toHaveTextContent('Claude Code is not connected. Nothing was started.')
    expect(promptText(screen.getByRole('textbox', { name: 'Watcher message' }))).toBe('Start the release checks.')
    expect(screen.getByRole('button', { name: 'Start Watcher and send' })).toBeEnabled()
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'manual-send' }))
  })

  it('never offers Devin for Watcher, and says where to connect a provider when none can host it', async () => {
    const state = stateWithWatcher()
    state.host.models = [{ id: 'devin:agent', provider: 'Devin', name: 'Devin', ready: true }]
    renderRoom(state, roomState({ current: null, currentOptions: null }))
    expect(await screen.findByText(/Connect Codex, Claude Code or Grok Build in Settings/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start Watcher and send' })).toBeNull()
  })

  it('shows Watcher’s own pane under the Sotto Owl tile, with its meter and pinned asking mode and none of a thread’s Git, menu or permissions controls', async () => {
    const { command } = renderRoom(stateWithWatcher(), roomState())
    const pane = await screen.findByRole('region', { name: 'Watcher' })
    expect(within(pane).getByRole('heading', { level: 1, name: 'Watcher' })).toBeInTheDocument()
    expect(within(pane).getByRole('img', { name: 'Sotto Owl' })).toBeInTheDocument()
    // The tile is the owl in the corner; the small owl that sat before Watcher's name is gone, and so is the sidebar.
    expect(pane.querySelector('.watcher-head .watcher-owl')).toBeNull()
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(within(pane).getByRole('meter', { name: 'Watched threads' })).toHaveAttribute('aria-valuetext', '2 of 4 watched')
    expect(within(pane).getByText('Watching Footer links.')).toBeInTheDocument()
    // Watcher's replies are signed Watcher, whatever provider it runs on.
    expect(within(pane).getByText('Watcher', { selector: '.thread-message__who' })).toBeInTheDocument()
    expect(within(pane).queryByText('Codex', { selector: '.thread-message__who' })).toBeNull()
    expect(within(pane).getByRole('textbox', { name: 'Watcher message' })).toBeInTheDocument()
    expect(within(pane).getByText('Ask before changes')).toBeInTheDocument()
    expect(within(pane).queryByRole('combobox', { name: 'Thread permissions' })).toBeNull()
    expect(within(pane).queryByRole('button', { name: 'More actions' })).toBeNull()
    // Watcher's history is read while the room shows it; nothing selects it on the Threads page.
    expect(command).toHaveBeenCalledWith({ type: 'observe-threads', threadIds: ['watcher'] })
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'select-thread' }))
  })

  it('keeps Watcher’s reading position, and a beside thread’s, for a trip to another room', async () => {
    const ROW = 100
    const VIEW = 500
    const tops = new WeakMap<Element, number>()
    const height = (element: HTMLElement): number => element.querySelectorAll('.thread-message').length * ROW
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return height(this) })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => VIEW)
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return tops.get(this) ?? 0 })
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) { tops.set(this, Math.max(0, Math.min(value, height(this) - VIEW))) })
    try {
      const state = stateWithWatcher()
      const history = (id: string) => Array.from({ length: 40 }, (_, index) => ({ id: `${id}-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const, text: `${id} ${index}`, createdAt: at }))
      state.host.threads.find(thread => thread.id === 'watcher')!.messages = history('watcher')
      state.host.threads.find(thread => thread.id === 'footer-links')!.messages = history('footer')
      mockApp('watcher')
      mockAgents(state)
      const { bridge } = fakeBridge(roomState())
      const tree = (room: boolean) => <WatcherRoomProvider bridge={bridge}><SidebarChromeProvider updateControl={null}>
        {room ? <WatcherView now={NOW} /> : <p>Threads</p>}
      </SidebarChromeProvider></WatcherRoomProvider>
      const view = render(tree(true))
      await paneReady()
      const transcript = (pane: string) => within(screen.getByRole('region', { name: pane })).getByRole('log', { name: 'Thread transcript' })
      expect(transcript('Watcher').scrollTop).toBe(40 * ROW - VIEW)
      transcript('Watcher').scrollTop = 1_200
      fireEvent.scroll(transcript('Watcher'))
      fireEvent.click(screen.getByRole('button', { name: 'All threads, 9. Show the list' }))
      fireEvent.click(screen.getByRole('button', { name: 'Open Footer links beside Watcher' }))
      transcript('Footer links').scrollTop = 700
      fireEvent.scroll(transcript('Footer links'))
      // To Threads and back: both panes come back where they were read, not at their newest messages.
      view.rerender(tree(false))
      view.rerender(tree(true))
      await paneReady()
      expect(transcript('Watcher').scrollTop).toBe(1_200)
      expect(transcript('Footer links').scrollTop).toBe(700)
      expect(screen.getAllByRole('button', { name: 'Jump to latest' })).toHaveLength(2)
      // A reader back at the end follows again, and the next return finds the end.
      transcript('Watcher').scrollTop = 40 * ROW
      fireEvent.scroll(transcript('Watcher'))
      view.rerender(tree(false))
      view.rerender(tree(true))
      await paneReady()
      expect(transcript('Watcher').scrollTop).toBe(40 * ROW - VIEW)
    } finally { vi.restoreAllMocks() }
  })

  it('keeps Watcher on its own provider before its first send, since another provider is another Watcher', async () => {
    const state = stateWithWatcher()
    state.host.threads.find(thread => thread.id === 'watcher')!.nativeSessionStarted = false
    renderRoom(state, roomState())
    const pane = await screen.findByRole('region', { name: 'Watcher' })
    fireEvent.click(within(pane).getByRole('combobox', { name: 'Thread model' }))
    const picker = screen.getByRole('dialog', { name: 'Choose model' })
    expect(within(picker).getAllByRole('option').map(option => option.textContent)).toEqual([expect.stringContaining('GPT-5.4')])
    expect(within(pane).getByText('Ask before changes')).toBeInTheDocument()
  })

  it('names each thread that needs the user and why, under the header', async () => {
    renderRoom(stateWithWatcher(), roomState())
    await paneReady()
    const line = screen.getByRole('heading', { level: 2, name: '2 need you' }).closest('section')!
    expect(within(line).getAllByRole('button').map(button => button.getAttribute('aria-label')))
      .toEqual(['Open Visual gate flake to answer its permission', 'Open Streaming WAV stall at its failed turn'])
    expect(line).toHaveTextContent('permission')
    expect(line).toHaveTextContent('last turn failed')
  })

  it('counts the names past five in the needs-you line, and the count opens All threads with focus coming back to it', async () => {
    const state = stateWithWatcher()
    for (const index of [1, 2, 3, 4, 5]) state.host.threads.push({ id: `asks-${index}`, title: `Asks ${index}`, projectId: 'workshop', modelId: 'claude:sonnet', providerId: 'claude',
      status: 'idle', messages: [], requests: [{ id: `asks-${index}-question`, kind: 'question', text: 'Which branch?', options: [] }] })
    renderRoom(state, roomState())
    await paneReady()
    const line = screen.getByRole('heading', { level: 2, name: '7 need you' }).closest('section')!
    expect(within(line).getAllByRole('button')).toHaveLength(6)
    const more = within(line).getByRole('button', { name: '2 more need you. Show all threads' })
    more.focus()
    fireEvent.click(more)
    const filter = within(screen.getByRole('dialog', { name: 'All threads' })).getByRole('searchbox', { name: 'Filter threads' })
    await waitFor(() => expect(filter).toHaveFocus())
    fireEvent.keyDown(filter, { key: 'Escape' })
    expect(more).toHaveFocus()
  })

  it('opens the Overview over the room from All threads, in the decided order, and Escape returns focus to All threads', async () => {
    renderRoom(stateWithWatcher(), roomState())
    await paneReady()
    const button = screen.getByRole('button', { name: 'All threads, 9. Show the list' })
    fireEvent.click(button)
    const list = within(screen.getByRole('dialog', { name: 'All threads' }))
    await waitFor(() => expect(list.getByRole('searchbox', { name: 'Filter threads' })).toHaveFocus())
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(list.getAllByRole('heading', { level: 3 }).map(heading => heading.getAttribute('aria-label')))
      .toEqual(['Needs you, 2 threads', 'Working, 2 threads', 'Idle, 5 threads'])
    expect(list.getByText('Run a command in workshop')).toBeInTheDocument()
    expect(list.getByRole('button', { name: 'Open Visual gate flake to answer its permission' })).toHaveTextContent('Open to answer')
    // Watcher is not among its own threads.
    expect(list.queryByRole('button', { name: 'Open Watcher beside Watcher' })).toBeNull()
    const footer = list.getByRole('button', { name: 'Open Footer links beside Watcher' })
    expect(footer).toHaveAccessibleDescription(/Watched by Watcher/)
    expect(footer.closest('li')!.querySelector('.watched-badge')).not.toBeNull()
    expect(list.getByRole('button', { name: 'Open Weekly note beside Watcher' })).not.toHaveAccessibleDescription(/Watched by Watcher/)
    // Settled threads stay reachable at the end of Idle, folded away until asked for.
    expect(list.queryByText('Benchmark rerun')).toBeNull()
    fireEvent.click(list.getByRole('button', { name: 'Settled, 4 threads' }))
    expect(list.getByText('Benchmark rerun')).toBeInTheDocument()
    // The filter narrows the list.
    fireEvent.change(list.getByRole('searchbox', { name: 'Filter threads' }), { target: { value: 'weekly' } })
    expect(list.getAllByRole('button', { name: /beside Watcher$/ }).map(item => item.getAttribute('aria-label'))).toEqual(['Open Weekly note beside Watcher'])
    fireEvent.keyDown(list.getByRole('searchbox', { name: 'Filter threads' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'All threads' })).toBeNull()
    expect(button).toHaveFocus()
  })

  it('opens a thread beside Watcher at what it waits on, reads it while it shows, and Escape closes it back to its opener', async () => {
    const { command } = renderRoom(stateWithWatcher(), roomState())
    await paneReady()
    const name = screen.getByRole('button', { name: 'Open Visual gate flake to answer its permission' })
    name.focus()
    fireEvent.click(name)
    const beside = await screen.findByRole('region', { name: 'Visual gate flake' })
    expect(beside).toHaveAttribute('id', 'watcher-beside-pane')
    await waitFor(() => expect(beside.querySelector('.agent-request[data-kind="permission"]')).toHaveFocus())
    expect(within(beside).getByRole('button', { name: 'Open Visual gate flake in Threads' })).toBeInTheDocument()
    expect(within(beside).getByRole('button', { name: 'Close Visual gate flake pane' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Watcher' })).toBeInTheDocument()
    expect(screen.getByRole('separator', { name: 'Resize panes' })).toBeInTheDocument()
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'observe-threads', threadIds: ['watcher', 'visual-gate'] }))
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'select-thread' }))
    fireEvent.keyDown(beside.querySelector('.agent-request[data-kind="permission"]')!, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Visual gate flake' })).toBeNull()
    await waitFor(() => expect(name).toHaveFocus())
  })

  it('opens a thread in the Threads room, selected, with Shift or Open in Threads', async () => {
    const { command, navigate } = renderRoom(stateWithWatcher(), roomState())
    await paneReady()
    fireEvent.click(screen.getByRole('button', { name: 'All threads, 9. Show the list' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open Footer links beside Watcher' }), { shiftKey: true })
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('threads'))
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: 'footer-links' })
    expect(screen.queryByRole('region', { name: 'Footer links' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open Streaming WAV stall at its failed turn' }))
    const beside = await screen.findByRole('region', { name: 'Streaming WAV stall' })
    fireEvent.click(within(beside).getByRole('button', { name: 'Open Streaming WAV stall in Threads' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: 'wav-stall' }))
  })

  it('keeps Threads in flight under More Watcher actions, saves it through main and returns focus on Escape', async () => {
    const { bridge, publish } = renderRoom(stateWithWatcher(), roomState())
    const more = await screen.findByRole('button', { name: 'More Watcher actions' })
    fireEvent.click(more)
    const panel = screen.getByRole('dialog', { name: 'Watcher settings' })
    const limit = within(panel).getByRole('combobox', { name: 'Threads in flight' })
    expect(limit).toHaveFocus()
    expect(limit).toHaveValue('4')
    expect(limit).toHaveAccessibleDescription(/Lowering it stops nothing/)
    fireEvent.change(limit, { target: { value: '3' } })
    await waitFor(() => expect(bridge.setLimit).toHaveBeenCalledWith({ limit: 3 }))
    await waitFor(() => expect(screen.getByRole('meter', { name: 'Watched threads' })).toHaveAttribute('aria-valuetext', '2 of 3 watched'))
    fireEvent.keyDown(limit, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Watcher settings' })).toBeNull()
    expect(more).toHaveFocus()
    // A lower limit than the threads in flight stops nothing; the meter says so.
    act(() => publish(roomState({ inFlightLimit: 1, observedAt: new Date(NOW + 1_000).toISOString() })))
    expect(screen.getByRole('meter', { name: 'Watched threads' })).toHaveAttribute('aria-valuetext', '2 of 1 watched')
  })

  it('says a refused limit change and keeps the old limit', async () => {
    const { bridge } = renderRoom(stateWithWatcher(), roomState())
    bridge.setLimit.mockResolvedValueOnce({ status: 'refused', code: 'INVALID_INPUT', message: 'The limit was not saved. It is still 4.', retryable: true })
    fireEvent.click(await screen.findByRole('button', { name: 'More Watcher actions' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Threads in flight' }), { target: { value: '7' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('The limit was not saved. It is still 4.')
    expect(screen.getByRole('meter', { name: 'Watched threads' })).toHaveAttribute('aria-valuetext', '2 of 4 watched')
  })
})

describe('the room switch', () => {
  function foot(navigation: AppNavigation, watcherEnabled = true) {
    const navigate = mockApp(navigation, watcherEnabled)
    const view = render(<SidebarFoot />)
    return { navigate, view, tabs: () => within(screen.getByRole('tablist', { name: 'Page' })).getAllByRole('tab') }
  }

  it('puts the owl alone between Dictate and Threads, named Watcher, with one tab stop', () => {
    const { tabs } = foot('home')
    expect(tabs().map(tab => tab.getAttribute('aria-label') ?? tab.textContent)).toEqual(['Dictate', 'Watcher', 'Threads'])
    expect(tabs()[1]).toHaveAttribute('title', 'Watcher')
    expect(tabs()[1]).toHaveTextContent('')
    expect(tabs().map(tab => tab.tabIndex)).toEqual([0, -1, -1])
  })

  for (const from of ['home', 'threads', 'settings', 'help', 'history', 'memory'] as const) it(`reaches all three rooms from the keyboard on ${from}`, () => {
    const { navigate, tabs } = foot(from)
    const start = tabs().find(tab => tab.tabIndex === 0)!
    start.focus()
    const index = tabs().indexOf(start)
    fireEvent.keyDown(start, { key: 'End' })
    expect(navigate).toHaveBeenLastCalledWith('threads')
    fireEvent.keyDown(tabs()[2]!, { key: 'Home' })
    expect(navigate).toHaveBeenLastCalledWith('home')
    fireEvent.keyDown(tabs()[0]!, { key: 'ArrowRight' })
    expect(navigate).toHaveBeenLastCalledWith('watcher')
    expect(tabs()[1]).toHaveFocus()
    expect(index).toBeGreaterThanOrEqual(0)
  })

  it('hands focus to the lit tab of the room it opens, whose page draws its own switch', () => {
    const { tabs, view } = foot('home')
    tabs()[0]!.focus()
    fireEvent.keyDown(tabs()[0]!, { key: 'ArrowRight' })
    view.unmount()
    // The room's page mounts a new foot; the press's focus lands on its lit owl.
    foot('watcher')
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true')
    expect(tabs()[1]).toHaveFocus()
  })

  it('floats in Watcher’s room with the page links before it and the update control after, in the order the eye reads them', () => {
    mockApp('watcher')
    render(<WatcherDock updateControl={<button type="button" aria-label="Check for updates" />} />)
    const dock = document.querySelector('.watcher-dock__pill')!
    const stops = [...dock.querySelectorAll('a, [role="tab"][tabindex="0"], button[aria-label="Check for updates"]')].map(node => node.getAttribute('aria-label') ?? node.textContent)
    expect(stops).toEqual(['History', 'Settings', 'Help', 'Watcher', 'Check for updates'])
    expect(screen.getByRole('tab', { name: 'Watcher' })).toHaveAttribute('aria-selected', 'true')
  })

  it('is Dictate | Threads alone with the gate off', () => {
    const { tabs } = foot('threads', false)
    expect(tabs().map(tab => tab.textContent)).toEqual(['Dictate', 'Threads'])
  })
})

describe('a watched thread', () => {
  function renderThreadsPage(watcherEnabled: boolean) {
    const state = stateWithWatcher()
    state.activeThreadId = 'footer-links'
    mockApp('threads', watcherEnabled)
    mockAgents(state)
    const { bridge } = fakeBridge(roomState())
    render(<WatcherRoomProvider bridge={bridge}><ThreadsView now={NOW} /></WatcherRoomProvider>)
    return bridge
  }

  it('shows the owl after its provider logo in its row and its pane, and says what a send does', async () => {
    renderThreadsPage(true)
    const sidebar = within(screen.getByRole('complementary', { name: 'Thread sidebar' }))
    const row = await sidebar.findByRole('button', { name: 'Footer links' })
    await waitFor(() => expect(within(row).getByRole('img', { name: 'Watched by Watcher' })).toBeInTheDocument())
    expect(row).toHaveAccessibleDescription(/Watched by Watcher/)
    const pane = screen.getByRole('region', { name: 'Footer links' })
    expect(within(pane).getByRole('img', { name: 'Watched by Watcher' })).toBeInTheDocument()
    expect(within(pane).queryByRole('button', { name: 'Watched by Watcher' })).toBeNull()
    expect(within(pane).getByText('Watched by Watcher. If you send here, Watcher stops sending to it.')).toBeInTheDocument()
    // Watcher itself lives in its room, not in the Threads list.
    expect(sidebar.queryByRole('button', { name: 'Watcher' })).toBeNull()
    expect(within(sidebar.getByRole('button', { name: 'Weekly note' })).queryByRole('img', { name: 'Watched by Watcher' })).toBeNull()
  })

  it('shows nothing of Watcher with the gate off, and never asks main', () => {
    const bridge = renderThreadsPage(false)
    expect(screen.queryAllByRole('img', { name: 'Watched by Watcher' })).toEqual([])
    expect(screen.queryByText(/If you send here, Watcher stops sending to it/)).toBeNull()
    expect(bridge.get).not.toHaveBeenCalled()
    expect(bridge.onChanged).not.toHaveBeenCalled()
  })
})

describe('Watcher’s thread in the window', () => {
  it('finds a host’s thread under either key the window may use', () => {
    const state = stateWithWatcher()
    expect(threadForTarget(state, target('watcher'))?.id).toBe('watcher')
    const scoped = { ...state, hostId: HOST, host: { ...state.host, threads: state.host.threads.map(thread => ({ ...thread, id: `host:${HOST}:${thread.id}` })) } }
    expect(threadForTarget(scoped, target('watcher'))?.id).toBe(`host:${HOST}:watcher`)
    expect(threadForTarget(scoped, { hostId: '0f0e0d0c-0b0a-4908-8706-050403020100', threadId: 'watcher' })).toBeUndefined()
  })

  it('leaves the current Watcher out of the Threads page and clears a selection of it', () => {
    const state = stateWithWatcher()
    state.activeThreadId = 'watcher'
    const shown = withoutRoomWatcher(state, true, null)
    expect(shown.host.threads.map(thread => thread.id)).not.toContain('watcher')
    expect(shown.activeThreadId).toBeNull()
    expect(withoutRoomWatcher(state, true, 'footer-links').host.threads.map(thread => thread.id)).not.toContain('footer-links')
    expect(withoutRoomWatcher(state, false, 'footer-links')).toBe(state)
  })
})
