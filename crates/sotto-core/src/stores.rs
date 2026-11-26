use std::fs;
use std::path::Path;
use std::time::Duration;

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

const THREAD_PROJECTION_VERSION: &str = "2";

/// The most activity records one thread keeps, as Node's `MAX_AGENT_ACTIVITIES` in `src/shared/agentActivity.ts`.
/// Node's protocol schemas refuse a longer list, so a Rust write must never leave more rows than this for a thread.
pub const MAX_AGENT_ACTIVITIES: usize = 2_000;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("I/O error opening store: {0}")]
    Io(#[from] std::io::Error),
    #[error("Corrupt JSON in SQLite store: {0}")]
    Json(#[from] serde_json::Error),
    /// Work that committed but did not finish, such as a scrub whose checkpoint found the log busy.
    #[error("{0}")]
    Unfinished(&'static str),
}

/// Runs `work` with its commits flushed to the disk (`synchronous=FULL`), then puts the connection back to the setting
/// every save uses, as Node's `flushedCommits` (`src/main/storage/sqliteDurability.ts`). The work's own failure is the
/// one reported.
fn flushed_commits<T>(conn: &Connection, work: impl FnOnce() -> Result<T, StoreError>) -> Result<T, StoreError> {
    conn.execute_batch("PRAGMA synchronous = FULL;")?;
    let result = work();
    let restored = conn.execute_batch("PRAGMA synchronous = NORMAL;");
    let value = result?;
    restored?;
    Ok(value)
}

/// Opens a SQLite database with the exact pragmas required for parity with Node's `node:sqlite`
/// (ADR-0214: `recursive_triggers = ON`, `journal_mode = WAL`, 5 s busy timeout).
pub fn open_sqlite(path: &Path) -> Result<Connection, StoreError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA secure_delete = ON;
         PRAGMA recursive_triggers = ON;",
    )?;
    Ok(conn)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn run_migrations(conn: &Connection, migrations: &[(i64, &str)]) -> Result<(), StoreError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version INTEGER PRIMARY KEY,
           appliedAt TEXT NOT NULL
         );",
    )?;
    for &(version, sql) in migrations {
        conn.execute_batch("BEGIN IMMEDIATE;")?;
        let res = (|| -> Result<(), StoreError> {
            let applied: Option<i64> = conn
                .query_row(
                    "SELECT version FROM schema_migrations WHERE version = ?1",
                    [version],
                    |r| r.get(0),
                )
                .optional()?;
            if applied.is_none() {
                conn.execute_batch(sql)?;
                conn.execute(
                    "INSERT INTO schema_migrations (version, appliedAt) VALUES (?1, ?2)",
                    rusqlite::params![version, now_iso()],
                )?;
            }
            Ok(())
        })();
        match res {
            Ok(()) => conn.execute_batch("COMMIT;")?,
            Err(err) => {
                let _ = conn.execute_batch("ROLLBACK;");
                return Err(err);
            }
        }
    }
    Ok(())
}

const THREAD_MIGRATIONS: &[(i64, &str)] = &[
    (
        1,
        "CREATE TABLE events (
           seq INTEGER PRIMARY KEY AUTOINCREMENT,
           thread_id TEXT NOT NULL,
           kind TEXT NOT NULL,
           at TEXT NOT NULL,
           payload TEXT NOT NULL
         );
         CREATE INDEX events_thread ON events(thread_id, seq);
         CREATE TABLE messages (
           thread_id TEXT NOT NULL,
           position INTEGER NOT NULL,
           message_id TEXT NOT NULL,
           role TEXT NOT NULL,
           text TEXT NOT NULL,
           created_at TEXT NOT NULL,
           command_id TEXT,
           attachments TEXT,
           PRIMARY KEY (thread_id, position)
         );
         CREATE INDEX messages_thread_message ON messages(thread_id, message_id);
         CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);",
    ),
    (
        2,
        "CREATE TABLE activities (
           thread_id TEXT NOT NULL,
           activity_id TEXT NOT NULL,
           position INTEGER NOT NULL,
           payload TEXT NOT NULL,
           PRIMARY KEY (thread_id, activity_id)
         );
         CREATE INDEX activities_thread_position ON activities(thread_id, position);
         CREATE TABLE activity_epochs (thread_id TEXT PRIMARY KEY NOT NULL, epoch TEXT);
         CREATE TABLE activity_redactions (identity_hash TEXT PRIMARY KEY NOT NULL);",
    ),
    (
        3,
        "CREATE INDEX events_thread_resets ON events(thread_id, seq) WHERE kind = 'messages-reset';
         ALTER TABLE activity_epochs ADD COLUMN message_reset_seq INTEGER;",
    ),
    (
        4,
        "CREATE TABLE visuals (
           seq INTEGER PRIMARY KEY AUTOINCREMENT,
           thread_id TEXT NOT NULL,
           visual_id TEXT NOT NULL,
           created_at TEXT NOT NULL,
           anchor_message_id TEXT,
           anchor_user_message_id TEXT,
           payload TEXT NOT NULL,
           UNIQUE (thread_id, visual_id)
         );
         CREATE INDEX visuals_thread ON visuals(thread_id, seq);",
    ),
    (
        5,
        "CREATE TABLE wake_ups (
           thread_id TEXT NOT NULL,
           message_id TEXT NOT NULL,
           PRIMARY KEY (thread_id, message_id)
         );",
    ),
    (
        6,
        "ALTER TABLE messages ADD COLUMN watcher_own_change TEXT;
         ALTER TABLE messages ADD COLUMN watcher_observed_changes TEXT;",
    ),
    (7, "ALTER TABLE messages ADD COLUMN turn_message_id TEXT;"),
    (8, "ALTER TABLE wake_ups ADD COLUMN watcher_asks TEXT;"),
    (9, "ALTER TABLE wake_ups ADD COLUMN hidden INTEGER;"),
    (10, "ALTER TABLE messages ADD COLUMN provider_error INTEGER;"),
    (11, "CREATE INDEX IF NOT EXISTS messages_thread_role_position ON messages(thread_id, role, position);"),
];

