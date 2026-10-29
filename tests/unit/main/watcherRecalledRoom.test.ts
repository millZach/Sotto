// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import { WatcherService } from '../../../src/main/agents/watcher'
import type { WatcherArchived } from '../../../src/main/agents/watcherArchive'
import type { WorkspaceHost } from '../../../src/main/agents/workspace'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { emptyWatcherRecord, type WatcherOperation, type WatcherPromptTurn, type WatcherRequest } from '../../../src/shared/watcher'

// Watcher's archive (#1759): the archived work a conversation shown far back brings to the room is placed once, when it is
// read back, never on each room build, so a room built again costs the same however much was read back.
const localId = '11111111-1111-4111-8111-111111111111'
const at = '2026-10-20T12:00:00.000Z'

/** Builds the room `builds` times after its first, and counts every read of a recalled record over those builds. */
function readsPerBuild(recalledCount: number, builds: number): number {
  const record = emptyWatcherRecord()
  const watcher = { hostId: localId, threadId: 'master' }
  record.current = { target: watcher, projectId: 'project', provider: 'codex', creationOperationId: randomUUID(), createdAt: at }
  record.promptTurns = [{ id: randomUUID(), watcher, createdAt: at, rootUserMessageId: 'live-message' }]
  let reads = 0, counting = false
  const counted = <T extends object>(value: T): T => new Proxy(value, { get(target, property, receiver) { if (counting) reads++; return Reflect.get(target, property, receiver) } })
  const requests: WatcherRequest[] = [], operations: WatcherOperation[] = [], promptTurns: WatcherPromptTurn[] = []
  for (let index = 0; index < recalledCount; index++) {
    const id = randomUUID(), turn = randomUUID(), target = { hostId: localId, threadId: `worker-${index}` }
    requests.push(counted({ id, watcher, rootUserMessageId: `archived-${index}`, state: 'closed', createdAt: at, closedAt: at, participants: [] }))
    promptTurns.push(counted({ id: turn, watcher, createdAt: at, rootUserMessageId: `archived-${index}` }))
    operations.push(counted({ id: randomUUID(), requestId: id, retryKey: randomUUID(), digest: 'a'.repeat(64), promptTurnId: turn, action: 'send', target, generation: 0,
      deliveryState: 'accepted', createdAt: at, updatedAt: at, receiptId: `receipt-${index}`, cardId: `card-${index}`, outcome: 'answered', outcomeAt: at }))
  }
  const recalled: WatcherArchived = { requests, operations, promptTurns }
  const host = emptyDesktopState(localId).host
  host.threads = [{ id: 'master', kind: 'watcher', projectId: 'project', title: 'Watcher', modelId: 'model', providerId: 'codex', status: 'idle', requests: [],
    messages: [...Array.from({ length: recalledCount }, (_, index) => [
      { id: `archived-${index}`, role: 'user' as const, text: 'Synthetic instruction', createdAt: at },
      { id: `archived-reply-${index}`, role: 'assistant' as const, text: 'Synthetic reply', createdAt: at }]).flat(),
    { id: 'live-message', role: 'user' as const, text: 'Synthetic instruction', createdAt: at }] }]
  const control = { watcherRecord: () => structuredClone(record), watcherRecordView: () => record, watcherRecalledWork: () => recalled,
    watcherSnapshot: () => host, hostId: () => localId, hostThreadsOf: () => undefined, useWatcher: () => () => undefined, subscribe: () => () => undefined,
    archivedWatcherWork: () => undefined } as unknown as AgentControl
  const service = new WatcherService({ directory: '', control, host: {} as WorkspaceHost, historyEnabled: () => false, streamingPublishCost: true })
  try {
    const first = service.state()
    expect(first.receipts).toHaveLength(recalledCount)
    expect(first.receiptReplies).toHaveLength(recalledCount)
    counting = true
    for (let build = 0; build < builds; build++) service.state()
    return reads
  } finally { service.close() }
}

describe('the room with archived work read back (#1759)', () => {
  it('reads none of the recalled records again on each room build, however many were read back', () => {
    const few = readsPerBuild(50, 5), many = readsPerBuild(2_000, 5)
    expect({ few, many }).toEqual({ few: 0, many: 0 })
  })
})
