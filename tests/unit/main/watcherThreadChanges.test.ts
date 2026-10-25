// @vitest-environment node
/**
 * Watcher's and delegation's side of thread changes (ADR-0016, #925 step 5). Watcher's observe pass reads only the threads a
 * change names and the threads its record names; its wake-up pass reads only the watched threads, the threads they
 * delegated to and Watcher's own, by look-up; its room and delegation's pass look threads up rather than walk the list.
 * These hold that to the whole path it replaces: two coordinators over one workspace, the first taking the workspace's
 * thread changes in, the second every publication whole, each with its own Watcher and delegation. The second's Watcher
 * reads every thread in every pass, as every Watcher did before, and its wake-up pass is given no look-ups.
 *
 * After each operation, what each says is compared as JSON: Watcher's record, its room, the state behind its wake-ups (what
 * waits, what it told, what it observed of each thread, its evidence and what it kept per thread), every wake-up handed to
 * the coordinator, and delegation's records and pauses. Two things are normalized, and nothing else: UUIDs Watcher makes at
 * random (its prompt turns), named in the order they first appear; and the room's build number, which counts builds.
 * Wake-ups are kept by the test rather than queued, so neither coordinator sends anything to the shared provider.
 *
 * Each seed runs with the workspace's windows held for every thread, or led by the changes side's coordinator as in
 * production, where windows go and come back as its observed threads move (`stack`). A family lets a watched thread's window
 * go and come back; another moves Watcher's record and brings its pass only through the provider's next publication,
 * asserting the test supplied no call. The clock moves only once both sides hold the same host snapshot and have read their
 * records, so neither side's pass is dated a window later than the other's.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentRequest, type AgentThread } from '../../../src/shared/agents'
import type { AgentControl } from '../../../src/main/agents/control'
import { DelegationService } from '../../../src/main/agents/delegation'
import { ConfiguredProviderHost } from '../../../src/main/agents/providerSwitch'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'
import { WatcherService } from '../../../src/main/agents/watcher'
import { WATCHER_OBSERVE_MS } from '../../../src/main/agents/watcherWakeUp'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { WATCHER_QUIET_MS } from '../../../src/shared/watcherOverview'
import type { WatcherOperation, WatcherRecord, WatcherRequest, WatcherThreadTarget } from '../../../src/shared/watcher'
import type { WatcherRemoteHosts } from '../../../src/shared/watcherHost'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import { StreamingAdapter } from '../../fixtures/streamingAdapter'
import { testCredentials } from '../../fixtures/testCredentials'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close() })

const AT = '2026-10-25T12:00:00.000Z'
const REMOTE = '22222222-2222-4222-8222-222222222222'
const MODEL = { id: 'fake:model', provider: 'Fake', name: 'Synthetic model', ready: true }
const OTHER_MODEL = { id: 'fake:other', provider: 'Fake', name: 'Other synthetic model', ready: true }
const quiet = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 40))
const thread = (id: string, fields: Partial<AgentThread> = {}): AgentThread => ({ id, projectId: 'project', title: `Thread ${id}`, modelId: 'fake:model',
  status: 'idle', messages: [], requests: [], ...fields })
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

/** mulberry32: whole 32-bit integers throughout, so every operation family is reachable. */
function prng(seed: number): (below: number) => number {
  return below => {
    seed = (seed + 0x6d2b79f5) | 0
    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) % below
  }
}

/** Timers a test runs as the fake clock passes them, in the order they fall due. */
class Timers {
  private readonly waiting: { due: number; order: number; run: () => void; cancelled: boolean }[] = []
  private order = 0
  readonly schedule = (run: () => void, delay: number): (() => void) => {
    const timer = { due: Date.now() + Math.max(0, delay), order: this.order++, run, cancelled: false }
    this.waiting.push(timer)
    return () => { timer.cancelled = true }
  }
  /** Runs every timer due by now, and any due that those set, oldest first. */
  runDue(): number {
    let ran = 0
    for (;;) {
      const due = this.waiting.filter(timer => !timer.cancelled && timer.due <= Date.now()).sort((left, right) => left.due - right.due || left.order - right.order)[0]
      if (!due) break
      this.waiting.splice(this.waiting.indexOf(due), 1)
      due.run(); ran++
    }
    for (let at = this.waiting.length - 1; at >= 0; at--) if (this.waiting[at]!.cancelled) this.waiting.splice(at, 1)
    return ran
  }
}

/** What one coordinator, its Watcher and its delegation say, as each kept it. */
interface Side {
  readonly name: 'changed' | 'whole'
  readonly control: AgentControl
  readonly watcher: WatcherService
  readonly delegation: DelegationService
  readonly timers: Timers
  /** Every wake-up the coordinator was handed, in order: kept here rather than queued. */
  readonly delivered: unknown[]
}