const MEMORY_MIGRATIONS: &[(i64, &str)] = &[
    (
        1,
        "CREATE TABLE memories (
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
         END;",
    ),
    (
        2,
        "CREATE TABLE policies (
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
         CREATE INDEX policies_action_scope ON policies(action, scope);",
    ),
    (
        3,
        "CREATE TABLE memory_profile (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           questionnaireCompletedAt TEXT NOT NULL
         );",
    ),
    (
        4,
        "CREATE TABLE policies_v4 (
           id TEXT PRIMARY KEY NOT NULL,
           action TEXT NOT NULL CHECK (action IN ('spend', 'publish', 'destroy', 'relax-verification', 'remote-answer')),
           resource TEXT NOT NULL,
           scope TEXT NOT NULL,
           effect TEXT NOT NULL CHECK (effect IN ('allow', 'always-confirm')),
           source TEXT NOT NULL CHECK (source IN ('user', 'questionnaire')),
           note TEXT NOT NULL,
           grantedAt TEXT NOT NULL,
           expiresAt TEXT,
           revokedAt TEXT
         );
         INSERT INTO policies_v4 SELECT id, action, resource, scope, effect, source, note, grantedAt, expiresAt, revokedAt FROM policies;
         DROP TABLE policies;
         ALTER TABLE policies_v4 RENAME TO policies;
         CREATE INDEX policies_action_scope ON policies(action, scope);",
    ),
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "commandId", skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    #[serde(rename = "turnMessageId", skip_serializing_if = "Option::is_none")]
    pub turn_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Value>,
    #[serde(rename = "watcherOwnChange", skip_serializing_if = "Option::is_none")]
    pub watcher_own_change: Option<Value>,
    #[serde(rename = "watcherObservedChanges", skip_serializing_if = "Option::is_none")]
    pub watcher_observed_changes: Option<Value>,
    #[serde(rename = "providerError", skip_serializing_if = "Option::is_none")]
    pub provider_error: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadEventAttribution {
    #[serde(rename = "clientId")]
    pub client_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    pub transport: String,
}

/// Thread event log entry matching `threadEventSchema` in `src/shared/threadEvents.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ThreadEvent {
    #[serde(rename = "message-added")]
    MessageAdded {
        at: String,
        message: StoredMessage,
        #[serde(skip_serializing_if = "Option::is_none")]
        redacted: Option<bool>,
    },
    #[serde(rename = "message-text-appended")]
    MessageTextAppended {
        at: String,
        #[serde(rename = "messageId")]
        message_id: String,
        #[serde(rename = "appendText")]
        append_text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        redacted: Option<bool>,
    },
    #[serde(rename = "message-replaced")]
    MessageReplaced {
        at: String,
        message: StoredMessage,
        #[serde(skip_serializing_if = "Option::is_none")]
        redacted: Option<bool>,
    },
    #[serde(rename = "message-aliased")]
    MessageAliased {
        at: String,
        #[serde(rename = "messageId")]
        message_id: String,
        #[serde(rename = "canonicalId")]
        canonical_id: String,
    },
    #[serde(rename = "messages-reset")]
    MessagesReset {
        at: String,
        #[serde(rename = "historyEpoch", skip_serializing_if = "Option::is_none")]
        history_epoch: Option<String>,
    },
    #[serde(rename = "answer-given")]
    AnswerGiven {
        at: String,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        answer: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        approved: Option<bool>,
        #[serde(rename = "permissionChoice", skip_serializing_if = "Option::is_none")]
        permission_choice: Option<String>,
        #[serde(rename = "questionOptionIds", skip_serializing_if = "Option::is_none")]
        question_option_ids: Option<Vec<String>>,
        attribution: ThreadEventAttribution,
    },
}

impl ThreadEvent {
    pub fn kind_str(&self) -> &'static str {
        match self {
            ThreadEvent::MessageAdded { .. } => "message-added",
            ThreadEvent::MessageTextAppended { .. } => "message-text-appended",
            ThreadEvent::MessageReplaced { .. } => "message-replaced",
            ThreadEvent::MessageAliased { .. } => "message-aliased",
            ThreadEvent::MessagesReset { .. } => "messages-reset",
            ThreadEvent::AnswerGiven { .. } => "answer-given",
        }
    }

    pub fn at(&self) -> &str {
        match self {
            ThreadEvent::MessageAdded { at, .. }
            | ThreadEvent::MessageTextAppended { at, .. }
            | ThreadEvent::MessageReplaced { at, .. }
            | ThreadEvent::MessageAliased { at, .. }
            | ThreadEvent::MessagesReset { at, .. }
            | ThreadEvent::AnswerGiven { at, .. } => at,
        }
    }
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
    pub event: Value,
}

#[derive(Debug, Clone)]
pub struct ForwardMessagesPage {
    pub messages: Vec<(StoredMessage, i64)>,
    pub earlier_available: bool,
    pub has_more: bool,
}

/// Reads and writes Sotto's `threads.sqlite` database in place (schema v1–v11),
/// matching `src/main/agents/threadStore.ts`.
pub struct ThreadStore {
    conn: Connection,
}

