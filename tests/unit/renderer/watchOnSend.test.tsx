import { setPromptText } from './helpers/promptEditor'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommand, AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import type { WatcherThreadTarget } from '../../../src/shared/watcher'
import type { WatcherBridge, WatcherRoomResult, WatcherRoomState } from '../../../src/shared/watcherRoom'
import type { AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadComposer } from '../../../src/renderer/src/agents/ThreadComposer'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { describeThreads } from '../../../src/renderer/src/agents/threadFacts'
import { WatcherRoomProvider } from '../../../src/renderer/src/watcher/watcherRoom'
import { watchAfterSend, watchOnSend } from '../../../src/renderer/src/watcher/watchOnSend'
import { watchNotices } from '../../../src/renderer/src/watcher/watchNotice'
import { agentContextFixture } from '../../fixtures/agentContext'
import { threadsStateFixture } from '../../fixtures/agentState'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(),
  useOptionalAgents: vi.fn(),
}))

const HOST = '6c0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a10'
const THREAD = 'grok-previews'
const at = new Date(E2E_THREADS_NOW).toISOString()

afterEach(() => { cleanup(); watchOnSend.clear(); const notice = watchNotices.get(); if (notice !== null) watchNotices.dismiss(notice.id) })

function room(patch: Partial<WatcherRoomState> = {}): WatcherRoomState {
  return { current: null, history: [], runtimeMode: 'approval-required', standingWatches: [], ownChanges: [], requests: [], watchedThreads: [],
    receipts: [], recoveryNotice: null, observedAt: at, ...patch } as unknown as WatcherRoomState
}

function fakeBridge(initial: WatcherRoomState) {
  let state = initial
  const ok = (next: WatcherRoomState): WatcherRoomResult => { state = next; return { status: 'ok', state } }
  const same = (a: WatcherThreadTarget, b: WatcherThreadTarget): boolean => a.hostId === b.hostId && a.threadId === b.threadId
  return {
    get: vi.fn(async () => ({ status: 'ok' as const, state })),
    open: vi.fn(), prepareStopAll: vi.fn(), stopAll: vi.fn(),
    onChanged: vi.fn(() => () => undefined),
    watchThread: vi.fn(async ({ target }: { target: WatcherThreadTarget }) => ok({ ...state,
      standingWatches: [{ id: crypto.randomUUID(), target, createdAt: at, generation: 0 }],
      watchedThreads: [{ target, title: target.threadId, watched: true, paused: false, status: 'running', connected: true, settled: false, backgroundWorkCount: 0, waitsOn: [], participation: [] }] } as WatcherRoomState)),
    unwatchThread: vi.fn(async ({ target }: { target: WatcherThreadTarget }) => ok({ ...state,
      standingWatches: (state.standingWatches ?? []).filter(watch => !same(watch.target, target)),
      watchedThreads: state.watchedThreads.filter(entry => !same(entry.target, target)) })),
  }
}

/** A new thread's composer, before its first send, with Watcher on or off and main answering each command. */
function setup({ enabled = true, started = false, sendError = null as string | null, initial = room() } = {}) {
  vi.mocked(useOptionalApp).mockReturnValue({ settings: DEFAULT_SETTINGS, update: { watcherEnabled: enabled } } as unknown as AppContextValue)
  const state: AgentState = threadsStateFixture()
  state.hostId = HOST
  state.host.threads.forEach(thread => { thread.requests = [] })
  const thread = state.host.threads.find(item => item.id === THREAD)!
  thread.nativeSessionStarted = !started ? false : true
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async request => request.type === 'manual-send' && sendError !== null ? { ...state, error: sendError } : state)
  const store = new ThreadDraftStore(command)
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, command, { threadDrafts: store }))
  const bridge = fakeBridge(initial)
  const composer = (): React.ReactElement => <WatcherRoomProvider bridge={bridge as unknown as WatcherBridge}>
    <ThreadComposer row={describeThreads(state, E2E_THREADS_NOW).find(row => row.thread.id === THREAD)!} state={state} command={command} store={store} onSend={vi.fn()} />
  </WatcherRoomProvider>
  return { state, command, store, bridge, composer }
}

