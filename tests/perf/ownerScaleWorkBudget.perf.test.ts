// @vitest-environment node
/**
 * What main does per update and per user action with the owner's history, counted rather than timed (#1232).
 *
 * Main's lag came back again and again (#917, #925, #1038, #1062, #1065-#1068, and October 20, 2026) with the same cause:
 * work per update that grew with what the user had accumulated: the threads, a remote host, every answered question and
 * Watcher's record. Fresh fixtures hold none of it, and timing checks are opt-in, so nothing in CI saw it. This builds main
 * as `src/main/index.ts` wires it, on Owl and on stable, at the owner's scale (`tests/fixtures/ownerScalePipeline.ts`),
 * streams replies on one thread and on three, and does what the user does: saves an answer draft, types in a composer,
 * opens a thread and sends. It counts the work each update and each action does, and fails when a count passes its budget
 * or grows the wrong way along either of two lines:
 *
 * - History (answer retirements, Watcher's requests, operations and watches, the remote host's answered threads), with
 *   the threads held: the work must stay flat. This is how every regression above grew.
 * - Threads on this computer, with the history held: the work may grow as the threads do, since a broadcast carries every
 *   thread, but never faster. The work per thread stays flat.
 *
 * It counts calls and objects, never time. Every timer runs on Vitest's fake clock, moved on in fixed steps, and each step
 * waits until no file work is in flight, so the counts are the same on every run and every machine; it runs in the
 * default suite. A failure names the count that grew, along which line, and the numbers at both ends. Read state without
 * copying it, and do work bounded by what changed rather than by the history. The budgets only tighten: a change that
 * needs a higher one says why in its pull request. docs/perf/2026-10-20-main-lag.md has the numbers and how to read them.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ActivitySubscribers } from '../../src/main/agents/activitySnapshots'
import { AgentControl } from '../../src/main/agents/control'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import { SottoThreadHost } from '../../src/main/agents/threads'
import { WatcherService } from '../../src/main/agents/watcher'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import type { AgentHostSnapshot, AgentState, AgentThread } from '../../src/shared/agents'
import type { WatcherThreadTarget } from '../../src/shared/watcher'
import { ownerScalePipeline, type OwnerScalePipeline, type OwnerScaleTrack, type ThreadChangesReport } from '../fixtures/ownerScalePipeline'
import { verifyingThreadChanges } from '../../src/main/agents/threadChanges'
import type { OwnerScale } from '../fixtures/ownerScale'

/** The kinds of work counted. Each is per update while streaming, and per action for the user's actions. */
const KINDS = ['copies', 'copiedObjects', 'wholeStateCopies', 'wholeCopyThreads', 'wholeCopyObjects', 'unsharedPublications', 'routerShellBuilds',
  'coordinatorShellBuilds', 'threadVisits', 'watcherRecordCopies', 'watcherRecordObjects', 'watcherRecordComparisons', 'unwatchedThreadPasses', 'ownerLookups',
  'stringifies', 'providerIdParses', 'schemaErrors', 'watcherRoomBuilds', 'watcherRoomRecords', 'threadRecordsTouched', 'adapterChangeRecords',
  'wrapperChangeRecords', 'switchChangeRecords', 'workspaceChangeRecords', 'creationReads'] as const
type Kind = typeof KINDS[number]
type Counts = Record<Kind, number>

const counter = vi.hoisted(() => ({ measuring: false, wholeThreads: Number.POSITIVE_INFINITY, record: undefined as (() => unknown) | undefined,
  tally: {} as Record<string, number>, sites: {} as Record<string, Record<string, number>>, accepting: 0 }))
/**
 * With `SOTTO_WORK_SITES=1`, where each serialization, each thread visit and each copied object came from: the nearest
 * frame in `src/`. It is slow, and is for finding what grew; a failure then names the places whose counts grew most.
 */
const SITES = vi.hoisted(() => process.env.SOTTO_WORK_SITES === '1')
const SITED = vi.hoisted(() => new Set<string>(['stringifies', 'threadVisits', 'copiedObjects', 'threadRecordsTouched']))
const site = vi.hoisted(() => (): string => {
  const frame = new Error().stack?.split('\n').find(line => /[\\/]src[\\/]/u.test(line))
  return frame?.trim().replace(/^at /u, '').replace(/(^|\()[^()]*?[\\/]src[\\/]/u, '$1src/').replace(/\\/gu, '/') ?? 'outside src/'
})
/** `at` names where the work was done when the caller knows it, such as the layer that touched thread records; that is always kept. */
const bump = vi.hoisted(() => (kind: string, by = 1, at?: string): void => {
  if (!counter.measuring) return
  counter.tally[kind] = (counter.tally[kind] ?? 0) + by
  if (at !== undefined || SITES && SITED.has(kind)) { const where = at ?? site(), sites = counter.sites[kind] ??= {}; sites[where] = (sites[where] ?? 0) + by }
})
/**
 * The thread records one layer between the adapter and the coordinator built or walked for an update: every thread of
 * the snapshot it handed on, since each of them builds a new record for every thread or reads each against its last
 * (#925). The layers are the adapter's activity view with its copy, the identity wrapper, the provider switch, the
 * workspace's accept, the host stamp and the workspace's activity publication. A layer that passes on thread changes
 * counts the records it upserted and the threads it removed instead; the workspace's accept, the threads it took in; the
 * host stamp, the threads it stamped; and the publication, the threads it read again.
 */
const touched = vi.hoisted(() => (layer: string, snapshot: { threads?: unknown } | undefined): void => {
  if (Array.isArray(snapshot?.threads)) bump('threadRecordsTouched', snapshot.threads.length, layer)
})
const { fresh, freshEachOver } = await vi.hoisted(() => import('./support/copyAccounting'))
const visits = await vi.hoisted(() => import('../fixtures/threadVisits'))
/** How many threads a copier was handed, when it was handed a whole host's state: a shell or a snapshot carrying every thread of a host. */
const wholeThreads = vi.hoisted(() => (value: unknown): number | undefined => {
  const holder = value as { host?: { threads?: unknown }; threads?: unknown } | null
  const threads = Array.isArray(holder?.host?.threads) ? holder.host.threads : Array.isArray(holder?.threads) ? holder.threads : undefined
  return threads !== undefined && threads.length >= counter.wholeThreads ? threads.length : undefined
})
/**
 * Every copy, counted where it is made: by `structuredClone` or by one of the four copiers in `cloneHostSnapshot.ts`,
 * which every other copier calls (`cloneActivitySnapshot`, an activity subscription's copy for its subscribers, the
 * certifying of activity and models, the workspace's thread records), so a copy made inside another is counted once. Each
 * copy is counted once and by the objects it made; a whole copy also by the threads it carried; a copy of Watcher's record
 * by its objects too. A publication's records copied over the last one's are one copy, sized by the records that
 * changed; a record published again that had not changed is kept, not copied, and a call that kept every record is no
 * copy (#1326). Sizing a copy reads its source, which is no visit.
 */
const copied = vi.hoisted(() => (value: unknown, copy: unknown, previous?: readonly unknown[]): void => {
  if (!counter.measuring) return
  const on = visits.threadVisits.on
  visits.threadVisits.on = false
  try {
    const made = previous === undefined ? fresh(copy, value) : freshEachOver(copy as unknown[], value as unknown[], previous)
    // A copy over earlier records that kept all of them made nothing, and is no copy.
    if (previous !== undefined && made === 0) return
    bump('copies'); bump('copiedObjects', made)
    const threads = wholeThreads(value)
    if (threads !== undefined) { bump('wholeStateCopies'); bump('wholeCopyThreads', threads); bump('wholeCopyObjects', made) }
    if (counter.record && value === counter.record()) { bump('watcherRecordCopies'); bump('watcherRecordObjects', made) }
  } finally { visits.threadVisits.on = on }
})
vi.mock('../../src/main/agents/cloneHostSnapshot', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/main/agents/cloneHostSnapshot')>()
  return { ...original,
    cloneHostSnapshot: (snapshot: Parameters<typeof original.cloneHostSnapshot>[0]) => { const copy = original.cloneHostSnapshot(snapshot); copied(snapshot, copy); return copy },
    clonePlainData: <T>(value: T): T => { const copy = original.clonePlainData(value); copied(value, copy); return copy },
    copyUnshared: <T>(value: T, shared: (value: object) => boolean, seal?: (copy: object) => void): T => {
      const copy = original.copyUnshared(value, shared, seal); copied(value, copy); return copy
    },
    copyOver: <T>(values: readonly T[], previous: readonly (T | undefined)[], shared: (value: object) => boolean, seal: (copy: object) => void): T[] => {
      const copy = original.copyOver(values, previous, shared, seal); copied(values, copy, previous); return copy
    } }
})
// The host stamp the workspace's accept puts on every thread it takes in (`touched`): all of them for a whole snapshot,
// one at a time for the threads a change named (#925).
vi.mock('../../src/main/agents/hostIdentity', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/main/agents/hostIdentity')>()
  return { ...original, stampHostSnapshot: (snapshot: Parameters<typeof original.stampHostSnapshot>[0], hostId: string) => {
    touched('host stamp', snapshot)
    return original.stampHostSnapshot(snapshot, hostId)
  }, stampHostThread: (thread: Parameters<typeof original.stampHostThread>[0], hostId: string) => {
    bump('threadRecordsTouched', 1, 'host stamp')
    return original.stampHostThread(thread, hostId)
  } }
})
// The provider switch keeps an activity subscription's publication as it is and copies anything else: a snapshot that
// comes without the publication's mark is copied once more on every update.
vi.mock('../../src/main/agents/activitySnapshots', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/main/agents/activitySnapshots')>()
  return { ...original, isActivityPublication: (snapshot: Parameters<typeof original.isActivityPublication>[0]) => {
    const published = original.isActivityPublication(snapshot)
    if (!published) bump('unsharedPublications')
    return published
  } }
})
// Comparing Watcher's whole record with the copy just made of it, which costs more than the copy.
vi.mock('node:util', async importOriginal => {
  const original = await importOriginal<typeof import('node:util')>()
  const isDeepStrictEqual = (left: unknown, right: unknown): boolean => {
    if (counter.measuring && counter.record && (left === counter.record() || right === counter.record())) bump('watcherRecordComparisons')
    return original.isDeepStrictEqual(left, right)
  }
  return { ...original, default: { ...original, isDeepStrictEqual }, isDeepStrictEqual }
})
// Reading a provider out of a public model or project ID: how a stable build filters the providers it holds out of every
// publish, once per model and project. Asked once per thread instead, it was a second of a busy minute (#1068).
vi.mock('../../src/shared/agents', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/shared/agents')>()
  return { ...original, parsePublicProviderEntityId: (id: string) => { bump('providerIdParses'); return original.parsePublicProviderEntityId(id) } }
})

