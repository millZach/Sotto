// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import { WatcherService } from '../../../src/main/agents/watcher'
import type { WatcherArchived } from '../../../src/main/agents/watcherArchive'
import type { WorkspaceHost } from '../../../src/main/agents/workspace'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { emptyWatcherRecord, type WatcherOperation, type WatcherPromptTurn, type WatcherRecord, type WatcherRequest } from '../../../src/shared/watcher'
import { watcherRoomWork } from '../../../src/shared/watcherRoom'

// Watcher's archive (#1759): the archived work a conversation shown far back brings to the room is placed once, when it is
// read back, and kept apart from the record's own lists, so neither a room build nor a change of the record reads or copies
// any of it again, however much was read back; and a card the record and the archive both hold shows once.
const localId = '11111111-1111-4111-8111-111111111111'
const at = '2026-10-20T12:00:00.000Z'
const watcher = { hostId: localId, threadId: 'master' }

function operation(requestId: string, turn: string, index: number): WatcherOperation {
  return { id: randomUUID(), requestId, retryKey: randomUUID(), digest: 'a'.repeat(64), promptTurnId: turn, action: 'send', target: { hostId: localId, threadId: `worker-${index}` },
    generation: 0, deliveryState: 'accepted', createdAt: at, updatedAt: at, receiptId: `receipt-${index}`, cardId: `card-${index}`, outcome: 'answered', outcomeAt: at }
}

/** A room over a record and `recalledCount` records read back, every read of a recalled record or list counted once on. */
function roomWith(recalledCount: number, overlap = false) {
  let record: WatcherRecord = emptyWatcherRecord()
  record.current = { target: watcher, projectId: 'project', provider: 'codex', creationOperationId: randomUUID(), createdAt: at }
  const liveRequest = randomUUID(), liveTurn = randomUUID()
  record.promptTurns = [{ id: liveTurn, watcher, createdAt: at, rootUserMessageId: 'live-message' }]
  record.requests.push({ id: liveRequest, watcher, rootUserMessageId: 'live-message', state: 'closed', createdAt: at, closedAt: at, participants: [] })
  record.operations.push(operation(liveRequest, liveTurn, -1))
  let reads = 0, counting = false
  const counted = <T extends object>(value: T): T => new Proxy(value, { get(target, property, receiver) { if (counting) reads++; return Reflect.get(target, property, receiver) } })
  const requests: WatcherRequest[] = [], operations: WatcherOperation[] = [], promptTurns: WatcherPromptTurn[] = []
  for (let index = 0; index < recalledCount; index++) {
    const id = randomUUID(), turn = randomUUID()
    requests.push(counted({ id, watcher, rootUserMessageId: `archived-${index}`, state: 'closed', createdAt: at, closedAt: at, participants: [] }))
    promptTurns.push(counted({ id: turn, watcher, createdAt: at, rootUserMessageId: `archived-${index}` }))
    operations.push(counted(operation(id, turn, index)))
  }
  // The record's own operation read back too, as after a crash between the archive's write and the record's save.
  if (overlap) { requests.push(record.requests[0]!); promptTurns.push(record.promptTurns[0]!); operations.push(record.operations[0]!) }
  const recalled: WatcherArchived = { requests: counted(requests), operations: counted(operations), promptTurns: counted(promptTurns) }
  const host = emptyDesktopState(localId).host
  host.threads = [{ id: 'master', kind: 'watcher', projectId: 'project', title: 'Watcher', modelId: 'model', providerId: 'codex', status: 'idle', requests: [],
    messages: [...Array.from({ length: recalledCount }, (_, index) => [
      { id: `archived-${index}`, role: 'user' as const, text: 'Synthetic instruction', createdAt: at },
      { id: `archived-reply-${index}`, role: 'assistant' as const, text: 'Synthetic reply', createdAt: at }]).flat(),
    { id: 'live-message', role: 'user' as const, text: 'Synthetic instruction', createdAt: at }, { id: 'live-reply', role: 'assistant' as const, text: 'Synthetic reply', createdAt: at }] }]
  const control = { watcherRecord: () => structuredClone(record), watcherRecordView: () => record, watcherRecalledWork: () => recalled,
    watcherSnapshot: () => host, hostId: () => localId, hostThreadsOf: () => undefined, useWatcher: () => () => undefined, subscribe: () => () => undefined,
    archivedWatcherWork: () => undefined } as unknown as AgentControl
  const service = new WatcherService({ directory: '', control, host: {} as WorkspaceHost, historyEnabled: () => false, streamingPublishCost: true })
  return { service, recalledCount,
    /** Counts reads of what was read back from here on. */
    count: () => { counting = true; reads = 0 },
    reads: () => reads,
    /** A change of the record, as every Watcher action makes: a new record with a new operation. */
    replaceRecord: () => { record = { ...record, operations: [...record.operations, operation(liveRequest, liveTurn, -2)] } } }
}

/** Reads of the recalled records and lists over `builds` room builds after the first, the record replaced before each. */
function readsPerBuild(recalledCount: number, builds: number): number {
  const room = roomWith(recalledCount)
  try {
    const first = room.service.state()
    expect(watcherRoomWork(first).receipts).toHaveLength(recalledCount + 1)
    expect(watcherRoomWork(first).receiptReplies).toHaveLength(recalledCount + 1)
    room.count()
    for (let build = 0; build < builds; build++) { room.service.state(); room.replaceRecord(); room.service.state() }
    return room.reads()
  } finally { room.service.close() }
}

describe('the room with archived work read back (#1759)', () => {
  it('reads and copies none of what was read back on a room build or a change of the record, however much was read back', () => {
    const few = readsPerBuild(50, 5), many = readsPerBuild(2_000, 5)
    expect({ few, many }).toEqual({ few: 0, many: 0 })
  })

  it('shows a card the record and the archive both hold once, as the record holds it', () => {
    const room = roomWith(3, true)
    try {
      const state = room.service.state(), work = watcherRoomWork(state)
      const own = state.receipts[0]!
      expect(work.receipts.filter(item => item.id === own.id)).toEqual([own])
      expect(work.receiptReplies.filter(item => item.operationId === own.id)).toHaveLength(1)
      expect(work.requests.filter(item => item.id === own.requestId)).toHaveLength(1)
      expect(new Set(work.receiptReplies.map(item => item.operationId)).size).toBe(work.receiptReplies.length)
    } finally { room.service.close() }
  })
})