/** The remote host, as the router hands Watcher its snapshot: the same frozen snapshot until it pushes again. */
function remoteHost() {
  const listeners = new Set<(hostId?: string, force?: boolean) => void>()
  const state = { threads: [] as AgentThread[], snapshot: undefined as AgentHostSnapshot | undefined, connected: true }
  const push = () => {
    state.snapshot = { ...structuredClone(EMPTY_AGENT_HOST), hostId: REMOTE, connected: state.connected,
      capabilities: { ...EMPTY_AGENT_HOST.capabilities, observe: true, threads: true },
      projects: [{ id: 'remote-project', title: 'Remote project', path: '/srv/remote' }],
      threads: Object.freeze(state.threads.map(item => ({ ...structuredClone(item), hostId: REMOTE }))) as AgentThread[] }
    for (const listener of listeners) listener(REMOTE, false)
  }
  const hosts = (): WatcherRemoteHosts => ({
    hosts: () => [{ hostId: REMOTE, name: 'forge', control: false, reads: false, workSettled: true, outcomes: true, connected: state.connected, permissionCeiling: 'approval-required' }],
    read: async () => { throw new Error('This host takes no reads.') },
    control: async () => { throw new Error('This host takes no control.') },
    snapshot: id => id === REMOTE ? state.snapshot : undefined,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
  })
  return { state, push, hosts }
}

/**
 * The adapter, the identity wrapper, the provider switch and one workspace, as main wires them, with two coordinators
 * over the workspace, each with Watcher open on the same Watcher thread and delegation on.
 */
/**
 * How the workspace hears which threads a window looks at, which decides the threads whose messages it holds:
 * - `held`: every thread's, but those the test lets go of, so neither coordinator's looking changes what the other is sent;
 * - `led`: the coordinator on changes alone tells it, as the only coordinator does in production, and the whole side's
 *   telling is not heard. Windows go and come back as that coordinator's own threads to observe move: Watcher's watched
 *   threads, delegation's followed threads, the selected thread and the threads a window shows.
 * Letting both tell it (`shared`, tried and not kept) makes them disagree, and the cause is the pair, not the changes path:
 * when the whole side's delegation has seen a delegated thread's reply and stops following the thread, its telling makes
 * the workspace drop that thread's messages before the changes side, which still follows it, reads the reply. The workspace
 * hears no such telling in production, and `led` agrees across every family.
 */
