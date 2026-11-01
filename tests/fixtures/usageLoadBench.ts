/**
 * Child-process workload for usageLedgerLoad.perf.test.ts: one start's read of a folder of Claude usage ledgers, synthetic
 * usage only. Run with --expose-gc, on a folder of its own, which it changes: the long thread's first report is saved.
 */
import { NativeUsage } from '../../src/main/agents/nativeUsage'

const [root, threadsText, visitText = 'none'] = process.argv.slice(2)
if (!root || !threadsText) throw new Error('Expected a usage folder of its own and how many short threads it holds')
const collect = (globalThis as { gc?: () => void }).gc
if (!collect) throw new Error('Run with --expose-gc')
const settledHeap = (): number => { collect(); collect(); return process.memoryUsage().heapUsed }
const megabytes = (bytes: number): number => bytes / 1024 / 1024
const ids = [...Array.from({ length: Number(threadsText) }, (_, thread) => `thread-${thread}`), 'long']

const heapBefore = settledHeap()
const cpuBefore = process.cpuUsage(), started = performance.now()
const usage = new NativeUsage(root, 'claude', visitText === 'visit')
await usage.load()
const loadMs = performance.now() - started, loadCpu = process.cpuUsage(cpuBefore)
const loadHeapMb = megabytes(settledHeap() - heapBefore)
let visit: { visitMs: number; visitHeapMb: number; rows: number } | undefined
if (visitText === 'visit') {
  // Usage reads every thread's saved rows once its provider connects.
  let rows = 0
  const visiting = performance.now()
  for (const id of ids) usage.visitUsage(id, () => { rows += 1 })
  visit = { visitMs: performance.now() - visiting, visitHeapMb: megabytes(settledHeap() - heapBefore), rows }
}
// Whatever the start wrote, such as views of ledgers it read whole, lands before the long thread reports.
await usage.flushed()
const reporting = performance.now()
usage.claude('long', { type: 'assistant', timestamp: '2026-10-31T12:00:00.000Z', message: { id: 'msg_after_start', model: 'claude-opus-5-5',
  usage: { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 0 } } })
const firstReportMs = performance.now() - reporting
const output = usage.get('long')?.total?.output
await usage.flushed()
console.log(JSON.stringify({ loadMs, loadCpuMs: (loadCpu.user + loadCpu.system) / 1000, loadHeapMb, ...visit, firstReportMs, output }))
