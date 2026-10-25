// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { immutableActivities, immutableRecord } from '../../../src/main/agents/activitySnapshots'
import { ThreadChangesPublisher, ThreadMap, threadChangesBetween, threadMapDifferences, type AgentHostChanges, type AgentHostRest } from '../../../src/main/agents/threadChanges'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'

const thread = (id: string, fields: Partial<AgentThread> = {}): AgentThread => ({ id, projectId: 'project', title: `Thread ${id}`, modelId: 'model',
  status: 'idle', messages: [], requests: [], ...fields })
const host = (threads: AgentThread[], fields: Partial<AgentHostSnapshot> = {}): AgentHostSnapshot => ({ ...structuredClone(EMPTY_AGENT_HOST), connected: true,
  name: 'Synthetic', threads, ...fields })
/** A record copied, recursively frozen and owned, as a publisher hands one out. */
const owned = (id: string, fields: Partial<AgentThread> = {}): AgentThread => immutableRecord(thread(id, fields))
const message = (id: string, text: string) => ({ id, role: 'user' as const, text, createdAt: '2026-10-24T00:00:00.000Z' })
const rest = (fields: Partial<AgentHostSnapshot> = {}): AgentHostRest => {
  const parts: Partial<AgentHostSnapshot> = host([], fields)
  delete parts.threads
  return immutableRecord(parts as AgentHostRest)
}
const ids = (map: ThreadMap): string[] => [...map.ids()]
/** A map holding a whole publication of `threads`. */
function started(threads: AgentThread[], sequence = 1): ThreadMap {
  const map = new ThreadMap()
  expect(map.apply({ sequence, whole: true, upserts: threads, removals: [], rest: rest() })).toBe('applied')
  return map
}

