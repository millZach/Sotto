// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ClaudeActivity } from '../../../src/main/agents/claudeActivity'
import { CodexActivityProjection, codexItemSchema } from '../../../src/main/agents/codexActivity'
import { grokActivities } from '../../../src/main/agents/grokActivity'
import { devinActivities } from '../../../src/main/agents/devinActivity'
import { agentActivitySchema, mergeAgentActivities, type AgentActivity } from '../../../src/shared/agentActivity'

const timestamp = '2026-09-20T12:00:00.000Z'
const claudeTool = (id: string, input: Record<string, unknown>, parent?: string) => ({ type: 'assistant', timestamp,
  ...(parent ? { parent_tool_use_id: parent } : {}), message: { content: [{ type: 'tool_use', id, name: 'Agent', input }] } })

describe('observational subagent roster metadata', () => {
  it('keeps Codex identity and assignment through spawn, wait and child completion without completing on parent/tool finish', () => {
    let now = 1_000
    const projection = new CodexActivityProjection(() => now)
    const thread = { id: 'sotto', messages: [], activities: [] as AgentActivity[] }
    const item = (id: string, tool: string, status: string, prompt?: string) => codexItemSchema.parse({ id, type: 'collabAgentToolCall', tool, status: 'completed', receiverThreadIds: ['native-child'], agentsStates: { 'native-child': { status } }, prompt, model: tool === 'spawnAgent' ? 'reported-model' : undefined })
    projection.item(thread, item('spawn', 'spawnAgent', 'running', 'Review tests'), { turnId: 'parent-turn', phase: 'completed' })
    const initial = thread.activities[0]!.agents![0]!
    expect(initial).toMatchObject({ status: 'running', model: 'reported-model', title: 'Review tests', startedAt: new Date(now).toISOString() })
    expect(initial.completedAt).toBeUndefined()
    projection.turn(thread, { id: 'parent-turn', status: 'completed' }, true)
    expect(thread.activities[0]!.agents![0]!.status).toBe('running')
    now = 2_000
    projection.item(thread, item('wait', 'wait', 'running'), { turnId: 'later-turn', phase: 'completed' })
    expect(thread.activities.at(-1)!.agents![0]).toMatchObject({ id: initial.id, assignmentId: initial.assignmentId, model: 'reported-model' })
    projection.childNotification('native-child', 'turn/completed', { turn: { status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1_000 } })
    expect(thread.activities.at(-1)!.agents![0]).toMatchObject({ status: 'completed', completedAt: new Date(now).toISOString(), durationMs: 1_000 })
    now = 3_000
    projection.item(thread, item('followup', 'sendInput', 'running', 'Check the revision'), { turnId: 'third-turn', phase: 'completed' })
    const reused = thread.activities.at(-1)!.agents![0]!
    expect(reused.id).toBe(initial.id)
    expect(reused.assignmentId).not.toBe(initial.assignmentId)
    expect(reused.startedAt).toBe(new Date(now).toISOString())
    expect(reused.completedAt).toBeUndefined()
    expect(reused.message).toBeUndefined()
    expect(JSON.stringify(thread)).not.toContain('native-child')
    thread.activities.forEach(row => agentActivitySchema.parse(row))
  })

  it('preserves Codex child lifecycle and model when a long task exhausts the detail budget', () => {
    const projection = new CodexActivityProjection(() => 1_000)
    const thread = { id: 'sotto', messages: [], activities: [] as AgentActivity[] }
    projection.item(thread, codexItemSchema.parse({ id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', prompt: 'Review tests\n' + 'x'.repeat(70_000), model: 'reported-model', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } }), { turnId: 'turn', phase: 'completed' })
    expect(thread.activities[0]!.agents![0]).toMatchObject({ status: 'running', model: 'reported-model', title: 'Review tests' })
    expect(thread.activities[0]!.agents![0]!.prompt).toHaveLength(65_536)
    expect(thread.activities[0]!.truncated).toBe(true)
    agentActivitySchema.parse(thread.activities[0])
  })

  it('maps Codex nested spawn parent IDs and does not invent model or historical timing', () => {
    const projection = new CodexActivityProjection(() => 1_000)
    const thread = { id: 'sotto', messages: [], activities: [] as AgentActivity[] }
    projection.item(thread, codexItemSchema.parse({ id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } }), { turnId: 'old', phase: 'history' })
    const child = thread.activities[0]!.agents![0]!
    expect(child.model).toBeUndefined()
    expect(child.startedAt).toBeUndefined()
    expect(child.observedAt).toBeUndefined()
    projection.childNotification('child', 'item/completed', { turnId: 'nested', item: { id: 'nested-spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['grandchild'], agentsStates: { grandchild: { status: 'running' } } } })
    expect(thread.activities.at(-1)!.agents![0]!.parentId).toBe(child.id)
  })

  it('unifies Claude launch/task rows, records only reported models, and preserves the background child after launch acknowledgement', () => {
    const projection = new ClaudeActivity()
    let rows = projection.apply([], claudeTool('launch', { description: 'Review tests', prompt: 'Check assertions', model: 'sonnet', run_in_background: true }), 'turn', 'message', '/p')
    const launched = rows[0]!.agents![0]!
    rows = projection.apply(rows, { type: 'system', subtype: 'task_started', task_id: 'task', tool_use_id: 'launch', description: 'Review tests', timestamp }, 'turn', 'message', '/p')
    expect(rows.at(-1)!.agents![0]).toMatchObject({ id: launched.id, assignmentId: launched.assignmentId, model: 'sonnet' })
    rows = projection.apply(rows, { type: 'user', timestamp, tool_use_result: { agentId: 'native-agent', isAsync: true }, message: { content: [{ type: 'tool_result', tool_use_id: 'launch', content: 'Launched' }] } }, 'turn', 'message', '/p')
    expect(rows[0]!.status).toBe('completed')
    expect(rows[0]!.agents![0]!.status).toBe('running')
    rows = projection.apply(rows, { type: 'assistant', timestamp, parent_tool_use_id: 'launch', message: { model: 'claude-sonnet-reported', content: [] } }, 'turn', 'message', '/p')
    expect(rows.at(-1)!.agents![0]!.model).toBe('claude-sonnet-reported')
    rows = projection.apply(rows, { type: 'system', subtype: 'task_notification', task_id: 'task', status: 'completed', summary: 'Tests verified', timestamp: '2026-09-20T12:01:00.000Z' }, 'later', 'other', '/p')
    expect(rows.at(-1)!.agents![0]).toMatchObject({ id: launched.id, message: 'Tests verified', status: 'completed', completedAt: '2026-09-20T12:01:00.000Z' })
    rows = projection.apply(rows, claudeTool('resume', { resume: 'native-agent', prompt: 'Check revision' }), 'next', 'next', '/p')
    expect(rows.at(-1)!.agents![0]).toMatchObject({ id: launched.id, assignmentId: 'claude-tool-resume', status: 'running', title: 'Check revision' })
    expect(rows.at(-1)!.agents![0]!.model).toBeUndefined()
    rows.forEach(row => agentActivitySchema.parse(row))
  })

  it('waits for streamed Agent input before identifying a resumed child and resolves durable hashed aliases', () => {
    const first = new ClaudeActivity()
    let rows = first.apply([], claudeTool('original', { prompt: 'First' }), 'turn', 'message', '/p')
    rows = first.apply(rows, { type: 'user', tool_use_result: { agentId: 'native-agent', content: [{ type: 'text', text: 'Done' }] }, message: { content: [{ type: 'tool_result', tool_use_id: 'original', content: 'Done' }] } }, 'turn', 'message', '/p')
    const original = rows[0]!.agents![0]!
    const alias = original.aliasIds![0]!
    expect(alias).not.toContain('native-agent')
    for (const projector of [first, new ClaudeActivity(id => id === alias ? rows[0] : undefined)]) {
      let stream = projector.apply([], { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'resumed', name: 'Agent', input: {} } } }, 'next', 'next', '/p')
      expect(stream[0]!.agents).toBeUndefined()
      stream = projector.apply(stream, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ resume: 'native-agent', prompt: 'Second' }) } } }, 'next', 'next', '/p')
      expect(stream[0]!.agents![0]).toMatchObject({ id: original.id, assignmentId: 'claude-tool-resumed', prompt: 'Second' })
    }
  })

  it('marks a rejected Claude agent launch failed even without structured tool result metadata', () => {
    const projection = new ClaudeActivity()
    let rows = projection.apply([], claudeTool('launch', { prompt: 'Review tests' }), 'turn', 'message', '/p')
    rows = projection.apply(rows, { type: 'system', subtype: 'task_started', task_id: 'task', tool_use_id: 'launch', timestamp }, 'turn', 'message', '/p')
    rows = projection.apply(rows, { type: 'user', timestamp, message: { content: [{ type: 'tool_result', tool_use_id: 'launch', is_error: true, content: 'Agent limit reached' }] } }, 'turn', 'message', '/p')
    expect(rows[0]!.agents![0]).toMatchObject({ status: 'failed', message: 'Agent limit reached', completedAt: timestamp })
    const later = projection.apply(rows, { type: 'system', subtype: 'task_progress', task_id: 'task', timestamp }, 'turn', 'message', '/p')
    expect(later).toEqual(rows)
  })

  it('nests Claude children and preserves current metadata after activity eviction', () => {
    const projection = new ClaudeActivity()
    const parent = projection.apply([], claudeTool('parent', { prompt: 'Review' }), 'turn', 'message', '/p')[0]!.agents![0]!
    let rows = projection.apply([], claudeTool('child', { prompt: 'Check tests' }, 'parent'), 'turn', 'message', '/p')
    expect(rows[0]!.agents![0]!.parentId).toBe(parent.id)
    projection.apply(rows, { type: 'system', subtype: 'task_started', task_id: 'task', tool_use_id: 'child', timestamp }, 'turn', 'message', '/p')
    rows = projection.apply([], { type: 'system', subtype: 'task_notification', task_id: 'task', status: 'completed', summary: 'Passed', timestamp }, 'turn', 'message', '/p')
    expect(rows[0]!.agents![0]).toMatchObject({ id: 'claude-agent-child', parentId: parent.id, title: 'Check tests', message: 'Passed' })
  })

  it('keeps Grok attempts on the same child and sends results and actual metadata without inferring a parent model', () => {
    const context = { turnId: 'turn', cwd: '/p' }
    let rows = grokActivities({ sessionUpdate: 'subagent_spawned', subagent_id: 'child', attempt_id: 'one', parent_subagent_id: 'parent', model_id: 'reported', description: 'Review' }, context)
    expect(rows[0]!.agents![0]).toMatchObject({ id: 'grok-child-child', assignmentId: 'grok-agent-child-one', parentId: 'grok-child-parent', model: 'reported' })
    expect(rows[0]!.agents![0]!.observedAt).toBeUndefined()
    rows = mergeAgentActivities(rows, grokActivities({ sessionUpdate: 'subagent_finished', subagent_id: 'child', attempt_id: 'one', status: 'completed', output: 'Verified' }, context, rows))
    expect(rows[0]!.agents![0]!.message).toBe('Verified')
    const second = grokActivities({ sessionUpdate: 'subagent_spawned', subagent_id: 'child', attempt_id: 'two', prompt: 'Review again' }, context, rows)
    expect(second[0]!.agents![0]).toMatchObject({ id: 'grok-child-child', assignmentId: 'grok-agent-child-two', title: 'Review again' })
    expect(second[0]!.agents![0]!.model).toBeUndefined()
    expect(second[0]!.agents![0]!.message).toBeUndefined()
    expect(grokActivities({ sessionUpdate: 'subagent_finished', subagent_id: 'child', status: 'completed' }, context)[0]!.agents![0]!.assignmentId).toBeUndefined()
  })

  it('does not invent a roster child for an ordinary ACP tool named Agent', () => {
    const rows = devinActivities({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Agent', status: 'in_progress' }, { turnId: 'turn', cwd: '/p' })
    expect(rows[0]!.agents).toBeUndefined()
  })
})
