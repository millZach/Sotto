// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../../src/main/agents/watcher'
import type { AgentControl } from '../../../src/main/agents/control'
import type { WorkspaceHost } from '../../../src/main/agents/workspace'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { emptyWatcherRecord, watcherRecordSchema, type WatcherRecord } from '../../../src/shared/watcher'
import { watcherTakeovers } from '../../../src/shared/watcherRoom'

const HOST = '11111111-1111-4111-8111-111111111111'
const AT = '2026-10-16T10:00:00.000Z'
const watcher = { hostId: HOST, threadId: 'watcher' }
const worker = { hostId: HOST, threadId: 'worker' }
afterEach(() => { vi.restoreAllMocks() })

it('gives one send that ends several requests’ work on a thread one takeover time, so it is one line', () => {
  let record: WatcherRecord = emptyWatcherRecord()
  record.current = { target: watcher, projectId: 'project', provider: 'codex', creationOperationId: '22222222-2222-4222-8222-222222222222', createdAt: AT }
  // Watcher drove the worker for two of the user's requests.
  record.requests = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'].map((id, index) => ({ id, watcher, rootUserMessageId: `u${index}`,
    state: 'active' as const, createdAt: AT, closedAt: null, participants: [{ requestId: id, startedBy: 'watcher' as const, generation: 0, state: 'participating' as const, target: worker, promptCount: 1 }] }))
  const update = (change: (next: WatcherRecord) => void): void => { const next = structuredClone(record); change(next); record = watcherRecordSchema.parse(next) }
  const control = {
    watcherRecord: () => structuredClone(record), watcherRecordView: () => record, hostId: () => HOST,
    watcherSnapshot: () => ({ ...emptyDesktopState(HOST).host, threads: [] }), useWatcher: () => () => undefined, subscribe: () => () => undefined,
    mutateWatcher: update, updateWatcher: async (change: (next: WatcherRecord) => void) => update(change), cancelWatcherQueue: async () => undefined,
    refreshWatcherObservation: () => undefined, watcherSendRecords: () => ({ deliveries: [], followups: [] }),
  } as unknown as AgentControl
  const service = new WatcherService({ directory: '', control, host: {} as WorkspaceHost, limit: () => 4, historyEnabled: () => false })
  try {
    // The clock ticks between every read of it.
    let tick = 0
    vi.spyOn(Date.prototype, 'toISOString').mockImplementation(() => `2026-10-16T10:05:${String(tick++).padStart(2, '0')}.000Z`)
    ;(service as unknown as { takeover(threadId: string, reason: 'user-send'): void }).takeover('worker', 'user-send')
    vi.restoreAllMocks()
    const times = record.requests.map(request => request.participants[0]!.takeover?.at)
    expect(times[0]).toBeDefined()
    expect(times[1]).toBe(times[0])
    expect(watcherTakeovers({ current: record.current, requests: record.requests })).toHaveLength(1)
  } finally { service.close() }
})
