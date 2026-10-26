// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { WatcherService } from '../../src/main/agents/watcher'
import { createWatcherRoomDesktop } from '../../src/main/agents/watcherRoomDesktop'
import { registerIpc } from '../../src/main/ipc/registerIpc'
import { WATCHER_PREPARE_STOP_ALL, WATCHER_STOP_ALL, applyWatcherRoomUpdate, type WatcherPrepareStopAllResult, type WatcherRoomHeld, type WatcherRoomState, type WatcherRoomUpdate,
  type WatcherStopAllResult } from '../../src/shared/watcherRoom'
import { createIpcHarness } from '../fixtures/ipcHarness'
import { WatcherPhoneService } from '../../src/main/agents/watcherPhone'
import { LocalHostService } from '../../src/main/agents/hostService'
import { PairedClients } from '../../src/main/agents/pairing'
import { startSocketServer } from '../../src/host/socketServer'
import { canonicalModelId } from '../../src/shared/modelCatalog'
import { rawPeer } from '../fixtures/rawHostPeer'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { HostConnectionError, HostRequestTimeoutError, SocketHostService } from '../../src/main/agents/socketHostService'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { DESKTOP_CLIENTS_FILE } from '../../src/shared/desktopClients'
import { watcherToolSchemas, type WatcherThreadTarget, type WatcherToolName, type WatcherToolOutput } from '../../src/shared/watcher'
import { watcherHostControlSchema, type WatcherHostControl, type WatcherHostProjection } from '../../src/shared/watcherHost'
import type { HostOperation } from '../../src/shared/hostProtocol'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { startFixtureHeadlessHost } from '../fixtures/desktopHostStack'
import { codexFixture } from '../fixtures/codexFixture'
import { deferred, heldOperation } from '../fixtures/deferred'
import type { CodexAppServerHost } from '../../src/main/agents/codex'
import { storedFollowups } from '../fixtures/followupQueue'
import { initializeGitRepository } from '../fixtures/gitRepository'
import { markTurnActivity } from '../../src/main/agents/turnActivity'
import { HostFactsSource, hostMachineReport } from '../../src/main/agents/hostFacts'
import { lastUserMessageIdOf, type AgentState } from '../../src/shared/agents'
import { isResumeNoteText } from '../../src/shared/restartResume'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readProjectOrigins } from '../../src/main/agents/projectOrigins'
import type { WorkerMachineSetting } from '../../src/shared/workerMachine'
import { BranchBundles } from '../../src/main/agents/branchBundles'
import { DesktopBranchMoves, foldersOfSnapshot } from '../../src/main/agents/branchMoves'
import { branchMoveWords } from '../../src/shared/branchMoves'

/** These tests run on the real clock: ordinary news waits as long as a question does (#1190's timing has unit tests). */
const SHORT_BATCH = { quietMs: 2_000, maxMs: 5_000 }

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
/**
 * `machines` runs the desktop and the paired host with the Owl answer for Work across machines on (ADR-0082): `true` for
 * that alone, or where this computer's new workers start (#1032) as well.
 */
async function master(native?: CodexAppServerHost, usage = false, machines?: boolean | { setting: () => WorkerMachineSetting }) {
  const crossMachine = machines !== undefined && machines !== false, placing = typeof machines === 'object' ? machines : undefined
  const owl = usage || crossMachine
  if (native || owl) { await remote.host.close(); remote.host = await startFixtureHeadlessHost({ dataDirectory: remote.root, port: 0, providers: { codex: native ?? remote.native },
    ...(owl ? { sottoVersion: '0.1.38-owl.20261013.1' } : {}) }); remote.url = 'http://127.0.0.1:' + remote.host.descriptor!.port }
  const paired = await pairedDesktop()
  const workspace = await workspaceFixture(undefined, { history: false })
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host,
    credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => false, watcherEnabled: true } })
  // This computer's facts are read as the desktop reads them, from this machine (#1031).
  const facts = new HostFactsSource({ sleep: async () => undefined })
  // A start from a thread's branch moves it as the desktop does (#1033), over this computer's sockets to its hosts.
  const moving: { watcher?: WatcherService } = {}
  const branchMoves = new DesktopBranchMoves({ bundles: new BranchBundles({ stagingDirectory: join(f.root, 'branch-moves'), recordsPath: join(f.root, 'branch-moves.json') }),
    folders: foldersOfSnapshot(() => f.control.watcherSnapshot()), host: id => moving.watcher?.branchMoveHost(id), hostName: id => moving.watcher?.machineName(id) ?? 'That machine' })
  const watcher = moving.watcher = new WatcherService({ ordinaryBatch: SHORT_BATCH, directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => false,
    machineFacts: () => hostMachineReport(facts, () => ({ threads: f.control.watcherSnapshot().threads, ...f.control.watcherSendRecords() }), crossMachine), crossMachine,
    ...placing ? { workerMachine: placing.setting, projectOrigins: () => readProjectOrigins(f.control.shell().host.projects) } : {}, ...crossMachine ? { branchMoves } : {} })
  const tools = new WatcherToolServer(watcher, { machines: crossMachine }); workspace.host.useWatcherTools(tools)
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
  return { ...f, ...paired, watcher, tools, router, connection, workspace, id, requestId, start, call }
}
/** Lets the paired desktop answer on the host, or stops it, as Settings > Hosts & phones does, and waits for the desktop to hear. */
async function allowAnswers(f: Awaited<ReturnType<typeof master>>, allowed: boolean) {
  const { adminToken } = JSON.parse(await readFile(join(remote.root, 'host-listener.json'), 'utf8')) as { adminToken: string }
  const response = await fetch(remote.url + '/v1/admin/' + (allowed ? 'allow-answers' : 'deny-answers'), { method: 'POST',
    headers: { Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: f.pairing.clientId }) })
  expect(response.status).toBe(200)
  await expect.poll(() => f.router.watcherHosts().hosts()[0]?.permissionCeiling).toBe(allowed ? 'full-access' : 'approval-required')
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

it.each([['muse', 'Muse', 'supportsWatcherMuse'], ['cursor', 'Cursor', 'supportsWatcherCursor']] as const)('reads and directs a paired host for a Watcher on %s only when the host lists its Watcher feature, and says to update one that does not', async (provider, label, feature) => {
  const f = await master()
  // Watcher on Muse or Cursor: its identity names that provider (ADR-0079, ADR-0128); this host is new enough to take it.
  await f.control.updateWatcher(record => { record.current!.provider = provider })
  expect(f.socket[feature]).toBe(true)
  expect(f.hello.features).toContain(`watcher-${provider}`)
  const project = { hostId: f.pairing.hostId, projectId: f.project.id }
  expect(await f.call('list_threads', { project })).toMatchObject({ status: 'ok' })
  // An older host does not know a Watcher on that provider, so it is asked nothing and Watcher is told to update it.
  vi.spyOn(f.socket, feature, 'get').mockReturnValue(false)
  const reads = vi.spyOn(f.socket, 'watcherRead'), controls = vi.spyOn(f.socket, 'watcherControl')
  for (const [name, input] of [['list_threads', { project }], ['start_thread', f.start()]] as const) {
    expect(await f.call(name, input)).toMatchObject({ status: 'refused', code: 'HOST_FEATURE_UNAVAILABLE', message: expect.stringMatching(new RegExp(`Update Sotto on this host before Watcher on ${label}`, 'u')) })
  }
  expect(reads).not.toHaveBeenCalled(); expect(controls).not.toHaveBeenCalled()
  // Its projects say so too, rather than offering control Watcher would be refused.
  const listed = await f.call('list_projects', {})
  if (listed.status !== 'ok') throw new Error('projects-refused')
  const remoteRows = listed.projects.filter(item => item.target.hostId === f.pairing.hostId)
  expect(remoteRows.length).toBeGreaterThan(0)
  expect(remoteRows.every(item => !item.controlAvailable && !item.readsAvailable)).toBe(true)
})

it('lists This computer and each paired machine with its facts and running threads; an older host reads unknown, a disconnected one not connected (#1031)', async () => {
  const f = await master()
  const family = ({ win32: 'windows', darwin: 'macos', linux: 'linux' } as Record<string, string>)[process.platform] ?? null
  const machines = async () => { const result = await f.call('list_machines', {}); if (result.status !== 'ok') throw new Error('list-refused'); return result.machines }
  expect(await machines()).toEqual([
    expect.objectContaining({ hostId: f.control.hostId(), name: 'This computer', thisComputer: true, connected: true, factsState: 'reported',
      facts: expect.objectContaining({ os: expect.objectContaining({ family }) }) }),
    expect.objectContaining({ hostId: f.pairing.hostId, name: 'Synthetic remote', thisComputer: false, connected: true, factsState: 'reported',
      facts: expect.objectContaining({ os: expect.objectContaining({ family }) }), runningThreads: 0 })])
  // Work across machines is off on both: no machine shows a live load or work placed but not started (#1311).
  for (const machine of await machines()) expect(Object.keys(machine)).not.toEqual(expect.arrayContaining(['load']))
  // A start on the paired machine is in flight there, and its thread runs there.
  const started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start-refused')
  // The owning host's reply can arrive before the desktop's copy of the thread shows its first turn. A reconcile in
  // that gap reads a created thread with no turn and no message yet: the start is still in flight, not finished.
  // The router reads the host's state through its view, and some readers through its shell, so both stand in for it.
  const behindOf = (read: () => AgentState) => (): AgentState => {
    const state = read()
    return { ...state, host: { ...state.host, threads: state.host.threads.map(thread => {
      if (thread.id !== started.target.threadId) return thread
      const created = { ...thread }; delete created.lastTurn
      return { ...created, status: 'idle' as const, messages: [], ...thread.summary ? { summary: { ...thread.summary, messageCount: 0 } } : {} }
    }) } }
  }
  // Read the originals before spying: a spy is installed before its implementation's arguments are evaluated.
  const shell = behindOf(f.socket.shell.bind(f.socket)), view = behindOf(f.socket.view.bind(f.socket))
  const behind = [vi.spyOn(f.socket, 'shell').mockImplementation(shell), vi.spyOn(f.socket, 'view').mockImplementation(view)]
  await (f.watcher as unknown as { reconcileRemote(hostId: string): Promise<void> }).reconcileRemote(f.pairing.hostId)
  expect(f.watcher.startsInFlight()).toBe(1)
  for (const spy of behind) spy.mockRestore()
  await expect.poll(async () => (await machines())[1]).toMatchObject({ runningThreads: 1 })
  // No machine says anything of the Threads in flight limit, which is gone (#1183).
  for (const machine of await machines()) expect(Object.keys(machine)).not.toEqual(expect.arrayContaining(['inFlight']))
  // An older host does not list host-facts: it reads unknown, and nothing is asked of it.
  const socket = f.socket as unknown as { features: readonly string[] }, features = socket.features
  socket.features = features.filter(feature => feature !== 'host-facts')
  const asked = vi.spyOn(f.socket, 'hostFacts')
  expect((await machines())[1]).toMatchObject({ connected: true, factsState: 'unknown', facts: null, runningThreads: null,
    note: expect.stringContaining('Update Sotto on it') })
  expect(asked).not.toHaveBeenCalled()
  socket.features = features
  // A connection that drops while its facts are read reads not connected, not as the facts it sent before dropping.
  asked.mockImplementationOnce(async () => {
    const report = await SocketHostService.prototype.hostFacts.call(f.socket)
    Object.assign(f.connection, { available: () => false })
    return report
  })
  expect((await machines())[1]).toMatchObject({ connected: false, factsState: 'not-connected', facts: null, runningThreads: null })
  expect(asked).toHaveBeenCalledTimes(1)
  // A host that is not connected says so rather than reading its last facts as current, and is not asked.
  expect((await machines())[1]).toMatchObject({ connected: false, factsState: 'not-connected', facts: null, runningThreads: null })
  expect(asked).toHaveBeenCalledTimes(1)
})

