// @vitest-environment node
/**
 * What the read before a Codex send costs as a thread grows (#324). Before `turn/start`, the adapter's send
 * path calls `refreshThread`, which reads the whole transcript with `thread/read` and `includeTurns: true`,
 * applies it, and saves the thread record, so that input typed in native Codex is caught before Sotto replies.
 * Since #324 a send first asks for the newest turn alone with `thread/turns/list` and reads the whole transcript
 * only when that turn is not the one Sotto already holds. This seeds a thread with 50, 500 and 2,000 completed
 * turns in the fake Codex app-server under `tests/fixtures/`, opens it, and times several sends against it, each
 * after the last one's turn has finished: the whole send to `accepted`, `refreshThread` inside it, and within that
 * the `thread/read` and `thread/turns/list` round trips and the applying and saving done inside them. It counts
 * both requests per send and weighs the replies the fake sent, and, for comparison, the newest turn and its user
 * message alone: the only part of the transcript the `expectedLastUserMessageId` check compares. It then sends the
 * way the Threads page does, through the coordinator over the wrapped adapter, and counts the whole reads each send
 * made before `turn/start` and after it, and the newest-turn checks before it (#765). Counters, sizes and timers only; every seeded text is filler. It asserts no time, so it runs only under `SOTTO_PERF_BENCH=1`
 * (`tests/fixtures/perfBench.ts`). Add `SOTTO_PERF_WITHOUT_TURNS_LIST=1` for the same run with the check switched
 * off, which is how a send read before #324:
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/codexSendRead.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *   SOTTO_PERF_BENCH=1 SOTTO_PERF_WITHOUT_TURNS_LIST=1 npx vitest run tests/perf/codexSendRead.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CodexAppServerHost } from '../../src/main/agents/codex'
import { aroundTurnStart, historyReads } from '../fixtures/codexFixture'
import { opened, seededCodexThread, type CodexFixture as Fixture, type FakeThread } from '../fixtures/codexSeededThread'
import { manualSendCoordinator } from '../fixtures/manualSendCoordinator'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

const SENDS = 5
/** Measure the send as it was before #324: the fake refuses `thread/turns/list` as a Codex without it does. */
const WITHOUT_TURNS_LIST = process.env.SOTTO_PERF_WITHOUT_TURNS_LIST === '1'
const SIZES = [50, 500, 2000] as const
type Stage = 'refreshThread' | 'read' | 'newestTurn' | 'applyThread' | 'persist'
const STAGES = ['refreshThread', 'read', 'newestTurn', 'applyThread', 'persist'] as const

/**
 * Time the adapter's own steps while the benchmark runs. `read` and `newestTurn` are `rpc` for `thread/read` and
 * `thread/turns/list`: the request, the fake's reply, parsing it and the adapter's callback. `applyThread` and
 * `persist` count only inside those callbacks, so the send's other saves (its outbox origin, the turn it started)
 * stay out of them.
 */
const spent = new Map<Stage, number>()
const originals = new Map<string, unknown>()
let reading = 0
function instrument(): void {
  const prototype = CodexAppServerHost.prototype as unknown as Record<string, (...args: unknown[]) => unknown>
  const timed = (name: string, stage: Stage, when: (args: unknown[]) => boolean, around?: { enter(): void; leave(): void }): void => {
    const original = prototype[name]!
    // `rpc` is wrapped twice, once per stage; keep the method itself, not the first wrapper, for restore().
    if (!originals.has(name)) originals.set(name, original)
    prototype[name] = function (this: unknown, ...args: unknown[]) {
      if (!when(args)) return original.apply(this, args)
      const startedAt = performance.now()
      const stop = (): void => { spent.set(stage, (spent.get(stage) ?? 0) + performance.now() - startedAt); around?.leave() }
      around?.enter()
      let result: unknown
      try { result = original.apply(this, args) } catch (error) { stop(); throw error }
      if (result instanceof Promise) return result.finally(stop)
      stop(); return result
    }
  }
  timed('refreshThread', 'refreshThread', () => true)
  const inside = { enter: () => { reading++ }, leave: () => { reading-- } }
  timed('rpc', 'read', args => args[0] === 'thread/read', inside)
  timed('rpc', 'newestTurn', args => args[0] === 'thread/turns/list', inside)
  timed('applyThread', 'applyThread', () => reading > 0)
  timed('persist', 'persist', () => reading > 0)
}
function restore(): void {
  const prototype = CodexAppServerHost.prototype as unknown as Record<string, unknown>
  for (const [name, original] of originals) prototype[name] = original
  originals.clear()
}

