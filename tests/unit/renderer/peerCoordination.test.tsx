// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentMessage, AgentState } from '../../../src/shared/agents'
import { COORDINATION_NEWS_OPENING, type CoordinationBridge, type CoordinationChanged, type CoordinationExchangeView, type CoordinationReply } from '../../../src/shared/threadCoordination'
import { formatIncomingPeerMessage } from '../../../src/main/agents/threadCoordinationNews'
import { CoordinationStore } from '../../../src/renderer/src/agents/coordination'
import { PeerCoordinationAgentsSection, PeerCoordinationHeaderBadge, PeerCoordinationWorldProvider, PeerExchangeRow, peerExchangesByTurn, usePeerCoordinationWorld, type PeerCoordinationWorld } from '../../../src/renderer/src/agents/PeerCoordination'
import { MessageList, type ActivityContext } from '../../../src/renderer/src/agents/ThreadTranscript'
import { placeActivities } from '../../../src/renderer/src/agents/threadActivityView'
import { ToolsPanelStore } from '../../../src/renderer/src/tools/toolsPanelStore'
import { useOptionalApp, type AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))

function setOwl(on: boolean): void {
  vi.mocked(useOptionalApp).mockReturnValue({
    update: {
      currentVersion: '0.1.37-owl.20261123.1',
      phase: { phase: 'up-to-date' },
      checkedAt: null,
      owlFeatures: { 'parent-thread-coordination': on },
    },
  } as unknown as AppContextValue)
}

function makeExchange(patch: Partial<CoordinationExchangeView> = {}): CoordinationExchangeView {
  return {
    id: crypto.randomUUID(),
    direction: 'sent',
    peerThreadId: 'api-thread',
    peerTitle: 'API refactor',
    peerProvider: 'codex',
    messageId: crypto.randomUUID(),
    anchorMessageId: 'turn-1',
    delivery: 'started',
    deliveryState: 'accepted',
    outcome: 'working',
    hopCount: 1,
    hopMax: 6,
    expectReply: true,
    hasReply: false,
    createdAt: '2026-11-23T10:00:00.000Z',
    updatedAt: '2026-11-23T10:00:05.000Z',
    ...patch,
  }
}

