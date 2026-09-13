// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ClaudeActivity } from '../../../src/main/agents/claudeActivity'
import { grokActivities } from '../../../src/main/agents/grokActivity'
import { mergeAgentActivities } from '../../../src/shared/agentActivity'

describe('native activity projection', () => {
  it('keeps Claude tool identity, command context, result and parent agent across live/log replay', () => {
    const projector = new ClaudeActivity()
    const start = { type: 'assistant', parent_tool_use_id: 'agent-call', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'echo hello' } }] } }
    const running = projector.apply([], start, 'turn', 'message', '/project')
    expect(running[0]).toMatchObject({ id: 'claude-tool-tool-1', kind: 'command', status: 'running', command: 'echo hello', afterMessageId: 'message', parentId: 'claude-tool-agent-call' })
    const done = projector.apply(running, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'hello', is_error: false }] } }, 'turn', 'later', '/project')
    expect(done[0]).toMatchObject({ status: 'completed', output: 'hello', afterMessageId: 'message' })
    expect(projector.apply(done, start, 'turn', 'later', '/project')).toEqual(done)
  })
  it('maps file edits and task lifecycle without copying agent narration into the main answer', () => {
    const projector = new ClaudeActivity()
    let rows = projector.apply([], { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: '/p/a', old_string: 'a', new_string: 'b' } }] } }, 't', 'm', '/p')
    expect(rows[0]).toMatchObject({ kind: 'file-change', changes: [{ path: '/p/a', kind: 'Edit' }] })
    rows = projector.apply(rows, { type: 'system', subtype: 'task_started', task_id: 'task', tool_use_id: 'spawn', description: 'Review' }, 't', 'm', '/p')
    rows = projector.apply(rows, { type: 'system', subtype: 'task_notification', task_id: 'task', status: 'completed', summary: 'Checked' }, 't', 'm2', '/p')
    expect(rows[1]).toMatchObject({ kind: 'subagent', status: 'completed', agents: [{ id: 'task', status: 'completed' }], afterMessageId: 'm' })
  })
  it('upserts ACP full output snapshots and preserves status on replay', () => {
    const context = { turnId: 'turn', afterMessageId: 'user', cwd: '/p' }
    const initial = grokActivities({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Run', kind: 'execute', status: 'in_progress', rawInput: { command: 'echo hi' } }, context)
    const complete = grokActivities({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'hi' } }], rawOutput: { exitCode: 0 } }, context, initial)
    const rows = mergeAgentActivities(initial, complete)
    expect(rows[0]).toMatchObject({ kind: 'command', command: 'echo hi', output: 'hi', exitCode: 0, status: 'completed' })
    expect(mergeAgentActivities(mergeAgentActivities(rows, complete), initial)).toEqual(rows)
  })
  it('maps Grok native subagent attempts as observational history without routable addresses', () => {
    const context = { turnId: 'turn', afterMessageId: 'user', cwd: '/p' }
    const running = grokActivities({ sessionUpdate: 'subagent_spawned', subagent_id: 'child', child_session_id: 'child', attempt_id: 'attempt', description: 'Review', agentAddress: 'private-address' }, context)
    expect(running[0]).toMatchObject({ kind: 'subagent', status: 'running', title: 'Review', agents: [{ id: 'child', status: 'running' }] })
    const finished = grokActivities({ sessionUpdate: 'subagent_finished', subagent_id: 'child', child_session_id: 'child', attempt_id: 'attempt', status: 'failed', error: 'Tool rejected', duration_ms: 30 }, context, running)
    expect(finished[0]).toMatchObject({ status: 'failed', error: 'Tool rejected', durationMs: 30 })
    expect(JSON.stringify(finished)).not.toContain('private-address')
  })
  it('marks clipped native output and never invents a start time from a result timestamp', () => {
    const rows = new ClaudeActivity().apply([], { type: 'user', timestamp: '2026-09-13T00:00:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'x'.repeat(70000) }] } }, 't', 'm', '/p')
    expect(rows[0]).toMatchObject({ truncated: true, completedAt: '2026-09-13T00:00:00.000Z' })
    expect(rows[0]?.startedAt).toBeUndefined()
    expect(rows[0]?.output).toHaveLength(65536)
  })
  it('keeps an older Grok subagent identity when completion arrives during a later parent turn', () => {
    const running = grokActivities({ sessionUpdate: 'subagent_spawned', subagent_id: 'child', description: 'Review' }, { turnId: 'one', cwd: '/p' })
    const finished = grokActivities({ sessionUpdate: 'subagent_finished', subagent_id: 'child', status: 'completed' }, { turnId: 'two', cwd: '/p' }, running)
    expect(finished[0]?.id).toBe(running[0]?.id)
    expect(finished[0]?.turnId).toBe('one')
  })
})
