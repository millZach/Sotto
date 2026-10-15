// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { WatcherService } from '../../src/main/agents/watcher'
import { createWatcherRoomDesktop } from '../../src/main/agents/watcherRoomDesktop'
import { registerIpc } from '../../src/main/ipc/registerIpc'
import { WATCHER_PREPARE_STOP_ALL, WATCHER_STOP_ALL, type WatcherPrepareStopAllResult, type WatcherRoomState, type WatcherStopAllResult } from '../../src/shared/watcherRoom'
import { createIpcHarness } from '../fixtures/ipcHarness'
import { WatcherPhoneService } from '../../src/main/agents/watcherPhone'
import { LocalHostService } from '../../src/main/agents/hostService'
import { PairedClients } from '../../src/main/agents/pairing'
import { startSocketServer } from '../../src/host/socketServer'
import { canonicalModelId } from '../../src/shared/modelCatalog'
import { rawPeer } from '../fixtures/rawHostPeer'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { DESKTOP_CLIENTS_FILE } from '../../src/shared/desktopClients'
import { watcherToolSchemas, type WatcherToolName, type WatcherToolOutput } from '../../src/shared/watcher'
import { watcherHostControlSchema, type WatcherHostControl, type WatcherHostProjection } from '../../src/shared/watcherHost'
import type { HostOperation } from '../../src/shared/hostProtocol'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { startFixtureHeadlessHost } from '../fixtures/desktopHostStack'
import { codexFixture } from '../fixtures/codexFixture'
import { heldOperation } from '../fixtures/deferred'
import type { CodexAppServerHost } from '../../src/main/agents/codex'

const remote = useSocketHostFixture()
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() } finally { vi.restoreAllMocks() } })

async function pairedDesktop(record = true, gate = true) {
  const pairing = await SocketHostService.pair(remote.url, remote.host.pairing.issuePairingCode().code, 'Synthetic desktop')
  if (record) await writeFile(join(remote.root, DESKTOP_CLIENTS_FILE), JSON.stringify([pairing.clientId]))
  const socket = new SocketHostService({ url: remote.url, token: pairing.token, watcherEnabled: gate })
  remote.clients.push(socket)
  const hello = await socket.connect()
  await socket.command({ type: 'connect', provider: 'codex' })
  const path = join(remote.root, 'worker-project'); await mkdir(path, { recursive: true })
  await socket.command({ type: 'create-project', provider: 'codex', title: 'Synthetic remote project', path, useExisting: true })
  return { socket, pairing, hello, project: socket.shell().host.projects.find(item => item.path === path)!,
    model: socket.shell().host.models.find(item => item.providerId === 'codex' && item.ready)! }
}
async function master(native?: CodexAppServerHost, usage = false) {
  if (native || usage) { await remote.host.close(); remote.host = await startFixtureHeadlessHost({ dataDirectory: remote.root, port: 0, providers: { codex: native ?? remote.native },
    ...(usage ? { sottoVersion: '0.1.38-owl.20261013.1' } : {}) }); remote.url = 'http://127.0.0.1:' + remote.host.descriptor!.port }
  const paired = await pairedDesktop()
  const workspace = await workspaceFixture(undefined, { history: false })
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host,
    credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => false, watcherEnabled: true } })
  const watcher = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => false, limit: () => 1 })
  const tools = new WatcherToolServer(watcher); workspace.host.useWatcherTools(tools)
  const router = new DesktopHostRouter(emptyDesktopState, { watcherEnabled: true })
  const connection = { hostId: paired.pairing.hostId, name: 'Synthetic remote', kind: 'remote' as const, service: paired.socket,
    detail: (id: string) => paired.socket.readThreadDetail(id), preview: () => null }
  router.add(connection); watcher.useRemoteHosts(router.watcherHosts())
  cleanups.push(async () => { watcher.close(); await (watcher as unknown as { reconciling?: Promise<void> }).reconciling?.catch(() => undefined); router.dispose(); await tools.close(); f.control.dispose(); await f.control.closed(); await workspace.stop(); await workspace.remove() })
  await f.control.start(); await f.control.commandShell({ type: 'connect', provider: 'codex' }); await watcher.recover()
  const model = f.control.shell().host.models.find(item => item.providerId === 'codex')!
  expect(await watcher.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const id = watcher.state().current!.target.threadId
  await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic master request' })
  const requestId = watcher.state().requests.at(-1)!.id
  const start = () => ({ requestId, retryKey: randomUUID(), project: { hostId: paired.pairing.hostId, projectId: paired.project.id },
    modelId: paired.model.id, title: 'Synthetic remote worker', workingCopy: { kind: 'shared' as const }, firstPrompt: 'host_private_prompt_19cb' })
  const call = async <N extends WatcherToolName>(name: N, input: unknown): Promise<WatcherToolOutput<N>> => {
    const result = watcherToolSchemas[name].output.parse(await watcher.invoke(id, name, input)) as WatcherToolOutput<N>
    if ('receipt' in result && result.receipt) {
      const receipt = result.receipt
      await expect.poll(() => f.control.watcherRecord().operations.find(item => item.id === receipt.operationId)).toMatchObject({ requestId: receipt.requestId, target: receipt.target })
    }
    if (name === 'start_thread' && result.status === 'ok' && 'target' in result) {
      const target = result.target
      await expect.poll(() => paired.socket.shell().host.threads.some(thread => thread.id === target.threadId)).toBe(true)
    }
    return result
  }
  return { ...f, ...paired, watcher, router, connection, workspace, id, requestId, start, call }
}

it('negotiates host-v1 features only for recorded desktops and never for stable desktop automation', async () => {
  const health = await (await fetch(remote.url + '/v1/health')).json() as { v: number; features: string[] }
  expect(health.v).toBe(1); expect(health.features).toContain('watcher-control'); expect(health.features).toContain('watcher-reads')
  const general = await pairedDesktop(false)
  expect(general.hello.features).not.toContain('watcher-control')
  expect(general.socket.supportsWatcherWorkSettled).toBe(false)
  // A recorded desktop learns the host reports the work counts work-settled news needs.
  const recorded = await pairedDesktop()
  expect(recorded.hello.features).toContain('watcher-work-settled'); expect(recorded.socket.supportsWatcherWorkSettled).toBe(true)
  const raw = general.socket as unknown as { call(op: HostOperation): Promise<unknown> }
  await expect(raw.call({ op: 'watcher-read', request: { master: { target: { hostId: randomUUID(), threadId: 'forged' }, projectId: 'forged', provider: 'codex', creationOperationId: randomUUID(), createdAt: new Date().toISOString() } } })).rejects.toMatchObject({ code: 'forbidden' })
  const stable = await pairedDesktop(true, false)
  expect(stable.socket.supportsWatcherControl).toBe(false); expect(stable.socket.supportsWatcherWorkSettled).toBe(false)
  await expect(stable.socket.watcherRead({ master: { target: { hostId: randomUUID(), threadId: 'master' }, projectId: 'master', provider: 'codex', creationOperationId: randomUUID(), createdAt: new Date().toISOString() } })).rejects.toMatchObject({ code: 'invalid_request' })
})

