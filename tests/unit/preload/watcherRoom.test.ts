// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { preloadElectron } from '../../fixtures/preloadElectron'
vi.mock('electron', async () => (await import('../../fixtures/preloadElectron')).preloadElectron())
import { createSottoBridge, createSottoWidgetBridge } from '../../../src/preload'
import { WATCHER_CHANGED, WATCHER_OPEN, WATCHER_SET_PERMISSION, WATCHER_START_NEW, WATCHER_WATCH_THREAD, WATCHER_UNWATCH_THREAD, watcherRoomStateSchema,
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
    receiptReplies: [], asks: [], context: null, state: { watching: [], kept: { decisions: ['Keep the branch'], rules: [], issues: [], updatedAt: at } } }
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
