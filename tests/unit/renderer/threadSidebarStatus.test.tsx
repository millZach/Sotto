import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { forgetFinishedUnseen } from '../../../src/renderer/src/agents/ThreadSidebar'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { describeThreads, workingLabel } from '../../../src/renderer/src/agents/threadFacts'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW

const status = (title: string): HTMLElement => screen.getByRole('button', { name: title }).querySelector('.thread-nav__status')!
const clock = (title: string): HTMLElement => screen.getByRole('button', { name: title }).querySelector('.thread-nav__time')!
const rowFor = (state: AgentState, threadId: string, now = NOW) => describeThreads(state, now).find(row => row.thread.id === threadId)!
const withStatus = (state: AgentState, threadId: string, threadStatus: 'idle' | 'running'): Partial<AgentState> =>
  ({ host: { ...state.host, threads: state.host.threads.map(thread => thread.id === threadId ? { ...thread, status: threadStatus } : thread) } })

/** The fixture's pending permission, rewritten as the provider's question on the same thread. */
function asQuestion(state: AgentState): AgentState {
  const thread = state.host.threads.find(entry => entry.id === 'visual-gate')!
  thread.requests = [{ id: 'visual-gate-question', kind: 'question', text: 'Which report should I keep?', options: [] }]
  state.queue = [{ ...state.queue[0]!, id: 'visual-gate:visual-gate-question:question', kind: 'question', requestId: 'visual-gate-question', text: 'Which report should I keep?' }]
  return state
}

/** A frozen clock (`NOW`) renders the row as a capture run would; `undefined` lets the working row tick. */
function mount(state: AgentState, now: number | undefined) {
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView onOpenAgents={vi.fn()} now={now} />)
  return live
}

beforeEach(() => { vi.mocked(useAgents).mockReset(); forgetFinishedUnseen() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('a row that needs you says what it needs', () => {
  it('tells a permission to allow or deny from a question to answer', () => {
    expect(rowFor(threadsStateFixture(), 'visual-gate')).toMatchObject({ state: 'needs', waitingFor: 'approval', stateLabel: 'Needs your approval' })
    expect(rowFor(asQuestion(threadsStateFixture()), 'visual-gate')).toMatchObject({ state: 'needs', waitingFor: 'question', stateLabel: 'Needs your answer' })
  })

  it('keeps the older wording where nothing is pending but you are still needed', () => {
    const blocked = threadsStateFixture()
    blocked.host.threads.find(thread => thread.id === 'visual-gate')!.requests = []
    blocked.queue = [{ id: 'footer-links:blocked', threadId: 'footer-links', kind: 'blocked', text: 'Scope changed. Decide whether to keep going.', createdAt: new Date(NOW).toISOString(), deferred: false }]
    expect(rowFor(blocked, 'footer-links')).toMatchObject({ state: 'needs', waitingFor: null, stateLabel: 'Waiting on you' })
    const failed = threadsStateFixture()
    failed.queue = []
    failed.host.threads.find(thread => thread.id === 'visual-gate')!.requests = []
    failed.host.threads.find(thread => thread.id === 'weekly-note')!.status = 'error'
    expect(rowFor(failed, 'weekly-note')).toMatchObject({ state: 'needs', waitingFor: null, stateLabel: 'Needs attention' })
  })

  it('marks the dot in the sidebar and keeps the disconnected suffix', () => {
    const state = threadsStateFixture(); state.host.connected = false
    mount(state, NOW)
    expect(status('Visual gate flake')).toHaveTextContent('Needs your approval · Disconnected')
    expect(status('Visual gate flake')).toHaveAttribute('data-waiting', 'approval')
    expect(status('Visual gate flake')).toHaveAttribute('data-state', 'needs')
    cleanup()
    mount(asQuestion(threadsStateFixture()), NOW)
    expect(status('Visual gate flake')).toHaveTextContent('Needs your answer')
    expect(status('Visual gate flake')).toHaveAttribute('data-waiting', 'question')
  })
})

describe('a working row counts up', () => {
  it('ticks every second without re-rendering the sidebar, and leaves idle rows on the coarse clock', () => {
    const state = threadsStateFixture()
    const since = rowFor(state, 'footer-links').workingSince
    vi.useFakeTimers()
    vi.setSystemTime(since + 5_000)
    mount(state, undefined)
    expect(clock('Footer links')).toHaveTextContent('5s')
    const renders = vi.mocked(useAgents).mock.calls.length
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(clock('Footer links')).toHaveTextContent('7s')
    expect(vi.mocked(useAgents).mock.calls.length).toBe(renders)
    // A row that is not working says nothing at its right end: the clock belongs to the run in progress. Its
    // last-activity time is still there for assistive technology, inside the hidden status sentence.
    const idle = screen.getByRole('button', { name: 'Grok voice previews' })
    expect(idle.querySelector(':scope > .thread-nav__time')).toBeNull()
    expect(idle.querySelector('.thread-nav__status .thread-nav__time')).toHaveAttribute('datetime')
  })

  it('reads the run from the provider’s running turn when it reported one, otherwise from your prompt', () => {
    const state = threadsStateFixture()
    const thread = state.host.threads.find(entry => entry.id === 'footer-links')!
    expect(rowFor(state, 'footer-links').workingSince).toBe(Date.parse(thread.messages.find(message => message.role === 'user')!.createdAt))
    thread.activities = [{ id: 'turn', turnId: 'turn', kind: 'turn', sequence: 1, status: 'running', title: 'Turn', startedAt: new Date(NOW - 90_000).toISOString(), createdAt: new Date(NOW - 90_000).toISOString() }]
    expect(rowFor(state, 'footer-links')).toMatchObject({ workingSince: NOW - 90_000, when: '1m 30s' })
    expect(workingLabel(NOW - 45_000, NOW)).toBe('45s')
    expect(workingLabel(NOW - 3_930_000, NOW)).toBe('1h 05m')
    expect(workingLabel(Number.NaN, NOW)).toBe('')
  })
})

describe('a thread that finishes out of sight', () => {
  it('says it just finished until the thread is opened', () => {
    const state = threadsStateFixture()
    const live = mount(state, NOW)
    expect(status('Footer links')).toHaveTextContent('Working')
    act(() => { live.publish(withStatus(live.state, 'footer-links', 'idle')) })
    expect(status('Footer links')).toHaveTextContent('Just finished')
    expect(status('Footer links')).toHaveAttribute('data-unseen', 'true')
    act(() => { live.publish({ activeThreadId: 'footer-links' }) })
    expect(status('Footer links')).toHaveTextContent('Done')
    expect(status('Footer links')).not.toHaveAttribute('data-unseen')
    // Working again clears it too, and finishing while you are reading the thread never marks it.
    act(() => { live.publish(withStatus(live.state, 'footer-links', 'running')) })
    act(() => { live.publish(withStatus(live.state, 'footer-links', 'idle')) })
    expect(status('Footer links')).toHaveTextContent('Done')
  })

  it('never marks the thread you are looking at, whichever way it finishes', () => {
    const state = threadsStateFixture(); state.activeThreadId = 'weekly-note'
    const live = mount(state, NOW)
    act(() => { live.publish(withStatus(live.state, 'weekly-note', 'idle')) })
    expect(status('Weekly note')).toHaveTextContent('Done')
    expect(status('Weekly note')).not.toHaveAttribute('data-unseen')
    // Leaving for another thread does not make the finish unseen after the fact.
    act(() => { live.publish({ activeThreadId: 'visual-gate' }) })
    expect(status('Weekly note')).toHaveTextContent('Done')
  })
})
