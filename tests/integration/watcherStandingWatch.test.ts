// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { deferred } from '../fixtures/deferred'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { watcherToolSchemas, type WatcherToolName, type WatcherToolOutput } from '../../src/shared/watcher'
import type { WatcherHostControl, WatcherHostProjection, WatcherRemoteHosts } from '../../src/shared/watcherHost'
import type { AgentControl } from '../../src/main/agents/control'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(workerHost = false, open = true) {
  const workspace = await workspaceFixture()
  cleanups.push(workspace.remove)
  workspace.adapters.codex.state.capabilities.steer = true
  workspace.adapters.codex.state.models[0]!.runtimeModes = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, historyEnabled: () => true } })
  let control: AgentControl = f.control
  const makeService = () => new WatcherService({ directory: f.root, host: workspace.host, control, historyEnabled: () => true, limit: () => 1, workerHost })
  let service = makeService()
  let toolServer = new WatcherToolServer(service)
  workspace.host.useWatcherTools(toolServer)
  cleanups.push(async () => { service.close(); await toolServer.close(); await f.dispose(); await control.closed(); await workspace.stop() })
  await control.start(); await control.commandShell({ type: 'connect', provider: 'codex' }); await service.recover()
  const model = control.watcherSnapshot().models.find(item => item.providerId === 'codex')!
  const project = control.watcherSnapshot().projects.find(item => item.providerId === 'codex')!
  if (!workerHost && open) { const opened = await service.open({ provider: 'codex', modelId: model.id }); expect(opened, JSON.stringify(opened)).toMatchObject({ status: 'ok' }) }
  const watcherId = () => service.state().current!.target.threadId
  const call = async <N extends WatcherToolName>(name: N, input: unknown) => watcherToolSchemas[name].output.parse(await service.invoke(watcherId(), name, input)) as WatcherToolOutput<N>
  const create = async () => {
    const threadId = randomUUID()
    expect((await control.commandShell({ type: 'create-thread', threadId, projectId: project.id, modelId: model.id,
      title: 'Synthetic existing worker', runtimeMode: 'approval-required', workingCopy: 'shared' })).error).toBeNull()
    return { hostId: control.hostId()!, threadId }
  }
  const native = (threadId: string) => workspace.adapters.codex.state.threads.find(thread => thread.id === workspace.registry.byThread(threadId)!.sessionId)!
  const finish = async (threadId: string) => {
    const thread = native(threadId); thread.status = 'idle'; thread.lastTurn = { id: thread.lastTurn?.id ?? randomUUID(), status: 'completed' }
    workspace.adapters.codex.emit(); await control.commandShell({ type: 'refresh', provider: 'codex' })
  }
  return { f, workspace, model, project, call, create, native, finish, watcherId,
    get control() { return control }, get service() { return service },
    restart: async () => {
      service.close(); await toolServer.close(); control.dispose(); await control.closed()
      control = f.create(); service = makeService(); toolServer = new WatcherToolServer(service); workspace.host.useWatcherTools(toolServer)
      await control.start(); await control.commandShell({ type: 'connect', provider: 'codex' }); await service.recover()
    },
    request: async () => {
      expect((await control.commandShell({ type: 'manual-send', threadId: watcherId(), draftId: randomUUID(), text: 'Synthetic coordination request' })).error).toBeNull()
      return service.state().requests.at(-1)!.id
    },
  }
}

it('watches without sending, survives request closure and process-state restart, and withdraws all news', async () => {
  const f = await fixture(), target = await f.create(), requestId = await f.request()
  await f.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text: 'Synthetic existing turn' })
  await f.finish(target.threadId)
  const before = f.workspace.adapters.codex.commands.filter(command => command.type === 'send').length
  const watched = await f.call('watch_thread', { target })
  expect(watched.status).toBe('ok')
  expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'send')).toHaveLength(before)
  await f.finish(f.watcherId())
  expect(f.service.state().requests.find(request => request.id === requestId)?.state).toBe('closed')
  const watch = f.service.state().standingWatches![0]!
  await f.restart()
  expect(f.service.state().standingWatches).toEqual([watch])
  const native = f.native(target.threadId)
  native.requests = [{ id: 'synthetic-card', kind: 'question', text: 'Synthetic question', options: [] }]
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  const news = f.service.state().news!.find(event => event.kind === 'needs-user')!
  expect(news).toMatchObject({ requestId: watch.id, target })
  expect(f.service.wakeDue(news)).toBe(true)
  expect(await f.call('unwatch_thread', { target })).toMatchObject({ status: 'ok', watched: false })
  expect(f.service.wakeDue(news)).toBe(false)
  expect(f.service.state().news).toEqual([])
  expect(f.service.state().watchedThreads.find(row => row.target.threadId === target.threadId)?.watched).not.toBe(true)
})

