// @vitest-environment node
/**
 * Watcher's wake-up pass keeps what it looked up from the pass before and looks up again only the threads the hosts'
 * journal says changed since (#1248). Its standing watches are part of the user's history: a pass while one watched thread
 * streams must look up as many threads with fifty other watched threads, all idle, as with none. It must also find what
 * a pass that reads every thread finds: the same news, observations and progress, after a change in place, a change the
 * coordinator did not describe, a thread that moved and a provider list sent again unchanged.
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'
import { emptyWatcherRecord, type WatcherRecord } from '../../../src/shared/watcher'
import type { HostThreadsChange, HostThreadsView } from '../../../src/main/agents/control'
import { WatcherHosts, type WatcherHostsIndex, type WatcherHostsReader } from '../../../src/main/agents/watcherHosts'
import { WatcherWakeUp } from '../../../src/main/agents/watcherWakeUp'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const AT = '2026-11-01T12:00:00.000Z'
const thread = (id: string, fields: Partial<AgentThread> = {}): AgentThread => ({ id, projectId: 'project', title: id, modelId: 'model', status: 'idle',
  providerId: 'claude', messages: [], requests: [], ...fields })
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

/**
 * This computer's host snapshot as the coordinator keeps it: a new snapshot for each change, over an index it patches in
 * place while no thread moves and builds again when one does, and the change it hands Watcher (`HostThreadsChange`).
 */
function coordinator(threads: AgentThread[]) {
  let index = indexOf(threads)
  let snapshot: AgentHostSnapshot = { ...structuredClone(EMPTY_AGENT_HOST), hostId: LOCAL, connected: true,
    capabilities: { ...EMPTY_AGENT_HOST.capabilities, observe: true }, projects: [{ id: 'project', title: 'Project', path: '/project' }],
    providers: [{ id: 'claude', name: 'Claude', connection: 'connected' }] as unknown as AgentHostSnapshot['providers'], threads }
  const counted = { lookups: 0 }
  function indexOf(list: readonly AgentThread[]) {
    const byId = new Map<string, AgentThread>(), at = new Map<string, number>()
    list.forEach((item, position) => { if (!byId.has(item.id)) { byId.set(item.id, item); at.set(item.id, position) } })
    const view: HostThreadsView = { thread: id => byId.get(id), position: id => at.get(id), delegatedFrom: () => undefined,
      watcherKinds: new Set(list.filter(item => item.kind === 'watcher').map(item => item.id)), foreign: false }
    return { byId, at, view }
  }
  return {
    counted,
    snapshot: () => snapshot,
    view: (of: AgentHostSnapshot) => of === snapshot ? index.view : undefined,
    /** Replaces threads in place, as an accept of thread changes does, and says what it changed. */
    replace(records: readonly AgentThread[], described = true): HostThreadsChange | undefined {
      const from = snapshot, previous = new Map<string, AgentThread>()
      const list = from.threads.slice()
      for (const record of records) { previous.set(record.id, index.byId.get(record.id)!); list[index.at.get(record.id)!] = record; index.byId.set(record.id, record) }
      snapshot = { ...from, threads: list }
      return described ? { from, threads: records, previous } : undefined
    },
    /** Moves a thread to the top, which builds the index again. */
    move(id: string): undefined {
      const list = snapshot.threads.filter(item => item.id !== id)
      list.unshift(snapshot.threads.find(item => item.id === id)!)
      index = indexOf(list); snapshot = { ...snapshot, threads: list }
      return undefined
    },
    /** Lists the same providers again in a new list, as a whole publication does. */
    relist(): undefined { snapshot = { ...snapshot, providers: structuredClone(snapshot.providers) }; index = indexOf(snapshot.threads); return undefined },
  }
}

/**
 * One wake-up pass with the hosts' look-ups and one reading every thread, over the same threads: Watcher, a thread that
 * streams, `idle` more watched threads that never change, and one no one watches. `steps` change the threads between passes.
 */
