// @vitest-environment node
/**
 * What main encodes and writes for one write of a Claude usage ledger while a reply streams, counted rather than timed
 * (#1451, #555). The ledger held every request of every Claude thread in one file, rewritten whole about once a second
 * while one streamed: 12.7 MB on the owner's computer, encoded again for every write until #1451 and synced to disk whole
 * until each thread's ledger had a file of its own. This fails when what one streamed write encodes or writes grows with
 * the ledgers nothing changed. It counts bytes, never time, so it runs in the default suite.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { NativeUsage } from '../../src/main/agents/nativeUsage'
import { AtomicJsonStore } from '../../src/main/storage/atomicJsonStore'

const roots: string[] = []
afterAll(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const frame = (thread: number, entry: number, output = 100) => ({ type: 'assistant', timestamp: new Date(Date.UTC(2026, 8, 1, 0, entry)).toISOString(), message: {
  id: `message-${thread}-${entry}`, model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: output, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
} })

it('encodes only the streaming thread\'s ledger for each write, however many other ledgers the file holds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-usage-encode-budget-')); roots.push(root)
  const usage = new NativeUsage(root, 'claude'); await usage.load()
  // Forty threads of six hundred requests each: a ledger of a few megabytes, most of it threads that are not streaming.
  for (let thread = 0; thread < 40; thread++) for (let entry = 0; entry < 600; entry++) usage.claude(`thread-${thread}`, frame(thread, entry))
  await usage.flushed()
  const directory = join(root, 'claude-usage'), names = await readdir(directory)
  const ledgersBytes = (await Promise.all(names.map(async name => Buffer.byteLength(await readFile(join(directory, name), 'utf8'))))).reduce((sum, bytes) => sum + bytes, 0)
  // The store still writes; the spy only keeps what each write was handed.
  const spy = vi.spyOn(AtomicJsonStore.prototype, 'writeSerialized')
  // A reply streaming on one thread: three of its writes, each after another output count.
  const message = { id: 'streamed', model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } }
  usage.claude('thread-0', { type: 'stream_event', event: { type: 'message_start', message } })
  usage.claudeResult('thread-0', { duration_ms: 1 })
  await usage.flushed()
  for (let index = 1; index <= 3; index++) {
    usage.claude('thread-0', { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: index * 10 } } })
    usage.claudeResult('thread-0', { duration_ms: index })
    await usage.flushed()
  }
  const calls = spy.mock.calls.map(([serialized]) => typeof serialized === 'string' ? serialized : Buffer.concat(serialized).toString('utf8'))
  spy.mockRestore()
  expect(calls.length).toBeGreaterThanOrEqual(4)
  for (const written of calls) {
    // The streaming thread's ledger alone is encoded and written, one of forty.
    expect((JSON.parse(written) as { id: string }).id).toBe('thread-0')
    expect(Buffer.byteLength(written) * 20).toBeLessThan(ledgersBytes)
  }
  // Every thread's ledger is still saved, each in its file as a whole serialization of it.
  expect(await readdir(directory)).toHaveLength(40)
  for (const name of await readdir(directory)) {
    const text = await readFile(join(directory, name), 'utf8')
    expect(text.trimEnd()).toBe(JSON.stringify(JSON.parse(text)))
  }
}, 120_000)
