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
 * stood, says only what each thread needs, pops a thread's own request open over the sidebar to answer through the
 * one store, and dismisses failures by the name their row showed.
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

  it('stands where Dismiss all stood while on, counts everyone and says the longest blocking wait', () => {
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
    expect(queue()).toHaveTextContent('longest wait 12 min')
    expect(within(queue()).getByText('Visual gate flake')).toBeInTheDocument()
    expect(within(queue()).getByText('Streaming WAV stall')).toBeInTheDocument()
    // It follows the search field, as the line it replaces did.
    const search = screen.getByRole('searchbox', { name: 'Search threads' })
    expect(search.compareDocumentPosition(queue()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(queue().closest('[role="status"], [role="alert"], [aria-live]')).toBeNull()
  })

  it('says only what each thread needs, with one press, and draws no ask', () => {
    owl(true)
    mount(threadsStateFixture())
    const entry = queue().querySelector<HTMLElement>('[data-entry-id="visual-gate"]')!
    // Which wait it is stands in the line's tooltip and the title's spoken name, not its words (Zach's pick C, November 5, 2026).
    expect(entry).not.toHaveTextContent('Needs your approval')
    expect(entry.querySelector('.needs-you__line')).toHaveAttribute('title', 'Needs your approval')
    expect(within(entry).getByRole('button', { name: 'Open Visual gate flake, needs your approval' })).toHaveTextContent(/^Visual gate flake$/)
    // The command and the project and machine line are the card's, not the entry's (October 29, 2026).
    expect(queue()).not.toHaveTextContent('npm test')
    expect(entry.querySelector('.needs-you__meta, .needs-you__ask')).toBeNull()
    expect(within(queue()).queryByRole('button', { name: 'Allow' })).toBeNull()
    const press = within(entry).getByRole('button', { name: 'Open to answer the approval in Visual gate flake' })
    expect(press).toHaveTextContent(/^Answer$/)
    expect(press).toHaveAttribute('aria-haspopup', 'dialog')
    expect(press).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('names the press of a delegated wait Open thread, since it only opens the thread it is reached from', () => {
    owl(true)
    const state = threadsStateFixture()
    // Footer links delegated a review, and the delegated thread waits on an approval (ADR-0135, a delegated wait).
    const ask = state.host.threads.find(thread => thread.id === 'visual-gate')!.requests[0]!
    state.host.threads.push({ id: 'footer-review', projectId: 'workshop', title: 'Review the footer fix', modelId: 'codex:gpt', providerId: 'codex', status: 'running',
      delegatedBy: 'footer-links', requests: [{ ...ask, id: 'footer-review-ask' }], messages: [] })
    const onOpen = vi.fn()
    render(<ThreadSidebar state={state} organization={organizeWorkspace(state, describeThreads(state, NOW), '', state.activeProjectId, true, NOW)}
      command={vi.fn()} query="" onQuery={vi.fn()} onOpen={onOpen} onNewThread={vi.fn()}
      currentThreadId={null} openThreadIds={[]} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />)
    const entry = queue().querySelector<HTMLElement>('[data-entry-id="footer-links"]')!
    expect(within(entry).getByRole('button', { name: /^Open .+, needs your approval in Review the footer fix$/u })).toBeInTheDocument()
    expect(within(entry).queryByRole('button', { name: /to answer/u })).toBeNull()
    const press = within(entry).getByRole('button', { name: /^Open [^,]+$/u })
    expect(press).toHaveTextContent(/^Open thread$/)
    expect(press).not.toHaveAttribute('aria-haspopup')
    fireEvent.click(press)
    expect(onOpen.mock.calls[0]?.[0]).toBe('footer-links')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('leads with what holds an agent, and rests a failed turn under it in muted words', () => {
    owl(true)
    let state = threadsStateFixture()
    state = edit(state, 'footer-links', thread => ({ ...thread, requests: [{ id: 'fl-q', kind: 'question', text: 'Which page?', options: [], since: ago(4) }] }))
    state = edit(state, 'visual-gate', thread => ({ ...thread, requests: [{ ...thread.requests[0]!, since: ago(0) }] }))
    state = edit(state, 'wav-stall', thread => ({ ...thread, failureId: 'f1', failureSince: ago(60) }))
    mount(state)
    const entries = [...queue().querySelectorAll<HTMLElement>('.needs-you__entry')]
    expect(entries.map(item => item.dataset.entryId)).toEqual(['visual-gate', 'footer-links', 'wav-stall'])
    const [approval, question, failed] = entries as [HTMLElement, HTMLElement, HTMLElement]
    expect(approval.querySelector('.thread-nav__ring')).toHaveAttribute('data-state', 'needs')
    // A wait under a minute says nothing; the question's four minutes are said, and lead the heading.
    expect(approval.querySelector('.needs-you__wait')).toBeNull()
    expect(question.querySelector('.needs-you__wait')).toHaveTextContent('4 min')
    expect(queue().querySelector('.needs-you__longest')).toHaveTextContent('longest wait 4 min')
    expect(within(question).getByRole('button', { name: 'Open Footer links, needs your answer' })).toBeInTheDocument()
    expect(within(question).getByRole('button', { name: 'Open to answer the question in Footer links' })).toHaveTextContent(/^Answer$/)
    // The failed turn blocks nothing: no amber, its words muted, and Dismiss and Show why for the pointer and the keys.
    expect(failed).toHaveAttribute('data-rest')
    expect(failed.querySelector('.thread-nav__ring')).not.toHaveAttribute('data-state')
    expect(failed).toHaveTextContent(/^Turn failed in\s*Streaming WAV stall/u)
    expect(failed.querySelector('.needs-you__wait')).toBeNull()
    expect(within(failed).getByRole('button', { name: 'Open Streaming WAV stall, its last turn failed' })).toBeInTheDocument()
    expect(within(failed).getByRole('button', { name: 'Dismiss Needs attention on Streaming WAV stall' })).toHaveTextContent('Dismiss')
    expect(within(failed).getByRole('button', { name: 'Show why Streaming WAV stall needs attention' })).toHaveTextContent('Show why')
    expect(failed.querySelector('.needs-you__line')).toHaveAttribute('title', 'Needs attention')
  })

  it('says no longest wait while only failures wait, or nothing blocking has waited a minute', () => {
    owl(true)
    let state = threadsStateFixture()
    state = edit(state, 'visual-gate', thread => ({ ...thread, requests: [{ ...thread.requests[0]!, since: ago(0) }] }))
    state = edit(state, 'wav-stall', thread => ({ ...thread, failureId: 'f1', failureSince: ago(90) }))
    mount(state)
    expect(queue().querySelector('.needs-you__longest')).toBeNull()
    expect(queue()).not.toHaveTextContent('just now')
    expect(queue()).not.toHaveTextContent('oldest')
  })

  it('pops an approval open over the sidebar and answers it through the answer store', async () => {
    owl(true)
    let state = threadsStateFixture()
    state = edit(state, 'visual-gate', thread => ({ ...thread, requests: [{ ...thread.requests[0]!, id: 'vg-approve', since: ago(3) }] }))
    const { command, onOpen } = mount(state)
    const press = within(queue()).getByRole('button', { name: 'Open to answer the approval in Visual gate flake' })
    await act(async () => { fireEvent.click(press) })
    const card = screen.getByRole('dialog', { name: 'Visual gate flake' })
    expect(press).toHaveAttribute('aria-expanded', 'true')
    expect(press).toHaveAttribute('aria-controls', card.id)
    expect(document.activeElement).toBe(card)
    expect(card).toHaveTextContent('npm test -- --run tests/unit/agents')
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Allow' })) })
    const answers = command.mock.calls.map(([request]) => request).filter(request => request.type === 'answer')
    expect(answers).toEqual([{ type: 'answer', threadId: 'visual-gate', requestId: 'vg-approve', answer: 'Approved', approved: true }])
    expect(within(card).getByText('Answer sent.')).toBeInTheDocument()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('answers a question in its popped card, as its own question answer', async () => {
    owl(true)
    let state = threadsStateFixture()
    const ask: AgentRequest = { id: 'ship-q', kind: 'question', text: 'Ship it?', options: [], since: ago(2),
      questions: [{ id: 'q1', question: 'Friday or Monday?', options: [{ id: 'fri', label: 'Friday' }, { id: 'mon', label: 'Monday' }], multiSelect: false, allowFreeText: false }] }
    state = edit(state, 'footer-links', thread => ({ ...thread, requests: [ask] }))
    const { command } = mount(state)
    expect(queue()).not.toHaveTextContent('Friday or Monday?')
    await act(async () => { fireEvent.click(within(queue()).getByRole('button', { name: 'Open to answer the question in Footer links' })) })
    const card = screen.getByRole('dialog', { name: 'Footer links' })
    await act(async () => { fireEvent.click(within(card).getByRole('radio', { name: 'Friday' })) })
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Send answer' })) })
    const answers = command.mock.calls.map(([request]) => request).filter(request => request.type === 'answer')
    expect(answers).toEqual([{ type: 'answer', threadId: 'footer-links', requestId: 'ship-q', answer: '', questionAnswers: { q1: { optionIds: ['fri'] } } }])
  })

  it('closes on Escape with the focus back on its press, and Open thread opens the thread', async () => {
    owl(true)
    const { onOpen, command } = mount(threadsStateFixture())
    const press = within(queue()).getByRole('button', { name: 'Open to answer the approval in Visual gate flake' })
    await act(async () => { fireEvent.click(press) })
    await act(async () => { fireEvent.keyDown(screen.getByRole('dialog', { name: 'Visual gate flake' }), { key: 'Escape' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(press)
    expect(press).toHaveAttribute('aria-expanded', 'false')
    // The press answers Escape while its card is open, wherever the focus went back to.
    await act(async () => { fireEvent.click(press) })
    press.focus()
    await act(async () => { fireEvent.keyDown(press, { key: 'Escape' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    // The focus moving on past the press closes the card, so none stands open out of Escape's reach.
    await act(async () => { fireEvent.click(press) })
    press.focus()
    expect(screen.getByRole('dialog', { name: 'Visual gate flake' })).toBeInTheDocument()
    await act(async () => { queue().querySelector<HTMLElement>('[data-entry-id="visual-gate"] .needs-you__title')!.focus() })
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { fireEvent.click(press) })
    await act(async () => { fireEvent.pointerDown(document.body) })
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { fireEvent.click(press) })
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog', { name: 'Visual gate flake' })).getByRole('button', { name: 'Open Visual gate flake' })) })
    expect(onOpen).toHaveBeenCalledWith('visual-gate')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(command.mock.calls.map(([request]) => request.type)).not.toContain('answer')
  })

  it('shows why a failure needs attention, and dismisses it from its card', async () => {
    owl(true)
    let state = threadsStateFixture()
    state = edit(state, 'wav-stall', thread => ({ ...thread, failureId: 'f1', failureReason: 'The provider stopped the turn.' }))
    const { command } = mount(state)
    expect(queue()).not.toHaveTextContent('The provider stopped the turn.')
    await act(async () => { fireEvent.click(within(queue()).getByRole('button', { name: 'Show why Streaming WAV stall needs attention' })) })
    const card = screen.getByRole('dialog', { name: 'Streaming WAV stall' })
    expect(card).toHaveTextContent('The provider stopped the turn.')
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Dismiss Needs attention on Streaming WAV stall' })) })
    const dismissed = command.mock.calls.map(([request]) => request).filter(request => request.type === 'dismiss-failures')
    expect(dismissed).toEqual([{ type: 'dismiss-failures', failures: [{ threadId: 'wav-stall', failure: 'f1' }] }])
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

  it('shows three approvals and questions and two failures, counts the rest, and unfolds for Show all', async () => {
    owl(true)
    let state = threadsStateFixture()
    for (const [index, id] of ['weekly-note', 'footer-links', 'grok-previews'].entries()) {
      state = edit(state, id, thread => ({ ...thread, requests: [{ id: `extra-${index}`, kind: 'permission' as const, text: 'Run it?', options: [], since: ago(20 - index) }] }))
    }
    mount(state)
    // Four approvals and the failed WAV stall: three approvals stand, then the failure, and one approval is counted.
    expect([...queue().querySelectorAll<HTMLElement>('.needs-you__entry')].map(item => item.dataset.kind)).toEqual(['approval', 'approval', 'approval', 'failed'])
    expect(queue()).toHaveTextContent('+ 1 more: 1 approval')
    await act(async () => { fireEvent.click(within(queue()).getByRole('button', { name: 'Show all waiting threads' })) })
    expect(queue().querySelectorAll('.needs-you__entry')).toHaveLength(5)
    await act(async () => { fireEvent.keyDown(queue(), { key: 'Escape' }) })
    expect(queue().querySelectorAll('.needs-you__entry')).toHaveLength(4)
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
    expect(document.activeElement).toBe(within(queue()).getByRole('button', { name: 'Open Grok voice previews, its last turn failed' }))
  })

  it('hands the focus on when an entry answered in its card leaves', async () => {
    owl(true)
    let state = threadsStateFixture()
    state = edit(state, 'visual-gate', thread => ({ ...thread, requests: [{ ...thread.requests[0]!, id: 'vg-focus' }] }))
    state = edit(state, 'wav-stall', thread => ({ ...thread, failureId: 'f1' }))
    const { again } = mount(state)
    await act(async () => { fireEvent.click(within(queue()).getByRole('button', { name: 'Open to answer the approval in Visual gate flake' })) })
    const allow = within(screen.getByRole('dialog', { name: 'Visual gate flake' })).getByRole('button', { name: 'Allow' })
    allow.focus()
    await act(async () => { fireEvent.click(allow) })
    await act(async () => { again(edit(state, 'visual-gate', thread => ({ ...thread, requests: [] }))) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(within(queue()).getByRole('button', { name: 'Open Streaming WAV stall, its last turn failed' }))
  })

  it('holds an unconfirmed answer in its card instead of offering to send it again', async () => {
    owl(true)
    let state = threadsStateFixture()
    state = edit(state, 'visual-gate', thread => ({ ...thread, requests: [{ ...thread.requests[0]!, id: 'vg-uncertain', delivery: 'uncertain' }] }))
    mount(state)
    await act(async () => { fireEvent.click(within(queue()).getByRole('button', { name: 'Open to answer the approval in Visual gate flake' })) })
    const card = screen.getByRole('dialog', { name: 'Visual gate flake' })
    expect(within(card).getByRole('button', { name: 'Allow' })).toBeDisabled()
    expect(within(card).getByRole('button', { name: 'Check again' })).toBeInTheDocument()
  })
})
