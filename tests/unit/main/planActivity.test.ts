// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ClaudeActivity } from '../../../src/main/agents/claudeActivity'
import { grokActivities } from '../../../src/main/agents/grokActivity'
import { planSteps } from '../../../src/shared/agentActivity'

describe('plans as checklists', () => {
  it('maps each provider’s step states onto the same three, and drops empty steps', () => {
    expect(planSteps([{ text: 'Read the parser', status: 'completed' }, { text: 'Fix the bug', status: 'in_progress' },
      { text: 'Add a test', status: 'pending' }, { text: '  ', status: 'pending' }, { text: 42, status: 'done' }]))
      .toEqual([{ text: 'Read the parser', status: 'completed' }, { text: 'Fix the bug', status: 'running' }, { text: 'Add a test', status: 'pending' }])
  })

  it('reads Claude’s todo list as the turn’s plan instead of tool input', () => {
    const projector = new ClaudeActivity()
    const rows = projector.apply([], { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'todo', name: 'TodoWrite', input: { todos: [
      { content: 'Reproduce the failure', status: 'completed', activeForm: 'Reproducing the failure' },
      { content: 'Patch the adapter', status: 'in_progress', activeForm: 'Patching the adapter' },
    ] } }] } }, 'turn', 'message', '/project')
    expect(rows[0]).toMatchObject({ kind: 'plan', title: 'Plan', steps: [
      { text: 'Reproduce the failure', status: 'completed' }, { text: 'Patch the adapter', status: 'running' },
    ] })
    expect(rows[0]!.text).toBeUndefined()
  })

  it('keeps one Grok plan row per turn as the plan is revised', () => {
    const context = { turnId: 'turn', afterMessageId: 'user', cwd: '/p' }
    const first = grokActivities({ sessionUpdate: 'plan', entries: [{ content: 'Look at the log', status: 'in_progress' }, { content: 'Write the fix', status: 'pending' }] }, context)
    expect(first).toEqual([expect.objectContaining({ id: 'grok-plan-turn', kind: 'plan', title: 'Plan',
      steps: [{ text: 'Look at the log', status: 'running' }, { text: 'Write the fix', status: 'pending' }] })])
    const second = grokActivities({ sessionUpdate: 'plan', entries: [{ content: 'Look at the log', status: 'completed' }, { content: 'Write the fix', status: 'in_progress' }] }, context, first)
    expect(second[0]!.id).toBe('grok-plan-turn')
    expect(second[0]!.steps).toEqual([{ text: 'Look at the log', status: 'completed' }, { text: 'Write the fix', status: 'running' }])
    expect(grokActivities({ sessionUpdate: 'plan', entries: [] }, context, second)).toEqual([])
  })
})