// Nothing main does may finish on the machine's time rather than the test's, or the work would fall into a different step
// on each run. Git is asked about each project folder; none is a repository, and this stand-in says so at once, as Git
// would, instead of a child process that exits whenever the machine lets it. A retry's or a recovery's wait runs on the
// test's clock.
vi.mock('../../src/main/agents/gitLauncher', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/main/agents/gitLauncher')>()
  const { EventEmitter } = await import('node:events')
  const launchProcess = (): import('../../src/main/agents/gitLauncher').LaunchedProcess => {
    const output = () => Object.assign(new EventEmitter(), { setEncoding() { return this }, destroy: () => undefined })
    const child = Object.assign(new EventEmitter(), { pid: undefined as number | undefined, stdout: output(), stderr: output(), kill: () => true })
    queueMicrotask(() => {
      child.pid = 1; child.emit('spawn')
      child.stderr.emit('data', Buffer.from('fatal: not a git repository (or any of the parent directories): .git\n'))
      child.emit('close', 128, null)
    })
    return child as never
  }
  return { ...original, launchProcess }
})
vi.mock('node:timers/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:timers/promises')>()
  const setTimeout = <T>(ms?: number, value?: T): Promise<T> => new Promise(resolve => { globalThis.setTimeout(() => resolve(value as T), ms) })
  return { ...original, setTimeout, default: { ...original, setTimeout } }
})

const roots: string[] = []

// ---------------------------------------------------------------------------------------------------------------------
// The clock. Every timer main sets is fake, and moves only when the test moves it, in STEP_MS steps. After each step the
// test waits until no file work is in flight, so what a timer sets off has landed before the next one fires, whatever the
// machine's speed. `setImmediate` stays real: it is how the test yields to the file work it waits for.

const STEP_MS = 5
/** Longer than the answer-recovery pass's interval (500 ms) and every publish window, so what work sets off is counted with it. */
const SETTLE_MS = 1_000
const turn = globalThis.setImmediate
const fileWorkInFlight = (): boolean => process.getActiveResourcesInfo().some(name => /^(FSReq|FileHandle|CloseReq)/u.test(name))
/** Until no file read or write has been in flight for three turns of the event loop. */
async function filesSettled(): Promise<void> {
  const started = process.hrtime.bigint()
  for (let quiet = 0; quiet < 3;) {
    if (process.hrtime.bigint() - started > 60_000_000_000n) throw new Error(`File work was still in flight after a minute: ${process.getActiveResourcesInfo().join(', ')}.`)
    await new Promise<void>(resolve => { turn(resolve) })
    quiet = fileWorkInFlight() ? 0 : quiet + 1
  }
}
async function step(ms = STEP_MS): Promise<void> { await vi.advanceTimersByTimeAsync(ms); await filesSettled() }
/** Moves the clock on by `ms`, one step at a time. */
async function pass(ms: number): Promise<void> { for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) await step() }
/** Moves the clock on, a step at a time, until `work` is done. */
async function until<T>(work: Promise<T>): Promise<T> {
  let done = false
  void work.then(() => { done = true }, () => { done = true })
  await filesSettled()
  for (let elapsed = 0; !done; elapsed += STEP_MS) {
    if (elapsed > 120_000) throw new Error('The work was not done after two minutes on the test\'s clock.')
    await step()
  }
  return work
}

// ---------------------------------------------------------------------------------------------------------------------

function zero(): Counts { return Object.fromEntries(KINDS.map(kind => [kind, 0])) as Counts }
type Sites = Record<string, Record<string, number>>

/** Counts what `work` does, and what it sets off until SETTLE_MS later on the test's clock. */
async function count(pipeline: OwnerScalePipeline, work: () => Promise<void>): Promise<{ counts: Counts; broadcasts: number; sites: Sites }> {
  counter.tally = {}; counter.sites = {}; pipeline.resetCounts(); visits.threadVisits.count = 0
  counter.measuring = true; visits.threadVisits.on = true
  try {
    await work()
    await pass(SETTLE_MS)
  } finally { counter.measuring = false; visits.threadVisits.on = false }
  return { counts: { ...zero(), ...counter.tally, ownerLookups: pipeline.ownerLookups(), threadVisits: visits.threadVisits.count, watcherRoomRecords: pipeline.watcherRoomRecords(),
    adapterChangeRecords: pipeline.adapterChangeRecords(), wrapperChangeRecords: pipeline.wrapperChangeRecords(), switchChangeRecords: pipeline.switchChangeRecords(),
    workspaceChangeRecords: pipeline.workspaceChangeRecords() } as Counts,
    broadcasts: pipeline.broadcasts(), sites: counter.sites }
}

const per = (counts: Counts, by: number): Counts => Object.fromEntries(KINDS.map(kind => [kind, Math.round(counts[kind] / Math.max(1, by) * 100) / 100])) as Counts

const CHUNKS = 30
interface Measured { threads: number; counts: Record<string, number>; scenarios: Record<Scenario, Counts>; sites: Record<Scenario, Sites>; updates: Partial<Record<Scenario, number>>
  threadChanges: ThreadChangesReport }

/** The shadows' work in the verifying mode (`ownerScalePipeline`'s `verifyThreadChanges`), left out of every count. */
function uncounted<T>(work: () => T): T {
  const measuring = counter.measuring, on = visits.threadVisits.on
  counter.measuring = false; visits.threadVisits.on = false
  try { return work() } finally { counter.measuring = measuring; visits.threadVisits.on = on }
}

