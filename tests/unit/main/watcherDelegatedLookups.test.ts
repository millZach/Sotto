// @vitest-environment node
/**
 * Watcher's wake-up pass finds the threads under the watched threads, whose cards are those threads' news (ADR-0081,
 * #1190), by walking down from the watched threads only (#925 step 5). Threads delegated from a thread Watcher does not
 * watch are never read, however many there are, on this computer or on a paired host: the look-ups one edge check and
 * one pass make stay the same with none of them, ten and a thousand. The edge check and the pass share one working-out.
 */
import { expect, it } from 'vitest'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'
import { emptyWatcherRecord, type WatcherRecord } from '../../../src/shared/watcher'
import type { WatcherRemoteHosts } from '../../../src/shared/watcherHost'
import type { HostThreadsView } from '../../../src/main/agents/control'
import { WatcherHosts, type WatcherHostsIndex, type WatcherHostsReader } from '../../../src/main/agents/watcherHosts'
import { WatcherWakeUp } from '../../../src/main/agents/watcherWakeUp'
import { targetKey } from '../../../src/main/agents/watcherEvidence'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const REMOTE = '22222222-2222-4222-8222-222222222222'
const AT = '2026-10-25T12:00:00.000Z'
const thread = (id: string, fields: Partial<AgentThread> = {}): AgentThread => ({ id, projectId: 'project', title: id, modelId: 'model', status: 'idle',
  messages: [], requests: [], clientConnected: true, ...fields })

/** The coordinator's index of a list, as `HostThreadIndex` answers it, counting each look-up. */
function viewOf(threads: readonly AgentThread[], count: { lookups: number }): HostThreadsView {
  const byId = new Map(threads.map((item, at) => [item.id, { item, at }]))
  const children = new Map<string, Set<string>>()
  for (const item of threads) if (item.delegatedBy) children.set(item.delegatedBy, (children.get(item.delegatedBy) ?? new Set()).add(item.id))
  return {
    thread: id => { count.lookups++; return byId.get(id)?.item },
    position: id => { count.lookups++; return byId.get(id)?.at },
    delegatedFrom: id => { count.lookups++; return children.get(id) },
    watcherKinds: new Set(threads.filter(item => item.kind === 'watcher').map(item => item.id)),
    foreign: false,
  }
}

/**
 * Watcher watching one thread here and one on a paired host, each with a thread delegated from it, beside `unrelated`
 * threads delegated from an unwatched thread on each host. Counts the look-ups one edge check and one pass make.
 */
function lookups(unrelated: number) {
  const count = { lookups: 0 }
  const local: AgentHostSnapshot = { ...structuredClone(EMPTY_AGENT_HOST), hostId: LOCAL, connected: true,
    capabilities: { ...EMPTY_AGENT_HOST.capabilities, observe: true }, projects: [{ id: 'project', title: 'Project', path: '/project' }],
    threads: [thread('w', { kind: 'watcher' }), thread('a'), thread('a1', { delegatedBy: 'a', requests: [{ id: 'card', kind: 'question', text: 'Which?', options: [] } as never] }),
      thread('p'), ...Array.from({ length: unrelated }, (_, index) => thread(`p-${index}`, { delegatedBy: 'p' }))] }
  const remoteSnapshot: AgentHostSnapshot = { ...structuredClone(EMPTY_AGENT_HOST), hostId: REMOTE, connected: true,
    capabilities: { ...EMPTY_AGENT_HOST.capabilities, observe: true }, projects: [],
    threads: Object.freeze([thread('ra', { hostId: REMOTE }), thread('ra1', { hostId: REMOTE, delegatedBy: 'ra' }), thread('rp', { hostId: REMOTE }),
      ...Array.from({ length: unrelated }, (_, index) => thread(`rp-${index}`, { hostId: REMOTE, delegatedBy: 'rp' }))]) as AgentThread[] }
  const view = viewOf(local.threads, count)
  const remote = { hosts: () => [{ hostId: REMOTE, control: false, reads: false, workSettled: true, connected: true, permissionCeiling: 'approval-required' as const }],
    snapshot: (id: string) => id === REMOTE ? remoteSnapshot : undefined, read: async () => undefined, control: async () => undefined,
    subscribe: () => () => undefined } as unknown as WatcherRemoteHosts
  const hosts = new WatcherHosts({ local: () => local, localThreads: snapshot => snapshot === local ? view : undefined, remote: () => remote })
  // Every call on the hosts' look-ups counts too, so a paired host's threads are counted as this computer's are.
  const counted = (index: WatcherHostsIndex): WatcherHostsIndex => new Proxy(index, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver) as unknown
    return typeof value === 'function' ? (...args: unknown[]) => { count.lookups++; return (value as (...a: unknown[]) => unknown).apply(target, args) } : value
  } })
  const reader: WatcherHostsReader = { index: snapshot => { const index = hosts.index(snapshot); return index && counted(index) }, takeChanges: snapshot => hosts.takeChanges(snapshot) }
  const record: WatcherRecord = { ...emptyWatcherRecord(), current: { target: { hostId: LOCAL, threadId: 'w' }, projectId: 'project', provider: 'claude',
    creationOperationId: '00000000-0000-4000-8000-000000000001', createdAt: AT },
  watches: [{ id: '00000000-0000-4000-8000-000000000002', target: { hostId: LOCAL, threadId: 'a' }, createdAt: AT, generation: 0, pausedByUserMessageId: null, lastUserMessageId: null },
    { id: '00000000-0000-4000-8000-000000000003', target: { hostId: REMOTE, threadId: 'ra' }, createdAt: AT, generation: 0, pausedByUserMessageId: null, lastUserMessageId: null }] }
  const wakes = new WatcherWakeUp({ snapshot: () => hosts.snapshot(), hosts: reader, record: () => record, canDeliver: () => false,
    deliver: async () => undefined, prune: async () => undefined, remember: async () => undefined, now: () => Date.parse(AT), schedule: () => () => undefined })
  // The first pass reads every thread and sets what the next follows.
  wakes.start()
  count.lookups = 0
  // An edge check whose edges have not moved, then a pass that follows the last.
  wakes.observeSoon(() => undefined)
  const edge = count.lookups
  wakes.observe()
  const owners = (wakes as unknown as { delegatedOwner: Map<string, string> }).delegatedOwner
  const passes = wakes as unknown as { observedChanges: number }
  return { edge, total: count.lookups, owners, followed: passes.observedChanges }
}

it('reads no thread delegated from an unwatched thread, however many there are, here or on a paired host', () => {
  const none = lookups(0), ten = lookups(10), thousand = lookups(1_000)
  expect([ten.edge, thousand.edge]).toEqual([none.edge, none.edge])
  expect([ten.total, thousand.total]).toEqual([none.total, none.total])
  // The pass did follow the last, and found the threads under the watched threads and nothing else.
  expect(thousand.followed).toBe(1)
  expect(new Map(thousand.owners)).toEqual(new Map([
    [targetKey({ hostId: LOCAL, threadId: 'a1' }), targetKey({ hostId: LOCAL, threadId: 'a' })],
    [targetKey({ hostId: REMOTE, threadId: 'ra1' }), targetKey({ hostId: REMOTE, threadId: 'ra' })],
  ]))
})
