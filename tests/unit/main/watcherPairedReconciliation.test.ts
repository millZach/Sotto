// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { SocketHostService } from '../../../src/main/agents/socketHostService'
import { DesktopHostRouter } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { WatcherService } from '../../../src/main/agents/watcher'
import type { AgentHostSnapshot } from '../../../src/shared/agents'
import type { WatcherHostProjection, WatcherRemoteHosts } from '../../../src/shared/watcherHost'
import { watcherToolSchemas } from '../../../src/shared/watcher'
import { watcherRecordFixture } from '../../fixtures/watcher'
import { workspaceFixture } from '../../fixtures/workspaceFixture'
import { agentControlFixture } from '../../fixtures/agentControlFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
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
  let projection: WatcherHostProjection = { hostId, master: record.current!, revision: 'initial', observedAt: new Date().toISOString(), requests: record.requests, operations: record.operations, evidence: [] }
  const read = vi.fn<WatcherRemoteHosts['read']>(async (_hostId, _request) => { void _hostId; void _request; return structuredClone(projection) })
  const hosts: ReturnType<WatcherRemoteHosts['hosts']> = [{ hostId, connected: true, reads: true, control: true, permissionCeiling: 'approval-required' }]
  let changed: ((hostId?: string, force?: boolean) => void) | undefined
  const remote: WatcherRemoteHosts = { hosts: () => hosts, snapshot: id => id === hostId ? snapshot : undefined, read, control: vi.fn(), subscribe: listener => { changed = listener; return () => { changed = undefined } } }
  const reconcile = () => (watcher as unknown as { reconcileRemote(): Promise<void> }).reconcileRemote()
  watcher.useRemoteHosts(remote); await reconcile()
  return { ...f, workspace, watcher, record, local, hostId, snapshot, hosts, remote, read, reconcile, emit: (id?: string, force?: boolean) => changed?.(id, force), drained: () => (watcher as unknown as { reconciling?: Promise<void> }).reconciling ?? Promise.resolve(), projection: (value: WatcherHostProjection) => { projection = value } }
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
  const result = await (f.watcher as unknown as { executeRemote(name: string, saved: typeof operation, input: unknown): Promise<unknown> }).executeRemote('send_to_thread', operation, input)
  expect(result).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  expect(f.control.watcherRecord().operations[0]!.deliveryState).toBe('accepted')
})

it.each(['queued', 'dispatching', 'uncertain'] as const)('keeps a definitive paired failure refunded once after an older %s projection', async pending => {
  const f = await fixture()
  await f.control.updateWatcher(record => {
    const second = record.operations[0]!
    record.operations.unshift({ ...structuredClone(second), id: randomUUID(), retryKey: randomUUID(), digest: 'b'.repeat(64),
      action: 'start', deliveryState: 'accepted', receiptId: 'first-receipt', cardId: 'first-card', messageId: 'first-message',
      creationReceiptId: 'first-creation', firstPromptReceiptId: 'first-prompt' })
    record.requests[0]!.participants[0]!.promptCount = 2
  })
  const record = f.control.watcherRecord(), first = record.operations[0]!, second = record.operations[1]!
  const failed = { ...second, deliveryState: 'failed' as const, refusalCode: 'PENDING_USER_REQUEST' as const,
    commandId: 'held-command', updatedAt: '2026-10-09T10:00:02.000Z' }
  const project = (operation: typeof second) => f.projection({ hostId: f.hostId, master: record.current!, revision: operation.deliveryState,
    observedAt: operation.updatedAt, requests: record.requests, operations: [first, operation], evidence: [] })
  project(failed); await f.reconcile()
  expect(f.control.watcherRecord().requests[0]!.participants[0]!.promptCount).toBe(1)
  const refunded = f.control.watcherRecord().operations[1]!
  project({ ...second, deliveryState: pending, refusalCode: 'DELIVERY_UNCERTAIN', commandId: 'older-command', itemId: 'older-item', creationUncertain: true })
  await f.reconcile()
  const afterOlder = f.control.watcherRecord().operations[1]!
  project(failed); await f.reconcile()
  // Check the budget first: an older in-flight receipt must not resurrect and refund this same send twice.
  expect(f.control.watcherRecord().requests[0]!.participants[0]!.promptCount).toBe(1)
  expect(afterOlder).toEqual(refunded)
  expect(f.control.watcherRecord().operations).toEqual([first, refunded])
  expect(f.remote.control).not.toHaveBeenCalled()
})

