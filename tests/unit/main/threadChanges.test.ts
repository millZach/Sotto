// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { immutableActivities } from '../../../src/main/agents/activitySnapshots'
import { ThreadChangesPublisher, ThreadMap, threadChangesBetween, threadMapDifferences, type AgentHostChanges, type AgentHostRest } from '../../../src/main/agents/threadChanges'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'

const thread = (id: string, fields: Partial<AgentThread> = {}): AgentThread => ({ id, projectId: 'project', title: `Thread ${id}`, modelId: 'model',
  status: 'idle', messages: [], requests: [], ...fields })
const host = (threads: AgentThread[], fields: Partial<AgentHostSnapshot> = {}): AgentHostSnapshot => ({ ...structuredClone(EMPTY_AGENT_HOST), connected: true,
  name: 'Synthetic', threads, ...fields })
/** A frozen record, as a publisher hands one out. */
const frozen = (id: string, fields: Partial<AgentThread> = {}): AgentThread => Object.freeze(thread(id, fields))
const rest = (fields: Partial<AgentHostSnapshot> = {}): AgentHostRest => {
  const parts: Partial<AgentHostSnapshot> = host([], fields)
  delete parts.threads
  return Object.freeze(parts as AgentHostRest)
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
    expect(map.apply({ sequence: 1, upserts: [frozen('a')], removals: [] })).toBe('resync')
    expect(map.sequence).toBeUndefined()
    expect(map.size).toBe(0)
    expect(map.snapshot()).toBeUndefined()
  })

  it('takes the order, the records and the rest a whole publication gives', () => {
    const a = frozen('a'), b = frozen('b'), c = frozen('c')
    const map = started([c, a, b], 7)
    expect(ids(map)).toEqual(['c', 'a', 'b'])
    expect(map.get('a')).toBe(a)
    expect(map.sequence).toBe(7)
    expect(map.snapshot()).toEqual(host([c, a, b]))
  })

  it('keeps an upserted thread where it was and appends a new one', () => {
    const map = started([frozen('a'), frozen('b'), frozen('c')])
    const b = frozen('b', { status: 'running' }), d = frozen('d')
    expect(map.apply({ sequence: 2, upserts: [d, b], removals: [] })).toBe('applied')
    expect(ids(map)).toEqual(['a', 'b', 'c', 'd'])
    expect(map.get('b')).toBe(b)
    expect(map.sequence).toBe(2)
  })

  it('drops a removed thread, and appends it when it comes back', () => {
    const map = started([frozen('a'), frozen('b'), frozen('c')])
    expect(map.apply({ sequence: 2, upserts: [], removals: ['a'] })).toBe('applied')
    expect(ids(map)).toEqual(['b', 'c'])
    expect(map.has('a')).toBe(false)
    expect(map.apply({ sequence: 3, upserts: [frozen('a')], removals: [] })).toBe('applied')
    expect(ids(map)).toEqual(['b', 'c', 'a'])
  })

  it('applies removals before upserts in one change', () => {
    const map = started([frozen('a'), frozen('b')])
    const a = frozen('a', { title: 'Back' })
    expect(map.apply({ sequence: 2, upserts: [a], removals: ['a'] })).toBe('applied')
    expect(ids(map)).toEqual(['b', 'a'])
    expect(map.get('a')).toBe(a)
  })

  it('asks for a resync on a gap or a repeated sequence, and changes nothing', () => {
    const map = started([frozen('a')], 4)
    expect(map.apply({ sequence: 6, upserts: [frozen('b')], removals: [] })).toBe('resync')
    expect(map.apply({ sequence: 4, upserts: [frozen('b')], removals: ['a'] })).toBe('resync')
    expect(ids(map)).toEqual(['a'])
    expect(map.sequence).toBe(4)
    // A whole publication after the gap starts the map again, whatever its sequence.
    expect(map.apply({ sequence: 9, whole: true, upserts: [frozen('b'), frozen('a')], removals: [], rest: rest() })).toBe('applied')
    expect(ids(map)).toEqual(['b', 'a'])
    expect(map.apply({ sequence: 10, upserts: [], removals: ['b'] })).toBe('applied')
    expect(ids(map)).toEqual(['a'])
  })

  it('takes a new order from a whole publication that reorders', () => {
    const a = frozen('a'), b = frozen('b'), c = frozen('c')
    const map = started([a, b, c])
    expect(map.apply({ sequence: 2, whole: true, upserts: [c, a], removals: [], rest: rest() })).toBe('applied')
    expect(ids(map)).toEqual(['c', 'a'])
    expect(map.get('c')).toBe(c)
    expect(map.has('b')).toBe(false)
  })

  it('takes the parts that are not threads alone, keeping every thread', () => {
    const a = frozen('a')
    const map = started([a])
    const next = rest({ error: 'Provider connection failed.', connected: false })
    expect(map.apply({ sequence: 2, upserts: [], removals: [], rest: next })).toBe('applied')
    expect(map.rest).toBe(next)
    expect(map.get('a')).toBe(a)
    expect(map.snapshot()).toMatchObject({ connected: false, error: 'Provider connection failed.', threads: [a] })
  })

  it('refuses a record that is not frozen, and applies none of the change', () => {
    const map = started([frozen('a')])
    expect(() => map.apply({ sequence: 2, upserts: [frozen('b'), thread('c')], removals: ['a'] })).toThrow(TypeError)
    expect(() => map.apply({ sequence: 2, upserts: [], removals: [], rest: { ...rest() } })).toThrow(TypeError)
    expect(ids(map)).toEqual(['a'])
    expect(map.sequence).toBe(1)
  })

  it('refuses a whole publication without the rest of the snapshot', () => {
    expect(() => new ThreadMap().apply({ sequence: 1, whole: true, upserts: [], removals: [] })).toThrow(TypeError)
  })

  it('hands out frozen records, and a snapshot of its own that any caller may change', () => {
    const map = started([frozen('a', { messages: [{ id: 'm', role: 'user', text: 'Hello', createdAt: '2026-10-24T00:00:00.000Z' }] })])
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
    const map = started([frozen('a'), frozen('b')])
    expect(threadMapDifferences(map, host([thread('a'), thread('b')]))).toEqual([])
  })

  it('names a missed removal, a missed upsert, a stale record, the wrong order and other parts that differ', () => {
    const map = started([frozen('a'), frozen('b'), frozen('c')])
    expect(threadMapDifferences(map, host([thread('a'), thread('b')]))).toEqual([expect.stringMatching(/thread "c" .*missed removal/u)])
    expect(threadMapDifferences(map, host([thread('a'), thread('b'), thread('c'), thread('d')]))).toEqual([expect.stringMatching(/thread "d" .*missed upsert/u)])
    expect(threadMapDifferences(map, host([thread('a'), thread('b', { status: 'running' }), thread('c')]))).toEqual([expect.stringMatching(/thread "b" .*stale/u)])
    expect(threadMapDifferences(map, host([thread('b'), thread('a'), thread('c')]))).toEqual([expect.stringMatching(/order/u)])
    expect(threadMapDifferences(map, host([thread('a'), thread('b'), thread('c')], { connected: false }))).toEqual([expect.stringMatching(/rest/u)])
  })

  it('in verifying mode, fails a change that leaves the map unlike the whole snapshot', () => {
    let truth = host([thread('a'), thread('b')])
    const map = new ThreadMap({ wholeOf: () => truth, verify: true })
    expect(map.apply({ sequence: 1, whole: true, upserts: [frozen('a'), frozen('b')], removals: [], rest: rest() })).toBe('applied')
    // The publisher removed b, but the change it sent forgot to say so.
    truth = host([thread('a', { status: 'running' })])
    expect(() => map.apply({ sequence: 2, upserts: [frozen('a', { status: 'running' })], removals: [] })).toThrow(/thread "b" is in the map but not the snapshot/u)
  })

  it('in verifying mode, fails a stale record and a wrong order', () => {
    let truth = host([thread('a'), thread('b')])
    const stale = new ThreadMap({ wholeOf: () => truth, verify: true })
    stale.apply({ sequence: 1, whole: true, upserts: [frozen('a'), frozen('b')], removals: [], rest: rest() })
    truth = host([thread('a', { title: 'Renamed' }), thread('b')])
    expect(() => stale.apply({ sequence: 2, upserts: [], removals: [] })).toThrow(/thread "a" is unlike/u)

    truth = host([thread('a'), thread('b')])
    const order = new ThreadMap({ wholeOf: () => truth, verify: true })
    order.apply({ sequence: 1, whole: true, upserts: [frozen('a'), frozen('b')], removals: [], rest: rest() })
    truth = host([thread('c'), thread('a'), thread('b')])
    // A thread that goes first can only come in a whole publication; an upsert appends it.
    expect(() => order.apply({ sequence: 2, upserts: [frozen('c')], removals: [] })).toThrow(/order/u)
  })

  it('checks nothing unless verifying is on', () => {
    const wholeOf = vi.fn(() => host([]))
    const map = new ThreadMap({ wholeOf, verify: false })
    map.apply({ sequence: 1, whole: true, upserts: [frozen('a')], removals: [], rest: rest() })
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

  it('sends a whole publication when the order changed some other way', () => {
    const { map } = published(host([thread('a'), thread('b'), thread('c')]))
    const a = map.get('a')!, c = map.get('c')!
    const moved = threadChangesBetween(map, host([thread('c'), thread('a'), thread('b')]))
    expect(moved.whole).toBe(true)
    expect(moved.upserts.map(item => item.id)).toEqual(['c', 'a', 'b'])
    // A thread that did not change is still the record published last.
    expect(moved.upserts[0]).toBe(c)
    expect(moved.upserts[1]).toBe(a)
    const inserted = threadChangesBetween(map, host([thread('a'), thread('new'), thread('b'), thread('c')]))
    expect(inserted.whole).toBe(true)
    expect(inserted.upserts.map(item => item.id)).toEqual(['a', 'new', 'b', 'c'])
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
    expect(() => publisher.publishChanges(() => ({ upserts: [frozen('a')], removals: [] }))).toThrow(/whole/u)
    publisher.publishChanges(() => ({ whole: true, upserts: [frozen('a'), frozen('b')], removals: [], rest: rest() }))
    publisher.publishChanges(() => ({ upserts: [frozen('c')], removals: ['a'] }))
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
      [],
      [thread('d')],
    ]
    for (const threads of steps) {
      truth = host(threads)
      publisher.publishSnapshots(() => host(threads))
    }
    expect(one.received.map(changes => changes.whole === true)).toEqual([true, false, false, false, true, false, false, false])
    expect(ids(one.map)).toEqual(['d'])
  })
})