impl ThreadStore {
    /// Opens `threads.sqlite` and ensures all v1–v11 migrations and meta entries are present.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let conn = open_sqlite(path)?;
        run_migrations(&conn, THREAD_MIGRATIONS)?;
        let current_proj: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'projection_version'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if current_proj.is_none() {
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('projection_version', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [THREAD_PROJECTION_VERSION],
            )?;
        }
        Ok(Self { conn })
    }

    pub fn quick_check(&self) -> Result<String, StoreError> {
        let status: String = self.conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        Ok(status)
    }

    pub fn latest_seq(&self) -> Result<i64, StoreError> {
        let seq: Option<i64> = self
            .conn
            .query_row("SELECT MAX(seq) FROM events", [], |r| r.get(0))?;
        Ok(seq.unwrap_or(0))
    }

    pub fn list_thread_ids(&self) -> Result<Vec<String>, StoreError> {
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

    pub fn append_event(&self, thread_id: &str, event: &ThreadEvent) -> Result<i64, StoreError> {
        self.append_events(thread_id, std::slice::from_ref(event))
    }

    /// Appends one or more events and applies them to the `messages` projection in a single
    /// `BEGIN IMMEDIATE` transaction, matching `ThreadStore.appendMany`.
    pub fn append_events(&self, thread_id: &str, events: &[ThreadEvent]) -> Result<i64, StoreError> {
        if events.is_empty() {
            return self.latest_seq();
        }
        self.conn.execute_batch("BEGIN IMMEDIATE;")?;
        let result = (|| -> Result<i64, StoreError> {
            let mut seq = 0i64;
            for event in events {
                let payload = serde_json::to_string(event)?;
                self.conn.execute(
                    "INSERT INTO events (thread_id, kind, at, payload) VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![thread_id, event.kind_str(), event.at(), payload],
                )?;
                seq = self.conn.last_insert_rowid();
                apply_event(&self.conn, thread_id, event)?;
            }
            Ok(seq)
        })();
        match result {
            Ok(seq) => {
                self.conn.execute_batch("COMMIT;")?;
                Ok(seq)
            }
            Err(err) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(err)
            }
        }
    }

    /// Drops deleted threads' projection and takes the words out of their log, leaving only that it happened, as Node's
    /// `ThreadStore.forgetMany` does for clearing (ADR-0140): one transaction whose commit waits for the disk, the
    /// identities of their activities remembered as erased, then one scrub, however many threads go.
    pub fn forget_many(&self, thread_ids: &[String]) -> Result<(), StoreError> {
        let mut ids: Vec<&str> = Vec::new();
        for id in thread_ids {
            if !ids.contains(&id.as_str()) {
                ids.push(id);
            }
        }
        if ids.is_empty() {
            return Ok(());
        }
        flushed_commits(&self.conn, || {
            let mut hashes = Vec::new();
            for id in &ids {
                let mut stmt = self.conn.prepare("SELECT thread_id, activity_id FROM activities WHERE thread_id = ?1")?;
                let rows = stmt.query_map([id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
                for row in rows {
                    let (thread, activity) = row?;
                    hashes.push(crate::thread_clearing::activity_identity_hash(&thread, &activity));
                }
            }
            self.conn.execute_batch("BEGIN IMMEDIATE;")?;
            let erased = (|| -> Result<(), StoreError> {
                for id in &ids {
                    for table in ["messages", "activities", "activity_epochs", "visuals", "wake_ups"] {
                        self.conn.execute(&format!("DELETE FROM {table} WHERE thread_id = ?1"), [id])?;
                    }
                    let mut stmt = self.conn.prepare("SELECT seq, payload FROM events WHERE thread_id = ?1")?;
                    let events: Vec<(i64, String)> = stmt
                        .query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))?
                        .collect::<Result<_, _>>()?;
                    for (seq, payload) in events {
                        if let Some(redacted) = crate::thread_clearing::redacted_payload(&payload) {
                            self.conn.execute("UPDATE events SET payload = ?1 WHERE seq = ?2", rusqlite::params![redacted, seq])?;
                        }
                    }
                }
                for hash in &hashes {
                    self.conn.execute("INSERT OR IGNORE INTO activity_redactions (identity_hash) VALUES (?1)", [hash])?;
                }
                Ok(())
            })();
            match erased {
                Ok(()) => self.conn.execute_batch("COMMIT;")?,
                Err(err) => {
                    let _ = self.conn.execute_batch("ROLLBACK;");
                    return Err(err);
                }
            }
            // Redaction is not finished while the words are still in a freed page or in the write-ahead log: a checkpoint
            // that found the log busy folded none of it, so the forget has not finished and is a failure.
            let busy: i64 = self.conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))?;
            if busy != 0 {
                return Err(StoreError::Unfinished("The history log could not be cleared"));
            }
            self.conn.execute_batch("VACUUM;")?;
            Ok(())
        })
    }

    pub fn read_messages(&self, thread_id: &str) -> Result<Vec<StoredMessage>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT message_id, role, text, created_at, command_id, attachments,
                    watcher_own_change, watcher_observed_changes, turn_message_id, provider_error
             FROM messages
             WHERE thread_id = ?1
             ORDER BY position ASC",
        )?;
        let rows = stmt.query_map([thread_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<i64>>(9)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (
                id,
                role,
                text,
                created_at,
                command_id,
                attachments_raw,
                own_raw,
                observed_raw,
                turn_message_id,
                provider_error_raw,
            ) = row?;
            let attachments = parse_optional_json(attachments_raw)?;
            let watcher_own_change = parse_optional_json(own_raw)?;
            let watcher_observed_changes = parse_optional_json(observed_raw)?;
            let provider_error = (provider_error_raw == Some(1)).then_some(true);
            out.push(StoredMessage {
                id,
                role,
                text,
                created_at,
                command_id,
                turn_message_id,
                attachments,
                watcher_own_change,
                watcher_observed_changes,
                provider_error,
            });
        }
        Ok(out)
    }

    pub fn read_activities(&self, thread_id: &str) -> Result<Vec<StoredActivity>, StoreError> {
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
        let rows = rows.collect::<Result<Vec<_>, _>>()?;
        // A list over the limit on disk reads as its newest records, as Node's store reads it.
        let skip = rows.len().saturating_sub(MAX_AGENT_ACTIVITIES);
        let mut out = Vec::with_capacity(rows.len() - skip);
        for (activity_id, position, raw) in rows.into_iter().skip(skip) {
            out.push(StoredActivity {
                activity_id,
                position,
                payload: serde_json::from_str(&raw)?,
            });
        }
        Ok(out)
    }

    pub fn save_activities(
        &self,
        thread_id: &str,
        epoch: Option<&str>,
        message_reset_seq: Option<i64>,
        activities: &[Value],
    ) -> Result<(), StoreError> {
        self.conn.execute_batch("BEGIN IMMEDIATE;")?;
        let res = (|| -> Result<(), StoreError> {
            self.conn
                .execute("DELETE FROM activities WHERE thread_id = ?1", [thread_id])?;
            self.conn.execute(
                "INSERT INTO activity_epochs (thread_id, epoch, message_reset_seq)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(thread_id) DO UPDATE SET epoch = excluded.epoch, message_reset_seq = excluded.message_reset_seq",
                rusqlite::params![thread_id, epoch, message_reset_seq],
            )?;
            // Only the newest MAX_AGENT_ACTIVITIES are kept, each at its own position in list order.
            let skip = activities.len().saturating_sub(MAX_AGENT_ACTIVITIES);
            for (position, activity) in activities.iter().skip(skip).enumerate() {
                if let Some(activity_id) = activity.get("id").and_then(Value::as_str) {
                    let encoded = serde_json::to_string(activity)?;
                    self.conn.execute(
                        "INSERT INTO activities (thread_id, activity_id, position, payload)
                         VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT(thread_id, activity_id) DO UPDATE SET
                           position = excluded.position,
                           payload = excluded.payload",
                        rusqlite::params![thread_id, activity_id, position as i64, encoded],
                    )?;
                }
            }
            Ok(())
        })();
        match res {
            Ok(()) => {
                self.conn.execute_batch("COMMIT;")?;
                Ok(())
            }
            Err(err) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(err)
            }
        }
    }

    /// Inserts or updates a single activity row without rewriting history. A record already stored keeps its position;
    /// a new one goes after the last, so positions stay unique whatever list index the caller holds it at. A new
    /// record past `MAX_AGENT_ACTIVITIES` deletes the oldest, so the table never holds a list Node refuses.
    pub fn upsert_activity(&self, thread_id: &str, activity: &Value) -> Result<(), StoreError> {
        let Some(activity_id) = activity.get("id").and_then(Value::as_str) else {
            return Ok(());
        };
        let encoded = serde_json::to_string(activity)?;
        let updated = self.conn.execute(
            "UPDATE activities SET payload = ?3 WHERE thread_id = ?1 AND activity_id = ?2",
            rusqlite::params![thread_id, activity_id, encoded],
        )?;
        if updated > 0 {
            return Ok(());
        }
        self.conn.execute_batch("SAVEPOINT activity_upsert;")?;
        let res = (|| -> Result<(), StoreError> {
            self.conn.execute(
                "INSERT INTO activities (thread_id, activity_id, position, payload)
                 VALUES (?1, ?2,
                   COALESCE((SELECT MAX(position) FROM activities WHERE thread_id = ?1), -1) + 1, ?3)",
                rusqlite::params![thread_id, activity_id, encoded],
            )?;
            // By row rather than by position, so rows an earlier build left at one position cannot outlast the limit.
            self.conn.execute(
                "DELETE FROM activities WHERE thread_id = ?1 AND rowid NOT IN (
                   SELECT rowid FROM activities WHERE thread_id = ?1
                   ORDER BY position DESC, rowid DESC LIMIT ?2)",
                rusqlite::params![thread_id, MAX_AGENT_ACTIVITIES as i64],
            )?;
            Ok(())
        })();
        match res {
            Ok(()) => {
                self.conn.execute_batch("RELEASE SAVEPOINT activity_upsert;")?;
                Ok(())
            }
            Err(err) => {
                let _ = self
                    .conn
                    .execute_batch("ROLLBACK TO SAVEPOINT activity_upsert; RELEASE SAVEPOINT activity_upsert;");
                Err(err)
            }
        }
    }

    pub fn read_events(
        &self,
        thread_id: Option<&str>,
        after_seq: i64,
        limit: usize,
    ) -> Result<(Vec<StoredThreadEvent>, bool), StoreError> {
        let fetch = (limit as i64).saturating_add(1);
        let mut out = Vec::new();
        if let Some(tid) = thread_id {
            let mut stmt = self.conn.prepare(
                "SELECT seq, thread_id, payload
                 FROM events
                 WHERE thread_id = ?1 AND seq > ?2
                 ORDER BY seq ASC
                 LIMIT ?3",
            )?;
            let rows = stmt.query_map(rusqlite::params![tid, after_seq, fetch], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            for row in rows {
                let (seq, tid, raw) = row?;
                out.push(StoredThreadEvent {
                    seq,
                    thread_id: tid,
                    event: serde_json::from_str(&raw)?,
                });
            }
        } else {
            let mut stmt = self.conn.prepare(
                "SELECT seq, thread_id, payload
                 FROM events
                 WHERE seq > ?1
                 ORDER BY seq ASC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(rusqlite::params![after_seq, fetch], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            for row in rows {
                let (seq, tid, raw) = row?;
                out.push(StoredThreadEvent {
                    seq,
                    thread_id: tid,
                    event: serde_json::from_str(&raw)?,
                });
            }
        }
        let has_more = out.len() > limit;
        if has_more {
            out.truncate(limit);
        }
        Ok((out, has_more))
    }

    /// Latest committed `messages-reset` event for `thread_id`, matching `ThreadStore.readMessageEpoch`.
    pub fn read_message_epoch(&self, thread_id: &str) -> Result<Option<(Option<String>, i64)>, StoreError> {
        let row: Option<(i64, String)> = self
            .conn
            .query_row(
                "SELECT seq, payload FROM events
                 WHERE thread_id = ?1 AND kind = 'messages-reset'
                 ORDER BY seq DESC LIMIT 1",
                [thread_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((seq, raw)) = row else {
            return Ok(None);
        };
        let parsed: Value = serde_json::from_str(&raw)?;
        let epoch = parsed
            .get("historyEpoch")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        Ok(Some((epoch, seq)))
    }

    /// Forward position-based message read for Watcher automation, matching `ThreadStore.readForwardMessages`.
    pub fn read_forward_messages(
        &self,
        thread_id: &str,
        after_position: Option<i64>,
        limit: usize,
    ) -> Result<ForwardMessagesPage, StoreError> {
        let count = limit.clamp(1, 50);
        let fetch = (count + 1) as i64;
        let newest = after_position.is_none();
        let mut rows_out: Vec<(StoredMessage, i64)> = Vec::new();
        let map_row = |row: &rusqlite::Row<'_>| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<i64>>(10)?,
            ))
        };
        let raw_rows: Vec<_> = if newest {
            let mut stmt = self.conn.prepare(
                "SELECT position, message_id, role, text, created_at, command_id, attachments,
                        watcher_own_change, watcher_observed_changes, turn_message_id, provider_error
                 FROM messages
                 WHERE thread_id = ?1
                 ORDER BY position DESC
                 LIMIT ?2",
            )?;
            let mut collected: Vec<_> = stmt
                .query_map(rusqlite::params![thread_id, fetch], map_row)?
                .collect::<Result<Vec<_>, _>>()?;
            collected.reverse();
            collected
        } else {
            let after = after_position.unwrap_or(-1);
            let mut stmt = self.conn.prepare(
                "SELECT position, message_id, role, text, created_at, command_id, attachments,
                        watcher_own_change, watcher_observed_changes, turn_message_id, provider_error
                 FROM messages
                 WHERE thread_id = ?1 AND position > ?2
                 ORDER BY position ASC
                 LIMIT ?3",
            )?;
            let rows = stmt
                .query_map(rusqlite::params![thread_id, after, fetch], map_row)?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let has_more = !newest && raw_rows.len() > count;
        let slice = if newest && raw_rows.len() > count {
            &raw_rows[raw_rows.len() - count..]
        } else if !newest && raw_rows.len() > count {
            &raw_rows[..count]
        } else {
            &raw_rows[..]
        };
        for (
            position,
            id,
            role,
            text,
            created_at,
            command_id,
            attachments_raw,
            own_raw,
            observed_raw,
            turn_message_id,
            provider_error_raw,
        ) in slice.iter().cloned()
        {
            rows_out.push((
                StoredMessage {
                    id,
                    role,
                    text,
                    created_at,
                    command_id,
                    turn_message_id,
                    attachments: parse_optional_json(attachments_raw)?,
                    watcher_own_change: parse_optional_json(own_raw)?,
                    watcher_observed_changes: parse_optional_json(observed_raw)?,
                    provider_error: (provider_error_raw == Some(1)).then_some(true),
                },
                position,
            ));
        }
        let earlier_available = rows_out.first().is_some_and(|(_, pos)| *pos > 0);
        Ok(ForwardMessagesPage {
            messages: rows_out,
            earlier_available,
            has_more,
        })
    }

    /// Reads one message by ID without loading the full thread transcript.
    pub fn read_message_by_id(
        &self,
        thread_id: &str,
        message_id: &str,
    ) -> Result<Option<StoredMessage>, StoreError> {
        let row = self
            .conn
            .query_row(
                "SELECT message_id, role, text, created_at, command_id, attachments,
                        watcher_own_change, watcher_observed_changes, turn_message_id, provider_error
                 FROM messages
                 WHERE thread_id = ?1 AND message_id = ?2
                 LIMIT 1",
                rusqlite::params![thread_id, message_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<i64>>(9)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            id,
            role,
            text,
            created_at,
            command_id,
            attachments_raw,
            own_raw,
            observed_raw,
            turn_message_id,
            provider_error_raw,
        )) = row
        else {
            return Ok(None);
        };
        Ok(Some(StoredMessage {
            id,
            role,
            text,
            created_at,
            command_id,
            turn_message_id,
            attachments: parse_optional_json(attachments_raw)?,
            watcher_own_change: parse_optional_json(own_raw)?,
            watcher_observed_changes: parse_optional_json(observed_raw)?,
            provider_error: (provider_error_raw == Some(1)).then_some(true),
        }))
    }
}

fn parse_optional_json(raw: Option<String>) -> Result<Option<Value>, StoreError> {
    match raw {
        Some(text) if !text.is_empty() => Ok(Some(serde_json::from_str(&text)?)),
        _ => Ok(None),
    }
}

fn apply_event(conn: &Connection, thread_id: &str, event: &ThreadEvent) -> Result<(), StoreError> {
    match event {
        ThreadEvent::MessageAdded { message, .. } => {
            let last: Option<i64> = conn.query_row(
                "SELECT MAX(position) FROM messages WHERE thread_id = ?1",
                [thread_id],
                |r| r.get(0),
            )?;
            let position = last.map_or(0, |n| n + 1);
            let attachments = message
                .attachments
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            let own = message
                .watcher_own_change
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            let observed = message
                .watcher_observed_changes
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            let provider_error: Option<i64> = (message.provider_error == Some(true)).then_some(1);
            conn.execute(
                "INSERT INTO messages (
                   thread_id, position, message_id, role, text, created_at,
                   command_id, attachments, watcher_own_change, watcher_observed_changes,
                   turn_message_id, provider_error
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                rusqlite::params![
                    thread_id,
                    position,
                    message.id,
                    message.role,
                    message.text,
                    message.created_at,
                    message.command_id,
                    attachments,
                    own,
                    observed,
                    message.turn_message_id,
                    provider_error,
                ],
            )?;
        }
        ThreadEvent::MessageTextAppended {
            message_id,
            append_text,
            ..
        } => {
            conn.execute(
                "UPDATE messages SET text = text || ?1 WHERE thread_id = ?2 AND message_id = ?3",
                rusqlite::params![append_text, thread_id, message_id],
            )?;
        }
        ThreadEvent::MessageReplaced { message, .. } => {
            let attachments = message
                .attachments
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            let own = message
                .watcher_own_change
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            let observed = message
                .watcher_observed_changes
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            let provider_error: Option<i64> = (message.provider_error == Some(true)).then_some(1);
            conn.execute(
                "UPDATE messages
                 SET role = ?1, text = ?2, created_at = ?3, command_id = ?4, attachments = ?5,
                     watcher_own_change = COALESCE(?6, watcher_own_change),
                     watcher_observed_changes = COALESCE(?7, watcher_observed_changes),
                     turn_message_id = COALESCE(turn_message_id, ?8),
                     provider_error = COALESCE(?9, provider_error)
                 WHERE thread_id = ?10 AND message_id = ?11",
                rusqlite::params![
                    message.role,
                    message.text,
                    message.created_at,
                    message.command_id,
                    attachments,
                    own,
                    observed,
                    message.turn_message_id,
                    provider_error,
                    thread_id,
                    message.id,
                ],
            )?;
        }
        ThreadEvent::MessageAliased {
            message_id,
            canonical_id,
            ..
        } => {
            if message_id != canonical_id {
                let duplicate = read_single_message(conn, thread_id, message_id)?;
                let canonical = read_single_message(conn, thread_id, canonical_id)?;
                if let (Some(dup), Some(can)) = (duplicate, canonical) {
                    if same_message_content(&dup, &can) {
                        conn.execute(
                            "DELETE FROM messages WHERE thread_id = ?1 AND message_id = ?2",
                            rusqlite::params![thread_id, message_id],
                        )?;
                    }
                }
            }
        }
        ThreadEvent::MessagesReset { .. } => {
            conn.execute("DELETE FROM messages WHERE thread_id = ?1", [thread_id])?;
        }
        ThreadEvent::AnswerGiven { .. } => {}
    }
    Ok(())
}

fn read_single_message(
    conn: &Connection,
    thread_id: &str,
    message_id: &str,
) -> Result<Option<StoredMessage>, StoreError> {
    let row = conn
        .query_row(
            "SELECT message_id, role, text, created_at, command_id, attachments,
                    watcher_own_change, watcher_observed_changes, turn_message_id, provider_error
             FROM messages
             WHERE thread_id = ?1 AND message_id = ?2
             LIMIT 1",
            rusqlite::params![thread_id, message_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                ))
            },
        )
        .optional()?;
    let Some((
        id,
        role,
        text,
        created_at,
        command_id,
        attachments_raw,
        own_raw,
        observed_raw,
        turn_message_id,
        provider_error_raw,
    )) = row
    else {
        return Ok(None);
    };
    Ok(Some(StoredMessage {
        id,
        role,
        text,
        created_at,
        command_id,
        turn_message_id,
        attachments: parse_optional_json(attachments_raw)?,
        watcher_own_change: parse_optional_json(own_raw)?,
        watcher_observed_changes: parse_optional_json(observed_raw)?,
        provider_error: (provider_error_raw == Some(1)).then_some(true),
    }))
}

