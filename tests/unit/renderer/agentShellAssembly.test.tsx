import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAgentConnection } from '../../../src/renderer/src/agents/AgentContext'
import { SHELL_CACHE_KEY, cacheableShell, readShellCache, writeShellCache } from '../../../src/renderer/src/agents/shellCache'
import { agentShell, defaultAgentConfiguration, EMPTY_AGENT_HOST, summarizeThread,
  type AgentBridge, type AgentMessage, type AgentModel, type AgentState, type AgentThread, type AgentThreadDetail,
  type AgentThreadDetailUpdate } from '../../../src/shared/agents'

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

const message = (id: string, role: AgentMessage['role'], text: string): AgentMessage =>
  ({ id, role, text, createdAt: `2026-01-0${id.length}T00:0${id.length}:00.000Z` })

function thread(id: string, messages: AgentMessage[]): AgentThread {
  return { id, title: id, projectId: 'project', modelId: 'claude:test', status: 'idle', messages, requests: [] }
}

const model = (id: string): AgentModel => ({ id, provider: 'Claude Code', providerId: 'claude', name: id, ready: true })

function fullState(threads: AgentThread[], activeThreadId: string | null = null): AgentState {
  return {
    configuration: { ...defaultAgentConfiguration(), enabled: true }, connection: 'connected',
    host: { ...EMPTY_AGENT_HOST, connected: true, threads },
    assignments: [], queue: [], activeThreadId, activeProjectId: null, draft: '', draftThreadId: null, composing: false,
    draftRequestId: null, draftAttachments: [], deliveredDrafts: [], threadDrafts: [], deliveries: [], pendingRequest: '',
    globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' },
    voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: false }, reasoningAccounts: [],
    membership: { status: 'beta', label: 'Test', expiresAt: null }, historyEnabled: true,
  }
}

/** A bridge that carries only the shell, with the detail of each thread on request or on push. */
function shellBridge(state: AgentState, options: { detail?: boolean } = {}) {
  const listeners = new Set<(state: AgentState) => void>()
  const detailListeners = new Set<(update: AgentThreadDetailUpdate) => void>()
  const revisions = new Map<string, number>()
  const detailOf = (threadId: string): AgentThreadDetail | null => {
    const found = state.host.threads.find(item => item.id === threadId)
    return found === undefined ? null : { threadId, revision: revisions.get(threadId) ?? 1, messages: found.messages }
  }
  const threadDetail = vi.fn(async (threadId: string) => detailOf(threadId))
  const bridge: AgentBridge = {
    get: async () => agentShell(state),
    command: vi.fn(async () => agentShell(state)),
    onState: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    ...(options.detail === false ? {} : {
      threadDetail,
      onThreadDetail: listener => { detailListeners.add(listener); return () => detailListeners.delete(listener) },
    }),
  }
  return {
    bridge, threadDetail,
    emit: (update: AgentThreadDetailUpdate) => { for (const listener of detailListeners) listener(update) },
    publish: (next: AgentState) => { state = next; for (const listener of listeners) listener(agentShell(next)) },
    push: (threadId: string) => {
      revisions.set(threadId, (revisions.get(threadId) ?? 0) + 1)
      const detail = detailOf(threadId)
      if (detail) for (const listener of detailListeners) listener(detail)
    },
  }
}

