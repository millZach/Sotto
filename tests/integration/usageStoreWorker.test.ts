// @vitest-environment node
/**
 * Usage's store runs on the usage store worker, never on main (ADR-0083, October 27 amendment). Opening Usage once held
 * main for about five seconds while `usage:read` queried a 326 MB `usage.sqlite` there. This runs one service through
 * every store path, start and its migration, live token and prompt flushes, recovery, the page's reads, a history import, Clear with its revision check and closing, through the
 * built worker, and counts every SQLite connection this thread opens: it must open none. A second service runs the same
 * steps with its store on main, and both must show the same figures.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentHost } from '../../src/main/agents/host'
import { UsageService } from '../../src/main/agents/usageService'
import { UsageStore } from '../../src/main/agents/usageStore'
import { UsageStoreOnWorkers } from '../../src/main/agents/usageStoreClient'
import type { UsageHistorySink } from '../../src/main/agents/usageHistory/sink'
import type { UsageLocalRead, UsagePromptSubmission, UsageTokenObservation } from '../../src/shared/usageDashboard'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { builtStoreWorker } from '../fixtures/storeWorker'

const connections = vi.hoisted(() => ({ opened: 0 }))
vi.mock('node:sqlite', async importOriginal => {
  const actual = await importOriginal<typeof import('node:sqlite')>()
  // Counts connections opened on this thread. The worker loads its own `node:sqlite`, so its connections never pass here.
  class CountedDatabaseSync extends actual.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) { super(...args); connections.opened += 1 }
  }
  return { ...actual, DatabaseSync: CountedDatabaseSync, default: { ...actual, DatabaseSync: CountedDatabaseSync } }
})

const at = '2026-10-12T12:00:00.000Z'
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const token = (patch: Partial<UsageTokenObservation> = {}): UsageTokenObservation => ({ providerId: 'codex', threadId: 'thread-1',
  modelId: 'native-model', recordKey: hash('request'), groupKey: hash('turn'), at, phase: 'live', partial: false,
  tokens: { input: 100, output: 20, cached: 40 }, ...patch })
const submission: UsagePromptSubmission = { providerId: 'codex', threadId: 'thread-1', messageId: 'message-1',
  modelId: 'selected-model', at, kind: 'user', inputKind: 'send' }
const history = (index: number): UsageTokenObservation => ({ ...token({ recordKey: hash(`history-${index}`), groupKey: undefined, phase: 'replay',
  at: `2026-09-${String(10 + (index % 18)).padStart(2, '0')}T10:00:00.000Z`, tokens: { input: index, output: 1 } }), origin: 'history', source: 'outside', client: 'codex-cli' })

let worker: Awaited<ReturnType<typeof builtStoreWorker>>
const roots: string[] = []
beforeAll(async () => { worker = await builtStoreWorker('usageStoreWorker') }, 60_000)
afterAll(async () => {
  await worker?.dispose()
  for (const root of roots) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-usage-worker-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

interface Run { readonly reads: UsageLocalRead[]; readonly stale: string; readonly cleared: string }

/** The same steps for either store: what each read showed. */
async function run(store: string | null): Promise<Run> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-usage-worker-')); roots.push(root)
  const fake = new FakeProviderHost()
  fake.state.connected = true
  fake.state.threads[0]!.providerId = 'codex'
  fake.state.models[0]!.providerId = 'codex'
  const host: AgentHost = fake
  let observe: ((record: UsageTokenObservation) => void) | undefined
  host.subscribeUsage = listener => { observe = listener; return () => { observe = undefined } }
  // The scan waits until the page's first reads are done, so what they show does not depend on how far the import got.
  let open: () => void = () => undefined
  const gate = new Promise<void>(resolve => { open = resolve })
  host.scanUsageHistory = async (sink: UsageHistorySink) => {
    await gate
    for (let index = 0; index < 5_000; index += 1_000) {
      sink.tokens(Array.from({ length: 1_000 }, (_, offset) => history(index + offset)))
      sink.setCursors([{ key: `codex:file-${index}`, cursor: { size: 10, mtimeMs: 1, offset: 10 } }])
      await sink.settled?.()
    }
  }
  const service = new UsageService({ directory: root, host, worker: store, acceptedPromptIdentities: identities => identities })
  const reads: UsageLocalRead[] = []
  try {
    service.start(); fake.emit()
    for (let index = 0; index < 50; index += 1) observe!(token({ recordKey: hash(`live-${index}`), tokens: { input: index, output: 2 } }))
    service.submitPrompt(submission)
    service.acceptPrompt(submission.threadId, submission.messageId)
    reads.push((await service.read({ timeZone: 'America/Los_Angeles' })).activity!)
    reads.push((await service.read({ timeZone: 'America/Los_Angeles', providerIds: ['codex'] })).activity!)
    // The first read started a history pass, held until now; its rows are counted once it finishes.
    open()
    await vi.waitFor(async () => expect((await service.read()).activity!.metadata.history?.status).toBe('complete'), { timeout: 10_000 })
    const imported = (await service.read({ from: '2026-09-01', to: '2026-09-30', timeZone: 'UTC' })).activity!
    reads.push(imported)
    const stale = (await service.clear({ expectedRevision: imported.metadata.revision - 1 })).status
    const latest = (await service.read()).activity!
    const cleared = (await service.clear({ expectedRevision: latest.metadata.revision })).status
    observe!(token({ recordKey: hash('after-clear'), groupKey: hash('new-turn'), liveNewGroup: true }))
    reads.push((await service.read()).activity!)
    return { reads, stale, cleared }
  } finally { service.close() }
}

