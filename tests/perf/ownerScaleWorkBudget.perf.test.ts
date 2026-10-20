// @vitest-environment node
/**
 * What main does per update and per user action with the owner's history, counted rather than timed (#1232).
 *
 * Main's lag came back again and again (#917, #925, #1038, #1062, #1065-#1068, and October 20, 2026) with the same cause:
 * work per update that grew with what the user had accumulated, the threads, a remote host, every answered question and
 * Watcher's record. Fresh fixtures hold none of it, and timing checks are opt-in, so nothing in CI saw it. This builds main
 * as `src/main/index.ts` wires it on Owl at the owner's scale (`tests/fixtures/ownerScalePipeline.ts`), streams replies on
 * one thread and on three, and does what the user does: saves an answer draft, types in a composer, opens a thread and
 * sends. It counts the work each update and each action does, and fails when a count passes its budget or grows between a
 * quarter of the owner's history and all of it. It counts calls, never time, so it runs in the default suite.
 *
 * A failure names the count that grew and the numbers at both scales. Read state without copying it, and do work bounded
 * by what changed rather than by the history. The budgets only tighten: a change that needs a higher one says why in its
 * pull request. docs/perf/2026-10-20-main-lag.md has the numbers and how to read them.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../src/main/agents/control'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { ownerScalePipeline, type OwnerScalePipeline } from '../fixtures/ownerScalePipeline'

/** The kinds of work counted. Each is per update while streaming, and per action for the user's actions. */
const KINDS = ['wholeStateCopies', 'routerShellBuilds', 'coordinatorShellBuilds', 'watcherRecordCopies', 'watcherRecordObjects',
  'watcherRecordComparisons', 'ownerLookups', 'stringifies'] as const
type Kind = typeof KINDS[number]
type Counts = Record<Kind, number>

const counter = vi.hoisted(() => ({ measuring: false, wholeThreads: Number.POSITIVE_INFINITY, record: undefined as (() => unknown) | undefined,
  tally: {} as Record<string, number> }))
const bump = vi.hoisted(() => (kind: string, by = 1): void => { if (counter.measuring) counter.tally[kind] = (counter.tally[kind] ?? 0) + by })
/** Whether a copier was handed a whole host's state: a shell or a snapshot carrying every thread of a host. */
const whole = vi.hoisted(() => (value: unknown): boolean => {
  const holder = value as { host?: { threads?: unknown }; threads?: unknown } | null
  const threads = Array.isArray(holder?.host?.threads) ? holder.host.threads : Array.isArray(holder?.threads) ? holder.threads : undefined
  return threads !== undefined && threads.length >= counter.wholeThreads
})
/** The objects a copy made, those in the copy that are not the very objects of what it copied. */
const fresh = vi.hoisted(() => function fresh(copy: unknown, original: unknown, seen = new Set<object>()): number {
  if (copy === null || typeof copy !== 'object' || copy === original || seen.has(copy)) return 0
  seen.add(copy)
  let made = 1
  const from = original !== null && typeof original === 'object' ? original as Record<string, unknown> : undefined
  for (const [key, field] of Object.entries(copy)) made += fresh(field, from?.[key], seen)
  return made
})
/** Every copier, counted where it copies, so a copy made inside another is counted once. */
const copied = vi.hoisted(() => (value: unknown, copy: unknown): void => {
  if (!counter.measuring) return
  if (whole(value)) bump('wholeStateCopies')
  if (counter.record && value === counter.record()) { bump('watcherRecordCopies'); bump('watcherRecordObjects', fresh(copy, value)) }
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

const sleep = (ms: number) => new Promise<void>(done => { setTimeout(done, ms) })
const roots: string[] = []
afterAll(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) })

const CHUNKS = 30
/** Each action is done this many times, each counted on its own once what it set off has settled; the median is kept. */
const REPEATS = 5
/** Longer than the answer-recovery pass's interval and every publish window, so what an action sets off is counted with it. */
const SETTLE_MS = 700

function zero(): Counts { return Object.fromEntries(KINDS.map(kind => [kind, 0])) as Counts }

/** Counts what `work` does, with every global counter installed only while it runs and its publishes settle. */
async function count(pipeline: OwnerScalePipeline, work: () => Promise<void>): Promise<{ counts: Counts; broadcasts: number }> {
  const nativeClone = globalThis.structuredClone, nativeStringify = JSON.stringify
  const routerBuild = vi.spyOn(DesktopHostRouter.prototype as unknown as { build: (...args: unknown[]) => unknown }, 'build')
  const coordinatorShell = vi.spyOn(AgentControl.prototype as unknown as { shellOf: (...args: unknown[]) => unknown }, 'shellOf')
  counter.tally = {}; pipeline.resetCounts()
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => { const copy = nativeClone(value, options); copied(value, copy); return copy }) as typeof structuredClone
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => { bump('stringifies'); return nativeStringify(...args) }) as typeof JSON.stringify
  routerBuild.mockClear(); coordinatorShell.mockClear()
  counter.measuring = true
  try {
    await work()
    await sleep(SETTLE_MS)
  } finally {
    counter.measuring = false
    globalThis.structuredClone = nativeClone; JSON.stringify = nativeStringify
  }
  const counts = { ...zero(), ...counter.tally, routerShellBuilds: routerBuild.mock.calls.length, coordinatorShellBuilds: coordinatorShell.mock.calls.length,
    ownerLookups: pipeline.ownerLookups() } as Counts
  routerBuild.mockRestore(); coordinatorShell.mockRestore()
  return { counts, broadcasts: pipeline.broadcasts() }
}

