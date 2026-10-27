// @vitest-environment node
/**
 * What opening a stored thread holds main for once the store worker reads it back (#1457, step 3 of
 * docs/plans/store-worker.md). Before it, `holdActivities` read the thread's whole activity on main: one query for up to
 * 2,000 rows, about 10 MB, then `JSON.parse` and the activity schema for each row, 0.61 s for one thread in the owner's
 * recording. The worker now runs the query, the parse and the schema; main receives the list, which is a structured-clone
 * read, and freezes each record.
 *
 * The first test counts, so it runs in the default suite: a thread holding the record limit, read back over the worker the
 * build compiles, arrives in pieces of `READ_PIECE_RECORDS`, each received in a task of its own, and main neither ran the
 * read nor checked one record against the schema. The second times what main is held for, receiving each piece and
 * freezing it, against the read on main it replaces, and what one piece holds main for at each size, the whole list
 * among them. It asserts nothing:
 *
 *   PowerShell:  $env:SOTTO_PERF_BENCH = '1'; npx vitest run tests/perf/storedActivityReadBack.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * `SOTTO_PERF_RECORD_SCALE` multiplies every body's size (5 by default, about 10 MB across the limit). Every word is
 * random; no user profile is opened.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { MessageChannel, receiveMessageOnPort, type MessagePort } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ownBuiltActivity } from '../../src/main/agents/activitySnapshots'
import { READ_PIECE_RECORDS, type WorkerMessage } from '../../src/main/agents/storeWorkerProtocol'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { ThreadStoreWriterOnWorker } from '../../src/main/agents/threadStoreWriter'
import { agentActivitySchema, MAX_AGENT_ACTIVITIES, type AgentActivity } from '../../src/shared/agentActivity'
import { activityRecordMix } from '../fixtures/activityRecordMix'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { builtStoreWorker } from '../fixtures/storeWorker'

const SAMPLES = 9
const SCALE = Number(process.env.SOTTO_PERF_RECORD_SCALE ?? 5)

const record = activityRecordMix(SCALE)

/** What the workspace does with a list once it is in hand (`savedRecord`): a record still running in the store was not live. */
const held = (activities: readonly AgentActivity[]): AgentActivity[] => activities.map(activity => activity.status === 'running' ? { ...activity, status: 'unknown' } : activity)