it('keeps an accepted paired outcome whole when an older failure projection arrives', async () => {
  const f = await fixture(), record = f.control.watcherRecord(), original = record.operations[0]!
  const accepted = { ...original, deliveryState: 'accepted' as const, commandId: 'accepted-command', updatedAt: '2026-10-09T10:00:02.000Z' }
  await f.control.updateWatcher(next => { next.operations[0] = accepted })
  f.projection({ hostId: f.hostId, master: record.current!, revision: 'older-failure', observedAt: original.updatedAt,
    requests: record.requests, operations: [{ ...original, deliveryState: 'failed', refusalCode: 'PROVIDER_UNAVAILABLE', creationUncertain: true }], evidence: [] })
  await f.reconcile()
  expect(f.control.watcherRecord().operations[0]).toEqual(accepted)
  expect(f.control.watcherRecord().requests[0]!.participants[0]!.promptCount).toBe(1)
  expect(f.remote.control).not.toHaveBeenCalled()
})

it('keeps a definitive paired refusal on retry when its follow-up projection read fails', async () => {
  const f = await fixture(), operation = f.control.watcherRecord().operations[0]!
  const input = watcherToolSchemas.send_to_thread.input.parse({ requestId: operation.requestId, retryKey: operation.retryKey, target: operation.target, delivery: 'now', text: 'Synthetic refused send' })
  const receipt = { operationId: operation.id, target: operation.target, requestId: operation.requestId, deliveryState: 'failed', receiptId: operation.receiptId, cardId: operation.cardId }
  vi.mocked(f.remote.control).mockResolvedValue({ status: 'refused', code: 'PENDING_USER_REQUEST', message: 'Synthetic pending question', retryable: false, receipt })
  f.read.mockRejectedValue(new Error('synthetic-read-failed'))
  await f.control.updateWatcher(record => { record.operations[0]!.inputDigest = createHash('sha256').update(JSON.stringify(['send_to_thread', input])).digest('hex') })
  const result = await (f.watcher as unknown as { executeRemote(name: string, saved: typeof operation, input: unknown): Promise<unknown> }).executeRemote('send_to_thread', operation, input)
  expect(result).toMatchObject({ status: 'refused', code: 'PENDING_USER_REQUEST', receipt })
  const retry = await f.watcher.invoke(f.control.watcherRecord().current!.target.threadId, 'send_to_thread', input)
  expect(retry).toMatchObject({ status: 'refused', code: 'PENDING_USER_REQUEST', receipt })
  expect(f.control.watcherRecord().requests[0]!.participants[0]!.promptCount).toBe(0)
  expect(f.remote.control).toHaveBeenCalledOnce()
})

