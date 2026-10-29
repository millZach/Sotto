// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { WatcherPhoneService } from '../../../src/main/agents/watcherPhone'
import type { AgentControl } from '../../../src/main/agents/control'
import type { WatcherService } from '../../../src/main/agents/watcher'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { watcherPhoneStateSchema } from '../../../src/shared/watcherPhone'
import type { WatcherRoomState } from '../../../src/shared/watcherRoom'

const HOST = '11111111-1111-4111-8111-111111111111'
const REQUEST = '22222222-2222-4222-8222-222222222222'
const AT = '2026-10-16T10:00:00.000Z'
const watcher = { hostId: HOST, threadId: 'watcher' }

it('carries the takeover lines to the phone, as protocol version 1 adds them, with each thread’s title', () => {
  const taken = { requestId: REQUEST, startedBy: 'watcher' as const, generation: 1, state: 'taken-over' as const, target: { hostId: HOST, threadId: 'auth' },
    promptCount: 1, takeover: { reason: 'user-send' as const, at: AT } }
  const room: WatcherRoomState = { current: { target: watcher, projectId: 'project', provider: 'codex', creationOperationId: '33333333-3333-4333-8333-333333333333', createdAt: AT },
    currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, status: 'idle', connected: true }, history: [],
    requests: [{ id: REQUEST, watcher, rootUserMessageId: 'u1', state: 'active', createdAt: AT, closedAt: null, participants: [taken] }],
    watchedThreads: [], receipts: [], recoveryNotice: null, observedAt: AT }
  const snapshot = { ...emptyDesktopState(HOST).host, threads: [{ id: 'auth', projectId: 'project', title: 'Auth refactor', modelId: 'codex:gpt', status: 'idle' as const, messages: [], requests: [] }] }
  const service = new WatcherPhoneService({ hostId: () => HOST, threadDetail: () => null, watcherSendRecords: () => ({ deliveries: [], followups: [] }) } as unknown as AgentControl,
    { state: () => room, phoneSnapshot: () => snapshot, startsInFlight: () => 0 } as unknown as WatcherService)
  const state = service.state(false)
  expect(state.takeovers).toEqual([{ target: { hostId: HOST, threadId: 'auth' }, title: 'Auth refactor', at: AT }])
  // An older phone reads the same page without the field.
  const { takeovers: _lines, ...older } = state
  void _lines
  expect(watcherPhoneStateSchema.parse(older)).toEqual(older)
})

it('carries the newest five hundred takeover lines, as it carries receipts, and titles them without a search per line', () => {
  const lines = Array.from({ length: 600 }, (_, index) => ({ requestId: REQUEST, startedBy: 'watcher' as const, generation: 1, state: 'taken-over' as const,
    target: { hostId: HOST, threadId: `worker-${index}` }, promptCount: 1, takeover: { reason: 'user-send' as const, at: new Date(Date.parse(AT) + index * 1_000).toISOString() } }))
  const room: WatcherRoomState = { current: { target: watcher, projectId: 'project', provider: 'codex', creationOperationId: '33333333-3333-4333-8333-333333333333', createdAt: AT },
    currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, status: 'idle', connected: true }, history: [],
    requests: [{ id: REQUEST, watcher, rootUserMessageId: 'u1', state: 'active', createdAt: AT, closedAt: null, participants: lines }],
    watchedThreads: [], receipts: [], recoveryNotice: null, observedAt: AT }
  const threads = lines.map(line => ({ id: line.target.threadId, projectId: 'project', title: `Task ${line.target.threadId}`, modelId: 'codex:gpt', status: 'idle' as const, messages: [], requests: [] }))
  const snapshot = { ...emptyDesktopState(HOST).host, threads }
  const service = new WatcherPhoneService({ hostId: () => HOST, threadDetail: () => null, watcherSendRecords: () => ({ deliveries: [], followups: [] }) } as unknown as AgentControl,
    { state: () => room, phoneSnapshot: () => snapshot, startsInFlight: () => 0 } as unknown as WatcherService)
  const find = vi.spyOn(threads, 'find')
  const state = service.state(false)
  expect(state.takeovers).toHaveLength(500)
  expect(state.takeovers?.[0]).toMatchObject({ target: { threadId: 'worker-100' }, title: 'Task worker-100' })
  expect(state.takeovers?.at(-1)).toMatchObject({ target: { threadId: 'worker-599' }, title: 'Task worker-599' })
  // The page's other parts find their few threads; the lines do not search once each.
  expect(find.mock.calls.length).toBeLessThan(10)
})