it('starts, reads positions, sends, stops and settles through the owning host without selecting it', async () => {
  const f = await master(), selected = f.router.shell().activeThreadId, input = f.start()
  expect(f.router.watcherHosts().hosts()).toEqual([expect.objectContaining({ hostId: f.pairing.hostId, workSettled: true })])
  const first = await f.call('start_thread', input)
  expect(first).toMatchObject({ status: 'ok', limits: { inFlightLimit: 1, promptCount: 1 } })
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start-refused')
  expect(await f.call('start_thread', input)).toMatchObject({ receipt: { operationId: first.receipt.operationId } })
  const read = await f.call('read_thread', { target: first.target })
  expect(read).toMatchObject({ status: 'ok', messages: [{ text: input.firstPrompt, position: 0 }] })
  if (read.status !== 'ok' || !('historyEpoch' in read)) throw new Error('read-refused')
  expect(await f.call('read_thread', { target: first.target, position: { historyEpoch: 'wrong-epoch', afterPosition: -1 } })).toMatchObject({ code: 'HISTORY_RESET' })
  remote.native.event({ type: 'ready', threadId: (await remote.native.snapshot()).threads.find(item => item.title === input.title)!.id, text: 'Synthetic completion' })
  await f.socket.command({ type: 'refresh', provider: 'codex' })
  await vi.waitFor(() => expect(f.socket.shell().host.threads.find(item => item.id === first.target.threadId)?.status).toBe('idle'))
  expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, text: 'Synthetic second prompt', delivery: 'now' })).toMatchObject({ status: 'ok', limits: { promptCount: 2 } })
  expect(await f.call('stop_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target })).toMatchObject({ status: 'ok', stopRequested: true })
  await vi.waitFor(() => expect(f.socket.shell().host.threads.find(item => item.id === first.target.threadId)?.status).toBe('idle'))
  const settled = await f.call('settle_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target })
  expect(settled.status, settled.status === 'refused' ? settled.code : undefined).toBe('ok')
  const afterSettlement = { requestId: f.requestId, retryKey: randomUUID(), target: first.target, text: 'Synthetic settled refusal', delivery: 'now' }
  expect(await f.call('send_to_thread', afterSettlement)).toMatchObject({ code: 'REQUEST_NOT_ACTIVE' })
  // A stale master projection must not revive participation on the owning host. The host's background reconcile
  // would correct the stale record before the send reads it, so it is held back and drained first: the refusal
  // asserted below must come from the owning host.
  vi.spyOn(f.watcher as unknown as { scheduleRemote: () => void }, 'scheduleRemote').mockImplementation(() => undefined)
  const background = f.watcher as unknown as { remoteTimer?: unknown; remoteFlushing: boolean; reconciling?: Promise<void> }
  await expect.poll(() => !background.remoteTimer && !background.remoteFlushing && !background.reconciling).toBe(true)
  // Standing sends now refresh owning fences at admission too. Hold that read so this still exercises the writer.
  vi.spyOn(f.watcher as unknown as { reconcileRemote(): Promise<void> }, 'reconcileRemote').mockResolvedValue(undefined)
  await f.control.updateWatcher(record => {
    const request = record.requests.find(item => item.id === f.requestId)!
    request.state = 'active'; request.closedAt = null
    const participant = request.participants[0]!
    participant.state = 'participating'; delete participant.automationStopped
    // Revive the stale assignment generation as well, so the master's new guard cannot hide the owner's refusal.
    participant.generation = record.watches!.find(watch => watch.target.threadId === first.target.threadId)!.generation
  })
  const writes = vi.spyOn(f.socket, 'watcherControl')
  expect(await f.call('send_to_thread', afterSettlement)).toMatchObject({ code: 'REQUEST_NOT_ACTIVE' })
  expect(writes).toHaveBeenCalledOnce()
  expect(f.router.shell().activeThreadId).toBe(selected)
  const record = await readFile(join(remote.root, 'agents.json'), 'utf8')
  expect(record).not.toContain(input.firstPrompt); expect(record).toContain('remoteOrigin')
})

it('holds a lost acknowledgement through disconnection and reconciles without another send', async () => {
  const f = await master(), input = f.start()
  const original = f.socket.watcherControl.bind(f.socket)
  const reads = vi.spyOn(f.socket, 'watcherRead').mockRejectedValue(new Error('lost-projection'))
  let admitted: WatcherHostControl | undefined
  vi.spyOn(f.socket, 'watcherControl').mockImplementation(async packet => { admitted = packet; await original(packet); throw new Error('lost-ack') })
  expect(await f.call('start_thread', input)).toMatchObject({ status: 'refused', code: 'DELIVERY_UNCERTAIN' })
  f.router.setReconnecting(f.pairing.hostId, true)
  expect(f.watcher.state().inFlight).toBe(1)
  expect(await f.call('start_thread', input)).toMatchObject({ receipt: { operationId: admitted!.operation.id } })
  const retry = await original(admitted!) as { receipt: { operationId: string } }
  expect(retry.receipt.operationId).toBe(admitted!.operation.id)
  reads.mockRestore()
  f.router.setReconnecting(f.pairing.hostId, false)
  expect(await f.call('read_operation', { operationId: admitted!.operation.id })).toMatchObject({ receipt: { deliveryState: 'accepted' } })
  expect(remote.host.service.state().host.threads.filter(item => item.title === input.title)).toHaveLength(1)
})

it('counts paired Watcher writes once in the owning Owl archive and keeps user sends under their selected model', async () => {
  const native = await codexFixture(undefined, false, 10_000); cleanups.push(native.cleanup)
  await native.script({ models: [
    { id: 'first', model: 'fixture-model', displayName: 'First model', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
    { id: 'later', model: 'later-model', displayName: 'Later model', isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
  ] })
  const f = await master(native.adapter, true), input = f.start()
  expect(f.hello.features).toContain('usage-dashboard')
  const activity = async () => {
    const read = await f.socket.usageRead({ providerIds: ['codex'], timeZone: 'UTC' })
    expect(read).toMatchObject({ status: 'ready', persistence: 'saved' })
    return read.activity!
  }
  const original = f.socket.watcherControl.bind(f.socket)
  const reads = vi.spyOn(f.socket, 'watcherRead').mockRejectedValue(new Error('Synthetic lost projection'))
  let admitted: WatcherHostControl | undefined
  const writes = vi.spyOn(f.socket, 'watcherControl').mockImplementation(async packet => { admitted = packet; await original(packet); throw new Error('Synthetic lost acknowledgement') })
  expect(await f.call('start_thread', input)).toMatchObject({ code: 'DELIVERY_UNCERTAIN' })
  const packet = admitted!, target = packet.operation.target
  await expect.poll(async () => (await activity()).totals.prompts).toEqual({ user: 0, watcher: 1, wakeUp: 0, total: 1, steered: 0 })
  expect(await f.call('start_thread', input)).toMatchObject({ receipt: { operationId: packet.operation.id } })
  expect(await original(packet)).toMatchObject({ receipt: { operationId: packet.operation.id } })
  reads.mockRestore(); writes.mockRestore()
  expect(await f.call('read_operation', { operationId: packet.operation.id })).toMatchObject({ receipt: { deliveryState: 'accepted' } })
  expect((await activity()).totals.prompts.total).toBe(1)

  await expect.poll(() => f.socket.shell().host.threads.find(thread => thread.id === target.threadId)?.lastTurn?.status).toBe('running')
  const turnId = f.socket.shell().host.threads.find(thread => thread.id === target.threadId)!.lastTurn!.id
  const codexId = (await native.driver.requests()).findLast(item => item.method === 'turn/start')!.params!.threadId as string
  const aliases = JSON.parse(await readFile(join(native.root, 'codex-threads.json'), 'utf8')) as Record<string, { codexThreadId: string }>
  const nativeId = Object.entries(aliases).find(([, value]) => value.codexThreadId === codexId)![0]
  const steer = { requestId: f.requestId, retryKey: randomUUID(), target, delivery: 'steer', expectedTurnId: turnId, text: 'Synthetic counted steer' }
  expect(await f.call('send_to_thread', steer)).toMatchObject({ status: 'ok' })
  expect(await f.call('send_to_thread', steer)).toMatchObject({ status: 'ok' })
  await expect.poll(async () => (await activity()).totals.prompts).toEqual({ user: 0, watcher: 2, wakeUp: 0, total: 2, steered: 1 })
  const queue = { requestId: f.requestId, retryKey: randomUUID(), target, delivery: 'queue', text: 'Synthetic counted queue' }
  const queued = await f.call('send_to_thread', queue)
  expect(queued, JSON.stringify(queued)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'queued' } })
  expect(await f.call('send_to_thread', queue)).toMatchObject({ receipt: queued.receipt })
  expect((await activity()).totals.prompts.total).toBe(2)
  await native.driver.completeTurn(nativeId, 'Synthetic first completion')
  await expect.poll(async () => (await activity()).totals.prompts.watcher).toBe(3)
  await expect.poll(async () => (await native.driver.requests()).filter(item => item.method === 'turn/start').length).toBe(2)
  await expect.poll(() => f.socket.shell().host.threads.find(thread => thread.id === target.threadId)?.lastTurn?.id).not.toBe(turnId)
  await expect.poll(() => f.socket.shell().host.threads.find(thread => thread.id === target.threadId)?.lastTurn?.status).toBe('running')
  await native.driver.completeTurn(nativeId, 'Synthetic queue completion')
  await expect.poll(() => f.socket.shell().host.threads.find(thread => thread.id === target.threadId)).toMatchObject({ status: 'idle', lastTurn: { status: 'completed' } })
  const now = { requestId: f.requestId, retryKey: randomUUID(), target, delivery: 'now', text: 'Synthetic counted send' }
  const sentNow = await f.call('send_to_thread', now)
  expect(sentNow.status, sentNow.status === 'refused' ? sentNow.code : undefined).toBe('ok')
  expect(await f.call('send_to_thread', now)).toMatchObject({ status: 'ok' })
  await expect.poll(async () => (await activity()).totals.prompts.watcher).toBe(4)
  await expect.poll(() => f.socket.shell().host.threads.find(thread => thread.id === target.threadId)?.lastTurn?.status).toBe('running')
  await native.driver.completeTurn(nativeId, 'Synthetic final machine completion')
  await expect.poll(() => f.socket.shell().host.threads.find(thread => thread.id === target.threadId)).toMatchObject({ status: 'idle', lastTurn: { status: 'completed' } })
  const laterModel = f.socket.shell().host.models.find(model => model.providerId === 'codex' && model.id !== f.model.id && model.ready)!
  expect((await f.socket.command({ type: 'configure-thread', threadId: target.threadId, modelId: laterModel.id })).error).toBeNull()
  expect((await f.socket.command({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text: 'Synthetic user continuation' })).error).toBeNull()
  await expect.poll(async () => (await activity()).totals.prompts.total).toBe(5)
  const final = await activity()
  expect(final.totals.prompts).toEqual({ user: 1, watcher: 4, wakeUp: 0, total: 5, steered: 1 })
  expect(final.models).toEqual(expect.arrayContaining([
    // No token report names a served model here, so each prompt counts under the model it was sent on (ADR-0083).
    expect.objectContaining({ modelId: canonicalModelId('codex', f.model.id), prompts: { user: 0, watcher: 4, wakeUp: 0, total: 4, steered: 1 } }),
    expect.objectContaining({ modelId: canonicalModelId('codex', laterModel.id), prompts: { user: 1, watcher: 0, wakeUp: 0, total: 1, steered: 0 } }),
  ]))
  const beforeRestart = await native.driver.requests()
  expect(beforeRestart.filter(item => item.method === 'turn/start')).toHaveLength(4)
  expect(beforeRestart.filter(item => item.method === 'turn/steer')).toHaveLength(1)

  await f.socket.close(); await remote.host.close()
  remote.host = await startFixtureHeadlessHost({ dataDirectory: remote.root, port: 0, providers: { codex: native.adapter }, sottoVersion: '0.1.38-owl.20261013.1' })
  remote.url = 'http://127.0.0.1:' + remote.host.descriptor!.port
  const socket = new SocketHostService({ url: remote.url, token: f.pairing.token, watcherEnabled: true }); remote.clients.push(socket)
  await socket.connect()
  expect(await socket.watcherControl(packet)).toMatchObject({ receipt: { operationId: packet.operation.id } })
  expect((await socket.usageRead({ providerIds: ['codex'], timeZone: 'UTC' })).activity!.totals.prompts).toEqual(final.totals.prompts)
  expect((await native.driver.requests()).filter(item => item.method === 'turn/start')).toHaveLength(4)
})

it('refuses start before the wire when the owning-host path is missing', async () => {
  const f = await master()
  const spy = vi.spyOn(f.socket, 'watcherControl')
  f.router.replace({ ...f.connection, service: { ...f.connection.service,
    shell: () => f.socket.shell(), command: command => f.socket.command(command), subscribe: listener => f.socket.subscribe(listener), supportsWatcherControl: false, supportsWatcherReads: false } })
  expect(await f.call('start_thread', f.start())).toMatchObject({ code: 'HOST_FEATURE_UNAVAILABLE' })
  expect(spy).not.toHaveBeenCalled(); expect(f.watcher.state().inFlight).toBe(0)
  expect(await f.call('list_projects', {})).toMatchObject({ status: 'ok', projects: expect.arrayContaining([expect.objectContaining({ target: { hostId: f.pairing.hostId, projectId: f.project.id }, controlAvailable: false })]) })
})

it('publishes host user takeover and fences queued automated prompts before another writer', async () => {
  const f = await master(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start-refused')
  const confirmation = f.watcher.prepareStopAll()
  if (confirmation.status !== 'ok') throw new Error('stop-preview-refused')
  await f.socket.command({ type: 'manual-send', threadId: first.target.threadId, draftId: randomUUID(), text: 'Synthetic phone instruction' })
  await vi.waitFor(() => expect(f.watcher.state().watchedThreads[0]?.participation[0]?.state).toBe('taken-over'))
  expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, text: 'Synthetic refused', delivery: 'queue' })).toMatchObject({ code: 'THREAD_TAKEN_OVER' })
  expect(await f.watcher.stopAll(confirmation.confirmationId)).toMatchObject({ code: 'TARGET_CHANGED' })
})

