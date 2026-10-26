// @vitest-environment node
/**
 * The window's broadcast reading only the threads that changed (ADR-0016, ADR-0028, #925 step 6). The router notes each
 * publication's thread list as made in place from the last one's when it was, and the broadcast reads only the positions
 * those notes name. These hold that to the whole walk it replaces: two broadcasters are sent the same router
 * publications, one with the notes and one with every list walked whole (its host is a new object, noted nowhere), and
 * their payloads must be the same JSON after every operation, across seeded runs of every operation family once and then
 * a mix of them. A window applies each payload delivered as the page does, and must then hold the router's list, which
 * finds what both broadcasters would share.
 *
 * The families are a streamed update on one thread and on several, a record replaced with the same data, a thread added
 * and one removed, a reorder, a remote host connecting, disconnecting and pushing (noted and not, and afresh as the
 * socket brings it), a failed delivery, the window reading the whole state, coalesced publishes that skip states (with
 * the skipped ones collected), a host's connected marks and its provider's connection changing, the hosts reordered, a
 * host renamed, a selection, and a push that changes nothing.
 *
 * Each of these faults, put in by hand, fails the run: the router noting a host's positions without the threads of the
 * hosts before it; the router noting a host it read whole; the router noting a publication whose hosts were added,
 * removed or reordered (its check of the hosts and its check that each host's list was the last one's both taken out:
 * either alone holds); the broadcast sending every replaced record without comparing it; the broadcast keeping a base a
 * delivery failed to send; the broadcast forgetting a record it sent over a whole walk's; and the notes giving up at a
 * snapshot that was collected, which leaves the payloads equal but reads a coalesced send whole.
 */
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentStateBroadcaster, ThreadRecordsBroadcast } from '../../../src/main/agents/agentStateBroadcast'
import { ThreadChangesDrift } from '../../../src/main/agents/threadChanges'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { noteThreadsReplaced } from '../../../src/shared/threadListPatches'
import type { AgentCommand, AgentState, AgentStateBroadcast, AgentThread } from '../../../src/shared/agents'

setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc') as () => void
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

const LOCAL = '11111111-1111-4111-8111-111111111111'
const FORGE = '22222222-2222-4222-8222-222222222222'
const STUDIO = '33333333-3333-4333-8333-333333333333'

/** mulberry32: whole 32-bit integers throughout, so every operation family is reachable. */
function prng(seed: number): (below: number) => number {
  return below => {
    seed = (seed + 0x6d2b79f5) | 0
    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) % below
  }
}

function record(id: string, title: string): AgentThread {
  return { id, projectId: 'project', title, modelId: '', providerId: 'claude', status: 'idle', messages: [], requests: [],
    summary: { messageCount: 0, activityCount: 0 } } as AgentThread
}

/**
 * A host as main holds one: each push replaces its state and nothing writes into it. A push that replaces records in
 * place notes so, as the coordinator's broadcast does; one that adds, removes or moves a thread does not.
 */
