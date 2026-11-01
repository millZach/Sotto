import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { AgentMessage, ThreadModelMoved } from '../../../src/shared/agents'
import { MessageList, type ActivityContext } from '../../../src/renderer/src/agents/ThreadTranscript'
import { placeActivities } from '../../../src/renderer/src/agents/threadActivityView'

afterEach(cleanup)

const context: ActivityContext = { liveTurn: null, running: false, connected: true, provider: 'claude', onDisclosure: () => undefined }
const message = (id: string, role: 'user' | 'assistant', createdAt: string): AgentMessage => ({ id, role, text: id, createdAt })
const messages = [message('ask', 'user', '2026-10-30T10:00:00.000Z'), message('answer', 'assistant', '2026-10-30T10:01:00.000Z'),
  message('again', 'user', '2026-10-31T12:00:00.000Z'), message('reply', 'assistant', '2026-10-31T12:01:00.000Z')]

function mount(moved: ThreadModelMoved): string[] {
  render(<MessageList messages={messages} provider="Claude Code" running={false} placement={placeActivities(messages, messages, [])} context={context} modelMoved={moved} />)
  return [...document.querySelectorAll('.thread-message, .thread-boundary')].map(row => row.classList.contains('thread-boundary') ? 'note' : row.textContent?.match(/ask|answer|again|reply/u)?.[0] ?? '')
}

// ADR-0171: a thread Sotto moved off a model its provider stopped offering says so once, where the move happened.
describe('the note of a model move', () => {
  it('names both models and the provider, after the turn begun last before the move', () => {
    expect(mount({ from: 'Opus 5.5 with 1M context', to: 'Opus 5.5', at: '2026-10-31T08:00:00.000Z' })).toEqual(['ask', 'answer', 'note', 'again', 'reply'])
    expect(screen.getByRole('note')).toHaveTextContent('Claude Code no longer offers Opus 5.5 with 1M context, so this thread now uses Opus 5.5.')
  })

  it('leads the conversation when the move came before every message shown', () => {
    expect(mount({ from: 'Fable 5', to: 'Fable 5.1', at: '2026-10-29T08:00:00.000Z' })[0]).toBe('note')
  })
})
