// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { SocketHostService } from '../../../src/main/agents/socketHostService'
import { immutableModels, isImmutableModels } from '../../../src/main/agents/activitySnapshots'
import { clientUpdateEnumerationUsesMuse, commandUsesMuse, modelsWithoutMuse } from '../../../src/main/agents/museGate'
import { desktopWindowClient } from '../../../src/main/agents/hostService'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { publicProviderEntityId, type AgentCommand, type AgentState, type ProviderClientUpdate } from '../../../src/shared/agents'
import type { HostRequest } from '../../../src/shared/hostProtocol'
import { watcherHostControlSchema, watcherHostReadSchema, type WatcherHostControl, type WatcherHostRead, type WatcherHostProjection } from '../../../src/shared/watcherHost'
import { watcherToolSchemas } from '../../../src/shared/watcher'
import { centerHostId, centerTime, watcherRecordFixture, watcherToolFixtures } from '../../fixtures/watcher'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const record = watcherRecordFixture(), master = record.current!
const { id, watcher, rootUserMessageId, createdAt } = record.requests[0]!
const request = { id, watcher, rootUserMessageId, createdAt }, operation = record.operations[0]!
const museModel = publicProviderEntityId('muse', 'model', 'scoped-model')
const museProject = publicProviderEntityId('muse', 'project', 'scoped-project')
type Call = NonNullable<WatcherHostRead['call']> | WatcherHostControl['call']
function read(name: NonNullable<WatcherHostRead['call']>['name'], input: unknown): WatcherHostRead {
  return watcherHostReadSchema.parse({ master, call: { name, input } })
}
function control(name: WatcherHostControl['call']['name'], input: unknown): WatcherHostControl {
  return watcherHostControlSchema.parse({ master, request, ceiling: 'approval-required', operation, call: { name, input } })
}
const start = (modelId = 'model', projectId = 'project') => control('start_thread', { ...watcherToolFixtures.start_thread.input as object,
  modelId, project: { hostId: centerHostId, projectId } })
const target = { hostId: centerHostId, threadId: 'muse-worker' }
const refusal = { status: 'refused', code: 'PROVIDER_UNAVAILABLE', retryable: false,
  message: 'Muse is available in Sotto Owl. Open an Owl build to continue. Nothing was sent.' }

