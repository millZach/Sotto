import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentState, AgentThread } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { describeThreads, rowStatus, unseenFailures } from '../../../src/renderer/src/agents/threadFacts'
import { failedTurnExplanation } from '../../../src/renderer/src/agents/FailedTurnNotice'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

/**
 * A failed turn is attention until a client shows it (ADR-0092): the row says Needs attention until the host marks it
 * seen, then Done; the sidebar counts the unseen ones with Dismiss all beside them; and the open pane says once why the
 * turn failed. The host's side is in tests/unit/main/failuresSeen.test.ts and failuresSeenControl.test.ts.
 */
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const REASON = 'Codex stopped before this reply finished, so it may be cut short. Send a message to carry on.'

function edit(state: AgentState, id: string, change: (thread: AgentThread) => AgentThread): AgentState {
  return { ...state, host: { ...state.host, threads: state.host.threads.map(thread => thread.id === id ? change(thread) : thread) } }
}
const seen = (thread: AgentThread): AgentThread => ({ ...thread, failureSeen: true })
const row = (state: AgentState, id: string) => describeThreads(state, NOW).find(entry => entry.thread.id === id)!
const failedTurn = (error?: string): AgentActivity => ({ id: 'codex-turn-wav-stall-1', turnId: 'wav-stall-1', sequence: 0, kind: 'turn', status: 'failed', title: 'Turn failed',
  startedAt: '2026-04-30T15:40:00.000Z', completedAt: '2026-04-30T17:02:00.000Z', timingSource: 'observed', afterMessageId: 'wav-stall-1', ...(error ? { error } : {}) })

function mount(state: AgentState) {
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView now={NOW} />)
  return live
}

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(() => { cleanup() })

describe('a failed thread\'s row', () => {
  it('says Needs attention until the host marks the failure seen, then Done', () => {
    const state = threadsStateFixture()
    expect(row(state, 'wav-stall')).toMatchObject({ state: 'needs', stateLabel: 'Needs attention', waitingFor: null })
    const after = edit(state, 'wav-stall', seen)
    expect(row(after, 'wav-stall')).toMatchObject({ state: 'done', stateLabel: 'Done' })
    expect(rowStatus(row(after, 'wav-stall')).text).toBe('Done')
  })

  it('keeps asking for an approval or an answer whatever the seen mark says', () => {
    const state = edit(threadsStateFixture(), 'visual-gate', thread => seen({ ...thread, status: 'error' }))
    expect(row(state, 'visual-gate')).toMatchObject({ state: 'needs', stateLabel: 'Needs your approval', waitingFor: 'approval' })
    expect(unseenFailures(state.host.threads)).toEqual(['wav-stall'])
  })

  it('says the turn failed when a seen failure has no reply to show', () => {
    const state = edit(threadsStateFixture(), 'wav-stall', thread => seen({ ...thread, messages: thread.messages.slice(0, 1) }))
    const facts = row(state, 'wav-stall')
    expect(facts.stateLabel).toBe('Done')
    expect(facts.sentence).toBe('The last turn failed. Open the thread to see why.')
  })
})