describe('a thread map', () => {
  it('asks for a whole publication before it holds one', () => {
    const map = new ThreadMap()
    expect(map.apply({ sequence: 1, upserts: [owned('a')], removals: [] })).toBe('resync')
    expect(map.sequence).toBeUndefined()
    expect(map.size).toBe(0)
    expect(map.snapshot()).toBeUndefined()
  })

  it('takes the order, the records and the rest a whole publication gives', () => {
    const a = owned('a'), b = owned('b'), c = owned('c')
    const map = started([c, a, b], 7)
    expect(ids(map)).toEqual(['c', 'a', 'b'])
    expect(map.get('a')).toBe(a)
    expect(map.sequence).toBe(7)
    expect(map.snapshot()).toEqual(host([c, a, b]))
  })

  it('keeps an upserted thread where it was and appends a new one', () => {
    const map = started([owned('a'), owned('b'), owned('c')])
    const b = owned('b', { status: 'running' }), d = owned('d')
    expect(map.apply({ sequence: 2, upserts: [d, b], removals: [] })).toBe('applied')
    expect(ids(map)).toEqual(['a', 'b', 'c', 'd'])
    expect(map.get('b')).toBe(b)
    expect(map.sequence).toBe(2)
  })

  it('drops a removed thread, and appends it when it comes back', () => {
    const map = started([owned('a'), owned('b'), owned('c')])
    expect(map.apply({ sequence: 2, upserts: [], removals: ['a'] })).toBe('applied')
    expect(ids(map)).toEqual(['b', 'c'])
    expect(map.has('a')).toBe(false)
    expect(map.apply({ sequence: 3, upserts: [owned('a')], removals: [] })).toBe('applied')
    expect(ids(map)).toEqual(['b', 'c', 'a'])
  })

  it('applies removals before upserts in one change', () => {
    const map = started([owned('a'), owned('b')])
    const a = owned('a', { title: 'Back' })
    expect(map.apply({ sequence: 2, upserts: [a], removals: ['a'] })).toBe('applied')
    expect(ids(map)).toEqual(['b', 'a'])
    expect(map.get('a')).toBe(a)
  })

  it('asks for a resync on a gap, ignores a change it already has, and changes nothing for either', () => {
    const map = started([owned('a')], 4)
    expect(map.apply({ sequence: 6, upserts: [owned('b')], removals: [] })).toBe('resync')
    expect(map.apply({ sequence: 4, upserts: [owned('b')], removals: ['a'] })).toBe('stale')
    expect(map.apply({ sequence: 3, upserts: [owned('b')], removals: ['a'] })).toBe('stale')
    expect(ids(map)).toEqual(['a'])
    expect(map.sequence).toBe(4)
    // A whole publication after the gap starts the map again, whatever its sequence.
    expect(map.apply({ sequence: 9, whole: true, upserts: [owned('b'), owned('a')], removals: [], rest: rest() })).toBe('applied')
    expect(ids(map)).toEqual(['b', 'a'])
    expect(map.apply({ sequence: 10, upserts: [], removals: ['b'] })).toBe('applied')
    expect(ids(map)).toEqual(['a'])
  })

  it('refuses a whole publication older than the one it holds, and takes one of the same sequence', () => {
    const map = started([owned('a')], 5)
    expect(map.apply({ sequence: 4, whole: true, upserts: [owned('old')], removals: [], rest: rest() })).toBe('stale')
    expect(ids(map)).toEqual(['a'])
    expect(map.sequence).toBe(5)
    // A resync is answered with the sequence of the last change sent.
    expect(map.apply({ sequence: 5, whole: true, upserts: [owned('b')], removals: [], rest: rest() })).toBe('applied')
    expect(ids(map)).toEqual(['b'])
  })

  it('places a new thread before another, in the middle of the list', () => {
    const map = started([owned('claude-a'), owned('codex-b'), owned('codex-c')])
    expect(map.apply({ sequence: 2, upserts: [owned('claude-d')], removals: [], placements: [{ id: 'claude-d', beforeId: 'codex-b' }] })).toBe('applied')
    expect(ids(map)).toEqual(['claude-a', 'claude-d', 'codex-b', 'codex-c'])
  })

  it('moves a thread that did not change, to another place or to the end, keeping its record', () => {
    const a = owned('a')
    const map = started([a, owned('b'), owned('c'), owned('d')])
    expect(map.apply({ sequence: 2, upserts: [], removals: [], placements: [{ id: 'd', beforeId: 'b' }] })).toBe('applied')
    expect(ids(map)).toEqual(['a', 'd', 'b', 'c'])
    expect(map.apply({ sequence: 3, upserts: [], removals: [], placements: [{ id: 'a', beforeId: null }] })).toBe('applied')
    expect(ids(map)).toEqual(['d', 'b', 'c', 'a'])
    expect(map.get('a')).toBe(a)
    // Placements apply in the order given, after removals and upserts.
    expect(map.apply({ sequence: 4, upserts: [owned('e')], removals: ['c'], placements: [{ id: 'a', beforeId: 'd' }, { id: 'e', beforeId: 'a' }] })).toBe('applied')
    expect(ids(map)).toEqual(['e', 'a', 'd', 'b'])
  })

  it('refuses a placement naming a thread it will not hold, and applies none of the change', () => {
    const map = started([owned('a'), owned('b')])
    expect(() => map.apply({ sequence: 2, upserts: [], removals: [], placements: [{ id: 'missing', beforeId: 'a' }] })).toThrow(TypeError)
    expect(() => map.apply({ sequence: 2, upserts: [owned('c')], removals: ['b'], placements: [{ id: 'c', beforeId: 'b' }] })).toThrow(TypeError)
    expect(() => map.apply({ sequence: 2, upserts: [], removals: [], placements: [{ id: 'a', beforeId: 'a' }] })).toThrow(TypeError)
    expect(ids(map)).toEqual(['a', 'b'])
    expect(map.sequence).toBe(1)
  })

  it('takes a new order from a whole publication that reorders', () => {
    const a = owned('a'), b = owned('b'), c = owned('c')
    const map = started([a, b, c])
    expect(map.apply({ sequence: 2, whole: true, upserts: [c, a], removals: [], rest: rest() })).toBe('applied')
    expect(ids(map)).toEqual(['c', 'a'])
    expect(map.get('c')).toBe(c)
    expect(map.has('b')).toBe(false)
  })

  it('takes the parts that are not threads alone, keeping every thread', () => {
    const a = owned('a')
    const map = started([a])
    const next = rest({ error: 'Provider connection failed.', connected: false })
    expect(map.apply({ sequence: 2, upserts: [], removals: [], rest: next })).toBe('applied')
    expect(map.rest).toBe(next)
    expect(map.get('a')).toBe(a)
    expect(map.snapshot()).toMatchObject({ connected: false, error: 'Provider connection failed.', threads: [a] })
  })

  it('refuses a record that is not owned, even one frozen on the outside, and applies none of the change', () => {
    const map = started([owned('a')])
    expect(() => map.apply({ sequence: 2, upserts: [owned('b'), thread('c')], removals: ['a'] })).toThrow(TypeError)
    // Frozen on the outside, but its messages could still be written into after the map took it.
    const shallow = Object.freeze(thread('c', { messages: [message('m', 'Hello')] }))
    expect(() => map.apply({ sequence: 2, upserts: [shallow], removals: [] })).toThrow(TypeError)
    expect(() => map.apply({ sequence: 2, upserts: [], removals: [], rest: { ...rest() } })).toThrow(TypeError)
    expect(() => map.apply({ sequence: 2, upserts: [], removals: [], rest: Object.freeze({ ...rest() }) })).toThrow(TypeError)
    expect(ids(map)).toEqual(['a'])
    expect(map.sequence).toBe(1)
  })

  it('holds records frozen all the way down', () => {
    const map = started([owned('a', { messages: [message('m', 'Hello')] })])
    const record = map.get('a')!
    expect(() => { record.messages.push(message('n', 'More')) }).toThrow(TypeError)
    expect(() => { record.messages[0]!.text = 'Changed' }).toThrow(TypeError)
    expect(() => { record.requests.push({ id: 'r', kind: 'question', text: 'Question', options: [] }) }).toThrow(TypeError)
    expect(map.get('a')!.messages).toEqual([message('m', 'Hello')])
  })

  it('refuses a whole publication without the rest of the snapshot', () => {
    expect(() => new ThreadMap().apply({ sequence: 1, whole: true, upserts: [], removals: [] })).toThrow(TypeError)
  })

  it('hands out frozen records, and a snapshot of its own that any caller may change', () => {
    const map = started([owned('a', { messages: [message('m', 'Hello')] })])
    expect(() => { (map.get('a') as { title: string }).title = 'Changed' }).toThrow(TypeError)
    const snapshot = map.snapshot()!
    snapshot.threads[0]!.title = 'Changed'
    snapshot.threads[0]!.messages[0]!.text = 'Changed'
    snapshot.threads.push(thread('b'))
    snapshot.models.push({ id: 'model', provider: 'Fake', name: 'Model', ready: true })
    expect(map.get('a')!.title).toBe('Thread a')
    expect(map.get('a')!.messages[0]!.text).toBe('Hello')
    expect(ids(map)).toEqual(['a'])
    expect(map.rest!.models).toEqual([])
    expect(map.snapshot()).not.toBe(snapshot)
  })
})

