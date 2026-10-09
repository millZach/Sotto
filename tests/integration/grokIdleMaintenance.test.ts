// @vitest-environment node
import { deferred } from '../fixtures/deferred'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { SessionReaper } from '../../src/main/agents/sessionReaper'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'

type Request = (method: string, params: unknown, accept: (value: unknown) => unknown) => Promise<unknown>

it('does not enroll an unloaded unconfirmed session when its durable history is read', async () => {
  let now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const f = await grokFixture(undefined, undefined, 60_000, { reaperSweepMs: 60_000, sessionIdleMs: 150 })
  const id = randomUUID()
  try {
    await f.host.connect()
    expect(await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic project', path: f.root })).toEqual({ accepted: true })
    await f.script({ rejectModel: true })
    await expect(f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Synthetic unconfirmed thread' })).rejects.toThrow('rejected')
    f.adapter.disconnect(); await f.adapter.closed()
    await f.host.connect()
    const reaper = (f.adapter as unknown as { reaper: SessionReaper }).reaper
    expect(reaper.tracked()).toEqual([])
    await f.action(id, { type: 'activity', notify: false, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Synthetic archived update' } } })
    await expect.poll(async () => (await f.adapter.refreshThread(id)).threads.find(thread => thread.id === id)?.messages.some(message => message.text === 'Synthetic archived update')).toBe(true)
    expect(await f.sessions.starts(id)).toBe(0)
    expect(reaper.tracked()).toEqual([])
    now += 150
    await reaper.sweep()
    expect((await f.driver.requests()).filter(frame => frame.method === '_x.ai/session/close')).toHaveLength(0)
  } finally { vi.restoreAllMocks(); await f.cleanup() }
})

it.each(['history', 'refresh'] as const)('keeps the full idle window after actual %s activity', async activity => {
  let now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const f = await grokFixture(undefined, undefined, 60_000, { reaperSweepMs: 60_000, sessionIdleMs: 150 })
  const id = randomUUID()
  try {
    await f.host.connect()
    const reaper = (f.adapter as unknown as { reaper: SessionReaper }).reaper
    expect(await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic project', path: f.root })).toEqual({ accepted: true })
    expect(await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Synthetic idle thread' })).toEqual({ accepted: true })
    now += 1_000
    if (activity === 'history') {
      // Durable-only provider activity cannot rely on the live notification's existing touch.
      await f.action(id, { type: 'activity', notify: false, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Synthetic durable update' } } })
      await expect.poll(async () => {
        await f.adapter.pollHistory()
        return (await f.host.snapshot()).threads.find(thread => thread.id === id)?.messages.some(message => message.text === 'Synthetic durable update')
      }).toBe(true)
    } else await f.adapter.refreshThread(id)
    await reaper.sweep()
    expect(await f.sessions.stopped(id)).toBe(false)
    now += 149
    await f.adapter.pollHistory()
    await reaper.sweep()
    expect(await f.sessions.stopped(id)).toBe(false)
    now += 1
    await reaper.sweep()
    expect(await f.sessions.stopped(id)).toBe(true)
  } finally { vi.restoreAllMocks(); await f.cleanup() }
})

it('does not renew idle age through recurring empty Grok history reads', async () => {
  let now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const f = await grokFixture(undefined, undefined, 60_000, { reaperSweepMs: 60_000, sessionIdleMs: 150 })
  const id = randomUUID()
  let reading: Promise<void> | undefined
  let gate: { entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | undefined
  try {
    await f.host.connect()
    const owned = f.adapter as unknown as { processes: Map<string, { rpc: { request: Request } }>; reaper: SessionReaper; historyReads: Map<string, Promise<void>> }
    expect(await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Synthetic project', path: f.root })).toEqual({ accepted: true })
    expect(await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Synthetic idle thread' })).toEqual({ accepted: true })
    // Each thread session has its own Grok process, and its history is read there.
    const rpc = owned.processes.get(id)!.rpc
    const request = rpc.request.bind(rpc)
    vi.spyOn(rpc, 'request').mockImplementation(async (method, params, accept) => {
      if (method === '_x.ai/session/updates' && gate) {
        gate.entered.resolve()
        await gate.release.promise
      }
      return request(method, params, accept)
    })
    // Empty maintenance overlaps every sweep for eighty idle windows; no user/provider activity occurs.
    for (let cycle = 0; cycle < 600; cycle++) {
      gate = { entered: deferred<void>(), release: deferred<void>() }
      reading = f.adapter.pollHistory()
      await gate.entered.promise
      expect(owned.historyReads.has(id)).toBe(true)
      now += 20
      await owned.reaper.sweep()
      expect(owned.reaper.tracked()).toContain(id)
      gate.release.resolve()
      await reading
      expect(owned.historyReads.has(id)).toBe(false)
    }
    expect((await f.driver.requests()).filter(frame => frame.method === '_x.ai/session/close')).toHaveLength(0)
    // Once a sweep sees the settled read, the original idle age still applies: no extra quiet window.
    await owned.reaper.sweep()
    expect(await f.sessions.stopped(id)).toBe(true)
  } finally {
    gate?.release.resolve()
    await reading?.catch(() => undefined)
    vi.restoreAllMocks()
    await f.cleanup()
  }
})
