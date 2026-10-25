// @vitest-environment node
/**
 * What the phone's page says of Watcher's work. Host protocol version 1's page still carries a starts count and a limit
 * (#1183): an iPhone from before Watcher management draws them as a meter and says "Watcher starts nothing new" once the
 * count reaches the limit, which is no longer true at any count. And Watcher working is its own turn, a turn on news of
 * a watched thread included, as the desktop shows it (#1436): counting the threads it started kept the iPhone's pill,
 * tab dot and "Watcher is working" line on while Watcher was idle and a few of its workers ran for hours.
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

/** The page for Watcher's own thread in `status`, with `starts` threads it started still working, as the newest phone sees it. */
function page(starts: number, status: 'idle' | 'running' | 'error' = 'idle') {
  const room: WatcherRoomState = { current: { target: { hostId: HOST, threadId: 'watcher' }, projectId: 'project', provider: 'codex', creationOperationId: '33333333-3333-4333-8333-333333333333', createdAt: AT },
    currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, status, connected: true }, history: [], requests: [], watchedThreads: [], receipts: [], recoveryNotice: null, observedAt: AT }
  const service = new WatcherPhoneService({ hostId: () => HOST, threadDetail: () => null, watcherSendRecords: () => ({ deliveries: [], followups: [] }),
    watcherPhoneTurn: () => ({ steers: false, running: status === 'running' }), watcherFollowups: () => [] } as unknown as AgentControl,
    { state: () => room, phoneSnapshot: () => emptyDesktopState(HOST).host, startsInFlight: () => starts } as unknown as WatcherService)
  return service.state(false, true, true)
}

it.each([0, 3, 7])('sends the true count of %i, below the limit an older iPhone reads', starts => {
  expect(page(starts)).toMatchObject({ inFlight: starts, inFlightLimit: WATCHER_PHONE_LEGACY_LIMIT })
})

it.each([8, 9, 25])('never tells an older iPhone that Watcher starts nothing new, with %i starts working', starts => {
  const state = page(starts)
  // The old meter's room line reads "Watcher starts nothing new" when the limit minus the count is zero or less.
  expect(state.inFlightLimit - state.inFlight).toBeGreaterThan(0)
  expect(state).toMatchObject({ inFlight: WATCHER_PHONE_LEGACY_LIMIT - 1 })
})

it('says Watcher is idle while threads it started still work', () => {
  expect(page(4)).toMatchObject({ working: false, inFlight: 4 })
  expect(page(2, 'error').working).toBe(false)
  expect(page(0).working).toBe(false)
})

it('says Watcher works while its own turn runs, a news turn the conversation leaves out included', () => {
  // The phone's conversation never shows Sotto's news, so the turn's only sign is Watcher's own thread running.
  expect(page(0, 'running').working).toBe(true)
  expect(page(3, 'running').working).toBe(true)
})
