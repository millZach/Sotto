import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommand, AgentRequest, AgentState, AgentThread } from '../../../src/shared/agents'
import { E2E_THREADS_NOW as NOW } from '../../../src/shared/e2e'
import { describeThreads, organizeWorkspace } from '../../../src/renderer/src/agents/threadFacts'
import { ThreadSidebar } from '../../../src/renderer/src/agents/ThreadSidebar'
import { useOptionalApp, type AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

/**
 * The Needs you queue in the Threads sidebar (ADR-0135): while its Owl feature is on it stands where Dismiss all
 * stood, answers the simple asks through the one store, and dismisses failures by the name their row showed.
 * While it is off the sidebar is today's whole. The facts it lists are in threadFacts.test.tsx.
 */
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))

function owl(on: boolean): void {
  vi.mocked(useOptionalApp).mockReturnValue({ update: { currentVersion: '0.1.40', phase: { phase: 'up-to-date' }, checkedAt: null,
    owlFeatures: { 'needs-you-queue': on } } } as unknown as AppContextValue)
}
beforeEach(() => { vi.mocked(useOptionalApp).mockReset() })
afterEach(cleanup)

const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString()
const edit = (state: AgentState, id: string, change: (thread: AgentThread) => AgentThread): AgentState =>
  ({ ...state, host: { ...state.host, threads: state.host.threads.map(thread => thread.id === id ? change(thread) : thread) } })

function mount(state: AgentState, command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => state)) {
  const onOpen = vi.fn()
  const element = (next: AgentState) => <ThreadSidebar state={next} organization={organizeWorkspace(next, describeThreads(next, NOW), '', next.activeProjectId, false, NOW)}
    command={command} query="" onQuery={vi.fn()} onOpen={onOpen} onNewThread={vi.fn()}
    currentThreadId={null} openThreadIds={[]} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />
  const view = render(element(state))
  return { ...view, command, onOpen, again: (next: AgentState) => view.rerender(element(next)) }
}
const queue = (): HTMLElement => document.querySelector('.needs-you')!

