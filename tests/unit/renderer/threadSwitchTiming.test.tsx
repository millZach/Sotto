import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { threadsStateFixture } from '../../fixtures/agentState'
import { deferred } from '../../fixtures/deferred'
import { useAgentConnection } from '../../../src/renderer/src/agents/AgentContext'
import { agentShell, defaultAgentConfiguration, EMPTY_AGENT_HOST, type AgentBridge, type AgentCommand, type AgentMessage, type AgentState,
  type AgentThread, type AgentThreadDetail } from '../../../src/shared/agents'
import type { ThreadSwitchTiming } from '../../../src/shared/mainActivity'

const sotto = window as unknown as { sotto?: unknown }
afterEach(() => { cleanup(); delete sotto.sotto; document.body.innerHTML = ''; vi.restoreAllMocks() })

/** The window's animation frames, held until the test runs them, then the task after them. */
function frames() {
  const queued: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { queued.push(callback); return queued.length })
  return async (): Promise<void> => {
    await act(async () => {
      for (const callback of queued.splice(0)) callback(performance.now())
      // The clock's task after the frame was queued before this one, so it has run once this resolves.
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

const message = (id: string): AgentMessage => ({ id, role: 'assistant', text: `Reply ${id}`, createdAt: '2026-11-20T18:29:00.000Z' })
const thread = (id: string, messages: AgentMessage[]): AgentThread =>
  ({ id, title: id, projectId: 'project', modelId: 'claude:test', status: 'idle', messages, requests: [], summary: { messageCount: messages.length, activityCount: 0 } } as unknown as AgentThread)

function stateOf(threads: AgentThread[], activeThreadId: string | null): AgentState {
  return threadsStateFixture({ cloneOverrides: false, configuration: { ...defaultAgentConfiguration(), enabled: true },
    host: { ...EMPTY_AGENT_HOST, connected: true, threads },
    topLevel: { activeThreadId, activeProjectId: null, draftAttachments: [], credentials: { reasoning: false, secure: false }, historyEnabled: true } })
}

describe('timing a thread switch in the window', () => {
  it('hands main the switch once the thread is painted with its history, and nothing for the thread already shown', async () => {
    const reports: ThreadSwitchTiming[] = []
    sotto.sotto = { mainActivity: { reportThreadSwitch: (timing: ThreadSwitchTiming) => reports.push(timing) } }
    const threads = [thread('first', [message('a')]), thread('second', [message('b'), message('c')])]
    let state = stateOf(threads, 'first')
    const history = deferred<AgentThreadDetail | null>()
    const bridge: AgentBridge = {
      get: async () => agentShell(state),
      command: vi.fn(async (command: AgentCommand) => {
        if (command.type === 'select-thread') state = { ...state, activeThreadId: command.threadId }
        return agentShell(state)
      }),
      onState: () => () => undefined,
      threadDetail: vi.fn(async (threadId: string) => threadId === 'second' ? history.promise
        : { threadId, revision: 1, messages: threads.find(item => item.id === threadId)!.messages }),
      onThreadDetail: () => () => undefined,
    }
    // The switched-to thread's pane is on screen, as on the Threads page.
    document.body.innerHTML = '<div class="threads-view"><section class="thread-pane" data-thread-id="second"></section></div>'
    const paint = frames()
    const { result } = renderHook(() => useAgentConnection(bridge))
    await waitFor(() => { expect(result.current.state?.activeThreadId).toBe('first') })
    await act(async () => { await result.current.command({ type: 'select-thread', threadId: 'first' }) })
    await act(async () => { await result.current.command({ type: 'select-thread', threadId: 'second' }) })
    // The selection is drawn, and the thread shows as loading until its history comes.
    expect(result.current.state?.host.threads.find(item => item.id === 'second')?.historyStatus).toBe('loading')
    await paint()
    expect(reports).toEqual([])
    await act(async () => { history.resolve({ threadId: 'second', revision: 1, messages: threads[1]!.messages }) })
    await paint()
    expect(reports).toHaveLength(1)
    const [timing] = reports
    expect(timing).toMatchObject({ held: false, remote: false, messages: 2, activities: 0, threads: 2 })
    expect(timing!.replyMs).not.toBeNull()
    expect(timing!.replyMs!).toBeLessThanOrEqual(timing!.historyMs)
    expect(timing!.historyMs).toBeLessThanOrEqual(timing!.frameMs)
    expect(timing!.frameMs).toBeLessThanOrEqual(timing!.paintedMs)
    expect(timing!.commits).toBeGreaterThan(0)
  })

  it('counts only genuinely changed thread records after structural sharing and reports replyMs null when painted via broadcast first', async () => {
    const reports: ThreadSwitchTiming[] = []
    sotto.sotto = { mainActivity: { reportThreadSwitch: (timing: ThreadSwitchTiming) => reports.push(timing) } }
    const threads = [
      thread('first', [message('a')]),
      thread('second', [message('b')]),
      thread('third', [message('c')]),
      thread('fourth', [message('d')]),
    ]
    let state = stateOf(threads, 'first')
    let broadcast: ((next: AgentState) => void) | null = null
    const pendingReply = deferred<AgentState>()
    const bridge: AgentBridge = {
      get: async () => agentShell(state),
      command: vi.fn(async (command: AgentCommand) => {
        if (command.type === 'select-thread' && command.threadId === 'second') return pendingReply.promise
        if (command.type === 'select-thread') state = { ...state, activeThreadId: command.threadId }
        return agentShell(state)
      }),
      onState: listener => { broadcast = listener as (next: AgentState) => void; return () => { broadcast = null } },
      threadDetail: vi.fn(async (threadId: string) => ({ threadId, revision: 1, messages: threads.find(item => item.id === threadId)!.messages })),
      onThreadDetail: () => () => undefined,
    }
    document.body.innerHTML = '<div class="threads-view"><section class="thread-pane" data-thread-id="second"></section></div>'
    const paint = frames()
    const { result } = renderHook(() => useAgentConnection(bridge))
    await waitFor(() => { expect(result.current.state?.activeThreadId).toBe('first') })
    // Pre-hold `second`'s detail so the switch is `held: true`.
    await act(async () => { await result.current.command({ type: 'observe-threads', threadIds: ['first', 'second'] }) })

    // Switch to `second`: broadcast lands and paints BEFORE `command('select-thread')` resolves.
    let selection!: Promise<AgentState | null>
    act(() => { selection = result.current.command({ type: 'select-thread', threadId: 'second' }) })
    state = { ...state, activeThreadId: 'second' }
    await act(async () => { broadcast?.(agentShell(state)) })
    // First animation frame commits the pending shell broadcast; second paints the committed frame for the clock.
    await paint()
    await paint()

    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      held: true,
      replyMs: null,
      threads: 4,
      newThreadRecords: 0,
    })

    // Resolve the delayed reply cleanly.
    await act(async () => { pendingReply.resolve(agentShell(state)); await selection })
  })
})