/** What a read shows, without the instants a run makes for itself. */
function figures(read: UsageLocalRead, index: number): unknown {
  const { metadata, ...rest } = read
  // Whether a pass is under way, before it finished, depends on timing rather than on what the store holds.
  return { ...rest, metadata: { revision: metadata.revision, generation: metadata.generation, ...(index === 2 ? { history: metadata.history?.status } : {}) } }
}

describe('usage store worker', () => {
  it('runs every Usage store read and write off main, with the figures the store on main gives', async () => {
    const onMain = await run(null)
    expect(connections.opened).toBeGreaterThan(0)
    connections.opened = 0
    const offMain = await run(worker.path)
    expect(connections.opened).toBe(0)

    expect([offMain.stale, offMain.cleared]).toEqual(['stale', 'cleared'])
    expect([onMain.stale, onMain.cleared]).toEqual(['stale', 'cleared'])
    expect(offMain.reads[0]!.totals.prompts.total).toBe(1)
    expect(offMain.reads[2]!.totals.tokenRecords).toBe(5_000)
    expect(offMain.reads.at(-1)!.totals.tokenRecords).toBe(1)
    expect(offMain.reads.map(figures)).toEqual(onMain.reads.map(figures))
  }, 60_000)

  it('writes a live flush after the history batch queued before it, so the live figures stand', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-usage-worker-')); roots.push(root)
    const path = join(root, 'usage.sqlite')
    // The file made here, so a connection on this thread can hold its write lock: the barrier the writer waits behind.
    const made = new UsageStore(path); made.open(); made.close()
    const barrier = new DatabaseSync(path, { timeout: 5_000 })
    barrier.exec('BEGIN IMMEDIATE')
    const client = new UsageStoreOnWorkers(path, worker.path)
    try {
      const identity = { providerId: 'claude' as const, threadId: 'thread-1', recordKey: hash('message-1'), modelId: 'claude-opus-5-5', at, partial: false }
      // Everything is queued while the writer is held at its first request, opening the file behind the lock.
      const opened = client.request({ kind: 'open' })
      const imported = client.request({ kind: 'history', pass: 1, write: { kind: 'tokens', batch: [{ ...identity, phase: 'replay', origin: 'history',
        source: 'outside', client: 'claude-code', tokens: { input: 100, output: 10 } }] } })
      const flushed = client.request({ kind: 'flush', flush: { retry: false, seed: false, prompts: [],
        tokens: [{ ...identity, phase: 'live', tokens: { input: 100, output: 20 } }] } })
      barrier.exec('COMMIT')
      await Promise.all([opened, imported])
      expect(await flushed).toEqual({ tokens: 1, prompts: 0, seed: false })
      const read = await client.request({ kind: 'query', query: {} })
      expect(read.totals.tokens.output.value).toBe(20)
    } finally { client.close(); barrier.close() }
  }, 60_000)
})
