import { describe, expect, it } from 'vitest'
import { ClaudeActivity } from '../../../src/main/agents/claudeActivity'

/**
 * Claude's live stream frames carry no timestamp of their own, so without an observed start a running
 * command has no time at all and nothing downstream can say how long it has run. A replayed transcript
 * must still be given no clock it never had.
 */
const bash = { type: 'assistant', message: { role: 'assistant', content: [
  { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
] } }

describe('timing a live Claude command', () => {
  it('starts a running row at the moment Sotto received the frame, and says Sotto timed it', () => {
    const before = Date.now()
    const row = new ClaudeActivity().apply([], bash, 'turn-1', undefined, 'C:/repo', true)[0]!
    expect(row.status).toBe('running')
    expect(row.timingSource).toBe('observed')
    expect(Date.parse(row.startedAt!)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(row.startedAt!)).toBeLessThanOrEqual(Date.now())
  })

  it('prefers the provider’s own time when a frame carries one', () => {
    const at = '2026-09-21T10:00:00.000Z'
    const row = new ClaudeActivity().apply([], { ...bash, timestamp: at }, 'turn-1', undefined, 'C:/repo', true)[0]!
    expect(row.startedAt).toBe(at)
    expect(row.timingSource).toBe('provider')
  })

  it('leaves a replayed frame without a start rather than inventing one', () => {
    const row = new ClaudeActivity().apply([], bash, 'turn-1', undefined, 'C:/repo', false)[0]!
    expect(row.startedAt).toBeUndefined()
    expect(row.timingSource).toBeUndefined()
  })

  it('keeps the first start across later frames for the same tool', () => {
    const projector = new ClaudeActivity()
    const first = projector.apply([], bash, 'turn-1', undefined, 'C:/repo', true)
    const again = projector.apply(first, bash, 'turn-1', undefined, 'C:/repo', true)
    // The activity merge keeps the first start it saw, so a redelivered frame cannot restart the clock.
    expect(again[0]!.id).toBe(first[0]!.id)
    expect(Date.parse(first[0]!.startedAt!)).toBeLessThanOrEqual(Date.parse(again[0]!.startedAt!))
  })
})
