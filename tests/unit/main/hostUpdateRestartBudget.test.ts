// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DesktopHosts } from '../../../src/main/hosts/desktopHosts'
import { HostUpdateMissed, SocketHostService } from '../../../src/main/agents/socketHostService'
import type { HostUpdateAnswer } from '../../../src/shared/hostSelfUpdate'
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