it('has no watched-count cap, keeps starts capped, and lets standing sends bypass start capacity', async () => {
  const f = await fixture(), requestId = await f.request()
  for (let index = 0; index < 10; index++) expect(await f.service.watchThread({ target: await f.create() })).toMatchObject({ status: 'ok' })
  expect(f.service.state().standingWatches).toHaveLength(10)
  expect(f.service.state().inFlight).toBe(0)
  const start = () => ({ requestId, retryKey: randomUUID(), project: { hostId: f.control.hostId()!, projectId: f.project.id },
    modelId: f.model.id, title: 'Synthetic started worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic work' })
  expect(await f.call('start_thread', start())).toMatchObject({ status: 'ok' })
  expect(await f.call('start_thread', start())).toMatchObject({ status: 'refused', code: 'IN_FLIGHT_LIMIT' })
  const watch = f.service.state().standingWatches![0]!
  expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target: watch.target, text: 'Synthetic continuation', delivery: 'now' }))
    .toMatchObject({ status: 'ok', limits: { inFlight: 1 } })
})

it('bounds standing prompts by Watcher turn, retains retries across turns, and never revives a stopped scope', async () => {
  const f = await fixture(), target = await f.create()
  await f.service.watchThread({ target })
  const watch = f.service.state().standingWatches![0]!
  const first = { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic first continuation', delivery: 'now' }
  const receipt = await f.call('send_to_thread', first)
  expect(receipt).toMatchObject({ status: 'ok', limits: { promptCount: 1 } })
  await f.finish(target.threadId)
  for (let count = 2; count <= 4; count++) {
    expect(await f.call('send_to_thread', { ...first, retryKey: randomUUID() })).toMatchObject({ status: 'ok', limits: { promptCount: count } })
    await f.finish(target.threadId)
  }
  expect(await f.call('send_to_thread', { ...first, retryKey: randomUUID() })).toMatchObject({ code: 'PROMPT_LIMIT' })
  const scope = f.service.state().requests.find(request => request.standingWatchId === watch.id)!
  await f.control.updateWatcher(record => { const request = record.requests.find(item => item.id === scope.id)!; request.state = 'stopped'; request.closedAt = new Date().toISOString() })
  expect(await f.call('send_to_thread', { ...first, retryKey: randomUUID() })).toMatchObject({ code: 'REQUEST_NOT_ACTIVE' })
  await f.request()
  expect(await f.call('send_to_thread', first)).toMatchObject({ receipt: receipt.status === 'ok' ? receipt.receipt : undefined })
  const renewed = await f.call('send_to_thread', { ...first, retryKey: randomUUID() })
  expect(renewed, JSON.stringify(renewed)).toMatchObject({ status: 'ok', limits: { promptCount: 1 } })
  expect(f.service.state().requests.find(request => request.id === scope.id)?.state).toBe('stopped')
})

it.each(['desktop', 'native'] as const)('keeps watching through a %s user turn and blocks now, queue and steer through restart', async origin => {
  const f = await fixture(), target = await f.create()
  await f.service.watchThread({ target })
  const watch = f.service.state().standingWatches![0]!
  const automatic = { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic automatic prompt', delivery: 'now' }
  expect(await f.call('send_to_thread', automatic)).toMatchObject({ status: 'ok' })
  expect(await f.call('send_to_thread', { ...automatic, retryKey: randomUUID(), delivery: 'queue' })).toMatchObject({ status: 'ok', receipt: { deliveryState: 'queued' } })
  if (origin === 'desktop') expect((await f.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text: 'Synthetic direct user prompt' })).error).toBeNull()
  else {
    const native = f.native(target.threadId)
    native.messages.push({ id: randomUUID(), role: 'user', text: 'Synthetic native user prompt', createdAt: new Date().toISOString() })
    native.status = 'running'; native.lastTurn = { id: randomUUID(), status: 'running' }
    f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  }
  await f.restart()
  expect(f.service.state().standingWatches).toHaveLength(1)
  expect(f.service.state().watchedThreads.find(row => row.target.threadId === target.threadId)).toMatchObject({ watched: true, paused: true })
  for (const delivery of ['now', 'queue', 'steer']) expect(await f.call('send_to_thread', { ...automatic, retryKey: randomUUID(), delivery, expectedTurnId: f.native(target.threadId).lastTurn?.id }))
    .toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
  const machineDrafts = new Set(f.control.watcherRecord().operations.filter(operation => operation.target.threadId === target.threadId).map(operation => operation.draftId))
  expect(f.control.shell().followups?.some(item => machineDrafts.has(item.draftId) && item.threadId === target.threadId)).toBe(false)
  await f.finish(target.threadId)
  if (origin === 'desktop') { await expect.poll(() => f.native(target.threadId).messages.at(-1)?.text).toBe('Synthetic direct user prompt'); await f.finish(target.threadId) }
  expect(f.service.state().watchedThreads.find(row => row.target.threadId === target.threadId)?.paused).toBe(false)
  await f.request()
  expect(await f.call('send_to_thread', { ...automatic, retryKey: randomUUID() })).toMatchObject({ status: 'ok' })
})

