// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWatcherRoomDesktop } from '../../../src/main/agents/watcherRoomDesktop'
import type { PublishScheduler } from '../../../src/main/agents/control'
import { registerIpc } from '../../../src/main/ipc/registerIpc'
import { WATCHER_GET, WATCHER_OPEN, WATCHER_PREPARE_STOP_ALL, WATCHER_STOP_ALL,
  WATCHER_SET_PERMISSION, WATCHER_WATCH_THREAD, WATCHER_UNWATCH_THREAD, WATCHER_START_NEW, applyWatcherRoomUpdate, newerWatcherRoom,
  type WatcherHandoverRead, type WatcherMergeTurnsRead, type WatcherRoomHeld, type WatcherRoomState, type WatcherRoomResult, type WatcherRoomUpdate,
  type WatcherStopAllResult } from '../../../src/shared/watcherRoom'
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
  let listener: (() => void) | undefined
  let current = room('complete'), available = true, held: WatcherRoomHeld | null = null
  const clock = new Clock(), order: string[] = [], rooms: WatcherRoomState[] = []
  const off = vi.fn(() => { listener = undefined })
  const service = {
    subscribe: vi.fn((fn: () => void) => { listener = fn; return off }),
    state: vi.fn(() => current),
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
    readMergeTurns: vi.fn((): WatcherMergeTurnsRead => ({ status: 'ok', queue: [], turns: [] })),
  }
  // The window's room: an update put back together as the preload does, or the room itself without the publish window.
  const send = vi.fn((payload: WatcherRoomState | WatcherRoomUpdate) => {
    // A window that is not there receives nothing, so it keeps the room it held.
    const assembled = 'base' in payload ? applyWatcherRoomUpdate(held, payload)! : undefined
    if (assembled && available) held = assembled
    const state = assembled ? assembled.room : payload as WatcherRoomState
    rooms.push(state); order.push(`send:${state.recoveryNotice}`); return available
  })
  const desktop = createWatcherRoomDesktop({ watcherEnabled, streamingPublishCost, watcher: service, send, schedule: clock.schedule })
  return { desktop, service, clock, send, order, off, rooms,
    publish: (state: WatcherRoomState) => { current = state; listener?.() }, current: (state: WatcherRoomState) => { current = state },
    available: (value: boolean) => { available = value } }
}
afterEach(() => vi.restoreAllMocks())

