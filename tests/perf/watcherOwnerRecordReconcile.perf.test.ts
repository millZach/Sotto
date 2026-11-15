// @vitest-environment node
/**
 * What one reconcile of a paired host costs main with the owner's own Watcher record (`watcherOwnerRecord.ts`, November
 * 13, 2026). A desktop reconciles a paired host on each projection the host pushes, about once a second while a watched
 * thread there works. That day each pass froze main for 90 to 175 ms: it searched the whole record once for each request
 * and receipt the host projected, so its work grew with the record times what the host projected.
 *
 * The first test counts, so it runs in the default suite: a pass that changes nothing walks the record's requests and
 * operations a fixed number of times, however many of them the host projects. The second times passes and prints JSON; it
 * runs only under `SOTTO_PERF_BENCH=1` (`docs/perf/2026-11-13-watcher-reconcile-owner-record.md`).
 *
 *   SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/watcherOwnerRecordReconcile.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { performance } from 'node:perf_hooks'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import type { AgentHostSnapshot, AgentThread } from '../../src/shared/agents'
import type { WatcherHostProjection, WatcherRemoteHosts } from '../../src/shared/watcherHost'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { PERF_BENCH, median, round } from '../fixtures/perfBench'
import { ownerWatcherRecord } from '../fixtures/watcherOwnerRecord'
import { workspaceFixture } from '../fixtures/workspaceFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const PAIRED = '00000000-0000-4000-8000-0000000000a2'

/** A desktop's Watcher holding the owner's record, paired with the host its watched threads ran on, whose projection says what the record holds. */
async function ownerPairedWatcher() {
  const workspace = await workspaceFixture(undefined, { history: false })
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => false, watcherEnabled: true } })
  const watcher = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => false })
  cleanups.push(async () => { watcher.close(); await f.dispose(); await workspace.stop(); await workspace.remove() })
  workspace.adapters.codex.state.threads[0]!.lastTurn = { id: 'watcher-turn', status: 'completed' }
  await f.control.start(); await f.control.commandShell({ type: 'connect', provider: 'codex' })
  const localSnapshot = f.control.watcherSnapshot(), native = localSnapshot.threads[0]!, local = f.control.hostId()!
  const record = ownerWatcherRecord(local, PAIRED)
  // The owner's Watcher conversation is this computer's thread.
  const owner = record.current!.target.threadId
  const retarget = (target: { hostId: string; threadId: string }) => { if (target.hostId === local && target.threadId === owner) target.threadId = native.id }
  record.current!.target.threadId = native.id
  for (const request of record.requests) retarget(request.watcher)
  for (const turn of record.promptTurns ?? []) retarget(turn.watcher)
  await f.control.watcherRecords.update(next => Object.assign(next, record))
  // Every thread the record names on the paired host, idle, as most of the owner's were.
  const names = new Set<string>()
  for (const request of record.requests) for (const participant of request.participants) if (participant.target.hostId === PAIRED) names.add(participant.target.threadId)
  for (const operation of record.operations) if (operation.target.hostId === PAIRED) names.add(operation.target.threadId)
  const threads: AgentThread[] = [...names].map(id => ({ ...native, id, hostId: PAIRED, status: 'idle' as const }))
  const snapshot: AgentHostSnapshot = { ...localSnapshot, hostId: PAIRED, connected: true, threads }
  let projection: WatcherHostProjection | undefined
  const hosts: ReturnType<WatcherRemoteHosts['hosts']> = [{ hostId: PAIRED, connected: true, reads: true, control: true, permissionCeiling: 'approval-required' }]
  const remote: WatcherRemoteHosts = { hosts: () => hosts, snapshot: id => id === PAIRED ? snapshot : undefined, read: async () => structuredClone(projection!),
    projection: () => projection, control: vi.fn(), subscribe: () => () => undefined }
  // A pushed projection is reconciled from the router's copy of it, not read again.
  const reconcile = () => (watcher as unknown as { reconcileRemote(hostId?: string, force?: boolean): Promise<void> }).reconcileRemote(PAIRED, false)
  // What the host projects to this desktop: the requests taking part there and the operations it ran, as the record holds them.
  const held = () => {
    const now = f.control.watcherRecords.copy()
    const requests = now.requests.filter(request => request.participants.some(item => item.target.hostId === PAIRED)).slice(-1_000)
    const operations = now.operations.filter(item => item.target.hostId === PAIRED).slice(-1_000)
    projection = { hostId: PAIRED, master: now.current!, revision: `revision-${requests.length}-${operations.length}`, observedAt: new Date().toISOString(), requests, operations, evidence: [] }
  }
  held()
  watcher.useRemoteHosts(remote)
  // Whatever the first passes settle, the projection then says what the record holds.
  await reconcile(); held(); await reconcile(); held()
  return { control: f.control, reconcile, projection: () => projection!, recordBytes: JSON.stringify(f.control.watcherRecords.view()).length }
}

