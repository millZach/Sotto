import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAgentConnection } from '../../../src/renderer/src/agents/AgentContext'
import { SHELL_CACHE_KEY, cacheableShell, readShellCache, writeShellCache } from '../../../src/renderer/src/agents/shellCache'
import { agentShell, defaultAgentConfiguration, EMPTY_AGENT_HOST, summarizeThread,
  type AgentBridge, type AgentMessage, type AgentState, type AgentThread, type AgentThreadDetail,
  type AgentThreadDetailUpdate } from '../../../src/shared/agents'

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

const message = (id: string, role: AgentMessage['role'], text: string): AgentMessage =>
  ({ id, role, text, createdAt: `2026-01-0${id.length}T00:0${id.length}:00.000Z` })

function thread(id: string, messages: AgentMessage[]): AgentThread {
  return { id, title: id, projectId: 'project', modelId: 'claude:test', status: 'idle', messages, requests: [] }
}

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
