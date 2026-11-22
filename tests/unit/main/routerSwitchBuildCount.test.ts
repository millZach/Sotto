// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { immutableActivities } from '../../../src/main/agents/activitySnapshots'
import { DetailSends } from '../../../src/main/agents/detailSends'
import { desktopWindowClient, type HostService } from '../../../src/main/agents/hostService'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentCommand, AgentMessage, AgentState, AgentThread } from '../../../src/shared/agents'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { heldProvidersOf } from '../../../src/shared/heldProviders'
import { noteThreadsReplaced } from '../../../src/shared/threadListPatches'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const REMOTE = '22222222-2222-4222-8222-222222222222'

function makeHost(hostId: string, kind: 'local' | 'remote', options: {
  readonly emitOnSelect?: boolean
  readonly clearFinishedOnObserve?: boolean
  readonly selectError?: string
} = {}) {
  let state = emptyDesktopState(hostId)
  state.host.connected = true
  state.connection = 'connected'
  state.host.projects = [
    { id: 'proj-a', title: 'Project A', path: '/repo-a' },
    { id: 'proj-b', title: 'Project B', path: '/repo-b' },
  ]
  state.host.threads = [
    { id: 't1', projectId: 'proj-a', title: 'First', modelId: 'codex:gpt-5.4', status: 'idle', messages: [], requests: [] },
    { id: 't2', projectId: 'proj-b', title: 'Second', modelId: 'codex:gpt-5.4', status: 'idle', finishedUnread: true, messages: [], requests: [] },
    { id: 'watcher-1', projectId: 'proj-a', title: 'Watcher', kind: 'watcher', modelId: 'codex:gpt-5.4', status: 'idle', messages: [], requests: [] },
  ]
  const listeners = new Set<(next: AgentState) => void>()

  let lastBroadcastHost = state.host
  const broadcastView = (): AgentState => {
    if (kind === 'local') {
      const nextHost = { ...state.host, threads: state.host.threads.slice() }
      noteThreadsReplaced(nextHost, lastBroadcastHost, [])
      lastBroadcastHost = nextHost
      return { ...state, host: nextHost, threadDraftPersistence: [] }
    }
    return { ...state }
  }
  const replyView = (): AgentState => {
    // Mirrors AgentControl.shellOf('reply') for local (fresh sliced list patched from last broadcast)
    // and SocketHostService.view() for remote (fresh top-level shell sharing cached host).
    if (kind === 'local') {
      const nextHost = { ...state.host, threads: state.host.threads.slice() }
      noteThreadsReplaced(nextHost, lastBroadcastHost, [])
      return { ...state, host: nextHost, threadDraftPersistence: [] }
    }
    return { ...state }
  }

  const service: DesktopHostConnection['service'] = {
    shell: () => structuredClone(state),
    view: () => broadcastView(),
    replyView: () => replyView(),
    activeSelection: () => ({ activeThreadId: state.activeThreadId, activeProjectId: state.activeProjectId }),
    subscribe: (listener: (next: AgentState) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    command: async (input: unknown) => {
      const command = input as AgentCommand
      if (command.type === 'select-thread') {
        if (options.selectError) {
          if (options.emitOnSelect) for (const listener of listeners) listener(broadcastView())
          return { ...replyView(), error: options.selectError }
        }
        const found = state.host.threads.find(item => item.id === command.threadId)
        state = {
          ...state,
          activeThreadId: found?.id ?? null,
          activeProjectId: found?.projectId ?? null,
          error: null,
          threadDraftPersistence: [],
        }
        if (options.emitOnSelect) {
          const emitted = broadcastView()
          for (const listener of listeners) listener(emitted)
        }
        return replyView()
      }
      if (command.type === 'observe-threads') {
        if (options.clearFinishedOnObserve && command.threadIds.includes('t2')) {
          const prevHost = state.host
          const updatedThreads = prevHost.threads.map(t => t.id === 't2' ? { ...t, finishedUnread: undefined } : t)
          const nextHost = { ...prevHost, threads: updatedThreads }
          noteThreadsReplaced(nextHost, prevHost, [1])
          state = { ...state, host: nextHost, threadDraftPersistence: [] }
          return state
        }
        return replyView()
      }
      return replyView()
    },
  } as unknown as HostService

  const connection: DesktopHostConnection = {
    hostId,
    name: kind === 'local' ? 'This computer' : 'Forge',
    kind,
    service,
    detail: () => null,
    preview: () => null,
    ...(kind === 'remote' ? { observe: async () => undefined } : {}),
  }
  return { connection, getState: () => state }
}

describe('DesktopHostRouter thread-switch build deduplication (#2733)', () => {
  it('runs a single build and emit across select-thread + observe-threads when local host already published', async () => {
    const local = makeHost(LOCAL, 'local', { emitOnSelect: true })
    const remote = makeHost(REMOTE, 'remote', { emitOnSelect: false })
    const replyBuilt = vi.fn()
    const router = new DesktopHostRouter(emptyDesktopState, { heldProviders: heldProvidersOf({}), replyBuilt })
    router.add(local.connection)
    router.add(remote.connection)

    let emits = 0
    router.subscribe(() => { emits++ })
    const buildSpy = vi.spyOn(router as unknown as { build: (...args: unknown[]) => unknown }, 'build')

    // Prime initial publication.
    await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL, 't1') }, desktopWindowClient())
    buildSpy.mockClear()
    replyBuilt.mockClear()
    emits = 0

    const selected = await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL, 't2') }, desktopWindowClient())
    const observed = await router.command({ type: 'observe-threads', threadIds: [hostEntityKey(LOCAL, 't2')] }, desktopWindowClient())

    expect(buildSpy).toHaveBeenCalledTimes(1)
    expect(emits).toBe(1)
    expect(replyBuilt).toHaveBeenCalledTimes(2)
    expect(selected.activeThreadId).toBe(hostEntityKey(LOCAL, 't2'))
    expect(selected.activeProjectId).toBe(hostEntityKey(LOCAL, 'proj-b'))
    expect(observed.activeThreadId).toBe(hostEntityKey(LOCAL, 't2'))
    expect(observed.activeProjectId).toBe(hostEntityKey(LOCAL, 'proj-b'))
    router.dispose()
  })

  it('still emits once when remote host does not emit during select-thread, and reuses published on observe-threads', async () => {
    const local = makeHost(LOCAL, 'local', { emitOnSelect: true })
    const remote = makeHost(REMOTE, 'remote', { emitOnSelect: false })
    const router = new DesktopHostRouter(emptyDesktopState, { heldProviders: heldProvidersOf({}) })
    router.add(local.connection)
    router.add(remote.connection)

    let emits = 0
    router.subscribe(() => { emits++ })
    const buildSpy = vi.spyOn(router as unknown as { build: (...args: unknown[]) => unknown }, 'build')

    const selected = await router.command({ type: 'select-thread', threadId: hostEntityKey(REMOTE, 't2') }, desktopWindowClient())
    const observed = await router.command({ type: 'observe-threads', threadIds: [hostEntityKey(REMOTE, 't2')] }, desktopWindowClient())

    expect(buildSpy).toHaveBeenCalledTimes(1)
    expect(emits).toBe(1)
    expect(selected.activeThreadId).toBe(hostEntityKey(REMOTE, 't2'))
    expect(selected.activeProjectId).toBe(hostEntityKey(REMOTE, 'proj-b'))
    expect(observed.activeThreadId).toBe(hostEntityKey(REMOTE, 't2'))
    router.dispose()
  })

  it('rebuilds in observe-threads when a host updates a thread without emitting (e.g. clearing finished inside a coalesce window)', async () => {
    const local = makeHost(LOCAL, 'local', { emitOnSelect: true, clearFinishedOnObserve: true })
    const router = new DesktopHostRouter(emptyDesktopState, { heldProviders: heldProvidersOf({}) })
    router.add(local.connection)
    router.subscribe(() => undefined)

    await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL, 't2') }, desktopWindowClient())
    const buildSpy = vi.spyOn(router as unknown as { build: (...args: unknown[]) => unknown }, 'build')

    const observed = await router.command({ type: 'observe-threads', threadIds: [hostEntityKey(LOCAL, 't2')] }, desktopWindowClient())

    expect(buildSpy).toHaveBeenCalledTimes(1)
    const thread = observed.host.threads.find(item => item.id === hostEntityKey(LOCAL, 't2'))
    expect(thread?.finishedUnread).toBeUndefined()
    router.dispose()
  })

  it('re-emits the refusal notice when select-thread fails even if the host emitted before returning an error', async () => {
    const local = makeHost(LOCAL, 'local', { emitOnSelect: true, selectError: 'Thread is locked.' })
    const router = new DesktopHostRouter(emptyDesktopState, { heldProviders: heldProvidersOf({}) })
    router.add(local.connection)
    const publishedErrors: Array<string | null> = []
    router.subscribe(state => publishedErrors.push(state.error))

    const result = await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL, 't1') }, desktopWindowClient())

    expect(result.error).toBe('Thread is locked.')
    expect(publishedErrors.at(-1)).toBe('Thread is locked.')
    router.dispose()
  })

  it('leaves selectedProjectId null for threads hidden by watcherEnabled=false', async () => {
    const local = makeHost(LOCAL, 'local', { emitOnSelect: true })
    const router = new DesktopHostRouter(emptyDesktopState, { watcherEnabled: false, heldProviders: heldProvidersOf({}) })
    router.add(local.connection)
    router.subscribe(() => undefined)

    const result = await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL, 't1') }, desktopWindowClient())
    expect(result.activeProjectId).toBe(hostEntityKey(LOCAL, 'proj-a'))
    router.dispose()
  })
})

