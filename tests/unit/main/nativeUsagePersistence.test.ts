// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeUsage } from '../../../src/main/agents/nativeUsage'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import type { ThreadUsage } from '../../../src/shared/threadUsage'

type Archive = Record<string, { view: ThreadUsage; entries: Record<string, unknown> }>
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture(provider: 'claude' | 'codex' | 'grok' = 'claude') {
  const root = await mkdtemp(join(tmpdir(), 'sotto-usage-writes-')); roots.push(root)
  const usage = new NativeUsage(root, provider)
  await usage.load()
  return { root, usage }
}
function frame(index: number, output = 100) {
  return { type: 'assistant', timestamp: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(), message: {
    id: `message-${index}`, model: 'claude-sonnet-4-6', usage: {
      input_tokens: 1000, output_tokens: output, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0,
    },
  } }
}
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it('does no archive writes or total recomputation for 100 identical historical frames among 100 entries', async () => {
  const { usage } = await fixture()
  const write = vi.spyOn(AtomicJsonStore.prototype, 'writeSerialized').mockResolvedValue(undefined)
  for (let i = 0; i < 100; i++) usage.claude('thread', frame(i))
  await usage.flushed()
  expect(write).toHaveBeenCalledTimes(1)
  const view = structuredClone(usage.get('thread'))
  const total = usage.get('thread')!.total
  write.mockClear()
  for (let i = 0; i < 100; i++) usage.claude('thread', frame(0))
  await usage.flushed()
  expect(write).not.toHaveBeenCalled()
  expect(usage.get('thread')).toEqual(view)
  expect(usage.get('thread')!.total).toBe(total)
  expect(total).toEqual({ input: 300_000, output: 10_000, cached: 200_000 })
})

it('skips repeated latest frames, stream deltas, elapsed results and compaction snapshots', async () => {
  const { usage } = await fixture()
  const write = vi.spyOn(AtomicJsonStore.prototype, 'writeSerialized').mockResolvedValue(undefined)
  const message = frame(0).message
  usage.claude('thread', { type: 'stream_event', event: { type: 'message_start', message } })
  usage.elapsed('thread', 12, 200_000)
  await usage.flushed()
  const view = structuredClone(usage.get('thread'))
  write.mockClear()
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01'))
  for (let i = 0; i < 100; i++) {
    usage.claude('thread', { type: 'assistant', message })
    usage.claude('thread', { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 100 } } })
    usage.elapsed('thread', 12, 200_000)
  }
  await usage.flushed()
  expect(write).not.toHaveBeenCalled()
  expect(usage.get('thread')).toEqual(view)
  usage.compacted('thread', 500, '2026-10-01T00:00:00Z')
  await usage.flushed(); write.mockClear()
  usage.compacted('thread', 500, '2026-10-01T00:00:00Z')
  usage.claude('thread', { type: 'assistant', message })
  await usage.flushed()
  expect(write).not.toHaveBeenCalled()
  expect(usage.get('thread')!.contextUsed).toBe(500)
})

it('saves changed history and metadata even when the latest request counters stay the same', async () => {
  const { usage, root } = await fixture()
  usage.claude('thread', frame(1))
  usage.claude('thread', frame(0))
  await usage.flushed()
  usage.claude('thread', frame(0, 200))
  usage.elapsed('thread', 321, 1_000_000)
  await usage.flushed()
  const reopened = new NativeUsage(root, 'claude'); await reopened.load(); await reopened.flushed()
  expect(reopened.get('thread')).toMatchObject({ total: { output: 300 }, latest: { output: 100 }, elapsedMs: 321, contextWindow: 1_000_000 })
  expect(reopened.get('thread')).toEqual(usage.get('thread'))
})

it('skips an unchanged unidentified Grok observation without turning it into a priced request', async () => {
  const { usage } = await fixture('grok')
  const write = vi.spyOn(AtomicJsonStore.prototype, 'writeSerialized').mockResolvedValue(undefined)
  const value = { update: { sessionUpdate: 'turn_completed', usage: { inputTokens: 1000, outputTokens: 100, apiDurationMs: 12 } } }
  usage.grok('thread', 'grok-4.6-build', value); await usage.flushed()
  const view = structuredClone(usage.get('thread'))
  write.mockClear()
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01'))
  for (let i = 0; i < 100; i++) usage.grok('thread', 'grok-4.6-build', value)
  await usage.flushed()
  expect(write).not.toHaveBeenCalled()
  expect(usage.get('thread')).toEqual(view)
  expect(view).toMatchObject({ partial: true, latest: { output: 100 } })
  expect(view!.estimatedUsd).toBeUndefined()
})