it('rechecks a late native question at the owning Codex writer, without answering', async () => {
  const native = await codexFixture(undefined, false); cleanups.push(native.cleanup)
  const f = await master(native.adapter), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start-refused')
  const target = first.target, codexId = (await native.driver.requests()).findLast(item => item.method === 'turn/start')!.params!.threadId as string
  const aliases = JSON.parse(await readFile(join(native.root, 'codex-threads.json'), 'utf8')) as Record<string, { codexThreadId: string }>
  const nativeId = Object.entries(aliases).find(([, value]) => value.codexThreadId === codexId)![0]
  await native.driver.completeTurn(nativeId, 'Synthetic completion')
  await vi.waitFor(() => expect(f.socket.shell().host.threads.find(item => item.id === target.threadId)?.lastTurn?.status).toBe('completed'))
  // Hold a real owning read from before refusal until the control reply has already refunded this send.
  vi.spyOn(f.watcher as unknown as { scheduleRemote: () => void }, 'scheduleRemote').mockImplementation(() => undefined)
  const background = f.watcher as unknown as { remoteTimer?: unknown; remoteFlushing: boolean; reconciling?: Promise<void>; reconcileRemote(hostId: string): Promise<void> }
  await expect.poll(() => !background.remoteTimer && !background.remoteFlushing && !background.reconciling).toBe(true)
  const gate = heldOperation(), olderProjection = heldOperation()
  const read = f.socket.watcherRead.bind(f.socket)
  // A send to a watched thread first refreshes the owning host's fences; only the read started once the writer holds is
  // the older one this test keeps back.
  let held = false, armed = false
  void gate.entered.then(() => { armed = true })
  vi.spyOn(f.socket, 'watcherRead').mockImplementation(async packet => {
    const projection = await read(packet)
    if (!packet.call && !held && armed) { held = true; await olderProjection.wait() }
    return projection
  })
  const prepare = native.adapter.prepareSkillInput.bind(native.adapter)
  vi.spyOn(native.adapter, 'prepareSkillInput').mockImplementation(async (...args) => { const result = await prepare(...args); if (args[1] === 'Synthetic held machine') await gate.wait(); return result })
  const sendInput = { requestId: f.requestId, retryKey: randomUUID(), target, delivery: 'now', text: 'Synthetic held machine' }
  const send = () => f.call('send_to_thread', sendInput)
  const lateQuestion = send()
  let reconciliation: Promise<void> | undefined
  try {
    await gate.entered
    const operationId = f.control.watcherRecord().operations.at(-1)!.id
    reconciliation = background.reconcileRemote(target.hostId)
    await olderProjection.entered
    await native.driver.raiseQuestion(nativeId, 'Synthetic late question')
    await vi.waitFor(() => expect(f.socket.shell().host.threads.find(item => item.id === target.threadId)?.requests.length).toBe(1))
    gate.release()
    await expect.poll(() => f.control.watcherRecord().operations.find(item => item.id === operationId)?.deliveryState).toBe('failed')
    olderProjection.release()
    await reconciliation
    const refused = await lateQuestion
    expect(refused).toMatchObject({ code: 'PENDING_USER_REQUEST', receipt: { deliveryState: 'failed' } })
    const promptCount = () => f.watcher.state().requests.find(item => item.id === f.requestId)!.participants[0]!.promptCount
    expect(promptCount()).toBe(1)
    expect(await send()).toMatchObject({ code: 'PENDING_USER_REQUEST', receipt: refused.receipt })
    expect(promptCount()).toBe(1)
    const before = await native.driver.requests()
    expect(before.filter(item => item.method === 'turn/start')).toHaveLength(1)
    expect(before.filter(item => item.method === 'request/answer')).toHaveLength(0)
    // A machine stop cancels the held question without answering it.
    expect(await f.call('stop_thread', { requestId: f.requestId, retryKey: randomUUID(), target })).toMatchObject({ status: 'ok' })
    expect((await native.driver.requests()).filter(item => item.method === 'request/answer')).toHaveLength(0)
  } finally { gate.release(); olderProjection.release(); await Promise.all([lateQuestion, reconciliation]); vi.restoreAllMocks() }
}, 60_000)

it('keeps remote receipts and ownership across host restart and never replays the original start', async () => {
  const f = await master(), input = f.start()
  let packet: WatcherHostControl | undefined
  const original = f.socket.watcherControl.bind(f.socket)
  vi.spyOn(f.socket, 'watcherControl').mockImplementation(async request => { packet = request; return original(request) })
  const first = await f.call('start_thread', input)
  expect(first.status).toBe('ok')
  await f.socket.close(); await remote.host.close()
  remote.host = await startFixtureHeadlessHost({ dataDirectory: remote.root, port: 0, providers: { codex: remote.native } })
  remote.url = 'http://127.0.0.1:' + remote.host.descriptor!.port
  const socket = new SocketHostService({ url: remote.url, token: f.pairing.token, watcherEnabled: true }); remote.clients.push(socket)
  await socket.connect()
  expect(await socket.watcherControl(packet!)).toMatchObject({ receipt: { operationId: packet!.operation.id } })
  expect(remote.host.service.state().host.threads.filter(item => item.title === input.title)).toHaveLength(1)
  expect((await socket.watcherRead({ master: packet!.master })) as object).toMatchObject({ operations: [expect.objectContaining({ id: packet!.operation.id })] })
})

it('routes steer and queue by turn identity and fences a native takeover before queued dispatch', async () => {
  const native = await codexFixture(undefined, false, 10_000); cleanups.push(native.cleanup)
  const f = await master(native.adapter), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok') throw new Error('start-refused')
  const target = first.target
  await vi.waitFor(() => expect(f.socket.shell().host.threads.find(item => item.id === target.threadId)?.lastTurn?.status).toBe('running'))
  const thread = f.socket.shell().host.threads.find(item => item.id === target.threadId)!
  const codexId = (await native.driver.requests()).findLast(item => item.method === 'turn/start')!.params!.threadId as string
  const aliases = JSON.parse(await readFile(join(native.root, 'codex-threads.json'), 'utf8')) as Record<string, { codexThreadId: string }>
  const nativeId = Object.entries(aliases).find(([, value]) => value.codexThreadId === codexId)![0]
  expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target, delivery: 'steer', expectedTurnId: 'wrong', text: 'Synthetic stale steer' })).toMatchObject({ code: 'STEER_UNAVAILABLE' })
  const steered = await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target, delivery: 'steer', expectedTurnId: thread.lastTurn!.id, text: 'Synthetic steer' })
  expect(steered.status, steered.status === 'refused' ? steered.code : undefined).toBe('ok')
  const queued = await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target, delivery: 'queue', text: 'Synthetic fenced queue' })
  expect(queued).toMatchObject({ status: 'ok', receipt: { deliveryState: 'queued' } })
  await native.driver.typeInProvider(nativeId, 'Synthetic native instruction')
  // The background poll can finish before it discovers this rollout. Establish takeover before releasing the queue.
  await native.adapter.refreshThread(nativeId)
  await vi.waitFor(() => expect(f.watcher.state().watchedThreads[0]?.participation[0]?.takeover?.reason).toBe('native-user-send'))
  await native.driver.completeTurn(nativeId, 'Synthetic completion')
  await vi.waitFor(() => expect(f.watcher.state().receipts.find(item => item.id === (queued.status === 'ok' ? queued.receipt.operationId : ''))?.deliveryState).toBe('failed'))
  const written = await native.driver.requests()
  expect(written.filter(item => item.method === 'turn/start')).toHaveLength(1)
  expect(written.filter(item => item.method === 'turn/steer')).toHaveLength(1)
  expect(written.filter(item => item.method === 'request/answer')).toHaveLength(0)
}, 60_000)

