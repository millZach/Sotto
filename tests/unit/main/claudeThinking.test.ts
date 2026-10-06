// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ClaudeActivity } from '../../../src/main/agents/claudeActivity'
import { agentActivitySchema, MAX_ACTIVITY_TEXT, type AgentActivity } from '../../../src/shared/agentActivity'

/**
 * Frame shapes as Claude Code 2.1.289 sends them with `--include-partial-messages`, and as its transcript keeps them.
 * Every word here is invented for the test.
 */
const event = (value: Record<string, unknown>, parent?: string) => ({ type: 'stream_event', session_id: 'session', parent_tool_use_id: parent ?? null, event: value })
const start = (id: string, parent?: string) => event({ type: 'message_start', message: { id, role: 'assistant', content: [] } }, parent)
const blockStart = (index: number, block: Record<string, unknown>, parent?: string) => event({ type: 'content_block_start', index, content_block: block }, parent)
const delta = (index: number, value: Record<string, unknown>, parent?: string) => event({ type: 'content_block_delta', index, delta: value }, parent)
const stop = (index: number, parent?: string) => event({ type: 'content_block_stop', index }, parent)
const thinkingFrame = (reply: string, words: string, extra: Record<string, unknown> = {}) => ({ type: 'assistant', uuid: `${reply}-thinking`, session_id: 'session', parent_tool_use_id: null,
  message: { id: reply, role: 'assistant', content: [{ type: 'thinking', thinking: words, signature: 'c2lnbmF0dXJl' }] }, ...extra })

function run(projector: ClaudeActivity, frames: readonly Record<string, unknown>[], live = true, rows: AgentActivity[] = []): AgentActivity[] {
  for (const frame of frames) rows = projector.apply(rows, frame, 'user-1', 'user-1', 'C:/repo', live)
  return rows
}
const reasoning = (rows: readonly AgentActivity[]) => rows.filter(row => row.kind === 'reasoning')

