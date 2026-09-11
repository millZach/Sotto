import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from './store'

export function probeMemoryStore(path: string): {
  sqliteVersion: string; migrationVersion: number; matchedId: string; fts5: true
} {
  const store = new MemoryStore(path)
  try {
    store.open()
    const now = new Date().toISOString()
    store.insert({
      id: 'memory-probe', type: 'preference', scope: 'probe-project',
      content: 'Packaged SQLite remembers concise explanations',
      sourceClass: 'inferred', confidence: 0.5, evidenceCount: 1, importance: 0.5,
      createdAt: now, lastConfirmedAt: null, lastUsedAt: null, validFrom: now,
      validTo: null, supersededBy: null, provenance: [{ threadId: 'probe-thread', ref: 'turn-1' }],
      tags: ['packaging'], state: 'active', authority: 'preference', embedding: null,
    })
    const matches = store.search('concise', { limit: 1, projectId: 'probe-project' })
    if (matches[0]?.id !== 'memory-probe') throw new Error('Memory store full-text query failed')
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const migrations = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
      if (migrations.length !== 2 || migrations[0]?.version !== 1 || migrations[1]?.version !== 2) {
        throw new Error('Memory store migration evidence is missing')
      }
      const version = db.prepare('SELECT sqlite_version() AS version').get()?.version
      if (typeof version !== 'string') throw new Error('SQLite version evidence is missing')
      return { sqliteVersion: version, migrationVersion: 2, matchedId: matches[0].id, fts5: true }
    } finally {
      db.close()
    }
  } finally {
    store.close()
  }
}