/** Builds main on `track` at `shape` of the owner's world and counts each scenario. */
async function measure(track: OwnerScaleTrack, shape: OwnerScale): Promise<Measured> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-owner-scale-')); roots.push(root)
  const pipeline = await until(ownerScalePipeline(root, shape, 3, track, { uncounted, touched: (layer, records) => bump('threadRecordsTouched', records, layer),
    // A creation read while the workspace takes in an update; a save serializing every creation is not one.
    creationRead: () => { if (counter.accepting) bump('creationReads') } }))
  counter.wholeThreads = Math.min(pipeline.counts.threads, pipeline.counts.remoteThreads)
  counter.record = () => pipeline.control.watcherRecordView()
  // Watcher's wake-up pass runs at most every 250 ms while threads stream. Here it runs on every update, as it does when
  // an update moves something it reacts to, so the counts are the most an update can do.
  if (pipeline.watcher) {
    if (!('observedAt' in pipeline.watcher.wakes)) throw new Error('Watcher\'s wake-up pass no longer keeps observedAt; hold its pass to every update another way.')
    Object.defineProperty(pipeline.watcher.wakes, 'observedAt', { get: () => -Infinity, set: () => undefined })
    // The pass asks `progress` for each thread it works through. It works through the threads Watcher watches and skips the
    // rest; working out news for every thread was #1062's cost.
    const wakes = pipeline.watcher.wakes as unknown as { options?: { progress?: (target: WatcherThreadTarget) => string | undefined } }
    const progress = wakes.options?.progress
    if (!wakes.options || typeof progress !== 'function') throw new Error('Watcher\'s wake-up pass no longer asks options.progress for each thread it works through; count the threads it works through another way.')
    const watched = (target: WatcherThreadTarget): boolean => pipeline.control.watcherRecordView().watches?.some(watch => watch.target.hostId === target.hostId && watch.target.threadId === target.threadId) === true
    wakes.options.progress = target => { if (counter.measuring && !watched(target)) bump('unwatchedThreadPasses'); return progress(target) }
  }
  try {
    await pass(SETTLE_MS)
    const scenarios = {} as Record<Scenario, Counts>, sites = {} as Record<Scenario, Sites>, updates: Partial<Record<Scenario, number>> = {}
    for (const streams of [1, 3]) {
      const sessions = pipeline.streamSessions.slice(0, streams)
      const at = new Date().toISOString()
      for (const session of sessions) {
        const thread = pipeline.adapter.state.threads.find(item => item.id === session)!
        pipeline.adapter.log.add(session, { id: `prompt-${streams}`, role: 'user', text: 'Synthetic prompt', createdAt: at }); thread.status = 'running'; pipeline.adapter.mark(session)
        pipeline.adapter.log.add(session, { id: `reply-${streams}`, role: 'assistant', text: 'First', createdAt: at })
      }
      pipeline.adapter.publish(true)
      await pass(SETTLE_MS)
      const { counts, broadcasts, sites: from } = await count(pipeline, async () => {
        for (let chunk = 0; chunk < CHUNKS; chunk++) {
          for (const session of sessions) pipeline.adapter.log.appendText(session, `reply-${streams}`, ` word${chunk}`)
          pipeline.adapter.publish(true)
          await step()
        }
      })
      if (broadcasts < 2) throw new Error(`The stream on ${streams} threads produced no updates to count.`)
      scenarios[`${streams} streaming` as Scenario] = per(counts, broadcasts); updates[`${streams} streaming` as Scenario] = broadcasts
      sites[`${streams} streaming` as Scenario] = Object.fromEntries(Object.entries(from).map(([kind, at]) => [kind, Object.fromEntries(Object.entries(at).map(([where, n]) => [where, Math.round(n / broadcasts * 100) / 100]))]))
      for (const session of sessions) { pipeline.adapter.state.threads.find(item => item.id === session)!.status = 'idle'; pipeline.adapter.mark(session) }
      pipeline.adapter.publish(false)
      await pass(SETTLE_MS)
    }
    for (const [name, action] of Object.entries(pipeline.actions)) {
      const { counts, sites: from } = await count(pipeline, () => until(action()))
      scenarios[name as Scenario] = counts; sites[name as Scenario] = from
    }
    return { threads: pipeline.counts.threads, counts: pipeline.counts, scenarios, sites, updates, threadChanges: pipeline.threadChanges() }
  } finally {
    counter.record = undefined; counter.wholeThreads = Number.POSITIVE_INFINITY
    await until(pipeline.stop())
    // Nothing a stopped pipeline left on the clock may run while the next one is counted.
    vi.clearAllTimers()
  }
}

const NAMES: Record<Kind, string> = {
  copies: 'copies of any size (structuredClone, clonePlainData, cloneHostSnapshot, copyUnshared or copyOver)',
  copiedObjects: 'objects those copies made',
  wholeStateCopies: 'copies of a host\'s whole state (a copy of every thread)',
  wholeCopyThreads: 'threads carried by those whole copies',
  wholeCopyObjects: 'objects those whole copies made',
  unsharedPublications: 'activity snapshots the provider switch copied because they came without the publication mark',
  routerShellBuilds: 'router shell builds (every host\'s threads built again)',
  coordinatorShellBuilds: 'coordinator shell builds',
  threadVisits: 'reads of a thread out of a snapshot\'s or a shell\'s thread list',
  watcherRecordCopies: 'copies of Watcher\'s whole record',
  watcherRecordObjects: 'objects copied out of Watcher\'s record',
  watcherRecordComparisons: 'comparisons of Watcher\'s whole record',
  unwatchedThreadPasses: 'threads Watcher\'s wake-up pass worked through that it does not watch',
  ownerLookups: 'look-ups of an answer\'s thread by the answer-draft store',
  stringifies: 'JSON.stringify calls',
  providerIdParses: 'reads of a provider out of a public model or project ID (how stable filters the providers it holds)',
  schemaErrors: 'schema failures (each builds an error)',
  watcherRoomBuilds: 'builds of Watcher\'s room state',
  watcherRoomRecords: 'records of Watcher\'s history (requests, receipts, earlier Watchers, watched threads\' participations) sent to the window\'s room',
  threadRecordsTouched: 'thread records the layers between the adapter and the coordinator built or walked (the adapter\'s view and copy, the identity wrapper, the provider switch, the workspace\'s accept, the host stamp and its activity publication)',
  adapterChangeRecords: 'thread records and removals the adapter\'s thread changes carried (#925)',
  wrapperChangeRecords: 'thread records and removals the identity wrapper\'s thread changes carried (#925)',
  switchChangeRecords: 'thread records and removals the provider switch\'s thread changes carried (#925)',
  workspaceChangeRecords: 'thread records and removals the workspace\'s thread changes carried (#925)',
  creationReads: 'reads of a thread\'s creation while the workspace took in an update (#925 review: a walk of every creation for each thread merged)',
}
const SCENARIOS = {
  '1 streaming': 'one thread streaming, per update',
  '3 streaming': 'three threads streaming, per update',
  saveAnswerDraft: 'saving an answer draft, per save',
  typeInComposer: 'typing in a composer, per debounced save',
  openThread: 'opening a thread, per open',
  send: 'sending a message, per send',
} as const
type Scenario = keyof typeof SCENARIOS

/**
 * The slack either line allows: a count may be a tenth higher and two more at the larger end. Along the history every
 * count is held flat. Along the threads these may grow in proportion, since an update or an action that carries every
 * thread reads, copies and serializes each one; every other count is held flat there too.
 */
const SLACK = { ratio: 1.1, plus: 2 } as const
/**
 * `workspaceChangeRecords` is here because a read hands the workspace a copy of every activity list, and a thread whose
 * records are in the store (every tenth thread here, ADR-0016's #918 amendment) has them read back from it and let go
 * again after the next save, once for the read and once for the publication taken in whole after it. Each of those is a
 * record that changed, so the read before a send, and the connection the fixture makes between the streams, change that
 * many records. The publication worked out from every thread before #925 found exactly those records changed too; the
 * workspace's thread changes only name them (October 25, 2026, #925 step 4).
 */
const PER_THREAD: ReadonlySet<Kind> = new Set(['copies', 'copiedObjects', 'wholeCopyThreads', 'wholeCopyObjects', 'threadVisits', 'stringifies', 'threadRecordsTouched',
  'workspaceChangeRecords', 'creationReads'])

