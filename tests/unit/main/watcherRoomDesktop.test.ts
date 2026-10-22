// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWatcherRoomDesktop } from '../../../src/main/agents/watcherRoomDesktop'
import type { PublishScheduler } from '../../../src/main/agents/control'
import { registerIpc } from '../../../src/main/ipc/registerIpc'
import { WATCHER_GET, WATCHER_OPEN, WATCHER_PREPARE_STOP_ALL, WATCHER_STOP_ALL,
  WATCHER_SET_PERMISSION, WATCHER_WATCH_THREAD, WATCHER_UNWATCH_THREAD, WATCHER_START_NEW,
  type WatcherHandoverRead, type WatcherRoomState, type WatcherRoomResult, type WatcherStopAllResult } from '../../../src/shared/watcherRoom'
import { createIpcHarness } from '../../fixtures/ipcHarness'
import { deferred } from '../../fixtures/deferred'

const at = '2026-10-14T00:00:00.000Z'
const room = (name: string): WatcherRoomState => ({ current: null, currentOptions: null, history: [], requests: [],
  watchedThreads: [], receipts: [], recoveryNotice: name, observedAt: at })
class Clock {
  readonly entries: { run(): void; cancelled: boolean }[] = []
  readonly schedule: PublishScheduler = (run, ms) => {
    expect(ms).toBe(50)
    const entry = { run, cancelled: false }; this.entries.push(entry)
    return () => { entry.cancelled = true }
  }
  tick(): void { const entry = this.entries.shift(); if (entry && !entry.cancelled) entry.run() }
}
function fixture(watcherEnabled = true, streamingPublishCost = true) {
  let listener: ((state: WatcherRoomState) => void) | undefined
  let current = room('complete'), available = true
  const clock = new Clock(), order: string[] = []
  const off = vi.fn(() => { listener = undefined })
  const service = {
    subscribe: vi.fn((fn: (state: WatcherRoomState) => void) => { listener = fn; return off }),
    get: vi.fn((): WatcherRoomResult => ({ status: 'ok', state: current })),
    open: vi.fn(async (): Promise<WatcherRoomResult> => ({ status: 'ok', state: current })),
    setPermission: vi.fn(async (): Promise<WatcherRoomResult> => ({ status: 'ok', state: current })),
    watchThread: vi.fn(async (): Promise<WatcherRoomResult> => ({ status: 'ok', state: current })),
    unwatchThread: vi.fn(async (): Promise<WatcherRoomResult> => ({ status: 'ok', state: current })),
    prepareStopAll: vi.fn(() => ({ status: 'ok' as const, confirmationId: randomUUID(), targets: [], expiresAt: at })),
    stopAll: vi.fn(async (): Promise<WatcherStopAllResult> => ({ status: 'ok', state: current, results: [] })),
    readHandover: vi.fn((): WatcherHandoverRead => ({ status: 'refused', code: 'TARGET_CHANGED', message: 'There is no handover to read.', retryable: false })),
    continueWithHandover: vi.fn((): WatcherRoomResult => ({ status: 'ok', state: current })),
    dismissHandover: vi.fn((): WatcherRoomResult => ({ status: 'ok', state: current })),
    startNew: vi.fn(async (): Promise<WatcherRoomResult> => ({ status: 'ok', state: current })),
  }
  const send = vi.fn((state: WatcherRoomState) => { order.push(`send:${state.recoveryNotice}`); return available })
  const desktop = createWatcherRoomDesktop({ watcherEnabled, streamingPublishCost, watcher: service, send, schedule: clock.schedule })
  return { desktop, service, clock, send, order, off,
    publish: (state: WatcherRoomState) => listener?.(state), current: (state: WatcherRoomState) => { current = state },
    available: (value: boolean) => { available = value } }
}
afterEach(() => vi.restoreAllMocks())