it('fences native input arriving at a prepared paired queue writer before another turn starts', async () => {
  // Only the writer's targeted read can ingest the native input added while preparation is held.
  const native = await codexFixture(undefined, false, 10_000, { pollIntervalMs: 600_000 }); cleanups.push(native.cleanup)
  const f = await master(native.adapter), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok') throw new Error('start-refused')
  const target = first.target
  await vi.waitFor(() => expect(f.socket.shell().host.threads.find(item => item.id === target.threadId)?.lastTurn?.status).toBe('running'))
  const codexId = (await native.driver.requests()).findLast(item => item.method === 'turn/start')!.params!.threadId as string
  const aliases = JSON.parse(await readFile(join(native.root, 'codex-threads.json'), 'utf8')) as Record<string, { codexThreadId: string }>
  const nativeId = Object.entries(aliases).find(([, value]) => value.codexThreadId === codexId)![0]
  const gate = heldOperation(), prepare = native.adapter.prepareSkillInput.bind(native.adapter)
  vi.spyOn(native.adapter, 'prepareSkillInput').mockImplementation(async (...args) => {
    const result = await prepare(...args)
    if (args[1] === 'Synthetic held native queue') await gate.wait()
    return result
  })
  const queued = await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target, delivery: 'queue', text: 'Synthetic held native queue' })
  expect(queued).toMatchObject({ status: 'ok', receipt: { deliveryState: 'queued' } })
  if (queued.status !== 'ok') throw new Error('queue-refused')
  try {
    await native.driver.completeTurn(nativeId, 'Synthetic completion before late input')
    await gate.entered
    await native.typeUnseen(nativeId, 'Synthetic native input after preparation')
    gate.release()
    const owner = (remote.host.service as unknown as { options: { watcher: WatcherService } }).options.watcher
    await vi.waitFor(() => expect(owner.state().watchedThreads.find(item => item.target.threadId === target.threadId)?.participation[0]?.takeover?.reason).toBe('native-user-send'))
    await vi.waitFor(() => expect(f.watcher.state().receipts.find(item => item.id === queued.receipt.operationId)?.deliveryState).toBe('failed'))
    const written = await native.driver.requests()
    expect(written.filter(item => item.method === 'turn/start')).toHaveLength(1)
    expect(written.filter(item => item.method === 'turn/steer')).toHaveLength(0)
    expect(written.filter(item => item.method === 'request/answer')).toHaveLength(0)
  } finally { gate.release() }
}, 60_000)

it('refuses changed operation identities and master ceilings on the owning host', async () => {
  const f = await master(), original = f.socket.watcherControl.bind(f.socket)
  let packet: WatcherHostControl | undefined
  vi.spyOn(f.socket, 'watcherControl').mockImplementation(async request => { packet = request; return original(request) })
  expect((await f.call('start_thread', f.start())).status).toBe('ok')
  expect(await original({ ...packet!, operation: { ...packet!.operation, id: randomUUID() } })).toMatchObject({ code: 'RETRY_KEY_CONFLICT' })
  expect(await original({ ...packet!, request: { ...packet!.request, rootUserMessageId: 'different-root' } })).toMatchObject({ code: 'INVALID_INPUT' })
  expect(await original({ ...packet!, ceiling: 'full-access' })).toMatchObject({ code: 'RETRY_KEY_CONFLICT' })
  expect(await original({ ...packet!, master: { ...packet!.master, projectId: 'changed-master-project' } })).toMatchObject({ code: 'RETRY_KEY_CONFLICT' })
  expect(await original({ ...packet!, operation: { ...packet!.operation, draftId: undefined } })).toMatchObject({ code: 'INVALID_INPUT' })
  const changedInput = { ...packet!.call.input, requestId: randomUUID() }
  const mismatch = { ...packet!, operation: { ...packet!.operation, digest: createHash('sha256').update(JSON.stringify([packet!.call.name, changedInput])).digest('hex') }, call: { ...packet!.call, input: changedInput } } as WatcherHostControl
  expect(await original(mismatch)).toMatchObject({ code: 'INVALID_INPUT' })
  const phone = await pairedDesktop(false)
  const forged = phone.socket as unknown as { call(op: HostOperation): Promise<unknown> }
  await expect(forged.call({ op: 'watcher-control', request: packet! })).rejects.toMatchObject({ code: 'forbidden' })
  const raw = f.socket as unknown as { call(op: object): Promise<unknown> }
  await expect(raw.call({ op: 'command', command: { type: 'manual-send', threadId: packet!.operation.target.threadId, text: 'Synthetic forged', origin: packet } })).rejects.toMatchObject({ code: 'invalid_request' })
})

it('enforces the narrower owning-host default and keeps a confirmed remote Stop all after the master default changes', async () => {
  const f = await master()
  await f.control.commandShell({ type: 'configure', patch: { newThreadRuntimeMode: 'full-access' } })
  expect(await f.call('start_thread', { ...f.start(), permission: { kind: 'runtime', mode: 'full-access' } })).toMatchObject({ code: 'PERMISSION_TOO_WIDE' })
  expect(f.watcher.state().inFlight).toBe(0)
  const acceptedInput = { ...f.start(), permission: { kind: 'runtime' as const, mode: 'approval-required' } }
  const first = await f.call('start_thread', acceptedInput)
  expect(first.status).toBe('ok')
  await f.control.commandShell({ type: 'configure', patch: { newThreadRuntimeMode: 'approval-required' } })
  const confirmation = f.watcher.prepareStopAll()
  if (confirmation.status !== 'ok' || first.status !== 'ok') throw new Error('stop-preview-refused')
  expect(confirmation.targets).toEqual([first.target])
  remote.native.event({ type: 'ready', threadId: (await remote.native.snapshot()).threads.find(item => item.title === 'Synthetic remote worker')!.id, text: 'Synthetic progress during confirmation' })
  await f.socket.command({ type: 'refresh', provider: 'codex' })
  await vi.waitFor(() => expect(f.socket.shell().host.threads.find(item => item.id === first.target.threadId)?.status).toBe('idle'))
  expect(remote.host.service.state().host.threads.find(item => item.id === first.target.threadId)?.status, 'Owning host after the completion event').toBe('idle')
  const progress = await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'now', text: 'Synthetic follow-up during confirmation' })
  expect(progress.status, progress.status === 'refused' ? progress.code : undefined).toBe('ok')
  expect(progress).toMatchObject({ limits: { promptCount: 2 } })
  const stopped = await f.watcher.stopAll(confirmation.confirmationId)
  // Should the stop come back unconfirmed, say which refusal each operation on the thread recorded, here and on the owning host.
  const outcomes = (receipts: { action: string; deliveryState: string; refusalCode?: string | undefined; target: { threadId: string } }[]) =>
    receipts.filter(item => item.target.threadId === first.target.threadId).map(item => `${item.action}:${item.deliveryState}:${item.refusalCode ?? '-'}`)
  const owner = (remote.host.service as unknown as { options: { watcher: WatcherService } }).options.watcher
  expect(stopped, JSON.stringify({ master: outcomes(f.watcher.state().receipts), owner: outcomes(owner.state().receipts) }))
    .toMatchObject({ status: 'ok', results: [{ target: first.target, status: expect.stringMatching(/stopped|requested/u) }] })
  expect(f.watcher.state().requests.find(item => item.id === f.requestId)?.state).toBe('stopped')
  expect(f.watcher.state().watchedThreads.find(item => item.target.threadId === first.target.threadId)?.participation[0]?.automationStopped).toBe(true)
  const writes = vi.spyOn(f.socket, 'watcherControl')
  expect(await f.call('start_thread', acceptedInput)).toMatchObject({ status: 'ok', receipt: { operationId: first.receipt.operationId } })
  expect(writes).not.toHaveBeenCalled()
  expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'now', text: 'Synthetic stopped request refusal' })).toMatchObject({ code: 'REQUEST_NOT_ACTIVE' })
})

it('keeps remote Stop all ownership while desktop room IPC is held and flushes before its own answer', async () => {
  const f = await master(), sent = vi.fn<(state: WatcherRoomState) => boolean>(() => true)
  const timers: (() => void)[] = []
  const desktop = createWatcherRoomDesktop({ watcherEnabled: true, streamingPublishCost: true, watcher: f.watcher,
    send: sent, setLimit: async () => undefined, schedule: run => { timers.push(run); return () => undefined } })!
  const ipc = createIpcHarness(); ipc.cleanup()
  const cleanup = registerIpc(ipc.ipc, { settings: ipc.settings, history: ipc.history, startup: ipc.startup, hotkeys: ipc.hotkeys,
    app: ipc.app, trustedSenders: () => [{ role: 'main', webContents: ipc.trustedContents, url: ipc.trustedUrl }], watcher: desktop.bridge })
  cleanups.push(async () => { cleanup(); desktop.dispose() })
  const observed = vi.fn(), off = f.watcher.subscribe(observed); cleanups.push(async () => off())
  const started = await f.call('start_thread', f.start())
  if (started.status !== 'ok') throw new Error('start-refused')
  expect(timers.length).toBeGreaterThan(0)
  expect(observed.mock.calls.length).toBeGreaterThan(sent.mock.calls.length)
  const preview = await ipc.ipc.invoke(WATCHER_PREPARE_STOP_ALL) as WatcherPrepareStopAllResult
  if (preview.status !== 'ok') throw new Error('stop-preview-refused')
  const original = f.socket.watcherControl.bind(f.socket)
  let stopId: string | undefined
  const writes = vi.spyOn(f.socket, 'watcherControl').mockImplementation(async packet => {
    if (packet.call.name === 'stop_thread') {
      stopId = packet.operation.id
      const before = sent.mock.calls.length
      await (f.watcher as unknown as { reconcileRemote(hostId: string): Promise<void> }).reconcileRemote(packet.operation.target.hostId)
      expect(sent).toHaveBeenCalledTimes(before)
    }
    return original(packet)
  })
  const stop = f.watcher.stopAll.bind(f.watcher)
  let ownResult: WatcherStopAllResult | undefined
  vi.spyOn(f.watcher, 'stopAll').mockImplementation(async id => { ownResult = await stop(id); return ownResult })
  const answer = await ipc.ipc.invoke(WATCHER_STOP_ALL, { confirmationId: preview.confirmationId })
  expect(answer).toMatchObject({ status: 'ok', results: [{ target: started.target, status: expect.stringMatching(/stopped|requested/u) }] })
  expect(answer).toBe(ownResult)
  if (ownResult?.status !== 'ok') throw new Error('stop-refused')
  const last = sent.mock.calls.at(-1)![0]
  expect(last).toMatchObject({ requests: ownResult.state.requests, receipts: ownResult.state.receipts,
    currentOptions: ownResult.state.currentOptions, inFlight: ownResult.state.inFlight, inFlightLimit: ownResult.state.inFlightLimit })
  // publish() and the operation's own state() are distinct captures; keep both original timestamps.
  expect(Date.parse(last.observedAt)).toBeLessThanOrEqual(Date.parse(ownResult.state.observedAt))
  const count = sent.mock.calls.length
  for (const run of timers.splice(0)) run()
  expect(sent).toHaveBeenCalledTimes(count)
  expect(writes.mock.calls.filter(([packet]) => packet.call.name === 'stop_thread')).toHaveLength(1)
  expect(await f.socket.watcherRead({ master: f.control.watcherRecord().current!, call: { name: 'read_operation', input: { operationId: stopId! } } })).toMatchObject({ status: 'ok', receipt: { operationId: stopId, deliveryState: 'accepted' } })
})