/**
 * Work that still grows with the history today (#1248), each with what it grows by along the history today, to a
 * thousandth. It may grow that far and no further, with none of the usual slack, and its budget is today's count
 * exactly, so one more fails and the failure names #1248. The pull request that fixes one removes its entry and lowers
 * its budget to the new count.
 *
 * October 22, 2026, with #1327 and #1326 together: Watcher's room no longer copies its records twice for each publish
 * (#1327), so Owl's copied objects grow by 1,896 per streamed update on one thread and 16,026 per send along the history,
 * from 2,968 and 21,386. The workspace stopped copying every thread for each publication (#1326), which took away a part
 * of the copied objects that does not grow with the history, so that growth is a larger share of what is left: 1.766
 * times streaming on one thread, where #1327 alone measured 1.398 and #1326 alone 2.045.
 *
 * October 23, 2026 (#1334): the coordinator's broadcast shell copies what is not threads only when it changed, which takes
 * away more of the copied objects that do not grow with the history. What grows is unchanged, 1,896 per streamed update on
 * one thread and 16,026 per send, and is a larger share again: 1.78 times streaming on one thread.
 *
 * October 23, 2026 (#1450): Watcher's room is built when the window's update goes, at most once a publish window, rather
 * than on every coordinator broadcast, and copied for none of them. Owl's copied objects no longer grow with the history
 * while threads stream or when an answer draft is saved, so those leave the copiedObjects entry, and what is left of it
 * is a command copying Watcher's whole record (#1248). The room's reads of every thread for each watched thread are made
 * on fewer updates, so that entry grows less along the history, and each growth is held to the new figure.
 *
 * October 24, 2026 (#925, step 3): the identity wrapper and the provider switch pass on thread changes, which takes away
 * work that does not grow with the history. What grows is exactly what grew before, and is a larger share of what is
 * left. Owl's reads of a thread still grow by 558 per streamed update on one thread, now 1.133 times, from 1.126 (651 on
 * three, 1.151 from 1.144), and by 4,158 per send, 1.135 times, from 1.139. Owl's copied objects still grow by 6,546 per
 * send, 1.238 times, from 1.164. Serializations still grow by 35 per streamed update on one thread on Owl, 2.36 times,
 * from 1.122 (36 on three, 1.739 from 1.119), by 1,124 per send on Owl, 1.783 times, from 1.499, and by 980 per send on
 * stable, 2.083 times, from 1.517.
 *
 * October 25, 2026 (#925, step 5): the coordinator takes the workspace's thread changes in and the router remakes only
 * the threads a broadcast replaced, which takes away about half of Owl's reads of a thread, none of which grew with the
 * history. What grows grows less: Watcher's room reads every thread for each watched thread as before, but the router no
 * longer reads every thread of the remote host, whose answered threads are part of the history, for the host-update and
 * start-at-boot questions. Owl's reads grow by 468 per streamed update on one thread, from 558, now 1.26 times, from 1.133
 * (561 on three, from 651, 1.293 from 1.151), by 2,326 per answer-draft save, from 2,506 (1.362 from 1.192), by 2,326 per
 * debounced save, from 2,596 (1.505 from 1.272), by 2,332 per thread opened, from 2,602 (1.351 from 1.219), and by 3,618
 * per send, from 4,158 (1.19 from 1.135). Each ratio rises only because what it is a ratio of fell.
 *
 * October 25, 2026 (#925 step 5, review, with main's #1531 merged): the reads that do not grow with the history fell a
 * little further, by 4 to 138 per update or action, and the growth along the history is exactly what it was: 468 per
 * streamed update on one thread, 561 on three, 2,326 per answer-draft save and 3,618 per send. The ratios it is held to
 * rise to 1.261, 1.296, 1.364 and 1.192 for that reason alone; none of them is more work.
 */
const KNOWN_HISTORY_GROWTH: readonly { readonly track: OwnerScaleTrack; readonly kind: Kind; readonly growth: Partial<Record<Scenario, number>>; readonly why: string }[] = [
  { track: 'owl', kind: 'threadVisits', growth: { '1 streaming': 1.261, '3 streaming': 1.296, saveAnswerDraft: 1.364, typeInComposer: 1.505, openThread: 1.351, send: 1.192 },
    why: "Watcher's room reading every thread once for each watched thread, on every room update" },
  { track: 'owl', kind: 'copiedObjects', growth: { typeInComposer: 1.266, openThread: 1.132, send: 1.238 },
    why: "a command copying Watcher's whole record" },
  { track: 'owl', kind: 'stringifies', growth: { '1 streaming': 2.36, '3 streaming': 1.739, typeInComposer: 1.756, openThread: 2.326 },
    why: "Watcher's wake-up pass building each watched thread's keys afresh, about eleven times on every update" },
  { track: 'owl', kind: 'stringifies', growth: { saveAnswerDraft: 2.93 }, why: 'the answer-draft store building a key for every retirement on every save' },
  { track: 'stable', kind: 'stringifies', growth: { saveAnswerDraft: 3.583 }, why: 'the answer-draft store building a key for every retirement on every save' },
  { track: 'stable', kind: 'stringifies', growth: { typeInComposer: 1.429, openThread: 1.632 }, why: 'the answer-recovery pass building a key for every remote retirement' },
  { track: 'owl', kind: 'stringifies', growth: { send: 1.783 }, why: "each save of agents.json checking Watcher's whole record" },
  { track: 'stable', kind: 'stringifies', growth: { send: 2.083 }, why: "each save of agents.json checking Watcher's whole record" },
  { track: 'owl', kind: 'watcherRecordObjects', growth: { typeInComposer: 3.885, openThread: 3.885, send: 3.885 }, why: "a command copying Watcher's whole record" },
]
const known = (track: OwnerScaleTrack, scenario: Scenario, kind: Kind) => KNOWN_HISTORY_GROWTH.find(entry => entry.track === track && entry.kind === kind && entry.growth[scenario] !== undefined)