describe('desktop Watcher room publication', () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])('checks both startup answers (%s, %s) before capture or scheduling', (watcher, cost) => {
    const f = fixture(watcher, cost), state = room('event')
    try {
      f.publish(state)
      expect(f.service.subscribe).toHaveBeenCalledTimes(watcher ? 1 : 0)
      expect(f.desktop === undefined).toBe(!watcher)
      expect(f.clock.entries).toHaveLength(watcher && cost ? 1 : 0)
      expect(f.send).toHaveBeenCalledTimes(watcher ? 1 : 0)
      if (watcher && !cost) expect(f.send.mock.calls[0]![0]).toBe(state)
      // With the publish window on, the room sends a capture of the state, never the state itself.
      if (watcher && cost) { expect(f.send.mock.calls[0]![0]).not.toBe(state); expect(f.send.mock.calls[0]![0]).toEqual(state) }
    } finally { f.desktop?.dispose() }
  })

  it('sends leading/latest trailing rooms, retains captured nested facts and closes quietly', () => {
    const f = fixture(), first = room('first'), pending = room('pending')
    const target = { hostId: randomUUID(), threadId: 'worker' }, requestId = randomUUID()
    pending.requests.push({ id: requestId, watcher: target, rootUserMessageId: 'prompt', state: 'active', createdAt: at, closedAt: null,
      displayPrompt: { originalLength: 3, wireDigest: 'a'.repeat(64) },
      userFollowups: [{ draftId: randomUUID(), displayPrompt: { originalLength: 2, wireDigest: 'b'.repeat(64) } }], participants: [] })
    pending.watchedThreads.push({ target, title: 'Worker', status: 'running', connected: true, settled: false, backgroundWorkCount: 0,
      waitsOn: [{ id: 'permission', kind: 'permission', openTarget: target }], participation: [],
      evidence: [{ id: 'proof', target, source: 'checkpoint', observedAt: at, freshness: 'fresh', availability: 'available', fact: 'files-changed', changedFiles: 3 }],
      observation: { observedAt: at, fresh: true } })
    pending.news = [{ id: 'news', kind: 'evidence-changed', requestId, target, generation: 0, observedAt: at, evidenceIds: ['proof'] }]
    pending.runtimeMode = 'full-access'
    pending.standingWatches = [{ id: randomUUID(), target: { ...target }, createdAt: at, generation: 0, pausedByUserMessageId: 'user' }]
    pending.ownChanges = [{ replyMessageId: 'reply', turnId: 'turn', files: ['README.md'], fileCount: 1, reason: 'Fix the wording', source: 'provider-file-change' }]
    const expected = structuredClone(pending)
    try {
      f.publish(first)
      for (let i = 0; i < 40; i++) f.publish(room(`intermediate-${i}`))
      f.publish(pending)
      pending.requests[0]!.displayPrompt!.originalLength = 99
      pending.requests[0]!.userFollowups![0]!.displayPrompt!.originalLength = 99
      pending.watchedThreads[0]!.evidence![0]!.changedFiles = 99
      pending.watchedThreads[0]!.waitsOn[0]!.openTarget.threadId = 'later'
      pending.watchedThreads[0]!.observation!.fresh = false
      pending.news[0]!.evidenceIds![0] = 'later proof'
      pending.runtimeMode = 'approval-required'
      pending.standingWatches[0]!.target.threadId = 'later watch'
      pending.standingWatches[0]!.pausedByUserMessageId = null
      pending.ownChanges[0]!.files[0] = 'later file'
      pending.ownChanges[0]!.reason = 'later reason'
      expect(f.send).toHaveBeenCalledTimes(1)
      f.clock.tick()
      expect(f.send.mock.calls.map(([state]) => state)).toEqual([first, expected])
      f.clock.tick()
      expect(f.send).toHaveBeenCalledTimes(2)
      expect(f.clock.entries).toHaveLength(0)
    } finally { f.desktop!.dispose() }
  })

  it('does not retry an absent window and recovers with a complete get before any older trailing send', async () => {
    const f = fixture()
    try {
      f.available(false); f.publish(room('missed')); f.clock.tick()
      expect(f.send).toHaveBeenCalledTimes(1)
      expect(f.clock.entries).toHaveLength(0)
      f.available(true); f.publish(room('leading')); f.publish(room('old'))
      const current = room('fresh'); f.current(current)
      expect(await f.desktop!.bridge.get()).toEqual({ status: 'ok', state: current })
      expect(f.order).toEqual(['send:missed', 'send:leading', 'send:old'])
      f.clock.tick()
      expect(f.send).toHaveBeenCalledTimes(3)
    } finally { f.desktop!.dispose() }
  })

  it('unsubscribes and drops a pending capture even if the cancelled timer escapes', () => {
    const f = fixture(); f.publish(room('first')); f.publish(room('pending'))
    const escaped = f.clock.entries[0]!.run
    f.desktop!.dispose(); escaped(); f.publish(room('after'))
    expect(f.off).toHaveBeenCalledOnce()
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('keeps the existing unavailable-host replies without a subscription or scheduler', async () => {
    const clock = new Clock()
    const desktop = createWatcherRoomDesktop({ watcherEnabled: true, streamingPublishCost: true,
      send: () => { throw new Error('No room exists') }, schedule: clock.schedule })!
    try {
      for (const answer of [desktop.bridge.get(), desktop.bridge.open({ provider: 'codex', modelId: 'model' }),
        desktop.bridge.prepareStopAll(), desktop.bridge.stopAll({ confirmationId: randomUUID() }),
        desktop.bridge.setPermission({ runtimeMode: 'full-access' }), desktop.bridge.watchThread({ target: { hostId: randomUUID(), threadId: 'worker' } }),
        desktop.bridge.unwatchThread({ target: { hostId: randomUUID(), threadId: 'worker' } }), desktop.bridge.startNew()]) {
        expect(await answer).toMatchObject({ status: 'refused', code: 'HOST_FEATURE_UNAVAILABLE' })
      }
      expect(clock.entries).toHaveLength(0)
    } finally { desktop.dispose() }
  })

  it('keeps authorization and schema refusals outside the room reply flush', async () => {
    const f = fixture(), ipc = createIpcHarness(); ipc.cleanup()
    const cleanup = registerIpc(ipc.ipc, { settings: ipc.settings, history: ipc.history, startup: ipc.startup, hotkeys: ipc.hotkeys,
      app: ipc.app, trustedSenders: () => [{ role: 'main', webContents: ipc.trustedContents, url: ipc.trustedUrl }], watcher: f.desktop!.bridge })
    try {
      f.publish(room('leading')); f.publish(room('pending'))
      await expect(ipc.ipc.invoke(WATCHER_OPEN, { provider: 'codex', modelId: 'model', approved: true })).rejects.toThrow()
      await expect(ipc.ipc.invokeArgs(WATCHER_GET, [], { sender: { ...ipc.trustedContents }, senderFrame: ipc.trustedEvent.senderFrame })).rejects.toThrow()
      for (const [channel, input] of [[WATCHER_SET_PERMISSION, { runtimeMode: 'full-access' }],
        [WATCHER_WATCH_THREAD, { target: { hostId: randomUUID(), threadId: 'worker' } }],
        [WATCHER_UNWATCH_THREAD, { target: { hostId: randomUUID(), threadId: 'worker' } }]] as const) {
        await expect(ipc.ipc.invoke(channel, { ...input, approved: true })).rejects.toThrow()
        await expect(ipc.ipc.invokeArgs(channel, [input], { sender: { ...ipc.trustedContents }, senderFrame: ipc.trustedEvent.senderFrame })).rejects.toThrow()
      }
      expect(f.service.open).not.toHaveBeenCalled(); expect(f.service.get).not.toHaveBeenCalled()
      expect(f.service.setPermission).not.toHaveBeenCalled(); expect(f.service.watchThread).not.toHaveBeenCalled(); expect(f.service.unwatchThread).not.toHaveBeenCalled()
      expect(f.send).toHaveBeenCalledTimes(1)
      f.clock.tick(); expect(f.send).toHaveBeenCalledTimes(2)
    } finally { cleanup(); f.desktop!.dispose() }
  })

  it.each([
    [WATCHER_GET, undefined], [WATCHER_OPEN, { provider: 'codex', modelId: 'model' }],
    [WATCHER_PREPARE_STOP_ALL, undefined], [WATCHER_STOP_ALL, { confirmationId: randomUUID() }], [WATCHER_START_NEW, undefined],
  ])('flushes pending room facts before the actual %s IPC answer, including tied timestamps', async (channel, input) => {
    const f = fixture(), ipc = createIpcHarness(); ipc.cleanup()
    const cleanup = registerIpc(ipc.ipc, { settings: ipc.settings, history: ipc.history, startup: ipc.startup, hotkeys: ipc.hotkeys,
      app: ipc.app, trustedSenders: () => [{ role: 'main', webContents: ipc.trustedContents, url: ipc.trustedUrl }], watcher: f.desktop!.bridge })
    try {
      f.publish(room('leading')); f.publish(room('pending'))
      const own = room('own answer'); f.current(own)
      const invocation = input === undefined ? ipc.ipc.invoke(channel as string) : ipc.ipc.invoke(channel as string, input)
      const result = await invocation.then(value => { f.order.push('answer'); return value })
      expect(f.order).toEqual(['send:leading', 'send:pending', 'answer'])
      if (channel !== WATCHER_PREPARE_STOP_ALL) expect(result).toMatchObject({ status: 'ok', state: { recoveryNotice: 'own answer', observedAt: at } })
      f.clock.tick()
      expect(f.send).toHaveBeenCalledTimes(2)
    } finally { cleanup(); f.desktop!.dispose() }
  })

  it.each([
    ['setPermission', WATCHER_SET_PERMISSION, { runtimeMode: 'full-access' }],
    ['watchThread', WATCHER_WATCH_THREAD, { target: { hostId: randomUUID(), threadId: 'worker' } }],
    ['unwatchThread', WATCHER_UNWATCH_THREAD, { target: { hostId: randomUUID(), threadId: 'worker' } }],
  ] as const)('preserves %s management replies and flushes before success, rejection and synchronous failure', async (operation, channel, input) => {
    for (const outcome of ['success', 'reject', 'throw'] as const) {
      const f = fixture(), ipc = createIpcHarness(); ipc.cleanup()
      const cleanup = registerIpc(ipc.ipc, { settings: ipc.settings, history: ipc.history, startup: ipc.startup, hotkeys: ipc.hotkeys,
        app: ipc.app, trustedSenders: () => [{ role: 'main', webContents: ipc.trustedContents, url: ipc.trustedUrl }], watcher: f.desktop!.bridge })
      const held = deferred<WatcherRoomResult>(), own = { status: 'ok' as const, state: room('management answer') }, failure = new Error('Synthetic management failure')
      if (outcome === 'throw') f.service[operation].mockImplementation(() => { throw failure })
      else f.service[operation].mockImplementation(() => held.promise)
      try {
        f.publish(room('leading')); f.publish(room('pending'))
        const observed = ipc.ipc.invoke(channel, input).then(value => { f.order.push('answer'); return value }, error => { f.order.push('error'); return error })
        if (outcome === 'success') held.resolve(own)
        else if (outcome === 'reject') held.reject(failure)
        expect(await observed).toBe(outcome === 'success' ? own : failure)
        expect(f.service[operation]).toHaveBeenCalledExactlyOnceWith(input)
        expect(f.order).toEqual(['send:leading', 'send:pending', outcome === 'success' ? 'answer' : 'error'])
        f.clock.tick(); expect(f.send).toHaveBeenCalledTimes(2)
      } finally { cleanup(); f.desktop!.dispose() }
    }
  })

  it.each(['open', 'stopAll'] as const)('returns %s own captured result when a newer tied room arrives while it is pending', async operation => {
    const f = fixture(), held = deferred<WatcherRoomResult & { results: [] }>()
    const own = { status: 'ok' as const, state: { ...room('own result'), recoveryNotice: 'own result' }, results: [] as [] }
    if (operation === 'open') f.service.open.mockImplementation(() => held.promise)
    else f.service.stopAll.mockImplementation(() => held.promise)
    try {
      f.publish(room('leading')); f.publish(room('old'))
      const answer = operation === 'open' ? f.desktop!.bridge.open({ provider: 'codex', modelId: 'model' }) : f.desktop!.bridge.stopAll({ confirmationId: randomUUID() })
      held.resolve(own); f.publish(room('later event')); f.current(room('later read'))
      expect(await answer).toBe(own)
      expect(f.order).toEqual(['send:leading', 'send:later event'])
      expect(f.service.get).not.toHaveBeenCalled()
      f.clock.tick(); expect(f.send).toHaveBeenCalledTimes(2)
    } finally { f.desktop!.dispose() }
  })

  it.each(['open', 'stopAll'] as const)('flushes before an awaited %s rejection and preserves the original error', async operation => {
    const f = fixture(), held = deferred<never>(), failure = new Error('Synthetic operation rejection')
    if (operation === 'open') f.service.open.mockImplementation(() => held.promise)
    else f.service.stopAll.mockImplementation(() => held.promise)
    try {
      f.publish(room('leading')); f.publish(room('pending'))
      const answer = operation === 'open' ? f.desktop!.bridge.open({ provider: 'codex', modelId: 'model' })
        : f.desktop!.bridge.stopAll({ confirmationId: randomUUID() })
      const observed = answer.catch(error => { f.order.push('rejected'); return error })
      held.reject(failure)
      expect(await observed).toBe(failure)
      expect(f.order).toEqual(['send:leading', 'send:pending', 'rejected'])
      expect(f.service.get).not.toHaveBeenCalled()
      f.clock.tick(); f.clock.tick(); expect(f.send).toHaveBeenCalledTimes(2)
    } finally { f.desktop!.dispose() }
  })

  it.each(['get', 'open', 'prepareStopAll', 'stopAll'] as const)('flushes before a synchronous %s throw crosses the bridge', async operation => {
    const f = fixture(), failure = new Error('Synthetic synchronous operation failure')
    const fail = (): never => { throw failure }
    f.service[operation].mockImplementation(fail)
    try {
      f.publish(room('leading')); f.publish(room('pending'))
      const answer = operation === 'get' ? f.desktop!.bridge.get()
        : operation === 'open' ? f.desktop!.bridge.open({ provider: 'codex', modelId: 'model' })
          : operation === 'prepareStopAll' ? f.desktop!.bridge.prepareStopAll()
            : f.desktop!.bridge.stopAll({ confirmationId: randomUUID() })
      expect(await answer.catch(error => { f.order.push('rejected'); return error })).toBe(failure)
      expect(f.order).toEqual(['send:leading', 'send:pending', 'rejected'])
      f.clock.tick(); f.clock.tick(); expect(f.send).toHaveBeenCalledTimes(2)
    } finally { f.desktop!.dispose() }
  })
})
