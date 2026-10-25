// @vitest-environment node
/**
 * Threads that delegate to each other in a cycle (ADR-0081). Ordinary starts make trees, but saved records accept a cycle,
 * and Watcher's wake-up pass must treat one exactly as reading every thread does (#925 step 5 review). That walk climbs from
 * each delegated thread through the threads above it until one repeats, and the last watched thread it meets answers for
 * it, so a watched thread on a cycle can answer for itself. The pass that walks down from the watched threads only must
 * find the same owners, the watched thread's own entry included, and make no wake-up the whole pass does not.
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'
import { emptyWatcherRecord, type WatcherRecord } from '../../../src/shared/watcher'
import type { HostThreadsView } from '../../../src/main/agents/control'
import { WatcherHosts } from '../../../src/main/agents/watcherHosts'
import { WatcherWakeUp, watcherDelegationOwners } from '../../../src/main/agents/watcherWakeUp'
import { targetKey } from '../../../src/main/agents/watcherEvidence'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const AT = '2026-10-25T12:00:00.000Z'
const card = (id: string) => ({ id, kind: 'question' as const, text: 'Which?', options: [] })
const thread = (id: string, fields: Partial<AgentThread> = {}): AgentThread => ({ id, projectId: 'project', title: id, modelId: 'model', status: 'idle',
  messages: [], requests: [], clientConnected: true, ...fields })
const key = (threadId: string) => targetKey({ hostId: LOCAL, threadId })

/** The coordinator's index of a list, as `HostThreadIndex` answers it. */
function viewOf(threads: readonly AgentThread[]): HostThreadsView {
  const byId = new Map(threads.map((item, at) => [item.id, { item, at }]))
  const children = new Map<string, Set<string>>()
  for (const item of threads) if (item.delegatedBy) children.set(item.delegatedBy, (children.get(item.delegatedBy) ?? new Set()).add(item.id))
  return { thread: id => byId.get(id)?.item, position: id => byId.get(id)?.at, delegatedFrom: id => children.get(id),
    watcherKinds: new Set(threads.filter(item => item.kind === 'watcher').map(item => item.id)), foreign: false }
}

/**
 * Two wake-up passes over the same threads and watches: one with the hosts' look-ups, which walks down from the watched
 * threads, and one without, which reads every thread, as every pass did before. Each runs its first pass, then two more
 * over unchanged threads.
 */
function passes(threads: AgentThread[], watched: readonly string[]) {
  const local: AgentHostSnapshot = { ...structuredClone(EMPTY_AGENT_HOST), hostId: LOCAL, connected: true,
    capabilities: { ...EMPTY_AGENT_HOST.capabilities, observe: true }, projects: [{ id: 'project', title: 'Project', path: '/project' }],
    threads: [thread('w', { kind: 'watcher' }), ...threads] }
  const record: WatcherRecord = { ...emptyWatcherRecord(), current: { target: { hostId: LOCAL, threadId: 'w' }, projectId: 'project', provider: 'claude',
    creationOperationId: '00000000-0000-4000-8000-000000000001', createdAt: AT },
  watches: watched.map((threadId, index) => ({ id: `00000000-0000-4000-8000-0000000000${(16 + index).toString(16)}`, target: { hostId: LOCAL, threadId },
    createdAt: AT, generation: 0, pausedByUserMessageId: null, lastUserMessageId: null })) }
  const view = viewOf(local.threads)
  const run = (lookups: boolean) => {
    const hosts = new WatcherHosts({ local: () => local, localThreads: snapshot => snapshot === local ? view : undefined, remote: () => undefined })
    const wakes = new WatcherWakeUp({ snapshot: () => hosts.snapshot(), ...lookups ? { hosts } : {}, record: () => record, canDeliver: () => false,
      deliver: async () => undefined, prune: async () => undefined, remember: async () => undefined, now: () => Date.parse(AT), schedule: () => () => undefined })
    wakes.start(); wakes.observe(); wakes.observe()
    const inside = wakes as unknown as { delegatedOwner: Map<string, string>; pending: unknown[]; recent: unknown[]; seen: Set<string>; observedChanges: number }
    return { owners: new Map([...inside.delegatedOwner].sort()), pending: inside.pending, recent: inside.recent, seen: [...inside.seen].sort(), followed: inside.observedChanges }
  }
  return { narrowed: run(true), whole: run(false), reading: watcherDelegationOwners(local, new Set(watched.map(key))) }
}

describe('a delegation cycle (#925 step 5 review)', () => {
  it.each([
    ['A and B delegate to each other, A watched', [thread('a', { delegatedBy: 'b' }), thread('b', { delegatedBy: 'a', requests: [card('q-b')] })], ['a'],
      [['a', 'a'], ['b', 'a']]],
    ['A, B and C in a three-cycle, A watched', [thread('a', { delegatedBy: 'c' }), thread('b', { delegatedBy: 'a', requests: [card('q-b')] }),
      thread('c', { delegatedBy: 'b', requests: [card('q-c')] })], ['a'], [['a', 'a'], ['b', 'a'], ['c', 'a']]],
    ['A and B delegate to each other, both watched', [thread('a', { delegatedBy: 'b', requests: [card('q-a')] }), thread('b', { delegatedBy: 'a', requests: [card('q-b')] })],
      ['a', 'b'], [['a', 'a'], ['b', 'b']]],
    ['a three-cycle hanging under a watched thread', [thread('top'), thread('a', { delegatedBy: 'top' }), thread('b', { delegatedBy: 'c', requests: [card('q-b')] }),
      thread('c', { delegatedBy: 'b' }), thread('d', { delegatedBy: 'a' })], ['top'], [['a', 'top'], ['d', 'top']]],
  ] as const)('finds the owners and makes the wake-ups the whole pass does: %s', (_name, threads, watched, owners) => {
    const { narrowed, whole, reading } = passes([...threads], watched)
    // Reading every thread finds exactly these owners: a watched thread on a cycle answers for itself.
    expect(new Map([...reading].sort())).toEqual(new Map(owners.map(([child, owner]) => [key(child), key(owner)])))
    expect(narrowed.followed).toBeGreaterThan(0)
    expect(narrowed.owners).toEqual(whole.owners)
    expect(narrowed.owners).toEqual(new Map([...reading].sort()))
    // The same news waits and was told, and a later pass over unchanged threads makes none the whole pass does not.
    expect(JSON.stringify(narrowed.pending)).toBe(JSON.stringify(whole.pending))
    expect(JSON.stringify(narrowed.recent)).toBe(JSON.stringify(whole.recent))
    expect(narrowed.seen).toEqual(whole.seen)
  })
})
