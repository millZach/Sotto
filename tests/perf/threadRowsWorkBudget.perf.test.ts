// @vitest-environment node
/**
 * What the window does to describe its thread rows for one update, counted rather than timed. The Threads page, the
 * sidebar beside other pages and Watcher's room describe every published state, and while threads streamed that once
 * described every thread on every update: in a profile of the window at the owner's scale, `ThreadsView` alone took
 * about 2 s of 8, and a keystroke in the composer waited behind it. A page's describer now describes again only the
 * threads an update changed and hands back every other row as it was, the same object.
 *
 * Each row is described once per `resolveModel` call, so the count of those calls is the count of rows described. With
 * 200 threads and an update that changes one, one row is described and every other row keeps its reference; at the
 * owner's scale, through main as `src/main/index.ts` wires it and the page's own `wrapAgentBridge` and state sharing,
 * each streaming update describes only the threads whose records it changed. That second case is also what checks that
 * unchanged thread records keep their reference from main to the page, which the describer relies on. Every result is
 * checked against `describeThreads` for the same state. The counts run in the default suite; with `SOTTO_PERF_BENCH=1`
 * it also reports the time one update takes, describing every thread and describing the changed one:
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/threadRowsWorkBudget.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { deserialize, serialize } from 'node:v8'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { AgentStateBroadcaster } from '../../src/main/agents/agentStateBroadcast'
import { wrapAgentBridge } from '../../src/renderer/src/agents/agentStateCatalogs'
import { createStateSharing, share } from '../../src/renderer/src/agents/stateSharing'
import { describeThreads, organizeWorkspace, threadDescriber, type ThreadRow } from '../../src/renderer/src/agents/threadFacts'
import { E2E_THREADS_NOW as NOW } from '../../src/shared/e2e'
import type { AgentState, AgentStateBroadcast, AgentThread, AgentWireBridge } from '../../src/shared/agents'
import { threadsStateFixture } from '../fixtures/agentState'
import { syntheticModelCatalog } from '../fixtures/modelCatalog'
import { ownerScalePipeline } from '../fixtures/ownerScalePipeline'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

const counter = vi.hoisted(() => ({ measuring: false, described: 0 }))
vi.mock('../../src/shared/modelCatalog', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/shared/modelCatalog')>()
  const resolveModel: typeof actual.resolveModel = (models, modelId) => {
    if (counter.measuring) counter.described++
    return actual.resolveModel(models, modelId)
  }
  return { ...actual, resolveModel }
})

/** The rows `describe` built while `work` ran, and what it returned. */
function counted<T>(work: () => T): { result: T; described: number } {
  counter.described = 0
  counter.measuring = true
  try { return { result: work(), described: counter.described } } finally { counter.measuring = false }
}

const THREADS = 200

/** The Threads design fixture's threads, needs-you, working, done and settled, repeated to `THREADS`, over the owner's catalog. */
function manyThreads(): AgentState {
  const state = threadsStateFixture()
  const designed = state.host.threads
  const threads = Array.from({ length: THREADS }, (_, index): AgentThread => ({ ...structuredClone(designed[index % designed.length]!), id: `thread-${index}` }))
  return { ...state, host: { ...state.host, models: [...state.host.models, ...syntheticModelCatalog()], threads } }
}

/** The state after an update that changed thread `index` alone: a new state around the same records, catalog and projects. */
function changed(state: AgentState, index: number, words: string): AgentState {
  const threads = state.host.threads.map((thread, at) => at === index ? { ...thread, title: `${thread.title} ${words}`, updatedAt: new Date(NOW).toISOString() } : thread)
  return { ...state, host: { ...state.host, threads } }
}

describe(`describing ${THREADS} threads for an update that changed one`, () => {
  it('describes the changed thread alone and keeps every other row', () => {
    const describeRows = threadDescriber()
    const before = manyThreads()
    const first = counted(() => describeRows(before, NOW))
    expect(first.described).toBe(THREADS)

    const after = changed(before, 37, 'renamed')
    const update = counted(() => describeRows(after, NOW))
    expect(update.described).toBe(1)
    expect(update.result).toEqual(describeThreads(after, NOW))
    expect(update.result[37]).not.toBe(first.result[37])
    expect(update.result[37]!.thread.title).toMatch(/renamed$/u)
    expect(update.result.filter((row, index) => row !== first.result[index])).toHaveLength(1)
    // `useShared` over the rows hands them back as the describer gave them, so on the next update it meets every row,
    // the one that changed included, by reference rather than walking it again.
    expect(share(first.result, update.result)).toBe(update.result)
    const next = counted(() => describeRows(changed(after, 120, 'later'), NOW))
    expect(next.described).toBe(1)
    expect(next.result[37]).toBe(update.result[37])
    expect(share(update.result, next.result)).toBe(next.result)
  })

  it('hands back the same rows when an update changed no thread', () => {
    const describeRows = threadDescriber()
    const state = manyThreads()
    const first = describeRows(state, NOW)
    const again = counted(() => describeRows({ ...state, notice: 'Something else changed.', host: { ...state.host } }, NOW))
    expect(again.described).toBe(0)
    expect(again.result).toBe(first)
  })

  it('describes only the working threads again when the clock moves', () => {
    const describeRows = threadDescriber()
    const state = manyThreads()
    const first = describeRows(state, NOW)
    const working = first.filter(row => row.state === 'working').length
    expect(working).toBeGreaterThan(0)
    expect(working).toBeLessThan(THREADS / 2)
    const tick = counted(() => describeRows(state, NOW + 30_000))
    expect(tick.described).toBe(working)
    expect(tick.result).toEqual(describeThreads(state, NOW + 30_000))
    for (const [index, row] of tick.result.entries()) if (row.state !== 'working') expect(row).toBe(first[index])
  })

  it.skipIf(!PERF_BENCH)('reports the time one update takes, describing every thread and only the changed one', () => {
    const ROUNDS = 60
    let state = manyThreads()
    const describeRows = threadDescriber()
    let shownEvery: readonly ThreadRow[] = describeThreads(state, NOW)
    let shownChanged = describeRows(state, NOW)
    const every: number[] = [], changedOnly: number[] = [], organize: number[] = []
    for (let round = 0; round < ROUNDS; round++) {
      state = changed(state, (round * 7) % THREADS, `${round}`)
      let started = performance.now()
      shownEvery = share(shownEvery, describeThreads(state, NOW))
      every.push(performance.now() - started)
      started = performance.now()
      shownChanged = share(shownChanged, describeRows(state, NOW))
      changedOnly.push(performance.now() - started)
      started = performance.now()
      organizeWorkspace(state, shownChanged, '', state.activeProjectId, true, NOW)
      organize.push(performance.now() - started)
    }
    console.info(`threadRowsWorkBudget ${JSON.stringify({ threads: THREADS, rounds: ROUNDS,
      medianMs: { describeEveryThreadAndShare: round(median(every), 3), describeChangedThreadAndShare: round(median(changedOnly), 3), organizeWorkspace: round(median(organize), 3) } })}`)
  })
})

