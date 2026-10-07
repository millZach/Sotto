import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

// Early start (#769): the first keystroke in a thread's composer asks main to start the thread's provider session.
const THREAD = 'grok-previews'

function mount(open: boolean) {
  const state: AgentState = threadsStateFixture()
  state.assignments = []
  state.activeThreadId = THREAD
  state.host = { ...state.host, threads: state.host.threads.map(thread => thread.id === THREAD ? { ...thread, status: 'idle' as const, ...(open ? { providerSessionOpen: true as const } : {}) } : thread) }
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView onOpenAgents={vi.fn()} now={E2E_THREADS_NOW} />)
  const prompt = () => screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement
  const type = (text: string) => { for (let end = 1; end <= text.length; end++) fireEvent.change(prompt(), { target: { value: text.slice(0, end) } }) }
  const starts = () => live.command.mock.calls.map(([request]) => request).filter(request => request.type === 'start-thread-session')
  /** Main publishes the thread's provider session as open, or as stopped. */
  const session = (opened: boolean) => act(() => {
    live.publish({ host: { ...live.state.host, threads: live.state.host.threads.map(thread => {
      if (thread.id !== THREAD) return thread
      const { providerSessionOpen, ...rest } = thread; void providerSessionOpen
      return opened ? { ...rest, providerSessionOpen: true as const } : rest
    }) } })
  })
  return { live, prompt, type, starts, session }
}

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(() => { cleanup() })

describe('early start from the composer', () => {
  it('asks once for a stopped session however many keys are typed', () => {
    const { type, starts } = mount(false)
    type('Look at the failing test')
    expect(starts()).toEqual([{ type: 'start-thread-session', threadId: THREAD }])
  })

  it('asks for no session that is already open', () => {
    const { type, starts } = mount(true)
    type('Look at the failing test')
    expect(starts()).toEqual([])
  })

  it('asks again once a session it saw open has stopped, and only once', () => {
    const { type, starts, session } = mount(false)
    type('First')
    expect(starts()).toHaveLength(1)
    session(true)
    type('First and more')
    expect(starts()).toHaveLength(1)
    // The reaper stopped it, or it ended: the next keystroke asks again.
    session(false)
    type('First and more, later')
    expect(starts()).toHaveLength(2)
    expect(starts()[1]).toEqual({ type: 'start-thread-session', threadId: THREAD })
  })

  it('does not ask again for a session that never opened', () => {
    const { prompt, type, starts } = mount(false)
    type('One')
    fireEvent.change(prompt(), { target: { value: '' } })
    type('Two')
    expect(starts()).toHaveLength(1)
  })
})
