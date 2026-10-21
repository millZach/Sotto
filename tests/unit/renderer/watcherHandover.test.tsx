import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { handoverLedger } from '../../../src/renderer/src/watcher/WatcherHandover'
import { firstMessage } from '../../../src/renderer/src/watcher/watcherFirstMessage'
import { agentContextFixture } from '../../fixtures/agentContext'
import { threadsStateFixture } from '../../fixtures/agentState'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn(), useOptionalAgents: vi.fn() }))

/**
 * Watcher's handover after a provider change in the room (ADR-0073, #1026; Zach's pick B of the continue prototype): the
 * strip over the new Watcher's composer, the send that continues with it, putting it away, and the first message that
 * shows it as Sotto's, beside the user's words.
 */
const NOW = E2E_THREADS_NOW
const HOST = '6c0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a10'
const at = new Date(NOW).toISOString()
const target = (threadId: string): WatcherThreadTarget => ({ hostId: HOST, threadId })
const identity: WatcherIdentity = { target: target('watcher-new'), projectId: 'workshop', provider: 'claude', creationOperationId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', createdAt: at }
const counts: HandoverCounts = { total: 6, carried: 4, tooLong: 1, notCarried: 0, images: 1, files: 0, visuals: 0, toolRecords: 12, historyKept: true, answered: true }
const WORDS = 'This is a handover from another Sotto thread. The history below is context, not a new request.\n\nThe user, 2026-07-12 19:29 UTC:\nWatch the footer links.'

function watcherThread(patch: Partial<AgentThread> = {}): AgentThread {
  return { id: 'watcher-new', kind: 'watcher', title: 'Watcher', projectId: 'workshop', modelId: 'claude:sonnet', providerId: 'claude', status: 'idle', requests: [], messages: [], ...patch }
}

function stateWithWatcher(thread = watcherThread()): AgentState {
  const state = threadsStateFixture()
  state.hostId = HOST
  state.host.capabilities.configureThread = true
  for (const model of state.host.models) model.providerId = model.id.startsWith('claude') ? 'claude' : model.id.startsWith('codex') ? 'codex' : 'grok'
  state.host.threads.push(thread)
  return state
}

function roomState(patch: Partial<WatcherRoomState> = {}): WatcherRoomState {
  return {
    current: identity, currentOptions: { modelId: 'claude:sonnet', reasoningEffort: null, runtimeMode: 'approval-required', status: 'idle', connected: true },
    history: [{ ...identity, target: target('watcher-old'), provider: 'codex' }], runtimeMode: 'approval-required', standingWatches: [], ownChanges: [],
    requests: [], watchedThreads: [], receipts: [], recoveryNotice: null, observedAt: at,
    handover: { source: target('watcher-old'), provider: 'codex', counts }, ...patch,
  }
}

function fakeBridge(initial: WatcherRoomState, options: { readonly handover?: boolean } = {}) {
  let state = initial
  const listeners = new Set<(next: WatcherRoomState) => void>()
  const ok = (next: WatcherRoomState): WatcherRoomResult => { state = next; return { status: 'ok', state } }
  const bridge = {
    get: vi.fn(async () => ({ status: 'ok' as const, state })),
    open: vi.fn(async ({ provider }: { provider: 'codex' | 'claude' | 'grok' }) => ok({ ...state, current: { ...identity, provider } })),
    prepareStopAll: vi.fn(), stopAll: vi.fn(), setPermission: vi.fn(),
    onChanged: vi.fn((listener: (next: WatcherRoomState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
    ...options.handover === false ? {} : {
      readHandover: vi.fn(async (): Promise<WatcherHandoverRead> => ({ status: 'ok', text: WORDS, counts })),
      continueWithHandover: vi.fn(async (request: { draftId: string }) => { void request; return ok(state) }),
      dismissHandover: vi.fn(async () => ok({ ...state, handover: null })),
    },
  }
  return { bridge: bridge as unknown as WatcherBridge & typeof bridge & Required<Pick<typeof bridge, 'readHandover' | 'continueWithHandover' | 'dismissHandover'>>,
    publish: (next: WatcherRoomState) => { state = next; for (const listener of listeners) listener(next) } }
}

function renderRoom(room: WatcherRoomState, options: { readonly state?: AgentState; readonly handover?: boolean } = {}) {
  vi.mocked(useOptionalApp).mockReturnValue({
    navigation: 'watcher', platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS,
    update: { watcherEnabled: true }, actions: { navigate: vi.fn(), minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn() },
  } as unknown as AppContextValue)
  const state = options.state ?? stateWithWatcher()
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => state)
  const connection = agentContextFixture(state, command, { threadDrafts: new ThreadDraftStore(command) })
  vi.mocked(useAgents).mockReturnValue(connection)
  vi.mocked(useOptionalAgents).mockReturnValue(connection)
  const { bridge, publish } = fakeBridge(room, options)
  const view = render(<WatcherRoomProvider bridge={bridge}><SidebarChromeProvider updateControl={null}><WatcherView now={NOW} /></SidebarChromeProvider></WatcherRoomProvider>)
  return { ...view, bridge, publish, command }
}

const watcherPane = () => screen.findByRole('region', { name: 'Watcher' })
const sends = (command: ReturnType<typeof renderRoom>['command']) => command.mock.calls.map(([request]) => request).filter(request => request.type === 'manual-send')

beforeEach(() => {
  vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalAgents).mockReset(); vi.mocked(useOptionalApp).mockReset()
  localStorage.clear(); roomView.set({ besideId: null, share: 0.5, tab: 'conversation' }); firstMessage.clear()
})
afterEach(() => { cleanup(); localStorage.clear() })

describe('the handover’s ledger', () => {
  it('says what a handover carried and left out, from its counts alone', () => {
    expect(handoverLedger(counts)).toEqual({ carried: '4 of 6 messages', leftOut: '1 message too long to carry, 1 image and 12 records of its work' })
    expect(handoverLedger({ ...counts, carried: 6, tooLong: 0, images: 0, toolRecords: 0 })).toEqual({ carried: 'all 6 messages', leftOut: null })
    expect(handoverLedger({ ...counts, total: 1, carried: 1, tooLong: 0, images: 0, toolRecords: 1 })).toEqual({ carried: 'its one message', leftOut: '1 record of its work' })
    expect(handoverLedger({ ...counts, notCarried: 3, tooLong: 0, images: 2, files: 1, visuals: 1, toolRecords: 0 }).leftOut)
      .toBe('3 older messages that did not fit, 2 images, 1 attached file and 1 visual')
  })
})

describe('the handover over the new Watcher’s composer', () => {
  it('says sending starts the new Watcher with a handover of the last one, what it carries and leaves out, and the send says Continue', async () => {
    renderRoom(roomState())
    const pane = await watcherPane()
    const strip = within(pane).getByRole('region', { name: 'Handover of the last Watcher' })
    expect(strip).toHaveTextContent('Sending starts the new Watcher with a handover of the last one, from Codex.')
    expect(strip).toHaveTextContent('It carries 4 of 6 messages and leaves out 1 message too long to carry, 1 image and 12 records of its work.')
    // Directly above the composer, in the eye's order: the strip, then the box, then Continue.
    const box = within(pane).getByRole('textbox', { name: 'Watcher message' })
    expect(strip.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const send = within(pane).getByRole('button', { name: 'Continue with the handover' })
    expect(send).toHaveTextContent('Continue')
    expect(within(pane).queryByRole('button', { name: 'Send prompt' })).toBeNull()
  })

  it('with history off, says the handover holds only what Sotto kept', async () => {
    renderRoom(roomState({ handover: { source: target('watcher-old'), provider: 'codex', counts: { ...counts, historyKept: false } } }))
    const strip = within(await watcherPane()).getByRole('region', { name: 'Handover of the last Watcher' })
    expect(strip).toHaveTextContent('Keep local history is off, so it holds only what Sotto kept since it last started. It carries 4 of 6 messages')
  })

  it('continues: main is told which draft carries the handover before that draft goes', async () => {
    const user = userEvent.setup()
    const { bridge, command } = renderRoom(roomState())
    const pane = await watcherPane()
    await user.click(within(pane).getByRole('textbox', { name: 'Watcher message' }))
    await user.keyboard('Carry on with the footer links.')
    await user.click(within(pane).getByRole('button', { name: 'Continue with the handover' }))
    await waitFor(() => expect(sends(command)).toHaveLength(1))
    const [sent] = sends(command) as Extract<AgentCommand, { type: 'manual-send' }>[]
    expect(sent).toMatchObject({ threadId: 'watcher-new', text: 'Carry on with the footer links.' })
    expect(bridge.continueWithHandover).toHaveBeenCalledWith({ draftId: sent!.draftId })
    expect(bridge.continueWithHandover.mock.invocationCallOrder[0]).toBeLessThan(command.mock.invocationCallOrder.at(-1)!)
    expect(bridge.dismissHandover).not.toHaveBeenCalled()
  })

  it('keeps the message back when main no longer offers the handover, and says so where the message is', async () => {
    const user = userEvent.setup()
    const { bridge, command } = renderRoom(roomState())
    bridge.continueWithHandover.mockResolvedValueOnce({ status: 'refused', code: 'TARGET_CHANGED', retryable: false,
      message: 'The handover is no longer offered, so nothing was sent. Retry sends your message to the new Watcher without it.' })
    const pane = await watcherPane()
    await user.click(within(pane).getByRole('textbox', { name: 'Watcher message' }))
    await user.keyboard('Carry on.{Enter}')
    expect(await within(pane).findByText(/The handover is no longer offered, so nothing was sent\./)).toBeVisible()
    expect(sends(command)).toHaveLength(0)
  })

  it('reads the handover on request, and Escape folds it, then puts the offer away and returns to the box', async () => {
    const user = userEvent.setup()
    const { bridge, command } = renderRoom(roomState())
    const pane = await watcherPane()
    const strip = within(pane).getByRole('region', { name: 'Handover of the last Watcher' })
    const read = within(strip).getByRole('button', { name: 'Read it' })
    await user.click(read)
    const words = await within(strip).findByRole('region', { name: 'The handover, word for word' })
    expect(words).toHaveTextContent('The history below is context, not a new request.')
    expect(within(strip).getByRole('button', { name: 'Hide it' })).toHaveAttribute('aria-expanded', 'true')
    words.focus()
    await user.keyboard('{Escape}')
    expect(within(strip).queryByRole('region', { name: 'The handover, word for word' })).toBeNull()
    expect(within(strip).getByRole('button', { name: 'Read it' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(bridge.dismissHandover).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(within(pane).queryByRole('region', { name: 'Handover of the last Watcher' })).toBeNull())
    expect(within(pane).getByRole('textbox', { name: 'Watcher message' })).toHaveFocus()
    expect(sends(command)).toHaveLength(0)
    // Put away, the send is an ordinary send again.
    expect(within(pane).getByRole('button', { name: 'Send prompt' })).toBeInTheDocument()
  })

  it('puts the offer away on Escape from the composer under it, once nothing open there takes the key', async () => {
    const user = userEvent.setup()
    const { bridge, command } = renderRoom(roomState())
    const pane = await watcherPane()
    await user.click(within(pane).getByRole('textbox', { name: 'Watcher message' }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(bridge.dismissHandover).toHaveBeenCalledTimes(1))
    expect(within(pane).getByRole('textbox', { name: 'Watcher message' })).toHaveFocus()
    expect(sends(command)).toHaveLength(0)
  })

  it('leaves the offer when Escape closes something open in the composer', async () => {
    const user = userEvent.setup()
    const { bridge } = renderRoom(roomState())
    const pane = await watcherPane()
    const chip = within(pane).getByRole('combobox', { name: 'Watcher’s permissions' })
    await user.click(chip)
    await user.keyboard('{Escape}')
    expect(chip).toHaveFocus()
    expect(bridge.dismissHandover).not.toHaveBeenCalled()
    expect(within(pane).getByRole('region', { name: 'Handover of the last Watcher' })).toBeInTheDocument()
  })

  it('puts the offer away from its X, sending nothing', async () => {
    const { bridge, command } = renderRoom(roomState())
    const pane = await watcherPane()
    fireEvent.click(within(pane).getByRole('button', { name: 'Don’t hand over: start the new Watcher without it' }))
    await waitFor(() => expect(within(pane).queryByRole('region', { name: 'Handover of the last Watcher' })).toBeNull())
    expect(bridge.dismissHandover).toHaveBeenCalledTimes(1)
    expect(bridge.continueWithHandover).not.toHaveBeenCalled()
    expect(sends(command)).toHaveLength(0)
  })

  it('shows nothing without an offer, or where the bridge takes no handover', async () => {
    renderRoom(roomState({ handover: null }))
    let pane = await watcherPane()
    expect(within(pane).queryByRole('region', { name: 'Handover of the last Watcher' })).toBeNull()
    expect(within(pane).getByRole('button', { name: 'Send prompt' })).toBeInTheDocument()
    cleanup()
    renderRoom(roomState(), { handover: false })
    pane = await watcherPane()
    expect(within(pane).queryByRole('region', { name: 'Handover of the last Watcher' })).toBeNull()
  })

  it('goes when main says the first message went', async () => {
    const { publish } = renderRoom(roomState())
    const pane = await watcherPane()
    expect(within(pane).getByRole('region', { name: 'Handover of the last Watcher' })).toBeInTheDocument()
    act(() => publish(roomState({ handover: null, observedAt: new Date(NOW + 1_000).toISOString() })))
    await waitFor(() => expect(within(pane).queryByRole('region', { name: 'Handover of the last Watcher' })).toBeNull())
  })
})

describe('the new Watcher’s first message', () => {
  it('shows the handover as Sotto’s, context rather than a request, ahead of the user’s words, with its words on request', async () => {
    const user = userEvent.setup()
    const thread = watcherThread({ messages: [{ id: 'first', role: 'user', text: 'Carry on with the footer links.', createdAt: at,
      handover: { text: WORDS, provider: 'codex', counts } }] })
    renderRoom(roomState({ handover: null }), { state: stateWithWatcher(thread) })
    const pane = await watcherPane()
    const card = within(pane).getByRole('article', { name: 'Handover from the last Watcher' })
    expect(card).toHaveTextContent('SottoHandover')
    expect(card).toHaveTextContent('From the last Watcher, on Codex. Context, not a new request.')
    expect(card).toHaveTextContent('Carried 4 of 6 messages. Left out 1 message too long to carry, 1 image and 12 records of its work.')
    expect(card).not.toHaveTextContent('Watch the footer links.')
    const words = pane.querySelector('[data-message-id="first"]')!
    expect(words).toHaveTextContent('Carry on with the footer links.')
    expect(card.compareDocumentPosition(words) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const disclose = within(card).getByRole('button', { name: 'Read the handover, word for word' })
    await user.click(disclose)
    expect(within(card).getByRole('region', { name: 'The handover, word for word' })).toHaveTextContent('Watch the footer links.')
    await user.keyboard('{Escape}')
    expect(within(card).queryByRole('region', { name: 'The handover, word for word' })).toBeNull()
    expect(within(card).getByRole('button', { name: 'Read the handover, word for word' })).toHaveFocus()
  })
})

describe('changing Watcher’s provider', () => {
  it('offers another provider’s models in Watcher’s model picker, and choosing one starts a new Watcher there through main', async () => {
    const { bridge } = renderRoom(roomState({ handover: null }))
    const pane = await watcherPane()
    fireEvent.click(within(pane).getByRole('combobox', { name: 'Thread model' }))
    const picker = await screen.findByRole('dialog', { name: 'Choose model' })
    expect(within(picker).getByText(/Another provider’s model starts a new Watcher\./)).toBeVisible()
    fireEvent.click(within(picker).getByRole('tab', { name: 'Codex' }))
    fireEvent.click(within(picker).getByRole('option', { name: 'GPT-5.4' }))
    await waitFor(() => expect(bridge.open).toHaveBeenCalledWith({ provider: 'codex', modelId: 'codex:gpt' }))
  })
})
