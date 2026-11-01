/**
 * Child-process workload for usageLedgerLoad.perf.test.ts: one start's read of a folder of Claude usage ledgers, synthetic
 * usage only. Run with --expose-gc, on a folder of its own, which it changes: the long thread's first report is saved.
 *
 * With `visit`, Usage reads every thread's saved rows once Claude connects, as main wires it: a `UsageService` over the
 * ledger, its store answering as the worker does, after a structured clone of each flush, as posting it to the worker makes.
 */
import type { AgentHostSnapshot } from '../../src/shared/agents'
import type { AgentHost } from '../../src/main/agents/host'
import { NativeUsage } from '../../src/main/agents/nativeUsage'
import { UsageService } from '../../src/main/agents/usageService'
import type { UsageStoreClient } from '../../src/main/agents/usageStoreClient'

const [root, threadsText, visitText = 'none'] = process.argv.slice(2)
if (!root || !threadsText) throw new Error('Expected a usage folder of its own and how many short threads it holds')
const collect = (globalThis as { gc?: () => void }).gc
if (!collect) throw new Error('Run with --expose-gc')
const settledHeap = (): number => { collect(); collect(); return process.memoryUsage().heapUsed }
const megabytes = (bytes: number): number => bytes / 1024 / 1024
const ids = [...Array.from({ length: Number(threadsText) }, (_, thread) => `thread-${thread}`), 'long']
const visiting = visitText === 'visit'

// Every task begun with setImmediate is timed: Usage reads its queued threads in such tasks.
const tasks: number[] = []
const immediate = globalThis.setImmediate
globalThis.setImmediate = ((callback: (...args: unknown[]) => void, ...args: unknown[]) => immediate(() => {
  const begun = performance.now()
  try { callback(...args) } finally { tasks.push(performance.now() - begun) }
})) as unknown as typeof setImmediate
const nextTurn = (): Promise<void> => new Promise(resolve => immediate(resolve))

const heapBefore = settledHeap()
const cpuBefore = process.cpuUsage(), started = performance.now()
const usage = new NativeUsage(root, 'claude', visiting)
await usage.load()
const loadMs = performance.now() - started, loadCpu = process.cpuUsage(cpuBefore)
const loadHeapMb = megabytes(settledHeap() - heapBefore)
let visit: Record<string, number> | undefined
if (visiting) {
  let saved = 0
  const client = { takesHistory: false, close: () => undefined, request: (request: { kind: string; flush?: { tokens: unknown[]; prompts: unknown[]; seed: boolean } }) => {
    if (request.kind === 'open') return Promise.resolve({ startedAt: '2026-10-31T00:00:00.000Z', revision: 0, generation: 0, legacySeedCompleted: false })
    if (request.kind !== 'flush' || !request.flush) return Promise.reject(new Error('Not asked for in this benchmark'))
    structuredClone(request)
    saved += request.flush.tokens.length
    return Promise.resolve({ tokens: request.flush.tokens.length, prompts: request.flush.prompts.length, seed: request.flush.seed })
  } } as unknown as UsageStoreClient
  let publish: ((snapshot: AgentHostSnapshot) => void) | undefined
  const host = { subscribe: (listener: (snapshot: AgentHostSnapshot) => void) => { publish = listener; return () => { publish = undefined } },
    visitUsage: (id: string, visitor: Parameters<NativeUsage['visitUsage']>[1]) => usage.visitUsage(id, visitor),
    subscribeUsage: (listener: Parameters<NativeUsage['subscribeUsage']>[0]) => usage.subscribeUsage(listener) } as unknown as AgentHost
  const service = new UsageService({ directory: root, host, client })
  service.start()
  const snapshot = { connected: true, providers: [{ id: 'claude', connection: 'connected' }], models: [],
    threads: ids.map(id => ({ id, providerId: 'claude' })) } as unknown as AgentHostSnapshot
  await nextTurn()
  tasks.length = 0
  const cpuVisit = process.cpuUsage(), publishing = performance.now()
  publish!(snapshot)
  const snapshotTaskMs = performance.now() - publishing
  // Until every queued thread is read; the source at BASE reads them all in the snapshot's own task.
  const queued = (): number => (service as unknown as { visits?: Map<string, unknown> }).visits?.size ?? 0
  while (queued()) await nextTurn()
  const visitMs = performance.now() - publishing, visitCpu = process.cpuUsage(cpuVisit)
  const batches = [...tasks]
  service.flush()
  for (let turn = 0; turn < 3; turn++) await nextTurn()
  visit = { snapshotTaskMs, visitMs, visitCpuMs: (visitCpu.user + visitCpu.system) / 1000, batches: batches.length,
    medianBatchMs: batches.length ? [...batches].sort((a, b) => a - b)[batches.length >> 1]! : 0,
    longestBatchMs: Math.max(0, ...batches), longestTaskMs: Math.max(snapshotTaskMs, ...batches),
    // The long thread's batch aside: one task reads all of a thread's usage, however long.
    secondLongestTaskMs: [snapshotTaskMs, ...batches].sort((a, b) => b - a)[1] ?? 0,
    batchesOver8Ms: batches.filter(ms => ms > 8).length, visitHeapMb: megabytes(settledHeap() - heapBefore), rows: saved }
  service.close()
}
// Whatever the start wrote, such as views of ledgers it read whole, lands before the long thread reports.
await usage.flushed()
const reporting = performance.now()
usage.claude('long', { type: 'assistant', timestamp: '2026-10-31T12:00:00.000Z', message: { id: 'msg_after_start', model: 'claude-opus-5-5',
  usage: { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 0 } } })
const firstReportMs = performance.now() - reporting
const output = usage.get('long')?.total?.output
await usage.flushed()
console.log(JSON.stringify({ loadMs, loadCpuMs: (loadCpu.user + loadCpu.system) / 1000, loadHeapMb, ...visit,
  firstReportMs, output }))