it('reconciles an uncertain paired refusal to acceptance without retaining a failure on retry', async () => {
  const f = await fixture(), operation = f.control.watcherRecord().operations[0]!
  const input = watcherToolSchemas.send_to_thread.input.parse({ requestId: operation.requestId, retryKey: operation.retryKey, target: operation.target, delivery: 'now', text: 'Synthetic uncertain send' })
  const receipt = { operationId: operation.id, target: operation.target, requestId: operation.requestId, deliveryState: 'uncertain', receiptId: operation.receiptId, cardId: operation.cardId }
  vi.mocked(f.remote.control).mockResolvedValue({ status: 'refused', code: 'DELIVERY_UNCERTAIN', message: 'Synthetic unavailable acknowledgement', retryable: true, receipt })
  f.read.mockRejectedValue(new Error('synthetic-read-failed'))
  await f.control.updateWatcher(record => { record.operations[0]!.inputDigest = createHash('sha256').update(JSON.stringify(['send_to_thread', input])).digest('hex') })
  const result = await (f.watcher as unknown as { executeRemote(name: string, saved: typeof operation, input: unknown): Promise<unknown> }).executeRemote('send_to_thread', operation, input)
  expect(result).toMatchObject({ status: 'refused', code: 'DELIVERY_UNCERTAIN', receipt })
  expect(f.control.watcherRecord().requests[0]!.participants[0]!.promptCount).toBe(1)
  const record = f.control.watcherRecord(), accepted = { ...operation, deliveryState: 'accepted' as const }
  f.read.mockResolvedValue({ hostId: f.hostId, master: record.current!, revision: 'accepted', observedAt: accepted.updatedAt,
    requests: record.requests, operations: [accepted], evidence: [] })
  await f.reconcile()
  const retry = await f.watcher.invoke(record.current!.target.threadId, 'send_to_thread', input)
  expect(retry).toMatchObject({ status: 'ok', receipt: { ...receipt, deliveryState: 'accepted' } })
  expect(f.control.watcherRecord().operations[0]!.refusalCode).toBeUndefined()
  expect(f.control.watcherRecord().requests[0]!.participants[0]!.promptCount).toBe(1)
  expect(f.remote.control).toHaveBeenCalledOnce()
})

it('continues to another owning host when the first projection read fails', async () => {
  const f = await fixture(), other = randomUUID()
  await f.control.updateWatcher(next => {
    const target = { hostId: other, threadId: 'other-worker' }
    next.requests[0]!.participants.push({ ...next.requests[0]!.participants[0]!, target })
    next.operations.push({ ...next.operations[0]!, id: randomUUID(), retryKey: randomUUID(), receiptId: randomUUID(), cardId: randomUUID(), messageId: randomUUID(), target })
    next.reservations.push({ ...next.reservations[0]!, target, operationId: next.operations[1]!.id })
  })
  const own = f.control.watcherRecord()
  f.hosts.push({ ...f.hosts[0]!, hostId: other })
  f.read.mockImplementation(async id => {
    if (id === f.hostId) throw new Error('synthetic-offline')
    return { hostId: other, master: own.current!, revision: 'accepted', observedAt: new Date().toISOString(), requests: [], operations: [{ ...own.operations[1]!, deliveryState: 'accepted' }], evidence: [] }
  })
  await f.reconcile()
  expect(f.read).toHaveBeenCalledWith(f.hostId, { master: own.current })
  expect(f.read).toHaveBeenCalledWith(other, { master: own.current })
  expect(f.control.watcherRecord().operations[0]!.deliveryState).toBe('uncertain')
  expect(f.control.watcherRecord().operations[1]!.deliveryState).toBe('accepted')
})

it('closes a request when its connected owning-host worker is settled', async () => {
  const f = await fixture()
  await f.control.updateWatcher(next => { next.operations[0]!.deliveryState = 'accepted' })
  f.snapshot.threads[0]!.status = 'idle'; f.snapshot.threads[0]!.workspaceSettledAt = new Date().toISOString()
  f.snapshot.connected = false
  f.watcher.observe(f.control.watcherSnapshot(), new Set())
  expect(f.control.watcherRecord().requests[0]!.state).toBe('active')
  f.snapshot.connected = true
  await f.reconcile()
  expect(f.control.watcherRecord().requests[0]!.state).toBe('closed')
})

