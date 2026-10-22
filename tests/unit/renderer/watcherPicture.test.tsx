import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState, AgentThread } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import type { WatcherIdentity, WatcherOperation } from '../../../src/shared/watcher'
import type { WatcherBridge, WatcherMergeTurnsRead, WatcherRoomResult, WatcherRoomState } from '../../../src/shared/watcherRoom'
import type { AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useAgents, useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { SidebarChromeProvider } from '../../../src/renderer/src/agents/SidebarFrame'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { WatcherRoomProvider } from '../../../src/renderer/src/watcher/watcherRoom'
import { roomView } from '../../../src/renderer/src/watcher/WatcherBeside'
import { WatcherView } from '../../../src/renderer/src/watcher/WatcherView'
import { firstMessage } from '../../../src/renderer/src/watcher/watcherFirstMessage'
import { agentContextFixture } from '../../fixtures/agentContext'
import { threadsStateFixture } from '../../fixtures/agentState'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn(), useOptionalAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const HOST = '6c0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a10'
const REQUEST = '2b8f3c1d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const SEND = '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const target = (threadId: string) => ({ hostId: HOST, threadId })
const at = new Date(NOW).toISOString()
const identity: WatcherIdentity = { target: target('watcher'), projectId: 'workshop', provider: 'codex', creationOperationId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', createdAt: at }

function state(): AgentState {
  const result = threadsStateFixture()
  result.hostId = HOST
  result.host.threads.push({ id: 'watcher', kind: 'watcher', title: 'Watcher', projectId: 'workshop', modelId: 'codex:gpt', providerId: 'codex', status: 'idle', requests: [],
    messages: [{ id: 'watcher-1', role: 'user', text: 'Keep the footer moving.', createdAt: at }] } as AgentThread)
  const footer = result.host.threads.find(thread => thread.id === 'footer-links')!
  footer.pullRequests = [{ number: 12, url: 'https://github.com/millZach/sotto-site/pull/12', title: 'Fix the footer links', state: 'open', draft: false, source: 'linked', linkedAt: at }]
  return result
}

const participant = { requestId: REQUEST, startedBy: 'watcher' as const, generation: 0, state: 'participating' as const, target: target('footer-links'), promptCount: 1 }
const send = (deliveryState: WatcherOperation['deliveryState']): WatcherOperation => ({ id: SEND, requestId: REQUEST, retryKey: SEND, digest: 'a'.repeat(64), action: 'send',
  target: target('footer-links'), generation: 0, delivery: 'now', deliveryState, createdAt: at, updatedAt: at, receiptId: 'receipt', cardId: 'card', messageId: 'footer-links-1' })
function roomState(patch: Partial<WatcherRoomState> = {}): WatcherRoomState {
  return {
    current: identity, currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, status: 'idle', connected: true }, history: [],
    requests: [{ id: REQUEST, watcher: identity.target, rootUserMessageId: 'watcher-1', state: 'active', createdAt: at, closedAt: null, participants: [participant] }],
    watchedThreads: [{ target: target('footer-links'), title: 'Footer links', watched: true, status: 'running', connected: true, settled: false, backgroundWorkCount: 0, waitsOn: [], participation: [participant] }],
    receipts: [send('dispatching')], recoveryNotice: null, observedAt: at, ...patch,
  }
}
const ready: WatcherMergeTurnsRead = { status: 'ok', turns: [],
  queue: [{ target: target('footer-links'), title: 'Footer links', pullRequest: { number: 12, state: 'open', checks: 'passed' }, checksPassedAt: at }] }

function renderRoomWith(bridge: { get: unknown }) {
  render(<WatcherRoomProvider bridge={bridge as unknown as WatcherBridge}><SidebarChromeProvider updateControl={null}><WatcherView now={NOW} /></SidebarChromeProvider></WatcherRoomProvider>)
}

function renderRoom(merge: WatcherMergeTurnsRead = ready) {
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'watcher', platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS, update: { watcherEnabled: true },
    actions: { navigate: vi.fn(), minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn() } } as unknown as AppContextValue)
  const agents = state()
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => agents)
  const connection = agentContextFixture(agents, command, { threadDrafts: new ThreadDraftStore(command) })
  vi.mocked(useAgents).mockReturnValue(connection)
  vi.mocked(useOptionalAgents).mockReturnValue(connection)
  const listeners = new Set<(next: WatcherRoomState) => void>()
  const ok = (next: WatcherRoomState): WatcherRoomResult => ({ status: 'ok', state: next })
  const bridge = {
    get: vi.fn(async () => ok(roomState())), open: vi.fn(), prepareStopAll: vi.fn(), stopAll: vi.fn(),
    readMergeTurns: vi.fn(async () => merge),
    onChanged: vi.fn((listener: (next: WatcherRoomState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  render(<WatcherRoomProvider bridge={bridge as unknown as WatcherBridge}><SidebarChromeProvider updateControl={null}><WatcherView now={NOW} /></SidebarChromeProvider></WatcherRoomProvider>)
  return { bridge, publish: (next: WatcherRoomState) => act(() => { for (const listener of listeners) listener(next) }) }
}

// jsdom lays nothing out: the picture is given a size to draw in.
beforeEach(() => {
  vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalAgents).mockReset(); vi.mocked(useOptionalApp).mockReset()
  roomView.set({ besideId: null, share: 0.5, tab: 'conversation' }); firstMessage.clear()
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return (this as HTMLElement).classList.contains('watcher-picture__canvas') ? 1200 : 0 } })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return (this as HTMLElement).classList.contains('watcher-picture__canvas') ? 560 : 0 } })
})
afterEach(() => {
  cleanup(); localStorage.clear(); delete document.documentElement.dataset.reducedMotion
  // The element's own getters come back from Element.prototype.
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
})