it('keeps a remote Stop all in flight while reconciliation reads the owning host', async () => {
  const f = await master(), started = await f.call('start_thread', f.start())
  if (started.status !== 'ok') throw new Error('start-refused')
  const confirmation = f.watcher.prepareStopAll()
  if (confirmation.status !== 'ok') throw new Error('stop-preview-refused')
  const original = f.socket.watcherControl.bind(f.socket)
  let stopId: string | undefined
  vi.spyOn(f.socket, 'watcherControl').mockImplementation(async packet => {
    if (packet.call.name === 'stop_thread') {
      stopId = packet.operation.id
      // The master's stop is dispatching, but the owning host has not admitted it.
      await (f.watcher as unknown as { reconcileRemote(hostId: string): Promise<void> }).reconcileRemote(packet.operation.target.hostId)
    }
    return original(packet)
  })
  expect(await f.watcher.stopAll(confirmation.confirmationId)).toMatchObject({ status: 'ok', results: [{ target: started.target, status: expect.stringMatching(/stopped|requested/u) }] })
  expect(await f.socket.watcherRead({ master: f.control.watcherRecord().current!, call: { name: 'read_operation', input: { operationId: stopId! } } })).toMatchObject({ status: 'ok', receipt: { operationId: stopId, deliveryState: 'accepted' } })
  expect(f.watcher.state().requests.find(item => item.id === f.requestId)?.state).toBe('stopped')
})

it('reconciles a remote Stop all after its acknowledgement is lost without sending it again', async () => {
  const f = await master(), started = await f.call('start_thread', f.start())
  if (started.status !== 'ok') throw new Error('start-refused')
  const confirmation = f.watcher.prepareStopAll()
  if (confirmation.status !== 'ok') throw new Error('stop-preview-refused')
  const original = f.socket.watcherControl.bind(f.socket)
  let stopId: string | undefined
  const writes = vi.spyOn(f.socket, 'watcherControl').mockImplementation(async packet => {
    const reply = await original(packet)
    if (packet.call.name === 'stop_thread') {
      stopId = packet.operation.id
      throw new Error('Synthetic lost stop acknowledgement')
    }
    return reply
  })
  expect(await f.watcher.stopAll(confirmation.confirmationId)).toMatchObject({ status: 'ok', results: [{ target: started.target, status: 'uncertain' }] })
  await (f.watcher as unknown as { reconcileRemote(hostId: string): Promise<void> }).reconcileRemote(started.target.hostId)
  await vi.waitFor(() => expect(f.control.watcherRecord().operations.find(item => item.id === stopId)?.deliveryState).toBe('accepted'))
  expect(writes).toHaveBeenCalledTimes(1)
})

it('releases an uncertain remote Stop all so an exact absent receipt can settle it', async () => {
  const f = await master(), started = await f.call('start_thread', f.start())
  if (started.status !== 'ok') throw new Error('start-refused')
  const confirmation = f.watcher.prepareStopAll()
  if (confirmation.status !== 'ok') throw new Error('stop-preview-refused')
  const original = f.socket.watcherControl.bind(f.socket)
  let stopPacket: WatcherHostControl | undefined
  const writes = vi.spyOn(f.socket, 'watcherControl').mockImplementation(async packet => {
    if (packet.call.name === 'stop_thread') {
      stopPacket = packet
      throw new Error('Synthetic unconfirmed transmission')
    }
    return original(packet)
  })
  expect(await f.watcher.stopAll(confirmation.confirmationId)).toMatchObject({ status: 'ok', results: [{ target: started.target, status: 'uncertain' }] })
  await (f.watcher as unknown as { reconcileRemote(hostId: string): Promise<void> }).reconcileRemote(started.target.hostId)
  await vi.waitFor(() => expect(f.control.watcherRecord().operations.find(item => item.id === stopPacket!.operation.id)).toMatchObject({ deliveryState: 'failed', refusalCode: 'OPERATION_NOT_RECORDED' }))
  expect(await original(stopPacket!)).toMatchObject({ status: 'refused', code: 'OPERATION_NOT_RECORDED' })
  expect(writes).toHaveBeenCalledTimes(1)
})

it.each(['queued', 'dispatching'])('rechecks a revoked phone after remote Stop all %s persistence', async phase => {
  const f = await master(), started = await f.call('start_thread', f.start())
  if (started.status !== 'ok') throw new Error('start-refused')
  const phone = new WatcherPhoneService(f.control, f.watcher), pairing = new PairedClients(f.workspace.root)
  await pairing.load()
  const server = await startSocketServer({ service: new LocalHostService({ control: f.control, watcherPhone: phone }), pairing, admin: false })
  cleanups.push(() => server.close())
  const paired = await pairing.redeem(pairing.issuePairingCode().code, 'Synthetic phone')
  const peer = await rawPeer(server.descriptor.port, pairing.signSession(paired.clientId, Date.now()))
  cleanups.push(async () => peer.frames.close())
  await peer.call('hello', { op: 'hello', accepts: ['watcher-phone', 'watcher-phone-stop-all'] })
  const preview = await peer.call('preview', { op: 'watcher-phone-prepare-stop-all' })
  const held = heldOperation(), original = f.control.updateWatcher.bind(f.control)
  let paused = false
  vi.spyOn(f.control, 'updateWatcher').mockImplementation(async update => {
    await original(update)
    if (!paused && f.control.watcherRecord().operations.some(operation => operation.action === 'stop' && operation.deliveryState === phase)) {
      paused = true; await held.wait()
    }
  })
  const writes = vi.spyOn(f.socket, 'watcherControl')
  const stopping = peer.call('stop', { op: 'watcher-phone-stop-all', confirmationId: (preview.result as { confirmationId: string }).confirmationId })
  try { await held.entered; await pairing.revoke(paired.clientId) } finally { held.release() }
  // Revocation may lose the phone's reply; the owning host must still receive no stop.
  await stopping.catch(() => undefined)
  expect(writes).not.toHaveBeenCalled()
  expect((await remote.native.snapshot()).threads.find(thread => thread.title === 'Synthetic remote worker')?.status).toBe('running')
})

it('refuses closed remote entry points with the same code as local tools and no coordinator effects', async () => {
  const f = await master(), original = f.socket.watcherControl.bind(f.socket)
  let packet: WatcherHostControl | undefined
  vi.spyOn(f.socket, 'watcherControl').mockImplementation(async request => { packet = request; return original(request) })
  expect((await f.call('start_thread', f.start())).status).toBe('ok')
  const state = f.watcher.state(), guard = vi.fn(), update = vi.spyOn(f.control, 'updateWatcher')
  f.watcher.close()
  expect(await f.watcher.admitRemote(packet!, f.pairing.clientId, guard)).toMatchObject({ code: 'NOT_CURRENT_WATCHER' })
  expect(await f.watcher.readRemote({ master: packet!.master }, f.pairing.clientId)).toMatchObject({ code: 'NOT_CURRENT_WATCHER' })
  expect(await f.call('list_threads', {})).toMatchObject({ code: 'NOT_CURRENT_WATCHER' })
  expect(f.watcher.prepareStopAll()).toMatchObject({ code: 'NOT_CURRENT_WATCHER' })
  expect(guard).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled()
  expect(f.watcher.state().receipts).toEqual(state.receipts)
})

it('refuses a remote mutation before transmission when the master closes during dispatch persistence', async () => {
  const f = await master(), gate = heldOperation(), writes = vi.spyOn(f.socket, 'watcherControl')
  const update = f.control.updateWatcher.bind(f.control)
  let held = false
  vi.spyOn(f.control, 'updateWatcher').mockImplementation(async mutator => {
    const result = await update(mutator)
    if (!held && f.watcher.state().receipts.some(item => item.deliveryState === 'dispatching' && item.target.hostId === f.pairing.hostId)) {
      held = true; await gate.wait()
    }
    return result
  })
  const input = f.start(), start = f.call('start_thread', input)
  try {
    await gate.entered; f.watcher.close(); gate.release()
    expect(await start).toMatchObject({ code: 'NOT_CURRENT_WATCHER', receipt: { deliveryState: 'failed' } })
    expect(writes).not.toHaveBeenCalled(); expect(f.watcher.state().inFlight).toBe(0)
    expect(f.watcher.state().requests[0]!.participants[0]).toMatchObject({ state: 'relinquished', promptCount: 1 })
    expect(await f.call('start_thread', input)).toMatchObject({ code: 'NOT_CURRENT_WATCHER' })
    expect(f.watcher.state().requests[0]!.participants[0]!.promptCount).toBe(1)
  } finally { gate.release(); await start }
})