it('keeps a bounded omitted operation until an exact owning receipt answers', async () => {
  const f = await fixture(), record = f.control.watcherRecord(), operation = record.operations[0]!
  f.read.mockImplementation(async (_id, request) => request.call ? { status: 'ok', action: 'send',
    receipt: { operationId: operation.id, requestId: operation.requestId, target: operation.target, receiptId: operation.receiptId, cardId: operation.cardId, deliveryState: 'accepted' },
    limits: { inFlight: 1, inFlightLimit: 4, promptCount: 1, promptLimit: 4 }, state: { status: 'running', stopped: false, settled: false, backgroundWorkCount: 0, observedAt: new Date().toISOString(), freshness: 'fresh' } }
    : { hostId: f.hostId, master: record.current!, revision: 'bounded', observedAt: new Date().toISOString(), requests: [], operations: [], evidence: [] })
  await f.reconcile()
  expect(f.control.watcherRecord().operations[0]!.deliveryState).toBe('accepted')
  expect(f.control.watcherRecord().requests[0]!.participants[0]!.promptCount).toBe(1)
  expect(f.control.watcherRecord().reservations).toHaveLength(1)
})

it('keeps uncertainty when the owning absence-fence store is full', async () => {
  const f = await fixture(), master = f.control.watcherRecord().current!
  await f.control.updateWatcher(record => { record.remoteAbsences = Array.from({ length: 1_000 }, () => ({ operationId: randomUUID(), master, clientId: 'synthetic', observedAt: new Date().toISOString() })) })
  expect(await f.watcher.readRemote({ master, call: { name: 'read_operation', input: { operationId: randomUUID() } } }, 'synthetic')).toMatchObject({ code: 'DELIVERY_UNCERTAIN' })
  expect(f.control.watcherRecord().remoteAbsences).toHaveLength(1_000)
})

it('does not treat an unknown receipt in another client scope as proof of non-admission', async () => {
  const f = await fixture(), record = f.control.watcherRecord()
  f.read.mockImplementation(async (_id, request) => request.call ? { status: 'refused', code: 'UNKNOWN_OPERATION', message: 'Synthetic different scope', retryable: false }
    : { hostId: f.hostId, master: record.current!, revision: 'other-scope', observedAt: new Date().toISOString(), requests: [], operations: [], evidence: [] })
  await f.reconcile()
  expect(f.control.watcherRecord().operations[0]!.deliveryState).toBe('uncertain')
  expect(f.watcher.state().inFlight).toBe(1)
})

it.each(['removed', 'reads-unavailable'])('holds an uncertain slot when its host is %s', async unavailable => {
  const f = await fixture()
  if (unavailable === 'removed') f.hosts.splice(0)
  else f.hosts[0]!.reads = false
  await f.reconcile(); f.watcher.observe(f.control.watcherSnapshot(), new Set())
  expect(f.control.watcherRecord().operations[0]!.deliveryState).toBe('uncertain')
  expect(f.watcher.state().inFlight).toBe(1)
  expect(f.control.watcherRecord().requests[0]!.participants[0]!.promptCount).toBe(1)
})

it.each(['owner', 'foreign'])('stopped request feedback from %s preserves user queues and rejects other clients', async caller => {
  const f = await fixture(), thread = f.control.watcherSnapshot().threads[0]!
  await f.control.commandShell({ type: 'queue-followup', threadId: thread.id, draftId: randomUUID(), text: 'Synthetic retained user queue' })
  const userIds = f.control.shell().followups!.map(item => item.id)
  expect(userIds.length).toBeGreaterThan(0)
  const master = { ...f.control.watcherRecord().current!, target: { hostId: randomUUID(), threadId: 'remote-master' } }
  await f.control.updateWatcher(record => {
    const request = record.requests[0]!
    request.watcher = master.target; request.remoteOrigin = { clientId: 'owner', master, creationOperationId: master.creationOperationId, ceiling: 'approval-required' }
    request.participants[0]!.target = { hostId: f.local, threadId: thread.id }; request.participants[0]!.startedBy = 'user'
    record.operations[0]!.target = request.participants[0]!.target; record.operations[0]!.deliveryState = 'queued'
    record.reservations[0]!.target = request.participants[0]!.target
  })
  const request = f.control.watcherRecord().requests[0]!
  const result = await f.watcher.readRemote({ master, stoppedRequests: [{ request: { id: request.id, watcher: request.watcher, rootUserMessageId: request.rootUserMessageId, createdAt: request.createdAt }, ceiling: 'approval-required' }] }, caller)
  expect(f.control.watcherRecord().requests[0]!.state).toBe(caller === 'owner' ? 'stopped' : 'active')
  if (caller === 'foreign') expect(result).toMatchObject({ code: 'RETRY_KEY_CONFLICT' })
  expect(f.control.shell().followups!.map(item => item.id)).toEqual(userIds)
})

