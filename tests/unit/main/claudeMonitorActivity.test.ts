// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ClaudeActivity } from '../../../src/main/agents/claudeActivity'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { ClaudeFrame } from '../../../src/main/agents/claudeProtocol'

const started = (id: string, type = 'local_agent'): ClaudeFrame => ({ type: 'system', subtype: 'task_started', task_id: id, task_type: type, description: type })
const progress = (id: string): ClaudeFrame => ({ type: 'system', subtype: 'task_progress', task_id: id, description: 'Updated' })
const ended = (id: string): ClaudeFrame => ({ type: 'system', subtype: 'task_notification', task_id: id, status: 'completed' })
const apply = (projector: ClaudeActivity, frame: ClaudeFrame, rows: AgentActivity[] = []): AgentActivity[] => projector.apply(rows, frame, 'turn', undefined, '/project')

describe('Claude monitor activity classification', () => {
  it('does not retain completed monitor identities or admit their delayed progress', () => {
    const projector = new ClaudeActivity()
    for (let index = 0; index < 4_100; index++) {
      expect(apply(projector, started(`monitor-${index}`, 'monitor'))).toEqual([])
      expect(apply(projector, ended(`monitor-${index}`))).toEqual([])
    }
    expect(projector['nonSubagentTasks'].size).toBe(0)
    expect(apply(projector, progress('monitor-0'))).toEqual([])
    expect(apply(projector, progress('monitor-4099'))).toEqual([])
  })

  it('updates a restored subagent after resuming beyond its start', () => {
    const original = new ClaudeActivity()
    let rows = apply(original, started('resumed'))
    const resumed = new ClaudeActivity()
    rows = apply(resumed, progress('resumed'), rows)
    expect(rows[0]).toMatchObject({ kind: 'subagent', status: 'running', title: 'Updated' })
    expect(apply(new ClaudeActivity(), ended('resumed'), rows)[0]?.status).toBe('completed')
  })

  it('retains a reused-ID exclusion only while its original row remains in the activity window', () => {
    const projector = new ClaudeActivity()
    let rows = apply(projector, started('reused'))
    rows = apply(projector, started('reused', 'monitor'), rows)
    for (let index = 0; index < 4_100; index++) rows = apply(projector, started(`monitor-${index}`, 'monitor'), rows)
    expect(projector['nonSubagentTasks'].size).toBe(1)
    expect(apply(projector, progress('reused'), rows)).toEqual(rows)
    expect(apply(projector, ended('reused'), rows)).toEqual(rows)
    expect(rows[0]?.status).toBe('running')
    expect(apply(projector, progress('reused'))).toEqual([])
    expect(projector['nonSubagentTasks'].size).toBe(0)
    rows = apply(projector, started('reused'), rows)
    expect(apply(projector, ended('reused'), rows)[0]?.status).toBe('completed')
  })

  it('reclassifies reused IDs in both directions without reviving an old agent row', () => {
    const projector = new ClaudeActivity()
    apply(projector, started('reused', 'monitor'))
    let rows = apply(projector, started('reused'))
    expect(rows[0]).toMatchObject({ kind: 'subagent', status: 'running' })
    rows = apply(projector, ended('reused'), rows)
    rows = apply(projector, started('reused', 'monitor'), rows)
    expect(apply(projector, progress('reused'), rows)).toEqual(rows)
    expect(rows[0]?.status).toBe('completed')
  })

  it('finishes a known shell command even without a task start', () => {
    const projector = new ClaudeActivity()
    const rows = apply(projector, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'shell', name: 'Bash', input: { command: 'build' } }] } })
    expect(apply(projector, { ...ended('background'), tool_use_id: 'shell' }, rows)).toMatchObject([{ kind: 'command', status: 'completed' }])
  })
})
