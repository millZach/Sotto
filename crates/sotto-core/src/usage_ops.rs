use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, Datelike, Duration as ChronoDuration, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::stores::open_sqlite;
use crate::workspace::{now_iso, parse_public_provider_entity_id};

pub const USAGE_MODEL_ROWS_MAX: usize = 200;
pub const USAGE_DAILY_BUCKETS_MAX: usize = 366;
pub const USAGE_HOURLY_CELLS_MAX: usize = 168;
pub const USAGE_CLIENT_ROWS_MAX: usize = 64;

const BUCKET_MS: i64 = 15 * 60 * 1_000;

/// Providers counted in `usage.sqlite`, matching `usageProviderIdSchema` in `src/shared/usageDashboard.ts`.
pub const USAGE_PROVIDERS: &[&str] = &[
    "codex",
    "claude",
    "grok",
    "devin",
    "muse",
    "opencode",
    "antigravity",
];

/// Providers Usage asks for account limits (`USAGE_LIMIT_PROVIDERS` in `src/shared/usageDashboard.ts`).
/// OpenCode and Antigravity are excluded (ADR-0087, ADR-0212).
pub const USAGE_LIMIT_PROVIDERS: &[&str] = &["codex", "claude", "grok", "devin", "muse"];

pub const USAGE_PROVIDERS_BEFORE_MUSE: &[&str] = &["codex", "claude", "grok", "devin"];
pub const USAGE_PROVIDERS_BEFORE_ANTIGRAVITY: &[&str] =
    &["codex", "claude", "grok", "devin", "muse", "opencode"];

#[derive(Debug, Clone, Default)]
pub struct UsageReadQuery {
    pub from: Option<String>,
    pub to: Option<String>,
    pub time_zone: Option<String>,
    pub provider_ids: Option<Vec<String>>,
    pub model_ids: Option<Vec<String>>,
    pub include_daily: Option<bool>,
    pub sources: Option<Vec<String>>,
    pub since: Option<String>,
}

/// Parses a `UsageLocalQuery` JSON object (`src/shared/usageDashboard.ts`) into `UsageReadQuery`.
pub fn parse_usage_read_query(raw: Option<&Value>) -> Result<UsageReadQuery, String> {
    let Some(val) = raw else {
        return Ok(UsageReadQuery::default());
    };
    if val.is_null() {
        return Ok(UsageReadQuery::default());
    }
    let Some(obj) = val.as_object() else {
        return Err("Usage query must be an object.".into());
    };
    let opt_str = |key: &str| -> Option<String> {
        obj.get(key)
            .and_then(Value::as_str)
            .map(ToString::to_string)
    };
    let opt_str_vec = |key: &str| -> Option<Vec<String>> {
        obj.get(key).and_then(Value::as_array).map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(ToString::to_string))
                .collect()
        })
    };
    let time_zone = opt_str("timeZone");
    if let Some(ref tz) = time_zone {
        parse_usage_time_zone(Some(tz))?;
    }
    let from = opt_str("from");
    let to = opt_str("to");
    if let (Some(ref f), Some(ref t)) = (&from, &to) {
        if f > t {
            return Err("Date range ends before it begins.".into());
        }
    }
    Ok(UsageReadQuery {
        from,
        to,
        time_zone,
        provider_ids: opt_str_vec("providerIds"),
        model_ids: opt_str_vec("modelIds"),
        include_daily: obj.get("includeDaily").and_then(Value::as_bool),
        sources: opt_str_vec("sources"),
        since: opt_str("since"),
    })
}

/// Reads the `UsageLocalRead` activity payload directly from `usage.sqlite` (matching `UsageStore.query`),
/// returning `Err` if the database file cannot be opened or is corrupt so callers fall back or surface failure.
pub fn usage_query_activity(data_directory: &Path, query: &UsageReadQuery) -> Result<Value, String> {
    let read = usage_read(data_directory, query, &[]);
    if read.get("status").and_then(Value::as_str) != Some("ready") {
        return Err("Usage store is unavailable.".into());
    }
    read.get("activity")
        .cloned()
        .ok_or_else(|| "Usage activity missing from read.".into())
}

/// Validates an IANA time zone name matching `usageTimeZoneSchema`.
pub fn parse_usage_time_zone(raw: Option<&str>) -> Result<(String, Tz), String> {
    let name = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("UTC");
    let tz: Tz = name
        .parse()
        .map_err(|_| format!("Invalid IANA time zone: {name}"))?;
    Ok((name.to_string(), tz))
}

/// Canonicalizes a served model ID matching `canonicalModelId` in `src/shared/modelCatalog.ts`.
pub fn canonical_model_id(provider: &str, model_id: &str) -> String {
    let raw = if let Some((_prov, kind, val)) = parse_public_provider_entity_id(model_id) {
        if kind == "model" {
            val
        } else {
            std::borrow::Cow::Borrowed(model_id)
        }
    } else {
        std::borrow::Cow::Borrowed(strip_native_model_prefix(model_id))
    };
    let mut id = raw.trim().to_ascii_lowercase();
    if provider == "claude" {
        if let Some(stripped) = id.strip_suffix("[1m]") {
            id = stripped.to_string();
        }
        if let Some(stripped) = strip_claude_anthropic_prefix(&id) {
            id = stripped.to_string();
        }
        id = strip_claude_version_suffix(&id);
        id = strip_at_8_digits(&id);
        id = strip_dash_8_digits(&id);
    } else {
        id = strip_iso_date_suffix(&id);
    }
    if id.is_empty() {
        "unknown".into()
    } else {
        id
    }
}

fn strip_native_model_prefix(model_id: &str) -> &str {
    let Some(rest) = model_id.strip_prefix("native:") else {
        return model_id;
    };
    let Some((prov, after)) = rest.split_once(":model:") else {
        return model_id;
    };
    if !prov.is_empty() && prov.bytes().all(|b| b.is_ascii_lowercase()) {
        after
    } else {
        model_id
    }
}

fn strip_claude_anthropic_prefix(id: &str) -> Option<&str> {
    if let Some(rest) = id.strip_prefix("anthropic.") {
        return Some(rest);
    }
    let bytes = id.as_bytes();
    if bytes.len() > 13
        && bytes[0].is_ascii_lowercase()
        && bytes[1].is_ascii_lowercase()
        && bytes[2] == b'.'
        && id[3..].starts_with("anthropic.")
    {
        return Some(&id[13..]);
    }
    None
}

fn strip_claude_version_suffix(id: &str) -> String {
    // Matches `-v\d+(?::\d+)?$`
    let Some(pos) = id.rfind("-v") else {
        return id.to_string();
    };
    let tail = &id[pos + 2..];
    if tail.is_empty() {
        return id.to_string();
    }
    let valid = match tail.split_once(':') {
        Some((a, b)) => {
            !a.is_empty()
                && !b.is_empty()
                && a.bytes().all(|c| c.is_ascii_digit())
                && b.bytes().all(|c| c.is_ascii_digit())
        }
        None => tail.bytes().all(|c| c.is_ascii_digit()),
    };
    if valid {
        id[..pos].to_string()
    } else {
        id.to_string()
    }
}

fn strip_at_8_digits(id: &str) -> String {
    if id.len() >= 9 {
        let split = id.len() - 9;
        if id.as_bytes()[split] == b'@' && id[split + 1..].bytes().all(|b| b.is_ascii_digit()) {
            return id[..split].to_string();
        }
    }
    id.to_string()
}

fn strip_dash_8_digits(id: &str) -> String {
    if id.len() >= 9 {
        let split = id.len() - 9;
        if id.as_bytes()[split] == b'-' && id[split + 1..].bytes().all(|b| b.is_ascii_digit()) {
            return id[..split].to_string();
        }
    }
    id.to_string()
}

