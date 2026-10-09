import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentState } from '../../../src/shared/agents'
import type { AgentBackgroundWork } from '../../../src/shared/agentMonitoring'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { describeThreads, rowStatus, workingLabel } from '../../../src/renderer/src/agents/threadFacts'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW

const status = (title: string): HTMLElement => screen.getByRole('button', { name: title }).querySelector('.thread-nav__status')!
const clock = (title: string): HTMLElement => screen.getByRole('button', { name: title }).querySelector('.thread-nav__time')!
const rowFor = (state: AgentState, threadId: string, now = NOW) => describeThreads(state, now).find(row => row.thread.id === threadId)!
/** The thread as the host publishes it: idle or running, and marked finished-unread or not (ADR-0046). */
const withStatus = (state: AgentState, threadId: string, threadStatus: 'idle' | 'running', finishedUnread = false): Partial<AgentState> =>
  ({ host: { ...state.host, threads: state.host.threads.map(thread => {
    if (thread.id !== threadId) return thread
    const { finishedUnread: _mark, ...rest } = thread
    void _mark
    return { ...rest, status: threadStatus, ...(finishedUnread ? { finishedUnread: true as const } : {}) }
  }) } })

/** The fixture's pending permission, rewritten as the provider's question on the same thread. */
function asQuestion(state: AgentState): AgentState {
  const thread = state.host.threads.find(entry => entry.id === 'visual-gate')!
  thread.requests = [{ id: 'visual-gate-question', kind: 'question', text: 'Which report should I keep?', options: [] }]

  return state
}