function makeBridge(
  initial: Record<string, { sent: CoordinationExchangeView[]; received: CoordinationExchangeView[] }>,
  replies: Record<string, { text: string; truncated: boolean }> = {},
) {
  const listeners = new Set<(change: CoordinationChanged) => void>()
  const bridge: CoordinationBridge & { readonly reads: string[] } = {
    reads: [],
    read: vi.fn(async ({ threadId }) => {
      bridge.reads.push(threadId)
      return { threadId, ...(initial[threadId] ?? { sent: [], received: [] }) }
    }),
    reply: vi.fn(async ({ exchangeId }) => {
      const found = replies[exchangeId]
      return found ? { exchangeId, ...found } : null
    }),
    onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return {
    bridge,
    emitChanged: (threadIds: string[]) => { for (const listener of [...listeners]) listener({ threadIds }) },
    listenerCount: () => listeners.size,
  }
}

function twoParentThreadsState(): AgentState {
  const state = threadsStateFixture()
  state.host.threads = [
    {
      id: 'ui-thread',
      title: 'UI Polish',
      projectId: 'workshop',
      modelId: 'claude:sonnet',
      providerId: 'claude',
      status: 'idle',
      requests: [],
      updatedAt: '2026-11-23T10:00:00.000Z',
      messages: [],
    },
    {
      id: 'api-thread',
      title: 'API refactor',
      projectId: 'workshop',
      modelId: 'codex:gpt',
      providerId: 'codex',
      status: 'running',
      requests: [],
      updatedAt: '2026-11-23T10:00:02.000Z',
      messages: [],
    },
  ]
  return state
}

const dummyActivity: ActivityContext = {
  liveTurn: null,
  running: false,
  connected: true,
  provider: 'Codex',
  onDisclosure: () => undefined,
}

beforeEach(() => {
  vi.mocked(useOptionalApp).mockReset()
})

afterEach(() => {
  cleanup()
  delete (window as { sotto?: unknown }).sotto
})

describe('parent-to-parent coordination UI (ADR-0216, Slice 2)', () => {
  it('renders an incoming peer message marked wakeUp: true as a quiet left-aligned attributed card (L1, Option A)', () => {
    setOwl(true)
    const state = twoParentThreadsState()
    const exchangeId = crypto.randomUUID()
    const msgId = crypto.randomUUID()
    const framedText = formatIncomingPeerMessage({
      senderThreadId: 'ui-thread',
      senderTitle: 'UI Polish',
      senderProvider: 'claude',
      exchangeId,
      hopCount: 2,
      hopMax: 6,
      message: 'Does POST /v2/sessions accept refresh tokens?',
      expectReply: true,
    })
    const messages: AgentMessage[] = [
      // Real deliveries are marked wakeUp: true by recordSottoMessage (#2835); verified peerExchange must win (L1).
      { id: msgId, role: 'user', wakeUp: true, text: framedText, createdAt: '2026-11-23T10:01:00.000Z' },
      { id: 'reply-1', role: 'assistant', text: 'Yes, pass refreshToken in the JSON body.', createdAt: '2026-11-23T10:01:10.000Z' },
    ]
    const received = makeExchange({
      id: exchangeId,
      direction: 'received',
      peerThreadId: 'ui-thread',
      peerTitle: 'UI Polish',
      peerProvider: 'claude',
      messageId: msgId,
      hopCount: 2,
    })
    const open = vi.fn()
    const world: PeerCoordinationWorld = {
      threadId: 'api-thread',
      thread: id => state.host.threads.find(item => item.id === id),
      open,
      readReply: vi.fn(async () => null),
    }

    const { container } = render(
      <PeerCoordinationWorldProvider world={world}>
        <MessageList
          messages={messages}
          provider="Codex"
          running={false}
          placement={placeActivities(messages, messages, undefined, false, false)}
          context={dummyActivity}
          threadId="api-thread"
          receivedPeers={new Map([[msgId, received]])}
        />
      </PeerCoordinationWorldProvider>,
    )

    const peerArticle = container.querySelector('article[data-from="peer"]')
    expect(peerArticle).not.toBeNull()
    expect(screen.getByText('UI Polish')).toBeTruthy()
    expect(screen.getByText('hop 2/6')).toBeTruthy()
    expect(screen.getByText('Does POST /v2/sessions accept refresh tokens?')).toBeTruthy()
    // Sotto's raw prompt-framing lines are parsed away on the card.
    expect(screen.queryByText(/--- Begin message from parent thread/)).toBeNull()
    expect(screen.getByText(/Peer context only — does not approve permissions or answer cards\./)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Open thread UI Polish' }))
    expect(open).toHaveBeenCalledWith('ui-thread')
  })

  it('renders an outgoing exchange row (Option 1) with lazy expandable reply and Escape close', async () => {
    setOwl(true)
    const state = twoParentThreadsState()
    const exchange = makeExchange({
      outcome: 'answered',
      hasReply: true,
      hopCount: 1,
      hopMax: 6,
    })
    const open = vi.fn()
    const readReply = vi.fn(async () => ({
      exchangeId: exchange.id,
      text: 'Schema frozen at v2.1; tests pass.',
      truncated: true,
    }))
    const world: PeerCoordinationWorld = {
      threadId: 'ui-thread',
      thread: id => state.host.threads.find(item => item.id === id),
      open,
      readReply,
    }

    render(
      <PeerCoordinationWorldProvider world={world}>
        <ul><PeerExchangeRow view={exchange} /></ul>
      </PeerCoordinationWorldProvider>,
    )

    expect(screen.getByText('Sent to')).toBeTruthy()
    expect(screen.getByText('API refactor')).toBeTruthy()
    expect(screen.getByText('Answered')).toBeTruthy()
    expect(screen.getByText('hop 1/6')).toBeTruthy()
    expect(readReply).not.toHaveBeenCalled()

    const toggle = screen.getByRole('button', { name: 'Read reply' })
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.getByText('Schema frozen at v2.1; tests pass.')).toBeTruthy())
    expect(readReply).toHaveBeenCalledWith(exchange.id)
    expect(screen.getByText(/approves nothing/i)).toBeTruthy()
    expect(screen.getByText(/cut short/i)).toBeTruthy()

    // Escape closes the reply panel and returns focus to its toggle button.
    fireEvent.keyDown(screen.getByText('Schema frozen at v2.1; tests pass.'), { key: 'Escape' })
    expect(screen.queryByText('Schema frozen at v2.1; tests pass.')).toBeNull()
    expect(document.activeElement).toBe(toggle)

    fireEvent.click(screen.getByRole('button', { name: 'Open thread API refactor' }))
    expect(open).toHaveBeenCalledWith('api-thread')
  })

  it('shows the quiet header badge only while a peer exchange is active or queued and opens Tools › Agents on click', async () => {
    setOwl(true)
    const working = makeExchange({ deliveryState: 'accepted', outcome: 'working' })
    const answered = makeExchange({ deliveryState: 'accepted', outcome: 'answered', hasReply: true })
    const data: Record<string, { sent: CoordinationExchangeView[]; received: CoordinationExchangeView[] }> = {
      'ui-thread': { sent: [working], received: [] },
      'done-thread': { sent: [answered], received: [] },
    }
    const { bridge, emitChanged } = makeBridge(data)
    ;(window as { sotto?: unknown }).sotto = { coordination: bridge }
    const store = new CoordinationStore(() => bridge)
    const panelStore = new ToolsPanelStore()

    const { rerender } = render(<PeerCoordinationHeaderBadge threadId="ui-thread" store={store} panelStore={panelStore} />)
    await waitFor(() => expect(screen.getByText('1 peer active')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Open Peer coordination in Tools/i }))
    expect(panelStore.getSnapshot().open).toBe(true)
    expect(panelStore.getSnapshot().surface).toBe('agents')

    // Transitioning to answered removes the header badge completely.
    data['ui-thread'] = { sent: [answered], received: [] }
    act(() => emitChanged(['ui-thread']))
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull())

    // Stable / Owl feature off renders nothing even when exchanges are active.
    setOwl(false)
    data['ui-thread'] = { sent: [working], received: [] }
    rerender(<PeerCoordinationHeaderBadge threadId="ui-thread" store={store} panelStore={panelStore} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders Tools › Agents Peer coordination section with Open thread and Open beside, and hides when Owl feature is off', async () => {
    setOwl(true)
    const state = twoParentThreadsState()
    const sent = makeExchange({ direction: 'sent', peerThreadId: 'api-thread', peerTitle: 'API refactor', outcome: 'answered', hasReply: true })
    const { bridge } = makeBridge({ 'ui-thread': { sent: [sent], received: [] } }, {
      [sent.id]: { text: 'Done.', truncated: false },
    })
    ;(window as { sotto?: unknown }).sotto = { coordination: bridge }
    const store = new CoordinationStore(() => bridge)
    const command = vi.fn(async () => state)
    const onOpenBeside = vi.fn()

    const { rerender } = render(
      <PeerCoordinationAgentsSection threadId="ui-thread" source={{ state, command, onOpenBeside }} store={store} />,
    )

    await waitFor(() => expect(screen.getByText('Peer coordination')).toBeTruthy())
    expect(screen.getByText('API refactor')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Open thread API refactor' }))
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: 'api-thread' })

    fireEvent.click(screen.getByRole('button', { name: 'Open API refactor beside' }))
    expect(onOpenBeside).toHaveBeenCalledWith('api-thread')

    // Owl off hides the entire section.
    setOwl(false)
    rerender(<PeerCoordinationAgentsSection threadId="ui-thread" source={{ state, command, onOpenBeside }} store={store} />)
    expect(screen.queryByText('Peer coordination')).toBeNull()
  })

  it('groups outgoing exchanges by anchorMessageId or trailing slot cleanly', () => {
    const anchored = makeExchange({ anchorMessageId: 'm1', createdAt: '2026-11-23T10:01:00.000Z' })
    const unanchored = makeExchange({ anchorMessageId: undefined, createdAt: '2026-11-23T10:02:00.000Z' })
    const earlier = makeExchange({ anchorMessageId: 'm0', createdAt: '2026-11-23T09:00:00.000Z' })
    const map = peerExchangesByTurn([anchored, unanchored, earlier], [
      { id: 'm1', createdAt: '2026-11-23T10:00:00.000Z' },
    ])
    expect(map.get('m1')).toEqual([anchored])
    expect(map.get('')).toEqual([unanchored])
    expect(map.has('m0')).toBe(false)
  })

  it('keeps hidden coordination-news wake-ups as separate turns with preserved activity and hop-2 stopped exchanges (L2, L3)', () => {
    setOwl(true)
    const state = twoParentThreadsState()
    const messages: AgentMessage[] = [
      { id: 'u1', role: 'user', text: 'Coordinate with API refactor', createdAt: '2026-11-23T10:00:00.000Z' },
      { id: 'a1', role: 'assistant', text: 'Sent initial request to API refactor.', createdAt: '2026-11-23T10:00:10.000Z' },
      { id: 'w1', role: 'user', wakeUp: true, text: `${COORDINATION_NEWS_OPENING}\n- Exchange ex-1 replied.`, createdAt: '2026-11-23T10:01:00.000Z' },
      { id: 'a2', role: 'assistant', text: 'Updated UI client to match v2 response.', createdAt: '2026-11-23T10:01:20.000Z' },
    ]
    const activities: AgentActivity[] = [
      { id: 'turn-1', turnId: 't1', kind: 'turn', title: 'Turn 1', status: 'completed', sequence: 1, afterMessageId: 'u1', startedAt: '2026-11-23T10:00:01.000Z', completedAt: '2026-11-23T10:00:10.000Z' },
      { id: 'c1', turnId: 't1', kind: 'command', title: 'Ran initial check', status: 'completed', sequence: 2, afterMessageId: 'u1', startedAt: '2026-11-23T10:00:02.000Z', completedAt: '2026-11-23T10:00:05.000Z' },
      { id: 'turn-2', turnId: 't2', kind: 'turn', title: 'Turn 2', status: 'completed', sequence: 3, afterMessageId: 'w1', startedAt: '2026-11-23T10:01:01.000Z', completedAt: '2026-11-23T10:01:20.000Z' },
      { id: 'c2', turnId: 't2', kind: 'command', title: 'Ran follow-up check', status: 'completed', sequence: 4, afterMessageId: 'w1', startedAt: '2026-11-23T10:01:02.000Z', completedAt: '2026-11-23T10:01:15.000Z' },
    ]
    const hop2Stopped = makeExchange({
      anchorMessageId: 'w1',
      hopCount: 2,
      outcome: 'stopped',
      hasReply: false,
      createdAt: '2026-11-23T10:01:05.000Z',
    })
    const world: PeerCoordinationWorld = {
      threadId: 'ui-thread',
      thread: id => state.host.threads.find(item => item.id === id),
      open: vi.fn(),
      readReply: vi.fn(async () => null),
    }

    const { container } = render(
      <PeerCoordinationWorldProvider world={world}>
        <MessageList
          messages={messages}
          provider="Claude Code"
          running={false}
          placement={placeActivities(messages, messages, activities, false, false)}
          context={dummyActivity}
          threadId="ui-thread"
          peerExchanges={peerExchangesByTurn([hop2Stopped], messages)}
          hideCoordinationWakeUps
        />
      </PeerCoordinationWorldProvider>,
    )

    // Raw coordination-news wake-up bubble is hidden.
    expect(screen.queryByText(/Sotto has news of a peer parent-thread coordination exchange/)).toBeNull()
    // Both replies remain visible as separate turns (a1 is NOT collapsed into u1's work fold).
    expect(screen.getByText('Sent initial request to API refactor.')).toBeTruthy()
    expect(screen.getByText('Updated UI client to match v2 response.')).toBeTruthy()
    // Both turns retain their own Worked-for fold sections (c1 on turn 1, c2 on turn 2).
    expect(container.querySelectorAll('section.thread-work')).toHaveLength(2)
    // Hop-2 stopped exchange anchored to w1 is still rendered under turn 2.
    expect(screen.getByText('hop 2/6')).toBeTruthy()
    expect(screen.getByText('Stopped')).toBeTruthy()
  })

  it('does not stick Read reply on Loading across host publishes or Hide/Read toggles (L4)', async () => {
    setOwl(true)
    const exchange = makeExchange({ outcome: 'answered', hasReply: true })
    let resolveFirst!: (value: CoordinationReply) => void
    let resolveSecond!: (value: CoordinationReply) => void
    let call = 0
    const bridge: CoordinationBridge = {
      read: vi.fn(async ({ threadId }) => ({ threadId, sent: [exchange], received: [] })),
      reply: vi.fn(() => new Promise<CoordinationReply>(resolve => {
        call += 1
        if (call === 1) resolveFirst = resolve
        else resolveSecond = resolve
      })),
      onChanged: () => () => undefined,
    }
    ;(window as { sotto?: unknown }).sotto = { coordination: bridge }
    const store = new CoordinationStore(() => bridge)
    const command = vi.fn(async () => twoParentThreadsState())

    function Harness({ state }: { readonly state: AgentState }) {
      const world = usePeerCoordinationWorld('ui-thread', state, command, store)
      return <PeerCoordinationWorldProvider world={world}><ul><PeerExchangeRow view={exchange} /></ul></PeerCoordinationWorldProvider>
    }

    const firstState = twoParentThreadsState()
    const { rerender } = render(<Harness state={firstState} />)

    // Open Read reply, then trigger a host publish (fresh threads array) before it settles.
    fireEvent.click(screen.getByRole('button', { name: 'Read reply' }))
    expect(screen.getByText('Loading reply…')).toBeTruthy()
    const nextState = twoParentThreadsState()
    nextState.host.threads[1] = { ...nextState.host.threads[1]!, updatedAt: '2026-11-23T10:02:00.000Z' }
    rerender(<Harness state={nextState} />)
    expect(bridge.reply).toHaveBeenCalledTimes(1)

    // Hide then Read again before first promise resolves, then resolve second promise.
    fireEvent.click(screen.getByRole('button', { name: 'Hide reply' }))
    fireEvent.click(screen.getByRole('button', { name: 'Read reply' }))
    expect(bridge.reply).toHaveBeenCalledTimes(2)
    act(() => {
      resolveFirst({ exchangeId: exchange.id, text: 'Stale first read', truncated: false })
      resolveSecond({ exchangeId: exchange.id, text: 'Fresh settled reply', truncated: false })
    })
    await waitFor(() => expect(screen.getByText('Fresh settled reply')).toBeTruthy())
    expect(screen.queryByText('Loading reply…')).toBeNull()
  })

  it('labels received rows in Tools › Agents as this thread’s own reply, not the peer’s words (L5)', async () => {
    setOwl(true)
    const state = twoParentThreadsState()
    const received = makeExchange({
      direction: 'received',
      peerThreadId: 'ui-thread',
      peerTitle: 'UI Polish',
      peerProvider: 'claude',
      outcome: 'answered',
      hasReply: true,
    })
    const { bridge } = makeBridge({ 'api-thread': { sent: [], received: [received] } }, {
      [received.id]: { text: 'Added refreshToken support.', truncated: false },
    })
    ;(window as { sotto?: unknown }).sotto = { coordination: bridge }
    const store = new CoordinationStore(() => bridge)

    render(<PeerCoordinationAgentsSection threadId="api-thread" source={{ state, command: vi.fn(async () => state) }} store={store} />)
    await waitFor(() => expect(screen.getByText('UI Polish')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Read reply' }))
    await waitFor(() => expect(screen.getByText('Added refreshToken support.')).toBeTruthy())
    expect(screen.getByText('This thread’s reply to UI Polish.')).toBeTruthy()
    expect(screen.queryByText(/UI Polish’s own words/)).toBeNull()
  })

  it('retains cached views across thread switches (N2), retries after a failed first read (N3), and skips reads/subscriptions when Owl gate is off', async () => {
    const working = makeExchange({ outcome: 'working' })
    let failFirst = true
    const listeners = new Set<(change: CoordinationChanged) => void>()
    const bridge: CoordinationBridge = {
      read: vi.fn(async ({ threadId }) => {
        if (failFirst) { failFirst = false; throw new Error('transient') }
        return { threadId, sent: [working], received: [] }
      }),
      reply: vi.fn(async () => null),
      onChanged: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }),
    }
    ;(window as { sotto?: unknown }).sotto = { coordination: bridge }

    // Gate off: zero bridge reads and zero subscriptions.
    setOwl(false)
    const offStore = new CoordinationStore(() => bridge)
    const state = twoParentThreadsState()
    render(<>
      <PeerCoordinationHeaderBadge threadId="ui-thread" store={offStore} panelStore={new ToolsPanelStore()} />
      <PeerCoordinationAgentsSection threadId="ui-thread" source={{ state, command: vi.fn(async () => state) }} store={offStore} />
    </>)
    expect(bridge.read).not.toHaveBeenCalled()
    expect(bridge.onChanged).not.toHaveBeenCalled()
    cleanup()

    // N3: failed first read retries cleanly on next want().
    const store = new CoordinationStore(() => bridge)
    const unsub1 = store.subscribe('ui-thread', () => undefined)
    store.want('ui-thread')
    await waitFor(() => expect(bridge.read).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 0))
    store.want('ui-thread')
    await waitFor(() => expect(store.views('ui-thread').sent).toHaveLength(1))

    // N2: leaving the thread retains cached views immediately on return (no flash to empty).
    unsub1()
    expect(store.views('ui-thread').sent).toHaveLength(1)
  })
})
