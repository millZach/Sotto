// @vitest-environment node
/**
 * What main encodes for one write of a Claude usage ledger while a reply streams, counted rather than timed (#1451). The
 * ledger holds every request of every Claude thread and is rewritten whole about once a second while one streams. On the
 * owner's computer it had grown to 12.7 MB, and encoding all of it again for every write was about a second of main's
 * busy minute. Main now encodes only the ledgers that changed and hands the rest over as the bytes it wrote last time;
 * the write itself runs off main. This fails when what one streamed write encodes grows with the ledgers nothing changed.
 * It counts bytes, never time, so it runs in the default suite.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
  const fileBytes = Buffer.byteLength(await readFile(join(root, 'claude-usage.json'), 'utf8'))
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
  const calls = spy.mock.calls.map(([serialized]) => serialized).filter((serialized): serialized is readonly Uint8Array[] => typeof serialized !== 'string')
  spy.mockRestore()
  expect(calls.length).toBeGreaterThanOrEqual(4)
  for (let index = 1; index < calls.length; index++) {
    const before = new Set(calls[index - 1])
    // What this write had to encode: every piece the last write did not already hold.
    const encoded = calls[index]!.filter(piece => !before.has(piece)).reduce((sum, piece) => sum + piece.byteLength, 0)
    const ledger = calls[index]!.reduce((largest, piece) => Math.max(largest, piece.byteLength), 0)
    // One thread's ledger, at most, out of forty.
    expect(encoded).toBeLessThanOrEqual(ledger)
    expect(encoded * 20).toBeLessThan(fileBytes)
  }
  // What reaches the disk is the whole ledger as it always was.
  const written = await readFile(join(root, 'claude-usage.json'), 'utf8')
  expect(written.endsWith('}\n')).toBe(true)
  expect(written.trimEnd()).toBe(JSON.stringify(JSON.parse(written)))
  expect(Object.keys(JSON.parse(written) as object)).toHaveLength(40)
}, 120_000)