async function settle(): Promise<void> { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

describe('Watch on a new thread composer', () => {
  it('is not drawn while the Watcher gate is off', async () => {
    const f = setup({ enabled: false })
    render(f.composer()); await settle()
    expect(screen.queryByRole('button', { name: 'Watch' })).toBeNull()
  })

  it('is not drawn once the thread has started', async () => {
    const f = setup({ started: true })
    render(f.composer()); await settle()
    expect(screen.queryByRole('button', { name: 'Watch' })).toBeNull()
  })

  it('sits after the permissions chip, before Send, as a pill that says Watch, then Watched when pressed', async () => {
    const f = setup()
    render(f.composer()); await settle()
    const watch = screen.getByRole('button', { name: 'Watch' })
    expect(watch).toHaveClass('thread-chip')
    expect(watch).toHaveAttribute('aria-pressed', 'false')
    expect(watch).toHaveTextContent('Watch')
    const chips = watch.closest('.thread-options--chips')!
    expect(chips.lastElementChild).toBe(watch)
    expect(watch.compareDocumentPosition(screen.getByRole('button', { name: 'Send prompt' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(watch)
    expect(watch).toHaveAttribute('aria-pressed', 'true')
    expect(watch).toHaveTextContent('Watch')
    // The press asks main nothing: the watch waits for the first send.
    expect(f.bridge.watchThread).not.toHaveBeenCalled()
    fireEvent.click(watch)
    expect(watch).toHaveAttribute('aria-pressed', 'false')
    expect(watchOnSend.has(THREAD)).toBe(false)
  })

  it('puts the thread under a standing watch once main has taken its first send', async () => {
    const f = setup()
    render(f.composer()); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Watch' }))
    setPromptText(screen.getByRole('textbox', { name: 'Prompt' }), 'Build the footer')
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }))
    await settle(); await settle()
    expect(f.command.mock.calls.some(([request]) => request.type === 'manual-send')).toBe(true)
    expect(f.bridge.watchThread).toHaveBeenCalledWith({ target: { hostId: HOST, threadId: THREAD } })
    expect(watchOnSend.has(THREAD)).toBe(false)
    f.store.flushAll()
  })

  it('keeps the request when the first send is refused, and watches nothing', async () => {
    const f = setup({ sendError: 'The provider refused the prompt.' })
    render(f.composer()); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Watch' }))
    setPromptText(screen.getByRole('textbox', { name: 'Prompt' }), 'Build the footer')
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }))
    await settle(); await settle()
    expect(f.bridge.watchThread).not.toHaveBeenCalled()
    expect(watchOnSend.has(THREAD)).toBe(true)
    expect(screen.getByRole('button', { name: 'Watch' })).toHaveAttribute('aria-pressed', 'true')
    f.store.flushAll()
  })

  it('is pressed for a thread Watcher already watches, and a press then stops watching it', async () => {
    const target = { hostId: HOST, threadId: THREAD }
    const f = setup({ initial: room({ standingWatches: [{ id: crypto.randomUUID(), target, createdAt: at, generation: 0 }],
      watchedThreads: [{ target, title: 'Grok previews', watched: true, paused: false, status: 'idle', connected: true, settled: false, backgroundWorkCount: 0, waitsOn: [], participation: [] }] } as Partial<WatcherRoomState>) })
    render(f.composer()); await settle()
    const watch = screen.getByRole('button', { name: 'Watch' })
    expect(watch).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(watch)
    await settle()
    expect(f.bridge.unwatchThread).toHaveBeenCalledWith({ target })
    expect(within(watch.closest('.thread-options--chips')!).getByRole('button', { name: 'Watch' })).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('watchAfterSend', () => {
  it('watches only after an accepted send, and only once', () => {
    const setThread = vi.fn(async () => undefined)
    const actions = { set: vi.fn(), setThread }
    watchAfterSend('t', true, actions)
    expect(setThread).not.toHaveBeenCalled()
    watchOnSend.set('t', true)
    watchAfterSend('t', false, actions)
    watchAfterSend('t', true, null)
    expect(setThread).not.toHaveBeenCalled()
    watchAfterSend('t', true, actions)
    watchAfterSend('t', true, actions)
    expect(setThread).toHaveBeenCalledTimes(1)
    expect(setThread).toHaveBeenCalledWith('t', true)
  })
})
