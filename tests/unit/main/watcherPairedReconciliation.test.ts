// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { WatcherService } from '../../../src/main/agents/watcher'
import type { AgentHostSnapshot } from '../../../src/shared/agents'
import type { WatcherHostProjection, WatcherRemoteHosts } from '../../../src/shared/watcherHost'
import { watcherRecordFixture } from '../../fixtures/watcher'
import { workspaceFixture } from '../../fixtures/workspaceFixture'
import { agentControlFixture } from '../../fixtures/agentControlFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const workspace = await workspaceFixture(undefined, { history: false })
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => false, watcherEnabled: true } })
  const watcher = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => false, limit: () => 4 })
  cleanups.push(async () => { watcher.close(); await f.dispose(); await workspace.stop(); await workspace.remove() })
  await f.control.start(); await f.control.commandShell({ type: 'connect', provider: 'codex' })
  const record = watcherRecordFixture(), local = f.control.hostId()!, hostId = randomUUID()
  record.current!.target.hostId = local; record.requests[0]!.watcher.hostId = local
  record.requests[0]!.participants[0]!.target.hostId = hostId
  record.operations[0]!.target.hostId = hostId; record.reservations[0]!.target.hostId = hostId
  await f.control.updateWatcher(next => Object.assign(next, structuredClone(record)))
  const localSnapshot = f.control.watcherSnapshot(), native = localSnapshot.threads[0]!
  const snapshot: AgentHostSnapshot = { ...localSnapshot, hostId, connected: true, threads: [{ ...native, id: 'worker', hostId, status: 'running' }] }
  let projection: WatcherHostProjection = { hostId, master: record.current!, revision: 'initial', observedAt: new Date().toISOString(), requests: [], operations: [], evidence: [] }
  const read = vi.fn(async () => structuredClone(projection))
  const hosts: ReturnType<WatcherRemoteHosts['hosts']> = [{ hostId, connected: true, reads: true, control: true, permissionCeiling: 'approval-required' }]
  const remote: WatcherRemoteHosts = { hosts: () => hosts, snapshot: id => id === hostId ? snapshot : undefined, read, control: vi.fn(), subscribe: () => () => undefined }
  const reconcile = () => (watcher as unknown as { reconcileRemote(): Promise<void> }).reconcileRemote()
  watcher.useRemoteHosts(remote); await reconcile()
  return { ...f, workspace, watcher, record, local, hostId, snapshot, hosts, remote, read, reconcile, projection: (value: WatcherHostProjection) => { projection = value } }
}

it('accepts only owning-host state fields and never lets a projection lower budgets or rewrite operation identity', async () => {
  const f = await fixture(), record = f.control.watcherRecord(), request = record.requests[0]!
  const own = request.participants[0]!, operation = record.operations[0]!
  await f.control.updateWatcher(next => {
    const request = next.requests[0]!
    for (const hostId of [f.local, randomUUID()]) {
      const target = { hostId, threadId: 'foreign' }
      request.participants.push({ ...structuredClone(own), target, promptCount: 3 })
      next.operations.push({ ...structuredClone(operation), id: randomUUID(), retryKey: randomUUID(), receiptId: randomUUID(), cardId: randomUUID(), messageId: randomUUID(), target, deliveryState: 'uncertain' })
      next.reservations.push({ ...next.reservations[0]!, target, operationId: next.operations.at(-1)!.id })
    }
  })
  const before = structuredClone(f.control.watcherRecord()), forged = structuredClone(before)
  for (const participant of forged.requests[0]!.participants) {
    participant.promptCount = 0; participant.startedBy = 'user'; participant.state = 'relinquished'
  }
  for (const receipt of forged.operations) { receipt.anchorMessageId = 'forged'; receipt.receiptId = randomUUID(); receipt.deliveryState = 'accepted' }
  f.projection({ hostId: f.hostId, master: before.current!, revision: 'forged', observedAt: new Date().toISOString(), requests: forged.requests, operations: forged.operations, evidence: [] })
  await f.reconcile()
  const after = f.control.watcherRecord()
  expect(after.requests[0]!.participants.slice(1)).toEqual(before.requests[0]!.participants.slice(1))
  expect(after.operations.slice(1)).toEqual(before.operations.slice(1))
  expect(after.requests[0]!.participants[0]).toMatchObject({ promptCount: 1, requestId: own.requestId, startedBy: 'watcher' })
  expect(after.operations[0]).toMatchObject({ requestId: operation.requestId, receiptId: operation.receiptId })
  expect(after.operations[0]!.anchorMessageId).toBe(operation.anchorMessageId)
})

it('keeps a validated accepted control receipt when its follow-up projection read fails', async () => {
  const f = await fixture(), operation = f.control.watcherRecord().operations[0]!
  const input = { requestId: operation.requestId, retryKey: operation.retryKey, target: operation.target, delivery: 'now' as const, text: 'Synthetic send' }
  const receipt = { operationId: operation.id, target: operation.target, requestId: operation.requestId, deliveryState: 'accepted', receiptId: operation.receiptId, cardId: operation.cardId }
  vi.mocked(f.remote.control).mockResolvedValue({ status: 'ok', receipt, limits: { inFlight: 1, inFlightLimit: 4, promptCount: 1, promptLimit: 4 }, delivery: 'now' })
  f.read.mockRejectedValue(new Error('synthetic-read-failed'))
  const result = await (f.watcher as unknown as { executeRemote(name: string, operation: typeof operation, input: unknown): Promise<unknown> }).executeRemote('send_to_thread', operation, input)
  expect(result).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  expect(f.control.watcherRecord().operations[0]!.deliveryState).toBe('accepted')
})
