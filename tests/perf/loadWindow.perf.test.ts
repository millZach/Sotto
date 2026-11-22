// @vitest-environment node
/**
 * Measures `readMessages(..., { turns: 10 })` query cost and `WorkspaceHost.observeThreads()` main-thread block time
 * when opening a large thread with wide assistant message texts (#2733).
 *
 *   PowerShell:  $env:SOTTO_PERF_BENCH = '1'; npx vitest run tests/perf/loadWindow.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *   sh:          SOTTO_PERF_BENCH=1 npx vitest run tests/perf/loadWindow.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIRST_WINDOW_TURNS, ThreadStore } from '../../src/main/agents/threadStore'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { heldProvidersOf } from '../../src/shared/heldProviders'
import type { AgentMessage } from '../../src/shared/agents'
import type { ThreadEvent } from '../../src/shared/threadEvents'
import { EventProvider, WORKSHOP } from '../fixtures/storeWriterEquivalence'
import { builtStoreWorker } from '../fixtures/storeWorker'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

const TURNS = 15
const ASSISTANT_MESSAGES_PER_TURN = 60
const ASSISTANT_CHARS = 16_384
const QUERY_SAMPLES = 15
const OBSERVE_SAMPLES = 9
const AT = '2026-11-22T12:00:00.000Z'

const wideText = (seed: number): string =>
  `${seed}:` + randomBytes(Math.ceil((ASSISTANT_CHARS * 3) / 4)).toString('base64').slice(0, ASSISTANT_CHARS)

function seedLargeThread(dbPath: string, threadId: string): void {
  const store = new ThreadStore(dbPath, undefined, null)
  store.open()
  try {
    const events: ThreadEvent[] = []
    for (let turn = 0; turn < TURNS; turn++) {
      const user: AgentMessage = { id: `u-${turn}`, role: 'user', text: `User turn ${turn}`, createdAt: AT }
      events.push({ kind: 'message-added', at: AT, message: user })
      for (let reply = 0; reply < ASSISTANT_MESSAGES_PER_TURN; reply++) {
        const assistant: AgentMessage = { id: `a-${turn}-${reply}`, role: 'assistant', text: wideText(turn * 100 + reply), createdAt: AT }
        events.push({ kind: 'message-added', at: AT, message: assistant })
      }
    }
    store.appendMany(threadId, events)
  } finally {
    store.close()
  }
}

describe.skipIf(!PERF_BENCH)('loadWindow query and engine main-thread block benchmark (requires SOTTO_PERF_BENCH=1)', () => {
  let worker: Awaited<ReturnType<typeof builtStoreWorker>>
  const roots: string[] = []

  beforeAll(async () => {
    worker = await builtStoreWorker()
  }, 120_000)

  afterAll(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
    await worker?.dispose()
  })

  it('measures readMessages boundary query + observeThreads main-thread block time on a wide multi-message thread', async () => {
    const expectedWindowMessages = FIRST_WINDOW_TURNS * (1 + ASSISTANT_MESSAGES_PER_TURN)
    const directory = await mkdtemp(join(tmpdir(), 'sotto-load-window-bench-'))
    roots.push(directory)
    const dbPath = join(directory, 'threads.sqlite')
    seedLargeThread(dbPath, WORKSHOP)

    // 1. Direct SQLite readMessages(turns: 10) + boundary query + EXPLAIN QUERY PLAN
    const store = new ThreadStore(dbPath, undefined, null)
    store.open()
    const db = (store as unknown as { db: DatabaseSync }).db
    const plan = db
      .prepare("EXPLAIN QUERY PLAN SELECT position FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY position DESC LIMIT ?")
      .all(WORKSHOP, FIRST_WINDOW_TURNS)
      .map(row => String(row.detail))

    const boundarySamples: number[] = []
    const readWindowSamples: number[] = []
    const boundaryStmt = db.prepare("SELECT position FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY position DESC LIMIT ?")
    for (let sample = 0; sample < QUERY_SAMPLES; sample++) {
      const bStart = performance.now()
      const rows = boundaryStmt.all(WORKSHOP, FIRST_WINDOW_TURNS)
      boundarySamples.push(performance.now() - bStart)
      expect(rows).toHaveLength(FIRST_WINDOW_TURNS)

      const wStart = performance.now()
      const window = store.readMessages(WORKSHOP, { turns: FIRST_WINDOW_TURNS })
      readWindowSamples.push(performance.now() - wStart)
      expect(window.messages).toHaveLength(expectedWindowMessages)
      expect(window.earlierAvailable).toBe(true)
    }
    store.close()

    // 2. WorkspaceHost.observeThreads() over the real store worker: synchronous main-thread block time + end-to-end arrival
    const adapter = new EventProvider()
    const project = join(directory, 'project')
    await mkdir(project)
    adapter.state.projects[0]!.path = project
    const host = new WorkspaceHost(adapter, directory, {
      historyEnabled: () => true,
      watcherEnabled: false,
      heldProviders: heldProvidersOf({ muse: false }),
      streamingPublishCostEnabled: true,
      storeWorker: { path: worker.path },
    })
    try {
      await host.initialize()
      await host.connect()
      host.observeThreads([])

      const mainBlockSamples: number[] = []
      const endToEndSamples: number[] = []
      const waitForLoaded = async (): Promise<void> => {
        const loaded = () => (host.workspaceSnapshot().threads.find(t => t.id === WORKSHOP)?.messages.length ?? 0) === expectedWindowMessages
        if (loaded()) return
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { unsub(); reject(new Error('Window did not load in time')) }, 10_000)
          const unsub = host.subscribe(() => {
            if (loaded()) { clearTimeout(timer); unsub(); resolve() }
          })
          if (loaded()) { clearTimeout(timer); unsub(); resolve() }
        })
      }

      for (let sample = 0; sample < OBSERVE_SAMPLES; sample++) {
        host.observeThreads([])
        const started = performance.now()
        host.observeThreads([WORKSHOP])
        const syncBlockMs = performance.now() - started
        await waitForLoaded()
        const totalMs = performance.now() - started
        mainBlockSamples.push(syncBlockMs)
        endToEndSamples.push(totalMs)
      }

      console.log(`EXPLAIN QUERY PLAN: ${plan.join(' | ')}`)
      console.log(`boundary query (turns=${FIRST_WINDOW_TURNS}): median ${round(median(boundarySamples), 2)} ms (min ${round(Math.min(...boundarySamples), 2)}, max ${round(Math.max(...boundarySamples), 2)})`)
      console.log(`readMessages (turns=${FIRST_WINDOW_TURNS}): median ${round(median(readWindowSamples), 2)} ms (min ${round(Math.min(...readWindowSamples), 2)}, max ${round(Math.max(...readWindowSamples), 2)})`)
      console.log(`observeThreads main-thread block: median ${round(median(mainBlockSamples), 2)} ms (min ${round(Math.min(...mainBlockSamples), 2)}, max ${round(Math.max(...mainBlockSamples), 2)})`)
      console.log(`observeThreads end-to-end load: median ${round(median(endToEndSamples), 2)} ms (min ${round(Math.min(...endToEndSamples), 2)}, max ${round(Math.max(...endToEndSamples), 2)})`)
    } finally {
      host.disconnect()
      await host.close().catch(() => undefined)
    }
  }, 60_000)
})