fn strip_iso_date_suffix(id: &str) -> String {
    // Matches `-\d{4}-\d{2}-\d{2}$` (11 bytes)
    if id.len() >= 11 {
        let split = id.len() - 11;
        let b = id.as_bytes();
        if b[split] == b'-'
            && b[split + 1..split + 5].iter().all(u8::is_ascii_digit)
            && b[split + 5] == b'-'
            && b[split + 6..split + 8].iter().all(u8::is_ascii_digit)
            && b[split + 8] == b'-'
            && b[split + 9..split + 11].iter().all(u8::is_ascii_digit)
        {
            return id[..split].to_string();
        }
    }
    id.to_string()
}

#[derive(Default)]
struct AggBuilder {
    token_records: u64,
    partial_records: u64,
    undated_records: u64,
    input_value: u64,
    input_known: u64,
    output_value: u64,
    output_known: u64,
    cached_value: u64,
    cached_known: u64,
    cache_write_value: u64,
    cache_write_known: u64,
    cache_write_5m_value: u64,
    cache_write_5m_known: u64,
    cache_write_1h_value: u64,
    cache_write_1h_known: u64,
    total_value: u64,
    total_known: u64,
    prompt_user: u64,
    prompt_watcher: u64,
    prompt_wake_up: u64,
    prompt_total: u64,
    prompt_steered: u64,
    threads: HashSet<String>,
    days: BTreeSet<String>,
    providers: BTreeSet<String>,
}

struct TokenChunk {
    provider: String,
    thread_id: String,
    day: Option<String>,
    records: u64,
    partial_records: u64,
    input_value: u64,
    input_known: u64,
    output_value: u64,
    output_known: u64,
    cached_value: u64,
    cached_known: u64,
    cache_write_value: u64,
    cache_write_known: u64,
    cache_write_5m_value: u64,
    cache_write_5m_known: u64,
    cache_write_1h_value: u64,
    cache_write_1h_known: u64,
    total_value: u64,
    total_known: u64,
}

impl AggBuilder {
    fn add_tokens(&mut self, chunk: &TokenChunk) {
        self.token_records = self.token_records.saturating_add(chunk.records);
        self.partial_records = self.partial_records.saturating_add(chunk.partial_records);
        if chunk.day.is_none() {
            self.undated_records = self.undated_records.saturating_add(chunk.records);
        }
        self.input_value = self.input_value.saturating_add(chunk.input_value);
        self.input_known = self.input_known.saturating_add(chunk.input_known);
        self.output_value = self.output_value.saturating_add(chunk.output_value);
        self.output_known = self.output_known.saturating_add(chunk.output_known);
        self.cached_value = self.cached_value.saturating_add(chunk.cached_value);
        self.cached_known = self.cached_known.saturating_add(chunk.cached_known);
        self.cache_write_value = self.cache_write_value.saturating_add(chunk.cache_write_value);
        self.cache_write_known = self.cache_write_known.saturating_add(chunk.cache_write_known);
        self.cache_write_5m_value = self
            .cache_write_5m_value
            .saturating_add(chunk.cache_write_5m_value);
        self.cache_write_5m_known = self
            .cache_write_5m_known
            .saturating_add(chunk.cache_write_5m_known);
        self.cache_write_1h_value = self
            .cache_write_1h_value
            .saturating_add(chunk.cache_write_1h_value);
        self.cache_write_1h_known = self
            .cache_write_1h_known
            .saturating_add(chunk.cache_write_1h_known);
        self.total_value = self.total_value.saturating_add(chunk.total_value);
        self.total_known = self.total_known.saturating_add(chunk.total_known);
        self.threads.insert(chunk.thread_id.clone());
        if let Some(ref d) = chunk.day {
            self.days.insert(d.clone());
        }
        self.providers.insert(chunk.provider.clone());
    }

    fn add_prompt(
        &mut self,
        provider: &str,
        thread_id: &str,
        day: &str,
        kind: &str,
        input_kind: &str,
    ) {
        match kind {
            "user" => self.prompt_user = self.prompt_user.saturating_add(1),
            "watcher" => self.prompt_watcher = self.prompt_watcher.saturating_add(1),
            "wake-up" => self.prompt_wake_up = self.prompt_wake_up.saturating_add(1),
            _ => {}
        }
        self.prompt_total = self.prompt_total.saturating_add(1);
        if input_kind == "steer" {
            self.prompt_steered = self.prompt_steered.saturating_add(1);
        }
        self.threads.insert(thread_id.to_string());
        self.days.insert(day.to_string());
        self.providers.insert(provider.to_string());
    }

    fn first_day(&self) -> Option<&str> {
        self.days.iter().next().map(String::as_str)
    }

    fn last_day(&self) -> Option<&str> {
        self.days.iter().next_back().map(String::as_str)
    }

    fn to_json_object(&self) -> Map<String, Value> {
        let field = |val: u64, known: u64| -> Value {
            let mut obj = Map::new();
            if known > 0 {
                obj.insert("value".into(), json!(val));
            }
            obj.insert("knownRows".into(), json!(known));
            obj.insert("rows".into(), json!(self.token_records));
            obj.insert(
                "partial".into(),
                json!(known < self.token_records || self.partial_records > 0),
            );
            Value::Object(obj)
        };
        let mut obj = Map::new();
        obj.insert(
            "tokens".into(),
            json!({
                "input": field(self.input_value, self.input_known),
                "output": field(self.output_value, self.output_known),
                "cached": field(self.cached_value, self.cached_known),
                "cacheWrite": field(self.cache_write_value, self.cache_write_known),
                "cacheWrite5m": field(self.cache_write_5m_value, self.cache_write_5m_known),
                "cacheWrite1h": field(self.cache_write_1h_value, self.cache_write_1h_known),
                "total": field(self.total_value, self.total_known),
            }),
        );
        obj.insert(
            "prompts".into(),
            json!({
                "user": self.prompt_user,
                "watcher": self.prompt_watcher,
                "wakeUp": self.prompt_wake_up,
                "total": self.prompt_total,
                "steered": self.prompt_steered,
            }),
        );
        obj.insert("tokenRecords".into(), json!(self.token_records));
        obj.insert("partialTokenRecords".into(), json!(self.partial_records));
        obj.insert("undatedTokenRecords".into(), json!(self.undated_records));
        obj.insert("activeThreads".into(), json!(self.threads.len()));
        obj.insert("activeDays".into(), json!(self.days.len()));
        if let Some(last) = self.last_day() {
            obj.insert("lastDay".into(), json!(last));
        }
        obj
    }
}

#[derive(Default)]
struct PromptTotals {
    user: u64,
    watcher: u64,
    wake_up: u64,
    total: u64,
    steered: u64,
}

impl PromptTotals {
    fn add(&mut self, kind: &str, input_kind: &str) {
        match kind {
            "user" => self.user = self.user.saturating_add(1),
            "watcher" => self.watcher = self.watcher.saturating_add(1),
            "wake-up" => self.wake_up = self.wake_up.saturating_add(1),
            _ => {}
        }
        self.total = self.total.saturating_add(1);
        if input_kind == "steer" {
            self.steered = self.steered.saturating_add(1);
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "user": self.user,
            "watcher": self.watcher,
            "wakeUp": self.wake_up,
            "total": self.total,
            "steered": self.steered,
        })
    }
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
        [name],
        |_| Ok(true),
    )
    .unwrap_or(false)
}

fn table_has_column(conn: &Connection, table: &str, col: &str) -> bool {
    let sql = format!("PRAGMA table_info({table})");
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return false;
    };
    stmt.query_map([], |row| row.get::<_, String>(1))
        .map(|rows| rows.flatten().any(|name| name == col))
        .unwrap_or(false)
}

