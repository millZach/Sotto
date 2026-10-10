// @vitest-environment node
/**
 * Where opening a long Codex thread spends its time (#352). Opening a thread Sotto holds no history for reads it
 * whole with `thread/read` and `includeTurns: true` and applies every turn. This seeds a thread with 50, 500 and
 * 2,000 completed turns in the fake Codex app-server (`tests/fixtures/codexSeededThread.ts`), opens it the way the
 * Threads page does, and splits the whole read into phases:
 *
 * - `sending`: from the request going out to the adapter starting to parse the reply line. This is the fake
 *   building its reply and the pipe carrying it, not Codex; the real client's round trip is in
 *   `docs/perf/2026-09-26-codex-send-read.md`.
 * - `parsing`: `JSON.parse` of the reply line (`json`), then the frame and thread schemas, up to applying.
 * - `reconciling`: `reconcileTurn`, which settles every turn's message identities.
 * - `applying`: `applyItem` for every item, which records the messages (`recording`) and the activity.
 * - `activity`: the activity projection's `item`, `anchor` and `turn`; the first two run inside `applying`, `turn`
 *   inside `rest`.
 * - `ordering`: `reconcileMessages`, wherever the read calls it, and how many times it did.
 * - `rest`: the rest of `applyThread` and `settleRead`. `persist`, inside the read, is reported on its own.
 *
 * Each open is timed on a fresh connection, so the adapter holds nothing for the thread and the read is the one an
 * open makes. Counters and timers only; every seeded text is filler. It asserts no time, so the timed half runs
 * only under `SOTTO_PERF_BENCH=1` (`tests/fixtures/perfBench.ts`); the default suite runs only the check that the
 * private members it wraps still exist:
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/codexOpenApply.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CodexAppServerHost } from '../../src/main/agents/codex'
import { CodexActivityProjection } from '../../src/main/agents/codexActivity'
import { opened, seededCodexThread } from '../fixtures/codexSeededThread'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

const OPENS = 5
const SIZES = [50, 500, 2000] as const
/** A reply line at least this long is the transcript; every other reply an open waits on is a few hundred bytes. */
const TRANSCRIPT_CHARS = 32_000
/** The members the benchmark wraps, by the class that owns them. */
const WRAPPED = {
  adapter: ['rpc', 'applyThread', 'reconcileTurn', 'applyItem', 'addMessage', 'reconcileMessages', 'settleRead', 'persist'],
  activity: ['item', 'anchor', 'turn'],
} as const
const PHASES = ['open', 'read', 'sending', 'parsing', 'json', 'applyThread', 'reconciling', 'applying', 'recording', 'activity', 'ordering', 'settleRead', 'persist'] as const
type Phase = (typeof PHASES)[number]
const owners = { adapter: CodexAppServerHost.prototype, activity: CodexActivityProjection.prototype } as unknown as Record<keyof typeof WRAPPED, Record<string, (...args: unknown[]) => unknown>>

const spent = new Map<Phase, number>()
const add = (phase: Phase, ms: number): void => { spent.set(phase, (spent.get(phase) ?? 0) + ms) }
let orderings = 0
/** While the whole read is in flight: when it went out, and when its reply line started to be parsed. */
let reading: { startedAt: number; parsedAt?: number } | undefined
const originals: { owner: Record<string, unknown>; name: string; original: unknown }[] = []
const originalParse = JSON.parse