/**
 * The budgets at the owner's scale, per update or per action: what main does with #1230 and #1231 fixed, with a tenth more
 * room, and today's count exactly for the work #1248 has still to fix (October 20, 2026; docs/perf/2026-10-20-main-lag.md).
 * The counts are the same on every run, so the room is for small changes, not for noise. A change that lowers a count
 * lowers its budget in the same pull request; one that needs a higher budget says why in its pull request.
 *
 * October 22, 2026, with #1327, #1326 and #1330 together: Watcher's room state hands out the record's own records rather
 * than copies (#1327), and the workspace's activity publication copies only the threads that changed (#1326). Every count
 * either lowered has its budget lowered to the combined count, with the usual room, or exactly for #1248's. The reads of
 * a thread are budgeted at today's count exactly. The window's broadcast now works out which thread records changed
 * (#1330, `ThreadRecordsBroadcast.encode`), in one walk of the threads of each broadcast. On stable that costs less than
 * what the three changes removed, so every read budget there is lower than before. On Owl it is 112 more reads per
 * streamed update, 586 more per thread opened and 1,172 more per send than without the three (with #1350's router reuse
 * counted on both sides), the one walk a broadcast needs to tell what changed. It is what buys the window a broadcast about a twentieth the size.
 *
 * October 23, 2026 (#1334): the coordinator's broadcast shell copies what is not threads only where it changed since the
 * last broadcast, where it was two copies of it on every broadcast. The copies and copied objects fall on both tracks, for
 * example from 9.85 to 7.85 copies per streamed update and 136 to 121 per send on Owl, and from 9.58 to 7.58 and 130 to
 * 114 on stable. Those budgets are lowered to the new counts with the usual room, or exactly for #1248's.
 *
 * October 23, 2026 (#1450): two counts are added, the builds of Watcher's room state and the records of Watcher's history
 * (requests, receipts, earlier Watchers and watched threads' participations) sent to the window's room. Before, Owl built
 * the room once for every coordinator broadcast and sent every one of those records with each update: at the owner's
 * scale one room build and 119 records per streamed update on one thread, 620 records per answer-draft save, per
 * keystroke save and per thread opened, and five builds and 930 records per send. Now the room is built when an update
 * goes and the update carries only what changed: 0.38 builds and no records per streamed update, two builds and no
 * records per save or open, three builds and no records per send. The threads that stream were let go by Watcher's
 * earlier requests, so their rows carry that history; a row that changes sends only what changed in it, never its
 * participations again (sent whole, 62 records per streamed update on one thread and 320 per save, growing with the
 * history). The desktop room's copy went with it. Measured with #1334 in, Owl makes one copy fewer per streamed update
 * (6.85, from 7.85), two fewer per action and five fewer per send (116, from 121), and copies 1,729 objects per streamed
 * update on one thread, from 4,329, and 46,635 per send, from 59,635; the room reads 4,996 threads per streamed update,
 * from 6,114, and 34,077 per send, from 37,733. Every count lowered has its budget lowered to the new count with the usual
 * room, or exactly for #1248's. Cursor, the seventh provider (ADR-0128), adds its status and capabilities, two objects,
 * to each whole-state copy a command makes, so Owl's exactly held copied-object counts rise by that and nothing more:
 * 10,702 per debounced save (four copies), 21,619 per open (ten) and 46,665 per send (thirteen copies and their parts).
 *
 * October 24, 2026 (#925, step 1): one count is added, the thread records the layers between the adapter and the
 * coordinator built or walked (`touched`). Every one of those six layers handles every thread on every update, so it is
 * about the threads times the layers: on Owl 1,310 per streamed update on one thread (about 212 each for the adapter, the
 * identity wrapper, the provider switch, the workspace's accept and the host stamp, and 251 for the workspace's
 * publication, per coordinator update), 1,012 per answer-draft save and 5,800 per send, and none when typing or opening a
 * thread; stable does about the same work, shared over one coordinator update fewer while one thread streams. It grows with the threads
 * and not with the history, so it is held in proportion to the threads and budgeted at today's count exactly. Each later
 * step of #925 has its layers pass on only the threads that changed, and lowers it.
 *
 * October 24, 2026 (#925, step 2): every adapter publishes thread changes beside its activity snapshots, and one more count
 * is added, the thread records and removals the adapter's thread changes carry (`adapterChangeRecords`). The fixture's
 * adapter marks the threads it changes, as Claude's does. It is the threads that changed and no more: 0.85 per
 * coordinator update with one thread streaming on Owl and 0.92 on stable (thirty chunks gathered into fewer publications
 * than updates), 2.54 with three, 2 per send (the prompt and the reply) and none for the other actions, the same with a
 * quarter of the threads or of the history. It is held flat along both lines and budgeted at today's count. Nothing in main
 * subscribes to it until the identity wrapper moves onto it in step 3, so the fixture's subscriber stands in for the
 * wrapper and the work of building and applying the changes is left out of every other count. `threadRecordsTouched`
 * does not drop yet: the adapter's snapshot path still runs for the wrapper and every layer above it.
 *
 * October 24, 2026 (#925, step 3): the identity wrapper reads the adapter's thread changes and passes on its own, and the
 * provider switch reads the wrapper's, so nothing in main subscribes to the adapter's or the wrapper's activity snapshots
 * any more. The adapter's change publication is now main's own work and is counted (the fixture no longer leaves it out),
 * and the adapter and the wrapper count, as the records they touched, the records their changes carried. Two counts are
 * added, the records and removals the wrapper's and the switch's thread changes carry (`wrapperChangeRecords`,
 * `switchChangeRecords`): the threads that changed and no more, the same as the adapter's on every scenario, flat along
 * both lines, and budgeted at today's count. Only the fixture reads the switch's until the workspace does in step 4, but
 * building them is counted as main's work all the same, so a cost they add shows before it is real; it moved no count
 * here. A provider connecting with every thread new is not a scenario here; `hostThreadChanges.test.ts` holds the work of
 * building that publication in proportion to the threads. Measured, on Owl at the owner's scale:
 * - `threadRecordsTouched` falls from 1,310 to 889 per streamed update on one thread, 1,317 to 899 on three, and 5,800 to
 *   4,299 per send (stable 1,396 to 939, 1,315 to 897 and 5,786 to 4,286). The adapter and the wrapper touch about one
 *   record an update where each touched 212. The switch still walks its threads once (212) to build the snapshot the
 *   workspace reads until step 4, but builds no record for it: each thread is the record it named once for the
 *   provider's record. Budgeted at the new counts exactly.
 * - The adapter's copy of its whole view for its activity subscribers went with them: no whole-state copy while threads
 *   stream (0.85 an update before), and copied objects fall from 1,731 to 20 per streamed update on one thread, 1,824 to
 *   114 on three and 46,665 to 34,094 per send (stable 2,141 to 288, 2,069 to 360 and 49,584 to 40,221). The wrapper no
 *   longer binds every thread's ID on every update, two JSON keys each, so serializations fall from 483 to 61 per streamed
 *   update on one thread and 3,550 to 2,561 per send (stable 468 to 12 and 2,876 to 1,885). The reads of a thread fall
 *   from 4,996 to 4,785 per streamed update on one thread (stable 3,557 to 3,328), the adapter's view no longer read.
 *   Every count lowered has its budget lowered to the new count with the usual room, or exactly for #1248's and the reads.
 * - Two budgets rise: the reads of a thread per send, from 34,077 to 35,117 on Owl and from 24,664 to 24,944 on stable,
 *   one more workspace publication per send that the coordinator, Watcher and the trackers each read every thread of.
 *   The switch now takes a read's records in over the ones it holds, sharing every activity list that did not change,
 *   where it kept the read's own copies until the next publication. So an idle thread's activity stays in the
 *   workspace's store between publications, as it does in the app, where an adapter's reads hand back its own certified
 *   lists; before, the fixture's reads handed back copies, and every thread's list came back into memory on the read
 *   before each send. Now that read, a copy of the caller's own as every command's reply is, brings the stored lists back
 *   and publishes once. The extra publication is what the app already does; the fixture stopped hiding it.
 * - Copies stay within their budgets: 2.69 per streamed update on one thread on Owl, from 2.62, and 95 per send on stable,
 *   from 94. Each update's one copy of the adapter's changed records replaces its copy of the whole view.
 * The streaming adapter's reads are now built as Claude's adapter builds them: a snapshot carries each watched thread's
 * messages and every other thread's summary, and a thread read for a subscriber that keeps history from events is the
 * activity view. A read no longer differs from the activity records in every thread, which made every send look like a
 * change to all of them.
 *
 * October 25, 2026 (#925, step 4): the workspace takes in the provider switch's thread changes, merging only the threads
 * they name and the threads its own commands changed, and builds its activity publication from a thread map, reading
 * again only the threads marked since the last. Nothing in main reads the switch's activity snapshot any more, so the
 * switch no longer builds it on each update, and the fixture's own subscriber to the switch's changes went: the
 * workspace's subscription is shadowed and counted instead, the switch now counting the records its changes carry. One
 * count is added, the records and removals the workspace's own thread changes carry (`workspaceChangeRecords`), which
 * nothing in main reads until the coordinator does in step 5; building them is counted as main's work, and only the
 * fixture's subscriber is left out. It follows the threads with stored activity a read brings back, so it may grow in
 * proportion to the threads (`PER_THREAD`); it is budgeted at today's count exactly. The workspace's accept counts the
 * threads it took in, the host stamp the threads it stamped and the publication the threads it read again. Measured
 * against the revision before, on Owl at the owner's scale:
 * - `threadRecordsTouched` falls from 889 to 10.77 per streamed update on one thread and from 4,299 to 2,103 per send
 *   (stable 939 to 11.58, and 4,286 to 2,097), and from 1,012 to 4 per answer-draft save. On three threads it falls from
 *   899 to 80.62: the connection the fixture makes between the two streams is a read, so the first publication after
 *   it is taken in whole (212 for the accept and as many stamped) and worked out from every thread (251). The same holds
 *   for the read before every send, which is most of what is left there.
 * - Copies fall from 2.69 to 1.85 per streamed update on one thread, 6.62 to 5.85 on three and 96 to 94 per send
 *   (stable 3.08 to 2.17, 6.69 to 5.92 and 95 to 93), and copied objects from 19.62 to 6.92, 114 to 102 and 34,094 to
 *   34,064 (stable 287.5 to 273.75, 360 to 348 and 40,221 to 40,191).
 * Every count lowered has its budget lowered to the new count with the usual room, or exactly for #925's and #1248's.
 * Nothing else moved, and no budget rises.
 *
 * October 25, 2026 (#925 step 4, review): every thread on this computer was made in Sotto, so the fixture now gives each
 * the started creation the workspace keeps for as long as the thread, newest last, as the owner's are. One count is
 * added, the reads of a creation's thread while the workspace takes in an update (`creationReads`). An accept looked up
 * each merged thread's creation by walking them all, which this branch's step 4 left on every update: with the walk,
 * 442 reads per streamed update on one thread and 66,997 per send at the owner's scale on Owl, growing about sixteen
 * times for four times the threads, which this test now fails. The creations are indexed by thread: 2.69 per streamed
 * update and 525 per send, in proportion to the threads, as a whole accept reads each thread once (`PER_THREAD`), and
 * budgeted at today's count exactly. One budget rises, Owl's copied objects per send, from 34,064 to 34,314: the read
 * before each send has always copied the project aliases and creations to tell whether it changed anything
 * (`refreshThread`), and the fixture held no creations for it to copy until now. No code here changed to cause it.
 *
 * October 25, 2026 (#925, step 5): the coordinator subscribes to the workspace's thread changes, and usage too, so nothing
 * in main reads the workspace's activity snapshot and the workspace no longer builds one on each publish. An ordinary
 * change is shown, tracked and listed again only for the threads it names; the coordinator's finish and failure tracking,
 * its outbox and draft checks and the broadcast's thread records read only those, and its look-ups of a thread are by an
 * index rather than a walk of the list. The router remakes only the threads a broadcast replaced in place, and answers
 * each host's threads from what its last publication made of them. The coordinator's thread list is counted like every
 * shown snapshot's (`hostThreadList`), and its checks in the verifying mode are left out. Measured against the revision
 * before, at the owner's scale, only the reads of a thread moved: on Owl from 4,785 to 2,268 per streamed update on one
 * thread, 4,973 to 2,479 on three, 15,593 to 8,752 per answer-draft save, 12,148 to 6,935 per debounced save, 14,490 to
 * 8,993 per thread opened and 35,117 to 22,693 per send; on stable from 3,328 to 1,577, 3,383 to 1,641, 8,926 to 3,684,
 * 9,855 to 6,789, 13,172 to 9,803 and 24,944 to 16,012. What is left on Owl is mostly Watcher's passes, which still read
 * every thread on every update, and the window's encoder, which step 6 feeds the changed records. Copies, serializations
 * and shell builds do not move: the coordinator's path made none per thread, and there is one shell build per broadcast.
 * Every reads budget is lowered to the new count exactly. No budget rises. With the review's fixes and main's #1531 merged,
 * the reads fell a little further (on Owl to 2,264 per streamed update on one thread, 2,458 on three, 8,727 per
 * answer-draft save and 22,555 per send; on stable to 1,573, 1,620, 3,664 and 15,874), and those budgets are lowered too.
 */