async function stack(threads = 7, observation: 'held' | 'led' = 'held') {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) })
  const root = await mkdtemp(join(tmpdir(), 'sotto-watcher-changes-'))
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }))
  await mkdir(join(root, 'project'), { recursive: true })
  const registry = new ThreadRegistry(join(root, 'registry'))
  await registry.load()
  cleanup.push(async () => { await registry.flush().catch(() => undefined) })
  const sessions = Array.from({ length: threads }, (_, index) => `s${index + 1}`)
  const adapter = new StreamingAdapter({ ...structuredClone(EMPTY_AGENT_HOST), name: 'Synthetic', version: '1', connected: true,
    capabilities: { ...EMPTY_AGENT_HOST.capabilities, projects: true, threads: true, submit: true, observe: true },
    projects: [{ id: 'project', title: 'Synthetic', path: join(root, 'project') }], models: [{ ...MODEL }],
    threads: [thread('w'), ...sessions.map(id => thread(id))] })
  const native = new ConfiguredProviderHost({ directory: join(root, 'switch'), provider: () => 'claude', enabledProviders: () => ['claude'], threadProvider: id => registry.byThread(id)?.provider,
    hosts: { claude: new SottoThreadHost('claude', adapter, registry), codex: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(),
      muse: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)), opencode: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)), cursor: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)) } })
  await mkdir(join(root, 'workspace'), { recursive: true })
  const workspace = new WorkspaceHost(native, join(root, 'workspace'), () => true, 600_000, true)
  workspace.enableDelegation()
  // Both coordinators tell the one workspace which threads they look at, and the last to tell it would decide which threads
  // hold their messages for both. It is made to hold every thread's but those the test lets go of (`unloaded`), so what one
  // coordinator looks at never changes what the other is sent, while a thread's window still goes and comes back as a
  // window's does in production: its messages drop to a summary and come back from the store.
  const unloaded = new Set<string>()
  const observe = workspace.observeThreads.bind(workspace)
  if (observation === 'held') workspace.observeThreads = () => observe(workspace.workspaceSnapshot().threads.map(item => item.id).filter(id => !unloaded.has(id)))
  /**
   * Tells the workspace again which threads are looked at, as a window does when it changes what it shows: held, every
   * thread but those let go of; led, the threads a window shows, all but those, through the changes side's coordinator.
   */
  let observeNow = (): void => { workspace.observeThreads([]) }
  cleanup.push(async () => { workspace.disconnect(); await workspace.privacyChanged().catch(() => undefined); workspace.dispose() })
  await workspace.initialize()
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const remote = remoteHost()
  const sotto = (session: string): string => registry.bySession('claude', session)!.threadId
  const at = (session: string) => adapter.state.threads.find(item => item.id === session)!
  const publish = (...marked: string[]): void => { for (const session of marked) adapter.mark(session); adapter.publish(false) }
  const sides: Side[] = []
  for (const name of ['changed', 'whole'] as const) {
    const directory = join(root, name)
    await mkdir(directory, { recursive: true })
    // Led by the changes side: the whole side's coordinator tells the workspace nothing of what it looks at.
    const host = observation === 'led' && name === 'whole' ? new Proxy(workspace, { get(target, key) {
      if (key === 'observeThreads') return () => undefined
      const value = Reflect.get(target, key, target) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    } }) as WorkspaceHost : workspace
    const control = createAgentControl({ directory, host, credentials, historyEnabled: () => false })
    if (name === 'whole') (control as unknown as { acceptsWhole: boolean }).acceptsWhole = true
    await control.start()
    cleanup.push(() => control.dispose())
    sides.push({ name, control, watcher: undefined as never, delegation: undefined as never, timers: new Timers(), delivered: [] })
  }
  if (observation === 'led') observeNow = () => {
    void sides[0]!.control.command({ type: 'observe-threads', threadIds: sides[0]!.control.watcherSnapshot().threads.map(item => item.id).filter(id => !unloaded.has(id)) })
  }
  for (const side of sides) await side.control.command({ type: 'connect' })
  publish()
  await settleWorkspace(workspace)
  // Watcher's own thread, which both Watchers are on.
  await workspace.setWatcherKind(sotto('w'), 'watcher')
  await settleWorkspace(workspace)
  const hostId = sides[0]!.control.hostId()!
  for (const side of sides) {
    const { control, timers } = side
    vi.spyOn(control, 'deliverWakeUp').mockImplementation(async (threadId, news) => { side.delivered.push({ threadId, news }) })
    control.mutateWatcher(record => {
      record.current = { target: { hostId, threadId: sotto('w') }, projectId: control.watcherSnapshot().threads.find(item => item.id === sotto('w'))!.projectId,
        provider: 'claude', creationOperationId: uuid(1), createdAt: AT }
    })
    const watcher = new WatcherService({ directory: join(root, side.name), control, host: workspace, historyEnabled: () => false, streamingPublishCost: true })
    cleanup.push(() => watcher.close())
    // The wake-up pass's timers run on the fake clock; the whole side's pass is given no look-ups, so it reads every thread.
    const wakes = watcher.wakes as unknown as { schedule: Timers['schedule']; options: { hosts?: unknown } }
    wakes.schedule = timers.schedule
    if (side.name === 'whole') wakes.options.hosts = undefined
    watcher.useRemoteHosts(remote.hosts())
    await watcher.recover()
    const delegation = new DelegationService({ directory: join(root, side.name), control, host: workspace, historyEnabled: () => false,
      now: () => Date.now(), schedule: timers.schedule })
    await delegation.recover()
    cleanup.push(() => delegation.close())
    Object.assign(side, { watcher, delegation })
  }
  return { root, adapter, workspace, registry, sessions, sotto, at, publish, remote, hostId, unloaded, observeNow, sides: sides as [Side, Side],
    /** How many times a side was given the call a publish makes because none came (`settled`). */
    supplied: { count: 0 } }
}
type Stack = Awaited<ReturnType<typeof stack>>

async function settleWorkspace(workspace: WorkspaceHost): Promise<void> { await quiet(); await workspace.flush(); await quiet() }

/** The JSON of `value` with each UUID named in the order it first appears. */
function text(value: unknown): string {
  const names = new Map<string, string>()
  return JSON.stringify(value ?? null, (_key, item: unknown) => item instanceof Map ? [...item].sort() : item instanceof Set ? [...item].sort() : item)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gu, id => {
      if (/^0{8}-0{4}-4000-8000-|^11111111-|^22222222-/u.test(id)) return id
      if (!names.has(id)) names.set(id, `uuid-${names.size}`)
      return names.get(id)!
    })
}

/** Where two texts first differ, with a little of each around it. */
function where(changed: string, whole: string): string {
  let at = 0
  while (at < changed.length && changed[at] === whole[at]) at++
  return `at ${at}: changes path ...${changed.slice(Math.max(0, at - 160), at + 200)}... whole path ...${whole.slice(Math.max(0, at - 160), at + 200)}...`
}

