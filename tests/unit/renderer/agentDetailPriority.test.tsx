import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Arriving history commits as a transition so a long transcript never sits in front of a keystroke. The first
 * words of a message in the thread on screen are the exception: that is the moment the user is waiting for (#771).
 */
const transitions = vi.hoisted(() => ({ count: 0 }))
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>()
  return { ...react, startTransition: (run: () => void) => { transitions.count += 1; react.startTransition(run) } }
})

import { useAgentConnection } from '../../../src/renderer/src/agents/AgentContext'
import { agentShell, defaultAgentConfiguration, EMPTY_AGENT_HOST, type AgentBridge, type AgentMessage, type AgentState,
  type AgentThread, type AgentThreadDetailUpdate } from '../../../src/shared/agents'

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

const message = (id: string, role: AgentMessage['role'], text: string): AgentMessage => ({ id, role, text, createdAt: '2026-10-06T00:00:00.000Z' })
const thread = (id: string, messages: AgentMessage[]): AgentThread => ({ id, title: id, projectId: 'project', modelId: 'claude:test', status: 'running', messages, requests: [] })

function state(threads: AgentThread[], activeThreadId: string): AgentState {
  return {
    configuration: { ...defaultAgentConfiguration(), enabled: true }, connection: 'connected',
    host: { ...EMPTY_AGENT_HOST, connected: true, threads },
    assignments: [], queue: [], activeThreadId, activeProjectId: null, draft: '', draftThreadId: null, composing: false,
    draftRequestId: null, draftAttachments: [], deliveredDrafts: [], threadDrafts: [], deliveries: [], pendingRequest: '',
    globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' },
    voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: false }, reasoningAccounts: [], historyEnabled: true,
  }
}

function bridgeFor(initial: AgentState) {
  const detailListeners = new Set<(update: AgentThreadDetailUpdate) => void>()
  const bridge: AgentBridge = {
    get: async () => agentShell(initial),
    command: vi.fn(async () => agentShell(initial)),
    onState: () => () => undefined,
    threadDetail: async threadId => ({ threadId, revision: 1, messages: initial.host.threads.find(item => item.id === threadId)!.messages }),
    onThreadDetail: listener => { detailListeners.add(listener); return () => detailListeners.delete(listener) },
  }
  return { bridge, emit: (update: AgentThreadDetailUpdate) => { for (const listener of detailListeners) listener(update) } }
}

describe('a detail arriving for the thread on screen', () => {
  it('commits a message’s first words urgently and the chunks after them as transitions', async () => {
    const initial = state([thread('workshop', [message('prompt', 'user', 'Which colour?')]), thread('docs', [message('d', 'user', 'Draft')])], 'workshop')
    const wire = bridgeFor(initial)
    const { result } = renderHook(() => useAgentConnection(wire.bridge))
    await waitFor(() => expect(result.current.state?.host.threads[0]!.messages).toHaveLength(1))

    transitions.count = 0
    act(() => { wire.emit({ threadId: 'workshop', baseRevision: 1, revision: 2, messageDeltas: [{ message: message('reply', 'assistant', 'Ind') }], activityDeltas: [] }) })
    expect(transitions.count).toBe(0)
    expect(result.current.state?.host.threads[0]!.messages.at(-1)?.text).toBe('Ind')

    act(() => { wire.emit({ threadId: 'workshop', baseRevision: 2, revision: 3, messageDeltas: [{ id: 'reply', appendText: 'igo' }], activityDeltas: [] }) })
    expect(transitions.count).toBe(1)
    await waitFor(() => expect(result.current.state?.host.threads[0]!.messages.at(-1)?.text).toBe('Indigo'))
  })

  it('commits a new message in a thread that is not on screen as a transition', async () => {
    const initial = state([thread('workshop', [message('prompt', 'user', 'Which colour?')]), thread('docs', [message('d', 'user', 'Draft')])], 'workshop')
    const wire = bridgeFor(initial)
    const { result } = renderHook(() => useAgentConnection(wire.bridge))
    await waitFor(() => expect(result.current.state?.host.threads[0]!.messages).toHaveLength(1))
    act(() => { result.current.command({ type: 'observe-threads', threadIds: ['workshop', 'docs'] }) })
    await waitFor(() => expect(result.current.state?.host.threads[1]!.messages).toHaveLength(1))

    transitions.count = 0
    act(() => { wire.emit({ threadId: 'docs', baseRevision: 1, revision: 2, messageDeltas: [{ message: message('reply', 'assistant', 'Sure') }], activityDeltas: [] }) })
    expect(transitions.count).toBe(1)
  })
})