function host(hostId: string, kind: 'local' | 'remote', name: string, threads: number) {
  const state = emptyDesktopState(hostId)
  state.host.connected = true; state.connection = 'connected'
  state.host.projects = [{ id: 'project', title: 'Project', path: '/repo' }]
  state.host.providers = [{ id: 'claude', name: 'Claude', connection: 'connected' }] as AgentState['host']['providers']
  state.host.threads = Array.from({ length: threads }, (_, index) => record(`${name}-${index}`, `Task ${index}`))
  let current = state
  let made = threads
  let available = true
  const listeners = new Set<(state: AgentState) => void>()
  const connection: DesktopHostConnection = { hostId, name, kind,
    service: { shell: () => structuredClone(current), view: () => ({ ...current }),
      subscribe: (listener: (state: AgentState) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      command: vi.fn(async (_command: AgentCommand) => { void _command; return structuredClone(current) }) } as unknown as DesktopHostConnection['service'],
    detail: async () => null, preview: () => null as never, available: () => available }
  const push = (next: AgentState): void => { current = next; for (const listener of listeners) listener({ ...current }) }
  return {
    connection,
    get threads() { return current.host.threads },
    /** The records at `positions` replaced in place by `replace`, noted as the coordinator notes its broadcasts. */
    replace(positions: readonly number[], replace: (thread: AgentThread) => AgentThread, noted = true): void {
      const threads = current.host.threads.slice()
      for (const position of positions) threads[position] = replace(threads[position]!)
      const next = { ...current, host: { ...current.host, threads } }
      if (noted) noteThreadsReplaced(next.host, current.host, positions)
      push(next)
    },
    /** A new list, noted nowhere. */
    relist(change: (threads: AgentThread[]) => AgentThread[]): void { push({ ...current, host: { ...current.host, threads: change(current.host.threads.slice()) } }) },
    /** Every record afresh with the same data, noted nowhere, as a remote host's push over the socket arrives. */
    fresh(): void { push(structuredClone(current)) },
    /** The same list on a new host, noted as made from the last with nothing replaced. */
    quiet(): void { const next = { ...current, host: { ...current.host } }; noteThreadsReplaced(next.host, current.host, []); push(next) },
    providers(connected: boolean): void {
      push({ ...current, host: { ...current.host, providers: [{ id: 'claude', name: 'Claude', connection: connected ? 'connected' : 'disconnected' }] as AgentState['host']['providers'] } })
    },
    newThread: (): AgentThread => record(`${name}-${made++}`, 'New'),
    setAvailable(value: boolean): void { available = value },
  }
}
type Host = ReturnType<typeof host>

const FAMILIES = ['stream one', 'stream several', 'same data', 'add', 'remove', 'reorder', 'connect', 'disconnect', 'remote push', 'remote push noted',
  'remote fresh', 'failed delivery', 'window read', 'coalesced', 'connected marks', 'provider connection', 'host order', 'rename', 'select', 'quiet'] as const
type Family = typeof FAMILIES[number]

const routers: DesktopHostRouter[] = []
afterEach(() => { for (const router of routers.splice(0)) router.dispose(); vi.unstubAllEnvs() })

async function run(seed: number, rounds = 160) {
  const random = prng(seed)
  const local = host(LOCAL, 'local', 'local', 24), forge = host(FORGE, 'remote', 'forge', 12), studio = host(STUDIO, 'remote', 'studio', 6)
  const router = new DesktopHostRouter(emptyDesktopState, { heldProviders: new Set(), watcherEnabled: true })
  routers.push(router)
  let latest: AgentState | undefined
  router.subscribe(state => { latest = state })
  router.add(local.connection); router.add(forge.connection); router.select(LOCAL)
  const connected = new Map<string, Host>([[LOCAL, local], [FORGE, forge]])
  const away = new Map<string, Host>([[STUDIO, studio]])
  const notes = new AgentStateBroadcaster(), whole = new AgentStateBroadcaster()
  const ran = new Map<Family, number>()
  let sends = 0, compared = 0
  /** The window, applying each broadcast it is sent as the page does: it must then hold the router's list. */
  const window = { revision: undefined as number | undefined, records: new Map<string, AgentThread>(), order: [] as string[] }
  const show = (payload: AgentStateBroadcast, state: AgentState): void => {
    const threads = payload.host.threads
    if (threads.base === null) { window.records = new Map(); window.order = threads.changed.map(thread => thread.id) }
    else {
      expect(threads.base, `seed ${seed}, send ${sends}: measured from a broadcast the window does not hold`).toBe(window.revision)
      for (const id of threads.removed ?? []) window.records.delete(id)
      if (threads.order) window.order = threads.order
      else if (threads.removed) window.order = window.order.filter(id => window.records.has(id))
    }
    for (const thread of threads.changed) window.records.set(thread.id, thread)
    window.revision = threads.revision
    expect(JSON.stringify(window.order.map(id => window.records.get(id))), `seed ${seed}, send ${sends}: the window's threads`).toBe(JSON.stringify(state.host.threads))
  }
  /** Sends the latest publication to both broadcasters, compares what each would put on the wire, and shows it. */
  const deliver = (delivered = true): void => {
    const state = latest
    if (!state) return
    latest = undefined
    let byNotes: AgentStateBroadcast | undefined, byWalk: AgentStateBroadcast | undefined
    notes.send(state, payload => { byNotes = payload; return delivered })
    whole.send({ ...state, host: { ...state.host } }, payload => { byWalk = payload; return delivered })
    sends++
    expect(JSON.stringify(byNotes), `seed ${seed}, send ${sends}`).toBe(JSON.stringify(byWalk))
    compared++
    if (delivered) show(byNotes!, state)
  }
  const pick = (from: Map<string, Host>): Host | undefined => { const hosts = [...from.values()]; return hosts.length ? hosts[random(hosts.length)] : undefined }
  const positions = (target: Host, count: number): number[] => {
    const length = target.threads.length, chosen = new Set<number>()
    while (length && chosen.size < Math.min(count, length)) chosen.add(random(length))
    return [...chosen]
  }
  const edit = (thread: AgentThread): AgentThread => ({ ...thread, status: thread.status === 'running' ? 'idle' : 'running',
    summary: { ...thread.summary!, messageCount: (thread.summary?.messageCount ?? 0) + 1 } })
  const same = (thread: AgentThread): AgentThread => structuredClone(thread)
  const apply = async (family: Family): Promise<void> => {
    ran.set(family, (ran.get(family) ?? 0) + 1)
    const target = pick(connected) ?? local
    switch (family) {
      case 'stream one': local.replace(positions(local, 1), edit); break
      case 'stream several': { const chosen = pick(connected)!; chosen.replace(positions(chosen, 2 + random(3)), edit); break }
      case 'same data': target.replace(positions(target, 1 + random(2)), same); break
      case 'add': target.relist(threads => { threads.splice(random(threads.length + 1), 0, target.newThread()); return threads }); break
      case 'remove': target.relist(threads => { if (threads.length) threads.splice(random(threads.length), 1); return threads }); break
      case 'reorder': target.relist(threads => { const [moved] = threads.splice(random(threads.length), 1); if (moved) threads.splice(random(threads.length + 1), 0, moved); return threads }); break
      case 'connect': { const host = pick(away); if (host) { away.delete(host.connection.hostId); connected.set(host.connection.hostId, host); router.add(host.connection) } break }
      case 'disconnect': { const remotes = new Map([...connected].filter(([id]) => id !== LOCAL)); const host = pick(remotes)
        if (host) { connected.delete(host.connection.hostId); away.set(host.connection.hostId, host); router.remove(host.connection.hostId) } break }
      case 'remote push': (pick(new Map([...connected].filter(([id]) => id !== LOCAL))) ?? local).replace([0], edit, false); break
      case 'remote push noted': { const remote = pick(new Map([...connected].filter(([id]) => id !== LOCAL))) ?? local; remote.replace(positions(remote, 1 + random(2)), edit); break }
      case 'remote fresh': (pick(new Map([...connected].filter(([id]) => id !== LOCAL))) ?? local).fresh(); break
      case 'failed delivery': local.replace(positions(local, 1), edit); deliver(false); local.replace(positions(local, 1), edit); break
      case 'window read': notes.windowRead(); whole.windowRead(); local.replace(positions(local, 1), edit); break
      case 'coalesced': {
        // Several publishes, of which only the last is sent: the ones between are held by nothing and are collected.
        for (let step = 1 + random(4); step > 0; step--) { const chosen = pick(connected)!; chosen.replace(positions(chosen, 1), edit) }
        await turn(); gc(); await turn(); gc()
        break
      }
      case 'connected marks': { const remote = pick(new Map([...connected].filter(([id]) => id !== LOCAL)))
        if (remote) { remote.setAvailable(random(2) === 0); router.setReconnecting(remote.connection.hostId, random(2) === 0); remote.replace(positions(remote, 1), edit) } break }
      case 'provider connection': target.providers(random(2) === 0); break
      case 'host order': {
        // A host that leaves and comes back stands last.
        const remote = pick(new Map([...connected].filter(([id]) => id !== LOCAL)))
        if (remote) { router.remove(remote.connection.hostId); router.add(remote.connection) } break
      }
      case 'rename': { const remote = pick(new Map([...connected].filter(([id]) => id !== LOCAL))); if (remote) router.rename(remote.connection.hostId, `Host ${random(5)}`); break }
      case 'select': router.select(pick(connected)!.connection.hostId); break
      case 'quiet': target.quiet(); break
    }
    deliver()
  }
  for (const family of FAMILIES) await apply(family)
  // The mix leans on streamed updates, as a working day does.
  const weighted: Family[] = [...FAMILIES, ...Array<Family>(8).fill('stream one'), ...Array<Family>(4).fill('stream several'), ...Array<Family>(3).fill('coalesced'),
    ...Array<Family>(2).fill('remote push noted'), 'same data', 'quiet']
  for (let round = 0; round < rounds; round++) await apply(weighted[random(weighted.length)]!)
  return { ran, sends, compared, notes: notes.threadEncodes, whole: whole.threadEncodes }
}

describe('the window\'s broadcast read where the notes say (#925 step 6)', () => {
  it.each([1, 7, 42, 925])('says what the whole walk says after every operation, seed %i', async seed => {
    const result = await run(seed)
    for (const family of FAMILIES) expect(result.ran.get(family) ?? 0, `family "${family}" ran`).toBeGreaterThan(0)
    expect(result.compared).toBe(result.sends)
    // The whole side never reads in part; the notes side does on most broadcasts.
    expect(result.whole.patched).toBe(0)
    expect(result.notes.patched, `of ${result.sends} broadcasts`).toBeGreaterThan(result.sends / 2)
  })

  it('checks every broadcast it read in part against the whole walk in verifying mode, and says the same', async () => {
    // Pinned off and then on, whatever the suite runs under.
    vi.stubEnv('SOTTO_VERIFY_THREAD_CHANGES', '0')
    const plain = await run(3, 80)
    vi.stubEnv('SOTTO_VERIFY_THREAD_CHANGES', '1')
    const verified = await run(3, 80)
    expect(verified.notes.verified).toBe(verified.notes.patched)
    expect(verified.notes.patched).toBe(plain.notes.patched)
    expect(plain.notes.verified).toBe(0)
  })

  it('reads coalesced publishes in part though the ones skipped were collected', async () => {
    const local = host(LOCAL, 'local', 'local', 10), forge = host(FORGE, 'remote', 'forge', 5)
    const router = new DesktopHostRouter(emptyDesktopState, { heldProviders: new Set(), watcherEnabled: true })
    routers.push(router)
    let latest: AgentState | undefined
    router.subscribe(state => { latest = state })
    router.add(local.connection); router.add(forge.connection)
    const broadcaster = new AgentStateBroadcaster()
    const sent: AgentStateBroadcast[] = []
    broadcaster.send(latest!, payload => { sent.push(payload); return true })
    const edit = (thread: AgentThread): AgentThread => ({ ...thread, title: `${thread.title}+` })
    // Three publishes, of which a coalesced send sends only the last; nothing holds the two between, and they are collected.
    const skipped: WeakRef<object>[] = []
    for (const [target, position] of [[local, 2], [forge, 1], [local, 7]] as const) { target.replace([position], edit); skipped.push(new WeakRef(latest!.host)) }
    const last = latest!
    await turn(); gc(); await turn(); gc()
    expect(skipped.slice(0, -1).filter(ref => ref.deref() !== undefined).length, 'skipped publications still alive').toBe(0)
    broadcaster.send(last, payload => { sent.push(payload); return true })
    expect(broadcaster.threadEncodes.patched).toBe(1)
    expect(sent[1]!.host.threads).toMatchObject({ revision: 2, base: 1 })
    expect(sent[1]!.host.threads.changed.map(thread => [thread.hostId, thread.title])).toEqual([[LOCAL, 'Task 2+'], [LOCAL, 'Task 7+'], [FORGE, 'Task 1+']])
  })
})

describe('the verifying mode of the window\'s broadcast (#925 step 6)', () => {
  it('finds a note that names too few positions, and changes nothing it keeps', () => {
    vi.stubEnv('SOTTO_VERIFY_THREAD_CHANGES', '1')
    const encoder = new ThreadRecordsBroadcast()
    const first = { threads: [record('a', 'A'), record('b', 'B'), record('c', 'C')] }
    encoder.encode(first.threads, first).commit()
    const second = { threads: [first.threads[0]!, { ...first.threads[1]!, title: 'B+' }, { ...first.threads[2]!, title: 'C+' }] }
    // A lie: the record at 2 was replaced too.
    noteThreadsReplaced(second, first, [1])
    expect(() => encoder.encode(second.threads, second)).toThrow(ThreadChangesDrift)
    // The failed encode kept nothing: the next, noted rightly, measures from the first.
    const third = { threads: second.threads }
    noteThreadsReplaced(third, first, [1, 2])
    const { payload } = encoder.encode(third.threads, third)
    expect(payload).toEqual({ revision: 3, base: 1, changed: [second.threads[1], second.threads[2]] })
  })

  it('sends no record replaced with the same data', () => {
    const encoder = new ThreadRecordsBroadcast()
    const first = { threads: [record('a', 'A'), record('b', 'B')] }
    encoder.encode(first.threads, first).commit()
    const second = { threads: [structuredClone(first.threads[0]!), first.threads[1]!] }
    noteThreadsReplaced(second, first, [0])
    expect(encoder.encode(second.threads, second).payload).toEqual({ revision: 2, base: 1, changed: [] })
    expect(encoder.patchedEncodes).toBe(1)
  })
})
