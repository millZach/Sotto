// @vitest-environment node
/**
 * What one `watcher-state` push costs each end (November 10, 2026 audit). A host pushes a paired desktop Watcher's whole
 * projection, up to 1,000 requests and 1,000 operations, whenever its revision moves, and the revision moves with every
 * watched thread's progress. On forge's host the push was 1.98 MB of JSON 2.1 times a second
 * (`docs/perf/2026-11-10-performance-and-data-audit.md`). This times the wire work of one push at that size: the host
 * serializing and compressing it as `src/host/socketFrames.ts` does, and the desktop inflating, parsing and reading it
 * with `hostPushSchema` as `SocketHostService.receive` does. It leaves out what each end does with the projection.
 *
 * It prints JSON and asserts nothing, so it runs only under `SOTTO_PERF_BENCH=1`:
 *
 *   SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/watcherStatePush.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * `SOTTO_AUDIT_WATCHER_RECORD=<path to a host's watcher-record.json>` times a real record's requests and operations in
 * place of the fixture's; it reads the file and writes nothing.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { deflateRawSync, inflateRawSync, constants as zlib } from 'node:zlib'
import { it } from 'vitest'
import { hostPushSchema } from '../../src/shared/hostProtocol'
import type { WatcherOperation, WatcherRecord, WatcherRequest } from '../../src/shared/watcher'
import { addWatcherHistory } from '../fixtures/ownerScale'
import { PERF_BENCH, median, round } from '../fixtures/perfBench'
import { watcherRecordFixture } from '../fixtures/watcher'

const RECORD = process.env.SOTTO_AUDIT_WATCHER_RECORD
const ROUNDS = 15
const AT = '2026-11-10T12:00:00.000Z'

/** Requests and operations as a host holds them for one paired desktop's Watcher: `count` of each, every request closed. */
function fixtureWork(count: number): { requests: WatcherRequest[]; operations: WatcherOperation[] } {
  const record = watcherRecordFixture(), hostId = randomUUID(), desktop = randomUUID()
  const master = { target: { hostId: desktop, threadId: randomUUID() }, projectId: randomUUID(), provider: 'codex' as const, creationOperationId: randomUUID(), createdAt: AT }
  const targets = Array.from({ length: 40 }, () => ({ hostId, threadId: randomUUID() }))
  record.requests = []; record.operations = []
  addWatcherHistory(record, targets, { requests: count, operations: count }, master.target)
  // Every request on a paired host came from a desktop's Watcher, and says which.
  for (const request of record.requests) request.remoteOrigin = { clientId: randomUUID(), master, creationOperationId: master.creationOperationId, ceiling: 'approval-required' }
  return { requests: record.requests, operations: record.operations }
}
function recordedWork(path: string): { requests: WatcherRequest[]; operations: WatcherOperation[] } {
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { watcher?: WatcherRecord } & Partial<WatcherRecord>
  const record = saved.watcher ?? saved
  return { requests: (record.requests ?? []).slice(-1_000), operations: (record.operations ?? []).slice(-1_000) }
}
const timed = <T>(work: () => T): { ms: number; value: T } => { const started = performance.now(); const value = work(); return { ms: performance.now() - started, value } }

it.skipIf(!PERF_BENCH)('times one watcher-state push on the host and on the desktop', () => {
  const sizes = RECORD ? [0] : [160, 925]
  const report: Record<string, unknown> = { source: RECORD ? 'a saved record' : 'fixture', rounds: ROUNDS }
  for (const count of sizes) {
    const work = RECORD ? recordedWork(RECORD) : fixtureWork(count)
    const first = work.requests[0]
    if (!first) throw new Error('The record holds no request.')
    const master = first.remoteOrigin?.master ?? { target: first.watcher, projectId: randomUUID(), provider: 'codex' as const, creationOperationId: randomUUID(), createdAt: AT }
    const targets = [...new Map(work.requests.flatMap(request => request.participants.map(item => [`${item.target.hostId}/${item.target.threadId}`, item.target] as const))).values()].slice(-1_000)
    // Outcomes stay on the host (`withoutOutcome` in `src/main/agents/watcher.ts`).
    const operations = work.operations.map(operation => Object.fromEntries(Object.entries(operation).filter(([key]) => key !== 'outcome' && key !== 'outcomeAt')))
    const push = { v: 1, event: 'watcher-state', projection: { hostId: randomUUID(), master, requests: work.requests, operations, evidence: [],
      progress: targets.map((target, index) => ({ target, fingerprint: index.toString(16).padStart(64, '0') })), standingWatches: [], revision: 'r'.repeat(64), observedAt: AT } }
    const checked = hostPushSchema.safeParse(push)
    if (!checked.success) throw new Error(`The push does not pass hostPushSchema: ${checked.error.issues.slice(0, 3).map(issue => `${issue.path.join('.')}: ${issue.code}`).join('; ')}`)
    const stringify: number[] = [], deflate: number[] = [], inflate: number[] = [], parse: number[] = [], schema: number[] = []
    let jsonBytes = 0, wireBytes = 0
    for (let round = 0; round < ROUNDS + 3; round++) {
      const text = timed(() => JSON.stringify(push))
      const data = Buffer.from(text.value)
      const packed = timed(() => deflateRawSync(data, { level: 6, finishFlush: zlib.Z_SYNC_FLUSH }))
      const unpacked = timed(() => inflateRawSync(packed.value, { finishFlush: zlib.Z_SYNC_FLUSH }).toString('utf8'))
      const raw = timed(() => JSON.parse(unpacked.value) as unknown)
      const read = timed(() => hostPushSchema.safeParse(raw.value))
      if (!read.value.success) throw new Error('The push did not read back.')
      jsonBytes = data.byteLength; wireBytes = packed.value.byteLength
      if (round < 3) continue
      stringify.push(text.ms); deflate.push(packed.ms); inflate.push(unpacked.ms); parse.push(raw.ms); schema.push(read.ms)
    }
    const host = median(stringify) + median(deflate), desktop = median(inflate) + median(parse) + median(schema)
    report[RECORD ? 'record' : `${count} requests`] = {
      requests: work.requests.length, operations: operations.length, progress: targets.length, jsonBytes, wireBytes,
      hostMs: { stringify: round(median(stringify)), deflate: round(median(deflate)), total: round(host) },
      desktopMs: { inflate: round(median(inflate)), parse: round(median(parse)), schema: round(median(schema)), total: round(desktop) },
      // At the 2.1 pushes a second forge's host sent on November 10.
      atLiveRate: { pushesPerSecond: 2.1, hostCorePercent: round(host * 2.1 / 10), desktopMainCorePercent: round(desktop * 2.1 / 10), wireBytesPerSecond: Math.round(wireBytes * 2.1) },
    }
  }
  console.log(`WATCHER-STATE-PUSH ${JSON.stringify(report, null, 1)}`)
})
