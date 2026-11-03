// @vitest-environment node
import * as fs from 'node:fs/promises'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeUsage } from '../../../src/main/agents/nativeUsage'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import type { ThreadUsage } from '../../../src/shared/threadUsage'
import { deferred } from '../../fixtures/deferred'
import { savedUsageLedgers } from '../../fixtures/usageLedgerFiles'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof fs>() }))

type Archive = Record<string, { view: ThreadUsage; entries: Record<string, unknown> }>
/** A write hands the store the file's text, or its encoded pieces (#1451). */
const writtenText = (written: string | readonly Uint8Array[]): string => typeof written === 'string' ? written : Buffer.concat(written).toString('utf8')
/** The ledgers the given writes carried, by thread: each changed thread's ledger is written to a file of its own (#555). */
const writtenLedgers = (calls: readonly (readonly unknown[])[]): Archive => Object.fromEntries(calls.map(([written]) => {
  const file = JSON.parse(writtenText(written as string | readonly Uint8Array[])) as { id: string; ledger: Archive[string] }
  return [file.id, file.ledger]
}))
/** Every thread's saved ledger under `root`, as the next start reads them. */
const savedLedgers = async (root: string, provider: 'claude' | 'codex' | 'grok' = 'claude'): Promise<Archive> => await savedUsageLedgers(root, provider) as Archive
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
  expect(total).toEqual({ input: 300_000, output: 10_000, cached: 200_000, cacheWrite: 0 })
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
  // The first write, of thread a, is held; the next carries both threads, each to its own file.
  const write = vi.spyOn(AtomicJsonStore.prototype, 'writeSerialized').mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise).mockImplementationOnce(() => second.promise)
  usage.claude('a', frame(0))
  await Promise.resolve()
  expect(write).toHaveBeenCalledTimes(1)
  const snapshot = writtenLedgers(write.mock.calls)
  let drained = false
  const drain = usage.flushed().then(() => { drained = true })
  for (let i = 1; i <= 100; i++) usage.claude(i % 2 ? 'a' : 'b', frame(i))
  expect(write).toHaveBeenCalledTimes(1)
  expect(Object.keys(snapshot)).toEqual(['a'])
  expect(Object.keys(snapshot.a!.entries)).toHaveLength(1)
  expect(usage.get('a')!.total!.output).toBe(5100)
  first.resolve()
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(3))
  expect(drained).toBe(false)
  const latest = writtenLedgers(write.mock.calls.slice(1))
  expect(latest.a!.view.total!.output).toBe(5100)
  expect(latest.b!.view.total!.output).toBe(5000)
  second.resolve(); await drain
  expect(drained).toBe(true)
  expect(write).toHaveBeenCalledTimes(3)
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
  expect((await savedLedgers(root, provider)).thread!.view.persistenceError).toBeUndefined()
  write.mockClear(); observe(); await usage.flushed()
  expect(write).not.toHaveBeenCalled()
})

it('keeps failures visible across threads until the latest changed totals are saved, and drains changes arriving during a failed write', async () => {
  const { usage } = await fixture()
  const first = deferred(), retry = deferred(), latest = deferred()
  // Each thread's ledger is a write of its own: both threads fail, both are retried, then b alone is written once more.
  const write = vi.spyOn(AtomicJsonStore.prototype, 'writeSerialized')
    .mockImplementationOnce(() => first.promise).mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => retry.promise).mockImplementationOnce(() => retry.promise).mockImplementationOnce(() => latest.promise)
  usage.claude('a', frame(0)); usage.claude('b', frame(0))
  const drain = usage.flushed()
  await Promise.resolve()
  usage.claude('b', frame(1))
  first.reject(new Error('Disk unavailable'))
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(4))
  expect(usage.get('a')!.persistenceError).toBe(true)
  expect(usage.get('b')!.persistenceError).toBe(true)
  usage.claude('b', frame(2))
  retry.resolve()
  await vi.waitFor(() => expect(usage.get('a')!.persistenceError).toBeUndefined())
  expect(usage.get('b')!.persistenceError).toBe(true)
  latest.resolve(); await drain
  expect(write).toHaveBeenCalledTimes(5)
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
  const usage = new NativeUsage(root, 'claude'); await usage.load()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const write = vi.spyOn(AtomicJsonStore.prototype, 'writeSerialized').mockResolvedValue(undefined)
  const clone = vi.spyOn(globalThis, 'structuredClone')
  const message = { ...frame(0).message, id: 'streamed', usage: { ...frame(0).message.usage, output_tokens: 0 } }
  const written = (call: number) => writtenLedgers([write.mock.calls[call]!]).thread!.entries.streamed as { tokens: { output: number } }
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

// A ledger is written about once a second while a reply streams. Only the thread that changed is serialized again
// (October 19, 2026), and only its file is written (#555).
it('serializes and writes only the ledgers that changed since the last write', async () => {
  const { root, usage } = await fixture()
  for (let thread = 0; thread < 30; thread++) for (let entry = 0; entry < 5; entry++) usage.claude(`thread-${thread}`, frame(entry))
  await usage.flushed()
  const stringify = vi.spyOn(JSON, 'stringify'), write = vi.spyOn(AtomicJsonStore.prototype, 'writeSerialized')
  usage.claude('thread-7', frame(9, 300))
  await usage.flushed()
  const ledgers = stringify.mock.calls.filter(([value]) => typeof value === 'object' && value !== null && 'entries' in value && 'view' in value)
  stringify.mockRestore()
  expect(ledgers).toHaveLength(1)
  expect(Object.keys(writtenLedgers(write.mock.calls))).toEqual(['thread-7'])
  const saved = await savedLedgers(root)
  expect(Object.keys(saved)).toHaveLength(30)
  expect(saved['thread-7']!.entries['message-9']).toBeDefined()
})

