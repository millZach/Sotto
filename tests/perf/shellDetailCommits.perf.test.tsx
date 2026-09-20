import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useAgentConnection } from '../../src/renderer/src/agents/AgentContext'
import { agentShell, defaultAgentConfiguration, EMPTY_AGENT_HOST,
  type AgentBridge, type AgentMessage, type AgentState, type AgentThread, type AgentThreadDetailUpdate } from '../../src/shared/agents'

/**
 * How many times the window commits for one streamed chunk. Main sends the shell (every thread's
 * summary) and the open thread's detail delta as two IPC messages, so they reach the window in two
 * tasks. While the reply is still shorter than the summary excerpt, the shell changes on every chunk
 * too. This measures the commits per chunk for each arrival order, so the order main sends in is a
 * measured choice rather than an assumed one.
 */

afterEach(() => { cleanup(); localStorage.clear() })

const CHUNKS = 20
const chunkText = (index: number): string => `word${index} `

const message = (id: string, role: AgentMessage['role'], text: string): AgentMessage =>
  ({ id, role, text, createdAt: '2026-01-01T00:00:00.000Z' })

function thread(id: string, messages: AgentMessage[]): AgentThread {
  return { id, title: id, projectId: 'project', modelId: 'claude:test', status: 'running', messages, requests: [] }
}

function fullState(threads: AgentThread[], activeThreadId: string): AgentState {
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

function wire(initial: AgentState) {
  let state = initial
  const listeners = new Set<(state: AgentState) => void>()
  const detailListeners = new Set<(update: AgentThreadDetailUpdate) => void>()
  const bridge: AgentBridge = {
    get: async () => agentShell(state),
    command: async () => agentShell(state),
    onState: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    threadDetail: async threadId => {
      const found = state.host.threads.find(item => item.id === threadId)
      return found === undefined ? null : { threadId, revision: 1, messages: found.messages }
    },
    onThreadDetail: listener => { detailListeners.add(listener); return () => detailListeners.delete(listener) },
  }
  return {
    bridge,
    shell: (next: AgentState) => { state = next; for (const listener of listeners) listener(agentShell(next)) },
    delta: (update: AgentThreadDetailUpdate) => { for (const listener of detailListeners) listener(update) },
  }
}

async function commitsPerChunk(order: 'shell-then-detail' | 'detail-then-shell'): Promise<number> {
  const reply = message('reply', 'assistant', '')
  const messages = [message('prompt', 'user', 'Describe the workspace.'), reply]
  const link = wire(fullState([thread('workshop', messages), thread('docs', [])], 'workshop'))
  let renders = 0
  const { result } = renderHook(() => { renders += 1; return useAgentConnection(link.bridge) })
  await waitFor(() => expect(result.current.state?.host.threads[0]?.messages).toHaveLength(2))
  // Settle everything the first arrival caused before counting.
  await act(async () => { await Promise.resolve() })
  const before = renders
  let text = ''
  for (let index = 0; index < CHUNKS; index += 1) {
    const chunk = chunkText(index)
    text += chunk
    const grown = fullState([thread('workshop', [messages[0]!, { ...reply, text }]), thread('docs', [])], 'workshop')
    const delta: AgentThreadDetailUpdate = { threadId: 'workshop', baseRevision: index + 1, revision: index + 2, messageDeltas: [{ id: 'reply', appendText: chunk }], activityDeltas: [] }
    // Each arrival is its own IPC message, so each is its own task and its own act().
    if (order === 'shell-then-detail') { act(() => link.shell(grown)); act(() => link.delta(delta)) }
    else { act(() => link.delta(delta)); act(() => link.shell(grown)) }
  }
  expect(result.current.state?.host.threads[0]?.messages[1]?.text).toBe(text)
  return (renders - before) / CHUNKS
}

describe('commits per streamed chunk', () => {
  it('reports how many times the window commits for one chunk in each arrival order', async () => {
    const shellFirst = await commitsPerChunk('shell-then-detail')
    cleanup(); localStorage.clear()
    const detailFirst = await commitsPerChunk('detail-then-shell')
    console.info(`shell+detail commits per chunk: ${JSON.stringify({ shellFirst, detailFirst })}`)
    // Main sends the shell first; detail-first is the fixture's order, and its 1 is the next chunk's detail committing the held shell.
    // Whatever the order, the text on screen is complete and every chunk costs at least one commit.
    expect(shellFirst).toBeGreaterThanOrEqual(1)
    expect(detailFirst).toBeGreaterThanOrEqual(1)
  })

  it('commits once per chunk when the shell arrives before the detail', async () => {
    // act() flushes React work but not rAF, so the held shell is still pending when the delta lands.
    expect(await commitsPerChunk('shell-then-detail')).toBe(1)
  })

  it('commits a shell that no detail follows within its frame', async () => {
    const initial = fullState([thread('workshop', [message('prompt', 'user', 'Hi')])], 'workshop')
    const link = wire(initial)
    const { result } = renderHook(() => useAgentConnection(link.bridge))
    await waitFor(() => expect(result.current.state?.host.threads).toHaveLength(1))
    // Only the notice changed: no detail follows this shell, so the frame itself must commit it.
    act(() => link.shell({ ...initial, notice: 'Standalone notice' }))
    await waitFor(() => expect(result.current.state?.notice).toBe('Standalone notice'))
  })
})
