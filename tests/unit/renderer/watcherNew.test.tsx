import React from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState, AgentThread, HandoverCounts } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import type { WatcherIdentity, WatcherThreadTarget } from '../../../src/shared/watcher'
import type { WatcherBridge, WatcherHandoverRead, WatcherRoomResult, WatcherRoomState } from '../../../src/shared/watcherRoom'
import type { AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useAgents, useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { SidebarChromeProvider } from '../../../src/renderer/src/agents/SidebarFrame'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { WatcherRoomProvider } from '../../../src/renderer/src/watcher/watcherRoom'
import { roomView } from '../../../src/renderer/src/watcher/WatcherBeside'
import { WatcherView } from '../../../src/renderer/src/watcher/WatcherView'
import { carriesOnSentence, NEW_WATCHER_BUSY, NEW_WATCHER_EMPTY, NEW_WATCHER_TITLE } from '../../../src/renderer/src/watcher/WatcherNew'
import { firstMessage } from '../../../src/renderer/src/watcher/watcherFirstMessage'
import { agentContextFixture } from '../../fixtures/agentContext'
import { threadsStateFixture } from '../../fixtures/agentState'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn(), useOptionalAgents: vi.fn() }))

/**
 * New Watcher in the room (Zach's pick on October 21, 2026, variant A of `prototype/new-watcher-button`): a chip first in
 * Watcher's composer footer, where an ordinary thread says where it runs; unavailable with its reason while Watcher works
 * or has said nothing; a press that asks main for a new Watcher and says main's refusal; the handover strip's lead after
 * it; and the new Watcher's empty conversation.
 */
const NOW = E2E_THREADS_NOW
const HOST = '6c0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a10'
const OTHER_HOST = '22222222-2222-4222-8222-222222222222'
const at = new Date(NOW).toISOString()
const target = (threadId: string): WatcherThreadTarget => ({ hostId: HOST, threadId })
const identity = (threadId: string): WatcherIdentity => ({ target: target(threadId), projectId: 'workshop', provider: 'claude',
  creationOperationId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', createdAt: at })
const counts: HandoverCounts = { total: 6, carried: 6, tooLong: 0, notCarried: 0, images: 0, files: 0, visuals: 0, toolRecords: 0, historyKept: true, answered: true }
const said = [{ id: 'm1', role: 'user' as const, text: 'Watch the footer links.', createdAt: at }, { id: 'm2', role: 'assistant' as const, text: 'Watching them.', createdAt: at }]

function watcherThread(id: string, patch: Partial<AgentThread> = {}): AgentThread {
  return { id, kind: 'watcher', title: 'Watcher', projectId: 'workshop', modelId: 'claude:sonnet', providerId: 'claude', hostId: HOST, status: 'idle', requests: [], messages: [], ...patch }
}

/** Two hosts are listed, so an ordinary thread's composer would say where it runs. */
function stateWith(...threads: AgentThread[]): AgentState {
  const state = threadsStateFixture()
  state.hostId = HOST
  state.host.capabilities.configureThread = true
  state.connections = [{ hostId: HOST, name: 'This computer', kind: 'local', connected: true }, { hostId: OTHER_HOST, name: 'forge', kind: 'remote', connected: true }]
  for (const model of state.host.models) model.providerId = model.id.startsWith('claude') ? 'claude' : model.id.startsWith('codex') ? 'codex' : 'grok'
  state.host.threads.push(...threads)
  return state
}

function roomState(current: string, patch: Partial<WatcherRoomState> = {}): WatcherRoomState {
  return {
    current: identity(current), currentOptions: { modelId: 'claude:sonnet', reasoningEffort: null, runtimeMode: 'approval-required', status: 'idle', connected: true },
    history: [], runtimeMode: 'approval-required', standingWatches: [], ownChanges: [],
    requests: [], watchedThreads: [], receipts: [], recoveryNotice: null, observedAt: at, handover: null, ...patch,
  }
}

function renderRoom(room: WatcherRoomState, state: AgentState, startNew: () => Promise<WatcherRoomResult>) {
  vi.mocked(useOptionalApp).mockReturnValue({
    navigation: 'watcher', platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS,
    update: { watcherEnabled: true }, actions: { navigate: vi.fn(), minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn() },
  } as unknown as AppContextValue)
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => state)
  const connection = agentContextFixture(state, command, { threadDrafts: new ThreadDraftStore(command) })
  vi.mocked(useAgents).mockReturnValue(connection)
  vi.mocked(useOptionalAgents).mockReturnValue(connection)
  let shown = room
  const bridge = {
    get: vi.fn(async () => ({ status: 'ok' as const, state: shown })),
    open: vi.fn(), prepareStopAll: vi.fn(), stopAll: vi.fn(), setPermission: vi.fn(),
    onChanged: vi.fn(() => () => undefined),
    readHandover: vi.fn(async (): Promise<WatcherHandoverRead> => ({ status: 'ok', text: 'The handover.', counts })),
    continueWithHandover: vi.fn(async () => ({ status: 'ok' as const, state: shown })),
    dismissHandover: vi.fn(async () => ({ status: 'ok' as const, state: shown = { ...shown, handover: null } })),
    startNew: vi.fn(async () => { const result = await startNew(); if (result.status === 'ok') shown = result.state; return result }),
  }
  const view = render(<WatcherRoomProvider bridge={bridge as unknown as WatcherBridge}><SidebarChromeProvider updateControl={null}><WatcherView now={NOW} /></SidebarChromeProvider></WatcherRoomProvider>)
  return { ...view, bridge }
}

const watcherPane = () => screen.findByRole('region', { name: 'Watcher' })
const newButton = async () => within(await watcherPane()).findByRole('button', { name: /New Watcher/u })

beforeEach(() => {
  vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalAgents).mockReset(); vi.mocked(useOptionalApp).mockReset()
  localStorage.clear(); roomView.set({ besideId: null, share: 0.5, tab: 'conversation' }); firstMessage.clear()
})
afterEach(() => { cleanup(); localStorage.clear() })

