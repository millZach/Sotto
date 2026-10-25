// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { preloadElectron } from '../../fixtures/preloadElectron'
vi.mock('electron', async () => (await import('../../fixtures/preloadElectron')).preloadElectron())
import { createSottoBridge, createSottoWidgetBridge } from '../../../src/preload'
import { WATCHER_CHANGED, WATCHER_GET, WATCHER_OPEN, newerWatcherRoom, WATCHER_SET_PERMISSION, WATCHER_START_NEW, WATCHER_WATCH_THREAD, WATCHER_UNWATCH_THREAD, watcherRoomStateSchema,
  type WatcherRoomState } from '../../../src/shared/watcherRoom'

it('offers the private Watcher bridge only behind the main renderer gate and validates inputs and results', async () => {
  const ipc = preloadElectron().ipcRenderer
  expect(createSottoBridge(ipc, 'win32').watcher).toBeUndefined()
  expect('watcher' in createSottoWidgetBridge(ipc, 'win32')).toBe(false)
  const bridge = createSottoBridge(ipc, 'win32', true).watcher!
  const refused = { status: 'refused', code: 'THREAD_BUSY', message: 'Wait for Watcher.', retryable: true }
  ipc.invoke.mockResolvedValue(refused)
  await expect(bridge.open({ provider: 'codex', modelId: 'model', reasoningEffort: 'low' })).resolves.toEqual(refused)
  expect(ipc.invoke).toHaveBeenLastCalledWith(WATCHER_OPEN, { provider: 'codex', modelId: 'model', reasoningEffort: 'low' })
  // No limit is left to set (#1183).
  expect('setLimit' in bridge).toBe(false)
  await bridge.setPermission!({ runtimeMode: 'full-access' })
  expect(ipc.invoke).toHaveBeenLastCalledWith(WATCHER_SET_PERMISSION, { runtimeMode: 'full-access' })
  expect(() => bridge.setPermission!({ runtimeMode: 'always' as 'full-access' })).toThrow()
  const target = { hostId: randomUUID(), threadId: 'worker' }
  await bridge.watchThread!({ target })
  expect(ipc.invoke).toHaveBeenLastCalledWith(WATCHER_WATCH_THREAD, { target })
  await bridge.unwatchThread!({ target })
  expect(ipc.invoke).toHaveBeenLastCalledWith(WATCHER_UNWATCH_THREAD, { target })
  expect(() => bridge.open({ provider: 'devin', modelId: 'model' } as never)).toThrow()
  // New Watcher sends nothing but its name, and its answer is checked like open's.
  await expect(bridge.startNew!()).resolves.toEqual(refused)
  expect(ipc.invoke).toHaveBeenLastCalledWith(WATCHER_START_NEW)
  expect(() => bridge.stopAll({ confirmationId: randomUUID(), approved: true } as never)).toThrow()
  ipc.invoke.mockResolvedValue({ status: 'ok' })
  await expect(bridge.get()).rejects.toThrow()
})

const without = (room: WatcherRoomState, key: keyof WatcherRoomState) => Object.fromEntries(Object.entries(room).filter(([name]) => name !== key))

it('hands every Watcher room update to the page as main sent it and drops a message that is not a room', () => {
  const ipc = preloadElectron().ipcRenderer
  const bridge = createSottoBridge(ipc, 'win32', true).watcher!
  const listener = vi.fn(), unsubscribe = bridge.onChanged(listener)
  expect(ipc.on).toHaveBeenCalledWith(WATCHER_CHANGED, expect.any(Function))
  const receive = ipc.on.mock.calls.find(call => call[0] === WATCHER_CHANGED)![1] as (event: unknown, ...payload: unknown[]) => void
  const hostId = randomUUID(), at = '2026-10-22T00:00:00.000Z'
  // Main's own room, already what the full schema would give: the window takes it on trust and passes it on whole (#1336).
  const room: WatcherRoomState = { current: null, currentOptions: null, history: [], runtimeMode: 'approval-required', standingWatches: [], ownChanges: [],
    requests: [], watchedThreads: [{ target: { hostId, threadId: 'worker' }, watched: true, paused: false, title: 'Worker', status: 'running',
      connected: true, settled: false, backgroundWorkCount: 0, evidence: [], waitsOn: [{ id: 'card', kind: 'question', openTarget: { hostId, threadId: 'worker' } }],
      participation: [] }], receipts: [], news: [], recoveryNotice: null, observedAt: at, creationStopped: false, handover: null,
    receiptReplies: [], asks: [], context: null, state: { watching: [], kept: { decisions: [{ id: 'd1', text: 'Keep the branch', touchedAt: at }], rules: [], issues: [], updatedAt: at } } }
  expect(watcherRoomStateSchema.parse(room)).toStrictEqual(room)
  receive({}, room)
  expect(listener).toHaveBeenCalledOnce()
  expect(listener.mock.calls[0]![0]).toBe(room)
  // What could not be a room never reaches the page.
  for (const malformed of [null, 'room', 7, [], [room], { ...room, observedAt: undefined }, { ...room, watchedThreads: undefined },
    without(room, 'observedAt'), without(room, 'watchedThreads'), { ...room, observedAt: 1 }]) receive({}, malformed)
  receive({}); receive({}, room, room)
  expect(listener).toHaveBeenCalledOnce()
  unsubscribe(); expect(ipc.removeListener).toHaveBeenCalledWith(WATCHER_CHANGED, expect.any(Function))
})