describe("Watcher's picture in its room", () => {
  it('is the third tab, after Watched, reached with the arrow keys, and its composer keeps one line', async () => {
    renderRoom()
    await screen.findByRole('tab', { name: /^Watched, / })
    const user = userEvent.setup()
    screen.getByRole('tab', { name: 'Conversation' }).focus()
    await user.keyboard('{ArrowRight}{ArrowRight}')
    const tab = screen.getByRole('tab', { name: 'Visualize' })
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(tab).toHaveFocus()
    expect(screen.getByRole('tabpanel', { name: 'Visualize' })).toBeInTheDocument()
    expect(document.getElementById('watcher-pane')).toHaveAttribute('data-view', 'visualize')
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Conversation' })).toHaveAttribute('aria-selected', 'true')
  })

  it('draws each watched thread as a button that opens its card, which Escape closes, giving focus back', async () => {
    roomView.set({ tab: 'visualize' })
    renderRoom()
    const node = await screen.findByRole('button', { name: /^Footer links: .*pull request #12, READY TO MERGE\. Show details$/ })
    expect(screen.getByRole('region', { name: /, 1 thread$/ })).toContainElement(node)
    const user = userEvent.setup()
    await user.click(node)
    const card = screen.getByRole('dialog', { name: 'Footer links, details' })
    expect(within(card).getByText(/Ready to merge, waiting for its turn/)).toBeInTheDocument()
    expect(within(card).getByRole('list', { name: 'What Watcher last did with it' })).toHaveTextContent('Sent to it, sending')
    expect(within(card).getByRole('button', { name: 'Open beside Watcher' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(node).toHaveFocus()
  })

  it('lists the merge turns along the top, each opening its thread’s card', async () => {
    roomView.set({ tab: 'visualize' })
    const { bridge } = renderRoom()
    const turn = await screen.findByRole('button', { name: '#12 READY TO MERGE, Footer links. Show details' })
    expect(bridge.readMergeTurns).toHaveBeenCalled()
    await userEvent.setup().click(turn)
    expect(screen.getByRole('dialog', { name: 'Footer links, details' })).toBeInTheDocument()
  })

  it('opens a settled thread’s card from its merge turn, showing the settled threads first', async () => {
    roomView.set({ tab: 'visualize' })
    const settled = { ...roomState().watchedThreads[0]!, settled: true, evidence: [{ id: 'merged-12', source: 'github' as const, observedAt: at, target: target('footer-links'),
      freshness: 'fresh' as const, availability: 'available' as const, fact: 'merge-observed' as const, url: 'https://github.com/millZach/sotto-site/pull/12', pullRequestState: 'merged' as const }] }
    const { bridge } = renderRoom({ status: 'ok', queue: [], turns: [] })
    bridge.get.mockResolvedValue({ status: 'ok', state: roomState({ watchedThreads: [settled] }) })
    cleanup()
    renderRoomWith(bridge)
    const turn = await screen.findByRole('button', { name: '#12 MERGED, Footer links. Show details' })
    expect(screen.queryByRole('button', { name: /^Footer links: / })).not.toBeInTheDocument()
    await userEvent.setup().click(turn)
    expect(await screen.findByRole('dialog', { name: 'Footer links, details' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide settled' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('moves a delivered send as a still mark beside the thread when motion is reduced, never over its title', async () => {
    document.documentElement.dataset.reducedMotion = 'on'
    roomView.set({ tab: 'visualize' })
    const { publish } = renderRoom({ status: 'ok', queue: [], turns: [] })
    await screen.findByRole('button', { name: /^Footer links: / })
    publish(roomState({ receipts: [send('accepted')], observedAt: new Date(NOW + 1_000).toISOString() }))
    await waitFor(() => expect(document.querySelector('.watcher-picture__mark')).not.toBeNull(), { timeout: 3_000 })
    expect(document.querySelector('.watcher-picture__blob')).toBeNull()
    expect(document.querySelector('.watcher-picture__mark [data-kind]')).toHaveAttribute('data-kind', 'steer')
  })
})