fn read_metadata_json(conn: &Connection) -> Option<(i64, i64, Option<String>, Value)> {
    if !table_exists(conn, "usage_meta") {
        return None;
    }
    let meta_row: Option<(String, i64, i64, Option<String>, i64)> = conn
        .query_row(
            "SELECT started_at, revision, generation, cleared_at, seed_completed
             FROM usage_meta
             WHERE singleton = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .ok()
        .flatten();
    let (started_at, revision, generation, cleared_at, seed_completed) = meta_row?;
    let mut obj = Map::new();
    obj.insert("startedAt".into(), json!(started_at));
    obj.insert("revision".into(), json!(revision.max(0)));
    obj.insert("generation".into(), json!(generation.max(0)));
    if let Some(ref cleared) = cleared_at {
        obj.insert("clearedAt".into(), json!(cleared));
    }
    obj.insert("legacySeedCompleted".into(), json!(seed_completed != 0));

    if table_exists(conn, "usage_history") {
        let hist: Option<(String, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT status, earliest_at, scanned_at FROM usage_history WHERE singleton = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .ok()
            .flatten();
        if let Some((status, earliest_at, scanned_at)) = hist {
            let mut h = Map::new();
            h.insert("status".into(), json!(status));
            if let Some(e) = earliest_at {
                h.insert("earliestAt".into(), json!(e));
            }
            if let Some(s) = scanned_at {
                h.insert("scannedAt".into(), json!(s));
            }
            obj.insert("history".into(), Value::Object(h));
        }
    }
    Some((revision, generation, cleared_at, Value::Object(obj)))
}

/// Builds honest unavailable quota entries matching `UsageService.readQuotas` when native quota
/// readers are not wired on the host yet (never emitting Antigravity limits, ADR-0212).
pub fn build_usage_quotas(
    provider_ids: Option<&[String]>,
    connected_providers: &[String],
) -> Vec<Value> {
    let mut out = Vec::new();
    for &provider in USAGE_LIMIT_PROVIDERS {
        if let Some(filter) = provider_ids {
            if !filter.iter().any(|p| p == provider) {
                continue;
            }
        }
        let connected = connected_providers.iter().any(|c| c == provider);
        out.push(json!({
            "providerId": provider,
            "status": "unavailable",
            "windows": [],
            "refreshable": false,
            "reason": if connected { "unsupported" } else { "not-connected" },
        }));
    }
    out
}

/// Answers `usage-refresh` matching `usageLocalHostReadSchema` (`src/shared/usageDashboard.ts`).
pub fn usage_refresh(provider_ids: Option<&[String]>, connected_providers: &[String]) -> Value {
    json!({
        "status": "ready",
        "quotas": build_usage_quotas(provider_ids, connected_providers),
        "persistence": "saved",
    })
}

fn parse_utc_instant(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

fn parse_bucket_utc(bucket: &str) -> Option<DateTime<Utc>> {
    if bucket.is_empty() {
        return None;
    }
    let naive = NaiveDateTime::parse_from_str(bucket, "%Y-%m-%dT%H:%M").ok()?;
    Some(Utc.from_utc_datetime(&naive))
}

fn local_day_of(dt: DateTime<Utc>, tz: Tz) -> String {
    let local = dt.with_timezone(&tz);
    format!("{:04}-{:02}-{:02}", local.year(), local.month(), local.day())
}

fn day_span_inclusive(from: Option<&str>, to: Option<&str>) -> Option<i64> {
    let (Some(f), Some(t)) = (from, to) else {
        return Some(0);
    };
    let d1 = NaiveDate::parse_from_str(f, "%Y-%m-%d").ok()?;
    let d2 = NaiveDate::parse_from_str(t, "%Y-%m-%d").ok()?;
    Some((d2 - d1).num_days() + 1)
}

fn day_in_range(day: Option<&str>, from: Option<&str>, to: Option<&str>) -> bool {
    if from.is_none() && to.is_none() {
        return true;
    }
    let Some(d) = day else {
        return false;
    };
    if let Some(f) = from {
        if d < f {
            return false;
        }
    }
    if let Some(t) = to {
        if d > t {
            return false;
        }
    }
    true
}

fn is_valid_usage_client(client: &str) -> bool {
    matches!(
        client,
        "sotto"
            | "claude-code"
            | "codex-app"
            | "codex-cli"
            | "codex-exec"
            | "codex-ide"
            | "t3-code"
            | "codex-in-claude-code"
            | "other"
            | "antigravity"
    )
}

fn is_valid_usage_source(source: &str) -> bool {
    matches!(source, "sotto" | "outside")
}

#[derive(Clone)]
struct CachedPromptRow {
    provider: String,
    served_model_raw: String,
    thread_id: String,
    source: String,
    client: String,
    at_dt: DateTime<Utc>,
    kind: String,
    input_kind: String,
}

#[derive(Clone)]
struct PromptServedCache {
    revision: i64,
    generation: i64,
    rows: Vec<CachedPromptRow>,
}

const PROMPT_CACHE_MAX_DBS: usize = 8;

fn prompt_served_cache() -> &'static Mutex<HashMap<PathBuf, PromptServedCache>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, PromptServedCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn utc_day_bounds(from: Option<&str>, to: Option<&str>) -> (Option<DateTime<Utc>>, Option<DateTime<Utc>>) {
    // Every IANA timezone offset lies within [-14h, +14h], so padding `from` by -1 day
    // and `to` by +2 days (exclusive) is a lossless UTC prefilter for any time zone.
    let lower = from
        .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|ndt| Utc.from_utc_datetime(&ndt) - ChronoDuration::days(1));
    let upper = to
        .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|ndt| Utc.from_utc_datetime(&ndt) + ChronoDuration::days(2));
    (lower, upper)
}

fn table_exists_checked(conn: &Connection, table: &str) -> Result<bool, rusqlite::Error> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
        [table],
        |_| Ok(true),
    )
    .optional()
    .map(|opt| opt.unwrap_or(false))
}

fn load_cached_prompts(
    tx: &rusqlite::Transaction<'_>,
    db_path: &Path,
    revision: i64,
    generation: i64,
    has_token_rows: bool,
) -> Result<Vec<CachedPromptRow>, rusqlite::Error> {
    if let Ok(guard) = prompt_served_cache().lock() {
        if let Some(entry) = guard.get(db_path) {
            if entry.revision == revision && entry.generation == generation {
                return Ok(entry.rows.clone());
            }
        }
    }

    let prompt_has_source = table_has_column(tx, "prompt_rows", "source");
    let token_has_sub_agent = has_token_rows && table_has_column(tx, "token_rows", "sub_agent");
    let source_cols = if prompt_has_source {
        "source, client"
    } else {
        "'sotto' AS source, 'sotto' AS client"
    };
    let served_expr = if has_token_rows {
        let sub_clause = if token_has_sub_agent {
            "AND t.sub_agent = 0"
        } else {
            ""
        };
        format!(
            "COALESCE((
                SELECT t.model_id
                FROM token_rows t
                WHERE t.provider = p.provider
                  AND t.thread_id = p.thread_id
                  {sub_clause}
                  AND t.at >= p.at
                  AND (p.next_at IS NULL OR t.at < p.next_at)
                ORDER BY t.at ASC
                LIMIT 1
            ), p.model_id)"
        )
    } else {
        "p.model_id".to_string()
    };
    let prompt_sql = format!(
        "SELECT p.provider, {served_expr} AS served_model_id,
                p.thread_id, p.source, p.client, p.at, p.kind, p.input_kind
         FROM (
             SELECT provider, thread_id, message_id, model_id, at, kind, input_kind, {source_cols},
                    LEAD(at) OVER (PARTITION BY provider, thread_id ORDER BY at, message_id) AS next_at
             FROM prompt_rows
         ) p
         ORDER BY p.at ASC"
    );

    let mut out = Vec::new();
    let mut stmt = tx.prepare(&prompt_sql)?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let provider: String = row.get(0)?;
        let served_model_raw: String = row.get(1)?;
        let thread_id: String = row.get(2)?;
        let source: String = row.get(3)?;
        let client: String = row.get(4)?;
        let at: String = row.get(5)?;
        let kind: String = row.get(6)?;
        let input_kind: String = row.get(7)?;
        if !USAGE_PROVIDERS.contains(&provider.as_str())
            || !is_valid_usage_source(&source)
            || !is_valid_usage_client(&client)
        {
            continue;
        }
        let Some(at_dt) = parse_utc_instant(&at) else {
            continue;
        };
        out.push(CachedPromptRow {
            provider,
            served_model_raw,
            thread_id,
            source,
            client,
            at_dt,
            kind,
            input_kind,
        });
    }
    out.sort_by_key(|r| r.at_dt);

    if let Ok(mut guard) = prompt_served_cache().lock() {
        if guard.len() >= PROMPT_CACHE_MAX_DBS && !guard.contains_key(db_path) {
            guard.clear();
        }
        guard.insert(
            db_path.to_path_buf(),
            PromptServedCache {
                revision,
                generation,
                rows: out.clone(),
            },
        );
    }
    Ok(out)
}

