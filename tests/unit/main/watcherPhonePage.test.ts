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

it('prunes orphaned receiptGroups outside the 200-message window while keeping in-window and active standing receipts', () => {
  const watcher = { hostId: HOST, threadId: 'watcher' }
  const baseMs = Date.parse('2026-11-20T00:00:00.000Z')
  const iso = (seconds: number): string => new Date(baseMs + seconds * 1_000).toISOString()
  // 260 visible messages (user/assistant pairs), so the 200-message window keeps messages 60..259.
  const allMessages = Array.from({ length: 260 }, (_, index) => ({
    id: `msg-${index}`,
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    text: index % 2 === 0 ? `User instruction ${index}` : `Watcher reply ${index}`,
    createdAt: iso(index * 10),
  }))
  const windowOldestSec = 60 * 10
  // 340 orphaned receipts from closed requests before the 200-message window, plus 20 in-window receipts,
  // plus 1 in-window unattached receipt (root inside window, no reply yet), plus 1 recent active standing receipt,
  // plus 1 stale standing receipt older than the window.
  const makeUuid = (prefix: string, n: number): string => `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
  const requests: WatcherRoomState['requests'][number][] = []
  const receipts: WatcherRoomState['receipts'][number][] = []
  const threads: { id: string; projectId: string; title: string; modelId: string; status: 'idle'; messages: []; requests: [] }[] = []

  for (let i = 0; i < 340; i++) {
    const reqId = makeUuid('10000000', i + 1)
    const opId = makeUuid('20000000', i + 1)
    const workerId = `orphan-worker-${i}`
    const createdAt = iso(i) // strictly before windowOldestSec = 600
    requests.push({ id: reqId, watcher, rootUserMessageId: `old-user-${i}`, state: 'closed', createdAt, closedAt: createdAt, participants: [] })
    receipts.push({
      id: opId, requestId: reqId, retryKey: makeUuid('30000000', i + 1), digest: 'a'.repeat(64),
      action: 'start', target: { hostId: HOST, threadId: workerId }, generation: 1,
      deliveryState: 'accepted', createdAt, updatedAt: createdAt, receiptId: `r-${i}`, cardId: `c-${i}`,
    })
    threads.push({ id: workerId, projectId: 'project', title: `Old worker ${i}`, modelId: 'codex:gpt', status: 'idle', messages: [], requests: [] })
  }

  // 20 in-window requests attached to visible user/assistant pairs (indices 220..258 step 2).
  const expectedInWindowOpIds: string[] = []
  for (let i = 0; i < 20; i++) {
    const userIdx = 220 + i * 2
    const reqId = makeUuid('40000000', i + 1)
    const opId = makeUuid('50000000', i + 1)
    const workerId = `recent-worker-${i}`
    const createdAt = iso(userIdx * 10 + 5)
    requests.push({ id: reqId, watcher, rootUserMessageId: `msg-${userIdx}`, state: 'closed', createdAt, closedAt: createdAt, participants: [] })
    receipts.push({
      id: opId, requestId: reqId, retryKey: makeUuid('60000000', i + 1), digest: 'b'.repeat(64),
      action: 'send', target: { hostId: HOST, threadId: workerId }, generation: 1,
      deliveryState: 'accepted', createdAt, updatedAt: createdAt, receiptId: `rr-${i}`, cardId: `cc-${i}`,
    })
    expectedInWindowOpIds.push(opId)
    threads.push({ id: workerId, projectId: 'project', title: `Recent worker ${i}`, modelId: 'codex:gpt', status: 'idle', messages: [], requests: [] })
  }

  // Recent active standing-watch receipt (synthetic rootUserMessageId, timestamp inside the 200-message window).
  const activeStandingReqId = makeUuid('70000000', 1)
  const activeStandingOpId = makeUuid('80000000', 1)
  requests.push({ id: activeStandingReqId, watcher, rootUserMessageId: `standing:${activeStandingReqId}`, state: 'active', createdAt: iso(windowOldestSec + 100), closedAt: null, participants: [] })
  receipts.push({
    id: activeStandingOpId, requestId: activeStandingReqId, retryKey: makeUuid('90000000', 1), digest: 'c'.repeat(64),
    action: 'send', target: { hostId: HOST, threadId: 'recent-worker-0' }, generation: 1,
    deliveryState: 'accepted', createdAt: iso(windowOldestSec + 100), updatedAt: iso(windowOldestSec + 100), receiptId: 'rs-1', cardId: 'cs-1',
  })
  expectedInWindowOpIds.push(activeStandingOpId)

  // Stale standing-watch receipt older than the 200-message window: must be pruned.
  const staleStandingReqId = makeUuid('70000000', 2)
  const staleStandingOpId = makeUuid('80000000', 2)
  requests.push({ id: staleStandingReqId, watcher, rootUserMessageId: `standing:${staleStandingReqId}`, state: 'active', createdAt: iso(10), closedAt: null, participants: [] })
  receipts.push({
    id: staleStandingOpId, requestId: staleStandingReqId, retryKey: makeUuid('90000000', 2), digest: 'd'.repeat(64),
    action: 'send', target: { hostId: HOST, threadId: 'orphan-worker-0' }, generation: 1,
    deliveryState: 'accepted', createdAt: iso(10), updatedAt: iso(10), receiptId: 'rs-2', cardId: 'cs-2',
  })

  threads.push({ id: 'watcher', projectId: 'project', title: 'Watcher', modelId: 'codex:gpt', status: 'idle', messages: [], requests: [] })
  const room: WatcherRoomState = {
    current: { target: watcher, projectId: 'project', provider: 'codex', creationOperationId: '33333333-3333-4333-8333-333333333333', createdAt: AT },
    currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, runtimeMode: 'auto', status: 'idle', connected: true },
    history: [], requests, watchedThreads: [], receipts, recoveryNotice: null, observedAt: AT,
  }
  const snapshot = { ...emptyDesktopState(HOST).host, threads }
  const makeService = (detailMessages: typeof allMessages | null) => new WatcherPhoneService(
    {
      hostId: () => HOST,
      threadDetail: () => detailMessages === null ? null : { threadId: 'watcher', messages: detailMessages, revision: 1, earlierAvailable: false },
      watcherSendRecords: () => ({ deliveries: [], followups: [] }),
      watcherPhoneTurn: () => ({ steers: false, running: false }),
      watcherFollowups: () => [],
    } as unknown as AgentControl,
    { state: () => room, phoneSnapshot: () => snapshot, startsInFlight: () => 0 } as unknown as WatcherService,
  )

  const unprunedWhenNoDetail = makeService(null).state(false, true, true)
  const prunedWithWindow = makeService(allMessages).state(false, true, true)
  const unprunedBytes = Buffer.byteLength(JSON.stringify(unprunedWhenNoDetail.receiptGroups))
  const prunedBytes = Buffer.byteLength(JSON.stringify(prunedWithWindow.receiptGroups))

  expect(unprunedWhenNoDetail.receiptGroups).toHaveLength(362)
  expect(prunedWithWindow.receiptGroups).toHaveLength(21)
  expect(prunedWithWindow.receiptGroups.flatMap(g => g.rows.map(r => r.operationId))).toEqual(expectedInWindowOpIds)
  expect(prunedBytes).toBeLessThan(unprunedBytes / 10)
})