it('shows each machine’s live load and work placed but not started with Work across machines on, and unknown where a host sends none (#1311)', async () => {
  const f = await master(undefined, false, true)
  const machines = async () => { const result = await f.call('list_machines', {}); if (result.status !== 'ok') throw new Error('list-refused'); return result.machines }
  const listed = await machines()
  expect(listed).toEqual([
    expect.objectContaining({ thisComputer: true, factsState: 'reported', load: expect.objectContaining({ windowMs: expect.any(Number) }), placedNotStarted: 0,
      memoryState: expect.stringMatching(/^(short|enough|unknown)$/u), cpuState: expect.stringMatching(/^(busy|not-busy|unknown)$/u) }),
    expect.objectContaining({ hostId: f.pairing.hostId, factsState: 'reported', runningThreads: 0, load: expect.objectContaining({ windowMs: expect.any(Number) }), placedNotStarted: 0 })])
  // A start admitted for the paired machine counts there before the host has it: the desktop adds its own reservation.
  const gate = deferred(), control = f.socket.watcherControl!.bind(f.socket)
  let held = 0
  const holding = vi.spyOn(f.socket, 'watcherControl').mockImplementation(async (...args) => { held += 1; await gate.promise; return control(...args) })
  const starting = f.call('start_thread', f.start())
  await vi.waitFor(() => expect(held).toBe(1))
  expect((await f.socket.hostFacts()).placedNotStarted).toBe(0)
  expect((await machines())[1]).toMatchObject({ placedNotStarted: 1 })
  gate.resolve()
  const started = await starting
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start-refused')
  holding.mockRestore()
  // Once the host holds it, it is counted once, by the host or as running there, and never twice.
  for (let index = 0; index < 5; index++) expect((await machines())[1]!.placedNotStarted).toBeLessThanOrEqual(1)
  await expect.poll(async () => (await machines())[1]).toMatchObject({ placedNotStarted: 0 })
  // A host whose own answer has the feature off sends its facts alone, as it did before: its load reads unknown.
  const report = await f.socket.hostFacts()
  vi.spyOn(f.socket, 'hostFacts').mockResolvedValue({ facts: report.facts, runningThreads: report.runningThreads })
  expect((await machines())[1]).toMatchObject({ factsState: 'reported', load: null, placedNotStarted: null, memoryState: 'unknown', cpuState: 'unknown' })
  // An older host does not list host-facts: its load reads unknown with its facts.
  const socket = f.socket as unknown as { features: readonly string[] }
  socket.features = socket.features.filter(feature => feature !== 'host-facts')
  expect((await machines())[1]).toMatchObject({ factsState: 'unknown', load: null, placedNotStarted: null, memoryState: 'unknown', cpuState: 'unknown' })
  // The tool Watcher is offered says so too.
  expect(f.tools.definitions.find(tool => tool.name === 'list_machines')!.description).toContain('how busy its CPU and memory are now')
})

it('reads a paired machine’s starts on their way before asking it, so a start counted by neither cannot slip between (#1311)', async () => {
  const f = await master(undefined, false, true)
  const machines = async () => { const result = await f.call('list_machines', {}); if (result.status !== 'ok') throw new Error('list-refused'); return result.machines }
  const gate = deferred(), control = f.socket.watcherControl!.bind(f.socket)
  let held = 0
  vi.spyOn(f.socket, 'watcherControl').mockImplementation(async (...args) => { held += 1; await gate.promise; return control(...args) })
  const starting = f.call('start_thread', f.start())
  await vi.waitFor(() => expect(held).toBe(1))
  // The host answers before the start reaches it, and the start goes through before the desktop reads the answer.
  const facts = f.socket.hostFacts.bind(f.socket)
  vi.spyOn(f.socket, 'hostFacts').mockImplementationOnce(async () => {
    const answer = await facts()
    gate.resolve(); expect(await starting).toMatchObject({ status: 'ok' })
    return answer
  })
  const [, machine] = await machines()
  // The answer saw neither the thread nor its turn, so the start counts as placed rather than nowhere.
  expect(machine).toMatchObject({ runningThreads: 0, placedNotStarted: 1 })
})

it('counts a start admitted for a paired machine while that machine was being asked for its count (#1311)', async () => {
  const f = await master(undefined, false, true)
  const machines = async () => { const result = await f.call('list_machines', {}); if (result.status !== 'ok') throw new Error('list-refused'); return result.machines }
  const gate = deferred(), control = f.socket.watcherControl!.bind(f.socket)
  let held = 0
  vi.spyOn(f.socket, 'watcherControl').mockImplementation(async (...args) => { held += 1; await gate.promise; return control(...args) })
  // While the host samples its load, Watcher admits a start there that is held before it is sent.
  let starting: Promise<unknown> | undefined
  const facts = f.socket.hostFacts.bind(f.socket)
  vi.spyOn(f.socket, 'hostFacts').mockImplementationOnce(async () => {
    starting = f.call('start_thread', f.start())
    await vi.waitFor(() => expect(held).toBe(1))
    return facts()
  })
  const [, machine] = await machines()
  // The answer was taken before the host had it, and the desktop read none before asking: it still counts once.
  expect(machine).toMatchObject({ runningThreads: 0, placedNotStarted: 1 })
  gate.resolve()
  expect(await starting).toMatchObject({ status: 'ok' })
})

it.each([
  ['timed out', true],
  ['lost its connection', false],
] as const)('counts a paired start whose request %s as placed only while the host may still start it (#1311)', async (_how, timedOut) => {
  const f = await master(undefined, false, true)
  const machines = async () => { const result = await f.call('list_machines', {}); if (result.status !== 'ok') throw new Error('list-refused'); return result.machines }
  // Receipts cannot be read, so the start stays unconfirmed.
  const reads = vi.spyOn(f.socket, 'watcherRead').mockRejectedValue(new Error('lost-projection'))
  vi.spyOn(f.socket, 'watcherControl').mockRejectedValue(timedOut
    ? new HostRequestTimeoutError('The host did not answer in time. Try refreshing.')
    : new HostConnectionError('The host connection closed. Connect again to refresh.', 'disconnected'))
  const started = await f.call('start_thread', f.start())
  expect(started).toMatchObject({ status: 'refused', code: 'DELIVERY_UNCERTAIN' })
  if (!('receipt' in started) || !started.receipt) throw new Error('no-receipt')
  const operationId = started.receipt.operationId
  expect(f.control.watcherRecordView().operations.find(item => item.id === operationId)?.deliveryState).toBe('uncertain')
  // A request that timed out is still alive on the host, which may start it later; a closed connection fenced it.
  expect((await machines())[1]).toMatchObject({ placedNotStarted: timedOut ? 1 : 0 })
  // Once its receipt is read, the start is resolved and stops counting.
  reads.mockRestore()
  await expect.poll(async () => {
    await (f.watcher as unknown as { reconcileRemote: (hostId: string) => Promise<void> }).reconcileRemote(f.pairing.hostId).catch(() => undefined)
    return f.control.watcherRecordView().operations.find(item => item.id === operationId)?.deliveryState
  }).toBe('failed')
  expect((await machines())[1]).toMatchObject({ placedNotStarted: 0 })
})

it('leaves a timed-out paired start to the host once the host’s own receipt shows it holds it, even as uncertain (#1311)', async () => {
  const f = await master(undefined, false, true)
  const machines = async () => { const result = await f.call('list_machines', {}); if (result.status !== 'ok') throw new Error('list-refused'); return result.machines }
  // The start's operation, once its answer names it.
  const own: { operationId?: string } = {}
  // Until the host answers, nothing of the start can be read back.
  let readable = false
  const read = f.socket.watcherRead.bind(f.socket)
  vi.spyOn(f.socket, 'watcherRead').mockImplementation(async (request, ...rest) => {
    if (!readable) throw new Error('lost-projection')
    // The host holds the start, and its own receipt says the start's delivery is uncertain there.
    const answer = await read(request, ...rest) as { operations?: { id: string; deliveryState: string }[]; receipt?: { operationId: string; deliveryState: string } }
    return { ...answer, ...answer.operations ? { operations: answer.operations.map(item => item.id === own.operationId ? { ...item, deliveryState: 'uncertain' } : item) } : {},
      ...answer.receipt?.operationId === own.operationId ? { receipt: { ...answer.receipt, deliveryState: 'uncertain' } } : {} }
  })
  const control = f.socket.watcherControl.bind(f.socket)
  vi.spyOn(f.socket, 'watcherControl').mockImplementationOnce(async (...args) => {
    await control(...args)
    throw new HostRequestTimeoutError('The host did not answer in time. Try refreshing.')
  })
  const started = await f.call('start_thread', f.start())
  expect(started).toMatchObject({ status: 'refused', code: 'DELIVERY_UNCERTAIN' })
  if (!('receipt' in started) || !started.receipt) throw new Error('no-receipt')
  own.operationId = started.receipt.operationId
  expect((await machines())[1]).toMatchObject({ placedNotStarted: 1 })
  readable = true
  await expect.poll(async () => {
    await (f.watcher as unknown as { reconcileRemote: (hostId: string) => Promise<void> }).reconcileRemote(f.pairing.hostId).catch(() => undefined)
    return (await machines())[1]!.placedNotStarted
  }).toBe(0)
  expect(f.control.watcherRecordView().operations.find(item => item.id === own.operationId)?.deliveryState).toBe('uncertain')
})

it('starts, reads positions, sends, stops and settles through the owning host without selecting it', async () => {
  const f = await master(), selected = f.router.shell().activeThreadId, input = f.start()
  expect(f.router.watcherHosts().hosts()).toEqual([expect.objectContaining({ hostId: f.pairing.hostId, workSettled: true })])
  // The host answers as host protocol version 1 has it, with the old limit's numbers, so an older desktop still reads
  // it. This desktop takes them off, and the owning host sends no working threads warning of its own (#1183).
  const raw = vi.spyOn(f.socket as unknown as { call(request: { op: string }): Promise<unknown> }, 'call')
  const first = await f.call('start_thread', input)
  const wire = await raw.mock.results[raw.mock.calls.findIndex(([request]) => request.op === 'watcher-control')]!.value as { limits: Record<string, unknown> }
  raw.mockRestore()
  expect(wire.limits).toMatchObject({ inFlight: 0, inFlightLimit: 8, promptCount: 1 })
  expect(wire).not.toHaveProperty('warning')
  expect(first).toMatchObject({ status: 'ok', limits: { promptCount: 1, promptLimit: 4 } })
  expect(first).not.toHaveProperty('warning')
  if (first.status === 'ok') expect(first.limits).toEqual({ promptCount: 1, promptLimit: 4 })
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start-refused')
  expect(await f.call('start_thread', input)).toMatchObject({ receipt: { operationId: first.receipt.operationId } })
  const read = await f.call('read_thread', { target: first.target })
  expect(read).toMatchObject({ status: 'ok', messages: [{ text: input.firstPrompt, position: 0 }] })
  if (read.status !== 'ok' || !('historyEpoch' in read)) throw new Error('read-refused')
  expect(await f.call('read_thread', { target: first.target, position: { historyEpoch: 'wrong-epoch', afterPosition: -1 } })).toMatchObject({ code: 'HISTORY_RESET' })
  remote.native.event({ type: 'ready', threadId: (await remote.native.snapshot()).threads.find(item => item.title === input.title)!.id, text: 'Synthetic completion' })
  await f.socket.command({ type: 'refresh', provider: 'codex' })
  await vi.waitFor(() => expect(f.socket.shell().host.threads.find(item => item.id === first.target.threadId)?.status).toBe('idle'))
  // A merge turn's mark is the desktop's alone (#1339): the owning host is sent the send without it, and the picture has it.
  const forwarded = vi.spyOn(f.socket as unknown as { call(request: { op: string }): Promise<unknown> }, 'call')
  const second = await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, text: 'Synthetic second prompt', delivery: 'now', mergeTurn: { pullRequest: 1291 } })
  const packet = forwarded.mock.calls.map(([request]) => request).find(request => request.op === 'watcher-control')
  forwarded.mockRestore()
  expect(second).toMatchObject({ status: 'ok', limits: { promptCount: 2 } })
  expect(packet).toBeDefined()
  expect(JSON.stringify(packet)).not.toContain('mergeTurn')
  if (second.status !== 'ok' || !('receipt' in second)) throw new Error('send-refused')
  expect(f.watcher.readMergeTurns()).toMatchObject({ status: 'ok', turns: [{ operationId: second.receipt.operationId, target: first.target, pullRequest: 1291 }] })
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

it('settles several idle threads on a paired host under one request while Watcher works (#1254)', async () => {
  const f = await master(), targets: { hostId: string, threadId: string }[] = []
  for (let index = 0; index < 3; index++) {
    const threadId = randomUUID()
    expect((await f.socket.command({ type: 'create-thread', threadId, projectId: f.project.id, modelId: f.model.id,
      title: `Synthetic idle remote review ${index}`, runtimeMode: 'approval-required', workingCopy: 'shared' })).error).toBeNull()
    await expect.poll(() => f.socket.shell().host.threads.some(thread => thread.id === threadId)).toBe(true)
    targets.push({ hostId: f.pairing.hostId, threadId })
  }
  for (const target of targets) {
    const settled = await f.call('settle_thread', { requestId: f.requestId, retryKey: randomUUID(), target })
    expect(settled, JSON.stringify(settled)).toMatchObject({ status: 'ok' })
  }
  expect(f.watcher.state().requests.find(item => item.id === f.requestId)).toMatchObject({ state: 'active' })
})

