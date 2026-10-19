import { describe, expect, it } from 'vitest'
import { commandFailure } from '../../../src/renderer/src/agents/AgentContext'

const UNCONFIRMED = 'The action could not be confirmed. Your draft is retained; check the connection before retrying.'
const invoked = (said: string): Error => new Error(`Error invoking remote method 'sotto:agents:command': ${said}`)

describe('the Threads page banner for a command that failed', () => {
  it('says what main said when main said it in words', () => {
    expect(commandFailure(invoked('Error: forge is disconnected. Nothing was sent. Try again once it reconnects.')))
      .toBe('forge is disconnected. Nothing was sent. Try again once it reconnects.')
    expect(commandFailure(invoked('HostConnectionError: The connection closed before the host confirmed this command. Refresh before deciding what to do next.')))
      .toBe('The connection closed before the host confirmed this command. Refresh before deciding what to do next.')
  })
  it('keeps the unconfirmed sentence for a code, a schema failure or nothing at all', () => {
    expect(commandFailure(invoked('Error: AGENT_SENDER_REJECTED'))).toBe(UNCONFIRMED)
    expect(commandFailure(invoked('ZodError: [\n  {\n    "code": "invalid_type"\n  }\n]'))).toBe(UNCONFIRMED)
    expect(commandFailure(new Error(''))).toBe(UNCONFIRMED)
    expect(commandFailure('not an error')).toBe(UNCONFIRMED)
  })
})
