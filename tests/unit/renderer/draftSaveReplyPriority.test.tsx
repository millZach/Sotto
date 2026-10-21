import { threadsStateFixture } from '../../fixtures/agentState'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAgentConnection } from '../../../src/renderer/src/agents/AgentContext'
import { agentShell, defaultAgentConfiguration, EMPTY_AGENT_HOST, type AgentBridge, type AgentState, type AgentThread } from '../../../src/shared/agents'

// Every low-priority commit the window makes goes through React's startTransition; counting the calls counts them.
const transitions = vi.hoisted(() => ({ count: 0 }))
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  const startTransition: typeof actual.startTransition = scope => { transitions.count++; actual.startTransition(scope) }
  return { ...actual, default: { ...actual, startTransition }, startTransition }
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const thread = (id: string, title = id): AgentThread => ({ id, title, projectId: 'project', modelId: 'claude:test', status: 'idle', messages: [], requests: [] })

function state(threads: AgentThread[]): AgentState {
  return threadsStateFixture({ cloneOverrides: false,
    configuration: { ...defaultAgentConfiguration(), enabled: true },
    host: { ...EMPTY_AGENT_HOST, connected: true, threads },
    topLevel: { activeThreadId: 'workshop', activeProjectId: null, draftAttachments: [], credentials: { reasoning: false, secure: false }, historyEnabled: true } })
}

/**
 * October 20, 2026: with a few hundred threads, every reply main sent to a draft save committed urgently, a
 * synchronous render of the whole sidebar (60-70 ms) once per pause in typing, which the next key waited behind.
 * A save is the composer's own bookkeeping, not an action the user watches land, so its reply commits as a
 * transition the next keystroke can interrupt. Counted, not timed: urgent commits per save must be zero.
 */
describe('a draft save reply', () => {
  async function connect(reply: AgentState) {
    const initial = state([thread('workshop'), thread('docs')])
    const command = vi.fn(async () => agentShell(reply))
    const bridge: AgentBridge = { get: async () => agentShell(initial), command, onState: () => () => undefined }
    const hook = renderHook(() => useAgentConnection(bridge))
    await waitFor(() => expect(hook.result.current.state).not.toBeNull())
    return hook
  }

  it('commits as a transition, never ahead of a keystroke', async () => {
    const saved = state([thread('workshop', 'saved'), thread('docs')])
    const { result } = await connect(saved)
    const before = transitions.count
    await act(async () => {
      await result.current.command({ type: 'save-thread-draft', composer: 'manual', threadId: 'workshop', draftId: crypto.randomUUID(), text: 'typed' })
    })
    await waitFor(() => expect(result.current.state?.host.threads[0]!.title).toBe('saved'))
    // One transition for the reply; an urgent commit would have made none.
    expect(transitions.count - before).toBe(1)
  })

  it('leaves an action the user watches urgent', async () => {
    const refreshed = state([thread('workshop', 'refreshed'), thread('docs')])
    const { result } = await connect(refreshed)
    const before = transitions.count
    await act(async () => { await result.current.command({ type: 'refresh' }) })
    expect(result.current.state?.host.threads[0]!.title).toBe('refreshed')
    expect(transitions.count - before).toBe(0)
  })
})
