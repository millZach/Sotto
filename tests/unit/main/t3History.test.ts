// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { T3CodeHost } from '../../../src/main/agents/t3'
import { agentThreadSchema, type AgentHostSnapshot } from '../../../src/shared/agents'

const stamp = '2026-09-11T12:00:00.000Z'
const shellThread = (id: string) => ({ id, projectId: 'project', title: id, updatedAt: stamp,
  modelSelection: { instanceId: 'codex', model: 'test' }, runtimeMode: 'approval-required',
  interactionMode: 'default', latestTurn: null, session: null })
const message = (id: string, text = `History ${id}`) => ({ id: `${id}-message`, role: 'assistant', text, createdAt: stamp })
const detailThread = (id: string) => ({ ...shellThread(id), messages: [message(id)] })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const hosts: T3CodeHost[] = []
afterEach(() => { hosts.splice(0).forEach(host => host.disconnect()); vi.restoreAllMocks(); vi.useRealTimers() })

async function fixture(count = 2) {
  vi.useFakeTimers()
  const host = new T3CodeHost(); hosts.push(host)
  host['connected'] = true
  let shell = { snapshotSequence: 1, projects: [], threads: Array.from({ length: count }, (_, i) => shellThread(String(i))) }
  const overrides = new Map<string, () => Promise<unknown>>()
  const request = vi.spyOn(host as unknown as { request(path: string): Promise<unknown> }, 'request').mockImplementation(async path => {
    const override = overrides.get(path)
    if (override) return override()
    if (path === '/api/orchestration/shell') return shell
    const id = /threads\/([^?]+)\?turnLimit=[15]$/u.exec(path)?.[1]
    if (id) return { thread: detailThread(id) }
    throw new Error(`Unexpected provider mutation/read: ${path}`)
  })
  const rpc = vi.spyOn(host as unknown as { rpc(tag: string, payload: unknown): Promise<unknown> }, 'rpc').mockResolvedValue({ providers: [] })
  const published: AgentHostSnapshot[] = []
  host.subscribe(snapshot => published.push(snapshot))
  await host.snapshot()
  return { host, request, rpc, overrides, published,
    thread: (id = '0') => host['current'].threads.find(thread => thread.id === id)!,
    reads: (id: string) => request.mock.calls.filter(([path]) => path === `/api/orchestration/threads/${id}?turnLimit=5`).length,
    delay: (id: string) => {
      const pending = deferred<unknown>()
      overrides.set(`/api/orchestration/threads/${id}?turnLimit=5`, () => pending.promise)
      return pending
    },
    shell: () => shell,
    setShell: (next: typeof shell) => { shell = next },
    flush: () => vi.advanceTimersByTimeAsync(0),
  }
}

it('starts cold demand synchronously, publishes loading, and deduplicates repeated observation and snapshot', async () => {
  const f = await fixture(), pending = f.delay('0')
  f.host.observeThreads(['0'])
  expect(f.reads('0')).toBe(1)
  expect(f.thread()).toMatchObject({ historyStatus: 'loading', messages: [] })
  for (let i = 0; i < 20; i++) f.host.observeThreads(['0'])
  const snapshot = f.host.snapshot()
  await f.flush()
  expect(f.reads('0')).toBe(1)
  pending.resolve({ thread: detailThread('0') }); await snapshot
  expect(f.thread()).toMatchObject({ historyStatus: 'ready', messages: [message('0')] })
  expect(f.rpc.mock.calls.every(([tag]) => tag === 'server.getConfig')).toBe(true)
})

it.each([50, 150])('loads B independently while A snapshot is delayed beyond %i ms', async ms => {
  const f = await fixture(), pending = f.delay('0')
  f.host.observeThreads(['0'])
  const snapshot = f.host.snapshot()
  await f.flush()
  f.host.observeThreads(['1'])
  expect(f.reads('1')).toBe(1)
  await vi.advanceTimersByTimeAsync(ms)
  expect(f.thread('1').historyStatus).toBe('ready')
  pending.resolve({ thread: detailThread('0') }); await snapshot
  expect(f.thread('1').messages).toEqual([message('1')])
  expect(f.thread('0').messages).toEqual([message('0')])
  expect(f.reads('1')).toBe(1)
})

