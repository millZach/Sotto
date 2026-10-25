// @vitest-environment node
/**
 * The host-level contract for thread changes (ADR-0016, #925), as `tests/integration/adapterContract.ts` holds every
 * adapter to it: the Sotto identity wrapper and the provider switch each pass on a thread's state change as an upsert under
 * the IDs that layer gives it, a thread that went as a removal, and a thread that came mid-list as a placement, and a
 * subscriber's thread map stays equal to the layer's own activity snapshot after every publication (the verifying mode).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { immutableRecord } from '../../../src/main/agents/activitySnapshots'
import { restOf } from '../../../src/main/agents/adapterThreadChanges'
import type { AgentHost } from '../../../src/main/agents/host'
import { ConfiguredProviderHost, providerEntityId } from '../../../src/main/agents/providerSwitch'
import { ThreadMap, threadMapDifferences, type ActivityChangesListener, type AgentHostChanges } from '../../../src/main/agents/threadChanges'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread, type ProviderId } from '../../../src/shared/agents'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import { StreamingAdapter } from '../../fixtures/streamingAdapter'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const thread = (id: string, fields: Partial<AgentThread> = {}): AgentThread => ({ id, projectId: 'project', title: `Thread ${id}`, modelId: 'fake:model',
  status: 'idle', messages: [], requests: [], ...fields })
function state(sessions: readonly string[]): AgentHostSnapshot {
  return { ...structuredClone(EMPTY_AGENT_HOST), name: 'Synthetic', version: '1', connected: true,
    capabilities: { ...EMPTY_AGENT_HOST.capabilities, threads: true, submit: true, projects: true },
    projects: [{ id: 'project', title: 'Synthetic project', path: 'C:/sotto-synthetic' }],
    models: [{ id: 'fake:model', provider: 'Fake', name: 'Synthetic model', ready: true }],
    threads: sessions.map(id => thread(id, { usage: { latest: { input: 1, output: 1, cached: 0 }, total: { input: 1, output: 1, cached: 0 }, modelId: 'fake:model' } as AgentThread['usage'] })) }
}

async function registryIn(load = true): Promise<ThreadRegistry> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-host-changes-'))
  const registry = new ThreadRegistry(root)
  if (load) await registry.load()
  cleanup.push(async () => { await registry.flush().catch(() => undefined); await rm(root, { recursive: true, force: true }) })
  return registry
}

/**
 * A subscriber to a host's thread changes holding a thread map, checked after every publication against the host's
 * activity snapshot of the same form from the same publish, which reaches its subscribers first.
 */
function watch(host: AgentHost, historyFromEvents = true, onChanges?: (changes: AgentHostChanges) => void) {
  let latest: AgentHostSnapshot | undefined
  const offSnapshots = host.subscribeActivitySnapshots!(snapshot => { latest = snapshot }, { historyFromEvents })
  const map = new ThreadMap({ wholeOf: () => latest!, verify: true })
  const received: AgentHostChanges[] = []
  const drift: string[] = []
  const subscription = host.subscribeActivityChanges!(changes => {
    received.push(changes)
    try { if (map.apply(changes) === 'resync') subscription.resync() }
    catch (error) { drift.push(error instanceof Error ? error.message : String(error)) }
    onChanges?.(changes)
  }, { historyFromEvents })
  cleanup.push(() => {
    subscription(); offSnapshots()
    expect(drift, 'A thread map fed this host\'s thread changes came to differ from its activity snapshot.').toEqual([])
  })
  return { map, received, drift, latest: () => latest!, last: () => received.at(-1)!, ids: () => [...map.ids()] }
}

