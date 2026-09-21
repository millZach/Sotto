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
    expect(projector['subagentTasks'].size).toBe(0)
    expect(apply(projector, progress('monitor-0'))).toEqual([])
    expect(apply(projector, progress('monitor-4099'))).toEqual([])
  })

  it('bounds positive classification while allowing fresh subagents', () => {
    const projector = new ClaudeActivity()
    for (let index = 0; index < 4_100; index++) apply(projector, started(`agent-${index}`))
    expect(projector['subagentTasks'].size).toBe(4_096)
    expect(apply(projector, progress('agent-0'))).toEqual([])
    const rows = apply(projector, progress('agent-4099'))
    expect(rows[0]).toMatchObject({ kind: 'subagent', status: 'running', title: 'Updated' })
    expect(apply(projector, ended('agent-4099'), rows)[0]?.status).toBe('completed')
    expect(projector['subagentTasks'].size).toBe(4_095)
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