const BUDGET: Record<OwnerScaleTrack, Record<Scenario, Counts>> = {
  owl: {
    '1 streaming': { copies: 2.04, copiedObjects: 7.61, wholeStateCopies: 0, wholeCopyThreads: 0, wholeCopyObjects: 0, unsharedPublications: 0, routerShellBuilds: 2, coordinatorShellBuilds: 2, threadVisits: 2263.92, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 0, stringifies: 61.15, providerIdParses: 0, schemaErrors: 0, watcherRoomBuilds: 0.42, watcherRoomRecords: 0, threadRecordsTouched: 10.77, adapterChangeRecords: 0.85, wrapperChangeRecords: 0.85, switchChangeRecords: 0.85, workspaceChangeRecords: 0.92, creationReads: 2.69 },
    '3 streaming': { copies: 6.44, copiedObjects: 111.69, wholeStateCopies: 0, wholeCopyThreads: 0, wholeCopyObjects: 0, unsharedPublications: 0, routerShellBuilds: 2, coordinatorShellBuilds: 2, threadVisits: 2458.08, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 0, stringifies: 84.77, providerIdParses: 0, schemaErrors: 0, watcherRoomBuilds: 0.51, watcherRoomRecords: 0, threadRecordsTouched: 80.62, adapterChangeRecords: 2.54, wrapperChangeRecords: 2.54, switchChangeRecords: 2.54, workspaceChangeRecords: 6.46, creationReads: 23.38 },
    saveAnswerDraft: { copies: 9.9, copiedObjects: 57.2, wholeStateCopies: 0, wholeCopyThreads: 0, wholeCopyObjects: 0, unsharedPublications: 0, routerShellBuilds: 3, coordinatorShellBuilds: 3, threadVisits: 8727, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 5, stringifies: 961, providerIdParses: 0, schemaErrors: 0, watcherRoomBuilds: 2.2, watcherRoomRecords: 0, threadRecordsTouched: 4, adapterChangeRecords: 0, wrapperChangeRecords: 0, switchChangeRecords: 0, workspaceChangeRecords: 4, creationReads: 0 },
    typeInComposer: { copies: 12.1, copiedObjects: 10_702, wholeStateCopies: 5, wholeCopyThreads: 879, wholeCopyObjects: 8558, unsharedPublications: 0, routerShellBuilds: 5, coordinatorShellBuilds: 7, threadVisits: 6935, watcherRecordCopies: 3, watcherRecordObjects: 2898, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 2, stringifies: 172, providerIdParses: 0, schemaErrors: 0, watcherRoomBuilds: 2.2, watcherRoomRecords: 0, threadRecordsTouched: 0, adapterChangeRecords: 0, wrapperChangeRecords: 0, switchChangeRecords: 0, workspaceChangeRecords: 0, creationReads: 0 },
    openThread: { copies: 23.1, copiedObjects: 21_619, wholeStateCopies: 11, wholeCopyThreads: 1846, wholeCopyObjects: 20545.8, unsharedPublications: 0, routerShellBuilds: 7, coordinatorShellBuilds: 10, threadVisits: 8993, watcherRecordCopies: 3, watcherRecordObjects: 2898, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 3, stringifies: 193, providerIdParses: 0, schemaErrors: 0, watcherRoomBuilds: 2.2, watcherRoomRecords: 0, threadRecordsTouched: 0, adapterChangeRecords: 0, wrapperChangeRecords: 0, switchChangeRecords: 0, workspaceChangeRecords: 0, creationReads: 0 },
    send: { copies: 103.4, copiedObjects: 34_314, wholeStateCopies: 11, wholeCopyThreads: 2544.3, wholeCopyObjects: 26647.5, unsharedPublications: 0, routerShellBuilds: 8, coordinatorShellBuilds: 14, threadVisits: 22_555, watcherRecordCopies: 7, watcherRecordObjects: 8694, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 3, stringifies: 2561, providerIdParses: 0, schemaErrors: 0, watcherRoomBuilds: 3.3, watcherRoomRecords: 0, threadRecordsTouched: 2103, adapterChangeRecords: 2, wrapperChangeRecords: 2, switchChangeRecords: 2, workspaceChangeRecords: 54, creationReads: 525 },
  },
  stable: {
    '1 streaming': { copies: 2.39, copiedObjects: 301.12, wholeStateCopies: 0, wholeCopyThreads: 0, wholeCopyObjects: 0, unsharedPublications: 0, routerShellBuilds: 2, coordinatorShellBuilds: 2, threadVisits: 1572.67, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 0, stringifies: 13.02, providerIdParses: 5, schemaErrors: 0, watcherRoomBuilds: 0, watcherRoomRecords: 0, threadRecordsTouched: 11.58, adapterChangeRecords: 0.92, wrapperChangeRecords: 0.92, switchChangeRecords: 0.92, workspaceChangeRecords: 1, creationReads: 2.92 },
    '3 streaming': { copies: 6.51, copiedObjects: 382.89, wholeStateCopies: 0, wholeCopyThreads: 0, wholeCopyObjects: 0, unsharedPublications: 0, routerShellBuilds: 2, coordinatorShellBuilds: 2, threadVisits: 1620.15, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 0, stringifies: 26.32, providerIdParses: 5, schemaErrors: 0, watcherRoomBuilds: 0, watcherRoomRecords: 0, threadRecordsTouched: 80.15, adapterChangeRecords: 2.54, wrapperChangeRecords: 2.54, switchChangeRecords: 2.54, workspaceChangeRecords: 6.46, creationReads: 23.38 },
    saveAnswerDraft: { copies: 14.3, copiedObjects: 14149.3, wholeStateCopies: 0, wholeCopyThreads: 0, wholeCopyObjects: 0, unsharedPublications: 0, routerShellBuilds: 3, coordinatorShellBuilds: 3, threadVisits: 3664, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 5, stringifies: 824, providerIdParses: 9, schemaErrors: 0, watcherRoomBuilds: 0, watcherRoomRecords: 0, threadRecordsTouched: 4, adapterChangeRecords: 0, wrapperChangeRecords: 0, switchChangeRecords: 0, workspaceChangeRecords: 4, creationReads: 0 },
    typeInComposer: { copies: 11, copiedObjects: 10811.9, wholeStateCopies: 6, wholeCopyThreads: 1153, wholeCopyObjects: 10794.3, unsharedPublications: 0, routerShellBuilds: 5, coordinatorShellBuilds: 8, threadVisits: 6789, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 2, stringifies: 20, providerIdParses: 18, schemaErrors: 0, watcherRoomBuilds: 0, watcherRoomRecords: 0, threadRecordsTouched: 0, adapterChangeRecords: 0, wrapperChangeRecords: 0, switchChangeRecords: 0, workspaceChangeRecords: 0, creationReads: 0 },
    openThread: { copies: 22, copiedObjects: 22766.7, wholeStateCopies: 13, wholeCopyThreads: 2117, wholeCopyObjects: 22741.4, unsharedPublications: 0, routerShellBuilds: 7, coordinatorShellBuilds: 11, threadVisits: 9803, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 3, stringifies: 31, providerIdParses: 27, schemaErrors: 0, watcherRoomBuilds: 0, watcherRoomRecords: 0, threadRecordsTouched: 0, adapterChangeRecords: 0, wrapperChangeRecords: 0, switchChangeRecords: 0, workspaceChangeRecords: 0, creationReads: 0 },
    send: { copies: 102.3, copiedObjects: 44210.1, wholeStateCopies: 12.1, wholeCopyThreads: 2813.8, wholeCopyObjects: 28846.4, unsharedPublications: 0, routerShellBuilds: 8, coordinatorShellBuilds: 15, threadVisits: 15_874, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 3, stringifies: 1885, providerIdParses: 31, schemaErrors: 0, watcherRoomBuilds: 0, watcherRoomRecords: 0, threadRecordsTouched: 2097, adapterChangeRecords: 2, wrapperChangeRecords: 2, switchChangeRecords: 2, workspaceChangeRecords: 54, creationReads: 525 },
  },
}