describe('assembling the window state from the shell', () => {
  it('does not walk retained history again for unrelated shell updates', async () => {
    let reads = 0
    const messages = Array.from({ length: 200 }, (_, index) => ({
      ...message(String(index), 'assistant', 'Retained history'),
      get id() { reads++; return String(index) },
    }))
    const state = fullState([thread('workshop', messages)], 'workshop')
    const wire = shellBridge(state)
    const { result } = renderHook(() => useAgentConnection(wire.bridge))
    await waitFor(() => expect(result.current.state?.host.threads[0]?.messages.length).toBe(200))
    wire.publish({ ...state, notice: 'First update' })
    await waitFor(() => expect(result.current.state?.notice).toBe('First update'))
    reads = 0
    wire.publish({ ...state, notice: 'Another update' })
    await waitFor(() => expect(result.current.state?.notice).toBe('Another update'))
    // The shell summary may inspect the last message; reconciliation must not
    // scan every retained message merely because another shell arrived.
    expect(reads).toBeLessThan(10)
  })

  it('splices the history it holds into each arriving shell and leaves the rest of the state alone', async () => {
    const messages = [message('a', 'user', 'Pick the palette'), message('bb', 'assistant', 'Indigo it is.')]
    const wire = shellBridge(fullState([thread('workshop', messages), thread('docs', [])], 'workshop'))
    const { result } = renderHook(() => useAgentConnection(wire.bridge))
    await waitFor(() => expect(result.current.state).not.toBeNull())
    await waitFor(() => expect(result.current.state!.host.threads[0]!.messages).toEqual(messages))
    expect(wire.threadDetail).toHaveBeenCalledWith('workshop')
    expect(result.current.state!.host.threads[1]!.messages).toEqual([])
    expect(result.current.state!.configuration.enabled).toBe(true)
  })

  it('says a viewed thread is still loading until its history arrives', async () => {
    const messages = [message('a', 'assistant', 'Working on it.')]
    const wire = shellBridge(fullState([thread('workshop', messages)]))
    wire.bridge.threadDetail = async () => null
    const { result } = renderHook(() => useAgentConnection(wire.bridge))
    await waitFor(() => expect(result.current.state).not.toBeNull())
    // Nothing declares the thread viewed yet, so the row is drawn from its summary alone.
    expect(result.current.state!.host.threads[0]!.historyStatus).toBeUndefined()
    expect(result.current.state!.host.threads[0]!.summary).toEqual(summarizeThread({ messages }))
    await act(async () => { await result.current.command({ type: 'observe-threads', threadIds: ['workshop'] }) })
    await waitFor(() => expect(result.current.state!.host.threads[0]!.historyStatus).toBe('loading'))
  })

  it('takes a pushed history and re-assembles the shell it is holding', async () => {
    const wire = shellBridge(fullState([thread('workshop', [])]))
    const { result } = renderHook(() => useAgentConnection(wire.bridge))
    await waitFor(() => expect(result.current.state).not.toBeNull())
    const messages = [message('a', 'assistant', 'A late reply.')]
    wire.publish(fullState([thread('workshop', messages)]))
    act(() => { wire.push('workshop') })
    await waitFor(() => expect(result.current.state!.host.threads[0]!.messages).toEqual(messages))
  })

  it('ignores a history older than the one it already holds', async () => {
    const newer = [message('a', 'assistant', 'Newest'), message('bb', 'assistant', 'Newer still')]
    const wire = shellBridge(fullState([thread('workshop', newer)], 'workshop'))
    const { result } = renderHook(() => useAgentConnection(wire.bridge))
    await waitFor(() => expect(result.current.state!.host.threads[0]!.messages).toHaveLength(2))
    // A request can answer after a push has already delivered newer history.
    act(() => { wire.emit({ threadId: 'workshop', revision: 0, messages: [message('a', 'assistant', 'Newest')] }) })
    await waitFor(() => expect(result.current.state!.host.threads[0]!.messages).toHaveLength(2))
    act(() => { wire.emit({ threadId: 'workshop', revision: 9, messages: [] }) })
    await waitFor(() => expect(result.current.state!.host.threads[0]!.messages).toHaveLength(0))
  })
})

describe('the detail deltas that follow a history', () => {
  it('applies an append by replacing only the message that grew', async () => {
    const messages = [message('a', 'user', 'Pick the palette'), message('bb', 'assistant', 'Indigo')]
    const wire = shellBridge(fullState([thread('workshop', messages)], 'workshop'))
    const { result } = renderHook(() => useAgentConnection(wire.bridge))
    await waitFor(() => expect(result.current.state!.host.threads[0]!.messages).toHaveLength(2))
    const before = result.current.state!.host.threads[0]!.messages
    act(() => { wire.emit({ threadId: 'workshop', baseRevision: 1, revision: 2, messageDeltas: [{ id: 'bb', appendText: ' it is.' }], activityDeltas: [] }) })
    await waitFor(() => expect(result.current.state!.host.threads[0]!.messages[1]!.text).toBe('Indigo it is.'))
    const after = result.current.state!.host.threads[0]!.messages
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
  })

  it('asks for the whole history when a delta does not follow the revision it holds', async () => {
    const messages = [message('a', 'assistant', 'Indigo')]
    const wire = shellBridge(fullState([thread('workshop', messages)], 'workshop'))
    const { result } = renderHook(() => useAgentConnection(wire.bridge))
    await waitFor(() => expect(result.current.state!.host.threads[0]!.messages).toHaveLength(1))
    expect(wire.threadDetail).toHaveBeenCalledTimes(1)
    act(() => { wire.emit({ threadId: 'workshop', baseRevision: 8, revision: 9, messageDeltas: [{ id: 'a', appendText: ' it is.' }], activityDeltas: [] }) })
    await waitFor(() => expect(wire.threadDetail).toHaveBeenCalledTimes(2))
    // The delta was not guessed at: the history on screen is still the one the window holds.
    expect(result.current.state!.host.threads[0]!.messages[0]!.text).toBe('Indigo')
  })
})

