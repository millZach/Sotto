// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { LocalHostService, type LocalHostControl } from '../../../src/main/agents/hostService'
import type { WatcherService } from '../../../src/main/agents/watcher'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import type { AgentState } from '../../../src/shared/agents'

const LOCAL = '11111111-1111-4111-8111-111111111111'

function hostState(): AgentState {
  const state = emptyDesktopState(LOCAL)
  state.host.connected = true; state.connection = 'connected'
  state.host.projects = [{ id: 'project', title: 'Project', path: '/repo' }]
  state.host.threads = [
    { id: 'busy', projectId: 'project', title: 'Busy', modelId: '', status: 'running', messages: [], requests: [] },
    { id: 'idle', projectId: 'project', title: 'Idle', modelId: '', status: 'idle', messages: [], requests: [] },
  ]
  return state
}

describe('questions asked on every change read what was published', () => {
  // The host-update and start-at-boot questions ask for a host's threads on every change. Rebuilding every host's shell
  // for them copied the whole coordinator state twice per waiting host per update.
  it('answers a host\'s threads from the last publication without reading any shell', () => {
    const state = hostState()
    let push: ((state: AgentState) => void) | undefined
    const shell = vi.fn(() => state)
    const connection: DesktopHostConnection = { hostId: LOCAL, name: 'This computer', kind: 'local', detail: () => null, preview: () => null,
      service: { shell, subscribe: listener => { push = listener; return () => undefined }, command: async () => state } }
    const router = new DesktopHostRouter(emptyDesktopState)
    router.add(connection)
    try {
      expect(router.publishedThreads(LOCAL).map(thread => thread.title)).toEqual(['Busy', 'Idle'])
      router.subscribe(() => undefined)
      push!(state)
      shell.mockClear()
      for (let index = 0; index < 5; index++) expect(router.publishedThreads(LOCAL).map(thread => thread.title)).toEqual(['Busy', 'Idle'])
      expect(router.publishedThreads('another-host')).toEqual([])
      expect(shell).not.toHaveBeenCalled()
    } finally { router.dispose() }
  })

  // A host update asks on every change whether the host's client update line runs, and waits while it does (ADR-0077).
  it('answers whether a host\'s client update line runs from the last publication without reading any shell', () => {
    const state = hostState()
    let push: ((state: AgentState) => void) | undefined
    const shell = vi.fn(() => state)
    const connection: DesktopHostConnection = { hostId: LOCAL, name: 'This computer', kind: 'local', detail: () => null, preview: () => null,
      service: { shell, subscribe: listener => { push = listener; return () => undefined }, command: async () => state } }
    const router = new DesktopHostRouter(emptyDesktopState)
    router.add(connection)
    const update = { id: 'codex' as const, installed: '0.51.0', published: '0.52.1', behind: true, channel: 'npm' as const, canInstall: true, checkedAt: '2026-10-16T10:00:00.000Z' }
    try {
      router.subscribe(() => undefined)
      push!({ ...state, clientUpdates: [{ ...update, state: 'idle' }] })
      shell.mockClear()
      expect(router.clientLineRunning(LOCAL)).toBe(false)
      push!({ ...state, clientUpdates: [{ ...update, state: 'queued' }], clientUpdateRun: { total: 1, done: 0 } })
      shell.mockClear()
      expect(router.clientLineRunning(LOCAL)).toBe(true)
      expect(router.clientLineRunning('another-host')).toBe(false)
      // The last client has finished and the run is not yet cleared: still running until the line says it is empty.
      push!({ ...state, clientUpdates: [{ ...update, state: 'updated' }], clientUpdateRun: { total: 1, done: 1 } })
      shell.mockClear()
      expect(router.clientLineRunning(LOCAL)).toBe(true)
      push!({ ...state, clientUpdates: [{ ...update, state: 'updated' }] })
      shell.mockClear()
      expect(router.clientLineRunning(LOCAL)).toBe(false)
      expect(shell).not.toHaveBeenCalled()
    } finally { router.dispose() }
  })

  it('reads afresh once a change arrives that nothing was published for', () => {
    const state = hostState()
    let push: ((state: AgentState) => void) | undefined
    const connection: DesktopHostConnection = { hostId: LOCAL, name: 'This computer', kind: 'local', detail: () => null, preview: () => null,
      service: { shell: () => state, subscribe: listener => { push = listener; return () => undefined }, command: async () => state } }
    const router = new DesktopHostRouter(emptyDesktopState)
    router.add(connection)
    try {
      const off = router.subscribe(() => undefined)
      push!(state)
      off()
      // The window stopped listening; the busy question still hears changes and must not answer from the old publication.
      state.host.threads = state.host.threads.map(thread => ({ ...thread, status: 'running' as const }))
      push!(state)
      expect(router.publishedThreads(LOCAL).map(thread => thread.status)).toEqual(['running', 'running'])
    } finally { router.dispose() }
  })
})

describe('a Watcher change beside a coordinator broadcast', () => {
  function local() {
    const state = hostState()
    let broadcast: ((state: AgentState) => void) | undefined
    let watcherChanged: (() => void) | undefined
    const control = { get: () => state, shell: vi.fn(() => state), subscribe: (listener: (state: AgentState) => void) => { broadcast = listener; return () => undefined } }
    const watcher = { subscribe: (listener: () => void) => { watcherChanged = listener; return () => undefined } }
    const service = new LocalHostService({ control: control as unknown as LocalHostControl, watcher: watcher as unknown as WatcherService })
    const received: AgentState[] = []
    const off = service.subscribe(next => received.push(next))
    return { state, control, received, off, broadcast: () => broadcast!(state), watcherChanged: () => watcherChanged!() }
  }
  const settle = () => new Promise<void>(resolve => queueMicrotask(resolve))

  // Watcher publishes on every coordinator broadcast, just before this service hears that same broadcast.
  it('hands on the broadcast alone, without copying the shell again', async () => {
    const f = local()
    f.watcherChanged(); f.broadcast()
    await settle()
    expect(f.received).toHaveLength(1)
    expect(f.control.shell).not.toHaveBeenCalled()
  })

  it('hands on a Watcher change that comes after the broadcast in the same turn', async () => {
    const f = local()
    f.watcherChanged(); f.broadcast(); f.watcherChanged()
    await settle()
    expect(f.received).toHaveLength(2)
    expect(f.control.shell).toHaveBeenCalledTimes(1)
  })

  it('still hands on a Watcher change that comes without a broadcast, once per turn', async () => {
    const f = local()
    f.watcherChanged(); f.watcherChanged()
    expect(f.received).toHaveLength(0)
    await settle()
    expect(f.received).toHaveLength(1)
    expect(f.control.shell).toHaveBeenCalledTimes(1)
  })

  it('hands on nothing after unsubscribing', async () => {
    const f = local()
    f.watcherChanged(); f.off()
    await settle()
    expect(f.received).toHaveLength(0)
  })
})
