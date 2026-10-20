// @vitest-environment node
/**
 * What Watcher's own work costs on every update, counted rather than timed (#1231). On the owner's Owl build, with about
 * 250 threads and a Watcher record of 160 requests, 149 operations and 5 standing watches, Watcher was about 27% of main:
 * its observe pass walked the whole record for every thread and copied and compared the record several times, and every
 * publish built a target key for every participant of every request for every watched target.
 *
 * This builds Watcher at that scale and at a smaller one and counts, for one observe pass and for one publish with
 * nothing changed: copies of the record, deep comparisons of it and target key builds. None of them may grow with the
 * record or with the thread count. It counts calls, never time, so it runs in the default suite.
 * docs/perf/2026-10-20-main-lag.md has the numbers before and after; SOTTO_PERF_BENCH=1 prints them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PERF_BENCH } from '../fixtures/perfBench'
import { watcherAtScale, type ScaleShape } from '../fixtures/watcherAtScale'

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
  try { run() } finally { counter.on = false }
  const result = {
    recordCopies: counter.clones.filter(ofRecord).length + structured.mock.calls.filter(([value]) => ofRecord(value)).length,
    watcherRecordCalls: copies.mock.calls.length,
    mutateWatcher: mutations.mock.calls.length,
    deepEquals: counter.deepEquals,
    keyBuilds: stringify.mock.calls.filter(([value]) => isTargetKey(value)).length,
  }
  copies.mockRestore(); mutations.mockRestore(); stringify.mockRestore(); structured.mockRestore()
  return result
}

async function measure(shape: ScaleShape) {
  const f = await watcherAtScale(shape)
  fixtures.push(f)
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
    const small = await measure({ threads: 60, requests: 40, operations: 40, watches: 5 })
    const moreRecord = await measure({ threads: 60, requests: 160, operations: 144, watches: 5 })
    const owner = await measure({ threads: 250, requests: 160, operations: 144, watches: 5 })
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
    // The room hands out a detached copy of the records it shows, once per publish however many listeners there are.
    expect(owner.publish.recordCopies, `publish copied the record more than once: ${seen}`).toBeLessThanOrEqual(1)
    expect(owner.publish.deepEquals, `publish compared the whole record: ${seen}`).toBe(0)
  })
})