it('keeps a closed paired copy stopped when a settle the master sent before its Stop arrives after it (#1254)', async () => {
  const f = await master(), targets: { hostId: string, threadId: string }[] = []
  for (let index = 0; index < 2; index++) {
    const threadId = randomUUID()
    expect((await f.socket.command({ type: 'create-thread', threadId, projectId: f.project.id, modelId: f.model.id,
      title: `Synthetic idle remote review ${index}`, runtimeMode: 'approval-required', workingCopy: 'shared' })).error).toBeNull()
    await expect.poll(() => f.socket.shell().host.threads.some(thread => thread.id === threadId)).toBe(true)
    targets.push({ hostId: f.pairing.hostId, threadId })
  }
  const owner = (remote.host.service as unknown as { options: { watcher: WatcherService } }).options.watcher
  const copy = () => owner.state().requests.find(item => item.id === f.requestId)
  expect(await f.call('settle_thread', { requestId: f.requestId, retryKey: randomUUID(), target: targets[0] })).toMatchObject({ status: 'ok' })
  await expect.poll(() => copy()?.state).toBe('closed')
  // The master reads an unconfirmed operation back on its next reconcile pass, 250 ms after it is left so. On a slow
  // machine that pass came before the Stop below: the owning host, with no record of the held settle, fenced its ID, and
  // the settle was refused as unrecorded, which is the other order and its own case. The pass is held here so the Stop
  // comes first, as this test names; the Stop's own reconcile runs at once and is not held.
  const passes = f.watcher as unknown as { remoteTimer?: unknown; remoteFlushing: boolean; armRemote(): void }
  await vi.waitFor(() => { expect(passes.remoteTimer).toBeUndefined(); expect(passes.remoteFlushing).toBe(false) })
  vi.spyOn(passes, 'armRemote').mockImplementation(() => undefined)
  // The second settle leaves the master but is held on the way, so the owning host has not seen it.
  let held: WatcherHostControl | undefined
  vi.spyOn(f.socket, 'watcherControl').mockImplementation(async packet => { held = packet; throw new Error('held-in-transit') })
  expect(await f.call('settle_thread', { requestId: f.requestId, retryKey: randomUUID(), target: targets[1] })).toMatchObject({ status: 'refused' })
  expect(held).toBeDefined()
  // It arrives just after the owning host hears the Stop, before that read asks after it.
  const stops = owner as unknown as { stopRemoteRequests(...args: unknown[]): Promise<void> }, stop = stops.stopRemoteRequests.bind(owner)
  let late: unknown
  vi.spyOn(stops, 'stopRemoteRequests').mockImplementation(async (...args) => {
    await stop(...args)
    late ??= await owner.admitRemote(held!, f.pairing.clientId, () => undefined)
  })
  expect((await f.control.commandShell({ type: 'interrupt', threadId: f.id })).error).toBeNull()
  expect(f.watcher.state().requests.find(item => item.id === f.requestId)?.state).toBe('stopped')
  await expect.poll(() => late).toBeDefined()
  expect(late).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
  expect(copy()?.state).toBe('stopped')
  expect(copy()?.participants.find(item => item.target.threadId === targets[1]!.threadId)).toBeUndefined()
})

it('holds a lost acknowledgement through disconnection and reconciles without another send', async () => {
  const f = await master(), input = f.start()
  const original = f.socket.watcherControl.bind(f.socket)
  const reads = vi.spyOn(f.socket, 'watcherRead').mockRejectedValue(new Error('lost-projection'))
  let admitted: WatcherHostControl | undefined
  vi.spyOn(f.socket, 'watcherControl').mockImplementation(async packet => { admitted = packet; await original(packet); throw new Error('lost-ack') })
  expect(await f.call('start_thread', input)).toMatchObject({ status: 'refused', code: 'DELIVERY_UNCERTAIN' })
  f.router.setReconnecting(f.pairing.hostId, true)
  expect(f.watcher.startsInFlight()).toBe(1)
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
  expect(spy).not.toHaveBeenCalled(); expect(f.watcher.startsInFlight()).toBe(0)
  expect(await f.call('list_projects', {})).toMatchObject({ status: 'ok', projects: expect.arrayContaining([expect.objectContaining({ target: { hostId: f.pairing.hostId, projectId: f.project.id }, controlAvailable: false })]) })
})

it('publishes the host user’s turn and holds automated prompts behind it before another writer', async () => {
  // Turns here end only when the test ends them, so the user's turn, and its pause, last while the test reads them.
  const native = await codexFixture(undefined, false); cleanups.push(native.cleanup)
  const f = await master(native.adapter), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start-refused')
  const codexId = (await native.driver.requests()).findLast(item => item.method === 'turn/start')!.params!.threadId as string
  const aliases = JSON.parse(await readFile(join(native.root, 'codex-threads.json'), 'utf8')) as Record<string, { codexThreadId: string }>
  await native.driver.completeTurn(Object.entries(aliases).find(([, value]) => value.codexThreadId === codexId)![0], 'Synthetic start completion')
  await vi.waitFor(() => expect(f.socket.shell().host.threads.find(item => item.id === first.target.threadId)?.lastTurn?.status).toBe('completed'))
  const confirmation = f.watcher.prepareStopAll()
  if (confirmation.status !== 'ok') throw new Error('stop-preview-refused')
  await f.socket.command({ type: 'manual-send', threadId: first.target.threadId, draftId: randomUUID(), text: 'Synthetic phone instruction' })
  await vi.waitFor(() => expect(f.watcher.state().watchedThreads[0]).toMatchObject({ watched: true, paused: true, participation: [{ state: 'participating' }] }))
  expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, text: 'Synthetic refused', delivery: 'queue' })).toMatchObject({ code: 'THREAD_BUSY' })
  expect(await f.watcher.stopAll(confirmation.confirmationId)).toMatchObject({ code: 'TARGET_CHANGED' })
})

it('keeps the prior paired fence after a host user changes a watched thread no request took part in', async () => {
  // Paired requests do not share the owning host's request order, so its local takeover marker grants and fences nothing
  // for them: only a taken-over participation does, as before the local resume rule (#1157, Bug Bot finding 1).
  const f = await master(), threadId = randomUUID()
  expect((await f.socket.command({ type: 'create-thread', threadId, projectId: f.project.id, modelId: f.model.id,
    title: 'Synthetic user-started remote worker', runtimeMode: 'approval-required', workingCopy: 'shared' })).error).toBeNull()
  const target = { hostId: f.pairing.hostId, threadId }
  await expect.poll(() => f.socket.shell().host.threads.some(thread => thread.id === threadId)).toBe(true)
  expect(await f.watcher.watchThread({ target })).toMatchObject({ status: 'ok' })
  const effort = f.model.reasoningEfforts?.at(-1)
  expect((await f.socket.command({ type: 'configure-thread', threadId, ...(effort ? { reasoningEffort: effort } : { runtimeMode: 'approval-required' as const }) })).error).toBeNull()
  await expect.poll(() => f.watcher.state().watchedThreads.find(item => item.target.threadId === threadId)).toMatchObject({ watched: true, paused: false })
  const sent = await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target, delivery: 'now', text: 'Synthetic desktop prompt after host change' })
  expect(sent, JSON.stringify(sent)).toMatchObject({ status: 'ok' })
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
  // The background poll can finish before it discovers this rollout. Establish the user's turn before releasing the queue.
  await native.adapter.refreshThread(nativeId)
  await vi.waitFor(() => expect(f.watcher.state().watchedThreads[0]?.paused).toBe(true))
  await native.driver.completeTurn(nativeId, 'Synthetic completion')
  await vi.waitFor(() => expect(f.watcher.state().receipts.find(item => item.id === (queued.status === 'ok' ? queued.receipt.operationId : ''))?.deliveryState).toBe('failed'))
  const written = await native.driver.requests()
  expect(written.filter(item => item.method === 'turn/start')).toHaveLength(1)
  expect(written.filter(item => item.method === 'turn/steer')).toHaveLength(1)
  expect(written.filter(item => item.method === 'request/answer')).toHaveLength(0)
}, 60_000)

it('picks a default send’s delivery on the desktop and sends a paired host the one it picked (ADR-0130)', async () => {
  const native = await codexFixture(undefined, false, 10_000); cleanups.push(native.cleanup)
  const f = await master(native.adapter), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok') throw new Error('start-refused')
  const target = first.target
  await vi.waitFor(() => expect(f.socket.shell().host.threads.find(item => item.id === target.threadId)?.lastTurn?.status).toBe('running'))
  const turnId = f.socket.shell().host.threads.find(item => item.id === target.threadId)!.lastTurn!.id
  const codexId = (await native.driver.requests()).findLast(item => item.method === 'turn/start')!.params!.threadId as string
  const aliases = JSON.parse(await readFile(join(native.root, 'codex-threads.json'), 'utf8')) as Record<string, { codexThreadId: string }>
  const nativeId = Object.entries(aliases).find(([, value]) => value.codexThreadId === codexId)![0]
  const packets: WatcherHostControl[] = []
  const original = f.socket.watcherControl.bind(f.socket)
  vi.spyOn(f.socket, 'watcherControl').mockImplementation(packet => { packets.push(structuredClone(packet)); return original(packet) })
  // A head fence comes before the picked delivery in the call as made; the host still finds the digest it was sent.
  const head = await vi.waitFor(() => { const id = lastUserMessageIdOf(f.socket.shell().host.threads.find(item => item.id === target.threadId)!); if (!id) throw new Error('No head yet'); return id })
  const steered = await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target, text: 'Synthetic default steer', expectedLastUserMessageId: head })
  expect(steered, JSON.stringify(steered)).toMatchObject({ status: 'ok', delivery: 'steer' })
  expect(packets.at(-1)!.call.input).toMatchObject({ delivery: 'steer', expectedTurnId: turnId, expectedLastUserMessageId: head })
  await vi.waitFor(async () => expect((await native.driver.requests()).filter(item => item.method === 'turn/steer')).toHaveLength(1))
  await native.driver.completeTurn(nativeId, 'Synthetic completion')
  await vi.waitFor(() => expect(f.socket.shell().host.threads.find(item => item.id === target.threadId)).toMatchObject({ status: 'idle', lastTurn: { status: 'completed' } }))
  const sent = await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target, text: 'Synthetic default now' })
  expect(sent, JSON.stringify(sent)).toMatchObject({ status: 'ok', delivery: 'now' })
  expect(packets.at(-1)!.call.input).toMatchObject({ delivery: 'now' })
  await vi.waitFor(async () => expect((await native.driver.requests()).filter(item => item.method === 'turn/start')).toHaveLength(2))
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
    // The user's input moves the owning host's watch to a new generation, which fences the prepared send.
    const owner = (remote.host.service as unknown as { options: { watcher: WatcherService } }).options.watcher
    const generation = () => owner.state().standingWatches?.find(item => item.target.threadId === target.threadId)?.generation ?? -1
    const before = generation()
    await native.typeUnseen(nativeId, 'Synthetic native input after preparation')
    gate.release()
    await vi.waitFor(() => expect(generation()).toBeGreaterThan(before))
    await vi.waitFor(() => expect(f.watcher.state().receipts.find(item => item.id === queued.receipt.operationId)?.deliveryState).toBe('failed'))
    const written = await native.driver.requests()
    expect(written.filter(item => item.method === 'turn/start')).toHaveLength(1)
    expect(written.filter(item => item.method === 'turn/steer')).toHaveLength(0)
    expect(written.filter(item => item.method === 'request/answer')).toHaveLength(0)
  } finally { gate.release() }
}, 60_000)

