// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { registerThreadCoordinationIpc, type ThreadCoordinationViews } from '../../../src/main/agents/threadCoordinationIpc'
import { formatIncomingPeerMessage } from '../../../src/main/agents/threadCoordinationNews'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { COORDINATION_CHANGED, COORDINATION_READ, COORDINATION_REPLY_READ, parseIncomingPeerMessageBody, type CoordinationExchangeView } from '../../../src/shared/threadCoordination'
import { ipcRegistry } from '../../fixtures/ipcHarness'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const REMOTE = '22222222-2222-4222-8222-222222222222'

function exchangeView(patch: Partial<CoordinationExchangeView> = {}): CoordinationExchangeView {
  return {
    id: randomUUID(),
    direction: 'sent',
    peerThreadId: 'target-1',
    peerTitle: 'API refactor',
    peerProvider: 'codex',
    messageId: randomUUID(),
    anchorMessageId: 'turn-1',
    delivery: 'started',
    deliveryState: 'accepted',
    outcome: 'working',
    hopCount: 1,
    hopMax: 6,
    expectReply: true,
    hasReply: false,
    createdAt: '2026-11-23T10:00:00.000Z',
    updatedAt: '2026-11-23T10:00:01.000Z',
    ...patch,
  }
}

function fakeService(
  byThread: Record<string, { sent: CoordinationExchangeView[]; received: CoordinationExchangeView[] }> = {},
  replies: Record<string, { text: string; truncated: boolean }> = {},
) {
  let listener: ((threadIds: readonly string[]) => void) | undefined
  const asked: string[] = []
  const service: ThreadCoordinationViews = {
    views: threadId => { asked.push(`views:${threadId}`); return byThread[threadId] ?? { sent: [], received: [] } },
    reply: (threadId, exchangeId) => { asked.push(`reply:${threadId}:${exchangeId}`); return replies[`${threadId}:${exchangeId}`] },
    onViewsChanged: given => { listener = given; return () => { listener = undefined } },
  }
  return { service, asked, change: (ids: readonly string[]) => listener?.(ids), listening: () => listener !== undefined }
}

describe('parent-to-parent thread coordination IPC (ADR-0216, Slice 2)', () => {
  it('registers nothing and listens to nothing when the Owl feature is off', () => {
    const { ipc, handlers, main } = ipcRegistry()
    const send = vi.fn()
    registerThreadCoordinationIpc(ipc, undefined, () => [main], () => LOCAL, send)()
    expect(handlers.size).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('serves host-qualified local views, refuses non-main senders, and returns empty for remote hosts', async () => {
    const { ipc, handlers, main, mainEvent, widgetEvent } = ipcRegistry()
    const sent = exchangeView({ direction: 'sent', peerThreadId: 'target-1', outcome: 'answered', hasReply: true })
    const received = exchangeView({ direction: 'received', peerThreadId: 'sender-1', peerTitle: 'UI Polish', peerProvider: 'claude' })
    const { service, asked } = fakeService({
      'sender-1': { sent: [sent], received: [] },
      'target-1': { sent: [], received: [received] },
    })
    const close = registerThreadCoordinationIpc(ipc, service, () => [main], () => LOCAL, vi.fn())
    const read = handlers.get(COORDINATION_READ)!

    expect(await read(mainEvent, { threadId: hostEntityKey(LOCAL, 'sender-1') })).toMatchObject({
      threadId: hostEntityKey(LOCAL, 'sender-1'),
      sent: [{ id: sent.id, peerThreadId: hostEntityKey(LOCAL, 'target-1'), outcome: 'answered', hasReply: true }],
      received: [],
    })
    expect(await read(mainEvent, { threadId: hostEntityKey(LOCAL, 'target-1') })).toMatchObject({
      threadId: hostEntityKey(LOCAL, 'target-1'),
      sent: [],
      received: [{ id: received.id, peerThreadId: hostEntityKey(LOCAL, 'sender-1'), peerTitle: 'UI Polish' }],
    })
    expect(await read(mainEvent, { threadId: hostEntityKey(REMOTE, 'sender-1') })).toEqual({
      threadId: hostEntityKey(REMOTE, 'sender-1'),
      sent: [],
      received: [],
    })
    expect(asked).toEqual(['views:sender-1', 'views:target-1'])

    expect(() => read(widgetEvent, { threadId: 'sender-1' })).toThrow('main Sotto window')
    expect(() => read(mainEvent, { threadId: 'sender-1', extra: true })).toThrow()
    close()
    expect(handlers.size).toBe(0)
  })

  it('reads an answered exchange reply on demand for local threads and main window only', async () => {
    const { ipc, handlers, main, mainEvent, widgetEvent } = ipcRegistry()
    const exchangeId = randomUUID()
    const { service, asked } = fakeService({}, {
      [`sender-1:${exchangeId}`]: { text: 'Endpoint is ready at /v2/auth.', truncated: false },
    })
    const close = registerThreadCoordinationIpc(ipc, service, () => [main], () => LOCAL, vi.fn())
    const readReply = handlers.get(COORDINATION_REPLY_READ)!

    expect(await readReply(mainEvent, { threadId: hostEntityKey(LOCAL, 'sender-1'), exchangeId })).toEqual({
      exchangeId,
      text: 'Endpoint is ready at /v2/auth.',
      truncated: false,
    })
    expect(await readReply(mainEvent, { threadId: hostEntityKey(LOCAL, 'sender-1'), exchangeId: randomUUID() })).toBeNull()
    expect(await readReply(mainEvent, { threadId: hostEntityKey(REMOTE, 'sender-1'), exchangeId })).toBeNull()
    expect(asked).toHaveLength(2)

    expect(() => readReply(widgetEvent, { threadId: 'sender-1', exchangeId })).toThrow('main Sotto window')
    expect(() => readReply(mainEvent, { threadId: 'sender-1', exchangeId: 'not-a-uuid' })).toThrow()
    close()
    expect(handlers.size).toBe(0)
  })

  it('pushes host-qualified COORDINATION_CHANGED notifications and stops on cleanup', () => {
    const { ipc, main } = ipcRegistry()
    const { service, change, listening } = fakeService()
    const send = vi.fn()
    const close = registerThreadCoordinationIpc(ipc, service, () => [main], () => LOCAL, send)

    change(['sender-1', 'target-1'])
    expect(send).toHaveBeenCalledWith(COORDINATION_CHANGED, {
      threadIds: [hostEntityKey(LOCAL, 'sender-1'), hostEntityKey(LOCAL, 'target-1')],
    })
    close()
    expect(listening()).toBe(false)
  })

  it('parses the inner body of a Sotto-framed incoming peer message and un-escapes fenced lines', () => {
    const exchangeId = randomUUID()
    const framed = formatIncomingPeerMessage({
      senderThreadId: 'sender-1',
      senderTitle: 'UI Polish',
      senderProvider: 'claude',
      exchangeId,
      hopCount: 2,
      hopMax: 6,
      message: 'First line\n--- separator\nLast line',
      expectReply: true,
    })
    expect(parseIncomingPeerMessageBody(framed)).toBe('First line\n--- separator\nLast line')
    expect(parseIncomingPeerMessageBody('Plain user message with no framing')).toBeNull()
  })
})
