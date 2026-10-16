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
