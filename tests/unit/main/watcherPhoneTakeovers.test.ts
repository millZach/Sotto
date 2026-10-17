// @vitest-environment node
import { expect, it } from 'vitest'
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
    watchedThreads: [], inFlight: 0, inFlightLimit: 4, receipts: [], recoveryNotice: null, observedAt: AT }
  const snapshot = { ...emptyDesktopState(HOST).host, threads: [{ id: 'auth', projectId: 'project', title: 'Auth refactor', modelId: 'codex:gpt', status: 'idle' as const, messages: [], requests: [] }] }
  const service = new WatcherPhoneService({ hostId: () => HOST, threadDetail: () => null, watcherSendRecords: () => ({ deliveries: [], followups: [] }) } as unknown as AgentControl,
    { state: () => room, phoneSnapshot: () => snapshot } as unknown as WatcherService)
  const state = service.state(false)
  expect(state.takeovers).toEqual([{ target: { hostId: HOST, threadId: 'auth' }, title: 'Auth refactor', at: AT }])
  // An older phone reads the same page without the field.
  const { takeovers: _lines, ...older } = state
  void _lines
  expect(watcherPhoneStateSchema.parse(older)).toEqual(older)
})
