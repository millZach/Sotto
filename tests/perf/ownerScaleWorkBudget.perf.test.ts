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
import { AgentControl } from '../../src/main/agents/control'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import type { AgentHostSnapshot, AgentState } from '../../src/shared/agents'
import type { WatcherThreadTarget } from '../../src/shared/watcher'
import { ownerScalePipeline, type OwnerScalePipeline, type OwnerScaleTrack } from '../fixtures/ownerScalePipeline'
import type { OwnerScale } from '../fixtures/ownerScale'

/** The kinds of work counted. Each is per update while streaming, and per action for the user's actions. */
const KINDS = ['copies', 'copiedObjects', 'wholeStateCopies', 'wholeCopyThreads', 'wholeCopyObjects', 'unsharedPublications', 'routerShellBuilds',
  'coordinatorShellBuilds', 'threadVisits', 'watcherRecordCopies', 'watcherRecordObjects', 'watcherRecordComparisons', 'unwatchedThreadPasses', 'ownerLookups',
  'stringifies', 'providerIdParses', 'schemaErrors'] as const
type Kind = typeof KINDS[number]
type Counts = Record<Kind, number>

const counter = vi.hoisted(() => ({ measuring: false, wholeThreads: Number.POSITIVE_INFINITY, record: undefined as (() => unknown) | undefined,
  tally: {} as Record<string, number>, sites: {} as Record<string, Record<string, number>> }))
/**
 * With `SOTTO_WORK_SITES=1`, where each serialization, each thread visit and each copied object came from: the nearest
 * frame in `src/`. It is slow, and is for finding what grew; a failure then names the places whose counts grew most.
 */
