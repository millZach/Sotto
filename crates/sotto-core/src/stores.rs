use std::fs;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("I/O error opening store: {0}")]
    Io(#[from] std::io::Error),
    #[error("Corrupt JSON in SQLite store: {0}")]
    Json(#[from] serde_json::Error),
}

/// Opens a SQLite database with the exact pragmas required for parity with Node's `node:sqlite`
/// (ADR-0212: `recursive_triggers = ON`, `journal_mode = WAL`, 5 s busy timeout).
pub fn open_sqlite(path: &Path) -> Result<Connection, StoreError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA recursive_triggers = ON;",
    )?;
    Ok(conn)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "commandId", skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredActivity {
    #[serde(rename = "activityId")]
    pub activity_id: String,
    pub position: i64,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredThreadEvent {
    pub seq: i64,
    #[serde(rename = "threadId")]
    pub thread_id: String,
    pub kind: String,
    pub at: String,
    pub payload: Value,
}

/// Reads Sotto's `threads.sqlite` database in place without altering TypeScript's schema (v1–v10).
pub struct ThreadStore {
    conn: Connection,
}

impl ThreadStore {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let conn = open_sqlite(path)?;
        Ok(Self { conn })
    }

    pub fn quick_check(&self) -> Result<String, StoreError> {
        let status: String = self.conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        Ok(status)
    }

    pub fn has_tables(&self) -> Result<bool, StoreError> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
            [],
            |r| r.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn list_thread_ids(&self) -> Result<Vec<String>, StoreError> {
        if !self.has_tables()? {
            return Ok(Vec::new());
        }
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT thread_id FROM messages ORDER BY thread_id ASC")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(row?);
        }
        Ok(ids)
    }

    pub fn read_messages(&self, thread_id: &str) -> Result<Vec<StoredMessage>, StoreError> {
        if !self.has_tables()? {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "SELECT message_id, role, text, created_at, command_id, attachments
             FROM messages
             WHERE thread_id = ?1
             ORDER BY position ASC",
        )?;
        let rows = stmt.query_map([thread_id], |row| {
            let attachments_raw: Option<String> = row.get(5)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                attachments_raw,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, role, text, created_at, command_id, attachments_raw) = row?;
            let attachments = match attachments_raw {
                Some(raw) if !raw.is_empty() => Some(serde_json::from_str(&raw)?),
                _ => None,
            };
            out.push(StoredMessage {
                id,
                role,
                text,
                created_at,
                command_id,
                attachments,
            });
        }
        Ok(out)
    }

    pub fn read_activities(&self, thread_id: &str) -> Result<Vec<StoredActivity>, StoreError> {
        let exists: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'activities'",
            [],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "SELECT activity_id, position, payload
             FROM activities
             WHERE thread_id = ?1
             ORDER BY position ASC",
        )?;
        let rows = stmt.query_map([thread_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (activity_id, position, raw) = row?;
            out.push(StoredActivity {
                activity_id,
                position,
                payload: serde_json::from_str(&raw)?,
            });
        }
        Ok(out)
    }

    pub fn read_events(
        &self,
        thread_id: &str,
        after_seq: i64,
        limit: usize,
    ) -> Result<Vec<StoredThreadEvent>, StoreError> {
        let exists: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'events'",
            [],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "SELECT seq, thread_id, kind, at, payload
             FROM events
             WHERE thread_id = ?1 AND seq > ?2
             ORDER BY seq ASC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(rusqlite::params![thread_id, after_seq, limit as i64], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (seq, tid, kind, at, raw) = row?;
            out.push(StoredThreadEvent {
                seq,
                thread_id: tid,
                kind,
                at,
                payload: serde_json::from_str(&raw)?,
            });
        }
        Ok(out)
    }
}

/// Reads Sotto's `subagents.sqlite` database in place.
pub struct SubagentStore {
    conn: Connection,
}

impl SubagentStore {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let conn = open_sqlite(path)?;
        Ok(Self { conn })
    }

    pub fn quick_check(&self) -> Result<String, StoreError> {
        let status: String = self.conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        Ok(status)
    }

    pub fn row_count(&self, thread_id: &str) -> Result<i64, StoreError> {
        let exists: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'subagent_rows'",
            [],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Ok(0);
        }
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM subagent_rows WHERE thread_id = ?1",
            [thread_id],
            |r| r.get(0),
        )?;
        Ok(count)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageMeta {
    pub started_at: String,
    pub revision: i64,
    pub generation: i64,
    pub seed_completed: bool,
}

/// Reads Sotto's `usage.sqlite` database in place.
pub struct UsageStore {
    conn: Connection,
}

