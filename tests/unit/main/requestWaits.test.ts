// @vitest-environment node
/**
 * When each request started waiting, stamped by the host (ADR-0135): the first snapshot that shows a request stamps it,
 * the stamp stands while the request stands, and publishing leaves a thread that already carries its stamps untouched.
 */
import { describe, expect, it } from 'vitest'
import { RequestWaits } from '../../../src/main/agents/requestWaits'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentRequest, type AgentThread } from '../../../src/shared/agents'

const permission = (id: string): AgentRequest => ({ id, kind: 'permission', text: 'Run the build?', options: [] })
const question = (id: string): AgentRequest => ({ id, kind: 'question', text: 'Friday or Monday?', options: [] })
function thread(id: string, requests: AgentRequest[] = []): AgentThread {
  return { id, title: id, projectId: 'project', modelId: 'model', status: 'idle', messages: [], requests }
}
function snapshot(threads: AgentThread[]): AgentHostSnapshot {
  return { ...structuredClone(EMPTY_AGENT_HOST), connected: true, threads }
}

describe('when a request started waiting', () => {
  it('stamps a request when it is first shown and keeps that stamp while it stands', () => {
    let clock = Date.parse('2026-10-24T10:00:00.000Z')
    const waits = new RequestWaits(() => clock)
    waits.track(snapshot([thread('a', [permission('p1')])]))
    expect(waits.publish(thread('a', [permission('p1')])).requests[0]).toMatchObject({ since: '2026-10-24T10:00:00.000Z' })
    clock += 12 * 60_000
    waits.track(snapshot([thread('a', [permission('p1')])]))
    expect(waits.publish(thread('a', [permission('p1')])).requests[0]).toMatchObject({ since: '2026-10-24T10:00:00.000Z' })
  })

  it('stamps each request on its own and forgets it once answered or gone', () => {
    let clock = Date.parse('2026-10-24T10:00:00.000Z')
    const waits = new RequestWaits(() => clock)
    waits.track(snapshot([thread('a', [permission('p1')])]))
    clock += 60_000
    waits.track(snapshot([thread('a', [permission('p1'), question('q1')])]))
    const both = waits.publish(thread('a', [permission('p1'), question('q1')]))
    expect(both.requests.map(request => request.since)).toEqual(['2026-10-24T10:00:00.000Z', '2026-10-24T10:01:00.000Z'])
    clock += 60_000
    waits.track(snapshot([thread('a', [question('q1')])]))
    waits.track(snapshot([thread('a', [permission('p1'), question('q1')])]))
    // p1 answered and asked again under the same ID is a new wait; q1 kept waiting throughout.
    expect(waits.publish(thread('a', [permission('p1'), question('q1')])).requests.map(request => request.since))
      .toEqual(['2026-10-24T10:02:00.000Z', '2026-10-24T10:01:00.000Z'])
    waits.track(snapshot([]))
    waits.track(snapshot([thread('a', [question('q1')])]))
    expect(waits.publish(thread('a', [question('q1')])).requests[0]?.since).toBe('2026-10-24T10:02:00.000Z')
  })

  it('reads only the threads a change named, as a whole read would leave them', () => {
    let clock = Date.parse('2026-10-24T10:00:00.000Z')
    const waits = new RequestWaits(() => clock)
    waits.track(snapshot([thread('a', [permission('p1')]), thread('b', [question('q1')])]))
    clock += 5 * 60_000
    const changed = snapshot([thread('a', [permission('p2')]), thread('b', [question('q1')])])
    waits.trackChanged(changed, [thread('a', [permission('p2')])], [])
    expect(waits.publish(thread('a', [permission('p2')])).requests[0]?.since).toBe('2026-10-24T10:05:00.000Z')
    expect(waits.publish(thread('b', [question('q1')])).requests[0]?.since).toBe('2026-10-24T10:00:00.000Z')
    waits.trackChanged(snapshot([thread('a', [permission('p2')])]), [], ['b'])
    clock += 60_000
    waits.track(snapshot([thread('a', [permission('p2')]), thread('b', [question('q1')])]))
    expect(waits.publish(thread('b', [question('q1')])).requests[0]?.since).toBe('2026-10-24T10:06:00.000Z')
    expect(() => new RequestWaits().trackChanged(snapshot([]), [], [])).toThrow()
  })

  it('publishes the thread as it stands when its stamps already stand, and strips a stamp it never gave', () => {
    const waits = new RequestWaits(() => Date.parse('2026-10-24T10:00:00.000Z'))
    const bare = thread('a')
    expect(waits.publish(bare)).toBe(bare)
    waits.track(snapshot([thread('a', [permission('p1')])]))
    const stamped = waits.publish(thread('a', [permission('p1')]))
    expect(waits.publish(stamped)).toBe(stamped)
    const foreign = thread('a', [{ ...permission('p9'), since: '2020-01-01T00:00:00.000Z' }])
    expect(waits.publish(foreign).requests[0]).not.toHaveProperty('since')
  })

  it('tells which threads moved when a stamp is new', () => {
    const waits = new RequestWaits(() => 1_000)
    const moved: string[] = []
    waits.onMoved = id => { moved.push(id) }
    waits.track(snapshot([thread('a', [permission('p1')]), thread('b')]))
    waits.track(snapshot([thread('a', [permission('p1')]), thread('b', [question('q1')])]))
    expect(moved).toEqual(['a', 'b'])
  })
})
