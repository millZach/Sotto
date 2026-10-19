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

  it('shows nothing for a finished news turn with no reply and no lifecycle record', () => {
    const bare = [...activities.filter(item => item.turnId !== 'news-3'), ...work('news-3', '58:10.000', '58:13.000', ['tool'], 30).filter(item => item.kind !== 'turn')]
    show(bare)
    expect(document.querySelector('[data-turn-id="news-3"]')).toBeNull()
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
