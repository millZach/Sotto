// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { SocketHostService } from '../../../src/main/agents/socketHostService'
import { WatcherService } from '../../../src/main/agents/watcher'
import type { AgentControl } from '../../../src/main/agents/control'
import type { WorkspaceHost } from '../../../src/main/agents/workspace'
import { watcherRoomInputs } from '../../../src/main/agents/watcherRoomInput'
import { DesktopHostRouter } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { emptyWatcherRecord } from '../../../src/shared/watcher'
import type { WatcherRemoteHosts } from '../../../src/shared/watcherHost'

const localId = '11111111-1111-4111-8111-111111111111'
const remoteId = '22222222-2222-4222-8222-222222222222'
function fixture(watcherEnabled = true, streamingPublishCost = true) {
  const state = emptyDesktopState(remoteId)
  state.host.connected = false
  state.host.providers = [{ id: 'codex', connection: 'connected' } as NonNullable<typeof state.host.providers>[number]]
  state.host.projects = [{ id: 'project', title: 'Project', path: '/repo', workspaceSettledAt: '2026-10-14T00:00:00.000Z' }]
  state.host.threads = [{ id: 'one', projectId: 'project', title: 'One', modelId: '', providerId: 'codex', status: 'running',
    messages: [], requests: [{ id: 'question', kind: 'question' } as typeof state.host.threads[number]['requests'][number]] },
  { id: 'two', projectId: 'project', title: 'Two', modelId: '', providerId: 'codex', status: 'idle', clientConnected: false, messages: [], requests: [] }]
  const socket = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'test', watcherEnabled, streamingPublishCost })
  Object.assign(socket, { cached: state })
  const router = new DesktopHostRouter(emptyDesktopState, { watcherEnabled, streamingPublishCost })
  let available = true
  router.add({ hostId: remoteId, name: 'Remote', kind: 'remote', service: socket, detail: () => null, preview: () => null, available: () => available })
  return { state, socket, router, offline: () => { available = false }, close: () => { router.dispose(); socket.close() } }
}