it('settles a refused paired queue send even when the takeover clears the queue before the send finishes', async () => {
  const native = await codexFixture(undefined, false, 10_000, { pollIntervalMs: 600_000 }); cleanups.push(native.cleanup)
  const f = await master(native.adapter), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok') throw new Error('start-refused')
  const target = first.target
  await vi.waitFor(() => expect(f.socket.shell().host.threads.find(item => item.id === target.threadId)?.lastTurn?.status).toBe('running'))
  const codexId = (await native.driver.requests()).findLast(item => item.method === 'turn/start')!.params!.threadId as string
  const aliases = JSON.parse(await readFile(join(native.root, 'codex-threads.json'), 'utf8')) as Record<string, { codexThreadId: string }>
  const nativeId = Object.entries(aliases).find(([, value]) => value.codexThreadId === codexId)![0]
  const text = 'Synthetic refused native queue'
  const owning = remote.host.service as unknown as { options: { watcher: WatcherService; control: {
    finishTurn(turn: unknown, error?: string): Promise<void>; cancelWatcherQueue(operationIds: ReadonlySet<string>): Promise<void>
    followupStore: { peek(): { items: readonly { text: string; status: string }[] } } } } }
  const owner = owning.options.watcher, control = owning.options.control
  const gate = heldOperation(), prepare = native.adapter.prepareSkillInput.bind(native.adapter)
  vi.spyOn(native.adapter, 'prepareSkillInput').mockImplementation(async (...args) => {
    const result = await prepare(...args)
    if (args[1] === text) await gate.wait()
    return result
  })
  // The owning queue has saved the refused send as failed but has not finished its turn. The takeover that the
  // native input causes lands in this gap and removes the queue item: the item's failure must already be recorded.
  // A cancel that came while the item was still dispatching would keep it, so the takeover's cancel waits for the failure.
  const queueItem = () => control.followupStore.peek().items.find(item => item.text === text)
  const finishing = heldOperation(), finish = control.finishTurn.bind(control), cancel = control.cancelWatcherQueue.bind(control)
  let held = false
  vi.spyOn(control, 'finishTurn').mockImplementation(async (turn, error) => {
    if (error !== undefined && !held && queueItem()?.status === 'failed') { held = true; await finishing.wait() }
    return finish(turn, error)
  })
  vi.spyOn(control, 'cancelWatcherQueue').mockImplementation(async operationIds => {
    if (queueItem()?.status === 'dispatching') await vi.waitFor(() => expect(queueItem()?.status).toBe('failed'))
    return cancel(operationIds)
  })
  const queued = await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target, delivery: 'queue', text })
  expect(queued).toMatchObject({ status: 'ok', receipt: { deliveryState: 'queued' } })
  if (queued.status !== 'ok') throw new Error('queue-refused')
  try {
    await native.driver.completeTurn(nativeId, 'Synthetic completion before refused input')
    await gate.entered
    // The user's input moves the owning host's watch to a new generation, which fences the prepared send.
    const generation = () => owner.state().standingWatches?.find(item => item.target.threadId === target.threadId)?.generation ?? -1
    const before = generation()
    await native.typeUnseen(nativeId, 'Synthetic native input before the refused send')
    gate.release()
    await finishing.entered
    await vi.waitFor(() => expect(generation()).toBeGreaterThan(before))
    await vi.waitFor(() => expect(queueItem()).toBeUndefined())
    finishing.release()
    await vi.waitFor(() => expect(owner.state().receipts.find(item => item.id === queued.receipt.operationId)?.deliveryState).toBe('failed'))
    await vi.waitFor(() => expect(f.watcher.state().receipts.find(item => item.id === queued.receipt.operationId)?.deliveryState).toBe('failed'))
    // The count of starts still working can follow the failed receipt by an update (it failed CI twice when read at once), so it is waited for too.
    await vi.waitFor(() => expect(f.watcher.startsInFlight()).toBe(0))
    const written = await native.driver.requests()
    expect(written.filter(item => item.method === 'turn/start')).toHaveLength(1)
  } finally { gate.release(); finishing.release() }
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

it('refuses a mode wider than the owning host lets this computer give and keeps a confirmed remote Stop all after the master default changes', async () => {
  const f = await master()
  await f.control.commandShell({ type: 'configure', patch: { newThreadRuntimeMode: 'full-access' } })
  expect(await f.call('start_thread', { ...f.start(), permission: { kind: 'runtime', mode: 'full-access' } })).toMatchObject({ code: 'PERMISSION_TOO_WIDE' })
  expect(f.watcher.startsInFlight()).toBe(0)
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

/** A Full access thread the host's own user opened on `f`'s paired host, a send to it, and the permission a start there is held to. */
async function fullAccessHostThread(f: Awaited<ReturnType<typeof master>>) {
  const threadId = randomUUID(), target = { hostId: f.pairing.hostId, threadId }
  await remote.host.service.command({ type: 'create-thread', threadId, projectId: f.project.id, title: 'Synthetic full-access thread',
    titleSource: 'user', modelId: f.model.id, runtimeMode: 'full-access' }, desktopWindowClient())
  await expect.poll(() => f.socket.shell().host.threads.find(thread => thread.id === threadId)?.runtimeMode).toBe('full-access')
  // The aggregate list and one naming the host give the permission a start there is held to. A send is held to none (#1145).
  const listed = async (input: { hostId?: string }) => {
    // Models come only when asked for (#1191).
    const projects = await f.call('list_projects', { ...input, includeModels: true })
    if (projects.status !== 'ok') throw new Error('list-refused')
    return projects.projects.find(item => item.target.hostId === f.pairing.hostId)?.workers?.find(item => item.modelId === f.model.id)?.defaultPermission
  }
  const send = (text: string) => f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target, text, delivery: 'now' })
  const startFullAccess = () => f.call('start_thread', { ...f.start(), permission: { kind: 'runtime', mode: 'full-access' } })
  return { target, listed, send, startFullAccess }
}

it('sends to a full-access thread on a paired host above the new-thread default, and starts none wider than it (#1145)', async () => {
  const f = await master()
  await allowAnswers(f, true)
  // As on a real desktop: Settings saves the default on this computer only (ADR-0074), so the host keeps none of its own.
  await f.control.commandShell({ type: 'configure', patch: { newThreadRuntimeMode: 'approval-required' } })
  expect(remote.host.service.state().configuration.newThreadRuntimeMode).toBeUndefined()
  const { target, listed, send, startFullAccess } = await fullAccessHostThread(f)
  expect(await listed({})).toEqual({ kind: 'runtime', mode: 'approval-required' })
  expect(await listed({ hostId: f.pairing.hostId })).toEqual({ kind: 'runtime', mode: 'approval-required' })
  const writes = vi.spyOn(f.socket, 'watcherControl')
  const sent = await send('Synthetic full-access send')
  expect(sent, JSON.stringify(sent)).toMatchObject({ status: 'ok' })
  expect(writes).toHaveBeenCalledOnce()
  // A start there is still held to the new-thread default, in the same words, before anything crosses the wire.
  expect(await startFullAccess()).toEqual({ status: 'refused', code: 'PERMISSION_TOO_WIDE', retryable: false,
    message: 'Watcher cannot give a thread more permission than your new-thread default. Nothing was sent or started. To give it more, widen New threads start with in Settings → Threads first.' })
  expect(writes).toHaveBeenCalledOnce()
  // A restarted host learns again from the desktop's next read whether it may answer, so restored operations are not held back.
  const owner = (remote.host.service as unknown as { options: { watcher: WatcherService } }).options.watcher
  const answers = (owner as unknown as { remoteAnswers: Map<string, () => boolean> }).remoteAnswers
  answers.clear()
  expect(await f.call('read_thread', { target })).toMatchObject({ status: 'ok' })
  expect(answers.get(f.pairing.clientId)?.()).toBe(true)
})

it('sends to a full-access thread on a paired host where this computer may not answer, and starts there no wider than Ask for approval', async () => {
  const f = await master()
  await allowAnswers(f, false)
  await f.control.commandShell({ type: 'configure', patch: { newThreadRuntimeMode: 'full-access' } })
  const { listed, send, startFullAccess } = await fullAccessHostThread(f)
  expect(await listed({})).toEqual({ kind: 'runtime', mode: 'approval-required' })
  expect(await listed({ hostId: f.pairing.hostId })).toEqual({ kind: 'runtime', mode: 'approval-required' })
  // A start is held to Ask for approval there whatever the default, and says why before it crosses the wire.
  const held = { status: 'refused', code: 'PERMISSION_TOO_WIDE', message: expect.stringContaining('does not let this computer answer') }
  const writes = vi.spyOn(f.socket, 'watcherControl')
  expect(await startFullAccess()).toMatchObject(held)
  expect(writes).not.toHaveBeenCalled()
  // A send gives the thread nothing it did not have, so the host takes it: a paired desktop may send there without Can answer.
  const sent = await send('Synthetic send where this computer may not answer')
  expect(sent, JSON.stringify(sent)).toMatchObject({ status: 'ok' })
  expect(writes).toHaveBeenCalledOnce()
  // The host holds a start back itself: with this computer's own check out of the way, the host refuses it.
  vi.spyOn(f.watcher as unknown as { permissionLimits: () => object }, 'permissionLimits').mockReturnValue({})
  const threads = remote.host.service.state().host.threads.length
  const start = await startFullAccess()
  expect(start, JSON.stringify(start)).toMatchObject(held)
  expect(writes).toHaveBeenCalledTimes(2)
  expect(remote.host.service.state().host.threads).toHaveLength(threads)
})

it('refuses a model without an asking mode on a host where this computer may not answer, rather than fit it to one that skips asking', async () => {
  const f = await master()
  await f.control.commandShell({ type: 'configure', patch: { newThreadRuntimeMode: 'full-access' } })
  // The router reads the host through `view` where it can and `shell` elsewhere; both see the same catalog.
  for (const read of ['shell', 'view'] as const) {
    const original = f.socket[read].bind(f.socket)
    vi.spyOn(f.socket, read).mockImplementation(() => {
      const state = original()
      return { ...state, host: { ...state.host, models: state.host.models.map(model => model.id === f.model.id ? { ...model, runtimeModes: ['auto', 'full-access'] as const } : model) } }
    })
  }
  const projects = await f.call('list_projects', { hostId: f.pairing.hostId, includeModels: true })
  if (projects.status !== 'ok') throw new Error('list-refused')
  expect(projects.projects[0]?.workers?.find(item => item.modelId === f.model.id)).toMatchObject({ defaultPermission: null, permissionComparable: false })
  const writes = vi.spyOn(f.socket, 'watcherControl')
  expect(await f.call('start_thread', f.start())).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE', message: expect.stringContaining('does not let this computer answer') })
  expect(writes).not.toHaveBeenCalled()
})

it('keeps remote Stop all ownership while desktop room IPC is held and flushes before its own answer', async () => {
  // The window's room, put back together from the updates main sends it (#1450).
  let held: WatcherRoomHeld | null = null
  const f = await master(), sent = vi.fn<(payload: WatcherRoomState | WatcherRoomUpdate) => boolean>(payload => { held = applyWatcherRoomUpdate(held, payload as WatcherRoomUpdate); return true })
  const timers: (() => void)[] = []
  const desktop = createWatcherRoomDesktop({ watcherEnabled: true, streamingPublishCost: true, watcher: f.watcher,
    send: sent, schedule: run => { timers.push(run); return () => undefined } })!
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
  // The window holds what the operation's own answer says, from a room built when its update went (#1450).
  expect((held as WatcherRoomHeld | null)?.room).toMatchObject({ requests: ownResult.state.requests, receipts: ownResult.state.receipts,
    currentOptions: ownResult.state.currentOptions })
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
    expect(writes).not.toHaveBeenCalled(); expect(f.watcher.startsInFlight()).toBe(0)
    expect(f.watcher.state().requests[0]!.participants[0]).toMatchObject({ state: 'relinquished', promptCount: 1 })
    expect(await f.call('start_thread', input)).toMatchObject({ code: 'NOT_CURRENT_WATCHER' })
    expect(f.watcher.state().requests[0]!.participants[0]!.promptCount).toBe(1)
  } finally { gate.release(); await start }
})

