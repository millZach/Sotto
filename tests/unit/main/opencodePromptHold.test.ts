import { describe, expect, it } from 'vitest'
import { promptHoldsServer } from '../../../src/main/agents/opencode'

/**
 * A prompt whose answer was lost keeps its thread's server for a minute, in case OpenCode is still taking it (#1107). The
 * minute runs from when the answer was lost, not from when the send began, which on a cold start can be most of a minute
 * earlier: the server's start, Sotto's tools and the prompt's own wait come first (#1143).
 */
describe('promptHoldsServer', () => {
  const sent = Date.parse('2026-10-17T00:00:00.000Z')
  const origin = { confirmed: false, createdAt: new Date(sent).toISOString() }
  const lostAt = sent + 50_000

  it('holds the server for a minute from when the answer was lost', () => {
    expect(promptHoldsServer(origin, lostAt, lostAt + 20_000)).toBe(true)
    expect(promptHoldsServer(origin, lostAt, lostAt + 59_999)).toBe(true)
    expect(promptHoldsServer(origin, lostAt, lostAt + 60_000)).toBe(false)
  })

  it('holds a prompt still on its way for a minute from when it was sent, and a confirmed one never', () => {
    expect(promptHoldsServer(origin, undefined, sent + 30_000)).toBe(true)
    expect(promptHoldsServer(origin, undefined, sent + 60_000)).toBe(false)
    expect(promptHoldsServer({ ...origin, confirmed: true }, lostAt, lostAt + 1_000)).toBe(false)
  })
})
