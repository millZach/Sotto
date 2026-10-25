// @vitest-environment node
/**
 * When each request started waiting, stamped as the coordinator first shows it (ADR-0135): the stamp stands while
 * the request stands, a thread already carrying its stamps is shown as it stands, and a stamp shown again — this
 * coordinator's own snapshot, or a remote one's — is kept rather than restamped.
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
const shown = (waits: RequestWaits, threads: AgentThread[], gone?: ReadonlySet<string>): AgentThread[] =>
  waits.decorate(snapshot(threads), gone).threads

describe('when a request started waiting', () => {
  it('stamps a request when it is first shown and keeps that stamp while it stands', () => {
    let clock = Date.parse('2026-10-24T10:00:00.000Z')
    const waits = new RequestWaits(() => clock)
    expect(shown(waits, [thread('a', [permission('p1')])])[0]?.requests[0]).toMatchObject({ since: '2026-10-24T10:00:00.000Z' })
    clock += 12 * 60_000
    expect(shown(waits, [thread('a', [permission('p1')])])[0]?.requests[0]).toMatchObject({ since: '2026-10-24T10:00:00.000Z' })
  })

  it('stamps each request on its own and forgets it once answered or gone', () => {
    let clock = Date.parse('2026-10-24T10:00:00.000Z')
    const waits = new RequestWaits(() => clock)
    shown(waits, [thread('a', [permission('p1')])])
    clock += 60_000
    expect(shown(waits, [thread('a', [permission('p1'), question('q1')])])[0]?.requests.map(request => request.since))
      .toEqual(['2026-10-24T10:00:00.000Z', '2026-10-24T10:01:00.000Z'])
    clock += 60_000
    shown(waits, [thread('a', [question('q1')])])
    // p1 answered and asked again under the same ID is a new wait; q1 kept waiting throughout.
    expect(shown(waits, [thread('a', [permission('p1'), question('q1')])])[0]?.requests.map(request => request.since))
      .toEqual(['2026-10-24T10:02:00.000Z', '2026-10-24T10:01:00.000Z'])
    shown(waits, [])
    expect(shown(waits, [thread('a', [question('q1')])])[0]?.requests[0]?.since).toBe('2026-10-24T10:02:00.000Z')
  })

  it('reads only the threads a change named, as a whole showing would leave them', () => {
    let clock = Date.parse('2026-10-24T10:00:00.000Z')
    const waits = new RequestWaits(() => clock)
    shown(waits, [thread('a', [permission('p1')]), thread('b', [question('q1')])])
    clock += 5 * 60_000
    expect(shown(waits, [thread('a', [permission('p2')])], new Set())[0]?.requests[0]?.since).toBe('2026-10-24T10:05:00.000Z')
    expect(shown(waits, [thread('b', [question('q1')])], new Set())[0]?.requests[0]?.since).toBe('2026-10-24T10:00:00.000Z')
    shown(waits, [], new Set(['b']))
    clock += 60_000
    expect(shown(waits, [thread('b', [question('q1')])], new Set())[0]?.requests[0]?.since).toBe('2026-10-24T10:06:00.000Z')
    expect(() => new RequestWaits().decorate(snapshot([]), new Set())).toThrow()
  })

  it('shows a thread as it stands when its stamps already stand, and keeps a stamp shown again', () => {
    const waits = new RequestWaits(() => Date.parse('2026-10-24T10:00:00.000Z'))
    const bare = thread('a')
    expect(shown(waits, [bare])[0]).toBe(bare)
    const stamped = shown(waits, [thread('a', [permission('p1')])])[0]!
    expect(shown(waits, [stamped])[0]).toBe(stamped)
    // A stamp from the coordinator that runs the thread, arriving on its snapshot, is the wait's start.
    const remote = new RequestWaits(() => Date.parse('2026-10-24T11:00:00.000Z'))
    expect(shown(remote, [stamped])[0]).toBe(stamped)
  })

  it('tells which threads moved when a stamp is new', () => {
    const waits = new RequestWaits(() => 1_000)
    const moved: string[] = []
    waits.onMoved = id => { moved.push(id) }
    shown(waits, [thread('a', [permission('p1')]), thread('b')])
    shown(waits, [thread('a', [permission('p1')]), thread('b', [question('q1')])])
    expect(moved).toEqual(['a', 'b'])
  })
})