it('moves the ledgers an earlier build kept in one file into files of their own, and removes that file once all are', async () => {
  const { root, usage } = await fixture()
  for (let thread = 0; thread < 3; thread++) usage.claude(`thread-${thread}`, frame(thread))
  await usage.flushed()
  const saved = await savedLedgers(root)
  // As an earlier build left it: every ledger in the one file, and none of its own.
  await rm(join(root, 'claude-usage'), { recursive: true })
  await writeFile(join(root, 'claude-usage.json'), JSON.stringify(saved))
  const write = vi.spyOn(AtomicJsonStore.prototype, 'writeSerialized').mockRejectedValueOnce(new Error('Disk unavailable'))
  const reopened = new NativeUsage(root, 'claude'); await reopened.load(); await reopened.flushed()
  // One ledger did not reach its file, so the one file stays and the next start still reads it.
  expect(await readdir(root)).toContain('claude-usage.json')
  const again = new NativeUsage(root, 'claude'); await again.load()
  for (const id of Object.keys(saved)) expect(again.get(id)).toEqual(usage.get(id))
  await again.flushed()
  write.mockRestore()
  await reopened.flushed()
  expect(await readdir(root)).not.toContain('claude-usage.json')
  expect(Object.keys(await savedLedgers(root)).sort()).toEqual(Object.keys(saved).sort())
  const last = new NativeUsage(root, 'claude'); await last.load()
  for (const id of Object.keys(saved)) expect(last.get(id)).toEqual(usage.get(id))
})

it('writes at most eight threads\u2019 ledger files at once, however many threads changed (review)', async () => {
  const { root, usage } = await fixture()
  for (let thread = 0; thread < 40; thread++) usage.claude(`thread-${thread}`, frame(thread))
  const writeSerialized = AtomicJsonStore.prototype.writeSerialized
  let inFlight = 0, most = 0
  vi.spyOn(AtomicJsonStore.prototype, 'writeSerialized').mockImplementation(async function (this: AtomicJsonStore<unknown>, serialized) {
    inFlight++; most = Math.max(most, inFlight)
    try { return await writeSerialized.call(this, serialized) } finally { inFlight-- }
  })
  await usage.flushed()
  expect(most).toBe(8)
  expect(Object.keys(await savedLedgers(root))).toHaveLength(40)
})

it('makes the threads\u2019 files durable in their folder before it removes an earlier build\u2019s one file (review)', async () => {
  const { root, usage } = await fixture()
  for (let thread = 0; thread < 3; thread++) usage.claude(`thread-${thread}`, frame(thread))
  await usage.flushed()
  const saved = await savedLedgers(root)
  await rm(join(root, 'claude-usage'), { recursive: true })
  await writeFile(join(root, 'claude-usage.json'), JSON.stringify(saved))
  const steps: string[] = []
  const open = fs.open, unlink = fs.unlink
  vi.spyOn(fs, 'open').mockImplementation(async (path, ...rest) => {
    if (String(path) === join(root, 'claude-usage')) steps.push('folder synced')
    return open(path, ...rest as [])
  })
  vi.spyOn(fs, 'unlink').mockImplementation(async path => { if (String(path) === join(root, 'claude-usage.json')) steps.push('one file removed'); return unlink(path) })
  const reopened = new NativeUsage(root, 'claude'); await reopened.load(); await reopened.flushed()
  expect(steps).toEqual(['folder synced', 'one file removed'])
})

it.each(['EPERM', 'EACCES', 'EISDIR'])('removes an earlier build\u2019s one file where the system refuses to sync a folder (%s), as Windows does (#1936)', async code => {
  const { root, usage } = await fixture()
  usage.claude('thread-0', frame(0))
  await usage.flushed()
  const saved = await savedLedgers(root)
  await rm(join(root, 'claude-usage'), { recursive: true })
  await writeFile(join(root, 'claude-usage.json'), JSON.stringify(saved))
  const open = fs.open
  vi.spyOn(fs, 'open').mockImplementation(async (path, ...rest) => {
    const handle = await open(path, ...rest as [])
    if (String(path) !== join(root, 'claude-usage')) return handle
    // Opened, then refused when asked to flush, as Windows answers for a folder.
    return Object.assign(Object.create(Object.getPrototypeOf(handle) as object) as typeof handle, handle, {
      sync: async () => { throw Object.assign(new Error('Synthetic refused folder sync'), { code }) }, close: () => handle.close() })
  })
  const reopened = new NativeUsage(root, 'claude'); await reopened.load(); await reopened.flushed()
  expect(await readdir(root)).not.toContain('claude-usage.json')
  expect(Object.keys(await savedLedgers(root))).toEqual(['thread-0'])
})

