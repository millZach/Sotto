// @vitest-environment node
/**
 * What the phone's page calls Watcher working: its own turn, a turn on news of a watched thread included, as the desktop
 * shows it. Threads Watcher started say their own status under Watched. Counting them kept the iPhone's pill, tab dot and
 * "Watcher is working" line on while Watcher was idle and a few of its workers ran for hours.
 */
import { expect, it } from 'vitest'
import { WatcherPhoneService } from '../../../src/main/agents/watcherPhone'
import type { AgentControl } from '../../../src/main/agents/control'
import type { WatcherService } from '../../../src/main/agents/watcher'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import type { WatcherRoomState } from '../../../src/shared/watcherRoom'

const HOST = '11111111-1111-4111-8111-111111111111'
const AT = '2026-10-23T20:00:00.000Z'

function page(status: 'idle' | 'running' | 'error', starts: number) {
  const room: WatcherRoomState = { current: { target: { hostId: HOST, threadId: 'watcher' }, projectId: 'project', provider: 'claude', creationOperationId: '33333333-3333-4333-8333-333333333333', createdAt: AT },
    currentOptions: { modelId: 'claude:opus', reasoningEffort: null, status, connected: true }, history: [], requests: [], watchedThreads: [], receipts: [], recoveryNotice: null, observedAt: AT }
  const service = new WatcherPhoneService({ hostId: () => HOST, threadDetail: () => null, watcherSendRecords: () => ({ deliveries: [], followups: [] }),
    watcherPhoneTurn: () => ({ steers: false, running: status === 'running' }), watcherFollowups: () => [] } as unknown as AgentControl,
    { state: () => room, phoneSnapshot: () => emptyDesktopState(HOST).host, startsInFlight: () => starts } as unknown as WatcherService)
  // As a phone that negotiated Watcher management and steering, the newest, sees it.
  return service.state(false, true, true)
}

it('says Watcher is idle while threads it started still work', () => {
  expect(page('idle', 4)).toMatchObject({ working: false, inFlight: 4 })
  expect(page('error', 2).working).toBe(false)
})

it('says Watcher works while its own turn runs, a news turn the conversation leaves out included', () => {
  // The phone's conversation never shows Sotto's news, so the turn's only sign is Watcher's own thread running.
  expect(page('running', 0).working).toBe(true)
  expect(page('running', 3).working).toBe(true)
})

it('says Watcher is idle with nothing running', () => {
  expect(page('idle', 0).working).toBe(false)
})