it('holds one immutable in-flight archive and coalesces 100 changing observations into one latest archive', async () => {
  const { usage } = await fixture()
  const first = deferred(), second = deferred()
  const write = vi.spyOn(AtomicJsonStore.prototype, 'writeSerialized').mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
  usage.claude('a', frame(0))
  await Promise.resolve()
  expect(write).toHaveBeenCalledTimes(1)
  const snapshot = JSON.parse(write.mock.calls[0]![0]) as Archive
  let drained = false
  const drain = usage.flushed().then(() => { drained = true })
  for (let i = 1; i <= 100; i++) usage.claude(i % 2 ? 'a' : 'b', frame(i))
  expect(write).toHaveBeenCalledTimes(1)
  expect(Object.keys(snapshot)).toEqual(['a'])
  expect(Object.keys(snapshot.a!.entries)).toHaveLength(1)
  expect(usage.get('a')!.total!.output).toBe(5100)
  first.resolve()
  await Promise.resolve()
  expect(write).toHaveBeenCalledTimes(2)
  expect(drained).toBe(false)
  const latest = JSON.parse(write.mock.calls[1]![0]) as Archive
  expect(latest.a!.view.total!.output).toBe(5100)
  expect(latest.b!.view.total!.output).toBe(5000)
  second.resolve(); await drain
  expect(drained).toBe(true)
  expect(write).toHaveBeenCalledTimes(2)
})

it.each(['claude', 'codex', 'grok'] as const)('keeps %s replay deduplication and retries a failed save on an unchanged observation', async provider => {
  const { usage, root } = await fixture(provider)
  const observe = () => {
    if (provider === 'claude') usage.claude('thread', frame(0))
    if (provider === 'codex') usage.codex('thread', 'gpt-6-astra', { turnId: 'turn', tokenUsage: {
      total: { inputTokens: 1000, outputTokens: 100 }, last: { inputTokens: 1000, outputTokens: 100 },
    } })
    if (provider === 'grok') usage.grok('thread', 'grok-4.6-build', { update: { sessionUpdate: 'turn_completed', prompt_id: 'turn', usage: {
      inputTokens: 1000, outputTokens: 100, costUsdTicks: 1_000_000,
    } } })
  }
  const write = vi.spyOn(AtomicJsonStore.prototype, 'writeSerialized').mockRejectedValueOnce(new Error('Disk unavailable'))
  observe(); await usage.flushed()
  expect(write).toHaveBeenCalledTimes(1)
  expect(usage.get('thread')!.persistenceError).toBe(true)
  const total = usage.get('thread')!.total
  observe(); await usage.flushed()
  expect(write).toHaveBeenCalledTimes(2)
  expect(usage.get('thread')!.persistenceError).toBeUndefined()
  expect(usage.get('thread')!.total).toEqual(total)
  const reopened = new NativeUsage(root, provider); await reopened.load(); await reopened.flushed()
  expect(reopened.get('thread')).toEqual(usage.get('thread'))
  expect(JSON.parse(await readFile(join(root, `${provider}-usage.json`), 'utf8')).thread.view.persistenceError).toBeUndefined()
  write.mockClear(); observe(); await usage.flushed()
  expect(write).not.toHaveBeenCalled()
})

it('keeps failures visible across threads until the latest changed totals are saved, and drains changes arriving during a failed write', async () => {
  const { usage } = await fixture()
  const first = deferred(), retry = deferred(), latest = deferred()
  const write = vi.spyOn(AtomicJsonStore.prototype, 'writeSerialized')
    .mockImplementationOnce(() => first.promise).mockImplementationOnce(() => retry.promise).mockImplementationOnce(() => latest.promise)
  usage.claude('a', frame(0)); usage.claude('b', frame(0))
  const drain = usage.flushed()
  await Promise.resolve()
  usage.claude('b', frame(1))
  first.reject(new Error('Disk unavailable')); await Promise.resolve()
  expect(usage.get('a')!.persistenceError).toBe(true)
  expect(usage.get('b')!.persistenceError).toBe(true)
  usage.claude('b', frame(2))
  retry.resolve(); await Promise.resolve()
  expect(usage.get('a')!.persistenceError).toBeUndefined()
  expect(usage.get('b')!.persistenceError).toBe(true)
  latest.resolve(); await drain
  expect(write).toHaveBeenCalledTimes(3)
  expect(usage.get('b')).toMatchObject({ total: { output: 300 } })
  expect(usage.get('b')!.persistenceError).toBeUndefined()
})