describe('the Needs you queue (ADR-0135)', () => {
  it('leaves the sidebar as it is today while the Owl feature is off', () => {
    owl(false)
    mount(threadsStateFixture())
    expect(document.querySelector('.needs-you')).toBeNull()
    expect(screen.getByRole('button', { name: 'Dismiss Needs attention on 1 thread' })).toBeInTheDocument()
    expect(document.querySelector('.thread-nav__indicators')).not.toBeNull()
  })

  it('stands where Dismiss all stood while on, counts everyone and says the oldest blocking wait', () => {
    owl(true)
    let state = threadsStateFixture()
    state = edit(state, 'visual-gate', thread => ({ ...thread, requests: [{ ...thread.requests[0]!, since: ago(12) }] }))
    state = edit(state, 'wav-stall', thread => ({ ...thread, failureId: 'f1', failureSince: ago(9) }))
    mount(state)
    expect(screen.queryByRole('button', { name: 'Dismiss Needs attention on 1 thread' })).toBeNull()
    expect(document.querySelector('.thread-nav__attention')).toBeNull()
    expect(document.querySelector('.thread-nav__indicators')).toBeNull()
    expect(within(queue()).getByText('Needs you')).toBeInTheDocument()
    expect(queue()).toHaveTextContent('2')
    expect(queue()).toHaveTextContent('oldest 12 min')
    expect(within(queue()).getByText('Visual gate flake')).toBeInTheDocument()
    expect(within(queue()).getByText('Needs your approval')).toBeInTheDocument()
    expect(within(queue()).getByText('Streaming WAV stall')).toBeInTheDocument()
    expect(within(queue()).getByText('Needs attention')).toBeInTheDocument()
    // It follows the search field, as the line it replaces did.
    const search = screen.getByRole('searchbox', { name: 'Search threads' })
    expect(search.compareDocumentPosition(queue()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(queue().closest('[role="status"], [role="alert"], [aria-live]')).toBeNull()
  })

  it('approves a short permission from the queue through the answer store', async () => {
    owl(true)
    let state = threadsStateFixture()
    state = edit(state, 'visual-gate', thread => ({ ...thread, requests: [{ ...thread.requests[0]!, id: 'vg-approve', since: ago(3) }] }))
    const { command } = mount(state)
    await act(async () => { fireEvent.click(within(queue()).getByRole('button', { name: 'Allow in Visual gate flake' })) })
    const answers = command.mock.calls.map(([request]) => request).filter(request => request.type === 'answer')
    expect(answers).toEqual([{ type: 'answer', threadId: 'visual-gate', requestId: 'vg-approve', answer: 'Approved', approved: true }])
    expect(within(queue()).getByText('Answer sent.')).toBeInTheDocument()
  })

  it('answers a one-question choice in one press, as its own question answer', async () => {
    owl(true)
    let state = threadsStateFixture()
    const ask: AgentRequest = { id: 'ship-q', kind: 'question', text: 'Ship it?', options: [], since: ago(2),
      questions: [{ id: 'q1', question: 'Friday or Monday?', options: [{ id: 'fri', label: 'Friday' }, { id: 'mon', label: 'Monday' }], multiSelect: false, allowFreeText: false }] }
    state = edit(state, 'footer-links', thread => ({ ...thread, requests: [ask] }))
    const { command } = mount(state)
    await act(async () => { fireEvent.click(within(queue()).getByRole('button', { name: 'Answer Friday in Footer links' })) })
    const answers = command.mock.calls.map(([request]) => request).filter(request => request.type === 'answer')
    expect(answers).toEqual([{ type: 'answer', threadId: 'footer-links', requestId: 'ship-q', answer: '', questionAnswers: { q1: { optionIds: ['fri'] } } }])
  })

  it('dismisses one failure by the name its row showed, and all of them together', async () => {
    owl(true)
    let state = threadsStateFixture()
    state = edit(state, 'wav-stall', thread => ({ ...thread, failureId: 'f1' }))
    state = edit(state, 'grok-previews', thread => ({ ...thread, status: 'error', failureId: 'f2' }))
    const { command } = mount(state)
    await act(async () => { fireEvent.click(within(queue()).getByRole('button', { name: 'Dismiss Needs attention on Streaming WAV stall' })) })
    await act(async () => { fireEvent.click(within(queue()).getByRole('button', { name: 'Dismiss Needs attention on 2 threads' })) })
    const dismissed = command.mock.calls.map(([request]) => request).filter(request => request.type === 'dismiss-failures')
    expect(dismissed).toEqual([
      { type: 'dismiss-failures', failures: [{ threadId: 'wav-stall', failure: 'f1' }] },
      { type: 'dismiss-failures', failures: expect.arrayContaining([{ threadId: 'wav-stall', failure: 'f1' }, { threadId: 'grok-previews', failure: 'f2' }]) },
    ])
  })

  it('shows three entries, counts the rest, and unfolds for Show all', async () => {
    owl(true)
    let state = threadsStateFixture()
    for (const [index, id] of ['weekly-note', 'footer-links', 'grok-previews'].entries()) {
      state = edit(state, id, thread => ({ ...thread, requests: [{ id: `extra-${index}`, kind: 'permission' as const, text: 'Run it?', options: [], since: ago(20 - index) }] }))
    }
    mount(state)
    expect(queue().querySelectorAll('.needs-you__entry')).toHaveLength(3)
    expect(queue()).toHaveTextContent('+ 2 more waiting')
    await act(async () => { fireEvent.click(within(queue()).getByRole('button', { name: 'Show all waiting threads' })) })
    expect(queue().querySelectorAll('.needs-you__entry')).toHaveLength(5)
    await act(async () => { fireEvent.keyDown(queue(), { key: 'Escape' }) })
    expect(queue().querySelectorAll('.needs-you__entry')).toHaveLength(3)
  })

  it('hands the focus to the next entry when a dismissed entry leaves', async () => {
    owl(true)
    let state = threadsStateFixture()
    state = edit(state, 'wav-stall', thread => ({ ...thread, failureId: 'f1' }))
    state = edit(state, 'grok-previews', thread => ({ ...thread, status: 'error', failureId: 'f2' }))
    const { again } = mount(state)
    const dismiss = within(queue()).getByRole('button', { name: 'Dismiss Needs attention on Streaming WAV stall' })
    dismiss.focus()
    await act(async () => { fireEvent.click(dismiss) })
    await act(async () => { again(edit(state, 'wav-stall', thread => ({ ...thread, failureSeen: true }))) })
    expect(document.activeElement).toBe(within(queue()).getAllByRole('button', { name: 'Open Grok voice previews' })[0])
  })

  it('keeps the focus in an answered entry, then hands it on when the entry leaves', async () => {
    owl(true)
    let state = threadsStateFixture()
    state = edit(state, 'visual-gate', thread => ({ ...thread, requests: [{ ...thread.requests[0]!, id: 'vg-focus' }] }))
    state = edit(state, 'wav-stall', thread => ({ ...thread, failureId: 'f1' }))
    const { again } = mount(state)
    const allow = within(queue()).getByRole('button', { name: 'Allow in Visual gate flake' })
    allow.focus()
    await act(async () => { fireEvent.click(allow) })
    expect(document.activeElement?.textContent).toContain('Answer sent.')
    await act(async () => { again(edit(state, 'visual-gate', thread => ({ ...thread, requests: [] }))) })
    expect(document.activeElement).toBe(within(queue()).getAllByRole('button', { name: 'Open Streaming WAV stall' })[0])
  })

  it('holds an unconfirmed answer instead of offering to send it again', () => {
    owl(true)
    let state = threadsStateFixture()
    state = edit(state, 'visual-gate', thread => ({ ...thread, requests: [{ ...thread.requests[0]!, id: 'vg-uncertain', delivery: 'uncertain' }] }))
    mount(state)
    expect(within(queue()).queryByRole('button', { name: 'Allow in Visual gate flake' })).toBeNull()
    expect(within(queue()).getByRole('button', { name: 'Check again' })).toBeInTheDocument()
  })

  it('opens the thread for an ask too long to judge here, and answers nothing', async () => {
    owl(true)
    let state = threadsStateFixture()
    state = edit(state, 'visual-gate', thread => ({ ...thread, requests: [{ ...thread.requests[0]!, id: 'vg-long', context: { command: 'x'.repeat(161) } }] }))
    const { command, onOpen } = mount(state)
    expect(within(queue()).queryByRole('button', { name: 'Allow in Visual gate flake' })).toBeNull()
    await act(async () => { fireEvent.click(within(queue()).getByRole('button', { name: 'Open Visual gate flake to answer' })) })
    expect(onOpen).toHaveBeenCalledWith('visual-gate')
    expect(command.mock.calls.map(([request]) => request.type)).not.toContain('answer')
  })
})