describe('desktop Watcher room publication', () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])('checks both startup answers (%s, %s) before building updates or scheduling', (watcher, cost) => {
    const f = fixture(watcher, cost), state = room('event')
    try {
      f.publish(state)
      expect(f.service.subscribe).toHaveBeenCalledTimes(watcher ? 1 : 0)
      expect(f.desktop === undefined).toBe(!watcher)
      expect(f.clock.entries).toHaveLength(watcher && cost ? 1 : 0)
      expect(f.send).toHaveBeenCalledTimes(watcher ? 1 : 0)
      if (watcher && !cost) expect(f.send.mock.calls[0]![0]).toBe(state)
      // With the publish window on, the first update is the whole room, the very room built for it, never a copy (#1450).
      if (watcher && cost) { expect(f.send.mock.calls[0]![0]).toEqual({ revision: 1, base: null, room: state }); expect((f.send.mock.calls[0]![0] as WatcherRoomUpdate).room).toBe(state) }
    } finally { f.desktop?.dispose() }
  })

  it('builds the room only when an update goes: the leading one at once, the newest at the trailing send, none between', () => {
    const f = fixture(), first = room('first'), last = room('last')
    try {
      f.publish(first)
      expect(f.service.state).toHaveBeenCalledOnce()
      for (let i = 0; i < 40; i++) f.publish(room(`intermediate-${i}`))
      f.publish(last)
      // Forty-one changes in the window built nothing and sent nothing (#1450).
      expect(f.service.state).toHaveBeenCalledOnce()
      expect(f.send).toHaveBeenCalledTimes(1)
      f.clock.tick()
      expect(f.service.state).toHaveBeenCalledTimes(2)
      expect(f.rooms).toEqual([first, last])
      f.clock.tick()
      expect(f.send).toHaveBeenCalledTimes(2)
      expect(f.clock.entries).toHaveLength(0)
    } finally { f.desktop!.dispose() }
  })

  it('builds the room for a change that moved nothing it shows, at most once a window, and sends nothing for it', () => {
    const f = fixture()
    try {
      f.publish(room('same')); f.clock.tick()
      for (let i = 0; i < 10; i++) f.publish({ ...room('same'), observedAt: '2026-10-14T00:00:01.000Z' })
      f.clock.tick()
      // A known limit (#1450): main cannot tell cheaply and safely that nothing the room shows moved, so the room is built
      // for the ten changes as for any, once at the first and once at the window's end, compared with the room last sent,
      // and nothing goes.
      expect(f.service.state).toHaveBeenCalledTimes(3)
      expect(f.send).toHaveBeenCalledOnce()
    } finally { f.desktop!.dispose() }
  })

  it('sends only the fields and list entries that changed, by place, and the window puts back the room main built', () => {
    const f = fixture(), hostId = randomUUID(), target = { hostId, threadId: 'worker' }
    const request = (n: number, state: 'active' | 'closed' = 'closed') => ({ id: randomUUID(), watcher: { hostId, threadId: 'watcher' }, rootUserMessageId: `prompt-${n}`,
      state, createdAt: at, closedAt: state === 'closed' ? at : null, participants: [] }) as WatcherRoomState['requests'][number]
    const history = Array.from({ length: 50 }, (_, n) => request(n))
    const active = request(50, 'active'), row = { target, title: 'Worker', status: 'running' as const, connected: true, settled: false, backgroundWorkCount: 0, waitsOn: [], participation: [] }
    const before: WatcherRoomState = { ...room('before'), requests: [...history, active], watchedThreads: [row], news: [], handover: null }
    // A new room as Watcher builds one: new arrays and rows, the closed requests the record's own, one request closed and one added.
    const after: WatcherRoomState = { ...room('before'), requests: [...history, { ...active, state: 'closed', closedAt: at }, request(51, 'active')],
      watchedThreads: [{ ...row }], news: [], observedAt: '2026-10-14T00:00:01.000Z', creationStopped: false }
    try {
      f.publish(before); f.clock.tick()
      f.publish(after)
      const update = structuredClone(f.send.mock.calls[1]![0]) as WatcherRoomUpdate
      // The closed request rides as what changed in it, the new one whole.
      expect(update).toEqual({ revision: 2, base: 1, room: { creationStopped: false, observedAt: after.observedAt },
        lists: { requests: { length: 52, at: [[51, after.requests[51]]], patch: [[50, { set: { state: 'closed', closedAt: at } }]] } }, removed: ['handover'] })
      // The window's room is the room main built, and keeps the closed requests it already held.
      expect(f.rooms[1]).toEqual(after)
      expect(f.rooms[1]!.requests[0]).toBe(f.rooms[0]!.requests[0])
      expect(f.rooms[1]!.watchedThreads).toBe(f.rooms[0]!.watchedThreads)
    } finally { f.desktop!.dispose() }
  })

  it('sends a watched thread whose status changed without the participations it has had, and the window keeps them', () => {
    const f = fixture(), hostId = randomUUID(), target = { hostId, threadId: 'worker' }
    type Participant = WatcherRoomState['watchedThreads'][number]['participation'][number]
    const participation: Participant[] = Array.from({ length: 200 }, () => ({ target, requestId: randomUUID(), startedBy: 'watcher', generation: 0,
      state: 'relinquished', lastUserMessageId: null, promptCount: 1 }))
    const row = (status: 'running' | 'idle', parts = participation) => ({ target, title: 'Worker', status, connected: true, settled: false, backgroundWorkCount: 0,
      waitsOn: [], participation: [...parts] })
    const taking: Participant = { ...participation[0]!, requestId: randomUUID(), state: 'participating' }
    try {
      f.publish({ ...room('rows'), watchedThreads: [row('running')] }); f.clock.tick()
      // Rebuilt as Watcher builds it: a new row and a new list of the same participations.
      f.publish({ ...room('rows'), watchedThreads: [row('idle')] }); f.clock.tick()
      f.publish({ ...room('rows'), watchedThreads: [row('idle', [...participation, taking])] }); f.clock.tick()
      const [, idle, taken] = f.send.mock.calls.map(([payload]) => structuredClone(payload) as WatcherRoomUpdate)
      expect(idle!.lists).toEqual({ watchedThreads: { length: 1, at: [], patch: [[0, { set: { status: 'idle' } }]] } })
      expect(taken!.lists).toEqual({ watchedThreads: { length: 1, at: [], patch: [[0, { lists: { participation: { length: 201, at: [[200, taking]] } } }]] } })
      expect(f.rooms.at(-1)!.watchedThreads).toEqual([row('idle', [...participation, taking])])
      expect(f.rooms.at(-1)!.watchedThreads[0]!.participation[0]).toBe(f.rooms[0]!.watchedThreads[0]!.participation[0])
    } finally { f.desktop!.dispose() }
  })

  it.each(['watchThread', 'get'] as const)('leaves the page on the room flushed after a %s reply when both were read in the same millisecond', async operation => {
    // Main numbers every room it builds; both rooms here are read at the same time.
    let sequence = 0, notice = 'first', listener: (() => void) | undefined
    const clock = new Clock(), build = (): WatcherRoomState => ({ ...room(notice), sequence: ++sequence })
    const service = { subscribe: (fn: () => void) => { listener = fn; return () => { listener = undefined } }, state: vi.fn(build),
      get: (): WatcherRoomResult => ({ status: 'ok', state: build() }),
      watchThread: async (): Promise<WatcherRoomResult> => { const answer = build(); notice = 'after the answer'; listener?.(); return { status: 'ok', state: answer } } }
    let held: WatcherRoomHeld | null = null
    const pushed: WatcherRoomState[] = []
    const desktop = createWatcherRoomDesktop({ watcherEnabled: true, streamingPublishCost: true, watcher: service as never, schedule: clock.schedule,
      send: update => { held = applyWatcherRoomUpdate(held, update as WatcherRoomUpdate)!; pushed.push(held.room); return true } })!
    try {
      listener!(); expect(pushed).toHaveLength(1)
      // A change waits in the window, and the reply's own room is built before the flush builds the next.
      if (operation === 'get') { notice = 'pending'; listener!() }
      const reply = operation === 'get' ? await desktop.bridge.get() : await desktop.bridge.watchThread({ target: { hostId: randomUUID(), threadId: 'worker' } })
      if (reply.status !== 'ok') throw new Error('refused')
      const flushed = pushed.at(-1)!
      expect(flushed.observedAt).toBe(reply.state.observedAt)
      expect(flushed.sequence!).toBeGreaterThan(reply.state.sequence!)
      // The page takes the push first and the reply after it, as the window does.
      const page = [...pushed, reply.state].reduce<WatcherRoomState | null>((current, next) => newerWatcherRoom(current, next), null)
      expect(page).toBe(flushed)
    } finally { desktop.dispose() }
  })

  it('measures from the last update the window was sent, and sends the room whole after the window read it', async () => {
    const f = fixture()
    try {
      f.publish(room('first')); f.clock.tick()
      f.available(false); f.publish(room('lost')); f.clock.tick()
      f.available(true); f.publish(room('second')); f.clock.tick()
      // The lost update never became a base: the next one is measured from the first.
      expect((f.send.mock.calls[2]![0] as WatcherRoomUpdate).base).toBe(1)
      await f.desktop!.bridge.get()
      f.publish(room('third'))
      expect(f.send.mock.calls[3]![0]).toMatchObject({ revision: 4, base: null, room: room('third') })
    } finally { f.desktop!.dispose() }
  })

  it('cannot apply an update measured from another, or one that would leave a gap in a list', () => {
    const held: WatcherRoomHeld = { revision: 3, room: room('held') }
    expect(applyWatcherRoomUpdate(held, { revision: 5, base: 4, room: {} })).toBeNull()
    expect(applyWatcherRoomUpdate(null, { revision: 5, base: 4, room: {} })).toBeNull()
    expect(applyWatcherRoomUpdate(held, { revision: 4, base: 3, room: {}, lists: { requests: { length: 2, at: [[1, 'one']] } } })).toBeNull()
    expect(applyWatcherRoomUpdate(held, { revision: 4, base: 3, room: {}, lists: { requests: { length: 1, at: [[1, 'one']] } } })).toBeNull()
    expect(applyWatcherRoomUpdate(held, { revision: 4, base: 3, room: {}, lists: { requests: { length: 1, at: [[0, 'zero']] } } })?.room.requests).toEqual(['zero'])
    // A patch reaches only a record that is there.
    expect(applyWatcherRoomUpdate(held, { revision: 4, base: 3, room: {}, lists: { requests: { length: 1, at: [], patch: [[0, { set: { state: 'closed' } }]] } } })).toBeNull()
    expect(applyWatcherRoomUpdate(held, { revision: 4, base: 3, room: {}, lists: { requests: { length: 1, at: [[0, 'zero']], patch: [[0, { set: { state: 'closed' } }]] } } })).toBeNull()
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
      // The trailing room is built when it goes, from what is true then (#1450).
      expect(f.order).toEqual(['send:missed', 'send:leading', 'send:fresh'])
      f.clock.tick()
      expect(f.send).toHaveBeenCalledTimes(3)
    } finally { f.desktop!.dispose() }
  })

  it('unsubscribes and drops a pending update even if the cancelled timer escapes', () => {
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
      expect(f.order).toEqual(['send:leading', 'send:own answer', 'answer'])
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

  it.each(['open', 'stopAll'] as const)('returns %s own result when a newer tied room arrives while it is pending', async operation => {
    const f = fixture(), held = deferred<WatcherRoomResult & { results: [] }>()
    const own = { status: 'ok' as const, state: { ...room('own result'), recoveryNotice: 'own result' }, results: [] as [] }
    if (operation === 'open') f.service.open.mockImplementation(() => held.promise)
    else f.service.stopAll.mockImplementation(() => held.promise)
    try {
      f.publish(room('leading')); f.publish(room('old'))
      const answer = operation === 'open' ? f.desktop!.bridge.open({ provider: 'codex', modelId: 'model' }) : f.desktop!.bridge.stopAll({ confirmationId: randomUUID() })
      held.resolve(own); f.publish(room('later event')); f.current(room('later read'))
      expect(await answer).toBe(own)
      expect(f.order).toEqual(['send:leading', 'send:later read'])
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
