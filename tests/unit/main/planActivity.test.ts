// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ClaudeActivity } from '../../../src/main/agents/providers/claude/claudeActivity'
import { grokActivities } from '../../../src/main/agents/grokActivity'
import { planSteps, type AgentActivity } from '../../../src/shared/agentActivity'

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
    // The step in progress keeps the words Claude says it with while it runs, for the working line.
    expect(rows[0]).toMatchObject({ kind: 'plan', title: 'Plan', steps: [
      { text: 'Reproduce the failure', status: 'completed' }, { text: 'Patch the adapter', status: 'running', active: 'Patching the adapter' },
    ] })
    expect(rows[0]!.steps![0]).not.toHaveProperty('active')
    expect(rows[0]!.text).toBeUndefined()
  })

  // Claude Code 2.1.328's task tools, in the shape a real Sonnet 5.5 turn sent them: one call per task, results by id.
  describe('Claude’s task tools', () => {
    const call = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
    const answer = (id: string, content: string, result: Record<string, unknown>, isError = false) =>
      ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, tool_use_result: result })
    /** Applies each frame in turn, as the stream sends them, and answers the rows that stand after the last. */
    const run = (projector: ClaudeActivity, turnId: string, frames: Record<string, unknown>[], rows: AgentActivity[] = []) =>
      frames.reduce((previous, frame) => projector.apply(previous, frame, turnId, 'message', '/project', true), rows)
    const create = (id: string, number: string, subject: string) => [call(id, 'TaskCreate', { subject, description: subject, activeForm: `${subject}ing` }),
      answer(id, `Task #${number} created successfully: ${subject}`, { task: { id: number, subject, description: subject } })]
    const update = (id: string, taskId: string, status: string) => [call(id, 'TaskUpdate', { taskId, status }),
      answer(id, `Updated task #${taskId} status`, { success: true, taskId, updatedFields: ['status'] })]
    const plan = (rows: readonly AgentActivity[], turnId: string) => rows.find(row => row.id === `claude-plan-${turnId}`)
    /** The turn's checklist as it reads, without the task ids each step keeps for picking the plan up again. */
    const shown = (rows: readonly AgentActivity[], turnId: string) => plan(rows, turnId)?.steps?.map(step => ({ text: step.text, status: step.status, ...(step.active ? { active: step.active } : {}) }))

    it('keeps one plan row per turn as tasks are made and moved on, with no tool row for any call', () => {
      const projector = new ClaudeActivity()
      const rows = run(projector, 'one', [...create('c1', '1', 'Read'), ...create('c2', '2', 'Patch'), ...update('u1', '1', 'in_progress')])
      expect(rows.filter(row => row.kind === 'plan')).toHaveLength(1)
      expect(plan(rows, 'one')).toMatchObject({ kind: 'plan', title: 'Plan', status: 'running',
        steps: [{ text: 'Read', status: 'running', active: 'Reading', id: '1' }, { text: 'Patch', status: 'pending', id: '2' }] })
      expect(rows.some(row => row.id.startsWith('claude-tool-'))).toBe(false)
      const done = run(projector, 'one', [...update('u2', '1', 'completed'), ...update('u3', '2', 'in_progress')], rows)
      expect(shown(done, 'one')).toEqual([{ text: 'Read', status: 'completed' }, { text: 'Patch', status: 'running', active: 'Patching' }])
    })

    it('shows a later turn only its own work, not the tasks an earlier turn finished', () => {
      const projector = new ClaudeActivity()
      const first = run(projector, 'one', [...create('c1', '1', 'Read'), ...update('u1', '1', 'completed'), ...create('c2', '2', 'Patch')])
      const second = run(projector, 'two', [...update('u2', '2', 'in_progress'), ...create('c3', '3', 'Test')], first)
      expect(shown(second, 'two')).toEqual([{ text: 'Patch', status: 'running', active: 'Patching' }, { text: 'Test', status: 'pending' }])
      // The earlier turn keeps its own row as it stood.
      expect(plan(second, 'one')!.steps).toHaveLength(2)
      // A finished task opened again belongs to this turn's work.
      const third = run(projector, 'three', update('u3', '1', 'in_progress'), second)
      expect(shown(third, 'three')).toEqual([{ text: 'Read', status: 'running', active: 'Reading' }, { text: 'Patch', status: 'running', active: 'Patching' }, { text: 'Test', status: 'pending' }])
      // Finished again, it stays in this turn's checklist, ticked.
      const fourth = run(projector, 'three', update('u4', '1', 'completed'), third)
      expect(shown(fourth, 'three')![0]).toEqual({ text: 'Read', status: 'completed' })
    })

    it('drops a deleted task, ignores a failed call, and learns the list from TaskList after starting late', () => {
      const projector = new ClaudeActivity()
      const rows = run(projector, 'one', [...create('c1', '1', 'Read'), ...create('c2', '2', 'Patch'), ...update('d1', '2', 'deleted'),
        call('bad', 'TaskUpdate', { taskId: '1', status: 'completed' }), answer('bad', 'Task not found', {}, true)])
      expect(shown(rows, 'one')).toEqual([{ text: 'Read', status: 'pending' }])
      // A projector made after the tasks were (Sotto started again) has nothing to name an update by until the list is read.
      const late = new ClaudeActivity()
      expect(plan(run(late, 'two', update('u1', '4', 'in_progress')), 'two')).toBeUndefined()
      const listed = run(late, 'two', [call('l1', 'TaskList', {}), answer('l1', '#4 [in_progress] Ship', { tasks: [
        { id: '3', subject: 'Earlier', status: 'completed', blockedBy: [] }, { id: '4', subject: 'Ship', status: 'in_progress', blockedBy: [] }] })])
      // The task an earlier turn finished stays with that turn, as it does for a projector that saw it finish.
      expect(shown(listed, 'two')).toEqual([{ text: 'Ship', status: 'running' }])
    })

    it('changes nothing when the transcript read delivers a task call the stream already applied', () => {
      const projector = new ClaudeActivity()
      const rows = run(projector, 'one', [...create('c1', '1', 'Read'), ...update('u1', '1', 'in_progress')])
      expect(run(projector, 'one', create('c1', '1', 'Read'), rows)).toBe(rows)
      expect(shown(run(projector, 'one', create('c1', '1', 'Read'), rows), 'one')).toEqual([{ text: 'Read', status: 'running', active: 'Reading' }])
    })

    it('picks the plan up from its last row after Sotto starts again, by the task ids its steps keep', () => {
      const rows = run(new ClaudeActivity(), 'one', [...create('c1', '1', 'Read'), ...update('u1', '1', 'completed'), ...create('c2', '2', 'Patch')])
      const again = new ClaudeActivity()
      const next = run(again, 'two', update('u2', '2', 'in_progress'), rows)
      // The task the earlier turn finished stays with that turn; the open one moves on in this turn's checklist. A step kept
      // no words for while it runs until it ran, so those wait for Claude to send them again.
      expect(shown(next, 'two')).toEqual([{ text: 'Patch', status: 'running' }])
    })

    it('leaves a subagent’s task calls as its own tool rows', () => {
      const rows = new ClaudeActivity().apply([], { ...call('sub', 'TaskCreate', { subject: 'Look' }), parent_tool_use_id: 'agent' }, 'one', 'message', '/project')
      expect(rows).toEqual([expect.objectContaining({ id: 'claude-tool-sub', kind: 'tool', title: 'TaskCreate' })])
    })
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
