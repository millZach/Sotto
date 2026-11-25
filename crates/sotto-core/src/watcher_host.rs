//! Owning-host Watcher service (ADR-0073, ADR-0082).
//!
//! Handles `watcher-control` and `watcher-read` requests from authenticated paired desktop
//! Watchers, persists durable ownership/fences in `watcher-record.json` via
//! [`WatcherRecordStore`], runs a host-side check queue (`watcher-check-queue` /
//! `watcher-check-stop`), tracks turn outcomes (`watcher-outcomes`), and produces
//! `watcher-state` and `watcher-progress` projections (`watcher-reads` / `watcher-progress`).
//!
//! Never logs prompt text, transcripts, tokens, or provider protocol bodies.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::coordinator::{ClientContext, CoordinatorHandle};
use crate::desktop_clients::DesktopClients;
use crate::ops::{working_copy_options, WorkingCopyOptions};
use crate::watcher::{
    cut_to_bytes, validate_watcher_record, WatcherIdentity, WatcherOperation, WatcherParticipant,
    WatcherPromptTurn, WatcherRecord, WatcherRecordStore, WatcherRequest, WatcherReservation,
    WatcherStandingWatch, WatcherTakeover, WatcherThreadTarget, WatcherWatchOrigin,
    WATCHER_PROMPTS_PER_THREAD,
};
use crate::workspace::{now_iso, parse_public_provider_entity_id};

pub const WATCHER_PROMPT_BYTES_MAX: usize = 32 * 1_024;
pub const WATCHER_READ_BYTES_MAX: usize = 64 * 1_024;
pub const WATCHER_REPLY_BYTES_MAX: usize = 32 * 1_024;
pub const WATCHER_TITLE_MAX: usize = 512;
pub const WATCHER_ROSTER_MAX: usize = 100;
pub const WATCHER_MESSAGES_MAX: usize = 50;
pub const WATCHER_STANDING_WATCHES_MAX: usize = 100_000;
pub const WATCHER_PARTICIPATION_HISTORY_MAX: usize = 100;

const WATCHER_PROVIDERS: &[&str] = &[
    "codex",
    "claude",
    "grok",
    "muse",
    "cursor",
    "antigravity",
];

const RUNTIME_MODE_ORDER: &[&str] = &[
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
];

const PAGE_TTL: Duration = Duration::from_secs(60);
const PAGES_MAX: usize = 16;
const EVIDENCE_PER_THREAD_MAX: usize = 100;
const RUNNING_TURN_HOLD: &str = "This thread is already running a turn. Wait for its news, steer it, or queue a follow-up instead.";
const USER_TURN_RUNNING: &str = "The user’s own turn is running in this thread. Wait for it to finish, or steer it.";
const WATCH_PAUSED_HOLD: &str = "This watch is paused while the user’s turn is running. Wait for it to finish before sending.";

/// Deserializes a JSON field that may be omitted (`None`), `null` (`Some(None)`), or a value
/// (`Some(Some(T))`) so re-serialization preserves JS `JSON.stringify` key presence verbatim.
fn deserialize_some<'de, T, D>(deserializer: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

fn default_roster_limit() -> usize {
    WATCHER_ROSTER_MAX
}

fn default_messages_limit() -> usize {
    WATCHER_MESSAGES_MAX
}

fn default_true() -> bool {
    true
}

// ---------------------------------------------------------------------------
// Wire-order-preserving input types (matching `src/shared/watcher.ts` & `watcherHost.ts`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherProjectTarget {
    pub host_id: String,
    pub project_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherPosition {
    pub history_epoch: String,
    pub after_position: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum WatcherPermission {
    Runtime {
        mode: String,
    },
    Provider {
        #[serde(rename = "choiceId")]
        choice_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum WatcherWorkingCopy {
    Shared {},
    NewWorktree {},
    ExistingWorktree {
        #[serde(rename = "choiceId")]
        choice_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeMadeFrom {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    pub thread_id: String,
}

/// Exact field order matching `watcherToolSchemas.start_thread.input` in `src/shared/watcher.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartThreadInput {
    pub request_id: String,
    pub retry_key: String,
    pub project: WatcherProjectTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompts: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_some",
        skip_serializing_if = "Option::is_none"
    )]
    pub speed: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<WatcherPermission>,
    pub working_copy: WatcherWorkingCopy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_ref_choice_id: Option<String>,
    pub title: String,
    pub first_prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_thread: Option<WatcherThreadTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_run: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_move: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub made_from: Option<WorktreeMadeFrom>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_origin: Option<String>,
}

/// Exact field order matching `watcherToolSchemas.send_to_thread.input`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendToThreadInput {
    pub request_id: String,
    pub retry_key: String,
    pub target: WatcherThreadTarget,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_last_user_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub go_merge: Option<Value>,
}

/// Exact field order matching `watcherToolSchemas.stop_thread.input`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StopThreadInput {
    pub request_id: String,
    pub retry_key: String,
    pub target: WatcherThreadTarget,
}

/// Exact field order matching `watcherToolSchemas.settle_thread.input`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettleThreadInput {
    pub request_id: String,
    pub retry_key: String,
    pub target: WatcherThreadTarget,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "name", content = "input")]
pub enum WatcherControlCall {
    #[serde(rename = "start_thread")]
    StartThread(Box<StartThreadInput>),
    #[serde(rename = "send_to_thread")]
    SendToThread(SendToThreadInput),
    #[serde(rename = "stop_thread")]
    StopThread(StopThreadInput),
    #[serde(rename = "settle_thread")]
    SettleThread(SettleThreadInput),
}

impl WatcherControlCall {
    pub fn name(&self) -> &'static str {
        match self {
            Self::StartThread(_) => "start_thread",
            Self::SendToThread(_) => "send_to_thread",
            Self::StopThread(_) => "stop_thread",
            Self::SettleThread(_) => "settle_thread",
        }
    }

    pub fn action(&self) -> &'static str {
        match self {
            Self::StartThread(_) => "start",
            Self::SendToThread(_) => "send",
            Self::StopThread(_) => "stop",
            Self::SettleThread(_) => "settle",
        }
    }

    pub fn request_id(&self) -> &str {
        match self {
            Self::StartThread(i) => &i.request_id,
            Self::SendToThread(i) => &i.request_id,
            Self::StopThread(i) => &i.request_id,
            Self::SettleThread(i) => &i.request_id,
        }
    }

    pub fn retry_key(&self) -> &str {
        match self {
            Self::StartThread(i) => &i.retry_key,
            Self::SendToThread(i) => &i.retry_key,
            Self::StopThread(i) => &i.retry_key,
            Self::SettleThread(i) => &i.retry_key,
        }
    }

    pub fn target(&self) -> Option<&WatcherThreadTarget> {
        match self {
            Self::StartThread(_) => None,
            Self::SendToThread(i) => Some(&i.target),
            Self::StopThread(i) => Some(&i.target),
            Self::SettleThread(i) => Some(&i.target),
        }
    }

    /// Computes SHA-256 of `JSON.stringify([call.name, call.input])` with exact Zod field order.
    pub fn digest(&self) -> String {
        let serialized = match self {
            Self::StartThread(i) => serde_json::to_string(&("start_thread", i)),
            Self::SendToThread(i) => serde_json::to_string(&("send_to_thread", i)),
            Self::StopThread(i) => serde_json::to_string(&("stop_thread", i)),
            Self::SettleThread(i) => serde_json::to_string(&("settle_thread", i)),
        }
        .unwrap_or_default();
        sha256_str(&serialized)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherControlRequestHeader {
    pub id: String,
    pub watcher: WatcherThreadTarget,
    pub root_user_message_id: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub standing_watch_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherHostControl {
    pub master: WatcherIdentity,
    pub request: WatcherControlRequestHeader,
    pub ceiling: String,
    pub operation: WatcherOperation,
    pub call: WatcherControlCall,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListThreadsInput {
    #[serde(default)]
    pub host_id: Option<String>,
    #[serde(default)]
    pub project: Option<WatcherProjectTarget>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default = "default_true")]
    pub include_settled: bool,
    #[serde(default)]
    pub watched_only: Option<bool>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default = "default_roster_limit")]
    pub limit: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListProjectsInput {
    #[serde(default)]
    pub host_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub include_models: Option<bool>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default = "default_roster_limit")]
    pub limit: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListWorkingCopiesInput {
    pub project: WatcherProjectTarget,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default = "default_roster_limit")]
    pub limit: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadThreadInput {
    pub target: WatcherThreadTarget,
    #[serde(default)]
    pub position: Option<WatcherPosition>,
    #[serde(default = "default_messages_limit")]
    pub limit: usize,
    #[serde(default)]
    pub include_activities: bool,
    #[serde(default)]
    pub require_fresh: Option<bool>,
    #[serde(default)]
    pub evidence: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadOperationInput {
    pub operation_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "name", content = "input")]
pub enum WatcherReadCall {
    #[serde(rename = "list_threads")]
    ListThreads(ListThreadsInput),
    #[serde(rename = "list_projects")]
    ListProjects(ListProjectsInput),
    #[serde(rename = "list_working_copies")]
    ListWorkingCopies(ListWorkingCopiesInput),
    #[serde(rename = "read_thread")]
    ReadThread(ReadThreadInput),
    #[serde(rename = "read_operation")]
    ReadOperation(ReadOperationInput),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoppedRequestHeader {
    pub id: String,
    pub watcher: WatcherThreadTarget,
    pub root_user_message_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoppedRequestEntry {
    pub request: StoppedRequestHeader,
    pub ceiling: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherHostRead {
    pub master: WatcherIdentity,
    #[serde(default)]
    pub standing_watches: Option<Vec<WatcherStandingWatch>>,
    #[serde(default)]
    pub stopped_requests: Option<Vec<StoppedRequestEntry>>,
    #[serde(default)]
    pub call: Option<WatcherReadCall>,
    #[serde(default)]
    pub outcomes: Option<bool>,
    #[serde(default)]
    pub adopt: Option<bool>,
}

// ---------------------------------------------------------------------------
// Projection & progress push types (`src/shared/watcherHost.ts`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherProgressEntry {
    pub target: WatcherThreadTarget,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherHostProjection {
    pub host_id: String,
    pub master: WatcherIdentity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub standing_watches: Option<Vec<WatcherStandingWatch>>,
    pub revision: String,
    pub observed_at: String,
    pub requests: Vec<WatcherRequest>,
    pub operations: Vec<WatcherOperation>,
    pub evidence: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<Vec<WatcherProgressEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherProgressChange {
    pub changed: Vec<WatcherProgressEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<Vec<WatcherThreadTarget>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whole: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherHostProgress {
    pub base_revision: String,
    pub revision: String,
    pub observed_at: String,
    pub changed: Vec<WatcherProgressEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<Vec<WatcherThreadTarget>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whole: Option<bool>,
}

// ---------------------------------------------------------------------------
// Shared pure helpers
// ---------------------------------------------------------------------------

pub fn sha256_str(s: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    let out = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in out {
        hex.push_str(&format!("{b:02x}"));
    }
    hex
}

fn json_digest<T: Serialize>(value: &T) -> String {
    let text = serde_json::to_string(value).unwrap_or_default();
    sha256_str(&text)
}

fn progress_key(target: &WatcherThreadTarget) -> String {
    format!("{}\u{0000}{}", target.host_id, target.thread_id)
}

fn progress_with(
    held: &[WatcherProgressEntry],
    change: &WatcherProgressChange,
) -> Vec<WatcherProgressEntry> {
    if change.whole == Some(true) {
        return change.changed.clone();
    }
    let gone: HashSet<String> = change
        .removed
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(progress_key)
        .collect();
    let changed_map: HashMap<String, &WatcherProgressEntry> = change
        .changed
        .iter()
        .map(|entry| (progress_key(&entry.target), entry))
        .collect();
    let mut result = Vec::with_capacity(held.len() + change.changed.len());
    let mut placed = HashSet::new();
    for entry in held {
        let key = progress_key(&entry.target);
        if gone.contains(&key) {
            continue;
        }
        if let Some(next) = changed_map.get(&key) {
            result.push((*next).clone());
            placed.insert(key);
        } else {
            result.push(entry.clone());
        }
    }
    for entry in &change.changed {
        let key = progress_key(&entry.target);
        if !placed.contains(&key) {
            result.push(entry.clone());
        }
    }
    result
}

/// Computes a minimal `watcher-progress` delta matching `watcherProgressChange` in `src/shared/watcherHost.ts`.
pub fn watcher_progress_change(
    held: &[WatcherProgressEntry],
    next: &[WatcherProgressEntry],
) -> WatcherProgressChange {
    let was: HashMap<String, &str> = held
        .iter()
        .map(|e| (progress_key(&e.target), e.fingerprint.as_str()))
        .collect();
    let now_set: HashSet<String> = next.iter().map(|e| progress_key(&e.target)).collect();
    let removed: Vec<WatcherThreadTarget> = held
        .iter()
        .filter(|e| !now_set.contains(&progress_key(&e.target)))
        .map(|e| e.target.clone())
        .collect();
    let changed: Vec<WatcherProgressEntry> = next
        .iter()
        .filter(|e| was.get(&progress_key(&e.target)).copied() != Some(e.fingerprint.as_str()))
        .cloned()
        .collect();
    let candidate = WatcherProgressChange {
        changed,
        removed: (!removed.is_empty()).then_some(removed),
        whole: None,
    };
    let rebuilt = progress_with(held, &candidate);
    let same = rebuilt.len() == next.len()
        && rebuilt
            .iter()
            .zip(next.iter())
            .all(|(a, b)| a.target == b.target && a.fingerprint == b.fingerprint);
    if same {
        candidate
    } else {
        WatcherProgressChange {
            changed: next.to_vec(),
            removed: None,
            whole: Some(true),
        }
    }
}

/// Digest of everything in a projection EXCEPT `progress`, `revision`, and `observedAt`,
/// matching `watcherRecordOf` in `src/host/socketServer.ts`.
pub fn watcher_record_digest(projection: &WatcherHostProjection) -> String {
    json_digest(&(
        &projection.host_id,
        &projection.master,
        &projection.standing_watches,
        &projection.requests,
        &projection.operations,
        &projection.evidence,
    ))
}

/// Host protocol v1 compatibility shim matching `watcherResultForHostV1` in `src/shared/watcher.ts`:
/// adds `{ inFlight: 0, inFlightLimit: 8 }` into `limits` and strips `warning`.
pub fn watcher_result_for_host_v1(mut value: Value) -> Value {
    let Some(obj) = value.as_object_mut() else {
        return value;
    };
    obj.remove("warning");
    if let Some(limits) = obj.get_mut("limits").and_then(Value::as_object_mut) {
        limits.insert("inFlight".into(), Value::Number(0.into()));
        limits.insert("inFlightLimit".into(), Value::Number(8.into()));
    }
    value
}

/// Opaque progress fingerprint over a thread's state (no prose leaves the host),
/// matching `watcherProgressFingerprint` in `src/main/agents/watcherWakeUp.ts`.
pub fn watcher_progress_fingerprint(thread: &Value) -> String {
    let status = thread.get("status").cloned().unwrap_or(Value::Null);
    let last_turn = thread.get("lastTurn").cloned().unwrap_or(Value::Null);
    let messages: Vec<Value> = thread
        .get("messages")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|m| {
                    let id = m.get("id").and_then(Value::as_str).unwrap_or("");
                    let len = m
                        .get("text")
                        .and_then(Value::as_str)
                        .map(|t| t.encode_utf16().count())
                        .unwrap_or(0);
                    json!([id, len])
                })
                .collect()
        })
        .unwrap_or_default();
    let activities: Value = match thread.get("activities").and_then(Value::as_array) {
        Some(arr) => Value::Array(
            arr.iter()
                .map(|a| {
                    let id = a.get("id").cloned().unwrap_or(Value::Null);
                    let st = a.get("status").cloned().unwrap_or(Value::Null);
                    let started = a.get("startedAt").cloned().unwrap_or(Value::Null);
                    let completed = a.get("completedAt").cloned().unwrap_or(Value::Null);
                    let text_len = a
                        .get("text")
                        .and_then(Value::as_str)
                        .map(|s| s.encode_utf16().count())
                        .unwrap_or(0);
                    let output_len = a
                        .get("output")
                        .and_then(Value::as_str)
                        .map(|s| s.encode_utf16().count())
                        .unwrap_or(0);
                    json!([id, st, started, completed, text_len, output_len])
                })
                .collect(),
        ),
        None => Value::Null,
    };
    let subagent_summary = thread.get("subagentSummary").cloned().unwrap_or(Value::Null);
    let bg: Value = thread
        .get("backgroundWork")
        .and_then(Value::as_array)
        .map(|arr| {
            Value::Array(
                arr.iter()
                    .map(|w| json!([w.get("id"), w.get("type")]))
                    .collect(),
            )
        })
        .unwrap_or(Value::Null);
    let mon: Value = thread
        .get("monitoring")
        .and_then(Value::as_array)
        .map(|arr| Value::Array(arr.iter().map(|w| w.get("id").cloned().unwrap_or(Value::Null)).collect()))
        .unwrap_or(Value::Null);
    let reqs: Vec<Value> = thread
        .get("requests")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|r| json!([r.get("id"), r.get("kind")]))
                .collect()
        })
        .unwrap_or_default();
    let summary_count = thread
        .get("summary")
        .and_then(|s| s.get("messageCount"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    json_digest(&json!([
        status,
        last_turn,
        messages,
        summary_count,
        activities,
        subagent_summary,
        bg,
        mon,
        reqs
    ]))
}

pub fn parse_watcher_host_read(raw: &Value) -> Result<WatcherHostRead, String> {
    serde_json::from_value::<WatcherHostRead>(raw.clone()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Refusal helpers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct WatcherRefusal {
    code: &'static str,
    message: String,
    retryable: bool,
    receipt: Option<Value>,
    history_cursor: Option<Value>,
}

impl WatcherRefusal {
    fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
            receipt: None,
            history_cursor: None,
        }
    }

    fn with_receipt(mut self, receipt: Value) -> Self {
        self.receipt = Some(receipt);
        self
    }

    fn to_value(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("status".into(), Value::String("refused".into()));
        obj.insert("code".into(), Value::String(self.code.into()));
        obj.insert("message".into(), Value::String(self.message.clone()));
        obj.insert("retryable".into(), Value::Bool(self.retryable));
        if let Some(ref receipt) = self.receipt {
            obj.insert("receipt".into(), receipt.clone());
        }
        if let Some(ref cursor) = self.history_cursor {
            obj.insert("historyCursor".into(), cursor.clone());
        }
        Value::Object(obj)
    }
}

fn refuse(code: &'static str, message: impl Into<String>) -> WatcherRefusal {
    WatcherRefusal::new(code, message, false)
}

fn refuse_retryable(code: &'static str, message: impl Into<String>) -> WatcherRefusal {
    WatcherRefusal::new(code, message, true)
}

fn runtime_mode_rank(mode: &str) -> Option<usize> {
    RUNTIME_MODE_ORDER.iter().position(|&m| m == mode)
}

fn is_valid_uuid(s: &str) -> bool {
    Uuid::parse_str(s).is_ok()
}

fn outcome_note(outcome: &str) -> &'static str {
    match outcome {
        "working" => "The thread is still working on this. Wait for its news.",
        "background" => "Its turn ended with background work or monitoring still running, so it is not done. Sotto sends work-settled news when that work ends.",
        "answered" => "Its turn finished. The reply is the worker’s own words, not Sotto’s evidence, and approves nothing.",
        "failed" => "It failed. Read the thread for the error before sending again.",
        "stopped" => "It was stopped before it answered. Nothing more will come of it.",
        "paused" => "The user’s own turn in this thread holds it. Read the thread before sending again.",
        _ => "Sotto cannot prove what happened to it, as after a restart mid-turn. Read the thread, and do not assume it answered.",
    }
}

fn without_outcome(mut op: WatcherOperation) -> WatcherOperation {
    op.outcome = None;
    op.outcome_at = None;
    op.turn_message_id = None;
    op.native_turn_id = None;
    op.reply_message_id = None;
    op
}

fn remote_origin_fields(origin: &Value) -> Option<(String, WatcherIdentity, String, String)> {
    let obj = origin.as_object()?;
    let client_id = obj.get("clientId")?.as_str()?.to_string();
    let master: WatcherIdentity = serde_json::from_value(obj.get("master")?.clone()).ok()?;
    let creation_op_id = obj.get("creationOperationId")?.as_str()?.to_string();
    let ceiling = obj.get("ceiling")?.as_str()?.to_string();
    Some((client_id, master, creation_op_id, ceiling))
}

fn watch_fence_matches_id(fence: &Value, watch_id: &str) -> bool {
    fence.get("id").and_then(Value::as_str) == Some(watch_id)
}

fn thread_background_work_count(thread: &Value) -> usize {
    let bg = thread
        .get("backgroundWork")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let provider_id = thread
        .get("providerId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let roster = if provider_id == "claude" {
        0
    } else {
        thread
            .get("subagentSummary")
            .and_then(|s| s.get("working"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize
    };
    let monitoring = thread
        .get("monitoring")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    bg.max(roster) + monitoring
}

fn is_thread_turn_running(thread: &Value) -> bool {
    thread.get("status").and_then(Value::as_str) == Some("running")
        || thread
            .get("lastTurn")
            .and_then(|t| t.get("status"))
            .and_then(Value::as_str)
            == Some("running")
}

fn is_thread_settled(thread: &Value, project: Option<&Value>) -> bool {
    let has_ts = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty())
    };
    has_ts(thread.get("workspaceSettledAt"))
        || has_ts(thread.get("settledAt"))
        || project.is_some_and(|p| has_ts(p.get("workspaceSettledAt")))
}

fn is_thread_connected(shell: &Value, thread: &Value) -> bool {
    if thread.get("clientConnected") == Some(&Value::Bool(false)) {
        return false;
    }
    let provider_id = thread
        .get("providerId")
        .and_then(Value::as_str)
        .unwrap_or("");
    shell
        .get("host")
        .and_then(|h| h.get("providers"))
        .and_then(Value::as_array)
        .is_some_and(|providers| {
            providers.iter().any(|p| {
                p.get("id").and_then(Value::as_str) == Some(provider_id)
                    && p.get("connection").and_then(Value::as_str) == Some("connected")
            })
        })
}