describe('owned cached Watcher room inputs', () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])('allocates readers only with both startup gates (%s, %s)', (watcher, cost) => {
    const f = fixture(watcher, cost)
    try {
      expect(typeof f.socket.watcherRoomThreads).toBe(watcher && cost ? 'function' : 'undefined')
      expect(typeof f.router.watcherHosts().roomThreads).toBe(watcher && cost ? 'function' : 'undefined')
    } finally { f.close() }
  })

  it('owns primitive rows and requests, preserves connectivity precedence and retained offline facts', () => {
    const f = fixture()
    try {
      const read = f.router.watcherHosts().roomThreads!
      const rows = read(remoteId, ['one', 'two', 'missing'])!
      expect(rows).toEqual([{ id: 'one', title: 'One', status: 'running', connected: true, settled: true, backgroundWorkCount: 0,
        waitsOn: [{ id: 'question', kind: 'question' }] }, { id: 'two', title: 'Two', status: 'idle', connected: false, settled: true, backgroundWorkCount: 0, waitsOn: [] }])
      rows[0]!.waitsOn[0]!.id = 'changed'; rows[0]!.title = 'changed'
      expect(f.state.host.threads[0]!.requests[0]!.id).toBe('question')
      const owned = read(remoteId, ['one'])!
      f.state.host.threads[0]!.title = 'Later'; f.state.host.threads[0]!.requests[0]!.id = 'later'
      expect(owned[0]).toMatchObject({ title: 'One', waitsOn: [{ id: 'question' }] })
      f.offline()
      expect(read(remoteId, ['one'])![0]).toMatchObject({ title: 'Later', status: 'running', connected: false })
      expect(read('unknown', ['one'])).toBeUndefined()
      expect(read(remoteId, ['missing'])).toEqual([])
      Object.assign(f.socket, { cached: undefined })
      expect(() => read(remoteId, ['one'])).toThrow('Connect to the host before reading its state.')
    } finally { f.close() }
  })

  it('filters dormant Muse threads and excludes a hidden project from settlement', () => {
    const f = fixture()
    try {
      f.state.host.projects[0]!.providerId = 'muse'
      Object.assign(f.socket, { dormantProviderThreads: new Map([['two', { projectId: 'project', provider: 'muse' }]]) })
      expect(f.socket.watcherRoomThreads!(['one', 'two'])).toEqual([
        { id: 'one', title: 'One', status: 'running', connected: true, settled: false, backgroundWorkCount: 0, waitsOn: [{ id: 'question', kind: 'question' }] }])
    } finally { f.close() }
  })

  it('falls back once for an older local service without the optional capability', () => {
    const f = fixture()
    try {
      Object.assign(f.socket, { watcherRoomThreads: undefined })
      const shell = vi.spyOn(f.socket, 'shell')
      expect(f.router.watcherHosts().roomThreads!(remoteId, ['one', 'two'])).toHaveLength(2)
      expect(shell).toHaveBeenCalledTimes(1)
    } finally { f.close() }
  })

  it.each([false, true])('keeps full room values while grouping remote state/Get reads (optimized: %s)', optimized => {
    const f = fixture(), record = emptyWatcherRecord()
    record.requests.push({ id: 'request', watcher: { hostId: localId, threadId: 'master' }, rootUserMessageId: 'user', state: 'active',
      createdAt: '2026-10-14T00:00:00.000Z', closedAt: null, participants: ['one', 'two', 'missing'].map(threadId => ({
        target: { hostId: remoteId, threadId }, requestId: 'request', startedBy: 'watcher', generation: 0, state: 'participating', promptCount: 1 })) })
    const control = { watcherRecord: () => structuredClone(record), watcherRecordView: () => record, watcherSnapshot: () => emptyDesktopState(localId).host,
      hostId: () => localId, useWatcher: () => () => undefined, subscribe: () => () => undefined } as unknown as AgentControl
    const service = new WatcherService({ directory: '', control, host: {} as WorkspaceHost, limit: () => 4, historyEnabled: () => false, streamingPublishCost: optimized })
    const legacy = new WatcherService({ directory: '', control, host: {} as WorkspaceHost, limit: () => 4, historyEnabled: () => false })
    const remote: WatcherRemoteHosts = f.router.watcherHosts()
    const room = vi.spyOn(remote, 'roomThreads'), snapshot = vi.spyOn(remote, 'snapshot'), shell = vi.spyOn(f.socket, 'shell')
    Object.assign(service, { remote }) // No reconciliation/observer work is part of this state-only check.
    Object.assign(legacy, { remote })
    const timestamp = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-10-14T00:00:00.000Z')
    try {
      expect(service.state()).toEqual(legacy.state())
      room.mockClear(); snapshot.mockClear(); shell.mockClear()
      const expected = new Map(watcherRoomInputs(f.state.host, ['one', 'two'], new Set(['muse'])).map(row => [row.id, row]))
      for (const state of [service.state(), (service.get() as { state: ReturnType<WatcherService['state']> }).state]) {
        for (const row of state.watchedThreads) {
          const input = expected.get(row.target.threadId)
          expect(row).toMatchObject({ title: input?.title ?? 'Unavailable thread', connected: input?.connected ?? false,
            settled: input?.settled ?? false, waitsOn: input?.waitsOn.map(wait => ({ ...wait, openTarget: row.target })) ?? [] })
        }
      }
      expect(room).toHaveBeenCalledTimes(optimized ? 2 : 0)
      expect(snapshot.mock.calls.length).toBe(optimized ? 0 : 18)
      expect(shell.mock.calls.length).toBe(optimized ? 0 : 18)
      if (optimized) expect(room).toHaveBeenCalledWith(remoteId, ['one', 'two', 'missing'])
    } finally { timestamp.mockRestore(); service.close(); legacy.close(); f.close() }
  })

  it.each(['active', 'stopped'] as const)('keeps standing-only watches, paused flags and %s participation without shell reads', requestState => {
    const f = fixture(), record = emptyWatcherRecord(), at = '2026-10-14T00:00:00.000Z'
    f.state.host.threads.push({ ...f.state.host.threads[1]!, id: 'standing-only', title: 'Standing only', requests: [] })
    record.current = { target: { hostId: localId, threadId: 'master' }, projectId: 'local-project', provider: 'codex',
      creationOperationId: '33333333-3333-4333-8333-333333333333', createdAt: at }
    record.lastRuntimeMode = 'full-access'
    record.requests.push({ id: 'request', watcher: record.current.target, rootUserMessageId: 'user', state: requestState,
      createdAt: at, closedAt: null, participants: ['one', 'two'].map(threadId => ({ target: { hostId: remoteId, threadId },
        requestId: 'request', startedBy: 'watcher', generation: 0, state: 'participating', promptCount: 1,
        ...(threadId === 'two' ? { automationStopped: true } : {}) })) })
    record.watches = [{ id: '44444444-4444-4444-8444-444444444444', target: { hostId: remoteId, threadId: 'standing-only' },
      createdAt: at, generation: 0, pausedByUserMessageId: 'user' }]
    const control = { watcherRecord: () => structuredClone(record), watcherRecordView: () => record, watcherSnapshot: () => emptyDesktopState(localId).host,
      hostId: () => localId, useWatcher: () => () => undefined, subscribe: () => () => undefined } as unknown as AgentControl
    const service = new WatcherService({ directory: '', control, host: {} as WorkspaceHost, limit: () => 4, historyEnabled: () => false, streamingPublishCost: true })
    const legacy = new WatcherService({ directory: '', control, host: {} as WorkspaceHost, limit: () => 4, historyEnabled: () => false })
    const remote = f.router.watcherHosts(), read = vi.spyOn(remote, 'roomThreads'), snapshot = vi.spyOn(remote, 'snapshot'), shell = vi.spyOn(f.socket, 'shell')
    Object.assign(service, { remote }); Object.assign(legacy, { remote })
    const timestamp = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue(at)
    try {
      const expected = legacy.state()
      snapshot.mockClear(); shell.mockClear()
      const state = service.state()
      expect(state).toEqual(expected)
      expect(state.runtimeMode).toBe('full-access')
      expect(state.watchedThreads.map(row => ({ id: row.target.threadId, watched: row.watched, paused: row.paused }))).toEqual([
        { id: 'one', watched: requestState === 'active', paused: false },
        { id: 'two', watched: false, paused: false }, { id: 'standing-only', watched: true, paused: true }])
      expect(read).toHaveBeenCalledExactlyOnceWith(remoteId, ['one', 'two', 'standing-only'])
      expect(snapshot).not.toHaveBeenCalled(); expect(shell).not.toHaveBeenCalled()
    } finally { timestamp.mockRestore(); service.close(); legacy.close(); f.close() }
  })
})
