// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ClaudeActivity } from '../../../src/main/agents/claudeActivity'
import type { AgentActivity } from '../../../src/shared/agentActivity'

/**
 * A call Claude was still writing when its turn was cut. Claude Code 2.1.296, cut by a steer sent now while it wrote a
 * Write call, sent the call's `content_block_start` and nothing more of it: no block stop, no assistant frame, no tool
 * result, then a `success` result with `terminal_reason` `aborted_streaming`. Every word here is invented for the test.
 */
const event = (value: Record<string, unknown>) => ({ type: 'stream_event', session_id: 'session', parent_tool_use_id: null, event: value })
const writing = (id: string) => [
  event({ type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } }),
  event({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name: 'Write', input: {} } }),
  event({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"notes.md","content":"The first lights' } }),
]
const cut = { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'aborted_streaming', session_id: 'session' }

function run(projector: ClaudeActivity, frames: readonly Record<string, unknown>[], turnEnd?: AgentActivity['status'], rows: AgentActivity[] = []): AgentActivity[] {
  for (const frame of frames) rows = projector.apply(rows, frame, 'user-1', 'user-1', 'C:/repo', true, frame.type === 'result' ? turnEnd : undefined)
  return rows
}
const call = (rows: readonly AgentActivity[], id: string) => rows.find(row => row.id === `claude-tool-${id}`)

describe('a Claude call cut while it was written', () => {
  it('settles the call the way its turn ended, since nothing will answer it', () => {
    const projector = new ClaudeActivity()
    const written = run(projector, writing('tool-1'))
    expect(call(written, 'tool-1')).toMatchObject({ kind: 'file-change', status: 'running' })
    expect(call(run(projector, [cut], 'interrupted', written), 'tool-1')).toMatchObject({ status: 'interrupted', completedAt: expect.any(String) })
  })

  it('leaves a call Claude finished writing to its own result', () => {
    const projector = new ClaudeActivity()
    const rows = run(projector, [...writing('tool-1'), event({ type: 'content_block_stop', index: 1 }), cut], 'interrupted')
    expect(call(rows, 'tool-1')?.status).toBe('running')
  })
})