it('fresh revisit renders cached messages immediately with zero HTTP/RPC reads; stale return revalidates once', async () => {
  const f = await fixture()
  f.host.observeThreads(['0']); await f.flush()
  f.host.observeThreads(['1']); await f.flush()
  const calls = f.request.mock.calls.length, rpcs = f.rpc.mock.calls.length
  f.host.observeThreads(['0'])
  expect(f.thread()).toMatchObject({ historyStatus: 'ready', messages: [message('0')] })
  await f.flush()
  expect(f.request).toHaveBeenCalledTimes(calls)
  expect(f.rpc).toHaveBeenCalledTimes(rpcs)
  f.host.observeThreads(['1']); await vi.advanceTimersByTimeAsync(60_001)
  const pending = f.delay('0')
  f.host.observeThreads(['0']); f.host.observeThreads(['0'])
  expect(f.thread()).toMatchObject({ historyStatus: 'loading', messages: [message('0')] })
  expect(f.reads('0')).toBe(2)
  pending.resolve({ thread: { ...detailThread('0'), messages: [message('0', 'Updated')] } }); await f.flush()
  expect(f.thread().messages[0]?.text).toBe('Updated')
})

it('distinguishes successful empty history from loading and local error, and refresh retries', async () => {
  const f = await fixture(), pending = f.delay('0')
  f.host.observeThreads(['0'])
  expect(f.thread().historyStatus).toBe('loading')
  pending.reject(new Error('History unavailable')); await f.flush()
  expect(f.thread()).toMatchObject({ historyStatus: 'error', historyError: 'History unavailable', messages: [] })
  expect(f.host['current'].connected).toBe(true)
  const calls = f.reads('0')
  for (let i = 0; i < 20; i++) f.host.observeThreads(['0'])
  await vi.advanceTimersByTimeAsync(10_000)
  expect(f.reads('0')).toBe(calls)
  f.overrides.set('/api/orchestration/threads/0?turnLimit=5', async () => ({ thread: { ...shellThread('0'), messages: [] } }))
  await f.host.snapshot()
  expect(f.thread()).toMatchObject({ historyStatus: 'ready', messages: [] })
  expect(f.thread()).not.toHaveProperty('historyError')
  const legacy = { ...f.thread() }
  delete legacy.historyStatus
  expect(agentThreadSchema.parse(legacy)).not.toHaveProperty('historyStatus')
})

it('keeps cached messages on refresh failure without retaining stale permission activities', async () => {
  const f = await fixture()
  f.overrides.set('/api/orchestration/threads/0?turnLimit=5', async () => ({ thread: { ...detailThread('0'), activities: [{
    id: 'activity', kind: 'approval.requested', summary: 'Permission', createdAt: stamp, payload: { requestId: 'permission' },
  }] } }))
  f.host.observeThreads(['0']); await f.flush()
  expect(f.thread().requests).toHaveLength(1)
  f.host.observeThreads(['1']); await f.flush()
  expect(f.thread().requests).toEqual([])
  f.host.observeThreads(['0'])
  expect(f.thread()).toMatchObject({ historyStatus: 'ready', requests: [], messages: [message('0')] })
  f.overrides.set('/api/orchestration/threads/0?turnLimit=5', async () => { throw new Error('Unavailable') })
  await f.host.snapshot()
  expect(f.thread()).toMatchObject({ historyStatus: 'error', requests: [], messages: [message('0')] })
})

it('does not promote late A activities after A -> B -> A, or issue a duplicate A read', async () => {
  const f = await fixture(), pending = f.delay('0')
  f.host.observeThreads(['0']); f.host.observeThreads(['1']); f.host.observeThreads(['0'])
  pending.resolve({ thread: { ...detailThread('0'), activities: [{ id: 'a', kind: 'approval.requested', summary: 'Stale', createdAt: stamp, payload: { requestId: 'p' } }] } })
  await f.flush()
  expect(f.reads('0')).toBe(1)
  expect(f.thread()).toMatchObject({ historyStatus: 'ready', requests: [], messages: [message('0')] })
})

it('coalesces push invalidations during a pending snapshot into one drain, then stops', async () => {
  const f = await fixture(), pending = f.delay('0')
  f.host.observeThreads(['0'])
  const snapshot = f.host.snapshot(); await f.flush()
  for (let i = 0; i < 100; i++) f.host['scheduleRefresh']()
  pending.resolve({ thread: detailThread('0') }); await snapshot; await f.flush()
  expect(f.request.mock.calls.filter(([path]) => path === '/api/orchestration/shell')).toHaveLength(3)
  const calls = f.request.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.request).toHaveBeenCalledTimes(calls)
})

