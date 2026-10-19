import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState, AgentThread } from '../../../src/shared/agents'
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
import { FIRST_MESSAGE_KEY, firstMessage } from '../../../src/renderer/src/watcher/watcherFirstMessage'
import { agentContextFixture } from '../../fixtures/agentContext'
import { threadsStateFixture } from '../../fixtures/agentState'
import { promptText, setPromptText } from './helpers/promptEditor'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn(), useOptionalAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const HOST = '6c0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a10'
const at = new Date(NOW).toISOString()
const identity: WatcherIdentity = { target: { hostId: HOST, threadId: 'watcher' }, projectId: 'workshop', provider: 'codex', creationOperationId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', createdAt: at }
const watcherThread: AgentThread = { id: 'watcher', kind: 'watcher', title: 'Watcher', projectId: 'workshop', modelId: 'codex:gpt', providerId: 'codex', status: 'idle', requests: [], messages: [] }
const room = (current: boolean): WatcherRoomState => ({ current: current ? identity : null,
  currentOptions: current ? { modelId: 'codex:gpt', reasoningEffort: null, status: 'idle', connected: true } : null, history: [], requests: [], watchedThreads: [],
  receipts: [], recoveryNotice: null, observedAt: at })
const kept = (phase: 'writing' | 'starting' | 'started', text = 'Keep an eye on the footer links.') =>
  sessionStorage.setItem(FIRST_MESSAGE_KEY, JSON.stringify({ text, modelId: '', effort: null, phase }))

function renderRoom(current: boolean) {
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'watcher', platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS, update: { watcherEnabled: true },
    actions: { navigate: vi.fn(), minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn() } } as unknown as AppContextValue)
  const state = threadsStateFixture()
  state.host.threads.push(structuredClone(watcherThread))
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => state)
  const connection = agentContextFixture(state, command, { threadDrafts: new ThreadDraftStore(command) })
  vi.mocked(useAgents).mockReturnValue(connection)
  vi.mocked(useOptionalAgents).mockReturnValue(connection)
  const ok = (next: WatcherRoomState): WatcherRoomResult => ({ status: 'ok', state: next })
  const listeners = new Set<(next: WatcherRoomState) => void>()
  const bridge = { get: vi.fn(async () => ok(room(current))), open: vi.fn(async () => ok(room(true))), prepareStopAll: vi.fn(), stopAll: vi.fn(),
    onChanged: vi.fn((listener: (next: WatcherRoomState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }) } as unknown as WatcherBridge
  const view = render(<WatcherRoomProvider bridge={bridge}><SidebarChromeProvider updateControl={null}><WatcherView now={NOW} /></SidebarChromeProvider></WatcherRoomProvider>)
  return { ...view, command, connection, publish: (next: WatcherRoomState) => { for (const listener of listeners) listener(next) } }
}

beforeEach(() => { vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalAgents).mockReset(); vi.mocked(useOptionalApp).mockReset(); sessionStorage.clear(); roomView.set({ besideId: null, share: 0.5, tab: 'conversation' }); firstMessage.clear() })
afterEach(() => { cleanup(); sessionStorage.clear() })

describe('Watcher’s first message', () => {
  it('is kept in the window’s session as it is written, and a reload finds it in the composer', async () => {
    const view = renderRoom(false)
    setPromptText(await screen.findByRole('textbox', { name: 'Watcher message' }), 'Keep an eye on the footer links.')
    expect(JSON.parse(sessionStorage.getItem(FIRST_MESSAGE_KEY)!)).toMatchObject({ text: 'Keep an eye on the footer links.', phase: 'writing' })
    view.unmount()
    // A reload: the window's memory goes and its session stays.
    const session = sessionStorage.getItem(FIRST_MESSAGE_KEY)!
    firstMessage.clear(); sessionStorage.setItem(FIRST_MESSAGE_KEY, session)
    firstMessage.reload()
    renderRoom(false)
    expect(promptText(await screen.findByRole('textbox', { name: 'Watcher message' }))).toBe('Keep an eye on the footer links.')
  })

  it('goes to Watcher once after a reload while main was creating it, and then leaves the session', async () => {
    kept('starting')
    firstMessage.reload()
    const { command } = renderRoom(true)
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'manual-send', threadId: 'watcher', text: 'Keep an eye on the footer links.' })))
    expect(command.mock.calls.filter(([request]) => request.type === 'manual-send')).toHaveLength(1)
    expect(sessionStorage.getItem(FIRST_MESSAGE_KEY)).toBeNull()
  })

  it('goes back to the composer, with nothing sent, when main says after the reload that there is no Watcher', async () => {
    kept('started', 'Start the release checks.')
    firstMessage.reload()
    const { command } = renderRoom(false)
    const field = await screen.findByRole('textbox', { name: 'Watcher message' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start Watcher and send' })).toBeEnabled())
    expect(promptText(field)).toBe('Start the release checks.')
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'manual-send' }))
  })

  it('becomes Watcher’s draft, unsent, when main was still creating Watcher as the window reloaded', async () => {
    kept('starting', 'Start the release checks.')
    firstMessage.reload()
    const { command, connection, publish } = renderRoom(false)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start Watcher and send' })).toBeEnabled())
    // Main finishes creating it: the first entry goes, and the words wait in Watcher's own composer.
    act(() => publish({ ...room(true), observedAt: new Date(NOW + 1_000).toISOString() }))
    await waitFor(() => expect(connection.threadDrafts.draft('watcher').text).toBe('Start the release checks.'))
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'manual-send' }))
    expect(sessionStorage.getItem(FIRST_MESSAGE_KEY)).toBeNull()
  })

  it('still becomes Watcher’s draft after a second reload while main goes on creating Watcher', async () => {
    kept('starting', 'Start the release checks.')
    firstMessage.reload()
    const first = renderRoom(false)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start Watcher and send' })).toBeEnabled())
    first.unmount()
    // The second reload: memory goes again, and only the session says the message is waiting for Watcher.
    const session = sessionStorage.getItem(FIRST_MESSAGE_KEY)!
    firstMessage.clear(); sessionStorage.setItem(FIRST_MESSAGE_KEY, session)
    firstMessage.reload()
    const { command, connection, publish } = renderRoom(false)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start Watcher and send' })).toBeEnabled())
    act(() => publish({ ...room(true), observedAt: new Date(NOW + 1_000).toISOString() }))
    await waitFor(() => expect(connection.threadDrafts.draft('watcher').text).toBe('Start the release checks.'))
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'manual-send' }))
  })

  it('keeps nothing it cannot read', () => {
    sessionStorage.setItem(FIRST_MESSAGE_KEY, '{"text":3}')
    firstMessage.reload()
    expect(firstMessage.get()).toEqual({ text: '', modelId: '', effort: null, phase: 'writing', error: null })
  })
})