const SHAPES = {
  /** A quarter of the owner's history, with all of their threads. */
  quarterHistory: { threads: 1, history: 0.25 },
  owner: { threads: 1, history: 1 },
  /** A quarter of the owner's threads, with all of their history. */
  quarterThreads: { threads: 0.25, history: 1 },
} as const satisfies Record<string, OwnerScale>
const TRACKS = ['owl', 'stable'] as const satisfies readonly OwnerScaleTrack[]
const measured = {} as Record<OwnerScaleTrack, Record<keyof typeof SHAPES, Measured>>

const nativeClone = globalThis.structuredClone, nativeStringify = JSON.stringify
const proto = { control: AgentControl.prototype as unknown as { shellOf(shareThreads: boolean): AgentState; shownSnapshot(snapshot: AgentHostSnapshot, gone?: Set<string>): AgentHostSnapshot
    hostThreadList(list: AgentThread[]): AgentThread[]; verifyChanges(...args: unknown[]): void; verifyBroadcast(...args: unknown[]): void },
  router: DesktopHostRouter.prototype as unknown as { build(...args: unknown[]): AgentState }, watcher: WatcherService.prototype,
  // The layers whose thread records are counted (`touched`).
  subscribers: ActivitySubscribers.prototype,
  wrapper: SottoThreadHost.prototype as unknown as { mapSnapshot(snapshot: AgentHostSnapshot): AgentHostSnapshot },
  providerSwitch: ConfiguredProviderHost.prototype as unknown as { aggregate(): AgentHostSnapshot },
  workspace: WorkspaceHost.prototype as unknown as { accept(snapshot: AgentHostSnapshot, fromPublication?: boolean): void
    acceptThreads(changes: unknown): { handled: number; opening: boolean }; refreshPublished(): number } }
const native = { shellOf: proto.control.shellOf, shownSnapshot: proto.control.shownSnapshot, hostThreadList: proto.control.hostThreadList,
  verifyChanges: proto.control.verifyChanges, verifyBroadcast: proto.control.verifyBroadcast, build: proto.router.build, state: proto.watcher.state,
  publish: proto.subscribers.publish, mapSnapshot: proto.wrapper.mapSnapshot, aggregate: proto.providerSwitch.aggregate, accept: proto.workspace.accept,
  acceptThreads: proto.workspace.acceptThreads, refreshPublished: proto.workspace.refreshPublished }
let schemaError: ((issue: never) => unknown) | undefined

beforeAll(async () => {
  // Every copier, the serializer and the shell builders are counted; the coordinator's snapshot and every shell it builds
  // carry a counted thread list, as the adapter's and the remote host's do (`threadVisits.ts`).
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => { const copy = nativeClone(visits.uncounted(value), options); copied(value, copy); return copy }) as typeof structuredClone
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => { bump('stringifies'); return nativeStringify(...args) }) as typeof JSON.stringify
  proto.control.shellOf = function (this: unknown, shareThreads: boolean) {
    bump('coordinatorShellBuilds')
    const state = native.shellOf.call(this, shareThreads)
    state.host.threads = visits.countedThreads(state.host.threads)
    return state
  }
  proto.control.shownSnapshot = function (this: unknown, snapshot: AgentHostSnapshot, gone?: Set<string>) {
    const shown = native.shownSnapshot.call(this, snapshot, gone)
    return { ...shown, threads: visits.countedThreads(shown.threads) }
  }
  // The host snapshot an accept of thread changes makes carries a counted list too, as one a whole accept shows does (#925).
  proto.control.hostThreadList = function (this: unknown, list: AgentThread[]) { return visits.countedThreads(native.hostThreadList.call(this, list)) }
  // The coordinator's own checks in the verifying mode are left out of every count, as the shadows' are.
  proto.control.verifyChanges = function (this: unknown, ...args: unknown[]) { uncounted(() => native.verifyChanges.apply(this, args)) }
  proto.control.verifyBroadcast = function (this: unknown, ...args: unknown[]) { uncounted(() => native.verifyBroadcast.apply(this, args)) }
  if (SITES) visits.threadVisits.visited = () => { const at = site(), sites = counter.sites.threadVisits ??= {}; sites[at] = (sites[at] ?? 0) + 1 }
  // What the router publishes carries a counted thread list too: the broadcaster, the busy checks and the answer-recovery
  // pass read it.
  proto.router.build = function (this: unknown, ...args: unknown[]) {
    bump('routerShellBuilds')
    const state = native.build.apply(this, args)
    state.host.threads = visits.countedThreads(state.host.threads)
    return state
  }
  // Every build of Watcher's room, for the window, a phone, a read or Watcher's own tools.
  proto.watcher.state = function (this: WatcherService) { bump('watcherRoomBuilds'); return native.state.call(this) }
  // Each layer between the adapter and the coordinator, where it hands on its threads (#925).
  for (const [layer, method] of [['ActivitySubscribers.publish', native.publish], ['SottoThreadHost.mapSnapshot', native.mapSnapshot],
    ['ConfiguredProviderHost.aggregate', native.aggregate], ['WorkspaceHost.accept', native.accept], ['WorkspaceHost.acceptThreads', native.acceptThreads],
    ['WorkspaceHost.refreshPublished', native.refreshPublished]] as const) {
    if (typeof method !== 'function') throw new Error(`${layer} is gone; count the thread records that layer touches for an update another way.`)
  }
  // A detached publication is the provider switch's aggregate, counted where it is built; any other is an adapter's view.
  proto.subscribers.publish = function (this: ActivitySubscribers, view: (historyFromEvents: boolean) => AgentHostSnapshot, detached?: boolean) {
    native.publish.call(this, detached ? view : historyFromEvents => { const snapshot = view(historyFromEvents); touched('adapter', snapshot); return snapshot }, detached)
  }
  proto.wrapper.mapSnapshot = function (this: unknown, snapshot: AgentHostSnapshot) { const mapped = native.mapSnapshot.call(this, snapshot); touched('identity wrapper', mapped); return mapped }
  proto.providerSwitch.aggregate = function (this: unknown) { const snapshot = native.aggregate.call(this); touched('provider switch', snapshot); return snapshot }
  proto.workspace.accept = function (this: { state: { snapshot: AgentHostSnapshot } }, snapshot: AgentHostSnapshot, fromPublication?: boolean) {
    counter.accepting++
    try { native.accept.call(this, snapshot, fromPublication) } finally { counter.accepting-- }
    touched('workspace accept', this.state.snapshot)
  }
  proto.workspace.acceptThreads = function (this: unknown, changes: unknown) {
    counter.accepting++
    let result: { handled: number; opening: boolean }
    try { result = native.acceptThreads.call(this, changes) } finally { counter.accepting-- }
    bump('threadRecordsTouched', result.handled, 'workspace accept'); return result
  }
  // The publication counts the threads it read again, none when nothing was marked, which still names the layer as run.
  proto.workspace.refreshPublished = function (this: unknown) { const read = native.refreshPublished.call(this); bump('threadRecordsTouched', read, 'workspace publication'); return read }
  schemaError = z.config().customError as typeof schemaError
  z.config({ customError: issue => { bump('schemaErrors'); return schemaError?.(issue as never) as string | undefined } })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
  for (const track of TRACKS) {
    measured[track] = {} as Record<keyof typeof SHAPES, Measured>
    for (const [name, shape] of Object.entries(SHAPES)) measured[track][name as keyof typeof SHAPES] = await measure(track, shape)
  }
  if (process.env.SOTTO_PERF_BENCH === '1') console.log(`Owner-scale work budget: ${nativeStringify(measured)}`)
}, 600_000)

