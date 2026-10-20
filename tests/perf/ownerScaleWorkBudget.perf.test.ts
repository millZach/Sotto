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
import { ownerScalePipeline, type OwnerScalePipeline, type OwnerScaleTrack } from '../fixtures/ownerScalePipeline'
import type { OwnerScale } from '../fixtures/ownerScale'

/** The kinds of work counted. Each is per update while streaming, and per action for the user's actions. */
const KINDS = ['wholeStateCopies', 'wholeCopyThreads', 'wholeCopyObjects', 'routerShellBuilds', 'coordinatorShellBuilds', 'threadVisits',
  'watcherRecordCopies', 'watcherRecordObjects', 'watcherRecordComparisons', 'ownerLookups', 'stringifies', 'providerIdParses', 'schemaErrors'] as const
type Kind = typeof KINDS[number]
type Counts = Record<Kind, number>

const counter = vi.hoisted(() => ({ measuring: false, wholeThreads: Number.POSITIVE_INFINITY, record: undefined as (() => unknown) | undefined,
  tally: {} as Record<string, number>, sites: {} as Record<string, Record<string, number>> }))
/**
 * With `SOTTO_WORK_SITES=1`, where each serialization and each thread visit came from: the nearest frame in `src/`. It is
 * slow, and is for finding what grew; a failure then names the places whose counts grew most.
 */
