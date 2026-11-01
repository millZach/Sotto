/**
 * What the window commits while it is hidden (#993). Sixty broadcasts, as many as main sends in four seconds while a
 * thread streams, are handed one after another to the real agent connection with the window hidden, and React's commits
 * of the state are counted; then the window is shown. It counts commits and times nothing. Each commit drew the window
 * again for nobody: about 8 ms of renderer time per update by #993's estimate, and 3-23 ms in jsdom by
 * `threadsRender.perf.test.tsx`'s rows.
 *
 * The count is a CI guard, in the default suite. Run on `origin/main` it counts the "before".
 */
import React, { Profiler } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAgentConnection } from '../../src/renderer/src/agents/AgentContext'
import { agentShell, defaultAgentConfiguration, EMPTY_AGENT_HOST, type AgentBridge, type AgentState, type AgentThread } from '../../src/shared/agents'
import { threadsStateFixture } from '../fixtures/agentState'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const UPDATES = 60

/** The state after `text` streamed, its notice standing for what changed, since a shell broadcast carries no messages. */
function stateWith(text: string): AgentState {
  const streaming: AgentThread = { id: 'streaming', title: 'Streaming', projectId: 'project', modelId: 'claude:test', status: 'running',
    messages: [{ id: 'reply', role: 'assistant', text, createdAt: '2026-10-31T12:00:00.000Z' }], requests: [] }
  return threadsStateFixture({ cloneOverrides: false, configuration: { ...defaultAgentConfiguration(), enabled: true },
    host: { ...EMPTY_AGENT_HOST, connected: true, threads: [streaming] },
    topLevel: { activeThreadId: null, activeProjectId: null, draftAttachments: [], credentials: { reasoning: false, secure: false }, historyEnabled: true, notice: text } })
}

it('commits nothing while the window is hidden, and the newest state once when it is shown', async () => {
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  const listeners = new Set<(state: AgentState) => void>()
  let latest = stateWith('')
  const bridge: AgentBridge = {
    get: async () => agentShell(latest),
    command: vi.fn(async () => agentShell(latest)),
    onState: listener => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  let commits = 0
  let shown = ''
  function Window(): React.ReactNode {
    const connection = useAgentConnection(bridge)
    shown = connection.state?.notice ?? ''
    return null
  }
  render(<Profiler id="window" onRender={() => { commits++ }}><Window /></Profiler>)
  await waitFor(() => expect(shown).toBe(''))
  await act(async () => { await Promise.resolve() })
  commits = 0

  for (let update = 1; update <= UPDATES; update++) {
    latest = stateWith(`word `.repeat(update))
    act(() => { for (const listener of listeners) listener(agentShell(latest)) })
  }
  const whileHidden = commits
  act(() => { hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange')) })
  const onShow = commits - whileHidden
  console.info(`hidden window: ${JSON.stringify({ updates: UPDATES, commitsWhileHidden: whileHidden, commitsOnShow: onShow })}`)

  expect(whileHidden).toBe(0)
  expect(onShow).toBe(1)
  expect(shown).toBe('word '.repeat(UPDATES))
})