it('attributes returning paired evidence to its host, queues news after user work and withdraws it on Stop', async () => {
  const f = await master(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start-refused')
  let checks: 'failed' | 'passed' = 'failed'
  const shell = f.socket.shell.bind(f.socket)
  // The synthetic evidence belongs to a PR the owning roster still links.
  vi.spyOn(f.socket, 'shell').mockImplementation(() => {
    const state = shell()
    return { ...state, host: { ...state.host, threads: state.host.threads.map(thread => thread.id !== first.target.threadId ? thread
      : { ...thread, pullRequests: [{ url: 'https://github.com/synthetic/project/pull/5', number: 5, title: 'Synthetic PR',
        state: 'open' as const, draft: false, source: 'linked' as const, linkedAt: new Date().toISOString() }] }) } }
  })
  const original = f.socket.watcherRead.bind(f.socket)
  vi.spyOn(f.socket, 'watcherRead').mockImplementation(async packet => {
    const result = await original(packet)
    if (packet.call) return result
    const projection = result as WatcherHostProjection
    return { ...projection, evidence: [...projection.evidence, { id: 'synthetic-host-fact', target: first.target,
      source: 'github', observedAt: new Date().toISOString(), freshness: 'fresh', availability: 'available',
      fact: checks === 'failed' ? 'checks-failed' : 'checks-passed', checksState: checks,
      headId: 'synthetic-head', url: 'https://github.com/synthetic/project/pull/5' }] }
  })
  await f.control.commandShell({ type: 'queue-followup', threadId: f.id, draftId: randomUUID(), text: 'Synthetic user continuation' })
  const occurrences: string[] = []
  for (const state of ['failed', 'passed', 'failed'] as const) {
    checks = state; f.router.replace(f.connection)
    await vi.waitFor(() => {
      const facts = f.watcher.state().watchedThreads.find(item => item.target.threadId === first.target.threadId)!.evidence ?? []
      const fact = facts.find(item => item.source === 'github' && item.checksState === state)!
      expect(fact).toBeDefined()
      const event = f.watcher.state().news?.find(item => item.kind === 'evidence-changed' && item.evidenceIds?.includes(fact.id))
      expect(event).toMatchObject({ target: first.target, requestId: f.watcher.state().standingWatches!.find(watch => watch.target.threadId === first.target.threadId)!.id })
      expect(occurrences).not.toContain(event!.id)
    }, { timeout: 15_000 })
    const event = f.watcher.state().news!.find(item => item.kind === 'evidence-changed' && item.target.threadId === first.target.threadId)!
    occurrences.push(event.id)
    await vi.waitFor(() => expect(f.control.shell().followups?.filter(item => item.threadId === f.id).at(-1)?.wakeUp).toBe(true), { timeout: 15_000 })
    expect(f.control.shell().followups!.filter(item => item.threadId === f.id)[0]!.text).toBe('Synthetic user continuation')
  }
  expect(new Set(occurrences).size).toBe(3)
  expect(await f.call('stop_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target })).toMatchObject({ status: 'ok' })
  expect(await f.watcher.unwatchThread({ target: first.target })).toMatchObject({ status: 'ok' })
  checks = 'passed'; f.router.replace(f.connection)
  await vi.waitFor(() => expect(f.watcher.state().news?.some(item => item.target.threadId === first.target.threadId)).toBe(false))
  await vi.waitFor(() => expect(f.control.shell().followups?.some(item => item.threadId === f.id && item.wakeUp)).toBe(false))
  expect(f.control.shell().followups!.find(item => item.threadId === f.id)?.text).toBe('Synthetic user continuation')
  expect(f.watcher.state().watchedThreads.find(item => item.target.threadId === first.target.threadId)!.participation[0]).toMatchObject({ automationStopped: true, promptCount: 1 })
  expect((await remote.native.snapshot()).threads.find(item => item.title === 'Synthetic remote worker')!.messages.filter(item => item.role === 'user')).toHaveLength(1)
  expect(f.workspace.adapters.codex.commands.filter(item => item.type === 'answer')).toHaveLength(0)
}, 60_000)


it('resets paired quiet progress when an owning-host plan step completes without changing its shell summary', async () => {
  const f = await master(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start-refused')
  const nativeId = (await remote.native.snapshot()).threads.find(item => item.title === 'Synthetic remote worker')!.id
  const plan = { id: 'synthetic-plan', turnId: 'synthetic-progress-turn', kind: 'plan' as const, status: 'running' as const, sequence: 0, title: 'Synthetic plan',
    steps: [{ text: 'Synthetic step', status: 'running' as 'running' | 'completed' }] }
  remote.native.event({ type: 'stream', threadId: nativeId, messageId: 'synthetic-progress', text: '', status: 'running', activities: [plan] })
  await f.socket.command({ type: 'refresh', provider: 'codex' })
  const observationKey = JSON.stringify([first.target.hostId, first.target.threadId])
  await vi.waitFor(() => expect(f.watcher.wakes.observations.has(observationKey)).toBe(true))
  await f.call('read_operation', { operationId: first.receipt.operationId })
  const before = f.watcher.wakes.observations.get(observationKey)!.lastProgressAt
  const shell = f.socket.shell().host.threads.find(item => item.id === first.target.threadId)!
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 19 * 60_000)
  try {
    plan.steps[0]!.status = 'completed'
    remote.native.event({ type: 'stream', threadId: nativeId, messageId: 'synthetic-progress', text: '', status: 'running', activities: [plan] })
    await f.socket.command({ type: 'refresh', provider: 'codex' })
    expect(f.socket.shell().host.threads.find(item => item.id === first.target.threadId)!.summary).toEqual(shell.summary)
    await vi.waitFor(() => expect(f.watcher.wakes.observations.get(observationKey)!.lastProgressAt).not.toBe(before), { timeout: 5_000 })
  } finally { clock.mockRestore() }
}, 60_000)


it.each(['stopped', 'closed'] as const)('fences a request %s during remote dispatch persistence before the wire', async state => {
  const f = await master(), gate = heldOperation(), writes = vi.spyOn(f.socket, 'watcherControl')
  const update = f.control.updateWatcher.bind(f.control)
  let held = false
  vi.spyOn(f.control, 'updateWatcher').mockImplementation(async mutator => {
    const result = await update(mutator)
    if (!held && f.watcher.state().receipts.some(item => item.deliveryState === 'dispatching' && item.target.hostId === f.pairing.hostId)) {
      held = true; await gate.wait()
    }
    return result
  })
  const input = f.start(), start = f.call('start_thread', input)
  try {
    await gate.entered
    if (state === 'stopped') await f.control.commandShell({ type: 'interrupt', threadId: f.id })
    else await update(record => { const request = record.requests.find(item => item.id === f.requestId)!; request.state = 'closed'; request.closedAt = new Date().toISOString() })
    expect(f.watcher.state().requests.find(item => item.id === f.requestId)?.state).toBe(state)
    gate.release()
    expect(await start).toMatchObject({ code: 'REQUEST_NOT_ACTIVE', receipt: { deliveryState: 'failed' } })
    expect(writes).not.toHaveBeenCalled(); expect(f.watcher.state().inFlight).toBe(0)
    expect((await remote.native.snapshot()).threads.some(item => item.title === input.title)).toBe(false)
    expect(await f.call('start_thread', input)).toMatchObject({ code: 'REQUEST_NOT_ACTIVE', receipt: { deliveryState: 'failed' } })
  } finally { gate.release(); await start }
})


it('keeps restored queues paused after retrying another receipt on the same request', async () => {
  const f = await master(), input = f.start(), original = f.socket.watcherControl.bind(f.socket)
  let packet: WatcherHostControl | undefined
  vi.spyOn(f.socket, 'watcherControl').mockImplementation(async request => { if (request.call.name === 'start_thread') packet = request; return original(request) })
  const first = await f.call('start_thread', input)
  if (first.status !== 'ok') throw new Error('start-refused')
  const queued = await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'queue', text: 'Synthetic restored machine queue' })
  expect(queued).toMatchObject({ status: 'ok', receipt: { deliveryState: 'queued' } })
  const nativeId = (await remote.native.snapshot()).threads.find(item => item.title === input.title)!.id
  await f.socket.close(); await remote.host.close()
  remote.host = await startFixtureHeadlessHost({ dataDirectory: remote.root, port: 0, providers: { codex: remote.native } })
  remote.url = 'http://127.0.0.1:' + remote.host.descriptor!.port
  const socket = new SocketHostService({ url: remote.url, token: f.pairing.token, watcherEnabled: true }); remote.clients.push(socket)
  await socket.connect(); await socket.command({ type: 'connect', provider: 'codex' })
  expect(remote.host.service.state().followups?.some(item => item.threadId === first.target.threadId && item.status === 'queued')).toBe(true)
  expect(await socket.watcherControl(packet!)).toMatchObject({ receipt: { operationId: first.receipt.operationId } })
  remote.native.event({ type: 'ready', threadId: nativeId, text: 'Synthetic completion after restart' })
  await socket.command({ type: 'refresh', provider: 'codex' })
  await vi.waitFor(() => expect(remote.host.service.state().followups?.find(item => item.threadId === first.target.threadId)?.status).toBe('paused'))
  expect((await remote.native.snapshot()).threads.find(item => item.id === nativeId)!.messages.filter(item => item.role === 'user')).toHaveLength(1)
}, 60_000)


it('keeps operation-specific restart fences when another receipt or a new operation reconnects its request', async () => {
  const workspace = await workspaceFixture(undefined, { history: true })
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { historyEnabled: () => true, watcherEnabled: true } })
  let control = f.control
  let worker = new WatcherService({ directory: f.root, host: workspace.host, control, historyEnabled: () => true, limit: () => 1, workerHost: true })
  cleanups.push(async () => { worker.close(); await f.dispose(); await workspace.stop(); await workspace.remove() })
  await control.start(); await control.commandShell({ type: 'connect', provider: 'codex' }); await worker.recover()
  const master = { target: { hostId: randomUUID(), threadId: randomUUID() }, projectId: 'synthetic-master-project', provider: 'codex' as const,
    creationOperationId: randomUUID(), createdAt: new Date().toISOString() }
  const request = { id: randomUUID(), watcher: master.target, rootUserMessageId: randomUUID(), createdAt: master.createdAt }
  const target = { hostId: control.hostId()!, threadId: randomUUID() }, clientId = randomUUID()
  const packet = (call: Extract<WatcherHostControl['call'], { name: 'start_thread' | 'send_to_thread' }>): WatcherHostControl => ({ master, request, call,
    ceiling: 'approval-required', operation: { id: randomUUID(), requestId: request.id, retryKey: call.input.retryKey,
      digest: createHash('sha256').update(JSON.stringify([call.name, watcherToolSchemas[call.name].input.parse(call.input)])).digest('hex'), action: call.name === 'start_thread' ? 'start' : 'send', target,
      generation: 0, deliveryState: 'queued', delivery: call.name === 'start_thread' ? 'now' : call.input.delivery, createdAt: request.createdAt, updatedAt: request.createdAt,
      receiptId: randomUUID(), cardId: randomUUID(), draftId: randomUUID(), messageId: randomUUID(), anchorMessageId: request.rootUserMessageId,
      ...call.name === 'start_thread' ? { creationReceiptId: randomUUID(), firstPromptReceiptId: randomUUID() } : {} } })
  const snapshot = control.watcherSnapshot()
  const start = packet({ name: 'start_thread', input: { requestId: request.id, retryKey: randomUUID(), project: { hostId: target.hostId, projectId: snapshot.projects.find(item => item.providerId === 'codex')!.id },
    modelId: snapshot.models.find(item => item.providerId === 'codex' && item.ready)!.id, title: 'Synthetic owned worker', firstPrompt: 'Synthetic first machine prompt', workingCopy: { kind: 'shared' } } })
  watcherHostControlSchema.parse(start)
  const started = await worker.admitRemote(start, clientId, () => undefined) as { status: string; code?: string }
  expect(started.status, started.code).toBe('ok')
  const queued = packet({ name: 'send_to_thread', input: { requestId: request.id, retryKey: randomUUID(), target, text: 'Synthetic saved queue', delivery: 'queue' } })
  expect(await worker.admitRemote(queued, clientId, () => undefined)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'queued' } })
  worker.close(); control.dispose(); await control.closed()
  control = f.create()
  worker = new WatcherService({ directory: f.root, host: workspace.host, control, historyEnabled: () => true, limit: () => 1, workerHost: true })
  await control.start(); await control.commandShell({ type: 'connect', provider: 'codex' }); await worker.recover()
  const code = (id: string) => { try { worker.guardOperation(id); return undefined } catch (error) { return (error as { result?: { code: string } }).result?.code } }
  expect(control.watcherRecord().operations.find(item => item.id === queued.operation.id)?.deliveryState).toBe('queued')
  expect(code(queued.operation.id)).toBe('HOST_DISCONNECTED')
  expect(await worker.admitRemote(start, clientId, () => undefined)).toMatchObject({ receipt: { operationId: start.operation.id } })
  expect(code(queued.operation.id)).toBe('HOST_DISCONNECTED')
  if (queued.call.name !== 'send_to_thread') throw new Error('Synthetic queue packet mismatch')
  const fresh = packet({ name: 'send_to_thread', input: { ...queued.call.input, retryKey: randomUUID() } })
  expect(await worker.admitRemote(fresh, clientId, () => undefined)).toMatchObject({ status: 'ok' })
  expect(code(fresh.operation.id)).toBeUndefined()
  expect(code(queued.operation.id)).toBe('HOST_DISCONNECTED')
})