impl UsageStore {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let conn = open_sqlite(path)?;
        Ok(Self { conn })
    }

    pub fn quick_check(&self) -> Result<String, StoreError> {
        let status: String = self.conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        Ok(status)
    }

    pub fn read_meta(&self) -> Result<Option<UsageMeta>, StoreError> {
        let exists: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'usage_meta'",
            [],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Ok(None);
        }
        let meta = self
            .conn
            .query_row(
                "SELECT started_at, revision, generation, seed_completed FROM usage_meta WHERE singleton = 1",
                [],
                |r| {
                    Ok(UsageMeta {
                        started_at: r.get(0)?,
                        revision: r.get(1)?,
                        generation: r.get(2)?,
                        seed_completed: r.get::<_, i64>(3)? != 0,
                    })
                },
            )
            .optional()?;
        Ok(meta)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyRecord {
    pub id: String,
    pub action: String,
    pub resource: String,
    pub scope: String,
    pub effect: String,
    pub source: String,
    pub note: String,
    pub granted_at: String,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
}

/// Reads Sotto's `memory.sqlite` database in place (including FTS5 verification and ADR-0004 policy records).
pub struct MemoryStore {
    conn: Connection,
}

impl MemoryStore {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let conn = open_sqlite(path)?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        Ok(Self { conn })
    }

    pub fn quick_check(&self) -> Result<String, StoreError> {
        let status: String = self.conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        Ok(status)
    }

    pub fn schema_version(&self) -> Result<i64, StoreError> {
        let exists: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
            [],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Ok(0);
        }
        let version: Option<i64> = self
            .conn
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0))?;
        Ok(version.unwrap_or(0))
    }

    pub fn active_policies(&self) -> Result<Vec<PolicyRecord>, StoreError> {
        let exists: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'policies'",
            [],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "SELECT id, action, resource, scope, effect, source, note, grantedAt, expiresAt, revokedAt
             FROM policies
             WHERE revokedAt IS NULL
             ORDER BY grantedAt ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(PolicyRecord {
                id: r.get(0)?,
                action: r.get(1)?,
                resource: r.get(2)?,
                scope: r.get(3)?,
                effect: r.get(4)?,
                source: r.get(5)?,
                note: r.get(6)?,
                granted_at: r.get(7)?,
                expires_at: r.get(8)?,
                revoked_at: r.get(9)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn opens_and_reads_sotto_sqlite_schemas_with_recursive_triggers_and_fts5() {
        let dir = tempdir().unwrap();

        // threads.sqlite
        let threads_path = dir.path().join("threads.sqlite");
        {
            let conn = open_sqlite(&threads_path).unwrap();
            let recursive: i64 = conn
                .query_row("PRAGMA recursive_triggers", [], |r| r.get(0))
                .unwrap();
            assert_eq!(recursive, 1);
            conn.execute_batch(
                "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL);
                 CREATE TABLE messages (thread_id TEXT NOT NULL, position INTEGER NOT NULL, message_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, command_id TEXT, attachments TEXT, PRIMARY KEY (thread_id, position));
                 CREATE TABLE activities (thread_id TEXT NOT NULL, activity_id TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (thread_id, activity_id));
                 INSERT INTO messages VALUES ('t1', 0, 'm1', 'user', 'hello from ts', '2026-11-20T00:00:00.000Z', NULL, NULL);
                 INSERT INTO events (thread_id, kind, at, payload) VALUES ('t1', 'message-added', '2026-11-20T00:00:00.000Z', '{\"id\":\"m1\"}');",
            )
            .unwrap();
        }
        let thread_store = ThreadStore::open(&threads_path).unwrap();
        assert_eq!(thread_store.quick_check().unwrap(), "ok");
        assert_eq!(thread_store.list_thread_ids().unwrap(), vec!["t1"]);
        let msgs = thread_store.read_messages("t1").unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].text, "hello from ts");
        assert_eq!(thread_store.read_events("t1", 0, 50).unwrap().len(), 1);

        // memory.sqlite with FTS5 and policies
        let memory_path = dir.path().join("memory.sqlite");
        {
            let conn = open_sqlite(&memory_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL);
                 INSERT INTO schema_migrations VALUES (4, '2026-11-20T00:00:00.000Z');
                 CREATE VIRTUAL TABLE memories_fts USING fts5(content, tags);
                 CREATE TABLE policies (id TEXT PRIMARY KEY NOT NULL, action TEXT NOT NULL, resource TEXT NOT NULL, scope TEXT NOT NULL, effect TEXT NOT NULL, source TEXT NOT NULL, note TEXT NOT NULL, grantedAt TEXT NOT NULL, expiresAt TEXT, revokedAt TEXT);
                 INSERT INTO policies VALUES ('p1', 'remote-answer', 'client-1', 'host', 'allow', 'user', 'desktop', '2026-11-20T00:00:00.000Z', NULL, NULL);",
            )
            .unwrap();
        }
        let mem_store = MemoryStore::open(&memory_path).unwrap();
        assert_eq!(mem_store.quick_check().unwrap(), "ok");
        assert_eq!(mem_store.schema_version().unwrap(), 4);
        assert_eq!(mem_store.active_policies().unwrap().len(), 1);
    }
}