fn same_message_content(duplicate: &StoredMessage, canonical: &StoredMessage) -> bool {
    duplicate.role == canonical.role
        && duplicate.text == canonical.text
        && (duplicate.command_id.is_none() || duplicate.command_id == canonical.command_id)
        && (duplicate.turn_message_id.is_none()
            || duplicate.turn_message_id == canonical.turn_message_id)
        && (duplicate.attachments.is_none() || duplicate.attachments == canonical.attachments)
}

/// Reads and initializes Sotto's `subagents.sqlite` database in place.
pub struct SubagentStore {
    conn: Connection,
}

impl SubagentStore {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let conn = open_sqlite(path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS subagent_redactions (identity TEXT PRIMARY KEY);
             CREATE TABLE IF NOT EXISTS subagent_flushes (key TEXT PRIMARY KEY, count INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS subagent_classifications (thread_id TEXT NOT NULL, activity_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(thread_id, activity_id));
             CREATE TABLE IF NOT EXISTS subagent_threads (thread_id TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS subagent_rows (thread_id TEXT NOT NULL, agent_id TEXT NOT NULL, sequence INTEGER NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(thread_id, agent_id));
             CREATE INDEX IF NOT EXISTS subagent_rows_sequence ON subagent_rows(thread_id, sequence);
             CREATE INDEX IF NOT EXISTS subagent_rows_status ON subagent_rows(thread_id, status);
             CREATE INDEX IF NOT EXISTS subagent_live_rows ON subagent_rows(status, thread_id);
             CREATE TABLE IF NOT EXISTS subagent_assignments (thread_id TEXT NOT NULL, agent_id TEXT NOT NULL, assignment_id TEXT NOT NULL, sequence INTEGER NOT NULL, value TEXT NOT NULL, fingerprint TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(thread_id, agent_id, assignment_id));
             CREATE INDEX IF NOT EXISTS subagent_assignments_sequence ON subagent_assignments(thread_id, agent_id, sequence);",
        )?;
        Ok(Self { conn })
    }

    pub fn quick_check(&self) -> Result<String, StoreError> {
        let status: String = self.conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        Ok(status)
    }

    pub fn row_count(&self, thread_id: &str) -> Result<i64, StoreError> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM subagent_rows WHERE thread_id = ?1",
            [thread_id],
            |r| r.get(0),
        )?;
        Ok(count)
    }

    /// Deleted threads' rosters go whole (ADR-0140), as Node's `SubagentStore.forgetMany`: their rows, tasks, results
    /// and classifications, in one transaction whose commit waits for the disk, then one scrub. Their identities are
    /// remembered as erased, as turning history off does.
    pub fn forget_many(&self, thread_ids: &[String]) -> Result<(), StoreError> {
        let mut ids: Vec<&str> = Vec::new();
        for id in thread_ids {
            if !ids.contains(&id.as_str()) {
                ids.push(id);
            }
        }
        if ids.is_empty() {
            return Ok(());
        }
        flushed_commits(&self.conn, || {
            self.conn.execute_batch("BEGIN IMMEDIATE;")?;
            let erased = (|| -> Result<(), StoreError> {
                for id in &ids {
                    let mut stmt = self.conn.prepare("SELECT agent_id, assignment_id FROM subagent_assignments WHERE thread_id = ?1")?;
                    let assignments: Vec<(String, String)> = stmt
                        .query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))?
                        .collect::<Result<_, _>>()?;
                    for (agent, assignment) in assignments {
                        for identity in [
                            crate::thread_clearing::subagent_identity(id, &agent, Some(&assignment)),
                            crate::thread_clearing::subagent_identity(id, &agent, None),
                        ] {
                            self.conn.execute("INSERT OR IGNORE INTO subagent_redactions (identity) VALUES (?1)", [identity])?;
                        }
                    }
                    for table in ["subagent_assignments", "subagent_classifications", "subagent_rows", "subagent_threads"] {
                        self.conn.execute(&format!("DELETE FROM {table} WHERE thread_id = ?1"), [id])?;
                    }
                }
                Ok(())
            })();
            match erased {
                Ok(()) => self.conn.execute_batch("COMMIT;")?,
                Err(err) => {
                    let _ = self.conn.execute_batch("ROLLBACK;");
                    return Err(err);
                }
            }
            Ok(())
        })?;
        self.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(())
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