/** What Watcher keeps behind its wake-ups, read out of the wake-up pass. */
function wakeState(watcher: WatcherService) {
  const wakes = watcher.wakes as unknown as Record<string, unknown>
  const evidence = watcher.wakes.evidence as unknown as Record<string, Map<string, Map<string, unknown>>>
  const inner = (map: Map<string, Map<string, unknown>>) => [...map].map(([key, slots]) => [key, [...slots]]).sort()
  const progress = [...(wakes.progress as Map<string, Record<string, unknown>>)].map(([key, item]) => [key,
    { fingerprint: item.fingerprint, connected: item.connected, connectedAt: item.connectedAt, progressAt: item.progressAt, quiet: item.quiet, links: item.links, timed: item.cancel !== undefined }]).sort()
  return { pending: wakes.pending, recent: wakes.recent, news: watcher.wakes.news(), observations: wakes.observations, progress,
    seen: wakes.seen, latestEvidence: wakes.latestEvidence, toldLocal: wakes.toldLocal, localAt: wakes.localAt, owedWorkSettled: wakes.owedWorkSettled,
    settling: wakes.settling, waking: wakes.waking, toldAttention: wakes.toldAttention, carriedAttention: wakes.carriedAttention, turnsEnded: wakes.turnsEnded,
    carrying: wakes.carrying, ripened: wakes.ripened, openCards: [...(wakes.openCards as Map<string, { owner: string; cards: Map<string, unknown> }>)].map(([key, held]) => [key, held.owner, [...held.cards]]).sort(),
    openPrototypes: wakes.openPrototypes, reobserved: wakes.reobserved, delegatedOwner: wakes.delegatedOwner, lookedAt: wakes.lookedAt, sawThreads: wakes.sawThreads,
    misses: wakes.misses, retries: wakes.retries, consumedRetries: wakes.consumedRetries, watcherResting: wakes.watcherResting, lastNewsAt: wakes.lastNewsAt,
    evidence: { entries: inner(evidence.entries!), attending: inner(evidence.attending!), returning: inner(evidence.returning!), passing: inner(evidence.passing!) } }
}

/** Every way the two sides differ now, named. */
function differences({ sides: [changed, whole] }: Stack): string[] {
  const room = (side: Side) => { const { sequence: _sequence, ...rest } = side.watcher.state(); void _sequence; return rest }
  const heads = (side: Side) => [...(side.watcher as unknown as { nativeHeads: Map<string, string | null> }).nativeHeads].sort()
  const delegation = (side: Side) => {
    const inside = side.delegation as unknown as { records: unknown[]; paused: Set<string>; untold: Map<string, { ids: Set<string>; attempts: number }>; lastWorking: Map<string, number> }
    return { records: inside.records, paused: inside.paused, untold: [...inside.untold].map(([key, item]) => [key, item.ids, item.attempts]).sort(), lastWorking: inside.lastWorking }
  }
  const aspects: [string, unknown, unknown][] = [
    ['Watcher\'s record', changed.control.watcherRecordView(), whole.control.watcherRecordView()],
    ['Watcher\'s room', room(changed), room(whole)],
    ['the state behind Watcher\'s wake-ups', wakeState(changed.watcher), wakeState(whole.watcher)],
    ['each thread\'s newest user message as Watcher noted it', heads(changed), heads(whole)],
    ['the wake-ups handed to the coordinator', changed.delivered, whole.delivered],
    ['delegation\'s records and pauses', delegation(changed), delegation(whole)],
    ['the coordinator\'s host snapshot', changed.control.watcherSnapshot(), whole.control.watcherSnapshot()],
  ]
  return aspects.flatMap(([aspect, left, right]) => { const a = text(left), b = text(right); return a === b ? [] : [`${aspect} ${where(a, b)}`] })
}

/**
 * Both sides agree once each has taken in what the operation set off and run the wake-up pass it owes: the clock moves on
 * by the observe window, so a pass put off while updates came runs on both, over the same threads.
 */
async function agree(made: Stack, step: string, supply = true): Promise<void> {
  let found: string[] = []
  for (let attempt = 0; attempt < 60; attempt++) {
    await settled(made, supply)
    // How many passes each side ran follows when its coordinator's broadcasts reached it, which the harness, not the changes
    // path, decides: a late broadcast leaves one side a pass owed. Both run one pass now, at the same time on the clock, which
    // takes the place of any pass owed, so what is compared is each side's own pass over the same threads.
    if (supply) for (const side of made.sides) side.watcher.wakes.observe()
    passTime(made, WATCHER_OBSERVE_MS)
    await quiet()
    found = differences(made)
    if (!found.length) return
  }
  expect(found, `after ${step}`).toEqual([])
}

/**
 * Waits, without moving the fake clock, until neither side has anything left to take in: the workspace has flushed, and
 * each coordinator's host snapshot, Watcher's record and what its last wake-up pass read stay as they are for two looks,
 * both coordinators hold the same host snapshot, and each wake-up pass has read the record as it now stands.
 * Moving the clock while one side still has an update to take in would date that side's next pass a window later.
 */