describe('Claude thinking as it streams', () => {
  it('starts a Thinking row with the block, grows it with each delta and settles it when the block stops', () => {
    const projector = new ClaudeActivity()
    let rows = run(projector, [start('msg_1'), blockStart(0, { type: 'thinking', thinking: '', signature: '' })])
    expect(reasoning(rows)).toEqual([expect.objectContaining({ id: 'claude-thinking-msg_1-0', kind: 'reasoning', title: 'Thinking', status: 'running', afterMessageId: 'user-1', timingSource: 'observed' })])
    expect(reasoning(rows)[0]!.text).toBeUndefined()
    expect(reasoning(rows)[0]!.cwd).toBeUndefined()
    rows = run(projector, [delta(0, { type: 'thinking_delta', thinking: 'Reading the ' })], true, rows)
    expect(reasoning(rows)[0]).toMatchObject({ status: 'running', text: 'Reading the ' })
    rows = run(projector, [delta(0, { type: 'thinking_delta', thinking: 'config first.' }), delta(0, { type: 'signature_delta', signature: 'c2lnbmF0dXJl' })], true, rows)
    expect(reasoning(rows)[0]).toMatchObject({ status: 'running', text: 'Reading the config first.' })
    expect(JSON.stringify(rows)).not.toContain('c2lnbmF0dXJl')
    rows = run(projector, [stop(0)], true, rows)
    expect(reasoning(rows)).toHaveLength(1)
    expect(reasoning(rows)[0]).toMatchObject({ status: 'completed', text: 'Reading the config first.', completedAt: expect.any(String) })
    // The live frame that repeats the finished block adds no second row.
    rows = run(projector, [thinkingFrame('msg_1', 'Reading the config first.')], true, rows)
    expect(reasoning(rows)).toHaveLength(1)
    for (const row of rows) expect(agentActivitySchema.safeParse(row).success).toBe(true)
  })

  it('comes before the reply and the tools of the same message', () => {
    const projector = new ClaudeActivity()
    const rows = run(projector, [start('msg_1'), blockStart(0, { type: 'thinking', thinking: '' }), delta(0, { type: 'thinking_delta', thinking: 'Plan the edit.' }), stop(0),
      blockStart(1, { type: 'text', text: '' }), delta(1, { type: 'text_delta', text: 'Editing now.' }), stop(1),
      blockStart(2, { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }), delta(2, { type: 'input_json_delta', partial_json: '{"command":"npm test"}' }), stop(2)])
    expect(rows.map(row => row.kind)).toEqual(['reasoning', 'command'])
    expect(rows[0]!.sequence).toBeLessThan(rows[1]!.sequence)
  })

  it('shows a redacted block, or one with no words, as the row without text', () => {
    const projector = new ClaudeActivity()
    let rows = run(projector, [start('msg_1'), blockStart(0, { type: 'redacted_thinking', data: 'ZW5jcnlwdGVk' })])
    expect(reasoning(rows)).toEqual([expect.objectContaining({ title: 'Thinking', status: 'running' })])
    rows = run(projector, [stop(0), start('msg_2'), blockStart(0, { type: 'thinking', thinking: '' }), delta(0, { type: 'signature_delta', signature: 'c2ln' }), stop(0)], true, rows)
    expect(reasoning(rows)).toHaveLength(2)
    for (const row of reasoning(rows)) { expect(row.status).toBe('completed'); expect(row.text).toBeUndefined() }
    expect(JSON.stringify(rows)).not.toContain('ZW5jcnlwdGVk')
  })

  it('reads the same row back from the transcript, with the time Claude reported', () => {
    const live = run(new ClaudeActivity(), [start('msg_1'), blockStart(0, { type: 'thinking', thinking: '' }), delta(0, { type: 'thinking_delta', thinking: 'Check the tests.' }), stop(0)])
    const line = thinkingFrame('msg_1', 'Check the tests.', { apiBlockIndex: 0, thinkingDurationMs: 1500, timestamp: '2026-10-05T10:00:01.500Z' })
    const replayed = run(new ClaudeActivity(), [line], false)
    expect(reasoning(replayed)).toEqual([expect.objectContaining({ id: reasoning(live)[0]!.id, status: 'completed', text: 'Check the tests.',
      startedAt: '2026-10-05T10:00:00.000Z', completedAt: '2026-10-05T10:00:01.500Z', durationMs: 1500, timingSource: 'provider' })])
    // Read over the live row, the transcript's line settles it in place rather than adding another.
    const merged = run(new ClaudeActivity(), [line], false, live)
    expect(reasoning(merged)).toHaveLength(1)
    expect(reasoning(merged)[0]).toMatchObject({ text: 'Check the tests.', status: 'completed', durationMs: 1500 })
  })

  it('takes a live block the stream never showed from the reply frame', () => {
    const rows = run(new ClaudeActivity(), [thinkingFrame('msg_9', 'Only in the frame.')])
    expect(reasoning(rows)).toEqual([expect.objectContaining({ id: 'claude-thinking-msg_9-0', status: 'completed', text: 'Only in the frame.' })])
  })

  it('puts a subagent’s thinking under that subagent, as its tools are', () => {
    const rows = run(new ClaudeActivity(), [start('sub_1', 'agent-tool'), blockStart(0, { type: 'thinking', thinking: '' }, 'agent-tool'), delta(0, { type: 'thinking_delta', thinking: 'Inside.' }, 'agent-tool')])
    expect(reasoning(rows)).toEqual([expect.objectContaining({ parentId: 'claude-tool-agent-tool', text: 'Inside.', status: 'running' })])
  })

  it('settles a block the turn stopped in the middle of', () => {
    const projector = new ClaudeActivity()
    let rows = run(projector, [start('msg_1'), blockStart(0, { type: 'thinking', thinking: '' }), delta(0, { type: 'thinking_delta', thinking: 'Half a' })])
    rows = run(projector, [{ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'session' }], true, rows)
    expect(reasoning(rows)[0]).toMatchObject({ status: 'interrupted', text: 'Half a' })
  })

  it('cuts long thinking at the record’s detail budget and says so', () => {
    const projector = new ClaudeActivity()
    const half = 'x'.repeat(MAX_ACTIVITY_TEXT / 2 + 10)
    const rows = run(projector, [start('msg_1'), blockStart(0, { type: 'thinking', thinking: '' }), delta(0, { type: 'thinking_delta', thinking: half }), delta(0, { type: 'thinking_delta', thinking: half }), stop(0)])
    expect(reasoning(rows)[0]!.text).toHaveLength(MAX_ACTIVITY_TEXT)
    expect(reasoning(rows)[0]!.truncated).toBe(true)
    expect(agentActivitySchema.safeParse(reasoning(rows)[0]).success).toBe(true)
  })
})