it('puts main\'s room updates back into the whole room once for every listener, and reads the room when it cannot (#1450)', async () => {
  const ipc = preloadElectron().ipcRenderer
  const bridge = createSottoBridge(ipc, 'win32', true).watcher!
  const first = vi.fn(), second = vi.fn(), offFirst = bridge.onChanged(first), offSecond = bridge.onChanged(second)
  expect(ipc.on.mock.calls.filter(call => call[0] === WATCHER_CHANGED)).toHaveLength(1)
  const receive = ipc.on.mock.calls.find(call => call[0] === WATCHER_CHANGED)![1] as (event: unknown, ...payload: unknown[]) => void
  const hostId = randomUUID(), at = '2026-10-23T00:00:00.000Z', later = '2026-10-23T00:00:01.000Z'
  const room: WatcherRoomState = { current: null, currentOptions: null, history: [], requests: [], watchedThreads: [], receipts: [], recoveryNotice: null, observedAt: at }
  receive({}, { revision: 1, base: null, room })
  expect(first).toHaveBeenLastCalledWith(room); expect(second).toHaveBeenLastCalledWith(room)
  const request = { id: randomUUID(), watcher: { hostId, threadId: 'watcher' }, rootUserMessageId: 'prompt', state: 'active', createdAt: at, closedAt: null, participants: [] }
  receive({}, { revision: 2, base: 1, room: { recoveryNotice: 'Reconnect.', observedAt: later }, lists: { requests: { length: 1, at: [[0, request]] } } })
  const assembled = first.mock.calls.at(-1)![0] as WatcherRoomState
  expect(assembled).toEqual({ ...room, recoveryNotice: 'Reconnect.', observedAt: later, requests: [request] })
  // What did not change is what the page already held.
  expect(assembled.watchedThreads).toBe(room.watchedThreads)
  expect(second.mock.calls.at(-1)![0]).toBe(assembled)
  // An update measured from a room it does not hold changes nothing it holds: it reads the room once and hands that on.
  const read = { ...room, recoveryNotice: 'read', observedAt: later }
  let answer!: (value: unknown) => void
  ipc.invoke.mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
  receive({}, { revision: 9, base: 8, room: { observedAt: later } })
  receive({}, { revision: 10, base: 9, room: { observedAt: later } })
  expect(ipc.invoke).toHaveBeenCalledOnce(); expect(ipc.invoke).toHaveBeenCalledWith(WATCHER_GET)
  expect(first).toHaveBeenCalledTimes(2)
  answer({ status: 'ok', state: read })
  await vi.waitFor(() => expect(first).toHaveBeenLastCalledWith(read))
  // Main sends the next update whole, and the page holds it again.
  receive({}, { revision: 11, base: null, room })
  receive({}, { revision: 12, base: 11, room: { observedAt: later }, removed: ['recoveryNotice'] })
  expect(first.mock.calls.at(-1)![0]).not.toHaveProperty('recoveryNotice')
  expect(ipc.invoke).toHaveBeenCalledOnce()
  offFirst(); expect(ipc.removeListener).not.toHaveBeenCalled()
  offSecond(); expect(ipc.removeListener).toHaveBeenCalledWith(WATCHER_CHANGED, expect.any(Function))
})

/** The room the page ends on, from every room the preload handed it, ordered as the page orders them. */
const pageRoom = (listener: ReturnType<typeof vi.fn>) => listener.mock.calls.reduce<WatcherRoomState | null>((page, [room]) => newerWatcherRoom(page, room as WatcherRoomState), null)