describe('New Watcher in Watcher’s composer', () => {
  it('stands first in the footer, where an ordinary thread says where it runs, and never says where Watcher runs', async () => {
    renderRoom(roomState('watcher-a'), stateWith(watcherThread('watcher-a', { messages: said })), vi.fn())
    const button = await newButton()
    expect(button).toHaveAccessibleName('New Watcher')
    expect(button).toHaveAttribute('title', NEW_WATCHER_TITLE)
    expect(button).not.toHaveAttribute('aria-disabled')
    const pane = await watcherPane()
    expect(pane.querySelector('.thread-host-chip')).toBeNull()
    expect(pane).not.toHaveTextContent('Runs on this computer')
    // First in the footer's row, after the paperclip and before the model, in the order Tab takes.
    expect(pane.querySelector('.thread-prompt__meta')!.firstElementChild).toBe(button)
    const model = within(pane).getByRole('combobox', { name: 'Thread model' })
    expect(button.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const attach = within(pane).getByRole('button', { name: 'Attach screenshots' })
    expect(attach.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('is unavailable with its reason while Watcher works or waits on a card, and a press does nothing', async () => {
    const user = userEvent.setup()
    const startNew = vi.fn(async (): Promise<WatcherRoomResult> => ({ status: 'ok', state: roomState('watcher-b') }))
    const { bridge } = renderRoom(roomState('watcher-a'), stateWith(watcherThread('watcher-a', { messages: said, status: 'running' })), startNew)
    const button = await newButton()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('title', NEW_WATCHER_BUSY)
    expect(button).toHaveAccessibleDescription(NEW_WATCHER_BUSY)
    // Still in the Tab order, so its reason can be heard.
    expect(button).not.toBeDisabled()
    await user.click(button)
    expect(bridge.startNew).not.toHaveBeenCalled()
  })

  it('is unavailable for a Watcher that has said nothing yet', async () => {
    renderRoom(roomState('watcher-a'), stateWith(watcherThread('watcher-a')), vi.fn())
    const button = await newButton()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAccessibleDescription(NEW_WATCHER_EMPTY)
  })

  it('a press asks main for a new Watcher, and its refusal is said in main’s words under the composer', async () => {
    const user = userEvent.setup()
    const refusal = 'Wait for Watcher and its pending deliveries before starting a new one.'
    const { bridge } = renderRoom(roomState('watcher-a'), stateWith(watcherThread('watcher-a', { messages: said })),
      async () => ({ status: 'refused', code: 'THREAD_BUSY', message: refusal, retryable: true }))
    await user.click(await newButton())
    expect(bridge.startNew).toHaveBeenCalledTimes(1)
    expect(await within(await watcherPane()).findByRole('alert')).toHaveTextContent(refusal)
    expect(screen.getByRole('textbox', { name: 'Watcher message' })).toBeInTheDocument()
  })

  it('started, the new Watcher’s composer has focus, with the handover offered over it and no provider named', async () => {
    const user = userEvent.setup()
    const next = roomState('watcher-b', { history: [identity('watcher-a')], handover: { source: target('watcher-a'), provider: 'claude', counts } })
    renderRoom(roomState('watcher-a'), stateWith(watcherThread('watcher-a', { messages: said }), watcherThread('watcher-b')), async () => ({ status: 'ok', state: next }))
    await user.click(await newButton())
    const strip = await within(await watcherPane()).findByRole('region', { name: 'Handover of the last Watcher' })
    expect(strip).toHaveTextContent('Sending starts the new Watcher with a handover of the last one.')
    expect(strip).not.toHaveTextContent('from Claude')
    expect(within(await watcherPane()).getByRole('button', { name: 'Continue with the handover' })).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Watcher message' })))
    // The new Watcher has said nothing, so New Watcher waits for it too.
    expect(await newButton()).toHaveAccessibleDescription(NEW_WATCHER_EMPTY)
  })

  it('after a provider change the strip still names the provider the last Watcher was on', async () => {
    renderRoom(roomState('watcher-b', { history: [{ ...identity('watcher-a'), provider: 'codex' }], handover: { source: target('watcher-a'), provider: 'codex', counts } }),
      stateWith(watcherThread('watcher-b')), vi.fn())
    const strip = await within(await watcherPane()).findByRole('region', { name: 'Handover of the last Watcher' })
    expect(strip).toHaveTextContent('Sending starts the new Watcher with a handover of the last one, from Codex.')
  })
})

describe('the new Watcher’s empty conversation', () => {
  it('says which model it is on, where the last conversation went and what carried on', async () => {
    const worker = target('footer-links'), watched = target('weekly-note')
    const row = (at: WatcherThreadTarget, status: 'idle' | 'running') => ({ target: at, title: at.threadId, watched: true, status, connected: true, settled: false,
      backgroundWorkCount: 0, waitsOn: [], participation: [] })
    const request = { id: '3f0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a11', watcher: target('watcher-a'), rootUserMessageId: 'm1', createdAt: at, state: 'active' as const, closedAt: null,
      participants: [{ requestId: '3f0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a11', target: worker, startedBy: 'watcher' as const, state: 'participating' as const, generation: 0, promptCount: 1 }] }
    renderRoom(roomState('watcher-b', { history: [identity('watcher-a')], watchedThreads: [row(worker, 'running'), row(watched, 'idle')],
      requests: [request as unknown as WatcherRoomState['requests'][number]] }), stateWith(watcherThread('watcher-b')), vi.fn())
    const pane = await watcherPane()
    const note = await within(pane).findByRole('heading', { level: 3, name: /^New Watcher on /u })
    expect(note.closest('.watcher-new-note')).toHaveTextContent(/The last conversation is in Watcher history on the Threads page\. Watcher still watches your 2 threads, and the thread it started keeps working\.$/u)
    expect(pane).not.toHaveTextContent('What is next for this thread?')
  })

  it('is the plain empty line for a first Watcher that replaced nothing', async () => {
    renderRoom(roomState('watcher-a'), stateWith(watcherThread('watcher-a')), vi.fn())
    const pane = await watcherPane()
    expect(await within(pane).findByText('What is next for this thread?')).toBeInTheDocument()
    expect(pane.querySelector('.watcher-new-note')).toBeNull()
  })

  it('reads naturally whichever parts are true', () => {
    expect(carriesOnSentence(3, 2)).toBe('Watcher still watches your 3 threads, and the threads it started keep working.')
    expect(carriesOnSentence(1, 1)).toBe('Watcher still watches one of your threads, and the thread it started keeps working.')
    expect(carriesOnSentence(2, 0)).toBe('Watcher still watches your 2 threads.')
    expect(carriesOnSentence(0, 1)).toBe('The thread Watcher started keeps working.')
    expect(carriesOnSentence(0, 3)).toBe('The threads Watcher started keep working.')
    expect(carriesOnSentence(0, 0)).toBeNull()
  })
})