describe('a stored thread read back on the store worker', () => {
  let worker: Awaited<ReturnType<typeof builtStoreWorker>>
  let root: string
  let path: string
  let bytes = 0
  beforeAll(async () => {
    worker = await builtStoreWorker()
    root = await mkdtemp(join(tmpdir(), 'sotto-read-back-bench-'))
    path = join(root, 'threads.sqlite')
    const store = new ThreadStore(path, undefined, null)
    store.open()
    const records = Array.from({ length: MAX_AGENT_ACTIVITIES }, (_, index) => record(index))
    bytes = records.reduce((sum, item) => sum + JSON.stringify(item).length, 0)
    store.syncActivities('thread', records)
    store.close()
  }, 120_000)
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    await worker?.dispose()
  })

  it('reads the list on the worker and hands it back in pieces, each in a task of its own, parsing nothing on main', async () => {
    const store = new ThreadStore(path, undefined, worker.path)
    store.open()
    const writer = new ThreadStoreWriterOnWorker(store)
    // Counts the turns of main's event loop, so each piece can say which turn received it.
    let turns = 0, turning = true
    const turn = (): void => { turns++; if (turning) setImmediate(turn) }
    try {
      const parsed = vi.spyOn(agentActivitySchema, 'parse')
      const readOnMain = vi.spyOn(ThreadStore.prototype, 'readActivities')
      const heardAt: number[] = []
      const handle = store.writer! as unknown as { heard(message: WorkerMessage): void }
      const heard = handle.heard.bind(handle)
      vi.spyOn(handle, 'heard').mockImplementation(message => { heardAt.push(turns); heard(message) })
      setImmediate(turn)
      const back = await writer.readActivities('thread')
      expect(back && 'activities' in back ? back.activities.map(activity => activity.id) : []).toEqual(Array.from({ length: MAX_AGENT_ACTIVITIES }, (_, index) => `activity-${index}`))
      expect(heardAt).toHaveLength(Math.ceil(MAX_AGENT_ACTIVITIES / READ_PIECE_RECORDS))
      // No two pieces were received in one turn, so the window had its turn between each.
      for (let piece = 1; piece < heardAt.length; piece++) expect(heardAt[piece]).toBeGreaterThan(heardAt[piece - 1]!)
      expect(parsed).not.toHaveBeenCalled()
      expect(readOnMain).not.toHaveBeenCalled()
    } finally { turning = false; vi.restoreAllMocks(); writer.close() }
  }, 120_000)

  describe.skipIf(!PERF_BENCH)('timed (requires SOTTO_PERF_BENCH=1)', () => {
    it('times what main is held for: the read on main, each piece received from the worker, and one piece at each size', async () => {
      const onMain: number[] = [], worstPiece: number[] = [], total: number[] = []
      let pieceCount = 0
      for (let sample = 0; sample <= SAMPLES; sample++) {
        // The read `holdActivities` made on main, from a store that holds none of the records yet.
        const cold = new ThreadStore(path, undefined, null)
        cold.open()
        try {
          const started = performance.now()
          const records = held(cold.readActivities('thread', { shared: true }))
          if (sample > 0) onMain.push(performance.now() - started)
          expect(records).toHaveLength(MAX_AGENT_ACTIVITIES)
        } finally { cold.close() }
        // The worker reads it; main is held for each piece's receive, a structured-clone read done inside
        // `receiveMessageOnPort`, then for its freeze, and at the end for the mapping. Each piece is waited for without taking
        // it, so only the receive is timed, and main turns its event loop between pieces, as the store does.
        const store = new ThreadStore(path, undefined, worker.path)
        store.open()
        try {
          const handle = store.writer! as unknown as { port: MessagePort; heard(message: WorkerMessage): void }
          handle.port.removeAllListeners('message')
          let records: readonly AgentActivity[] | undefined
          store.writer!.read('thread', result => { if ('activities' in result) records = result.activities })
          const wait = new Int32Array(new SharedArrayBuffer(4))
          let most = 0, sum = 0, count = 0
          while (!records) {
            let received: { message: unknown } | undefined
            let took = 0
            for (let tries = 0; !received; tries++) {
              if (tries > 120_000) throw new Error('The worker never answered the read')
              const started = performance.now()
              received = receiveMessageOnPort(handle.port)
              took = performance.now() - started
              if (!received) Atomics.wait(wait, 0, 0, 1)
            }
            const freezing = performance.now()
            handle.heard(received.message as WorkerMessage)
            let piece = took + performance.now() - freezing
            if (records) { const mapping = performance.now(); expect(held(records)).toHaveLength(MAX_AGENT_ACTIVITIES); piece += performance.now() - mapping }
            most = Math.max(most, piece); sum += piece; count++
            // The next piece is asked for from a task of its own.
            if (!records) await new Promise(resolve => setImmediate(resolve))
          }
          if (sample > 0) { worstPiece.push(most); total.push(sum); pieceCount = count }
        } finally { store.close() }
      }
      // One piece's receive and freeze at each size, the whole list among them, each piece received apart.
      const list = Array.from({ length: MAX_AGENT_ACTIVITIES }, (_, index) => record(index))
      const pieces: Record<string, number> = {}
      const { port1, port2 } = new MessageChannel()
      try {
        for (const size of [MAX_AGENT_ACTIVITIES, 1_000, 500, 250]) {
          const worst: number[] = []
          for (let sample = 0; sample <= SAMPLES; sample++) {
            let most = 0
            for (let from = 0; from < list.length; from += size) {
              port1.postMessage(list.slice(from, from + size))
              const started = performance.now()
              const piece = receiveMessageOnPort(port2)!.message as AgentActivity[]
              for (const activity of piece) ownBuiltActivity(activity)
              most = Math.max(most, performance.now() - started)
            }
            if (sample > 0) worst.push(most)
          }
          pieces[`worstPiece${size}Ms`] = round(median(worst), 2)
        }
      } finally { port1.close(); port2.close() }
      const result = { records: MAX_AGENT_ACTIVITIES, mib: round(bytes / 1_048_576, 1), samples: SAMPLES, scale: SCALE,
        readOnMainMs: round(median(onMain), 1), pieces: pieceCount, worstPieceMs: round(median(worstPiece), 2), worstPieceMaxMs: round(Math.max(...worstPiece), 2),
        heldInAllMs: round(median(total), 2), ...pieces }
      console.log(`stored activity read back ${JSON.stringify(result)}`)
    }, 600_000)
  })
})
