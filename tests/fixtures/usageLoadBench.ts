/**
 * Child-process workload for usageLedgerLoad.perf.test.ts: one start's read of a folder of Claude usage ledgers, synthetic
 * usage only. Run with --expose-gc, on a folder of its own, which it changes: the long thread's first report is saved.
 *
 * With `visit`, Usage reads the threads' saved rows once Claude connects, as main wires it (`connectUsage`). It counts the
 * bytes of ledger and view files read, times every task begun with setImmediate (Usage reads its queued threads in such
 * tasks), and keeps the longest stretch main went without a turn of its event loop, which bounds the longest task of any
 * kind, a file's parse among them.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { NativeUsage } from '../../src/main/agents/nativeUsage'
import { connectUsage } from './usageBenchStore'

const [root, threadsText, visitText = 'none'] = process.argv.slice(2)
if (!root || !threadsText) throw new Error('Expected a usage folder of its own and how many short threads it holds')
const collect = (globalThis as { gc?: () => void }).gc
if (!collect) throw new Error('Run with --expose-gc')
const megabytes = (bytes: number): number => bytes / 1024 / 1024
const ids = [...Array.from({ length: Number(threadsText) }, (_, thread) => `thread-${thread}`), 'long']
const visiting = visitText === 'visit'

// The bytes of each kind of usage file read, by either read.
const read = { ledger: 0, view: 0 }
const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs'), fsp = require('node:fs/promises') as typeof import('node:fs/promises')
const count = (path: unknown, contents: unknown): void => {
  const bytes = typeof contents === 'string' ? Buffer.byteLength(contents) : contents instanceof Uint8Array ? contents.byteLength : 0
  if (/[0-9a-f]{40}\.view\.json$/u.test(String(path))) read.view += bytes
  else if (/[0-9a-f]{40}\.json$/u.test(String(path))) read.ledger += bytes
}
const readFile = fsp.readFile, readFileSync = fs.readFileSync
fsp.readFile = (async (path: Parameters<typeof readFile>[0], ...rest: unknown[]) => {
  const contents = await (readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest); count(path, contents); return contents
}) as typeof readFile
fs.readFileSync = ((path: Parameters<typeof readFileSync>[0], ...rest: unknown[]) => {
  const contents = (readFileSync as (...args: unknown[]) => unknown)(path, ...rest); count(path, contents); return contents
}) as typeof readFileSync
syncBuiltinESMExports()

// Every task begun with setImmediate is timed.
const tasks: number[] = []
const immediate = globalThis.setImmediate
globalThis.setImmediate = ((callback: (...args: unknown[]) => void, ...args: unknown[]) => immediate(() => {
  const begun = performance.now()
  try { callback(...args) } finally { tasks.push(performance.now() - begun) }
})) as unknown as typeof setImmediate
const nextTurn = (): Promise<void> => new Promise(resolve => immediate(resolve))

// A tick at every turn of the event loop: the longest gap between two is the longest main was held, by one task or a few.
const monitor = { running: false, last: 0, longest: 0 }
const tick = (): void => {
  const now = performance.now()
  monitor.longest = Math.max(monitor.longest, now - monitor.last); monitor.last = now
  if (monitor.running) immediate(tick)
}
const watch = (): void => { monitor.running = true; monitor.last = performance.now(); immediate(tick) }
const unwatched = <T>(work: () => T): T => { monitor.running = false; try { return work() } finally { watch() } }
const settledHeap = (): number => unwatched(() => { collect(); collect(); return process.memoryUsage().heapUsed })

const heapBefore = (() => { collect(); collect(); return process.memoryUsage().heapUsed })()
watch()
const cpuBefore = process.cpuUsage(), started = performance.now()
let applied: () => void = () => undefined
const landed = new Promise<void>(resolve => { applied = resolve })
const usage = new NativeUsage(root, 'claude', visiting, id => { if (id === 'long') applied() })
await usage.load()
const loadMs = performance.now() - started, loadCpu = process.cpuUsage(cpuBefore)
const loadHeapMb = megabytes(settledHeap() - heapBefore)
let visit: Record<string, number> | undefined
if (visiting) {
  const connected = connectUsage(usage, root, ids)
  await nextTurn()
  tasks.length = 0
  const cpuVisit = process.cpuUsage(), publishing = performance.now()
  connected.publish()
  const snapshotTaskMs = performance.now() - publishing
  // Until no thread is left to read; the source at BASE reads them all in the snapshot's own task.
  while (connected.queued()) await nextTurn()
  const visitMs = performance.now() - publishing, visitCpu = process.cpuUsage(cpuVisit)
  const batches = [...tasks]
  connected.service.flush()
  for (let turn = 0; turn < 3; turn++) await nextTurn()
  visit = { snapshotTaskMs, visitMs, visitCpuMs: (visitCpu.user + visitCpu.system) / 1000, batches: batches.length,
    medianBatchMs: batches.length ? [...batches].sort((a, b) => a - b)[batches.length >> 1]! : 0,
    longestTaskMs: Math.max(snapshotTaskMs, ...batches), visitHeapMb: megabytes(settledHeap() - heapBefore), rows: connected.store.saved() }
  connected.service.close()
  await connected.store.written()
}
const startLongestMs = monitor.longest
const parsed = { ...read }
// Whatever the start wrote, such as views of ledgers it read whole, lands before the long thread reports.
await usage.flushed()
const output = usage.get('long')?.total?.output ?? 0
monitor.longest = 0
const reporting = performance.now()
usage.claude('long', { type: 'assistant', timestamp: '2026-10-31T12:00:00.000Z', message: { id: 'msg_after_start', model: 'claude-opus-5-5',
  usage: { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 0 } } })
const reportTaskMs = performance.now() - reporting
// A source that counts it in the report's own task has counted it now; one that reads the thread first, once the read lands.
if (usage.get('long')?.total?.output === output) await landed
const reportAppliedMs = performance.now() - reporting
// The write its count sets off encodes the thread's ledger in a microtask behind it, on either source: two turns more
// take that in too.
await nextTurn(); await nextTurn()
const reportLongestMs = monitor.longest
monitor.running = false
await usage.flushed()
console.log(JSON.stringify({ loadMs, loadCpuMs: (loadCpu.user + loadCpu.system) / 1000, loadHeapMb, ...visit, startLongestMs,
  ledgerBytesRead: parsed.ledger, viewBytesRead: parsed.view, reportTaskMs, reportAppliedMs, reportLongestMs, output: usage.get('long')?.total?.output }))
