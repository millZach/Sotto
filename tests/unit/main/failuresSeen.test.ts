// @vitest-environment node
/**
 * The rules for a failed thread that a client has seen (ADR-0092), on snapshots built by hand. The coordinator around
 * them, its persistence and Dismiss all are in failuresSeenControl.test.ts; the socket in socketClientIsolation.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { FAILURES_SEEN_MAX, FailuresSeen } from '../../../src/main/agents/failuresSeen'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'

type Shape = Partial<Pick<AgentThread, 'status' | 'requests' | 'lastTurn' | 'clientConnected' | 'settledAt'>>

function thread(id: string, shape: Shape = {}): AgentThread {
  return { id, title: id, projectId: 'project', modelId: 'model', status: 'idle', messages: [], requests: [], ...shape }
}
function snapshot(threads: AgentThread[], extra: Partial<AgentHostSnapshot> = {}): AgentHostSnapshot {
  return { ...structuredClone(EMPTY_AGENT_HOST), connected: true, threads, ...extra }
}
const failed = (id: string, turn = 't1'): AgentThread => thread(id, { status: 'error', lastTurn: { id: turn, status: 'failed' } })
const permission = { id: 'p1', kind: 'permission' as const, text: 'Run the build?', options: [] }
/** What a client names for Dismiss all: each thread with the failure the host published for it, read from these threads. */
function rows(seen: FailuresSeen, threads: AgentThread[], ...ids: string[]): { threadId: string; failure: string }[] {
  seen.track(snapshot(threads))
  return ids.map(threadId => ({ threadId, failure: seen.failureOf(threadId) ?? '' }))
}