it('applies updates measured from a whole room that arrives while it reads, and reads again when one after it cannot apply', async () => {
  const ipc = preloadElectron().ipcRenderer
  const listener = vi.fn(), off = createSottoBridge(ipc, 'win32', true).watcher!.onChanged(listener)
  const receive = ipc.on.mock.calls.find(call => call[0] === WATCHER_CHANGED)![1] as (event: unknown, ...payload: unknown[]) => void
  const at = (second: number) => `2026-10-23T00:00:${String(second).padStart(2, '0')}.000Z`
  // Main numbers every room it builds; here the number is the second it was built in.
  const room = (second: number, notice: string | null = null): WatcherRoomState => ({ current: null, currentOptions: null, history: [], requests: [], watchedThreads: [],
    receipts: [], recoveryNotice: notice, observedAt: at(second), sequence: second })
  const answers: ((value: unknown) => void)[] = []
  ipc.invoke.mockImplementation(() => new Promise(resolve => { answers.push(resolve) }))
  // Measured from a room this window never held: it reads the room.
  receive({}, { revision: 5, base: 4, room: { observedAt: at(1), sequence: 1 } })
  expect(ipc.invoke).toHaveBeenCalledOnce()
  // Main read the reset before these: a whole room, then an update measured from it, both before the read answers.
  receive({}, { revision: 6, base: null, room: room(2) })
  receive({}, { revision: 7, base: 6, room: { recoveryNotice: 'last', observedAt: at(3), sequence: 3 } })
  expect(listener).toHaveBeenLastCalledWith(room(3, 'last'))
  // The read's answer is older than what main sent since, and the page keeps the newer room.
  answers.shift()!({ status: 'ok', state: room(1, 'read') })
  await vi.waitFor(() => expect(listener).toHaveBeenLastCalledWith(room(1, 'read')))
  expect(pageRoom(listener)).toEqual(room(3, 'last'))
  // The read did not drop the room it held: the next update still applies, and nothing is read again.
  receive({}, { revision: 8, base: 7, room: { observedAt: at(4), sequence: 4 } })
  expect(listener).toHaveBeenLastCalledWith(room(4, 'last'))
  expect(ipc.invoke).toHaveBeenCalledOnce()

  // An update after a whole room that still cannot apply, while a read is out, is read again once that read answers.
  receive({}, { revision: 20, base: 19, room: { observedAt: at(5), sequence: 5 } })
  receive({}, { revision: 21, base: null, room: room(6) })
  receive({}, { revision: 23, base: 22, room: { observedAt: at(7), sequence: 7 } })
  expect(ipc.invoke).toHaveBeenCalledTimes(2)
  answers.shift()!({ status: 'ok', state: room(5, 'second read') })
  await vi.waitFor(() => expect(ipc.invoke).toHaveBeenCalledTimes(3))
  expect(pageRoom(listener)).toEqual(room(6))
  answers.shift()!({ status: 'ok', state: room(8, 'third read') })
  await vi.waitFor(() => expect(listener).toHaveBeenLastCalledWith(room(8, 'third read')))
  expect(pageRoom(listener)).toEqual(room(8, 'third read'))
  expect(ipc.invoke).toHaveBeenCalledTimes(3)
  off()
})

it('leaves the page on the newer room when a recovery read\'s answer and a whole room were read in the same millisecond', async () => {
  const ipc = preloadElectron().ipcRenderer
  const listener = vi.fn(), off = createSottoBridge(ipc, 'win32', true).watcher!.onChanged(listener)
  const receive = ipc.on.mock.calls.find(call => call[0] === WATCHER_CHANGED)![1] as (event: unknown, ...payload: unknown[]) => void
  const at = '2026-10-23T00:00:00.000Z'
  const room = (notice: string, sequence: number): WatcherRoomState => ({ current: null, currentOptions: null, history: [], requests: [], watchedThreads: [],
    receipts: [], recoveryNotice: notice, observedAt: at, sequence })
  let answer!: (value: unknown) => void
  ipc.invoke.mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
  receive({}, { revision: 5, base: 4, room: { observedAt: at, sequence: 9 } })
  expect(ipc.invoke).toHaveBeenCalledOnce()
  // Main took the read with room A, then sent room B whole, built in the same millisecond.
  receive({}, { revision: 6, base: null, room: room('B', 11) })
  answer({ status: 'ok', state: room('A', 10) })
  await vi.waitFor(() => expect(listener).toHaveBeenLastCalledWith(room('A', 10)))
  // A tie in time is no tie in order: the page ends on B.
  expect(pageRoom(listener)).toEqual(room('B', 11))
  off()
})