describe('a thread map checked against a whole snapshot', () => {
  it('finds nothing when the map equals the snapshot', () => {
    const map = started([owned('a'), owned('b')])
    expect(threadMapDifferences(map, host([thread('a'), thread('b')]))).toEqual([])
  })

  it('names a missed removal, a missed upsert, a stale record, the wrong order and other parts that differ', () => {
    const map = started([owned('a'), owned('b'), owned('c')])
    expect(threadMapDifferences(map, host([thread('a'), thread('b')]))).toEqual([expect.stringMatching(/thread "c" .*missed removal/u)])
    expect(threadMapDifferences(map, host([thread('a'), thread('b'), thread('c'), thread('d')]))).toEqual([expect.stringMatching(/thread "d" .*missed upsert/u)])
    expect(threadMapDifferences(map, host([thread('a'), thread('b', { status: 'running' }), thread('c')]))).toEqual([expect.stringMatching(/thread "b" .*stale/u)])
    expect(threadMapDifferences(map, host([thread('b'), thread('a'), thread('c')]))).toEqual([expect.stringMatching(/order/u)])
    expect(threadMapDifferences(map, host([thread('a'), thread('b'), thread('c')], { connected: false }))).toEqual([expect.stringMatching(/rest/u)])
  })

  it('in verifying mode, fails a change that leaves the map unlike the whole snapshot', () => {
    let truth = host([thread('a'), thread('b')])
    const map = new ThreadMap({ wholeOf: () => truth, verify: true })
    expect(map.apply({ sequence: 1, whole: true, upserts: [owned('a'), owned('b')], removals: [], rest: rest() })).toBe('applied')
    // The publisher removed b, but the change it sent forgot to say so.
    truth = host([thread('a', { status: 'running' })])
    expect(() => map.apply({ sequence: 2, upserts: [owned('a', { status: 'running' })], removals: [] })).toThrow(/thread "b" is in the map but not the snapshot/u)
  })

  it('in verifying mode, fails a stale record and a wrong order', () => {
    let truth = host([thread('a'), thread('b')])
    const stale = new ThreadMap({ wholeOf: () => truth, verify: true })
    stale.apply({ sequence: 1, whole: true, upserts: [owned('a'), owned('b')], removals: [], rest: rest() })
    truth = host([thread('a', { title: 'Renamed' }), thread('b')])
    expect(() => stale.apply({ sequence: 2, upserts: [], removals: [] })).toThrow(/thread "a" is unlike/u)

    truth = host([thread('a'), thread('b')])
    const order = new ThreadMap({ wholeOf: () => truth, verify: true })
    order.apply({ sequence: 1, whole: true, upserts: [owned('a'), owned('b')], removals: [], rest: rest() })
    truth = host([thread('c'), thread('a'), thread('b')])
    // A thread that goes first can only come in a whole publication; an upsert appends it.
    expect(() => order.apply({ sequence: 2, upserts: [owned('c')], removals: [] })).toThrow(/order/u)
  })

  it('checks nothing unless verifying is on', () => {
    const wholeOf = vi.fn(() => host([]))
    const map = new ThreadMap({ wholeOf, verify: false })
    map.apply({ sequence: 1, whole: true, upserts: [owned('a')], removals: [], rest: rest() })
    expect(wholeOf).not.toHaveBeenCalled()
  })
})

