import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
const at = new Date(NOW).toISOString()
const TILE = 'Watcher’s context and state'
const identity = (provider: WatcherIdentity['provider'] = 'codex'): WatcherIdentity => ({ target: { hostId: HOST, threadId: 'watcher' }, projectId: 'workshop', provider,
  creationOperationId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', createdAt: at })

function watcherThread(): AgentThread {
  return { id: 'watcher', kind: 'watcher', title: 'Watcher', projectId: 'workshop', modelId: 'codex:gpt', providerId: 'codex', status: 'idle', requests: [],
    messages: [{ id: 'watcher-1', role: 'user', text: 'Keep an eye on the footer links.', createdAt: new Date(NOW - 60_000).toISOString() },
      { id: 'watcher-2', role: 'assistant', text: 'Watching Footer links.', createdAt: new Date(NOW - 30_000).toISOString() }] }
}
function agentState(): AgentState {
  const state = threadsStateFixture()
  state.host.threads.push(watcherThread())
  openSidebarFolders(state)
  return state
}
const context = (patch: Partial<NonNullable<WatcherRoomState['context']>> = {}): NonNullable<WatcherRoomState['context']> =>
  ({ tokens: 190_000, compactAt: 400_000, canCompact: true, compacting: false, ...patch })
const emptyKept = { decisions: [], rules: [], issues: [], updatedAt: null }

function roomState(patch: Partial<WatcherRoomState> = {}): WatcherRoomState {
  return {
    current: identity(), currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, status: 'idle', connected: true }, history: [],
    requests: [], watchedThreads: [], inFlight: 0, inFlightLimit: 4, receipts: [], recoveryNotice: null, observedAt: at,
    context: context(), state: { watching: [], kept: emptyKept }, ...patch,
  }
}

function renderRoom(room: WatcherRoomState, answer: AgentState | null = agentState()) {
  const state = agentState()
  vi.mocked(useOptionalApp).mockReturnValue({
    navigation: 'watcher', platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS,
    update: { watcherEnabled: true }, actions: { navigate: vi.fn(), minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn() },
  } as unknown as AppContextValue)
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async request => request.type === 'compact-thread' ? answer : state)
  const connection = agentContextFixture(state, command, { threadDrafts: new ThreadDraftStore(command) })
  vi.mocked(useAgents).mockReturnValue(connection)
  vi.mocked(useOptionalAgents).mockReturnValue(connection)
  const ok = (next: WatcherRoomState): WatcherRoomResult => ({ status: 'ok', state: next })
  const bridge = {
    get: vi.fn(async () => ok(room)), open: vi.fn(async () => ok(room)), setLimit: vi.fn(async () => ok(room)),
    prepareStopAll: vi.fn(), stopAll: vi.fn(), onChanged: vi.fn(() => () => {}),
  } as unknown as WatcherBridge
  render(<WatcherRoomProvider bridge={bridge}><SidebarChromeProvider updateControl={null}><WatcherView now={NOW} /></SidebarChromeProvider></WatcherRoomProvider>)
  return { command }
}

async function openPanel(): Promise<{ tile: HTMLElement; panel: HTMLElement }> {
  const tile = await screen.findByRole('button', { name: TILE })
  fireEvent.click(tile)
  return { tile, panel: await screen.findByRole('dialog', { name: 'Watcher’s context' }) }
}

beforeEach(() => { vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalAgents).mockReset(); vi.mocked(useOptionalApp).mockReset(); localStorage.clear(); sessionStorage.clear(); roomView.set({ besideId: null, share: 0.5, tab: 'conversation' }); firstMessage.clear() })
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear() })