describe('a failed thread a client has seen', () => {
  it('is seen when a client shows it, and only then', () => {
    const seen = new FailuresSeen()
    const threads = [failed('a'), failed('b'), thread('c')]
    expect(seen.track(snapshot(threads))).toBe(false)
    expect(seen.has('a')).toBe(false)
    expect(seen.show(['a', 'c'], threads)).toBe(true)
    expect(seen.has('a')).toBe(true)
    // Showing a thread that has not failed sees nothing, and another failed thread stays unseen.
    expect(seen.has('c')).toBe(false)
    expect(seen.has('b')).toBe(false)
    // Showing it again changes nothing.
    expect(seen.show(['a'], threads)).toBe(false)
  })

  it('is seen at once when it fails while a client shows it', () => {
    const seen = new FailuresSeen()
    seen.show(['a'], [thread('a', { status: 'running' })])
    expect(seen.track(snapshot([failed('a')]))).toBe(true)
    expect(seen.has('a')).toBe(true)
  })

  it('stays seen after the client looks away, until the thread works or rests again', () => {
    const seen = new FailuresSeen()
    seen.show(['a'], [failed('a')])
    seen.show([], [failed('a')])
    seen.track(snapshot([failed('a')]))
    expect(seen.has('a')).toBe(true)
    expect(seen.track(snapshot([thread('a', { status: 'running', lastTurn: { id: 't2', status: 'running' } })]))).toBe(true)
    expect(seen.has('a')).toBe(false)
    // The next failure is news again.
    seen.track(snapshot([failed('a', 't2')]))
    expect(seen.has('a')).toBe(false)
  })

  it('drops the mark when an idle thread rests', () => {
    const seen = new FailuresSeen()
    seen.show(['a'], [failed('a')])
    seen.show([], [failed('a')])
    expect(seen.track(snapshot([thread('a')]))).toBe(true)
    expect(seen.has('a')).toBe(false)
  })

  it('treats a later turn\'s failure as new even when no snapshot showed it working', () => {
    const seen = new FailuresSeen()
    seen.show(['a'], [failed('a', 't1')])
    seen.show([], [failed('a', 't1')])
    expect(seen.track(snapshot([failed('a', 't2')]))).toBe(true)
    expect(seen.has('a')).toBe(false)
  })

  it('keeps the mark while the thread\'s provider or host is disconnected', () => {
    const seen = new FailuresSeen()
    seen.show(['a', 'b'], [failed('a'), failed('b')])
    seen.show([], [])
    seen.track(snapshot([thread('a'), thread('b')], { connected: false }))
    seen.track(snapshot([thread('a', { clientConnected: false }), failed('b')]))
    expect(seen.has('a')).toBe(true)
    expect(seen.has('b')).toBe(true)
  })

  it('never sees a thread that waits on a request, by showing or by Dismiss all', () => {
    const seen = new FailuresSeen()
    const asking = thread('a', { status: 'error', requests: [permission] })
    expect(seen.show(['a'], [asking])).toBe(false)
    expect(seen.dismiss(rows(seen, [asking], 'a'), [asking])).toBe(false)
    expect(seen.has('a')).toBe(false)
  })

  it('keeps a seen failure seen when the thread then asks something', () => {
    const seen = new FailuresSeen()
    seen.show(['a'], [failed('a')])
    seen.show([], [])
    seen.track(snapshot([{ ...failed('a'), requests: [permission] }]))
    expect(seen.has('a')).toBe(true)
  })

  it('sees every failed thread Dismiss all names, and nothing else', () => {
    const seen = new FailuresSeen()
    const threads = [failed('a'), failed('b'), thread('c'), failed('d')]
    expect(seen.dismiss(rows(seen, threads, 'a', 'b', 'c'), threads)).toBe(true)
    expect(['a', 'b', 'c', 'd'].map(id => seen.has(id))).toEqual([true, true, false, false])
    expect(seen.dismiss(rows(seen, threads, 'a', 'b'), threads)).toBe(false)
  })

  it('leaves a failure that came after the press as news, and sees one still standing in the failure it named', () => {
    const seen = new FailuresSeen()
    const named = rows(seen, [failed('a', 't3'), failed('b', 't1')], 'a', 'b')
    // Before Dismiss all reaches the host, a's next turn fails, with or without a snapshot showing it working first.
    seen.track(snapshot([thread('a', { status: 'running', lastTurn: { id: 't4', status: 'running' } }), failed('b', 't1')]))
    const now = [failed('a', 't4'), failed('b', 't1')]
    seen.track(snapshot(now))
    expect(seen.dismiss(named, now)).toBe(true)
    expect(seen.has('a')).toBe(false)
    expect(seen.has('b')).toBe(true)
    const direct = new FailuresSeen()
    const before = rows(direct, [failed('a', 't3')], 'a')
    direct.track(snapshot([failed('a', 't4')]))
    expect(direct.dismiss(before, [failed('a', 't4')])).toBe(false)
    expect(direct.has('a')).toBe(false)
    // A name the host never gave, as an empty one from a client that read none, sees nothing.
    expect(direct.dismiss([{ threadId: 'a', failure: '' }], [failed('a', 't4')])).toBe(false)
  })

  it('never sees a closed thread', () => {
    const seen = new FailuresSeen()
    const settled = thread('a', { status: 'error', settledAt: '2026-10-19T10:00:00.000Z' })
    expect(seen.dismiss(rows(seen, [settled], 'a'), [settled])).toBe(false)
  })

  it('saves its marks with the failure each was seen in and its turn, and takes them back', () => {
    let next = 0
    const seen = new FailuresSeen([], undefined, () => `f${++next}`)
    const both = [failed('a', 't1'), thread('b', { status: 'error' })]
    seen.dismiss(rows(seen, both, 'a', 'b'), both)
    expect(seen.saved()).toEqual([{ threadId: 'a', failure: 'f1', turn: 't1' }, { threadId: 'b', failure: 'f2' }])
    const again = new FailuresSeen(seen.saved())
    expect(again.has('a')).toBe(true)
    // After a restart the same failed turn stays seen, and a failure that had no turn stays seen when one is named.
    again.track(snapshot([failed('a', 't1'), failed('b', 't9')]))
    expect(again.has('a')).toBe(true)
    expect(again.has('b')).toBe(true)
    // A different failed turn is a new failure.
    again.track(snapshot([failed('a', 't2'), failed('b', 't9')]))
    expect(again.has('a')).toBe(false)
    expect(again.has('b')).toBe(true)
  })

  it('keeps one failure across a resume that fails and the history that later names its turn', () => {
    const seen = new FailuresSeen()
    const resumed = thread('a', { status: 'error' })
    seen.track(snapshot([resumed]))
    const name = seen.failureOf('a')
    expect(seen.dismiss([{ threadId: 'a', failure: name! }], [resumed])).toBe(true)
    expect(seen.track(snapshot([failed('a', 't1')]))).toBe(true)
    expect(seen.has('a')).toBe(true)
    expect(seen.failureOf('a')).toBe(name)
  })

  it('names each failure on its own and drops the name once the thread works or rests', () => {
    const seen = new FailuresSeen()
    seen.track(snapshot([failed('a', 't1')]))
    const first = seen.failureOf('a')
    expect(first).toBeDefined()
    seen.track(snapshot([thread('a', { status: 'running' })]))
    expect(seen.failureOf('a')).toBeUndefined()
    seen.track(snapshot([failed('a', 't1')]))
    expect(seen.failureOf('a')).not.toBe(first)
  })

  it('keeps every mark of a listed thread, however many Dismiss all names', () => {
    const many = Array.from({ length: FAILURES_SEEN_MAX + 50 }, (_, index) => failed(`t${index}`))
    const seen = new FailuresSeen()
    expect(seen.dismiss(rows(seen, many, ...many.map(item => item.id)), many)).toBe(true)
    seen.track(snapshot(many))
    expect(many.every(item => seen.has(item.id))).toBe(true)
    expect(seen.saved()).toHaveLength(FAILURES_SEEN_MAX + 50)
  })

  it('keeps at most the newest marks of threads that are gone, and dormant ones whole', () => {
    const ids = Array.from({ length: FAILURES_SEEN_MAX + 5 }, (_, index) => `t${index}`)
    const saved = ids.map(threadId => ({ threadId, failure: '' }))
    // Restoring drops nothing: until the host lists its threads, it cannot tell which are gone.
    expect(new FailuresSeen(saved).saved()).toHaveLength(ids.length)
    const listed = new FailuresSeen(saved)
    listed.track(snapshot([failed('t0', '')].map(item => ({ ...item, lastTurn: undefined }))))
    // t0 is still listed in its failure; of the gone ones, the four oldest past the limit go.
    expect(listed.saved().map(mark => mark.threadId)).toEqual(['t0', ...ids.slice(5)])
    const dormant = new Set(['t1'])
    const kept = new FailuresSeen(saved, id => dormant.has(id))
    kept.track(snapshot([]))
    expect(kept.saved().map(mark => mark.threadId)).toEqual(['t1', ...ids.slice(5)])
  })

  it('publishes the name of the failure and the mark as optional fields, and nothing otherwise', () => {
    const seen = new FailuresSeen([{ threadId: 'a', failure: 'f1' }])
    expect(seen.publish(thread('a'))).toMatchObject({ failureId: 'f1', failureSeen: true })
    seen.track(snapshot([failed('c')]))
    expect(seen.publish(thread('c'))).toMatchObject({ failureId: seen.failureOf('c') })
    expect(seen.publish(thread('c'))).not.toHaveProperty('failureSeen')
    expect(seen.publish(thread('b'))).not.toHaveProperty('failureSeen')
    expect(seen.publish({ ...thread('b'), failureSeen: true, failureId: 'old' })).toEqual(thread('b'))
    const same = thread('b')
    expect(seen.publish(same)).toBe(same)
  })
})
