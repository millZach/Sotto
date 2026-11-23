// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage, AgentState } from '../../../src/shared/agents'
import type { CoordinationBridge, CoordinationChanged, CoordinationExchangeView } from '../../../src/shared/threadCoordination'
import { formatIncomingPeerMessage } from '../../../src/main/agents/threadCoordinationNews'
import { CoordinationStore } from '../../../src/renderer/src/agents/coordination'
import { PeerCoordinationAgentsSection, PeerCoordinationHeaderBadge, PeerCoordinationWorldProvider, PeerExchangeRow, peerExchangesByTurn, type PeerCoordinationWorld } from '../../../src/renderer/src/agents/PeerCoordination'
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
  it('renders an incoming peer message as a quiet left-aligned attributed card (Option A) with Open thread and ADR-0004 note', () => {
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
      { id: msgId, role: 'user', text: framedText, createdAt: '2026-11-23T10:01:00.000Z' },
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
})
