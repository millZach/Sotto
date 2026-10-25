// @vitest-environment node
/**
 * The router builds the window's state from every host's on every broadcast. A host whose state holds the same values
 * as at the last publication hands on what that publication made for it, and anything that changed shows as a router
 * with nothing to reuse would show it (#1335).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { desktopWindowClient } from '../../../src/main/agents/hostService'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import type { AgentCommand, AgentState, AgentThread } from '../../../src/shared/agents'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const REMOTE = '22222222-2222-4222-8222-222222222222'

/**
 * A host as main holds one: each push replaces its state and nothing writes into it. Its view is the state without a
 * copy, a new object around the same fields, and its shell a whole copy, as the coordinator's and a socket host's are.
 */
function host(hostId: string, kind: 'local' | 'remote', threads = 6) {
  const state = emptyDesktopState(hostId)
  state.host.connected = true; state.connection = 'connected'
  state.host.projects = [{ id: 'project', title: 'Project', path: '/repo' }, { id: 'other', title: 'Other', path: '/other' }]
  state.host.providers = [{ id: 'claude', name: 'Claude', connection: 'connected' }] as AgentState['host']['providers']
  state.host.threads = Array.from({ length: threads }, (_, index): AgentThread => ({ id: `thread-${index}`, projectId: 'project', title: `Task ${index}`,
    modelId: '', providerId: 'claude', status: 'idle', messages: [], requests: [] }))
  state.threadDrafts = [{ threadId: 'thread-0', draftId: 'draft', text: 'Draft', attachments: [], requestId: null }] as unknown as AgentState['threadDrafts']
  let current = state
  const listeners = new Set<(state: AgentState) => void>()
  let available = true
  const connection: DesktopHostConnection = { hostId, name: kind === 'local' ? 'This computer' : 'Forge', kind,
    service: { shell: () => structuredClone(current), view: () => ({ ...current }), subscribe: (listener: (state: AgentState) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      command: vi.fn(async (_command: AgentCommand) => { void _command; return structuredClone(current) }) } as unknown as DesktopHostConnection['service'],
    detail: async () => null, preview: () => null as never, available: () => available }
  return {
    connection,
    get state() { return current },
    /** Pushes the host's next state: a new state around the same values, with `change` applied. */
    push(change: (next: AgentState) => void = () => undefined): void {
      const next = { ...current, host: { ...current.host, threads: current.host.threads.map(thread => ({ ...thread, messages: [] })) } }
      change(next)
      current = next
      for (const listener of listeners) listener(kind === 'local' ? this.view() : next)
    },
    view: () => ({ ...current }),
    setAvailable(value: boolean) { available = value },
  }
}

/** What a router with nothing to reuse builds from the same hosts, with the same selection. */
function fresh(hosts: ReturnType<typeof host>[], selected: string): AgentState {
  const router = new DesktopHostRouter(emptyDesktopState)
  try {
    for (const item of hosts) router.add(item.connection)
    router.select(selected)
    return router.shell()
  } finally { router.dispose() }
}

const routers: DesktopHostRouter[] = []
afterEach(() => { for (const router of routers.splice(0)) router.dispose() })
function setup() {
  const local = host(LOCAL, 'local'), remote = host(REMOTE, 'remote', 4)
  const router = new DesktopHostRouter(emptyDesktopState)
  routers.push(router)
  const published: AgentState[] = []
  router.subscribe(state => published.push(state))
  router.add(local.connection); router.add(remote.connection); router.select(LOCAL)
  const latest = () => published.at(-1)!
  const threadOf = (state: AgentState, hostId: string, id: string) => state.host.threads.find(thread => thread.id === hostEntityKey(hostId, id))!
  return { local, remote, router, published, latest, threadOf }
}

describe('building the window state again (#1335)', () => {
  it('hands on every thread and setting of a host whose state holds the same values, with the values a fresh build gives', () => {
    const { local, remote, latest } = setup()
    const before = latest()
    local.push()
    const after = latest()
    expect(after).not.toBe(before)
    expect(after).toStrictEqual(fresh([local, remote], LOCAL))
    after.host.threads.forEach((thread, index) => expect(thread).toBe(before.host.threads[index]))
    expect(after.configuration).toBe(before.configuration)
    remote.push()
    const third = latest()
    expect(third).toStrictEqual(fresh([local, remote], LOCAL))
    third.host.threads.forEach((thread, index) => expect(thread).toBe(before.host.threads[index]))
  })

  it.each<[string, 'local' | 'remote', (next: AgentState) => void, string[]]>([
    ['a thread title', 'remote', next => { next.host.threads[1] = { ...next.host.threads[1]!, title: 'Renamed' } }, ['thread-1']],
    ['a thread project', 'local', next => { next.host.threads[2] = { ...next.host.threads[2]!, projectId: 'other' } }, ['thread-2']],
    ['a thread status', 'local', next => { next.host.threads[0] = { ...next.host.threads[0]!, status: 'running' } }, ['thread-0']],
    ['a new thread', 'remote', next => { next.host.threads = [{ ...next.host.threads[0]!, id: 'thread-new' }, ...next.host.threads] }, ['thread-new']],
    ['a thread gone', 'local', next => { next.host.threads = next.host.threads.slice(1) }, []],
    ['a project title', 'remote', next => { next.host.projects = [{ ...next.host.projects[0]!, title: 'Renamed project' }, next.host.projects[1]!] }, []],
    ['the selected thread', 'local', next => { next.activeThreadId = 'thread-3' }, []],
    ['a draft thread', 'local', next => { next.threadDrafts = [{ ...next.threadDrafts![0]!, threadId: 'thread-2' }] }, []],
    ['the busy threads', 'remote', next => { next.busyThreadIds = ['thread-2'] }, []],
    ['a setting', 'local', next => { next.configuration = { ...next.configuration, projectsDirectory: '/elsewhere' } }, []],
    ['a provider disconnecting', 'remote', next => { next.host = { ...next.host, providers: [{ ...next.host.providers![0]!, connection: 'disconnected' }] } }, ['thread-0', 'thread-1', 'thread-2', 'thread-3']],
  ])('shows %s on the %s host as a fresh build does, and keeps every thread that did not change', (_name, which, change, changed) => {
    const context = setup(), { local, remote, latest, threadOf } = context
    const target = which === 'local' ? local : remote, hostId = which === 'local' ? LOCAL : REMOTE
    const before = latest()
    target.push(change)
    const after = latest()
    expect(after).toStrictEqual(fresh([local, remote], LOCAL))
    for (const thread of after.host.threads) {
      const earlier = before.host.threads.find(item => item.id === thread.id)
      const key = thread.id.slice(thread.id.lastIndexOf(':') + 1)
      if (thread.hostId === hostId && changed.includes(key)) expect(thread).not.toBe(earlier)
      else expect(thread).toBe(earlier)
    }
    // The build after it measures from this one.
    target.push()
    expect(latest()).toStrictEqual(fresh([local, remote], LOCAL))
    for (const id of changed) if (threadOf(after, hostId, id)) expect(threadOf(latest(), hostId, id)).toBe(threadOf(after, hostId, id))
  })

  it('makes a host thread afresh when the host is renamed, drops its connection or reads Reconnecting', async () => {
    const { local, remote, router, latest, threadOf } = setup()
    const before = latest()
    router.rename(REMOTE, 'Renamed forge')
    expect(latest()).toStrictEqual(fresh([local, { ...remote, connection: { ...remote.connection, name: 'Renamed forge' } }], LOCAL))
    expect(threadOf(latest(), REMOTE, 'thread-0').hostLabel).toBe('Renamed forge')
    expect(threadOf(latest(), LOCAL, 'thread-0')).toBe(threadOf(before, LOCAL, 'thread-0'))
    remote.setAvailable(false)
    router.setReconnecting(REMOTE, true)
    const reconnecting = threadOf(latest(), REMOTE, 'thread-0')
    expect(reconnecting).toMatchObject({ clientConnected: false, clientReconnecting: true })
    router.setReconnecting(REMOTE, false)
    expect(threadOf(latest(), REMOTE, 'thread-0')).not.toHaveProperty('clientReconnecting')
    expect(threadOf(latest(), REMOTE, 'thread-0').clientConnected).toBe(false)
    remote.setAvailable(true)
    remote.push()
    expect(threadOf(latest(), REMOTE, 'thread-0').clientConnected).toBe(true)
    // A command reply reads every host afresh, and gives the values the publication would.
    const reply = await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL, 'thread-1') }, desktopWindowClient())
    expect(reply.host.threads).toStrictEqual(latest().host.threads)
  })

  it('reuses nothing a removed host was given when it is added again', () => {
    const { local, remote, router, latest, threadOf } = setup()
    const before = threadOf(latest(), REMOTE, 'thread-0')
    router.remove(REMOTE)
    expect(latest().host.threads.every(thread => thread.hostId === LOCAL)).toBe(true)
    router.add(remote.connection)
    expect(threadOf(latest(), REMOTE, 'thread-0')).not.toBe(before)
    expect(latest()).toStrictEqual(fresh([local, remote], LOCAL))
  })
})