/** A frozen clock (`NOW`) renders the row as a capture run would; `undefined` lets the working row tick. */
function mount(state: AgentState, now: number | undefined) {
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView now={now} />)
  return live
}

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('a row that needs you says what it needs', () => {
  it('tells a permission to allow or deny from a question to answer', () => {
    expect(rowFor(threadsStateFixture(), 'visual-gate')).toMatchObject({ state: 'needs', waitingFor: 'approval', stateLabel: 'Needs your approval' })
    expect(rowFor(asQuestion(threadsStateFixture()), 'visual-gate')).toMatchObject({ state: 'needs', waitingFor: 'question', stateLabel: 'Needs your answer' })
  })

  it('says so for a thread with no assignment, whose request never enters the attention queue', () => {
    // The coordinator queues only for threads with an assignment; the provider's request on the thread is what you answer.
    const unqueued = (state: AgentState): AgentState => {
        return state
    }
    expect(rowFor(unqueued(threadsStateFixture()), 'visual-gate')).toMatchObject({ state: 'needs', waitingFor: 'approval', stateLabel: 'Needs your approval',
      request: { kind: 'permission', requestId: 'visual-gate-permission' } })
    expect(rowFor(unqueued(asQuestion(threadsStateFixture())), 'visual-gate')).toMatchObject({ state: 'needs', waitingFor: 'question', stateLabel: 'Needs your answer',
      request: { kind: 'question', requestId: 'visual-gate-question' } })
    // The collapsed rail says the same thing in its title and its ring.
    // Collapsing is remembered, so the width record is cleared either side of the test, even when it fails.
    localStorage.removeItem('sotto.threadWorkspace.sidebar')
    try {
      mount(unqueued(asQuestion(threadsStateFixture())), NOW)
      expect(status('Visual gate flake')).toHaveTextContent('Needs your answer')
      expect(status('Visual gate flake')).toHaveAttribute('data-waiting', 'question')
      act(() => { screen.getByRole('button', { name: 'Collapse sidebar' }).click() })
      const rail = document.querySelector<HTMLElement>('.thread-nav__rail-thread[aria-label="Visual gate flake"]')!
      expect(rail).toHaveAttribute('title', 'Visual gate flake · Needs your answer')
      expect(rail.querySelector('.thread-nav__ring')).toHaveAttribute('data-state', 'needs')
      expect(rail.querySelector('.thread-nav__ring')).toHaveAttribute('data-waiting', 'question')
    } finally { localStorage.removeItem('sotto.threadWorkspace.sidebar') }
  })

  it('keeps the native question visible until the user answers', () => {
    const pending = asQuestion(threadsStateFixture())

    expect(rowFor(pending, 'visual-gate')).toMatchObject({ state: 'needs', waitingFor: 'question', stateLabel: 'Needs your answer',
      request: { kind: 'question', requestId: 'visual-gate-question' } })
  })

  it('keeps the older wording where nothing is pending but you are still needed', () => {
    const blocked = threadsStateFixture()
    blocked.host.threads.find(thread => thread.id === 'visual-gate')!.requests = []

    expect(rowFor(blocked, 'footer-links')).toMatchObject({ state: 'working', waitingFor: null, stateLabel: 'Working' })
    const failed = threadsStateFixture()

    failed.host.threads.find(thread => thread.id === 'visual-gate')!.requests = []
    failed.host.threads.find(thread => thread.id === 'weekly-note')!.status = 'error'
    expect(rowFor(failed, 'weekly-note')).toMatchObject({ state: 'needs', waitingFor: null, stateLabel: 'Needs attention' })
  })

  it('says a running compaction is compacting rather than letting it read as the agent working', () => {
    const state = threadsStateFixture()
    const thread = state.host.threads.find(entry => entry.id === 'footer-links')!
    thread.status = 'running'
    thread.compaction = { commandId: 'compact-1', status: 'running' }
    expect(rowFor(state, 'footer-links')).toMatchObject({ state: 'working', stateLabel: 'Compacting context' })
    // Unconfirmed is not the same as still going: the composer says so, the row does not claim it.
    thread.compaction = { commandId: 'compact-1', status: 'uncertain' }
    expect(rowFor(state, 'footer-links')).toMatchObject({ state: 'working', stateLabel: 'Working' })
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

  it('reads Reconnecting, not Disconnected, while the thread\'s host restarts for an update (ADR-0040)', () => {
    const state = threadsStateFixture()
    state.host.threads = state.host.threads.map(thread => thread.id === 'visual-gate' ? { ...thread, clientConnected: false, clientReconnecting: true } : thread)
    mount(state, NOW)
    expect(status('Visual gate flake')).toHaveTextContent('Needs your approval · Reconnecting')
    expect(status('Visual gate flake')).not.toHaveTextContent('Disconnected')
    expect(rowFor(state, 'visual-gate')).toMatchObject({ connected: false, reconnecting: true })
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
    // Last activity stays visible beside idle titles; only running clocks tick.
    const idle = screen.getByRole('button', { name: 'Grok voice previews' })
    expect(idle.querySelector(':scope > .thread-nav__time')).toHaveAttribute('datetime')
    expect(idle.querySelectorAll('.thread-nav__time')).toHaveLength(1)
  })

  it('reads the run from the provider’s running turn when it reported one, otherwise from your prompt', () => {
    const state = threadsStateFixture()
    const thread = state.host.threads.find(entry => entry.id === 'footer-links')!
    expect(rowFor(state, 'footer-links').workingSince).toBe(Date.parse(thread.messages.find(message => message.role === 'user')!.createdAt))
    thread.activities = [{ id: 'turn', turnId: 'turn', kind: 'turn', sequence: 1, status: 'running', title: 'Turn', startedAt: new Date(NOW - 90_000).toISOString() }]
    expect(rowFor(state, 'footer-links')).toMatchObject({ workingSince: NOW - 90_000, when: '1m 30s' })
    expect(workingLabel(NOW - 45_000, NOW)).toBe('45s')
    expect(workingLabel(NOW - 3_930_000, NOW)).toBe('1h 05m')
    expect(workingLabel(Number.NaN, NOW)).toBe('')
  })
})

// Whether a thread finished out of sight is the host's to say (ADR-0046, tests/unit/main/finishedUnread.test.ts);
// the sidebar reads the mark the host publishes and words it.
describe('a thread the host marks as finished and unread', () => {
  it('says it just finished while the host marks it, and Done once the mark is gone', () => {
    const live = mount(threadsStateFixture(), NOW)
    expect(status('Footer links')).toHaveTextContent('Working')
    act(() => { live.publish(withStatus(live.state, 'footer-links', 'idle')) })
    expect(status('Footer links')).toHaveTextContent('Done')
    expect(status('Footer links')).not.toHaveAttribute('data-unseen')
    act(() => { live.publish(withStatus(live.state, 'footer-links', 'idle', true)) })
    expect(status('Footer links')).toHaveTextContent('Just finished')
    expect(status('Footer links')).toHaveAttribute('data-unseen', 'true')
    const ring = screen.getByRole('button', { name: 'Footer links' }).querySelector('.thread-nav__ring')!
    expect(ring).toHaveAttribute('data-unseen', 'true')
    act(() => { live.publish(withStatus(live.state, 'footer-links', 'idle')) })
    expect(status('Footer links')).toHaveTextContent('Done')
    expect(status('Footer links')).not.toHaveAttribute('data-unseen')
  })

  it('says only what the thread is doing when the mark rides on a thread that is not done', () => {
    const live = mount(threadsStateFixture(), NOW)
    act(() => { live.publish(withStatus(live.state, 'footer-links', 'running', true)) })
    expect(status('Footer links')).toHaveTextContent('Working')
    expect(status('Footer links')).not.toHaveAttribute('data-unseen')
  })
})

describe('a thread whose turn ended with work still running', () => {
  const agent: AgentBackgroundWork = { id: 'build', label: 'Engine: engine:build2', type: 'workflow' }
  const command: AgentBackgroundWork = { id: 'serve', label: 'npm run dev', type: 'command' }
  const withWork = (state: AgentState, threadId: string, backgroundWork: AgentBackgroundWork[] | undefined): Partial<AgentState> =>
    ({ host: { ...state.host, threads: state.host.threads.map(thread => thread.id === threadId ? { ...thread, status: 'idle', backgroundWork } : thread) } })

  it('stays working until the agents it started report back, and a lone command is waited on', () => {
    const state = threadsStateFixture()
    const prompt = rowFor(state, 'footer-links').workingSince
    Object.assign(state, withWork(state, 'footer-links', [agent, command]))
    // The clock keeps counting from your prompt, so the row reads as one piece of work.
    expect(rowFor(state, 'footer-links')).toMatchObject({ state: 'working', stateLabel: 'Working', workingSince: prompt })
    Object.assign(state, withWork(state, 'footer-links', [command]))
    expect(rowFor(state, 'footer-links')).toMatchObject({ state: 'working', stateLabel: 'Waiting' })
    Object.assign(state, withWork(state, 'footer-links', undefined))
    expect(rowFor(state, 'footer-links')).toMatchObject({ state: 'done', stateLabel: 'Done' })
  })

  it('reads as working, not finished, while the work runs', () => {
    const live = mount(threadsStateFixture(), NOW)
    act(() => { live.publish(withWork(live.state, 'footer-links', [agent])) })
    expect(status('Footer links')).toHaveTextContent('Working')
    expect(status('Footer links')).toHaveAttribute('data-state', 'working')
    expect(status('Footer links')).not.toHaveAttribute('data-unseen')
  })
})


describe('sidebar working-copy context', () => {
  it('distinguishes a shared branch, detached checkout, pending worktree and failed setup', () => {
    const state = threadsStateFixture()
    const thread = state.host.threads.find(item => item.id === 'grok-previews')!
    thread.worktree = { mode: 'shared', status: 'ready', branch: 'main', path: '/project', repositoryRoot: '/project' }
    const live = mount(state, NOW)
    const button = () => screen.getByRole('button', { name: 'Grok voice previews' })
    expect(button().querySelector('.thread-nav__branch')).toHaveTextContent('main · Project folder')
    expect(button()).toHaveAccessibleDescription(/Sonnet 4.5, main, Project folder/)
    // Assert that the localized activity time is exposed, independent of the runner timezone.
    expect(button()).toHaveAccessibleDescription(`Claude,Done ${rowFor(state, thread.id).when} Sonnet 4.5, main, Project folder`)
    const update = (worktree: typeof thread.worktree) => act(() => live.publish({ host: { ...live.state.host, threads: live.state.host.threads.map(item => item.id === thread.id ? { ...item, worktree } : item) } }))
    update({ mode: 'independent', status: 'ready', path: '/checkout', repositoryRoot: '/checkout' })
    expect(button().querySelector('.thread-nav__branch')).toHaveTextContent('Detached HEAD · Worktree')
    expect(button().querySelector('.thread-nav__branch .lucide-git-branch')).not.toBeNull()
    update({ mode: 'independent', status: 'pending', branch: 'stale-branch' })
    expect(button().querySelector('.thread-nav__branch')).toHaveTextContent('New worktree pending')
    expect(button().querySelector('.thread-nav__branch .lucide-folder-git-2')).not.toBeNull()
    expect(button().querySelector('.thread-nav__branch')).not.toHaveTextContent('stale-branch')
    update({ mode: 'independent', status: 'error', branch: 'stale-branch', error: 'Folder moved' })
    expect(button().querySelector('.thread-nav__branch')).toHaveTextContent('Worktree not ready')
    expect(button().querySelector('.thread-nav__branch .lucide-folder-git-2')).not.toBeNull()
    expect(button().querySelector('.thread-nav__branch')).not.toHaveTextContent('stale-branch')
  })
})

// Babysitting is Sotto's claim, not the provider's (ADR-0061 decision 14): the row says it only where it would say Done.
describe('a thread that babysits a pull request', () => {
  const babysitting = [{ url: 'https://github.com/o/r/pull/74', number: 74, startedBy: 'agent' as const, startedAt: '2026-10-08T21:02:00.000Z' }]
  const babysat = (state: AgentState, threadId: string, threadStatus: 'idle' | 'running', finishedUnread = false, numbers = [74]): Partial<AgentState> => {
    const changed = withStatus(state, threadId, threadStatus, finishedUnread)
    return { host: { ...changed.host!, threads: changed.host!.threads.map(thread => thread.id === threadId
      ? { ...thread, babysitting: numbers.map(number => ({ ...babysitting[0]!, url: `https://github.com/o/r/pull/${number}`, number })) } : thread) } }
  }

  it('says Babysitting #74 where it would say Done, and gives way to Working and Just finished', () => {
    const live = mount(threadsStateFixture(), NOW)
    act(() => { live.publish(babysat(live.state, 'footer-links', 'idle')) })
    expect(status('Footer links')).toHaveTextContent('Babysitting #74')
    expect(status('Footer links')).toHaveAttribute('data-babysitting', 'true')
    expect(status('Footer links')).toHaveAttribute('data-state', 'done')
    act(() => { live.publish(babysat(live.state, 'footer-links', 'running')) })
    expect(status('Footer links')).toHaveTextContent('Working')
    expect(status('Footer links')).not.toHaveAttribute('data-babysitting')
    act(() => { live.publish(babysat(live.state, 'footer-links', 'idle', true)) })
    expect(status('Footer links')).toHaveTextContent('Just finished')
    act(() => { live.publish(babysat(live.state, 'footer-links', 'idle', false, [74, 76])) })
    expect(status('Footer links')).toHaveTextContent('Babysitting #74 and #76')
  })

  it('says the same in the collapsed rail, whose title would otherwise read Done', () => {
    // Collapsing is remembered, so the width record is cleared either side of the test, even when it fails.
    localStorage.removeItem('sotto.threadWorkspace.sidebar')
    try {
      const live = mount(threadsStateFixture(), NOW)
      act(() => { live.publish(babysat(live.state, 'footer-links', 'idle')) })
      act(() => { screen.getByRole('button', { name: 'Collapse sidebar' }).click() })
      const rail = document.querySelector<HTMLElement>('.thread-nav__rail-thread[aria-label="Footer links"]')!
      expect(rail).toHaveAttribute('title', 'Footer links · Babysitting #74')
      expect(rail).toHaveAccessibleDescription('Footer links · Babysitting #74')
      act(() => { live.publish(babysat(live.state, 'footer-links', 'idle', true)) })
      expect(rail).toHaveAttribute('title', 'Footer links · Just finished')
      act(() => { live.publish(babysat(live.state, 'footer-links', 'running')) })
      expect(rail).toHaveAttribute('title', 'Footer links · Working')
    } finally { localStorage.removeItem('sotto.threadWorkspace.sidebar') }
  })

  it('gives way to a request waiting on you, and to settling', () => {
    const state = threadsStateFixture()
    Object.assign(state, babysat(state, 'visual-gate', 'idle'))
    expect(rowStatus(rowFor(state, 'visual-gate'))).toEqual({ text: 'Needs your approval', finished: false, babysitting: false })
    const done = rowFor(state, 'footer-links')
    const thread = { ...done.thread, babysitting }
    expect(rowStatus({ ...done, thread, state: 'done', stateLabel: 'Done', settledBy: null })).toEqual({ text: 'Babysitting #74', finished: false, babysitting: true })
    expect(rowStatus({ ...done, thread, state: 'done', stateLabel: 'Done', settledBy: 'thread' })).toMatchObject({ text: 'Settled', babysitting: false })
  })
})