describe('DetailSends.wholeDetail cloning and decoration isolation (#2733)', () => {
  function makeSends(streamingPublishCost: boolean) {
    const messages: AgentMessage[] = [
      {
        id: 'm1',
        role: 'user',
        text: 'Check screenshot',
        createdAt: '2026-11-22T12:00:00.000Z',
        attachments: [{ id: 'a1', name: 'shot.png', mimeType: 'image/png', sizeBytes: 1200, preview: { available: true } }],
      },
      {
        id: 'm2',
        role: 'assistant',
        text: 'Looks good',
        createdAt: '2026-11-22T12:00:05.000Z',
      },
    ]
    const activities = immutableActivities([
      { id: 'act-1', turnId: 'm1', sequence: 0, kind: 'command', status: 'completed', title: 'Run test', output: 'ok' },
    ] satisfies AgentActivity[])
    const thread: AgentThread = {
      id: 't1',
      projectId: 'p1',
      title: 'Test thread',
      modelId: 'codex:gpt-5.4',
      status: 'idle',
      messages,
      activities: activities as AgentActivity[],
      requests: [],
    }
    const state = emptyDesktopState(LOCAL)
    state.host.threads = [thread]
    const sends = new DetailSends({
      state: () => state,
      dependencies: { streamingPublishCost },
      threadById: id => id === thread.id ? thread : undefined,
      paneActivities: item => item.activities,
      presentedMessages: item => item.messages,
      revision: () => 5,
      certifiedActivitySignature: () => ({} as never),
      decorate: snapshot => {
        for (const item of snapshot.threads) for (const msg of item.messages) {
          for (const attachment of msg.attachments ?? []) delete attachment.preview
          if (msg.id === 'm2') {
            msg.attachments = [{ id: 'local-1', name: 'added.png', mimeType: 'image/png', sizeBytes: 500, preview: { available: true } }]
          }
        }
      },
    })
    return { sends, messages, activities }
  }

  it('shares certified immutableActivities under streamingPublishCost and isolates snapshot messages from decoration', () => {
    const { sends, messages, activities } = makeSends(true)
    const origClone = globalThis.structuredClone
    let cloneCalls = 0
    globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
      cloneCalls++
      return origClone(value, options)
    }) as typeof structuredClone

    try {
      const detail = sends.threadDetail('t1')!
      expect(cloneCalls).toBe(1)
      expect(detail.activities).toBe(activities)
      // Decorated detail reflects stripped preview on m1 and added preview attachment on m2.
      expect(detail.messages[0]!.attachments?.[0]?.preview).toBeUndefined()
      expect(detail.messages[1]!.attachments?.[0]?.id).toBe('local-1')
      // Original presented messages are never mutated.
      expect(messages[0]!.attachments?.[0]?.preview).toEqual({ available: true })
      expect(messages[1]!.attachments).toBeUndefined()
      // Stored undecorated snapshot is never mutated by decorate().
      const snapshot = (sends as unknown as { detailSnapshots: Map<string, { messages: AgentMessage[]; activities?: AgentActivity[] }> }).detailSnapshots.get('t1')!
      expect(snapshot.messages[0]!.attachments?.[0]?.preview).toEqual({ available: true })
      expect(snapshot.messages[1]!.attachments).toBeUndefined()
      expect(snapshot.activities).toBe(activities)
    } finally {
      globalThis.structuredClone = origClone
    }
  })

  it('keeps cloning activities once when streamingPublishCost is false while still cloning messages only once', () => {
    const { sends, activities } = makeSends(false)
    const origClone = globalThis.structuredClone
    let cloneCalls = 0
    globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
      cloneCalls++
      return origClone(value, options)
    }) as typeof structuredClone

    try {
      const detail = sends.threadDetail('t1')!
      expect(cloneCalls).toBe(2)
      expect(detail.activities).not.toBe(activities)
      expect(detail.activities).toEqual(activities)
    } finally {
      globalThis.structuredClone = origClone
    }
  })
})
