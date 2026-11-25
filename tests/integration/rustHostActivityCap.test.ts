// @vitest-environment node
// The activity limit across both host programs (ADR-0214): a threads.sqlite written by the Rust host's own store opens in Node's
// ThreadStore, which reads, saves and reads again every thread without refusing it. The Rust host on forge once left a
// thread with 2,001 rows, and Node's next save of it threw "Too many thread activities". Runs when
// `SOTTO_TEST_RUST_HOST=1` (the Rust host CI job, and locally after a `cargo build`).
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { MAX_AGENT_ACTIVITIES } from '../../src/shared/agentActivity'

const RUN_RUST_HOST = process.env.SOTTO_TEST_RUST_HOST === '1'

describe.skipIf(!RUN_RUST_HOST)('Rust host activity writes read in Node', () => {
  let dir: string
  let path: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sotto-rust-activity-cap-'))
    path = join(dir, 'threads.sqlite')
    // The Rust test writes past the limit through upsert_activity and save_activities, into this database.
    execFileSync('cargo', ['test', '-p', 'sotto-core', '--lib', '--locked', 'stores::tests::activity_writes_stay_within_node_limits', '--', '--exact'], {
      stdio: 'inherit', env: { ...process.env, SOTTO_SHARED_ACTIVITIES_DB: path },
    })
  }, 600_000)

  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  it('never leaves a thread over the limit or with a repeated position, and Node saves every thread it wrote', () => {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const threads = db.prepare('SELECT thread_id, COUNT(*) AS count, COUNT(DISTINCT position) AS positions FROM activities GROUP BY thread_id').all()
      expect(threads.map(row => String(row.thread_id)).sort()).toEqual(['mixed', 'saved', 'upserted'])
      for (const row of threads) {
        expect(Number(row.count)).toBeLessThanOrEqual(MAX_AGENT_ACTIVITIES)
        expect(Number(row.positions)).toBe(Number(row.count))
      }
    } finally { db.close() }

    const store = new ThreadStore(path)
    store.open()
    try {
      for (const threadId of ['upserted', 'mixed', 'saved']) {
        const records = store.readActivities(threadId)
        expect(records.length).toBeLessThanOrEqual(MAX_AGENT_ACTIVITIES)
        expect(() => store.syncActivities(threadId, records)).not.toThrow()
        expect(store.readActivities(threadId).map(record => record.id)).toEqual(records.map(record => record.id))
      }
      expect(store.readActivities('upserted')).toHaveLength(MAX_AGENT_ACTIVITIES)
      expect(store.readActivities('mixed').at(-1)!.id).toBe('rust-0')
    } finally { store.close() }
  })
})
