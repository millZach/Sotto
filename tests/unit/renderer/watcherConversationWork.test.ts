// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { joinedPlacements, joinedReceipts, joinedTakeovers, liveReceipts, placeTakeovers, recalledConversation, recalledTakeovers,
  type RecalledConversation } from '../../../src/renderer/src/watcher/watcherConversationWork'
import type { AgentMessage } from '../../../src/shared/agents'
import type { WatcherOperation, WatcherRequest } from '../../../src/shared/watcher'
import type { WatcherRoomState, WatcherTakeover } from '../../../src/shared/watcherRoom'

// Watcher's archive (#1759): the window indexes what its conversation shown back recalled once, for the room's `recalled`
// object, and a change of the record's own lists joins over those lists alone, however much was read back.
const at = '2026-10-20T12:00:00.000Z'
const watcher = { hostId: '11111111-1111-4111-8111-111111111111', threadId: 'master' }
const operation = (requestId: string, index: number): WatcherOperation => ({ id: randomUUID(), requestId, retryKey: randomUUID(), digest: 'a'.repeat(64), action: 'send',
  target: { hostId: watcher.hostId, threadId: `worker-${index}` }, generation: 0, deliveryState: 'accepted', createdAt: at, updatedAt: at, receiptId: `receipt-${index}`, cardId: `card-${index}` })

/** Reads of what was read back while the window joins a changed record `changes` times, after indexing it once. */
function readsPerLiveChange(recalledCount: number, changes: number): number {
  let reads = 0, counting = false
  const counted = <T extends object>(value: T): T => new Proxy(value, { get(target, property, receiver) { if (counting) reads++; return Reflect.get(target, property, receiver) } })
  const requests: WatcherRequest[] = [], receipts: WatcherOperation[] = [], replies: { operationId: string; messageId: string }[] = []
  for (let index = 0; index < recalledCount; index++) {
    const id = randomUUID(), receipt = operation(id, index)
    requests.push(counted({ id, watcher, rootUserMessageId: `archived-${index}`, state: 'closed', createdAt: at, closedAt: at,
      participants: [{ target: receipt.target, requestId: id, startedBy: 'watcher', generation: 0, state: 'taken-over', promptCount: 1, takeover: { reason: 'user-send', at } }] }))
    receipts.push(counted(receipt))
    replies.push(counted({ operationId: receipt.id, messageId: `archived-${index}` }))
  }
  const recalled: NonNullable<WatcherRoomState['recalled']> = counted({ receipts: counted(receipts), receiptReplies: counted(replies), requests: counted(requests) })
  const index = recalledConversation(recalled, watcher)!
  expect(index.takeovers).toHaveLength(recalledCount)
  const liveRequest = randomUUID()
  counting = true
  for (let change = 0; change < changes; change++) {
    // A change of the record: a new list of its own receipts, placed under its own message.
    const live = [operation(liveRequest, -1 - change)]
    const own = liveReceipts(live, live.map(item => ({ operationId: item.id, messageId: 'live-message' })))
    const again = recalledConversation(recalled, watcher)!
    const joined = joinedReceipts(own.byMessage, own.operations, again)
    expect(joined.get('live-message')).toHaveLength(1)
    expect(joined.get('archived-0')).toHaveLength(1)
    expect(joinedTakeovers(new Map(), new Map([['archived-0', [again.takeovers[0]!]]])).get('archived-0')).toHaveLength(1)
    expect(joinedPlacements(new Map(), again).get(live[0]!.id)).toBeUndefined()
  }
  return reads
}

describe('the window joins what was read back with the record (#1759)', () => {
  it('reads as much of what was read back for a change of the record at 50 archived actions as at 2,000', () => {
    const few = readsPerLiveChange(50, 5), many = readsPerLiveChange(2_000, 5)
    expect(many).toBe(few)
  })

  it('shows a card the record holds too once, as the record holds it', () => {
    const shared = operation(randomUUID(), 1), older = { ...shared, deliveryState: 'queued' as const }
    const recalled = recalledConversation({ receipts: [older], receiptReplies: [{ operationId: shared.id, messageId: 'message' }], requests: [] }, watcher)
    const own = liveReceipts([shared], [{ operationId: shared.id, messageId: 'message' }])
    expect(joinedReceipts(own.byMessage, own.operations, recalled).get('message')).toEqual([shared])
  })
})

const minutes = (count: number): string => new Date(Date.parse(at) + count * 60_000).toISOString()
const line = (index: number, time: string): WatcherTakeover => ({ target: { hostId: watcher.hostId, threadId: `worker-${index}` }, at: time })
/** What the read back brought, as `recalledConversation` indexes it, with its takeover lines as given. */
const recalledLines = (takeovers: readonly WatcherTakeover[]): RecalledConversation => ({ receipts: new Map(), operations: new Set(), placements: new Map(), takeovers })