function run(idle: number, steps: ((host: ReturnType<typeof coordinator>, round: number) => HostThreadsChange | undefined)[]) {
  const ids = Array.from({ length: idle }, (_, index) => `idle-${index}`)
  const host = coordinator([thread('w', { kind: 'watcher' }), thread('s', { status: 'running', lastTurn: { id: 'turn', status: 'running' } }), ...ids.map(id => thread(id)), thread('u')])
  const record: WatcherRecord = { ...emptyWatcherRecord(), current: { target: { hostId: LOCAL, threadId: 'w' }, projectId: 'project', provider: 'claude',
    creationOperationId: uuid(1), createdAt: AT },
  watches: ['s', ...ids].map((threadId, index) => ({ id: uuid(100 + index), target: { hostId: LOCAL, threadId }, createdAt: AT, generation: 0,
    pausedByUserMessageId: null, lastUserMessageId: null })) }
  const hosts = new WatcherHosts({ local: () => host.snapshot(), localThreads: snapshot => host.view(snapshot), remote: () => undefined })
  const counting = (index: WatcherHostsIndex): WatcherHostsIndex => new Proxy(index, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver) as unknown
    return typeof value === 'function' ? (...args: unknown[]) => { host.counted.lookups++; return (value as (...a: unknown[]) => unknown).apply(target, args) } : value
  } })
  const reader: WatcherHostsReader = { index: snapshot => { const index = hosts.index(snapshot); return index && counting(index) },
    takeChanges: snapshot => hosts.takeChanges(snapshot), touchedSince: snapshot => hosts.touchedSince(snapshot) }
  let now = Date.parse(AT)
  const wakes = (lookups: boolean) => new WatcherWakeUp({ snapshot: () => hosts.snapshot(), ...lookups ? { hosts: reader } : {}, record: () => record,
    canDeliver: () => false, deliver: async () => undefined, prune: async () => undefined, remember: async () => undefined, now: () => now, schedule: () => () => undefined })
  const kept = wakes(true), whole = wakes(false)
  kept.start(); whole.start(); kept.observe(); whole.observe()
  const lookups: number[] = []
  steps.forEach((step, round) => {
    now += 1_000
    const changed = step(host, round)
    hosts.localChanged(host.snapshot(), changed)
    host.counted.lookups = 0
    kept.observe(); whole.observe()
    lookups.push(host.counted.lookups)
  })
  const said = (wakes: WatcherWakeUp) => {
    const inside = wakes as unknown as { pending: unknown[]; recent: unknown[]; seen: Set<string>; progress: Map<string, unknown> }
    return JSON.stringify({ pending: inside.pending, recent: inside.recent, seen: [...inside.seen].sort(), observations: [...wakes.observations].sort(),
      progress: [...inside.progress].map(([key, value]) => [key, { ...value as object, cancel: undefined }]).sort() })
  }
  return { lookups, kept: said(kept), whole: said(whole), followed: (kept as unknown as { observedChanges: number }).observedChanges }
}

/** The streaming thread's reply grows by one chunk, as each update while it streams. */
const stream = (host: ReturnType<typeof coordinator>, round: number) => {
  const before = host.snapshot().threads.find(item => item.id === 's')!
  return host.replace([{ ...before, messages: [{ id: 'reply', role: 'assistant', text: `word `.repeat(round + 1), createdAt: AT }] }])
}

describe('Watcher\'s wake-up pass keeps its look-ups while threads do not change (#1248)', () => {
  it('looks up as many threads while one watched thread streams, however many other watched threads there are', () => {
    const steps = Array.from({ length: 5 }, () => stream)
    const none = run(0, steps), five = run(5, steps), fifty = run(50, steps)
    expect(five.lookups).toEqual(none.lookups)
    expect(fifty.lookups).toEqual(none.lookups)
    // Watcher's conversations, its own thread and the thread that changed.
    expect(Math.max(...fifty.lookups)).toBeLessThanOrEqual(3)
    expect(fifty.followed).toBeGreaterThan(0)
    for (const result of [none, five, fifty]) expect(result.kept).toBe(result.whole)
  })

  it('finds what reading every thread finds after a change it was not told, a thread that moved and providers listed again', () => {
    const steps = [stream, (host: ReturnType<typeof coordinator>) => host.replace([{ ...host.snapshot().threads.find(item => item.id === 'idle-1')!, status: 'running' as const }], false),
      stream, (host: ReturnType<typeof coordinator>) => host.move('idle-2'), stream, (host: ReturnType<typeof coordinator>) => host.relist(), stream]
    const five = run(5, steps), fifty = run(50, steps)
    expect(five.kept).toBe(five.whole)
    expect(fifty.kept).toBe(fifty.whole)
    // A thread that moved moves the places of others, so that pass looks every watched thread up again; the next does not.
    expect(fifty.lookups[3]).toBeGreaterThan(50)
    expect(fifty.lookups[4]).toBe(five.lookups[4])
    // Providers listed again as they were mark no thread otherwise, so nothing is looked up again.
    expect(fifty.lookups[5]).toBe(five.lookups[5])
  })
})
