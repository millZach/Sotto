import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentMessage } from '../../../src/shared/agents'
import { MessageList, type ActivityContext } from '../../../src/renderer/src/agents/ThreadTranscript'
import { placeActivities } from '../../../src/renderer/src/agents/threadActivityView'

const context: ActivityContext = { liveTurn: 'turn-1', running: true, connected: true, provider: 'claude', onDisclosure: () => undefined }
const at = '2026-09-15T10:19:00.000Z'
const user: AgentMessage = { id: 'user-1', role: 'user', text: 'Look around the repo.', createdAt: at }
const reply = (id: string, text: string): AgentMessage => ({ id, role: 'assistant', text, createdAt: at })
const command = (afterMessageId: string): AgentActivity =>
  ({ id: 'claude-tool-1', turnId: 'turn-1', sequence: 1, kind: 'command', status: 'running', title: 'Bash', command: 'git status', afterMessageId })

function mount(messages: AgentMessage[], { running = true, streamText = true, activities = [] as AgentActivity[] } = {}) {
  render(<MessageList messages={messages} provider="claude" running={running} placement={placeActivities(messages, messages, activities)} context={context} streamText={streamText} />)
  return document.querySelectorAll('.thread-message')
}

afterEach(cleanup)

describe('assistant messages without text', () => {
  it('draws no header for a provider call that holds only tool use so far', () => {
    const articles = mount([user, reply('a-1', 'I will look.'), reply('a-2', ''), reply('a-3', '')])
    expect(articles).toHaveLength(2)
  })
})

describe('replies shown as written', () => {
  it('draws the reply being written', () => {
    mount([user, reply('a-1', 'Half a sent')])
    expect(screen.getByText('Half a sent')).toBeInTheDocument()
    expect(screen.queryByText('Writing a reply…')).not.toBeInTheDocument()
  })
})

describe('replies shown when finished', () => {
  it('holds back the reply being written', () => {
    mount([user, reply('a-1', 'Half a sent')], { streamText: false })
    expect(screen.queryByText('Half a sent')).not.toBeInTheDocument()
    expect(screen.getByText('Writing a reply…')).toHaveAttribute('role', 'status')
  })

  it('shows the reply once a tool call follows it, and the tool call as it runs', () => {
    mount([user, reply('a-1', 'I will look.')], { streamText: false, activities: [command('a-1')] })
    expect(screen.getByText('I will look.')).toBeInTheDocument()
    expect(screen.getByText('git status')).toBeInTheDocument()
  })

  it('shows the reply once a later provider call starts, even before it has text', () => {
    mount([user, reply('a-1', 'I will look.'), reply('a-2', 'Found i')], { streamText: false })
    expect(screen.getByText('I will look.')).toBeInTheDocument()
    expect(screen.queryByText('Found i')).not.toBeInTheDocument()
  })

  it('shows the whole reply when the turn ends', () => {
    mount([user, reply('a-1', 'All done.')], { running: false, streamText: false })
    expect(screen.getByText('All done.')).toBeInTheDocument()
    expect(screen.queryByText('Writing a reply…')).not.toBeInTheDocument()
  })
})