it('persists the remembered permission before first creation and permits widening and narrowing', async () => {
  const f = await fixture(false, false)
  expect(await f.service.setPermission({ runtimeMode: 'full-access' })).toMatchObject({ status: 'ok', state: { current: null, runtimeMode: 'full-access' } })
  expect(await f.service.open({ provider: 'codex', modelId: f.model.id })).toMatchObject({ status: 'ok', state: { currentOptions: { runtimeMode: 'full-access' } } })
  for (const runtimeMode of ['auto-accept-edits', 'auto', 'full-access', 'approval-required'] as const) {
    expect(await f.service.setPermission({ runtimeMode })).toMatchObject({ status: 'ok', state: { runtimeMode, currentOptions: { runtimeMode } } })
  }
  await f.service.setPermission({ runtimeMode: 'full-access' }); await f.restart()
  expect(f.service.state()).toMatchObject({ runtimeMode: 'full-access', currentOptions: { runtimeMode: 'full-access' } })
  const record = JSON.parse(await readFile(join(f.f.root, 'agents.json'), 'utf8')) as { watcher: { lastRuntimeMode: string } }
  expect(record.watcher.lastRuntimeMode).toBe('full-access')
})

it('keeps Stop bounded within the current Watcher turn while retaining the standing watch', async () => {
  const f = await fixture(), requestId = await f.request()
  const started = await f.call('start_thread', { requestId, retryKey: randomUUID(), project: { hostId: f.control.hostId()!, projectId: f.project.id },
    modelId: f.model.id, title: 'Synthetic stoppable worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic worker turn' })
  if (started.status !== 'ok') throw new Error('Synthetic start refused')
  const watch = f.service.state().standingWatches![0]!
  expect(await f.call('stop_thread', { requestId, retryKey: randomUUID(), target: started.target })).toMatchObject({ status: 'ok' })
  await f.finish(started.target.threadId)
  expect(f.service.state().standingWatches).toHaveLength(1)
  expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target: started.target, text: 'Synthetic forbidden same-turn restart', delivery: 'now' }))
    .toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
})

