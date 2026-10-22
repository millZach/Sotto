// @vitest-environment node
// SOTTO_PERF_BENCH=1 npx vitest run tests/perf/agentSavedSerialize.perf.test.ts --maxWorkers=1 --disable-console-intercept
/**
 * What a save with nothing new costs the coordinator (#1332). Main saves after every provider snapshot, and most change
 * nothing saved, so `persist()` builds the text of `agents.json` only to find it equal to the newest write. Before #1332
 * that text was `JSON.stringify` of the whole state; the Watcher record and the receipt ledgers, which are only ever
 * replaced, now keep their text. The state here has the owner's shape at 250 threads: a Watcher record of about 900 KB
 * (October 2026), full receipt ledgers, and a draft and a delivery for each thread.
 *
 * Reports, per call: `JSON.stringify` of the saved state (what every such save serialized before), the part of a
 * `persist()` with nothing new that runs before its first wait (building the saved state's text and comparing it with
 * the newest write), and the whole awaited `persist()`. Run on a checkout from before #1332 for the earlier numbers.
 */
import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import type { WatcherRecord } from '../../src/shared/watcher'
import { createAgentControl } from '../fixtures/agentControlFixture'
import { testCredentials } from '../fixtures/testCredentials'
import { watcherRecordFixture } from '../fixtures/watcher'

const PERF_BENCH = process.env.SOTTO_PERF_BENCH === '1'
const THREADS = 250
/** A copy of a real `agents.json` to time instead of the built state. It is read and saved in a temporary folder only. */
const OWN_FILE = process.env.SOTTO_PERF_AGENTS_JSON

type Inside = {
  state: { deliveries?: unknown[]; threadDrafts?: unknown[]; deliveredDrafts?: unknown[]; obsoleteDrafts?: unknown[] }
  deliveredPromptDigests: unknown[]
  answeredRequests: unknown[]
  savedOverLiveState(): Record<string, unknown>
  persist(): Promise<void>
  mutateWatcher(update: (record: WatcherRecord) => void): void
}

/** About the owner's Watcher record: hundreds of requests and operations and a thousand wake-up IDs. */
function ownerWatcherRecord(): WatcherRecord {
  const record = watcherRecordFixture()
  const request = record.requests[0]!, operation = record.operations[0]!, reservation = record.reservations[0]!
  const operations = Array.from({ length: 320 }, (_, index) => ({ ...operation, id: randomUUID(), retryKey: randomUUID(), digest: randomUUID().replaceAll('-', '').padEnd(64, '0'),
    target: { ...operation.target, threadId: `thread-${index % THREADS}` }, receiptId: randomUUID(), cardId: randomUUID(), messageId: randomUUID() }))
  record.operations = operations
  record.requests = [request, ...Array.from({ length: 340 }, () => ({ ...request, id: randomUUID(), state: 'closed' as const, closedAt: request.createdAt,
    rootUserMessageId: randomUUID(), participants: [] }))]
  record.reservations = operations.slice(0, 8).map(item => ({ ...reservation, operationId: item.id, target: item.target }))
  record.wakeEventIds = Array.from({ length: 1_000 }, () => randomUUID())
  return record
}

/** The rest of the owner's shape: full receipt ledgers, and a draft and an unresolved delivery for each thread. */
async function fill(inside: Inside): Promise<void> {
  inside.mutateWatcher(record => Object.assign(record, ownerWatcherRecord()))
  const receipts = (extra: object) => Array.from({ length: 128 }, (_, index) => ({ threadId: `thread-${index}`, draftId: randomUUID(), ...extra }))
  inside.state.deliveredDrafts = receipts({})
  inside.state.obsoleteDrafts = receipts({})
  inside.deliveredPromptDigests = receipts({ digest: randomUUID() + randomUUID() })
  inside.answeredRequests = receipts({ provider: 'codex', requestId: randomUUID(), questionsDigest: randomUUID() + randomUUID(), decisionId: randomUUID() })
  const now = new Date().toISOString()
  inside.state.threadDrafts = Array.from({ length: THREADS }, (_, index) => ({ threadId: `thread-${index}`, draftId: randomUUID(), text: 'A short draft the user left here.', attachments: [] }))
  inside.state.deliveries = Array.from({ length: THREADS }, (_, index) => ({ threadId: `thread-${index}`, draftId: randomUUID(), status: 'uncertain', createdAt: now, updatedAt: now }))
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

describe.skipIf(!PERF_BENCH)('a save with nothing new (#1332; requires SOTTO_PERF_BENCH=1)', () => {
  it(`costs a fraction of serializing the whole state at ${THREADS} threads`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-saved-serialize-'))
    const credentials = await testCredentials(root, { mode: 'unavailable' })
    const control = createAgentControl({ directory: root, host: new E2EAgentHost(), credentials, reasoner: e2eAgentReasoner })
    try {
      if (OWN_FILE) await copyFile(OWN_FILE, join(root, 'agents.json'))
      await control.start()
      const inside = control as unknown as Inside
      if (!OWN_FILE) await fill(inside)
      await inside.persist()
      const bytes = JSON.stringify(inside.savedOverLiveState()).length
      const time = (run: () => unknown, rounds = 200): number => {
        for (let index = 0; index < 20; index++) run()
        const samples: number[] = []
        for (let index = 0; index < rounds; index++) { const start = performance.now(); run(); samples.push(performance.now() - start) }
        return median(samples)
      }
      const whole = time(() => JSON.stringify(inside.savedOverLiveState()))
      const check = time(() => { void inside.persist() })
      const samples: number[] = []
      for (let index = 0; index < 200; index++) { const start = performance.now(); await inside.persist(); samples.push(performance.now() - start) }
      const persist = median(samples)
      expect(await readFile(join(root, 'agents.json'), 'utf8')).toBe(`${JSON.stringify(inside.savedOverLiveState())}
`)
      console.log(`agents.json ${(bytes / 1024).toFixed(0)} KB${OWN_FILE ? ' (given file)' : ` at ${THREADS} threads`}: JSON.stringify of the whole state ${whole.toFixed(3)} ms, persist with nothing new ${check.toFixed(3)} ms to its first wait, ${persist.toFixed(3)} ms awaited (medians)`)
      if (process.env.SOTTO_PERF_ASSERT === '1') expect(check).toBeLessThan(whole / 2)
    } finally {
      control.dispose(); await control.closed()
      await rm(root, { recursive: true, force: true })
    }
  })
})