/** Per kind, the middle of the times an action was counted: a publish window or a pass that fell into one time is not its work. */
const median = (times: readonly Counts[]): Counts => Object.fromEntries(KINDS.map(kind => [kind, [...times.map(item => item[kind])].sort((a, b) => a - b)[Math.floor(times.length / 2)]!])) as Counts
const per = (counts: Counts, by: number): Counts => Object.fromEntries(KINDS.map(kind => [kind, Math.round(counts[kind] / Math.max(1, by) * 100) / 100])) as Counts

interface Measured { counts: Record<string, number>; streaming: Record<string, Counts>; actions: Record<string, Counts> }

/** Builds main at `scale` of the owner's history and counts each scenario. */
async function measure(scale: number): Promise<Measured> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-owner-scale-')); roots.push(root)
  const pipeline = await ownerScalePipeline(root, scale, 3)
  counter.wholeThreads = pipeline.counts.remoteThreads
  counter.record = () => pipeline.control.watcherRecordView()
  // Watcher's wake-up pass runs at most every 250 ms while threads stream, so how many updates it runs in depends on the
  // machine's speed. Here it runs on every update, as it does when an update moves something it reacts to, so the counts
  // are the same on any machine and are the most an update can do.
  if (!('observedAt' in pipeline.watcher.wakes)) throw new Error('Watcher\'s wake-up pass no longer keeps observedAt; hold its pass to every update another way.')
  Object.defineProperty(pipeline.watcher.wakes, 'observedAt', { get: () => -Infinity, set: () => undefined })
  try {
    const streaming: Record<string, Counts> = {}
    for (const streams of [1, 3]) {
      const sessions = pipeline.streamSessions.slice(0, streams)
      const at = new Date().toISOString()
      for (const session of sessions) {
        const thread = pipeline.adapter.state.threads.find(item => item.id === session)!
        pipeline.adapter.log.add(session, { id: `prompt-${streams}`, role: 'user', text: 'Synthetic prompt', createdAt: at }); thread.status = 'running'
        pipeline.adapter.log.add(session, { id: `reply-${streams}`, role: 'assistant', text: 'First', createdAt: at })
      }
      pipeline.adapter.publish(true)
      await sleep(300)
      const { counts, broadcasts } = await count(pipeline, async () => {
        for (let chunk = 0; chunk < CHUNKS; chunk++) {
          for (const session of sessions) pipeline.adapter.log.appendText(session, `reply-${streams}`, ` word${chunk}`)
          pipeline.adapter.publish(true)
          await sleep(5)
        }
      })
      if (broadcasts < 2) throw new Error(`The stream on ${streams} threads produced no updates to count.`)
      streaming[`${streams} streaming`] = per(counts, broadcasts)
      for (const session of sessions) pipeline.adapter.state.threads.find(item => item.id === session)!.status = 'idle'
      pipeline.adapter.publish(false)
      await sleep(300)
    }
    const actions: Record<string, Counts> = {}
    for (const [name, action] of Object.entries(pipeline.actions)) {
      const times: Counts[] = []
      for (let time = 0; time < REPEATS; time++) times.push((await count(pipeline, action)).counts)
      actions[name] = median(times)
    }
    return { counts: pipeline.counts, streaming, actions }
  } finally {
    counter.record = undefined; counter.wholeThreads = Number.POSITIVE_INFINITY
    await pipeline.stop()
  }
}