it('syncs watches to the owning host, persists takeover there and refuses withdrawn or old-host identities', async () => {
  const master = await fixture(), worker = await fixture(true), target = await worker.create()
  const clientId = randomUUID()
  let standingWatch = true
  let admitted: WatcherHostControl | undefined
  const remote: WatcherRemoteHosts = {
    hosts: () => [{ hostId: target.hostId, connected: true, reads: true, control: true, standingWatch, permissionCeiling: 'approval-required' }],
    snapshot: () => worker.control.watcherSnapshot(),
    read: (_hostId, request) => worker.service.readRemote(request, clientId, () => undefined),
    control: (_hostId, request) => { admitted = request; return worker.service.admitRemote(request, clientId, () => undefined) },
    subscribe: listener => worker.control.subscribe(() => listener(target.hostId)),
  }
  master.service.useRemoteHosts(remote)
  expect(await master.service.watchThread({ target })).toMatchObject({ status: 'ok' })
  const watch = master.service.state().standingWatches![0]!, identity = master.service.state().current!
  expect(worker.control.watcherRecord().watches).toMatchObject([{ id: watch.id, target, remoteOrigin: { clientId } }])
  const projected = worker.service.remoteProjection(identity, clientId)
  expect(projected.progress).toHaveLength(1)
  const input = { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic paired continuation', delivery: 'now' }
  expect(await master.call('send_to_thread', input)).toMatchObject({ status: 'ok' })
  expect((await worker.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text: 'Synthetic owning-host user prompt' })).error).toBeNull()
  await worker.restart()
  expect(worker.control.watcherRecord().watches![0]!.pausedByUserMessageId).toBeTruthy()
  for (const delivery of ['now', 'queue', 'steer']) expect(await master.call('send_to_thread', { ...input, retryKey: randomUUID(), delivery }))
    .toMatchObject({ code: 'THREAD_TAKEN_OVER' })
  await worker.finish(target.threadId)
  await expect.poll(() => worker.native(target.threadId).messages.at(-1)?.text).toBe('Synthetic owning-host user prompt')
  await worker.finish(target.threadId)
  // A refresh adopts the owning-host fence before a fresh automation scope is admitted.
  const projection = await remote.read(target.hostId, { master: identity }) as WatcherHostProjection
  expect(projection.standingWatches![0]).toMatchObject({ pausedByUserMessageId: null })
  await master.service.watchThread({ target })
  await master.request()
  expect(await master.call('send_to_thread', { ...input, retryKey: randomUUID() })).toMatchObject({ status: 'ok' })
  await master.service.unwatchThread({ target })
  expect(worker.control.watcherRecord().watches).toEqual([])
  expect(await worker.service.readRemote({ master: identity, standingWatches: [watch] }, clientId, () => undefined)).toMatchObject({ code: 'REQUEST_NOT_ACTIVE' })
  standingWatch = false
  expect(await master.service.watchThread({ target })).toMatchObject({ code: 'HOST_FEATURE_UNAVAILABLE' })
  standingWatch = true
  await master.service.watchThread({ target })
  const freshWatch = master.service.state().standingWatches![0]!
  const replacement = { ...identity, target: { ...identity.target, threadId: randomUUID() }, creationOperationId: randomUUID(),
    createdAt: new Date(Date.parse(identity.createdAt) + 1_000).toISOString() }
  expect(await worker.service.readRemote({ master: replacement, standingWatches: [freshWatch] }, clientId, () => undefined))
    .toMatchObject({ standingWatches: [{ id: freshWatch.id, remoteOrigin: { masterCreationOperationId: replacement.creationOperationId } }] })
  for (const standingWatches of [[freshWatch], []]) expect(await worker.service.readRemote({ master: identity, standingWatches }, clientId, () => undefined))
    .toMatchObject({ status: 'refused', code: 'NOT_CURRENT_WATCHER' })
  expect(await worker.service.admitRemote(admitted!, clientId, () => undefined)).toMatchObject({ status: 'refused', code: 'NOT_CURRENT_WATCHER' })
  const emptyReplacement = { ...replacement, target: { ...replacement.target, threadId: randomUUID() }, creationOperationId: randomUUID(),
    createdAt: new Date(Date.parse(replacement.createdAt) + 1_000).toISOString() }
  expect(await worker.service.readRemote({ master: emptyReplacement, standingWatches: [] }, clientId, () => undefined)).toMatchObject({ standingWatches: [] })
  await worker.restart()
  expect(await worker.service.readRemote({ master: replacement, standingWatches: [{ ...freshWatch, id: randomUUID() }] }, clientId, () => undefined))
    .toMatchObject({ status: 'refused', code: 'NOT_CURRENT_WATCHER' })
})

it('rechecks connection guards at management mutations and lets unwatch beat an unfinished owning-host assignment', async () => {
  const master = await fixture(), worker = await fixture(true), target = await master.create()
  const before = master.service.state().runtimeMode
  const guard = () => { throw new Error('Synthetic disconnected phone') }
  expect(await master.service.setPermission({ runtimeMode: 'full-access' }, guard)).toMatchObject({ status: 'refused' })
  expect(await master.service.watchThread({ target }, guard)).toMatchObject({ status: 'refused' })
  expect(master.service.state().runtimeMode).toBe(before)
  expect(master.service.state().standingWatches).toEqual([])
  await master.service.watchThread({ target })
  expect(await master.service.unwatchThread({ target }, guard)).toMatchObject({ status: 'refused' })
  expect(master.service.state().standingWatches).toHaveLength(1)

  const pairedTarget = await worker.create(), clientId = randomUUID(), entered = deferred<void>(), release = deferred<void>()
  let pause = true
  const remote: WatcherRemoteHosts = {
    hosts: () => [{ hostId: pairedTarget.hostId, connected: true, reads: true, control: true, standingWatch: true, permissionCeiling: 'approval-required' }],
    snapshot: () => worker.control.watcherSnapshot(),
    control: (_hostId, request) => worker.service.admitRemote(request, clientId, () => undefined),
    read: async (_hostId, request) => {
      const result = await worker.service.readRemote(request, clientId, () => undefined)
      if (pause && request.standingWatches?.length) { pause = false; entered.resolve(); await release.promise }
      return result
    },
    subscribe: () => () => undefined,
  }
  master.service.useRemoteHosts(remote)
  const assigning = master.service.watchThread({ target: pairedTarget })
  await entered.promise
  expect(master.service.state().standingWatches?.some(watch => watch.target.hostId === pairedTarget.hostId)).toBe(false)
  expect(await master.service.unwatchThread({ target: pairedTarget })).toMatchObject({ status: 'ok' })
  release.resolve()
  expect(await assigning).toMatchObject({ status: 'refused', code: 'TARGET_CHANGED' })
  expect(worker.control.watcherRecord().watches).toEqual([])
  expect(master.service.state().standingWatches?.some(watch => watch.target.hostId === pairedTarget.hostId)).toBe(false)
})
