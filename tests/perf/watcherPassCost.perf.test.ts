// @vitest-environment node
/**
 * What Watcher's own work costs on every update, counted rather than timed (#1231). On the owner's Owl build, with about
 * 250 threads and a Watcher record of 160 requests, 149 operations and 5 standing watches, Watcher was about 27% of main:
 * its observe pass walked the whole record for every thread and copied and compared the record several times, and every
 * publish built a target key for every participant of every request for every watched target.
 *
 * This builds Watcher at that scale and at a smaller one and counts, for one observe pass and for one publish with
 * nothing changed: copies of the record, deep comparisons of it, target key builds and reads of a thread out of the
 * snapshot. None of them may grow with the record, and only thread reads may grow with the thread count, in step with
 * it. A pass in which the user sent to two threads changes the record once, a failed send already recorded changes
 * nothing, and the first pass after a record is loaded still lets go of the prompt turns nothing reads. It counts calls,
 * never time, so it runs in the default suite.
 * docs/perf/2026-10-20-main-lag.md has the numbers before and after; SOTTO_PERF_BENCH=1 prints them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PERF_BENCH } from '../fixtures/perfBench'
import { centerTime } from '../fixtures/watcher'
import { watcherAtScale, type ScaleOptions, type ScaleShape } from '../fixtures/watcherAtScale'
import { prunePromptTurns, WATCHER_PROMPT_TURNS_KEPT } from '../../src/main/agents/watcherRecords'
import type { WatcherRecord } from '../../src/shared/watcher'

const counter = vi.hoisted(() => ({ on: false, clones: [] as unknown[], deepEquals: 0 }))
vi.mock('../../src/main/agents/cloneHostSnapshot', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/main/agents/cloneHostSnapshot')>()
  return { ...actual, clonePlainData: <T>(value: T): T => { if (counter.on) counter.clones.push(value); return actual.clonePlainData(value) } }
})
vi.mock('node:util', async importOriginal => {
  const actual = await importOriginal<typeof import('node:util')>()
  return { ...actual, default: actual, isDeepStrictEqual: (left: unknown, right: unknown) => { if (counter.on) counter.deepEquals++; return actual.isDeepStrictEqual(left, right) } }
})

type Fixture = Awaited<ReturnType<typeof watcherAtScale>>
const fixtures: Fixture[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); vi.restoreAllMocks() })

/** A target key, as `key` and `targetKey` build one: JSON of a host ID and a thread ID. */
const isTargetKey = (value: unknown) => Array.isArray(value) && value.length === 2 && value.every(item => typeof item === 'string' || item === null || item === undefined)

function counted(f: Fixture, run: () => void) {
  const record = f.state()
  const ofRecord = (value: unknown) => value === record || typeof value === 'object' && value !== null
    && ('requests' in value && (value as { requests: unknown }).requests === record.requests
      || 'operations' in value && (value as { operations: unknown }).operations === record.operations)
  const copies = vi.spyOn(f.control, 'watcherRecord'), mutations = vi.spyOn(f.control, 'mutateWatcher')
  const stringify = vi.spyOn(JSON, 'stringify'), structured = vi.spyOn(globalThis, 'structuredClone')
  counter.clones = []; counter.deepEquals = 0; counter.on = true
  f.threadVisits.count = 0; f.threadVisits.on = true
  try { run() } finally { counter.on = false; f.threadVisits.on = false }
  const result = {
    recordCopies: counter.clones.filter(ofRecord).length + structured.mock.calls.filter(([value]) => ofRecord(value)).length,
    watcherRecordCalls: copies.mock.calls.length,
    mutateWatcher: mutations.mock.calls.length,
    deepEquals: counter.deepEquals,
    keyBuilds: stringify.mock.calls.filter(([value]) => isTargetKey(value)).length,
    threadVisits: f.threadVisits.count,
  }
  copies.mockRestore(); mutations.mockRestore(); stringify.mockRestore(); structured.mockRestore()
  return result
}

async function scaled(shape: ScaleShape, options?: ScaleOptions) {
  const f = await watcherAtScale(shape, options)
  fixtures.push(f)
  return f
}

const SMALL: ScaleShape = { threads: 60, requests: 40, operations: 40, watches: 5 }
const OWNER: ScaleShape = { threads: 250, requests: 160, operations: 144, watches: 5 }

