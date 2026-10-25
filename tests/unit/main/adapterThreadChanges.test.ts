// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { AdapterThreadChanges, restOf } from '../../../src/main/agents/adapterThreadChanges'
import { ThreadMap, threadMapDifferences, type AgentHostChanges } from '../../../src/main/agents/threadChanges'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'

const thread = (id: string, fields: Partial<AgentThread> = {}): AgentThread => ({ id, projectId: 'project', title: `Thread ${id}`, modelId: 'model',
  status: 'idle', messages: [], requests: [], ...fields })

/**
 * An adapter as the real ones are built: thread records it writes into in place, in the order they were added, and an
 * activity view that builds a new record for each thread on every read. `marking` gives the changes `thread` and `rest`.
 */
class Adapter {
  readonly threads = new Map<string, AgentThread>()
  readonly state: AgentHostSnapshot = { ...structuredClone(EMPTY_AGENT_HOST), name: 'Synthetic', connected: true }
  views = 0
  readonly changes: AdapterThreadChanges
  constructor(marking: boolean) {
    this.changes = new AdapterThreadChanges({
      view: historyFromEvents => { this.views++; return { ...this.state, threads: [...this.threads.values()].map(item => this.shown(item, historyFromEvents)) } },
      ...(marking ? {
        thread: (id: string, historyFromEvents: boolean) => { const item = this.threads.get(id); return item && this.shown(item, historyFromEvents) },
        rest: () => restOf(this.state),
      } : {}),
    })
  }
  add(id: string, fields: Partial<AgentThread> = {}): void { this.threads.set(id, thread(id, fields)); this.changes.mark(id) }
  set(id: string, fields: Partial<AgentThread>): void { Object.assign(this.threads.get(id)!, fields); this.changes.mark(id) }
  remove(id: string): void { this.threads.delete(id); this.changes.mark(id) }
  whole(historyFromEvents = false): AgentHostSnapshot { return { ...this.state, threads: [...this.threads.values()].map(item => this.shown(item, historyFromEvents)) } }
  private shown(item: AgentThread, historyFromEvents: boolean): AgentThread {
    return historyFromEvents ? { ...item, messages: [], summary: { messageCount: item.messages.length, activityCount: 0 } } : { ...item, messages: item.messages.map(message => ({ ...message })) }
  }
}

/** A subscriber holding a thread map checked against the adapter's whole view after every publication. */
function subscriber(adapter: Adapter, historyFromEvents = false, verify = true) {
  const map = new ThreadMap({ wholeOf: () => adapter.whole(historyFromEvents), verify })
  const received: AgentHostChanges[] = []
  const off = adapter.changes.subscribeActivityChanges(changes => {
    received.push(changes)
    if (map.apply(changes) === 'resync') off.resync()
  }, { historyFromEvents })
  return { map, received, off, last: () => received.at(-1)!, upserted: () => received.at(-1)!.upserts.map(record => record.id) }
}

