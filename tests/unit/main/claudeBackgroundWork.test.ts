// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ClaudeMonitoring } from '../../../src/main/agents/claudeMonitoring'
import { agentBackgroundWorkSchema, MAX_AGENT_MONITORS, MAX_BACKGROUND_WORK } from '../../../src/shared/agentMonitoring'
import type { ClaudeFrame } from '../../../src/main/agents/claudeProtocol'

/** Shaped like the CLI's own `task_started` emitter; the description is the only text it carries here. */
const start = (patch: ClaudeFrame = {}): ClaudeFrame => ({ type: 'system', subtype: 'task_started', task_id: 'native-agent-id', task_type: 'local_agent',
  description: 'Review the diff', is_backgrounded: true, spawn_depth: 1, ...patch })
const update = (patch: ClaudeFrame, task_id = 'native-agent-id'): ClaudeFrame => ({ type: 'system', subtype: 'task_updated', task_id, patch })
const notification = (task_id = 'native-agent-id', status = 'completed'): ClaudeFrame => ({ type: 'system', subtype: 'task_notification', task_id, status })

describe('Claude background work', () => {
  it.each([
    ['local_workflow', 'workflow'], ['workflow', 'workflow'], ['local_agent', 'subagent'],
    ['in_process_teammate', 'teammate'], ['remote_agent', 'remote-agent'],
  ])('counts a root %s task as %s work, not as a watch', (task_type, type) => {
    const work = new ClaudeMonitoring()
    work.apply(start({ task_type, is_backgrounded: undefined, spawn_depth: undefined }))
    expect(work.working).toEqual([{ id: expect.any(String), label: 'Review the diff', type }])
    expect(work.current).toEqual([])
    expect(agentBackgroundWorkSchema.safeParse(work.working).success).toBe(true)
  })

  it.each(['plan', 'dream', 'scheduled', 'shell', 'local_bash', 'mcp_task', 'unknown', undefined])('leaves %s inert', task_type => {
    const work = new ClaudeMonitoring()
    work.apply(start({ task_type }))
    work.apply({ type: 'system', subtype: 'task_progress', task_id: 'native-agent-id', description: 'Still going' })
    expect(work.working).toEqual([])
    expect(work.current).toEqual([])
  })

  it('keeps an opaque identity, sanitizes the label and names an unlabelled task by its kind', () => {
    const work = new ClaudeMonitoring()
    work.apply(start({ description: 'Review\u0000 the‮ diff\n' + 'x'.repeat(300) }))
    const [first] = work.working
    expect(first?.id).not.toContain('native-agent-id')
    expect(agentBackgroundWorkSchema.safeParse(work.working).success).toBe(true)
    work.apply(update({ description: 'Review the tests' }))
    expect(work.working).toEqual([{ id: first!.id, label: 'Review the tests', type: 'subagent' }])
    work.working[0]!.label = 'Mutated outside'
    expect(work.working[0]!.label).toBe('Review the tests')
    work.apply(start({ task_id: 'unnamed', task_type: 'local_workflow', description: '' }))
    expect(work.working[1]).toMatchObject({ label: 'Workflow', type: 'workflow' })
  })

  it.each([{ ambient: true }, { skip_transcript: true }, { parent_tool_use_id: 'child' }, { isSidechain: true },
    { owned_by_subagent: true }, { spawn_depth: 2 }, { tool_use_id: 'unseen' }])('excludes work this thread did not start itself %j', patch => {
    const work = new ClaudeMonitoring()
    work.apply(start(patch))
    expect(work.working).toEqual([])
  })

  it('takes ownership from the launching tool the way a watch does', () => {
    const work = new ClaudeMonitoring()
    work.apply({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'root-launch' } } })
    work.apply({ type: 'assistant', parent_tool_use_id: 'child', message: { content: [{ type: 'tool_use', id: 'nested-launch' }] } })
    work.apply(start({ task_id: 'root', tool_use_id: 'root-launch', description: 'Root agent' }))
    work.apply(start({ task_id: 'nested', tool_use_id: 'nested-launch', description: 'Nested agent' }))
    expect(work.working.map(task => task.label)).toEqual(['Root agent'])
  })

  it('leaves a subagent the turn is blocking on to the held action until it is moved to the background', () => {
    const work = new ClaudeMonitoring()
    work.apply(start({ is_backgrounded: false }))
    expect(work.working).toEqual([])
    work.apply(update({ description: 'Still in the foreground' }))
    expect(work.working).toEqual([])
    work.apply(update({ is_backgrounded: true }))
    expect(work.working).toEqual([{ id: expect.any(String), label: 'Still in the foreground', type: 'subagent' }])
  })

  it('survives the turn ending and unrelated foreground frames', () => {
    const work = new ClaudeMonitoring()
    work.apply(start())
    work.apply({ type: 'assistant', message: { content: 'All the agents have finished.' } })
    work.apply({ type: 'result', is_error: false, result: 'ok' })
    work.apply(start({ task_id: 'command', task_type: 'local_bash' }))
    expect(work.working).toHaveLength(1)
  })

  it.each([
    ['a notification', notification()], ['a notification with no status', { type: 'system', subtype: 'task_notification', task_id: 'native-agent-id' }],
    ['a failed notification', notification('native-agent-id', 'failed')], ['a stopped notification', notification('native-agent-id', 'stopped')],
    ['a terminal update', update({ status: 'completed' })], ['a killed update', update({ status: 'killed' })], ['an end time', update({ end_time: 123 })],
  ])('ends on %s and cannot be revived by a late update', (_, frame) => {
    const work = new ClaudeMonitoring()
    work.apply(start())
    work.apply(frame)
    expect(work.working).toEqual([])
    work.apply({ type: 'system', subtype: 'task_progress', task_id: 'native-agent-id', description: 'Late progress' })
    work.apply(update({ status: 'running' }))
    expect(work.working).toEqual([])
  })

  it('pauses on a paused status and resumes only on an explicit running update', () => {
    const work = new ClaudeMonitoring()
    work.apply(start())
    work.apply(update({ status: 'paused' }))
    work.apply({ type: 'system', subtype: 'task_progress', task_id: 'native-agent-id' })
    expect(work.working).toEqual([])
    work.apply(update({ status: 'running' }))
    expect(work.working).toHaveLength(1)
  })

  it('ends only the task its bookend names', () => {
    const work = new ClaudeMonitoring()
    work.apply(start({ task_id: 'first', description: 'First agent' }))
    work.apply(start({ task_id: 'second', task_type: 'local_workflow', description: 'Second agent' }))
    work.apply(start({ task_id: 'watch', task_type: 'monitor', description: 'Watch the build' }))
    work.apply(notification('first'))
    expect(work.working.map(task => task.label)).toEqual(['Second agent'])
    expect(work.current.map(task => task.label)).toEqual(['Watch the build'])
  })

  it('bounds background work and watches separately, so a wide workflow never crowds out a watch', () => {
    const work = new ClaudeMonitoring()
    for (let n = 0; n < 100; n++) work.apply(start({ task_id: `agent-${n}` }))
    expect(work.working).toHaveLength(MAX_BACKGROUND_WORK)
    for (let n = 0; n < 100; n++) work.apply(start({ task_id: `watch-${n}`, task_type: 'monitor' }))
    expect(work.current).toHaveLength(MAX_AGENT_MONITORS)
    expect(agentBackgroundWorkSchema.safeParse(work.working).success).toBe(true)
    work.apply(notification('agent-0'))
    work.apply(start({ task_id: 'late', description: 'Late agent' }))
    expect(work.working.at(-1)?.label).toBe('Late agent')
  })
})