const roots: string[] = []
afterAll(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) })
const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

/** Every state main published while `streams` threads streamed at the owner's scale, as the page rebuilt and shared it. */
async function pageStatesAtOwnerScale(streams: number): Promise<{ states: AgentState[]; streamingFrom: number }> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-thread-rows-work-')); roots.push(root)
  const pipeline = await ownerScalePipeline(root, { threads: 1, history: 1 }, streams, 'owl')
  const broadcaster = new AgentStateBroadcaster()
  const sent: Buffer[] = []
  const off = pipeline.router.subscribe(state => { broadcaster.send(state, payload => { sent.push(serialize(payload)); return true }) })
  let streamingFrom: number
  try {
    await pause(1_000)
    const sessions = pipeline.streamSessions.slice(0, streams)
    const at = new Date().toISOString()
    for (const session of sessions) {
      const thread = pipeline.adapter.state.threads.find(item => item.id === session)!
      pipeline.adapter.log.add(session, { id: 'prompt', role: 'user', text: 'Synthetic prompt', createdAt: at }); thread.status = 'running'
      pipeline.adapter.log.add(session, { id: 'reply', role: 'assistant', text: 'First', createdAt: at })
    }
    pipeline.adapter.publish(true)
    await pause(500)
    streamingFrom = sent.length
    for (let chunk = 0; chunk < 20; chunk++) {
      for (const session of sessions) pipeline.adapter.log.appendText(session, 'reply', ` word${chunk}`)
      pipeline.adapter.publish(true)
      await pause(20)
    }
    await pause(500)
  } finally {
    off()
    await pipeline.stop()
  }
  // The page's side, as `AgentContext` takes each broadcast: rebuilt by `wrapAgentBridge`, then shared against the last state.
  let listener: ((raw: unknown) => void) | null = null
  const bridge = { get: () => Promise.reject(new Error('unused')), command: () => Promise.reject(new Error('unused')),
    onState: (next: (raw: unknown) => void) => { listener = next; return () => { listener = null } } } as unknown as AgentWireBridge
  const sharing = createStateSharing()
  const states: AgentState[] = []
  let shown: AgentState | undefined, arrived: AgentState | undefined
  wrapAgentBridge(bridge).onState(state => { arrived = state })
  for (const buffer of sent) {
    arrived = undefined
    listener!(deserialize(buffer) as AgentStateBroadcast)
    if (arrived === undefined) throw new Error('A broadcast of this run could not be put back.')
    shown = sharing(shown, arrived)
    states.push(shown)
  }
  return { states, streamingFrom }
}

describe('describing the page\'s states while threads stream at the owner\'s scale', () => {
  it('describes, per update, only the threads whose records the update changed', async () => {
    const STREAMS = 3
    const { states, streamingFrom } = await pageStatesAtOwnerScale(STREAMS)
    const streaming = states.slice(streamingFrom)
    expect(states[0]!.host.threads.length).toBeGreaterThanOrEqual(250)
    expect(streaming.length).toBeGreaterThanOrEqual(10)
    const describeRows = threadDescriber()
    const perUpdate: { described: number; changedRecords: number }[] = []
    let previous: AgentState | undefined
    for (const state of states) {
      const held = new Map(previous?.host.threads.map(thread => [thread.id, thread]))
      const changedRecords = state.host.threads.filter(thread => held.get(thread.id) !== thread).length
      const { result, described } = counted(() => describeRows(state, NOW))
      expect(result).toEqual(describeThreads(state, NOW))
      // A row is described again only for a new or changed record, unless the catalog or the projects changed with it.
      if (previous !== undefined && previous.host.models === state.host.models && previous.host.projects === state.host.projects) expect(described).toBe(changedRecords)
      perUpdate.push({ described, changedRecords })
      previous = state
    }
    // Main and the page keep the record of every thread that did not stream, so a streaming update describes those that did.
    expect(Math.max(...perUpdate.slice(streamingFrom).map(update => update.described))).toBeLessThanOrEqual(STREAMS)
  }, 180_000)
})
