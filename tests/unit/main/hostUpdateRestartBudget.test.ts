// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DesktopHosts } from '../../../src/main/hosts/desktopHosts'
import { HostUpdateMissed, SocketHostService } from '../../../src/main/agents/socketHostService'
import { HOST_UPDATE_RESTART_BUDGET_MS, type HostUpdateAnswer } from '../../../src/shared/hostSelfUpdate'
import { deferred } from '../../fixtures/deferred'

const host = { id: 'saved-host', name: 'Test host', enabled: true }
type Recovery = {
  outcomeAfterRestart(target: typeof host, before: SocketHostService, deadline: number): Promise<HostUpdateAnswer | undefined>
  socketStep<T>(id: string, step: () => Promise<T>): Promise<T>
}
const dispose: (() => Promise<void>)[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000) })
afterEach(async () => {
  for (const close of dispose.splice(0).reverse()) await close()
  vi.clearAllTimers(); vi.useRealTimers()
})

/** The real serialized recovery and request timer, with only the transport held; no server, child or file is opened. */
function recovery(connected = true) {
  const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'test-token', catchUpEvents: false })
  const socket = client as unknown as { receive(text: string): void; disconnected(frames: unknown): void; pending: Map<string, unknown> }
  const send = vi.fn<(request: unknown) => boolean>(() => true)
  const frames = { send, isClosed: false, close: () => { frames.isClosed = true; socket.disconnected(frames) } }
  Object.assign(client, { features: ['host-update'], frames, session: { session: 'test-session' } })
  const manager = Object.create(DesktopHosts.prototype) as DesktopHosts
  const listeners = new Set<() => void>()
  const status = new Map([[host.id, { phase: connected ? 'connected' : 'connecting' }]]), queued = new Map<string, Promise<void>>()
  Object.assign(manager, { options: { now: () => Date.now() }, saved: [host], status,
    live: new Map([[host.id, { socket: client }]]), socketSteps: queued, listeners, closed: false })
  const run = manager as unknown as Recovery
  dispose.push(async () => {
    Object.assign(manager, { closed: true })
    for (const listener of listeners) listener()
    await client.close()
    await vi.advanceTimersByTimeAsync(30_500)
  })
  return { client, send, pending: socket.pending, queued, run,
    connect: () => { status.set(host.id, { phase: 'connected' }); for (const listener of listeners) listener() },
    read: (within: number) => run.outcomeAfterRestart(host, {} as SocketHostService, Date.now() + within),
    answer: (result: HostUpdateAnswer) => {
      const request = send.mock.calls.at(-1)?.[0] as { id: string } | undefined
      if (!request) throw new Error('No outcome request was sent')
      socket.receive(JSON.stringify({ v: 1, id: request.id, ok: true, result }))
    } }
}

