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
    expect(seen.dismiss(['a'], [asking])).toBe(false)
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
    expect(seen.dismiss(['a', 'b', 'c'], threads)).toBe(true)
    expect(['a', 'b', 'c', 'd'].map(id => seen.has(id))).toEqual([true, true, false, false])
    expect(seen.dismiss(['a', 'b'], threads)).toBe(false)
  })

  it('never sees a closed thread', () => {
    const seen = new FailuresSeen()
    const settled = thread('a', { status: 'error', settledAt: '2026-10-19T10:00:00.000Z' })
    expect(seen.dismiss(['a'], [settled])).toBe(false)
  })

  it('saves its marks with the failure each was seen in, and takes them back', () => {
    const seen = new FailuresSeen()
    seen.dismiss(['a', 'b'], [failed('a', 't1'), thread('b', { status: 'error' })])
    expect(seen.saved()).toEqual([{ threadId: 'a', failure: 't1:failed' }, { threadId: 'b', failure: '' }])
    const again = new FailuresSeen(seen.saved())
    expect(again.has('a')).toBe(true)
    // The same failure after a restart stays seen; a different one is news.
    again.track(snapshot([failed('a', 't1'), failed('b', 't9')]))
    expect(again.has('a')).toBe(true)
    expect(again.has('b')).toBe(false)
  })

  it('keeps every mark of a listed thread, however many Dismiss all names', () => {
    const many = Array.from({ length: FAILURES_SEEN_MAX + 50 }, (_, index) => failed(`t${index}`))
    const seen = new FailuresSeen()
    expect(seen.dismiss(many.map(item => item.id), many)).toBe(true)
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

  it('publishes the mark as an optional field and nothing otherwise', () => {
    const seen = new FailuresSeen([{ threadId: 'a', failure: '' }])
    expect(seen.publish(thread('a')).failureSeen).toBe(true)
    expect(seen.publish(thread('b'))).not.toHaveProperty('failureSeen')
    expect(seen.publish({ ...thread('b'), failureSeen: true })).not.toHaveProperty('failureSeen')
    const same = thread('b')
    expect(seen.publish(same)).toBe(same)
  })
})