describe('the startup shell cache', () => {
  it('paints what the window saw last, marked stale and disconnected, then replaces it', async () => {
    const live = fullState([thread('workshop', [message('a', 'assistant', 'Indigo it is.')])], 'workshop')
    writeShellCache(live)
    const wire = shellBridge(fullState([thread('workshop', [message('a', 'assistant', 'Indigo it is.')])], 'workshop'))
    wire.bridge.get = () => new Promise(resolve => { setTimeout(() => resolve(agentShell(live)), 20) })
    const { result } = renderHook(() => useAgentConnection(wire.bridge))
    await waitFor(() => expect(result.current.state).not.toBeNull())
    expect(result.current.state!.stale).toBe(true)
    expect(result.current.state!.connection).toBe('disconnected')
    expect(result.current.state!.host.connected).toBe(false)
    expect(result.current.state!.host.threads[0]!.summary!.lastAssistant!.text).toBe('Indigo it is.')
    await waitFor(() => expect(result.current.state!.stale).toBeUndefined())
    expect(result.current.state!.connection).toBe('connected')
  })

  it('keeps a row\'s own excerpts and nothing else: no transcript, no attachment bytes, no drafts', () => {
    const image = { id: 'image', name: 'pixel.png', mimeType: 'image/png' as const, dataUrl: 'data:image/png;base64,AAAA' }
    const live = { ...fullState([thread('workshop', [message('a', 'user', 'The prompt'), message('bb', 'assistant', 'Hidden middle'), message('ccc', 'assistant', 'The reply')])]),
      draft: 'Unsent draft', draftAttachments: [image],
      threadDrafts: [{ threadId: 'workshop', draftId: '00000000-0000-4000-8000-000000000000', text: 'Unsent draft', attachments: [image], requestId: null, updatedAt: '2026-01-01T00:00:00.000Z' }] }
    const kept = cacheableShell(live)
    const serialized = JSON.stringify(kept)
    expect(serialized).not.toContain('Hidden middle')
    expect(serialized).not.toContain('Unsent draft')
    expect(serialized).not.toContain('data:image')
    expect(kept.host.threads[0]!.messages).toEqual([])
    expect(kept.host.threads[0]!.activities).toEqual([])
    expect(kept.threadDrafts).toEqual([])
    // The row's own sentence survives, which is the whole point of painting from the cache.
    expect(kept.host.threads[0]!.summary).toMatchObject({ messageCount: 3, lastAssistant: { text: 'The reply' } })
  })

  it('writes nothing and clears what it has when local history is off', async () => {
    writeShellCache(fullState([thread('workshop', [])]))
    expect(localStorage.getItem(SHELL_CACHE_KEY)).not.toBeNull()
    const off = { ...fullState([thread('workshop', [])]), historyEnabled: false }
    const wire = shellBridge(off)
    renderHook(() => useAgentConnection(wire.bridge))
    await waitFor(() => expect(localStorage.getItem(SHELL_CACHE_KEY)).toBeNull())
    expect(readShellCache()).toBeNull()
  })

  it('trims a large catalog to the models its threads reference, so the cache stays under the cap', () => {
    const kept = model('claude:kept')
    const catalog = [kept, ...Array.from({ length: 700 }, (_, index) => model(`catalog:unused-${index}`))]
    const live = { ...fullState([{ ...thread('workshop', []), modelId: kept.id }]) }
    live.host = { ...live.host, models: catalog }
    writeShellCache(live)
    const raw = localStorage.getItem(SHELL_CACHE_KEY)
    expect(raw).not.toBeNull()
    expect(raw!.length).toBeLessThan(20_000)
    const restored = readShellCache()
    expect(restored!.host.models).toEqual([kept])
  })

  it('restores each host\'s own catalog, trimmed to what its threads reference, including a remote host\'s own', () => {
    const ownModel = model('local:kept'), ownUnused = model('local:unused')
    const remoteModel = model('remote:kept'), remoteUnused = model('remote:unused')
    const ownCatalog = [ownModel, ownUnused]
    const remoteCatalog = [remoteModel, remoteUnused]
    const live = fullState([
      { ...thread('local-thread', []), hostId: 'local-host', modelId: ownModel.id },
      { ...thread('remote-thread', []), hostId: 'remote-host', modelId: remoteModel.id },
    ])
    live.host = {
      ...live.host, models: ownCatalog,
      clientHosts: [
        // The selected host's own entry is the very array `host.models` holds, as the desktop router produces.
        { hostId: 'local-host', connected: true, models: ownCatalog, capabilities: live.host.capabilities },
        { hostId: 'remote-host', connected: true, models: remoteCatalog, capabilities: live.host.capabilities },
      ],
    }
    writeShellCache(live)
    const restored = readShellCache()!
    expect(restored.host.models).toEqual([ownModel])
    expect(restored.host.clientHosts!.find(entry => entry.hostId === 'local-host')!.models).toEqual([ownModel])
    expect(restored.host.clientHosts!.find(entry => entry.hostId === 'remote-host')!.models).toEqual([remoteModel])
  })

  it('keeps a remote thread\'s model in the host\'s own catalog, where the Agents room looks it up', () => {
    // Model IDs are not host-keyed, so the same model can sit in both catalogs.
    const shared = model('native:claude:model:sonnet')
    const live = fullState([
      { ...thread('local-thread', []), hostId: 'local-host', modelId: 'claude:local' },
      { ...thread('remote-thread', []), hostId: 'remote-host', modelId: shared.id },
    ])
    const ownCatalog = [model('claude:local'), shared, model('claude:unused')]
    live.host = { ...live.host, models: ownCatalog, clientHosts: [
      { hostId: 'local-host', connected: true, models: ownCatalog, capabilities: live.host.capabilities },
      { hostId: 'remote-host', connected: true, models: [shared], capabilities: live.host.capabilities },
    ] }
    writeShellCache(live)
    expect(readShellCache()!.host.models.map(entry => entry.id)).toEqual(['claude:local', shared.id])
  })
})