it('sends no outcome read when the restart budget has already ended', async () => {
  const f = recovery(), result = f.read(0)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.send).not.toHaveBeenCalled()
  expect(await result).toBeUndefined()
  expect(f.pending.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('ends recovery at its deadline while an earlier update step is still queued, without ending that step', async () => {
  const f = recovery(), held = deferred<void>()
  let ended = false
  const earlier = f.run.socketStep(host.id, () => held.promise).then(() => { ended = true })
  const result = f.read(100), seen = vi.fn()
  void result.then(seen)
  try {
    await vi.advanceTimersByTimeAsync(100)
    expect(seen).toHaveBeenCalledWith(undefined)
    expect(ended).toBe(false)
    expect(f.send).not.toHaveBeenCalled()
  } finally { held.resolve(); await earlier; await vi.advanceTimersByTimeAsync(0) }
  expect(f.send).not.toHaveBeenCalled()
  expect(f.pending.size).toBe(0)
  expect(f.queued.size).toBe(0)
})

it('keeps an earlier update failure while an expired queued outcome sends nothing', async () => {
  const f = recovery(), held = deferred<void>(), failure = new Error('The earlier install failed')
  const earlier = f.run.socketStep(host.id, () => held.promise).catch((error: unknown) => error)
  const seen = vi.fn()
  void f.read(100).then(seen)
  await vi.advanceTimersByTimeAsync(100)
  expect(seen).toHaveBeenCalledWith(undefined)
  held.reject(failure)
  expect(await earlier).toBe(failure)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.send).not.toHaveBeenCalled()
  expect(f.queued.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('removes a silent outcome request when the remaining restart budget ends', async () => {
  const f = recovery(), seen = vi.fn()
  void f.read(100).then(seen)
  await vi.advanceTimersByTimeAsync(99)
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(f.pending.size).toBe(1)
  expect(seen).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(seen).toHaveBeenCalledWith(undefined)
  expect(f.pending.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('takes time waiting in the serialized queue out of the outcome answer budget', async () => {
  const f = recovery(), held = deferred<void>(), seen = vi.fn()
  const earlier = f.run.socketStep(host.id, () => held.promise)
  void f.read(100).then(seen)
  await vi.advanceTimersByTimeAsync(75)
  held.resolve(); await earlier; await vi.advanceTimersByTimeAsync(0)
  expect(f.send).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(24)
  expect(seen).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(seen).toHaveBeenCalledWith(undefined)
  expect(f.pending.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds a silent outcome after reconnecting just before the restart deadline', async () => {
  const f = recovery(false), seen = vi.fn()
  void f.read(100).then(seen)
  await vi.advanceTimersByTimeAsync(99)
  expect(f.send).not.toHaveBeenCalled()
  f.connect()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(f.pending.size).toBe(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(seen).toHaveBeenCalledWith(undefined)
  expect(f.pending.size).toBe(0)
  expect(f.queued.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('never extends the socket outcome answer deadline when given a larger remaining budget', async () => {
  const f = recovery(), seen = vi.fn()
  void f.client.hostUpdate({ action: 'outcome' }, { timeoutMs: 60_000 }).catch(seen)
  await vi.advanceTimersByTimeAsync(29_999)
  expect(seen).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(seen).toHaveBeenCalledWith(expect.objectContaining({ miss: 'timeout' }))
  expect(f.pending.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps a confirmed rollback arriving just before the deadline', async () => {
  const f = recovery(), result = f.read(100)
  await vi.advanceTimersByTimeAsync(99)
  const rollback = { type: 'update-outcome', running: '9.9.8', restart: { state: 'finished', version: '9.9.9', attempt: 'aaaaaaaa',
    result: { type: 'error', reason: 'update-start-failed', restarted: true } } } as const
  f.answer(rollback)
  expect(await result).toEqual(rollback)
  expect(f.pending.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds the pause before another outcome read by the remaining budget', async () => {
  const f = recovery(), seen = vi.fn()
  vi.spyOn(f.client, 'hostUpdate').mockResolvedValue({ type: 'update-outcome', running: '9.9.8', restart: { state: 'restarting', version: '9.9.9' } })
  void f.read(80).then(seen)
  await vi.advanceTimersByTimeAsync(80)
  expect(seen).toHaveBeenCalledTimes(1)
  expect(f.client.hostUpdate).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('still retries an outcome connection that drops and returns the confirmed rollback', async () => {
  const f = recovery()
  const rollback = { type: 'update-outcome', running: '9.9.8', restart: { state: 'finished', version: '9.9.9',
    result: { type: 'error', reason: 'update-start-failed', restarted: true } } } as const
  vi.spyOn(f.client, 'hostUpdate').mockRejectedValueOnce(new HostUpdateMissed('closed')).mockResolvedValueOnce(rollback)
  const result = f.read(1_000)
  await vi.advanceTimersByTimeAsync(500)
  expect(await result).toEqual(rollback)
  expect(f.client.hostUpdate).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

type Recovering = {
  scheduleReconnect(target: typeof host, active: undefined, droppedAt?: number): void
  restartOnPurpose<T>(target: typeof host, operation: () => Promise<T>, untouched: (result: T) => boolean, reconnect: () => { since?: number; tailnetOnlyMs?: number }): Promise<T>
  runUpdate(id: string, operation: { op: 'update-install'; version: string; file: string; sha256: string }): Promise<unknown>
  retries: Map<string, { since?: number; tailnetOnlyMs?: number; timer?: ReturnType<typeof setTimeout> }>
}
/** A manager with only the reconnect bookkeeping a restart window touches; `open` and `press` are held. */
function reconnecting(status: { phase: string; reconnecting?: boolean } = { phase: 'connecting', reconnecting: true }) {
  const manager = Object.create(DesktopHosts.prototype) as DesktopHosts
  const open = vi.fn(() => new Promise<void>(() => undefined))
  const press = vi.fn(async (_host: unknown, run: (connection: { updateHost(): Promise<unknown> }) => Promise<unknown>) => run({ updateHost: async () => ({ type: 'update-installed' }) }))
  Object.assign(manager, { options: { now: () => Date.now(), retryDelayMs: () => 60_000, router: { setReconnecting: vi.fn(), remove: vi.fn() } },
    saved: [host], status: new Map([[host.id, status]]), live: new Map([[host.id, { via: 'tailnet', up: false }]]), retries: new Map(),
    held: new Map(), restartWindows: new Map(), updatesOverSsh: new Set(), socketSteps: new Map(), listeners: new Set(), closed: false, open, press })
  const run = manager as unknown as Recovering & { restartWindows: Map<string, { since: number; tailnetOnlyMs: number }> }
  dispose.push(async () => { for (const retry of run.retries.values()) clearTimeout(retry.timer) })
  return { run, open, press }
}

it('keeps a later reconnect on the tailnet alone until the restart budget ends, after one that reached the stopping host', () => {
  const f = reconnecting()
  f.run.restartWindows.set(host.id, { since: 1_000, tailnetOnlyMs: 140_000 })
  f.run.scheduleReconnect(host, undefined, 70_000)
  expect(f.run.retries.get(host.id)).toMatchObject({ since: 1_000, tailnetOnlyMs: 140_000 })
  f.run.retries.clear()
  vi.setSystemTime(141_000)
  f.run.scheduleReconnect(host, undefined, 141_000)
  expect(f.run.retries.get(host.id)).toMatchObject({ since: 141_000 })
  expect(f.run.retries.get(host.id)?.tailnetOnlyMs).toBeUndefined()
  expect(f.run.restartWindows.size).toBe(0)
})

it('stops waiting for the first reconnect after a restart at the restart budget, while that connect carries on', async () => {
  const f = reconnecting({ phase: 'connected' }), seen = vi.fn()
  void f.run.restartOnPurpose(host, async () => 'restarting', () => false, () => ({ since: Date.now(), tailnetOnlyMs: 100 })).then(seen)
  await vi.advanceTimersByTimeAsync(99)
  expect(f.open).toHaveBeenCalledTimes(1)
  expect(seen).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(seen).toHaveBeenCalledWith('restarting')
})

it('installs over an admin connection while the tailnet reconnects after a download that fell back to SSH', async () => {
  const f = reconnecting()
  await expect(f.run.runUpdate(host.id, { op: 'update-install', version: '9.9.9', file: 'host.tar.gz', sha256: 'a'.repeat(64) })).resolves.toEqual({ type: 'update-installed' })
  expect(f.press).toHaveBeenCalledTimes(1)
})

it('still refuses an update step for a host that is neither connected nor reconnecting', async () => {
  const f = reconnecting({ phase: 'connecting' })
  await expect(f.run.runUpdate(host.id, { op: 'update-install', version: '9.9.9', file: 'host.tar.gz', sha256: 'a'.repeat(64) })).rejects.toThrow('is not connected')
  expect(f.press).not.toHaveBeenCalled()
})

it('asks again when a quick reconnect reaches the old host before the restart has recorded itself', async () => {
  const f = recovery()
  const rollback = { type: 'update-outcome', running: '9.9.8', restart: { state: 'finished', version: '9.9.9', attempt: 'bbbbbbbb',
    result: { type: 'error', reason: 'update-start-failed', restarted: true } } } as const
  vi.spyOn(f.client, 'hostUpdate').mockResolvedValueOnce({ type: 'update-outcome', running: '9.9.8', restart: { state: 'none' } }).mockResolvedValueOnce(rollback)
  const result = f.read(1_000)
  await vi.advanceTimersByTimeAsync(500)
  expect(await result).toEqual(rollback)
  expect(f.client.hostUpdate).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('ends a restart whose old host never drops within its budget, the reconnect it then starts included', async () => {
  const f = reconnecting({ phase: 'connected' }), seen = vi.fn()
  const socket = { connected: () => true, whenDisconnected: () => new Promise<void>(() => undefined),
    hostUpdate: vi.fn(async (request: { action: string }) => request.action === 'restart' ? { type: 'update-restarting', version: '9.9.9' } : { type: 'update-outcome', running: '9.9.8', restart: { state: 'none' } }) }
  const run = f.run as unknown as { restartOverSocket(target: typeof host, socket: unknown, version: string): Promise<unknown> }
  void run.restartOverSocket(host, socket, '9.9.9').then(seen)
  await vi.advanceTimersByTimeAsync(HOST_UPDATE_RESTART_BUDGET_MS)
  expect(f.open).toHaveBeenCalledTimes(1)
  // The connect never answers; nothing waits for it past the budget.
  await vi.advanceTimersByTimeAsync(1)
  expect(seen).toHaveBeenCalledWith({ went: true, result: undefined })
})

it('installs over an admin connection between reconnect attempts, when no connection is live', async () => {
  const f = reconnecting()
  ;(f.run as unknown as { live: Map<string, unknown> }).live.clear()
  await expect(f.run.runUpdate(host.id, { op: 'update-install', version: '9.9.9', file: 'host.tar.gz', sha256: 'a'.repeat(64) })).resolves.toEqual({ type: 'update-installed' })
  expect(f.press).toHaveBeenCalledTimes(1)
})

it('restarts over an admin connection while the tailnet reconnects, only after an earlier step of the update went over SSH', async () => {
  const restarted = { type: 'update-restarted', ready: { type: 'ready', hostId: 'host-id', pid: 42 } }
  const later = reconnecting({ phase: 'connecting', reconnecting: true, owned: true } as never)
  const run = later.run as unknown as Recovering & { restartForUpdate(id: string, version: string): Promise<unknown>; open: () => Promise<void>; press: unknown }
  run.press = vi.fn(async (_host: unknown, press: (connection: { updateHost(): Promise<unknown> }) => Promise<unknown>) => press({ updateHost: async () => restarted }))
  run.open = vi.fn(async () => undefined)
  await expect(run.restartForUpdate(host.id, '9.9.9')).rejects.toThrow('Connect to Test host')
  await run.runUpdate(host.id, { op: 'update-install', version: '9.9.9', file: 'host.tar.gz', sha256: 'a'.repeat(64) })
  await expect(run.restartForUpdate(host.id, '9.9.9')).resolves.toEqual(restarted)
})