it('coalesces progress-only owning pushes without reads or persistence and skips unused hosts', async () => {
  const f = await fixture(), record = f.control.watcherRecord()
  const projection: WatcherHostProjection = { hostId: f.hostId, master: record.current!, revision: 'progress', observedAt: new Date().toISOString(), requests: record.requests, operations: record.operations, evidence: [], progress: [{ target: record.operations[0]!.target, fingerprint: 'a'.repeat(64) }] }
  const cached = vi.fn(() => projection)
  Object.assign(f.remote, { projection: cached })
  f.hosts.push({ ...f.hosts[0]!, hostId: randomUUID() })
  const writes = vi.spyOn(f.control, 'updateWatcher'); f.read.mockClear()
  vi.useFakeTimers()
  for (let n = 0; n < 100; n++) f.emit(undefined, false)
  await vi.advanceTimersByTimeAsync(250); await f.drained()
  expect(cached).toHaveBeenCalledOnce()
  expect(cached).toHaveBeenCalledWith(f.hostId, record.current)
  expect(f.read).not.toHaveBeenCalled()
  expect(writes).not.toHaveBeenCalled()
  vi.useRealTimers()
})

it('does not turn ordinary shell streaming into Watcher reads and exposes typed owning pushes', async () => {
  const f = await fixture(), state = f.control.shell(), master = f.control.watcherRecord().current!
  const socket = new SocketHostService({ url: 'http://127.0.0.1:1', token: 'synthetic', watcherEnabled: true })
  const internal = socket as unknown as { cached: typeof state; features: string[]; notifyState(): void; receive(text: string): void }
  internal.cached = { ...state, stale: false, host: { ...state.host, hostId: f.hostId } }; internal.features = ['watcher-control', 'watcher-reads']
  const router = new DesktopHostRouter(emptyDesktopState, { watcherEnabled: true })
  cleanups.push(async () => { router.dispose(); await socket.close() })
  router.add({ hostId: f.hostId, name: 'Synthetic', kind: 'remote', service: socket, detail: id => socket.readThreadDetail(id), preview: () => null })
  const changed = vi.fn(); router.watcherHosts().subscribe(changed)
  for (let n = 0; n < 100; n++) internal.notifyState()
  expect(changed).not.toHaveBeenCalled()
  internal.receive(JSON.stringify({ v: 1, event: 'watcher-state', projection: { hostId: f.hostId, master, revision: 'typed', observedAt: new Date().toISOString(), requests: [], operations: [], evidence: [] } }))
  expect(changed).toHaveBeenCalledOnce()
  expect(changed).toHaveBeenCalledWith(f.hostId, false)
})

it('backs off a failing owning read while further pushes are coalesced', async () => {
  const f = await fixture()
  f.read.mockClear(); f.read.mockRejectedValue(new Error('synthetic-retry'))
  vi.useFakeTimers()
  f.emit(f.hostId, false)
  await vi.advanceTimersByTimeAsync(250); await f.drained()
  expect(f.read).toHaveBeenCalledTimes(1)
  for (let n = 0; n < 100; n++) f.emit(f.hostId, false)
  await vi.advanceTimersByTimeAsync(999); await f.drained()
  expect(f.read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1); await f.drained()
  expect(f.read).toHaveBeenCalledTimes(2)
  vi.useRealTimers()
})