function fixture(boundary: 'router' | 'socket', museEnabled = false, mixed = true) {
  const state = emptyDesktopState(centerHostId)
  state.host.connected = true
  state.host.models = [{ id: 'model', providerId: 'codex', provider: 'Codex', name: 'Ordinary', ready: true },
    { id: 'native-model', providerId: 'muse', provider: 'Muse', name: 'Muse', ready: true },
    { id: museModel, providerId: 'muse', provider: 'Muse', name: 'Scoped Muse', ready: true }]
  state.host.projects = [{ id: 'project', providerId: 'codex', title: 'Ordinary', path: '/ordinary' },
    { id: 'shared', title: 'Shared', path: '/shared' },
    { id: 'native-project', providerId: 'muse', title: 'Muse', path: '/muse' },
    { id: museProject, providerId: 'muse', title: 'Scoped Muse', path: '/scoped' }]
  state.host.threads = [{ id: 'worker', providerId: 'codex', projectId: 'project', modelId: 'model', title: 'Ordinary', status: 'idle', messages: [], requests: [] },
    { id: target.threadId, providerId: 'muse', projectId: 'shared', modelId: 'native-model', title: 'Muse', status: 'idle', messages: [], requests: [] }]
  if (!mixed) {
    state.host.models = state.host.models.slice(0, 1)
    state.host.projects = state.host.projects.slice(0, 1)
    state.host.threads = state.host.threads.slice(0, 1)
  }
  const projection: WatcherHostProjection = { hostId: centerHostId, master, revision: 'retained', observedAt: centerTime,
    requests: record.requests, operations: [{ ...operation, target }], evidence: [] }
  const calls: (WatcherHostRead | WatcherHostControl)[] = []
  const wireFrames: HostRequest[] = []
  const results = new Map<Call['name'], unknown>()
  const setResponse = (name: Call['name'], result: unknown) => { results.set(name, result) }
  const response = (call: Call | undefined) => call ? structuredClone(results.get(call.name) ?? watcherToolFixtures[call.name].output) : structuredClone(projection)
  let guard: (() => void) | undefined
  if (boundary === 'router') {
    let shellListener: ((value: AgentState) => void) | undefined
    const command = vi.fn(async (_input: AgentCommand) => { void _input; return state })
    const connection: DesktopHostConnection = { hostId: centerHostId, kind: 'remote', name: 'Paired Owl', detail: () => null, preview: () => null,
      offersClientUpdates: () => true,
      service: { shell: () => state, subscribe: listener => { shellListener = listener; return () => { shellListener = undefined } }, command, supportsWatcherReads: true, supportsWatcherControl: true,
        cachedWatcherProjection: () => projection,
        watcherRead: async value => { calls.push(value); return response(value.call) },
        watcherControl: async (value, _client, dispatchGuard) => { void _client; guard = dispatchGuard; calls.push(value); return response(value.call) } } }
    const router = new DesktopHostRouter(emptyDesktopState, { watcherEnabled: true, museEnabled })
    router.add(connection); cleanup.push(() => router.dispose())
    const remote = router.watcherHosts()
    return { state, calls, wireFrames, client: undefined, projection, setResponse, snapshot: () => remote.snapshot(centerHostId), cachedProjection: () => remote.projection!(centerHostId, master),
      execute: (input: AgentCommand) => router.command(input, desktopWindowClient()), command,
      read: (value: WatcherHostRead) => remote.read(centerHostId, value), control: (value: WatcherHostControl) => remote.control(centerHostId, value),
      publish: () => shellListener?.(state), dispatchGuard: () => guard!() }
  }
  const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'synthetic', expectedHostId: centerHostId,
    watcherEnabled: true, museEnabled, catchUpEvents: false })
  const internal = client as unknown as { receive(text: string): void; publish(value: typeof state): void }
  Object.assign(client, { features: ['watcher-reads', 'watcher-control'], cachedWatcher: projection,
    frames: { close: () => undefined, send: (frame: HostRequest) => {
      wireFrames.push(frame)
      let result: unknown
      if (frame.op === 'watcher-read' || frame.op === 'watcher-control') { calls.push(frame.request); result = response(frame.request.call) }
      else if (frame.op === 'command') result = state
      else if (frame.op === 'detail') result = null
      else throw new Error('Unexpected operation')
      queueMicrotask(() => internal.receive(JSON.stringify({ v: 1, id: frame.id, ok: true, result })))
      return true
    } }, session: { session: 'synthetic', hostId: centerHostId } })
  internal.publish(state); cleanup.push(() => client.close())
  return { state, calls, wireFrames, client, projection, setResponse, snapshot: () => client.shell().host, cachedProjection: () => client.cachedWatcherProjection(master),
    execute: (input: AgentCommand) => client.command(input), command: undefined,
    read: (value: WatcherHostRead) => client.watcherRead(value), control: (value: WatcherHostControl) => client.watcherControl(value),
    publish: () => internal.publish(state), dispatchGuard: () => undefined }
}