fn native_head(thread: &Value) -> Option<String> {
    if let Some(id) = thread.get("lastUserMessageId").and_then(Value::as_str) {
        if !id.is_empty() {
            return Some(id.to_string());
        }
    }
    if let Some(arr) = thread.get("messages").and_then(Value::as_array) {
        for msg in arr.iter().rev() {
            if msg.get("role").and_then(Value::as_str) == Some("user") {
                if let Some(id) = msg.get("id").and_then(Value::as_str) {
                    return Some(id.to_string());
                }
            }
        }
    }
    thread
        .get("summary")
        .and_then(|s| s.get("lastUser"))
        .and_then(|u| u.get("id"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn thread_supports_steer(shell: &Value, thread: &Value) -> bool {
    let provider_id = thread
        .get("providerId")
        .and_then(Value::as_str)
        .unwrap_or("");
    shell
        .get("host")
        .and_then(|h| h.get("providers"))
        .and_then(Value::as_array)
        .and_then(|providers| {
            providers
                .iter()
                .find(|p| p.get("id").and_then(Value::as_str) == Some(provider_id))
        })
        .and_then(|p| p.get("capabilities"))
        .and_then(|c| c.get("steer"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn classify_thread_group(
    thread: &Value,
    project: Option<&Value>,
    connected: bool,
    last_progress_ms: Option<i64>,
    connected_at_ms: Option<i64>,
    now_ms: i64,
) -> &'static str {
    let settled = is_thread_settled(thread, project);
    if thread
        .get("archivedAt")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
    {
        return "Idle";
    }
    let has_requests = thread
        .get("requests")
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty());
    let status = thread.get("status").and_then(Value::as_str).unwrap_or("idle");
    let turn_failed = thread
        .get("lastTurn")
        .and_then(|t| t.get("status"))
        .and_then(Value::as_str)
        == Some("failed");
    if has_requests || (!settled && (status == "error" || turn_failed)) {
        return "Needs you";
    }
    if settled {
        return "Idle";
    }
    let open_pr = thread
        .get("pullRequests")
        .and_then(Value::as_array)
        .is_some_and(|prs| {
            prs.iter()
                .any(|p| p.get("state").and_then(Value::as_str) == Some("open"))
        })
        || thread
            .get("worktree")
            .and_then(|w| w.get("git"))
            .and_then(|g| g.get("pullRequest"))
            .and_then(|p| p.get("state"))
            .and_then(Value::as_str)
            == Some("open");
    if open_pr {
        return "Ready for review";
    }
    let active = is_thread_turn_running(thread) || thread_background_work_count(thread) > 0;
    if active {
        let quiet_since = last_progress_ms
            .into_iter()
            .chain(connected_at_ms)
            .max();
        if connected && quiet_since.is_some_and(|t| now_ms - t >= 20 * 60 * 1_000) {
            return "Quiet";
        }
        return "Working";
    }
    "Idle"
}

// ---------------------------------------------------------------------------
// Internal runtime state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct ThreadObservation {
    observed_at: String,
    last_progress_at: String,
    last_progress_ms: i64,
    connected_at_ms: i64,
    last_fingerprint: String,
    last_turn_id: Option<String>,
    last_turn_status: Option<String>,
}

#[derive(Debug, Clone)]
struct WorkingCopySnapshot {
    revision: String,
    base_refs: Vec<Value>,
}

#[derive(Debug, Clone)]
struct CachedPage {
    kind: String,
    rows: Vec<Value>,
    expires: Instant,
    working_copies: Option<WorkingCopySnapshot>,
}

#[derive(Debug, Clone)]
struct CopyChoiceEntry {
    project_id: String,
    revision: String,
    snapshot_id: String,
    path: Option<String>,
    branch: Option<String>,
}

#[derive(Debug, Clone)]
struct QueuedCheck {
    operation_id: String,
    target: WatcherThreadTarget,
    waiting: Option<WaitingCheckPayload>,
}

#[derive(Debug, Clone)]
pub struct WaitingCheckPayload {
    input: StartThreadInput,
    client: ClientContext,
    may_answer: bool,
}

#[derive(Default)]
struct WatcherHostRuntime {
    last_shell: Option<Value>,
    evidence: HashMap<String, Vec<Value>>,
    observations: HashMap<String, ThreadObservation>,
    pages: HashMap<String, CachedPage>,
    copy_choices: HashMap<String, CopyChoiceEntry>,
    check_queue: VecDeque<QueuedCheck>,
    adopted: HashSet<String>,
    remote_answers: HashMap<String, bool>,
}

impl WatcherHostRuntime {
    fn prune_pages(&mut self) {
        let now = Instant::now();
        self.pages.retain(|_, p| p.expires > now);
        while self.pages.len() > PAGES_MAX {
            if let Some(oldest_key) = self
                .pages
                .iter()
                .min_by_key(|(_, p)| p.expires)
                .map(|(k, _)| k.clone())
            {
                self.pages.remove(&oldest_key);
            } else {
                break;
            }
        }
        let valid_snaps: HashSet<&String> = self.pages.keys().collect();
        self.copy_choices
            .retain(|_, c| valid_snaps.contains(&c.snapshot_id));
    }

    fn record_evidence(&mut self, target_key: &str, item: Value) {
        let list = self.evidence.entry(target_key.to_string()).or_default();
        let item_id = item.get("id").and_then(Value::as_str);
        if let Some(id) = item_id {
            if let Some(existing) = list
                .iter_mut()
                .find(|e| e.get("id").and_then(Value::as_str) == Some(id))
            {
                *existing = item;
                return;
            }
        }
        list.push(item);
        if list.len() > EVIDENCE_PER_THREAD_MAX {
            let excess = list.len() - EVIDENCE_PER_THREAD_MAX;
            list.drain(0..excess);
        }
    }

    fn read_evidence(&self, target_key: &str, connected: bool) -> Vec<Value> {
        let Some(items) = self.evidence.get(target_key) else {
            return Vec::new();
        };
        items
            .iter()
            .map(|item| {
                let mut cloned = item.clone();
                if !connected {
                    if let Some(obj) = cloned.as_object_mut() {
                        obj.insert("freshness".into(), Value::String("stale".into()));
                    }
                }
                cloned
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// WatcherHostService
// ---------------------------------------------------------------------------

pub struct WatcherHostService {
    host_id: String,
    coordinator: CoordinatorHandle,
    desktops: Option<Arc<Mutex<DesktopClients>>>,
    record_store: Mutex<WatcherRecordStore>,
    runtime: Mutex<WatcherHostRuntime>,
    tx_lock: tokio::sync::Mutex<()>,
    notify_tx: broadcast::Sender<()>,
}

impl WatcherHostService {
    pub fn open(
        data_directory: PathBuf,
        host_id: String,
        coordinator: CoordinatorHandle,
    ) -> Result<Self, String> {
        let mut store = WatcherRecordStore::new(data_directory);
        store.load()?;
        let (notify_tx, _) = broadcast::channel(128);
        Ok(Self {
            host_id,
            coordinator,
            desktops: None,
            record_store: Mutex::new(store),
            runtime: Mutex::new(WatcherHostRuntime::default()),
            tx_lock: tokio::sync::Mutex::new(()),
            notify_tx,
        })
    }

    /// Attaches the shared SSH-recorded desktop client & identity store (`desktop-clients.json`
    /// and `desktop-identities.json`) for safe re-pair ownership migration (#2863).
    pub fn with_desktops(mut self, desktops: Arc<Mutex<DesktopClients>>) -> Self {
        self.desktops = Some(desktops);
        self
    }

    pub fn host_id(&self) -> &str {
        &self.host_id
    }

    pub fn subscribe(&self) -> broadcast::Receiver<()> {
        self.notify_tx.subscribe()
    }

    pub fn record_snapshot(&self) -> WatcherRecord {
        self.record_store.lock().unwrap().view().clone()
    }

    fn notify(&self) {
        let _ = self.notify_tx.send(());
    }

    async fn refresh_shell(&self, may_answer: bool) -> Result<Value, WatcherRefusal> {
        let shell = self
            .coordinator
            .shell(may_answer)
            .await
            .map_err(|_| refuse_retryable("HOST_DISCONNECTED", "Host coordinator is unavailable."))?;
        self.runtime.lock().unwrap().last_shell = Some(shell.clone());
        Ok(shell)
    }

    fn update_record<F, R>(&self, mutate: F) -> Result<R, WatcherRefusal>
    where
        F: FnOnce(&mut WatcherRecord) -> Result<R, WatcherRefusal>,
    {
        let mut store = self.record_store.lock().unwrap();
        let mut next = store.view().clone();
        let out = mutate(&mut next)?;
        validate_watcher_record(&next)
            .map_err(|e| refuse("INVALID_INPUT", format!("Watcher record invariant failed: {e}")))?;
        store
            .update(|rec| {
                *rec = next;
                Ok(())
            })
            .map_err(|_| refuse("STATE_FULL", "Could not persist Watcher record."))?;
        Ok(out)
    }

    // -----------------------------------------------------------------------
    // Observation & outcome tracking (called on every coordinator shell push)
    // -----------------------------------------------------------------------

    /// Observes a coordinator shell snapshot, advancing standing watches, native user takeovers,
    /// operation outcomes, native-turn evidence, reservations, and queued checks.
    pub fn observe_shell(&self, shell: &Value) -> Vec<(String, WaitingCheckPayload)> {
        let now_str = now_iso();
        let now_ms = chrono::Utc::now().timestamp_millis();
        let threads = shell
            .get("host")
            .and_then(|h| h.get("threads"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let projects = shell
            .get("host")
            .and_then(|h| h.get("projects"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let deliveries = shell
            .get("deliveries")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let threads_by_id: HashMap<&str, &Value> = threads
            .iter()
            .filter_map(|t| t.get("id").and_then(Value::as_str).map(|id| (id, t)))
            .collect();

        let mut something_changed = false;
        let mut newly_evidenced: Vec<(String, Value)> = Vec::new();
        {
            let mut rt = self.runtime.lock().unwrap();
            rt.last_shell = Some(shell.clone());
            for thread in &threads {
                let Some(tid) = thread.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let target = WatcherThreadTarget::new(&self.host_id, tid);
                let tkey = target.key();
                let fp = watcher_progress_fingerprint(thread);
                let connected = is_thread_connected(shell, thread);
                let turn_id = thread
                    .get("lastTurn")
                    .and_then(|t| t.get("id"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
                let turn_status = thread
                    .get("lastTurn")
                    .and_then(|t| t.get("status"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string);

                let prev = rt.observations.get(&tkey).cloned();
                let progressed = prev.as_ref().is_none_or(|p| p.last_fingerprint != fp);
                if progressed {
                    something_changed = true;
                }
                let last_progress_at = if progressed {
                    now_str.clone()
                } else {
                    prev.as_ref()
                        .map(|p| p.last_progress_at.clone())
                        .unwrap_or_else(|| now_str.clone())
                };
                let last_progress_ms = if progressed {
                    now_ms
                } else {
                    prev.as_ref().map(|p| p.last_progress_ms).unwrap_or(now_ms)
                };
                let connected_at_ms = prev.as_ref().map(|p| p.connected_at_ms).unwrap_or(now_ms);

                // Emit native-turn evidence when a turn finishes or fails.
                if let (Some(ref tid_turn), Some(ref st)) = (&turn_id, &turn_status) {
                    let prev_done = prev.as_ref().is_some_and(|p| {
                        p.last_turn_id.as_deref() == Some(tid_turn.as_str())
                            && p.last_turn_status.as_deref() == Some(st.as_str())
                    });
                    if !prev_done && (st == "completed" || st == "failed") {
                        let fact = if st == "failed" {
                            "turn-failed"
                        } else {
                            "turn-finished"
                        };
                        let ev_id = json_digest(&("native-turn", &target, tid_turn, fact));
                        let mut ev = json!({
                            "id": ev_id,
                            "source": "native-turn",
                            "observedAt": now_str,
                            "target": target,
                            "freshness": if connected { "fresh" } else { "stale" },
                            "availability": if connected { "available" } else { "unavailable" },
                            "turnId": tid_turn,
                            "fact": fact,
                        });
                        if st == "failed" {
                            if let Some(obj) = ev.as_object_mut() {
                                obj.insert(
                                    "failureCategory".into(),
                                    Value::String("provider-turn-failed".into()),
                                );
                            }
                        }
                        newly_evidenced.push((tkey.clone(), ev));
                        something_changed = true;
                    }
                }

                rt.observations.insert(
                    tkey,
                    ThreadObservation {
                        observed_at: now_str.clone(),
                        last_progress_at,
                        last_progress_ms,
                        connected_at_ms,
                        last_fingerprint: fp,
                        last_turn_id: turn_id,
                        last_turn_status: turn_status,
                    },
                );
            }
            for (tkey, ev) in newly_evidenced {
                rt.record_evidence(&tkey, ev);
            }
        }

        // Reconcile durable WatcherRecord against live shell state.
        let record_changed = {
            let mut store = self.record_store.lock().unwrap();
            let current = store.view().clone();
            let mut next = current.clone();
            let mut dirty = false;

            // 1. Update delivery states from coordinator deliveries.
            for op in &mut next.operations {
                if op.target.host_id != self.host_id {
                    continue;
                }
                if let Some(ref draft_id) = op.draft_id {
                    if let Some(del) = deliveries.iter().rev().find(|d| {
                        d.get("threadId").and_then(Value::as_str) == Some(op.target.thread_id.as_str())
                            && d.get("draftId").and_then(Value::as_str) == Some(draft_id.as_str())
                    }) {
                        let status = del.get("status").and_then(Value::as_str).unwrap_or("");
                        if status == "accepted" && op.delivery_state != "accepted" {
                            op.delivery_state = "accepted".into();
                            op.refusal_code = None;
                            op.updated_at = now_str.clone();
                            dirty = true;
                        } else if status == "failed" && op.delivery_state != "accepted" && op.delivery_state != "failed" {
                            op.delivery_state = "failed".into();
                            op.refusal_code = Some("PROVIDER_UNAVAILABLE".into());
                            op.updated_at = now_str.clone();
                            dirty = true;
                        }
                    }
                }
            }

            // Build lookup of Watcher's own sent message IDs per thread.
            let watcher_msgs: HashSet<(String, String)> = next
                .operations
                .iter()
                .filter_map(|op| {
                    op.message_id
                        .as_ref()
                        .map(|mid| (op.target.thread_id.clone(), mid.clone()))
                })
                .collect();

            // 2. Track standing watch heads / pauses and native user takeovers.
            let mut watched_threads: HashSet<String> = HashSet::new();
            if let Some(ref mut watches) = next.watches {
                for watch in watches.iter_mut() {
                    if watch.target.host_id != self.host_id {
                        continue;
                    }
                    watched_threads.insert(watch.target.thread_id.clone());
                    let Some(thread) = threads_by_id.get(watch.target.thread_id.as_str()) else {
                        continue;
                    };
                    let head = native_head(thread);
                    let is_machine = head.as_ref().is_some_and(|h| {
                        watcher_msgs.contains(&(watch.target.thread_id.clone(), h.clone()))
                    });
                    let running = is_thread_turn_running(thread);
                    let prev_head = watch.last_user_message_id.clone().flatten();
                    if head != prev_head {
                        watch.last_user_message_id = Some(head.clone());
                        if head.is_some() && !is_machine {
                            watch.generation = watch.generation.saturating_add(1);
                            watch.parked = None;
                            if running {
                                watch.paused_by_user_message_id = Some(head.clone());
                            } else {
                                watch.paused_by_user_message_id = Some(None);
                            }
                        }
                        dirty = true;
                    } else if !running
                        && watch
                            .paused_by_user_message_id
                            .as_ref()
                            .and_then(|o| o.as_ref())
                            .is_some()
                    {
                        watch.paused_by_user_message_id = Some(None);
                        dirty = true;
                    } else if running
                        && head.is_some()
                        && !is_machine
                        && watch.paused_by_user_message_id.as_ref().and_then(|o| o.as_ref())
                            != head.as_ref()
                    {
                        watch.paused_by_user_message_id = Some(head.clone());
                        dirty = true;
                    }
                }
            }

            // 3. Detect takeovers on non-standing-watch threads when user sends natively.
            for req in &mut next.requests {
                if req.state != "active" {
                    continue;
                }
                for part in &mut req.participants {
                    if part.target.host_id != self.host_id || part.state != "participating" {
                        continue;
                    }
                    let Some(thread) = threads_by_id.get(part.target.thread_id.as_str()) else {
                        continue;
                    };
                    let head = native_head(thread);
                    let prev_head = part.last_user_message_id.clone().flatten();
                    let is_machine = head.as_ref().is_some_and(|h| {
                        watcher_msgs.contains(&(part.target.thread_id.clone(), h.clone()))
                    });
                    if head.is_some() && head != prev_head && !is_machine {
                        part.last_user_message_id = Some(head.clone());
                        if !watched_threads.contains(&part.target.thread_id) {
                            part.state = "taken-over".into();
                            part.generation = part.generation.saturating_add(1);
                            part.takeover = Some(WatcherTakeover {
                                reason: "native-user-send".into(),
                                at: now_str.clone(),
                            });
                        } else if let Some(w) = next
                            .watches
                            .as_deref()
                            .unwrap_or(&[])
                            .iter()
                            .find(|w| w.target == part.target)
                        {
                            if w.generation > part.generation {
                                part.generation = w.generation;
                            }
                        }
                        dirty = true;
                    }
                }
            }

            // 4. Compute outcomes for accepted start/send operations (`watcher-outcomes`).
            let final_outcomes = ["answered", "failed", "stopped", "paused", "unknown"];
            for op in &mut next.operations {
                if op.target.host_id != self.host_id
                    || (op.action != "start" && op.action != "send")
                    || op.delivery_state != "accepted"
                {
                    continue;
                }
                if op
                    .outcome
                    .as_deref()
                    .is_some_and(|o| final_outcomes.contains(&o))
                {
                    continue;
                }
                let Some(thread) = threads_by_id.get(op.target.thread_id.as_str()) else {
                    continue;
                };
                let Some(ref op_msg_id) = op.message_id else {
                    continue;
                };
                let last_turn = thread.get("lastTurn");
                let last_turn_status = last_turn
                    .and_then(|t| t.get("status"))
                    .and_then(Value::as_str);
                let last_turn_id = last_turn
                    .and_then(|t| t.get("id"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
                let last_turn_msg = last_turn
                    .and_then(|t| t.get("messageId"))
                    .and_then(Value::as_str);

                let matches_turn = last_turn_msg == Some(op_msg_id.as_str())
                    || (op.delivery.as_deref() == Some("steer") && last_turn.is_some());
                if !matches_turn {
                    continue;
                }

                let bg_count = thread_background_work_count(thread);
                let new_outcome = match last_turn_status {
                    Some("running") => Some("working"),
                    Some("failed") => Some("failed"),
                    Some("interrupted") => {
                        let head = native_head(thread);
                        let user_took_over = head.as_ref().is_some_and(|h| {
                            h != op_msg_id
                                && !watcher_msgs
                                    .contains(&(op.target.thread_id.clone(), h.clone()))
                        });
                        Some(if user_took_over { "paused" } else { "stopped" })
                    }
                    Some("completed") => {
                        if is_thread_turn_running(thread) || bg_count > 0 {
                            Some("background")
                        } else {
                            Some("answered")
                        }
                    }
                    _ => None,
                };
                if let Some(outcome_str) = new_outcome {
                    let reply_id = if outcome_str == "answered" {
                        thread
                            .get("summary")
                            .and_then(|s| s.get("lastAssistant"))
                            .and_then(|m| m.get("id"))
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                            .or_else(|| {
                                thread
                                    .get("messages")
                                    .and_then(Value::as_array)
                                    .and_then(|arr| {
                                        arr.iter().rev().find(|m| {
                                            m.get("role").and_then(Value::as_str)
                                                == Some("assistant")
                                        })
                                    })
                                    .and_then(|m| m.get("id"))
                                    .and_then(Value::as_str)
                                    .map(ToString::to_string)
                            })
                    } else {
                        None
                    };
                    let changed = op.outcome.as_deref() != Some(outcome_str)
                        || op.turn_message_id.as_deref() != Some(op_msg_id.as_str())
                        || op.native_turn_id != last_turn_id
                        || (reply_id.is_some() && op.reply_message_id != reply_id);
                    if changed {
                        op.outcome = Some(outcome_str.into());
                        op.outcome_at = Some(now_str.clone());
                        op.turn_message_id = Some(op_msg_id.clone());
                        if let Some(ntid) = last_turn_id {
                            op.native_turn_id = Some(ntid);
                        }
                        if let Some(rid) = reply_id {
                            op.reply_message_id = Some(rid);
                        }
                        dirty = true;
                    }
                }
            }

            // 5. Prune reservations for finished/failed/relinquished threads.
            let before_res = next.reservations.len();
            let ops_snapshot = next.operations.clone();
            let reqs_snapshot = next.requests.clone();
            next.reservations.retain(|res| {
                if res.target.host_id != self.host_id {
                    return true;
                }
                let target_ops: Vec<&WatcherOperation> = ops_snapshot
                    .iter()
                    .filter(|o| o.target == res.target)
                    .collect();
                if target_ops
                    .iter()
                    .any(|o| o.delivery_state == "dispatching" || o.delivery_state == "uncertain")
                {
                    return true;
                }
                let participant_active = reqs_snapshot
                    .iter()
                    .find(|r| r.id == res.request_id)
                    .and_then(|r| r.participants.iter().find(|p| p.target == res.target))
                    .is_some_and(|p| p.state == "participating");
                if !participant_active {
                    return false;
                }
                if target_ops.iter().any(|o| o.delivery_state == "queued") {
                    return true;
                }
                let Some(thread) = threads_by_id.get(res.target.thread_id.as_str()) else {
                    return !target_ops.iter().all(|o| o.delivery_state == "failed");
                };
                if !is_thread_connected(shell, thread) {
                    return true;
                }
                is_thread_turn_running(thread)
                    || thread_background_work_count(thread) > 0
                    || thread
                        .get("requests")
                        .and_then(Value::as_array)
                        .is_some_and(|a| !a.is_empty())
            });
            if next.reservations.len() != before_res {
                dirty = true;
            }

            // 6. Close active remote requests once all their participants are relinquished/taken-over and no unresolved ops remain.
            let ops_ref = next.operations.clone();
            for req in &mut next.requests {
                if req.state != "active" || req.remote_origin.is_none() || req.participants.is_empty()
                {
                    continue;
                }
                let has_unresolved = ops_ref.iter().any(|o| {
                    o.request_id == req.id
                        && matches!(
                            o.delivery_state.as_str(),
                            "queued" | "dispatching" | "uncertain"
                        )
                });
                let all_done = req.participants.iter().all(|p| {
                    p.state != "participating"
                        || threads_by_id.get(p.target.thread_id.as_str()).is_some_and(|t| {
                            let proj = projects.iter().find(|pr| {
                                pr.get("id").and_then(Value::as_str)
                                    == t.get("projectId").and_then(Value::as_str)
                            });
                            is_thread_settled(t, proj)
                        })
                });
                if !has_unresolved && all_done {
                    req.state = "closed".into();
                    req.closed_at = Some(now_str.clone());
                    dirty = true;
                }
            }

            if dirty && validate_watcher_record(&next).is_ok() {
                let _ = store.update(|rec| {
                    *rec = next;
                    Ok(())
                });
            }
            dirty
        };

        // 7. Release completed/failed/stopped running checks and return any next waiting check to launch.
        let to_launch = self.advance_check_queue(&threads_by_id);

        if something_changed || record_changed || !to_launch.is_empty() {
            self.notify();
        }
        to_launch
    }

    fn advance_check_queue(
        &self,
        threads_by_id: &HashMap<&str, &Value>,
    ) -> Vec<(String, WaitingCheckPayload)> {
        let record = self.record_snapshot();
        let mut rt = self.runtime.lock().unwrap();
        let mut launch = Vec::new();
        while let Some(front) = rt.check_queue.front() {
            if front.waiting.is_some() {
                // This waiting check just moved to the head of the queue — launch it now!
                if let Some(entry) = rt.check_queue.front_mut() {
                    if let Some(payload) = entry.waiting.take() {
                        launch.push((entry.operation_id.clone(), payload));
                    }
                }
                break;
            }
            let op = record.operations.iter().find(|o| o.id == front.operation_id);
            let still_holds = match op {
                None => false,
                Some(o) if o.delivery_state == "failed" => false,
                Some(o) if matches!(o.delivery_state.as_str(), "queued" | "dispatching" | "uncertain") => true,
                Some(o) => {
                    if let Some(ref outcome) = o.outcome {
                        outcome == "working" || outcome == "background"
                    } else if let Some(thread) = threads_by_id.get(o.target.thread_id.as_str()) {
                        is_thread_turn_running(thread)
                            || thread_background_work_count(thread) > 0
                            || thread.get("lastTurn").is_none()
                    } else {
                        false
                    }
                }
            };
            if still_holds {
                break;
            }
            rt.check_queue.pop_front();
        }
        launch
    }

    /// Runs a queued check whose turn at the head of this host's check queue just arrived.
    pub async fn launch_queued_check(&self, operation_id: String, payload: WaitingCheckPayload) {
        let op = {
            let record = self.record_snapshot();
            record.operations.into_iter().find(|o| o.id == operation_id)
        };
        let Some(op) = op else {
            return;
        };
        if op.delivery_state != "queued" {
            return;
        }
        let _ = self
            .execute_start_thread(&op, &payload.input, &payload.client, payload.may_answer)
            .await;
        self.notify();
    }

    // -----------------------------------------------------------------------
    // Authority, re-pair migration & validation checks
    // -----------------------------------------------------------------------

    fn desktop_host_id_of(&self, client_id: &str) -> Option<String> {
        self.desktops.as_ref().and_then(|d| {
            d.lock()
                .unwrap()
                .host_id_of(client_id)
                .map(ToString::to_string)
        })
    }

    fn check_caller_host_binding(
        &self,
        client_id: &str,
        master_host_id: &str,
    ) -> Result<(), WatcherRefusal> {
        if let Some(caller_host) = self.desktop_host_id_of(client_id) {
            if caller_host != master_host_id {
                return Err(refuse(
                    "INVALID_INPUT",
                    "This desktop identity does not match the Watcher master computer. Nothing was sent.",
                ));
            }
        }
        Ok(())
    }

    /// Whether an authenticated desktop `client_id` owns `(origin_client_id, origin_master_host_id)`
    /// for `master_host_id` (#2863):
    /// - If `client_id` has an SSH-recorded `desktopHostId` binding, it may only act for that host.
    /// - Exact `client_id` matches are always owned (once the caller binding passes).
    /// - Cross-`client_id` migration after a desktop re-pair is permitted ONLY when `client_id` is
    ///   SSH-verified as `master_host_id` and `origin_client_id` is not bound to a different desktop.
    fn owns_remote_origin(
        &self,
        origin_client_id: &str,
        origin_master_host_id: &str,
        client_id: &str,
        master_host_id: &str,
    ) -> bool {
        if origin_client_id.is_empty() || origin_master_host_id != master_host_id {
            return false;
        }
        let caller_host = self.desktop_host_id_of(client_id);
        if caller_host
            .as_deref()
            .is_some_and(|bound| bound != master_host_id)
        {
            return false;
        }
        if origin_client_id == client_id {
            return true;
        }
        if caller_host.as_deref() != Some(master_host_id) {
            return false;
        }
        let origin_host = self.desktop_host_id_of(origin_client_id);
        origin_host.is_none() || origin_host.as_deref() == Some(master_host_id)
    }

    fn watch_fence_matches_target_origin(
        &self,
        fence: &Value,
        target: &WatcherThreadTarget,
        client_id: &str,
        master_host_id: &str,
    ) -> bool {
        let target_ok = fence
            .get("target")
            .and_then(|v| serde_json::from_value::<WatcherThreadTarget>(v.clone()).ok())
            .is_some_and(|t| t == *target);
        let origin_ok = fence
            .get("remoteOrigin")
            .and_then(|v| serde_json::from_value::<WatcherWatchOrigin>(v.clone()).ok())
            .is_some_and(|o| {
                self.owns_remote_origin(&o.client_id, &o.master_host_id, client_id, master_host_id)
            });
        target_ok && origin_ok
    }

    fn needs_remote_client_migration(
        &self,
        record: &WatcherRecord,
        client_id: &str,
        master_host_id: &str,
    ) -> bool {
        if self.desktop_host_id_of(client_id).as_deref() != Some(master_host_id) {
            return false;
        }
        let has_watch = record.watches.as_deref().unwrap_or(&[]).iter().any(|w| {
            w.remote_origin.as_ref().is_some_and(|o| {
                o.client_id != client_id
                    && self.owns_remote_origin(
                        &o.client_id,
                        &o.master_host_id,
                        client_id,
                        master_host_id,
                    )
            })
        });
        if has_watch {
            return true;
        }
        let has_fence = record
            .watch_fences
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .any(|f| {
                f.get("remoteOrigin")
                    .and_then(|v| serde_json::from_value::<WatcherWatchOrigin>(v.clone()).ok())
                    .is_some_and(|o| {
                        o.client_id != client_id
                            && self.owns_remote_origin(
                                &o.client_id,
                                &o.master_host_id,
                                client_id,
                                master_host_id,
                            )
                    })
            });
        if has_fence {
            return true;
        }
        let has_request = record.requests.iter().any(|r| {
            r.remote_origin
                .as_ref()
                .and_then(remote_origin_fields)
                .is_some_and(|(cid, m, _, _)| {
                    cid != client_id
                        && self.owns_remote_origin(&cid, &m.target.host_id, client_id, master_host_id)
                })
        });
        if has_request {
            return true;
        }
        let has_master = record
            .remote_masters
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .any(|m| {
                let Some(cid) = m.get("clientId").and_then(Value::as_str) else {
                    return false;
                };
                let Some(hid) = m.get("masterHostId").and_then(Value::as_str) else {
                    return false;
                };
                cid != client_id && self.owns_remote_origin(cid, hid, client_id, master_host_id)
            });
        if has_master {
            return true;
        }
        record
            .remote_absences
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .any(|a| {
                let Some(cid) = a.get("clientId").and_then(Value::as_str) else {
                    return false;
                };
                let Some(hid) = a
                    .get("master")
                    .and_then(|m| m.get("target"))
                    .and_then(|t| t.get("hostId"))
                    .and_then(Value::as_str)
                else {
                    return false;
                };
                cid != client_id && self.owns_remote_origin(cid, hid, client_id, master_host_id)
            })
    }

    /// Atomically re-stamps a verified re-paired desktop's prior `clientId` records to its new
    /// `clientId` (#2863), deduplicating `remoteMasters` while keeping the newest replacement
    /// watermark. Caller must hold `tx_lock`.
    fn migrate_remote_client(
        &self,
        master: &WatcherIdentity,
        client_id: &str,
    ) -> Result<(), WatcherRefusal> {
        let master_host_id = master.target.host_id.as_str();
        if self.desktop_host_id_of(client_id).as_deref() != Some(master_host_id) {
            return Ok(());
        }
        let current = self.record_snapshot();
        if !self.needs_remote_client_migration(&current, client_id, master_host_id) {
            return Ok(());
        }
        self.update_record(|next| {
            if let Some(ref mut watches) = next.watches {
                for w in watches.iter_mut() {
                    if let Some(ref mut o) = w.remote_origin {
                        if o.client_id != client_id
                            && self.owns_remote_origin(
                                &o.client_id,
                                &o.master_host_id,
                                client_id,
                                master_host_id,
                            )
                        {
                            o.client_id = client_id.to_string();
                        }
                    }
                }
            }
            if let Some(ref mut fences) = next.watch_fences {
                for f in fences.iter_mut() {
                    let should_migrate = f
                        .get("remoteOrigin")
                        .and_then(|v| serde_json::from_value::<WatcherWatchOrigin>(v.clone()).ok())
                        .is_some_and(|o| {
                            o.client_id != client_id
                                && self.owns_remote_origin(
                                    &o.client_id,
                                    &o.master_host_id,
                                    client_id,
                                    master_host_id,
                                )
                        });
                    if should_migrate {
                        if let Some(ro) = f.get_mut("remoteOrigin").and_then(Value::as_object_mut) {
                            ro.insert("clientId".into(), Value::String(client_id.to_string()));
                        }
                    }
                }
            }
            for req in &mut next.requests {
                let should_migrate = req
                    .remote_origin
                    .as_ref()
                    .and_then(remote_origin_fields)
                    .is_some_and(|(cid, m, _, _)| {
                        cid != client_id
                            && self.owns_remote_origin(
                                &cid,
                                &m.target.host_id,
                                client_id,
                                master_host_id,
                            )
                    });
                if should_migrate {
                    if let Some(ro) = req.remote_origin.as_mut().and_then(Value::as_object_mut) {
                        ro.insert("clientId".into(), Value::String(client_id.to_string()));
                    }
                }
            }
            if let Some(ref mut masters) = next.remote_masters {
                let mut newest: Option<(String, String)> = None;
                let mut others: Vec<Value> = Vec::with_capacity(masters.len());
                for origin in masters.drain(..) {
                    let cid = origin.get("clientId").and_then(Value::as_str).unwrap_or("");
                    let hid = origin
                        .get("masterHostId")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if self.owns_remote_origin(cid, hid, client_id, master_host_id) {
                        let created_at = origin
                            .get("createdAt")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let op_id = origin
                            .get("creationOperationId")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        if newest
                            .as_ref()
                            .is_none_or(|(best_at, _)| created_at.as_str() > best_at.as_str())
                        {
                            newest = Some((created_at, op_id));
                        }
                    } else {
                        others.push(origin);
                    }
                }
                if let Some((created_at, op_id)) = newest {
                    others.push(json!({
                        "clientId": client_id,
                        "masterHostId": master_host_id,
                        "creationOperationId": op_id,
                        "createdAt": created_at,
                    }));
                }
                *masters = others;
            }
            if let Some(ref mut absences) = next.remote_absences {
                for absence in absences.iter_mut() {
                    let should_migrate = {
                        let cid = absence.get("clientId").and_then(Value::as_str).unwrap_or("");
                        let hid = absence
                            .get("master")
                            .and_then(|m| m.get("target"))
                            .and_then(|t| t.get("hostId"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        cid != client_id
                            && self.owns_remote_origin(cid, hid, client_id, master_host_id)
                    };
                    if should_migrate {
                        if let Some(obj) = absence.as_object_mut() {
                            obj.insert("clientId".into(), Value::String(client_id.to_string()));
                        }
                    }
                }
            }
            Ok(())
        })
    }

    fn check_remote_master(
        &self,
        record: &WatcherRecord,
        master: &WatcherIdentity,
        client_id: &str,
    ) -> Result<(), WatcherRefusal> {
        if !WATCHER_PROVIDERS.contains(&master.provider.as_str()) {
            return Err(refuse(
                "INVALID_INPUT",
                "Unknown Watcher provider. Nothing was sent.",
            ));
        }
        self.check_caller_host_binding(client_id, &master.target.host_id)?;
        if let Some(masters) = record.remote_masters.as_deref() {
            for item in masters {
                let item_cid = item.get("clientId").and_then(Value::as_str).unwrap_or("");
                let item_host = item
                    .get("masterHostId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if self.owns_remote_origin(item_cid, item_host, client_id, &master.target.host_id) {
                    let retained_at = item
                        .get("createdAt")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let retained_op = item
                        .get("creationOperationId")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if retained_at > master.created_at.as_str()
                        || (retained_at == master.created_at.as_str()
                            && retained_op != master.creation_operation_id.as_str())
                    {
                        return Err(refuse(
                            "NOT_CURRENT_WATCHER",
                            "That Watcher conversation was replaced. Its old assignments cannot be restored.",
                        ));
                    }
                }
            }
        }
        let check_origin = |origin: &WatcherWatchOrigin| -> Result<(), WatcherRefusal> {
            if self.owns_remote_origin(
                &origin.client_id,
                &origin.master_host_id,
                client_id,
                &master.target.host_id,
            ) {
                if let Some(ref created_at) = origin.master_created_at {
                    let op_id = origin
                        .master_creation_operation_id
                        .as_deref()
                        .unwrap_or("");
                    if created_at.as_str() > master.created_at.as_str()
                        || (created_at.as_str() == master.created_at.as_str()
                            && op_id != master.creation_operation_id.as_str())
                    {
                        return Err(refuse(
                            "NOT_CURRENT_WATCHER",
                            "That Watcher conversation was replaced. Its old assignments cannot be restored.",
                        ));
                    }
                }
            }
            Ok(())
        };
        for watch in record.watches.as_deref().unwrap_or(&[]) {
            if let Some(ref origin) = watch.remote_origin {
                check_origin(origin)?;
            }
        }
        for fence in record.watch_fences.as_deref().unwrap_or(&[]) {
            if let Some(origin) = fence
                .get("remoteOrigin")
                .and_then(|v| serde_json::from_value::<WatcherWatchOrigin>(v.clone()).ok())
            {
                check_origin(&origin)?;
            }
        }
        Ok(())
    }

    fn check_remote_authority(
        &self,
        record: &WatcherRecord,
        operation: &WatcherOperation,
        master: &WatcherIdentity,
        client_id: &str,
        standing_watch_id: Option<&str>,
    ) -> Result<(), WatcherRefusal> {
        self.check_remote_master(record, master, client_id)?;
        let fences = record.watch_fences.as_deref().unwrap_or(&[]);
        if let Some(ref wid) = operation.standing_watch_id {
            if fences.iter().any(|f| watch_fence_matches_id(f, wid)) {
                return Err(refuse(
                    "REQUEST_NOT_ACTIVE",
                    "This watch was removed. Nothing was sent.",
                ));
            }
        }
        let assignment_id = standing_watch_id.or_else(|| {
            (operation.action != "start")
                .then_some(operation.standing_watch_id.as_deref())
                .flatten()
        });
        if let Some(aid) = assignment_id {
            let matched = record
                .watches
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .any(|w| {
                    w.id == aid
                        && w.target == operation.target
                        && w.remote_origin.as_ref().is_some_and(|o| {
                            self.owns_remote_origin(
                                &o.client_id,
                                &o.master_host_id,
                                client_id,
                                &master.target.host_id,
                            ) && o.master_creation_operation_id.as_deref()
                                == Some(master.creation_operation_id.as_str())
                        })
                });
            if !matched {
                return Err(refuse(
                    "REQUEST_NOT_ACTIVE",
                    "The owning host has no matching watch assignment. Nothing was sent.",
                ));
            }
        }
        if operation.standing_watch_id.is_none()
            && operation.confirmed_stop != Some(true)
            && fences.iter().any(|f| {
                self.watch_fence_matches_target_origin(
                    f,
                    &operation.target,
                    client_id,
                    &master.target.host_id,
                )
            })
        {
            return Err(refuse(
                "REQUEST_NOT_ACTIVE",
                "This thread was unwatched. Use a new watch assignment before continuing.",
            ));
        }
        Ok(())
    }

    fn check_not_delegated(
        &self,
        shell: &Value,
        thread: &Value,
        action: &str,
    ) -> Result<(), WatcherRefusal> {
        let Some(delegated_by) = thread.get("delegatedBy").and_then(Value::as_str) else {
            return Ok(());
        };
        let parent_title = shell
            .get("host")
            .and_then(|h| h.get("threads"))
            .and_then(Value::as_array)
            .and_then(|arr| {
                arr.iter()
                    .find(|t| t.get("id").and_then(Value::as_str) == Some(delegated_by))
            })
            .and_then(|t| t.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("its parent thread");
        let verb = match action {
            "stop" | "stop_thread" => "stopped",
            "settle" | "settle_thread" => "settled",
            _ => "sent",
        };
        Err(refuse(
            "RESERVED_THREAD",
            format!(
                "This thread was delegated by another thread. Direct that thread instead: “{parent_title}”, threadId {delegated_by}, hostId {}. Nothing was {verb}.",
                self.host_id
            ),
        ))
    }

    fn check_protected_thread(&self, thread: &Value) -> Result<(), WatcherRefusal> {
        let kind = thread.get("kind").and_then(Value::as_str);
        if matches!(kind, Some("watcher" | "watcher-history")) || thread.get("owlet").is_some() {
            return Err(refuse(
                "RESERVED_THREAD",
                "This thread has a special job and cannot be directed by Watcher.",
            ));
        }
        Ok(())
    }

    fn check_pending_requests(&self, thread: &Value) -> Result<(), WatcherRefusal> {
        let has_req = thread
            .get("requests")
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty());
        if has_req {
            return Err(refuse(
                "PENDING_USER_REQUEST",
                "This thread is waiting for a user answer. The user must answer it before Watcher continues.",
            ));
        }
        Ok(())
    }

    fn human_turn_running(&self, thread: &Value, record: &WatcherRecord) -> bool {
        if !is_thread_turn_running(thread) {
            return false;
        }
        let Some(tid) = thread.get("id").and_then(Value::as_str) else {
            return false;
        };
        let target = WatcherThreadTarget::new(&self.host_id, tid);
        let head = native_head(thread);
        let Some(head_id) = head else {
            return true;
        };
        let is_machine = record
            .operations
            .iter()
            .any(|op| op.target == target && op.message_id.as_deref() == Some(head_id.as_str()));
        !is_machine
    }

    fn check_human_turn(
        &self,
        thread: &Value,
        record: &WatcherRecord,
        delivery: Option<&str>,
    ) -> Result<(), WatcherRefusal> {
        if delivery == Some("steer") {
            return Ok(());
        }
        if self.human_turn_running(thread, record) {
            return Err(refuse_retryable("THREAD_BUSY", USER_TURN_RUNNING));
        }
        let tid = thread.get("id").and_then(Value::as_str).unwrap_or("");
        let target = WatcherThreadTarget::new(&self.host_id, tid);
        if record.watches.as_deref().unwrap_or(&[]).iter().any(|w| {
            w.target == target
                && w.paused_by_user_message_id
                    .as_ref()
                    .and_then(|o| o.as_ref())
                    .is_some()
        }) {
            return Err(refuse_retryable("THREAD_BUSY", WATCH_PAUSED_HOLD));
        }
        Ok(())
    }

    fn check_permission(
        &self,
        shell: &Value,
        model_id: &str,
        explicit: Option<&WatcherPermission>,
        request_ceiling: &str,
        may_answer: bool,
    ) -> Result<WatcherPermission, WatcherRefusal> {
        let model = shell
            .get("host")
            .and_then(|h| h.get("models"))
            .and_then(Value::as_array)
            .and_then(|models| {
                models
                    .iter()
                    .find(|m| m.get("id").and_then(Value::as_str) == Some(model_id))
            });
        let Some(model) = model else {
            return Err(refuse(
                "PROVIDER_UNAVAILABLE",
                "Choose a ready worker model. Sotto will not switch accounts.",
            ));
        };
        if model.get("ready").and_then(Value::as_bool) != Some(true) {
            return Err(refuse(
                "PROVIDER_UNAVAILABLE",
                "Choose a ready worker model. Sotto will not switch accounts.",
            ));
        }
        let offered: Vec<&str> = model
            .get("runtimeModes")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        if offered.is_empty() {
            return Err(refuse(
                "PERMISSION_NOT_COMPARABLE",
                "This model has no comparable permission mode. Choose another model.",
            ));
        }
        let req_rank = runtime_mode_rank(request_ceiling)
            .ok_or_else(|| refuse("INVALID_INPUT", "Invalid permission ceiling."))?;
        let effective_rank = if may_answer { req_rank } else { 0 };
        let ceiling_mode = RUNTIME_MODE_ORDER[effective_rank];

        // Nearest offered mode <= effective ceiling.
        let resolved_ceiling = offered
            .iter()
            .filter_map(|&m| runtime_mode_rank(m).map(|r| (r, m)))
            .filter(|(r, _)| *r <= effective_rank)
            .max_by_key(|(r, _)| *r)
            .map(|(_, m)| m);

        let Some(resolved_ceiling) = resolved_ceiling else {
            if !may_answer {
                return Err(refuse(
                    "PERMISSION_TOO_WIDE",
                    "That host does not let this computer answer there, so Watcher can give a thread on it no more than Ask for approval. Nothing was sent or started. To give it more, let this computer answer on that host first.",
                ));
            }
            return Err(refuse(
                "PERMISSION_NOT_COMPARABLE",
                "This model has no comparable permission mode. Choose another model.",
            ));
        };

        match explicit {
            Some(WatcherPermission::Provider { .. }) => Err(refuse(
                "PERMISSION_NOT_COMPARABLE",
                "This permission choice cannot be compared with the new-thread default.",
            )),
            Some(WatcherPermission::Runtime { mode }) => {
                if !offered.contains(&mode.as_str()) {
                    return Err(refuse(
                        "PERMISSION_NOT_COMPARABLE",
                        "This model does not offer that permission mode.",
                    ));
                }
                let asked_rank = runtime_mode_rank(mode)
                    .ok_or_else(|| refuse("INVALID_INPUT", "Invalid permission mode."))?;
                let cap_rank = runtime_mode_rank(resolved_ceiling).unwrap_or(0);
                if asked_rank > cap_rank {
                    let msg = if !may_answer {
                        "That host does not let this computer answer there, so Watcher can give a thread on it no more than Ask for approval. Nothing was sent or started. To give it more, let this computer answer on that host first."
                    } else {
                        "The worker exceeds the master’s new-thread permission default. Nothing was sent."
                    };
                    return Err(refuse("PERMISSION_TOO_WIDE", msg));
                }
                if asked_rank > req_rank {
                    return Err(refuse(
                        "PERMISSION_TOO_WIDE",
                        "The worker exceeds the master’s new-thread permission default. Nothing was sent.",
                    ));
                }
                Ok(WatcherPermission::Runtime { mode: mode.clone() })
            }
            None => {
                let cap_rank = runtime_mode_rank(resolved_ceiling).unwrap_or(0);
                if !may_answer && cap_rank > runtime_mode_rank(ceiling_mode).unwrap_or(0) {
                    return Err(refuse(
                        "PERMISSION_TOO_WIDE",
                        "That host does not let this computer answer there, so Watcher can give a thread on it no more than Ask for approval. Nothing was sent or started.",
                    ));
                }
                Ok(WatcherPermission::Runtime {
                    mode: resolved_ceiling.to_string(),
                })
            }
        }
    }

    fn check_settlement(&self, shell: &Value, thread: &Value) -> Result<(), WatcherRefusal> {
        self.check_pending_requests(thread)?;
        if is_thread_turn_running(thread) {
            return Err(refuse(
                "THREAD_BUSY",
                "Wait for this thread to finish before settling it.",
            ));
        }
        let bg = thread_background_work_count(thread);
        if bg > 0 {
            return Err(refuse(
                "BACKGROUND_WORK_RUNNING",
                format!(
                    "This thread still has background work ({bg} active). Stop it explicitly before settling."
                ),
            ));
        }
        let tid = thread.get("id").and_then(Value::as_str).unwrap_or("");
        // Delegated child threads block settlement if running or waiting on user.
        if let Some(threads) = shell
            .get("host")
            .and_then(|h| h.get("threads"))
            .and_then(Value::as_array)
        {
            for child in threads {
                if child.get("delegatedBy").and_then(Value::as_str) == Some(tid)
                    && (is_thread_turn_running(child)
                        || thread_background_work_count(child) > 0
                        || child
                            .get("requests")
                            .and_then(Value::as_array)
                            .is_some_and(|a| !a.is_empty()))
                {
                    let title = child
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("delegated thread");
                    let cid = child.get("id").and_then(Value::as_str).unwrap_or("");
                    return Err(refuse(
                        "BACKGROUND_WORK_RUNNING",
                        format!(
                            "Delegated thread “{title}” ({cid}) blocks settlement. Wait for it before settling. Nothing was settled."
                        ),
                    ));
                }
            }
        }
        // Open pull requests block settlement.
        let open_pr_url = thread
            .get("pullRequests")
            .and_then(Value::as_array)
            .and_then(|arr| {
                arr.iter()
                    .find(|p| p.get("state").and_then(Value::as_str) == Some("open"))
            })
            .and_then(|p| p.get("url").and_then(Value::as_str))
            .or_else(|| {
                let pr = thread.get("worktree")?.get("git")?.get("pullRequest")?;
                (pr.get("state").and_then(Value::as_str) == Some("open"))
                    .then(|| pr.get("url").and_then(Value::as_str))
                    .flatten()
            });
        if let Some(url) = open_pr_url {
            let title = thread
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Thread");
            return Err(refuse(
                "THREAD_BUSY",
                format!(
                    "Thread “{title}” ({tid}) has an open pull request, {url}. Wait for it to merge or close before settling. Nothing was settled."
                ),
            ));
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Receipt / limits / state formatting
    // -----------------------------------------------------------------------

    fn receipt_value(&self, op: &WatcherOperation) -> Value {
        let mut obj = Map::new();
        obj.insert("operationId".into(), Value::String(op.id.clone()));
        obj.insert(
            "target".into(),
            serde_json::to_value(&op.target).unwrap_or(Value::Null),
        );
        obj.insert("requestId".into(), Value::String(op.request_id.clone()));
        obj.insert(
            "deliveryState".into(),
            Value::String(op.delivery_state.clone()),
        );
        obj.insert("receiptId".into(), Value::String(op.receipt_id.clone()));
        obj.insert("cardId".into(), Value::String(op.card_id.clone()));
        if let Some(ref draft_id) = op.draft_id {
            obj.insert("draftId".into(), Value::String(draft_id.clone()));
        }
        if let Some(ref msg_id) = op.message_id {
            obj.insert("messageId".into(), Value::String(msg_id.clone()));
        }
        if let Some(ref item_id) = op.item_id {
            obj.insert("itemId".into(), Value::String(item_id.clone()));
        }
        Value::Object(obj)
    }

    fn prompt_count(
        &self,
        record: &WatcherRecord,
        target: &WatcherThreadTarget,
        prompt_turn_id: Option<&str>,
        request_id: &str,
    ) -> u32 {
        if let Some(turn_id) = prompt_turn_id {
            record
                .operations
                .iter()
                .filter(|op| {
                    op.prompt_turn_id.as_deref() == Some(turn_id)
                        && op.target == *target
                        && (op.action == "start" || op.action == "send")
                        && op.prompt_refunded != Some(true)
                })
                .count() as u32
        } else {
            record
                .requests
                .iter()
                .find(|r| r.id == request_id)
                .and_then(|r| r.participants.iter().find(|p| p.target == *target))
                .map(|p| p.prompt_count)
                .unwrap_or(0)
        }
    }

    fn limits_value(&self, record: &WatcherRecord, op: &WatcherOperation) -> Value {
        let count = self
            .prompt_count(
                record,
                &op.target,
                op.prompt_turn_id.as_deref(),
                &op.request_id,
            )
            .min(WATCHER_PROMPTS_PER_THREAD);
        json!({
            "promptCount": count,
            "promptLimit": WATCHER_PROMPTS_PER_THREAD,
        })
    }

    fn operation_state(&self, shell: &Value, target: &WatcherThreadTarget) -> Value {
        let thread = shell
            .get("host")
            .and_then(|h| h.get("threads"))
            .and_then(Value::as_array)
            .and_then(|arr| {
                arr.iter()
                    .find(|t| t.get("id").and_then(Value::as_str) == Some(target.thread_id.as_str()))
            });
        let Some(thread) = thread else {
            return json!({
                "status": "unavailable",
                "stopped": false,
                "settled": false,
                "backgroundWorkCount": 0,
                "observedAt": Value::Null,
                "freshness": "stale",
            });
        };
        let project = shell
            .get("host")
            .and_then(|h| h.get("projects"))
            .and_then(Value::as_array)
            .and_then(|arr| {
                arr.iter().find(|p| {
                    p.get("id").and_then(Value::as_str)
                        == thread.get("projectId").and_then(Value::as_str)
                })
            });
        let status = thread
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unavailable");
        let has_reqs = thread
            .get("requests")
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty());
        let connected = is_thread_connected(shell, thread);
        json!({
            "status": status,
            "stopped": status == "idle" && !has_reqs,
            "settled": is_thread_settled(thread, project),
            "backgroundWorkCount": thread_background_work_count(thread),
            "observedAt": now_iso(),
            "freshness": if connected { "fresh" } else { "stale" },
        })
    }

    fn operation_result(
        &self,
        shell: &Value,
        record: &WatcherRecord,
        call: &WatcherControlCall,
        op: &WatcherOperation,
    ) -> Value {
        let receipt = self.receipt_value(op);
        let limits = self.limits_value(record, op);

        if let Some(ref code) = op.refusal_code {
            let msg = match code.as_str() {
                "THREAD_TAKEN_OVER" => {
                    "The user sent this thread an instruction first, so this was not sent. Read it before sending again."
                }
                "THREAD_BUSY" => RUNNING_TURN_HOLD,
                "REQUEST_NOT_ACTIVE" => {
                    "This Watcher request has stopped. Nothing was sent."
                }
                _ => "The operation could not be completed. Read its receipt before trying again.",
            };
            return json!({
                "status": "refused",
                "code": code,
                "message": msg,
                "retryable": matches!(code.as_str(), "THREAD_BUSY" | "DELIVERY_UNCERTAIN" | "PROVIDER_UNAVAILABLE" | "HOST_DISCONNECTED"),
                "receipt": receipt,
            });
        }

        match call {
            WatcherControlCall::StartThread(create) => {
                // Check if this start is waiting in the check queue.
                let waiting_ahead = {
                    let rt = self.runtime.lock().unwrap();
                    rt.check_queue
                        .iter()
                        .position(|c| c.operation_id == op.id && c.waiting.is_some())
                };
                if let Some(ahead) = waiting_ahead {
                    let note = format!(
                        "{ahead} check{} ahead on this host. Its thread starts automatically when its turn comes; stop_thread removes it from the queue.",
                        if ahead == 1 { " is" } else { "s are" }
                    );
                    let perm = create.permission.clone().unwrap_or(WatcherPermission::Runtime {
                        mode: "approval-required".into(),
                    });
                    let mut choices = json!({
                        "modelId": create.model_id.clone().unwrap_or_default(),
                        "reasoningEffort": create.reasoning_effort,
                        "speed": create.speed.clone().flatten(),
                        "permission": perm,
                        "workingCopy": create.working_copy,
                    });
                    if let Some(ref base) = create.base_ref_choice_id {
                        if let Some(obj) = choices.as_object_mut() {
                            obj.insert("baseRefChoiceId".into(), Value::String(base.clone()));
                        }
                    }
                    return watcher_result_for_host_v1(json!({
                        "status": "ok",
                        "receipt": receipt,
                        "limits": limits,
                        "target": op.target,
                        "creationReceiptId": op.creation_receipt_id.clone().unwrap_or_default(),
                        "firstPromptReceiptId": op.first_prompt_receipt_id.clone().unwrap_or_default(),
                        "effectiveChoices": choices,
                        "check": { "ahead": ahead, "note": note },
                    }));
                }

                let thread = shell
                    .get("host")
                    .and_then(|h| h.get("threads"))
                    .and_then(Value::as_array)
                    .and_then(|arr| {
                        arr.iter().find(|t| {
                            t.get("id").and_then(Value::as_str) == Some(op.target.thread_id.as_str())
                        })
                    });
                let Some(thread) = thread else {
                    return WatcherRefusal::new(
                        "DELIVERY_UNCERTAIN",
                        "The creation is recorded, but its thread is unavailable. This retry started nothing. Reconcile the original receipt.",
                        true,
                    )
                    .with_receipt(receipt)
                    .to_value();
                };
                let perm = if let Some(pm) = thread.get("providerMode").and_then(Value::as_str) {
                    json!({ "kind": "provider", "choiceId": pm })
                } else {
                    let rm = thread
                        .get("runtimeMode")
                        .and_then(Value::as_str)
                        .unwrap_or("approval-required");
                    json!({ "kind": "runtime", "mode": rm })
                };
                let mut choices = json!({
                    "modelId": thread.get("modelId").and_then(Value::as_str).unwrap_or(""),
                    "reasoningEffort": thread.get("reasoningEffort").cloned().unwrap_or(Value::Null),
                    "speed": thread.get("speed").cloned().unwrap_or(Value::Null),
                    "permission": perm,
                    "workingCopy": create.working_copy,
                });
                if let Some(ref base) = create.base_ref_choice_id {
                    if let Some(obj) = choices.as_object_mut() {
                        obj.insert("baseRefChoiceId".into(), Value::String(base.clone()));
                    }
                }
                watcher_result_for_host_v1(json!({
                    "status": "ok",
                    "receipt": receipt,
                    "limits": limits,
                    "target": op.target,
                    "creationReceiptId": op.creation_receipt_id.clone().unwrap_or_default(),
                    "firstPromptReceiptId": op.first_prompt_receipt_id.clone().unwrap_or_default(),
                    "effectiveChoices": choices,
                }))
            }
            WatcherControlCall::SendToThread(_) => watcher_result_for_host_v1(json!({
                "status": "ok",
                "receipt": receipt,
                "limits": limits,
                "delivery": op.delivery.clone().unwrap_or_else(|| "now".into()),
            })),
            WatcherControlCall::StopThread(_) => watcher_result_for_host_v1(json!({
                "status": "ok",
                "receipt": receipt,
                "limits": limits,
                "stopRequested": true,
                "state": self.operation_state(shell, &op.target),
            })),
            WatcherControlCall::SettleThread(_) => watcher_result_for_host_v1(json!({
                "status": "ok",
                "receipt": receipt,
                "limits": limits,
                "state": self.operation_state(shell, &op.target),
            })),
        }
    }

    // -----------------------------------------------------------------------
    // `watcher-control` (`admitRemote`)
    // -----------------------------------------------------------------------

    pub async fn admit_remote(
        &self,
        raw: Value,
        client_id: &str,
        client_name: &str,
        may_answer: bool,
    ) -> Value {
        self.runtime
            .lock()
            .unwrap()
            .remote_answers
            .insert(client_id.to_string(), may_answer);

        let res = self
            .admit_remote_inner(raw, client_id, client_name, may_answer)
            .await;
        match res {
            Ok(val) => watcher_result_for_host_v1(val),
            Err(err) => err.to_value(),
        }
    }

    async fn admit_remote_inner(
        &self,
        raw: Value,
        client_id: &str,
        client_name: &str,
        may_answer: bool,
    ) -> Result<Value, WatcherRefusal> {
        let packet: WatcherHostControl = serde_json::from_value(raw).map_err(|_| {
            refuse(
                "INVALID_INPUT",
                "This machine request could not be admitted. Nothing was sent.",
            )
        })?;

        let WatcherHostControl {
            master,
            request,
            ceiling,
            operation,
            call,
        } = packet;

        // Validate packet invariants matching `WatcherService.admitRemote` in `src/main/agents/watcher.ts`.
        let valid_ceiling = runtime_mode_rank(&ceiling).is_some();
        let valid_uuids = is_valid_uuid(&master.target.host_id)
            && is_valid_uuid(&master.creation_operation_id)
            && is_valid_uuid(&request.id)
            && is_valid_uuid(&operation.id)
            && is_valid_uuid(&operation.request_id)
            && is_valid_uuid(&operation.retry_key)
            && is_valid_uuid(&operation.target.host_id);
        let expected_delivery = match &call {
            WatcherControlCall::StartThread(_) => Some("now"),
            WatcherControlCall::SendToThread(s) => s.delivery.as_deref(),
            _ => None,
        };
        let expected_turn_id = match &call {
            WatcherControlCall::SendToThread(s) => s.expected_turn_id.as_deref(),
            _ => None,
        };
        let expected_last_user_id = match &call {
            WatcherControlCall::SendToThread(s) => s.expected_last_user_message_id.as_deref(),
            _ => None,
        };
        let start_or_send = matches!(operation.action.as_str(), "start" | "send");
        let call_target_matches = call
            .target()
            .is_none_or(|t| *t == operation.target);
        let project_matches = match &call {
            WatcherControlCall::StartThread(s) => s.project.host_id == self.host_id,
            _ => true,
        };
        let unsupported_start_fields = match &call {
            WatcherControlCall::StartThread(s) => {
                s.from_move.is_some()
                    || s.from_origin.is_some()
                    || s.count.is_some()
                    || s.prompts.is_some()
                    || s.title.trim().is_empty()
                    || s.title.len() > WATCHER_TITLE_MAX
                    || s.first_prompt.trim().is_empty()
                    || s.first_prompt.len() > WATCHER_PROMPT_BYTES_MAX
            }
            WatcherControlCall::SendToThread(s) => {
                s.text.trim().is_empty() || s.text.len() > WATCHER_PROMPT_BYTES_MAX
            }
            _ => false,
        };

        if !valid_ceiling
            || !valid_uuids
            || master.target.host_id == self.host_id
            || master.target != request.watcher
            || operation.target.host_id != self.host_id
            || operation.request_id != request.id
            || call.request_id() != request.id
            || operation.retry_key != call.retry_key()
            || operation.digest != call.digest()
            || operation.delivery_state != "queued"
            || operation.command_id.is_some()
            || operation.item_id.is_some()
            || operation.refusal_code.is_some()
            || operation.creation_uncertain.is_some()
            || operation.prompt_refunded.is_some()
            || (if start_or_send {
                operation.draft_id.is_none() || operation.message_id.is_none()
            } else {
                operation.draft_id.is_some() || operation.message_id.is_some()
            })
            || (if operation.action == "start" {
                operation.creation_receipt_id.is_none()
                    || operation.first_prompt_receipt_id.is_none()
            } else {
                operation.creation_receipt_id.is_some()
                    || operation.first_prompt_receipt_id.is_some()
            })
            || operation.anchor_message_id.as_deref() != Some(request.root_user_message_id.as_str())
            || operation.action != call.action()
            || !call_target_matches
            || !project_matches
            || operation.delivery.as_deref() != expected_delivery
            || operation.expected_turn_id.as_deref() != expected_turn_id
            || operation.expected_last_user_message_id.as_deref() != expected_last_user_id
            || unsupported_start_fields
        {
            return Err(refuse(
                "INVALID_INPUT",
                "The machine operation does not match its request and target. Nothing was sent.",
            ));
        }

        let shell = self.refresh_shell(may_answer).await?;

        // Refuse sends/stops/settles targeting delegated child threads before touching the record.
        if let Some(target) = call.target() {
            if let Some(thread) = shell
                .get("host")
                .and_then(|h| h.get("threads"))
                .and_then(Value::as_array)
                .and_then(|arr| {
                    arr.iter()
                        .find(|t| t.get("id").and_then(Value::as_str) == Some(target.thread_id.as_str()))
                })
            {
                self.check_not_delegated(&shell, thread, call.name())?;
            }
        }

        // Serialized admission transaction.
        let (admitted_op, is_retry) = {
            let _guard = self.tx_lock.lock().await;
            self.admit_operation_tx(
                &shell,
                &master,
                &request,
                &ceiling,
                &operation,
                &call,
                client_id,
                may_answer,
            )?
        };

        if is_retry {
            let latest_shell = self.refresh_shell(may_answer).await.unwrap_or(shell);
            let record = self.record_snapshot();
            let live = record
                .operations
                .iter()
                .find(|o| o.id == admitted_op.id)
                .unwrap_or(&admitted_op);
            return Ok(self.operation_result(&latest_shell, &record, &call, live));
        }

        let client = ClientContext {
            client_id: client_id.to_string(),
            user: client_name.to_string(),
            may_answer,
        };

        let result = self
            .execute_operation(&admitted_op, &call, &client, may_answer)
            .await;
        self.notify();
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn admit_operation_tx(
        &self,
        shell: &Value,
        master: &WatcherIdentity,
        request: &WatcherControlRequestHeader,
        ceiling: &str,
        operation: &WatcherOperation,
        call: &WatcherControlCall,
        client_id: &str,
        may_answer: bool,
    ) -> Result<(WatcherOperation, bool), WatcherRefusal> {
        let pre_record = self.record_snapshot();
        self.check_remote_master(&pre_record, master, client_id)?;
        self.migrate_remote_client(master, client_id)?;
        let record = self.record_snapshot();

        // Check remote absence fence.
        if record
            .remote_absences
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .any(|a| a.get("operationId").and_then(Value::as_str) == Some(operation.id.as_str()))
        {
            return Err(refuse(
                "OPERATION_NOT_RECORDED",
                "An exact read fenced this unrecorded operation. Nothing was sent.",
            ));
        }

        // Check existing request origin match.
        let existing_req = record.requests.iter().find(|r| r.id == request.id);
        if let Some(existing) = existing_req {
            let origin_match = existing
                .remote_origin
                .as_ref()
                .and_then(remote_origin_fields)
                .is_some_and(|(cid, m, cop, ceil)| {
                    self.owns_remote_origin(&cid, &m.target.host_id, client_id, &master.target.host_id)
                        && m == *master
                        && cop == master.creation_operation_id
                        && ceil == ceiling
                });
            if existing.watcher != master.target
                || existing.root_user_message_id != request.root_user_message_id
                || existing.created_at != request.created_at
                || !origin_match
            {
                return Err(refuse(
                    "RETRY_KEY_CONFLICT",
                    "This request identity belongs to another origin. Nothing was sent.",
                ));
            }
        }

        // Idempotent retry check.
        if let Some(retry) = record
            .operations
            .iter()
            .find(|o| o.request_id == request.id && o.retry_key == operation.retry_key)
        {
            if retry.id != operation.id
                || retry.digest != operation.digest
                || retry.confirmed_stop != operation.confirmed_stop
                || retry.target != operation.target
            {
                return Err(refuse(
                    "RETRY_KEY_CONFLICT",
                    "This operation identity changed. Read the original receipt.",
                ));
            }
            return Ok((retry.clone(), true));
        }

        // Authority & watch fence check for new operations.
        self.check_remote_authority(
            &record,
            operation,
            master,
            client_id,
            request.standing_watch_id.as_deref(),
        )?;

        // Request state check (a closed remote request reopens on a new operation; a stopped one stays stopped except confirmedStop).
        let is_confirmed_stop = operation.action == "stop"
            && operation.confirmed_stop == Some(true)
            && existing_req.is_some_and(|r| {
                r.participants.iter().any(|p| {
                    p.target == operation.target
                        && p.started_by == "watcher"
                        && p.state == "participating"
                })
            });
        let reopens = existing_req.is_some_and(|r| r.state == "closed");
        if let Some(existing) = existing_req {
            if existing.state != "active" && !reopens && !is_confirmed_stop {
                return Err(refuse(
                    "REQUEST_NOT_ACTIVE",
                    "This request is not active. Only a user Send to Watcher can start a request.",
                ));
            }
        }

        let is_start = matches!(call, WatcherControlCall::StartThread(_));
        let is_send = matches!(call, WatcherControlCall::SendToThread(_));
        let is_stop = matches!(call, WatcherControlCall::StopThread(_));

        let stops_queued_check = is_stop
            && self
                .runtime
                .lock()
                .unwrap()
                .check_queue
                .iter()
                .any(|c| c.target == operation.target && c.waiting.is_some());

        let threads = shell
            .get("host")
            .and_then(|h| h.get("threads"))
            .and_then(Value::as_array);
        let thread = threads.and_then(|arr| {
            arr.iter().find(|t| {
                t.get("id").and_then(Value::as_str) == Some(operation.target.thread_id.as_str())
            })
        });

        if is_start && thread.is_some() {
            return Err(refuse(
                "TARGET_CHANGED",
                "That thread identity already exists. Nothing was started.",
            ));
        }

        if !is_start && !stops_queued_check {
            let Some(t) = thread else {
                return Err(refuse(
                    "UNKNOWN_TARGET",
                    "That thread is unavailable. Read the thread list again.",
                ));
            };
            self.check_protected_thread(t)?;
            self.check_not_delegated(shell, t, call.name())?;
            if !is_thread_connected(shell, t) {
                return Err(refuse_retryable(
                    "HOST_DISCONNECTED",
                    "This thread is disconnected. Reconnect it before sending.",
                ));
            }
        }

        // Standing watch & takeover checks.
        let watched_target = record
            .watches
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .find(|w| w.target == operation.target);
        if !watched_target.is_some()
            && request.standing_watch_id.is_none()
            && record.requests.iter().any(|r| {
                r.participants
                    .iter()
                    .any(|p| p.target == operation.target && p.state == "taken-over")
            })
        {
            return Err(refuse(
                "THREAD_TAKEN_OVER",
                "The user took over this thread. Read it before sending again.",
            ));
        }
        if let Some(ref sw_id) = request.standing_watch_id {
            let watch = record
                .watches
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .find(|w| w.id == *sw_id && w.target == operation.target);
            let Some(watch) = watch else {
                return Err(refuse(
                    "REQUEST_NOT_ACTIVE",
                    "This thread is no longer watched. Nothing was sent.",
                ));
            };
            if operation.generation != watch.generation {
                return Err(refuse(
                    "THREAD_TAKEN_OVER",
                    "This watch changed. Read the thread before sending again.",
                ));
            }
        }

        // Participant state checks.
        let prev_participant = existing_req
            .and_then(|r| r.participants.iter().find(|p| p.target == operation.target));
        if is_send {
            if prev_participant.is_some_and(|p| p.state == "relinquished") {
                return Err(refuse(
                    "REQUEST_NOT_ACTIVE",
                    "Watcher settled this participation. It will not send another prompt for this request.",
                ));
            }
            if prev_participant.is_some_and(|p| p.automation_stopped == Some(true)) {
                return Err(refuse(
                    "REQUEST_NOT_ACTIVE",
                    "Watcher stopped this participation. It will not send another prompt for this request.",
                ));
            }
        }

        // Per-operation admission checks.
        match call {
            WatcherControlCall::StartThread(create) => {
                let project = shell
                    .get("host")
                    .and_then(|h| h.get("projects"))
                    .and_then(Value::as_array)
                    .and_then(|arr| {
                        arr.iter().find(|p| {
                            p.get("id").and_then(Value::as_str) == Some(create.project.project_id.as_str())
                        })
                    });
                if project.is_none() {
                    return Err(refuse(
                        "UNKNOWN_TARGET",
                        "That project is unavailable. Read the project list again.",
                    ));
                }
                let Some(ref model_id) = create.model_id else {
                    return Err(refuse(
                        "INVALID_INPUT",
                        "Name the worker model for this start. Nothing was started.",
                    ));
                };
                self.check_permission(
                    shell,
                    model_id,
                    create.permission.as_ref(),
                    ceiling,
                    may_answer,
                )?;
                // Verify copy choices when naming existing-worktree or baseRefChoiceId.
                let mut rt = self.runtime.lock().unwrap();
                rt.prune_pages();
                if let WatcherWorkingCopy::ExistingWorktree { ref choice_id } = create.working_copy
                {
                    if rt.copy_choices.get(choice_id).and_then(|c| c.path.as_ref()).is_none() {
                        return Err(refuse(
                            "WORKING_COPY_CHANGED",
                            "Read the working-copy choices again before starting this thread.",
                        ));
                    }
                }
                if let Some(ref base_id) = create.base_ref_choice_id {
                    if rt.copy_choices.get(base_id).and_then(|c| c.branch.as_ref()).is_none() {
                        return Err(refuse(
                            "WORKING_COPY_CHANGED",
                            "Read the working-copy choices again before starting this thread.",
                        ));
                    }
                }
            }
            WatcherControlCall::SendToThread(sent) => {
                let t = thread.unwrap();
                self.check_pending_requests(t)?;
                let delivery = sent.delivery.as_deref().unwrap_or("now");
                if let Some(ref fence_turn) = sent.expected_turn_id {
                    let live_turn = t
                        .get("lastTurn")
                        .and_then(|lt| lt.get("id"))
                        .and_then(Value::as_str);
                    if delivery == "steer" && live_turn != Some(fence_turn.as_str()) {
                        return Err(refuse(
                            "STEER_UNAVAILABLE",
                            "The running turn changed. Nothing was steered.",
                        ));
                    }
                }
                self.check_human_turn(t, &record, Some(delivery))?;
                if let Some(ref expected_head) = sent.expected_last_user_message_id {
                    if native_head(t).as_deref() != Some(expected_head.as_str()) {
                        return Err(refuse(
                            "TARGET_CHANGED",
                            "This thread received another instruction. Read it before sending.",
                        ));
                    }
                }
                if delivery == "now" && is_thread_turn_running(t) {
                    return Err(refuse("THREAD_BUSY", RUNNING_TURN_HOLD));
                }
                if delivery == "steer" {
                    if !is_thread_turn_running(t) {
                        return Err(refuse(
                            "STEER_UNAVAILABLE",
                            "There is no running turn to steer. Send normally instead.",
                        ));
                    }
                    if !thread_supports_steer(shell, t) {
                        return Err(refuse(
                            "STEER_UNAVAILABLE",
                            "Steer needs a supported, confirmed running turn. Read the thread and its turn first.",
                        ));
                    }
                }
            }
            WatcherControlCall::StopThread(_) => {
                if let Some(t) = thread {
                    if request.standing_watch_id.is_some() && self.human_turn_running(t, &record) {
                        return Err(refuse_retryable(
                            "THREAD_BUSY",
                            "The user’s own turn in this thread is running, and Watcher does not stop it. Nothing was stopped.",
                        ));
                    }
                }
            }
            WatcherControlCall::SettleThread(_) => {
                let t = thread.unwrap();
                self.check_settlement(shell, t)?;
                let has_unresolved = record.operations.iter().any(|o| {
                    o.target == operation.target
                        && matches!(
                            o.delivery_state.as_str(),
                            "queued" | "dispatching" | "uncertain"
                        )
                });
                if has_unresolved {
                    return Err(refuse(
                        "DELIVERY_UNCERTAIN",
                        "This thread still has an outstanding delivery. Reconcile it before settling.",
                    ));
                }
            }
        }

        // Prompt budget check (4 prompts per Watcher turn / request per thread).
        if (is_start || is_send)
            && self.prompt_count(
                &record,
                &operation.target,
                operation.prompt_turn_id.as_deref(),
                &request.id,
            ) >= WATCHER_PROMPTS_PER_THREAD
        {
            return Err(refuse(
                "PROMPT_LIMIT",
                "This thread has received four prompts in this Watcher turn. A retry or another request cannot renew the limit.",
            ));
        }

        // Check generation and unique operation identifiers.
        let expected_gen = prev_participant
            .map(|p| p.generation)
            .or_else(|| watched_target.map(|w| w.generation))
            .unwrap_or(0);
        let duplicate_id = record.operations.iter().any(|o| {
            o.id == operation.id
                || o.receipt_id == operation.receipt_id
                || o.card_id == operation.card_id
                || (operation.draft_id.is_some() && o.draft_id == operation.draft_id)
                || (operation.message_id.is_some() && o.message_id == operation.message_id)
                || (operation.creation_receipt_id.is_some()
                    && o.creation_receipt_id == operation.creation_receipt_id)
                || (operation.first_prompt_receipt_id.is_some()
                    && o.first_prompt_receipt_id == operation.first_prompt_receipt_id)
        });
        if operation.generation != expected_gen || duplicate_id {
            return Err(refuse(
                "TARGET_CHANGED",
                "This operation identity or ownership generation changed. Nothing was sent.",
            ));
        }

        // Persist the admitted request, promptTurn, participant, operation, and reservation.
        let admitted = self.update_record(|next| {
            if let Some(ref pt_id) = operation.prompt_turn_id {
                let turns = next.prompt_turns.get_or_insert_with(Vec::new);
                if let Some(existing_turn) = turns.iter().find(|t| t.id == *pt_id) {
                    if existing_turn.watcher != master.target {
                        return Err(refuse(
                            "RETRY_KEY_CONFLICT",
                            "This turn budget belongs to another Watcher. Nothing was sent.",
                        ));
                    }
                } else {
                    turns.push(WatcherPromptTurn {
                        id: pt_id.clone(),
                        watcher: master.target.clone(),
                        created_at: now_iso(),
                        root_user_message_id: None,
                        native_turn_id: None,
                        previous_native_turn_id: None,
                    });
                }
            }

            let req_entry = match next.requests.iter_mut().find(|r| r.id == request.id) {
                Some(r) => {
                    if r.state == "closed" {
                        r.state = "active".into();
                        r.closed_at = None;
                    }
                    r
                }
                None => {
                    let remote_origin = json!({
                        "clientId": client_id,
                        "master": master,
                        "creationOperationId": master.creation_operation_id,
                        "ceiling": ceiling,
                    });
                    next.requests.push(WatcherRequest {
                        id: request.id.clone(),
                        watcher: master.target.clone(),
                        root_user_message_id: request.root_user_message_id.clone(),
                        standing_watch_id: request.standing_watch_id.clone(),
                        display_prompt: None,
                        handover: None,
                        phone_origin: None,
                        paired_permission_ceiling: None,
                        remote_origin: Some(remote_origin),
                        state: "active".into(),
                        created_at: request.created_at.clone(),
                        closed_at: None,
                        user_followups: None,
                        participants: Vec::new(),
                    });
                    next.requests.last_mut().unwrap()
                }
            };

            let participant = match req_entry
                .participants
                .iter_mut()
                .find(|p| p.target == operation.target)
            {
                Some(p) => p,
                None => {
                    req_entry.participants.push(WatcherParticipant {
                        request_id: request.id.clone(),
                        started_by: if is_start { "watcher" } else { "user" }.into(),
                        generation: operation.generation,
                        state: "participating".into(),
                        takeover: None,
                        automation_stopped: None,
                        target: operation.target.clone(),
                        last_user_message_id: thread.map(native_head),
                        parked: None,
                        prompt_count: 0,
                    });
                    req_entry.participants.last_mut().unwrap()
                }
            };
            if is_start || is_send {
                participant.prompt_count = participant.prompt_count.saturating_add(1);
            }

            let mut op_to_store = without_outcome(operation.clone());
            op_to_store.updated_at = now_iso();
            next.operations.push(op_to_store.clone());

            if is_start || is_send {
                next.reservations.retain(|r| r.target != operation.target);
                next.reservations.push(WatcherReservation {
                    target: operation.target.clone(),
                    request_id: request.id.clone(),
                    operation_id: operation.id.clone(),
                    generation: operation.generation,
                    reason: if is_start { "creation" } else { "queued" }.into(),
                });
            }

            // Record remote master entry if not yet present.
            let masters = next.remote_masters.get_or_insert_with(Vec::new);
            if let Some(m) = masters.iter_mut().find(|m| {
                m.get("clientId").and_then(Value::as_str) == Some(client_id)
                    && m.get("masterHostId").and_then(Value::as_str)
                        == Some(master.target.host_id.as_str())
            }) {
                if let Some(obj) = m.as_object_mut() {
                    obj.insert(
                        "creationOperationId".into(),
                        Value::String(master.creation_operation_id.clone()),
                    );
                    obj.insert("createdAt".into(), Value::String(master.created_at.clone()));
                }
            } else if masters.len() < 1_000 {
                masters.push(json!({
                    "clientId": client_id,
                    "masterHostId": master.target.host_id,
                    "creationOperationId": master.creation_operation_id,
                    "createdAt": master.created_at,
                }));
            }

            Ok(op_to_store)
        })?;

        Ok((admitted, false))
    }

    async fn execute_operation(
        &self,
        op: &WatcherOperation,
        call: &WatcherControlCall,
        client: &ClientContext,
        may_answer: bool,
    ) -> Result<Value, WatcherRefusal> {
        match call {
            WatcherControlCall::StartThread(create) => {
                // Handle check queue (`watcher-check-queue`): one check runs at a time on this host.
                if create.check == Some(true) {
                    let is_waiting = {
                        let mut rt = self.runtime.lock().unwrap();
                        if rt.check_queue.is_empty() {
                            rt.check_queue.push_back(QueuedCheck {
                                operation_id: op.id.clone(),
                                target: op.target.clone(),
                                waiting: None,
                            });
                            false
                        } else {
                            rt.check_queue.push_back(QueuedCheck {
                                operation_id: op.id.clone(),
                                target: op.target.clone(),
                                waiting: Some(WaitingCheckPayload {
                                    input: (**create).clone(),
                                    client: client.clone(),
                                    may_answer,
                                }),
                            });
                            true
                        }
                    };
                    if is_waiting {
                        let shell = self.refresh_shell(may_answer).await?;
                        let record = self.record_snapshot();
                        let live = record
                            .operations
                            .iter()
                            .find(|o| o.id == op.id)
                            .unwrap_or(op);
                        return Ok(self.operation_result(&shell, &record, call, live));
                    }
                }
                self.execute_start_thread(op, create, client, may_answer)
                    .await
            }
            WatcherControlCall::SendToThread(sent) => {
                let delivery = sent.delivery.as_deref().unwrap_or("now").to_string();
                let send_res = self
                    .coordinator
                    .watcher_send_message(
                        op.target.thread_id.clone(),
                        sent.text.clone(),
                        op.draft_id.clone().unwrap_or_default(),
                        op.message_id.clone().unwrap_or_default(),
                        delivery,
                        client.clone(),
                    )
                    .await;
                self.commit_send_outcome(op, send_res)?;
                let shell = self.refresh_shell(may_answer).await?;
                self.observe_shell(&shell);
                let record = self.record_snapshot();
                let live = record
                    .operations
                    .iter()
                    .find(|o| o.id == op.id)
                    .unwrap_or(op);
                Ok(self.operation_result(&shell, &record, call, live))
            }
            WatcherControlCall::StopThread(_) => {
                // First check if this stop targets a waiting check in the check queue (`watcher-check-stop`).
                let stopped_queued_op_id: Option<String> = {
                    let mut rt = self.runtime.lock().unwrap();
                    let pos = rt
                        .check_queue
                        .iter()
                        .position(|c| c.target == op.target && c.waiting.is_some());
                    pos.and_then(|idx| rt.check_queue.remove(idx).map(|c| c.operation_id))
                };
                if let Some(waiting_op_id) = stopped_queued_op_id {
                    let _ = self.update_record(|next| {
                        if let Some(start_op) =
                            next.operations.iter_mut().find(|o| o.id == waiting_op_id)
                        {
                            if start_op.delivery_state == "queued" {
                                start_op.delivery_state = "failed".into();
                                start_op.refusal_code = Some("REQUEST_NOT_ACTIVE".into());
                                start_op.updated_at = now_iso();
                            }
                        }
                        if let Some(stop_op) = next.operations.iter_mut().find(|o| o.id == op.id) {
                            stop_op.delivery_state = "accepted".into();
                            stop_op.updated_at = now_iso();
                        }
                        next.reservations.retain(|r| r.target != op.target);
                        Ok(())
                    });
                    let shell = self.refresh_shell(may_answer).await?;
                    let record = self.record_snapshot();
                    let live = record
                        .operations
                        .iter()
                        .find(|o| o.id == op.id)
                        .unwrap_or(op);
                    return Ok(self.operation_result(&shell, &record, call, live));
                }

                // Increment watch/participant generation, mark automationStopped, fail queued ops, cancel queued followups.
                let cancelled_drafts: HashSet<String> = self.update_record(|next| {
                    let req_watch_id = next
                        .requests
                        .iter()
                        .find(|r| r.id == op.request_id)
                        .and_then(|r| r.standing_watch_id.clone())
                        .or_else(|| op.standing_watch_id.clone());
                    if let Some(ref wid) = req_watch_id {
                        if let Some(w) = next
                            .watches
                            .as_deref_mut()
                            .unwrap_or(&mut [])
                            .iter_mut()
                            .find(|w| w.id == *wid)
                        {
                            w.generation = w.generation.saturating_add(1);
                        }
                    }
                    for req in &mut next.requests {
                        for part in &mut req.participants {
                            if part.target == op.target && part.state == "participating" {
                                part.generation = part.generation.saturating_add(1);
                                part.automation_stopped = Some(true);
                            }
                        }
                    }
                    let new_gen = next
                        .requests
                        .iter()
                        .find(|r| r.id == op.request_id)
                        .and_then(|r| r.participants.iter().find(|p| p.target == op.target))
                        .map(|p| p.generation)
                        .unwrap_or(op.generation);
                    if let Some(saved) = next.operations.iter_mut().find(|o| o.id == op.id) {
                        saved.generation = new_gen;
                    }
                    let mut drafts = HashSet::new();
                    for other in &mut next.operations {
                        if other.id != op.id && other.target == op.target {
                            if let Some(ref d) = other.draft_id {
                                drafts.insert(d.clone());
                            }
                            if other.delivery_state == "queued" {
                                other.delivery_state = "failed".into();
                                other.refusal_code = Some("REQUEST_NOT_ACTIVE".into());
                                other.updated_at = now_iso();
                            }
                        }
                    }
                    Ok(drafts)
                })?;

                if !cancelled_drafts.is_empty() {
                    let _ = self
                        .coordinator
                        .watcher_cancel_queued_followups(cancelled_drafts)
                        .await;
                }
                let interrupt_res = self
                    .coordinator
                    .watcher_interrupt(op.target.thread_id.clone(), client.clone())
                    .await;
                let _ = self.update_record(|next| {
                    if let Some(saved) = next.operations.iter_mut().find(|o| o.id == op.id) {
                        match &interrupt_res {
                            Ok(()) => {
                                saved.delivery_state = "accepted".into();
                                saved.refusal_code = None;
                            }
                            Err(_) => {
                                saved.delivery_state = "failed".into();
                                saved.refusal_code = Some("PROVIDER_UNAVAILABLE".into());
                            }
                        }
                        saved.updated_at = now_iso();
                    }
                    Ok(())
                });
                let shell = self.refresh_shell(may_answer).await?;
                self.observe_shell(&shell);
                let record = self.record_snapshot();
                let live = record
                    .operations
                    .iter()
                    .find(|o| o.id == op.id)
                    .unwrap_or(op);
                Ok(self.operation_result(&shell, &record, call, live))
            }
            WatcherControlCall::SettleThread(_) => {
                let settle_res = self
                    .coordinator
                    .watcher_settle_thread(op.target.thread_id.clone(), true)
                    .await;
                let _ = self.update_record(|next| {
                    if let Some(saved) = next.operations.iter_mut().find(|o| o.id == op.id) {
                        match &settle_res {
                            Ok(()) => {
                                saved.delivery_state = "accepted".into();
                                saved.refusal_code = None;
                            }
                            Err(_) => {
                                saved.delivery_state = "failed".into();
                                saved.refusal_code = Some("PROVIDER_UNAVAILABLE".into());
                            }
                        }
                        saved.updated_at = now_iso();
                    }
                    if settle_res.is_ok() {
                        if let Some(req) = next.requests.iter_mut().find(|r| r.id == op.request_id)
                        {
                            if let Some(part) =
                                req.participants.iter_mut().find(|p| p.target == op.target)
                            {
                                part.state = "relinquished".into();
                            }
                        }
                        next.reservations.retain(|r| r.target != op.target);
                    }
                    Ok(())
                });
                let shell = self.refresh_shell(may_answer).await?;
                self.observe_shell(&shell);
                let record = self.record_snapshot();
                let live = record
                    .operations
                    .iter()
                    .find(|o| o.id == op.id)
                    .unwrap_or(op);
                Ok(self.operation_result(&shell, &record, call, live))
            }
        }
    }

    async fn execute_start_thread(
        &self,
        op: &WatcherOperation,
        create: &StartThreadInput,
        client: &ClientContext,
        may_answer: bool,
    ) -> Result<Value, WatcherRefusal> {
        let shell = self.refresh_shell(may_answer).await?;
        let record = self.record_snapshot();
        let req_ceiling = record
            .requests
            .iter()
            .find(|r| r.id == op.request_id)
            .and_then(|r| r.remote_origin.as_ref())
            .and_then(remote_origin_fields)
            .map(|(_, _, _, c)| c)
            .unwrap_or_else(|| "approval-required".into());

        let model_id = create.model_id.as_deref().unwrap_or("");
        let perm = match self.check_permission(
            &shell,
            model_id,
            create.permission.as_ref(),
            &req_ceiling,
            may_answer,
        ) {
            Ok(p) => p,
            Err(err) => {
                self.mark_operation_failed(&op.id, err.code);
                let latest_shell = self.refresh_shell(may_answer).await.unwrap_or(shell);
                let rec = self.record_snapshot();
                let live = rec.operations.iter().find(|o| o.id == op.id).unwrap_or(op);
                return Ok(self.operation_result(
                    &latest_shell,
                    &rec,
                    &WatcherControlCall::StartThread(Box::new(create.clone())),
                    live,
                ));
            }
        };

        // Resolve working copy choices.
        let (wc_mode, existing_path, base_branch) = match self.resolve_working_copy(&shell, create)
        {
            Ok(v) => v,
            Err(err) => {
                self.mark_operation_failed(&op.id, err.code);
                let latest_shell = self.refresh_shell(may_answer).await.unwrap_or(shell);
                let rec = self.record_snapshot();
                let live = rec.operations.iter().find(|o| o.id == op.id).unwrap_or(op);
                return Ok(self.operation_result(
                    &latest_shell,
                    &rec,
                    &WatcherControlCall::StartThread(Box::new(create.clone())),
                    live,
                ));
            }
        };

        let mut create_cmd = Map::new();
        create_cmd.insert("type".into(), Value::String("create-thread".into()));
        create_cmd.insert("threadId".into(), Value::String(op.target.thread_id.clone()));
        create_cmd.insert(
            "projectId".into(),
            Value::String(create.project.project_id.clone()),
        );
        create_cmd.insert("title".into(), Value::String(create.title.clone()));
        create_cmd.insert("titleSource".into(), Value::String("user".into()));
        create_cmd.insert("modelId".into(), Value::String(model_id.to_string()));
        if let Some(ref eff) = create.reasoning_effort {
            create_cmd.insert("reasoningEffort".into(), Value::String(eff.clone()));
        }
        if let Some(Some(ref sp)) = create.speed {
            create_cmd.insert("speed".into(), Value::String(sp.clone()));
        }
        match perm {
            WatcherPermission::Runtime { mode } => {
                create_cmd.insert("runtimeMode".into(), Value::String(mode));
            }
            WatcherPermission::Provider { choice_id } => {
                create_cmd.insert("providerMode".into(), Value::String(choice_id));
            }
        }
        create_cmd.insert("workingCopy".into(), Value::String(wc_mode.into()));
        if let Some(path) = existing_path {
            create_cmd.insert("existingWorktreePath".into(), Value::String(path));
        }
        if let Some(branch) = base_branch {
            create_cmd.insert("baseBranch".into(), Value::String(branch));
        }

        if self.coordinator.watcher_create_thread(create_cmd).await.is_err() {
            self.mark_operation_failed(&op.id, "PROVIDER_UNAVAILABLE");
            let latest_shell = self.refresh_shell(may_answer).await.unwrap_or(shell);
            let rec = self.record_snapshot();
            let live = rec.operations.iter().find(|o| o.id == op.id).unwrap_or(op);
            return Ok(self.operation_result(
                &latest_shell,
                &rec,
                &WatcherControlCall::StartThread(Box::new(create.clone())),
                live,
            ));
        }

        let send_res = self
            .coordinator
            .watcher_send_message(
                op.target.thread_id.clone(),
                create.first_prompt.clone(),
                op.draft_id.clone().unwrap_or_default(),
                op.message_id.clone().unwrap_or_default(),
                "now".into(),
                client.clone(),
            )
            .await;
        self.commit_send_outcome(op, send_res)?;
        let latest_shell = self.refresh_shell(may_answer).await?;
        self.observe_shell(&latest_shell);
        let rec = self.record_snapshot();
        let live = rec.operations.iter().find(|o| o.id == op.id).unwrap_or(op);
        Ok(self.operation_result(
            &latest_shell,
            &rec,
            &WatcherControlCall::StartThread(Box::new(create.clone())),
            live,
        ))
    }

    fn resolve_working_copy(
        &self,
        shell: &Value,
        create: &StartThreadInput,
    ) -> Result<(&'static str, Option<String>, Option<String>), WatcherRefusal> {
        if matches!(create.working_copy, WatcherWorkingCopy::Shared {})
            && create.base_ref_choice_id.is_none()
        {
            return Ok(("shared", None, None));
        }
        let project_path = shell
            .get("host")
            .and_then(|h| h.get("projects"))
            .and_then(Value::as_array)
            .and_then(|arr| {
                arr.iter().find(|p| {
                    p.get("id").and_then(Value::as_str) == Some(create.project.project_id.as_str())
                })
            })
            .and_then(|p| p.get("path"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                refuse(
                    "UNKNOWN_TARGET",
                    "That project is unavailable. Read the project list again.",
                )
            })?;
        let options = working_copy_options(project_path);
        let revision = json_digest(&options);
        if !options.is_git && !matches!(create.working_copy, WatcherWorkingCopy::Shared {}) {
            return Err(refuse(
                "WORKING_COPY_CHANGED",
                "The working-copy choices changed. Read them again. Nothing was started.",
            ));
        }
        let mut rt = self.runtime.lock().unwrap();
        rt.prune_pages();
        let existing_path = match &create.working_copy {
            WatcherWorkingCopy::ExistingWorktree { choice_id } => {
                let entry = rt.copy_choices.get(choice_id).ok_or_else(|| {
                    refuse(
                        "WORKING_COPY_CHANGED",
                        "The working-copy choices changed. Read them again. Nothing was started.",
                    )
                })?;
                if entry.project_id != create.project.project_id
                    || entry.revision != revision
                    || entry.path.is_none()
                    || !options
                        .worktrees
                        .iter()
                        .any(|w| Some(w.path.as_str()) == entry.path.as_deref())
                {
                    return Err(refuse(
                        "WORKING_COPY_CHANGED",
                        "The working-copy choices changed. Read them again. Nothing was started.",
                    ));
                }
                let p = entry.path.clone().unwrap();
                let occupied = shell
                    .get("host")
                    .and_then(|h| h.get("threads"))
                    .and_then(Value::as_array)
                    .is_some_and(|arr| {
                        arr.iter().any(|t| {
                            t.get("worktree")
                                .and_then(|w| w.get("path"))
                                .and_then(Value::as_str)
                                == Some(p.as_str())
                        })
                    });
                if occupied {
                    return Err(refuse(
                        "WORKING_COPY_UNAVAILABLE",
                        "That working copy is already used by a thread.",
                    ));
                }
                Some(p)
            }
            _ => None,
        };
        let base_branch = match &create.base_ref_choice_id {
            Some(base_id) => {
                let entry = rt.copy_choices.get(base_id).ok_or_else(|| {
                    refuse(
                        "WORKING_COPY_CHANGED",
                        "The working-copy choices changed. Read them again. Nothing was started.",
                    )
                })?;
                if entry.project_id != create.project.project_id
                    || entry.revision != revision
                    || entry.branch.is_none()
                {
                    return Err(refuse(
                        "WORKING_COPY_CHANGED",
                        "The working-copy choices changed. Read them again. Nothing was started.",
                    ));
                }
                entry.branch.clone()
            }
            None => None,
        };
        let mode = match create.working_copy {
            WatcherWorkingCopy::Shared {} => "shared",
            _ => "independent",
        };
        Ok((mode, existing_path, base_branch))
    }

    fn commit_send_outcome(
        &self,
        op: &WatcherOperation,
        send_res: Result<(String, Option<String>), crate::coordinator::CoordinatorError>,
    ) -> Result<(), WatcherRefusal> {
        let _ = self.update_record(|next| {
            let mut should_refund = false;
            let mut op_request_id = op.request_id.clone();
            let mut op_target = op.target.clone();
            if let Some(saved) = next.operations.iter_mut().find(|o| o.id == op.id) {
                op_request_id = saved.request_id.clone();
                op_target = saved.target.clone();
                match &send_res {
                    Ok((status, item_id)) => {
                        saved.delivery_state = match status.as_str() {
                            "queued" => "queued".into(),
                            "unconfirmed" | "uncertain" => "uncertain".into(),
                            "failed" => "failed".into(),
                            _ => "accepted".into(),
                        };
                        if let Some(id) = item_id {
                            saved.item_id = Some(id.clone());
                        }
                        if saved.delivery_state == "failed" {
                            saved.refusal_code = Some("PROVIDER_UNAVAILABLE".into());
                            if saved.prompt_refunded != Some(true) {
                                saved.prompt_refunded = Some(true);
                                should_refund = true;
                            }
                        } else {
                            saved.refusal_code = None;
                        }
                    }
                    Err(_) => {
                        saved.delivery_state = "failed".into();
                        saved.refusal_code = Some("PROVIDER_UNAVAILABLE".into());
                        if saved.prompt_refunded != Some(true) {
                            saved.prompt_refunded = Some(true);
                            should_refund = true;
                        }
                    }
                }
                saved.updated_at = now_iso();
            }
            if should_refund {
                if let Some(req) = next.requests.iter_mut().find(|r| r.id == op_request_id) {
                    if let Some(part) = req.participants.iter_mut().find(|p| p.target == op_target)
                    {
                        part.prompt_count = part.prompt_count.saturating_sub(1);
                    }
                }
            }
            Ok(())
        });
        Ok(())
    }

    fn mark_operation_failed(&self, operation_id: &str, code: &str) {
        let _ = self.update_record(|next| {
            let mut refund: Option<(String, WatcherThreadTarget)> = None;
            if let Some(saved) = next.operations.iter_mut().find(|o| o.id == operation_id) {
                saved.delivery_state = "failed".into();
                saved.refusal_code = Some(code.into());
                saved.updated_at = now_iso();
                if (saved.action == "start" || saved.action == "send")
                    && saved.prompt_refunded != Some(true)
                    && !matches!(
                        code,
                        "THREAD_TAKEN_OVER" | "REQUEST_NOT_ACTIVE" | "NOT_CURRENT_WATCHER"
                    )
                {
                    saved.prompt_refunded = Some(true);
                    refund = Some((saved.request_id.clone(), saved.target.clone()));
                }
                next.reservations.retain(|r| r.operation_id != operation_id);
            }
            if let Some((req_id, target)) = refund {
                if let Some(req) = next.requests.iter_mut().find(|r| r.id == req_id) {
                    if let Some(part) = req.participants.iter_mut().find(|p| p.target == target) {
                        part.prompt_count = part.prompt_count.saturating_sub(1);
                    }
                }
            }
            Ok(())
        });
        // Also remove from check queue if it was running at the front.
        let mut rt = self.runtime.lock().unwrap();
        rt.check_queue.retain(|c| c.operation_id != operation_id);
    }

    // -----------------------------------------------------------------------
    // `watcher-read` (`readRemote`) & `remoteProjection`
    // -----------------------------------------------------------------------

    pub async fn read_remote(&self, raw: Value, client_id: &str, may_answer: bool) -> Value {
        self.runtime
            .lock()
            .unwrap()
            .remote_answers
            .insert(client_id.to_string(), may_answer);

        match self.read_remote_inner(raw, client_id, may_answer).await {
            Ok(val) => watcher_result_for_host_v1(val),
            Err(err) => err.to_value(),
        }
    }

    async fn read_remote_inner(
        &self,
        raw: Value,
        client_id: &str,
        may_answer: bool,
    ) -> Result<Value, WatcherRefusal> {
        let packet: WatcherHostRead = serde_json::from_value(raw).map_err(|_| {
            refuse(
                "INVALID_INPUT",
                "This Watcher read could not be completed.",
            )
        })?;

        let WatcherHostRead {
            master,
            standing_watches,
            stopped_requests,
            call,
            outcomes,
            adopt,
        } = packet;

        if !is_valid_uuid(&master.target.host_id)
            || !is_valid_uuid(&master.creation_operation_id)
            || !WATCHER_PROVIDERS.contains(&master.provider.as_str())
        {
            return Err(refuse(
                "INVALID_INPUT",
                "This Watcher read could not be completed.",
            ));
        }

        if let Some(ref sw) = standing_watches {
            if sw.len() > WATCHER_STANDING_WATCHES_MAX {
                return Err(refuse(
                    "INVALID_INPUT",
                    "Too many standing watches in one read.",
                ));
            }
        }
        if let Some(ref sr) = stopped_requests {
            if sr.len() > 1_000 {
                return Err(refuse(
                    "INVALID_INPUT",
                    "Too many stopped requests in one read.",
                ));
            }
        }

        self.check_caller_host_binding(client_id, &master.target.host_id)?;
        let shell = self.refresh_shell(may_answer).await?;

        if adopt == Some(true) {
            let _guard = self.tx_lock.lock().await;
            self.adopt_remote_requests(&master, client_id)?;
        }
        if let Some(watches) = standing_watches {
            let _guard = self.tx_lock.lock().await;
            let cancelled = self.sync_remote_watches(&shell, &master, watches, client_id)?;
            if !cancelled.is_empty() {
                let _ = self
                    .coordinator
                    .watcher_cancel_queued_followups(cancelled)
                    .await;
            }
            self.notify();
        }
        if let Some(stops) = stopped_requests {
            if !stops.is_empty() {
                let _guard = self.tx_lock.lock().await;
                let cancelled = self.stop_remote_requests(&master, stops, client_id)?;
                if !cancelled.is_empty() {
                    let _ = self
                        .coordinator
                        .watcher_cancel_queued_followups(cancelled)
                        .await;
                }
                self.notify();
            }
        }

        let Some(call) = call else {
            let proj = self.remote_projection(&master, client_id);
            return Ok(serde_json::to_value(proj).unwrap_or(Value::Null));
        };

        match call {
            WatcherReadCall::ReadOperation(input) => {
                if !is_valid_uuid(&input.operation_id) {
                    return Err(refuse(
                        "INVALID_INPUT",
                        "Invalid operation ID.",
                    ));
                }
                let op = {
                    let _guard = self.tx_lock.lock().await;
                    self.migrate_remote_client(&master, client_id)?;
                    let record = self.record_snapshot();
                    let found = record
                        .operations
                        .iter()
                        .find(|o| o.id == input.operation_id)
                        .cloned();
                    if let Some(op) = found {
                        let owned = record.requests.iter().any(|r| {
                            r.id == op.request_id
                                && r.watcher == master.target
                                && r.remote_origin
                                    .as_ref()
                                    .and_then(remote_origin_fields)
                                    .is_some_and(|(cid, m, cop, _)| {
                                        self.owns_remote_origin(
                                            &cid,
                                            &m.target.host_id,
                                            client_id,
                                            &master.target.host_id,
                                        ) && cop == master.creation_operation_id
                                    })
                        });
                        if !owned {
                            return Err(refuse(
                                "UNKNOWN_OPERATION",
                                "That operation does not belong to this desktop.",
                            ));
                        }
                        op
                    } else {
                        // Fence exact negative read in `remoteAbsences`.
                        self.update_record(|next| {
                            let absences = next.remote_absences.get_or_insert_with(Vec::new);
                            if !absences.iter().any(|a| {
                                a.get("operationId").and_then(Value::as_str)
                                    == Some(input.operation_id.as_str())
                            }) {
                                if absences.len() >= 1_000 {
                                    return Err(refuse(
                                        "DELIVERY_UNCERTAIN",
                                        "This host cannot keep track of another missing thread. That start or send stays unconfirmed.",
                                    ));
                                }
                                absences.push(json!({
                                    "operationId": input.operation_id,
                                    "master": master,
                                    "clientId": client_id,
                                    "observedAt": now_iso(),
                                }));
                            }
                            Ok(())
                        })?;
                        return Err(refuse(
                            "OPERATION_NOT_RECORDED",
                            "That operation was not recorded. Its identity is fenced against later admission.",
                        ));
                    }
                };
                self.read_operation_response(&shell, &op, outcomes == Some(true))
                    .await
            }
            WatcherReadCall::ListThreads(input) => self.list_threads(&shell, input),
            WatcherReadCall::ListProjects(input) => self.list_projects(&shell, input, may_answer),
            WatcherReadCall::ListWorkingCopies(input) => self.list_working_copies(&shell, input),
            WatcherReadCall::ReadThread(input) => self.read_thread(&shell, input).await,
        }
    }

    fn adopt_remote_requests(
        &self,
        master: &WatcherIdentity,
        client_id: &str,
    ) -> Result<(), WatcherRefusal> {
        let seen_key = format!(
            "{}:{}:{}:{}",
            client_id, master.target.host_id, master.target.thread_id, master.creation_operation_id
        );
        if self.runtime.lock().unwrap().adopted.contains(&seen_key)
            && !self.needs_remote_client_migration(
                &self.record_snapshot(),
                client_id,
                &master.target.host_id,
            )
        {
            return Ok(());
        }
        if master.target.host_id == self.host_id {
            return Err(refuse(
                "INVALID_INPUT",
                "A remote request must belong to its master computer.",
            ));
        }
        let pre_record = self.record_snapshot();
        self.check_remote_master(&pre_record, master, client_id)?;
        self.migrate_remote_client(master, client_id)?;
        let record = self.record_snapshot();

        let made_by_older = |req: &WatcherRequest| -> bool {
            let Some((cid, orig_master, _, _)) =
                req.remote_origin.as_ref().and_then(remote_origin_fields)
            else {
                return false;
            };
            cid == client_id
                && orig_master.target.host_id == master.target.host_id
                && orig_master.created_at < master.created_at
        };

        let has_moves = record.requests.iter().any(made_by_older)
            || record.watches.as_deref().unwrap_or(&[]).iter().any(|w| {
                w.remote_origin.as_ref().is_some_and(|o| {
                    o.client_id == client_id
                        && o.master_host_id == master.target.host_id
                        && o.master_created_at
                            .as_deref()
                            .is_some_and(|c| c < master.created_at.as_str())
                })
            });
        let retained_op = record
            .remote_masters
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .find(|m| {
                m.get("clientId").and_then(Value::as_str) == Some(client_id)
                    && m.get("masterHostId").and_then(Value::as_str)
                        == Some(master.target.host_id.as_str())
            })
            .and_then(|m| m.get("creationOperationId").and_then(Value::as_str))
            .map(ToString::to_string);

        if has_moves || retained_op.as_deref() != Some(master.creation_operation_id.as_str()) {
            self.update_record(|next| {
                let mut replaced_watchers: HashSet<String> = HashSet::new();
                for req in &mut next.requests {
                    if made_by_older(req) {
                        replaced_watchers.insert(req.watcher.key());
                        req.watcher = master.target.clone();
                        if let Some(obj) = req.remote_origin.as_mut().and_then(Value::as_object_mut)
                        {
                            obj.insert(
                                "master".into(),
                                serde_json::to_value(master).unwrap_or(Value::Null),
                            );
                            obj.insert(
                                "creationOperationId".into(),
                                Value::String(master.creation_operation_id.clone()),
                            );
                        }
                    }
                }
                if !replaced_watchers.is_empty() {
                    if let Some(ref mut turns) = next.prompt_turns {
                        for turn in turns.iter_mut() {
                            if replaced_watchers.contains(&turn.watcher.key()) {
                                turn.watcher = master.target.clone();
                            }
                        }
                    }
                }
                if let Some(ref mut watches) = next.watches {
                    for w in watches.iter_mut() {
                        if let Some(ref mut o) = w.remote_origin {
                            if o.client_id == client_id
                                && o.master_host_id == master.target.host_id
                                && o.master_created_at
                                    .as_deref()
                                    .is_none_or(|c| c < master.created_at.as_str())
                            {
                                o.master_creation_operation_id =
                                    Some(master.creation_operation_id.clone());
                                o.master_created_at = Some(master.created_at.clone());
                            }
                        }
                    }
                }
                let masters = next.remote_masters.get_or_insert_with(Vec::new);
                if let Some(existing) = masters.iter_mut().find(|m| {
                    m.get("clientId").and_then(Value::as_str) == Some(client_id)
                        && m.get("masterHostId").and_then(Value::as_str)
                            == Some(master.target.host_id.as_str())
                }) {
                    if let Some(obj) = existing.as_object_mut() {
                        obj.insert(
                            "creationOperationId".into(),
                            Value::String(master.creation_operation_id.clone()),
                        );
                        obj.insert("createdAt".into(), Value::String(master.created_at.clone()));
                    }
                } else {
                    if masters.len() >= 1_000 {
                        return Err(refuse(
                            "HOST_FEATURE_UNAVAILABLE",
                            "This host cannot retain another Watcher desktop. Use a desktop already paired here.",
                        ));
                    }
                    masters.push(json!({
                        "clientId": client_id,
                        "masterHostId": master.target.host_id,
                        "creationOperationId": master.creation_operation_id,
                        "createdAt": master.created_at,
                    }));
                }
                Ok(())
            })?;
        }

        let mut rt = self.runtime.lock().unwrap();
        if rt.adopted.len() >= 1_000 {
            rt.adopted.clear();
        }
        rt.adopted.insert(seen_key);
        Ok(())
    }

    fn sync_remote_watches(
        &self,
        shell: &Value,
        master: &WatcherIdentity,
        watches: Vec<WatcherStandingWatch>,
        client_id: &str,
    ) -> Result<HashSet<String>, WatcherRefusal> {
        if master.target.host_id == self.host_id
            || watches
                .iter()
                .any(|w| w.target.host_id != self.host_id || w.remote_origin.is_some())
        {
            return Err(refuse(
                "INVALID_INPUT",
                "The watch assignment does not match its owning host.",
            ));
        }

        let pre_record = self.record_snapshot();
        self.check_remote_master(&pre_record, master, client_id)?;
        self.migrate_remote_client(master, client_id)?;
        let record = self.record_snapshot();

        let threads = shell
            .get("host")
            .and_then(|h| h.get("threads"))
            .and_then(Value::as_array);
        let find_thread = |tid: &str| {
            threads.and_then(|arr| {
                arr.iter()
                    .find(|t| t.get("id").and_then(Value::as_str) == Some(tid))
            })
        };

        let delegated_ids: HashSet<String> = watches
            .iter()
            .filter(|w| {
                find_thread(&w.target.thread_id)
                    .and_then(|t| t.get("delegatedBy"))
                    .is_some_and(|v| !v.is_null())
            })
            .map(|w| w.id.clone())
            .collect();

        let fences = record.watch_fences.as_deref().unwrap_or(&[]);
        let kept: Vec<WatcherStandingWatch> = watches
            .into_iter()
            .filter(|w| {
                !delegated_ids.contains(&w.id)
                    && !fences.iter().any(|f| watch_fence_matches_id(f, &w.id))
            })
            .collect();

        let kept_ids: HashSet<String> = kept.iter().map(|w| w.id.clone()).collect();
        let kept_targets: HashSet<String> = kept.iter().map(|w| w.target.key()).collect();
        if kept_ids.len() != kept.len() || kept_targets.len() != kept.len() {
            return Err(refuse(
                "INVALID_INPUT",
                "The watch assignment does not match its owning host.",
            ));
        }

        for w in &kept {
            let Some(thread) = find_thread(&w.target.thread_id) else {
                return Err(refuse(
                    "UNKNOWN_TARGET",
                    "That thread is unavailable. Read the thread list again.",
                ));
            };
            self.check_protected_thread(thread)?;
            if let Some(prev) = record
                .watches
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .find(|item| item.id == w.id || item.target == w.target)
            {
                let owned_by_caller = prev.remote_origin.as_ref().is_some_and(|o| {
                    self.owns_remote_origin(
                        &o.client_id,
                        &o.master_host_id,
                        client_id,
                        &master.target.host_id,
                    )
                });
                let same_owner = prev.id == w.id && prev.target == w.target && owned_by_caller;
                // If this same desktop replaced its own watch on the same thread (e.g. toggling
                // Watch off/on while disconnected or after re-pair), withdraw the old watch below
                // before installing the replacement (#2863).
                let replaceable_own = prev.target == w.target
                    && prev.id != w.id
                    && !kept_ids.contains(prev.id.as_str())
                    && owned_by_caller;
                if !same_owner && !replaceable_own {
                    return Err(refuse(
                        "THREAD_TAKEN_OVER",
                        "Another watch owns this thread. Nothing was changed.",
                    ));
                }
            }
        }

        let cancelled = self.update_record(|next| {
            let masters = next.remote_masters.get_or_insert_with(Vec::new);
            if let Some(existing) = masters.iter_mut().find(|m| {
                m.get("clientId").and_then(Value::as_str) == Some(client_id)
                    && m.get("masterHostId").and_then(Value::as_str)
                        == Some(master.target.host_id.as_str())
            }) {
                if let Some(obj) = existing.as_object_mut() {
                    obj.insert(
                        "creationOperationId".into(),
                        Value::String(master.creation_operation_id.clone()),
                    );
                    obj.insert("createdAt".into(), Value::String(master.created_at.clone()));
                }
            } else {
                if masters.len() >= 1_000 {
                    return Err(refuse(
                        "HOST_FEATURE_UNAVAILABLE",
                        "This host cannot retain another Watcher desktop. Use a desktop already paired here.",
                    ));
                }
                masters.push(json!({
                    "clientId": client_id,
                    "masterHostId": master.target.host_id,
                    "creationOperationId": master.creation_operation_id,
                    "createdAt": master.created_at,
                }));
            }

            let to_withdraw: Vec<(WatcherThreadTarget, bool)> = next
                .watches
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .filter(|w| {
                    w.remote_origin.as_ref().is_some_and(|o| {
                        self.owns_remote_origin(
                            &o.client_id,
                            &o.master_host_id,
                            client_id,
                            &master.target.host_id,
                        )
                    }) && !kept_ids.contains(w.id.as_str())
                })
                .map(|w| (w.target.clone(), !delegated_ids.contains(&w.id)))
                .collect();

            let mut cancelled_drafts = HashSet::new();
            for (target, should_fence) in to_withdraw {
                Self::withdraw_watch(next, &target, &mut cancelled_drafts, should_fence);
            }

            for w in kept {
                let origin = WatcherWatchOrigin {
                    client_id: client_id.to_string(),
                    master_host_id: master.target.host_id.clone(),
                    master_creation_operation_id: Some(master.creation_operation_id.clone()),
                    master_created_at: Some(master.created_at.clone()),
                };
                if let Some(prev) = next
                    .watches
                    .get_or_insert_with(Vec::new)
                    .iter_mut()
                    .find(|item| item.id == w.id)
                {
                    prev.remote_origin = Some(origin);
                    prev.parked = w.parked;
                    continue;
                }
                let thread = find_thread(&w.target.thread_id);
                let head = thread.and_then(native_head);
                let paused = thread.is_some_and(|t| self.human_turn_running(t, next));
                let installed = WatcherStandingWatch {
                    id: w.id,
                    target: w.target.clone(),
                    created_at: w.created_at,
                    generation: w.generation,
                    paused_by_user_message_id: Some(if paused {
                        Some(head.clone().unwrap_or_else(|| "unobserved-user-turn".into()))
                    } else {
                        None
                    }),
                    last_user_message_id: Some(head),
                    parked: w.parked,
                    remote_origin: Some(origin),
                };
                next.watches.get_or_insert_with(Vec::new).push(installed);
            }
            Ok(cancelled_drafts)
        })?;

        Ok(cancelled)
    }

    fn withdraw_watch(
        record: &mut WatcherRecord,
        target: &WatcherThreadTarget,
        cancelled_drafts: &mut HashSet<String>,
        should_fence: bool,
    ) {
        let removed: Vec<WatcherStandingWatch> = record
            .watches
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .filter(|w| w.target == *target)
            .cloned()
            .collect();
        if should_fence {
            let fences = record.watch_fences.get_or_insert_with(Vec::new);
            for w in &removed {
                if !fences.iter().any(|f| watch_fence_matches_id(f, &w.id)) {
                    let mut obj = Map::new();
                    obj.insert("id".into(), Value::String(w.id.clone()));
                    obj.insert(
                        "target".into(),
                        serde_json::to_value(&w.target).unwrap_or(Value::Null),
                    );
                    if let Some(ref origin) = w.remote_origin {
                        obj.insert(
                            "remoteOrigin".into(),
                            serde_json::to_value(origin).unwrap_or(Value::Null),
                        );
                    }
                    fences.push(Value::Object(obj));
                }
            }
        }
        if let Some(ref mut watches) = record.watches {
            watches.retain(|w| w.target != *target);
        }
        let removed_ids: HashSet<&str> = removed.iter().map(|w| w.id.as_str()).collect();
        for req in &mut record.requests {
            if req
                .standing_watch_id
                .as_deref()
                .is_some_and(|wid| removed_ids.contains(wid))
                && req.state == "active"
            {
                req.state = "stopped".into();
                req.closed_at = Some(now_iso());
            }
            for part in &mut req.participants {
                if part.target == *target && part.state == "participating" {
                    part.generation = part.generation.saturating_add(1);
                    part.automation_stopped = Some(true);
                }
            }
        }
        for op in &mut record.operations {
            if op.target == *target {
                if let Some(ref d) = op.draft_id {
                    cancelled_drafts.insert(d.clone());
                }
                if op.delivery_state == "queued" {
                    op.delivery_state = "failed".into();
                    op.refusal_code = Some("REQUEST_NOT_ACTIVE".into());
                    op.updated_at = now_iso();
                }
            }
        }
    }

    fn stop_remote_requests(
        &self,
        master: &WatcherIdentity,
        stops: Vec<StoppedRequestEntry>,
        client_id: &str,
    ) -> Result<HashSet<String>, WatcherRefusal> {
        if master.target.host_id == self.host_id {
            return Err(refuse(
                "INVALID_INPUT",
                "A remote request must belong to its master computer.",
            ));
        }
        self.check_caller_host_binding(client_id, &master.target.host_id)?;
        self.migrate_remote_client(master, client_id)?;
        let record = self.record_snapshot();
        for entry in &stops {
            if entry.request.watcher != master.target {
                return Err(refuse(
                    "RETRY_KEY_CONFLICT",
                    "That stopped request belongs to another origin.",
                ));
            }
            if let Some(existing) = record.requests.iter().find(|r| r.id == entry.request.id) {
                let origin_ok = existing
                    .remote_origin
                    .as_ref()
                    .and_then(remote_origin_fields)
                    .is_some_and(|(cid, m, _, ceil)| {
                        self.owns_remote_origin(
                            &cid,
                            &m.target.host_id,
                            client_id,
                            &master.target.host_id,
                        ) && m == *master
                            && ceil == entry.ceiling
                    });
                if !origin_ok
                    || existing.root_user_message_id != entry.request.root_user_message_id
                    || existing.created_at != entry.request.created_at
                {
                    return Err(refuse(
                        "RETRY_KEY_CONFLICT",
                        "That stopped request belongs to another origin.",
                    ));
                }
            }
        }

        self.update_record(|next| {
            let mut cancelled_drafts = HashSet::new();
            for entry in stops {
                if let Some(existing) = next.requests.iter_mut().find(|r| r.id == entry.request.id)
                {
                    if existing.state != "stopped" {
                        existing.state = "stopped".into();
                        existing.closed_at = Some(now_iso());
                    }
                } else {
                    next.requests.push(WatcherRequest {
                        id: entry.request.id.clone(),
                        watcher: master.target.clone(),
                        root_user_message_id: entry.request.root_user_message_id,
                        standing_watch_id: None,
                        display_prompt: None,
                        handover: None,
                        phone_origin: None,
                        paired_permission_ceiling: None,
                        remote_origin: Some(json!({
                            "clientId": client_id,
                            "master": master,
                            "creationOperationId": master.creation_operation_id,
                            "ceiling": entry.ceiling,
                        })),
                        state: "stopped".into(),
                        created_at: entry.request.created_at,
                        closed_at: Some(now_iso()),
                        user_followups: None,
                        participants: Vec::new(),
                    });
                }
                for op in &mut next.operations {
                    if op.request_id == entry.request.id && op.confirmed_stop != Some(true) {
                        if let Some(ref d) = op.draft_id {
                            cancelled_drafts.insert(d.clone());
                        }
                        if op.delivery_state == "queued" {
                            op.delivery_state = "failed".into();
                            op.refusal_code = Some("REQUEST_NOT_ACTIVE".into());
                            op.updated_at = now_iso();
                        }
                    }
                }
            }
            Ok(cancelled_drafts)
        })
    }

    pub fn remote_projection(
        &self,
        master: &WatcherIdentity,
        client_id: &str,
    ) -> WatcherHostProjection {
        if self
            .desktop_host_id_of(client_id)
            .as_deref()
            .is_some_and(|bound| bound != master.target.host_id.as_str())
        {
            let empty_reqs: Vec<WatcherRequest> = Vec::new();
            let empty_ops: Vec<WatcherOperation> = Vec::new();
            let empty_watches: Vec<WatcherStandingWatch> = Vec::new();
            let empty_ev: Vec<Value> = Vec::new();
            let empty_prog: Vec<WatcherProgressEntry> = Vec::new();
            let work_rev = json_digest(&(&empty_reqs, &empty_ops, &empty_watches));
            let revision = json_digest(&(&work_rev, &empty_ev, &empty_prog));
            return WatcherHostProjection {
                host_id: self.host_id.clone(),
                master: master.clone(),
                standing_watches: Some(empty_watches),
                revision,
                observed_at: now_iso(),
                requests: empty_reqs,
                operations: empty_ops,
                evidence: empty_ev,
                progress: Some(empty_prog),
            };
        }
        let record = self.record_snapshot();
        let owned_requests: Vec<WatcherRequest> = record
            .requests
            .iter()
            .filter(|r| {
                r.watcher == master.target
                    && r.remote_origin
                        .as_ref()
                        .and_then(remote_origin_fields)
                        .is_some_and(|(cid, m, cop, _)| {
                            self.owns_remote_origin(
                                &cid,
                                &m.target.host_id,
                                client_id,
                                &master.target.host_id,
                            ) && cop == master.creation_operation_id
                        })
            })
            .cloned()
            .collect();
        let owned_ids: HashSet<&str> = owned_requests.iter().map(|r| r.id.as_str()).collect();
        let all_ops: Vec<WatcherOperation> = record
            .operations
            .iter()
            .filter(|o| owned_ids.contains(o.request_id.as_str()))
            .cloned()
            .collect();
        let pending: Vec<WatcherOperation> = all_ops
            .iter()
            .filter(|o| {
                matches!(
                    o.delivery_state.as_str(),
                    "queued" | "dispatching" | "uncertain"
                )
            })
            .cloned()
            .collect();
        let recent_count = 1_000usize.saturating_sub(pending.len());
        let non_pending: Vec<WatcherOperation> = all_ops
            .iter()
            .filter(|o| {
                !matches!(
                    o.delivery_state.as_str(),
                    "queued" | "dispatching" | "uncertain"
                )
            })
            .cloned()
            .collect();
        let mut operations: Vec<WatcherOperation> = if recent_count > 0 {
            let start = non_pending.len().saturating_sub(recent_count);
            non_pending[start..].to_vec()
        } else {
            Vec::new()
        };
        operations.extend(pending);
        if operations.len() > 1_000 {
            let start = operations.len() - 1_000;
            operations = operations[start..].to_vec();
        }
        let required_req_ids: HashSet<&str> =
            operations.iter().map(|o| o.request_id.as_str()).collect();
        let mut requests: Vec<WatcherRequest> = owned_requests
            .into_iter()
            .filter(|r| required_req_ids.contains(r.id.as_str()))
            .collect();
        if requests.len() > 1_000 {
            let start = requests.len() - 1_000;
            requests = requests[start..].to_vec();
        }
        let standing_watches: Vec<WatcherStandingWatch> = record
            .watches
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .filter(|w| {
                w.remote_origin.as_ref().is_some_and(|o| {
                    self.owns_remote_origin(
                        &o.client_id,
                        &o.master_host_id,
                        client_id,
                        &master.target.host_id,
                    ) && o.master_creation_operation_id.as_deref()
                        == Some(master.creation_operation_id.as_str())
                })
            })
            .cloned()
            .collect();

        let mut target_map: HashMap<String, WatcherThreadTarget> = HashMap::new();
        for req in &requests {
            for p in &req.participants {
                target_map.insert(p.target.key(), p.target.clone());
            }
        }
        for w in &standing_watches {
            target_map.insert(w.target.key(), w.target.clone());
        }

        let projected_ops: Vec<WatcherOperation> =
            operations.into_iter().map(without_outcome).collect();

        let (evidence, progress) = {
            let rt = self.runtime.lock().unwrap();
            let mut ev: Vec<Value> = Vec::new();
            for target in target_map.values() {
                ev.extend(rt.read_evidence(&target.key(), true));
            }
            if ev.len() > 1_000 {
                let start = ev.len() - 1_000;
                ev = ev[start..].to_vec();
            }
            let mut prog: Vec<WatcherProgressEntry> = Vec::new();
            if let Some(ref shell) = rt.last_shell {
                if let Some(threads) = shell
                    .get("host")
                    .and_then(|h| h.get("threads"))
                    .and_then(Value::as_array)
                {
                    for thread in threads {
                        if let Some(tid) = thread.get("id").and_then(Value::as_str) {
                            let target = WatcherThreadTarget::new(&self.host_id, tid);
                            if target_map.contains_key(&target.key()) {
                                prog.push(WatcherProgressEntry {
                                    target,
                                    fingerprint: watcher_progress_fingerprint(thread),
                                });
                            }
                        }
                    }
                }
            }
            if prog.len() > 1_000 {
                let start = prog.len() - 1_000;
                prog = prog[start..].to_vec();
            }
            (ev, prog)
        };

        let work_rev = json_digest(&(&requests, &projected_ops, &standing_watches));
        let revision = json_digest(&(&work_rev, &evidence, &progress));
        WatcherHostProjection {
            host_id: self.host_id.clone(),
            master: master.clone(),
            standing_watches: Some(standing_watches),
            revision,
            observed_at: now_iso(),
            requests,
            operations: projected_ops,
            evidence,
            progress: Some(progress),
        }
    }

    // -----------------------------------------------------------------------
    // Read operations: `read_operation`, `list_threads`, `list_projects`,
    // `list_working_copies`, `read_thread`
    // -----------------------------------------------------------------------

    async fn read_operation_response(
        &self,
        shell: &Value,
        op: &WatcherOperation,
        include_outcomes: bool,
    ) -> Result<Value, WatcherRefusal> {
        let record = self.record_snapshot();
        let mut obj = Map::new();
        obj.insert("status".into(), Value::String("ok".into()));
        obj.insert("receipt".into(), self.receipt_value(op));
        obj.insert("limits".into(), self.limits_value(&record, op));
        obj.insert("action".into(), Value::String(op.action.clone()));
        obj.insert("state".into(), self.operation_state(shell, &op.target));

        if include_outcomes && (op.action == "start" || op.action == "send") {
            let outcome = if op.delivery_state == "failed" {
                "failed"
            } else if let Some(ref o) = op.outcome {
                o.as_str()
            } else {
                "working"
            };
            let mut reference = Map::new();
            reference.insert(
                "target".into(),
                serde_json::to_value(&op.target).unwrap_or(Value::Null),
            );
            if let Some(ref tm) = op.turn_message_id {
                reference.insert("turnMessageId".into(), Value::String(tm.clone()));
            }
            if let Some(ref nt) = op.native_turn_id {
                reference.insert("nativeTurnId".into(), Value::String(nt.clone()));
            }
            if let Some(ref rm) = op.reply_message_id {
                reference.insert("replyMessageId".into(), Value::String(rm.clone()));
            }
            obj.insert("outcome".into(), Value::String(outcome.into()));
            obj.insert("reference".into(), Value::Object(reference));

            let waiting_ahead = {
                let rt = self.runtime.lock().unwrap();
                rt.check_queue
                    .iter()
                    .position(|c| c.operation_id == op.id && c.waiting.is_some())
            };
            let note = if let Some(ahead) = waiting_ahead {
                format!(
                    "{ahead} check{} ahead on this host. Its thread starts automatically when its turn comes; stop_thread removes it from the queue.",
                    if ahead == 1 { " is" } else { "s are" }
                )
            } else {
                outcome_note(outcome).to_string()
            };
            obj.insert("outcomeNote".into(), Value::String(note));

            // Turn-scoped evidence.
            let turn_ids: HashSet<&str> = op
                .turn_message_id
                .as_deref()
                .into_iter()
                .chain(op.native_turn_id.as_deref())
                .collect();
            if !turn_ids.is_empty() {
                let ev: Vec<Value> = self
                    .runtime
                    .lock()
                    .unwrap()
                    .read_evidence(&op.target.key(), true)
                    .into_iter()
                    .filter(|e| {
                        e.get("turnId")
                            .and_then(Value::as_str)
                            .is_some_and(|tid| turn_ids.contains(tid))
                    })
                    .collect();
                if !ev.is_empty() {
                    let start = ev.len().saturating_sub(20);
                    obj.insert("evidence".into(), Value::Array(ev[start..].to_vec()));
                }
            }

            if outcome == "answered" {
                if let Some(ref reply_id) = op.reply_message_id {
                    let stored = self
                        .coordinator
                        .watcher_read_message(op.target.thread_id.clone(), reply_id.clone())
                        .await
                        .ok()
                        .flatten();
                    if let Some(msg) = stored.filter(|m| m.role == "assistant") {
                        let cut = cut_to_bytes(&msg.text, WATCHER_REPLY_BYTES_MAX);
                        let truncated = cut.len() < msg.text.len();
                        obj.insert(
                            "reply".into(),
                            json!({
                                "from": "worker",
                                "messageId": msg.id,
                                "text": cut,
                                "createdAt": msg.created_at,
                                "truncated": truncated,
                            }),
                        );
                    } else {
                        obj.insert(
                            "replyUnavailable".into(),
                            json!({
                                "reason": "not-retained",
                                "message": "Sotto no longer holds this reply. Read the thread for what the worker said.",
                            }),
                        );
                    }
                }
            }
        }

        // Enforce 64 KiB read bound by trimming reply text if needed.
        let mut out = Value::Object(obj);
        loop {
            let size = serde_json::to_string(&out).map(|s| s.len()).unwrap_or(0);
            if size <= WATCHER_READ_BYTES_MAX {
                break;
            }
            let Some(reply_obj) = out.get_mut("reply").and_then(Value::as_object_mut) else {
                break;
            };
            let current_text = reply_obj
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if current_text.is_empty() {
                break;
            }
            let over = size - WATCHER_READ_BYTES_MAX;
            let next_max = current_text.len().saturating_sub(over + 64);
            let trimmed = cut_to_bytes(&current_text, next_max);
            reply_obj.insert("text".into(), Value::String(trimmed));
            reply_obj.insert("truncated".into(), Value::Bool(true));
        }
        Ok(out)
    }

    fn paginate(
        &self,
        kind: String,
        rows: Vec<Value>,
        cursor: Option<&str>,
        limit: usize,
        working_copies: Option<WorkingCopySnapshot>,
    ) -> Result<(Vec<Value>, String, Option<String>), WatcherRefusal> {
        let mut rt = self.runtime.lock().unwrap();
        rt.prune_pages();
        let limit = limit.clamp(1, WATCHER_ROSTER_MAX);
        let (revision, position, source_rows) = match cursor {
            Some(c) if c != "restart" => {
                let Some((rev, pos_str)) = c.split_once(':') else {
                    return Err(refuse_retryable(
                        "CURSOR_EXPIRED",
                        "This list changed or its cursor expired. Read its first page again.",
                    ));
                };
                let Ok(pos) = pos_str.parse::<usize>() else {
                    return Err(refuse_retryable(
                        "CURSOR_EXPIRED",
                        "This list changed or its cursor expired. Read its first page again.",
                    ));
                };
                let Some(page) = rt.pages.get(rev) else {
                    return Err(refuse_retryable(
                        "CURSOR_EXPIRED",
                        "This list changed or its cursor expired. Read its first page again.",
                    ));
                };
                if page.kind != kind {
                    return Err(refuse_retryable(
                        "CURSOR_EXPIRED",
                        "This list changed or its cursor expired. Read its first page again.",
                    ));
                }
                (rev.to_string(), pos, page.rows.clone())
            }
            _ => {
                let rev = Uuid::new_v4().to_string();
                rt.pages.insert(
                    rev.clone(),
                    CachedPage {
                        kind,
                        rows: rows.clone(),
                        expires: Instant::now() + PAGE_TTL,
                        working_copies,
                    },
                );
                rt.prune_pages();
                (rev, 0, rows)
            }
        };
        let end = (position + limit).min(source_rows.len());
        let page_rows = if position < source_rows.len() {
            source_rows[position..end].to_vec()
        } else {
            Vec::new()
        };
        let next_cursor = (end < source_rows.len()).then(|| format!("{revision}:{end}"));
        Ok((page_rows, revision, next_cursor))
    }

    fn list_threads(&self, shell: &Value, input: ListThreadsInput) -> Result<Value, WatcherRefusal> {
        if input
            .host_id
            .as_deref()
            .is_some_and(|h| h != self.host_id.as_str())
            || input
                .project
                .as_ref()
                .is_some_and(|p| p.host_id != self.host_id)
        {
            return Err(refuse(
                "HOST_FEATURE_UNAVAILABLE",
                "Remote Watcher thread reads are not available yet.",
            ));
        }

        let record = self.record_snapshot();
        let threads = shell
            .get("host")
            .and_then(|h| h.get("threads"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let projects = shell
            .get("host")
            .and_then(|h| h.get("projects"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let now_ms = chrono::Utc::now().timestamp_millis();

        // Delegated child cards bubble up to their delegating parent.
        let mut delegated_cards: HashMap<String, Vec<Value>> = HashMap::new();
        for child in &threads {
            let Some(parent_id) = child.get("delegatedBy").and_then(Value::as_str) else {
                continue;
            };
            let Some(cid) = child.get("id").and_then(Value::as_str) else {
                continue;
            };
            if let Some(reqs) = child.get("requests").and_then(Value::as_array) {
                for r in reqs {
                    let kind = r.get("kind").and_then(Value::as_str).unwrap_or("question");
                    delegated_cards
                        .entry(parent_id.to_string())
                        .or_default()
                        .push(json!({
                            "id": r.get("id").and_then(Value::as_str).unwrap_or(""),
                            "kind": kind,
                            "label": if kind == "permission" { "Open to answer permission" } else { "Open to answer question" },
                            "openTarget": { "hostId": self.host_id, "threadId": cid },
                        }));
                }
            }
        }

        let mut rows = Vec::new();
        let mut group_counts: HashMap<&'static str, usize> = HashMap::from([
            ("Needs you", 0),
            ("Ready for review", 0),
            ("Working", 0),
            ("Landing", 0),
            ("Quiet", 0),
            ("Idle", 0),
        ]);

        let rt = self.runtime.lock().unwrap();
        for thread in &threads {
            let kind = thread.get("kind").and_then(Value::as_str);
            if matches!(kind, Some("watcher" | "watcher-history")) || thread.get("owlet").is_some()
            {
                continue;
            }
            let Some(tid) = thread.get("id").and_then(Value::as_str) else {
                continue;
            };
            let project_id = thread
                .get("projectId")
                .and_then(Value::as_str)
                .unwrap_or("");
            if let Some(ref filter_proj) = input.project {
                if project_id != filter_proj.project_id {
                    continue;
                }
            }
            let project = projects
                .iter()
                .find(|p| p.get("id").and_then(Value::as_str) == Some(project_id));
            if !input.include_settled && is_thread_settled(thread, project) {
                continue;
            }

            let target = WatcherThreadTarget::new(&self.host_id, tid);
            let tkey = target.key();
            let connected = is_thread_connected(shell, thread);
            let obs = rt.observations.get(&tkey);
            let group = classify_thread_group(
                thread,
                project,
                connected,
                obs.map(|o| o.last_progress_ms),
                obs.map(|o| o.connected_at_ms),
                now_ms,
            );
            if let Some(ref filter_group) = input.group {
                if group != filter_group.as_str() {
                    continue;
                }
            }
            *group_counts.entry(group).or_insert(0) += 1;

            let mut waits_on: Vec<Value> = thread
                .get("requests")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .map(|r| {
                            let rk = r.get("kind").and_then(Value::as_str).unwrap_or("question");
                            json!({
                                "id": r.get("id").and_then(Value::as_str).unwrap_or(""),
                                "kind": rk,
                                "label": if rk == "permission" { "Open to answer permission" } else { "Open to answer question" },
                                "openTarget": target,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            if let Some(extra) = delegated_cards.get(tid) {
                waits_on.extend(extra.iter().cloned());
            }
            waits_on.truncate(100);

            let provider = thread
                .get("providerId")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .or_else(|| {
                    thread
                        .get("modelId")
                        .and_then(Value::as_str)
                        .and_then(parse_public_provider_entity_id)
                        .map(|(p, _, _)| p.to_string())
                })
                .unwrap_or_else(|| "codex".into());

            let branch = thread
                .get("worktree")
                .and_then(|w| w.get("branch"))
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let working_copy = thread.get("worktree").map(|w| {
                let mode = w.get("mode").and_then(Value::as_str).unwrap_or("shared");
                json!({ "kind": if mode == "shared" { "shared" } else { "new-worktree" } })
            });
            let prs: Vec<Value> = thread
                .get("pullRequests")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .take(50)
                        .map(|p| {
                            json!({
                                "number": p.get("number").and_then(Value::as_u64).unwrap_or(1),
                                "url": p.get("url").and_then(Value::as_str).unwrap_or(""),
                                "title": p.get("title").and_then(Value::as_str).unwrap_or(""),
                                "state": p.get("state").and_then(Value::as_str).unwrap_or("open"),
                                "draft": p.get("draft").and_then(Value::as_bool).unwrap_or(false),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let evidence = rt.read_evidence(&tkey, connected);
            let watcher_read_at = record
                .reads
                .iter()
                .find(|r| {
                    r.get("target")
                        .and_then(|t| serde_json::from_value::<WatcherThreadTarget>(t.clone()).ok())
                        .is_some_and(|t| t == target)
                })
                .and_then(|r| r.get("readAt").and_then(Value::as_str))
                .map(ToString::to_string);

            let mut participation: Vec<Value> = record
                .requests
                .iter()
                .flat_map(|r| r.participants.iter())
                .filter(|p| p.target == target)
                .map(|p| {
                    let mut po = Map::new();
                    po.insert("requestId".into(), Value::String(p.request_id.clone()));
                    po.insert("startedBy".into(), Value::String(p.started_by.clone()));
                    po.insert("generation".into(), json!(p.generation));
                    po.insert("state".into(), Value::String(p.state.clone()));
                    if let Some(ref tk) = p.takeover {
                        po.insert(
                            "takeover".into(),
                            serde_json::to_value(tk).unwrap_or(Value::Null),
                        );
                    }
                    if p.automation_stopped == Some(true) {
                        po.insert("automationStopped".into(), Value::Bool(true));
                    }
                    Value::Object(po)
                })
                .collect();
            if participation.len() > WATCHER_PARTICIPATION_HISTORY_MAX {
                let start = participation.len() - WATCHER_PARTICIPATION_HISTORY_MAX;
                participation = participation[start..].to_vec();
            }

            let mut row = Map::new();
            row.insert(
                "target".into(),
                serde_json::to_value(&target).unwrap_or(Value::Null),
            );
            row.insert(
                "title".into(),
                Value::String(
                    thread
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("Thread")
                        .chars()
                        .take(WATCHER_TITLE_MAX)
                        .collect(),
                ),
            );
            row.insert("projectId".into(), Value::String(project_id.to_string()));
            if let Some(w) = record
                .watches
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .find(|w| w.target == target)
            {
                let mut sw = json!({
                    "id": w.id,
                    "target": w.target,
                    "createdAt": w.created_at,
                    "generation": w.generation,
                    "pausedByUserMessageId": w.paused_by_user_message_id.clone().flatten(),
                });
                if w.parked == Some(true) {
                    if let Some(o) = sw.as_object_mut() {
                        o.insert("parked".into(), Value::Bool(true));
                    }
                }
                row.insert("standingWatch".into(), sw);
            }
            row.insert("provider".into(), Value::String(provider));
            row.insert(
                "modelId".into(),
                Value::String(
                    thread
                        .get("modelId")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                ),
            );
            if let Some(eff) = thread
                .get("reasoningEffort")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                row.insert("reasoningEffort".into(), Value::String(eff.to_string()));
            }
            row.insert(
                "status".into(),
                Value::String(
                    thread
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("idle")
                        .to_string(),
                ),
            );
            row.insert("group".into(), Value::String(group.into()));
            row.insert("waitsOn".into(), Value::Array(waits_on));
            row.insert(
                "branch".into(),
                branch.map(Value::String).unwrap_or(Value::Null),
            );
            row.insert("workingCopy".into(), working_copy.unwrap_or(Value::Null));
            row.insert("pullRequests".into(), Value::Array(prs));
            row.insert("evidence".into(), Value::Array(evidence));
            row.insert(
                "lastActivityAt".into(),
                obs.map(|o| Value::String(o.last_progress_at.clone()))
                    .unwrap_or(Value::Null),
            );
            row.insert(
                "observedAt".into(),
                obs.map(|o| Value::String(o.observed_at.clone()))
                    .unwrap_or(Value::Null),
            );
            row.insert("connected".into(), Value::Bool(connected));
            row.insert(
                "freshness".into(),
                Value::String(
                    if !connected {
                        "stale"
                    } else if obs.is_some() {
                        "fresh"
                    } else {
                        "unknown"
                    }
                    .into(),
                ),
            );
            row.insert("userReadAt".into(), Value::Null);
            row.insert(
                "watcherReadAt".into(),
                watcher_read_at.map(Value::String).unwrap_or(Value::Null),
            );
            row.insert("participation".into(), Value::Array(participation));
            row.insert("protected".into(), Value::Bool(false));
            rows.push(Value::Object(row));
        }
        drop(rt);

        let page_kind = format!(
            "threads:{}",
            json_digest(&(
                &input.host_id,
                &input.project,
                &input.group,
                input.include_settled,
                input.watched_only == Some(true),
            ))
        );
        let (page_rows, revision, next_cursor) =
            self.paginate(page_kind, rows, input.cursor.as_deref(), input.limit, None)?;
        Ok(json!({
            "status": "ok",
            "rows": page_rows,
            "snapshotRevision": revision,
            "nextCursor": next_cursor,
            "observedAt": now_iso(),
            "staleHosts": [],
            "counts": {
                "Needs you": group_counts["Needs you"],
                "Ready for review": group_counts["Ready for review"],
                "Working": group_counts["Working"],
                "Landing": group_counts["Landing"],
                "Quiet": group_counts["Quiet"],
                "Idle": group_counts["Idle"],
            },
        }))
    }

    fn list_projects(
        &self,
        shell: &Value,
        input: ListProjectsInput,
        may_answer: bool,
    ) -> Result<Value, WatcherRefusal> {
        if input
            .host_id
            .as_deref()
            .is_some_and(|h| h != self.host_id.as_str())
        {
            return Err(refuse(
                "HOST_FEATURE_UNAVAILABLE",
                "Remote Watcher project reads are not available yet.",
            ));
        }
        let projects = shell
            .get("host")
            .and_then(|h| h.get("projects"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let models = shell
            .get("host")
            .and_then(|h| h.get("models"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let connected = shell
            .get("host")
            .and_then(|h| h.get("connected"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let ceiling = if may_answer {
            "full-access"
        } else {
            "approval-required"
        };

        let workers: Vec<Value> = models
            .iter()
            .filter(|m| m.get("ready").and_then(Value::as_bool) == Some(true))
            .filter(|m| {
                input.provider.as_deref().is_none_or(|p| {
                    m.get("providerId").and_then(Value::as_str) == Some(p)
                })
            })
            .take(100)
            .map(|m| {
                let model_id = m.get("id").and_then(Value::as_str).unwrap_or("");
                let default_perm = self
                    .check_permission(shell, model_id, None, ceiling, may_answer)
                    .ok();
                let efforts: Vec<Value> = m
                    .get("reasoningEfforts")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                json!({
                    "provider": m.get("providerId").and_then(Value::as_str).unwrap_or("codex"),
                    "modelId": model_id,
                    "reasoningEfforts": efforts,
                    "speeds": [],
                    "defaultPermission": default_perm.as_ref().map(|p| serde_json::to_value(p).unwrap_or(Value::Null)).unwrap_or(Value::Null),
                    "permissionComparable": default_perm.is_some(),
                })
            })
            .collect();

        let query = input.query.as_deref().map(str::to_lowercase);
        let rows: Vec<Value> = projects
            .iter()
            .filter(|p| {
                let id = p.get("id").and_then(Value::as_str).unwrap_or("");
                if let Some(ref pid) = input.project_id {
                    if id != pid {
                        return false;
                    }
                }
                if let Some(ref q) = query {
                    let title = p
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_lowercase();
                    let path = p
                        .get("path")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_lowercase();
                    return title.contains(q) || path.contains(q);
                }
                true
            })
            .map(|p| {
                json!({
                    "target": {
                        "hostId": self.host_id,
                        "projectId": p.get("id").and_then(Value::as_str).unwrap_or(""),
                    },
                    "title": p.get("title").and_then(Value::as_str).unwrap_or("Project"),
                    "displayRoot": p.get("path").and_then(Value::as_str).unwrap_or(""),
                    "workers": workers,
                    "controlAvailable": true,
                    "readsAvailable": true,
                    "readOnlyProfileAvailable": true,
                    "freshness": if connected { "fresh" } else { "stale" },
                })
            })
            .collect();

        let page_kind = format!(
            "projects:{}",
            json_digest(&(
                &input.host_id,
                &input.project_id,
                &input.query,
                &input.provider,
            ))
        );
        let (page_rows, _, next_cursor) =
            self.paginate(page_kind, rows, input.cursor.as_deref(), input.limit, None)?;
        Ok(json!({
            "status": "ok",
            "projects": page_rows,
            "nextCursor": next_cursor,
            "observedAt": now_iso(),
            "staleHosts": [],
        }))
    }

    fn list_working_copies(
        &self,
        shell: &Value,
        input: ListWorkingCopiesInput,
    ) -> Result<Value, WatcherRefusal> {
        if input.project.host_id != self.host_id {
            return Err(refuse(
                "HOST_FEATURE_UNAVAILABLE",
                "Remote Watcher working-copy choices are not available yet.",
            ));
        }
        let kind = format!("copies:{}", input.project.project_id);
        if let Some(cursor) = input.cursor.as_deref().filter(|c| *c != "restart") {
            let (rows, rev, next_cursor) =
                self.paginate(kind, Vec::new(), Some(cursor), input.limit, None)?;
            let wc = self
                .runtime
                .lock()
                .unwrap()
                .pages
                .get(&rev)
                .and_then(|p| p.working_copies.clone())
                .ok_or_else(|| {
                    refuse_retryable(
                        "CURSOR_EXPIRED",
                        "This list changed or its cursor expired. Read its first page again.",
                    )
                })?;
            return Ok(json!({
                "status": "ok",
                "project": input.project,
                "revision": wc.revision,
                "choices": rows,
                "baseRefs": wc.base_refs,
                "nextCursor": next_cursor,
                "observedAt": now_iso(),
                "staleHosts": [],
            }));
        }

        let project_path = shell
            .get("host")
            .and_then(|h| h.get("projects"))
            .and_then(Value::as_array)
            .and_then(|arr| {
                arr.iter().find(|p| {
                    p.get("id").and_then(Value::as_str) == Some(input.project.project_id.as_str())
                })
            })
            .and_then(|p| p.get("path"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                refuse(
                    "UNKNOWN_TARGET",
                    "That project is unavailable. Read the project list again.",
                )
            })?;

        let options: WorkingCopyOptions = working_copy_options(project_path);
        let revision = json_digest(&options);
        let threads = shell
            .get("host")
            .and_then(|h| h.get("threads"))
            .and_then(Value::as_array);

        let mut choices = vec![json!({
            "choiceId": Uuid::new_v4().to_string(),
            "kind": "shared",
            "branch": options.current_branch,
            "occupied": false,
            "locked": false,
            "limitations": [],
        })];
        if options.is_git {
            choices.push(json!({
                "choiceId": Uuid::new_v4().to_string(),
                "kind": "new-worktree",
                "branch": options.current_branch,
                "occupied": false,
                "locked": false,
                "limitations": [],
            }));
        }
        let mut choice_entries: Vec<(String, Option<String>, Option<String>)> = Vec::new();
        for wt in &options.worktrees {
            let occupied = threads.is_some_and(|arr| {
                arr.iter().any(|t| {
                    t.get("worktree")
                        .and_then(|w| w.get("path"))
                        .and_then(Value::as_str)
                        == Some(wt.path.as_str())
                })
            });
            let cid = Uuid::new_v4().to_string();
            choice_entries.push((cid.clone(), Some(wt.path.clone()), None));
            choices.push(json!({
                "choiceId": cid,
                "kind": "existing-worktree",
                "branch": wt.branch,
                "occupied": occupied,
                "locked": false,
                "limitations": if occupied { vec!["Already used by a thread"] } else { Vec::new() },
            }));
        }
        let mut base_refs = Vec::new();
        for branch in options.branches.iter().take(100) {
            let cid = Uuid::new_v4().to_string();
            choice_entries.push((cid.clone(), None, Some(branch.clone())));
            base_refs.push(json!({ "choiceId": cid, "name": branch }));
        }

        let (page_rows, page_rev, next_cursor) = self.paginate(
            kind,
            choices,
            None,
            input.limit,
            Some(WorkingCopySnapshot {
                revision: revision.clone(),
                base_refs: base_refs.clone(),
            }),
        )?;

        {
            let mut rt = self.runtime.lock().unwrap();
            for (cid, path, branch) in choice_entries {
                rt.copy_choices.insert(
                    cid,
                    CopyChoiceEntry {
                        project_id: input.project.project_id.clone(),
                        revision: revision.clone(),
                        snapshot_id: page_rev.clone(),
                        path,
                        branch,
                    },
                );
            }
        }

        Ok(json!({
            "status": "ok",
            "project": input.project,
            "revision": revision,
            "choices": page_rows,
            "baseRefs": base_refs,
            "nextCursor": next_cursor,
            "observedAt": now_iso(),
            "staleHosts": [],
        }))
    }

    async fn read_thread(
        &self,
        shell: &Value,
        input: ReadThreadInput,
    ) -> Result<Value, WatcherRefusal> {
        if input.target.host_id != self.host_id {
            return Err(refuse(
                "HOST_FEATURE_UNAVAILABLE",
                "Remote Watcher thread reads are not available yet.",
            ));
        }
        let thread = shell
            .get("host")
            .and_then(|h| h.get("threads"))
            .and_then(Value::as_array)
            .and_then(|arr| {
                arr.iter().find(|t| {
                    t.get("id").and_then(Value::as_str) == Some(input.target.thread_id.as_str())
                })
            })
            .ok_or_else(|| {
                refuse(
                    "UNKNOWN_TARGET",
                    "That thread is unavailable. Read the thread list again.",
                )
            })?;
        let kind = thread.get("kind").and_then(Value::as_str);
        if matches!(kind, Some("watcher" | "watcher-history")) {
            return Err(refuse(
                "RESERVED_THREAD",
                "Watcher tools read workers. Open Watcher history in its own pane.",
            ));
        }

        let after_pos = input.position.as_ref().map(|p| p.after_position);
        let limit = input.limit.clamp(1, WATCHER_MESSAGES_MAX);
        let read = self
            .coordinator
            .watcher_read_thread(input.target.thread_id.clone(), after_pos, limit)
            .await
            .map_err(|_| {
                refuse_retryable(
                    "HISTORY_UNAVAILABLE",
                    "This thread’s history is unavailable. Reconnect its provider and read again.",
                )
            })?
            .ok_or_else(|| {
                refuse_retryable(
                    "HISTORY_UNAVAILABLE",
                    "This thread’s history is unavailable. Reconnect its provider and read again.",
                )
            })?;

        if input.require_fresh == Some(true) && read.availability != "available" {
            return Err(refuse_retryable(
                "HISTORY_UNAVAILABLE",
                "This thread’s provider is unavailable. Cached history does not prove it finished. Reconnect and read again.",
            ));
        }
        if let Some(ref pos) = input.position {
            if pos.history_epoch != read.history_epoch {
                let mut refusal = refuse(
                    "HISTORY_RESET",
                    "This thread’s history changed. Start a fresh read.",
                );
                refusal.history_cursor = Some(json!({
                    "historyEpoch": read.history_epoch,
                    "afterPosition": -1,
                }));
                return Err(refusal);
            }
        }

        let mut messages: Vec<Value> = read
            .messages
            .into_iter()
            .filter(|(m, _)| m.role == "user" || m.role == "assistant")
            .map(|(m, pos)| {
                json!({
                    "id": m.id,
                    "position": pos,
                    "role": m.role,
                    "text": m.text,
                    "createdAt": m.created_at,
                })
            })
            .collect();

        let waits_on: Vec<Value> = thread
            .get("requests")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .take(100)
                    .map(|r| {
                        let rk = r.get("kind").and_then(Value::as_str).unwrap_or("question");
                        json!({
                            "id": r.get("id").and_then(Value::as_str).unwrap_or(""),
                            "kind": rk,
                            "label": if rk == "permission" { "Open to answer permission" } else { "Open to answer question" },
                            "openTarget": input.target,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        let mut activities: Vec<Value> = if input.include_activities {
            read.activities
                .into_iter()
                .filter_map(|a| {
                    let id = a.get("id")?.as_str()?;
                    let kind = a.get("kind")?.as_str()?;
                    let valid_kind = matches!(
                        kind,
                        "turn"
                            | "command"
                            | "file-change"
                            | "tool"
                            | "reasoning"
                            | "plan"
                            | "subagent"
                            | "status"
                            | "compaction"
                    );
                    if !valid_kind {
                        return None;
                    }
                    let status = a.get("status").and_then(Value::as_str).unwrap_or("unknown");
                    let status = if matches!(
                        status,
                        "running" | "completed" | "failed" | "interrupted" | "unknown"
                    ) {
                        status
                    } else {
                        "unknown"
                    };
                    let title: String = a
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .chars()
                        .take(2_000)
                        .collect();
                    let mut obj = Map::new();
                    obj.insert("id".into(), Value::String(id.to_string()));
                    obj.insert("kind".into(), Value::String(kind.to_string()));
                    obj.insert("status".into(), Value::String(status.to_string()));
                    obj.insert("title".into(), Value::String(title));
                    if let Some(s) = a.get("startedAt").and_then(Value::as_str) {
                        obj.insert("startedAt".into(), Value::String(s.to_string()));
                    }
                    if let Some(c) = a.get("completedAt").and_then(Value::as_str) {
                        obj.insert("completedAt".into(), Value::String(c.to_string()));
                    }
                    Some(Value::Object(obj))
                })
                .take(100)
                .collect()
        } else {
            Vec::new()
        };

        let connected = is_thread_connected(shell, thread);
        let evidence = self
            .runtime
            .lock()
            .unwrap()
            .read_evidence(&input.target.key(), connected);

        let mut truncated = read.has_more;
        let mut earlier_available = read.earlier_available;
        let has_position = input.position.is_some();

        let build_result = |msgs: &[Value],
                            acts: &[Value],
                            trunc: bool,
                            earlier: bool|
         -> Value {
            let first_pos = msgs.first().and_then(|m| m.get("position")).cloned();
            let last_pos = msgs.last().and_then(|m| m.get("position")).cloned();
            let next_pos = if (trunc && has_position) || read.has_more {
                last_pos.clone()
            } else {
                None
            };
            json!({
                "status": "ok",
                "target": input.target,
                "messages": msgs,
                "waitsOn": waits_on,
                "activities": acts,
                "evidence": evidence,
                "historyEpoch": read.history_epoch,
                "firstPosition": first_pos.unwrap_or(Value::Null),
                "lastPosition": last_pos.unwrap_or(Value::Null),
                "nextPosition": next_pos.unwrap_or(Value::Null),
                "truncated": trunc,
                "earlierAvailable": earlier,
                "observedAt": now_iso(),
            })
        };

        let mut result = build_result(&messages, &activities, truncated, earlier_available);
        while serde_json::to_string(&result).map(|s| s.len()).unwrap_or(0) > WATCHER_READ_BYTES_MAX
            && messages.len() > 1
        {
            if has_position {
                messages.pop();
            } else {
                messages.remove(0);
                earlier_available = true;
            }
            truncated = true;
            result = build_result(&messages, &activities, truncated, earlier_available);
        }
        while serde_json::to_string(&result).map(|s| s.len()).unwrap_or(0) > WATCHER_READ_BYTES_MAX
            && !activities.is_empty()
        {
            activities.remove(0);
            truncated = true;
            result = build_result(&messages, &activities, truncated, earlier_available);
        }
        if serde_json::to_string(&result).map(|s| s.len()).unwrap_or(0) > WATCHER_READ_BYTES_MAX {
            if let Some(first) = messages.first_mut().and_then(Value::as_object_mut) {
                let text = first
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let cut = cut_to_bytes(&text, 32 * 1_024);
                first.insert("text".into(), Value::String(cut));
                truncated = true;
                result = build_result(&messages, &activities, truncated, earlier_available);
            }
        }
        if serde_json::to_string(&result).map(|s| s.len()).unwrap_or(0) > WATCHER_READ_BYTES_MAX {
            return Err(refuse(
                "HISTORY_UNAVAILABLE",
                "This thread’s read exceeds the bounded response size. Read fewer messages.",
            ));
        }

        // Advance read marker unless this was a `requireFresh` settlement probe.
        if input.require_fresh != Some(true) {
            if let Some(last_pos) = result.get("lastPosition").and_then(Value::as_i64) {
                let target_clone = input.target.clone();
                let epoch = read.history_epoch.clone();
                let _ = self.update_record(|next| {
                    next.reads.retain(|r| {
                        r.get("target")
                            .and_then(|t| serde_json::from_value::<WatcherThreadTarget>(t.clone()).ok())
                            .is_none_or(|t| t != target_clone)
                    });
                    next.reads.push(json!({
                        "target": target_clone,
                        "position": { "historyEpoch": epoch, "afterPosition": last_pos },
                        "readAt": now_iso(),
                    }));
                    Ok(())
                });
            }
        }

        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::MockProviderAdapter;
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use tempfile::TempDir;

    async fn setup_service() -> (
        TempDir,
        String,
        Arc<MockProviderAdapter>,
        CoordinatorHandle,
        WatcherHostService,
    ) {
        let dir = TempDir::new().unwrap();
        let host_id = Uuid::new_v4().to_string();
        let mock = Arc::new(MockProviderAdapter::new("codex"));
        let mut providers: BTreeMap<String, Arc<dyn crate::provider::ProviderAdapter>> =
            BTreeMap::new();
        providers.insert("codex".into(), Arc::clone(&mock) as Arc<dyn crate::provider::ProviderAdapter>);
        let coordinator = CoordinatorHandle::spawn(
            dir.path().to_path_buf(),
            host_id.clone(),
            true,
            providers,
        )
        .unwrap();
        let watcher = WatcherHostService::open(
            dir.path().to_path_buf(),
            host_id.clone(),
            coordinator.clone(),
        )
        .unwrap();
        // Wait for startup connect.
        let mut connected = false;
        for _ in 0..50 {
            let s = coordinator.shell(true).await.unwrap();
            if s["host"]["connected"] == Value::Bool(true) {
                watcher.observe_shell(&s);
                connected = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(connected, "mock codex should connect");
        (dir, host_id, mock, coordinator, watcher)
    }

    fn make_master(provider: &str) -> WatcherIdentity {
        WatcherIdentity {
            target: WatcherThreadTarget::new(Uuid::new_v4().to_string(), Uuid::new_v4().to_string()),
            project_id: "watcher-proj".into(),
            provider: provider.into(),
            creation_operation_id: Uuid::new_v4().to_string(),
            created_at: now_iso(),
        }
    }

    #[test]
    fn host_v1_limits_shim_adds_legacy_fields_and_strips_warning() {
        let input = json!({
            "status": "ok",
            "limits": { "promptCount": 1, "promptLimit": 4 },
            "warning": "too many threads",
        });
        let out = watcher_result_for_host_v1(input);
        assert!(out.get("warning").is_none());
        assert_eq!(out["limits"]["inFlight"], 0);
        assert_eq!(out["limits"]["inFlightLimit"], 8);
        assert_eq!(out["limits"]["promptCount"], 1);
        assert_eq!(out["limits"]["promptLimit"], 4);
    }

    #[test]
    fn progress_change_computes_delta_and_falls_back_to_whole_on_reorder() {
        let t1 = WatcherThreadTarget::new(Uuid::new_v4().to_string(), "t1");
        let t2 = WatcherThreadTarget::new(Uuid::new_v4().to_string(), "t2");
        let held = vec![
            WatcherProgressEntry { target: t1.clone(), fingerprint: "a".repeat(64) },
            WatcherProgressEntry { target: t2.clone(), fingerprint: "b".repeat(64) },
        ];
        let next = vec![
            WatcherProgressEntry { target: t1.clone(), fingerprint: "c".repeat(64) },
            WatcherProgressEntry { target: t2.clone(), fingerprint: "b".repeat(64) },
        ];
        let delta = watcher_progress_change(&held, &next);
        assert_eq!(delta.whole, None);
        assert_eq!(delta.changed.len(), 1);
        assert_eq!(delta.changed[0].target, t1);
        assert_eq!(delta.removed, None);

        // Reordering triggers `whole: true`.
        let reordered = vec![next[1].clone(), next[0].clone()];
        let full = watcher_progress_change(&held, &reordered);
        assert_eq!(full.whole, Some(true));
        assert_eq!(full.changed.len(), 2);
    }

    #[test]
    fn digest_matches_js_zod_key_order_for_start_and_send() {
        let req_id = "11111111-1111-4111-8111-111111111111";
        let retry_key = "22222222-2222-4222-8222-222222222222";
        let host_id = "33333333-3333-4333-8333-333333333333";
        let call = WatcherControlCall::SendToThread(SendToThreadInput {
            request_id: req_id.into(),
            retry_key: retry_key.into(),
            target: WatcherThreadTarget::new(host_id, "t-1"),
            text: "hello".into(),
            delivery: Some("now".into()),
            expected_last_user_message_id: None,
            expected_turn_id: None,
            go_merge: None,
        });
        let expected_json = format!(
            r#"["send_to_thread",{{"requestId":"{req_id}","retryKey":"{retry_key}","target":{{"hostId":"{host_id}","threadId":"t-1"}},"text":"hello","delivery":"now"}}]"#
        );
        assert_eq!(call.digest(), sha256_str(&expected_json));
    }

    #[tokio::test]
    async fn admit_start_read_send_stop_settle_and_permission_ceiling() {
        let (_dir, host_id, mock, coordinator, watcher) = setup_service().await;
        let project_dir = TempDir::new().unwrap();
        let mut create_proj = Map::new();
        create_proj.insert("type".into(), json!("create-project"));
        create_proj.insert("title".into(), json!("Repo"));
        create_proj.insert(
            "path".into(),
            json!(project_dir.path().to_string_lossy().to_string()),
        );
        let client = ClientContext {
            client_id: "desktop-1".into(),
            user: "Desktop".into(),
            may_answer: true,
        };
        let shell = coordinator.run_command(client, create_proj).await.unwrap();
        let project_id = shell["host"]["projects"][0]["id"].as_str().unwrap().to_string();
        let model_id = shell["host"]["models"][0]["id"].as_str().unwrap().to_string();

        let master = make_master("codex");
        let req_id = Uuid::new_v4().to_string();
        let thread_id = Uuid::new_v4().to_string();
        let created_at = now_iso();

        // 1. Permission ceiling refused when `may_answer = false` and asking for `full-access`.
        let start_input = StartThreadInput {
            request_id: req_id.clone(),
            retry_key: Uuid::new_v4().to_string(),
            project: WatcherProjectTarget {
                host_id: host_id.clone(),
                project_id: project_id.clone(),
            },
            machine: None,
            os: None,
            role: None,
            model_id: Some(model_id.clone()),
            reasoning_effort: Some("low".into()),
            count: None,
            prompts: None,
            speed: None,
            permission: Some(WatcherPermission::Runtime {
                mode: "full-access".into(),
            }),
            working_copy: WatcherWorkingCopy::Shared {},
            base_ref_choice_id: None,
            title: "Worker 1".into(),
            first_prompt: "Say hello".into(),
            from_thread: None,
            test_run: None,
            from_move: None,
            made_from: None,
            check: None,
            from_origin: None,
        };
        let digest = WatcherControlCall::StartThread(Box::new(start_input.clone())).digest();
        let denied_packet = json!({
            "master": master,
            "request": {
                "id": req_id,
                "watcher": master.target,
                "rootUserMessageId": "root-1",
                "createdAt": created_at,
            },
            "ceiling": "full-access",
            "operation": {
                "id": Uuid::new_v4().to_string(),
                "requestId": req_id,
                "retryKey": start_input.retry_key,
                "digest": digest,
                "action": "start",
                "target": { "hostId": host_id, "threadId": thread_id },
                "generation": 0,
                "delivery": "now",
                "deliveryState": "queued",
                "createdAt": created_at,
                "updatedAt": created_at,
                "receiptId": Uuid::new_v4().to_string(),
                "cardId": Uuid::new_v4().to_string(),
                "creationReceiptId": Uuid::new_v4().to_string(),
                "firstPromptReceiptId": Uuid::new_v4().to_string(),
                "draftId": Uuid::new_v4().to_string(),
                "messageId": Uuid::new_v4().to_string(),
                "anchorMessageId": "root-1",
            },
            "call": { "name": "start_thread", "input": start_input },
        });
        let denied = watcher
            .admit_remote(denied_packet.clone(), "desktop-1", "Desktop", false)
            .await;
        assert_eq!(denied["status"], "refused");
        assert_eq!(denied["code"], "PERMISSION_TOO_WIDE");

        // 2. With `may_answer = true`, start succeeds and does NOT change activeThreadId.
        let started = watcher
            .admit_remote(denied_packet.clone(), "desktop-1", "Desktop", true)
            .await;
        assert_eq!(started["status"], "ok", "start failed: {started}");
        assert_eq!(started["limits"]["inFlight"], 0);
        assert_eq!(started["limits"]["inFlightLimit"], 8);
        assert_eq!(started["limits"]["promptCount"], 1);
        let op_id = started["receipt"]["operationId"].as_str().unwrap().to_string();

        // Active thread was NOT changed by Watcher start.
        let after_shell = coordinator.shell(true).await.unwrap();
        assert!(after_shell["activeThreadId"].is_null());

        // 3. Idempotent retry returns the same receipt.
        let retried = watcher
            .admit_remote(denied_packet, "desktop-1", "Desktop", true)
            .await;
        assert_eq!(retried["status"], "ok");
        assert_eq!(retried["receipt"]["operationId"], op_id);

        // 4. Read thread and verify HISTORY_RESET.
        let read_ok = watcher
            .read_remote(
                json!({
                    "master": master,
                    "call": {
                        "name": "read_thread",
                        "input": { "target": { "hostId": host_id, "threadId": thread_id } }
                    }
                }),
                "desktop-1",
                true,
            )
            .await;
        assert_eq!(read_ok["status"], "ok", "read_thread failed: {read_ok}");
        assert_eq!(read_ok["messages"][0]["text"], "Say hello");

        let read_reset = watcher
            .read_remote(
                json!({
                    "master": master,
                    "call": {
                        "name": "read_thread",
                        "input": {
                            "target": { "hostId": host_id, "threadId": thread_id },
                            "position": { "historyEpoch": "wrong-epoch", "afterPosition": -1 }
                        }
                    }
                }),
                "desktop-1",
                true,
            )
            .await;
        assert_eq!(read_reset["status"], "refused");
        assert_eq!(read_reset["code"], "HISTORY_RESET");

        // 5. Complete the mock turn, then verify read_operation with `outcomes: true`.
        mock.complete_turn(&thread_id, "Synthetic worker reply");
        for _ in 0..50 {
            let s = coordinator.shell(true).await.unwrap();
            watcher.observe_shell(&s);
            if s["host"]["threads"][0]["status"] == "idle" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let op_read = watcher
            .read_remote(
                json!({
                    "master": master,
                    "outcomes": true,
                    "call": { "name": "read_operation", "input": { "operationId": op_id } }
                }),
                "desktop-1",
                true,
            )
            .await;
        assert_eq!(op_read["status"], "ok", "read_operation failed: {op_read}");
        assert_eq!(op_read["outcome"], "answered");
        assert_eq!(op_read["reply"]["from"], "worker");
        assert_eq!(op_read["reply"]["text"], "Synthetic worker reply");

        // 5b. Send a second prompt, interrupt with stop_thread, verify idle.
        let send_input = SendToThreadInput {
            request_id: req_id.clone(),
            retry_key: Uuid::new_v4().to_string(),
            target: WatcherThreadTarget::new(&host_id, &thread_id),
            text: "Second prompt".into(),
            delivery: Some("now".into()),
            expected_last_user_message_id: None,
            expected_turn_id: None,
            go_merge: None,
        };
        let send_digest = WatcherControlCall::SendToThread(send_input.clone()).digest();
        let sent = watcher
            .admit_remote(
                json!({
                    "master": master,
                    "request": {
                        "id": req_id,
                        "watcher": master.target,
                        "rootUserMessageId": "root-1",
                        "createdAt": created_at,
                    },
                    "ceiling": "full-access",
                    "operation": {
                        "id": Uuid::new_v4().to_string(),
                        "requestId": req_id,
                        "retryKey": send_input.retry_key,
                        "digest": send_digest,
                        "action": "send",
                        "target": { "hostId": host_id, "threadId": thread_id },
                        "generation": 0,
                        "delivery": "now",
                        "deliveryState": "queued",
                        "createdAt": created_at,
                        "updatedAt": created_at,
                        "receiptId": Uuid::new_v4().to_string(),
                        "cardId": Uuid::new_v4().to_string(),
                        "draftId": Uuid::new_v4().to_string(),
                        "messageId": Uuid::new_v4().to_string(),
                        "anchorMessageId": "root-1",
                    },
                    "call": { "name": "send_to_thread", "input": send_input },
                }),
                "desktop-1",
                "Desktop",
                true,
            )
            .await;
        assert_eq!(sent["status"], "ok", "send_to_thread failed: {sent}");
        assert_eq!(sent["limits"]["promptCount"], 2);

        let stop_input = StopThreadInput {
            request_id: req_id.clone(),
            retry_key: Uuid::new_v4().to_string(),
            target: WatcherThreadTarget::new(&host_id, &thread_id),
        };
        let stop_digest = WatcherControlCall::StopThread(stop_input.clone()).digest();
        let stopped = watcher
            .admit_remote(
                json!({
                    "master": master,
                    "request": {
                        "id": req_id,
                        "watcher": master.target,
                        "rootUserMessageId": "root-1",
                        "createdAt": created_at,
                    },
                    "ceiling": "full-access",
                    "operation": {
                        "id": Uuid::new_v4().to_string(),
                        "requestId": req_id,
                        "retryKey": stop_input.retry_key,
                        "digest": stop_digest,
                        "action": "stop",
                        "target": { "hostId": host_id, "threadId": thread_id },
                        "generation": 0,
                        "deliveryState": "queued",
                        "createdAt": created_at,
                        "updatedAt": created_at,
                        "receiptId": Uuid::new_v4().to_string(),
                        "cardId": Uuid::new_v4().to_string(),
                        "anchorMessageId": "root-1",
                    },
                    "call": { "name": "stop_thread", "input": stop_input },
                }),
                "desktop-1",
                "Desktop",
                true,
            )
            .await;
        assert_eq!(stopped["status"], "ok", "stop_thread failed: {stopped}");
        assert_eq!(stopped["stopRequested"], true);

        // 6. Settle thread (generation bumped to 1 by stop) and verify workspaceSettledAt is set.
        let settle_input = SettleThreadInput {
            request_id: req_id.clone(),
            retry_key: Uuid::new_v4().to_string(),
            target: WatcherThreadTarget::new(&host_id, &thread_id),
        };
        let settle_digest = WatcherControlCall::SettleThread(settle_input.clone()).digest();
        let settled = watcher
            .admit_remote(
                json!({
                    "master": master,
                    "request": {
                        "id": req_id,
                        "watcher": master.target,
                        "rootUserMessageId": "root-1",
                        "createdAt": created_at,
                    },
                    "ceiling": "full-access",
                    "operation": {
                        "id": Uuid::new_v4().to_string(),
                        "requestId": req_id,
                        "retryKey": settle_input.retry_key,
                        "digest": settle_digest,
                        "action": "settle",
                        "target": { "hostId": host_id, "threadId": thread_id },
                        "generation": 1,
                        "deliveryState": "queued",
                        "createdAt": created_at,
                        "updatedAt": created_at,
                        "receiptId": Uuid::new_v4().to_string(),
                        "cardId": Uuid::new_v4().to_string(),
                        "anchorMessageId": "root-1",
                    },
                    "call": { "name": "settle_thread", "input": settle_input },
                }),
                "desktop-1",
                "Desktop",
                true,
            )
            .await;
        assert_eq!(settled["status"], "ok", "settle failed: {settled}");
        assert_eq!(settled["state"]["settled"], true);

        // Verify send after settle is refused with REQUEST_NOT_ACTIVE.
        let after_settle_input = SendToThreadInput {
            request_id: req_id.clone(),
            retry_key: Uuid::new_v4().to_string(),
            target: WatcherThreadTarget::new(&host_id, &thread_id),
            text: "After settle".into(),
            delivery: Some("now".into()),
            expected_last_user_message_id: None,
            expected_turn_id: None,
            go_merge: None,
        };
        let after_digest = WatcherControlCall::SendToThread(after_settle_input.clone()).digest();
        let refused_after = watcher
            .admit_remote(
                json!({
                    "master": master,
                    "request": {
                        "id": req_id,
                        "watcher": master.target,
                        "rootUserMessageId": "root-1",
                        "createdAt": created_at,
                    },
                    "ceiling": "full-access",
                    "operation": {
                        "id": Uuid::new_v4().to_string(),
                        "requestId": req_id,
                        "retryKey": after_settle_input.retry_key,
                        "digest": after_digest,
                        "action": "send",
                        "target": { "hostId": host_id, "threadId": thread_id },
                        "generation": 1,
                        "delivery": "now",
                        "deliveryState": "queued",
                        "createdAt": created_at,
                        "updatedAt": created_at,
                        "receiptId": Uuid::new_v4().to_string(),
                        "cardId": Uuid::new_v4().to_string(),
                        "draftId": Uuid::new_v4().to_string(),
                        "messageId": Uuid::new_v4().to_string(),
                        "anchorMessageId": "root-1",
                    },
                    "call": { "name": "send_to_thread", "input": after_settle_input },
                }),
                "desktop-1",
                "Desktop",
                true,
            )
            .await;
        assert_eq!(refused_after["status"], "refused");
        assert_eq!(refused_after["code"], "REQUEST_NOT_ACTIVE");

        coordinator.shutdown().await;
    }

    #[tokio::test]
    async fn standing_watches_and_new_owner_adoption() {
        let (_dir, host_id, _mock, coordinator, watcher) = setup_service().await;
        let project_dir = TempDir::new().unwrap();
        let mut create_proj = Map::new();
        create_proj.insert("type".into(), json!("create-project"));
        create_proj.insert("title".into(), json!("Repo"));
        create_proj.insert(
            "path".into(),
            json!(project_dir.path().to_string_lossy().to_string()),
        );
        let client = ClientContext {
            client_id: "desktop-1".into(),
            user: "Desktop".into(),
            may_answer: true,
        };
        let shell = coordinator.run_command(client.clone(), create_proj).await.unwrap();
        let project_id = shell["host"]["projects"][0]["id"].as_str().unwrap().to_string();
        let model_id = shell["host"]["models"][0]["id"].as_str().unwrap().to_string();

        // Create a user thread.
        let tid = Uuid::new_v4().to_string();
        let mut create_t = Map::new();
        create_t.insert("type".into(), json!("create-thread"));
        create_t.insert("threadId".into(), json!(tid));
        create_t.insert("projectId".into(), json!(project_id));
        create_t.insert("modelId".into(), json!(model_id));
        create_t.insert("title".into(), json!("Watched"));
        create_t.insert("workingCopy".into(), json!("shared"));
        let shell = coordinator.run_command(client, create_t).await.unwrap();
        watcher.observe_shell(&shell);

        let old_master = WatcherIdentity {
            target: WatcherThreadTarget::new(Uuid::new_v4().to_string(), "w-old"),
            project_id: "watcher-proj".into(),
            provider: "claude".into(),
            creation_operation_id: Uuid::new_v4().to_string(),
            created_at: "2026-11-01T00:00:00.000Z".into(),
        };
        let watch_id = Uuid::new_v4().to_string();
        let proj = watcher
            .read_remote(
                json!({
                    "master": old_master,
                    "standingWatches": [{
                        "id": watch_id,
                        "target": { "hostId": host_id, "threadId": tid },
                        "createdAt": "2026-11-01T00:00:01.000Z",
                        "generation": 0,
                        "parked": true
                    }]
                }),
                "desktop-1",
                true,
            )
            .await;
        assert_eq!(proj["standingWatches"].as_array().unwrap().len(), 1);
        assert_eq!(proj["standingWatches"][0]["parked"], true);

        // Adopt under a newer Watcher of the same desktop (`watcher-new-owner`).
        let new_master = WatcherIdentity {
            target: WatcherThreadTarget::new(old_master.target.host_id.clone(), "w-new"),
            project_id: "watcher-proj".into(),
            provider: "antigravity".into(),
            creation_operation_id: Uuid::new_v4().to_string(),
            created_at: "2026-11-02T00:00:00.000Z".into(),
        };
        let adopted_proj = watcher
            .read_remote(
                json!({ "master": new_master, "adopt": true }),
                "desktop-1",
                true,
            )
            .await;
        assert_eq!(adopted_proj["standingWatches"].as_array().unwrap().len(), 1);

        // Old master is now refused with NOT_CURRENT_WATCHER.
        let old_refused = watcher
            .read_remote(
                json!({
                    "master": old_master,
                    "standingWatches": []
                }),
                "desktop-1",
                true,
            )
            .await;
        assert_eq!(old_refused["status"], "refused");
        assert_eq!(old_refused["code"], "NOT_CURRENT_WATCHER");

        coordinator.shutdown().await;
    }

    #[tokio::test]
    async fn check_queue_holds_second_check_and_stop_removes_it() {
        let (_dir, host_id, mock, coordinator, watcher) = setup_service().await;
        let project_dir = TempDir::new().unwrap();
        let mut create_proj = Map::new();
        create_proj.insert("type".into(), json!("create-project"));
        create_proj.insert("title".into(), json!("Repo"));
        create_proj.insert(
            "path".into(),
            json!(project_dir.path().to_string_lossy().to_string()),
        );
        let client = ClientContext {
            client_id: "desktop-1".into(),
            user: "Desktop".into(),
            may_answer: true,
        };
        let shell = coordinator.run_command(client, create_proj).await.unwrap();
        let project_id = shell["host"]["projects"][0]["id"].as_str().unwrap().to_string();
        let model_id = shell["host"]["models"][0]["id"].as_str().unwrap().to_string();

        let master = make_master("codex");
        let req_id = Uuid::new_v4().to_string();
        let created_at = now_iso();
        let make_check_packet = |tid: &str, title: &str| {
            let input = StartThreadInput {
                request_id: req_id.clone(),
                retry_key: Uuid::new_v4().to_string(),
                project: WatcherProjectTarget {
                    host_id: host_id.clone(),
                    project_id: project_id.clone(),
                },
                machine: None,
                os: None,
                role: None,
                model_id: Some(model_id.clone()),
                reasoning_effort: None,
                count: None,
                prompts: None,
                speed: None,
                permission: Some(WatcherPermission::Runtime {
                    mode: "approval-required".into(),
                }),
                working_copy: WatcherWorkingCopy::Shared {},
                base_ref_choice_id: None,
                title: title.into(),
                first_prompt: "Run tests".into(),
                from_thread: None,
                test_run: None,
                from_move: None,
                made_from: None,
                check: Some(true),
                from_origin: None,
            };
            let digest = WatcherControlCall::StartThread(Box::new(input.clone())).digest();
            json!({
                "master": master,
                "request": {
                    "id": req_id,
                    "watcher": master.target,
                    "rootUserMessageId": "root-check",
                    "createdAt": created_at,
                },
                "ceiling": "full-access",
                "operation": {
                    "id": Uuid::new_v4().to_string(),
                    "requestId": req_id,
                    "retryKey": input.retry_key,
                    "digest": digest,
                    "action": "start",
                    "target": { "hostId": host_id, "threadId": tid },
                    "generation": 0,
                    "delivery": "now",
                    "deliveryState": "queued",
                    "createdAt": created_at,
                    "updatedAt": created_at,
                    "receiptId": Uuid::new_v4().to_string(),
                    "cardId": Uuid::new_v4().to_string(),
                    "creationReceiptId": Uuid::new_v4().to_string(),
                    "firstPromptReceiptId": Uuid::new_v4().to_string(),
                    "draftId": Uuid::new_v4().to_string(),
                    "messageId": Uuid::new_v4().to_string(),
                    "anchorMessageId": "root-check",
                },
                "call": { "name": "start_thread", "input": input },
            })
        };

        let t1 = Uuid::new_v4().to_string();
        let t2 = Uuid::new_v4().to_string();
        let t3 = Uuid::new_v4().to_string();

        // First check runs immediately.
        let r1 = watcher
            .admit_remote(make_check_packet(&t1, "Check 1"), "desktop-1", "Desktop", true)
            .await;
        assert_eq!(r1["status"], "ok");
        assert!(r1.get("check").is_none());

        // Second check waits behind first (`ahead: 1`), thread not created yet.
        let r2 = watcher
            .admit_remote(make_check_packet(&t2, "Check 2"), "desktop-1", "Desktop", true)
            .await;
        assert_eq!(r2["status"], "ok");
        assert_eq!(r2["check"]["ahead"], 1);
        let shell_mid = coordinator.shell(true).await.unwrap();
        assert!(!shell_mid["host"]["threads"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == t2));

        // Third check waits (`ahead: 2`).
        let r3 = watcher
            .admit_remote(make_check_packet(&t3, "Check 3"), "desktop-1", "Desktop", true)
            .await;
        assert_eq!(r3["status"], "ok");
        assert_eq!(r3["check"]["ahead"], 2);

        // Stop the waiting second check (`watcher-check-stop`).
        let stop2 = StopThreadInput {
            request_id: req_id.clone(),
            retry_key: Uuid::new_v4().to_string(),
            target: WatcherThreadTarget::new(&host_id, &t2),
        };
        let stop2_digest = WatcherControlCall::StopThread(stop2.clone()).digest();
        let stopped2 = watcher
            .admit_remote(
                json!({
                    "master": master,
                    "request": {
                        "id": req_id,
                        "watcher": master.target,
                        "rootUserMessageId": "root-check",
                        "createdAt": created_at,
                    },
                    "ceiling": "full-access",
                    "operation": {
                        "id": Uuid::new_v4().to_string(),
                        "requestId": req_id,
                        "retryKey": stop2.retry_key,
                        "digest": stop2_digest,
                        "action": "stop",
                        "target": { "hostId": host_id, "threadId": t2 },
                        "generation": 0,
                        "deliveryState": "queued",
                        "createdAt": created_at,
                        "updatedAt": created_at,
                        "receiptId": Uuid::new_v4().to_string(),
                        "cardId": Uuid::new_v4().to_string(),
                        "anchorMessageId": "root-check",
                    },
                    "call": { "name": "stop_thread", "input": stop2 },
                }),
                "desktop-1",
                "Desktop",
                true,
            )
            .await;
        assert_eq!(stopped2["status"], "ok");
        assert_eq!(stopped2["stopRequested"], true);

        // Complete Check 1 -> Check 3 is returned to launch!
        mock.complete_turn(&t1, "Check 1 green");
        let mut launched = Vec::new();
        for _ in 0..50 {
            let s = coordinator.shell(true).await.unwrap();
            let next = watcher.observe_shell(&s);
            if !next.is_empty() {
                launched = next;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(launched.len(), 1);
        let (op3, payload3) = launched.pop().unwrap();
        watcher.launch_queued_check(op3, payload3).await;
        let shell_after = coordinator.shell(true).await.unwrap();
        assert!(shell_after["host"]["threads"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == t3));
        // Stopped Check 2 was never started.
        assert!(!shell_after["host"]["threads"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == t2));

        coordinator.shutdown().await;
    }

    #[tokio::test]
    async fn repair_migrates_verified_desktop_and_blocks_cross_desktop_spoofing() {
        let (dir, host_id, _mock, coordinator, watcher) = setup_service().await;
        let desktops = Arc::new(Mutex::new(DesktopClients::new(dir.path())));
        let watcher = watcher.with_desktops(Arc::clone(&desktops));

        let project_dir = TempDir::new().unwrap();
        let mut create_proj = Map::new();
        create_proj.insert("type".into(), json!("create-project"));
        create_proj.insert("title".into(), json!("Repo"));
        create_proj.insert(
            "path".into(),
            json!(project_dir.path().to_string_lossy().to_string()),
        );
        let client = ClientContext {
            client_id: "client-old".into(),
            user: "Desktop A".into(),
            may_answer: true,
        };
        let shell = coordinator.run_command(client.clone(), create_proj).await.unwrap();
        let project_id = shell["host"]["projects"][0]["id"].as_str().unwrap().to_string();
        let model_id = shell["host"]["models"][0]["id"].as_str().unwrap().to_string();

        let tid = Uuid::new_v4().to_string();
        let mut create_t = Map::new();
        create_t.insert("type".into(), json!("create-thread"));
        create_t.insert("threadId".into(), json!(tid));
        create_t.insert("projectId".into(), json!(project_id));
        create_t.insert("modelId".into(), json!(model_id));
        create_t.insert("title".into(), json!("Watched Worker"));
        create_t.insert("workingCopy".into(), json!("shared"));
        let shell = coordinator.run_command(client, create_t).await.unwrap();
        watcher.observe_shell(&shell);

        let desktop_a = Uuid::new_v4().to_string();
        let desktop_b = Uuid::new_v4().to_string();
        let master_old = WatcherIdentity {
            target: WatcherThreadTarget::new(&desktop_a, "w-old"),
            project_id: "watcher-proj".into(),
            provider: "codex".into(),
            creation_operation_id: Uuid::new_v4().to_string(),
            created_at: "2026-11-01T00:00:00.000Z".into(),
        };
        let master_a = WatcherIdentity {
            target: WatcherThreadTarget::new(&desktop_a, "w-current"),
            project_id: "watcher-proj".into(),
            provider: "codex".into(),
            creation_operation_id: Uuid::new_v4().to_string(),
            created_at: "2026-11-02T00:00:00.000Z".into(),
        };
        let watch_1 = Uuid::new_v4().to_string();
        let watch_2 = Uuid::new_v4().to_string();

        // Pre-re-pair sync & send under `client-old` (before desktop-identities.json exists).
        std::fs::write(
            dir.path().join(crate::desktop_clients::DESKTOP_CLIENTS_FILE),
            serde_json::to_string(&["client-old"]).unwrap(),
        )
        .unwrap();
        desktops.lock().unwrap().refresh();

        let synced = watcher
            .read_remote(
                json!({
                    "master": master_a,
                    "standingWatches": [{
                        "id": watch_1,
                        "target": { "hostId": host_id, "threadId": tid },
                        "createdAt": "2026-11-02T00:00:01.000Z",
                        "generation": 0
                    }]
                }),
                "client-old",
                true,
            )
            .await;
        assert_eq!(synced["standingWatches"].as_array().unwrap().len(), 1);

        let make_send = |watch_id: &str, text: &str| {
            let req_id = Uuid::new_v4().to_string();
            let root_msg_id = Uuid::new_v4().to_string();
            let input = SendToThreadInput {
                request_id: req_id.clone(),
                retry_key: Uuid::new_v4().to_string(),
                target: WatcherThreadTarget::new(&host_id, &tid),
                text: text.into(),
                delivery: Some("now".into()),
                expected_last_user_message_id: None,
                expected_turn_id: None,
                go_merge: None,
            };
            let digest = WatcherControlCall::SendToThread(input.clone()).digest();
            let ts = now_iso();
            json!({
                "master": master_a,
                "request": {
                    "id": req_id,
                    "watcher": master_a.target,
                    "rootUserMessageId": root_msg_id,
                    "createdAt": ts,
                    "standingWatchId": watch_id,
                },
                "ceiling": "full-access",
                "operation": {
                    "id": Uuid::new_v4().to_string(),
                    "requestId": req_id,
                    "retryKey": input.retry_key,
                    "digest": digest,
                    "action": "send",
                    "target": { "hostId": host_id, "threadId": tid },
                    "standingWatchId": watch_id,
                    "generation": 0,
                    "delivery": "now",
                    "deliveryState": "queued",
                    "createdAt": ts,
                    "updatedAt": ts,
                    "receiptId": Uuid::new_v4().to_string(),
                    "cardId": Uuid::new_v4().to_string(),
                    "draftId": Uuid::new_v4().to_string(),
                    "messageId": Uuid::new_v4().to_string(),
                    "anchorMessageId": root_msg_id,
                },
                "call": { "name": "send_to_thread", "input": input },
            })
        };

        let sent_1 = watcher
            .admit_remote(make_send(&watch_1, "Before re-pair"), "client-old", "Desktop A", true)
            .await;
        assert_eq!(sent_1["status"], "ok", "pre-repair send failed: {sent_1}");
        let op_1_id = sent_1["receipt"]["operationId"].as_str().unwrap().to_string();

        // Simulate re-pair + another bound desktop B + an unbound desktop U.
        std::fs::write(
            dir.path().join(crate::desktop_clients::DESKTOP_CLIENTS_FILE),
            serde_json::to_string(&["client-new", "client-b", "client-unbound"]).unwrap(),
        )
        .unwrap();
        std::fs::write(
            dir.path().join(crate::desktop_clients::DESKTOP_IDENTITIES_FILE),
            serde_json::to_string(&json!({
                "version": 1,
                "desktops": {
                    "client-new": desktop_a,
                    "client-b": desktop_b
                }
            }))
            .unwrap(),
        )
        .unwrap();
        desktops.lock().unwrap().refresh();

        // Bound Desktop B spoofing Desktop A's masterHostId is refused and gets empty projection.
        let spoof_b_sync = watcher
            .read_remote(json!({ "master": master_a, "standingWatches": [] }), "client-b", true)
            .await;
        assert_eq!(spoof_b_sync["status"], "refused");
        assert_eq!(spoof_b_sync["code"], "INVALID_INPUT");
        let spoof_b_send = watcher
            .admit_remote(make_send(&watch_1, "Spoof B"), "client-b", "Desktop B", true)
            .await;
        assert_eq!(spoof_b_send["status"], "refused");
        assert_eq!(spoof_b_send["code"], "INVALID_INPUT");
        assert!(watcher.remote_projection(&master_a, "client-b").standing_watches.unwrap().is_empty());

        // Unbound Desktop U spoofing Desktop A CANNOT migrate watches, send, or read operations.
        let spoof_u_sync = watcher
            .read_remote(
                json!({
                    "master": master_a,
                    "standingWatches": [{
                        "id": watch_1,
                        "target": { "hostId": host_id, "threadId": tid },
                        "createdAt": "2026-11-02T00:00:01.000Z",
                        "generation": 0
                    }]
                }),
                "client-unbound",
                true,
            )
            .await;
        assert_eq!(spoof_u_sync["status"], "refused");
        assert_eq!(spoof_u_sync["code"], "THREAD_TAKEN_OVER");
        let spoof_u_send = watcher
            .admit_remote(make_send(&watch_1, "Spoof U"), "client-unbound", "Unbound", true)
            .await;
        assert_eq!(spoof_u_send["status"], "refused");
        assert_eq!(spoof_u_send["code"], "REQUEST_NOT_ACTIVE");
        let spoof_u_read = watcher
            .read_remote(
                json!({
                    "master": master_a,
                    "call": { "name": "read_operation", "input": { "operationId": op_1_id } }
                }),
                "client-unbound",
                true,
            )
            .await;
        assert_eq!(spoof_u_read["status"], "refused");
        assert_eq!(spoof_u_read["code"], "UNKNOWN_OPERATION");

        // Verified re-paired Desktop A (`client-new`) migrates watches & operations seamlessly!
        let synced_after = watcher
            .read_remote(
                json!({
                    "master": master_a,
                    "standingWatches": [{
                        "id": watch_1,
                        "target": { "hostId": host_id, "threadId": tid },
                        "createdAt": "2026-11-02T00:00:01.000Z",
                        "generation": 0
                    }]
                }),
                "client-new",
                true,
            )
            .await;
        assert_eq!(synced_after["standingWatches"].as_array().unwrap().len(), 1);
        assert_eq!(synced_after["standingWatches"][0]["remoteOrigin"]["clientId"], "client-new");

        // Replacement watermark survives re-pair (`NOT_CURRENT_WATCHER` for older Watcher).
        let old_refused = watcher
            .read_remote(json!({ "master": master_old, "standingWatches": [] }), "client-new", true)
            .await;
        assert_eq!(old_refused["status"], "refused");
        assert_eq!(old_refused["code"], "NOT_CURRENT_WATCHER");

        // Pre-re-pair operation read succeeds under `client-new`.
        let op_read = watcher
            .read_remote(
                json!({
                    "master": master_a,
                    "call": { "name": "read_operation", "input": { "operationId": op_1_id } }
                }),
                "client-new",
                true,
            )
            .await;
        assert_eq!(op_read["status"], "ok");
        assert_eq!(op_read["receipt"]["operationId"], op_1_id);

        // Toggling Watch off/on (replacing watch_1 with watch_2 on the same thread) succeeds cleanly.
        let replaced = watcher
            .read_remote(
                json!({
                    "master": master_a,
                    "standingWatches": [{
                        "id": watch_2,
                        "target": { "hostId": host_id, "threadId": tid },
                        "createdAt": "2026-11-02T00:05:00.000Z",
                        "generation": 0
                    }]
                }),
                "client-new",
                true,
            )
            .await;
        assert_eq!(replaced["standingWatches"][0]["id"], watch_2);

        // Wait for first mock turn to finish or just complete it before sending under watch_2.
        _mock.complete_turn(&tid, "Done 1");
        for _ in 0..50 {
            let s = coordinator.shell(true).await.unwrap();
            watcher.observe_shell(&s);
            if s["host"]["threads"][0]["status"] == "idle" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let sent_2 = watcher
            .admit_remote(make_send(&watch_2, "After re-pair"), "client-new", "Desktop A", true)
            .await;
        assert_eq!(sent_2["status"], "ok", "post-repair send failed: {sent_2}");

        // Deduplicated remoteMasters for desktop_a.
        let snap = watcher.record_snapshot();
        let masters_a: Vec<&Value> = snap
            .remote_masters
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .filter(|m| m.get("masterHostId").and_then(Value::as_str) == Some(desktop_a.as_str()))
            .collect();
        assert_eq!(masters_a.len(), 1);
        assert_eq!(masters_a[0]["clientId"], "client-new");

        coordinator.shutdown().await;
    }

    /// #2873: replacing Watcher (New Watcher or a provider change) gives the desktop a new Watcher conversation, and its standing watches here stay bound
    /// to the old one until the desktop's reconnect read (the new Watcher, `adopt` and its standing watches) re-binds
    /// them, including when the desktop re-paired in between and is heard under a new `clientId`.
    async fn replace_watcher_reconnect_then_send(repair: bool) {
        let (dir, host_id, mock, coordinator, watcher) = setup_service().await;
        let desktops = Arc::new(Mutex::new(DesktopClients::new(dir.path())));
        let watcher = watcher.with_desktops(Arc::clone(&desktops));

        let project_dir = TempDir::new().unwrap();
        let mut create_proj = Map::new();
        create_proj.insert("type".into(), json!("create-project"));
        create_proj.insert("title".into(), json!("Repo"));
        create_proj.insert(
            "path".into(),
            json!(project_dir.path().to_string_lossy().to_string()),
        );
        let client = ClientContext {
            client_id: "client-old".into(),
            user: "Desktop A".into(),
            may_answer: true,
        };
        let shell = coordinator.run_command(client.clone(), create_proj).await.unwrap();
        let project_id = shell["host"]["projects"][0]["id"].as_str().unwrap().to_string();
        let model_id = shell["host"]["models"][0]["id"].as_str().unwrap().to_string();
        let tid = Uuid::new_v4().to_string();
        let mut create_t = Map::new();
        create_t.insert("type".into(), json!("create-thread"));
        create_t.insert("threadId".into(), json!(tid));
        create_t.insert("projectId".into(), json!(project_id));
        create_t.insert("modelId".into(), json!(model_id));
        create_t.insert("title".into(), json!("Watched Worker"));
        create_t.insert("workingCopy".into(), json!("shared"));
        let shell = coordinator.run_command(client, create_t).await.unwrap();
        watcher.observe_shell(&shell);

        let desktop_a = Uuid::new_v4().to_string();
        let identity = |thread: &str, created_at: &str| WatcherIdentity {
            target: WatcherThreadTarget::new(&desktop_a, thread),
            project_id: "watcher-proj".into(),
            provider: "codex".into(),
            creation_operation_id: Uuid::new_v4().to_string(),
            created_at: created_at.into(),
        };
        let before = identity("w-before", "2026-11-22T00:00:00.000Z");
        let after = identity("w-after", "2026-11-25T02:24:27.772Z");
        let watch_id = Uuid::new_v4().to_string();
        let watch = json!([{
            "id": watch_id,
            "target": { "hostId": host_id, "threadId": tid },
            "createdAt": "2026-11-22T00:00:01.000Z",
            "generation": 0
        }]);
        let make_send = |master: &WatcherIdentity, text: &str| {
            let req_id = Uuid::new_v4().to_string();
            let root_msg_id = Uuid::new_v4().to_string();
            let input = SendToThreadInput {
                request_id: req_id.clone(),
                retry_key: Uuid::new_v4().to_string(),
                target: WatcherThreadTarget::new(&host_id, &tid),
                text: text.into(),
                delivery: Some("now".into()),
                expected_last_user_message_id: None,
                expected_turn_id: None,
                go_merge: None,
            };
            let digest = WatcherControlCall::SendToThread(input.clone()).digest();
            let ts = now_iso();
            json!({
                "master": master,
                "request": {
                    "id": req_id,
                    "watcher": master.target,
                    "rootUserMessageId": root_msg_id,
                    "createdAt": ts,
                    "standingWatchId": watch_id,
                },
                "ceiling": "full-access",
                "operation": {
                    "id": Uuid::new_v4().to_string(),
                    "requestId": req_id,
                    "retryKey": input.retry_key,
                    "digest": digest,
                    "action": "send",
                    "target": { "hostId": host_id, "threadId": tid },
                    "standingWatchId": watch_id,
                    "generation": 0,
                    "delivery": "now",
                    "deliveryState": "queued",
                    "createdAt": ts,
                    "updatedAt": ts,
                    "receiptId": Uuid::new_v4().to_string(),
                    "cardId": Uuid::new_v4().to_string(),
                    "draftId": Uuid::new_v4().to_string(),
                    "messageId": Uuid::new_v4().to_string(),
                    "anchorMessageId": root_msg_id,
                },
                "call": { "name": "send_to_thread", "input": input },
            })
        };

        // A pairing from before desktop-identities.json existed, as forge's was.
        std::fs::write(
            dir.path().join(crate::desktop_clients::DESKTOP_CLIENTS_FILE),
            serde_json::to_string(&["client-old"]).unwrap(),
        )
        .unwrap();
        desktops.lock().unwrap().refresh();
        let synced = watcher
            .read_remote(
                json!({ "master": before, "adopt": true, "standingWatches": watch }),
                "client-old",
                true,
            )
            .await;
        assert_eq!(synced["standingWatches"].as_array().unwrap().len(), 1, "{synced}");
        let sent = watcher
            .admit_remote(make_send(&before, "Before the replacement"), "client-old", "Desktop A", true)
            .await;
        assert_eq!(sent["status"], "ok", "send before the replacement failed: {sent}");
        mock.complete_turn(&tid, "Done");
        let mut idle = false;
        for _ in 0..250 {
            let s = coordinator.shell(true).await.unwrap();
            watcher.observe_shell(&s);
            if s["host"]["threads"][0]["status"] == "idle" {
                idle = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(idle, "the watched thread's turn should finish");

        // Watcher is replaced, and for the re-pair case the launch script's SSH-recorded new pairing.
        let client_id = if repair { "client-new" } else { "client-old" };
        if repair {
            std::fs::write(
                dir.path().join(crate::desktop_clients::DESKTOP_CLIENTS_FILE),
                serde_json::to_string(&["client-new"]).unwrap(),
            )
            .unwrap();
            std::fs::write(
                dir.path().join(crate::desktop_clients::DESKTOP_IDENTITIES_FILE),
                serde_json::to_string(&json!({ "version": 1, "desktops": { "client-new": desktop_a } }))
                    .unwrap(),
            )
            .unwrap();
            desktops.lock().unwrap().refresh();
        }

        // Until the host hears from the new Watcher, the watch is the old one's. A send shows it only without a re-pair:
        // admission migrates a re-paired desktop's records before it refuses, leaving the reconnect read nothing to migrate.
        if !repair {
            let early = watcher
                .admit_remote(make_send(&after, "Too early"), client_id, "Desktop A", true)
                .await;
            assert_eq!(early["status"], "refused", "{early}");
            assert_eq!(early["code"], "REQUEST_NOT_ACTIVE");
        } else {
            let snap = watcher.record_snapshot();
            let origin = snap
                .watches
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .find(|w| w.id == watch_id)
                .and_then(|w| w.remote_origin.clone())
                .expect("the watch is still installed");
            assert_eq!(origin.client_id, "client-old");
            assert_eq!(
                origin.master_creation_operation_id.as_deref(),
                Some(before.creation_operation_id.as_str())
            );
        }

        // The desktop's reconnect read under the new Watcher migrates and re-binds the watch to it.
        let reconnected = watcher
            .read_remote(
                json!({ "master": after, "adopt": true, "standingWatches": watch }),
                client_id,
                true,
            )
            .await;
        let origin = &reconnected["standingWatches"][0]["remoteOrigin"];
        assert_eq!(origin["clientId"], client_id, "{reconnected}");
        assert_eq!(origin["masterCreationOperationId"], after.creation_operation_id.as_str());
        assert_eq!(origin["masterCreatedAt"], after.created_at.as_str());

        // Watcher's next send on the watched thread goes, and the replaced Watcher stays refused.
        let sent = watcher
            .admit_remote(make_send(&after, "After the replacement"), client_id, "Desktop A", true)
            .await;
        assert_eq!(sent["status"], "ok", "send after the replacement failed: {sent}");
        let stale = watcher
            .admit_remote(make_send(&before, "From the replaced Watcher"), client_id, "Desktop A", true)
            .await;
        assert_eq!(stale["status"], "refused", "{stale}");
        assert_eq!(stale["code"], "NOT_CURRENT_WATCHER");
        let snap = watcher.record_snapshot();
        let masters: Vec<&Value> = snap
            .remote_masters
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .filter(|m| m.get("masterHostId").and_then(Value::as_str) == Some(desktop_a.as_str()))
            .collect();
        assert_eq!(masters.len(), 1);
        assert_eq!(masters[0]["clientId"], client_id);
        assert_eq!(masters[0]["creationOperationId"], after.creation_operation_id.as_str());

        coordinator.shutdown().await;
    }

    #[tokio::test]
    async fn new_watcher_then_reconnect_rebinds_watches_so_sends_go() {
        replace_watcher_reconnect_then_send(false).await;
    }

    #[tokio::test]
    async fn new_watcher_then_repair_and_reconnect_rebinds_watches_so_sends_go() {
        replace_watcher_reconnect_then_send(true).await;
    }
}
