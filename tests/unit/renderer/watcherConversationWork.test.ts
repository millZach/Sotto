// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { joinedPlacements, joinedReceipts, joinedTakeovers, liveReceipts, recalledConversation } from '../../../src/renderer/src/watcher/watcherConversationWork'
import type { WatcherOperation, WatcherRequest } from '../../../src/shared/watcher'
import type { WatcherRoomState } from '../../../src/shared/watcherRoom'

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
