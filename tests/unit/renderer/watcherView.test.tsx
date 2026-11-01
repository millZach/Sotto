import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
import { WatcherView } from '../../../src/renderer/src/watcher/WatcherView'
import type { UpdateControlProps } from '../../../src/renderer/src/features/updates/UpdateControl'
import { firstMessage } from '../../../src/renderer/src/watcher/watcherFirstMessage'
import { toolsPanelStore } from '../../../src/renderer/src/tools/toolsPanelStore'
import { agentContextFixture } from '../../fixtures/agentContext'
import { browserBridgeFixture, browserPage } from '../../fixtures/renderer/browserBridge'
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
    receipts: [], recoveryNotice: null, observedAt: at, ...patch,
  }
}

function fakeBridge(state: WatcherRoomState) {
  const listeners = new Set<(next: WatcherRoomState) => void>()
  const ok = (next: WatcherRoomState): WatcherRoomResult => ({ status: 'ok', state: next })
  const bridge = {
    get: vi.fn(async () => ok(state)),
    open: vi.fn(async () => ok({ ...state, current: identity })),
    setPermission: vi.fn(async ({ runtimeMode }: { runtimeMode: WatcherRoomState['runtimeMode'] }) => ok({ ...state, runtimeMode })),
    watchThread: vi.fn(async () => ok(state)),
    unwatchThread: vi.fn(async () => ok(state)),
    prepareStopAll: vi.fn(),
    stopAll: vi.fn(),
    onChanged: vi.fn((listener: (next: WatcherRoomState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  return { bridge: bridge as unknown as WatcherBridge & typeof bridge, publish: (next: WatcherRoomState) => { for (const listener of listeners) listener(next) } }
}

function mockApp(navigation: AppNavigation, watcherEnabled = true, museEnabled = false, quiet = false) {
  const navigate = vi.fn()
  vi.mocked(useOptionalApp).mockReturnValue({
    navigation, platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS,
    update: museEnabled || quiet ? { watcherEnabled, owlFeatures: { watcher: watcherEnabled, muse: museEnabled, 'quiet-composer': quiet } } : { watcherEnabled }, actions: { navigate, minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn(), dismissPastePermissionNotices: vi.fn() },
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

function renderRoom(state: AgentState, room: WatcherRoomState, watcherEnabled = true, quiet = false) {
  const navigate = mockApp('watcher', watcherEnabled, false, quiet)
  const command = mockAgents(state)
  const { bridge, publish } = fakeBridge(room)
  const view = render(<WatcherRoomProvider bridge={bridge}><SidebarChromeProvider updateControl={null}><WatcherView now={NOW} /></SidebarChromeProvider></WatcherRoomProvider>)
  return { ...view, bridge, publish, command, navigate }
}

/** Waits for Watcher's own pane: until then the room shows its header over a status line, which the pane's header replaces. */
async function paneReady(): Promise<void> {
  await waitFor(() => expect(document.querySelector('#watcher-pane .thread-workspace__transcript')).not.toBeNull())
}

beforeEach(() => { vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalAgents).mockReset(); vi.mocked(useOptionalApp).mockReset(); localStorage.clear(); roomView.set({ besideId: null, share: 0.5 }); firstMessage.clear() })
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear() })

describe("Watcher's room", () => {
  it('says once, in one sentence above the composer, that the first message starts Watcher, and leaves the rest to Help (#1822)', async () => {
    const { navigate } = renderRoom(stateWithWatcher(), roomState({ current: null, currentOptions: null, watchedThreads: [], requests: [] }))
    await screen.findByRole('heading', { level: 2, name: 'Start Watcher' })
    const intro = document.querySelector('.watcher-first__intro')!
    expect(intro).toHaveTextContent(/^Start WatcherWatcher starts your other threads, briefs them and keeps an eye on them while they work\. Your first message starts it\. How Watcher works$/u)
    // The providers and permissions paragraph lives in Help now, and "starts it" is said nowhere else.
    expect(screen.queryByText(/only you answer a thread’s questions and permissions/u)).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Watcher message' })).toHaveAttribute('data-placeholder', 'Say what to start or check.')
    expect(document.body.textContent?.match(/starts (it|Watcher)\b/gu)).toEqual(['starts it'])
    fireEvent.click(screen.getByRole('button', { name: 'How Watcher works' }))
    expect(navigate).toHaveBeenCalledWith('help', 'help-watcher')
  })

  it('starts on Watcher’s own composer the first time, and the first message starts Watcher and goes to it without selecting anything', async () => {
    const { bridge, command } = renderRoom(stateWithWatcher(), roomState({ current: null, currentOptions: null, watchedThreads: [], requests: [] }))
    expect(await screen.findByRole('heading', { level: 2, name: 'Start Watcher' })).toBeInTheDocument()
    // No actions before Watcher runs.
    expect(screen.queryByRole('button', { name: 'More Watcher actions' })).toBeNull()
    const chosen = screen.getByRole('group', { name: 'Watcher’s model' })
    expect(within(chosen).getByRole('combobox', { name: 'Thread model' })).toHaveTextContent('Sonnet 4.5')
    // What it may do without asking is chosen here too, and a new Watcher starts on Ask for approval.
    expect(within(chosen).getByRole('combobox', { name: 'Watcher’s permissions' })).toHaveTextContent('Ask for approval')
    expect(screen.getByText('On Sonnet 4.5, with your own Claude Code account.')).toBeInTheDocument()
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

  it.each([false, true])('starts with the chosen model and effort from the first-entry composer, quiet %s', async quiet => {
    const state = stateWithWatcher()
    state.host.models = [{ id: 'claude:sonnet', provider: 'Claude Code', providerId: 'claude', name: 'Sonnet 4.5', ready: true,
      reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' }]
    const { bridge, command } = renderRoom(state, roomState({ current: null, currentOptions: null, watchedThreads: [], requests: [] }), true, quiet)
    const prompt = await screen.findByRole('textbox', { name: 'Watcher message' })
    expect(prompt.closest('form')?.getAttribute('data-quiet')).toBe(quiet ? 'true' : null)
    expect(bridge.open).not.toHaveBeenCalled()
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'create-thread' }))
    if (quiet) {
      const effort = screen.getByRole('combobox', { name: 'Thread reasoning' })
      expect(effort.closest('.split-chip-effort')).not.toHaveAttribute('data-speed')
      expect(effort).toHaveTextContent(/^Medium$/u)
      fireEvent.keyDown(effort, { key: 'End' })
      expect(effort).toHaveTextContent(/^High$/u)
      expect(screen.getByRole('combobox', { name: 'Watcher’s permissions' }).closest('.thread-prompt__meta > .thread-prompt__shield')).not.toBeNull()
    } else {
      expect(document.querySelector('.split-chip-effort')).toBeNull()
      fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
      fireEvent.change(screen.getByRole('slider', { name: 'Thread reasoning effort' }), { target: { value: '2' } })
      fireEvent.keyDown(screen.getByRole('slider', { name: 'Thread reasoning effort' }), { key: 'Escape' })
    }
    expect(screen.getByRole('combobox', { name: 'Watcher’s permissions' })).toHaveTextContent('Ask for approval')
    setPromptText(prompt, 'Keep an eye on the footer links.')
    fireEvent.click(screen.getByRole('button', { name: 'Start Watcher and send' }))
    await waitFor(() => expect(bridge.open).toHaveBeenCalledWith({ provider: 'claude', modelId: 'claude:sonnet', reasoningEffort: 'high' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'manual-send', threadId: 'watcher', text: 'Keep an eye on the footer links.' })))
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'create-thread' }))
  })

  it.each([false, true])('keeps queued follow-ups above Watcher’s working composer and preserves Queue and Stop, quiet %s', async quiet => {
    const state = stateWithWatcher()
    state.host.threads.find(thread => thread.id === 'watcher')!.status = 'running'
    const texts = ['On PR #1216, fix the two bug bot findings.', 'Has PR #1251 merged to main?']
    state.followups = texts.map((text, index) => ({ id: `6000000${index}-0000-4000-8000-000000000000`, threadId: 'watcher', draftId: crypto.randomUUID(), text, attachments: [], createdAt: at, updatedAt: at, status: 'queued' as const }))
    const { command } = renderRoom(state, roomState(), true, quiet)
    await paneReady()
    const pane = screen.getByRole('region', { name: 'Watcher' })
    const prompt = within(pane).getByRole('textbox', { name: 'Watcher message' })
    expect(prompt.closest('form')?.getAttribute('data-quiet')).toBe(quiet ? 'true' : null)
    expect(prompt).toHaveAttribute('data-placeholder', 'Watcher is working. Write a follow-up to queue it.')
    const queue = within(pane).getByRole('region', { name: 'Queued messages' })
    for (const text of texts) {
      expect(within(queue).getByText(text)).toBeInTheDocument()
      expect(within(within(pane).getByRole('log', { name: 'Thread transcript' })).queryByText(text)).not.toBeInTheDocument()
    }
    expect(within(pane).queryByLabelText('Queued message')).not.toBeInTheDocument()
    setPromptText(prompt, 'Check the release too.')
    fireEvent.click(within(pane).getByRole('button', { name: 'Queue prompt' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'queue-followup', threadId: 'watcher', text: 'Check the release too.' })))
    fireEvent.click(within(pane).getByRole('button', { name: 'Stop agent' }))
    expect(command).toHaveBeenCalledWith({ type: 'interrupt', threadId: 'watcher' })
  })

  it.each([false, true].flatMap(quiet => [false, true].map(workerRoles => ({ quiet, workerRoles }))))('cycles first-entry speed and keeps it through an effort change, quiet $quiet, worker roles $workerRoles', async ({ quiet, workerRoles }) => {
    const state = stateWithWatcher()
    state.host.models = [{ id: 'claude:sonnet', provider: 'Claude Code', providerId: 'claude', name: 'Sonnet 4.5', ready: true,
      reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium',
      speeds: [{ id: 'fast', name: 'Fast' }, { id: 'ultrafast', name: 'Ultra fast' }] }]
    const updateSettings = vi.fn()
    vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'watcher', platform: 'win32', windowMaximized: false,
      settings: { ...DEFAULT_SETTINGS, workerRoles: { orchestrating: { modelId: 'claude:sonnet', reasoningEffort: 'medium' } } },
      update: { owlFeatures: { watcher: true, 'quiet-composer': quiet, 'worker-roles': workerRoles } },
      actions: { navigate: vi.fn(), minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings },
    } as unknown as AppContextValue)
    const command = mockAgents(state)
    const { bridge } = fakeBridge(roomState({ current: null, currentOptions: null, watchedThreads: [], requests: [] }))
    render(<WatcherRoomProvider bridge={bridge}><SidebarChromeProvider updateControl={null}><WatcherView now={NOW} /></SidebarChromeProvider></WatcherRoomProvider>)
    if (quiet) {
      const effort = await screen.findByRole('combobox', { name: 'Thread reasoning' })
      expect(effort).toHaveTextContent('Medium, Standard')
      fireEvent.click(effort)
      fireEvent.click(screen.getByRole('radio', { name: 'Fast' }))
      expect(effort).toHaveTextContent('Medium, Fast')
      expect(effort).toHaveFocus()
      fireEvent.keyDown(effort, { key: 'ArrowUp', altKey: true })
      expect(effort).toHaveTextContent('Medium, Ultra fast')
      fireEvent.keyDown(effort, { key: 'ArrowUp', altKey: true })
      expect(effort).toHaveTextContent('Medium, Standard')
      fireEvent.keyDown(effort, { key: 'ArrowDown', altKey: true })
      expect(effort).toHaveTextContent('Medium, Ultra fast')
    } else {
      fireEvent.click(await screen.findByRole('button', { name: 'Thread speed: Standard' }))
      fireEvent.click(screen.getByRole('button', { name: 'Thread speed: Fast' }))
      expect(screen.getByRole('button', { name: 'Thread speed: Ultra fast' })).toHaveAttribute('data-speed', 'ultrafast')
    }
    if (workerRoles) expect(updateSettings).toHaveBeenLastCalledWith({ workerRoles: { orchestrating: { modelId: 'claude:sonnet', reasoningEffort: 'medium', speed: 'ultrafast' } } })
    else expect(updateSettings).not.toHaveBeenCalled()
    if (quiet) {
      const effort = screen.getByRole('combobox', { name: 'Thread reasoning' })
      fireEvent.keyDown(effort, { key: 'ArrowRight' })
      expect(effort).toHaveTextContent('High, Ultra fast')
    } else {
      fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
      fireEvent.change(screen.getByRole('slider', { name: 'Thread reasoning effort' }), { target: { value: '2' } })
      fireEvent.keyDown(screen.getByRole('slider', { name: 'Thread reasoning effort' }), { key: 'Escape' })
    }
    if (workerRoles) expect(updateSettings).toHaveBeenLastCalledWith({ workerRoles: { orchestrating: { modelId: 'claude:sonnet', reasoningEffort: 'high', speed: 'ultrafast' } } })
    else expect(updateSettings).not.toHaveBeenCalled()
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'configure-thread' }))
    setPromptText(screen.getByRole('textbox', { name: 'Watcher message' }), 'Keep an eye on the footer links.')
    fireEvent.click(screen.getByRole('button', { name: 'Start Watcher and send' }))
    await waitFor(() => expect(bridge.open).toHaveBeenCalledWith({ provider: 'claude', modelId: 'claude:sonnet', reasoningEffort: 'high', speed: 'ultrafast' }))
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'create-thread' }))
  })

  it.each([{ alreadySaved: false, workerRoles: false }, { alreadySaved: false, workerRoles: true }, { alreadySaved: true, workerRoles: true }])(
    'keeps an unavailable first-entry speed while starting at Standard, already saved $alreadySaved, worker roles $workerRoles', async ({ alreadySaved, workerRoles }) => {
    const state = stateWithWatcher()
    state.host.models = [
      { id: 'codex:gpt', provider: 'Codex', providerId: 'codex', name: 'GPT-6.1 Sol', ready: true,
        reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium', speeds: [{ id: 'fast', name: 'Fast' }, { id: 'ultrafast', name: 'Ultra fast' }] },
      { id: 'claude:sonnet', provider: 'Claude Code', providerId: 'claude', name: 'Sonnet 5.5', ready: true,
        reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium', speeds: [{ id: 'fast', name: 'Fast' }] },
    ]
    const updateSettings = vi.fn()
    vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'watcher', platform: 'win32', windowMaximized: false,
      settings: { ...DEFAULT_SETTINGS, workerRoles: { orchestrating: { modelId: alreadySaved ? 'claude:sonnet' : 'codex:gpt', reasoningEffort: 'medium', ...(alreadySaved ? { speed: 'ultrafast' } : {}) } } },
      update: { owlFeatures: { watcher: true, 'quiet-composer': true, 'worker-roles': workerRoles } },
      actions: { navigate: vi.fn(), updateSettings },
    } as unknown as AppContextValue)
    mockAgents(state)
    const { bridge } = fakeBridge(roomState({ current: null, currentOptions: null, watchedThreads: [], requests: [] }))
    render(<WatcherRoomProvider bridge={bridge}><SidebarChromeProvider updateControl={null}><WatcherView now={NOW} /></SidebarChromeProvider></WatcherRoomProvider>)
    const effort = await screen.findByRole('combobox', { name: 'Thread reasoning' })
    if (!alreadySaved) {
      fireEvent.keyDown(effort, { key: 'ArrowDown', altKey: true })
      expect(effort).toHaveTextContent('Medium, Ultra fast')
      fireEvent.click(screen.getByRole('combobox', { name: 'Thread model' }))
      fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }))
      fireEvent.click(screen.getByRole('option', { name: 'Sonnet 5.5' }))
      if (workerRoles) expect(updateSettings).toHaveBeenLastCalledWith({ workerRoles: { orchestrating: { modelId: 'claude:sonnet', reasoningEffort: 'medium', speed: 'ultrafast' } } })
    }
    expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toHaveTextContent('Medium, Standard')
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Thread reasoning' }), { key: 'ArrowRight' })
    if (workerRoles) expect(updateSettings).toHaveBeenLastCalledWith({ workerRoles: { orchestrating: { modelId: 'claude:sonnet', reasoningEffort: 'high', speed: 'ultrafast' } } })
    else expect(updateSettings).not.toHaveBeenCalled()
    setPromptText(screen.getByRole('textbox', { name: 'Watcher message' }), 'Keep the saved speed.')
    fireEvent.click(screen.getByRole('button', { name: 'Start Watcher and send' }))
    await waitFor(() => expect(bridge.open).toHaveBeenCalledWith({ provider: 'claude', modelId: 'claude:sonnet', reasoningEffort: 'high',
      ...(!alreadySaved ? { speed: 'ultrafast', speedSourceModelId: 'codex:gpt' } : {}) }))
  })

  it.each([['question', false], ['question', true], ['permission', false], ['permission', true]] as const)('queues a follow-up while Watcher waits on a %s card (quiet: %s) without answering it', async (kind, quiet) => {
    const state = stateWithWatcher()
    const thread = state.host.threads.find(item => item.id === 'watcher')!
    const request: AgentThread['requests'][number] = kind === 'question'
      ? { id: 'card', kind, text: 'Which branch?', options: [{ id: 'main', label: 'Main' }, { id: 'release', label: 'Release' }], skippable: true }
      : { id: 'card', kind, text: 'Allow the command?', options: [], permissionChoices: [{ id: 'allow', label: 'Allow', kind: 'allow-once' as const }] }
    thread.requests = [request]
    // Providers may report idle while waiting on a card; the card still holds delivery.
    thread.status = 'idle'
    const { command } = renderRoom(state, roomState(), true, quiet)
    await paneReady()
    const prompt = screen.getByRole('textbox', { name: 'Watcher message' })
    expect(prompt).toHaveAttribute('contenteditable', 'true')
    setPromptText(prompt, 'After this, check the release notes.')
    const queue = screen.getByRole('button', { name: 'Queue prompt' })
    expect(queue).toBeEnabled()
    fireEvent.click(queue)
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'queue-followup', threadId: 'watcher', text: 'After this, check the release notes.' })))
    expect(command.mock.calls.some(([item]) => item.type === 'answer' || item.type === 'steer' || item.type === 'manual-send')).toBe(false)
    expect(thread.requests).toEqual([request])
    expect(screen.getByRole('region', { name: 'Queued messages' })).toHaveTextContent('After this, check the release notes.')
    expect(promptText(prompt)).toBe('')
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
    const { bridge, publish } = fakeBridge(roomState({ current: null, currentOptions: null, watchedThreads: [], requests: [] }))
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
    const { bridge } = fakeBridge(roomState({ current: null, currentOptions: null, watchedThreads: [], requests: [] }))
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

  it('offers a Muse model for Watcher where Muse is shown, and starts Watcher on Muse with it', async () => {
    const state = stateWithWatcher()
    state.host.models = [{ id: 'muse:fixture', provider: 'Muse', providerId: 'muse', name: 'Fixture Muse', ready: true }]
    mockApp('watcher', true, true)
    mockAgents(state)
    const { bridge } = fakeBridge(roomState({ current: null, currentOptions: null, watchedThreads: [], requests: [] }))
    render(<WatcherRoomProvider bridge={bridge}><SidebarChromeProvider updateControl={null}><WatcherView now={NOW} /></SidebarChromeProvider></WatcherRoomProvider>)
    expect(await screen.findByText('On Fixture Muse, with your own Muse account.')).toBeInTheDocument()
    setPromptText(await screen.findByRole('textbox', { name: 'Watcher message' }), 'Keep an eye on the footer links.')
    fireEvent.click(screen.getByRole('button', { name: 'Start Watcher and send' }))
    await waitFor(() => expect(bridge.open).toHaveBeenCalledWith(expect.objectContaining({ provider: 'muse', modelId: 'muse:fixture' })))
  })

  it('never offers Devin for Watcher, and says where to connect a provider when none can host it', async () => {
    const state = stateWithWatcher()
    state.host.models = [{ id: 'devin:agent', provider: 'Devin', name: 'Devin', ready: true }]
    renderRoom(state, roomState({ current: null, currentOptions: null }))
    expect(await screen.findByText(/Connect Codex, Claude Code or Grok Build in Settings/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start Watcher and send' })).toBeNull()
  })

  it('shows Watcher’s own pane under the Sotto Owl tile, with its own permissions and none of a thread’s Git, menu or permissions controls', async () => {
    const { command } = renderRoom(stateWithWatcher(), roomState())
    const pane = await screen.findByRole('region', { name: 'Watcher' })
    expect(within(pane).getByRole('heading', { level: 1, name: 'Watcher' })).toBeInTheDocument()
    // Once Watcher runs, the tile is the button for its context and state (#1189).
    expect(within(pane).getByRole('button', { name: 'Watcher’s context and state' })).toBeInTheDocument()
    // The tile is the owl in the corner; the small owl that sat before Watcher's name is gone, and so is the sidebar.
    expect(pane.querySelector('.watcher-head .thread-workspace__title > .watcher-owl')).toBeNull()
    expect(screen.queryByRole('complementary')).toBeNull()
    // The room is Watcher's conversation alone: its header holds no tabs (Zach, October 27, 2026).
    expect(within(pane).queryByRole('tablist', { name: 'Watcher’s view' })).toBeNull()
    expect(within(pane).queryByRole('tab', { name: /^Conversation$|^Watched|^Visualize$/ })).toBeNull()
    expect(within(pane).queryByRole('meter')).toBeNull()
    expect(within(pane).getByText('Watching Footer links.')).toBeInTheDocument()
    // Watcher's replies are signed Watcher, whatever provider it runs on.
    expect(within(pane).getByText('Watcher', { selector: '.thread-message__who' })).toBeInTheDocument()
    expect(within(pane).queryByText('Codex', { selector: '.thread-message__who' })).toBeNull()
    expect(within(pane).getByRole('textbox', { name: 'Watcher message' })).toBeInTheDocument()
    expect(within(pane).getByRole('combobox', { name: 'Watcher’s permissions' })).toHaveTextContent('Ask for approval')
    expect(within(pane).queryByRole('combobox', { name: 'Thread permissions' })).toBeNull()
    expect(within(pane).queryByRole('button', { name: 'More actions' })).toBeNull()
    // Watcher's history is read while the room shows it; nothing selects it on the Threads page.
    expect(command).toHaveBeenCalledWith({ type: 'observe-threads', threadIds: ['watcher'] })
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'select-thread' }))
  })

  const ROW = 100
  const VIEW = 500
  /** Lays transcripts out in jsdom: each message one row under its transcript's top, moved by its scroll. */
  function layOutTranscripts(): void {
    const tops = new WeakMap<Element, number>()
    const height = (element: HTMLElement): number => element.querySelectorAll('.thread-message').length * ROW
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return height(this) })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => VIEW)
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return tops.get(this) ?? 0 })
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) { tops.set(this, Math.max(0, Math.min(value, height(this) - VIEW))) })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const log = this.closest<HTMLElement>('.thread-workspace__transcript')
      const index = log === null || !this.matches('.thread-message') ? -1 : [...log.querySelectorAll('.thread-message')].indexOf(this)
      const top = index < 0 ? 0 : index * ROW - log!.scrollTop
      return { top, bottom: index < 0 ? VIEW : top + ROW, left: 0, right: 600, width: 600, height: index < 0 ? VIEW : ROW, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    })
  }
  const history = (id: string, from = 0) => Array.from({ length: 40 - from }, (_, index) => ({ id: `${id}-${index + from}`, role: (index + from) % 2 ? 'assistant' as const : 'user' as const,
    text: `${id} ${index + from}`, createdAt: at }))
  /** The window let a thread's history go: it comes back with none, saying it has some, until the history arrives. */
  const withoutHistory = (state: AgentState, threadId: string): AgentState => {
    const next = structuredClone(state)
    next.host.threads = next.host.threads.map(item => item.id !== threadId ? item
      : { ...item, messages: [], historyStatus: 'loading' as const, summary: { messageCount: item.messages.length, activityCount: 0 } })
    return next
  }

  it.each(['news', 'watcher-1'])('offers Steer now while Watcher works, on Sotto’s news as on the user’s message (#1188), head %s', async head => {
    const state = stateWithWatcher()
    state.host.capabilities = { ...state.host.capabilities, steer: true }
    Object.assign(state.host.threads.find(thread => thread.id === 'watcher')!, { status: 'running', lastUserMessageId: head, wakeUpMessageIds: ['news'] })
    state.followups = [{ id: 'queued', threadId: 'watcher', draftId: 'draft', text: 'Watch them again', attachments: [], status: 'queued', createdAt: at, updatedAt: at }]
    renderRoom(state, roomState())
    const pane = await screen.findByRole('region', { name: 'Watcher' })
    expect(within(within(pane).getByRole('region', { name: 'Queued messages' })).getAllByText('Watch them again').length).toBeGreaterThan(0)
    expect(within(pane).getAllByRole('button', { name: 'Steer now' }).length).toBeGreaterThan(0)
  })

  it('keeps Watcher’s reading position, and a beside thread’s, for a trip to another room', async () => {
    layOutTranscripts()
    try {
      const state = stateWithWatcher()
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
      // Back with fewer of Watcher's messages in the window: the message that was at the top is at the top again.
      view.rerender(tree(false))
      const shorter = structuredClone(state)
      shorter.host.threads.find(thread => thread.id === 'watcher')!.messages = history('watcher', 10)
      mockAgents(shorter)
      view.rerender(tree(true))
      await paneReady()
      expect(transcript('Watcher').scrollTop).toBe(200)
      expect(transcript('Watcher').querySelectorAll('.thread-message')[2]).toHaveTextContent('watcher 12')
      // A reader back at the end follows again, and the next return finds the end.
      transcript('Watcher').scrollTop = 30 * ROW
      fireEvent.scroll(transcript('Watcher'))
      view.rerender(tree(false))
      view.rerender(tree(true))
      await paneReady()
      expect(transcript('Watcher').scrollTop).toBe(30 * ROW - VIEW)
    } finally { vi.restoreAllMocks() }
  })

  it('waits for a thread’s history before putting its reader back, and never keeps the empty view as the place', async () => {
    layOutTranscripts()
    try {
      const state = stateWithWatcher()
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
      fireEvent.click(screen.getByRole('button', { name: 'All threads, 9. Show the list' }))
      fireEvent.click(screen.getByRole('button', { name: 'Open Footer links beside Watcher' }))
      transcript('Footer links').scrollTop = 700
      fireEvent.scroll(transcript('Footer links'))
      transcript('Watcher').scrollTop = 1_200
      fireEvent.scroll(transcript('Watcher'))
      view.rerender(tree(false))
      // Back after other threads pushed both histories out of the window: each pane draws an empty transcript first,
      // which scrolls as it settles. That is not where either reader was.
      mockAgents(withoutHistory(withoutHistory(state, 'footer-links'), 'watcher'))
      view.rerender(tree(true))
      await screen.findByRole('region', { name: 'Footer links' })
      expect(transcript('Footer links')).toHaveAttribute('aria-busy', 'true')
      fireEvent.scroll(transcript('Footer links'))
      fireEvent.scroll(transcript('Watcher'))
      // The histories arrive: both readers are back where they were, not at the newest message.
      mockAgents(state)
      view.rerender(tree(true))
      await waitFor(() => expect(transcript('Footer links').scrollTop).toBe(700))
      expect(transcript('Watcher').scrollTop).toBe(1_200)
      expect(screen.getAllByRole('button', { name: 'Jump to latest' })).toHaveLength(2)
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
    expect(within(pane).getByRole('combobox', { name: 'Watcher’s permissions' })).toHaveTextContent('Ask for approval')
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

  it('names a thread whose prototype waits for review in the needs-you line, and the Overview opens its first page (ADR-0108)', async () => {
    const state = stateWithWatcher()
    const pages = [{ token: 'f'.repeat(32), kind: 'file' as const, name: 'settings-prototype.html', start: 'settings-prototype.html' },
      { token: 's'.repeat(32), kind: 'server' as const, name: 'localhost:8075', start: '' }]
    state.host.threads.find(thread => thread.id === 'grok-previews')!.prototypeReady = { source: 'reply:grok-previews-2', pages }
    const openQuestionPage = vi.fn(async () => ({ ok: true as const }))
    const before = window.sotto
    window.sotto = { ...before, openQuestionPage } as unknown as NonNullable<typeof window.sotto>
    try {
      renderRoom(state, roomState())
      await paneReady()
      const line = screen.getByRole('heading', { level: 2, name: '3 need you' }).closest('section')!
      const name = within(line).getByRole('button', { name: 'Open Grok voice previews to review its prototype' })
      expect(name.closest('li')).toHaveTextContent('prototype to review')
      fireEvent.click(screen.getByRole('button', { name: 'All threads, 9. Show the list' }))
      const list = within(screen.getByRole('dialog', { name: 'All threads' }))
      const row = list.getByRole('button', { name: 'Open Grok voice previews beside Watcher' }).closest('li')!
      expect(row.closest('section')).toHaveAccessibleName('Needs you, 3 threads')
      expect(row).toHaveTextContent('Prototype to review')
      const open = within(row).getByRole('button', { name: 'Open the prototype, settings-prototype.html' })
      expect(open).toHaveTextContent('Open the prototype')
      fireEvent.click(open)
      expect(openQuestionPage).toHaveBeenCalledExactlyOnceWith({ threadId: 'grok-previews', token: pages[0]!.token })
      await waitFor(() => expect(openQuestionPage).toHaveBeenCalledTimes(1))
    } finally { if (before === undefined) delete window.sotto; else window.sotto = before }
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

  it('groups an idle thread whose sub-agents are confirmed working under Working, and one whose agents are unknown under Idle', async () => {
    // The Overview reads the same active-work rule as Watcher's quiet news and list_threads (#1157, Bug Bot finding 6 on #1163).
    const groups = async (working: number, unknown: number) => {
      const state = stateWithWatcher()
      state.host.threads.find(thread => thread.id === 'grok-previews')!.subagentSummary = { total: 3, working, unknown, completed: 3 - working - unknown, failed: 0, interrupted: 0 }
      renderRoom(state, roomState())
      await paneReady()
      fireEvent.click(screen.getByRole('button', { name: 'All threads, 9. Show the list' }))
      const list = within(screen.getByRole('dialog', { name: 'All threads' }))
      const seen = { headings: list.getAllByRole('heading', { level: 3 }).map(heading => heading.getAttribute('aria-label')),
        group: list.getByRole('button', { name: 'Open Grok voice previews beside Watcher' }).closest('li')!.getAttribute('data-group') }
      cleanup()
      return seen
    }
    expect(await groups(2, 0)).toEqual({ headings: ['Needs you, 2 threads', 'Working, 3 threads', 'Idle, 4 threads'], group: 'working' })
    expect(await groups(0, 3)).toEqual({ headings: ['Needs you, 2 threads', 'Working, 2 threads', 'Idle, 5 threads'], group: 'idle' })
  })

  it('shows a settled thread the filter matches without unfolding Settled, and folds it again once the filter is cleared', async () => {
    renderRoom(stateWithWatcher(), roomState())
    await paneReady()
    fireEvent.click(screen.getByRole('button', { name: 'All threads, 9. Show the list' }))
    const list = within(screen.getByRole('dialog', { name: 'All threads' }))
    const filter = list.getByRole('searchbox', { name: 'Filter threads' })
    fireEvent.change(filter, { target: { value: 'benchmark' } })
    // As in the Threads sidebar, a search reaches into Settled: the match shows, and the fold says it is open.
    expect(list.getByRole('button', { name: 'Open Benchmark rerun beside Watcher' })).toBeInTheDocument()
    expect(list.getByRole('button', { name: 'Settled, 1 thread' })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.change(filter, { target: { value: '' } })
    expect(list.queryByRole('button', { name: 'Open Benchmark rerun beside Watcher' })).toBeNull()
    expect(list.getByRole('button', { name: 'Settled, 4 threads' })).toHaveAttribute('aria-expanded', 'false')
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

  it('stops reading a beside thread when its pane closes before Watcher exists, so main does not count it as seen', async () => {
    const { command } = renderRoom(stateWithWatcher(), roomState({ current: null, currentOptions: null, watchedThreads: [], requests: [] }))
    await screen.findByRole('heading', { level: 2, name: 'Start Watcher' })
    fireEvent.click(screen.getByRole('button', { name: /^All threads, \d+\. Show the list$/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Open Weekly note beside Watcher' }))
    const beside = await screen.findByRole('region', { name: 'Weekly note' })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'observe-threads', threadIds: ['weekly-note'] }))
    command.mockClear()
    // Only the pane closes; the room stays, so its unmount cleanup never runs. The empty list has to go on its own.
    fireEvent.click(within(beside).getByRole('button', { name: 'Close Weekly note pane' }))
    expect(screen.queryByRole('region', { name: 'Weekly note' })).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: 'Start Watcher' })).toBeInTheDocument()
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'observe-threads', threadIds: [] }))
  })

  it('folds an open disclosure on Escape in a beside thread, and the next Escape closes the pane', async () => {
    const state = stateWithWatcher()
    const previews = state.host.threads.find(thread => thread.id === 'grok-previews')!
    previews.activities = [
      { id: 'lifecycle', turnId: 'turn-1', sequence: 0, kind: 'turn', status: 'completed', title: 'Turn', afterMessageId: 'grok-previews-1', durationMs: 124_000, timingSource: 'provider' },
      { id: 'test', turnId: 'turn-1', sequence: 1, kind: 'command', status: 'completed', title: 'Command', afterMessageId: 'grok-previews-1', command: 'npm test -- --run', output: 'PASS 12 tests' },
    ]
    renderRoom(state, roomState())
    await paneReady()
    fireEvent.click(screen.getByRole('button', { name: 'All threads, 9. Show the list' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open Grok voice previews beside Watcher' }))
    const beside = await screen.findByRole('region', { name: 'Grok voice previews' })
    const work = within(beside).getByRole('button', { name: 'Worked for 2m 04s · 1 step' })
    work.focus()
    fireEvent.click(work)
    expect(work).toHaveAttribute('aria-expanded', 'true')
    // On its button, Escape folds what the button opened; the pane stays.
    fireEvent.keyDown(work, { key: 'Escape' })
    expect(work).toHaveAttribute('aria-expanded', 'false')
    expect(work).toHaveFocus()
    expect(screen.getByRole('region', { name: 'Grok voice previews' })).toBeInTheDocument()
    // From inside what it shows, Escape folds it too and puts focus back on its button.
    fireEvent.click(work)
    const group = within(beside).getByRole('button', { name: 'Ran 1 command' })
    group.focus()
    // The group opened with the fold, so Escape folds it first, then the fold.
    fireEvent.keyDown(group, { key: 'Escape' })
    expect(group).toHaveAttribute('aria-expanded', 'false')
    fireEvent.keyDown(group, { key: 'Escape' })
    expect(work).toHaveAttribute('aria-expanded', 'false')
    expect(work).toHaveFocus()
    // Nothing left open: Escape closes the pane.
    fireEvent.keyDown(work, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Grok voice previews' })).toBeNull()
  })

  describe('a fork made beside Watcher (#1136)', () => {
    /** Grok voice previews as a finished Claude Code thread, with Fork from here shown (Owl), opened beside Watcher. */
    async function forkable(answer: (request: Extract<AgentCommand, { type: 'fork-thread' }>, state: AgentState) => AgentState, held?: Promise<void>) {
      const state = stateWithWatcher()
      state.host.threads.find(thread => thread.id === 'grok-previews')!.providerId = 'claude'
      state.host.models = state.host.models.map(model => model.id === 'claude:sonnet' ? { ...model, providerId: 'claude' as const } : model)
      mockApp('watcher')
      const app = vi.mocked(useOptionalApp)()!
      vi.mocked(useOptionalApp).mockReturnValue({ ...app, update: { watcherEnabled: true, owlFeatures: { watcher: true, 'continue-agent-thread': true } } } as unknown as AppContextValue)
      const show = (shown: AgentState): void => {
        const connection = agentContextFixture(shown, command, { threadDrafts: new ThreadDraftStore(command) })
        vi.mocked(useAgents).mockReturnValue(connection)
        vi.mocked(useOptionalAgents).mockReturnValue(connection)
      }
      const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async request => {
        if (request.type !== 'fork-thread') return state
        await held
        const next = answer(request, state)
        // Main's reply reaches the window before the press hears it, as AgentContext commits it.
        show(next)
        return next
      })
      show(state)
      const { bridge } = fakeBridge(roomState())
      render(<WatcherRoomProvider bridge={bridge}><SidebarChromeProvider updateControl={null}><WatcherView now={NOW} /></SidebarChromeProvider></WatcherRoomProvider>)
      await paneReady()
      fireEvent.click(screen.getByRole('button', { name: /^All threads, \d+\. Show the list$/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Open Grok voice previews beside Watcher' }))
      const beside = await screen.findByRole('region', { name: 'Grok voice previews' })
      const user = userEvent.setup()
      await user.click(within(beside).getByRole('button', { name: /^Fork from here/u }))
      await user.click(within(beside).getByRole('button', { name: 'Fork' }))
      return { command }
    }

    it('opens the fork beside Watcher in place of its source, with the cursor in its composer, so the next message goes to the fork', async () => {
      const { command } = await forkable((request, state) => {
        const next = structuredClone(state)
        const source = next.host.threads.find(thread => thread.id === 'grok-previews')!
        next.host.threads.push({ ...structuredClone(source), id: request.newThreadId, title: 'Fork of Grok voice previews' })
        next.activeThreadId = request.newThreadId
        return next
      })
      const fork = await screen.findByRole('region', { name: 'Fork of Grok voice previews' })
      const forkId = (command.mock.calls.find(([request]) => request.type === 'fork-thread')![0] as Extract<AgentCommand, { type: 'fork-thread' }>).newThreadId
      expect(fork).toHaveAttribute('id', 'watcher-beside-pane')
      expect(fork).toHaveAttribute('data-thread-id', forkId)
      expect(roomView.get().besideId).toBe(forkId)
      expect(screen.queryByRole('region', { name: 'Grok voice previews' })).toBeNull()
      await waitFor(() => expect(fork.querySelector('.thread-workspace__compose .prompt-editor')).toHaveFocus())
      await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'observe-threads', threadIds: ['watcher', forkId] }))
    })

    it('leaves another thread opened beside Watcher while the fork was made where it is', async () => {
      let release = (): void => undefined
      const held = new Promise<void>(resolve => { release = resolve })
      const { command } = await forkable((request, state) => {
        const next = structuredClone(state)
        const source = next.host.threads.find(thread => thread.id === 'grok-previews')!
        next.host.threads.push({ ...structuredClone(source), id: request.newThreadId, title: 'Fork of Grok voice previews' })
        return next
      }, held)
      fireEvent.click(screen.getByRole('button', { name: /^All threads, \d+\. Show the list$/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Open Weekly note beside Watcher' }))
      expect(await screen.findByRole('region', { name: 'Weekly note' })).toHaveAttribute('id', 'watcher-beside-pane')
      await act(async () => { release(); await command.mock.results.find((_result, index) => command.mock.calls[index]![0].type === 'fork-thread')!.value })
      expect(roomView.get().besideId).toBe('weekly-note')
      expect(screen.getByRole('region', { name: 'Weekly note' })).toBeInTheDocument()
      expect(screen.queryByRole('region', { name: 'Fork of Grok voice previews' })).toBeNull()
    })

    it('leaves the original beside Watcher when the fork fails, with the card saying why', async () => {
      await forkable((_request, state) => ({ ...state, error: 'Sotto no longer has that reply in this thread, so nothing was made. Refresh the thread and try again.' }))
      const beside = screen.getByRole('region', { name: 'Grok voice previews' })
      expect(await within(beside).findByRole('alert')).toHaveTextContent('Sotto no longer has that reply in this thread, so nothing was made.')
      expect(roomView.get().besideId).toBe('grok-previews')
      expect(beside).toHaveAttribute('data-thread-id', 'grok-previews')
      expect(within(beside).getByRole('region', { name: 'Fork from here' })).toBeInTheDocument()
    })
  })

  it('opens a thread at its failed turn on that turn’s line, not on its title', async () => {
    const state = stateWithWatcher()
    const stall = state.host.threads.find(thread => thread.id === 'wav-stall')!
    stall.activities = [
      { id: 'stall-turn', turnId: 'stall-1', sequence: 0, kind: 'turn', status: 'failed', title: 'Turn', afterMessageId: 'wav-stall-1', durationMs: 124_000, timingSource: 'provider',
        error: 'The playback test failed again.' },
      { id: 'stall-test', turnId: 'stall-1', sequence: 1, kind: 'command', status: 'failed', title: 'Command', afterMessageId: 'wav-stall-1', command: 'npm test -- wav', exitCode: 1 },
    ]
    renderRoom(state, roomState())
    await paneReady()
    fireEvent.click(screen.getByRole('button', { name: 'Open Streaming WAV stall at its failed turn' }))
    const beside = await screen.findByRole('region', { name: 'Streaming WAV stall' })
    const failed = within(beside).getByRole('button', { name: 'Failed after 2m 04s · 1 step' })
    await waitFor(() => expect(failed).toHaveFocus())
    expect(failed.closest('[data-turn-outcome="failed"]')).toHaveTextContent('The playback test failed again.')
  })

  it('opens a failed thread with no turn record at the end of its transcript, where the failed turn ended, over a kept place', async () => {
    layOutTranscripts()
    try {
      const state = stateWithWatcher()
      state.host.threads.find(thread => thread.id === 'wav-stall')!.messages = history('stall')
      renderRoom(state, roomState())
      await paneReady()
      const transcript = () => within(screen.getByRole('region', { name: 'Streaming WAV stall' })).getByRole('log', { name: 'Thread transcript' })
      // Read earlier in it once, and close it: that place is kept for its next opening.
      fireEvent.click(screen.getByRole('button', { name: 'All threads, 9. Show the list' }))
      fireEvent.click(screen.getByRole('button', { name: 'Open Streaming WAV stall beside Watcher' }))
      await screen.findByRole('region', { name: 'Streaming WAV stall' })
      transcript().scrollTop = 700
      fireEvent.scroll(transcript())
      fireEvent.click(screen.getByRole('button', { name: 'Close Streaming WAV stall pane' }))
      // Closing hands focus back on the next turn of the event loop; let it land before the next press.
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      // Opened at its failed turn, it shows the end, where that turn ended, with the transcript focused.
      fireEvent.click(screen.getByRole('button', { name: 'Open Streaming WAV stall at its failed turn' }))
      await screen.findByRole('region', { name: 'Streaming WAV stall' })
      await waitFor(() => expect(transcript()).toHaveFocus())
      expect(transcript().scrollTop).toBe(40 * ROW - VIEW)
    } finally { vi.restoreAllMocks() }
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

  it('takes a beside thread’s pull request badge to its pull request in Tools, on the Threads page with the thread selected', async () => {
    toolsPanelStore.setOpen(false)
    const state = stateWithWatcher()
    state.host.threads.find(thread => thread.id === 'footer-links')!.worktree = { mode: 'shared', status: 'ready', path: 'C:/work/app', repositoryRoot: 'C:/work/app', branch: 'fix/footer',
      git: { isRepository: true, branch: 'fix/footer', upstream: 'origin/fix/footer', hasRemote: true, defaultBranch: 'main', isDefaultBranch: false, dirty: false, changedFiles: 0, insertions: 0,
        deletions: 0, ahead: 0, behind: 0, aheadOfDefault: null, fetchedAt: null, readAt: at,
        pullRequest: { number: 12, title: 'Fix the footer links', url: 'https://github.com/o/r/pull/12', state: 'open', draft: false } } }
    const { command, navigate } = renderRoom(state, roomState())
    await paneReady()
    fireEvent.click(screen.getByRole('button', { name: 'All threads, 9. Show the list' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open Footer links beside Watcher' }))
    const beside = await screen.findByRole('region', { name: 'Footer links' })
    // The room has no Tools panel, so the badge says where it goes.
    fireEvent.click(within(beside).getByRole('button', { name: 'Open PR #12 - Open: Fix the footer links in Tools on the Threads page' }))
    expect(toolsPanelStore.getSnapshot()).toMatchObject({ open: true, surface: 'pull-request' })
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('threads'))
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: 'footer-links' })
    toolsPanelStore.setOpen(false)
  })

  it('has no limit to set: once Watcher runs its header holds no More Watcher actions, and the watched count is not capped', async () => {
    renderRoom(stateWithWatcher(), roomState())
    await paneReady()
    expect(screen.queryByRole('button', { name: 'More Watcher actions' })).toBeNull()
    expect(screen.queryByText('Threads in flight')).toBeNull()
  })

  /** A window whose Sotto browser opens `footer-links`' pages, and whose system browser opens anything. */
  function withBrowser(): { readonly browser: ReturnType<typeof browserBridgeFixture>; readonly openExternalLink: ReturnType<typeof vi.fn>; readonly restore: () => void } {
    const workspace = { threadId: 'footer-links', projectId: 'workshop', workingDirectory: 'D:/work/workshop', workspaceId: '0f8fad5b-d9cb-469f-a165-70867728950e' }
    const browser = browserBridgeFixture({ workspace, commands: {
      openLink: vi.fn(async ({ url }) => ({ ok: true as const, value: { destination: 'embedded' as const, page: browserPage(workspace, { id: '7c9e6679-7425-40de-944b-e07fc1f90ae7', url, title: 'Docs' }) } })),
    } })
    const openExternalLink = vi.fn(async () => ({ ok: true }))
    Object.defineProperty(window, 'sotto', { configurable: true, value: { browser: browser.bridge, openExternalLink } })
    return { browser, openExternalLink, restore: () => { Reflect.deleteProperty(window, 'sotto') } }
  }

  it('shows a beside thread’s page in Sotto’s browser on the Threads page, with the thread selected, since the room has no Tools', async () => {
    toolsPanelStore.setOpen(false)
    const { browser, restore } = withBrowser()
    try {
      const state = stateWithWatcher()
      const footer = state.host.threads.find(thread => thread.id === 'footer-links')!
      footer.messages = [...footer.messages, { id: 'footer-docs', role: 'assistant', text: 'See [the docs](https://example.com/docs).', createdAt: at }]
      const { command, navigate } = renderRoom(state, roomState())
      await paneReady()
      fireEvent.click(screen.getByRole('button', { name: 'All threads, 9. Show the list' }))
      fireEvent.click(screen.getByRole('button', { name: 'Open Footer links beside Watcher' }))
      const beside = await screen.findByRole('region', { name: 'Footer links' })
      await userEvent.click(within(beside).getByRole('link', { name: 'the docs' }))
      await waitFor(() => expect(browser.bridge.openLink).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com/docs' })))
      await waitFor(() => expect(navigate).toHaveBeenCalledWith('threads'))
      expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: 'footer-links' })
      expect(toolsPanelStore.getSnapshot()).toMatchObject({ open: true, surface: 'browser' })
      expect(toolsPanelStore.browser.thread('footer-links')?.activePageId).toBe('7c9e6679-7425-40de-944b-e07fc1f90ae7')
    } finally { restore(); toolsPanelStore.setOpen(false) }
  })

  it('opens links in Watcher’s own conversation in the system browser, since nothing shows Watcher’s browser', async () => {
    const { browser, openExternalLink, restore } = withBrowser()
    try {
      const state = stateWithWatcher()
      const watcher = state.host.threads.find(thread => thread.id === 'watcher')!
      watcher.messages = [...watcher.messages, { id: 'watcher-docs', role: 'assistant', text: 'See [the docs](https://example.com/docs).', createdAt: at }]
      const { navigate } = renderRoom(state, roomState())
      await paneReady()
      const link = within(screen.getByRole('region', { name: 'Watcher' })).getByRole('link', { name: 'the docs' })
      fireEvent.contextMenu(link, { clientX: 40, clientY: 60 })
      expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Open in system browser', 'Copy link'])
      await userEvent.keyboard('{Escape}')
      await userEvent.click(link)
      await waitFor(() => expect(openExternalLink).toHaveBeenCalledWith('https://example.com/docs'))
      expect(browser.bridge.openLink).not.toHaveBeenCalled()
      expect(navigate).not.toHaveBeenCalled()
    } finally { restore() }
  })
})

describe('the room switch', () => {
  function foot(navigation: AppNavigation, watcherEnabled = true) {
    const navigate = mockApp(navigation, watcherEnabled)
    const view = render(<SidebarFoot />)
    return { navigate, view, tabs: () => within(screen.getByRole('tablist', { name: 'Page' })).getAllByRole('tab') }
  }

  it('puts the owl between Dictate and Threads, every tile named and tipped, with one tab stop', () => {
    const { tabs } = foot('home')
    expect(tabs().map(tab => tab.getAttribute('aria-label'))).toEqual(['Dictate', 'Watcher', 'Threads'])
    // Every tile's tip names its page shortcut too (ADR-0158).
    expect(tabs().map(tab => tab.getAttribute('title'))).toEqual(['Dictate (Ctrl+1)', 'Watcher (Ctrl+2)', 'Threads (Ctrl+3)'])
    expect(tabs().map(tab => tab.tabIndex)).toEqual([0, -1, -1])
  })

  for (const from of ['home', 'threads', 'settings', 'help', 'memory'] as const) it(`reaches all three rooms from the keyboard on ${from}`, () => {
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

  it('puts the way off the page right after All threads: the room switch, a hairline, the pages and the update, each a press of its own', async () => {
    const navigate = mockApp('watcher')
    mockAgents(stateWithWatcher())
    const { bridge } = fakeBridge(roomState())
    const onActivate = vi.fn()
    const update = { status: { phase: { phase: 'available', version: '9.9.9', problem: null } }, busy: false, onActivate } as unknown as UpdateControlProps
    render(<WatcherRoomProvider bridge={bridge}><SidebarChromeProvider updateControl={null}><WatcherView now={NOW} update={update} /></SidebarChromeProvider></WatcherRoomProvider>)
    await paneReady()
    const head = document.querySelector<HTMLElement>('.watcher-head')!
    // In the order the eye reads them, and all before Stop all's end of the header: All threads, the room switch with
    // its owl lit, then Settings and Help (Usage and Memory are behind their gates here), then the update. No More menu.
    const list = within(head).getByRole('button', { name: /^All threads, \d+\. Show the list$/ })
    const rooms = within(head).getByRole('tablist', { name: 'Page' })
    expect(within(rooms).getByRole('tab', { name: 'Watcher' })).toHaveAttribute('aria-selected', 'true')
    const pages = within(head).getByRole('navigation', { name: 'Pages' })
    expect(within(pages).getAllByRole('link').map(link => link.textContent)).toEqual(['Settings', 'Help'])
    const updating = within(head).getByRole('button', { name: 'Update 9.9.9 ready to download' })
    const order = [list, rooms, pages, updating]
    for (const [index, node] of order.slice(1).entries()) expect(order[index]!.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(head.querySelector('.thread-workspace__title .watcher-head__way')).not.toBeNull()
    expect(within(head).queryByRole('button', { name: /^More/ })).toBeNull()
    fireEvent.click(within(pages).getByRole('link', { name: 'Settings' }))
    expect(navigate).toHaveBeenCalledWith('settings')
    fireEvent.click(updating)
    expect(onActivate).toHaveBeenCalledWith('download')
  })

  it('has no update control where the app does not update itself, and keeps its pages', async () => {
    renderRoom(stateWithWatcher(), roomState())
    await paneReady()
    const head = document.querySelector<HTMLElement>('.watcher-head')!
    expect(head.querySelector('.update-control')).toBeNull()
    expect(within(within(head).getByRole('navigation', { name: 'Pages' })).getAllByRole('link').map(link => link.textContent)).toEqual(['Settings', 'Help'])
  })

  it('is Dictate | Threads alone with the gate off', () => {
    const { tabs } = foot('threads', false)
    expect(tabs().map(tab => tab.getAttribute('aria-label'))).toEqual(['Dictate', 'Threads'])
  })
})

describe('a watched thread', () => {
  function renderThreadsPage(watcherEnabled: boolean) {
    const state = stateWithWatcher()
    state.activeThreadId = 'footer-links'
    mockApp('threads', watcherEnabled)
    mockAgents(state)
    // Watcher started Footer links, so main keeps a standing watch on it.
    const { bridge } = fakeBridge(roomState({ standingWatches: [{ id: '5d1f0a6e-2c3b-4a59-8e7d-6f5e4d3c2b1a', target: target('footer-links'), createdAt: at, generation: 0 }] }))
    render(<WatcherRoomProvider bridge={bridge}><ThreadsView now={NOW} /></WatcherRoomProvider>)
    return bridge
  }

  it('shows the owl after its provider logo in its row and its pane, with Watch pressed and nothing under the composer', async () => {
    renderThreadsPage(true)
    const sidebar = within(screen.getByRole('complementary', { name: 'Thread sidebar' }))
    const row = await sidebar.findByRole('button', { name: 'Footer links' })
    await waitFor(() => expect(within(row).getByRole('img', { name: 'Watched by Watcher' })).toBeInTheDocument())
    expect(row).toHaveAccessibleDescription(/Watched by Watcher/)
    const pane = screen.getByRole('region', { name: 'Footer links' })
    expect(within(pane).getByRole('img', { name: 'Watched by Watcher' })).toBeInTheDocument()
    expect(within(pane).queryByRole('button', { name: 'Watched by Watcher' })).toBeNull()
    // Zach asked for the line under the composer to go: the header's Watch says the thread is watched, and stops it.
    expect(within(pane).queryByText(/Watched by Watcher\./)).toBeNull()
    expect(within(pane).queryByRole('button', { name: 'Stop watching Footer links' })).toBeNull()
    expect(within(pane).getByRole('button', { name: 'Watch Footer links' })).toHaveAttribute('aria-pressed', 'true')
    // Watcher itself lives in its room, not in the Threads list.
    expect(sidebar.queryByRole('button', { name: 'Watcher' })).toBeNull()
    expect(within(sidebar.getByRole('button', { name: 'Weekly note' })).queryByRole('img', { name: 'Watched by Watcher' })).toBeNull()
  })

  it('shows nothing of Watcher with the gate off, and never asks main', () => {
    const bridge = renderThreadsPage(false)
    expect(screen.queryAllByRole('img', { name: 'Watched by Watcher' })).toEqual([])
    expect(screen.queryByText(/Watched by Watcher/)).toBeNull()
    expect(screen.queryAllByRole('button', { name: /^Watch |^Stop watching/ })).toEqual([])
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

describe('Watcher’s night scene', () => {
  const scene = (container: HTMLElement) => container.querySelectorAll('#watcher-pane > canvas.watcher-scene')

  it('is drawn beside the first entry, hidden from assistive technology, and stays once the first message is sent', async () => {
    const { container } = renderRoom(stateWithWatcher(), roomState({ current: null, currentOptions: null, watchedThreads: [], requests: [] }))
    expect(await screen.findByRole('heading', { level: 2, name: 'Start Watcher' })).toBeInTheDocument()
    const canvases = scene(container)
    expect([...canvases].map(canvas => [canvas.className, canvas.getAttribute('aria-hidden'), canvas.hasAttribute('tabindex')])).toEqual([
      ['watcher-scene watcher-scene--land', 'true', false], ['watcher-scene watcher-scene--owl', 'true', false],
    ])
    // The thread owls' buttons answer the pointer only; All threads is the keyboard's way to the same threads.
    expect(container.querySelector('#watcher-pane > .watcher-scene--owls')).toHaveAttribute('aria-hidden', 'true')
    setPromptText(screen.getByRole('textbox', { name: 'Watcher message' }), 'Keep an eye on the footer links.')
    fireEvent.click(screen.getByRole('button', { name: 'Start Watcher and send' }))
    // The scene lives in the margins, so a conversation does not put it away.
    expect(await screen.findByRole('region', { name: 'Watcher' })).toBeInTheDocument()
    expect(scene(container)).toHaveLength(2)
    expect(scene(container)[0]).not.toHaveAttribute('data-leaving')
  })

  it('stays while Watcher’s conversation loads again or cannot be read', async () => {
    const withHistory = (historyStatus: AgentThread['historyStatus']): AgentState => {
      const state = stateWithWatcher()
      state.host.threads = state.host.threads.map(thread => thread.id === 'watcher' ? { ...thread, historyStatus } : thread)
      return state
    }
    mockApp('watcher')
    mockAgents(withHistory('ready'))
    const { bridge } = fakeBridge(roomState())
    const room = () => <WatcherRoomProvider bridge={bridge}><SidebarChromeProvider updateControl={null}><WatcherView now={NOW} /></SidebarChromeProvider></WatcherRoomProvider>
    const { container, rerender } = render(room())
    await paneReady()
    expect(scene(container)).toHaveLength(2)
    for (const status of ['loading', 'error', 'ready'] as const) {
      mockAgents(withHistory(status))
      rerender(room())
      expect(scene(container)).toHaveLength(2)
    }
  })

  it('does not exist with the Watcher gate off', () => {
    const { container } = renderRoom(stateWithWatcher(), roomState({ current: null, currentOptions: null, watchedThreads: [], requests: [] }), false)
    expect(container.querySelectorAll('canvas')).toHaveLength(0)
  })
})