describe('a shell held for its frame', () => {
  it('commits before a command response, so the older shell never lands after it', async () => {
    const wire = shellBridge(fullState([thread('workshop', [])], 'workshop'))
    const { result } = renderHook(() => useAgentConnection(wire.bridge))
    await waitFor(() => expect(result.current.state).not.toBeNull())
    // The shell arrives and is held for the frame; the command that follows answers before the frame fires.
    act(() => { wire.publish({ ...fullState([thread('workshop', [])], 'workshop'), notice: 'from the shell' }) })
    expect(result.current.state?.notice).not.toBe('from the shell')
    vi.mocked(wire.bridge.command).mockResolvedValueOnce({ ...fullState([thread('workshop', [])], 'workshop'), notice: 'from the command' })
    await act(async () => { await result.current.command({ type: 'configure', patch: { orbColor: 'amber' } }) })
    expect(result.current.state?.notice).toBe('from the command')
    await new Promise(resolve => requestAnimationFrame(resolve))
    await act(async () => undefined)
    expect(result.current.state?.notice).toBe('from the command')
  })
})

describe('shell updates while the main window is hidden', () => {
  it('delivers a widget mute without waiting for a suspended animation frame', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    const initial = fullState([])
    const wire = shellBridge(initial)
    const { result } = renderHook(() => useAgentConnection(wire.bridge))
    await waitFor(() => expect(result.current.state).not.toBeNull())
    act(() => wire.publish({ ...initial, voice: { ...initial.voice, action: 'mute', revision: 1 } }))
    expect(result.current.state?.voice.action).toBe('mute')
    expect(frame).not.toHaveBeenCalled()
  })

  it('flushes a pending shell when hidden and resumes batching when shown', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')
    const initial = fullState([])
    const wire = shellBridge(initial)
    const { result } = renderHook(() => useAgentConnection(wire.bridge))
    await waitFor(() => expect(result.current.state).not.toBeNull())
    act(() => wire.publish({ ...initial, notice: 'pending' }))
    expect(result.current.state?.notice).toBe('')
    act(() => {
      hidden.mockReturnValue(true)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current.state?.notice).toBe('pending')
    expect(cancel).toHaveBeenCalledWith(1)
    act(() => wire.publish({ ...initial, notice: 'hidden' }))
    expect(result.current.state?.notice).toBe('hidden')
    act(() => {
      hidden.mockReturnValue(false)
      document.dispatchEvent(new Event('visibilitychange'))
      wire.publish({ ...initial, notice: 'visible' })
    })
    expect(result.current.state?.notice).toBe('hidden')
    act(() => wire.emit({ threadId: 'workshop', revision: 1, messages: [] }))
    expect(result.current.state?.notice).toBe('visible')
  })

  it('cancels the pending frame and visibility listener on unmount', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(7)
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    const initial = fullState([])
    const wire = shellBridge(initial)
    const { result, unmount } = renderHook(() => useAgentConnection(wire.bridge))
    await waitFor(() => expect(result.current.state).not.toBeNull())
    act(() => wire.publish({ ...initial, notice: 'pending' }))
    const listener = add.mock.calls.find(([event]) => event === 'visibilitychange')?.[1]
    expect(listener).toBeTypeOf('function')
    unmount()
    expect(cancel).toHaveBeenCalledWith(7)
    expect(remove).toHaveBeenCalledWith('visibilitychange', listener)
  })
})

