// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ClaudeActivity } from '../../../src/main/agents/claudeActivity'
import { CodexActivityProjection, codexItemSchema } from '../../../src/main/agents/codexActivity'
import { grokActivities } from '../../../src/main/agents/grokActivity'
import { devinActivities } from '../../../src/main/agents/devinActivity'
import { agentActivitySchema, mergeAgentActivities, type AgentActivity } from '../../../src/shared/agentActivity'
import { distinctModels } from '../../../src/shared/subagents'
import { subagentActivityClassification } from '../../../src/main/agents/subagentStore'

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

  it('follows Codex multi-agent v2 agents through start, messages, completion and follow-up tasks', () => {
    let now = 1_000
    const projection = new CodexActivityProjection(() => now)
    const thread = { id: 'sotto', messages: [], activities: [] as AgentActivity[] }
    const activity = (id: string, kind: string, agentPath: string, agentThreadId: string, model: string | null = null) =>
      codexItemSchema.parse({ id, type: 'subAgentActivity', kind, agentThreadId, agentPath, model, reasoningEffort: 'xhigh' })
    const agents = () => thread.activities.flatMap(record => record.agents ?? [])
    projection.item(thread, activity('call-spawn', 'started', '/root/review_tests', 'native-child', 'reported-model'), { turnId: 'turn', phase: 'completed' })
    const started = agents()[0]!
    expect(started).toMatchObject({ status: 'running', title: 'review_tests', model: 'reported-model', startedAt: new Date(now).toISOString() })
    expect(thread.activities[0]).toMatchObject({ kind: 'subagent', title: 'review_tests', status: 'running' })
    now = 2_000
    projection.item(thread, activity('call-message', 'interacted', '/root/review_tests', 'native-child'), { turnId: 'turn', phase: 'completed' })
    expect(thread.activities).toHaveLength(1)
    expect(agents()[0]).toMatchObject({ status: 'running', assignmentId: started.assignmentId, startedAt: started.startedAt })
    now = 3_000
    projection.item(thread, activity('subagent-completed-1', 'completed', '/root/review_tests', 'native-child'), { turnId: 'later-turn', phase: 'completed' })
    expect(thread.activities).toHaveLength(1)
    expect(thread.activities[0]).toMatchObject({ turnId: 'turn', status: 'completed', completedAt: new Date(now).toISOString() })
    expect(agents()[0]).toMatchObject({ status: 'completed', assignmentId: started.assignmentId, completedAt: new Date(now).toISOString() })
    now = 4_000
    projection.item(thread, activity('call-followup', 'interacted', '/root/review_tests', 'native-child'), { turnId: 'later-turn', phase: 'completed' })
    // A follow-up task starts the agent's own turn; a message alone would leave it finished.
    projection.childNotification('native-child', 'turn/started', { turn: { id: 'child-turn', status: 'inProgress' } })
    const followup = thread.activities.at(-1)!.agents![0]!
    expect(thread.activities).toHaveLength(2)
    expect(followup).toMatchObject({ id: started.id, status: 'running', model: 'reported-model', startedAt: new Date(now).toISOString() })
    expect(followup.assignmentId).not.toBe(started.assignmentId)
    expect(followup.completedAt).toBeUndefined()
    // A child's message up to the agent that started it is not work the parent gave it.
    projection.childNotification('native-child', 'item/completed', { turnId: 'child-turn', item: { id: 'call-reply', type: 'subAgentActivity', kind: 'interacted', agentThreadId: 'native-root', agentPath: '/root' } })
    expect(thread.activities).toHaveLength(2)
    projection.childNotification('native-child', 'item/completed', { turnId: 'child-turn', item: { id: 'call-nested', type: 'subAgentActivity', kind: 'started', agentThreadId: 'native-grandchild', agentPath: '/root/review_tests/fixtures' } })
    expect(thread.activities.at(-1)!.agents![0]).toMatchObject({ title: 'fixtures', parentId: started.id, status: 'running' })
    expect(JSON.stringify(thread)).not.toMatch(/native-|xhigh/u)
    thread.activities.forEach(row => agentActivitySchema.parse(row))
  })

  it('leaves a finished Codex v2 agent finished when it is only sent a message, and opens a new assignment once it works again (#1261)', () => {
    let now = 1_000
    const projection = new CodexActivityProjection(() => now)
    const thread = { id: 'sotto', messages: [], activities: [] as AgentActivity[] }
    const activity = (id: string, kind: string) => codexItemSchema.parse({ id, type: 'subAgentActivity', kind, agentThreadId: 'native-child', agentPath: '/root/spec_review' })
    const statuses = () => thread.activities.filter(record => record.kind === 'subagent').map(record => record.agents![0]!.status)
    // As codex-cli 0.163 reported it: a message while the agent works, a follow-up task, its completion, then a message.
    projection.item(thread, activity('call-spawn', 'started'), { turnId: 'turn', phase: 'completed' })
    projection.childNotification('native-child', 'turn/started', { turn: { id: 'child-turn-1', status: 'inProgress' } })
    projection.item(thread, activity('call-message', 'interacted'), { turnId: 'turn', phase: 'completed' })
    projection.childNotification('native-child', 'turn/completed', { turn: { id: 'child-turn-1', status: 'completed' } })
    expect(statuses()).toEqual(['completed'])
    now = 2_000
    projection.item(thread, activity('call-followup', 'interacted'), { turnId: 'turn', phase: 'completed' })
    // A follow-up task starts the agent's own turn at once; that is what shows it is working again.
    projection.childNotification('native-child', 'turn/started', { turn: { id: 'child-turn-2', status: 'inProgress' } })
    expect(statuses()).toEqual(['completed', 'running'])
    expect(thread.activities[1]!.agents![0]!.startedAt).toBe(new Date(2_000).toISOString())
    now = 3_000
    projection.item(thread, activity('subagent-completed-child-turn-2', 'completed'), { turnId: 'turn', phase: 'completed' })
    projection.childNotification('native-child', 'thread/status/changed', { status: { type: 'idle' } })
    projection.childNotification('native-child', 'turn/completed', { turn: { id: 'child-turn-2', status: 'completed' } })
    now = 4_000
    // send_message to a finished agent leaves it in the agent's mail and starts no turn.
    projection.item(thread, activity('call-thanks', 'interacted'), { turnId: 'turn', phase: 'completed' })
    projection.turn(thread, { id: 'turn', status: 'completed' }, true)
    expect(statuses()).toEqual(['completed', 'completed'])
    // Read again from history, with no notifications, it reads the same.
    for (const [id, kind] of [['call-spawn', 'started'], ['call-message', 'interacted'], ['call-followup', 'interacted'], ['subagent-completed-child-turn-2', 'completed'], ['call-thanks', 'interacted']] as const) {
      projection.item(thread, activity(id, kind), { turnId: 'turn', phase: 'history' })
    }
    expect(statuses()).toEqual(['completed', 'completed'])
  })

  it('opens a Codex v2 follow-up a later completion shows ran, when no turn of the agent\'s own was seen', () => {
    const projection = new CodexActivityProjection(() => 1_000)
    const history = { id: 'sotto', messages: [], activities: [] as AgentActivity[] }
    const activity = (id: string, kind: string) => codexItemSchema.parse({ id, type: 'subAgentActivity', kind, agentThreadId: 'native-child', agentPath: '/root/spec_review' })
    for (const [id, kind] of [['call-spawn', 'started'], ['subagent-completed-1', 'completed'], ['call-followup', 'interacted'], ['subagent-completed-2', 'completed']] as const) {
      projection.item(history, activity(id, kind), { turnId: 'turn', phase: 'history' })
    }
    expect(history.activities.map(record => record.agents![0]!.status)).toEqual(['completed', 'completed'])
    expect(new Set(history.activities.map(record => record.agents![0]!.assignmentId)).size).toBe(2)
  })

  it('starts a new Codex v2 assignment after a late repeat of the item that started a finished one', () => {
    const projection = new CodexActivityProjection(() => 1_000)
    const thread = { id: 'sotto', messages: [], activities: [] as AgentActivity[] }
    const activity = (id: string, kind: string) => codexItemSchema.parse({ id, type: 'subAgentActivity', kind, agentThreadId: 'native-child', agentPath: '/root/review_tests' })
    projection.item(thread, activity('call-spawn', 'started'), { turnId: 'turn', phase: 'started' })
    projection.item(thread, activity('subagent-completed-1', 'completed'), { turnId: 'turn', phase: 'completed' })
    projection.item(thread, activity('call-spawn', 'started'), { turnId: 'turn', phase: 'completed' })
    projection.item(thread, activity('call-followup', 'interacted'), { turnId: 'turn', phase: 'completed' })
    projection.childNotification('native-child', 'turn/started', { turn: { id: 'child-turn', status: 'inProgress' } })
    expect(thread.activities.map(record => record.agents![0]!.status)).toEqual(['completed', 'running'])
  })

  it('keeps each Codex v2 assignment\'s observed times when history is read again', () => {
    let now = 1_000
    const projection = new CodexActivityProjection(() => now)
    const thread = { id: 'sotto', messages: [], activities: [] as AgentActivity[] }
    const items = [['call-spawn', 'started'], ['subagent-completed-1', 'completed'], ['call-followup', 'interacted'], ['subagent-completed-2', 'completed']] as const
    const activity = ([id, kind]: readonly [string, string]) => codexItemSchema.parse({ id, type: 'subAgentActivity', kind, agentThreadId: 'native-child', agentPath: '/root/review_tests' })
    for (const item of items) { projection.item(thread, activity(item), { turnId: 'turn', phase: 'completed' }); now += 2_000 }
    const times = () => thread.activities.map(record => [record.agents![0]!.startedAt, record.agents![0]!.completedAt])
    const observed = times()
    expect(observed).toEqual([[new Date(1_000).toISOString(), new Date(3_000).toISOString()], [new Date(5_000).toISOString(), new Date(7_000).toISOString()]])
    for (const item of items) projection.item(thread, activity(item), { turnId: 'turn', phase: 'history' })
    expect(times()).toEqual(observed)
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

  describe('a Claude workflow\'s agents', () => {
    const launch = { type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id: 'flow', name: 'Workflow', input: { script: 'run()' } }] } }
    const started = { type: 'system', subtype: 'task_started', task_id: 'wtask', tool_use_id: 'flow', task_type: 'local_workflow', workflow_name: 'phase-1-perf', description: 'Implement the phase 1 perf issues', timestamp }
    const launched = { type: 'user', timestamp, tool_use_result: { status: 'async_launched', taskId: 'wtask', taskType: 'local_workflow', runId: 'wf_81b798e8-536' }, message: { content: [{ type: 'tool_result', tool_use_id: 'flow', content: 'Launched' }] } }
    const t0 = Date.parse(timestamp)
    const agent = (index: number, state: string, extra: Record<string, unknown> = {}) => ({ type: 'workflow_agent', index, label: `#31${index} 31${index}-lane`, phaseTitle: 'Implement', state, queuedAt: t0, promptPreview: `Implement #31${index}.`, ...extra })
    // Claude Code describes a workflow's progress by whichever agent reported last.
    const progress = (description: string, entries?: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'system', subtype: 'task_progress', task_id: 'wtask', tool_use_id: 'flow', description, last_tool_name: description, ...(entries ? { workflow_progress: entries } : {}), timestamp, ...extra })
    const three = [
      agent(1, 'progress', { agentId: 'a1', model: 'claude-opus-5-5[1m]', startedAt: t0 }),
      agent(2, 'done', { agentId: 'a2', model: 'claude-sonnet-5', startedAt: t0, durationMs: 90_000, resultPreview: 'Opened #350.' }),
      agent(3, 'start', { model: 'opus' }),
    ]
    const run = (projection: ClaudeActivity, frames: Record<string, unknown>[], start: AgentActivity[] = []) => frames.reduce((rows, frame) => projection.apply(rows, frame, 'turn', 'message', '/p'), start)
    const task = (rows: AgentActivity[]) => rows.find(row => row.id === 'claude-task-wtask')!
    const frames = [launch, started, launched, progress('Implement: #311 311-lane', three), progress('Implement: #313 313-lane', [three[0], three[1], agent(3, 'progress', { agentId: 'a3', model: 'claude-opus-5-5[1m]', startedAt: t0 + 4_000 })])]

    it('gives the workflow one row named for the workflow, and each agent its own row under it', () => {
      // An agent still waiting for a place to start is counted, not shown, until it starts.
      const early = run(new ClaudeActivity(), frames.slice(0, 4))
      expect(task(early).agents!.map(agent => agent.title)).toEqual(['Implement the phase 1 perf issues', '#311 311-lane', '#312 312-lane'])
      expect(task(early).agents![0]!.progress).toEqual({ total: 3, working: 1, completed: 1, failed: 0, interrupted: 0, queued: 1 })
      const rows = run(new ClaudeActivity(), frames)
      const [workflow, ...agents] = task(rows).agents!
      expect(workflow).toMatchObject({ kind: 'workflow', title: 'Implement the phase 1 perf issues', description: 'phase-1-perf', prompt: 'Implement the phase 1 perf issues', status: 'running',
        progress: { total: 3, working: 2, completed: 1, failed: 0, interrupted: 0 } })
      expect(workflow!.model).toBeUndefined()
      expect(task(rows).title).toBe('Implement the phase 1 perf issues')
      expect(agents.map(child => [child.title, child.status, child.model, child.parentId])).toEqual([
        ['#311 311-lane', 'running', 'claude-opus-5-5[1m]', workflow!.id],
        ['#312 312-lane', 'completed', 'claude-sonnet-5', workflow!.id],
        ['#313 313-lane', 'running', 'claude-opus-5-5[1m]', workflow!.id],
      ])
      expect(agents[1]).toMatchObject({ prompt: 'Implement #312.', message: 'Opened #350.', startedAt: timestamp, durationMs: 90_000, completedAt: new Date(t0 + 90_000).toISOString() })
      // The launch alias is gone once the resolved name arrives: one model, named once.
      expect(agents[2]!.model).toBe('claude-opus-5-5[1m]')
      expect(distinctModels(agents.map(child => child.model))).toEqual(['claude-opus-5-5[1m]', 'claude-sonnet-5'])
      expect(distinctModels(['opus', 'claude-opus-5-5[1m]', 'haiku'])).toEqual(['claude-opus-5-5[1m]', 'haiku'])
      rows.forEach(row => agentActivitySchema.parse(row))
    })

    // Claude Code writes no task frames to a session transcript, so a workflow's agents come back after a restart from
    // the saved roster and the text-free classification, never from replaying the transcript.
    it('gives the same rows when the same frames are projected again, and keeps them across a cursor resume', () => {
      const live = run(new ClaudeActivity(), frames)
      expect(task(run(new ClaudeActivity(), frames)).agents).toEqual(task(live).agents)
      // A frame without the list, as Claude Code throttles them, keeps every agent already known.
      const quiet = run(new ClaudeActivity(), [progress('Implement: #312 312-lane')], live)
      expect(task(quiet).agents!.map(child => child.id)).toEqual(task(live).agents!.map(child => child.id))
      // A projector resumed from the saved classification alone keeps the children and their identities.
      const saved = new Map(live.map(row => [row.id, subagentActivityClassification(row)]))
      const resumed = new ClaudeActivity(id => saved.get(id))
      const next = run(resumed, [progress('Implement: #313 313-lane', [agent(1, 'done', { agentId: 'a1', model: 'claude-opus-5-5[1m]', startedAt: t0, durationMs: 60_000 })])])
      const [workflow, ...agents] = task(next).agents!
      expect(workflow).toMatchObject({ id: task(live).agents![0]!.id, kind: 'workflow', progress: { total: 3, completed: 2, working: 1 } })
      expect(agents.map(child => [child.id, child.status])).toEqual(task(live).agents!.slice(1).map((child, index) => [child.id, ['completed', 'completed', 'running'][index]!]))
    })

    it('stays working while one agent finishes, and its notification settles it and any agent still working', () => {
      const projection = new ClaudeActivity()
      let rows = run(projection, frames)
      rows = run(projection, [progress('Implement: #311 311-lane', [agent(1, 'error', { agentId: 'a1', startedAt: t0, durationMs: 30_000, error: 'Tests failed twice.' }), three[1], agent(3, 'progress', { agentId: 'a3', startedAt: t0 })])], rows)
      expect(task(rows).agents![0]).toMatchObject({ status: 'running', progress: { total: 3, working: 1, completed: 1, failed: 1 } })
      expect(task(rows).agents![1]).toMatchObject({ status: 'failed', message: 'Tests failed twice.' })
      rows = run(projection, [{ type: 'system', subtype: 'task_notification', task_id: 'wtask', tool_use_id: 'flow', status: 'completed', summary: 'Two of three opened.', timestamp }], rows)
      const [workflow, ...agents] = task(rows).agents!
      expect(workflow).toMatchObject({ status: 'completed', message: 'Two of three opened.', progress: { total: 3, working: 0, completed: 2, failed: 1 } })
      expect(agents.map(child => child.status)).toEqual(['failed', 'completed', 'completed'])
      expect(agents[2]!.completedAt).toBe(timestamp)
      // A run that fails does not count agents it never heard from as failed: they read as interrupted.
      const failing = new ClaudeActivity()
      const stopped = run(failing, [...frames, { type: 'system', subtype: 'task_notification', task_id: 'wtask', tool_use_id: 'flow', status: 'failed', timestamp }])
      expect(task(stopped).agents!.map(child => child.status)).toEqual(['failed', 'interrupted', 'completed', 'interrupted'])
      // A later progress frame cannot reopen the settled run.
      const after = run(projection, [progress('Implement: #313 313-lane', [agent(3, 'progress', { agentId: 'a3' })])], rows)
      expect(task(after).agents!.map(child => child.status)).toEqual(['completed', 'failed', 'completed', 'completed'])
    })

    it('shows a retried agent working again as a new assignment, without the failed attempt\'s result', () => {
      const projection = new ClaudeActivity()
      let rows = run(projection, [launch, started, launched, progress('Implement: #311 311-lane', [agent(1, 'error', { agentId: 'a1', startedAt: t0, durationMs: 30_000, error: { message: 'Stalled.' } })])])
      const failed = task(rows).agents![1]!
      expect(failed).toMatchObject({ status: 'failed', message: 'Stalled.', durationMs: 30_000 })
      rows = run(projection, [progress('Implement: #311 311-lane', [agent(1, 'start', { agentId: 'a1b', attempt: 2, startedAt: t0 + 60_000 })])], rows)
      const retried = task(rows).agents![1]!
      expect(retried).toMatchObject({ id: failed.id, status: 'running', title: '#311 311-lane', startedAt: new Date(t0 + 60_000).toISOString() })
      expect(retried.assignmentId).not.toBe(failed.assignmentId)
      expect(retried.message).toBeUndefined()
      expect(retried.completedAt).toBeUndefined()
      expect(retried.durationMs).toBeUndefined()
      expect(task(rows).agents![0]!.progress).toMatchObject({ working: 1, failed: 0 })
    })

    it('watches an agent\'s own transcript when progress names no model, and patches only that agent', () => {
      const projection = new ClaudeActivity()
      let rows = run(projection, [launch, started, launched, progress('Implement: #311 311-lane', [agent(1, 'progress', { agentId: 'a1f2', startedAt: t0 })])])
      const child = task(rows).agents![1]!
      expect(child.model).toBeUndefined()
      expect(projection.modelTargets()).toEqual([{ id: child.id, transcript: { runId: 'wf_81b798e8-536', agentId: 'a1f2' }, settled: false }])
      rows = projection.applyModel(rows, child.id, 'claude-opus-5-5')
      expect(task(rows).agents!.map(agent => agent.model)).toEqual([undefined, 'claude-opus-5-5'])
      expect(projection.modelTargets()).toEqual([])
      rows.forEach(row => agentActivitySchema.parse(row))
    })
  })

  it('names a background agent\'s model from its launch result or its own transcript, whichever comes first', () => {
    const background = new ClaudeActivity()
    let rows = background.apply([], claudeTool('launch', { description: 'Review tests', prompt: 'Check assertions', run_in_background: true }), 'turn', 'message', '/p')
    rows = background.apply(rows, { type: 'system', subtype: 'task_started', task_id: 'a3a0e66ba6fe555ae', tool_use_id: 'launch', task_type: 'local_agent', timestamp }, 'turn', 'message', '/p')
    const agent = rows[0]!.agents![0]!
    expect(background.modelTargets()).toEqual([{ id: agent.id, transcript: { agentId: 'a3a0e66ba6fe555ae' }, settled: false }])
    const launched = background.apply(rows, { type: 'user', timestamp, tool_use_result: { status: 'async_launched', isAsync: true, agentId: 'a3a0e66ba6fe555ae', resolvedModel: 'claude-opus-5-5' }, message: { content: [{ type: 'tool_result', tool_use_id: 'launch', content: 'Launched' }] } }, 'turn', 'message', '/p')
    expect(launched.filter(row => row.agents?.length).map(row => row.agents![0]!.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
    expect(background.modelTargets()).toEqual([])
    // A future CLI that names the model on the task start is taken as it comes.
    const started = new ClaudeActivity().apply([], { type: 'system', subtype: 'task_started', task_id: 'task', task_type: 'local_agent', model: 'claude-future', timestamp }, 'turn', 'message', '/p')
    expect(started[0]!.agents![0]!.model).toBe('claude-future')
    // Replayed history files the launch result as `toolUseResult`; its model is read from there too.
    const replay = new ClaudeActivity()
    let replayed = replay.apply([], claudeTool('launch', { prompt: 'Check assertions', run_in_background: true }), 'turn', 'message', '/p')
    replayed = replay.apply(replayed, { type: 'user', timestamp, toolUseResult: { status: 'async_launched', isAsync: true, agentId: 'a3a0e66ba6fe555ae', resolvedModel: 'claude-opus-5-5' }, message: { content: [{ type: 'tool_result', tool_use_id: 'launch', content: 'Launched' }] } }, 'turn', 'message', '/p')
    expect(replayed[0]!.agents![0]!.model).toBe('claude-opus-5-5')
    // Without one, the agent's own transcript is watched while the agent runs.
    const quiet = new ClaudeActivity()
    let silent = quiet.apply([], claudeTool('launch', { prompt: 'Check assertions', run_in_background: true }), 'turn', 'message', '/p')
    silent = quiet.apply(silent, { type: 'user', timestamp, toolUseResult: { status: 'async_launched', isAsync: true, agentId: 'a3a0e66ba6fe555ae' }, message: { content: [{ type: 'tool_result', tool_use_id: 'launch', content: 'Launched' }] } }, 'turn', 'message', '/p')
    expect(quiet.modelTargets()).toEqual([{ id: silent[0]!.agents![0]!.id, transcript: { agentId: 'a3a0e66ba6fe555ae' }, settled: false }])
    silent = quiet.applyModel(silent, silent[0]!.agents![0]!.id, 'claude-opus-5-5')
    expect(silent).toHaveLength(1)
    expect(silent[0]!.agents![0]).toMatchObject({ status: 'running', model: 'claude-opus-5-5' })
  })

  it('ignores a <synthetic> sidechain notice and settles a stopped agent that has no model', () => {
    const projection = new ClaudeActivity()
    let rows = projection.apply([], claudeTool('launch', { prompt: 'Check assertions', run_in_background: true }), 'turn', 'message', '/p')
    rows = projection.apply(rows, { type: 'system', subtype: 'task_started', task_id: 'a3a0e66ba6fe555ae', tool_use_id: 'launch', task_type: 'local_agent', timestamp }, 'turn', 'message', '/p')
    // Claude Code's own error notice is not the model the agent ran on, so it neither names the row
    // nor outranks the launch's resolved model, and the transcript stays watched until that arrives.
    rows = projection.apply(rows, { type: 'assistant', timestamp, parent_tool_use_id: 'launch', message: { model: '<synthetic>', content: [] } }, 'turn', 'message', '/p')
    expect(rows.flatMap(row => row.agents ?? []).map(agent => agent.model)).not.toContain('<synthetic>')
    const id = rows[0]!.agents![0]!.id
    expect(projection.modelTargets()).toEqual([{ id, transcript: { agentId: 'a3a0e66ba6fe555ae' }, settled: false }])
    // A stopped agent that never named a model is still read, but marked settled so the reader gives up.
    rows = projection.apply(rows, { type: 'system', subtype: 'task_notification', task_id: 'a3a0e66ba6fe555ae', tool_use_id: 'launch', status: 'completed', timestamp }, 'turn', 'message', '/p')
    expect(projection.modelTargets()).toEqual([{ id, transcript: { agentId: 'a3a0e66ba6fe555ae' }, settled: true }])
    rows = projection.apply(rows, { type: 'user', timestamp, tool_use_result: { status: 'async_launched', isAsync: true, agentId: 'a3a0e66ba6fe555ae', resolvedModel: 'claude-opus-5-5' }, message: { content: [{ type: 'tool_result', tool_use_id: 'launch', content: 'Launched' }] } }, 'turn', 'message', '/p')
    expect(rows.filter(row => row.agents?.length).map(row => row.agents![0]!.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
    expect(projection.modelTargets()).toEqual([])
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
