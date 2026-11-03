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
import { useAgents, useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadComposer } from '../../../src/renderer/src/agents/ThreadComposer'
import { ThreadTranscript } from '../../../src/renderer/src/agents/ThreadTranscript'
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
  useAgents: vi.fn(),
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
function setup({ enabled = true, started = false, sendError = null as string | null, refusals = Number.POSITIVE_INFINITY, initial = room() } = {}) {
  const dismissPastePermissionNotices = vi.fn()
  vi.mocked(useOptionalApp).mockReturnValue({ settings: DEFAULT_SETTINGS, update: { watcherEnabled: enabled },
    actions: { dismissPastePermissionNotices } } as unknown as AppContextValue)
  const state: AgentState = threadsStateFixture()
  state.hostId = HOST
  state.host.threads.forEach(thread => { thread.requests = [] })
  const thread = state.host.threads.find(item => item.id === THREAD)!
  thread.nativeSessionStarted = !started ? false : true
  // The first `refusals` sends are refused with `sendError`; the rest main takes.
  let refused = 0
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async request => {
    if (request.type !== 'manual-send' || request.draftId === undefined || sendError === null || refused++ >= refusals) return state
    // As main does, the refusal is recorded against the draft, which is what offers Retry.
    state.deliveries = [{ threadId: request.threadId, draftId: request.draftId, status: 'failed', createdAt: at, updatedAt: at }]
    return { ...state, error: sendError }
  })
  const store = new ThreadDraftStore(command)
  const connection = agentContextFixture(state, command, { threadDrafts: store })
  vi.mocked(useOptionalAgents).mockReturnValue(connection)
  vi.mocked(useAgents).mockReturnValue(connection)
  const bridge = fakeBridge(initial)
  const composer = (watcher = false): React.ReactElement => <WatcherRoomProvider bridge={bridge as unknown as WatcherBridge}>
    <ThreadComposer row={describeThreads(state, E2E_THREADS_NOW).find(row => row.thread.id === THREAD)!} state={state} command={command} store={store} onSend={vi.fn()} watcher={watcher} />
  </WatcherRoomProvider>
  /** The pane's transcript above its composer, where a refused send offers Retry. */
  const pane = (): React.ReactElement => {
    const row = describeThreads(state, E2E_THREADS_NOW).find(item => item.thread.id === THREAD)!
    return <WatcherRoomProvider bridge={bridge as unknown as WatcherBridge}>
      <ThreadTranscript row={row} state={state} command={command} store={store} followSignal={0} />
      <ThreadComposer row={row} state={state} command={command} store={store} onSend={vi.fn()} />
    </WatcherRoomProvider>
  }
  return { state, command, store, bridge, composer, pane, dismissPastePermissionNotices }
}

async function settle(): Promise<void> { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

describe('Watch on a new thread composer', () => {
  it('is not drawn while the Watcher gate is off', async () => {
    const f = setup({ enabled: false })
    render(f.composer()); await settle()
    expect(screen.queryByRole('button', { name: 'Watch' })).toBeNull()
  })

  it('is not drawn in Watcher\'s own composer', async () => {
    const f = setup()
    render(f.composer(true)); await settle()
    expect(screen.queryByRole('button', { name: 'Watch' })).toBeNull()
  })

  it('is not drawn once the thread has started', async () => {
    const f = setup({ started: true })
    render(f.composer()); await settle()
    expect(screen.queryByRole('button', { name: 'Watch' })).toBeNull()
  })

  it('sits after the permissions chip, before Send, as a pill that keeps saying Watch when pressed', async () => {
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
    expect(f.dismissPastePermissionNotices).toHaveBeenCalledTimes(1)
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

  it('applies the watch when Retry sends a refused first send that main then takes', async () => {
    const f = setup({ sendError: 'The provider refused the prompt.', refusals: 1 })
    const view = render(f.pane()); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Watch' }))
    setPromptText(screen.getByRole('textbox', { name: 'Prompt' }), 'Build the footer')
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }))
    await settle(); await settle()
    expect(f.bridge.watchThread).not.toHaveBeenCalled()
    view.rerender(f.pane())
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await settle(); await settle()
    expect(f.command.mock.calls.filter(([request]) => request.type === 'manual-send')).toHaveLength(2)
    // Watch's setThread(thread, true) reaches main as one watchThread for the thread.
    expect(f.bridge.watchThread).toHaveBeenCalledTimes(1)
    expect(f.bridge.watchThread).toHaveBeenCalledWith({ target: { hostId: HOST, threadId: THREAD } })
    expect(f.bridge.unwatchThread).not.toHaveBeenCalled()
    expect(watchOnSend.has(THREAD)).toBe(false)
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
    watchAfterSend('t', true, 'send', true, actions)
    expect(setThread).not.toHaveBeenCalled()
    watchOnSend.set('t', true)
    watchAfterSend('t', false, 'send', true, actions)
    watchAfterSend('t', true, 'send', true, actions)
    watchAfterSend('t', true, 'send', true, actions)
    expect(setThread).toHaveBeenCalledTimes(1)
    expect(setThread).toHaveBeenCalledWith('t', true)
  })

  it('never watches on a queue or a steer, and drops the request after a send main never confirmed', () => {
    const setThread = vi.fn(async () => undefined)
    const actions = { set: vi.fn(), setThread }
    watchOnSend.set('t', true)
    watchAfterSend('t', true, 'queue', true, actions)
    watchAfterSend('t', true, 'steer', true, actions)
    expect(watchOnSend.has('t')).toBe(true)
    watchAfterSend('t', null, 'send', true, actions)
    expect(watchOnSend.has('t')).toBe(false)
    watchAfterSend('t', true, 'send', true, actions)
    expect(setThread).not.toHaveBeenCalled()
  })

  it('drops the request on a send made while Watch is unavailable, or after the thread had started', () => {
    const setThread = vi.fn(async () => undefined)
    const actions = { set: vi.fn(), setThread }
    watchOnSend.set('t', true)
    watchAfterSend('t', true, 'send', true, null)
    expect(watchOnSend.has('t')).toBe(false)
    watchOnSend.set('t', true)
    watchAfterSend('t', true, 'send', false, actions)
    expect(watchOnSend.has('t')).toBe(false)
    watchAfterSend('t', true, 'send', true, actions)
    expect(setThread).not.toHaveBeenCalled()
  })
})