pub fn remote_answer_scope(client_id: &str) -> String {
    format!("client:{client_id}")
}

fn is_inactive_at(record: &PolicyRecord, at_ms: i64) -> bool {
    let parse_ms = |ts: &str| DateTime::parse_from_rfc3339(ts).ok().map(|dt| dt.timestamp_millis());
    if let Some(ref revoked) = record.revoked_at {
        if parse_ms(revoked).is_some_and(|ms| ms <= at_ms) {
            return true;
        }
    }
    if let Some(ref expires) = record.expires_at {
        if parse_ms(expires).is_some_and(|ms| ms <= at_ms) {
            return true;
        }
    }
    false
}

/// Reads and writes Sotto's `memory.sqlite` database in place (schema v1–v4, FTS5, and ADR-0004
/// policy records matching `src/main/memory/migrations.mjs` and `src/main/memory/policies.ts`).
pub struct MemoryStore {
    conn: Connection,
}

impl MemoryStore {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let conn = open_sqlite(path)?;
        run_migrations(&conn, MEMORY_MIGRATIONS)?;
        Ok(Self { conn })
    }

    /// Opens an existing `memory.sqlite` in strictly read-only mode without running migrations
    /// or taking a `BEGIN IMMEDIATE` write lock (safe for concurrent read-only queries).
    pub fn open_read_only(path: &Path) -> Result<Self, StoreError> {
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(Duration::from_secs(5))?;
        Ok(Self { conn })
    }

    pub fn quick_check(&self) -> Result<String, StoreError> {
        let status: String = self.conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        Ok(status)
    }

    pub fn schema_version(&self) -> Result<i64, StoreError> {
        let version: Option<i64> = self
            .conn
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0))?;
        Ok(version.unwrap_or(0))
    }

    pub fn active_policies(&self) -> Result<Vec<PolicyRecord>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, action, resource, scope, effect, source, note, grantedAt, expiresAt, revokedAt
             FROM policies
             WHERE revokedAt IS NULL
             ORDER BY grantedAt ASC, id ASC",
        )?;
        let at_ms = Utc::now().timestamp_millis();
        let rows = stmt.query_map([], map_policy_row)?;
        let mut out = Vec::new();
        for row in rows {
            let record = row?;
            if !is_inactive_at(&record, at_ms) {
                out.push(record);
            }
        }
        Ok(out)
    }

    /// Sets a paired client's `remote-answer` authority (ADR-0004): revokes every active
    /// `remote-answer` record for that client, then inserts a new `allow` record when `allowed` is
    /// true, matching `PolicyStore.setRemoteAnswers`.
    pub fn set_remote_answers(
        &self,
        client_id: &str,
        allowed: bool,
        note: &str,
    ) -> Result<(), StoreError> {
        let scope = remote_answer_scope(client_id);
        let at = now_iso();
        self.conn.execute_batch("BEGIN IMMEDIATE;")?;
        let res = (|| -> Result<(), StoreError> {
            self.conn.execute(
                "UPDATE policies SET revokedAt = ?1
                 WHERE action = 'remote-answer' AND scope = ?2 AND resource = ?3 AND revokedAt IS NULL",
                rusqlite::params![at, scope, client_id],
            )?;
            if allowed {
                let id = Uuid::new_v4().to_string();
                self.conn.execute(
                    "INSERT INTO policies (id, action, resource, scope, effect, source, note, grantedAt, expiresAt, revokedAt)
                     VALUES (?1, 'remote-answer', ?2, ?3, 'allow', 'user', ?4, ?5, NULL, NULL)",
                    rusqlite::params![id, client_id, scope, note, now_iso()],
                )?;
            }
            Ok(())
        })();
        match res {
            Ok(()) => {
                self.conn.execute_batch("COMMIT;")?;
                Ok(())
            }
            Err(err) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(err)
            }
        }
    }

    /// Grants `remote-answer` authority for `client_id` only if no active allow grant already
    /// exists, returning `true` if a new policy record was written (matching `PolicyStore.ensureRemoteAnswers`).
    pub fn ensure_remote_answers(&self, client_id: &str, note: &str) -> Result<bool, StoreError> {
        if self.may_grant_remote(client_id)? {
            return Ok(false);
        }
        self.set_remote_answers(client_id, true, note)?;
        Ok(true)
    }

    /// Evaluates whether a paired remote client may answer permission/question cards (ADR-0004).
    /// Reads only `policies`: never `memories` or `memories_fts`.
    pub fn may_grant_remote(&self, client_id: &str) -> Result<bool, StoreError> {
        let has_policies: bool = self
            .conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'policies' LIMIT 1",
                [],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !has_policies {
            return Ok(false);
        }
        let scope = remote_answer_scope(client_id);
        let mut stmt = self.conn.prepare(
            "SELECT id, action, resource, scope, effect, source, note, grantedAt, expiresAt, revokedAt
             FROM policies
             WHERE action = 'remote-answer' AND scope = ?1 AND resource = ?2
             ORDER BY grantedAt DESC, id DESC",
        )?;
        let rows = stmt.query_map(rusqlite::params![scope, client_id], map_policy_row)?;
        let at_ms = Utc::now().timestamp_millis();
        let mut active = Vec::new();
        for row in rows {
            let record = row?;
            if !is_inactive_at(&record, at_ms) {
                active.push(record);
            }
        }
        if active.iter().any(|r| r.effect == "always-confirm") {
            return Ok(false);
        }
        Ok(active.iter().any(|r| r.effect == "allow"))
    }
}