describe.each([['the shim', false], ['marking', true]] as const)('an adapter\'s thread changes through %s', (_name, marking) => {
  it('publishes a whole first publication, then each change, a new thread and a removal, keeping the map equal to the view', () => {
    const adapter = new Adapter(marking)
    adapter.add('a'); adapter.add('b'); adapter.add('c')
    const one = subscriber(adapter)
    adapter.changes.publish()
    expect(one.last()).toMatchObject({ sequence: 1, whole: true })
    expect([...one.map.ids()]).toEqual(['a', 'b', 'c'])
    adapter.set('b', { status: 'running' })
    adapter.changes.publish()
    expect(one.last().whole).toBeUndefined()
    expect(one.upserted()).toEqual(['b'])
    adapter.add('d')
    adapter.changes.publish()
    expect(one.upserted()).toEqual(['d'])
    adapter.remove('a')
    adapter.changes.publish()
    expect(one.last()).toMatchObject({ upserts: [], removals: ['a'] })
    expect([...one.map.ids()]).toEqual(['b', 'c', 'd'])
    // Nothing changed: the publication still goes out, carrying nothing.
    adapter.changes.publish()
    expect(one.last()).toMatchObject({ sequence: 5, upserts: [], removals: [] })
    expect(one.last().rest).toBeUndefined()
  })

  it('carries the rest only when it changed', () => {
    const adapter = new Adapter(marking)
    adapter.add('a')
    const one = subscriber(adapter)
    adapter.changes.publish()
    adapter.state.error = 'Synthetic failure'
    adapter.changes.publish()
    expect(one.last().rest?.error).toBe('Synthetic failure')
    adapter.changes.publish()
    expect(one.last().rest).toBeUndefined()
  })

  it('keeps both forms of the view, each with its own numbering and its own changes', () => {
    const adapter = new Adapter(marking)
    adapter.add('a'); adapter.add('b')
    const full = subscriber(adapter, false), fromEvents = subscriber(adapter, true)
    adapter.changes.publish()
    adapter.set('a', { messages: [{ id: 'm', role: 'user', text: 'Synthetic', createdAt: '2026-10-24T00:00:00.000Z' }] })
    adapter.changes.publish()
    expect(full.upserted()).toEqual(['a'])
    expect(fromEvents.upserted()).toEqual(['a'])
    expect(full.map.get('a')!.messages).toHaveLength(1)
    expect(fromEvents.map.get('a')!.messages).toHaveLength(0)
    expect(fromEvents.map.get('a')!.summary).toEqual({ messageCount: 1, activityCount: 0 })
  })

  it('delivers a thread marked from inside a listener exactly once, in the publication built after it (#925)', () => {
    const adapter = new Adapter(marking)
    adapter.add('a'); adapter.add('b')
    const map = new ThreadMap({ wholeOf: () => adapter.whole(), verify: true })
    const received: AgentHostChanges[] = []
    let reacted = false
    adapter.changes.subscribeActivityChanges(changes => {
      received.push(changes)
      map.apply(changes)
      // As a layer above might: what this subscriber does changes another thread and publishes at once.
      if (!changes.whole && !reacted) { reacted = true; adapter.set('b', { status: 'running' }); adapter.changes.publish() }
    })
    // Checked at the end rather than after every publication: it is handed the first change after the state moved on.
    const second = subscriber(adapter, false, false)
    adapter.changes.publish()
    adapter.set('a', { title: 'Renamed' })
    adapter.changes.publish()
    const carried = (id: string) => received.filter(changes => !changes.whole && changes.upserts.some(record => record.id === id)).length
    expect(carried('a')).toBe(1)
    expect(carried('b')).toBe(1)
    expect(received.map(changes => changes.sequence)).toEqual([1, 2, 3])
    // The other subscriber was handed both, in order, after the first.
    expect(second.received.map(changes => changes.sequence)).toEqual([1, 2, 3])
    expect(second.map.get('b')!.status).toBe('running')
    // A change marked after a build went out is in the next one, not lost.
    adapter.set('a', { status: 'running' })
    adapter.changes.publish()
    expect(second.upserted()).toEqual(['a'])
    expect(threadMapDifferences(second.map, adapter.whole())).toEqual([])
  })

  it('stays correct when a resync listener marks and publishes from inside it', async () => {
    const adapter = new Adapter(marking)
    adapter.add('a'); adapter.add('b')
    const map = new ThreadMap({ wholeOf: () => adapter.whole(), verify: true })
    let asked = false, resynced = false
    const off = adapter.changes.subscribeActivityChanges(changes => {
      const applied = map.apply(changes)
      if (applied === 'resync') off.resync()
      if (changes.whole && asked && !resynced) { resynced = true; adapter.set('a', { status: 'error' }); adapter.changes.publish() }
    })
    adapter.changes.publish()
    asked = true
    off.resync()
    await Promise.resolve()
    expect(resynced).toBe(true)
    expect(map.get('a')!.status).toBe('error')
    adapter.set('b', { status: 'running' })
    adapter.changes.publish()
    expect(map.get('b')!.status).toBe('running')
  })
})

describe('an adapter that marks its own thread changes', () => {
  it('reads only the threads it marked, and never the whole view after the first publication', () => {
    const adapter = new Adapter(true)
    for (let index = 0; index < 50; index++) adapter.add(`t${index}`)
    const one = subscriber(adapter)
    adapter.changes.publish()
    const views = adapter.views
    adapter.set('t7', { status: 'running' })
    adapter.changes.publish()
    expect(adapter.views).toBe(views)
    expect(one.upserted()).toEqual(['t7'])
  })

  it('leaves out a thread it marked that did not change', () => {
    const adapter = new Adapter(true)
    adapter.add('a'); adapter.add('b')
    const one = subscriber(adapter)
    adapter.changes.publish()
    adapter.changes.mark('a'); adapter.set('b', { status: 'running' })
    adapter.changes.publish()
    expect(one.upserted()).toEqual(['b'])
  })

  it('does not send a change nobody marked, which is why every path that changes a thread marks it', () => {
    const adapter = new Adapter(true)
    adapter.add('a')
    subscriber(adapter)
    adapter.changes.publish()
    adapter.threads.get('a')!.status = 'running'
    expect(() => adapter.changes.publish()).toThrow(/stale record/u)
  })

  it('works out a publication bringing several new threads, and one after markAll, whole, in the view\'s order', () => {
    const adapter = new Adapter(true)
    adapter.add('a')
    const one = subscriber(adapter)
    adapter.changes.publish()
    // Marked in another order than they were added.
    adapter.threads.set('b', thread('b')); adapter.threads.set('c', thread('c'))
    adapter.changes.mark('c'); adapter.changes.mark('b')
    adapter.changes.publish()
    expect([...one.map.ids()]).toEqual(['a', 'b', 'c'])
    // A connection rebuilds the threads in another order, without one of them.
    adapter.threads.clear()
    adapter.threads.set('c', thread('c')); adapter.threads.set('a', thread('a', { status: 'running' }))
    adapter.changes.markAll()
    adapter.changes.publish()
    expect(one.last().removals).toEqual(['b'])
    expect([...one.map.ids()]).toEqual(['c', 'a'])
  })

  it('starts a form someone subscribes to later from a whole publication', () => {
    const adapter = new Adapter(true)
    adapter.add('a')
    const full = subscriber(adapter)
    adapter.changes.publish()
    adapter.set('a', { status: 'running' })
    adapter.changes.publish()
    const fromEvents = subscriber(adapter, true)
    adapter.add('b')
    adapter.changes.publish()
    expect(fromEvents.last()).toMatchObject({ sequence: 1, whole: true })
    expect([...fromEvents.map.ids()]).toEqual(['a', 'b'])
    expect(full.upserted()).toEqual(['b'])
  })
})