it('retries a failed B immediately even while the snapshot is waiting for A', async () => {
  const f = await fixture(), pending = f.delay('0')
  f.host.observeThreads(['0'])
  const first = f.host.snapshot(); await f.flush()
  f.overrides.set('/api/orchestration/threads/1?turnLimit=5', async () => { throw new Error('Try again') })
  f.host.observeThreads(['1']); await f.flush()
  expect(f.thread('1').historyStatus).toBe('error')
  f.overrides.delete('/api/orchestration/threads/1?turnLimit=5')
  const retry = f.host.snapshot(); await f.flush()
  expect(f.thread('1').historyStatus).toBe('ready')
  expect(f.reads('1')).toBe(2)
  pending.resolve({ thread: detailThread('0') }); await Promise.all([first, retry])
})

it('drains selection made before a pending shell reveals its ID', async () => {
  const f = await fixture(), pending = deferred<unknown>()
  f.overrides.set('/api/orchestration/shell', () => pending.promise)
  const snapshot = f.host.snapshot()
  f.host.observeThreads(['new'])
  pending.resolve({ ...f.shell(), snapshotSequence: 2, threads: [...f.shell().threads, shellThread('new')] })
  await snapshot; await f.flush()
  expect(f.thread('new')).toMatchObject({ historyStatus: 'ready', messages: [message('new')] })
  const calls = f.request.mock.calls.length
  await vi.advanceTimersByTimeAsync(10_000)
  expect(f.request).toHaveBeenCalledTimes(calls)
})

it('does not refetch demand completed while an older shell GET was pending', async () => {
  const f = await fixture(), shell = deferred<unknown>()
  f.overrides.set('/api/orchestration/shell', () => shell.promise)
  const snapshot = f.host.snapshot()
  f.host.observeThreads(['1']); await f.flush()
  expect(f.thread('1').historyStatus).toBe('ready')
  shell.resolve(f.shell()); await snapshot
  expect(f.reads('1')).toBe(1)
})

it('an explicit snapshot joining older work revalidates warm observation before returning authority', async () => {
  const f = await fixture()
  f.host.observeThreads(['1']); await f.flush()
  const old = f.delay('0')
  f.host.observeThreads(['0'])
  const first = f.host.snapshot(); await f.flush()
  f.host.observeThreads(['1'])
  expect(f.reads('1')).toBe(1)
  const fresh = f.delay('1')
  let returned = false
  const authority = f.host.snapshot().then(() => { returned = true })
  expect(f.reads('1')).toBe(2)
  old.resolve({ thread: detailThread('0') }); await first; await f.flush()
  expect(returned).toBe(false)
  fresh.resolve({ thread: detailThread('1') }); await authority
  expect(f.thread('1').historyStatus).toBe('ready')
})

it.each(['resolve', 'reject'] as const)('discards old connection %s without clearing newer same-ID demand', async outcome => {
  const f = await fixture(), old = f.delay('0')
  f.host.observeThreads(['0'])
  const oldSnapshot = f.host.snapshot().catch(() => undefined); await f.flush()
  f.host.disconnect()
  expect(f.host['current'].threads).toEqual([])
  f.host['connected'] = true
  const fresh = f.delay('0')
  const newSnapshot = f.host.snapshot(); await f.flush()
  if (outcome === 'resolve') old.resolve({ thread: { ...detailThread('0'), messages: [message('0', 'Old connection')] } })
  else old.reject(new Error('Old connection error'))
  await oldSnapshot; await f.flush()
  expect(f.thread().historyStatus).toBe('loading')
  fresh.resolve({ thread: { ...detailThread('0'), messages: [message('0', 'New connection')] } })
  await newSnapshot
  expect(f.thread()).toMatchObject({ historyStatus: 'ready', messages: [message('0', 'New connection')] })
})

it('bounds inactive history to 12 entries and expires it lazily without fetching thousands of shell rows', async () => {
  const f = await fixture(2_000)
  expect(f.request).toHaveBeenCalledTimes(1)
  for (let i = 0; i < 16; i++) { f.host.observeThreads([String(i)]); await f.flush() }
  expect(f.host['history'].size).toBe(13)
  expect(f.host['history'].has('0')).toBe(false)
  expect(f.host['history'].has('3')).toBe(true)
  const calls = f.request.mock.calls.length
  f.host.observeThreads(['3']); await f.flush()
  expect(f.request).toHaveBeenCalledTimes(calls)
  f.host.observeThreads([])
  await vi.advanceTimersByTimeAsync(600_001)
  await f.host.snapshot()
  expect(f.host['history'].size).toBe(0)
  expect(f.request.mock.calls.filter(([path]) => path.includes('/threads/'))).toHaveLength(16)
})