describe('changes worked out from a whole snapshot', () => {
  /** A map holding what the shim made of `snapshot`, as a publisher keeps one. */
  function published(snapshot: AgentHostSnapshot): { map: ThreadMap; changes: ReturnType<typeof threadChangesBetween> } {
    const changes = threadChangesBetween(undefined, snapshot)
    const map = new ThreadMap()
    map.apply({ ...changes, sequence: 1 })
    return { map, changes }
  }

  it('makes the first publication whole, with frozen records and parts', () => {
    const { changes } = published(host([thread('a'), thread('b')]))
    expect(changes.whole).toBe(true)
    expect(changes.upserts.map(item => item.id)).toEqual(['a', 'b'])
    expect(changes.removals).toEqual([])
    expect(changes.rest).toBeDefined()
    expect(Object.isFrozen(changes.upserts[0])).toBe(true)
    expect(Object.isFrozen(changes.upserts[0]!.messages)).toBe(true)
    expect(Object.isFrozen(changes.rest)).toBe(true)
    expect(() => { (changes.upserts[0] as { title: string }).title = 'Changed' }).toThrow(TypeError)
  })

  it('leaves out a thread that is the record published last, or equal to it', () => {
    const { map } = published(host([thread('a'), thread('b')]))
    const a = map.get('a')!
    // `a` is the very record; b is a new object equal to the last one.
    const changes = threadChangesBetween(map, host([a, thread('b')]))
    expect(changes).toEqual({ upserts: [], removals: [] })
  })

  it('upserts a changed thread as a new frozen record that keeps every part that did not change', () => {
    const activities = immutableActivities([{ id: 'x', turnId: 't', sequence: 0, kind: 'command', status: 'completed', title: 'Build' }])
    const { map } = published(host([thread('a', { activities }), thread('b')]))
    const before = map.get('a')!
    const changes = threadChangesBetween(map, host([thread('a', { activities, status: 'running' }), thread('b')]))
    expect(changes.whole).toBeUndefined()
    expect(changes.upserts).toHaveLength(1)
    const after = changes.upserts[0]!
    expect(after).not.toBe(before)
    expect(after.status).toBe('running')
    expect(after.activities).toBe(activities)
    expect(after.messages).toBe(before.messages)
    expect(Object.isFrozen(after)).toBe(true)
    expect(changes.rest).toBeUndefined()
  })

  it('names a thread that went, and appends a new one without a whole publication', () => {
    const { map } = published(host([thread('a'), thread('b'), thread('c')]))
    const changes = threadChangesBetween(map, host([thread('a'), thread('c'), thread('d')]))
    expect(changes.whole).toBeUndefined()
    expect(changes.removals).toEqual(['b'])
    expect(changes.upserts.map(item => item.id)).toEqual(['d'])
  })

  /** `map` after `changes`, numbered as the next publication. */
  function after(map: ThreadMap, changes: ReturnType<typeof threadChangesBetween>): string[] {
    expect(map.apply({ ...changes, sequence: map.sequence! + 1 })).toBe('applied')
    return ids(map)
  }

  it('places a thread that comes in the middle, as the provider switch lists a new thread of one provider before the next provider\'s', () => {
    const { map } = published(host([thread('claude-a'), thread('codex-b'), thread('codex-c')]))
    const changes = threadChangesBetween(map, host([thread('claude-a'), thread('claude-d'), thread('codex-b'), thread('codex-c')]))
    expect(changes.whole).toBeUndefined()
    expect(changes.upserts.map(item => item.id)).toEqual(['claude-d'])
    expect(changes.placements).toEqual([{ id: 'claude-d', beforeId: 'codex-b' }])
    expect(after(map, changes)).toEqual(['claude-a', 'claude-d', 'codex-b', 'codex-c'])
    expect(threadMapDifferences(map, host([thread('claude-a'), thread('claude-d'), thread('codex-b'), thread('codex-c')]))).toEqual([])
  })

  it('places a thread that moved without upserting it', () => {
    const { map } = published(host([thread('a'), thread('b'), thread('c')]))
    const c = map.get('c')!
    const changes = threadChangesBetween(map, host([thread('c'), thread('a'), thread('b')]))
    expect(changes.whole).toBeUndefined()
    expect(changes.upserts).toEqual([])
    expect(changes.placements).toEqual([{ id: 'c', beforeId: 'a' }])
    expect(after(map, changes)).toEqual(['c', 'a', 'b'])
    expect(map.get('c')).toBe(c)
  })

  it('places threads that moved and came in several places at once', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    const next = ['a', 'x', 'c', 'b', 'd', 'e', 'f', 'j', 'g', 'h', 'i', 'y']
    const { map } = published(host(before.map(id => thread(id))))
    const changes = threadChangesBetween(map, host(next.map(id => thread(id))))
    expect(changes.whole).toBeUndefined()
    expect(changes.upserts.map(item => item.id)).toEqual(['x', 'y'])
    // x comes in the middle; one of b and c moved, and j; y goes last without a placement.
    expect(changes.placements).toHaveLength(3)
    expect(after(map, changes)).toEqual(next)
  })

  it('sends a whole publication when most of the list moved', () => {
    const { map } = published(host([thread('a'), thread('b'), thread('c'), thread('d')]))
    const a = map.get('a')!, d = map.get('d')!
    const moved = threadChangesBetween(map, host([thread('d'), thread('c'), thread('b'), thread('a')]))
    expect(moved.whole).toBe(true)
    expect(moved.placements).toBeUndefined()
    expect(moved.upserts.map(item => item.id)).toEqual(['d', 'c', 'b', 'a'])
    // A thread that did not change is still the record published last.
    expect(moved.upserts[0]).toBe(d)
    expect(moved.upserts[3]).toBe(a)
  })

  it('copies a thread it is handed and keeps nothing the caller can still write into', () => {
    const { map } = published(host([thread('a')]))
    const alias = thread('a', { messages: [message('m', 'Hello')] })
    const changes = threadChangesBetween(map, host([alias]))
    expect(changes.upserts[0]).not.toBe(alias)
    after(map, changes)
    // The caller writes into what it handed over; the map is unchanged, and the next publication carries the write.
    alias.messages.push(message('n', 'More'))
    alias.messages[0]!.text = 'Changed'
    expect(map.get('a')!.messages).toEqual([message('m', 'Hello')])
    const next = threadChangesBetween(map, host([alias]))
    expect(next.upserts.map(item => item.messages.map(entry => entry.text))).toEqual([['Changed', 'More']])
  })

  it('carries the parts that are not threads only when they changed', () => {
    const { map } = published(host([thread('a')]))
    const changes = threadChangesBetween(map, host([thread('a')], { connected: false, error: 'Lost.' }))
    expect(changes.upserts).toEqual([])
    expect(changes.rest).toMatchObject({ connected: false, error: 'Lost.' })
    expect(Object.isFrozen(changes.rest)).toBe(true)
    // The catalog that did not change is the one published last.
    expect(changes.rest!.models).toBe(map.rest!.models)
  })
})

