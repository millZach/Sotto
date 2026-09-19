// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ThreadMessageLog } from '../../../src/main/agents/threadMessageLog'
import type { AgentMessage } from '../../../src/shared/agents'
import type { ThreadHostEvent } from '../../../src/main/agents/host'

const message = (id: string, role: AgentMessage['role'], text: string): AgentMessage => ({ id, role, text, createdAt: '2026-09-19T10:00:00.000Z' })

describe('the append path a provider rail is handed to', () => {
  it('treats a shorter or partial list as a partial read, never as a rewind', () => {
    const log = new ThreadMessageLog()
    const events: ThreadHostEvent[] = []
    log.subscribeEvents(event => events.push(event))
    log.seed('t', [{ id: 'u0', role: 'user' }, { id: 'a0', role: 'assistant' }, { id: 'u1', role: 'user' }])

    // A capped poll that only reached the first turn so far.
    log.set('t', [message('u0', 'user', 'First'), message('a0', 'assistant', 'Reply')])
    // A session read afresh after a reap, arriving with the tail alone.
    log.set('t', [message('u1', 'user', 'Second'), message('a1', 'assistant', 'Second reply')])

    expect(events.map(item => item.event.kind)).not.toContain('messages-reset')
    // What the store already held was recognised; only the unseen message was added.
    expect(events.filter(item => item.event.kind === 'message-added').map(item => item.event.kind === 'message-added' ? item.event.message.id : '')).toEqual(['a1'])
  })

  it('adds what is new and appends what grew when the rail is handed over again', () => {
    const log = new ThreadMessageLog()
    const events: ThreadHostEvent[] = []
    log.subscribeEvents(event => events.push(event))
    log.set('t', [message('u0', 'user', 'Ask'), message('a0', 'assistant', 'Par')])
    log.set('t', [message('u0', 'user', 'Ask'), message('a0', 'assistant', 'Partial reply')])
    expect(events.map(item => item.event.kind)).toEqual(['message-added', 'message-added', 'message-text-appended'])
    expect(log.messages('t').map(item => item.text)).toEqual(['Ask', 'Partial reply'])
  })
})
