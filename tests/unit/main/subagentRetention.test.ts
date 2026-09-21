// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ClaudeActivity } from '../../../src/main/agents/claudeActivity'
import { CodexActivityProjection, codexItemSchema } from '../../../src/main/agents/codexActivity'
import { MAX_AGENT_ACTIVITIES, type AgentActivity, type ObservedAgent } from '../../../src/shared/agentActivity'

const assignmentCount = 5_000
const prompt = `Task title\n${'retained-prompt-sentinel '.repeat(400)}`
const result = 'retained-result-sentinel '.repeat(400)
const timestamp = '2026-09-20T12:00:00.000Z'
// Inspect only the adapter's owned lookup state, not the bounded activities supplied by the caller.
const cache = <T>(projector: object, name: string): Map<string, T> => Reflect.get(projector, name) as Map<string, T>
function expectCompact(agents: ObservedAgent[]): void {
  expect(agents).toHaveLength(assignmentCount)
  for (const agent of agents) {
    expect(agent.prompt).toBeUndefined()
    expect(agent.description).toBeUndefined()
    expect(agent.message).toBeUndefined()
    expect(agent.title?.length ?? 0).toBeLessThanOrEqual(240)
    expect(agent.model?.length ?? 0).toBeLessThanOrEqual(512)
  }
  const retained = JSON.stringify(agents)
  expect(retained).not.toContain('retained-prompt-sentinel')
  expect(retained).not.toContain('retained-result-sentinel')
  // Structural payload budget, independent of CI machine speed and provider task/result size.
  expect(retained.length).toBeLessThan(assignmentCount * 1_024)
}

describe('provider subagent cache retention', () => {
  it('keeps Claude identity aliases without retaining 5,000 archived prompts/results', () => {
    const projection = new ClaudeActivity()
    let rows: AgentActivity[] = []
    for (let index = 0; index < assignmentCount; index++) {
      const tool = `launch-${index}`
      rows = projection.apply(rows, { type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id: tool, name: 'Agent', input: { prompt } }] } }, 'turn', 'message', '/p')
      rows = projection.apply(rows, { type: 'system', subtype: 'task_started', task_id: `task-${index}`, tool_use_id: tool, timestamp }, 'turn', 'message', '/p')
      rows = projection.apply(rows, { type: 'user', timestamp, tool_use_result: { agentId: `native-${index}`, content: [{ type: 'text', text: result }] }, message: { content: [{ type: 'tool_result', tool_use_id: tool, content: result }] } }, 'turn', 'message', '/p')
    }
    for (let index = 0; index < MAX_AGENT_ACTIVITIES; index++) rows = projection.apply(rows, { type: 'assistant', message: { content: [{ type: 'tool_use', id: `ordinary-${index}`, name: 'Read', input: {} }] } }, 'turn', 'message', '/p')
    expect(rows).toHaveLength(MAX_AGENT_ACTIVITIES)
    expect(rows.every(row => row.agents === undefined)).toBe(true)
    expectCompact([...cache<ObservedAgent>(projection, 'agentsByTool').values()])
    expectCompact([...cache<ObservedAgent>(projection, 'agentsByTask').values()])
    rows = projection.apply(rows, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'reused', name: 'Agent', input: { resume: 'native-0', prompt: 'Check the revision' } }] } }, 'next', 'message', '/p')
    expect(rows.at(-1)!.agents![0]).toMatchObject({ id: 'claude-agent-launch-0', assignmentId: 'claude-tool-reused', status: 'running' })
    rows = projection.apply(rows, { type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed', summary: 'Late summary', timestamp }, 'next', 'message', '/p')
    expect(rows.at(-1)!.agents![0]).toMatchObject({ id: 'claude-agent-launch-1', assignmentId: 'claude-tool-launch-1', message: 'Late summary' })
  })

  it('keeps Codex child identity without retaining 5,000 archived prompts/results', () => {
    const projection = new CodexActivityProjection(() => 1_000)
    const thread = { id: 'sotto', messages: [], activities: [] as AgentActivity[] }
    for (let index = 0; index < assignmentCount; index++) {
      const child = `native-${index}`
      projection.item(thread, codexItemSchema.parse({ type: 'collabAgentToolCall', id: `spawn-${index}`, tool: 'spawnAgent', status: 'completed', receiverThreadIds: [child], prompt, agentsStates: { [child]: { status: 'completed', message: result } } }), { turnId: 'turn', phase: 'history' })
    }
    for (let index = 0; index < MAX_AGENT_ACTIVITIES; index++) projection.item(thread, codexItemSchema.parse({ type: 'commandExecution', id: `ordinary-${index}`, status: 'completed', command: 'echo done' }), { turnId: 'turn', phase: 'history' })
    expect(thread.activities).toHaveLength(MAX_AGENT_ACTIVITIES)
    expect(thread.activities.every(row => row.agents === undefined)).toBe(true)
    const identities = [...cache<{ agent: ObservedAgent }>(projection, 'children').values()].map(owner => owner.agent)
    expectCompact(identities)
    projection.childNotification('native-0', 'turn/completed', { turn: { status: 'failed', error: { message: 'Late failure' } } })
    expect(thread.activities.at(-1)!.agents![0]).toMatchObject({ id: identities[0]!.id, assignmentId: identities[0]!.assignmentId, status: 'failed', message: 'Late failure' })
    projection.item(thread, codexItemSchema.parse({ type: 'collabAgentToolCall', id: 'reused', tool: 'sendInput', prompt: 'Check the revision', status: 'completed', receiverThreadIds: ['native-1'], agentsStates: { 'native-1': { status: 'running' } } }), { turnId: 'next', phase: 'completed' })
    expect(thread.activities.at(-1)!.agents![0]).toMatchObject({ id: identities[1]!.id, status: 'running', prompt: 'Check the revision' })
    expect(thread.activities.at(-1)!.agents![0]!.assignmentId).not.toBe(identities[1]!.assignmentId)
  })
})