const NAMES: Record<Kind, string> = {
  wholeStateCopies: 'copies of a host\'s whole state (structuredClone, clonePlainData, cloneHostSnapshot or cloneActivitySnapshot of every thread)',
  routerShellBuilds: 'router shell builds (every host\'s threads built again)',
  coordinatorShellBuilds: 'coordinator shell builds',
  watcherRecordCopies: 'copies of Watcher\'s whole record',
  watcherRecordObjects: 'objects copied out of Watcher\'s record',
  watcherRecordComparisons: 'comparisons of Watcher\'s whole record',
  ownerLookups: 'look-ups of an answer\'s thread by the answer-draft store',
  stringifies: 'JSON.stringify calls',
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
 * How much a count may grow from a quarter of the owner's history to all of it, four times as much: a quarter more and
 * one more at most, so held flat. Two may grow as the history does, five times, but never as its square:
 * - `JSON.stringify` calls, which stand for work done per item. An update that compared every watched thread with every
 *   request's participants through stringified keys grew sixteen times (#1231).
 * - The objects a user's action copies out of Watcher's record. A command may copy the record (`copySites.json` lists
 *   where), so the copy's size follows the record, but how many copies it makes is held flat. On an update it is held
 *   flat too: an update copies none.
 */
const FLAT = 1.25, LINEAR = 5
function growth(scenario: Scenario, kind: Kind): number {
  if (kind === 'stringifies') return LINEAR
  if (kind === 'watcherRecordObjects' && !scenario.endsWith('streaming')) return LINEAR
  return FLAT
}

/**
 * The budgets at the owner's scale, per update or per action, about a fifth over what main does with #1230 and #1231
 * fixed (October 20, 2026; docs/perf/2026-10-20-main-lag.md). A change that lowers a count lowers its budget in the same
 * pull request; one that needs a higher budget says why in its pull request.
 */
const BUDGET: Record<Scenario, Counts> = {
  // One update: the coordinator's shell, the router's build of it and one whole-state copy, and no copy of Watcher's record.
  '1 streaming': { wholeStateCopies: 1.5, routerShellBuilds: 1.5, coordinatorShellBuilds: 1.5, watcherRecordCopies: 0.25, watcherRecordObjects: 400, watcherRecordComparisons: 0.25, ownerLookups: 0.5, stringifies: 600 },
  '3 streaming': { wholeStateCopies: 1.5, routerShellBuilds: 1.5, coordinatorShellBuilds: 1.5, watcherRecordCopies: 0.25, watcherRecordObjects: 400, watcherRecordComparisons: 0.25, ownerLookups: 0.5, stringifies: 600 },
  // A save looks up the answer's own thread, never every retired answer's (#1230).
  saveAnswerDraft: { wholeStateCopies: 2, routerShellBuilds: 2, coordinatorShellBuilds: 2, watcherRecordCopies: 1, watcherRecordObjects: 3_500, watcherRecordComparisons: 1, ownerLookups: 5, stringifies: 60 },
  typeInComposer: { wholeStateCopies: 6, routerShellBuilds: 5, coordinatorShellBuilds: 8, watcherRecordCopies: 2, watcherRecordObjects: 3_500, watcherRecordComparisons: 1, ownerLookups: 3, stringifies: 100 },
  openThread: { wholeStateCopies: 12, routerShellBuilds: 6, coordinatorShellBuilds: 10, watcherRecordCopies: 2, watcherRecordObjects: 3_500, watcherRecordComparisons: 1, ownerLookups: 3, stringifies: 100 },
  send: { wholeStateCopies: 26, routerShellBuilds: 12, coordinatorShellBuilds: 19, watcherRecordCopies: 8, watcherRecordObjects: 12_500, watcherRecordComparisons: 1, ownerLookups: 3, stringifies: 4_700 },
}

let quarter: Measured, owner: Measured
beforeAll(async () => {
  quarter = await measure(0.25)
  owner = await measure(1)
  if (process.env.SOTTO_PERF_BENCH === '1') console.log(`Owner-scale work budget: ${JSON.stringify({ quarter, owner })}`)
}, 240_000)

function scenarioCounts(measured: Measured, scenario: Scenario): Counts {
  return measured.streaming[scenario] ?? measured.actions[scenario]!
}

describe('main\'s work at the owner\'s scale (#1232)', () => {
  it('builds the owner\'s history', () => {
    expect(owner.counts).toMatchObject({ threads: 250, remoteThreads: 40, retirements: 256, remoteRetirements: 40, operations: 150, requests: 160, watches: 5 })
  })
  it.each(Object.keys(SCENARIOS) as Scenario[])('%s: does not grow with the history, and stays within its budget', scenario => {
    const small = scenarioCounts(quarter, scenario), large = scenarioCounts(owner, scenario)
    const seen = `${SCENARIOS[scenario]}, at a quarter of the owner's history ${JSON.stringify(small)} and at all of it ${JSON.stringify(large)}`
    const grew = KINDS.filter(kind => large[kind] > small[kind] * growth(scenario, kind) + 1)
      .map(kind => `${NAMES[kind]} grew with the history, from ${small[kind]} to ${large[kind]}`)
    expect(grew, `Work on ${seen} grows with what the user has accumulated: ${grew.join('; ')}. Do work bounded by what changed, and read state without copying it.`).toEqual([])
    const over = KINDS.filter(kind => large[kind] > BUDGET[scenario][kind]).map(kind => `${NAMES[kind]}: ${large[kind]}, budget ${BUDGET[scenario][kind]}`)
    expect(over, `Work on ${seen} is over its budget: ${over.join('; ')}.`).toEqual([])
  })
})