const blocked = [
  ...['native-model', museModel, 'scoped-model'].map(id => ({ name: `start with model ${id}`, value: start(id) })),
  ...['native-project', museProject, 'scoped-project'].map(id => ({ name: `start in project ${id}`, value: start('model', id) })),
  { name: 'read Muse history', value: read('read_thread', { target }) },
  ...(['send_to_thread', 'stop_thread', 'settle_thread'] as const).map(name => ({ name, value: control(name,
    { ...watcherToolFixtures[name].input as object, target }) })),
  ...['native-project', museProject, 'scoped-project'].map(projectId => ({ name: `working copies ${projectId}`,
    value: read('list_working_copies', { project: { hostId: centerHostId, projectId } }) })),
  { name: 'mixed thread catalog', value: read('list_threads', { hostId: centerHostId, cursor: 'retained:1', limit: 1 }) },
  { name: 'mixed project thread catalog', value: read('list_threads', { project: { hostId: centerHostId, projectId: 'shared' } }) },
  { name: 'Muse project thread catalog alias', value: read('list_threads', { project: { hostId: centerHostId, projectId: 'scoped-project' } }) },
  { name: 'mixed project and model catalog', value: read('list_projects', { hostId: centerHostId, cursor: 'retained:1', limit: 1 }) },
]
for (const boundary of ['router', 'socket'] as const) {
  it.each(blocked)(`refuses ${boundary} $name with Muse held before dispatch`, async ({ value }) => {
    const f = fixture(boundary), before = structuredClone(f.state)
    const result = 'operation' in value ? await f.control(value) : await f.read(value)
    expect(result).toEqual(refusal)
    expect(f.calls).toEqual([])
    expect(f.state).toEqual(before)
  })
  it(`keeps ${boundary} text-free reconciliation and exact operation reads whole with Muse held`, async () => {
    const f = fixture(boundary), before = structuredClone(f.projection)
    expect(f.cachedProjection()).toEqual(before)
    expect(await f.read({ master, stoppedRequests: [{ request, ceiling: 'approval-required' }] })).toEqual(before)
    const value = read('read_operation', watcherToolFixtures.read_operation.input)
    expect(await f.read(value)).toEqual(watcherToolFixtures.read_operation.output)
    expect(f.calls).toHaveLength(2)
    expect(f.projection).toEqual(before)
  })
  it(`keeps ${boundary} ordinary Codex reads and controls available on a mixed host`, async () => {
    const f = fixture(boundary)
    for (const name of ['read_thread', 'list_working_copies', 'list_threads'] as const) {
      const input = name === 'list_threads' ? { project: { hostId: centerHostId, projectId: 'project' } } : watcherToolFixtures[name].input
      expect(await f.read(read(name, input))).toEqual(watcherToolFixtures[name].output)
    }
    for (const name of ['start_thread', 'send_to_thread', 'stop_thread', 'settle_thread'] as const) {
      expect(await f.control(control(name, watcherToolFixtures[name].input))).toEqual(watcherToolFixtures[name].output)
    }
    expect(f.calls).toHaveLength(7)
  })
  it(`preserves ${boundary} ordinary catalog counts and next cursors without Muse`, async () => {
    const f = fixture(boundary, false, false)
    for (const name of ['list_threads', 'list_projects'] as const) {
      const page = watcherToolSchemas[name].output.parse({ ...watcherToolFixtures[name].output as object, nextCursor: 'held-page:1' })
      f.setResponse(name, page)
      const value = read(name, { hostId: centerHostId, cursor: 'held-page:0', limit: 1 })
      expect(await f.read(value)).toEqual(page)
      expect(f.calls.at(-1)).toEqual(value)
    }
    expect(f.calls).toHaveLength(2)
  })
  it(`keeps ${boundary} a qualified Codex project separate from a Muse project's native short ID`, async () => {
    const f = fixture(boundary), projectId = publicProviderEntityId('codex', 'project', 'shared')
    f.state.host.projects.push({ id: projectId, providerId: 'codex', title: 'Codex shared', path: '/codex-shared' })
    f.state.host.threads[0]!.projectId = projectId; f.publish()
    const page = watcherToolSchemas.list_threads.output.parse(watcherToolFixtures.list_threads.output)
    if (page.status !== 'ok') throw new Error('Expected synthetic page')
    page.rows[0]!.projectId = projectId; page.nextCursor = 'scoped-page:1'
    f.setResponse('list_threads', page)
    const value = read('list_threads', { project: { hostId: centerHostId, projectId }, cursor: 'scoped-page:0', limit: 1 })
    expect(await f.read(value)).toEqual(page)
    expect(f.calls).toEqual([value])
  })
  it(`passes ${boundary} Muse-enabled calls and complete paged catalogs unchanged`, async () => {
    const f = fixture(boundary, true)
    for (const value of blocked.map(item => item.value)) {
      const result = 'operation' in value ? await f.control(value) : await f.read(value)
      expect(result).toEqual(watcherToolFixtures[value.call!.name].output)
    }
    expect(f.calls).toHaveLength(blocked.length)
    expect(f.state.host.threads.map(item => item.id)).toEqual(['worker', 'muse-worker'])
  })
  it(`retains ${boundary} known Muse ownership when a later shell omits the thread`, async () => {
    const f = fixture(boundary)
    f.state.host.threads = f.state.host.threads.filter(item => item.id !== target.threadId); f.publish()
    expect(await f.read(read('read_thread', { target }))).toEqual(refusal)
    expect(f.calls).toEqual([])
  })
}
it('omits Muse from the Watcher snapshot without changing the paired raw shell', () => {
  const f = fixture('router'), before = structuredClone(f.state)
  const snapshot = f.snapshot()!
  expect(snapshot.threads.map(item => item.id)).toEqual(['worker'])
  expect(snapshot.models.map(item => item.id)).toEqual(['model'])
  expect(snapshot.projects.map(item => item.id)).toEqual(['project', 'shared'])
  expect(f.state).toEqual(before)
})
it('omits a label-only Muse model from the Watcher snapshot without changing its raw catalog', () => {
  const f = fixture('router')
  delete f.state.host.models[1]!.providerId
  const before = structuredClone(f.state)
  expect(f.snapshot()!.models.map(item => item.id)).toEqual(['model'])
  expect(f.state).toEqual(before)
})
it('preserves certified catalog sharing when hiding a label-only Muse model', () => {
  const catalog = immutableModels([{ id: 'raw-muse', provider: 'Muse', name: 'Muse', ready: true },
    { id: 'model', providerId: 'codex', provider: 'Codex', name: 'Ordinary', ready: true }])
  const visible = modelsWithoutMuse(catalog)
  expect(visible.map(item => item.id)).toEqual(['model'])
  expect(isImmutableModels(visible)).toBe(true)
  expect(modelsWithoutMuse(catalog)).toBe(visible)
  expect(catalog.map(item => item.id)).toEqual(['raw-muse', 'model'])
})
it.each(['command', 'detail'] as const)('keeps an omitted known Muse thread behind the ordinary direct socket %s gate', async kind => {
  const f = fixture('socket')
  f.state.host.threads = f.state.host.threads.filter(item => item.id !== target.threadId); f.publish()
  if (kind === 'command') await expect(f.client!.command({ type: 'interrupt', threadId: target.threadId })).rejects.toThrow('Muse is available in Sotto Owl')
  else expect(await f.client!.readThreadDetail(target.threadId)).toBeNull()
  expect(f.wireFrames).toEqual([])
})
it('remembers published Muse ownership without any window or Watcher snapshot subscriber', async () => {
  const f = fixture('router', false, false)
  f.state.host.threads.push({ id: target.threadId, providerId: 'muse', projectId: 'project', modelId: 'native-model', title: 'Muse',
    status: 'idle', messages: [], requests: [] })
  f.publish()
  f.state.host.threads = f.state.host.threads.filter(item => item.id !== target.threadId); f.publish()
  expect(await f.read(read('read_thread', { target }))).toEqual(refusal)
  expect(f.calls).toEqual([])
})
it('rechecks the router Muse gate in the existing control dispatch guard', async () => {
  const f = fixture('router')
  await f.control(start())
  f.state.host.models[0]!.providerId = 'muse'; f.state.host.models[0]!.provider = 'Muse'
  expect(() => f.dispatchGuard()).toThrow('Muse is available in Sotto Owl')
  expect(f.calls).toHaveLength(1)
})