const SITES = vi.hoisted(() => process.env.SOTTO_WORK_SITES === '1')
const SITED = vi.hoisted(() => new Set<string>(['stringifies', 'threadVisits', 'copiedObjects']))
const site = vi.hoisted(() => (): string => {
  const frame = new Error().stack?.split('\n').find(line => /[\\/]src[\\/]/u.test(line))
  return frame?.trim().replace(/^at /u, '').replace(/(^|\()[^()]*?[\\/]src[\\/]/u, '$1src/').replace(/\\/gu, '/') ?? 'outside src/'
})
const bump = vi.hoisted(() => (kind: string, by = 1): void => {
  if (!counter.measuring) return
  counter.tally[kind] = (counter.tally[kind] ?? 0) + by
  if (SITES && SITED.has(kind)) { const at = site(), sites = counter.sites[kind] ??= {}; sites[at] = (sites[at] ?? 0) + by }
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
  return { counts: { ...zero(), ...counter.tally, ownerLookups: pipeline.ownerLookups(), threadVisits: visits.threadVisits.count } as Counts, broadcasts: pipeline.broadcasts(), sites: counter.sites }
}

const per = (counts: Counts, by: number): Counts => Object.fromEntries(KINDS.map(kind => [kind, Math.round(counts[kind] / Math.max(1, by) * 100) / 100])) as Counts

const CHUNKS = 30
interface Measured { threads: number; counts: Record<string, number>; scenarios: Record<Scenario, Counts>; sites: Record<Scenario, Sites>; updates: Partial<Record<Scenario, number>> }

/** Builds main on `track` at `shape` of the owner's world and counts each scenario. */
async function measure(track: OwnerScaleTrack, shape: OwnerScale): Promise<Measured> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-owner-scale-')); roots.push(root)
  const pipeline = await until(ownerScalePipeline(root, shape, 3, track))
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
        pipeline.adapter.log.add(session, { id: `prompt-${streams}`, role: 'user', text: 'Synthetic prompt', createdAt: at }); thread.status = 'running'
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
      for (const session of sessions) pipeline.adapter.state.threads.find(item => item.id === session)!.status = 'idle'
      pipeline.adapter.publish(false)
      await pass(SETTLE_MS)
    }
    for (const [name, action] of Object.entries(pipeline.actions)) {
      const { counts, sites: from } = await count(pipeline, () => until(action()))
      scenarios[name as Scenario] = counts; sites[name as Scenario] = from
    }
    return { threads: pipeline.counts.threads, counts: pipeline.counts, scenarios, sites, updates }
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
const PER_THREAD: ReadonlySet<Kind> = new Set(['copies', 'copiedObjects', 'wholeCopyThreads', 'wholeCopyObjects', 'threadVisits', 'stringifies'])

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
 */
const KNOWN_HISTORY_GROWTH: readonly { readonly track: OwnerScaleTrack; readonly kind: Kind; readonly growth: Partial<Record<Scenario, number>>; readonly why: string }[] = [
  { track: 'owl', kind: 'threadVisits', growth: { '1 streaming': 1.256, '3 streaming': 1.258, saveAnswerDraft: 1.2, typeInComposer: 1.29, openThread: 1.232, send: 1.209 },
    why: "Watcher's room reading every thread once for each watched thread, on every room update" },
  { track: 'owl', kind: 'copiedObjects', growth: { '1 streaming': 1.766, '3 streaming': 1.738, saveAnswerDraft: 3.447, typeInComposer: 1.604, openThread: 1.306, send: 1.366 },
    why: "the desktop Watcher room copying the requests, operations and watches in each room it holds for its publish window, and a command copying Watcher's whole record" },
  { track: 'owl', kind: 'stringifies', growth: { '1 streaming': 1.122, '3 streaming': 1.119, typeInComposer: 1.756, openThread: 2.326 },
    why: "Watcher's wake-up pass building each watched thread's keys afresh, about eleven times on every update" },
  { track: 'owl', kind: 'stringifies', growth: { saveAnswerDraft: 2.93 }, why: 'the answer-draft store building a key for every retirement on every save' },
  { track: 'stable', kind: 'stringifies', growth: { saveAnswerDraft: 3.583 }, why: 'the answer-draft store building a key for every retirement on every save' },
  { track: 'stable', kind: 'stringifies', growth: { typeInComposer: 1.429, openThread: 1.632 }, why: 'the answer-recovery pass building a key for every remote retirement' },
  { track: 'owl', kind: 'stringifies', growth: { send: 1.499 }, why: "each save of agents.json checking Watcher's whole record" },
  { track: 'stable', kind: 'stringifies', growth: { send: 1.517 }, why: "each save of agents.json checking Watcher's whole record" },
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
 * streamed update, 586 more per thread opened and 1,172 more per send than before the three, the one walk a broadcast
 * needs to tell what changed. It is what buys the window a broadcast about a twentieth the size.
 */
const BUDGET: Record<OwnerScaleTrack, Record<Scenario, Counts>> = {
  owl: {
    '1 streaming': { copies: 10.84, copiedObjects: 4371.77, wholeStateCopies: 0.94, wholeCopyThreads: 232.7, wholeCopyObjects: 1885.75, unsharedPublications: 0, routerShellBuilds: 2, coordinatorShellBuilds: 2, threadVisits: 6153.69, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 0, stringifies: 509.54, providerIdParses: 0, schemaErrors: 0 },
    '3 streaming': { copies: 14.99, copiedObjects: 4466.08, wholeStateCopies: 0.94, wholeCopyThreads: 232.7, wholeCopyObjects: 1889.46, unsharedPublications: 0, routerShellBuilds: 2, coordinatorShellBuilds: 2, threadVisits: 6208.77, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 0, stringifies: 529.77, providerIdParses: 0, schemaErrors: 0 },
    saveAnswerDraft: { copies: 16.5, copiedObjects: 5342, wholeStateCopies: 0, wholeCopyThreads: 0, wholeCopyObjects: 0, unsharedPublications: 0, routerShellBuilds: 3, coordinatorShellBuilds: 3, threadVisits: 15_673, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 5, stringifies: 961, providerIdParses: 0, schemaErrors: 0 },
    typeInComposer: { copies: 23.1, copiedObjects: 16_034, wholeStateCopies: 5, wholeCopyThreads: 879, wholeCopyObjects: 8558, unsharedPublications: 0, routerShellBuilds: 5, coordinatorShellBuilds: 7, threadVisits: 12_268, watcherRecordCopies: 3, watcherRecordObjects: 2898, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 2, stringifies: 172, providerIdParses: 0, schemaErrors: 0 },
    openThread: { copies: 37.4, copiedObjects: 26_945, wholeStateCopies: 11, wholeCopyThreads: 1846, wholeCopyObjects: 20_545.8, unsharedPublications: 0, routerShellBuilds: 7, coordinatorShellBuilds: 10, threadVisits: 14_610, watcherRecordCopies: 3, watcherRecordObjects: 2898, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 3, stringifies: 193, providerIdParses: 0, schemaErrors: 0 },
    send: { copies: 149.6, copiedObjects: 59_923, wholeStateCopies: 14.3, wholeCopyThreads: 3369.3, wholeCopyObjects: 38_819, unsharedPublications: 0, routerShellBuilds: 8, coordinatorShellBuilds: 14, threadVisits: 37_973, watcherRecordCopies: 7, watcherRecordObjects: 8694, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 3, stringifies: 3692, providerIdParses: 0, schemaErrors: 0 },
  },
  stable: {
    '1 streaming': { copies: 10.54, copiedObjects: 2393.6, wholeStateCopies: 1.02, wholeCopyThreads: 252.09, wholeCopyObjects: 2041.88, unsharedPublications: 0, routerShellBuilds: 2, coordinatorShellBuilds: 2, threadVisits: 3596.75, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 0, stringifies: 515.17, providerIdParses: 5, schemaErrors: 0 },
    '3 streaming': { copies: 13.96, copiedObjects: 2317.11, wholeStateCopies: 0.94, wholeCopyThreads: 232.7, wholeCopyObjects: 1888.54, unsharedPublications: 0, routerShellBuilds: 2, coordinatorShellBuilds: 2, threadVisits: 3635, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 0, stringifies: 486.12, providerIdParses: 5, schemaErrors: 0 },
    saveAnswerDraft: { copies: 18.7, copiedObjects: 14_237.3, wholeStateCopies: 0, wholeCopyThreads: 0, wholeCopyObjects: 0, unsharedPublications: 0, routerShellBuilds: 3, coordinatorShellBuilds: 3, threadVisits: 9006, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 5, stringifies: 824, providerIdParses: 9, schemaErrors: 0 },
    typeInComposer: { copies: 21, copiedObjects: 10_950.5, wholeStateCopies: 6, wholeCopyThreads: 1153, wholeCopyObjects: 10_794.3, unsharedPublications: 0, routerShellBuilds: 5, coordinatorShellBuilds: 8, threadVisits: 9975, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 2, stringifies: 20, providerIdParses: 18, schemaErrors: 0 },
    openThread: { copies: 36, copiedObjects: 22_911.9, wholeStateCopies: 13, wholeCopyThreads: 2117, wholeCopyObjects: 22_741.4, unsharedPublications: 0, routerShellBuilds: 7, coordinatorShellBuilds: 11, threadVisits: 13_292, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 3, stringifies: 31, providerIdParses: 27, schemaErrors: 0 },
    send: { copies: 143, copiedObjects: 54_785.5, wholeStateCopies: 15.4, wholeCopyThreads: 3638.8, wholeCopyObjects: 41_012.4, unsharedPublications: 0, routerShellBuilds: 8, coordinatorShellBuilds: 15, threadVisits: 24_904, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, unwatchedThreadPasses: 0, ownerLookups: 3, stringifies: 2876, providerIdParses: 31, schemaErrors: 0 },
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
const proto = { control: AgentControl.prototype as unknown as { shellOf(shareThreads: boolean): AgentState; shownSnapshot(snapshot: AgentHostSnapshot): AgentHostSnapshot },
  router: DesktopHostRouter.prototype as unknown as { build(...args: unknown[]): AgentState } }
const native = { shellOf: proto.control.shellOf, shownSnapshot: proto.control.shownSnapshot, build: proto.router.build }
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
  proto.control.shownSnapshot = function (this: unknown, snapshot: AgentHostSnapshot) {
    const shown = native.shownSnapshot.call(this, snapshot)
    return { ...shown, threads: visits.countedThreads(shown.threads) }
  }
  if (SITES) visits.threadVisits.visited = () => { const at = site(), sites = counter.sites.threadVisits ??= {}; sites[at] = (sites[at] ?? 0) + 1 }
  // What the router publishes carries a counted thread list too: the broadcaster, the busy checks and the answer-recovery
  // pass read it.
  proto.router.build = function (this: unknown, ...args: unknown[]) {
    bump('routerShellBuilds')
    const state = native.build.apply(this, args)
    state.host.threads = visits.countedThreads(state.host.threads)
    return state
  }
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
  proto.control.shellOf = native.shellOf; proto.control.shownSnapshot = native.shownSnapshot; proto.router.build = native.build
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
const WHERE = SITES ? '' : ' Run it with SOTTO_WORK_SITES=1 to see where the serializations, thread visits and copied objects that grew come from.'

describe.each(TRACKS)('main\'s work at the owner\'s scale on %s (#1232)', track => {
  it('builds the owner\'s world', () => {
    expect(measured[track].owner.counts).toMatchObject({ threads: 250, remoteThreads: 40, retirements: 256, remoteRetirements: 40, operations: 150, requests: 160, watches: 5 })
    expect(measured[track].quarterHistory.counts).toMatchObject({ threads: 250, remoteThreads: 10, retirements: 64, operations: 38, requests: 40 })
    expect(measured[track].quarterThreads.counts).toMatchObject({ threads: 63, remoteThreads: 40, retirements: 256, operations: 150, requests: 160 })
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
  })
})
