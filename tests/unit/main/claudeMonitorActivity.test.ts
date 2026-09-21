// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ClaudeActivity } from '../../../src/main/agents/claudeActivity'
import { agentActivitySchema, type AgentActivity } from '../../../src/shared/agentActivity'
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

  it('persists a reused-ID exclusion on its history row across cursor resume', () => {
    const projector = new ClaudeActivity()
    let rows = apply(projector, started('reused'))
    rows = apply(projector, started('reused', 'monitor'), rows)
    for (let index = 0; index < 4_100; index++) rows = apply(projector, started(`monitor-${index}`, 'monitor'), rows)
    rows = JSON.parse(JSON.stringify(rows)).map((row: unknown) => agentActivitySchema.parse(row))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.taskUpdatesExcluded).toBe(true)
    expect(apply(new ClaudeActivity(), progress('reused'), rows)).toEqual(rows)
    expect(apply(new ClaudeActivity(), ended('reused'), rows)).toEqual(rows)
    expect(rows[0]?.status).toBe('running')
    expect(apply(projector, progress('reused'))).toEqual([])
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
    rows = apply(new ClaudeActivity(), started('reused'), rows)
    expect(rows[0]?.taskUpdatesExcluded).toBe(false)
    expect(apply(new ClaudeActivity(), { ...ended('reused'), status: 'failed', summary: 'New task failed' }, rows)[0]).toMatchObject({ status: 'failed', text: 'New task failed' })
  })

  it.each(['completed', 'failed', 'stopped', 'cancelled', 'canceled', 'killed', 'interrupted', 'unknown'])('closes %s notifications before late progress or duplicate outcomes', status => {
    const projector = new ClaudeActivity()
    let rows = apply(projector, started('finished'))
    rows = apply(projector, { ...ended('finished'), status }, rows)
    expect(rows[0]?.status).toBe(status === 'completed' || status === 'failed' || status === 'unknown' ? status : 'interrupted')
    expect(rows[0]?.taskUpdatesExcluded).toBe(true)
    const restored = JSON.parse(JSON.stringify(rows)).map((row: unknown) => agentActivitySchema.parse(row))
    expect(apply(new ClaudeActivity(), progress('finished'), restored)).toEqual(rows)
    expect(apply(new ClaudeActivity(), { ...ended('finished'), status: 'failed', summary: 'Late outcome' }, restored)).toEqual(rows)
  })

  it('closes older terminal history without overwriting its outcome when a notification has no known status', () => {
    const original = new ClaudeActivity()
    let rows = apply(original, started('legacy'))
    rows = apply(original, ended('legacy'), rows).map(row => { const legacy = { ...row }; delete legacy.taskUpdatesExcluded; return legacy })
    rows = apply(new ClaudeActivity(), { ...ended('legacy'), status: undefined }, rows)
    expect(rows[0]).toMatchObject({ status: 'completed', taskUpdatesExcluded: true })
    expect(apply(new ClaudeActivity(), { ...ended('legacy'), status: 'failed', summary: 'Late failure' }, rows)).toEqual(rows)
  })

  it('accepts an explicit new start against legacy terminal history with no exclusion marker', () => {
    const projector = new ClaudeActivity()
    let rows = apply(projector, started('legacy'))
    rows = apply(projector, ended('legacy'), rows).map(row => { const legacy = { ...row }; delete legacy.taskUpdatesExcluded; return legacy })
    rows = apply(new ClaudeActivity(), started('legacy'), rows)
    expect(rows[0]?.taskUpdatesExcluded).toBe(false)
    expect(apply(new ClaudeActivity(), { ...ended('legacy'), status: 'failed' }, rows)[0]?.status).toBe('failed')
  })

  it('finishes a known shell command even without a task start', () => {
    const projector = new ClaudeActivity()
    const rows = apply(projector, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'shell', name: 'Bash', input: { command: 'build' } }] } })
    expect(apply(projector, { ...ended('background'), tool_use_id: 'shell' }, rows)).toMatchObject([{ kind: 'command', status: 'completed' }])
  })
})
