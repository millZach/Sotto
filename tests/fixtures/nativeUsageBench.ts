/** Child-process workload for nativeUsageWrites.perf.test.ts; synthetic archives only. */
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTask } from 'node:timers/promises'
import { NativeUsage } from '../../src/main/agents/nativeUsage'
import { nativeUsageBenchTotals as totals } from './nativeUsageBenchTotals'

type Archive = Record<string, { entries: Record<string, unknown> }>
const [seed, threadsText, scenario] = process.argv.slice(2)
if (!seed || !threadsText || !['replay', 'stream', 'turns'].includes(scenario ?? '')) throw new Error('Expected seed, thread count and workload')
const threads = Number(threadsText)
const root = await mkdtemp(join(tmpdir(), 'sotto-usage-bench-'))
try {
  await copyFile(seed, join(root, 'claude-usage.json'))
  const usage = new NativeUsage(root, 'claude'); await usage.load(); await usage.flushed()
  const archive = JSON.parse(await readFile(seed, 'utf8')) as Record<string, { entries: Record<string, { tokens: { output: number } }> }>
  const first = Object.keys(archive['thread-0']!.entries)[0]!
  const output = archive['thread-0']!.entries[first]!.tokens.output
  const message = (id: string, count: number) => ({ id, model: 'claude-sonnet-4-6', usage: {
    input_tokens: 1000, output_tokens: count, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0,
  } })
  if (scenario === 'stream') {
    usage.claude('thread-0', { type: 'stream_event', event: { type: 'message_start', message: message('live', 0) } })
    await usage.flushed()
  }
  // The baseline hands the store a copy of the ledger; later versions hand it the ledger already serialized.
  const store = (usage as unknown as { store: { write(value: Archive): Promise<void>; writeSerialized?(text: string): Promise<void> } }).store
  const original = store.write.bind(store)
  let writes = 0, entriesWritten = 0
  const recordWrite = (value: Archive): void => {
    writes++
    for (const ledger of Object.values(value)) entriesWritten += Object.keys(ledger.entries).length
  }
  store.write = value => { recordWrite(value); return original(value) }
  if (store.writeSerialized) {
    const writeSerialized = store.writeSerialized.bind(store)
    store.writeSerialized = text => { recordWrite(JSON.parse(text) as Archive); return writeSerialized(text) }
  }
  const before = totals(usage.get('thread-0'))
  const outputBefore = Array.from({ length: threads }, (_, i) => usage.get(`thread-${i}`)?.total?.output ?? 0).reduce((sum, value) => sum + value, 0)
  const heapBefore = process.memoryUsage().heapUsed
  const cpuBefore = process.cpuUsage()
  const started = performance.now()
  for (let i = 0; i < 100; i++) {
    if (scenario === 'replay') usage.claude('thread-0', { type: 'assistant', timestamp: '2026-09-01T00:00:00.000Z', message: message(first, output) })
    if (scenario === 'stream') usage.claude('thread-0', { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: i + 1 } } })
    if (scenario === 'turns') usage.claude(`thread-${i % threads}`, { type: 'assistant', timestamp: new Date(Date.UTC(2026, 8, 2, 0, i)).toISOString(), message: message(`new-${i}`, 100) })
    // Transcript batches and process output arrive across event-loop turns, not just one giant synchronous loop.
    if ((i + 1) % 10 === 0) await nextTask()
  }
  const observedMs = performance.now() - started
  const heapAfterObservations = process.memoryUsage().heapUsed
  await usage.flushed()
  const drainedMs = performance.now() - started
  const cpu = process.cpuUsage(cpuBefore)
  const heapAfterDrain = process.memoryUsage().heapUsed
  const result = Array.from({ length: threads }, (_, i) => totals(usage.get(`thread-${i}`)))
  if (scenario === 'replay') assert.deepEqual(result[0], before)
  if (scenario === 'stream') assert.equal(result[0]!.total!.output, before.total!.output! + 100)
  if (scenario === 'turns') assert.equal(result.reduce((sum, view) => sum + (view.total?.output ?? 0), 0), outputBefore + 10_000)
  const reopened = new NativeUsage(root, 'claude'); await reopened.load(); await reopened.flushed()
  for (let i = 0; i < threads; i++) assert.deepEqual(totals(reopened.get(`thread-${i}`)), result[i])
  const bytes = (await stat(join(root, 'claude-usage.json'))).size
  console.log(JSON.stringify({ writes, entriesWritten, observedMs, drainedMs, cpuMs: (cpu.user + cpu.system) / 1000,
    heapBefore, heapAfterObservations, heapAfterDrain, archiveBytes: bytes, result }))
} finally { await rm(root, { recursive: true, force: true }) }
