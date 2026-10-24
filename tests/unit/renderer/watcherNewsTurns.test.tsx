import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentMessage } from '../../../src/shared/agents'
import { MessageList, type ActivityContext } from '../../../src/renderer/src/agents/ThreadTranscript'
import { placeActivities } from '../../../src/renderer/src/agents/threadActivityView'

// Watcher's conversation without its news wake-ups, as main presents it (watcherWakeUpsAsShown): each news turn's work
// names a message the transcript does not have. Times follow Zach's Watcher thread of October 19, 2026.
const clock = (time: string): string => `2026-10-19T11:${time}Z`
const said = (id: string, role: AgentMessage['role'], time: string, text: string): AgentMessage => ({ id, role, text, createdAt: clock(time) })
const work = (turnId: string, from: string, to: string, kinds: AgentActivity['kind'][], first: number, status: AgentActivity['status'] = 'completed'): AgentActivity[] => [
  { id: `turn-${turnId}`, turnId, afterMessageId: turnId, sequence: first, kind: 'turn', status, title: 'Turn', startedAt: clock(from), completedAt: clock(to) },
  ...kinds.map((kind, index): AgentActivity => ({ id: `${turnId}-${index}`, turnId, afterMessageId: turnId, sequence: first + index + 1, kind, status: 'completed',
    title: kind === 'tool' ? 'read_thread' : 'Thinking', startedAt: clock(from), completedAt: clock(to) })),
]
const messages = [
  said('you-1', 'user', '56:40.379', 'What is the update-all thread waiting on?'),
  said('answer-1', 'assistant', '56:50.463', 'It is waiting on a permission to run the suite.'),
  said('news-reply-1', 'assistant', '56:59.843', 'The update-all thread got your permission.'),
  said('news-reply-2', 'assistant', '57:36.613', 'CI went green on the host-update pull request.'),
  said('you-2', 'user', '59:05.573', 'Merge the host-update one if CI is green.'),
  said('answer-2', 'assistant', '59:33.423', 'Sent it the merge.'),
]
const activities = [
  ...work('you-1', '56:41.291', '56:50.600', ['reasoning', 'tool'], 0),
  ...work('news-1', '56:54.086', '57:00.200', ['tool', 'reasoning'], 10),
  ...work('news-2', '57:29.544', '57:36.900', ['tool', 'reasoning'], 20),
  ...work('news-3', '58:10.000', '58:13.000', ['tool'], 30),
  ...work('you-2', '59:06.224', '59:33.500', ['reasoning', 'tool'], 40),
]
const finished: ActivityContext = { liveTurn: null, running: false, connected: true, provider: 'claude', onDisclosure: () => undefined }

function show(list: readonly AgentActivity[] = activities, watcher = true) {
  return render(<MessageList messages={messages} provider="Claude Code" running={false} placement={placeActivities(messages, messages, list)} context={finished}
    speaker={watcher ? 'watcher' : undefined} />)
}
/** Whether these words appear in this order. Each must appear once. */
function inOrder(texts: readonly string[]): boolean {
  const transcript = document.body.textContent ?? ''
  const at = texts.map(text => transcript.indexOf(text))
  return at.every((index, n) => index >= 0 && transcript.indexOf(texts[n]!, index + 1) < 0 && (n === 0 || index > at[n - 1]!))
}

afterEach(cleanup)