fn usage_error_read(quotas: Vec<Value>) -> Value {
    json!({
        "status": "error",
        "quotas": quotas,
        "persistence": "failed",
    })
}

/// Reads real usage dashboard rollups from `usage.sqlite` matching `usageLocalHostReadSchema`
/// (`src/shared/usageDashboard.ts`) and `UsageStore.query` (`src/main/agents/usageStore.ts`).
pub fn usage_read(
    data_directory: &Path,
    query: &UsageReadQuery,
    connected_providers: &[String],
) -> Value {
    let (tz_name, tz) = parse_usage_time_zone(query.time_zone.as_deref())
        .unwrap_or_else(|_| ("UTC".into(), chrono_tz::UTC));
    let quotas = build_usage_quotas(query.provider_ids.as_deref(), connected_providers);
    let db_path = data_directory.join("usage.sqlite");

    // Only a genuinely missing database reads as a fresh empty store; an existing file that
    // cannot be opened or whose schema/pages are corrupt must surface as `status: "error"`.
    if !db_path.exists() {
        return empty_usage_ready(&tz_name, query.include_daily, quotas);
    }

    match usage_read_existing(&db_path, &tz_name, tz, query, quotas.clone()) {
        Ok(val) => val,
        Err(_) => usage_error_read(quotas),
    }
}

