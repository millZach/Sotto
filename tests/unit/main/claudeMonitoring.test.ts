// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ClaudeActivity } from '../../../src/main/agents/claudeActivity'
import { ClaudeMonitoring } from '../../../src/main/agents/claudeMonitoring'
import { agentMonitoringSchema, MAX_AGENT_MONITORS } from '../../../src/shared/agentMonitoring'
import type { ClaudeFrame } from '../../../src/main/agents/claudeProtocol'

const start = (patch: ClaudeFrame = {}): ClaudeFrame => ({ type: 'system', subtype: 'task_started', task_id: 'native-private-id', task_type: 'monitor', description: 'Watch the build', ...patch })
const update = (patch: ClaudeFrame): ClaudeFrame => ({ type: 'system', subtype: 'task_updated', task_id: 'native-private-id', patch })

describe('Claude confirmed monitoring', () => {
  it('never turns an ended monitor into a subagent on a delayed progress update', () => {
    const activity = new ClaudeActivity()
    let rows = activity.apply([], start(), 'turn', undefined, '/project')
    rows = activity.apply(rows, { type: 'system', subtype: 'task_notification', task_id: 'native-private-id', status: 'completed' }, 'turn', undefined, '/project')
    rows = activity.apply(rows, { type: 'system', subtype: 'task_progress', task_id: 'native-private-id' }, 'turn', undefined, '/project')
    expect(rows).toEqual([])
  })

  it('starts immediately, keeps an opaque identity and sanitizes the label', () => {
    const watch = new ClaudeMonitoring()
    watch.apply(start({ description: 'Watch\u0000 the\u202e build\n' + 'x'.repeat(300) }))
    expect(watch.current).toHaveLength(1)
    expect(agentMonitoringSchema.safeParse(watch.current).success).toBe(true)
    expect(watch.current[0]?.id).not.toContain('native-private-id')
    const original = watch.current[0]!.id
    watch.apply({ type: 'system', subtype: 'task_progress', task_id: 'native-private-id', description: 'Watch deployment' })
    expect(watch.current).toEqual([{ id: original, label: 'Watch deployment' }])
    watch.current[0]!.label = 'Mutated outside'
    expect(watch.current[0]!.label).toBe('Watch deployment')
  })

  it.each(['local_bash', 'shell', 'local_agent', 'unknown', undefined])('does not treat %s as a watch', task_type => {
    const watch = new ClaudeMonitoring()
    watch.apply(start({ task_type }))
    watch.apply({ type: 'assistant', message: { content: 'I am monitoring the process.' } })
    watch.apply({ type: 'system', subtype: 'task_progress', task_id: 'native-private-id' })
    expect(watch.current).toEqual([])
  })

  it.each([{ ambient: true }, { skip_transcript: true }, { parent_tool_use_id: 'child' }, { isSidechain: true }])('excludes internal tasks %j', patch => {
    const watch = new ClaudeMonitoring()
    watch.apply(start(patch))
    expect(watch.current).toEqual([])
  })

  it('recognizes nested ownership from streaming and complete launching tools', () => {
    const watch = new ClaudeMonitoring()
    watch.apply({ type: 'stream_event', parent_tool_use_id: 'child', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'nested-1' } } })
    watch.apply({ type: 'assistant', parent_tool_use_id: 'child', message: { content: [{ type: 'tool_use', id: 'nested-2' }] } })
    watch.apply(start({ tool_use_id: 'nested-1' }))
    watch.apply(start({ task_id: 'other', task_type: 'monitor_mcp', tool_use_id: 'nested-2' }))
    expect(watch.current).toEqual([])
  })

  it('pauses on idle evidence and resumes only on an explicit running update', () => {
    const watch = new ClaudeMonitoring()
    watch.apply(start())
    const original = watch.current[0]!.id
    watch.apply(update({ status: 'paused' }))
    watch.apply({ type: 'system', subtype: 'task_progress', task_id: 'native-private-id' })
    watch.apply(update({ description: 'Still paused' }))
    expect(watch.current).toEqual([])
    watch.apply(update({ status: 'running' }))
    expect(watch.current).toEqual([{ id: original, label: 'Still paused' }])
    watch.apply(update({ status: 'pending' }))
    expect(watch.current).toEqual([])
  })

  it.each(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'interrupted'])('clears %s without an original type and cannot revive it from a late update', status => {
    const watch = new ClaudeMonitoring()
    watch.apply(start())
    watch.apply(update({ status }))
    watch.apply({ type: 'system', subtype: 'task_progress', task_id: 'native-private-id' })
    watch.apply(update({ status: 'running' }))
    expect(watch.current).toEqual([])
  })

  it('clears a terminal notification and end time without guessing their status', () => {
    const watch = new ClaudeMonitoring()
    watch.apply(start())
    watch.apply({ type: 'system', subtype: 'task_notification', task_id: 'native-private-id' })
    expect(watch.current).toEqual([])
    watch.apply(start({ task_type: 'monitor_mcp' }))
    watch.apply(update({ end_time: 123 }))
    expect(watch.current).toEqual([])
  })

  it('preserves a live watch across unrelated foreground events and caps retained watches', () => {
    const watch = new ClaudeMonitoring()
    watch.apply(start())
    watch.apply({ type: 'result', is_error: false })
    watch.apply(start({ task_id: 'command', task_type: 'local_bash' }))
    expect(watch.current).toHaveLength(1)
    for (let n = 0; n < 100; n++) watch.apply(start({ task_id: String(n) }))
    expect(watch.current).toHaveLength(MAX_AGENT_MONITORS)
  })
})
