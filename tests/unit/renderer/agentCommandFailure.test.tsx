import { describe, expect, it } from 'vitest'
import type { AgentState } from '../../../src/shared/agents'
import { commandFailure } from '../../../src/renderer/src/agents/AgentContext'
import { checkedOnConnectedHost } from '../../../src/renderer/src/agents/ThreadPane'

const UNCONFIRMED = 'The action could not be confirmed. Your draft is retained; check the connection before retrying.'
const invoked = (said: string): Error => new Error(`Error invoking remote method 'sotto:agents:command': ${said}`)

describe('the Threads page banner for a command that failed', () => {
  it('says what main said when main said it in words', () => {
    expect(commandFailure(invoked('Error: forge is disconnected. Nothing was sent. Try again once it reconnects.')))
      .toBe('forge is disconnected. Nothing was sent. Try again once it reconnects.')
    expect(commandFailure(invoked('HostConnectionError: The connection closed before the host confirmed this command. Refresh before deciding what to do next.')))
      .toBe('The connection closed before the host confirmed this command. Refresh before deciding what to do next.')
    expect(commandFailure(invoked('Error: [forge] is disconnected. Nothing was sent. Try again once it reconnects.')))
      .toBe('[forge] is disconnected. Nothing was sent. Try again once it reconnects.')
  })
  it('keeps the unconfirmed sentence for a code, a schema failure or nothing at all', () => {
    expect(commandFailure(invoked('Error: AGENT_SENDER_REJECTED'))).toBe(UNCONFIRMED)
    expect(commandFailure(invoked('ZodError: [\n  {\n    "code": "invalid_type"\n  }\n]'))).toBe(UNCONFIRMED)
    expect(commandFailure(new Error(''))).toBe(UNCONFIRMED)
    expect(commandFailure('not an error')).toBe(UNCONFIRMED)
  })
})

describe('Check again on a request card', () => {
  const reply = (connected: boolean, error: string | null = null): AgentState => ({ error,
    host: { connected: true, threads: [{ id: 'forge:thread', hostId: 'forge' }], clientHosts: [{ hostId: 'forge', connected }] } }) as unknown as AgentState
  it('counts only when the thread was read on a host that is still connected', () => {
    expect(checkedOnConnectedHost(reply(true), 'forge:thread')).toBe(true)
    // Main answers a dropped connection with the shell, quietly; that is not a check.
    expect(checkedOnConnectedHost(reply(false), 'forge:thread')).toBe(false)
    expect(checkedOnConnectedHost(reply(true, 'Refused.'), 'forge:thread')).toBe(false)
    expect(checkedOnConnectedHost(reply(true), 'gone')).toBe(false)
    expect(checkedOnConnectedHost(null, 'forge:thread')).toBe(false)
  })
})