function instrument(): void {
  const timed = <O extends keyof typeof WRAPPED>(owner: O, name: (typeof WRAPPED)[O][number], phase: Phase, when: (args: unknown[]) => boolean,
    enter?: () => void, leave?: () => void): void => {
    const prototype: Record<string, (...args: unknown[]) => unknown> = owners[owner], original = prototype[name]!
    originals.push({ owner: prototype, name, original })
    prototype[name] = function (this: unknown, ...args: unknown[]) {
      if (!when(args)) return original.apply(this, args)
      const startedAt = performance.now()
      enter?.()
      const stop = (): void => { add(phase, performance.now() - startedAt); leave?.() }
      let result: unknown
      try { result = original.apply(this, args) } catch (error) { stop(); throw error }
      if (result instanceof Promise) return result.finally(stop)
      stop(); return result
    }
  }
  const inRead = (): boolean => reading !== undefined
  timed('adapter', 'rpc', 'read', args => args[0] === 'thread/read' && (args[1] as { includeTurns?: boolean }).includeTurns === true,
    () => { reading = { startedAt: performance.now() } }, () => { reading = undefined })
  // Parsing ends where applying starts: the reply's schemas are checked just before `applyThread` is called.
  timed('adapter', 'applyThread', 'applyThread', inRead, () => { if (reading?.parsedAt !== undefined) add('parsing', performance.now() - reading.parsedAt) })
  timed('adapter', 'reconcileTurn', 'reconciling', inRead)
  timed('adapter', 'applyItem', 'applying', inRead)
  // Parts of applying and of the rest: recording a message in the thread's log, and the thread's activity.
  timed('adapter', 'addMessage', 'recording', inRead)
  for (const name of WRAPPED.activity) timed('activity', name, 'activity', inRead)
  timed('adapter', 'reconcileMessages', 'ordering', inRead, () => { orderings++ })
  timed('adapter', 'settleRead', 'settleRead', inRead)
  timed('adapter', 'persist', 'persist', inRead)
  JSON.parse = function (text: string, reviver?: Parameters<typeof JSON.parse>[1]) {
    if (!reading || reading.parsedAt !== undefined || typeof text !== 'string' || text.length < TRANSCRIPT_CHARS) return originalParse(text, reviver)
    const startedAt = performance.now()
    reading.parsedAt = startedAt
    add('sending', startedAt - reading.startedAt)
    try { return originalParse(text, reviver) } finally { add('json', performance.now() - startedAt) }
  } as typeof JSON.parse
}
function restore(): void {
  for (const { owner, name, original } of originals.reverse()) owner[name] = original
  originals.length = 0
  JSON.parse = originalParse
}

describe('Codex open benchmark', () => {
  it('wraps adapter and activity members that still exist', () => {
    for (const owner of Object.keys(WRAPPED) as (keyof typeof WRAPPED)[]) {
      for (const name of WRAPPED[owner]) expect(typeof owners[owner][name], `${owner}.${name}`).toBe('function')
    }
  })
})

describe.skipIf(!PERF_BENCH)("Codex open of a long thread (timing benchmark; requires SOTTO_PERF_BENCH=1)", () => {
  beforeAll(instrument)
  afterAll(restore)

  for (const turns of SIZES) {
    it(`at ${turns} turns`, async () => {
      const { f, id } = await seededCodexThread(turns)
      try {
        const samples = Object.fromEntries([...PHASES, 'rest'].map(phase => [phase, [] as number[]])) as Record<Phase | 'rest', number[]>
        const counts: number[] = []
        for (let index = 0; index < OPENS; index++) {
          // A fresh connection holds no history, so the open reads the thread whole.
          await f.host.connect()
          spent.clear(); orderings = 0
          const startedAt = performance.now()
          f.host.observeThreads?.([id])
          add('open', await opened(f, id, startedAt))
          expect((await f.host.snapshot()).threads.find(thread => thread.id === id)?.messages).toHaveLength(turns * 2)
          for (const phase of PHASES) samples[phase].push(spent.get(phase) ?? 0)
          samples.rest.push((spent.get('applyThread') ?? 0) + (spent.get('settleRead') ?? 0)
            - (spent.get('reconciling') ?? 0) - (spent.get('applying') ?? 0) - (spent.get('ordering') ?? 0))
          counts.push(orderings)
          // Connecting opens every watched thread, so the next open is timed from the watched set, not the connection.
          f.host.observeThreads?.([]); f.host.disconnect(); await f.adapter.closed()
        }
        console.info(`codex open: ${JSON.stringify({ turns, opens: OPENS,
          ...Object.fromEntries([...PHASES, 'rest'].map(phase => [`${phase}MedianMs`, round(median(samples[phase as Phase | 'rest']))])),
          orderingsPerRead: median(counts) })}`)
      } finally { await f.cleanup() }
    }, 600_000)
  }
})