it('attributes returning paired evidence to its host, queues news after user work and withdraws it on Stop', async () => {
  const f = await master(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start-refused')
  let checks: 'failed' | 'passed' = 'failed'
  // The synthetic evidence belongs to a PR the owning roster still links. The router reads the host's state through its
  // view, and some readers through its shell, so both carry the link.
  const linkedOf = (read: () => AgentState) => (): AgentState => {
    const state = read()
    return { ...state, host: { ...state.host, threads: state.host.threads.map(thread => thread.id !== first.target.threadId ? thread
      : { ...thread, pullRequests: [{ url: 'https://github.com/synthetic/project/pull/5', number: 5, title: 'Synthetic PR',
        state: 'open' as const, draft: false, source: 'linked' as const, linkedAt: new Date().toISOString() }] }) } }
  }
  // Read the originals before spying: a spy is installed before its implementation's arguments are evaluated.
  const linkedShell = linkedOf(f.socket.shell.bind(f.socket)), linkedView = linkedOf(f.socket.view.bind(f.socket))
  vi.spyOn(f.socket, 'shell').mockImplementation(linkedShell)
  vi.spyOn(f.socket, 'view').mockImplementation(linkedView)
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
    await vi.waitFor(() => expect(storedFollowups(f.control).filter(item => item.threadId === f.id).at(-1)?.wakeUp).toBe(true), { timeout: 15_000 })
    expect(storedFollowups(f.control).filter(item => item.threadId === f.id)[0]!.text).toBe('Synthetic user continuation')
    // The user's follow-up shows; Sotto's wake-up for Watcher behind it does not.
    expect(f.control.shell().followups!.filter(item => item.threadId === f.id).map(item => item.text)).toEqual(['Synthetic user continuation'])
  }
  expect(new Set(occurrences).size).toBe(3)
  expect(await f.call('stop_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target })).toMatchObject({ status: 'ok' })
  expect(await f.watcher.unwatchThread({ target: first.target })).toMatchObject({ status: 'ok' })
  checks = 'passed'; f.router.replace(f.connection)
  await vi.waitFor(() => expect(f.watcher.state().news?.some(item => item.target.threadId === first.target.threadId)).toBe(false))
  await vi.waitFor(() => expect(storedFollowups(f.control).some(item => item.threadId === f.id && item.wakeUp)).toBe(false))
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
    expect(writes).not.toHaveBeenCalled(); expect(f.watcher.startsInFlight()).toBe(0)
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
  // The start's first turn was running when the host closed, so the host resumes it with its restart note once that turn
  // ends, whenever it recorded the turn before closing (ADR-0076). That note is the host's own; the restored queue's
  // prompt must not go, so the only other prompt the thread has had is its first.
  const prompts = (await remote.native.snapshot()).threads.find(item => item.id === nativeId)!.messages.filter(item => item.role === 'user')
  expect(prompts.filter(item => !isResumeNoteText(item.text))).toHaveLength(1)
  expect(prompts.filter(item => item.text.includes('Synthetic restored machine queue'))).toEqual([])
}, 60_000)


it('keeps operation-specific restart fences when another receipt or a new operation reconnects its request', async () => {
  const workspace = await workspaceFixture(undefined, { history: true })
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { historyEnabled: () => true, watcherEnabled: true } })
  let control = f.control
  let worker = new WatcherService({ ordinaryBatch: SHORT_BATCH, directory: f.root, host: workspace.host, control, historyEnabled: () => true, workerHost: true })
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
  worker = new WatcherService({ ordinaryBatch: SHORT_BATCH, directory: f.root, host: workspace.host, control, historyEnabled: () => true, workerHost: true })
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
  { desktop: 'full-access', host: 'approval-required', answers: true, expected: 'full-access' },
  { desktop: 'approval-required', host: 'full-access', answers: true, expected: 'approval-required' },
  { desktop: 'full-access', host: 'full-access', answers: false, expected: 'approval-required' },
] as const)('starts on this computer\'s $desktop over the host\'s own $host, held to asking unless this computer may answer there ($answers)', async defaults => {
  const f = await master()
  if (defaults.answers) await allowAnswers(f, true)
  await f.control.commandShell({ type: 'configure', patch: { newThreadRuntimeMode: defaults.desktop } })
  await remote.host.service.command({ type: 'configure', patch: { newThreadRuntimeMode: defaults.host } }, desktopWindowClient())
  const first = await f.call('start_thread', f.start())
  expect(first.status, first.status === 'refused' ? first.code : undefined).toBe('ok')
  expect(first).toMatchObject({ effectiveChoices: { permission: { kind: 'runtime', mode: defaults.expected } } })
  if (first.status !== 'ok') throw new Error('start-refused')
  await expect.poll(() => f.socket.shell().host.threads.find(item => item.id === first.target.threadId)?.runtimeMode).toBe(defaults.expected)
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
  if (check === 'protection') {
    // A slim row, the default (#1191), says protected only when it is.
    const row = list.rows.find(item => item.target.hostId === started.target.hostId && item.target.threadId === twin.id)
    expect(row).toBeDefined(); expect(row?.protected).toBeFalsy()
  }
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
  expect(f.watcher.startsInFlight()).toBe(1)
  await (f.watcher as unknown as { reconcileRemote(): Promise<void> }).reconcileRemote()
  expect(f.control.watcherRecord().operations.find(item => item.id === packet!.operation.id)).toMatchObject({ deliveryState: 'failed', refusalCode: 'OPERATION_NOT_RECORDED' })
  expect(f.watcher.startsInFlight()).toBe(0)
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

it('reads a replaced Watcher’s unconfirmed start under that Watcher’s own identity (#1325)', async () => {
  const f = await master(), original = f.socket.watcherControl.bind(f.socket), read = f.socket.watcherRead.bind(f.socket)
  // The host admits the start and its reply is lost, and no read reaches the host until Watcher has been replaced.
  let packet: WatcherHostControl | undefined
  vi.spyOn(f.socket, 'watcherControl').mockImplementation(async input => { packet = input; await original(input); throw new Error('synthetic-lost-reply') })
  const reads = vi.spyOn(f.socket, 'watcherRead').mockRejectedValue(new Error('synthetic-read-held'))
  expect(await f.call('start_thread', f.start())).toMatchObject({ code: 'DELIVERY_UNCERTAIN' })
  expect(f.control.watcherRecord().operations.find(item => item.id === packet!.operation.id)!.deliveryState).toBe('uncertain')
  // Watcher's turn ends with its start unconfirmed. While the thread it started there may still be working, a provider
  // change waits: a host stops a thread only for the Watcher that started it.
  const binding = f.workspace.registry.byThread(f.id)!
  const native = f.workspace.adapters.codex.state.threads.find(thread => thread.id === binding.sessionId)!
  native.status = 'idle'; native.lastTurn = { id: randomUUID(), status: 'completed' }; f.workspace.adapters.codex.emit()
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await f.control.commandShell({ type: 'connect', provider: 'claude' })
  const claude = f.control.watcherSnapshot().models.find(item => item.providerId === 'claude' && item.ready)!
  expect(await f.watcher.open({ provider: 'claude', modelId: claude.id })).toMatchObject({ status: 'refused', code: 'THREAD_BUSY',
    message: 'A thread Watcher started on another computer is still working, and only this Watcher can stop it there. Wait for it to finish, or stop it with Stop all, then change its provider. Nothing was changed.' })
  // Its slot freed, as when that thread finishes, the move goes through with the start still unconfirmed.
  await f.control.updateWatcher(record => { record.reservations = [] })
  expect(await f.watcher.open({ provider: 'claude', modelId: claude.id })).toMatchObject({ status: 'ok', state: { current: { provider: 'claude' } } })
  expect(f.watcher.state().history.at(-1)!.target.threadId).toBe(f.id)
  // The host keeps the start under the Watcher that made it, so it is read under that one, and its receipt comes back.
  reads.mockImplementation(read)
  await (f.watcher as unknown as { reconcileRemote(): Promise<void> }).reconcileRemote()
  expect(f.control.watcherRecord().operations.find(item => item.id === packet!.operation.id)!.deliveryState).toBe('accepted')
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

it('reads a paired worker\'s outcome and reply through exact host reads, and an older host\'s as unknown', async () => {
  const f = await master()
  expect(f.router.watcherHosts().hosts()).toEqual([expect.objectContaining({ hostId: f.pairing.hostId, outcomes: true })])
  const input = f.start(), first = await f.call('start_thread', input)
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start-refused')
  const reads = vi.spyOn(f.socket, 'watcherRead')
  const operationId = first.receipt.operationId
  const read = async (id = operationId) => {
    const result = await f.call('read_operation', { operationId: id })
    if (result.status !== 'ok') throw new Error(`read-refused: ${result.code}`)
    return result
  }
  expect(await read()).toMatchObject({ outcome: 'working', reference: { target: first.target } })
  expect(reads.mock.calls.some(([request]) => request.call?.name === 'read_operation' && request.outcomes === true)).toBe(true)
  // The owning host's provider ends the turn its brief began, naming it by that brief's message.
  const native = (await remote.native.snapshot()).threads.find(item => item.title === input.title)!
  const brief = native.messages.find(message => message.role === 'user')!
  remote.native.event({ type: 'ready', threadId: native.id, text: 'Synthetic remote reply',
    activities: markTurnActivity([], { provider: 'codex', turnId: brief.id, status: 'completed' }) })
  await f.socket.command({ type: 'refresh', provider: 'codex' })
  await vi.waitFor(async () => expect(await read()).toMatchObject({ outcome: 'answered', reference: { target: first.target, turnMessageId: brief.id },
    reply: { from: 'worker', text: 'Synthetic remote reply' } }))
  // The desktop keeps the host's outcome as identities only.
  expect(f.control.watcherRecord().operations.find(item => item.id === operationId)).toMatchObject({ outcome: 'answered', turnMessageId: brief.id })
  expect(JSON.stringify(f.control.watcherRecord())).not.toContain('Synthetic remote reply')
  // A host that does not list watcher-outcomes is not asked for them, and its accepted brief reads as unknown.
  vi.spyOn(f.socket, 'supportsWatcherOutcomes', 'get').mockReturnValue(false)
  const second = await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, text: 'Synthetic second brief', delivery: 'now' })
  if (second.status !== 'ok') throw new Error(`send-refused: ${second.code}`)
  await vi.waitFor(async () => expect((await read(second.receipt.operationId)).receipt.deliveryState).toBe('accepted'))
  reads.mockClear()
  const older = await read(second.receipt.operationId)
  expect(older).toMatchObject({ outcome: 'unknown', outcomeNote: expect.stringMatching(/does not report outcomes/u) })
  expect(older.reply).toBeUndefined()
  expect(reads.mock.calls.filter(([request]) => request.call?.name === 'read_operation').every(([request]) => request.outcomes === undefined)).toBe(true)
  // Projections never carry outcomes, so a desktop from before them still reads the host.
  const projection = await f.socket.watcherRead({ master: f.watcher.state().current! }) as WatcherHostProjection
  expect(projection.operations.every(item => item.outcome === undefined && item.replyMessageId === undefined)).toBe(true)
})

it('delivers a later request’s queued prompt to a paired thread Stop all held, as soon as its turn is free (#1203)', async () => {
  const native = await codexFixture(undefined, false, 10_000); cleanups.push(native.cleanup)
  const f = await master(native.adapter), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start-refused')
  const turn = () => f.socket.shell().host.threads.find(item => item.id === first.target.threadId)?.lastTurn?.status
  await vi.waitFor(() => expect(turn()).toBe('running'))
  const codexId = (await native.driver.requests()).findLast(item => item.method === 'turn/start')!.params!.threadId as string
  const aliases = JSON.parse(await readFile(join(native.root, 'codex-threads.json'), 'utf8')) as Record<string, { codexThreadId: string }>
  const nativeId = Object.entries(aliases).find(([, value]) => value.codexThreadId === codexId)![0]
  await native.driver.completeTurn(nativeId, 'Synthetic completion')
  await vi.waitFor(() => expect(turn()).toBe('completed'))
  const confirmation = f.watcher.prepareStopAll()
  if (confirmation.status !== 'ok') throw new Error('stop-preview-refused')
  expect(await f.watcher.stopAll(confirmation.confirmationId)).toMatchObject({ status: 'ok' })
  // The user asks Watcher again. Its new request reaches the thread Stop all stopped: now while the turn is free, then a
  // queued prompt while the turn it started runs, which the owning host sends once that turn ends.
  const binding = f.workspace.registry.byThread(f.id)!, watcher = f.workspace.adapters.codex.state.threads.find(item => item.id === binding.sessionId)!
  watcher.status = 'idle'; watcher.lastTurn = { id: randomUUID(), status: 'completed' }; f.workspace.adapters.codex.emit()
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect((await f.control.commandShell({ type: 'manual-send', threadId: f.id, draftId: randomUUID(), text: 'Synthetic second master request' })).error).toBeNull()
  // The user's own request: a stop receipt read back late may fence a standing scope for this Watcher turn after it.
  const requestId = f.watcher.state().requests.filter(request => !request.standingWatchId).at(-1)!.id
  expect(requestId).not.toBe(f.requestId)
  const send = (delivery: 'now' | 'queue', text: string) => f.call('send_to_thread', { requestId, retryKey: randomUUID(), target: first.target, delivery, text })
  const now = await send('now', 'Synthetic paired now')
  expect(now, JSON.stringify(now)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  await vi.waitFor(() => expect(turn()).toBe('running'))
  expect(await send('queue', 'Synthetic paired note')).toMatchObject({ status: 'ok', receipt: { deliveryState: 'queued' } })
  const starts = async () => (await native.driver.requests()).filter(item => item.method === 'turn/start').length
  expect(await starts()).toBe(2)
  await native.driver.completeTurn(nativeId, 'Synthetic second completion')
  await vi.waitFor(async () => expect(await starts()).toBe(3), { timeout: 10_000 })
}, 60_000)

// Work across machines (#1032): the projects on both machines are copies of one GitHub repository, by their origin remotes.
const git = promisify(execFile)
async function origin(path: string, url: string): Promise<void> {
  await git('git', ['init', '-q', path])
  await git('git', ['-C', path, 'remote', 'add', 'origin', url])
}
async function acrossMachines(setting: WorkerMachineSetting = 'this-computer') {
  const choice = { setting }
  const f = await master(undefined, false, { setting: () => choice.setting })
  const local = f.control.shell().host.projects.find(item => item.providerId === 'codex')!
  await origin(local.path, 'git@github.com:millZach/Sotto.git')
  await origin(f.project.path, 'https://github.com/millZach/Sotto')
  // A start that stays on This computer names a model ready here; one placed on the paired machine names one ready there.
  const here = f.control.shell().host.models.find(item => item.providerId === 'codex' && item.ready)!
  return { ...f, local, choice, onThisComputer: () => ({ ...f.start(), project: { hostId: f.control.hostId()!, projectId: local.id } }),
    staysHere: () => ({ ...f.start(), project: { hostId: f.control.hostId()!, projectId: local.id }, modelId: here.id }),
    // `call` waits for a started thread on the paired host; a start that stays here is read as Watcher reads it.
    startHere: async (input: unknown) => watcherToolSchemas.start_thread.output.parse(await f.watcher.invoke(f.id, 'start_thread', input)) }
}
const family = ({ win32: 'windows', darwin: 'macos', linux: 'linux' } as Record<string, 'windows' | 'macos' | 'linux'>)[process.platform]!

it('starts a worker on the paired machine new workers start on, in its copy of the project, and says where in the receipt (#1032)', async () => {
  const f = await acrossMachines()
  expect(f.hello.features).toContain('project-origins')
  f.choice.setting = f.pairing.hostId
  const listed = await f.call('list_machines', {})
  expect(listed).toMatchObject({ status: 'ok', newWorkersStart: { choice: 'machine', hostId: f.pairing.hostId, name: 'Synthetic remote' } })
  const raw = vi.spyOn(f.socket as unknown as { call(request: { op: string }): Promise<unknown> }, 'call')
  const input = f.onThisComputer(), started = await f.call('start_thread', input)
  if (started.status !== 'ok' || !('target' in started)) throw new Error(`start-refused: ${started.status === 'refused' ? started.message : ''}`)
  expect(started.target.hostId).toBe(f.pairing.hostId)
  expect(started.placement).toEqual({ hostId: f.pairing.hostId, name: 'Synthetic remote', awayFromDefault: false })
  expect(f.socket.shell().host.threads.find(thread => thread.id === started.target.threadId)?.projectId).toBe(f.project.id)
  // The owning host is sent the start as it goes: its own project, and neither the machine nor the setting.
  const packet = raw.mock.calls.map(([request]) => request).find(request => request.op === 'watcher-control') as unknown as { request: { call: { input: Record<string, unknown> } } }
  raw.mockRestore()
  expect(packet.request.call.input['project']).toEqual({ hostId: f.pairing.hostId, projectId: f.project.id })
  expect(packet.request.call.input).not.toHaveProperty('machine')
  expect(packet.request.call.input).not.toHaveProperty('os')
  // A retry reads the first receipt, wherever new workers start by then.
  f.choice.setting = 'this-computer'
  expect(await f.call('start_thread', input)).toMatchObject({ status: 'ok', receipt: { operationId: started.receipt.operationId }, target: started.target })
  expect(f.socket.shell().host.threads.filter(thread => thread.title === input.title)).toHaveLength(1)
  // Back on This computer, a start in the same project stays here; one that names the paired machine goes there, away from the default.
  const here = await f.startHere({ ...f.staysHere(), title: 'Synthetic local worker' })
  expect(here).toMatchObject({ status: 'ok', target: { hostId: f.control.hostId() }, placement: { hostId: f.control.hostId(), name: 'This computer', awayFromDefault: false } })
  expect(await f.call('start_thread', { ...f.onThisComputer(), machine: f.pairing.hostId, title: 'Synthetic named worker' })).toMatchObject({ status: 'ok',
    target: { hostId: f.pairing.hostId }, placement: { hostId: f.pairing.hostId, awayFromDefault: true } })
})

it('starts on This computer and says why when the paired machine new workers start on is not connected (#1032)', async () => {
  const f = await acrossMachines()
  f.choice.setting = f.pairing.hostId
  Object.assign(f.connection, { available: () => false })
  const started = await f.startHere(f.staysHere())
  expect(started).toMatchObject({ status: 'ok', target: { hostId: f.control.hostId() }, placement: { hostId: f.control.hostId(), awayFromDefault: true,
    note: 'Synthetic remote, where new workers start, is not connected, so this one started on This computer.' } })
  // The room shows the same placement under the start's card, from memory as the receipt holds it.
  const room = f.watcher.get()
  if (room.status !== 'ok' || started.status !== 'ok' || !('receipt' in started)) throw new Error('room-unreadable')
  expect(room.state.receiptPlacements).toContainEqual({ operationId: started.receipt.operationId, placement: started.placement })
})

it('keeps a start that reuses a worktree or a base branch read here on This computer, away from the default, and says why (#1032)', async () => {
  const f = await acrossMachines()
  await initializeGitRepository(f.local.path)
  vi.spyOn(f.workspace.host, 'workingCopyOptions').mockResolvedValue({ isGit: true, currentBranch: 'main', branches: ['main'],
    worktrees: [{ path: f.local.path, branch: 'main' }] })
  f.choice.setting = f.pairing.hostId
  const choices = await f.call('list_working_copies', { project: f.staysHere().project })
  if (choices.status !== 'ok' || !('choices' in choices)) throw new Error('copy read refused')
  const worktree = { kind: 'existing-worktree', choiceId: choices.choices.find(item => item.kind === 'existing-worktree')!.choiceId }
  const base = choices.baseRefs.find(item => item.name === 'main')!.choiceId
  const placement = (note: string) => ({ hostId: f.control.hostId(), name: 'This computer', awayFromDefault: true, note })
  // Zach, October 25, 2026: these choices tie a start that names neither machine nor system to this computer.
  expect(await f.startHere({ ...f.staysHere(), title: 'Synthetic reused worktree', workingCopy: worktree })).toMatchObject({ status: 'ok',
    target: { hostId: f.control.hostId() }, placement: placement('It reuses a worktree on This computer, so it started here rather than on Synthetic remote, where new workers start.') })
  expect(await f.startHere({ ...f.staysHere(), title: 'Synthetic base branch', baseRefChoiceId: base })).toMatchObject({ status: 'ok',
    target: { hostId: f.control.hostId() }, effectiveChoices: { baseRefChoiceId: base },
    placement: placement('Its base branch was read on This computer, so it started here rather than on Synthetic remote, where new workers start.') })
  // Naming the paired machine is still refused: those choices mean nothing in its copy, and it is sent nothing.
  for (const choice of [{ workingCopy: worktree }, { baseRefChoiceId: base }]) {
    expect(await f.startHere({ ...f.staysHere(), ...choice, machine: f.pairing.hostId, title: 'Synthetic named machine' }))
      .toMatchObject({ status: 'refused', code: 'WORKING_COPY_CHANGED' })
  }
  expect(f.socket.shell().host.threads.filter(thread => ['Synthetic reused worktree', 'Synthetic base branch', 'Synthetic named machine'].includes(thread.title))).toEqual([])
})

it('refuses in plain words a machine with no copy of the project, and sends it nothing (#1032)', async () => {
  const f = await acrossMachines()
  await git('git', ['-C', f.project.path, 'remote', 'set-url', 'origin', 'https://github.com/someone/Elsewhere.git'])
  const writes = vi.spyOn(f.socket, 'watcherControl')
  const refused = await f.call('start_thread', { ...f.onThisComputer(), machine: f.pairing.hostId })
  expect(refused).toMatchObject({ status: 'refused', code: 'UNKNOWN_TARGET', message: `Synthetic remote has no copy of ${f.local.title}. Add the project on Synthetic remote first. Nothing was started.` })
  expect(writes).not.toHaveBeenCalled()
  expect(f.control.watcherRecord().operations).toHaveLength(0)
})

it('takes explicit placement on an older host that reports no facts, and says to update it for a project it cannot match (#1032)', async () => {
  const f = await acrossMachines()
  const socket = f.socket as unknown as { features: readonly string[] }
  socket.features = socket.features.filter(feature => feature !== 'host-facts' && feature !== 'project-origins')
  expect(f.router.watcherHosts().hosts()[0]).toMatchObject({ facts: false, origins: false })
  const started = await f.call('start_thread', { ...f.start(), machine: f.pairing.hostId })
  expect(started).toMatchObject({ status: 'ok', target: { hostId: f.pairing.hostId }, placement: { hostId: f.pairing.hostId, name: 'Synthetic remote' } })
  expect(await f.call('start_thread', { ...f.onThisComputer(), machine: f.pairing.hostId })).toMatchObject({ status: 'refused', code: 'HOST_FEATURE_UNAVAILABLE',
    message: 'Synthetic remote cannot say which repository its projects are copies of. Update Sotto on it, or name one of its projects from list_projects. Nothing was started.' })
  // A system named beside it cannot be checked on a host that does not say what it runs.
  expect(await f.call('start_thread', { ...f.start(), machine: f.pairing.hostId, os: family })).toMatchObject({ status: 'refused', code: 'HOST_FEATURE_UNAVAILABLE' })
})

it('starts a worker that names a system on a machine of it, and refuses one no connected machine runs without starting anything (#1032)', async () => {
  const f = await acrossMachines()
  f.choice.setting = f.pairing.hostId
  // Both machines run this system here; the machine new workers start on comes first.
  expect(await f.call('start_thread', { ...f.onThisComputer(), os: family })).toMatchObject({ status: 'ok', target: { hostId: f.pairing.hostId } })
  const other = family === 'macos' ? 'linux' : 'macos', writes = vi.spyOn(f.socket, 'watcherControl'), before = f.control.watcherRecord().operations.length
  expect(await f.call('start_thread', { ...f.onThisComputer(), os: other })).toMatchObject({ status: 'refused', code: 'HOST_DISCONNECTED',
    message: other === 'macos' ? 'No Mac is connected. Connect a Mac, or run this on This computer. Nothing was started.'
      : 'No Linux machine is connected. Connect a Linux machine, or run this on This computer. Nothing was started.' })
  expect(writes).not.toHaveBeenCalled()
  expect(f.control.watcherRecord().operations).toHaveLength(before)
})

// Starting from a thread's branch (#1033): This computer's project is a repository with a branch, and a thread works in it.
async function fromBranch() {
  const f = await acrossMachines()
  const run = async (...args: string[]) => (await git('git', ['-C', f.local.path, '-c', 'user.name=Sotto test', '-c', 'user.email=test@example.invalid', ...args])).stdout.trim()
  await writeFile(join(f.local.path, 'README.md'), '# Project\n'); await run('add', 'README.md'); await run('commit', '-q', '-m', 'Start the project')
  await run('switch', '-q', '-c', 'feat/x')
  await writeFile(join(f.local.path, 'x.txt'), 'x\n'); await run('add', 'x.txt'); await run('commit', '-q', '-m', 'Add x')
  const here = f.control.shell().host.models.find(item => item.providerId === 'codex' && item.ready)!
  const source = randomUUID()
  expect((await f.control.commandShell({ type: 'create-thread', threadId: source, projectId: f.local.id, title: 'Synthetic source', modelId: here.id, workingCopy: 'shared' })).error).toBeNull()
  return { ...f, run, commit: await run('rev-parse', 'HEAD'), fromThread: { hostId: f.control.hostId()!, threadId: source } }
}

it('starts a worker on the paired machine from a thread’s branch on This computer, in a new worktree on that branch, and says so (#1033)', async () => {
  const f = await fromBranch()
  expect(f.hello.features).toContain('branch-moves')
  const raw = vi.spyOn(f.socket as unknown as { call(request: { op: string }): Promise<unknown> }, 'call')
  const started = await f.call('start_thread', { ...f.onThisComputer(), machine: f.pairing.hostId, workingCopy: { kind: 'new-worktree' }, fromThread: f.fromThread })
  if (started.status !== 'ok' || !('target' in started)) throw new Error(`start-refused: ${started.status === 'refused' ? started.message : ''}`)
  expect(started.startedFrom).toEqual({ hostId: f.pairing.hostId, name: 'Synthetic remote', branch: 'feat/x', note: 'Started on Synthetic remote from feat/x.' })
  // The host is sent the move the start comes from, and neither the thread nor the machine it named.
  const packet = raw.mock.calls.map(([request]) => request).find(request => request.op === 'watcher-control') as unknown as { request: { call: { input: Record<string, unknown> } } }
  raw.mockRestore()
  const moveId = packet.request.call.input['fromMove'] as string
  expect(moveId).toMatch(/^[0-9a-f-]{36}$/u)
  expect(packet.request.call.input).not.toHaveProperty('fromThread')
  expect(packet.request.call.input).not.toHaveProperty('testRun')
  // The worker's worktree on the host is made from the move's incoming ref, on the branch's own name.
  await expect.poll(() => f.socket.shell().host.threads.find(thread => thread.id === started.target.threadId)?.worktree?.status, { timeout: 20_000 }).toBe('ready')
  const worktree = f.socket.shell().host.threads.find(thread => thread.id === started.target.threadId)!.worktree!
  expect(worktree).toMatchObject({ branch: 'feat/x', incomingRef: `refs/sotto/incoming/${moveId}/feat/x` })
  expect((await git('git', ['-C', worktree.path!, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(f.commit)
})

it('refuses a start from a thread with uncommitted work in the move’s words, and a test run starts from a snapshot of it (#1033)', async () => {
  const f = await fromBranch()
  await writeFile(join(f.local.path, 'x.txt'), 'edited\n'); await writeFile(join(f.local.path, 'new.txt'), 'new\n')
  const refused = await f.startHere({ ...f.staysHere(), workingCopy: { kind: 'new-worktree' }, fromThread: f.fromThread })
  expect(refused).toMatchObject({ status: 'refused', code: 'WORKING_COPY_UNAVAILABLE', message: branchMoveWords.uncommitted })
  expect(f.control.shell().host.threads.filter(thread => thread.title === 'Synthetic remote worker')).toHaveLength(0)
  expect(await f.run('for-each-ref', 'refs/sotto')).toBe('')
  const tested = await f.startHere({ ...f.staysHere(), title: 'Synthetic test run', workingCopy: { kind: 'new-worktree' }, fromThread: f.fromThread, testRun: true })
  if (tested.status !== 'ok' || !('target' in tested)) throw new Error(`start-refused: ${tested.status === 'refused' ? tested.message : ''}`)
  expect(tested.startedFrom).toEqual({ hostId: f.control.hostId(), name: 'This computer', branch: 'feat/x', snapshot: { untracked: ['new.txt'], untrackedCount: 1 },
    note: 'Started on This computer from feat/x with your uncommitted changes (1 untracked file).' })
  await expect.poll(() => f.control.shell().host.threads.find(thread => thread.id === tested.target.threadId)?.worktree?.status, { timeout: 20_000 }).toBe('ready')
  const worktree = f.control.shell().host.threads.find(thread => thread.id === tested.target.threadId)!.worktree!
  // The source thread holds feat/x, so the worker's branch takes the next name; its folder has the uncommitted work.
  expect(worktree.branch).toBe('feat/x-2')
  // As committed: this computer's own `core.autocrlf` may give a checkout CRLF on the way out.
  expect((await readFile(join(worktree.path!, 'new.txt'), 'utf8')).replace(/\r\n/gu, '\n')).toBe('new\n')
  expect((await readFile(join(worktree.path!, 'x.txt'), 'utf8')).replace(/\r\n/gu, '\n')).toBe('edited\n')
  // The source is as it was: on feat/x, its changes uncommitted, nothing stashed.
  expect(await f.run('symbolic-ref', '--short', 'HEAD')).toBe('feat/x')
  // Trimmed, so the first line's leading space is gone.
  expect(await f.run('status', '--porcelain')).toBe('M x.txt\n?? new.txt')
  expect(await f.run('stash', 'list')).toBe('')
  // Watcher never names a move itself.
  expect(await f.startHere({ ...f.staysHere(), workingCopy: { kind: 'new-worktree' }, fromMove: randomUUID() })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
})

for (const where of ['paired', 'here'] as const) {
  it(`lets go of a moved branch when its start is stopped after the branch arrived, ${where === 'paired' ? 'on the paired machine' : 'on This computer'} (#1033)`, async () => {
    const f = await fromBranch()
    // The branch arrives, then the user stops Watcher's request before the start goes.
    const move = DesktopBranchMoves.prototype.forStart
    const forStart = vi.spyOn(DesktopBranchMoves.prototype, 'forStart').mockImplementation(async function (this: DesktopBranchMoves, input) {
      const moved = await move.call(this, input)
      expect(moved.type).toBe('moved')
      await f.control.updateWatcher(record => {
        for (const request of record.requests) if (request.state === 'active') { request.state = 'stopped'; request.closedAt = new Date().toISOString() }
      })
      return moved
    })
    try {
      const started = where === 'paired'
        ? await f.call('start_thread', { ...f.onThisComputer(), machine: f.pairing.hostId, workingCopy: { kind: 'new-worktree' }, fromThread: f.fromThread })
        : await f.startHere({ ...f.staysHere(), workingCopy: { kind: 'new-worktree' }, fromThread: f.fromThread })
      expect(started).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
      expect(forStart).toHaveBeenCalledTimes(1)
      const repository = where === 'paired' ? f.project.path : f.local.path
      await expect.poll(async () => (await git('git', ['-C', repository, 'for-each-ref', 'refs/sotto'])).stdout.trim()).toBe('')
    } finally { forStart.mockRestore() }
  })
}

it('lets go of a moved branch once reconciling finds the start failed with no thread, after its answer was lost (#1033)', async () => {
  const f = await fromBranch()
  const refs = async () => (await git('git', ['-C', f.project.path, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/sotto'])).stdout.trim()
  // The branch has arrived on the paired machine. Its start there fails without making a thread, as when the ref is
  // missing as the worktree is made, and the answer never reaches this computer.
  const control = f.socket.watcherControl.bind(f.socket)
  vi.spyOn(f.socket, 'watcherControl').mockImplementationOnce(async (request, ...rest) => {
    const [ref, commit] = (await refs()).split(' ')
    await git('git', ['-C', f.project.path, 'update-ref', '-d', ref!])
    const answer = await control(request, ...rest)
    expect(answer).toMatchObject({ status: 'refused', receipt: { deliveryState: 'failed' } })
    await git('git', ['-C', f.project.path, 'update-ref', ref!, commit!])
    throw new Error('synthetic-lost-answer')
  })
  const started = await f.call('start_thread', { ...f.onThisComputer(), machine: f.pairing.hostId, workingCopy: { kind: 'new-worktree' }, fromThread: f.fromThread })
  expect(started).toMatchObject({ status: 'refused', code: 'DELIVERY_UNCERTAIN' })
  expect(await refs()).not.toBe('')
  // Reconciling reads the failed receipt and a host with no such thread: the branch is let go.
  await expect.poll(refs, { timeout: 30_000 }).toBe('')
  vi.restoreAllMocks()
}, 60_000)

it('keeps a lost start’s moved branch for the next reconcile when this computer has no host ID for a moment (#1033)', async () => {
  const f = await fromBranch()
  const refs = async () => (await git('git', ['-C', f.project.path, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/sotto'])).stdout.trim()
  const watcher = f.watcher as unknown as { madeThread: (...args: unknown[]) => boolean; lostStartMoves: Map<string, unknown>; reconcileRemote(hostId?: string): Promise<void> }
  // As the test above: the start fails on the paired machine with no thread, and its answer is lost.
  const control = f.socket.watcherControl.bind(f.socket)
  vi.spyOn(f.socket, 'watcherControl').mockImplementationOnce(async (request, ...rest) => {
    const [ref, commit] = (await refs()).split(' ')
    await git('git', ['-C', f.project.path, 'update-ref', '-d', ref!])
    await control(request, ...rest)
    await git('git', ['-C', f.project.path, 'update-ref', ref!, commit!])
    throw new Error('synthetic-lost-answer')
  })
  // While Sotto starts, this computer has no host ID, and asking whether the paired machine made the thread throws.
  const made = vi.spyOn(watcher, 'madeThread').mockImplementation(() => { throw new Error('synthetic-no-host-id') })
  try {
    const started = await f.call('start_thread', { ...f.onThisComputer(), machine: f.pairing.hostId, workingCopy: { kind: 'new-worktree' }, fromThread: f.fromThread })
    expect(started).toMatchObject({ status: 'refused', code: 'DELIVERY_UNCERTAIN' })
    await expect.poll(() => made.mock.calls.length, { timeout: 30_000 }).toBeGreaterThan(0)
    // Nothing was decided, so the branch and its entry wait.
    expect(watcher.lostStartMoves.size).toBe(1)
    expect(await refs()).not.toBe('')
    made.mockRestore()
    await watcher.reconcileRemote(f.pairing.hostId)
    await expect.poll(refs, { timeout: 30_000 }).toBe('')
    expect(watcher.lostStartMoves.size).toBe(0)
  } finally { vi.restoreAllMocks() }
}, 60_000)

it('lets go of a moved branch when the paired machine answers its start with a definite failure and no thread (#1033)', async () => {
  const f = await fromBranch()
  // The branch has arrived on the paired machine; its answer is a failed receipt for this very start, and it made no thread.
  vi.spyOn(f.socket, 'watcherControl').mockImplementationOnce(async request => {
    const { operation } = request
    return { status: 'refused', code: 'PROVIDER_UNAVAILABLE', message: 'Synthetic failure. Nothing was started.', retryable: false,
      receipt: { operationId: operation.id, target: operation.target, requestId: operation.requestId, deliveryState: 'failed', receiptId: operation.receiptId, cardId: operation.cardId } }
  })
  try {
    const started = await f.call('start_thread', { ...f.onThisComputer(), machine: f.pairing.hostId, workingCopy: { kind: 'new-worktree' }, fromThread: f.fromThread })
    expect(started).toMatchObject({ status: 'refused', code: 'PROVIDER_UNAVAILABLE', receipt: { deliveryState: 'failed' } })
    await expect.poll(async () => (await git('git', ['-C', f.project.path, 'for-each-ref', 'refs/sotto'])).stdout.trim()).toBe('')
  } finally { vi.restoreAllMocks() }
})

it('lets go of a moved branch when its permission is refused after the branch arrived, on This computer (#1033)', async () => {
  const f = await fromBranch()
  // The branch arrives, then the start's permission no longer fits, as when the user narrows New threads start with.
  const move = DesktopBranchMoves.prototype.forStart
  const watcher = f.watcher as unknown as { permission: (...args: unknown[]) => unknown }
  const forStart = vi.spyOn(DesktopBranchMoves.prototype, 'forStart').mockImplementation(async function (this: DesktopBranchMoves, input) {
    const moved = await move.call(this, input)
    expect(moved.type).toBe('moved')
    vi.spyOn(watcher, 'permission').mockImplementationOnce(() => { throw new Error('synthetic-permission-narrowed') })
    return moved
  })
  try {
    const started = await f.startHere({ ...f.staysHere(), workingCopy: { kind: 'new-worktree' }, fromThread: f.fromThread })
    expect(started).toMatchObject({ status: 'refused' })
    expect(forStart).toHaveBeenCalledTimes(1)
    await expect.poll(async () => (await git('git', ['-C', f.local.path, 'for-each-ref', 'refs/sotto'])).stdout.trim()).toBe('')
  } finally { forStart.mockRestore(); vi.restoreAllMocks() }
})

it('warns when starts the paired machine answered before its list holds them leave more than ten working there (#1032)', async () => {
  const f = await acrossMachines(), hostId = f.pairing.hostId
  // The paired machine's list as this computer holds it: nine threads working, and none of the starts below yet.
  const remoteHosts = (f.watcher as unknown as { remote: { snapshot(id: string): ReturnType<SocketHostService['shell']>['host'] | undefined } }).remote
  const real = remoteHosts.snapshot.bind(remoteHosts), shape = f.control.shell().host.threads.find(thread => thread.kind === 'watcher')!
  const nine = Array.from({ length: 9 }, (_, index) => ({ ...shape, id: `synthetic-working-${index}`, kind: undefined, status: 'running' as const, title: 'Synthetic busy thread' }))
  vi.spyOn(remoteHosts, 'snapshot').mockImplementation(id => {
    const snapshot = real(id)
    return snapshot && id === hostId ? { ...snapshot, threads: [...snapshot.threads.filter(thread => thread.title !== 'Synthetic held worker'), ...nine] } : snapshot
  })
  const held = () => ({ ...f.start(), machine: hostId, title: 'Synthetic held worker' })
  // The first start makes ten: no warning.
  const first = await f.call('start_thread', held())
  expect(first).toMatchObject({ status: 'ok', target: { hostId } })
  expect(first).not.toHaveProperty('warning')
  // The second counts the first, which the host answered but the list does not hold yet, and itself, once each: eleven.
  expect(await f.call('start_thread', held())).toMatchObject({ status: 'ok', warning: '11 threads are working on Synthetic remote. Synthetic remote may slow down.' })
})

it('counts a started worker the paired machine lists by its own turn, so one finished and kept for its background work is not working (#1032)', async () => {
  const f = await acrossMachines(), hostId = f.pairing.hostId
  const remoteHosts = (f.watcher as unknown as { remote: { snapshot(id: string): ReturnType<SocketHostService['shell']>['host'] | undefined } }).remote
  const real = remoteHosts.snapshot.bind(remoteHosts), shape = f.control.shell().host.threads.find(thread => thread.kind === 'watcher')!
  const nine = Array.from({ length: 9 }, (_, index) => ({ ...shape, id: `synthetic-working-${index}`, kind: undefined, status: 'running' as const, title: 'Synthetic busy thread' }))
  // The first worker's turn has finished on the paired machine; its background work keeps Watcher's hold on it.
  const finished = { threadId: '' }
  vi.spyOn(remoteHosts, 'snapshot').mockImplementation(id => {
    const snapshot = real(id)
    return snapshot && id === hostId ? { ...snapshot, threads: [...snapshot.threads.map(thread => thread.id === finished.threadId ? { ...thread, status: 'idle' as const,
      lastTurn: { id: 'synthetic-finished-turn', status: 'completed' as const }, backgroundWork: [{ id: randomUUID(), label: 'Synthetic background command', type: 'command' as const }] } : thread), ...nine] } : snapshot
  })
  const held = () => ({ ...f.start(), machine: hostId, title: 'Synthetic held worker' })
  const first = await f.call('start_thread', held())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('first-start-refused')
  expect(first).not.toHaveProperty('warning')
  finished.threadId = first.target.threadId
  await expect.poll(() => f.control.watcherRecord().reservations.some(item => item.target.threadId === first.target.threadId)).toBe(true)
  // Nine working and the new start make ten: the finished worker is counted by its turn, not as a start.
  const second = await f.call('start_thread', held())
  expect(second).toMatchObject({ status: 'ok', target: { hostId } })
  expect(second).not.toHaveProperty('warning')
})

it('does not count a start that never reached the paired machine among its working threads (#1032)', async () => {
  const f = await acrossMachines(), hostId = f.pairing.hostId
  const remoteHosts = (f.watcher as unknown as { remote: { snapshot(id: string): ReturnType<SocketHostService['shell']>['host'] | undefined } }).remote
  const real = remoteHosts.snapshot.bind(remoteHosts), shape = f.control.shell().host.threads.find(thread => thread.kind === 'watcher')!
  const nine = Array.from({ length: 9 }, (_, index) => ({ ...shape, id: `synthetic-working-${index}`, kind: undefined, status: 'running' as const, title: 'Synthetic busy thread' }))
  vi.spyOn(remoteHosts, 'snapshot').mockImplementation(id => {
    const snapshot = real(id)
    return snapshot && id === hostId ? { ...snapshot, threads: [...snapshot.threads, ...nine] } : snapshot
  })
  // The first start is lost on the way, before the host admits it, and its exact receipt cannot be read: it stays unconfirmed.
  vi.spyOn(f.socket, 'watcherControl').mockRejectedValueOnce(new Error('synthetic-connection-lost'))
  const reads = f.socket.watcherRead.bind(f.socket)
  vi.spyOn(f.socket, 'watcherRead').mockImplementation(async request => {
    if ((request as { call?: { name?: string } }).call?.name === 'read_operation') throw new Error('synthetic-connection-lost')
    return reads(request)
  })
  const held = () => ({ ...f.start(), machine: hostId, title: 'Synthetic held worker' })
  const lost = await f.call('start_thread', held())
  expect(lost).toMatchObject({ status: 'refused', code: 'DELIVERY_UNCERTAIN' })
  const operationId = 'receipt' in lost ? lost.receipt?.operationId : undefined
  expect(f.control.watcherRecord().operations.find(item => item.id === operationId)?.deliveryState).toBe('uncertain')
  // Nine working and the new start make ten: an unconfirmed delivery alone is not a working thread.
  const next = await f.call('start_thread', held())
  expect(next).toMatchObject({ status: 'ok', target: { hostId } })
  expect(next).not.toHaveProperty('warning')
  expect(f.control.watcherRecord().operations.find(item => item.id === operationId)?.deliveryState).toBe('uncertain')
})

it('reads the paired machine’s list once for every start it counts, rather than once per start (#1032)', async () => {
  const f = await acrossMachines(), hostId = f.pairing.hostId
  const remoteHosts = (f.watcher as unknown as { remote: { snapshot(id: string): ReturnType<SocketHostService['shell']>['host'] | undefined } }).remote
  const real = remoteHosts.snapshot.bind(remoteHosts), shape = f.control.shell().host.threads.find(thread => thread.kind === 'watcher')!
  const held = () => ({ ...f.start(), machine: hostId, title: 'Synthetic held worker' })
  const targets: WatcherThreadTarget[] = []
  for (let index = 0; index < 4; index++) {
    const started = await f.call('start_thread', held())
    if (started.status !== 'ok' || !('target' in started)) throw new Error('start-refused')
    targets.push(started.target)
  }
  // Five hundred idle threads, and none of the starts yet, every element read counted.
  const idle = Array.from({ length: 500 }, (_, index) => ({ ...shape, id: `synthetic-idle-${index}`, kind: undefined, status: 'idle' as const, title: 'Synthetic idle thread' }))
  let reads = 0
  const counted = new Proxy(idle, { get(target, property, receiver) {
    if (typeof property === 'string' && /^\d+$/u.test(property)) reads += 1
    return Reflect.get(target, property, receiver) as unknown
  } })
  vi.spyOn(remoteHosts, 'snapshot').mockImplementation(id => { const snapshot = real(id); return snapshot && id === hostId ? { ...snapshot, threads: counted } : snapshot })
  const warning = (f.watcher as unknown as { machineWorkingWarning(target: WatcherThreadTarget): object }).machineWorkingWarning(targets.at(-1)!)
  expect(warning).toEqual({})
  // One read to look the starts up and one to count: three earlier starts do not read it three more times.
  expect(reads).toBeLessThanOrEqual(2 * idle.length)
})

it('counts the new start by its own turn once the paired machine lists it, so a fast worker already finished is not working (#1032)', async () => {
  const f = await acrossMachines(), hostId = f.pairing.hostId
  const remoteHosts = (f.watcher as unknown as { remote: { snapshot(id: string): ReturnType<SocketHostService['shell']>['host'] | undefined } }).remote
  const real = remoteHosts.snapshot.bind(remoteHosts), shape = f.control.shell().host.threads.find(thread => thread.kind === 'watcher')!
  const started = await f.call('start_thread', { ...f.start(), machine: hostId, title: 'Synthetic fast worker' })
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start-refused')
  const ten = Array.from({ length: 10 }, (_, index) => ({ ...shape, id: `synthetic-working-${index}`, kind: undefined, status: 'running' as const, title: 'Synthetic busy thread' }))
  const fast = { ...shape, id: started.target.threadId, kind: undefined, title: 'Synthetic fast worker' }
  let list: AgentState['host']['threads'] = []
  vi.spyOn(remoteHosts, 'snapshot').mockImplementation(id => { const snapshot = real(id); return snapshot && id === hostId ? { ...snapshot, threads: list } : snapshot })
  const warning = () => (f.watcher as unknown as { machineWorkingWarning(target: WatcherThreadTarget): object }).machineWorkingWarning(started.target)
  // Ten working, and the new worker's turn already over before its answer came back: ten, not eleven.
  list = [...ten, { ...fast, status: 'idle', lastTurn: { id: 'synthetic-fast-turn', status: 'completed' } }]
  expect(warning()).toEqual({})
  // Still running, it is working.
  list = [...ten, { ...fast, status: 'running', lastTurn: { id: 'synthetic-fast-turn', status: 'running' } }]
  expect(warning()).toEqual({ warning: '11 threads are working on Synthetic remote. Synthetic remote may slow down.' })
  // Not listed yet, or listed before its first turn shows, it counts as starting.
  list = ten
  expect(warning()).toEqual({ warning: '11 threads are working on Synthetic remote. Synthetic remote may slow down.' })
  list = [...ten, { ...fast, status: 'idle', lastTurn: undefined, messages: [], summary: undefined }]
  expect(warning()).toEqual({ warning: '11 threads are working on Synthetic remote. Synthetic remote may slow down.' })
})

it('does not take an answer about another operation as the paired machine having made a start (#1032)', async () => {
  const f = await acrossMachines(), hostId = f.pairing.hostId
  const remoteHosts = (f.watcher as unknown as { remote: { snapshot(id: string): ReturnType<SocketHostService['shell']>['host'] | undefined } }).remote
  const real = remoteHosts.snapshot.bind(remoteHosts), shape = f.control.shell().host.threads.find(thread => thread.kind === 'watcher')!
  const nine = Array.from({ length: 9 }, (_, index) => ({ ...shape, id: `synthetic-working-${index}`, kind: undefined, status: 'running' as const, title: 'Synthetic busy thread' }))
  vi.spyOn(remoteHosts, 'snapshot').mockImplementation(id => {
    const snapshot = real(id)
    return snapshot && id === hostId ? { ...snapshot, threads: [...snapshot.threads.filter(thread => thread.title !== 'Synthetic held worker'), ...nine] } : snapshot
  })
  // The host answers the first start "ok", but its receipt names another operation.
  const control = f.socket.watcherControl.bind(f.socket)
  vi.spyOn(f.socket, 'watcherControl').mockImplementationOnce(async (...args) => {
    const answer = await control(...args) as { receipt: { operationId: string } }
    return { ...answer, receipt: { ...answer.receipt, operationId: randomUUID() } }
  })
  // Nothing of the host can be read back either: the projection would carry the host's own receipt for the start, which
  // is proof it was made, and reconciling the uncertain start reads it before the next start.
  vi.spyOn(f.socket, 'watcherRead').mockRejectedValue(new Error('synthetic-connection-lost'))
  const held = () => ({ ...f.start(), machine: hostId, title: 'Synthetic held worker' })
  const mismatched = await f.call('start_thread', held())
  expect(mismatched).toMatchObject({ status: 'refused', code: 'DELIVERY_UNCERTAIN' })
  const operationId = 'receipt' in mismatched ? mismatched.receipt?.operationId : undefined
  expect(f.control.watcherRecord().operations.find(item => item.id === operationId)?.deliveryState).toBe('uncertain')
  // Nine working and the new start make ten: an answer that was not about the first start proves nothing of it.
  const next = await f.call('start_thread', held())
  expect(next).toMatchObject({ status: 'ok', target: { hostId } })
  expect(next).not.toHaveProperty('warning')
})

it('counts a start the paired machine lists before its first prompt is confirmed, while it waits for its first turn (#1032)', async () => {
  const f = await acrossMachines(), hostId = f.pairing.hostId
  const remoteHosts = (f.watcher as unknown as { remote: { snapshot(id: string): ReturnType<SocketHostService['shell']>['host'] | undefined } }).remote
  const real = remoteHosts.snapshot.bind(remoteHosts), shape = f.control.shell().host.threads.find(thread => thread.kind === 'watcher')!
  const nine = Array.from({ length: 9 }, (_, index) => ({ ...shape, id: `synthetic-working-${index}`, kind: undefined, status: 'running' as const, title: 'Synthetic busy thread' }))
  // The machine lists a start's thread, idle with no turn yet, while its first prompt is still on its way: neither accepted nor answered.
  const waiting = () => f.control.watcherRecordView().operations.filter(item => item.action === 'start' && item.target.hostId === hostId && item.deliveryState === 'dispatching')
    .map(item => ({ ...shape, id: item.target.threadId, kind: undefined, status: 'idle' as const, lastTurn: undefined, messages: [], summary: undefined, title: 'Synthetic waiting worker' }))
  vi.spyOn(remoteHosts, 'snapshot').mockImplementation(id => {
    const snapshot = real(id)
    return snapshot && id === hostId ? { ...snapshot, threads: [...snapshot.threads.filter(thread => thread.title !== 'Synthetic held worker'), ...nine, ...waiting()] } : snapshot
  })
  const gate = deferred(), control = f.socket.watcherControl.bind(f.socket)
  let held = 0
  vi.spyOn(f.socket, 'watcherControl').mockImplementationOnce(async (...args) => { held += 1; await gate.promise; return control(...args) })
  const held1 = f.call('start_thread', { ...f.start(), machine: hostId, title: 'Synthetic held worker' })
  await vi.waitFor(() => expect(held).toBe(1))
  expect(waiting()).toHaveLength(1)
  // Nine running, the listed worker waiting for its first turn and the new start: eleven.
  expect(await f.call('start_thread', { ...f.start(), machine: hostId, title: 'Synthetic held worker' })).toMatchObject({ status: 'ok',
    warning: '11 threads are working on Synthetic remote. Synthetic remote may slow down.' })
  gate.resolve()
  expect(await held1).toMatchObject({ status: 'ok' })
})

it('refuses a machine or system while Work across machines is off, and lists no default (#1032)', async () => {
  const f = await master()
  expect(f.hello.features).not.toContain('project-origins')
  expect(await f.call('start_thread', { ...f.start(), machine: f.pairing.hostId })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect(await f.call('start_thread', { ...f.start(), os: family })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  // Nor a thread's branch to start from, or a test run (#1033).
  expect(await f.call('start_thread', { ...f.start(), workingCopy: { kind: 'new-worktree' }, fromThread: { hostId: f.pairing.hostId, threadId: 'x' } })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect(await f.call('start_thread', { ...f.start(), testRun: true })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  const listed = await f.call('list_machines', {})
  expect(listed).not.toHaveProperty('newWorkersStart')
  expect(await f.call('start_thread', f.start())).not.toHaveProperty('placement')
  const room = f.watcher.get()
  expect(room.status === 'ok' && room.state.receiptPlacements).toBeFalsy()
})

it('refuses a start that names a move on a Stable host, even from a desktop that sends one (#1033)', async () => {
  const f = await master()
  // A desktop that puts a move in the start it sends, with the digest made to match, as only Owl's Watcher would.
  const control = f.socket.watcherControl.bind(f.socket)
  vi.spyOn(f.socket, 'watcherControl').mockImplementation(async (request, ...rest) => {
    if (request.call.name !== 'start_thread') return control(request, ...rest)
    const input = watcherToolSchemas.start_thread.input.parse({ ...request.call.input, workingCopy: { kind: 'new-worktree' }, fromMove: randomUUID() })
    const operation = { ...request.operation, digest: createHash('sha256').update(JSON.stringify(['start_thread', input])).digest('hex') }
    return control({ ...request, operation, call: { name: 'start_thread', input } } as WatcherHostControl, ...rest)
  })
  const started = await f.call('start_thread', { ...f.start(), title: 'Synthetic moved start' })
  expect(started).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect(f.socket.shell().host.threads.some(thread => thread.title === 'Synthetic moved start')).toBe(false)
})