const checkedClient = (id: 'codex' | 'muse'): ProviderClientUpdate => ({ id, installed: '1.1.1', published: '1.1.2', behind: true,
  channel: id === 'muse' ? 'self-update' : 'npm', canInstall: true, checkedAt: centerTime, state: 'idle' })
function clientProviders(state: AgentState, museConnection: 'connected' | 'disconnected' = 'connected'): void {
  state.host.providers = [
    { id: 'codex', name: 'Codex', connection: 'connected', version: '1.1.1', capabilities: state.host.capabilities },
    { id: 'muse', name: 'Muse', connection: museConnection, version: '1.1.1', capabilities: state.host.capabilities },
  ]
}
for (const boundary of ['router', 'socket'] as const) {
  it(`refuses ${boundary} wildcard checks of connected Muse before dispatch`, async () => {
    const f = fixture(boundary)
    clientProviders(f.state); f.publish()
    const before = structuredClone(f.state), projectionBefore = structuredClone(f.projection)
    await expect(f.execute({ type: 'check-client-updates' })).rejects.toThrow('Muse is available in Sotto Owl')
    expect(f.command?.mock.calls ?? []).toEqual([])
    expect(f.wireFrames).toEqual([])
    expect(f.state).toEqual(before)
    expect(f.projection).toEqual(projectionBefore)
  })
  it(`refuses ${boundary} explicit Muse queues without changing the ordinary update line`, async () => {
    const f = fixture(boundary)
    f.state.clientUpdates = [checkedClient('codex'), checkedClient('muse')]
    f.state.clientUpdateRun = { total: 1, done: 0, line: ['codex'] }; f.publish()
    const before = structuredClone(f.state)
    await expect(f.execute({ type: 'queue-client-updates', providers: ['codex', 'muse'] })).rejects.toThrow('Muse is available in Sotto Owl')
    expect(f.command?.mock.calls ?? []).toEqual([])
    expect(f.wireFrames).toEqual([])
    expect(f.state).toEqual(before)
  })
  it.each(['ordinary only', 'disconnected Muse', 'legacy no providers'] as const)(`keeps ${boundary} %s checks and ordinary queues available`, async kind => {
    const f = fixture(boundary)
    clientProviders(f.state, 'disconnected')
    if (kind === 'ordinary only') f.state.host.providers = f.state.host.providers!.filter(provider => provider.id !== 'muse')
    if (kind === 'legacy no providers') delete f.state.host.providers
    f.publish()
    const before = structuredClone(f.state)
    const commands: AgentCommand[] = [{ type: 'check-client-updates' }, { type: 'queue-client-updates', providers: ['codex'] }]
    for (const input of commands) await f.execute(input)
    if (f.command) expect(f.command.mock.calls.map(([input]) => input)).toEqual(commands)
    else expect(f.wireFrames.map(frame => frame.op === 'command' ? frame.command : null)).toEqual(commands)
    expect(f.state).toEqual(before)
  })
  it(`passes ${boundary} Muse-enabled wildcard checks and queues unchanged`, async () => {
    const f = fixture(boundary, true)
    clientProviders(f.state); f.publish()
    const commands: AgentCommand[] = [{ type: 'check-client-updates' }, { type: 'queue-client-updates', providers: ['codex', 'muse'] }]
    for (const input of commands) await f.execute(input)
    if (f.command) expect(f.command.mock.calls.map(([input]) => input)).toEqual(commands)
    else expect(f.wireFrames.map(frame => frame.op === 'command' ? frame.command : null)).toEqual(commands)
  })
}
it('keeps the initial gate explicit-only while unknown raw wildcard enumeration refuses', () => {
  expect(commandUsesMuse({ type: 'check-client-updates' })).toBe(false)
  expect(clientUpdateEnumerationUsesMuse({ type: 'check-client-updates' })).toBe(true)
  expect(clientUpdateEnumerationUsesMuse({ type: 'queue-client-updates', providers: ['codex'] })).toBe(false)
})
it('hides held Muse updates on every clientHosts entry and sends a named ordinary queue to its own machine', async () => {
  const localId = '22222222-2222-4222-8222-222222222222'
  const local = emptyDesktopState(localId), remote = emptyDesktopState(centerHostId)
  for (const state of [local, remote]) {
    state.host.connected = true; state.connection = 'connected'; clientProviders(state)
    state.clientUpdates = [checkedClient('codex'), checkedClient('muse')]
    state.clientUpdateRun = { total: 2, done: 0, line: ['codex', 'muse'] }
  }
  const localCommand = vi.fn(async (_input: AgentCommand) => { void _input; return local })
  const remoteCommand = vi.fn(async (_input: AgentCommand) => { void _input; return remote })
  const router = new DesktopHostRouter(emptyDesktopState, { watcherEnabled: true, museEnabled: false })
  cleanup.push(() => router.dispose())
  router.add({ hostId: localId, kind: 'local', name: 'This computer', detail: () => null, preview: () => null,
    service: { shell: () => local, subscribe: () => () => undefined, command: localCommand } })
  router.add({ hostId: centerHostId, kind: 'remote', name: 'Paired Owl', offersClientUpdates: () => true, detail: () => null, preview: () => null,
    service: { shell: () => remote, subscribe: () => () => undefined, command: remoteCommand } })
  router.select(centerHostId)
  const before = structuredClone([local, remote]), shown = router.shell()
  expect(shown.clientUpdates).toBeUndefined()
  for (const host of shown.host.clientHosts!) {
    expect(host.clientUpdates).toEqual([checkedClient('codex')])
    expect(host.clientUpdateRun).toEqual({ total: 2, done: 0, line: ['codex'] })
    expect(host.providers?.map(provider => provider.id)).toEqual(['codex'])
  }
  await expect(router.command({ type: 'queue-client-updates', providers: ['muse'], hostId: localId }, desktopWindowClient())).rejects.toThrow('Muse is available in Sotto Owl')
  expect(localCommand).not.toHaveBeenCalled(); expect(remoteCommand).not.toHaveBeenCalled()
  await router.command({ type: 'queue-client-updates', providers: ['codex'], hostId: localId }, desktopWindowClient())
  expect(localCommand).toHaveBeenCalledExactlyOnceWith({ type: 'queue-client-updates', providers: ['codex'] }, desktopWindowClient())
  expect(remoteCommand).not.toHaveBeenCalled()
  await router.command({ type: 'queue-client-updates', providers: ['codex'], hostId: centerHostId }, desktopWindowClient())
  expect(remoteCommand).toHaveBeenCalledExactlyOnceWith({ type: 'queue-client-updates', providers: ['codex'] }, desktopWindowClient())
  expect([local, remote]).toEqual(before)
})