describe('the Sotto Owl tile in Watcher’s room', () => {
  it('is a button named for Watcher’s context and state, with a tooltip saying the same, once Watcher runs', async () => {
    renderRoom(roomState())
    const tile = await screen.findByRole('button', { name: TILE })
    expect(tile).toHaveAttribute('title', TILE)
    expect(tile).toHaveAttribute('aria-expanded', 'false')
    expect(tile).toHaveAccessibleDescription('190k of 400k.')
    expect(screen.queryByRole('img', { name: 'Sotto Owl' })).toBeNull()
    expect(tile.querySelector('.watcher-context__dot')).toBeNull()
  })

  it('stays a picture before Watcher starts', async () => {
    renderRoom(roomState({ current: null, currentOptions: null, context: null }))
    expect(await screen.findByRole('img', { name: 'Sotto Owl' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: TILE })).toBeNull()
  })

  it('carries a dot once Watcher’s context reaches nine tenths of the point, and says so', async () => {
    renderRoom(roomState({ context: context({ tokens: 372_000 }) }))
    const tile = await screen.findByRole('button', { name: TILE })
    expect(tile.querySelector('.watcher-context__dot')).not.toBeNull()
    expect(tile).toHaveAccessibleDescription('372k of 400k, close to the point.')
    fireEvent.click(tile)
    expect(await screen.findByText(/^Close to 400k\. Sotto compacts Watcher’s conversation once it passes 400k, between turns\.$/)).toBeInTheDocument()
  })

  it('opens a panel with the numbers and the point, and Escape closes it and puts focus back on the tile', async () => {
    renderRoom(roomState())
    const { tile, panel } = await openPanel()
    expect(tile).toHaveAttribute('aria-expanded', 'true')
    expect(within(panel).getByRole('heading', { name: 'Watcher’s context' })).toBeInTheDocument()
    expect(within(panel).getByText('190k')).toBeInTheDocument()
    expect(within(panel).getByText('context, compacts at 400k')).toBeInTheDocument()
    expect(within(panel).getByText('Sotto compacts Watcher’s conversation once it passes 400k, between turns.')).toBeInTheDocument()
    const meter = within(panel).getByRole('meter', { name: 'Watcher’s context' })
    expect(meter).toHaveAttribute('aria-valuenow', '190000')
    expect(meter).toHaveAttribute('aria-valuemax', '400000')
    expect(meter).toHaveAttribute('aria-valuetext', '190k of 400k')
    await waitFor(() => expect(panel).toHaveFocus())
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Watcher’s context' })).toBeNull()
    expect(tile).toHaveFocus()
    expect(tile).toHaveAttribute('aria-expanded', 'false')
  })

  it('closes on a press outside it', async () => {
    renderRoom(roomState())
    await openPanel()
    fireEvent.pointerDown(screen.getByRole('heading', { level: 1, name: 'Watcher' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Watcher’s context' })).toBeNull())
  })

  it('says when the provider has not reported Watcher’s context', async () => {
    renderRoom(roomState({ context: context({ tokens: null }) }))
    const { panel } = await openPanel()
    expect(within(panel).getByText('Its provider has not reported its context yet. Sotto compacts Watcher’s conversation once it passes 400k, between turns.')).toBeInTheDocument()
    expect(within(panel).queryByRole('meter')).toBeNull()
  })

  it('offers no compaction when the room says nothing of Watcher’s context', async () => {
    renderRoom(roomState({ context: undefined }))
    const { tile, panel } = await openPanel()
    expect(tile).toHaveAccessibleDescription('Not reported yet.')
    expect(within(panel).getByText('Its provider has not reported its context yet.')).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Compact context' })).toBeDisabled()
  })

  it('says Grok Build cannot compact, and offers no compaction there', async () => {
    renderRoom(roomState({ current: identity('grok'), context: context({ canCompact: false, tokens: 520_000 }) }))
    const { tile, panel } = await openPanel()
    expect(within(panel).getByText('Grok Build cannot compact, so each message rereads all of it.')).toBeInTheDocument()
    expect(within(panel).getByText('520k')).toBeInTheDocument()
    expect(within(panel).getByText('context')).toBeInTheDocument()
    expect(within(panel).queryByRole('meter')).toBeNull()
    expect(within(panel).getByRole('button', { name: 'Compact context' })).toBeDisabled()
    expect(tile.querySelector('.watcher-context__bar')).toBeNull()
    expect(tile.querySelector('.watcher-context__dot')).toBeNull()
  })

  it('sends compact-thread for the current Watcher on Compact context', async () => {
    const { command } = renderRoom(roomState())
    const { panel } = await openPanel()
    const button = within(panel).getByRole('button', { name: 'Compact context' })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'compact-thread', threadId: 'watcher' }))
    expect(within(panel).queryByRole('alert')).toBeNull()
  })

  it('says so when Compact context could not be confirmed', async () => {
    renderRoom(roomState(), null)
    const { panel } = await openPanel()
    fireEvent.click(within(panel).getByRole('button', { name: 'Compact context' }))
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Sotto could not start compacting Watcher’s conversation. Nothing was lost. Try again.')
  })

  it('holds Compact context while a compaction runs, and while Watcher’s turn runs', async () => {
    const { command } = renderRoom(roomState({ context: context({ compacting: true }) }))
    const { panel } = await openPanel()
    expect(within(panel).getByText('Compacting Watcher’s conversation.')).toBeInTheDocument()
    expect(within(panel).getByRole('meter', { name: 'Watcher’s context' })).toHaveAttribute('aria-valuetext', 'Compacting')
    const button = within(panel).getByRole('button', { name: 'Compact context' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'compact-thread' }))
    cleanup()
    renderRoom(roomState({ currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, status: 'running', connected: true } }))
    const running = await openPanel()
    expect(within(running.panel).getByRole('button', { name: 'Compact context' })).toBeDisabled()
  })

  it('shows Watcher’s state in four groups, each saying None when it is empty', async () => {
    renderRoom(roomState())
    const { panel } = await openPanel()
    expect(within(panel).getByRole('heading', { name: 'Watcher’s state, kept through compaction' })).toBeInTheDocument()
    for (const label of ['Watching', 'Waiting on you', 'Your rules', 'Issues filed']) {
      const group = within(panel).getByRole('heading', { name: label }).closest('section')!
      expect(within(group).getByText('None')).toBeInTheDocument()
    }
  })

  it('lists what Watcher watches and what it kept', async () => {
    renderRoom(roomState({ state: {
      watching: [{ target: { hostId: HOST, threadId: 'footer-links' }, title: 'Footer links', waitsOn: 'Waits on your permission to run npm test.' }],
      kept: { decisions: ['Merge #1186 once CI is green?'], rules: ['Full test suites run in CI, not on the laptop.', 'Ask before merging.'], issues: ['#1189 Watcher: auto-compact its conversation'], updatedAt: at },
    } }))
    const { panel } = await openPanel()
    const group = (name: string): HTMLElement => within(panel).getByRole('heading', { name }).closest('section')!
    expect(within(group('Watching, 1')).getByRole('listitem')).toHaveTextContent('Footer linksWaits on your permission to run npm test.')
    expect(within(group('Waiting on you, 1')).getByText('Merge #1186 once CI is green?')).toBeInTheDocument()
    expect(within(group('Your rules, 2')).getAllByRole('listitem')).toHaveLength(2)
    expect(within(group('Issues filed, 1')).getByText('#1189 Watcher: auto-compact its conversation')).toBeInTheDocument()
    expect(within(panel).queryByText('None')).toBeNull()
  })
})