describe('a sync command reply racing a low-priority broadcast', () => {
  it('is not overtaken once its transition finally catches up', async () => {
    // Hidden, a broadcast commits directly as a transition (no frame holds it). Publishing it here does
    // not await React's own scheduling of that low-priority work, so it is still unsettled — exactly
    // like the real Scheduler, which runs it on its own macrotask — when the command below replies.
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    const initial = fullState([thread('workshop', [])], 'workshop')
    const wire = shellBridge(initial)
    const { result } = renderHook(() => useAgentConnection(wire.bridge))
    await waitFor(() => expect(result.current.state).not.toBeNull())
    let resolveCommand!: (state: AgentState) => void
    vi.mocked(wire.bridge.command).mockImplementationOnce(() => new Promise(resolve => { resolveCommand = resolve }))
    wire.publish({ ...initial, notice: 'from the broadcast' })
    // `refresh` is a provider operation and runs at once rather than waiting behind the command lane,
    // so `bridge.command` (and `resolveCommand`) is called synchronously here.
    const sending = result.current.command({ type: 'refresh' })
    resolveCommand({ ...initial, notice: 'from the command' })
    // The command's reply is urgent: it lands as soon as its own promise settles.
    await act(async () => { await sending })
    expect(result.current.state?.notice).toBe('from the command')
    // Give the older broadcast's transition every chance to run its own render; React replays the
    // whole update queue in call order whenever it does, so the later, urgent call still wins.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    expect(result.current.state?.notice).toBe('from the command')
  })
})

it('keeps monitoring on the live shell but never caches or restores it', () => {
  const watched = thread('workshop', [])
  watched.monitoring = [{ id: '56d13d2c-f6d0-4968-a9ed-18c87a7d5b5a', label: 'Watch only while connected' }]
  const live = fullState([watched])
  expect(agentShell(live).host.threads[0]!.monitoring).toEqual(watched.monitoring)
  writeShellCache(live)
  expect(localStorage.getItem(SHELL_CACHE_KEY)).not.toContain('Watch only while connected')
  expect(readShellCache()!.host.threads[0]!.monitoring).toBeUndefined()
  // An older cache or a manually copied live shell cannot resurrect an observation either.
  localStorage.setItem(SHELL_CACHE_KEY, JSON.stringify(agentShell(live)))
  expect(readShellCache()!.host.threads[0]!.monitoring).toBeUndefined()
  expect(watched.monitoring).toHaveLength(1)
})

it('keeps background work on the live shell but never caches or restores it', () => {
  const working = thread('workshop', [])
  working.backgroundWork = [{ id: '0d5c4b7e-3f5a-4f0e-8a51-2b8f1c9d7e60', label: 'Agent only while connected', type: 'workflow' }]
  const live = fullState([working])
  expect(agentShell(live).host.threads[0]!.backgroundWork).toEqual(working.backgroundWork)
  writeShellCache(live)
  expect(localStorage.getItem(SHELL_CACHE_KEY)).not.toContain('Agent only while connected')
  expect(readShellCache()!.host.threads[0]!.backgroundWork).toBeUndefined()
  localStorage.setItem(SHELL_CACHE_KEY, JSON.stringify(agentShell(live)))
  expect(readShellCache()!.host.threads[0]!.backgroundWork).toBeUndefined()
  expect(working.backgroundWork).toHaveLength(1)
})