describe('Watcher’s replies to news', () => {
  it('keeps each turn’s work with its own turn, before its reply, and nothing below the last reply', () => {
    show()
    expect(inOrder(['What is the update-all', 'Worked for 9.3s', 'It is waiting on', 'After news · 6.1s', 'got your permission', 'After news · 7.3s', 'CI went green',
      'Merge the host-update', 'Worked for 27s', 'Sent it the merge.'])).toBe(true)
    expect((document.body.textContent ?? '').trimEnd().endsWith('Sent it the merge.')).toBe(true)
  })

  it('folds the work into the reply’s header instead of giving it a line of its own', () => {
    show()
    const reply = document.querySelector<HTMLElement>('[data-message-id="news-reply-1"]')!
    const press = reply.querySelector('header button')!
    expect(press).toHaveTextContent('After news · 6.1s')
    expect(press).toHaveAttribute('aria-expanded', 'false')
    // Your own two turns keep their lines; the news turns have none.
    expect(screen.getAllByRole('button', { name: /^Worked for/u })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /Used 1 tool/u })).not.toBeInTheDocument()
    fireEvent.click(press)
    expect(press).toHaveAttribute('aria-expanded', 'true')
    expect(reply).toHaveTextContent('Used 1 tool, thought once')
    fireEvent.keyDown(press, { key: 'Escape' })
    expect(press).toHaveAttribute('aria-expanded', 'false')
    expect(press).toHaveFocus()
  })

  it('leaves your answer as your turn’s reply instead of folding it under a news reply', () => {
    show()
    expect(screen.getByText('It is waiting on a permission to run the suite.')).toBeInTheDocument()
    expect(screen.getByText('The update-all thread got your permission.')).toBeInTheDocument()
  })

  it('shows nothing for a finished news turn that wrote no reply, and says so when one failed', () => {
    show()
    expect(document.querySelector('[data-turn-id="news-3"]')).toBeNull()
    cleanup()
    show([...activities.filter(item => item.turnId !== 'news-3'), ...work('news-3', '58:10.000', '58:13.000', ['tool'], 30, 'failed')])
    const failed = document.querySelector<HTMLElement>('[data-turn-id="news-3"]')!
    expect(failed).toHaveTextContent('Failed after 3.0s')
    expect(inOrder(['CI went green', 'Failed after 3.0s', 'Merge the host-update'])).toBe(true)
  })

  it('says in the header when the news turn failed, and keeps its error in view', () => {
    const failed = activities.map(item => item.id === 'turn-news-1' ? { ...item, status: 'failed' as const, error: 'Watcher’s provider stopped answering.' } : item)
    show(failed)
    const reply = document.querySelector<HTMLElement>('[data-message-id="news-reply-1"]')!
    expect(reply).toHaveAttribute('data-turn-outcome', 'failed')
    expect(reply.querySelector('header button')).toHaveTextContent('After news · failed after 6.1s')
    expect(reply).toHaveTextContent('Watcher’s provider stopped answering.')
  })

  it('lists the live news turn’s work above the reply it is writing', () => {
    const live = activities.map(item => item.turnId === 'news-2' ? { ...item, status: 'running' as const, completedAt: undefined } : item)
      .filter(item => item.turnId !== 'news-3' && item.turnId !== 'you-2')
    const shown = messages.slice(0, 4)
    render(<MessageList messages={shown} provider="Claude Code" running placement={placeActivities(shown, shown, live)} speaker="watcher"
      context={{ ...finished, liveTurn: 'news-2', running: true }} />)
    expect(document.querySelector('[data-message-id="news-reply-2"] header button')).toBeNull()
    expect(inOrder(['got your permission', 'Read thread', 'CI went green'])).toBe(true)
  })

  it('shows nothing for a finished news turn with no reply and no lifecycle record', () => {
    const bare = [...activities.filter(item => item.turnId !== 'news-3'), ...work('news-3', '58:10.000', '58:13.000', ['tool'], 30).filter(item => item.kind !== 'turn')]
    show(bare)
    expect(document.querySelector('[data-turn-id="news-3"]')).toBeNull()
  })
})

/**
 * Watcher working on news: the wake-up that began the turn is left out, so the turn has nothing drawn until its first reply,
 * only its running work under the last turn (#1452).
 */