describe('the Sotto identity wrapper\'s thread changes', () => {
  async function wrapped(load = true) {
    const registry = await registryIn(load)
    const adapter = new StreamingAdapter(state(['s1', 's2', 's3']))
    const host = new SottoThreadHost('claude', adapter, registry)
    const sotto = (session: string): string => registry.bySession('claude', session)!.threadId
    return { registry, adapter, host, sotto }
  }

  it('publishes each state change as an upsert under its Sotto thread ID, and a removal under it too', async () => {
    const { adapter, host, sotto } = await wrapped()
    const one = watch(host)
    adapter.emit()
    expect(one.last()).toMatchObject({ sequence: 1, whole: true })
    expect(one.ids()).toEqual(['s1', 's2', 's3'].map(sotto))
    expect(one.ids()).not.toContain('s1')
    const untouched = one.map.get(sotto('s1'))
    adapter.state.threads[1]!.status = 'running'; adapter.mark('s2'); adapter.publish(false)
    expect(one.last().whole).toBeUndefined()
    expect(one.last().upserts.map(record => [record.id, record.status])).toEqual([[sotto('s2'), 'running']])
    expect(one.last().removals).toEqual([])
    expect(one.map.get(sotto('s1'))).toBe(untouched)
    const removed = sotto('s3')
    adapter.state.threads.splice(2, 1); adapter.mark('s3'); adapter.publish(false)
    expect(one.last()).toMatchObject({ upserts: [], removals: [removed] })
    expect(one.ids()).toEqual([sotto('s1'), sotto('s2')])
  })

  it('maps a thread that moved to a placement naming Sotto\'s IDs', async () => {
    const { adapter, host, sotto } = await wrapped()
    const one = watch(host)
    adapter.emit()
    adapter.state.threads.unshift(adapter.state.threads.pop()!); adapter.emit()
    expect(one.last().placements).toEqual([{ id: sotto('s3'), beforeId: sotto('s1') }])
    expect(one.ids()).toEqual(['s3', 's1', 's2'].map(sotto))
  })

  it('hands on nothing before the durable bindings load, and a whole publication first after they do', async () => {
    const { registry, adapter, host, sotto } = await wrapped(false)
    const one = watch(host)
    adapter.emit()
    adapter.state.threads[0]!.status = 'running'; adapter.mark('s1'); adapter.publish(false)
    expect(one.received).toEqual([])
    await registry.load()
    adapter.state.threads[1]!.status = 'running'; adapter.mark('s2'); adapter.publish(false)
    expect(one.received).toHaveLength(1)
    expect(one.last()).toMatchObject({ whole: true })
    expect(one.last().upserts.map(record => [record.id, record.status])).toEqual([[sotto('s1'), 'running'], [sotto('s2'), 'running'], [sotto('s3'), 'idle']])
  })

  it('answers a resync with a whole publication of what it published', async () => {
    const { adapter, host, sotto } = await wrapped()
    const one = watch(host)
    adapter.emit()
    const late: AgentHostChanges[] = []
    const subscription = host.subscribeActivityChanges!(changes => {
      late.push(changes)
      // A subscriber that missed a publication asks for a whole one from inside its listener.
      if (late.length === 2) subscription.resync()
    }, { historyFromEvents: true })
    cleanup.push(() => subscription())
    adapter.state.threads[0]!.title = 'Renamed'; adapter.mark('s1'); adapter.publish(false)
    adapter.state.threads[0]!.title = 'Renamed again'; adapter.mark('s1'); adapter.publish(false)
    await Promise.resolve()
    expect(late.map(changes => [changes.sequence, changes.whole === true])).toEqual([[2, true], [3, false], [3, true]])
    expect(late[2]!.upserts.map(record => record.id)).toEqual(one.ids())
    expect(late[2]!.upserts[0]).toMatchObject({ id: sotto('s1'), title: 'Renamed again' })
  })

  /** An inner host whose thread changes this test publishes by hand, delivered as it says. */
  function scripted() {
    const listeners = new Set<ActivityChangesListener>()
    let sequence = 0
    const rest = immutableRecord(restOf({ ...state([]), threads: [] }))
    const inner = Object.assign(new FakeProviderHost(state([])), {
      subscribeActivityChanges: (listener: ActivityChangesListener) => {
        listeners.add(listener)
        const off = Object.assign(() => { listeners.delete(listener) }, { resync: () => undefined })
        return off
      },
    })
    const send = (changes: Omit<AgentHostChanges, 'sequence' | 'rest'> & { rest?: AgentHostChanges['rest'] }) => {
      const numbered: AgentHostChanges = { ...changes, ...(changes.whole ? { rest } : {}), sequence: ++sequence }
      for (const listener of [...listeners]) listener(numbered)
    }
    return { inner, send }
  }

  it('hands a record handed on before out again as the same record', async () => {
    const registry = await registryIn()
    const { inner, send } = scripted()
    const host = new SottoThreadHost('claude', inner, registry)
    const records = ['s1', 's2'].map(id => immutableRecord(thread(id)))
    const received: AgentHostChanges[] = []
    const map = new ThreadMap({ verify: false })
    const off = host.subscribeActivityChanges!(changes => { received.push(changes); map.apply(changes) }, { historyFromEvents: true })
    cleanup.push(() => off())
    send({ whole: true, upserts: records, removals: [] })
    const first = map.threads()
    send({ whole: true, upserts: records, removals: [] })
    expect(map.threads()).toEqual(first)
    first.forEach((record, index) => expect(map.threads()[index]).toBe(record))
  })

  it('carries every publication the adapter delivered while one of its own was being delivered, once each', async () => {
    const registry = await registryIn()
    const { inner, send } = scripted()
    const host = new SottoThreadHost('claude', inner, registry)
    const records = ['s1', 's2'].map(id => immutableRecord(thread(id)))
    const map = new ThreadMap({ verify: false })
    let reentered = false
    const received: AgentHostChanges[] = []
    const off = host.subscribeActivityChanges!(changes => {
      received.push(changes)
      expect(map.apply(changes)).toBe('applied')
      if (reentered) return
      reentered = true
      // Two more publications from inside this listener: one changes s1, the next adds s3 and removes s2.
      send({ upserts: [immutableRecord(thread('s1', { status: 'running' }))], removals: [] })
      send({ upserts: [immutableRecord(thread('s3'))], removals: ['s2'] })
    }, { historyFromEvents: true })
    cleanup.push(() => off())
    send({ whole: true, upserts: records, removals: [] })
    const sotto = (session: string): string => registry.bySession('claude', session)!.threadId
    expect(map.threads().map(record => [record.id, record.status])).toEqual([[sotto('s1'), 'running'], [sotto('s3'), 'idle']])
    expect(received.map(changes => changes.sequence)).toEqual([1, 2, 3])
    // Both waiting publications built in the first of the two queued builds; the second found nothing left to carry.
    expect(received[2]).toMatchObject({ upserts: [], removals: [] })
  })
})