async function settled(made: Stack, supply = true): Promise<void> {
  const look = () => made.sides.map(side => {
    const wakes = side.watcher.wakes as unknown as { observedEdges?: { record: unknown; threads: string } }
    return [side.control.watcherSnapshot(), side.control.watcherRecordView(), wakes.observedEdges?.record, wakes.observedEdges?.threads, side.delivered.length]
  }).flat()
  let last: unknown[] = []
  for (let round = 0; round < 50; round++) {
    await settleWorkspace(made.workspace)
    const now = look(), still = now.length === last.length && now.every((item, at) => item === last[at])
    last = now
    if (!still) continue
    // Both coordinators have taken in the same publications: one whose publication is still on its way would see it only
    // after the clock moved, and date what it finds a window later than the other.
    if (round < 40 && text(made.sides[0].control.watcherSnapshot()) !== text(made.sides[1].control.watcherSnapshot())) continue
    // A record change is read by the wake-up pass the coordinator's next publish runs. A side whose record changed with no
    // publish to follow is given the call that publish would make, at the same time on the clock.
    const behind = made.sides.filter(side => (side.watcher.wakes as unknown as { observedEdges?: { record: unknown } }).observedEdges?.record !== side.control.watcherRecordView())
    if (!behind.length) return
    if (!supply) continue
    made.supplied.count += behind.length
    for (const side of behind) side.watcher.wakes.observeSoon(() => undefined)
  }
}

/** Moves the fake clock on by `ms` and runs every timer it passes, on both sides. */
function passTime(made: Stack, ms: number): void {
  const end = Date.now() + ms
  // In steps no longer than the observe window, so each pass's own timers run as they would.
  while (Date.now() < end) {
    vi.setSystemTime(Math.min(end, Date.now() + WATCHER_OBSERVE_MS))
    for (const side of made.sides) side.timers.runDue()
  }
}

/** Changes both Watchers' records the same way. */
async function onBoth(made: Stack, change: (record: WatcherRecord) => void): Promise<void> {
  for (const side of made.sides) await side.control.updateWatcher(change)
}

