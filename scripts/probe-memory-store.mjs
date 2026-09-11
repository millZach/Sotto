import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'

import { migrateDatabase } from '../src/main/memory/migrations.mjs'

const root = await mkdtemp(join(resolve(import.meta.dirname, '..'), '.memory-store-probe-'))
let db
try {
  db = new DatabaseSync(join(root, 'memory.sqlite'))
  const applied = migrateDatabase(db)
  assert.deepEqual(applied, [1])
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO memories (
    id, type, scope, content, sourceClass, confidence, evidenceCount, importance,
    createdAt, lastConfirmedAt, lastUsedAt, validFrom, validTo, supersededBy,
    provenance, tags, state, authority, embedding
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('memory-probe', 'preference', 'probe-project', 'Packaged SQLite remembers concise explanations',
      'explicit', 1, 1, 0.5, now, now, now, now, null, null, '[]', '["packaging"]',
      'active', 'preference', null)
  const matched = db.prepare(`
    SELECT memories.id FROM memories_fts
    JOIN memories ON memories.rowid = memories_fts.rowid
    WHERE memories_fts MATCH ? AND memories.state = 'active'
    ORDER BY bm25(memories_fts) LIMIT 1
  `).get('"concise"')
  assert.equal(matched?.id, 'memory-probe')
  assert.deepEqual(migrateDatabase(db), [])
  const sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version
  process.stdout.write(`${JSON.stringify({
    sqliteVersion, migrationVersion: applied[0], matchedId: matched.id, fts5: true,
  })}\n`)
} finally {
  db?.close()
  await rm(root, { recursive: true, force: true })
}
