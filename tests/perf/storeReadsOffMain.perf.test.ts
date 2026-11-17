// @vitest-environment node
/**
 * What two reads of the thread store cost main (November 17, 2026: a 4.3 s freeze caught inside both). Every word is
 * random; nothing of a person's is read.
 *
 * - The message scrubber's read (`promptsBefore`, ADR-0109) over a thread of 2,500 turns, made on main and made through
 *   the store worker: main's busy time per read, from its event loop's utilization, and the read's wall time.
 * - Watcher's own-change marking while Watcher is out of view and another thread streams: main's time per publish and how
 *   many times Watcher's window of 1,000 turns is read from the store. Run it against the code before the change for the
 *   numbers before it (docs/perf/2026-11-17-store-reads-off-main.md says how).
 *
 * It asserts no time, so it runs only under `SOTTO_PERF_BENCH=1`; `workspaceStoreWorker.test.ts` and
 * `watcherOwnChangeHistory.test.ts` hold the two changes in the default run by count:
 *
 *   PowerShell:  $env:SOTTO_PERF_BENCH = '1'; npx vitest run tests/perf/storeReadsOffMain.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ThreadHostEvent } from '../../src/main/agents/host'
import { ThreadMessageLog } from '../../src/main/agents/threadMessageLog'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { ThreadStoreWriterOnWorker } from '../../src/main/agents/threadStoreWriter'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import type { AgentMessage } from '../../src/shared/agents'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { builtStoreWorker } from '../fixtures/storeWorker'

const TURNS = 2_500
const READS = 25
const WATCHER_TURNS = 1_000
const UPDATES = 200
const at = (index: number): string => new Date(Date.UTC(2026, 10, 17, 9, 0, index)).toISOString()
const words = (size: number): string => randomBytes(Math.ceil(size * 0.75)).toString('base64').slice(0, size).replace(/[+/]/gu, ' ')

function history(turns: number): AgentMessage[] {
  return Array.from({ length: turns }, (_, turn) => [
    { id: `u${turn}`, role: 'user' as const, text: words(200 + (turn % 7) * 150), createdAt: at(turn * 3) },
    { id: `n${turn}`, role: 'assistant' as const, text: words(120), createdAt: at(turn * 3 + 1) },
    { id: `a${turn}`, role: 'assistant' as const, text: `${words(1_500)}\n\n${words(1_500)}?`, createdAt: at(turn * 3 + 2) },
  ]).flat()
}

/** Main's busy milliseconds across `work`, from its event loop's utilization, with the wall time beside it. */
async function busy(work: () => Promise<unknown> | unknown): Promise<{ busyMs: number; wallMs: number }> {
  const before = performance.eventLoopUtilization()
  const started = performance.now()
  await work()
  const wallMs = performance.now() - started
  const used = performance.eventLoopUtilization(before)
  // Work inside one task shows as wall time, as nothing idles across it.
  return { busyMs: Math.max(used.active, 0) || wallMs, wallMs }
}

class EventProvider extends FakeProviderHost {
  readonly log = new ThreadMessageLog()
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void { return this.log.subscribeEvents(listener) }
}

describe.skipIf(!PERF_BENCH)('two reads of the thread store, on main and off it', () => {
  let worker: Awaited<ReturnType<typeof builtStoreWorker>>
  let root: string
  beforeAll(async () => {
    worker = await builtStoreWorker()
    root = await mkdtemp(join(tmpdir(), 'sotto-store-reads-bench-'))
  }, 120_000)
  afterAll(async () => { await worker?.dispose(); if (root) await rm(root, { recursive: true, force: true }) })

  it('the message scrubber’s read: main’s busy time per read on main and through the store worker', async () => {
    const path = join(root, 'scrubber.sqlite')
    const seed = new ThreadStore(path, undefined, null)
    seed.open(); seed.replaceThreadMessages('long', history(TURNS), 'epoch'); seed.close()
    const store = new ThreadStore(path, undefined, { path: worker.path })
    store.open()
    const writer = new ThreadStoreWriterOnWorker(store)
    try {
      const before = `u${TURNS - 10}`
      const skip = new Set<string>()
      const onMain = store.promptsBefore('long', before, skip)
      const offMain = await writer.readPrompts('long', before, skip)
      expect(offMain).toEqual({ prompts: onMain })
      const main: { busyMs: number; wallMs: number }[] = []
      const off: { busyMs: number; wallMs: number }[] = []
      for (let read = 0; read < READS; read++) {
        main.push(await busy(() => store.promptsBefore('long', before, skip)))
        off.push(await busy(() => writer.readPrompts('long', before, skip)))
      }
      const report = (samples: typeof main) => `main busy median ${round(median(samples.map(sample => sample.busyMs)))} ms (worst ${round(Math.max(...samples.map(sample => sample.busyMs)))}), wall median ${round(median(samples.map(sample => sample.wallMs)))} ms`
      console.log(`scrubber read over ${TURNS} turns, on main: ${report(main)}`)
      console.log(`scrubber read over ${TURNS} turns, on the store worker: ${report(off)}`)
    } finally { writer.close() }
  }, 300_000)

  it('Watcher’s marking out of view: main’s time per publish while another thread streams, and Watcher’s store reads', async () => {
    const directory = await mkdtemp(join(root, 'watcher-'))
    const provider = new EventProvider()
    const watcher = provider.state.threads[0]!.id
    const other = provider.state.threads[1]!.id
    const host = new WorkspaceHost(provider, directory, { historyEnabled: () => true, watcherEnabled: true, storeWorker: { path: worker.path } })
    try {
      await host.initialize(); await host.connect(); host.observeThreads([watcher])
      await host.setWatcherKind(watcher, 'watcher')
      const messages = history(WATCHER_TURNS)
      provider.state.threads[0]!.messages = messages
      provider.log.set(watcher, messages)
      provider.emit()
      await host.snapshot()
      await host.flush()
      host.observeThreads([])
      host.workspaceSnapshot()
      const read = vi.spyOn(ThreadStore.prototype, 'readMessages')
      const times: number[] = []
      for (let update = 0; update < UPDATES; update++) {
        provider.log.add(other, { id: `other-${update}`, role: 'assistant', text: words(400), createdAt: at(update) })
        const started = performance.now()
        host.workspaceSnapshot()
        times.push(performance.now() - started)
      }
      const watcherReads = read.mock.calls.filter(([threadId]) => threadId === watcher).length
      read.mockRestore()
      console.log(`Watcher out of view, ${UPDATES} publishes for another thread: median ${round(median(times), 2)} ms per publish, ${watcherReads} reads of Watcher's window (${round(watcherReads / UPDATES, 2)} per publish)`)
    } finally { host.disconnect(); await host.close().catch(() => undefined) }
  }, 300_000)
})