it('enforces the byte budget and drops an oversized transcript once inactive', async () => {
  const f = await fixture(8)
  for (let i = 0; i < 6; i++) {
    f.overrides.set(`/api/orchestration/threads/${i}?turnLimit=5`, async () => ({ thread: { ...detailThread(String(i)), messages: [message(String(i), 'x'.repeat(2 * 1024 * 1024))] } }))
    f.host.observeThreads([String(i)]); await f.flush()
  }
  expect([...f.host['history']].filter(([id]) => id !== '5').reduce((sum, [, entry]) => sum + entry.bytes, 0)).toBeLessThanOrEqual(8 * 1024 * 1024)
  f.overrides.set('/api/orchestration/threads/7?turnLimit=5', async () => ({ thread: { ...detailThread('7'), messages: [message('7', 'x'.repeat(9 * 1024 * 1024))] } }))
  f.host.observeThreads(['7']); await f.flush()
  expect(f.thread('7').historyStatus).toBe('ready')
  f.host.observeThreads([])
  expect(f.host['history'].has('7')).toBe(false)
})

it('caps outstanding detail transport at four and drops obsolete queued navigation', async () => {
  const f = await fixture(50)
  const pending = Array.from({ length: 50 }, (_, i) => f.delay(String(i)))
  for (let i = 0; i < 50; i++) f.host.observeThreads([String(i)])
  expect(f.request.mock.calls.filter(([path]) => path.includes('/threads/'))).toHaveLength(4)
  expect(f.host['detailQueue'].size).toBe(1)
  pending[0]!.resolve({ thread: detailThread('0') }); await f.flush()
  expect(f.reads('49')).toBe(1)
  for (let i = 1; i < 50; i++) pending[i]!.resolve({ thread: detailThread(String(i)) })
  await f.flush()
  expect(f.thread('49').historyStatus).toBe('ready')
  expect(f.request.mock.calls.filter(([path]) => path.includes('/threads/'))).toHaveLength(5)
})

it('preserves five-turn coverage during a guarded one-turn takeover read and never dispatches', async () => {
  const f = await fixture()
  f.overrides.set('/api/orchestration/threads/0?turnLimit=5', async () => ({ thread: { ...detailThread('0'), messages: [message('old'), message('0')] } }))
  f.host.observeThreads(['0']); await f.flush()
  f.overrides.set('/api/orchestration/threads/0?turnLimit=1', async () => ({ thread: { ...detailThread('0'), messages: [{ ...message('user'), role: 'user' }] } }))
  await expect(f.host.execute({ type: 'send', threadId: '0', commandId: 'command', messageId: 'new', text: 'Never sent', expectedLastUserMessageId: 'prior' })).rejects.toThrow('The thread changed')
  expect(f.thread().messages.map(item => item.id)).toEqual(['old-message', '0-message', 'user-message'])
  expect(f.thread().historyStatus).toBe('ready')
  expect(f.request.mock.calls.some(([path]) => path.includes('/dispatch'))).toBe(false)
})

it('rejects an already-resolved permission using a fresh guarded read even with cached history', async () => {
  const f = await fixture()
  f.host.observeThreads(['0']); await f.flush()
  await expect(f.host.execute({ type: 'answer', threadId: '0', commandId: 'command', requestId: 'stale', answer: '', approved: true })).rejects.toThrow('no longer pending')
  expect(f.reads('0')).toBe(2)
  expect(f.request.mock.calls.some(([path]) => path.includes('/dispatch'))).toBe(false)
})

it('an older pending detail response cannot replace a newer guarded read with stale permission activities', async () => {
  const f = await fixture(), pending = f.delay('0')
  f.host.observeThreads(['0'])
  f.overrides.set('/api/orchestration/threads/0?turnLimit=1', async () => ({ thread: { ...detailThread('0'), messages: [{ ...message('user'), role: 'user' }], activities: [] } }))
  await expect(f.host.execute({ type: 'send', threadId: '0', commandId: 'command', messageId: 'new', text: 'Never sent', expectedLastUserMessageId: 'prior' })).rejects.toThrow('The thread changed')
  pending.resolve({ thread: { ...detailThread('0'), activities: [{ id: 'a', kind: 'approval.requested', summary: 'Old permission', createdAt: stamp, payload: { requestId: 'old' } }] } })
  await f.flush()
  expect(f.thread().requests).toEqual([])
  expect(f.thread().messages.map(item => item.id)).toEqual(['0-message', 'user-message'])
})

it('ignores a regressing shell sequence without rolling back lifecycle metadata', async () => {
  const f = await fixture()
  f.setShell({ ...f.shell(), snapshotSequence: 10, threads: [{ ...shellThread('0'), title: 'Newest' }] })
  await f.host.snapshot()
  f.setShell({ ...f.shell(), snapshotSequence: 9, threads: [shellThread('0')] })
  await f.host.snapshot()
  expect(f.thread().title).toBe('Newest')
})