it('bounds retries on permanent failure and keeps unsaved data on reconnect until a later shutdown drain succeeds', async () => {
  const { usage, root } = await fixture()
  usage.claude('thread', frame(0)); await usage.flushed()
  const write = vi.spyOn(AtomicJsonStore.prototype, 'writeSerialized').mockRejectedValue(new Error('Disk unavailable'))
  usage.claude('thread', frame(1)); await usage.flushed()
  expect(write).toHaveBeenCalledTimes(1)
  await usage.flushed()
  expect(write).toHaveBeenCalledTimes(2)
  await usage.load()
  expect(write).toHaveBeenCalledTimes(3)
  expect(usage.get('thread')).toMatchObject({ total: { output: 200 }, persistenceError: true })
  write.mockRestore()
  await usage.flushed()
  const reopened = new NativeUsage(root, 'claude'); await reopened.load(); await reopened.flushed()
  expect(reopened.get('thread')).toMatchObject({ total: { output: 200 } })
  expect(reopened.get('thread')!.persistenceError).toBeUndefined()
})

it('reports a failed repricing migration and retries it through the same drain', async () => {
  const { root } = await fixture()
  await writeFile(join(root, 'claude-usage.json'), JSON.stringify({ thread: {
    view: { rateVersions: [], partial: true, updatedAt: '2026-09-01T00:00:00Z' }, seen: [], incomplete: false,
    entries: { old: { model: 'claude-sonnet-4-6', tokens: { input: 1000, output: 100, cached: 0, cacheWrite: 0 }, rate: 'old' } },
  } }))
  const write = vi.spyOn(AtomicJsonStore.prototype, 'writeSerialized').mockRejectedValueOnce(new Error('Disk unavailable'))
  const usage = new NativeUsage(root, 'claude'); await usage.load(); await usage.flushed()
  expect(usage.get('thread')).toMatchObject({ persistenceError: true, total: { output: 100 } })
  await usage.flushed()
  expect(write).toHaveBeenCalledTimes(2)
  expect(usage.get('thread')!.persistenceError).toBeUndefined()
})

it('writes a streaming reply at most once an interval, and the end of its turn at once, without copying the ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-usage-writes-')); roots.push(root)
  const usage = new NativeUsage(root, 'claude', 1000); await usage.load()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const write = vi.spyOn(AtomicJsonStore.prototype, 'writeSerialized').mockResolvedValue(undefined)
  const clone = vi.spyOn(globalThis, 'structuredClone')
  const message = { ...frame(0).message, id: 'streamed', usage: { ...frame(0).message.usage, output_tokens: 0 } }
  const written = (call: number) => (JSON.parse(write.mock.calls[call]![0]) as Archive).thread!.entries.streamed as { tokens: { output: number } }
  usage.claude('thread', { type: 'stream_event', event: { type: 'message_start', message } })
  await vi.advanceTimersByTimeAsync(0)
  expect(write).toHaveBeenCalledTimes(1)
  // Half a second of a streaming reply reporting its output on every frame.
  for (let i = 1; i <= 50; i++) {
    usage.claude('thread', { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: i * 10 } } })
    await vi.advanceTimersByTimeAsync(10)
  }
  expect(write).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(500)
  expect(write).toHaveBeenCalledTimes(2)
  expect(written(1).tokens.output).toBe(500)
  usage.claude('thread', { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 600 } } })
  usage.claudeResult('thread', { duration_ms: 1234 })
  await vi.advanceTimersByTimeAsync(0)
  expect(write).toHaveBeenCalledTimes(3)
  expect(written(2).tokens.output).toBe(600)
  expect(usage.get('thread')!.elapsedMs).toBe(1234)
  expect(clone).not.toHaveBeenCalled()
  await usage.flushed()
  expect(write).toHaveBeenCalledTimes(3)
})

it('drains a write the interval is still holding back when the adapter closes', async () => {
  const { usage, root } = await fixture()
  usage.claude('thread', frame(0)); await usage.flushed()
  usage.claude('thread', frame(1))
  await usage.flushed()
  const reopened = new NativeUsage(root, 'claude'); await reopened.load(); await reopened.flushed()
  expect(reopened.get('thread')).toMatchObject({ total: { output: 200 } })
})