const SITES = vi.hoisted(() => process.env.SOTTO_WORK_SITES === '1')
const site = vi.hoisted(() => (): string => {
  const frame = new Error().stack?.split('\n').find(line => /[\\/]src[\\/]/u.test(line))
  return frame?.trim().replace(/^at /u, '').replace(/\(.*?[\\/]src[\\/]/u, '(src/').replace(/\\/gu, '/') ?? 'outside src/'
})
const bump = vi.hoisted(() => (kind: string, by = 1): void => {
  if (!counter.measuring) return
  counter.tally[kind] = (counter.tally[kind] ?? 0) + by
  if (SITES && (kind === 'stringifies' || kind === 'threadVisits')) { const at = site(), sites = counter.sites[kind] ??= {}; sites[at] = (sites[at] ?? 0) + by }
})
const { fresh } = await vi.hoisted(() => import('./support/copyAccounting'))
const visits = await vi.hoisted(() => import('../fixtures/threadVisits'))
/** How many threads a copier was handed, when it was handed a whole host's state: a shell or a snapshot carrying every thread of a host. */
const wholeThreads = vi.hoisted(() => (value: unknown): number | undefined => {
  const holder = value as { host?: { threads?: unknown }; threads?: unknown } | null
  const threads = Array.isArray(holder?.host?.threads) ? holder.host.threads : Array.isArray(holder?.threads) ? holder.threads : undefined
  return threads !== undefined && threads.length >= counter.wholeThreads ? threads.length : undefined
})
/**
 * Every copier, counted where it copies, so a copy made inside another is counted once. A whole copy is counted three
 * ways: once, by the threads it carried, and by the objects it made. Sizing a copy reads its source, which is no visit.
 */
const copied = vi.hoisted(() => (value: unknown, copy: unknown): void => {
  if (!counter.measuring) return
  const on = visits.threadVisits.on
  visits.threadVisits.on = false
  try {
    const threads = wholeThreads(value)
    if (threads !== undefined) { bump('wholeStateCopies'); bump('wholeCopyThreads', threads); bump('wholeCopyObjects', fresh(copy, value)) }
    if (counter.record && value === counter.record()) { bump('watcherRecordCopies'); bump('watcherRecordObjects', fresh(copy, value)) }
  } finally { visits.threadVisits.on = on }
})
vi.mock('../../src/main/agents/cloneHostSnapshot', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/main/agents/cloneHostSnapshot')>()
  return { ...original,
    cloneHostSnapshot: (snapshot: Parameters<typeof original.cloneHostSnapshot>[0]) => { const copy = original.cloneHostSnapshot(snapshot); copied(snapshot, copy); return copy },
    clonePlainData: <T>(value: T): T => { const copy = original.clonePlainData(value); copied(value, copy); return copy } }
})
vi.mock('../../src/main/agents/activitySnapshots', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/main/agents/activitySnapshots')>()
  return { ...original, cloneActivitySnapshot: (snapshot: Parameters<typeof original.cloneActivitySnapshot>[0]) => { const copy = original.cloneActivitySnapshot(snapshot); copied(snapshot, copy); return copy } }
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
  wholeStateCopies: 'copies of a host\'s whole state (structuredClone, clonePlainData, cloneHostSnapshot or cloneActivitySnapshot of every thread)',
  wholeCopyThreads: 'threads carried by those whole copies',
  wholeCopyObjects: 'objects those whole copies made',
  routerShellBuilds: 'router shell builds (every host\'s threads built again)',
  coordinatorShellBuilds: 'coordinator shell builds',
  threadVisits: 'reads of a thread out of a snapshot\'s or a shell\'s thread list',
  watcherRecordCopies: 'copies of Watcher\'s whole record',
  watcherRecordObjects: 'objects copied out of Watcher\'s record',
  watcherRecordComparisons: 'comparisons of Watcher\'s whole record',
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
const PER_THREAD: ReadonlySet<Kind> = new Set(['wholeCopyThreads', 'wholeCopyObjects', 'threadVisits', 'stringifies'])

/**
 * Work that still grows with the history today (#1248): allowed to grow along the history only as far as it does now, and
 * held to its budget at today's count, so it can only shrink. The pull request that fixes one removes its entry and lowers
 * its budget.
 */
const KNOWN_HISTORY_GROWTH: readonly { readonly track: OwnerScaleTrack; readonly scenarios: readonly Scenario[]; readonly kind: Kind; readonly growth: number; readonly why: string }[] = [
  { track: 'owl', scenarios: ['1 streaming', '3 streaming', 'saveAnswerDraft', 'typeInComposer', 'openThread', 'send'], kind: 'threadVisits', growth: 1.39,
    why: "Watcher's room reading every thread once for each watched thread, on every room update" },
  { track: 'owl', scenarios: ['saveAnswerDraft'], kind: 'stringifies', growth: 2.76, why: 'the answer-draft store building a key for every retirement on every save' },
  { track: 'stable', scenarios: ['saveAnswerDraft'], kind: 'stringifies', growth: 3.59, why: 'the answer-draft store building a key for every retirement on every save' },
  { track: 'stable', scenarios: ['typeInComposer', 'openThread'], kind: 'stringifies', growth: 1.64, why: 'the answer-recovery pass building a key for every remote retirement' },
  { track: 'owl', scenarios: ['send'], kind: 'stringifies', growth: 1.42, why: "each save of agents.json checking Watcher's whole record" },
  { track: 'stable', scenarios: ['send'], kind: 'stringifies', growth: 1.52, why: "each save of agents.json checking Watcher's whole record" },
  { track: 'owl', scenarios: ['typeInComposer', 'openThread', 'send'], kind: 'watcherRecordObjects', growth: 3.89, why: "a command copying Watcher's whole record" },
]
const known = (track: OwnerScaleTrack, scenario: Scenario, kind: Kind) => KNOWN_HISTORY_GROWTH.find(entry => entry.track === track && entry.kind === kind && entry.scenarios.includes(scenario))

/**
 * The budgets at the owner's scale, per update or per action: what main does with #1230 and #1231 fixed, with a tenth more
 * room, and today's count exactly for the work #1248 has still to fix (October 20, 2026; docs/perf/2026-10-20-main-lag.md).
 * The counts are the same on every run, so the room is for small changes, not for noise. A change that lowers a count
 * lowers its budget in the same pull request; one that needs a higher budget says why in its pull request.
 */
const BUDGET: Record<OwnerScaleTrack, Record<Scenario, Counts>> = {
  owl: {
    '1 streaming': { wholeStateCopies: 2.04, wholeCopyThreads: 508.8, wholeCopyObjects: 4410.25, routerShellBuilds: 2, coordinatorShellBuilds: 2, threadVisits: 4917.77, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, ownerLookups: 0, stringifies: 489, providerIdParses: 0, schemaErrors: 0 },
    '3 streaming': { wholeStateCopies: 3, wholeCopyThreads: 553.81, wholeCopyObjects: 5494.42, routerShellBuilds: 2, coordinatorShellBuilds: 2, threadVisits: 4943.54, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, ownerLookups: 0, stringifies: 511.25, providerIdParses: 0, schemaErrors: 0 },
    saveAnswerDraft: { wholeStateCopies: 9, wholeCopyThreads: 2227, wholeCopyObjects: 32_763, routerShellBuilds: 3, coordinatorShellBuilds: 3, threadVisits: 12_827, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, ownerLookups: 5, stringifies: 831, providerIdParses: 0, schemaErrors: 0 },
    typeInComposer: { wholeStateCopies: 5, wholeCopyThreads: 879, wholeCopyObjects: 13_188, routerShellBuilds: 5, coordinatorShellBuilds: 7, threadVisits: 8543, watcherRecordCopies: 3, watcherRecordObjects: 2898, watcherRecordComparisons: 0, ownerLookups: 2, stringifies: 47, providerIdParses: 0, schemaErrors: 0 },
    openThread: { wholeStateCopies: 11, wholeCopyThreads: 1846, wholeCopyObjects: 29_806, routerShellBuilds: 7, coordinatorShellBuilds: 10, threadVisits: 11_174, watcherRecordCopies: 3, watcherRecordObjects: 2898, watcherRecordComparisons: 0, ownerLookups: 3, stringifies: 70, providerIdParses: 0, schemaErrors: 0 },
    send: { wholeStateCopies: 28, wholeCopyThreads: 6706, wholeCopyObjects: 98_576, routerShellBuilds: 8, coordinatorShellBuilds: 14, threadVisits: 30_268, watcherRecordCopies: 6, watcherRecordObjects: 7245, watcherRecordComparisons: 0, ownerLookups: 3, stringifies: 3365, providerIdParses: 0, schemaErrors: 0 },
  },
  stable: {
    '1 streaming': { wholeStateCopies: 2.12, wholeCopyThreads: 527.09, wholeCopyObjects: 4556.48, routerShellBuilds: 2, coordinatorShellBuilds: 2, threadVisits: 3212.09, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, ownerLookups: 0, stringifies: 515.17, providerIdParses: 5, schemaErrors: 0 },
    '3 streaming': { wholeStateCopies: 3, wholeCopyThreads: 552.55, wholeCopyObjects: 5482.06, routerShellBuilds: 2, coordinatorShellBuilds: 2, threadVisits: 3207.86, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, ownerLookups: 0, stringifies: 486.12, providerIdParses: 5, schemaErrors: 0 },
    saveAnswerDraft: { wholeStateCopies: 9, wholeCopyThreads: 2218, wholeCopyObjects: 32_684, routerShellBuilds: 3, coordinatorShellBuilds: 3, threadVisits: 7980, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, ownerLookups: 5, stringifies: 824, providerIdParses: 9, schemaErrors: 0 },
    typeInComposer: { wholeStateCopies: 6, wholeCopyThreads: 1153, wholeCopyObjects: 16_968, routerShellBuilds: 5, coordinatorShellBuilds: 8, threadVisits: 8082, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, ownerLookups: 2, stringifies: 20, providerIdParses: 18, schemaErrors: 0 },
    openThread: { wholeStateCopies: 13, wholeCopyThreads: 2117, wholeCopyObjects: 33_545, routerShellBuilds: 7, coordinatorShellBuilds: 11, threadVisits: 12_048, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, ownerLookups: 3, stringifies: 31, providerIdParses: 27, schemaErrors: 0 },
    send: { wholeStateCopies: 29, wholeCopyThreads: 6964, wholeCopyObjects: 102_203, routerShellBuilds: 8, coordinatorShellBuilds: 15, threadVisits: 21_934, watcherRecordCopies: 0, watcherRecordObjects: 0, watcherRecordComparisons: 0, ownerLookups: 3, stringifies: 2876, providerIdParses: 31, schemaErrors: 0 },
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
  router: DesktopHostRouter.prototype as unknown as { build(...args: unknown[]): unknown } }
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
  proto.router.build = function (this: unknown, ...args: unknown[]) { bump('routerShellBuilds'); return native.build.apply(this, args) }
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
  if (!SITES || (kind !== 'stringifies' && kind !== 'threadVisits')) return ''
  const before = small?.[kind] ?? {}, after = large?.[kind] ?? {}
  const most = Object.entries(after).map(([at, n]) => [at, n - (before[at] ?? 0)] as const).filter(([, more]) => more > 0).sort((a, b) => b[1] - a[1]).slice(0, 3)
  return most.length ? ` (most at ${most.map(([at, more]) => `${at} +${Math.round(more)}`).join(', ')})` : ''
}
const WHERE = SITES ? '' : ' Run it with SOTTO_WORK_SITES=1 to see where the serializations and thread visits that grew are made.'

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
      const allowed = known(track, scenario, kind)
      if (all[kind] <= few[kind] * (allowed?.growth ?? SLACK.ratio) + SLACK.plus) return []
      return [`${NAMES[kind]} grew from ${few[kind]} to ${all[kind]}${allowed ? `, more than the ${allowed.growth} times allowed for ${allowed.why} (#1248)` : ''}${grewAt(kind, quarterHistory.sites[scenario], owner.sites[scenario])}`]
    })
    expect(history, `${what}, the work grew with the history (the owner's ${owner.threads} threads on this computer held, a quarter of their history ${show(few)}, all of it ${show(all)}): ${history.join('; ')}. Do work bounded by what changed, and read state without copying it.${WHERE}`).toEqual([])
    const ratio = owner.threads / quarterThreads.threads
    const threads = KINDS.flatMap(kind => {
      const allowed = (PER_THREAD.has(kind) ? fewThreads[kind] * ratio : fewThreads[kind]) * SLACK.ratio + SLACK.plus
      if (all[kind] <= allowed) return []
      return [`${NAMES[kind]} grew ${PER_THREAD.has(kind) ? 'faster than' : 'with'} the threads, from ${fewThreads[kind]} with ${quarterThreads.threads} threads to ${all[kind]} with ${owner.threads}${grewAt(kind, quarterThreads.sites[scenario], owner.sites[scenario])}`]
    })
    expect(threads, `${what}, the work grew faster than the threads (the owner's history held, ${quarterThreads.threads} threads ${show(fewThreads)}, ${owner.threads} threads ${show(all)}): ${threads.join('; ')}. Work per thread must not depend on how many threads there are.${WHERE}`).toEqual([])
    const budget = BUDGET[track]?.[scenario]
    const over = budget ? KINDS.filter(kind => all[kind] > budget[kind]).map(kind => `${NAMES[kind]}: ${all[kind]}, budget ${budget[kind]}`) : ['no budget']
    expect(over, `${what}, at the owner's scale the work is over its budget (${show(all)}): ${over.join('; ')}.`).toEqual([])
  })
})