it.each([
  { desktop: 'approval-required', host: 'full-access' },
  { desktop: 'full-access', host: 'approval-required' },
] as const)('uses the common narrower default with desktop $desktop and host $host when permission is omitted', async defaults => {
  const f = await master()
  await f.control.commandShell({ type: 'configure', patch: { newThreadRuntimeMode: defaults.desktop } })
  await remote.host.service.command({ type: 'configure', patch: { newThreadRuntimeMode: defaults.host } }, desktopWindowClient())
  const first = await f.call('start_thread', f.start())
  expect(first.status, first.status === 'refused' ? first.code : undefined).toBe('ok')
  expect(first).toMatchObject({ effectiveChoices: { permission: { kind: 'runtime', mode: 'approval-required' } } })
  if (first.status !== 'ok') throw new Error('start-refused')
  await expect.poll(() => f.socket.shell().host.threads.find(item => item.id === first.target.threadId)?.runtimeMode).toBe('approval-required')
})


it.each(['list_projects', 'list_threads'] as const)('applies the explicit local host filter to %s while keeping the aggregate available', async name => {
  const f = await master()
  expect(await f.call('start_thread', f.start())).toMatchObject({ status: 'ok' })
  const aggregate = await f.call(name, {})
  if (aggregate.status !== 'ok') throw new Error('list-refused')
  const all = 'projects' in aggregate ? aggregate.projects : aggregate.rows
  expect(all.some(item => item.target.hostId === f.pairing.hostId)).toBe(true)
  const local = await f.call(name, { hostId: f.control.hostId()! })
  if (local.status !== 'ok') throw new Error('list-refused')
  const rows = 'projects' in local ? local.projects : local.rows
  expect(rows.every(item => item.target.hostId === f.control.hostId())).toBe(true)
  expect(rows.some(item => item.target.hostId === f.pairing.hostId)).toBe(false)
})

it.each(['retention', 'project filter', 'settlement', 'protection', 'queue preservation'] as const)('keeps paired identities separate for %s when local IDs collide', async check => {
  const f = await master()
  const started = await f.call('start_thread', f.start())
  if (started.status !== 'ok') throw new Error('Synthetic remote creation was refused')
  // The paired host's new thread reaches this computer's copy of the host a moment after the start returns.
  await expect.poll(() => f.socket.shell().host.threads.some(thread => thread.id === started.target.threadId)).toBe(true)
  const hostId = f.control.hostId()!, local = f.control.watcherSnapshot()
  const twin = { ...f.socket.shell().host.threads.find(thread => thread.id === started.target.threadId)!, hostId,
    title: 'Local identity twin', status: 'idle' as const, messages: [], requests: [] }
  const project = { ...f.project, hostId, title: 'Local reserved twin', path: join(f.root, 'watcher', 'workspace'), workspaceSettledAt: new Date().toISOString() }
  vi.spyOn(f.control, 'watcherSnapshot').mockReturnValue({ ...local, threads: [...local.threads, twin], projects: [...local.projects, project] })
  const shell = f.control.shell()
  vi.spyOn(f.control, 'shell').mockReturnValue({ ...shell, host: { ...shell.host, projects: [...shell.host.projects, project] } })
  if (check === 'queue preservation') {
    await f.control.updateWatcher(record => { record.requests.find(request => request.id === f.requestId)!.participants[0]!.automationStopped = true })
    expect(f.watcher.preserveUserQueue(twin.id)).toBe(false)
    return
  }
  if (check === 'retention') {
    expect(f.watcher.watchedThreadIds()).not.toContain(twin.id)
    return
  }
  const list = await f.call('list_threads', check === 'project filter' ? { project: { hostId, projectId: f.project.id } }
    : check === 'settlement' ? { includeSettled: false } : {})
  if (list.status !== 'ok') throw new Error('Synthetic catalog read was refused')
  if (check === 'project filter') expect(list.rows.map(row => row.target)).toEqual([{ hostId, threadId: twin.id }])
  if (check === 'settlement') {
    expect(list.rows.map(row => row.target)).toContainEqual(started.target)
    expect(list.rows.map(row => row.target)).not.toContainEqual({ hostId, threadId: twin.id })
  }
  if (check === 'protection') expect(list.rows.find(row => row.target.hostId === started.target.hostId && row.target.threadId === twin.id)?.protected).toBe(false)
})