async function replies(root: string): Promise<{ method: string; bytes: number }[]> {
  return (await readFile(join(root, 'replies.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { method: string; bytes: number })
}

/**
 * A seeded thread (`codexSeededThread.ts`) whose fake records the size of every reply. Under
 * `SOTTO_PERF_WITHOUT_TURNS_LIST=1` the fake is a Codex without `thread/turns/list`, so every send reads the whole
 * transcript as it did before #324: that run gives the "before" figures.
 */
const seededFixture = (turns: number, wrapped = false) =>
  seededCodexThread(turns, wrapped, { recordReplyBytes: true, ...(WITHOUT_TURNS_LIST ? { withoutTurnsList: true } : {}) })
/** A seeded thread opened the way the Threads page opens it, on the adapter alone. */
async function seeded(turns: number): Promise<{ f: Fixture; id: string; openMs: number }> {
  const { f, id } = await seededFixture(turns)
  await f.host.connect()
  const startedAt = performance.now()
  f.host.observeThreads?.([id])
  return { f, id, openMs: await opened(f, id, startedAt) }
}

/** The whole reads a send made before its `turn/start` and after it, and the newest-turn checks before it (#765). */
async function wholeReads(f: Fixture, from: number): Promise<{ before: number; after: number; checks: number }> {
  const { before, after } = aroundTurnStart((await f.driver.requests()).slice(from))
  const whole = (requests: typeof before) => historyReads(requests).filter(read => read === 'read').length
  return { before: whole(before), after: whole(after), checks: historyReads(before).filter(read => read === 'turns').length }
}

const lastUser = (f: Fixture, id: string): string | null =>
  (f.adapter as unknown as { log: { lastUserMessageId(id: string): string | undefined } }).log.lastUserMessageId(id) ?? null

describe.skipIf(!PERF_BENCH)('Codex send-time read on a long thread', () => {
  beforeAll(instrument)
  afterAll(restore)

  for (const turns of SIZES) {
    it(`at ${turns} turns`, async () => {
      const { f, id, openMs } = await seeded(turns)
      try {
        const samples: Record<Stage | 'send', number[]> = { send: [], refreshThread: [], read: [], newestTurn: [], applyThread: [], persist: [] }
        const sent: { method: string; bytes: number }[] = []
        for (let index = 0; index < SENDS; index++) {
          const before = (await replies(f.root)).length
          spent.clear()
          const messageId = randomUUID()
          const startedAt = performance.now()
          const result = await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId, text: 'Synthetic prompt', expectedLastUserMessageId: lastUser(f, id) })
          samples.send.push(performance.now() - startedAt)
          expect(result).toEqual({ accepted: true })
          for (const stage of STAGES) samples[stage].push(spent.get(stage) ?? 0)
          sent.push(...(await replies(f.root)).slice(before))
          await f.driver.completeTurn(id, 'Synthetic reply')
          await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.status, { timeout: 60_000, interval: 20 }).toBe('idle')
        }
        const state = JSON.parse(await readFile(join(f.root, 'state.json'), 'utf8')) as { threads: Record<string, FakeThread> }
        const native = state.threads[await f.realId(id)]!
        const last = native.turns.at(-1)!
        // What `thread/turns/list` with `limit: 1` carries: one turn in a page, and the user message in it.
        const lastTurnBytes = Buffer.byteLength(JSON.stringify({ id: 1, result: { data: [last], nextCursor: 'cursor', backwardsCursor: 'cursor' } })) + 1
        const lastUserBytes = Buffer.byteLength(JSON.stringify(last.items.findLast(item => item.type === 'userMessage')))
        const weighed = (method: string) => {
          const bytes = sent.filter(reply => reply.method === method).map(reply => reply.bytes)
          return { perSend: bytes.length / SENDS, maxBytes: bytes.length ? Math.max(...bytes) : 0 }
        }
        console.info(`codex send read: ${JSON.stringify({ turns, sends: SENDS, openMs: round(openMs), sendMedianMs: round(median(samples.send)),
          ...Object.fromEntries(STAGES.map(stage => [`${stage}MedianMs`, round(median(samples[stage]))])),
          threadRead: weighed('thread/read'), turnsList: weighed('thread/turns/list'), newestTurnBytes: lastTurnBytes, newestUserMessageBytes: lastUserBytes })}`)
      } finally { await f.cleanup() }
    }, 600_000)
  }

  // What a user sees: a send from the Threads page goes through the coordinator, which reads the thread before
  // dispatching and again after Codex accepts when its echo has not already settled the send.
  for (const turns of SIZES) {
    it(`from the Threads page at ${turns} turns`, async () => {
      const { f, id } = await seededFixture(turns, true)
      const control = await manualSendCoordinator(f.root, f.host)
      try {
        await control.start(); await control.command({ type: 'connect' })
        const startedAt = performance.now()
        await control.command({ type: 'observe-threads', threadIds: [id] })
        const openMs = await opened(f, f.registry.byThread(id)!.sessionId, startedAt)
        const samples: Record<Stage | 'send', number[]> = { send: [], refreshThread: [], read: [], newestTurn: [], applyThread: [], persist: [] }
        const reads: { before: number; after: number; checks: number }[] = []
        for (let index = 0; index < SENDS; index++) {
          const from = (await f.driver.requests()).length
          spent.clear()
          const startedAt = performance.now()
          const result = await control.command({ type: 'manual-send', threadId: id, text: 'Synthetic prompt' })
          samples.send.push(performance.now() - startedAt)
          // A refused send would be timed as a fast one with no reads.
          expect(result.error).toBeNull()
          for (const stage of STAGES) samples[stage].push(spent.get(stage) ?? 0)
          reads.push(await wholeReads(f, from))
          await f.driver.completeTurn(id, 'Synthetic reply')
          await expect.poll(async () => { await control.command({ type: 'refresh' }); return control.get().host.threads.find(thread => thread.id === id)?.status },
            { timeout: 60_000, interval: 50 }).toBe('idle')
        }
        console.info(`codex send read, Threads page: ${JSON.stringify({ turns, sends: SENDS, openMs: round(openMs), sendMedianMs: round(median(samples.send)),
          ...Object.fromEntries(STAGES.map(stage => [`${stage}MedianMs`, round(median(samples[stage]))])),
          wholeReadsBeforeTurnStart: reads.map(read => read.before), wholeReadsAfterTurnStart: reads.map(read => read.after),
          newestTurnChecksBeforeTurnStart: reads.map(read => read.checks) })}`)
      } finally { control.dispose(); await control.privacyChanged(); await f.cleanup() }
    }, 600_000)
  }
})
