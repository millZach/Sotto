// @vitest-environment node
/**
 * What Watcher spends reconciling a paired host whose projection changes nothing (#1781). A desktop reconciles a paired
 * host on every projection the host pushes while Watcher has work in flight there. Each pass copied Watcher's whole
 * record to try the host's receipts on, and serialized the record four times to see whether anything had changed, so
 * a pass that changed nothing cost the record's size, and the record grows with every instruction Watcher is given.
 *
 * The first test counts, so it runs in the default suite: a pass that changes nothing copies nothing of the record,
 * hands nothing to `updateWatcher`, and serializes nothing larger than a few small values, with the owner's history and
 * with four times it. What it still serializes is a thread's key for each record it compares, which grows with the record
 * the host projects. The second test times passes at the owner's scale and at eight times it, where Watcher's pruning
 * already holds the live record near 250 KB, and prints JSON; it runs only under `SOTTO_PERF_BENCH=1`
 * (`docs/perf/2026-10-31-watcher-reconcile.md`).
 *
 *   SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/watcherRemoteReconcile.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import type { AgentHostSnapshot } from '../../src/shared/agents'
import type { WatcherHostProjection, WatcherRemoteHosts } from '../../src/shared/watcherHost'
import { watcherRecordFixture } from '../fixtures/watcher'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { addWatcherHistory, ownerScaleCounts } from '../fixtures/ownerScale'
import { PERF_BENCH, median, round } from '../fixtures/perfBench'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/**
 * A desktop's Watcher with work on one paired host: the history `watcher` times as long as the owner's on October 20
 * (8 is about October 28's), every request taking part on that host, a thread there Watcher watches and has stopped, and
 * the host's projection saying what the record already holds.
 */
async function pairedWatcher(watcherScale: number) {
  const workspace = await workspaceFixture(undefined, { history: false })
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => false, watcherEnabled: true } })
  const watcher = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => false })
  cleanups.push(async () => { watcher.close(); await f.dispose(); await workspace.stop(); await workspace.remove() })
  // Watcher's own thread has had a turn, which its prompt turn records and a stop's fence reads again on every pass.
  workspace.adapters.codex.state.threads[0]!.lastTurn = { id: 'watcher-turn', status: 'completed' }
  await f.control.start(); await f.control.commandShell({ type: 'connect', provider: 'codex' })
  const localSnapshot = f.control.watcherSnapshot(), native = localSnapshot.threads[0]!
  const record = watcherRecordFixture(), local = f.control.hostId()!, hostId = randomUUID()
  // Watcher is a thread on this computer, with a turn of its own, as a stop's fence reads it.
  record.current!.target = { hostId: local, threadId: native.id }; record.requests[0]!.watcher = record.current!.target
  record.requests[0]!.participants[0]!.target.hostId = hostId
  record.operations[0]!.target.hostId = hostId; record.reservations[0]!.target.hostId = hostId
  const targets = Array.from({ length: 40 }, (_, index) => ({ hostId, threadId: `worker-${index}` }))
  addWatcherHistory(record, targets, ownerScaleCounts({ threads: 1, history: 1, watcher: watcherScale }))
  // A watched thread on the host that Watcher stopped, under the request still open: each pass hears the stop's receipt
  // again and fences the watch's turn.
  const request = record.requests[0]!, watched = request.participants[0]!.target
  record.watches = [{ id: randomUUID(), target: watched, createdAt: request.createdAt, generation: 0 }]
  record.operations.push({ ...structuredClone(record.operations.at(-1)!), id: randomUUID(), requestId: request.id, retryKey: randomUUID(), action: 'stop', target: watched,
    receiptId: 'stop-receipt', cardId: 'stop-card' })
  await f.control.updateWatcher(next => Object.assign(next, structuredClone(record)))
  const snapshot: AgentHostSnapshot = { ...localSnapshot, hostId, connected: true,
    threads: [{ ...native, id: 'worker', hostId, status: 'running' }, ...targets.map(target => ({ ...native, id: target.threadId, hostId, status: 'idle' as const }))] }
  let projection: WatcherHostProjection | undefined
  const hosts: ReturnType<WatcherRemoteHosts['hosts']> = [{ hostId, connected: true, reads: true, control: true, permissionCeiling: 'approval-required' }]
  const remote: WatcherRemoteHosts = { hosts: () => hosts, snapshot: id => id === hostId ? snapshot : undefined, read: async () => structuredClone(projection!),
    projection: () => projection, control: vi.fn(), subscribe: () => () => undefined }
  // A pushed projection is reconciled from the router's copy of it, not read again.
  const reconcile = () => (watcher as unknown as { reconcileRemote(hostId?: string, force?: boolean): Promise<void> }).reconcileRemote(hostId, false)
  const held = () => { const now = f.control.watcherRecord(); projection = { hostId, master: now.current!, revision: randomUUID(), observedAt: new Date().toISOString(), requests: now.requests, operations: now.operations, evidence: [] } }
  held()
  watcher.useRemoteHosts(remote)
  // Whatever the first passes settle, the projection then says what the record holds.
  await reconcile(); held(); await reconcile(); held()
  const fenced = f.control.watcherRecordView().requests.some(item => item.standingWatchId === record.watches![0]!.id && item.participants.some(participant => participant.automationStopped))
  return { control: f.control, reconcile, recordBytes: JSON.stringify(f.control.watcherRecordView()).length, fenced }
}