describe('a thread changes publisher', () => {
  const holder = (verifyAgainst?: () => AgentHostSnapshot) => {
    const map = new ThreadMap(verifyAgainst ? { wholeOf: verifyAgainst, verify: true } : {})
    const received: AgentHostChanges[] = []
    const listener = (changes: AgentHostChanges) => { received.push(changes); return map.apply(changes) }
    return { map, received, listener }
  }

  it('sends a whole publication first, then changes numbered one by one, the same object to every subscriber of a form', () => {
    const publisher = new ThreadChangesPublisher()
    const first = holder(), second = holder()
    publisher.subscribe(first.listener); publisher.subscribe(second.listener)
    const view = vi.fn(() => host([thread('a'), thread('b')]))
    publisher.publishSnapshots(view)
    expect(view).toHaveBeenCalledTimes(1)
    expect(first.received[0]).toMatchObject({ sequence: 1, whole: true })
    publisher.publishSnapshots(() => host([thread('a', { status: 'running' }), thread('b')]))
    expect(first.received[1]).toMatchObject({ sequence: 2, removals: [] })
    expect(first.received[1]!.upserts.map(item => item.id)).toEqual(['a'])
    expect(second.received[1]).toBe(first.received[1])
    expect(Object.isFrozen(first.received[1])).toBe(true)
    expect(first.map.snapshot()).toEqual(host([thread('a', { status: 'running' }), thread('b')]))
  })

  it('still sends a publication that changed nothing, so a subscriber sees every publish', () => {
    const publisher = new ThreadChangesPublisher()
    const one = holder()
    publisher.subscribe(one.listener)
    publisher.publishSnapshots(() => host([thread('a')]))
    publisher.publishSnapshots(() => host([thread('a')]))
    expect(one.received[1]).toEqual({ sequence: 2, upserts: [], removals: [] })
  })

  it('builds each form once, and numbers each form on its own', () => {
    const publisher = new ThreadChangesPublisher()
    const events = holder(), whole = holder(), more = holder()
    publisher.subscribe(events.listener, { historyFromEvents: true })
    publisher.subscribe(more.listener, { historyFromEvents: true })
    publisher.subscribe(whole.listener)
    const view = vi.fn((historyFromEvents: boolean) => host([thread('a', { title: historyFromEvents ? 'Events' : 'Whole' })]))
    publisher.publishSnapshots(view)
    expect(view.mock.calls.map(([form]) => form).sort()).toEqual([false, true])
    expect(events.map.get('a')!.title).toBe('Events')
    expect(whole.map.get('a')!.title).toBe('Whole')
    expect(more.received[0]).toBe(events.received[0])
  })

  it('sends a late subscriber a whole publication with the next one', () => {
    const publisher = new ThreadChangesPublisher()
    const early = holder(), late = holder()
    publisher.subscribe(early.listener)
    publisher.publishSnapshots(() => host([thread('a')]))
    publisher.subscribe(late.listener)
    publisher.publishSnapshots(() => host([thread('a'), thread('b')]))
    expect(early.received[1]).toMatchObject({ sequence: 2 })
    expect(early.received[1]!.whole).toBeUndefined()
    expect(late.received).toHaveLength(1)
    expect(late.received[0]).toMatchObject({ sequence: 2, whole: true })
    expect(ids(late.map)).toEqual(['a', 'b'])
    publisher.publishSnapshots(() => host([thread('b')]))
    expect(late.received[1]).toMatchObject({ sequence: 3, removals: ['a'] })
    expect(ids(late.map)).toEqual(['b'])
  })

  it('answers a resync with a whole publication of what it last published, numbered so the next change follows', async () => {
    const publisher = new ThreadChangesPublisher()
    const one = holder()
    const subscription = publisher.subscribe(one.listener)
    publisher.publishSnapshots(() => host([thread('a')]))
    publisher.publishSnapshots(() => host([thread('a'), thread('b')]))
    subscription.resync()
    expect(one.received).toHaveLength(2)
    await Promise.resolve()
    expect(one.received[2]).toMatchObject({ sequence: 2, whole: true })
    expect(one.received[2]!.upserts.map(item => item.id)).toEqual(['a', 'b'])
    publisher.publishSnapshots(() => host([thread('b')]))
    expect(one.received[3]).toMatchObject({ sequence: 3, removals: ['a'] })
  })

  it('recovers a subscriber that missed a change through its own resync', async () => {
    const publisher = new ThreadChangesPublisher()
    const map = new ThreadMap()
    let dropping = false
    const subscription = publisher.subscribe(changes => {
      if (dropping) return
      if (map.apply(changes) === 'resync') subscription.resync()
    })
    publisher.publishSnapshots(() => host([thread('a'), thread('b')]))
    dropping = true
    publisher.publishSnapshots(() => host([thread('b')]))
    dropping = false
    publisher.publishSnapshots(() => host([thread('b'), thread('c')]))
    expect(ids(map)).toEqual(['a', 'b'])
    await Promise.resolve()
    expect(ids(map)).toEqual(['b', 'c'])
    expect(map.sequence).toBe(3)
  })

  it('sends nothing to a subscriber that left, and nothing on a resync before the first publication', async () => {
    const publisher = new ThreadChangesPublisher()
    const one = holder(), two = holder()
    const off = publisher.subscribe(one.listener)
    publisher.subscribe(two.listener).resync()
    await Promise.resolve()
    expect(two.received).toEqual([])
    off()
    publisher.publishSnapshots(() => host([thread('a')]))
    expect(one.received).toEqual([])
    expect(two.received[0]).toMatchObject({ sequence: 1, whole: true })
    expect(publisher.size).toBe(1)
  })

  it('takes changes a publisher marked itself, and wants the first one whole', () => {
    const publisher = new ThreadChangesPublisher()
    const one = holder()
    publisher.subscribe(one.listener)
    expect(() => publisher.publishChanges(() => ({ upserts: [owned('a')], removals: [] }))).toThrow(/whole/u)
    publisher.publishChanges(() => ({ whole: true, upserts: [owned('a'), owned('b')], removals: [], rest: rest() }))
    publisher.publishChanges(() => ({ upserts: [owned('c')], removals: ['a'] }))
    expect(one.received.map(changes => changes.sequence)).toEqual([1, 2])
    expect(ids(one.map)).toEqual(['b', 'c'])
  })

  it('keeps every subscriber equal to the snapshots it was built from, checked after every change', () => {
    const publisher = new ThreadChangesPublisher()
    let truth = host([])
    const one = holder(() => truth)
    publisher.subscribe(one.listener)
    const steps: AgentThread[][] = [
      [thread('a'), thread('b'), thread('c')],
      [thread('a', { status: 'running' }), thread('b'), thread('c')],
      [thread('a', { status: 'running' }), thread('c')],
      [thread('a', { status: 'running' }), thread('c'), thread('b')],
      [thread('c'), thread('a', { status: 'idle' }), thread('b')],
      [thread('c'), thread('a'), thread('b'), thread('d')],
      [thread('c'), thread('e'), thread('a'), thread('b'), thread('d')],
      [thread('d'), thread('b'), thread('a'), thread('e'), thread('c')],
      [],
      [thread('d')],
    ]
    for (const threads of steps) {
      truth = host(threads)
      publisher.publishSnapshots(() => host(threads))
    }
    expect(one.received.map(changes => changes.whole === true)).toEqual([true, false, false, false, false, false, false, true, false, false])
    expect(ids(one.map)).toEqual(['d'])
  })

  it('copies records a publisher marked itself when it does not own them, and keeps nothing the caller can still write into', () => {
    const publisher = new ThreadChangesPublisher()
    const one = holder()
    publisher.subscribe(one.listener)
    const alias = thread('a', { messages: [message('m', 'Hello')] })
    const parts: Partial<AgentHostSnapshot> = host([])
    delete parts.threads
    publisher.publishChanges(() => ({ whole: true, upserts: [alias], removals: [], rest: parts as AgentHostRest }))
    expect(one.map.get('a')).not.toBe(alias)
    alias.messages.push(message('n', 'More'))
    alias.messages[0]!.text = 'Changed'
    ;(parts as { name: string }).name = 'Changed'
    expect(one.map.get('a')!.messages).toEqual([message('m', 'Hello')])
    expect(one.map.rest!.name).toBe('Synthetic')
    // An owned record is passed on as it is.
    const b = owned('b')
    publisher.publishChanges(() => ({ upserts: [b], removals: [] }))
    expect(one.map.get('b')).toBe(b)
  })

  it('delivers a publication made from inside a listener after the one being delivered, to every subscriber in order', () => {
    const publisher = new ThreadChangesPublisher()
    let state = [thread('a')]
    const first = holder(), second = holder()
    let nested = false
    publisher.subscribe(changes => {
      first.listener(changes)
      // As a layer might: something this subscriber does makes the publisher publish again at once.
      if (!nested) { nested = true; state = [thread('a'), thread('b')]; publisher.publishSnapshots(() => host(state)) }
    })
    publisher.subscribe(second.listener)
    publisher.publishSnapshots(() => host(state))
    expect(second.received.map(changes => changes.sequence)).toEqual([1, 2])
    expect(first.received.map(changes => changes.sequence)).toEqual([1, 2])
    expect(ids(second.map)).toEqual(['a', 'b'])
    expect(second.map.sequence).toBe(2)
  })

  it('keeps delivering past a listener that throws, drains what was queued inside a listener, and throws the first failure after', () => {
    const publisher = new ThreadChangesPublisher()
    let state = [thread('a'), thread('b')]
    const first = holder(), last = holder()
    let nested = false
    publisher.subscribe(changes => {
      first.listener(changes)
      if (!nested) { nested = true; state = [thread('a'), thread('b'), thread('c')]; publisher.publishSnapshots(() => host(state)) }
    })
    publisher.subscribe(() => { throw new Error('a subscriber failed') })
    publisher.subscribe(last.listener)
    expect(() => publisher.publishSnapshots(() => host(state))).toThrow('a subscriber failed')
    // The subscriber after the one that threw still got both publications, and the queued one was not dropped.
    expect(last.received.map(changes => changes.sequence)).toEqual([1, 2])
    expect(ids(last.map)).toEqual(['a', 'b', 'c'])
    expect(ids(first.map)).toEqual(['a', 'b', 'c'])
    // The publisher is free again: the next publication goes out normally.
    state = [thread('a')]
    expect(() => publisher.publishSnapshots(() => host(state))).toThrow('a subscriber failed')
    expect(ids(last.map)).toEqual(['a'])
  })

  it('goes on numbering a form after its last subscriber left and another came', () => {
    const publisher = new ThreadChangesPublisher()
    const one = holder()
    const off = publisher.subscribe(one.listener)
    publisher.publishSnapshots(() => host([thread('a')]))
    publisher.publishSnapshots(() => host([thread('a'), thread('b')]))
    off()
    // The same subscriber comes back with the map it kept: the whole publication it is sent is newer, never older.
    publisher.subscribe(one.listener)
    publisher.publishSnapshots(() => host([thread('b')]))
    expect(one.received.at(-1)).toMatchObject({ sequence: 3, whole: true })
    expect(ids(one.map)).toEqual(['b'])
  })
})