/**
 * Reads of the messages and of the read back's takeover lines while Watcher's conversation goes on `changes` times, after
 * the read back placed its lines once: `turns` turns read back, each with a thread taken over in it, then the live turn.
 * Each change streams the newest reply or begins a turn, as a conversation does while it is shown far back (#1773).
 */
function readsPerChange(turns: number, changes: number, newestLine = false): number {
  let reads = 0, counting = false
  const counted = <T extends object>(value: T): T => new Proxy(value, { get(target, property, receiver) { if (counting) reads++; return Reflect.get(target, property, receiver) } })
  const held: AgentMessage[] = [], lines: WatcherTakeover[] = []
  for (let turn = 0; turn < turns; turn++) {
    held.push({ id: `archived-${turn}`, role: 'user', text: 'Synthetic instruction', createdAt: minutes(turn * 10) },
      { id: `archived-reply-${turn}`, role: 'assistant', text: 'Synthetic reply', createdAt: minutes(turn * 10 + 1) })
    lines.push(counted(line(turn, minutes(turn * 10 + 5))))
  }
  held.push({ id: 'live', role: 'user', text: 'Synthetic instruction', createdAt: minutes(turns * 10) }, { id: 'live-reply', role: 'assistant', text: '', createdAt: minutes(turns * 10 + 1) })
  const archivedLast = lines.at(-1)
  // A thread the read back says was taken over in the turn still being written, which the next turn settles (#1773).
  if (newestLine) lines.push(counted(line(turns, new Date(Date.parse(minutes(turns * 10)) + 30_000).toISOString())))
  const recalled = recalledLines(counted(lines))
  expect(recalledTakeovers(counted([...held]), recalled)!.get('archived-reply-0')).toEqual([lines[0]])
  for (let change = 0; change < changes; change++) {
    const newest = held.at(-1)!
    if (change % 2 === 0) held[held.length - 1] = { ...newest, text: `${newest.text}Synthetic words ` }
    else held.push({ id: `live-${change}`, role: 'user', text: 'Synthetic instruction', createdAt: minutes(turns * 10 + change) },
      { id: `live-reply-${change}`, role: 'assistant', text: '', createdAt: minutes(turns * 10 + change) })
    const messages = counted([...held])
    counting = true
    const placed = recalledTakeovers(messages, recalled)
    counting = false
    expect(placed!.get(`archived-reply-${turns - 1}`)).toEqual([archivedLast])
  }
  return reads
}

describe('the read back\'s takeover lines in Watcher\'s conversation (#1773)', () => {
  it('are placed once for the read back: a streamed reply or a new turn reads as much at 2,000 turns read back as at 50', () => {
    const few = readsPerChange(50, 6), many = readsPerChange(2_000, 6)
    expect(many).toBe(few)
  })

  it('settle the newest turn\'s line when the next turn begins, reading as much at 2,000 turns read back as at 50', () => {
    const few = readsPerChange(50, 6, true), many = readsPerChange(2_000, 6, true)
    expect(many).toBe(few)
  })

  it('go where placeTakeovers puts them, as replies stream, turns begin, the conversation is read further back and clocks disagree', () => {
    let seed = 1773
    const random = (): number => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647
    let made = 0
    const message = (role: AgentMessage['role'], time: number): AgentMessage =>
      ({ id: `message-${made++}`, role, text: role !== 'assistant' || random() < 0.7 ? 'Synthetic words' : '', createdAt: minutes(time) })
    const role = (): AgentMessage['role'] => random() < 0.35 ? 'user' : 'assistant'
    for (let round = 0; round < 60; round++) {
      let clock = 1_000, messages: AgentMessage[] = Array.from({ length: Math.floor(random() * 12) }, () => message(role(), clock += Math.floor(random() * 4)))
      // Lines from before the conversation to past its end, oldest first, as the read back gives them.
      const lines = Array.from({ length: 1 + Math.floor(random() * 10) }, (_, index) => line(index, minutes(990 + Math.floor(random() * (clock - 960)))))
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      const recalled = recalledLines(lines)
      const check = (): void => {
        const expected = placeTakeovers(messages, lines), placed = recalledTakeovers(messages, recalled)!
        for (const item of messages) expect(placed.get(item.id) ?? []).toEqual(expected.get(item.id) ?? [])
      }
      check()
      for (let step = 0; step < 12; step++) {
        const pick = random(), newest = messages.at(-1)
        if (pick < 0.35 && newest) messages = [...messages.slice(0, -1), { ...newest, text: `${newest.text}Synthetic words` }]
        else if (pick < 0.75) messages = [...messages, message(role(), clock += Math.floor(random() * 4))]
        // A user message whose clock is behind the lines already placed.
        else if (pick < 0.85) messages = [...messages, message('user', 990 + Math.floor(random() * (clock - 990)))]
        // Read further back: older messages ahead of the ones held.
        else messages = [message('user', 900), message('assistant', 901), ...messages]
        check()
      }
    }
  })
})