/** The seeded run: every operation family once in a fixed order, then a seeded mix of them. */
async function equivalenceRun(seed: number, rounds: number, observation: 'held' | 'led' = 'held') {
  const made = await stack(7, observation)
  const { adapter, workspace, sessions, sotto, at, publish, remote, hostId, sides } = made
  const [changed, whole] = sides
  const next = prng(seed)
  // Each coordinator's queue, as Watcher and delegation ask it: the user's work waiting in a thread, which the test moves.
  const pending = new Set<string>()
  for (const side of sides) vi.spyOn(side.control, 'hasPendingThreadWork').mockImplementation(threadId => pending.has(threadId))
  let ids = 100, compared = 0, remoteThreads = 0
  const same = async (step: string, supply = true): Promise<void> => { compared++; await agree(made, step, supply) }
  const target = (session: string): WatcherThreadTarget => ({ hostId, threadId: sotto(session) })
  const say = (session: string, role: 'user' | 'assistant', words: string): string => {
    const id = `m-${ids++}`
    adapter.log.add(session, { id, role, text: words, createdAt: new Date().toISOString() })
    return id
  }
  const watcherTarget = { hostId, threadId: sotto('w') }
  const activeRequests = () => changed.control.watcherRecordView().requests.filter(request => request.state === 'active' && !request.standingWatchId)
  const pick = <T>(list: readonly T[]): T => list[next(list.length)]!
  // A delegated thread under s1, delegated by s1, which Watcher watches.
  await workspace.setDelegatedBy(sotto(sessions.at(-1)!), sotto('s1'))
  const watchS1 = { id: uuid(ids++), target: target('s1'), createdAt: AT, generation: 0, pausedByUserMessageId: null, lastUserMessageId: null }
  await onBoth(made, record => { (record.watches ??= []).push(structuredClone(watchS1)) })
  await same('a thread delegated from s1, which Watcher watches')
  const watched = () => (changed.control.watcherRecordView().watches ?? []).flatMap(item => sessions.filter(session => sotto(session) === item.target.threadId))
  const families: Record<string, (session: string) => Promise<void>> = {
    // Standing watches, as Watch makes one and Stop watching takes it away.
    'watch': async session => {
      if (changed.control.watcherRecordView().watches?.some(item => item.target.threadId === sotto(session))) return
      const head = at(session).messages.findLast(item => item.role === 'user')?.id ?? null
      const watch = { id: uuid(ids++), target: target(session), createdAt: new Date().toISOString(), generation: 0, pausedByUserMessageId: null, lastUserMessageId: head }
      await onBoth(made, record => { (record.watches ??= []).push(structuredClone(watch)) })
      await same(`watching ${session}`)
    },
    'unwatch': async session => {
      await onBoth(made, record => { record.watches = (record.watches ?? []).filter(item => item.target.threadId !== sotto(session)) })
      await same(`no longer watching ${session}`)
    },
    // A request with threads taking part, some of them on the paired host, and its end.
    'request': async session => {
      const id = uuid(ids++), other = pick(sessions)
      const participants: WatcherRequest['participants'] = [session, other].filter((item, index, all) => all.indexOf(item) === index).map((item, index) => ({ target: target(item), requestId: id, startedBy: 'watcher', generation: 0,
        state: 'participating', promptCount: 1, ...index ? { lastUserMessageId: null } : {} }))
      if (remote.state.threads.length) participants.push({ target: { hostId: REMOTE, threadId: pick(remote.state.threads).id }, requestId: id, startedBy: 'watcher', generation: 0, state: 'participating', promptCount: 1 })
      await onBoth(made, record => { record.requests.push({ id, watcher: watcherTarget, rootUserMessageId: `root-${id}`, state: 'active', createdAt: new Date().toISOString(), closedAt: null, participants }) })
      await same(`a request with ${session} taking part`)
    },
    'request-ends': async () => {
      const request = activeRequests()[0]
      if (!request) return
      await onBoth(made, record => { const found = record.requests.find(item => item.id === request.id)!; found.state = 'closed'; found.closedAt = new Date().toISOString() })
      await same('a request ending')
    },
    // Watcher's starts and sends, in every delivery state, some with their brief already in the thread.
    'operation': async session => {
      const request = activeRequests().find(item => item.participants.some(part => part.target.threadId === sotto(session))) ?? activeRequests()[0]
      if (!request) return
      const participant = request.participants[next(request.participants.length)]!, local = participant.target.hostId === hostId
      const deliveryState = pick(['accepted', 'accepted', 'dispatching', 'uncertain', 'failed'] as const)
      // Recorded before it goes, as Watcher records each send, and then, for some, echoed in the thread by its provider.
      const echoed = local && next(2) === 1, messageId = `brief-${ids++}`
      const operation: WatcherOperation = { id: uuid(ids++), requestId: request.id, retryKey: uuid(ids++), digest: (ids++).toString(16).padStart(64, '0'),
        action: next(2) ? 'send' : 'start', target: participant.target, generation: participant.generation, deliveryState, createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), receiptId: `receipt-${ids++}`, cardId: `card-${ids++}`, messageId, draftId: uuid(ids++),
        ...deliveryState === 'failed' ? { refusalCode: 'PROVIDER_UNAVAILABLE' as const } : {} }
      await onBoth(made, record => { record.operations.push(structuredClone(operation)) })
      if (echoed) {
        adapter.log.add(sessions.find(item => sotto(item) === participant.target.threadId)!, { id: messageId, role: 'user', text: 'A brief', createdAt: new Date().toISOString() })
        publish()
      }
      await same(`Watcher's ${operation.action} to ${participant.target.threadId} ${deliveryState}`)
    },
    // A turn starting and ending, sometimes with work left running or failing, and the user's own message, a takeover.
    'turn-starts': async session => {
      at(session).status = 'running'; at(session).lastTurn = { id: `turn-${ids++}`, status: 'running' }
      publish(session); await same(`a turn starting in ${session}`)
    },
    'turn-ends': async session => {
      const failed = next(4) === 0
      at(session).status = failed ? 'error' : 'idle'
      at(session).lastTurn = { id: at(session).lastTurn?.id ?? `turn-${ids++}`, status: failed ? 'failed' : 'completed' }
      at(session).backgroundWork = next(3) === 0 ? [{ id: `work-${ids++}`, type: 'shell' } as never] : undefined
      say(session, 'assistant', 'Done')
      publish(session); await same(`a turn ${failed ? 'failing' : 'finishing'} in ${session}`)
    },
    'work-settles': async session => { if (!at(session).backgroundWork) return; at(session).backgroundWork = undefined; publish(session); await same(`work settling in ${session}`) },
    'user-message': async session => {
      // Often in a watched thread, which takes it over and holds its watch while the user's own work runs.
      const into = watched().length && next(2) ? pick(watched()) : session
      say(into, 'user', 'The user says something'); publish(); await same(`the user writing in ${into}`)
    },
    // A watched thread whose newest message is Watcher's own send, its watch held for a user turn and its queue holding
    // work: Watcher lets the hold go though nothing in the thread moved, only its record (ADR-0073).
    'held-watch': async session => {
      const into = watched().length ? pick(watched()) : session
      const watch = changed.control.watcherRecordView().watches?.find(item => item.target.threadId === sotto(into))
      const request = activeRequests()[0]
      if (!watch || !request) return
      const messageId = `brief-${ids++}`
      const operation: WatcherOperation = { id: uuid(ids++), requestId: request.id, retryKey: uuid(ids++), digest: (ids++).toString(16).padStart(64, '0'), action: 'send',
        target: target(into), generation: watch.generation, deliveryState: 'accepted', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        receiptId: `receipt-${ids++}`, cardId: `card-${ids++}`, messageId, draftId: uuid(ids++) }
      await onBoth(made, record => { record.operations.push(structuredClone(operation)) })
      adapter.log.add(into, { id: messageId, role: 'user', text: 'A brief', createdAt: new Date().toISOString() })
      at(into).status = 'idle'
      publish(into); await same(`Watcher's send echoed in ${into}`)
      pending.add(sotto(into))
      await onBoth(made, record => { const held = record.watches!.find(item => item.id === watch.id); if (held) held.pausedByUserMessageId = 'unobserved-user-turn' })
      publish(pick(sessions.filter(item => item !== into))); await same(`the watch of ${into} held, with work in its queue`)
    },
    // A watched thread's window going and coming back: the workspace drops its messages to a summary, then reads them back
    // from the store, as when a window stops and starts showing it.
    'window': async session => {
      const into = watched().length && next(2) ? pick(watched()) : session
      const shown = (side: Side) => text(side.control.watcherSnapshot().threads.find(item => item.id === sotto(into)))
      const before = shown(changed)
      if (made.unloaded.has(sotto(into))) made.unloaded.delete(sotto(into)); else made.unloaded.add(sotto(into))
      made.observeNow()
      // The window goes or comes back through the workspace's next publication, which reaches the two coordinators a
      // moment apart; both show it before anything else happens, or the next step would find one side still without it.
      for (let wait = 0; wait < 60 && !(shown(changed) !== before && shown(changed) === shown(whole)); wait++) await quiet()
      await same(`${into}'s window ${made.unloaded.has(sotto(into)) ? 'going' : 'coming back'}`)
    },
    // A change to Watcher's record whose pass comes only through the real path: the provider's next publication, taken in
    // by each coordinator and handed to its Watcher, with no call supplied by the test.
    'record-then-publication': async session => {
      const watch = changed.control.watcherRecordView().watches?.[0]
      if (!watch) return
      await onBoth(made, record => { const held = record.watches!.find(item => item.id === watch.id); if (held) held.lastUserMessageId = null })
      const before = made.supplied.count
      say(session, 'assistant', 'Words that publish'); publish()
      await same(`Watcher's record moving, then the provider publishing ${session}`, false)
      expect(made.supplied.count, 'the publication brought each side its pass').toBe(before)
    },
    // The user's own work waiting in a watched thread's queue, or leaving it, with no change to the thread itself.
    'queue': async session => {
      const into = watched().length ? pick(watched()) : session
      if (pending.has(sotto(into))) pending.delete(sotto(into)); else pending.add(sotto(into))
      publish(pick(sessions)); await same(`the queue of ${into} ${pending.has(sotto(into)) ? 'holding' : 'clearing'}`)
    },
    'streamed': async session => { say(session, 'assistant', 'Streamed words'); publish(); await same(`words streaming in ${session}`) },
    // A question or permission card coming and going.
    'card': async session => {
      at(session).requests = at(session).requests.length ? [] : [{ id: `q-${ids++}`, kind: next(2) ? 'question' : 'permission', text: 'Which?', options: [] } as unknown as AgentRequest]
      publish(session); await same(`a card in ${session}`)
    },
    // Time passing: the observe window, a batch of news, evidence going stale, and work gone quiet.
    'time': async () => {
      const ms = pick([WATCHER_OBSERVE_MS, 2_500, 30_000, 6 * 60_000, WATCHER_QUIET_MS + 1_000])
      passTime(made, ms); publish(); await same(`${ms} ms passing`)
    },
    // A pull request linked to a thread, and what GitHub says of it.
    'pull-request': async session => {
      const url = `https://github.com/example/repo/pull/${(ids++ % 5) + 1}`
      at(session).pullRequests = [{ number: 1, url, state: 'open', draft: false } as never]
      publish(session)
      await quiet()
      const read = { url, observedAt: new Date().toISOString(), head: `head-${ids++}`, state: pick(['open', 'merged'] as const), availability: 'available' as const,
        checks: pick(['passed', 'failed', 'pending'] as const), checkCount: 3, conflicting: next(2) === 0 }
      for (const side of sides) side.watcher.pullRequestObserved(read)
      await same(`a pull request of ${session} read`)
    },
    // The paired host: a thread added, one changing, one going, and facts it reports.
    'paired-thread': async () => {
      const choice = next(3)
      if (choice === 0 || !remote.state.threads.length) remote.state.threads.push(thread(`remote-${remoteThreads++}`, { projectId: 'remote-project' }))
      else if (choice === 1) { const item = pick(remote.state.threads); item.status = item.status === 'running' ? 'idle' : 'running'; item.lastTurn = { id: `rturn-${ids++}`, status: item.status === 'running' ? 'running' : 'completed' } }
      else remote.state.threads.splice(next(remote.state.threads.length), 1)
      remote.push(); publish(); await same('the paired host pushing')
    },
    'paired-facts': async () => {
      const item = remote.state.threads[0]
      if (!item) return
      const fact = { id: 'x', target: { hostId: REMOTE, threadId: item.id }, source: 'working-copy', observedAt: new Date().toISOString(), freshness: 'fresh', availability: 'available',
        fact: 'files-changed', changedFiles: ids++ % 7 }
      for (const side of sides) side.watcher.wakes.pairedEvidence(REMOTE, [fact as never])
      await same('the paired host reporting facts')
    },
    'paired-connection': async () => { remote.state.connected = !remote.state.connected; remote.push(); publish(); await same(`the paired host ${remote.state.connected ? 'connecting' : 'disconnecting'}`) },
    // Delegation: an open brief on the delegated thread, its turn, its card and its end.
    'delegation': async () => {
      const child = sessions.at(-1)!, messageId = say(child, 'user', 'A brief')
      at(child).status = 'running'; at(child).lastTurn = { id: messageId, status: 'running' }
      publish(child)
      await same('a brief reaching the delegated thread')
      const record = { id: uuid(ids++), delegatingThreadId: sotto('s1'), delegatedThreadId: sotto(child), action: 'send', work: 'code-review', rootUserMessageId: `root-${ids++}`,
        inputDigest: 'a'.repeat(64), draftId: uuid(ids++), messageId, expectedLastUserMessageId: null, deliveryState: pick(['accepted', 'dispatching']), outcome: 'working',
        told: 'working', charged: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      // Recorded as a send records it, which follows its thread from then on, then the provider publishes again.
      for (const side of sides) { (side.delegation as unknown as { records: unknown[] }).records.push(structuredClone(record)); side.control.refreshDelegationObservation() }
      publish(child)
      await same('a delegation sent')
    },
    'delegated-turn': async () => {
      const child = sessions.at(-1)!
      at(child).status = at(child).status === 'running' ? 'idle' : 'running'
      at(child).lastTurn = { id: at(child).lastTurn?.id ?? `turn-${ids++}`, status: at(child).status === 'running' ? 'running' : 'completed' }
      if (at(child).status === 'idle') say(child, 'assistant', 'A reply')
      at(child).requests = next(3) === 0 ? [{ id: `dq-${ids++}`, kind: 'question', text: 'Which?', options: [] } as unknown as AgentRequest] : []
      publish(child); await same('the delegated thread moving')
    },
    // Watcher's own turn, which it rests on or not.
    'watcher-turn': async () => {
      at('w').status = at('w').status === 'running' ? 'idle' : 'running'
      at('w').lastTurn = { id: `wturn-${ids++}`, status: at('w').status === 'running' ? 'running' : 'completed' }
      publish('w'); await same(`Watcher's turn ${at('w').status === 'running' ? 'starting' : 'ending'}`)
    },
    // The user settling a thread, and the provider starting and dropping threads.
    'settle': async session => { await workspace.setWorkspaceSettled('thread', sotto(session), next(2) === 0); await same(`settling ${session}`) },
    'thread-starts': async () => {
      const id = `n${ids++}`; adapter.state.threads.push(thread(id)); sessions.splice(sessions.length - 1, 0, id); publish(id)
      await same(`the provider starting ${id}`)
      // The workspace holds the new thread's messages from now on, as every thread's: otherwise the first coordinator to
      // look at it, as by watching it, would bring its window in between the two coordinators' passes.
      made.observeNow(); await same(`${id} coming into view`)
    },
    'thread-drops': async session => {
      if (session === sessions.at(-1) || session === 's1' || sessions.length < 4) return
      adapter.state.threads.splice(adapter.state.threads.indexOf(at(session)), 1); sessions.splice(sessions.indexOf(session), 1); publish(session)
      await same(`the provider dropping ${session}`)
    },
    // The provider's catalog changing, which the coordinator takes in whole.
    'catalog': async () => { adapter.state.models = adapter.state.models.length > 1 ? [{ ...MODEL }] : [{ ...MODEL }, { ...OTHER_MODEL }]; publish(); await same('the provider\'s catalog changing') },
  }
  const names = Object.keys(families)
  const ran = new Map<string, number>()
  const run = async (name: string) => {
    const session = pick(sessions.slice(0, -1))
    ran.set(name, (ran.get(name) ?? 0) + 1)
    await families[name]!(session)
  }
  for (const name of names) await run(name)
  for (let round = 0; round < rounds; round++) await run(pick(names))
  return { made, ran, names, compared, changed, whole }
}

describe('Watcher and delegation on thread changes (#925 step 5)', () => {
  it.each([[1, 'held'], [2, 'held'], [3, 'led'], [4, 'led']] as const)('say what the whole path says across a seeded run of every operation family (seed %i, windows %s)', async (seed, observation) => {
    const { ran, names, compared, changed, whole } = await equivalenceRun(seed, 70, observation)
    // Every family ran, and the comparisons ran after each.
    expect(names.filter(name => !ran.has(name))).toEqual([])
    expect(compared).toBeGreaterThan(names.length)
    // The changes side followed changes, in its observe pass and its wake-up pass; the whole side never did.
    expect(changed.watcher.observedChanges).toBeGreaterThan(10)
    expect(changed.watcher.wakes.observedChanges).toBeGreaterThan(10)
    expect(whole.watcher.observedChanges).toBe(0)
    expect(whole.watcher.wakes.observedChanges).toBe(0)
  }, 600_000)
})
