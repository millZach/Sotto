// @vitest-environment node
/**
 * What the phone's page says of Watcher's work. Host protocol version 1's page still carries a starts count and a limit
 * (#1183): an iPhone from before Watcher management draws them as a meter and says "Watcher starts nothing new" once the
 * count reaches the limit, which is no longer true at any count. And Watcher working is its own turn, a turn on news of
 * a watched thread included, as the desktop shows it (#1436): counting the threads it started kept the iPhone's pill,
 * tab dot and "Watcher is working" line on while Watcher was idle and a few of its workers ran for hours.
 */
import { expect, it, vi } from 'vitest'
import { WatcherPhoneService } from '../../../src/main/agents/watcherPhone'
import type { AgentControl } from '../../../src/main/agents/control'
import type { WatcherService } from '../../../src/main/agents/watcher'
import type { AgentSpeed } from '../../../src/shared/agents'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { WATCHER_PHONE_LEGACY_LIMIT, watcherPhoneStateSchema } from '../../../src/shared/watcherPhone'
import type { WatcherRoomState } from '../../../src/shared/watcherRoom'
import type { AgentCommand } from '../../../src/shared/agents'

const HOST = '11111111-1111-4111-8111-111111111111'
const AT = '2026-10-20T10:00:00.000Z'

/** The page for Watcher's own thread in `status`, with `starts` threads it started still working, as the newest phone sees it. */
function page(starts: number, status: 'idle' | 'running' | 'error' = 'idle', speed?: AgentSpeed | null) {
  const room: WatcherRoomState = { current: { target: { hostId: HOST, threadId: 'watcher' }, projectId: 'project', provider: 'codex', creationOperationId: '33333333-3333-4333-8333-333333333333', createdAt: AT },
    currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, runtimeMode: 'auto', status, connected: true, ...(speed !== undefined ? { speed } : {}) }, history: [], requests: [], watchedThreads: [], receipts: [], recoveryNotice: null, observedAt: AT }
  const service = new WatcherPhoneService({ hostId: () => HOST, threadDetail: () => null, watcherSendRecords: () => ({ deliveries: [], followups: [] }),
    watcherPhoneTurn: () => ({ steers: false, running: status === 'running' }), watcherFollowups: () => [] } as unknown as AgentControl,
    { state: () => room, phoneSnapshot: () => emptyDesktopState(HOST).host, startsInFlight: () => starts } as unknown as WatcherService)
  return service.state(false, true, true)
}

// The page names Watcher's speed for Watcher's box (watcher-phone-composer, October 31, 2026), Standard as null, and
// nothing else of the desktop's options: a spread of them once broke every phone hello.
it.each(['fast', 'ultrafast', null] as const)('projects only the phone contract when desktop speed is %s', speed => {
  const state = watcherPhoneStateSchema.parse(page(0, 'idle', speed))
  expect(state.current).toEqual({ target: { hostId: HOST, threadId: 'watcher' }, provider: 'codex', modelId: 'codex:gpt',
    reasoningEffort: null, runtimeMode: 'auto', status: 'idle', connected: true, steers: false, speed })
})

it('says Standard as null when the desktop names no speed', () => {
  expect(watcherPhoneStateSchema.parse(page(0)).current?.speed).toBeNull()
})

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

it.each([['question', true], ['permission', true], ['question', false], ['permission', false]] as const)(
  'queues a phone message behind a %s card with running=%s without steering or answering it', async (kind, running) => {
  const target = { hostId: HOST, threadId: 'watcher' }
  const requests = [{ id: 'card', kind, text: 'Waiting for you', options: [] }]
  const command = vi.fn(async (_command: AgentCommand, origin: { guard: () => void }) => {
    origin.guard()
    return { error: null }
  })
  const service = new WatcherPhoneService({ hostId: () => HOST,
    watcherSnapshot: () => ({ threads: [{ id: 'watcher', requests }] }),
    watcherPhoneTurn: () => ({ running, steers: true }), commandFromWatcherPhone: command } as unknown as AgentControl,
  { state: () => ({ current: { target } }), isCurrent: () => true, guardPhoneSend: vi.fn() } as unknown as WatcherService)
  vi.spyOn(service, 'state').mockReturnValue(page(0))
  const draftId = '44444444-4444-4444-8444-444444444444'
  const origin = { kind: 'phone' as const, hostId: HOST, clientId: 'phone' }
  for (const delivery of [undefined, 'steer'] as const) {
    const result = await service.send({ target, origin, draftId, text: 'Check the footer next', ...(delivery ? { delivery } : {}) },
      { clientId: 'phone', user: 'Phone', transport: 'socket' }, () => {}, () => false, true, delivery !== undefined)
    expect(result.status).toBe('ok')
    expect(command.mock.lastCall?.[0]).toEqual({ type: 'queue-followup', threadId: 'watcher', draftId, text: 'Check the footer next' })
  }
  expect(command).toHaveBeenCalledTimes(2)
  expect(requests).toEqual([{ id: 'card', kind, text: 'Waiting for you', options: [] }])
})
