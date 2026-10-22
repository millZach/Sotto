// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ActivitySubscribers, asActivityPublication, immutableActivities, immutableUpdates, isActivityPublication, isImmutableActivities, cloneActivitySnapshot } from '../../../src/main/agents/activitySnapshots'
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

describe('the activity subscribers of an adapter', () => {
  it('builds and copies each form a subscriber asked for once, and hands every subscriber of a form that copy (#322)', () => {
    const subscribers = new ActivitySubscribers()
    const received: Array<[string, AgentHostSnapshot]> = []
    subscribers.add(value => received.push(['events', value]), { historyFromEvents: true })
    subscribers.add(value => received.push(['also events', value]), { historyFromEvents: true })
    const off = subscribers.add(value => received.push(['snapshots', value]))
    const built: boolean[] = []
    subscribers.publish(historyFromEvents => { built.push(historyFromEvents); return snapshot(records()) })
    expect(built).toEqual([true, false])
    expect(received.map(([name]) => name)).toEqual(['events', 'also events', 'snapshots'])
    expect(received[0]![1]).toBe(received[1]![1])
    expect(received[2]![1]).not.toBe(received[0]![1])
    expect(received.every(([, value]) => isActivityPublication(value))).toBe(true)
    off(); built.length = 0
    subscribers.publish(historyFromEvents => { built.push(historyFromEvents); return snapshot(records()) })
    expect(built).toEqual([true])
    expect(subscribers.size).toBe(2)
  })

  it('hands a detached view out as it is, and a snapshot built over a publication stays one', () => {
    const subscribers = new ActivitySubscribers()
    const received: AgentHostSnapshot[] = []
    subscribers.add(value => received.push(value))
    const view = snapshot(records())
    subscribers.publish(() => view, true)
    expect(received[0]).toBe(view)
    expect(isActivityPublication(view)).toBe(true)
    expect(isActivityPublication(asActivityPublication({ ...view }, view))).toBe(true)
    expect(isActivityPublication(asActivityPublication({ ...view }, snapshot(records())))).toBe(false)
  })

  it('publishes a record again as the one it published when nothing in it changed, frozen, sharing certified trees (#1326)', () => {
    const update = (record: AgentHostSnapshot['threads'][number], previous?: AgentHostSnapshot['threads'][number]) => immutableUpdates([record], [previous])[0]!
    const activities = immutableActivities(records())
    const source = snapshot(activities).threads[0]!
    const first = update(source)
    expect(first).not.toBe(source)
    expect(first.activities).toBe(activities)
    expect(Object.isFrozen(first)).toBe(true)
    expect(() => { first.requests.push({ id: 'request', kind: 'permission', text: 'Allow?', options: [] }) }).toThrow(TypeError)
    expect(update(source, first)).toBe(first)
    // A record the module owns is shared as it is, and so stays the same record.
    expect(update(first)).toBe(first)
    source.title = 'Renamed'
    const second = update(source, first)
    expect(second.title).toBe('Renamed')
    expect(first.title).toBe('Thread')
    expect(second.messages).toBe(first.messages)
    expect(isImmutableActivities(second.activities)).toBe(true)
    // The list the records come back in is the caller's own, and each record is matched with the previous at its place.
    const other = { ...source, id: 'other', title: 'Other' }
    const both = immutableUpdates([other, source], [undefined, second])
    expect(Object.isFrozen(both)).toBe(false)
    expect(both[1]).toBe(second)
    expect(both[0]!.title).toBe('Other')
    // A publication over such records copies what is not certified for each subscriber and shares the records.
    expect(cloneActivitySnapshot({ ...snapshot([]), threads: [second] }).threads[0]).toBe(second)
  })
})
