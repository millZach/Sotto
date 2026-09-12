export const migrations = [{
  version: 1,
  sql: `
    CREATE TABLE memories (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      scope TEXT NOT NULL,
      content TEXT NOT NULL,
      sourceClass TEXT NOT NULL CHECK (sourceClass IN ('explicit', 'observed', 'inferred', 'imported', 'agent-confirmed')),
      confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
      evidenceCount INTEGER NOT NULL CHECK (evidenceCount >= 0),
      importance REAL NOT NULL CHECK (importance BETWEEN 0 AND 1),
      createdAt TEXT NOT NULL,
      lastConfirmedAt TEXT,
      lastUsedAt TEXT,
      validFrom TEXT NOT NULL,
      validTo TEXT,
      supersededBy TEXT REFERENCES memories(id),
      provenance TEXT NOT NULL,
      tags TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'disputed', 'temporary', 'archived')),
      authority TEXT NOT NULL CHECK (authority IN ('preference', 'policy', 'permission')),
      embedding BLOB
    );
    CREATE INDEX memories_scope_state ON memories(scope, state);
    CREATE VIRTUAL TABLE memories_fts USING fts5(
      content, tags, content='memories', content_rowid='rowid'
    );
    CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
    END;
    CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.rowid, old.content, old.tags);
    END;
    CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.rowid, old.content, old.tags);
      INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
    END;
  `,
}, {
  version: 2,
  sql: `
    CREATE TABLE policies (
      id TEXT PRIMARY KEY NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('spend', 'publish', 'destroy', 'relax-verification')),
      resource TEXT NOT NULL,
      scope TEXT NOT NULL,
      effect TEXT NOT NULL CHECK (effect IN ('allow', 'always-confirm')),
      source TEXT NOT NULL CHECK (source IN ('user', 'questionnaire')),
      note TEXT NOT NULL,
      grantedAt TEXT NOT NULL,
      expiresAt TEXT,
      revokedAt TEXT
    );
    CREATE INDEX policies_action_scope ON policies(action, scope);
  `,
}, {
  version: 3,
  sql: `
    CREATE TABLE memory_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      questionnaireCompletedAt TEXT NOT NULL
    );
  `,
}]

export const latestMigrationVersion = migrations.at(-1).version

const memoryColumns = [
  'id', 'type', 'scope', 'content', 'sourceClass', 'confidence', 'evidenceCount', 'importance',
  'createdAt', 'lastConfirmedAt', 'lastUsedAt', 'validFrom', 'validTo', 'supersededBy',
  'provenance', 'tags', 'state', 'authority', 'embedding',
]
export const memoryInsertSql = `INSERT INTO memories (${memoryColumns.join(', ')})
  VALUES (${memoryColumns.map(() => '?').join(', ')})`

const policyColumns = [
  'id', 'action', 'resource', 'scope', 'effect', 'source', 'note', 'grantedAt', 'expiresAt', 'revokedAt',
]
export const policyInsertSql = `INSERT INTO policies (${policyColumns.join(', ')})
  VALUES (${policyColumns.map(() => '?').join(', ')})`

// Shared by the TypeScript store and the direct runtime probe.
export function migrateDatabase(db) {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;')
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL
  )`)
  const applied = []
  for (const migration of migrations) {
    db.exec('BEGIN IMMEDIATE')
    try {
      // Check inside the write transaction so simultaneous openers cannot race.
      if (!db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(migration.version)) {
        db.exec(migration.sql)
        db.prepare('INSERT INTO schema_migrations(version, appliedAt) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString())
        applied.push(migration.version)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return applied
}