fn usage_read_existing(
    db_path: &Path,
    tz_name: &str,
    tz: Tz,
    query: &UsageReadQuery,
    quotas: Vec<Value>,
) -> Result<Value, rusqlite::Error> {
    let mut conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));

    // Keep metadata, token buckets/rows, and prompt reads inside one consistent SQLite read transaction
    // so a concurrent `usage-clear` can never split tokens, prompts, and metadata across revisions.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Deferred)?;

    if !table_exists_checked(&tx, "usage_meta")? {
        return Ok(empty_usage_ready(tz_name, query.include_daily, quotas));
    }
    let Some((revision, generation, _, metadata)) = read_metadata_json(&tx) else {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    };

    let provider_filter: Option<HashSet<&str>> = query
        .provider_ids
        .as_ref()
        .map(|list| list.iter().map(String::as_str).collect());
    let model_filter: Option<HashSet<&str>> = query
        .model_ids
        .as_ref()
        .map(|list| list.iter().map(String::as_str).collect());
    let source_filter: Option<HashSet<&str>> = query
        .sources
        .as_ref()
        .map(|list| list.iter().map(String::as_str).collect());
    let since_dt = query.since.as_deref().and_then(parse_utc_instant);
    let since_iso = since_dt.map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    let from = query.from.as_deref();
    let to = query.to.as_deref();
    let (range_lower_utc, range_upper_utc) = utc_day_bounds(from, to);

    let mut totals = AggBuilder::default();
    let mut by_provider: BTreeMap<String, AggBuilder> = BTreeMap::new();
    let mut by_model: HashMap<(String, String), AggBuilder> = HashMap::new();
    let mut by_day: BTreeMap<String, AggBuilder> = BTreeMap::new();
    let mut by_client: HashMap<(String, String, bool), AggBuilder> = HashMap::new();
    let mut by_hour: BTreeMap<(u32, u32), PromptTotals> = BTreeMap::new();

    // 1. Read token buckets (or fallback to token_rows for v0 databases) with SQL time-range prefiltering.
    let has_buckets = table_exists_checked(&tx, "token_buckets")?;
    let has_token_rows = table_exists_checked(&tx, "token_rows")?;
    if has_buckets {
        let splits_bucket = since_dt.is_some_and(|dt| dt.timestamp_millis().rem_euclid(BUCKET_MS) != 0);
        let since_bucket = since_dt.map(|dt| {
            let floored = dt.timestamp_millis().div_euclid(BUCKET_MS) * BUCKET_MS;
            DateTime::from_timestamp_millis(floored)
                .unwrap_or(dt)
                .format("%Y-%m-%dT%H:%M")
                .to_string()
        });
        let range_lower_bucket = range_lower_utc.map(|dt| dt.format("%Y-%m-%dT%H:%M").to_string());
        let range_upper_bucket = range_upper_utc.map(|dt| dt.format("%Y-%m-%dT%H:%M").to_string());

        let mut where_parts: Vec<String> = Vec::new();
        let mut params_vec: Vec<String> = Vec::new();
        if let Some(ref sb) = since_bucket {
            params_vec.push(sb.clone());
            where_parts.push(if splits_bucket {
                format!("bucket > ?{}", params_vec.len())
            } else {
                format!("bucket >= ?{}", params_vec.len())
            });
        }
        if let Some(ref lb) = range_lower_bucket {
            params_vec.push(lb.clone());
            where_parts.push(format!("bucket >= ?{}", params_vec.len()));
        }
        if let Some(ref ub) = range_upper_bucket {
            params_vec.push(ub.clone());
            where_parts.push(format!("bucket < ?{}", params_vec.len()));
        }
        let where_clause = if where_parts.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_parts.join(" AND "))
        };
        let bucket_sql = format!(
            "SELECT provider, thread_id, model_id, source, client, sub_agent, bucket,
                    records, partial_records,
                    input_value, input_known, output_value, output_known,
                    cached_value, cached_known, cache_write_value, cache_write_known,
                    cache_write_5m_value, cache_write_5m_known,
                    cache_write_1h_value, cache_write_1h_known,
                    token_total_value, token_total_known
             FROM token_buckets
             {where_clause}"
        );
        let mut stmt = tx.prepare(&bucket_sql)?;
        let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec
            .iter()
            .map(|s| s as &dyn rusqlite::ToSql)
            .collect();
        let mut rows = stmt.query(param_refs.as_slice())?;
        while let Some(row) = rows.next()? {
            let provider: String = row.get(0)?;
            let thread_id: String = row.get(1)?;
            let model_raw: String = row.get(2)?;
            let source: String = row.get(3)?;
            let client: String = row.get(4)?;
            let sub_agent: bool = row.get::<_, i64>(5)? != 0;
            let bucket: String = row.get(6)?;
            if !USAGE_PROVIDERS.contains(&provider.as_str())
                || !is_valid_usage_source(&source)
                || !is_valid_usage_client(&client)
            {
                continue;
            }
            if let Some(ref pf) = provider_filter {
                if !pf.contains(provider.as_str()) {
                    continue;
                }
            }
            if let Some(ref sf) = source_filter {
                if !sf.contains(source.as_str()) {
                    continue;
                }
            }
            let local_day = parse_bucket_utc(&bucket).map(|dt| local_day_of(dt, tz));
            if !day_in_range(local_day.as_deref(), from, to) {
                continue;
            }
            let model = canonical_model_id(&provider, &model_raw);
            if let Some(ref mf) = model_filter {
                if !mf.contains(model.as_str()) {
                    continue;
                }
            }
            let chunk = TokenChunk {
                provider: provider.clone(),
                thread_id,
                day: local_day.clone(),
                records: row.get::<_, i64>(7)?.max(0) as u64,
                partial_records: row.get::<_, i64>(8)?.max(0) as u64,
                input_value: row.get::<_, i64>(9)?.max(0) as u64,
                input_known: row.get::<_, i64>(10)?.max(0) as u64,
                output_value: row.get::<_, i64>(11)?.max(0) as u64,
                output_known: row.get::<_, i64>(12)?.max(0) as u64,
                cached_value: row.get::<_, i64>(13)?.max(0) as u64,
                cached_known: row.get::<_, i64>(14)?.max(0) as u64,
                cache_write_value: row.get::<_, i64>(15)?.max(0) as u64,
                cache_write_known: row.get::<_, i64>(16)?.max(0) as u64,
                cache_write_5m_value: row.get::<_, i64>(17)?.max(0) as u64,
                cache_write_5m_known: row.get::<_, i64>(18)?.max(0) as u64,
                cache_write_1h_value: row.get::<_, i64>(19)?.max(0) as u64,
                cache_write_1h_known: row.get::<_, i64>(20)?.max(0) as u64,
                total_value: row.get::<_, i64>(21)?.max(0) as u64,
                total_known: row.get::<_, i64>(22)?.max(0) as u64,
            };
            totals.add_tokens(&chunk);
            by_provider.entry(provider.clone()).or_default().add_tokens(&chunk);
            by_model
                .entry((provider, model))
                .or_default()
                .add_tokens(&chunk);
            if let Some(day) = local_day {
                by_day.entry(day).or_default().add_tokens(&chunk);
            }
            by_client
                .entry((source, client, sub_agent))
                .or_default()
                .add_tokens(&chunk);
        }

        // Exact rows for the single 15-minute bucket split by `since`.
        if splits_bucket && has_token_rows {
            if let (Some(dt), Some(ref since_str)) = (since_dt, &since_iso) {
                let bucket_end_ms =
                    (dt.timestamp_millis().div_euclid(BUCKET_MS) + 1) * BUCKET_MS;
                let bucket_end_iso = DateTime::from_timestamp_millis(bucket_end_ms)
                    .unwrap_or(dt)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                ingest_token_rows(
                    &tx,
                    Some((since_str.as_str(), Some(bucket_end_iso.as_str()))),
                    tz,
                    from,
                    to,
                    provider_filter.as_ref(),
                    model_filter.as_ref(),
                    source_filter.as_ref(),
                    &mut totals,
                    &mut by_provider,
                    &mut by_model,
                    &mut by_day,
                    &mut by_client,
                )?;
            }
        }
    } else if has_token_rows {
        ingest_token_rows(
            &tx,
            since_iso.as_deref().map(|s| (s, None)),
            tz,
            from,
            to,
            provider_filter.as_ref(),
            model_filter.as_ref(),
            source_filter.as_ref(),
            &mut totals,
            &mut by_provider,
            &mut by_model,
            &mut by_day,
            &mut by_client,
        )?;
    }

    // 2. Read prompt rows with revision-cached served-model attribution (matching `UsageStore.servedModels`)
    // and binary-searched UTC range slicing so small-range queries do not scan full history.
    if table_exists_checked(&tx, "prompt_rows")? {
        let prompts = load_cached_prompts(&tx, db_path, revision, generation, has_token_rows)?;
        let lower_bound = match (since_dt, range_lower_utc) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        };
        let start_idx = lower_bound
            .map(|lb| prompts.partition_point(|r| r.at_dt < lb))
            .unwrap_or(0);
        let end_idx = range_upper_utc
            .map(|ub| prompts.partition_point(|r| r.at_dt < ub))
            .unwrap_or(prompts.len());
        let slice = if start_idx <= end_idx {
            &prompts[start_idx..end_idx]
        } else {
            &[]
        };

        for row in slice {
            if let Some(ref pf) = provider_filter {
                if !pf.contains(row.provider.as_str()) {
                    continue;
                }
            }
            if let Some(ref sf) = source_filter {
                if !sf.contains(row.source.as_str()) {
                    continue;
                }
            }
            if let Some(sdt) = since_dt {
                if row.at_dt < sdt {
                    continue;
                }
            }
            let local = row.at_dt.with_timezone(&tz);
            let day = format!("{:04}-{:02}-{:02}", local.year(), local.month(), local.day());
            if !day_in_range(Some(&day), from, to) {
                continue;
            }
            let model = canonical_model_id(&row.provider, &row.served_model_raw);
            if let Some(ref mf) = model_filter {
                if !mf.contains(model.as_str()) {
                    continue;
                }
            }
            let weekday = local.weekday().num_days_from_monday();
            let hour = local.hour();

            totals.add_prompt(&row.provider, &row.thread_id, &day, &row.kind, &row.input_kind);
            by_provider
                .entry(row.provider.clone())
                .or_default()
                .add_prompt(&row.provider, &row.thread_id, &day, &row.kind, &row.input_kind);
            by_model
                .entry((row.provider.clone(), model))
                .or_default()
                .add_prompt(&row.provider, &row.thread_id, &day, &row.kind, &row.input_kind);
            by_day
                .entry(day.clone())
                .or_default()
                .add_prompt(&row.provider, &row.thread_id, &day, &row.kind, &row.input_kind);
            by_client
                .entry((row.source.clone(), row.client.clone(), false))
                .or_default()
                .add_prompt(&row.provider, &row.thread_id, &day, &row.kind, &row.input_kind);
            by_hour
                .entry((weekday, hour))
                .or_default()
                .add(&row.kind, &row.input_kind);
        }
    }

    // 3. Serialize aggregates in exact Node `UsageStore.query` order and bounds.
    let providers: Vec<Value> = by_provider
        .into_iter()
        .map(|(provider_id, agg)| {
            let mut obj = agg.to_json_object();
            obj.insert("providerId".into(), json!(provider_id));
            Value::Object(obj)
        })
        .collect();

    let model_count = by_model.len();
    let mut model_entries: Vec<((String, String), AggBuilder)> = by_model.into_iter().collect();
    model_entries.sort_by(|((p1, m1), a1), ((p2, m2), a2)| {
        let io1 = a1.input_value.saturating_add(a1.output_value);
        let io2 = a2.input_value.saturating_add(a2.output_value);
        io2.cmp(&io1)
            .then_with(|| a2.prompt_total.cmp(&a1.prompt_total))
            .then_with(|| p1.cmp(p2))
            .then_with(|| m1.cmp(m2))
    });
    let models: Vec<Value> = model_entries
        .into_iter()
        .take(USAGE_MODEL_ROWS_MAX)
        .map(|((provider_id, model_id), agg)| {
            let mut obj = agg.to_json_object();
            obj.insert("providerId".into(), json!(provider_id));
            obj.insert("modelId".into(), json!(model_id));
            Value::Object(obj)
        })
        .collect();

    let span_from = from.or_else(|| totals.first_day());
    let span_to = to.or_else(|| totals.last_day());
    let span = day_span_inclusive(span_from, span_to).unwrap_or(0);
    let daily_coverage = if query.include_daily == Some(false) {
        "not-requested"
    } else if span > USAGE_DAILY_BUCKETS_MAX as i64 {
        "omitted-range"
    } else {
        "complete"
    };
    let daily: Vec<Value> = if daily_coverage == "complete" {
        by_day
            .into_iter()
            .take(USAGE_DAILY_BUCKETS_MAX)
            .map(|(day, agg)| {
                let mut obj = agg.to_json_object();
                obj.insert("day".into(), json!(day));
                Value::Object(obj)
            })
            .collect()
    } else {
        Vec::new()
    };

    let hourly: Vec<Value> = by_hour
        .into_iter()
        .take(USAGE_HOURLY_CELLS_MAX)
        .map(|((weekday, hour), prompts)| {
            json!({
                "weekday": weekday,
                "hour": hour,
                "prompts": prompts.to_json(),
            })
        })
        .collect();

    let mut client_entries: Vec<((String, String, bool), AggBuilder)> =
        by_client.into_iter().collect();
    client_entries.sort_by(|((s1, c1, sub1), _), ((s2, c2, sub2), _)| {
        s2.cmp(s1)
            .then_with(|| c1.cmp(c2))
            .then_with(|| sub1.cmp(sub2))
    });
    let clients: Vec<Value> = client_entries
        .into_iter()
        .take(USAGE_CLIENT_ROWS_MAX)
        .map(|((source, client_id, sub_agent), agg)| {
            let provs: Vec<String> = agg.providers.iter().cloned().collect();
            let mut obj = agg.to_json_object();
            obj.insert("source".into(), json!(source));
            obj.insert("clientId".into(), json!(client_id));
            obj.insert("subAgent".into(), json!(sub_agent));
            obj.insert("providerIds".into(), json!(provs));
            Value::Object(obj)
        })
        .collect();

    Ok(json!({
        "status": "ready",
        "activity": {
            "metadata": metadata,
            "totals": Value::Object(totals.to_json_object()),
            "timeZone": tz_name,
            "providers": providers,
            "models": models,
            "modelCount": model_count,
            "modelsTruncated": model_count > USAGE_MODEL_ROWS_MAX,
            "daily": daily,
            "dailyCoverage": daily_coverage,
            "hourly": hourly,
            "clients": clients,
        },
        "quotas": quotas,
        "persistence": "saved",
    }))
}

