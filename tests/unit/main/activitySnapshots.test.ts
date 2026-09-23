// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { immutableActivities, isImmutableActivities, cloneActivitySnapshot } from '../../../src/main/agents/activitySnapshots'
import { cloneHostSnapshot } from '../../../src/main/agents/cloneHostSnapshot'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot } from '../../../src/shared/agents'
import type { AgentActivity } from '../../../src/shared/agentActivity'

const records = (): AgentActivity[] => [{ id: 'build', turnId: 'turn', sequence: 0, kind: 'command',
  status: 'running', title: 'Build', output: 'first', agents: [{ id: 'child', status: 'running', message: 'Task' }] }]
function snapshot(activities: AgentActivity[]): AgentHostSnapshot {
  return { ...EMPTY_AGENT_HOST, threads: [{ id: 'thread', projectId: 'project', title: 'Thread', modelId: 'model',
    status: 'running', messages: [], requests: [], activities }] }
}

describe('owned activity snapshots', () => {
  it('owns and freezes nested data without freezing the mutable source or trusting its identity', () => {
    const source = records()
    const first = immutableActivities(source)
    source[0]!.output = 'second'
    source[0]!.agents![0]!.message = 'Changed task'
    expect(first[0]!.output).toBe('first')
    expect(first[0]!.agents![0]!.message).toBe('Task')
    expect(immutableActivities(source)[0]!.output).toBe('second')
    expect(() => { first[0]!.agents![0]!.message = 'Illegal' }).toThrow(TypeError)
    expect(isImmutableActivities(source)).toBe(false)
    expect(isImmutableActivities(first)).toBe(true)
    expect(immutableActivities(first)).toBe(first)
  })

  it('does not trust a shallow-frozen caller array', () => {
    const source = Object.freeze(records())
    expect(isImmutableActivities(source)).toBe(false)
    const first = immutableActivities(source)
    source[0]!.agents![0]!.message = 'Later'
    expect(first[0]!.agents![0]!.message).toBe('Task')
  })

  it('copies only new records when installing a changed list and retains old snapshots', () => {
    const first = immutableActivities(records())
    const second = immutableActivities([...first, { ...first[0]!, id: 'next', output: 'new' }])
    expect(second[0]).toBe(first[0])
    expect(second[1]!.agents).toBe(first[0]!.agents)
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(2)
  })

  it('shares certified activity only on the internal path while isolating mutable metadata', () => {
    const activities = immutableActivities(records())
    const source = snapshot(activities)
    const first = cloneActivitySnapshot(source)
    const second = cloneActivitySnapshot(source)
    expect(first.threads[0]!.activities).toBe(activities)
    expect(second.threads[0]!.activities).toBe(activities)
    first.threads[0]!.title = 'Changed'
    first.threads[0]!.requests.push({ id: 'request', kind: 'permission', text: 'Allow?', options: [] })
    expect(second.threads[0]!.title).toBe('Thread')
    expect(second.threads[0]!.requests).toEqual([])
    const publicCopy = cloneHostSnapshot(first)
    publicCopy.threads[0]!.activities![0]!.output = 'Writable'
    publicCopy.threads[0]!.activities![0]!.agents![0]!.message = 'Writable task'
    expect(activities[0]!.output).toBe('first')
    expect(activities[0]!.agents![0]!.message).toBe('Task')
  })

  it('copies uncertified legacy activities on every arrival, including in-place mutations', () => {
    const source = snapshot(records())
    const first = cloneActivitySnapshot(source)
    source.threads[0]!.activities![0]!.output = 'Later'
    const second = cloneActivitySnapshot(source)
    expect(first.threads[0]!.activities![0]!.output).toBe('first')
    expect(second.threads[0]!.activities![0]!.output).toBe('Later')
    expect(isImmutableActivities(second.threads[0]!.activities)).toBe(false)
  })
})
