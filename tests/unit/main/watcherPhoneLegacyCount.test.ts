// @vitest-environment node
/**
 * Host protocol version 1's phone page still carries a starts count and a limit (#1183). An iPhone from before Watcher
 * management draws them as a meter and says "Watcher starts nothing new" once the count reaches the limit, which is no
 * longer true at any count.
 */
import { expect, it } from 'vitest'
import { WatcherPhoneService } from '../../../src/main/agents/watcherPhone'
import type { AgentControl } from '../../../src/main/agents/control'
import type { WatcherService } from '../../../src/main/agents/watcher'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { WATCHER_PHONE_LEGACY_LIMIT } from '../../../src/shared/watcherPhone'
import type { WatcherRoomState } from '../../../src/shared/watcherRoom'

const HOST = '11111111-1111-4111-8111-111111111111'
const AT = '2026-10-20T10:00:00.000Z'
const room: WatcherRoomState = { current: { target: { hostId: HOST, threadId: 'watcher' }, projectId: 'project', provider: 'codex', creationOperationId: '33333333-3333-4333-8333-333333333333', createdAt: AT },
  currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, status: 'idle', connected: true }, history: [], requests: [], watchedThreads: [], receipts: [], recoveryNotice: null, observedAt: AT }

function page(starts: number) {
  const service = new WatcherPhoneService({ hostId: () => HOST, threadDetail: () => null, watcherSendRecords: () => ({ deliveries: [], followups: [] }) } as unknown as AgentControl,
    { state: () => room, phoneSnapshot: () => emptyDesktopState(HOST).host, startsInFlight: () => starts } as unknown as WatcherService)
  return service.state(false)
}

it.each([0, 3, 7])('sends the true count of %i, below the limit an older iPhone reads', starts => {
  expect(page(starts)).toMatchObject({ inFlight: starts, inFlightLimit: WATCHER_PHONE_LEGACY_LIMIT, working: starts > 0 })
})

it.each([8, 9, 25])('never tells an older iPhone that Watcher starts nothing new, with %i starts working', starts => {
  const state = page(starts)
  // The old meter's room line reads "Watcher starts nothing new" when the limit minus the count is zero or less.
  expect(state.inFlightLimit - state.inFlight).toBeGreaterThan(0)
  expect(state).toMatchObject({ inFlight: WATCHER_PHONE_LEGACY_LIMIT - 1, working: true })
})