fn map_policy_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<PolicyRecord> {
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use tempfile::tempdir;

    #[test]
    fn migrates_and_writes_threads_and_memory_stores_with_recursive_triggers_and_fts5() {
        let dir = tempdir().unwrap();

        let threads_path = dir.path().join("threads.sqlite");
        let thread_store = ThreadStore::open(&threads_path).unwrap();
        assert_eq!(thread_store.quick_check().unwrap(), "ok");
        let seq1 = thread_store
            .append_event(
                "t1",
                &ThreadEvent::MessageAdded {
                    at: "2026-11-21T00:00:00.000Z".into(),
                    message: StoredMessage {
                        id: "m1".into(),
                        role: "user".into(),
                        text: "hello".into(),
                        created_at: "2026-11-21T00:00:00.000Z".into(),
                        command_id: None,
                        turn_message_id: None,
                        attachments: None,
                        watcher_own_change: None,
                        watcher_observed_changes: None,
                        provider_error: None,
                    },
                    redacted: None,
                },
            )
            .unwrap();
        let seq2 = thread_store
            .append_event(
                "t1",
                &ThreadEvent::MessageTextAppended {
                    at: "2026-11-21T00:00:01.000Z".into(),
                    message_id: "m1".into(),
                    append_text: " world".into(),
                    redacted: None,
                },
            )
            .unwrap();
        assert!(seq2 > seq1);
        let msgs = thread_store.read_messages("t1").unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].text, "hello world");
        let (events, has_more) = thread_store.read_events(Some("t1"), 0, 50).unwrap();
        assert_eq!(events.len(), 2);
        assert!(!has_more);

        let memory_path = dir.path().join("memory.sqlite");
        let mem_store = MemoryStore::open(&memory_path).unwrap();
        assert_eq!(mem_store.quick_check().unwrap(), "ok");
        assert_eq!(mem_store.schema_version().unwrap(), 4);
        assert!(!mem_store.may_grant_remote("client-1").unwrap());
        mem_store
            .set_remote_answers("client-1", true, "Allowed for test")
            .unwrap();
        assert!(mem_store.may_grant_remote("client-1").unwrap());
        mem_store
            .set_remote_answers("client-1", false, "Denied for test")
            .unwrap();
        assert!(!mem_store.may_grant_remote("client-1").unwrap());
    }

    fn activity(id: &str) -> Value {
        serde_json::json!({ "id": id, "turnId": "turn", "sequence": 0, "kind": "command", "status": "completed", "title": "Run tests" })
    }

    /// Rows a thread holds, in position order, with their positions.
    fn stored_rows(store: &ThreadStore, thread_id: &str) -> Vec<(String, i64)> {
        let mut stmt = store
            .conn
            .prepare("SELECT activity_id, position FROM activities WHERE thread_id = ?1 ORDER BY position")
            .unwrap();
        stmt.query_map([thread_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    /// Rust activity writes never leave a table Node's `ThreadStore` refuses (ADR-0214): no thread over
    /// MAX_AGENT_ACTIVITIES rows and every position unique. With `SOTTO_SHARED_ACTIVITIES_DB` set, the database
    /// is written there for `tests/integration/rustHostActivityCap.test.ts` to open with Node's store.
    #[test]
    fn activity_writes_stay_within_node_limits() {
        let dir = tempdir().unwrap();
        let path = std::env::var_os("SOTTO_SHARED_ACTIVITIES_DB")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| dir.path().join("threads.sqlite"));
        let store = ThreadStore::open(&path).unwrap();
        let total = MAX_AGENT_ACTIVITIES + 25;

        // Incremental writes, as the coordinator makes, past the limit: the oldest go and positions never repeat.
        for index in 0..total {
            store.upsert_activity("upserted", &activity(&format!("work-{index}"))).unwrap();
        }
        // An update of a held record keeps its position rather than taking its list index.
        store.upsert_activity("upserted", &activity(&format!("work-{}", total - 10))).unwrap();
        let rows = stored_rows(&store, "upserted");
        assert_eq!(rows.len(), MAX_AGENT_ACTIVITIES);
        assert_eq!(rows[0].0, "work-25");
        assert_eq!(rows.last().unwrap().0, format!("work-{}", total - 1));
        let positions: HashSet<i64> = rows.iter().map(|(_, position)| *position).collect();
        assert_eq!(positions.len(), rows.len());
        assert_eq!(store.read_activities("upserted").unwrap().len(), MAX_AGENT_ACTIVITIES);

        // A full thread an earlier build left with every row at one position: one new record still leaves the limit.
        // Its own database, since the shared one holds only what Rust itself writes, for Node to open.
        let tied_store = ThreadStore::open(&dir.path().join("tied.sqlite")).unwrap();
        for index in 0..MAX_AGENT_ACTIVITIES {
            tied_store
                .conn
                .execute(
                    "INSERT INTO activities (thread_id, activity_id, position, payload) VALUES ('tied', ?1, 0, ?2)",
                    rusqlite::params![format!("tied-{index}"), activity(&format!("tied-{index}")).to_string()],
                )
                .unwrap();
        }
        tied_store.upsert_activity("tied", &activity("tied-new")).unwrap();
        let tied = stored_rows(&tied_store, "tied");
        assert_eq!(tied.len(), MAX_AGENT_ACTIVITIES);
        assert_eq!(tied.last().unwrap(), &("tied-new".to_string(), 1));

        // Rows Node left at its own positions, with gaps, then a Rust upsert: the new record goes after the last.
        for (index, position) in [(0, 5), (1, 9), (2, 40)] {
            store
                .conn
                .execute(
                    "INSERT INTO activities (thread_id, activity_id, position, payload) VALUES ('mixed', ?1, ?2, ?3)",
                    rusqlite::params![format!("node-{index}"), position, activity(&format!("node-{index}")).to_string()],
                )
                .unwrap();
        }
        store.upsert_activity("mixed", &activity("rust-0")).unwrap();
        let mixed = stored_rows(&store, "mixed");
        assert_eq!(mixed.last().unwrap(), &("rust-0".to_string(), 41));

        // A whole list over the limit saves its newest records at unique positions.
        let list: Vec<Value> = (0..total).map(|index| activity(&format!("saved-{index}"))).collect();
        store.save_activities("saved", None, None, &list).unwrap();
        let saved = stored_rows(&store, "saved");
        assert_eq!(saved.len(), MAX_AGENT_ACTIVITIES);
        assert_eq!(saved[0].0, "saved-25");
        let positions: HashSet<i64> = saved.iter().map(|(_, position)| *position).collect();
        assert_eq!(positions.len(), saved.len());
    }
}