#[allow(clippy::too_many_arguments)]
fn ingest_token_rows(
    conn: &Connection,
    at_bounds: Option<(&str, Option<&str>)>,
    tz: Tz,
    from: Option<&str>,
    to: Option<&str>,
    provider_filter: Option<&HashSet<&str>>,
    model_filter: Option<&HashSet<&str>>,
    source_filter: Option<&HashSet<&str>>,
    totals: &mut AggBuilder,
    by_provider: &mut BTreeMap<String, AggBuilder>,
    by_model: &mut HashMap<(String, String), AggBuilder>,
    by_day: &mut BTreeMap<String, AggBuilder>,
    by_client: &mut HashMap<(String, String, bool), AggBuilder>,
) -> Result<(), rusqlite::Error> {
    let has_source = table_has_column(conn, "token_rows", "source");
    let extra_cols = if has_source {
        "source, client, sub_agent"
    } else {
        "'sotto' AS source, 'sotto' AS client, 0 AS sub_agent"
    };
    let where_clause = match at_bounds {
        Some((_, Some(_))) => "WHERE at >= ?1 AND at < ?2",
        Some((_, None)) => "WHERE at >= ?1",
        None => "",
    };
    let sql = format!(
        "SELECT provider, thread_id, model_id, {extra_cols}, at, partial,
                input, output, cached, cache_write, cache_write_5m, cache_write_1h
         FROM token_rows
         {where_clause}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut handle_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<()> {
        let provider: String = row.get(0)?;
        let thread_id: String = row.get(1)?;
        let model_raw: String = row.get(2)?;
        let source: String = row.get(3)?;
        let client: String = row.get(4)?;
        let sub_agent: bool = row.get::<_, i64>(5)? != 0;
        let at_raw: Option<String> = row.get(6)?;
        let partial: bool = row.get::<_, i64>(7)? != 0;
        let input: Option<i64> = row.get(8)?;
        let output: Option<i64> = row.get(9)?;
        let cached: Option<i64> = row.get(10)?;
        let cache_write: Option<i64> = row.get(11)?;
        let cache_write_5m: Option<i64> = row.get(12)?;
        let cache_write_1h: Option<i64> = row.get(13)?;

        if !USAGE_PROVIDERS.contains(&provider.as_str())
            || !is_valid_usage_source(&source)
            || !is_valid_usage_client(&client)
        {
            return Ok(());
        }
        if let Some(pf) = provider_filter {
            if !pf.contains(provider.as_str()) {
                return Ok(());
            }
        }
        if let Some(sf) = source_filter {
            if !sf.contains(source.as_str()) {
                return Ok(());
            }
        }
        let local_day = at_raw
            .as_deref()
            .and_then(parse_utc_instant)
            .map(|dt| local_day_of(dt, tz));
        if !day_in_range(local_day.as_deref(), from, to) {
            return Ok(());
        }
        let model = canonical_model_id(&provider, &model_raw);
        if let Some(mf) = model_filter {
            if !mf.contains(model.as_str()) {
                return Ok(());
            }
        }
        let (total_val, total_known) = match (input, output) {
            (Some(i), Some(o)) => ((i.max(0) as u64).saturating_add(o.max(0) as u64), 1),
            _ => (0, 0),
        };
        let chunk = TokenChunk {
            provider: provider.clone(),
            thread_id,
            day: local_day.clone(),
            records: 1,
            partial_records: u64::from(partial),
            input_value: input.map_or(0, |v| v.max(0) as u64),
            input_known: u64::from(input.is_some()),
            output_value: output.map_or(0, |v| v.max(0) as u64),
            output_known: u64::from(output.is_some()),
            cached_value: cached.map_or(0, |v| v.max(0) as u64),
            cached_known: u64::from(cached.is_some()),
            cache_write_value: cache_write.map_or(0, |v| v.max(0) as u64),
            cache_write_known: u64::from(cache_write.is_some()),
            cache_write_5m_value: cache_write_5m.map_or(0, |v| v.max(0) as u64),
            cache_write_5m_known: u64::from(cache_write_5m.is_some()),
            cache_write_1h_value: cache_write_1h.map_or(0, |v| v.max(0) as u64),
            cache_write_1h_known: u64::from(cache_write_1h.is_some()),
            total_value: total_val,
            total_known,
        };
        totals.add_tokens(&chunk);
        by_provider
            .entry(provider.clone())
            .or_default()
            .add_tokens(&chunk);
        by_model
            .entry((provider, model))
            .or_default()
            .add_tokens(&chunk);
        if let Some(day) = local_day {
            by_day.entry(day).or_default().add_tokens(&chunk);
        }
        by_client
            .entry((source, client, sub_agent))
            .or_default()
            .add_tokens(&chunk);
        Ok(())
    };
    match at_bounds {
        Some((lo, Some(hi))) => {
            let mut rows = stmt.query([lo, hi])?;
            while let Some(row) = rows.next()? {
                handle_row(row)?;
            }
        }
        Some((lo, None)) => {
            let mut rows = stmt.query([lo])?;
            while let Some(row) = rows.next()? {
                handle_row(row)?;
            }
        }
        None => {
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                handle_row(row)?;
            }
        }
    }
    Ok(())
}

fn empty_usage_ready(tz_name: &str, include_daily: Option<bool>, quotas: Vec<Value>) -> Value {
    let empty_agg = Value::Object(AggBuilder::default().to_json_object());
    let daily_coverage = if include_daily == Some(false) {
        "not-requested"
    } else {
        "complete"
    };
    json!({
        "status": "ready",
        "activity": {
            "metadata": {
                "startedAt": now_iso(),
                "revision": 0,
                "generation": 0,
                "legacySeedCompleted": false,
            },
            "totals": empty_agg,
            "timeZone": tz_name,
            "providers": [],
            "models": [],
            "modelCount": 0,
            "modelsTruncated": false,
            "daily": [],
            "dailyCoverage": daily_coverage,
            "hourly": [],
            "clients": [],
        },
        "quotas": quotas,
        "persistence": "saved",
    })
}