describe('the provider switch\'s thread changes', () => {
  async function switched() {
    const registry = await registryIn()
    const codex = new StreamingAdapter(state(['c1', 'c2']))
    const claude = new StreamingAdapter(state(['a1', 'a2', 'a3']))
    // A host with no thread changes, reached through the shim.
    const grok = new FakeProviderHost()
    const host = new ConfiguredProviderHost({ provider: () => 'claude', enabledProviders: () => ['codex', 'claude', 'grok'], threadProvider: id => registry.byThread(id)?.provider,
      hosts: { codex: new SottoThreadHost('codex', codex, registry), claude: new SottoThreadHost('claude', claude, registry), grok,
        devin: new FakeProviderHost(), muse: new FakeProviderHost(), opencode: new FakeProviderHost(), cursor: new FakeProviderHost() } })
    cleanup.push(() => host.disconnect())
    await host.connect()
    const sotto = (provider: ProviderId, session: string): string => registry.bySession(provider, session)!.threadId
    return { registry, codex, claude, grok, host, sotto }
  }

  it('publishes a state change as an upsert named for its provider, and a removal under its Sotto thread ID', async () => {
    const { claude, codex, host, sotto } = await switched()
    const one = watch(host)
    codex.emit()
    expect(one.received[0]?.whole).toBe(true)
    claude.emit()
    expect(one.ids()).toEqual([sotto('codex', 'c1'), sotto('codex', 'c2'), sotto('claude', 'a1'), sotto('claude', 'a2'), sotto('claude', 'a3'), 'session-workshop', 'session-docs'])
    claude.state.threads[0]!.status = 'running'; claude.mark('a1'); claude.publish(false)
    const [upsert] = one.last().upserts
    expect(one.last().upserts).toHaveLength(1)
    expect(upsert).toMatchObject({ id: sotto('claude', 'a1'), status: 'running', providerId: 'claude', projectId: 'project',
      modelId: providerEntityId('claude', 'model', 'fake:model'), usage: { modelId: providerEntityId('claude', 'model', 'fake:model') } })
    codex.state.threads[1]!.title = 'Renamed'; codex.mark('c2'); codex.publish(false)
    expect(one.last().upserts).toEqual([expect.objectContaining({ id: sotto('codex', 'c2'), title: 'Renamed', providerId: 'codex', projectId: providerEntityId('codex', 'project', 'project') })])
    const gone = sotto('claude', 'a2')
    claude.state.threads.splice(1, 1); claude.mark('a2'); claude.publish(false)
    expect(one.last()).toMatchObject({ upserts: [], removals: [gone] })
    expect(one.map.has(gone)).toBe(false)
  })

  it('places a thread that came mid-list just before the next provider\'s first thread, not in a whole publication', async () => {
    const { claude, codex, host, sotto } = await switched()
    const one = watch(host)
    codex.emit(); claude.emit()
    codex.state.threads.push(thread('c3')); codex.mark('c3'); codex.publish(false)
    expect(one.last().whole).toBeUndefined()
    expect(one.last().upserts.map(record => record.id)).toEqual([sotto('codex', 'c3')])
    expect(one.last().placements).toEqual([{ id: sotto('codex', 'c3'), beforeId: sotto('claude', 'a1') }])
    expect(one.ids().slice(0, 4)).toEqual([sotto('codex', 'c1'), sotto('codex', 'c2'), sotto('codex', 'c3'), sotto('claude', 'a1')])
    // The last provider with threads has nothing after it, so its new thread goes last.
    claude.state.threads.push(thread('a4')); claude.mark('a4'); claude.publish(false)
    expect(one.last().placements).toEqual([{ id: sotto('claude', 'a4'), beforeId: 'session-workshop' }])
  })

  it('works out a host with no thread changes through the shim', async () => {
    const { claude, codex, grok, host } = await switched()
    const one = watch(host)
    codex.emit(); claude.emit()
    grok.state.threads[0]!.title = 'Renamed'; grok.emit()
    expect(one.last().upserts).toEqual([expect.objectContaining({ id: 'session-workshop', title: 'Renamed', providerId: 'grok' })])
    grok.state.threads.pop(); grok.emit()
    expect(one.last()).toMatchObject({ upserts: [], removals: ['session-docs'] })
  })

  it('carries a connection or catalog change as the rest, and removes the threads a disconnection drops', async () => {
    const { claude, codex, host, sotto } = await switched()
    const one = watch(host)
    codex.emit(); claude.emit()
    claude.state.models = [...claude.state.models, { id: 'fake:second', provider: 'Fake', name: 'Second model', ready: true }]
    claude.publish(false)
    expect(one.last()).toMatchObject({ upserts: [], removals: [] })
    expect(one.last().rest?.models.map(model => model.id)).toContain(providerEntityId('claude', 'model', 'fake:second'))
    // A provider that disconnects naming fewer threads drops the others, as its snapshot would.
    const kept = sotto('claude', 'a1'), dropped = [sotto('claude', 'a2'), sotto('claude', 'a3')]
    claude.state.connected = false; claude.state.threads.splice(1); claude.emit()
    expect([...one.last().removals].sort()).toEqual([...dropped].sort())
    expect(one.last().rest?.providers.find(provider => provider.id === 'claude')?.connection).not.toBe('connected')
    expect(one.map.has(kept)).toBe(true)
    // One that names none keeps what it had, as its snapshot does.
    claude.state.threads.splice(0); claude.emit()
    expect(one.last().removals).toEqual([])
    expect(one.map.has(kept)).toBe(true)
  })

  it('carries a disconnection the switch makes as the rest, keeping the provider\'s threads as its snapshot does', async () => {
    const { claude, codex, host, sotto } = await switched()
    const one = watch(host)
    codex.emit(); claude.emit()
    host.disconnect('claude')
    expect(one.last()).toMatchObject({ upserts: [], removals: [] })
    expect(one.last().rest?.providers.find(provider => provider.id === 'claude')?.connection).toBe('disconnected')
    expect(one.map.has(sotto('claude', 'a1'))).toBe(true)
    await host.connect('claude')
    expect(one.last().rest?.providers.find(provider => provider.id === 'claude')?.connection).toBe('connected')
  })

  it('keeps a read\'s threads until the next publication replaces them, as its snapshot does', async () => {
    const { claude, codex, host, sotto } = await switched()
    const one = watch(host)
    codex.emit(); claude.emit()
    // A change the adapter has not published yet reaches the switch by a read, and then by the publication.
    claude.state.threads[2]!.status = 'running'; claude.mark('a3')
    await host.snapshot()
    expect(one.map.get(sotto('claude', 'a3'))?.status).toBe('running')
    claude.state.threads[0]!.title = 'Renamed'; claude.mark('a1'); claude.publish(false)
    expect(one.map.get(sotto('claude', 'a1'))?.title).toBe('Renamed')
    expect(threadMapDifferences(one.map, one.latest())).toEqual([])
  })

  it('builds each publication once every subscriber has the last, carrying every change made from inside a listener once', async () => {
    const { claude, codex, host, sotto } = await switched()
    let reentered = false
    const one = watch(host, true, changes => {
      if (reentered || changes.whole) return
      reentered = true
      claude.state.threads[1]!.status = 'running'; claude.mark('a2'); claude.publish(false)
    })
    codex.emit(); claude.emit()
    claude.state.threads[0]!.status = 'running'; claude.mark('a1'); claude.publish(false)
    expect(one.map.get(sotto('claude', 'a1'))?.status).toBe('running')
    expect(one.map.get(sotto('claude', 'a2'))?.status).toBe('running')
    const sequences = one.received.map(changes => changes.sequence)
    expect(sequences).toEqual(sequences.map((_, index) => sequences[0]! + index))
  })

  it('hands an unchanged thread out as the same record in its changes and its snapshots', async () => {
    const { claude, codex, host, sotto } = await switched()
    const one = watch(host)
    codex.emit(); claude.emit()
    const record = one.map.get(sotto('claude', 'a2'))!
    expect(one.latest().threads.find(item => item.id === record.id)).toBe(record)
    claude.state.threads[0]!.status = 'running'; claude.mark('a1'); claude.publish(false)
    expect(one.map.get(record.id)).toBe(record)
    expect(one.latest().threads.find(item => item.id === record.id)).toBe(record)
  })

})