it('carries what Watcher’s conversation shown back recalled from its archive: its receipt cards and takeover lines (#1759)', () => {
  const taken = { requestId: REQUEST, startedBy: 'watcher' as const, generation: 1, state: 'taken-over' as const, target: { hostId: HOST, threadId: 'auth' },
    promptCount: 1, takeover: { reason: 'user-send' as const, at: AT } }
  const archivedRequest = { id: REQUEST, watcher, rootUserMessageId: 'u1', state: 'closed' as const, createdAt: AT, closedAt: AT, participants: [taken] }
  const receipt = { id: '44444444-4444-4444-8444-444444444444', requestId: REQUEST, retryKey: '55555555-5555-4555-8555-555555555555', digest: 'a'.repeat(64),
    action: 'send' as const, target: { hostId: HOST, threadId: 'auth' }, generation: 1, deliveryState: 'accepted' as const, createdAt: AT, updatedAt: AT, receiptId: 'receipt', cardId: 'card' }
  const room: WatcherRoomState = { current: { target: watcher, projectId: 'project', provider: 'codex', creationOperationId: '33333333-3333-4333-8333-333333333333', createdAt: AT },
    currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, status: 'idle', connected: true }, history: [], requests: [], watchedThreads: [], receipts: [],
    recalled: { receipts: [receipt], receiptReplies: [], requests: [archivedRequest] }, recoveryNotice: null, observedAt: AT }
  const snapshot = { ...emptyDesktopState(HOST).host, threads: [{ id: 'auth', projectId: 'project', title: 'Auth refactor', modelId: 'codex:gpt', status: 'idle' as const, messages: [], requests: [] }] }
  const service = new WatcherPhoneService({ hostId: () => HOST, threadDetail: () => null, watcherSendRecords: () => ({ deliveries: [], followups: [] }) } as unknown as AgentControl,
    { state: () => room, phoneSnapshot: () => snapshot, startsInFlight: () => 0 } as unknown as WatcherService)
  const state = service.state(false)
  expect(state.takeovers).toEqual([{ target: { hostId: HOST, threadId: 'auth' }, title: 'Auth refactor', at: AT }])
  expect(state.receiptGroups).toMatchObject([{ requestId: REQUEST, rows: [{ operationId: receipt.id, title: 'Auth refactor' }] }])
  // The same card and line the room carries too go once, the room's.
  const both: WatcherRoomState = { ...room, receipts: [receipt], requests: [{ ...archivedRequest, state: 'active', closedAt: null }] }
  const twice = new WatcherPhoneService({ hostId: () => HOST, threadDetail: () => null, watcherSendRecords: () => ({ deliveries: [], followups: [] }) } as unknown as AgentControl,
    { state: () => both, phoneSnapshot: () => snapshot, startsInFlight: () => 0 } as unknown as WatcherService).state(false)
  expect(twice.takeovers).toHaveLength(1)
  expect(twice.receiptGroups.flatMap(group => group.rows)).toHaveLength(1)
})

it('carries the newest five hundred recalled receipts, though a read back gives its batches newest first (#1759)', () => {
  const request = { id: REQUEST, watcher, rootUserMessageId: 'u1', state: 'closed' as const, createdAt: AT, closedAt: AT, participants: [] }
  const actions = Array.from({ length: 600 }, (_, index) => ({ id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`, requestId: REQUEST,
    retryKey: '55555555-5555-4555-8555-555555555555', digest: 'a'.repeat(64), action: 'send' as const, target: { hostId: HOST, threadId: `worker-${index}` }, generation: 1,
    deliveryState: 'accepted' as const, createdAt: new Date(Date.parse(AT) + index * 1_000).toISOString(), updatedAt: AT, receiptId: `receipt-${index}`, cardId: `card-${index}` }))
  // Six batches of a hundred, each oldest first within itself, the newest batch first.
  const receipts = [5, 4, 3, 2, 1, 0].flatMap(batch => actions.slice(batch * 100, batch * 100 + 100))
  const room: WatcherRoomState = { current: { target: watcher, projectId: 'project', provider: 'codex', creationOperationId: '33333333-3333-4333-8333-333333333333', createdAt: AT },
    currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, status: 'idle', connected: true }, history: [], requests: [], watchedThreads: [], receipts: [],
    recalled: { receipts, receiptReplies: [], requests: [request] }, recoveryNotice: null, observedAt: AT }
  const service = new WatcherPhoneService({ hostId: () => HOST, threadDetail: () => null, watcherSendRecords: () => ({ deliveries: [], followups: [] }) } as unknown as AgentControl,
    { state: () => room, phoneSnapshot: () => emptyDesktopState(HOST).host, startsInFlight: () => 0 } as unknown as WatcherService)
  const shown = service.state(false).receiptGroups.flatMap(group => group.rows.map(row => row.operationId))
  expect(shown).toHaveLength(500)
  expect(new Set(shown)).toEqual(new Set(actions.slice(100).map(item => item.id)))
})

it('gives a new Watcher none of the last one’s recalled takeover lines, though the read back is the same (#1759)', () => {
  const taken = { requestId: REQUEST, startedBy: 'watcher' as const, generation: 1, state: 'taken-over' as const, target: { hostId: HOST, threadId: 'auth' },
    promptCount: 1, takeover: { reason: 'user-send' as const, at: AT } }
  const recalled = { receipts: [], receiptReplies: [], requests: [{ id: REQUEST, watcher, rootUserMessageId: 'u1', state: 'closed' as const, createdAt: AT, closedAt: AT, participants: [taken] }] }
  const identity = (threadId: string) => ({ target: { hostId: HOST, threadId }, projectId: 'project', provider: 'codex' as const, creationOperationId: '33333333-3333-4333-8333-333333333333', createdAt: AT })
  let room: WatcherRoomState = { current: identity('watcher'), currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, status: 'idle', connected: true }, history: [],
    requests: [], watchedThreads: [], receipts: [], recalled, recoveryNotice: null, observedAt: AT }
  const snapshot = { ...emptyDesktopState(HOST).host, threads: [{ id: 'auth', projectId: 'project', title: 'Auth refactor', modelId: 'codex:gpt', status: 'idle' as const, messages: [], requests: [] }] }
  const service = new WatcherPhoneService({ hostId: () => HOST, threadDetail: () => null, watcherSendRecords: () => ({ deliveries: [], followups: [] }) } as unknown as AgentControl,
    { state: () => room, phoneSnapshot: () => snapshot, startsInFlight: () => 0 } as unknown as WatcherService)
  expect(service.state(false).takeovers).toHaveLength(1)
  room = { ...room, current: identity('new-watcher') }
  expect(service.state(false).takeovers ?? []).toHaveLength(0)
})
