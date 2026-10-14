// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { UsageStore } from '../../src/main/agents/usageStore'
import type { UsageLocalQuery, UsageTokenObservation } from '../../src/shared/usageDashboard'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { expectWithinBudget, PERF_ASSERT } from '../fixtures/perfBudget'

const ROWS = 400_000
const PROMPTS = 6_000
const START = Date.parse('2026-04-21T00:00:00Z')
const SPAN = 176 * 86_400_000
const NOW = '2026-10-14T12:00:00.000Z'
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

/** A small deterministic generator, so every run measures the same history. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => { state = (state * 1_664_525 + 1_013_904_223) >>> 0; return state / 2 ** 32 }
}

/**
 * About the shape of the development laptop's history once imported: sessions that work in bursts a few seconds to
 * a minute apart, a third in Sotto and the rest elsewhere, half of them sub-agents, and a few thousand prompts.
 */
function seed(path: string, sparse: boolean): void {
  const db = new DatabaseSync(path)
  try {
    const insert = db.prepare(`INSERT INTO token_rows (provider,thread_id,record_key,model_id,at,day,partial,input,output,cached,cache_write,source,client,sub_agent)
      VALUES (?,?,?,?,?,?,0,?,?,?,?,?,?,?)`)
    const prompt = db.prepare(`INSERT INTO prompt_rows (thread_id,message_id,provider,model_id,at,day,kind,input_kind,source,client)
      VALUES (?,?,?,?,?,?,?,'send',?,?)`)
    const next = random(sparse ? 7 : 11)
    const models = { claude: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5'], codex: ['gpt-6-astra', 'gpt-6.1-sol', 'codex-auto-review'] } as const
    db.exec('BEGIN')
    let row = 0
    let prompts = 0
    for (let session = 0; row < ROWS; session++) {
      const provider = session % 2 ? 'claude' : 'codex'
      const elsewhere = session % 3 !== 0
      const client = !elsewhere ? 'sotto' : provider === 'claude' ? 'claude-code' : ['codex-exec', 'codex-app', 'codex-cli'][session % 3]!
      const subAgent = session % 4 >= 2 ? 1 : 0
      const thread = `${elsewhere ? 'elsewhere' : 'thread'}-${session}`
      const length = sparse ? 200 : 20 + Math.floor(next() * 100)
      let at = START + Math.floor(next() * SPAN)
      for (let index = 0; index < length && row < ROWS; index++, row++) {
        at = sparse ? START + Math.floor(next() * SPAN) : at + 2_000 + Math.floor(next() * 58_000)
        const instant = new Date(Math.min(at, START + SPAN)).toISOString()
        if (!subAgent && index % 12 === 0 && prompts < PROMPTS) {
          const before = new Date(Date.parse(instant) - 500).toISOString()
          prompt.run(thread, `message-${prompts++}`, provider, `native:${provider}:model:${provider === 'claude' ? 'opus' : 'gpt-6-astra'}`,
            before, before.slice(0, 10), prompts % 7 === 0 ? 'wake-up' : 'user', elsewhere ? 'elsewhere' : 'sotto', client)
        }
        insert.run(provider, thread, hash(`row-${row}`), `native:${provider}:model:${models[provider][index % (subAgent ? 3 : 2)]}`, instant, instant.slice(0, 10),
          10_000 + (row % 5_000), 200 + (row % 300), 8_000, 500, elsewhere ? 'elsewhere' : 'sotto', client, subAgent)
      }
    }
    db.exec('COMMIT')
  } finally { db.close() }
}

/** Median of five reads, each after a write so no read is answered from the store's reuse of an unchanged query. */
function timed(store: UsageStore, query: UsageLocalQuery): number {
  const samples: number[] = []
  for (let run = 0; run < 6; run++) {
    store.markLegacySeedCompleted()
    store.observeTokens({ providerId: 'grok', threadId: 'bench', recordKey: hash(`bump-${run}-${Math.random()}`), modelId: 'grok-4.7', tokens: { input: 1, output: 1 },
      at: NOW, phase: 'live', partial: false, liveNewGroup: true, groupKey: hash(`bump-group-${run}-${Math.random()}`) })
    const started = performance.now()
    store.query(query)
    if (run) samples.push(performance.now() - started)
  }
  return round(median(samples))
}

const queries: Record<string, UsageLocalQuery> = {
  'All time, UTC': {},
  'All time, Los Angeles': { timeZone: 'America/Los_Angeles' },
  'Last 30 days, Los Angeles': { timeZone: 'America/Los_Angeles', from: '2026-09-15', to: '2026-10-14' },
  'Last 7 days, Kolkata, elsewhere only': { timeZone: 'Asia/Kolkata', from: '2026-10-08', to: '2026-10-14', sources: ['elsewhere'] },
  'Since a 5-hour window start': { timeZone: 'America/Los_Angeles', since: '2026-10-14T03:07:30.000Z' },
  'All time, one served model': { timeZone: 'America/Los_Angeles', modelIds: ['claude-opus-5-5'] },
}

describe.skipIf(!PERF_ASSERT && !PERF_BENCH)('Usage store queries over 400,000 request rows (requires SOTTO_PERF_ASSERT=1 or SOTTO_PERF_BENCH=1)', () => {
  let root: string
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'sotto-usage-query-bench-')) })
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

  // The worst case only reports: no real history spreads every request into its own quarter hour.
  for (const sparse of PERF_BENCH ? [false, true] : [false]) {
    it(sparse ? 'worst case: every request in its own 15-minute bucket' : 'imported history in working bursts', () => {
      const path = join(root, `${sparse ? 'sparse' : 'bursts'}.sqlite`)
      const prepare = new UsageStore(path, () => NOW); prepare.open(); prepare.close()
      const seeded = performance.now()
      seed(path, sparse)
      const seedMs = round(performance.now() - seeded)
      const store = new UsageStore(path, () => NOW); store.open()
      try {
        const db = new DatabaseSync(path)
        const buckets = db.prepare('SELECT COUNT(*) AS count FROM token_buckets').get()!.count
        db.close()
        const results = Object.fromEntries(Object.entries(queries).map(([label, query]) => [label, timed(store, query)]))
        const read = store.query({ timeZone: 'America/Los_Angeles' })
        expect(read.totals.tokenRecords).toBeGreaterThanOrEqual(ROWS)
        expect(read.hourly.reduce((total, cell) => total + cell.prompts.total, 0)).toBe(read.totals.prompts.total)
        // History import writes through the same rules a live row does, in batches of 2,048.
        const batch: UsageTokenObservation[] = Array.from({ length: 2_048 }, (_, index) => ({
          providerId: 'claude', threadId: 'import-bench', recordKey: hash(`import-${index}`), modelId: 'claude-opus-5-5',
          tokens: { input: 100, output: 10, cached: 50 }, at: new Date(START + index * 30_000).toISOString(), phase: 'replay', partial: false,
          origin: 'history', source: 'elsewhere', client: 'claude-code',
        }))
        const imported = performance.now()
        store.observeTokenBatch(batch)
        const importMs = round(performance.now() - imported)
        console.log(JSON.stringify({ shape: sparse ? 'sparse' : 'bursts', rows: ROWS, buckets, seedMs, importBatchOf2048Ms: importMs, medianQueryMs: results }))
        if (!sparse) {
          expectWithinBudget(results['All time, Los Angeles']!, 400, 'All time over 400,000 rows')
          expectWithinBudget(results['Last 30 days, Los Angeles']!, 150, 'Last 30 days over 400,000 rows')
          expectWithinBudget(results['Since a 5-hour window start']!, 100, 'A subscription window over 400,000 rows')
        }
      } finally { store.close() }
    }, 600_000)
  }
})