/**
 * What `passes` reconciles of a projection that changes nothing cost: copies of Watcher's record, characters serialized
 * and the longest one serialization, and changes handed to `updateWatcher`, each of which copies the record.
 */
async function measure(paired: Awaited<ReturnType<typeof pairedWatcher>>, passes: number) {
  const native = globalThis.structuredClone, stringify = JSON.stringify.bind(JSON), before = paired.control.watcherRecordView()
  let copies = 0, characters = 0, largest = 0
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
    if (value === paired.control.watcherRecordView()) copies++
    return native(value, options)
  }) as typeof structuredClone
  const serialized = vi.spyOn(JSON, 'stringify').mockImplementation(((...parameters: Parameters<typeof JSON.stringify>) => {
    const text = stringify(...parameters); characters += text?.length ?? 0; largest = Math.max(largest, text?.length ?? 0); return text
  }) as typeof JSON.stringify)
  const updates = vi.spyOn(paired.control, 'updateWatcher'), times: number[] = []
  let handed: number
  try {
    for (let pass = 0; pass < passes; pass++) { const start = performance.now(); await paired.reconcile(); times.push(performance.now() - start) }
    handed = updates.mock.calls.length
  } finally { globalThis.structuredClone = native; serialized.mockRestore(); updates.mockRestore() }
  expect(paired.control.watcherRecordView()).toBe(before)
  return { copies: copies / passes, characters: characters / passes, largest, updates: handed / passes, times }
}

it('copies and serializes nothing the size of the record on a reconcile that changes nothing', async () => {
  for (const scale of [1, 4]) {
    const paired = await pairedWatcher(scale), pass = await measure(paired, 3)
    // The stop's fence ran, so each pass below heard its receipt again.
    expect(paired.fenced).toBe(true)
    expect(pass.copies).toBe(0)
    expect(pass.updates).toBe(0)
    // The record is about 250 KB here; the longest serialization left is a Watcher identity, under a kilobyte.
    expect(paired.recordBytes).toBeGreaterThan(200_000)
    expect(pass.largest).toBeLessThan(1_000)
  }
})

it.skipIf(!PERF_BENCH)('measures a reconcile of a paired host that changes nothing', async () => {
  const report: Record<string, unknown> = {}
  for (const scale of [1, 8]) {
    const paired = await pairedWatcher(scale)
    await measure(paired, 5)
    const result = await measure(paired, 40)
    report[`watcher x${scale}`] = { recordBytes: paired.recordBytes, passMs: round(median(result.times), 2), copiesPerPass: result.copies,
      charactersPerPass: Math.round(result.characters), largestSerialized: result.largest, updatesPerPass: result.updates }
  }
  console.log(`WATCHER-RECONCILE ${JSON.stringify(report, null, 1)}`)
})