async function measure(shape: ScaleShape) {
  const f = await scaled(shape)
  // Nothing changed since the fixture's own first pass and publishes: this is a streamed chunk's update.
  const observe = counted(f, () => f.observe())
  const publish = counted(f, () => f.publish())
  // The wake-up pass, which a publish runs at most every 250 ms and which looks at every thread.
  const wakePass = counted(f, () => f.wakePass())
  expect(f.rooms()).toBeGreaterThan(0)
  return { shape, observe, publish, wakePass }
}

describe('Watcher pass cost at the owner\'s scale', () => {
  it('copies and compares nothing, and builds no more keys, as the record and the thread count grow', async () => {
    const small = await measure(SMALL)
    const moreRecord = await measure({ ...OWNER, threads: SMALL.threads })
    const owner = await measure(OWNER)
    const seen = JSON.stringify({ small, moreRecord, owner }, null, 1)
    if (PERF_BENCH) console.log(seen)
    for (const { observe } of [small, moreRecord, owner]) {
      // An unchanged update changes nothing, so it neither copies the record nor compares it.
      expect(observe.recordCopies, `observe pass copied the record: ${seen}`).toBe(0)
      expect(observe.watcherRecordCalls, `observe pass copied the record: ${seen}`).toBe(0)
      expect(observe.mutateWatcher, `observe pass offered an unchanged record: ${seen}`).toBe(0)
      expect(observe.deepEquals, `observe pass compared the whole record: ${seen}`).toBe(0)
    }
    for (const work of ['observe', 'publish', 'wakePass'] as const) for (const measure of ['recordCopies', 'watcherRecordCalls', 'mutateWatcher', 'deepEquals', 'keyBuilds'] as const) {
      expect(moreRecord[work][measure], `${work} ${measure} grew with the record: ${seen}`).toBeLessThanOrEqual(small[work][measure])
      expect(owner[work][measure], `${work} ${measure} grew with the threads: ${seen}`).toBeLessThanOrEqual(moreRecord[work][measure])
    }
    // Every pass reads each thread a few times, but never once per request or operation for each thread.
    for (const work of ['observe', 'publish', 'wakePass'] as const) {
      expect(moreRecord[work].threadVisits, `${work} read threads once per record entry: ${seen}`).toBeLessThanOrEqual(small[work].threadVisits)
      expect(owner[work].threadVisits / (OWNER.threads + 1), `${work} read each thread more often with more threads: ${seen}`)
        .toBeLessThanOrEqual(moreRecord[work].threadVisits / (SMALL.threads + 1))
    }
    // The room hands out a detached copy of the records it shows, once per publish however many listeners there are.
    expect(owner.publish.recordCopies, `publish copied the record more than once: ${seen}`).toBeLessThanOrEqual(1)
    expect(owner.publish.deepEquals, `publish compared the whole record: ${seen}`).toBe(0)
  })
})

/** The user's own message arriving on a thread, natively: its newest turn is theirs and still running. */
function userSends(f: Awaited<ReturnType<typeof scaled>>, threadId: string) {
  const index = f.snapshot.threads.findIndex(thread => thread.id === threadId), thread = f.snapshot.threads[index]!, id = `user-${threadId}`
  f.snapshot.threads[index] = { ...thread, status: 'running', lastUserMessageId: id, lastTurn: { id: `user-turn-${threadId}`, messageId: id, status: 'running' },
    messages: [...thread.messages, { id, role: 'user', text: 'Synthetic fixture text', createdAt: centerTime }] }
}

/** What a takeover decides for a thread, without the times it was made at. */
function takenOver(record: Readonly<WatcherRecord>, threadId: string) {
  const watch = record.watches?.find(item => item.target.threadId === threadId)
  return {
    watch: watch && { generation: watch.generation, pausedByUserMessageId: watch.pausedByUserMessageId, lastUserMessageId: watch.lastUserMessageId },
    participants: record.requests.flatMap(request => request.participants.filter(item => item.target.threadId === threadId && request.state === 'active')
      .map(item => ({ state: item.state, generation: item.generation, lastUserMessageId: item.lastUserMessageId, takeover: item.takeover?.reason }))),
    localTakeovers: record.localTakeovers?.filter(item => item.target.threadId === threadId).map(item => ({ lastRequestId: item.lastRequestId, userDrafts: item.userDrafts?.length ?? 0 })),
    operations: record.operations.filter(item => item.target.threadId === threadId).map(item => `${item.deliveryState}:${item.refusalCode ?? ''}`),
  }
}