describe('the sidebar\'s Needs attention line', () => {
  it('counts failed turns only, and Dismiss all sends every one of them to be marked seen', async () => {
    // Two failures and a thread waiting on an approval: the approval is never counted or dismissed.
    const state = edit(threadsStateFixture(), 'grok-previews', thread => ({ ...thread, status: 'error' }))
    const live = mount(state)
    const line = document.querySelector('.thread-nav__attention')!
    expect(line).toHaveTextContent('2 need attention')
    const dismiss = screen.getByRole('button', { name: 'Dismiss Needs attention on 2 threads' })
    expect(dismiss).toHaveTextContent('Dismiss all')
    // It sits between the search and the list, so Tab reaches it straight after the search field.
    const search = screen.getByRole('searchbox', { name: 'Search threads' })
    expect(search.compareDocumentPosition(dismiss) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(dismiss.compareDocumentPosition(screen.getByRole('button', { name: 'Streaming WAV stall' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await act(async () => { fireEvent.click(dismiss) })
    const sent = live.command.mock.calls.map(([request]) => request).filter(request => request.type === 'dismiss-failures')
    expect(sent).toEqual([{ type: 'dismiss-failures', threadIds: expect.arrayContaining(['wav-stall', 'grok-previews']) }])
    expect(sent[0]!.type === 'dismiss-failures' && sent[0]!.threadIds).toHaveLength(2)
    // The line goes once the host says so, and the search field keeps the focus the button had.
    expect(search).toHaveFocus()
    act(() => { live.publish(edit(edit(live.state, 'wav-stall', seen), 'grok-previews', seen)) })
    expect(document.querySelector('.thread-nav__attention')).toBeNull()
    expect(screen.getByRole('button', { name: 'Streaming WAV stall' }).querySelector('.thread-nav__status')).toHaveTextContent('Done')
  })

  it('says one thread in the singular, and is absent while nothing has failed unseen', () => {
    mount(threadsStateFixture())
    expect(document.querySelector('.thread-nav__attention')).toHaveTextContent('1 needs attention')
    expect(screen.getByRole('button', { name: 'Dismiss Needs attention on 1 thread' })).toBeInTheDocument()
    cleanup()
    mount(edit(threadsStateFixture(), 'wav-stall', seen))
    expect(document.querySelector('.thread-nav__attention')).toBeNull()
  })
})

describe('why the last turn failed', () => {
  const failed = (patch: Partial<AgentThread> = {}): AgentThread => ({ ...threadsStateFixture().host.threads.find(thread => thread.id === 'wav-stall')!, ...patch })

  it('leaves the reason to the transcript when the failed turn carries it', () => {
    expect(failedTurnExplanation(failed({ activities: [failedTurn(REASON)] }), 'Codex')).toEqual({ kind: 'transcript', reason: REASON })
  })

  it('says what it knows when the turn carries no reason, or no failed turn is on record', () => {
    expect(failedTurnExplanation(failed({ activities: [failedTurn()] }), 'Codex'))
      .toEqual({ kind: 'notice', title: 'The last turn failed.', body: 'Nothing in the transcript was lost. Send a message to try again.' })
    expect(failedTurnExplanation(failed(), 'Codex'))
      .toEqual({ kind: 'notice', title: 'Codex reported an error on this thread.', body: 'Nothing in the transcript was lost. Send a message to try again.' })
  })

  it('says nothing for a thread that is not failed, waits on a request, explains itself, or has no history yet', () => {
    expect(failedTurnExplanation(failed({ status: 'idle' }), 'Codex')).toBeNull()
    expect(failedTurnExplanation(failed({ requests: [{ id: 'q', kind: 'question', text: 'Which?', options: [] }] }), 'Codex')).toBeNull()
    expect(failedTurnExplanation(failed({ requestNotice: 'Codex asked for something Sotto cannot show.' }), 'Codex')).toBeNull()
    expect(failedTurnExplanation(failed({ historyStatus: 'loading' }), 'Codex')).toBeNull()
  })

  it('keeps explaining a seen failure, and says the reason once when the banner would repeat it', () => {
    const state = edit({ ...threadsStateFixture(), activeThreadId: 'wav-stall', error: REASON }, 'wav-stall', thread => seen({ ...thread, activities: [failedTurn(REASON)] }))
    mount(state)
    expect(screen.getAllByText(REASON)).toHaveLength(1)
    expect(document.querySelector('.thread-workspace__error')).toBeNull()
    expect(document.querySelector('.thread-failed-notice')).toBeNull()
  })

  it('shows the notice above the composer when the transcript has no reason, seen or not', () => {
    mount({ ...edit(threadsStateFixture(), 'wav-stall', seen), activeThreadId: 'wav-stall' })
    expect(document.querySelector('.thread-failed-notice')).toHaveTextContent('Codex reported an error on this thread. Nothing in the transcript was lost. Send a message to try again.')
    // It announces nothing: the user opened the thread to read it.
    expect(document.querySelector('.thread-failed-notice')?.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull()
  })
})