/// Computes the exact SHA-256 exclusion digest used by Node's `UsageStore.clear`
/// (`exclusion()` in `src/main/agents/usageStore.ts`), using JS UTF-16 code unit lengths
/// (`part.encode_utf16().count()`) so non-ASCII thread/message IDs match identically across hosts.
pub fn usage_exclusion_hash(kind: &str, parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("sotto-usage-{kind}:").as_bytes());
    for part in parts {
        hasher.update(format!("{}:", part.encode_utf16().count()).as_bytes());
        hasher.update(part.as_bytes());
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

/// Clears `usage.sqlite` transactionally with exclusions, revision/generation bumps, and
/// durable synchronous flush matching `UsageStore.clear` (`src/main/agents/usageStore.ts`).
pub fn usage_clear(data_directory: &Path, expected_revision: i64) -> Result<Value, String> {
    let db_path = data_directory.join("usage.sqlite");
    let conn = open_sqlite(&db_path).map_err(|e| format!("Could not open usage.sqlite: {e}"))?;
    let _ = conn.execute_batch("PRAGMA synchronous = FULL;");
    let outcome = (|| -> Result<Value, String> {
        conn.execute_batch("BEGIN IMMEDIATE;")
            .map_err(|e| format!("Could not start usage clear transaction: {e}"))?;
        let tx_res = (|| -> Result<Value, String> {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS usage_meta (
                   singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                   started_at TEXT NOT NULL,
                   revision INTEGER NOT NULL,
                   generation INTEGER NOT NULL,
                   cleared_at TEXT,
                   seed_completed INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE TABLE IF NOT EXISTS exclusions (
                   identity_hash TEXT PRIMARY KEY NOT NULL
                 );",
            )
            .map_err(|e| format!("Could not ensure usage_meta schema: {e}"))?;

            let started_now = now_iso();
            conn.execute(
                "INSERT OR IGNORE INTO usage_meta (singleton, started_at, revision, generation, cleared_at, seed_completed)
                 VALUES (1, ?1, 0, 0, NULL, 0)",
                [started_now.as_str()],
            )
            .map_err(|e| format!("Could not initialize usage_meta: {e}"))?;

            let Some((current_rev, current_gen, current_cleared, current_meta_json)) =
                read_metadata_json(&conn)
            else {
                return Err("Usage metadata is unavailable.".into());
            };

            if current_rev != expected_revision {
                return Ok(json!({
                    "status": "stale",
                    "metadata": current_meta_json,
                }));
            }

            // Record exclusions for every cleared token row, group, and prompt so cleared records
            // cannot resurrect on replay or when switching back to Node `UsageStore`.
            let mut exclusions: Vec<String> = Vec::new();
            if table_exists(&conn, "token_rows") {
                if let Ok(mut stmt) =
                    conn.prepare("SELECT provider, thread_id, record_key, group_key FROM token_rows")
                {
                    if let Ok(mut rows) = stmt.query([]) {
                        while let Ok(Some(row)) = rows.next() {
                            if let (Ok(prov), Ok(tid), Ok(rk)) = (
                                row.get::<_, String>(0),
                                row.get::<_, String>(1),
                                row.get::<_, String>(2),
                            ) {
                                exclusions.push(usage_exclusion_hash("row", &[&prov, &tid, &rk]));
                                if let Ok(Some(gk)) = row.get::<_, Option<String>>(3) {
                                    exclusions
                                        .push(usage_exclusion_hash("group", &[&prov, &tid, &gk]));
                                }
                            }
                        }
                    }
                }
            }
            for table in ["prompt_rows", "pending_prompt_rows"] {
                if table_exists(&conn, table) {
                    let sql = format!("SELECT thread_id, message_id FROM {table}");
                    if let Ok(mut stmt) = conn.prepare(&sql) {
                        if let Ok(mut rows) = stmt.query([]) {
                            while let Ok(Some(row)) = rows.next() {
                                if let (Ok(tid), Ok(mid)) =
                                    (row.get::<_, String>(0), row.get::<_, String>(1))
                                {
                                    exclusions.push(usage_exclusion_hash("prompt", &[&tid, &mid]));
                                }
                            }
                        }
                    }
                }
            }
            if !exclusions.is_empty() {
                let mut insert_excl = conn
                    .prepare("INSERT OR IGNORE INTO exclusions (identity_hash) VALUES (?1)")
                    .map_err(|e| format!("Could not prepare exclusion write: {e}"))?;
                for hash in &exclusions {
                    insert_excl
                        .execute([hash.as_str()])
                        .map_err(|e| format!("Could not write usage exclusion: {e}"))?;
                }
            }

            // Delete `token_rows` first so Node's bucket triggers stay consistent, then clear the rest.
            for table in [
                "token_rows",
                "token_buckets",
                "grok_conflict_floors",
                "prompt_rows",
                "pending_prompt_rows",
            ] {
                if table_exists(&conn, table) {
                    let sql = format!("DELETE FROM {table}");
                    conn.execute(&sql, [])
                        .map_err(|e| format!("Could not clear {table}: {e}"))?;
                }
            }

            let now = now_iso();
            let next_cleared = match current_cleared {
                Some(prev) if prev > now => prev,
                _ => now,
            };
            let next_rev = current_rev.saturating_add(1);
            let next_gen = current_gen.saturating_add(1);
            conn.execute(
                "UPDATE usage_meta SET revision = ?1, generation = ?2, cleared_at = ?3 WHERE singleton = 1",
                rusqlite::params![next_rev, next_gen, next_cleared],
            )
            .map_err(|e| format!("Could not update usage_meta: {e}"))?;

            let Some((_, _, _, next_meta_json)) = read_metadata_json(&conn) else {
                return Err("Usage metadata is unavailable after clear.".into());
            };
            Ok(json!({
                "status": "cleared",
                "metadata": next_meta_json,
            }))
        })();

        match tx_res {
            Ok(val) => {
                conn.execute_batch("COMMIT;")
                    .map_err(|e| format!("Could not commit usage clear: {e}"))?;
                Ok(val)
            }
            Err(err) => {
                let _ = conn.execute_batch("ROLLBACK;");
                Err(err)
            }
        }
    })();
    let _ = conn.execute_batch("PRAGMA synchronous = NORMAL;");
    outcome
}

/// Applies peer capability filtering matching `usageReadBeforeHistory`, `usageReadBeforeMuse`,
/// and `usageReadBeforeAntigravity` in `src/shared/usageDashboard.ts`.
pub fn filter_usage_read_for_peer(
    mut read: Value,
    accepts_history: bool,
    accepts_muse_opencode: bool,
    accepts_antigravity: bool,
) -> Value {
    if !accepts_history {
        if let Some(activity) = read.get_mut("activity").and_then(Value::as_object_mut) {
            activity.remove("clients");
            if let Some(meta) = activity.get_mut("metadata").and_then(Value::as_object_mut) {
                meta.remove("history");
            }
            strip_last_day(activity.get_mut("totals"));
            for key in ["providers", "models", "daily"] {
                if let Some(arr) = activity.get_mut(key).and_then(Value::as_array_mut) {
                    for row in arr {
                        strip_last_day(Some(row));
                    }
                }
            }
        }
    }
    if !accepts_muse_opencode {
        filter_usage_providers(&mut read, USAGE_PROVIDERS_BEFORE_MUSE, false);
    }
    if !accepts_antigravity {
        filter_usage_providers(&mut read, USAGE_PROVIDERS_BEFORE_ANTIGRAVITY, true);
    }
    read
}

fn strip_last_day(val: Option<&mut Value>) {
    if let Some(obj) = val.and_then(Value::as_object_mut) {
        obj.remove("lastDay");
    }
}

fn filter_usage_providers(read: &mut Value, allowed: &[&str], drop_antigravity_client: bool) {
    if let Some(quotas) = read.get_mut("quotas").and_then(Value::as_array_mut) {
        quotas.retain(|q| {
            q.get("providerId")
                .and_then(Value::as_str)
                .is_some_and(|p| allowed.contains(&p))
        });
    }
    if let Some(activity) = read.get_mut("activity").and_then(Value::as_object_mut) {
        for key in ["providers", "models"] {
            if let Some(arr) = activity.get_mut(key).and_then(Value::as_array_mut) {
                arr.retain(|row| {
                    row.get("providerId")
                        .and_then(Value::as_str)
                        .is_some_and(|p| allowed.contains(&p))
                });
            }
        }
        if let Some(clients) = activity.get_mut("clients").and_then(Value::as_array_mut) {
            clients.retain_mut(|row| {
                if drop_antigravity_client
                    && row.get("clientId").and_then(Value::as_str) == Some("antigravity")
                {
                    return false;
                }
                if let Some(provs) = row.get_mut("providerIds").and_then(Value::as_array_mut) {
                    if provs.is_empty() {
                        return true;
                    }
                    provs.retain(|v| v.as_str().is_some_and(|p| allowed.contains(&p)));
                    !provs.is_empty()
                } else {
                    true
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_model_id_matches_node_rules() {
        assert_eq!(
            canonical_model_id("claude", "native:claude:model:claude-opus-4-6[1m]"),
            "claude-opus-4-6"
        );
        assert_eq!(
            canonical_model_id("claude", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
            "claude-sonnet-4-5"
        );
        assert_eq!(
            canonical_model_id("claude", "claude-3-5-sonnet@20241022"),
            "claude-3-5-sonnet"
        );
        assert_eq!(
            canonical_model_id("codex", "native:codex:model:gpt-5.2-2026-01-15"),
            "gpt-5.2"
        );
        assert_eq!(canonical_model_id("codex", ""), "unknown");
    }

    #[test]
    fn reads_real_usage_sqlite_rollups_and_clears_with_exclusions() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("usage.sqlite");
        let conn = open_sqlite(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE usage_meta (
               singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
               started_at TEXT NOT NULL,
               revision INTEGER NOT NULL,
               generation INTEGER NOT NULL,
               cleared_at TEXT,
               seed_completed INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE usage_history (
               singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
               status TEXT NOT NULL,
               earliest_at TEXT,
               scanned_at TEXT
             );
             CREATE TABLE token_rows (
               provider TEXT NOT NULL, thread_id TEXT NOT NULL, record_key TEXT NOT NULL,
               group_key TEXT, model_id TEXT NOT NULL, at TEXT, day TEXT,
               input INTEGER, output INTEGER, cached INTEGER,
               cache_write INTEGER, cache_write_5m INTEGER, cache_write_1h INTEGER,
               partial INTEGER NOT NULL DEFAULT 0,
               source TEXT NOT NULL DEFAULT 'sotto', client TEXT NOT NULL DEFAULT 'sotto',
               sub_agent INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY(provider, thread_id, record_key)
             );
             CREATE TABLE token_buckets (
               provider TEXT NOT NULL, thread_id TEXT NOT NULL, model_id TEXT NOT NULL,
               source TEXT NOT NULL, client TEXT NOT NULL, sub_agent INTEGER NOT NULL,
               bucket TEXT NOT NULL, records INTEGER NOT NULL, partial_records INTEGER NOT NULL,
               input_value INTEGER NOT NULL, input_known INTEGER NOT NULL,
               output_value INTEGER NOT NULL, output_known INTEGER NOT NULL,
               cached_value INTEGER NOT NULL, cached_known INTEGER NOT NULL,
               cache_write_value INTEGER NOT NULL, cache_write_known INTEGER NOT NULL,
               cache_write_5m_value INTEGER NOT NULL, cache_write_5m_known INTEGER NOT NULL,
               cache_write_1h_value INTEGER NOT NULL, cache_write_1h_known INTEGER NOT NULL,
               token_total_value INTEGER NOT NULL, token_total_known INTEGER NOT NULL,
               PRIMARY KEY(provider, thread_id, model_id, source, client, sub_agent, bucket)
             ) WITHOUT ROWID;
             CREATE TABLE prompt_rows (
               thread_id TEXT NOT NULL, message_id TEXT NOT NULL, provider TEXT NOT NULL,
               model_id TEXT NOT NULL, at TEXT NOT NULL, day TEXT NOT NULL,
               kind TEXT NOT NULL, input_kind TEXT NOT NULL,
               source TEXT NOT NULL DEFAULT 'sotto', client TEXT NOT NULL DEFAULT 'sotto',
               PRIMARY KEY(thread_id, message_id)
             );
             CREATE TABLE pending_prompt_rows (
               thread_id TEXT NOT NULL, message_id TEXT NOT NULL, provider TEXT NOT NULL,
               model_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, input_kind TEXT NOT NULL,
               PRIMARY KEY(thread_id, message_id)
             );
             CREATE TABLE exclusions (identity_hash TEXT PRIMARY KEY NOT NULL);
             INSERT INTO usage_meta VALUES (1, '2026-11-20T00:00:00.000Z', 3, 1, NULL, 1);
             INSERT INTO usage_history VALUES (1, 'complete', '2026-11-20T01:00:00.000Z', '2026-11-22T01:00:00.000Z');
             INSERT INTO token_rows VALUES (
               'claude', 't1', 'rk1', 'gk1', 'native:claude:model:claude-opus-4-6[1m]',
               '2026-11-21T02:05:00.000Z', '2026-11-21',
               1000, 250, 500, 100, 100, 0, 0, 'sotto', 'sotto', 0
             );
             INSERT INTO token_buckets VALUES (
               'claude', 't1', 'native:claude:model:claude-opus-4-6[1m]', 'sotto', 'sotto', 0,
               '2026-11-21T02:00', 1, 0,
               1000, 1, 250, 1, 500, 1, 100, 1, 100, 1, 0, 1, 1250, 1
             );
             INSERT INTO prompt_rows VALUES (
               't1', 'm1', 'claude', 'opus', '2026-11-21T02:04:00.000Z', '2026-11-21',
               'user', 'send', 'sotto', 'sotto'
             );",
        )
        .unwrap();
        drop(conn);

        // Query in America/Los_Angeles (UTC-8 in Nov): 2026-11-21T02:00Z -> 2026-11-20 18:00 (Friday = weekday 4).
        let read = usage_read(
            dir.path(),
            &UsageReadQuery {
                time_zone: Some("America/Los_Angeles".into()),
                ..Default::default()
            },
            &["claude".into()],
        );
        assert_eq!(read["status"], "ready");
        assert_eq!(read["activity"]["totals"]["tokens"]["input"]["value"], 1000);
        assert_eq!(read["activity"]["totals"]["tokens"]["output"]["value"], 250);
        assert_eq!(read["activity"]["totals"]["tokens"]["total"]["value"], 1250);
        assert_eq!(read["activity"]["totals"]["prompts"]["user"], 1);
        assert_eq!(read["activity"]["totals"]["prompts"]["total"], 1);
        assert_eq!(read["activity"]["totals"]["lastDay"], "2026-11-20");
        assert_eq!(read["activity"]["dailyCoverage"], "complete");
        assert_eq!(read["activity"]["daily"][0]["day"], "2026-11-20");
        // Prompt served model resolved from token_rows ('claude-opus-4-6', not alias 'opus').
        assert_eq!(read["activity"]["models"].as_array().unwrap().len(), 1);
        assert_eq!(read["activity"]["models"][0]["modelId"], "claude-opus-4-6");
        assert_eq!(read["activity"]["hourly"][0]["weekday"], 4);
        assert_eq!(read["activity"]["hourly"][0]["hour"], 18);
        assert_eq!(read["activity"]["clients"][0]["clientId"], "sotto");
        assert_eq!(read["activity"]["metadata"]["history"]["status"], "complete");
        // Connected claude quota reports unsupported; disconnected codex reports not-connected.
        let quotas = read["quotas"].as_array().unwrap();
        assert_eq!(
            quotas.iter().find(|q| q["providerId"] == "claude").unwrap()["reason"],
            "unsupported"
        );
        assert_eq!(
            quotas.iter().find(|q| q["providerId"] == "codex").unwrap()["reason"],
            "not-connected"
        );

        // Stale clear refused.
        let stale = usage_clear(dir.path(), 2).unwrap();
        assert_eq!(stale["status"], "stale");
        assert_eq!(stale["metadata"]["revision"], 3);

        // Matching clear empties rows, writes exclusions, bumps revision & generation.
        let cleared = usage_clear(dir.path(), 3).unwrap();
        assert_eq!(cleared["status"], "cleared");
        assert_eq!(cleared["metadata"]["revision"], 4);
        assert_eq!(cleared["metadata"]["generation"], 2);
        assert!(cleared["metadata"]["clearedAt"].is_string());

        let after_clear = usage_read(dir.path(), &UsageReadQuery::default(), &[]);
        assert_eq!(after_clear["activity"]["totals"]["tokenRecords"], 0);
        assert_eq!(after_clear["activity"]["totals"]["prompts"]["total"], 0);
        assert_eq!(after_clear["activity"]["metadata"]["revision"], 4);

        let verify_conn = open_sqlite(&db_path).unwrap();
        let excl_count: i64 = verify_conn
            .query_row("SELECT COUNT(*) FROM exclusions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(excl_count, 3); // row + group + prompt
    }

    #[test]
    fn corrupt_usage_sqlite_returns_error_instead_of_empty_ready() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("usage.sqlite"), b"not a valid sqlite database").unwrap();
        let res = usage_read(dir.path(), &UsageReadQuery::default(), &[]);
        assert_eq!(res["status"], "error");
        assert_eq!(res["persistence"], "failed");
        assert!(res.get("activity").is_none());
    }
}