afterAll(async () => {
  vi.useRealTimers()
  globalThis.structuredClone = nativeClone; JSON.stringify = nativeStringify
  visits.threadVisits.visited = undefined
  proto.control.shellOf = native.shellOf; proto.control.shownSnapshot = native.shownSnapshot; proto.control.hostThreadList = native.hostThreadList
  proto.control.verifyChanges = native.verifyChanges; proto.control.verifyBroadcast = native.verifyBroadcast; proto.router.build = native.build; proto.watcher.state = native.state
  proto.subscribers.publish = native.publish; proto.wrapper.mapSnapshot = native.mapSnapshot; proto.providerSwitch.aggregate = native.aggregate
  proto.workspace.accept = native.accept; proto.workspace.acceptThreads = native.acceptThreads; proto.workspace.refreshPublished = native.refreshPublished
  z.config({ customError: schemaError as never })
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

const show = (counts: Counts): string => nativeStringify(counts)
/** With `SOTTO_WORK_SITES=1`, the places whose count of `kind` grew most between two measurements. */
function grewAt(kind: Kind, small: Sites | undefined, large: Sites | undefined): string {
  if (!SITES || !SITED.has(kind)) return ''
  const before = small?.[kind] ?? {}, after = large?.[kind] ?? {}
  const most = Object.entries(after).map(([at, n]) => [at, n - (before[at] ?? 0)] as const).filter(([, more]) => more > 0).sort((a, b) => b[1] - a[1]).slice(0, 3)
  return most.length ? ` (most at ${most.map(([at, more]) => `${at} +${Math.round(more)}`).join(', ')})` : ''
}
/** The layers `touched` counts, and which of them each scenario must run: a hook that stops running would read as no work. */
const LAYERS = ['adapter', 'identity wrapper', 'provider switch', 'workspace accept', 'host stamp', 'workspace publication'] as const
/** The workspace's accepted state and its activity publication, which the verifying mode also shadows through the shim. */
const SHADOWED = ['workspace accept', 'workspace publication'] as const
const LAYERS_RUN: Record<Scenario, readonly string[]> = { '1 streaming': LAYERS, '3 streaming': LAYERS, send: LAYERS,
  saveAnswerDraft: ['workspace publication'], typeInComposer: [], openThread: [] }
const WHERE = SITES ? '' : ' Run it with SOTTO_WORK_SITES=1 to see where the serializations, thread visits and copied objects that grew come from.'

describe.each(TRACKS)('main\'s work at the owner\'s scale on %s (#1232)', track => {
  it('builds the owner\'s world', () => {
    expect(measured[track].owner.counts).toMatchObject({ threads: 250, remoteThreads: 40, retirements: 256, remoteRetirements: 40, operations: 150, requests: 160, watches: 5 })
    expect(measured[track].quarterHistory.counts).toMatchObject({ threads: 250, remoteThreads: 10, retirements: 64, operations: 38, requests: 40 })
    expect(measured[track].quarterThreads.counts).toMatchObject({ threads: 63, remoteThreads: 40, retirements: 256, operations: 150, requests: 160 })
  })
  // With SOTTO_VERIFY_THREAD_CHANGES=1, every layer's publications are worked into thread changes and applied to a shadow
  // map that is checked against the layer's whole snapshot after every change, through every scenario at every shape.
  it.runIf(verifyingThreadChanges())('keeps every layer\'s thread map equal to its whole snapshot after every change (#925)', () => {
    for (const [shape, { threadChanges }] of Object.entries(measured[track])) {
      expect.soft(threadChanges.drift, `On ${track} at ${shape}, a thread map came to differ from its layer's whole snapshot.`).toEqual([])
      // The adapter's own thread changes, as well as what the shim works out from each layer's snapshots.
      for (const layer of [...SHADOWED, 'adapter changes', 'identity wrapper changes', 'provider switch changes', 'provider switch slot', 'workspace changes', 'coordinator changes']) {
        expect.soft(threadChanges.checked[layer] ?? 0, `On ${track} at ${shape}, the ${layer}'s thread map checked no change.`).toBeGreaterThan(0)
      }
    }
  })
  it.each(Object.keys(SCENARIOS) as Scenario[])('%s: flat with the history, in proportion to the threads, and within its budget', scenario => {
    const { quarterHistory, owner, quarterThreads } = measured[track]
    const few = quarterHistory.scenarios[scenario], all = owner.scenarios[scenario], fewThreads = quarterThreads.scenarios[scenario]
    const what = `On ${track}, ${SCENARIOS[scenario]}`
    const history = KINDS.flatMap(kind => {
      const held = known(track, scenario, kind), growth = held?.growth[scenario]
      if (all[kind] <= (growth === undefined ? few[kind] * SLACK.ratio + SLACK.plus : few[kind] * growth)) return []
      return [`${NAMES[kind]} grew from ${few[kind]} to ${all[kind]}${held ? `, more than the ${growth} times #1248 holds it to for ${held.why}` : ''}${grewAt(kind, quarterHistory.sites[scenario], owner.sites[scenario])}`]
    })
    // All three checks report, so a failure names everything that grew, along either line and against the budget.
    expect.soft(history, `${what}, the work grew with the history (the owner's ${owner.threads} threads on this computer held, a quarter of their history ${show(few)}, all of it ${show(all)}): ${history.join('; ')}. Do work bounded by what changed, and read state without copying it.${WHERE}`).toEqual([])
    const ratio = owner.threads / quarterThreads.threads
    const threads = KINDS.flatMap(kind => {
      const allowed = (PER_THREAD.has(kind) ? fewThreads[kind] * ratio : fewThreads[kind]) * SLACK.ratio + SLACK.plus
      if (all[kind] <= allowed) return []
      return [`${NAMES[kind]} grew ${PER_THREAD.has(kind) ? 'faster than' : 'with'} the threads, from ${fewThreads[kind]} with ${quarterThreads.threads} threads to ${all[kind]} with ${owner.threads}${grewAt(kind, quarterThreads.sites[scenario], owner.sites[scenario])}`]
    })
    expect.soft(threads, `${what}, the work grew faster than the threads (the owner's history held, ${quarterThreads.threads} threads ${show(fewThreads)}, ${owner.threads} threads ${show(all)}): ${threads.join('; ')}. Work per thread must not depend on how many threads there are.${WHERE}`).toEqual([])
    const budget = BUDGET[track]?.[scenario]
    const over = budget ? KINDS.filter(kind => all[kind] > budget[kind]).map(kind => {
      const held = known(track, scenario, kind)
      return `${NAMES[kind]}: ${all[kind]}, budget ${budget[kind]}${held ? ` (today's count, held there until #1248 stops ${held.why})` : ''}`
    }) : ['no budget']
    expect.soft(over, `${what}, at the owner's scale the work is over its budget (${show(all)}): ${over.join('; ')}.`).toEqual([])
    for (const [shape, { sites }] of Object.entries(measured[track])) {
      const ran = Object.keys(sites[scenario].threadRecordsTouched ?? {}).sort()
      expect.soft(ran, `${what} at ${shape}, the layers whose thread records were counted are not the ones this scenario runs. A hook that no longer runs reads as no work; count that layer where it now hands on its threads.`)
        .toEqual([...LAYERS_RUN[scenario]].sort())
    }
  })
})
