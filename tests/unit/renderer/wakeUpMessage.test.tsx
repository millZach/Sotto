import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentFollowup, AgentMessage, AgentState } from '../../../src/shared/agents'
import { isWakeUpFollowup, isWakeUpMessage, wakeUpMarkdown } from '../../../src/renderer/src/agents/babysitting'
import { MessageList, QueuedMessage, type ActivityContext } from '../../../src/renderer/src/agents/ThreadTranscript'
import { ThreadFollowups } from '../../../src/renderer/src/agents/ThreadFollowups'
import { placeActivities } from '../../../src/renderer/src/agents/threadActivityView'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { describeThreads } from '../../../src/renderer/src/agents/threadFacts'
import { threadsStateFixture } from './liveAgentState'

/** A wake-up in the thread and in its follow-up queue (ADR-0061, variant C), told by the host's mark alone. */
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const at = '2026-10-08T21:09:00.000Z'
const WAKE_UP = [
  'Sotto is babysitting a pull request for this thread, and it needs you.',
  '',
  'Pull request #74 "Greet the reviewer": https://github.com/o/r/pull/74',
  '- Check CI / *build* failed: https://github.com/o/r/actions/runs/4182',
  '',
  'Look into each item and act on it as your task requires.',
].join('\n')

describe('telling a wake-up', () => {
  it('goes by the host’s mark, never by the words', () => {
    expect(isWakeUpMessage({ role: 'user', wakeUp: true })).toBe(true)
    expect(isWakeUpMessage({ role: 'user' })).toBe(false)
    expect(isWakeUpMessage({ role: 'assistant', wakeUp: true })).toBe(false)
    expect(isWakeUpFollowup({ wakeUp: true })).toBe(true)
    expect(isWakeUpFollowup({})).toBe(false)
  })

  it('draws every word as sent: nothing becomes formatting, each line keeps its break, each link is a link', () => {
    expect(wakeUpMarkdown('- Check *build* failed: https://github.com/o/r/pull/1\nnext')).toBe('\\- Check \\*build\\* failed\\: <https://github.com/o/r/pull/1>\\\nnext')
    expect(wakeUpMarkdown('one\n\ntwo')).toBe('one\n\ntwo')
  })
})

const context: ActivityContext = { liveTurn: null, running: false, connected: true, provider: 'claude', onDisclosure: () => undefined }
function transcript(messages: AgentMessage[]) {
  render(<MessageList messages={messages} provider="Claude Code" running={false} placement={placeActivities(messages, messages, [])} context={context} />)
}

describe('a wake-up in the thread', () => {
  it('sits on the user’s side labelled Sotto and Wake-up, with the whole text the provider received', () => {
    transcript([{ id: 'w1', role: 'user', text: WAKE_UP, createdAt: at, wakeUp: true }])
    const message = document.querySelector('.thread-message')!
    expect(message).toHaveAttribute('data-role', 'user')
    expect(message).toHaveAttribute('data-from', 'sotto')
    const header = message.querySelector('header')!
    expect(within(header as HTMLElement).getByText('Sotto')).toBeVisible()
    expect(within(header as HTMLElement).getByText('Wake-up')).toBeVisible()
    expect(header).not.toHaveTextContent('You')
    // Every word, the list dash and the stars included, as text; the links as links.
    expect(message).toHaveTextContent('- Check CI / *build* failed: https://github.com/o/r/actions/runs/4182')
    expect(message.querySelector('ul, em, strong')).toBeNull()
    expect(within(message as HTMLElement).getByRole('link', { name: 'https://github.com/o/r/pull/74' })).toHaveAttribute('href', 'https://github.com/o/r/pull/74')
  })

  it('stays the user’s when the same words come without the mark', () => {
    transcript([{ id: 'u1', role: 'user', text: WAKE_UP, createdAt: at }])
    const message = document.querySelector('.thread-message')!
    expect(message).not.toHaveAttribute('data-from')
    expect(message.querySelector('header')).toHaveTextContent('You')
  })
})

describe('a wake-up waiting in the follow-up queue', () => {
  const followup = (id: string, text: string, wakeUp = false): AgentFollowup => ({ id, threadId: 'footer-links', draftId: crypto.randomUUID(), text, attachments: [],
    createdAt: at, updatedAt: at, status: 'queued', ...(wakeUp ? { wakeUp: true as const } : {}) })
  function queue(items: AgentFollowup[]) {
    const state: AgentState = { ...threadsStateFixture(), followups: items }
    const row = describeThreads(state, Date.parse(at)).find(item => item.thread.id === 'footer-links')!
    const command = vi.fn(async (request: { type: string; itemId?: string }) => ({ ...state, followups: items.filter(item => item.id !== request.itemId) }) as AgentState)
    render(<ThreadFollowups row={row} state={state} command={command as never} store={new ThreadDraftStore(vi.fn(async () => null), 0)} onRetryAdmission={vi.fn()} />)
    return command
  }

  it('shows it as Sotto’s after the user’s own, removable and never edited or moved', async () => {
    const command = queue([followup('a', 'Then add a changelog entry.'), followup('b', 'And a test.'), followup('w', WAKE_UP, true)])
    const items = document.querySelectorAll('.thread-followup')
    const wakeUp = items[2] as HTMLElement
    expect(wakeUp).toHaveAttribute('data-wake-up', 'true')
    expect(wakeUp).toHaveTextContent(/^Sotto · Wake-upSotto is babysitting a pull request/u)
    expect(within(wakeUp).queryByRole('button', { name: /Edit/u })).toBeNull()
    expect(within(wakeUp).queryByRole('button', { name: /Move/u })).toBeNull()
    // The user's last item cannot move past it.
    expect(screen.getByRole('button', { name: 'Move queued message 2 down' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Move queued message 1 down' })).not.toHaveAttribute('aria-disabled')
    fireEvent.click(within(wakeUp).getByRole('button', { name: 'Remove the wake-up from the queue' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'remove-followup', threadId: 'footer-links', itemId: 'w' }))
  })

  it('is echoed in the transcript as Sotto’s, word for word, where it will go', () => {
    render(<QueuedMessage item={followup('w', WAKE_UP, true)} />)
    const echo = screen.getByRole('article', { name: 'Queued wake-up from Sotto' })
    expect(echo).toHaveAttribute('data-from', 'sotto')
    expect(echo.querySelector('header')).toHaveTextContent('SottoWake-upQueued')
    expect(echo).toHaveTextContent('- Check CI / *build* failed')
    expect(echo.querySelector('ul')).toBeNull()
    cleanup()
    render(<QueuedMessage item={followup('a', 'Then add a changelog entry.')} />)
    expect(screen.getByRole('article', { name: 'Queued message' }).querySelector('header')).toHaveTextContent('You')
  })
})