it.each([
  { desired: 'high', expected: 'high' },
  { desired: 'thorough', expected: 'max' },
])("freezes this computer's $desired effort before hashing and preserves the omitted call on retry", async ({ desired, expected }) => {
  const f = await master()
  if (desired === 'thorough') {
    f.workspace.adapters.codex.state.models[0]!.reasoningEfforts = ['brief', 'thorough']
    await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  }
  await f.control.commandShell({ type: 'configure', patch: { newThreadModelId: f.control.shell().host.models[0]!.id, newThreadReasoningEffort: desired, newThreadRuntimeMode: 'full-access' } })
  await remote.host.service.command({ type: 'configure', patch: { newThreadReasoningEffort: 'low', newThreadRuntimeMode: 'approval-required' } }, desktopWindowClient())
  await vi.waitFor(() => expect(f.socket.shell().configuration.newThreadReasoningEffort).toBe('low'))
  const wire = vi.spyOn(f.socket, 'watcherControl'), input = f.start()
  const first = await f.call('start_thread', input)
  expect(first, JSON.stringify(first)).toMatchObject({ status: 'ok', effectiveChoices: { reasoningEffort: expected, permission: { kind: 'runtime', mode: 'approval-required' } } })
  if (first.status !== 'ok') throw new Error('start-refused')
  const packet = wire.mock.calls[0]![0]
  expect(packet.call.input).toMatchObject({ reasoningEffort: expected, permission: { kind: 'runtime', mode: 'approval-required' } })
  expect(packet.operation.digest).toBe(createHash('sha256').update(JSON.stringify([packet.call.name, packet.call.input])).digest('hex'))
  await f.control.commandShell({ type: 'configure', patch: { newThreadReasoningEffort: 'low', newThreadRuntimeMode: 'approval-required' } })
  expect(await f.call('start_thread', input)).toMatchObject({ receipt: { operationId: first.receipt.operationId } })
  expect(wire).toHaveBeenCalledOnce()
  expect(await f.call('start_thread', { ...input, firstPrompt: 'Synthetic changed retry' })).toMatchObject({ code: 'RETRY_KEY_CONFLICT' })
  const receipt = await f.socket.watcherControl(packet)
  expect(receipt).toMatchObject({ receipt: { operationId: first.receipt.operationId } })
  expect(remote.host.service.state().host.threads.filter(thread => thread.title === input.title)).toHaveLength(1)
  await expect.poll(() => f.socket.shell().host.threads.find(thread => thread.id === first.target.threadId)?.reasoningEffort).toBe(expected)
})

it('uses a fresh scoped connection for an admitted queue without renewing a restart fence', async () => {
  const native = await codexFixture(undefined, false); cleanups.push(native.cleanup)
  const f = await master(native.adapter), input = f.start(), first = await f.call('start_thread', input)
  if (first.status !== 'ok') throw new Error('start-refused')
  await vi.waitFor(() => expect(f.socket.shell().host.threads.some(thread => thread.id === first.target.threadId)).toBe(true))
  const queued = await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, text: 'Synthetic reconnect queue', delivery: 'queue' })
  expect(queued, JSON.stringify(queued)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'queued' } })
  const codexId = (await native.driver.requests()).findLast(item => item.method === 'turn/start')!.params!.threadId as string
  const aliases = JSON.parse(await readFile(join(native.root, 'codex-threads.json'), 'utf8')) as Record<string, { codexThreadId: string }>
  const nativeId = Object.entries(aliases).find(([, value]) => value.codexThreadId === codexId)![0]
  await f.socket.close()
  const socket = new SocketHostService({ url: remote.url, token: f.pairing.token, watcherEnabled: true }); remote.clients.push(socket)
  await socket.connect()
  await socket.watcherRead({ master: f.control.watcherRecord().current! })
  const worker = (remote.host.service as unknown as { options: { watcher: WatcherService } }).options.watcher
  expect(() => worker.guardOperation(queued.receipt!.operationId)).not.toThrow()
  await native.script({ holdReply: 'turn/start', suppressNotifications: true })
  const readReceipt = () => socket.watcherRead({ master: f.control.watcherRecord().current!,
    call: { name: 'read_operation', input: { operationId: queued.receipt!.operationId } } })
  const identity = { operationId: queued.receipt!.operationId, requestId: f.requestId, target: first.target }
  let releaseAction: string | undefined
  const releaseAck = async () => {
    releaseAction ??= await native.action(nativeId, { type: 'release-reply', method: 'turn/start' })
    await expect.poll(() => native.acted(releaseAction!)).toBe(true)
  }
  try {
    await native.driver.completeTurn(nativeId, 'Synthetic reconnect completion')
    await socket.command({ type: 'refresh', provider: 'codex' })
    await vi.waitFor(async () => expect((await native.driver.requests()).filter(item => item.method === 'turn/start')).toHaveLength(2))
    // The native journal proves arrival before acknowledgement. Acceptance belongs to the owning receipt.
    expect(await readReceipt()).toMatchObject({ receipt: { ...identity, deliveryState: 'dispatching' } })
    await releaseAck()
    await expect.poll(readReceipt).toMatchObject({ receipt: { ...identity, deliveryState: 'accepted' } })
    await vi.waitFor(() => expect((worker as unknown as { remoteGuards: Map<string, unknown> }).remoteGuards.size).toBe(0))
    const requests = await native.driver.requests()
    expect(requests.filter(item => item.method === 'turn/start')).toHaveLength(2)
    expect(requests.filter(item => item.method === 'request/answer')).toHaveLength(0)
  } finally {
    await releaseAck()
  }
})

it('refunds only an exact fenced absence and rejects a late packet for that operation', async () => {
  const f = await master(), original = f.socket.watcherControl.bind(f.socket)
  let packet: WatcherHostControl | undefined
  vi.spyOn(f.socket, 'watcherControl').mockImplementation(async input => { packet = input; throw new Error('synthetic-before-admission') })
  expect(await f.call('start_thread', f.start())).toMatchObject({ code: 'DELIVERY_UNCERTAIN' })
  expect(f.watcher.state().inFlight).toBe(1)
  await (f.watcher as unknown as { reconcileRemote(): Promise<void> }).reconcileRemote()
  expect(f.control.watcherRecord().operations.find(item => item.id === packet!.operation.id)).toMatchObject({ deliveryState: 'failed', refusalCode: 'OPERATION_NOT_RECORDED' })
  expect(f.watcher.state().inFlight).toBe(0)
  expect(f.control.watcherRecord().requests[0]!.participants[0]!.promptCount).toBe(0)
  expect(await original(packet!)).toMatchObject({ code: 'OPERATION_NOT_RECORDED' })
  expect(remote.host.service.state().host.threads.some(thread => thread.title === 'Synthetic remote worker')).toBe(false)
  await f.socket.close(); await remote.host.close()
  remote.host = await startFixtureHeadlessHost({ dataDirectory: remote.root, port: 0, providers: { codex: remote.native } })
  remote.url = 'http://127.0.0.1:' + remote.host.descriptor!.port
  const socket = new SocketHostService({ url: remote.url, token: f.pairing.token, watcherEnabled: true }); remote.clients.push(socket)
  await socket.connect()
  expect(await socket.watcherControl(packet!)).toMatchObject({ code: 'OPERATION_NOT_RECORDED' })
})

it.each(['Stop', 'Stop all'])('%s fences the owning request and removes its admitted machine queue', async action => {
  const native = await codexFixture(undefined, false); cleanups.push(native.cleanup)
  const f = await master(native.adapter), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok') throw new Error('start-refused')
  await vi.waitFor(() => expect(f.socket.shell().host.threads.some(thread => thread.id === first.target.threadId)).toBe(true))
  const queued = await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'queue', text: 'Synthetic stopped machine queue' })
  expect(queued).toMatchObject({ status: 'ok', receipt: { deliveryState: 'queued' } })
  if (action === 'Stop') await f.control.commandShell({ type: 'interrupt', threadId: f.id })
  else {
    const preview = f.watcher.prepareStopAll()
    if (preview.status !== 'ok') throw new Error('stop-preview-refused')
    expect(await f.watcher.stopAll(preview.confirmationId)).toMatchObject({ status: 'ok' })
  }
  const worker = (remote.host.service as unknown as { options: { watcher: WatcherService } }).options.watcher
  await vi.waitFor(() => expect(worker.remoteProjection(f.control.watcherRecord().current!, f.pairing.clientId).requests.find(request => request.id === f.requestId)?.state).toBe('stopped'))
  expect(remote.host.service.state().followups?.some(item => item.draftId === queued.receipt!.draftId)).toBe(false)
  expect(worker.remoteProjection(f.control.watcherRecord().current!, f.pairing.clientId).operations.find(item => item.id === queued.receipt!.operationId)).toMatchObject({ deliveryState: 'failed', refusalCode: 'REQUEST_NOT_ACTIVE' })
  expect((await native.driver.requests()).filter(item => item.method === 'turn/start')).toHaveLength(1)
})

it('rechecks the owning stopped request just before a prepared paired provider write', async () => {
  const native = await codexFixture(undefined, false); cleanups.push(native.cleanup)
  const f = await master(native.adapter), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok') throw new Error('start-refused')
  const codexId = (await native.driver.requests()).findLast(item => item.method === 'turn/start')!.params!.threadId as string
  const aliases = JSON.parse(await readFile(join(native.root, 'codex-threads.json'), 'utf8')) as Record<string, { codexThreadId: string }>
  const nativeId = Object.entries(aliases).find(([, value]) => value.codexThreadId === codexId)![0]
  await native.driver.completeTurn(nativeId, 'Synthetic completed turn')
  await vi.waitFor(() => expect(f.socket.shell().host.threads.find(thread => thread.id === first.target.threadId)?.lastTurn?.status).toBe('completed'))
  const gate = heldOperation(), prepare = native.adapter.prepareSkillInput.bind(native.adapter)
  vi.spyOn(native.adapter, 'prepareSkillInput').mockImplementation(async (...args) => { const result = await prepare(...args); if (args[1] === 'Synthetic held stopped send') await gate.wait(); return result })
  const send = f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'now', text: 'Synthetic held stopped send' })
  try {
    await gate.entered
    await f.control.commandShell({ type: 'interrupt', threadId: f.id })
    const worker = (remote.host.service as unknown as { options: { watcher: WatcherService } }).options.watcher
    await vi.waitFor(() => expect(worker.remoteProjection(f.control.watcherRecord().current!, f.pairing.clientId).requests.find(request => request.id === f.requestId)?.state).toBe('stopped'))
    gate.release()
    expect(await send).toMatchObject({ code: 'REQUEST_NOT_ACTIVE' })
    expect((await native.driver.requests()).filter(item => item.method === 'turn/start')).toHaveLength(1)
  } finally { gate.release(); await send }
})