describe('Watcher working on news before its first reply', () => {
  const news: AgentActivity[] = [
    { id: 'turn-news-4', turnId: 'news-4', afterMessageId: 'news-4', sequence: 50, kind: 'turn', status: 'running', title: 'Turn', startedAt: clock('59:50.000') },
    { id: 'news-4-0', turnId: 'news-4', afterMessageId: 'news-4', sequence: 51, kind: 'tool', status: 'running', title: 'read_thread', startedAt: clock('59:50.100') },
  ]
  const working: ActivityContext = { ...finished, liveTurn: 'news-4', running: true }
  const list = (shown: readonly AgentMessage[], records: readonly AgentActivity[], running: boolean, streamText = true, watcher = true) =>
    <MessageList messages={shown} provider="Claude Code" running={running} placement={placeActivities(shown, shown, records)}
      context={running ? working : finished} streamText={streamText} speaker={watcher ? 'watcher' : undefined} />
  /** Each drawn message's element, by ID, in the order drawn. */
  const drawnMessages = (): Map<string, Element> => new Map([...document.querySelectorAll('[data-message-id]')].map(item => [item.getAttribute('data-message-id')!, item]))

  it('leaves your finished turn as it was: folded, its reply whole and the same element, so nothing above or under the reader moves', () => {
    const view = render(list(messages, activities, false, false))
    const before = drawnMessages()
    const reply = document.querySelector('[data-message-id="answer-2"]')!.textContent
    view.rerender(list(messages, [...activities, ...news], true, false))
    expect(screen.getByRole('button', { name: 'Worked for 27s' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Writing a reply…')).not.toBeInTheDocument()
    expect(document.querySelector('[data-message-id="answer-2"]')!.textContent).toBe(reply)
    // The same elements stay, so the window's scroll anchoring holds the reader's place.
    const during = drawnMessages()
    expect([...during.keys()]).toEqual([...before.keys()])
    for (const [id, element] of before) expect(during.get(id), id).toBe(element)
    // The news turn's work is the newest thing drawn.
    expect(inOrder(['Sent it the merge.', 'Read thread'])).toBe(true)
    // It ends with no reply: the conversation is as it was.
    view.rerender(list(messages, [...activities, ...news.map(item => ({ ...item, status: 'completed' as const, completedAt: clock('59:55.000') }))], false, false))
    const after = drawnMessages()
    for (const [id, element] of before) expect(after.get(id), id).toBe(element)
  })

  it('leaves the reply to the last news as it was, its work still in its header', () => {
    const shown = messages.slice(0, 4)
    const records = activities.filter(item => item.turnId !== 'news-3' && item.turnId !== 'you-2')
    const view = render(list(shown, records, false))
    expect(document.querySelector('[data-message-id="news-reply-2"] header button')).toHaveTextContent('After news · 7.3s')
    view.rerender(list(shown, [...records, ...news], true))
    expect(document.querySelector('[data-message-id="news-reply-2"] header button')).toHaveTextContent('After news · 7.3s')
    expect(inOrder(['CI went green', 'Read thread'])).toBe(true)
  })

  it('still draws your own turn live while Watcher works on it', () => {
    const yours = [...activities.filter(item => item.turnId !== 'you-2'),
      { id: 'turn-you-2', turnId: 'you-2', afterMessageId: 'you-2', sequence: 40, kind: 'turn', status: 'running', title: 'Turn', startedAt: clock('59:06.224') } satisfies AgentActivity]
    render(<MessageList messages={messages} provider="Claude Code" running placement={placeActivities(messages, messages, yours)}
      context={{ ...finished, liveTurn: 'you-2', running: true }} streamText={false} speaker="watcher" />)
    expect(screen.queryByRole('button', { name: /^Worked for 27s/u })).not.toBeInTheDocument()
    expect(screen.getByText('Writing a reply…')).toBeInTheDocument()
  })

  /** Whether a reply is drawn whole and finished: its words, not being written. */
  const finishedReply = (id: string, words: string): void => {
    const reply = document.querySelector(`[data-message-id="${id}"]`)!
    expect(reply, id).toHaveTextContent(words)
    expect(reply.querySelector('[data-streaming]'), `${id} is not being written`).toBeNull()
    expect(screen.queryByText('Writing a reply…')).not.toBeInTheDocument()
  }
  const lifecycle = (turnId: string, sequence: number, status: AgentActivity['status'], from: string, to?: string): AgentActivity =>
    ({ id: `turn-${turnId}`, turnId, afterMessageId: turnId, sequence, kind: 'turn', status, title: 'Turn', startedAt: clock(from), ...to ? { completedAt: clock(to) } : {} })

  for (const streamText of [true, false]) {
    describe(streamText ? 'with replies shown as they are written' : 'with replies shown once complete', () => {
      it('leaves a plain answer as it was when the news turn has only its lifecycle record so far', () => {
        // An answer with no tools and no thinking: its turn's only record is its lifecycle, which draws nothing.
        const plain = messages.slice(0, 2)
        const records = [lifecycle('you-1', 0, 'completed', '56:41.291', '56:50.600')]
        const view = render(list(plain, records, false, streamText))
        const before = drawnMessages()
        view.rerender(list(plain, [...records, lifecycle('news-4', 50, 'running', '59:50.000')], true, streamText))
        finishedReply('answer-1', 'It is waiting on a permission to run the suite.')
        for (const [id, element] of before) expect(drawnMessages().get(id), id).toBe(element)
      })

      it('leaves your answer as it was when the news turn opens with an empty reply', () => {
        // Claude starts the reply empty, naming the turn the wake-up began, before it writes any words.
        const opening: AgentMessage = { ...said('news-4-reply', 'assistant', '59:51.000', ''), turnMessageId: 'news-4' }
        const view = render(list(messages, activities, false, streamText))
        const before = drawnMessages()
        view.rerender(list([...messages, opening], [...activities, ...news], true, streamText))
        finishedReply('answer-2', 'Sent it the merge.')
        expect(screen.getByRole('button', { name: 'Worked for 27s' })).toHaveAttribute('aria-expanded', 'false')
        for (const [id, element] of before) expect(drawnMessages().get(id), id).toBe(element)
      })
    })
  }

  it('changes nothing in another thread, whose running turn is always its newest', () => {
    render(list(messages, [...activities, ...news], true, false, false))
    expect(screen.getByText('Writing a reply…')).toBeInTheDocument()
  })
})

describe('an unshown turn in another thread', () => {
  it('keeps its work before its reply, on the line every turn has', () => {
    show(activities, false)
    expect(document.querySelector('[data-message-id="news-reply-1"] header button')).toBeNull()
    expect(document.querySelector('[data-turn-id="news-3"]')).toHaveTextContent('Worked for 3.0s')
    expect(inOrder(['It is waiting on', 'Worked for 6.1s', 'got your permission', 'Worked for 3.0s', 'Merge the host-update'])).toBe(true)
  })
})
