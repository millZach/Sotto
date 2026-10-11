// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { DESKTOP_CLIENTS_FILE } from '../../src/shared/desktopClients'
import { watcherToolSchemas, type WatcherToolName, type WatcherToolOutput } from '../../src/shared/watcher'
import type { WatcherHostControl } from '../../src/shared/watcherHost'
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
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

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
async function master(native?: CodexAppServerHost) {
  if (native) { await remote.host.close(); remote.host = await startFixtureHeadlessHost({ dataDirectory: remote.root, port: 0, providers: { codex: native } }); remote.url = 'http://127.0.0.1:' + remote.host.descriptor!.port }
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
  cleanups.push(async () => { watcher.close(); await tools.close(); f.control.dispose(); await f.control.closed(); await workspace.stop(); await workspace.remove() })
  await f.control.start(); await f.control.commandShell({ type: 'connect', provider: 'codex' }); await watcher.recover()
  const model = f.control.shell().host.models.find(item => item.providerId === 'codex')!
  expect(await watcher.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const id = watcher.state().current!.target.threadId
  await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic master request' })
  const requestId = watcher.state().requests.at(-1)!.id
  const start = () => ({ requestId, retryKey: randomUUID(), project: { hostId: paired.pairing.hostId, projectId: paired.project.id },
    modelId: paired.model.id, title: 'Synthetic remote worker', workingCopy: { kind: 'shared' as const }, firstPrompt: 'host_private_prompt_19cb' })
  const call = async <N extends WatcherToolName>(name: N, input: unknown): Promise<WatcherToolOutput<N>> => watcherToolSchemas[name].output.parse(await watcher.invoke(id, name, input)) as WatcherToolOutput<N>
  return { ...f, ...paired, watcher, router, connection, workspace, id, requestId, start, call }
}

it('negotiates host-v1 features only for recorded desktops and never for stable desktop automation', async () => {
  const health = await (await fetch(remote.url + '/v1/health')).json() as { v: number; features: string[] }
  expect(health.v).toBe(1); expect(health.features).toContain('watcher-control'); expect(health.features).toContain('watcher-reads')
  const general = await pairedDesktop(false)
  expect(general.hello.features).not.toContain('watcher-control')
  const raw = general.socket as unknown as { call(op: HostOperation): Promise<unknown> }
  await expect(raw.call({ op: 'watcher-read', request: { master: { target: { hostId: randomUUID(), threadId: 'forged' }, projectId: 'forged', provider: 'codex', creationOperationId: randomUUID(), createdAt: new Date().toISOString() } } })).rejects.toMatchObject({ code: 'forbidden' })
  const stable = await pairedDesktop(true, false)
  expect(stable.socket.supportsWatcherControl).toBe(false)
  await expect(stable.socket.watcherRead({ master: { target: { hostId: randomUUID(), threadId: 'master' }, projectId: 'master', provider: 'codex', creationOperationId: randomUUID(), createdAt: new Date().toISOString() } })).rejects.toMatchObject({ code: 'invalid_request' })
})

it('starts, reads positions, sends, stops and settles through the owning host without selecting it', async () => {
  const f = await master(), selected = f.router.shell().activeThreadId, input = f.start()
  const first = await f.call('start_thread', input)
  expect(first).toMatchObject({ status: 'ok', limits: { inFlightLimit: 1, promptCount: 1 } })
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start-refused')
  expect(await f.call('start_thread', input)).toMatchObject({ receipt: { operationId: first.receipt.operationId } })
  const read = await f.call('read_thread', { target: first.target })
  expect(read).toMatchObject({ status: 'ok', messages: [{ text: input.firstPrompt, position: 0 }] })
  if (read.status !== 'ok' || !('historyEpoch' in read)) throw new Error('read-refused')
  expect(await f.call('read_thread', { target: first.target, position: { historyEpoch: 'wrong-epoch', afterPosition: -1 } })).toMatchObject({ code: 'HISTORY_RESET' })
  remote.native.event({ type: 'ready', threadId: (await remote.native.snapshot()).threads.find(item => item.title === input.title)!.id, text: 'Synthetic completion' })
  await vi.waitFor(() => expect(f.socket.shell().host.threads.find(item => item.id === first.target.threadId)?.status).toBe('idle'))
  expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, text: 'Synthetic second prompt', delivery: 'now' })).toMatchObject({ status: 'ok', limits: { promptCount: 2 } })
  expect(await f.call('stop_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target })).toMatchObject({ status: 'ok', stopRequested: true })
  await vi.waitFor(() => expect(f.socket.shell().host.threads.find(item => item.id === first.target.threadId)?.status).toBe('idle'))
  const settled = await f.call('settle_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target })
  expect(settled.status, settled.status === 'refused' ? settled.code : undefined).toBe('ok')
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
  await f.socket.command({ type: 'manual-send', threadId: first.target.threadId, draftId: randomUUID(), text: 'Synthetic phone instruction' })
  await vi.waitFor(() => expect(f.watcher.state().watchedThreads[0]?.participation[0]?.state).toBe('taken-over'))
  expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, text: 'Synthetic refused', delivery: 'queue' })).toMatchObject({ code: 'THREAD_TAKEN_OVER' })
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
  const gate = heldOperation()
  const prepare = native.adapter.prepareSkillInput.bind(native.adapter)
  vi.spyOn(native.adapter, 'prepareSkillInput').mockImplementation(async (...args) => { const result = await prepare(...args); if (args[1] === 'Synthetic held machine') await gate.wait(); return result })
  const send = () => f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target, delivery: 'now', text: 'Synthetic held machine' })
  const lateQuestion = send()
  try {
    await gate.entered
    await native.driver.raiseQuestion(nativeId, 'Synthetic late question')
    await vi.waitFor(() => expect(f.socket.shell().host.threads.find(item => item.id === target.threadId)?.requests.length).toBe(1))
    gate.release()
    expect(await lateQuestion).toMatchObject({ code: 'PENDING_USER_REQUEST' })
    const before = await native.driver.requests()
    expect(before.filter(item => item.method === 'turn/start')).toHaveLength(1)
    expect(before.filter(item => item.method === 'request/answer')).toHaveLength(0)
    // A machine stop cancels the held question without answering it.
    expect(await f.call('stop_thread', { requestId: f.requestId, retryKey: randomUUID(), target })).toMatchObject({ status: 'ok' })
    expect((await native.driver.requests()).filter(item => item.method === 'request/answer')).toHaveLength(0)
  } finally { gate.release(); await lateQuestion; vi.restoreAllMocks() }
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
  await native.driver.completeTurn(nativeId, 'Synthetic completion')
  await vi.waitFor(() => expect(f.watcher.state().watchedThreads[0]?.participation[0]?.takeover?.reason).toBe('native-user-send'))
  await vi.waitFor(() => expect(f.watcher.state().receipts.find(item => item.id === (queued.status === 'ok' ? queued.receipt.operationId : ''))?.deliveryState).toBe('failed'))
  const written = await native.driver.requests()
  expect(written.filter(item => item.method === 'turn/start')).toHaveLength(1)
  expect(written.filter(item => item.method === 'turn/steer')).toHaveLength(1)
  expect(written.filter(item => item.method === 'request/answer')).toHaveLength(0)
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
  const first = await f.call('start_thread', { ...f.start(), permission: { kind: 'runtime', mode: 'approval-required' } })
  expect(first.status).toBe('ok')
  await f.control.commandShell({ type: 'configure', patch: { newThreadRuntimeMode: 'approval-required' } })
  const confirmation = f.watcher.prepareStopAll()
  if (confirmation.status !== 'ok' || first.status !== 'ok') throw new Error('stop-preview-refused')
  expect(confirmation.targets).toEqual([first.target])
  expect(await f.watcher.stopAll(confirmation.confirmationId)).toMatchObject({ status: 'ok', results: [{ target: first.target, status: expect.stringMatching(/stopped|requested/u) }] })
  expect(f.watcher.state().requests.find(item => item.id === f.requestId)?.state).toBe('stopped')
  expect(f.watcher.state().watchedThreads.find(item => item.target.threadId === first.target.threadId)?.participation[0]?.automationStopped).toBe(true)
})
