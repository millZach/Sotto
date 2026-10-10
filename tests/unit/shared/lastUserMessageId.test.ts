// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { lastUserMessageIdOf, type AgentMessage } from '../../../src/shared/agents'

const message = (id: string, role: AgentMessage['role']): AgentMessage => ({ id, role, text: id, createdAt: '2026-09-30T10:00:00.000Z' })

describe('the user message a send names for the stale-reply check', () => {
  it('is the one the adapter recorded, even when the window does not hold it', () => {
    expect(lastUserMessageIdOf({ messages: [], lastUserMessageId: 'recorded' })).toBe('recorded')
    expect(lastUserMessageIdOf({ messages: [message('older', 'user'), message('reply', 'assistant')], lastUserMessageId: 'recorded' })).toBe('recorded')
  })
  it('falls back to the window for a host that does not say yet', () => {
    expect(lastUserMessageIdOf({ messages: [message('first', 'user'), message('second', 'user'), message('reply', 'assistant')] })).toBe('second')
    expect(lastUserMessageIdOf({ messages: [message('reply', 'assistant')] })).toBeNull()
    expect(lastUserMessageIdOf({ messages: [] })).toBeNull()
  })
})
