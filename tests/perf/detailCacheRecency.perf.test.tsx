import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useAgentConnection } from '../../src/renderer/src/agents/AgentContext'
import { approximateDetailBytes } from '../../src/renderer/src/agents/detailCacheSize'
import { agentShell, defaultAgentConfiguration, EMPTY_AGENT_HOST,
  type AgentBridge, type AgentMessage, type AgentState, type AgentThread, type AgentThreadDetail, type AgentThreadDetailUpdate } from '../../src/shared/agents'

/**
 * Which history the window drops when it must drop one, over a scripted session. The window holds 16
 * histories. Each round the user comes back to the thread they work in, opens a thread the window does
 * not hold, and watches 20 shells arrive while fourteen other threads stream. The count is how often
 * coming back to the working thread had to fetch its history again. Every message is filler, so the
 * byte figure describes the synthetic histories, not anyone's real ones.
 */

afterEach(() => { cleanup(); localStorage.clear() })

const THREADS = 28
const HELD = 16
const ROUNDS = 8
const SHELLS_PER_ROUND = 20
const MESSAGES_PER_THREAD = 30
const filler = (index: number): string => `word${index} `.repeat(60)

const ids = Array.from({ length: THREADS }, (_, index) => `t${String(index).padStart(2, '0')}`)
const history = (id: string, extra = ''): AgentMessage[] => Array.from({ length: MESSAGES_PER_THREAD }, (_, index) => ({
  id: `${id}-m${index}`, role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
  text: filler(index) + (index === MESSAGES_PER_THREAD - 1 ? extra : ''), createdAt: '2026-01-01T00:00:00.000Z',
}))

function fullState(threads: AgentThread[], notice = ''): AgentState {
  return {
    configuration: { ...defaultAgentConfiguration(), enabled: true }, connection: 'connected',
    host: { ...EMPTY_AGENT_HOST, connected: true, threads },
    assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false,
    draftRequestId: null, draftAttachments: [], deliveredDrafts: [], threadDrafts: [], deliveries: [], pendingRequest: '',
    globalLaneBusy: false, notice, error: null, speech: { id: 0, text: '' },
    voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: false }, reasoningAccounts: [],
    membership: { status: 'beta', label: 'Test', expiresAt: null }, historyEnabled: true,
  }
}

function threadsAt(tick: number): AgentThread[] {
  // The working thread and the one beside it are quiet; the fourteen after them stream.
  return ids.map((id, index) => ({
    id, title: id, projectId: 'project', modelId: 'claude:test', requests: [],
    status: index >= 2 && index < HELD ? 'running' as const : 'idle' as const,
    messages: history(id, index >= 2 && index < HELD ? 'more '.repeat(tick) : ''),
  }))
}

function wire() {
  let state = fullState(threadsAt(0))
  const listeners = new Set<(state: AgentState) => void>()
  const detailListeners = new Set<(update: AgentThreadDetailUpdate) => void>()
  const revisions = new Map<string, number>()
  const requests = new Map<string, number>()
  const detailOf = (threadId: string): AgentThreadDetail | null => {
    const found = state.host.threads.find(item => item.id === threadId)
    return found === undefined ? null : { threadId, revision: revisions.get(threadId) ?? 1, messages: found.messages }
  }
  const bridge: AgentBridge = {
    get: async () => agentShell(state),
    command: async () => agentShell(state),
    onState: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    threadDetail: async threadId => { requests.set(threadId, (requests.get(threadId) ?? 0) + 1); return detailOf(threadId) },
    onThreadDetail: listener => { detailListeners.add(listener); return () => detailListeners.delete(listener) },
  }
  return {
    bridge, requests, detailOf,
    publish: (next: AgentState) => { state = next; for (const listener of listeners) listener(agentShell(next)) },
    push: (threadId: string) => {
      revisions.set(threadId, (revisions.get(threadId) ?? 1) + 1)
      const detail = detailOf(threadId)
      if (detail) for (const listener of detailListeners) listener(detail)
    },
  }
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

describe('the history cache over a session', () => {
  it('reports how often coming back to the working thread fetched its history again', async () => {
    const link = wire()
    const { result } = renderHook(() => useAgentConnection(link.bridge))
    await waitFor(() => expect(result.current.state).not.toBeNull())
    const held = (id: string): boolean => (result.current.state!.host.threads.find(item => item.id === id)?.messages.length ?? 0) > 0
    const view = async (id: string): Promise<void> => {
      await act(async () => { await result.current.command({ type: 'observe-threads', threadIds: [id] }) })
      await waitFor(() => expect(held(id)).toBe(true))
    }
    for (const id of ids.slice(0, HELD)) await view(id)
    const warm = link.requests.get('t00') ?? 0
    const shellTimes: number[] = []
    let tick = 0
    for (let round = 0; round < ROUNDS; round += 1) {
      await view('t00')
      await view(ids[HELD + round]!)
      for (let shell = 0; shell < SHELLS_PER_ROUND; shell += 1) {
        tick += 1
        const next = fullState(threadsAt(tick), `tick ${tick}`)
        // The previous held shell commits inside this publish: this is one shell's cost to the window.
        const started = performance.now()
        act(() => link.publish(next))
        shellTimes.push(performance.now() - started)
        // Two streaming threads have work in flight, so main pushes their history as it grows.
        if (shell % 5 === 0) act(() => { link.push('t02'); link.push('t03') })
      }
      await waitFor(() => expect(result.current.state!.notice).toBe(`tick ${tick}`))
    }
    await view('t00')
    const refetches = (link.requests.get('t00') ?? 0) - warm
    const heldIds = ids.filter(held)
    const details = heldIds.map(id => link.detailOf(id)!)
    const report = {
      returns: ROUNDS, refetches,
      requests: [...link.requests.values()].reduce((sum, count) => sum + count, 0),
      held: heldIds.length,
      approximateBytes: approximateDetailBytes(details),
      jsonBytes: details.reduce((sum, detail) => sum + JSON.stringify(detail).length, 0),
      medianShellMs: Number(median(shellTimes).toFixed(3)),
    }
    console.info(`history cache recency: ${JSON.stringify(report)}`)
    expect(report.held).toBe(HELD)
    // The thread the user keeps coming back to is the last one the window should give up.
    expect(refetches).toBe(0)
  })
})