describe('Watcher pass changes', () => {
  it('changes the record once in a pass in which the user sent to two threads, and decides each takeover as before', async () => {
    const f = await scaled(OWNER)
    // A thread watched from the start, and one taking part in an active request, which recovery gave a standing watch.
    const watched = 'worker-0', participating = f.state().requests.at(-1)!.participants[0]!.target.threadId
    userSends(f, watched); userSends(f, participating)
    const observe = counted(f, () => f.observe())
    const decided = { watched: takenOver(f.state(), watched), participating: takenOver(f.state(), participating) }
    if (PERF_BENCH) console.log(JSON.stringify({ observe, decided }))
    expect(observe.mutateWatcher, JSON.stringify(observe)).toBe(1)
    expect(observe.watcherRecordCalls, JSON.stringify(observe)).toBe(1)
    // As origin/main decided them with one change per takeover, measured October 20, 2026.
    expect(decided).toEqual(TAKEOVERS)
  })

  it('changes, copies and compares nothing for a failed send that is already recorded', async () => {
    const f = await scaled(SMALL)
    const failed = f.state().operations[0]!
    f.control.mutateWatcher(next => { const operation = next.operations[0]!; operation.deliveryState = 'failed'; operation.refusalCode = 'PROVIDER_UNAVAILABLE' })
    f.sends.deliveries.splice(f.sends.deliveries.findIndex(item => item.draftId === failed.draftId), 1)
    f.sends.followups.push({ id: '00000000-0000-4000-8000-0000000f0000', threadId: failed.target.threadId, draftId: failed.draftId!, text: 'Synthetic fixture text',
      attachments: [], createdAt: centerTime, updatedAt: centerTime, status: 'failed' })
    f.observe()
    const observe = counted(f, () => f.observe())
    expect(observe, JSON.stringify(observe)).toMatchObject({ recordCopies: 0, watcherRecordCalls: 0, mutateWatcher: 0, deepEquals: 0 })
    expect(f.state().operations[0]).toMatchObject({ deliveryState: 'failed', refusalCode: 'PROVIDER_UNAVAILABLE' })
  })

  it('lets go of the prompt turns nothing reads on the first pass after the record is loaded, then changes nothing', async () => {
    const f = await scaled(SMALL, { savedPromptTurns: 120 })
    // What main let go of with a change on every pass before (#1231): the turns past the kept ones that nothing reads.
    const pruned = structuredClone(f.loaded!) as WatcherRecord
    prunePromptTurns(pruned)
    expect(f.loaded!.promptTurns!.length).toBeGreaterThan(120)
    expect(pruned.promptTurns).toHaveLength(WATCHER_PROMPT_TURNS_KEPT)
    // The first pass after loading finds nothing new, but still lets go of them, once.
    const first = counted(f, () => f.observe())
    expect(f.state().promptTurns).toEqual(pruned.promptTurns)
    expect(first.mutateWatcher, JSON.stringify(first)).toBe(1)
    const next = counted(f, () => f.observe())
    expect(next.mutateWatcher, JSON.stringify(next)).toBe(0)
  })
})

/** What origin/main (9376061ef) recorded for the two sends in `changes the record once`, with three changes in its pass. */
const LAST_REQUEST = '00000000-0000-4000-8000-000000004ebf'
const TAKEOVERS = {
  watched: { watch: { generation: 1, pausedByUserMessageId: 'user-worker-0', lastUserMessageId: 'user-worker-0' }, participants: [],
    localTakeovers: [{ lastRequestId: LAST_REQUEST, userDrafts: 0 }], operations: ['accepted:'] },
  participating: { watch: { generation: 1, pausedByUserMessageId: 'user-worker-73', lastUserMessageId: 'user-worker-73' },
    participants: [{ state: 'participating', generation: 1, lastUserMessageId: 'user-worker-73' }],
    localTakeovers: [{ lastRequestId: LAST_REQUEST, userDrafts: 0 }], operations: ['accepted:'] },
}
