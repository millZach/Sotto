// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ClaudeActivity } from '../../../src/main/agents/claudeActivity'

/**
 * Every frame of a streamed Claude reply passes through the activity projector, and most of them are text that
 * changes no record. Handing back a new array for each one told every cache that reuses a thread's records by
 * identity that everything had changed (#771).
 */
const bash = { type: 'assistant', message: { role: 'assistant', content: [
  { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
] } }
const textDelta = { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'More words' } } }

describe('the Claude activity projector', () => {
  it('returns the records it was given when a frame changes none of them', () => {
    const projector = new ClaudeActivity()
    const records = projector.apply([], bash, 'turn-1', undefined, 'C:/repo', true)
    expect(projector.apply(records, textDelta, 'turn-1', undefined, 'C:/repo', true)).toBe(records)
    // The same tool call delivered again is the same record.
    expect(projector.apply(records, bash, 'turn-1', undefined, 'C:/repo', true)).toBe(records)
  })

  it('returns new records when a frame changes one', () => {
    const projector = new ClaudeActivity()
    const records = projector.apply([], bash, 'turn-1', undefined, 'C:/repo', true)
    const result = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } }
    const finished = projector.apply(records, result, 'turn-1', undefined, 'C:/repo', true)
    expect(finished).not.toBe(records)
    expect(finished[0]).toMatchObject({ id: 'claude-tool-tool-1', status: 'completed', output: 'ok' })
  })
})