/** The array methods a search of a list goes through, and its iterator, which a `for...of` walk does. */
const WALKS = ['find', 'findIndex', 'filter', 'some', 'every', 'forEach', 'map', 'flatMap', 'reduce', Symbol.iterator] as const

/** How many times `passes` reconciles walk the record's requests and its operations, each one as it stood before them. */
async function walksOf(paired: Awaited<ReturnType<typeof ownerPairedWatcher>>, passes: number) {
  const record = paired.control.watcherRecords.view(), lists = new Map<unknown, 'requests' | 'operations'>([[record.requests, 'requests'], [record.operations, 'operations']])
  const walks = { requests: 0, operations: 0 }, prototype = Array.prototype as unknown as Record<PropertyKey, (...parameters: unknown[]) => unknown>
  const originals = WALKS.map(name => [name, prototype[name]!] as const)
  for (const [name, original] of originals) prototype[name] = function (this: unknown, ...parameters: unknown[]) {
    const list = lists.get(this)
    if (list) walks[list]++
    return original.apply(this, parameters)
  }
  try { for (let pass = 0; pass < passes; pass++) await paired.reconcile() } finally { for (const [name, original] of originals) prototype[name] = original }
  expect(paired.control.watcherRecords.view()).toBe(record)
  return { requests: walks.requests / passes, operations: walks.operations / passes }
}

it('walks the owner\'s record a fixed number of times a reconcile, not once for each item the host projects', async () => {
  const paired = await ownerPairedWatcher(), walks = await walksOf(paired, 3)
  // The host projects 483 requests and 518 operations here. A search of the record for each was 490 walks of its requests
  // and 523 of its operations a pass. A pass now walks its requests 8 times and its operations 6 times, for the whole
  // host and the observe pass at its end, however much the host projects.
  expect(paired.projection().requests.length).toBeGreaterThan(400)
  expect(paired.projection().operations.length).toBeGreaterThan(400)
  expect(walks.requests).toBeLessThanOrEqual(12)
  expect(walks.operations).toBeLessThanOrEqual(12)
}, 60_000)

it.skipIf(!PERF_BENCH)('measures a reconcile of a paired host with the owner\'s record', async () => {
  const paired = await ownerPairedWatcher()
  const before = paired.control.watcherRecords.view()
  for (let pass = 0; pass < 5; pass++) await paired.reconcile()
  const times: number[] = []
  for (let pass = 0; pass < 30; pass++) { const start = performance.now(); await paired.reconcile(); times.push(performance.now() - start) }
  expect(paired.control.watcherRecords.view()).toBe(before)
  console.log(`OWNER-RECONCILE ${JSON.stringify({ recordBytes: paired.recordBytes, projectedRequests: paired.projection().requests.length,
    projectedOperations: paired.projection().operations.length, medianMs: round(median(times), 2), minMs: round(Math.min(...times), 2), maxMs: round(Math.max(...times), 2) })}`)
}, 120_000)
