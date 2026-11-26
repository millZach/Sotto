//! Watcher Master (ADR-0073, ADR-0144, ADR-0215 Phase 4b Slice 7).
//!
//! Owns the durable stores, watched-thread registry across local and remote hosts,
//! `WatcherRoomState` projection and `WatcherRoomBroadcast` delta patching, handover,
//! Stop all confirmation & execution, `tellWatcher` / `readyToMerge`, Watcher's own
//! questions, kept state (`keep_state` / `read_state`), hold state, limit restarts,
//! and follow-up queue with 100% on-disk and wire parity with TypeScript.
//!
//! Never logs user prose, prompt text, transcripts, tokens, or provider protocol bodies.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::coordinator::{ClientContext, CoordinatorHandle};
use crate::host_facts::global_host_facts_sampler;
use crate::host_router::DesktopHostRouter;
use crate::workspace::{now_iso, write_atomic_json};

// ---------------------------------------------------------------------------
// File names & protocol constants (exact TypeScript parity)
// ---------------------------------------------------------------------------

pub const WATCHER_RECORD_FILE: &str = "watcher-record.json";
pub const WATCHER_STATE_FILE: &str = "watcher-state.json";
pub const WATCHER_QUESTIONS_FILE: &str = "watcher-questions.json";
pub const WATCHER_TOLD_FILE: &str = "watcher-told.json";
pub const LIMIT_RESTARTS_FILE: &str = "limit-restarts.json";
pub const FOLLOWUPS_FILE: &str = "followups.json";

pub const WATCHER_SAVED_RESERVATIONS_MAX: usize = 8;
pub const WATCHER_PROMPT_TURNS_KEPT: usize = 50;
pub const WATCHER_PROMPTS_PER_THREAD: u32 = 4;
pub const WATCHER_READY_PRS_MAX: usize = 200;
pub const WATCHER_USER_UNWATCHES_MAX: usize = 10_000;
pub const WATCHER_TOLD_KEPT_MAX: usize = 200;
pub const WATCHER_QUESTIONS_KEPT: usize = 50;
pub const WATCHER_STOP_ALL_PREVIEW_LIMIT: usize = 16;
pub const WATCHER_STOP_ALL_TTL_MS: i64 = 60_000;
pub const WATCHER_KEPT_ITEMS_MAX: usize = 30;
pub const WATCHER_KEPT_RULES_MAX: usize = 60;
pub const WATCHER_KEPT_ITEM_MAX: usize = 300;
pub const WATCHER_KEPT_CLOSED_MAX: usize = 30;
pub const WATCHER_KEPT_CLOSED_MS: i64 = 24 * 60 * 60 * 1_000;
pub const WATCHER_STATE_GONE_MAX: usize = 500;
pub const WATCHER_STATE_CURSORS_HELD: usize = 8;
pub const WATCHER_FAILING_RETRY_MS: i64 = 5 * 60_000;
pub const WATCHER_HOLD_DETAIL_MAX: usize = 600;
pub const WATCHER_COMPACT_AT_DEFAULT: u64 = 160_000;
pub const LIMIT_RESTART_GRACE_MS: i64 = 60_000;
pub const LIMIT_RESTART_HORIZON_MS: i64 = 8 * 24 * 60 * 60 * 1_000;
pub const LIMIT_RESTARTS_IN_A_ROW_MAX: u32 = 3;
pub const LIMIT_RESTARTS_RECORDS_MAX: usize = 500;
pub const FOLLOWUPS_PER_THREAD_MAX: usize = 100;
/// The receipts `followups.json` keeps, the newest, as Node's `MAX_DELIVERED_DRAFTS`: its schema reads no more than
/// twice as many, so a file holding more would be set aside whole by Node.
pub const FOLLOWUPS_RECEIPTS_MAX: usize = 128;
pub const WATCHER_UNWATCHED_REQUEST_ID: &str = "00000000-0000-0000-0000-000000000000";
pub const WATCHER_SILENT_REPLY: &str = "NO_REPLY";
pub const SETTLE_IT: &str = "Settle it";
pub const KEEP_WATCHING: &str = "Keep watching";
pub const TELL_WATCHER_WORDS_BYTES_MAX: usize = 2_048;

const WATCHER_PROVIDERS: &[&str] = &["codex", "claude", "grok", "muse", "cursor", "antigravity"];
const RETIRED_WATCHER_KINDS: &[&str] = &[
    "to-do-added",
    "to-do-checked",
    "prototype-ready",
    "prototype-closed",
];

// ---------------------------------------------------------------------------
// Core shared identity & record types
// ---------------------------------------------------------------------------

/// Reads a field Node writes as `null` or leaves out as two answers: `Some(None)` for `null`, so a save writes the
/// `null` back, and `None` (with `default`) for a field that is not there.
fn present_or_null<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherThreadTarget {
    pub host_id: String,
    pub thread_id: String,
}

impl WatcherThreadTarget {
    pub fn new(host_id: impl Into<String>, thread_id: impl Into<String>) -> Self {
        Self {
            host_id: host_id.into(),
            thread_id: thread_id.into(),
        }
    }

    pub fn key(&self) -> String {
        format!("{}:{}|{}", self.host_id.len(), self.host_id, self.thread_id)
    }

    pub fn json_key(&self) -> String {
        serde_json::to_string(&(&self.host_id, &self.thread_id)).unwrap_or_default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherIdentity {
    pub target: WatcherThreadTarget,
    pub project_id: String,
    pub provider: String,
    pub creation_operation_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherWatchOrigin {
    pub client_id: String,
    pub master_host_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub master_creation_operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub master_created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherStandingWatch {
    pub id: String,
    pub target: WatcherThreadTarget,
    pub created_at: String,
    pub generation: u64,
    #[serde(default, deserialize_with = "present_or_null", skip_serializing_if = "Option::is_none")]
    pub paused_by_user_message_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "present_or_null", skip_serializing_if = "Option::is_none")]
    pub last_user_message_id: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_origin: Option<WatcherWatchOrigin>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherTakeover {
    pub reason: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherParticipant {
    pub request_id: String,
    pub started_by: String,
    pub generation: u64,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub takeover: Option<WatcherTakeover>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automation_stopped: Option<bool>,
    pub target: WatcherThreadTarget,
    #[serde(default, deserialize_with = "present_or_null", skip_serializing_if = "Option::is_none")]
    pub last_user_message_id: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parked: Option<bool>,
    pub prompt_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherRequest {
    pub id: String,
    pub watcher: WatcherThreadTarget,
    pub root_user_message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub standing_watch_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_prompt: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handover: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone_origin: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paired_permission_ceiling: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_origin: Option<Value>,
    pub state: String,
    pub created_at: String,
    pub closed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_followups: Option<Vec<Value>>,
    pub participants: Vec<WatcherParticipant>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherPromptTurn {
    pub id: String,
    pub watcher: WatcherThreadTarget,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_user_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_native_turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherOperation {
    pub id: String,
    pub request_id: String,
    pub retry_key: String,
    pub digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_refunded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub standing_watch_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_digest: Option<String>,
    pub action: String,
    pub target: WatcherThreadTarget,
    pub generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<String>,
    pub delivery_state: String,
    pub created_at: String,
    pub updated_at: String,
    pub receipt_id: String,
    pub card_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_receipt_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_prompt_receipt_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_last_user_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed_stop: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_uncertain: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refusal_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_message_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherReservation {
    pub target: WatcherThreadTarget,
    pub request_id: String,
    pub operation_id: String,
    pub generation: u64,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherReadyPullRequest {
    pub target: WatcherThreadTarget,
    pub url: String,
    pub head: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherUserUnwatch {
    pub target: WatcherThreadTarget,
    pub watcher_head: Option<String>,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherCreation {
    pub identity: WatcherIdentity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, deserialize_with = "present_or_null", skip_serializing_if = "Option::is_none")]
    pub speed: Option<Option<String>>,
    pub phase: String,
    pub replaces: Option<WatcherThreadTarget>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherRecord {
    pub version: u32,
    pub current: Option<WatcherIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_turns: Option<Vec<WatcherPromptTurn>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_runtime_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub watches: Option<Vec<WatcherStandingWatch>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready_pull_requests: Option<Vec<WatcherReadyPullRequest>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub watch_fences: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_unwatches: Option<Vec<WatcherUserUnwatch>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_takeovers: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_masters: Option<Vec<Value>>,
    pub creation: Option<WatcherCreation>,
    pub history: Vec<WatcherIdentity>,
    pub requests: Vec<WatcherRequest>,
    pub operations: Vec<WatcherOperation>,
    pub reservations: Vec<WatcherReservation>,
    pub reads: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_absences: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wake_event_ids: Option<Vec<String>>,
}

impl WatcherRecord {
    pub fn empty() -> Self {
        Self {
            version: 1,
            current: None,
            prompt_turns: None,
            last_runtime_mode: None,
            watches: None,
            ready_pull_requests: None,
            watch_fences: None,
            user_unwatches: None,
            local_takeovers: None,
            remote_masters: None,
            creation: None,
            history: Vec::new(),
            requests: Vec::new(),
            operations: Vec::new(),
            reservations: Vec::new(),
            reads: Vec::new(),
            remote_absences: None,
            wake_event_ids: None,
        }
    }
}

/// Validates all invariants enforced by TypeScript's `watcherRecordSchema.superRefine`.
pub fn validate_watcher_record(record: &WatcherRecord) -> Result<(), String> {
    if record.version != 1 {
        return Err("Watcher record version must be 1.".into());
    }
    let check_unique = |iter: Vec<String>| -> bool {
        let len = iter.len();
        let set: HashSet<String> = iter.into_iter().collect();
        set.len() == len
    };

    if !check_unique(record.requests.iter().map(|r| r.id.clone()).collect())
        || !check_unique(record.operations.iter().map(|o| o.id.clone()).collect())
        || !check_unique(
            record
                .prompt_turns
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .map(|t| t.id.clone())
                .collect(),
        )
        || !check_unique(
            record
                .watches
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .map(|w| w.target.key())
                .collect(),
        )
        || !check_unique(
            record
                .watches
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .map(|w| w.id.clone())
                .collect(),
        )
        || !check_unique(
            record
                .requests
                .iter()
                .map(|r| format!("{}|{}", r.watcher.key(), r.root_user_message_id))
                .collect(),
        )
        || !check_unique(
            record
                .operations
                .iter()
                .map(|o| format!("{}:{}", o.request_id, o.retry_key))
                .collect(),
        )
        || !check_unique(record.history.iter().map(|h| h.target.key()).collect())
        || !check_unique(record.reservations.iter().map(|r| r.target.key()).collect())
        || record.current.as_ref().is_some_and(|cur| {
            record
                .history
                .iter()
                .any(|h| h.target.key() == cur.target.key())
        })
    {
        return Err("watcher identities must be unique.".into());
    }

    if let Some(ref creation) = record.creation {
        let conflict = match (&creation.replaces, &record.current) {
            (Some(replaces), Some(cur)) => {
                replaces.key() != cur.target.key() || creation.identity.target.key() == replaces.key()
            }
            (Some(_), None) => true,
            (None, Some(cur)) => cur != &creation.identity,
            (None, None) => false,
        };
        if conflict
            || record
                .history
                .iter()
                .any(|h| h.target.key() == creation.identity.target.key())
        {
            return Err("Creation must preserve the current watcher identity.".into());
        }
    }

    let req_ids: HashSet<&str> = record.requests.iter().map(|r| r.id.as_str()).collect();
    let turn_ids: HashSet<&str> = record
        .prompt_turns
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|t| t.id.as_str())
        .collect();
    let op_ids: HashSet<&str> = record.operations.iter().map(|o| o.id.as_str()).collect();

    for req in &record.requests {
        if (req.state == "active") != req.closed_at.is_none() {
            return Err("Request state and participation must agree with their retained fences.".into());
        }
        if !check_unique(req.participants.iter().map(|p| p.target.key()).collect()) {
            return Err("Request state and participation must agree with their retained fences.".into());
        }
        for p in &req.participants {
            if p.request_id != req.id || (p.state == "taken-over") != p.takeover.is_some() {
                return Err(
                    "Request state and participation must agree with their retained fences.".into(),
                );
            }
        }
    }

    for op in &record.operations {
        if op.confirmed_stop == Some(true) && op.action != "stop" {
            return Err("Only an explicit confirmed Stop can carry this marker.".into());
        }
        if !req_ids.contains(op.request_id.as_str()) {
            return Err("Control references must name retained requests and operations.".into());
        }
        if let Some(ref pt) = op.prompt_turn_id {
            if !turn_ids.contains(pt.as_str()) {
                return Err("Control references must name retained requests and operations.".into());
            }
        }
    }
    for res in &record.reservations {
        if !req_ids.contains(res.request_id.as_str()) || !op_ids.contains(res.operation_id.as_str()) {
            return Err("Control references must name retained requests and operations.".into());
        }
    }
    Ok(())
}

/// Drops prompt turns nothing reads any more (`watcherRecords.ts:prunePromptTurns`).
pub fn prune_prompt_turns(record: &mut WatcherRecord) {
    let Some(turns) = record.prompt_turns.as_mut() else {
        return;
    };
    if turns.len() <= WATCHER_PROMPT_TURNS_KEPT {
        return;
    }
    let counted: HashSet<String> = record
        .operations
        .iter()
        .filter_map(|op| op.prompt_turn_id.clone())
        .collect();
    let mut newest: HashSet<String> = HashSet::new();
    let mut watchers: HashSet<String> = HashSet::new();
    for turn in turns.iter().rev() {
        let wk = turn.watcher.json_key();
        if watchers.insert(wk) {
            newest.insert(turn.id.clone());
        }
    }
    let recent = turns.len() - WATCHER_PROMPT_TURNS_KEPT;
    let mut idx = 0usize;
    turns.retain(|turn| {
        let keep = idx >= recent || counted.contains(&turn.id) || newest.contains(&turn.id);
        idx += 1;
        keep
    });
}

/// Caps saved reservations to 8, prioritizing unresolved operations (`watcherRecordForDisk`).
pub fn watcher_record_for_disk(record: &WatcherRecord) -> WatcherRecord {
    if record.reservations.len() <= WATCHER_SAVED_RESERVATIONS_MAX {
        return record.clone();
    }
    let mut unresolved: HashSet<String> = HashSet::new();
    for op in &record.operations {
        if op.creation_uncertain == Some(true)
            || matches!(
                op.delivery_state.as_str(),
                "queued" | "dispatching" | "uncertain"
            )
        {
            unresolved.insert(op.target.json_key());
        }
    }
    let mut first = Vec::new();
    let mut rest = Vec::new();
    for res in &record.reservations {
        if unresolved.contains(&res.target.json_key()) {
            first.push(res.clone());
        } else {
            rest.push(res.clone());
        }
    }
    first.extend(rest);
    first.truncate(WATCHER_SAVED_RESERVATIONS_MAX);
    let mut out = record.clone();
    out.reservations = first;
    out
}

/// Rebuilds reservations omitted by `watcher_record_for_disk` (`rebuildReservations`).
pub fn rebuild_reservations(record: &mut WatcherRecord) -> bool {
    let before = record.reservations.len();
    let mut reserved: HashSet<String> = record
        .reservations
        .iter()
        .map(|r| r.target.json_key())
        .collect();
    let req_map: HashMap<&str, &WatcherRequest> = record
        .requests
        .iter()
        .map(|r| (r.id.as_str(), r))
        .collect();
    let mut to_add = Vec::new();
    for op in &record.operations {
        if op.action != "start" || op.delivery_state == "failed" {
            continue;
        }
        let tk = op.target.json_key();
        if reserved.contains(&tk) {
            continue;
        }
        let Some(req) = req_map.get(op.request_id.as_str()) else {
            continue;
        };
        if req.state != "active" {
            continue;
        }
        let Some(part) = req
            .participants
            .iter()
            .find(|p| p.target.json_key() == tk && p.state == "participating")
        else {
            continue;
        };
        reserved.insert(tk);
        to_add.push(WatcherReservation {
            target: op.target.clone(),
            request_id: op.request_id.clone(),
            operation_id: op.id.clone(),
            generation: part.generation,
            reason: "creation".into(),
        });
    }
    record.reservations.extend(to_add);
    record.reservations.len() > before
}

// ---------------------------------------------------------------------------
// WatcherRecordStore (`watcher-record.json` with `agents.json` legacy fallback)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct WatcherRecordEnvelope {
    watcher: WatcherRecord,
}

#[derive(Debug)]
pub struct WatcherRecordStore {
    directory: PathBuf,
    record: WatcherRecord,
}

impl WatcherRecordStore {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
            record: WatcherRecord::empty(),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.directory.join(WATCHER_RECORD_FILE)
    }

    pub fn load(&mut self) -> Result<(), String> {
        let own = self.path();
        if own.exists() {
            let text = fs::read_to_string(&own)
                .map_err(|e| format!("Could not read watcher-record.json: {e}"))?;
            // A record this build cannot read is set aside, as Node does, so the next update does not write over it.
            let env = serde_json::from_str::<WatcherRecordEnvelope>(&text)
                .map_err(|e| format!("Invalid watcher-record.json: {e}"))
                .and_then(|env| validate_watcher_record(&env.watcher).map(|()| env))
                .inspect_err(|_| set_aside_unreadable(&own))?;
            self.record = env.watcher;
            rebuild_reservations(&mut self.record);
            return Ok(());
        }
        let legacy = self.directory.join("agents.json");
        if legacy.exists() {
            if let Ok(text) = fs::read_to_string(&legacy) {
                if let Ok(val) = serde_json::from_str::<Value>(&text) {
                    if let Some(w) = val.get("watcher").filter(|v| !v.is_null()) {
                        let rec: WatcherRecord = serde_json::from_value(w.clone())
                            .map_err(|e| format!("Invalid legacy watcher record: {e}"))?;
                        validate_watcher_record(&rec)?;
                        self.record = rec;
                        rebuild_reservations(&mut self.record);
                        return Ok(());
                    }
                }
            }
        }
        self.record = WatcherRecord::empty();
        Ok(())
    }

    pub fn view(&self) -> &WatcherRecord {
        &self.record
    }

    pub fn update<F, R>(&mut self, mutate: F) -> Result<R, String>
    where
        F: FnOnce(&mut WatcherRecord) -> Result<R, String>,
    {
        let mut next = self.record.clone();
        let out = mutate(&mut next)?;
        prune_prompt_turns(&mut next);
        validate_watcher_record(&next)?;
        if next != self.record {
            let for_disk = watcher_record_for_disk(&next);
            let env = WatcherRecordEnvelope { watcher: for_disk };
            let text = serde_json::to_string(&env)
                .map_err(|e| format!("Could not serialize watcher record: {e}"))?;
            write_atomic_compact(&self.path(), &text)?;
            self.record = next;
        }
        Ok(out)
    }
}

fn write_atomic_compact(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Could not create folder: {e}"))?;
    }
    let tmp = path.with_extension(format!("json.tmp-{}", Uuid::new_v4()));
    fs::write(&tmp, text).map_err(|e| format!("Could not write temporary file: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Could not commit file {}: {e}", path.display())
    })
}

/// Moves a store this build cannot read aside as `<name>.corrupt-<millis>`, as Node's `AtomicJsonStore` does, so the
/// next save does not write over what was in it (ADR-0214).
fn set_aside_unreadable(path: &Path) {
    let _ = fs::rename(path, crate::workspace::corrupt_copy_path(path));
}

fn remove_file_and_backups(directory: &Path, base_name: &str) -> Result<(), String> {
    let entries = match fs::read_dir(directory) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(format!("Could not read directory: {err}")),
    };
    let prefix = format!("{base_name}.");
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == base_name || name_str.starts_with(&prefix) {
            if let Err(err) = fs::remove_file(entry.path()) {
                if err.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!("Could not remove {name_str}: {err}"));
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// WatcherStateStore (`watcher-state.json` — kept decisions, rules, issues)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WatcherKeptList {
    Decisions,
    Rules,
    Issues,
}

impl WatcherKeptList {
    pub const ALL: [Self; 3] = [Self::Decisions, Self::Rules, Self::Issues];

    pub fn letter(self) -> char {
        match self {
            Self::Decisions => 'd',
            Self::Rules => 'r',
            Self::Issues => 'i',
        }
    }

    pub fn from_letter(ch: char) -> Option<Self> {
        match ch {
            'd' => Some(Self::Decisions),
            'r' => Some(Self::Rules),
            'i' => Some(Self::Issues),
            _ => None,
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Decisions => "Decisions",
            Self::Rules => "Rules",
            Self::Issues => "Issues",
        }
    }

    pub fn open_max(self) -> usize {
        match self {
            Self::Rules => WATCHER_KEPT_RULES_MAX,
            Self::Decisions | Self::Issues => WATCHER_KEPT_ITEMS_MAX,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherKeptItem {
    pub id: String,
    pub text: String,
    pub touched_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherKeptState {
    pub decisions: Vec<WatcherKeptItem>,
    pub rules: Vec<WatcherKeptItem>,
    pub issues: Vec<WatcherKeptItem>,
    pub updated_at: Option<String>,
}

impl WatcherKeptState {
    pub fn empty() -> Self {
        Self {
            decisions: Vec::new(),
            rules: Vec::new(),
            issues: Vec::new(),
            updated_at: None,
        }
    }

    pub fn list(&self, list: WatcherKeptList) -> &[WatcherKeptItem] {
        match list {
            WatcherKeptList::Decisions => &self.decisions,
            WatcherKeptList::Rules => &self.rules,
            WatcherKeptList::Issues => &self.issues,
        }
    }

    pub fn list_mut(&mut self, list: WatcherKeptList) -> &mut Vec<WatcherKeptItem> {
        match list {
            WatcherKeptList::Decisions => &mut self.decisions,
            WatcherKeptList::Rules => &mut self.rules,
            WatcherKeptList::Issues => &mut self.issues,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherKeptRecord {
    pub decisions: Vec<WatcherKeptItem>,
    pub rules: Vec<WatcherKeptItem>,
    pub issues: Vec<WatcherKeptItem>,
    pub updated_at: Option<String>,
    pub next_id: u64,
}

impl WatcherKeptRecord {
    pub fn empty() -> Self {
        Self {
            decisions: Vec::new(),
            rules: Vec::new(),
            issues: Vec::new(),
            updated_at: None,
            next_id: 1,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WatcherKeptLegacy {
    decisions: Vec<String>,
    rules: Vec<String>,
    issues: Vec<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherKeepAddItem {
    pub list: WatcherKeptList,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherKeepEditItem {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherKeepCloseItem {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherKeepStateInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decisions: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issues: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub add: Option<Vec<WatcherKeepAddItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edit: Option<Vec<WatcherKeepEditItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub close: Option<Vec<WatcherKeepCloseItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drop: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherKeptChange {
    pub list: WatcherKeptList,
    pub id: String,
    pub change: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherKeptListCount {
    pub open: usize,
    pub closed: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherKeptCounts {
    pub decisions: WatcherKeptListCount,
    pub rules: WatcherKeptListCount,
    pub issues: WatcherKeptListCount,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatcherKeepRefusal {
    pub code: &'static str,
    pub message: String,
}

fn parse_ms(iso: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn is_valid_kept_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !matches!(first, 'd' | 'r' | 'i') {
        return false;
    }
    let rest: String = chars.collect();
    !rest.is_empty()
        && rest.len() <= 9
        && !rest.starts_with('0')
        && rest.chars().all(|c| c.is_ascii_digit())
}

fn trim_kept_text(text: &str) -> Result<String, WatcherKeepRefusal> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.chars().count() > WATCHER_KEPT_ITEM_MAX {
        return Err(WatcherKeepRefusal {
            code: "INVALID_INPUT",
            message: format!(
                "Kept lines must be between 1 and {WATCHER_KEPT_ITEM_MAX} characters. Nothing was kept."
            ),
        });
    }
    Ok(trimmed.to_string())
}

pub fn read_kept_record(input: Value, now: &str) -> Result<WatcherKeptRecord, String> {
    if let Ok(legacy) = serde_json::from_value::<WatcherKeptLegacy>(input.clone()) {
        let mut next_id = 1u64;
        let touched_at = legacy
            .updated_at
            .clone()
            .unwrap_or_else(|| now.to_string());
        let mut build = |list: WatcherKeptList, items: Vec<String>| -> Vec<WatcherKeptItem> {
            items
                .into_iter()
                .filter_map(|text| {
                    let trimmed = text.trim().to_string();
                    if trimmed.is_empty() {
                        return None;
                    }
                    let id = format!("{}{}", list.letter(), next_id);
                    next_id += 1;
                    Some(WatcherKeptItem {
                        id,
                        text: trimmed,
                        touched_at: touched_at.clone(),
                        closed_at: None,
                        closed_note: None,
                    })
                })
                .collect()
        };
        return Ok(WatcherKeptRecord {
            decisions: build(WatcherKeptList::Decisions, legacy.decisions),
            rules: build(WatcherKeptList::Rules, legacy.rules),
            issues: build(WatcherKeptList::Issues, legacy.issues),
            updated_at: legacy.updated_at,
            next_id,
        });
    }
    serde_json::from_value::<WatcherKeptRecord>(input)
        .map_err(|e| format!("Invalid watcher-state.json: {e}"))
}

pub fn kept_as_shown(record: &WatcherKeptRecord, now_ms: i64) -> WatcherKeptState {
    let stays = |item: &WatcherKeptItem| -> bool {
        match item.closed_at.as_deref() {
            None => true,
            Some(closed) => parse_ms(closed)
                .map(|at| at + WATCHER_KEPT_CLOSED_MS > now_ms)
                .unwrap_or(false),
        }
    };
    WatcherKeptState {
        decisions: record
            .decisions
            .iter()
            .filter(|i| stays(i))
            .cloned()
            .collect(),
        rules: record.rules.iter().filter(|i| stays(i)).cloned().collect(),
        issues: record.issues.iter().filter(|i| stays(i)).cloned().collect(),
        updated_at: record.updated_at.clone(),
    }
}

pub fn open_kept(state: &WatcherKeptState) -> WatcherKeptState {
    let open = |items: &[WatcherKeptItem]| -> Vec<WatcherKeptItem> {
        items
            .iter()
            .filter(|i| i.closed_at.is_none())
            .cloned()
            .collect()
    };
    WatcherKeptState {
        decisions: open(&state.decisions),
        rules: open(&state.rules),
        issues: open(&state.issues),
        updated_at: state.updated_at.clone(),
    }
}

pub fn kept_changes(before: &WatcherKeptState, after: &WatcherKeptState) -> Vec<WatcherKeptChange> {
    let mut changes = Vec::new();
    for list in WatcherKeptList::ALL {
        let earlier: HashMap<&str, &WatcherKeptItem> = before
            .list(list)
            .iter()
            .map(|l| (l.id.as_str(), l))
            .collect();
        let now_ids: HashSet<&str> = after.list(list).iter().map(|l| l.id.as_str()).collect();
        for line in after.list(list) {
            match earlier.get(line.id.as_str()) {
                None => changes.push(WatcherKeptChange {
                    list,
                    id: line.id.clone(),
                    change: "added".into(),
                    text: Some(line.text.clone()),
                }),
                Some(was) if was.text != line.text => changes.push(WatcherKeptChange {
                    list,
                    id: line.id.clone(),
                    change: "edited".into(),
                    text: None,
                }),
                Some(was) if was.closed_at.is_none() && line.closed_at.is_some() => {
                    changes.push(WatcherKeptChange {
                        list,
                        id: line.id.clone(),
                        change: "closed".into(),
                        text: None,
                    });
                }
                Some(was) if was.touched_at != line.touched_at => {
                    changes.push(WatcherKeptChange {
                        list,
                        id: line.id.clone(),
                        change: "touched".into(),
                        text: None,
                    });
                }
                _ => {}
            }
        }
        for line in before.list(list) {
            if !now_ids.contains(line.id.as_str()) {
                changes.push(WatcherKeptChange {
                    list,
                    id: line.id.clone(),
                    change: "removed".into(),
                    text: None,
                });
            }
        }
    }
    changes
}

pub fn kept_counts(state: &WatcherKeptState) -> WatcherKeptCounts {
    let count = |list: WatcherKeptList| {
        let items = state.list(list);
        let open = items.iter().filter(|i| i.closed_at.is_none()).count();
        WatcherKeptListCount {
            open,
            closed: items.len() - open,
        }
    };
    WatcherKeptCounts {
        decisions: count(WatcherKeptList::Decisions),
        rules: count(WatcherKeptList::Rules),
        issues: count(WatcherKeptList::Issues),
    }
}

/// Pure `keep_state` transition matching `src/main/agents/watcherState.ts:applyKeep`.
pub fn apply_keep(
    record: &WatcherKeptRecord,
    input: &WatcherKeepStateInput,
    now: &str,
) -> Result<WatcherKeptRecord, WatcherKeepRefusal> {
    let refused = |code: &'static str, msg: String| WatcherKeepRefusal {
        code,
        message: format!("{msg} Nothing was kept."),
    };
    let now_ms = parse_ms(now).unwrap_or_else(|| Utc::now().timestamp_millis());
    let mut next = kept_as_shown(record, now_ms);
    let mut next_id = record.next_id;

    let mut named: Vec<&str> = Vec::new();
    for item in input.edit.as_deref().unwrap_or(&[]) {
        named.push(&item.id);
    }
    for item in input.close.as_deref().unwrap_or(&[]) {
        named.push(&item.id);
    }
    for id in input.drop.as_deref().unwrap_or(&[]) {
        named.push(id);
    }
    let mut seen_named: HashSet<&str> = HashSet::new();
    for id in &named {
        if !is_valid_kept_id(id) {
            return Err(refused("INVALID_INPUT", format!("Invalid line ID {id}.")));
        }
        if !seen_named.insert(id) {
            return Err(refused(
                "INVALID_INPUT",
                format!("Line {id} is named twice. Change each line once in a call."),
            ));
        }
    }

    let mut changed: HashSet<WatcherKeptList> = HashSet::new();
    for item in input.add.as_deref().unwrap_or(&[]) {
        changed.insert(item.list);
    }
    for id in &named {
        if let Some(list) = id.chars().next().and_then(WatcherKeptList::from_letter) {
            changed.insert(list);
        }
    }

    for (list, maybe_words) in [
        (WatcherKeptList::Decisions, input.decisions.as_deref()),
        (WatcherKeptList::Rules, input.rules.as_deref()),
        (WatcherKeptList::Issues, input.issues.as_deref()),
    ] {
        let Some(words) = maybe_words else {
            continue;
        };
        if changed.contains(&list) {
            return Err(refused(
                "INVALID_INPUT",
                format!(
                    "{} was given whole and changed by line in the same call. Do one or the other.",
                    list.display_name()
                ),
            ));
        }
        let open: Vec<WatcherKeptItem> = next
            .list(list)
            .iter()
            .filter(|l| l.closed_at.is_none())
            .cloned()
            .collect();
        let closed: Vec<WatcherKeptItem> = next
            .list(list)
            .iter()
            .filter(|l| l.closed_at.is_some())
            .cloned()
            .collect();
        let mut dedup: Vec<String> = Vec::new();
        let mut seen_words: HashSet<String> = HashSet::new();
        for w in words {
            let trimmed = trim_kept_text(w)?;
            if seen_words.insert(trimmed.clone()) {
                dedup.push(trimmed);
            }
        }
        let mut rebuilt: Vec<WatcherKeptItem> = dedup
            .into_iter()
            .map(|text| {
                if let Some(existing) = open.iter().find(|l| l.text == text) {
                    existing.clone()
                } else {
                    let id = format!("{}{}", list.letter(), next_id);
                    next_id += 1;
                    WatcherKeptItem {
                        id,
                        text,
                        touched_at: now.to_string(),
                        closed_at: None,
                        closed_note: None,
                    }
                }
            })
            .collect();
        rebuilt.extend(closed);
        *next.list_mut(list) = rebuilt;
        changed.insert(list);
    }

    for item in input.edit.as_deref().unwrap_or(&[]) {
        let text = trim_kept_text(&item.text)?;
        let list = item
            .id
            .chars()
            .next()
            .and_then(WatcherKeptList::from_letter)
            .ok_or_else(|| refused("INVALID_INPUT", format!("No line {} is kept.", item.id)))?;
        let Some(entry) = next.list_mut(list).iter_mut().find(|l| l.id == item.id) else {
            return Err(refused(
                "INVALID_INPUT",
                format!(
                    "No line {} is kept. read_state gives each line’s ID.",
                    item.id
                ),
            ));
        };
        if entry.closed_at.is_some() {
            return Err(refused(
                "INVALID_INPUT",
                format!(
                    "Line {} is closed. Add it again if it is open once more.",
                    item.id
                ),
            ));
        }
        entry.text = text;
        entry.touched_at = now.to_string();
    }

    for item in input.close.as_deref().unwrap_or(&[]) {
        let note = match item.note.as_deref() {
            Some(n) => Some(trim_kept_text(n)?),
            None => None,
        };
        let list = item
            .id
            .chars()
            .next()
            .and_then(WatcherKeptList::from_letter)
            .ok_or_else(|| refused("INVALID_INPUT", format!("No line {} is kept.", item.id)))?;
        let Some(entry) = next.list_mut(list).iter_mut().find(|l| l.id == item.id) else {
            return Err(refused(
                "INVALID_INPUT",
                format!(
                    "No line {} is kept. read_state gives each line’s ID.",
                    item.id
                ),
            ));
        };
        if entry.closed_at.is_none() {
            entry.closed_at = Some(now.to_string());
            entry.closed_note = note;
        }
    }

    for id in input.drop.as_deref().unwrap_or(&[]) {
        if let Some(list) = id.chars().next().and_then(WatcherKeptList::from_letter) {
            next.list_mut(list).retain(|l| l.id != *id);
        }
    }

    for item in input.add.as_deref().unwrap_or(&[]) {
        let text = trim_kept_text(&item.text)?;
        let entries = next.list_mut(item.list);
        if let Some(existing) = entries
            .iter_mut()
            .find(|l| l.closed_at.is_none() && l.text == text)
        {
            existing.touched_at = now.to_string();
        } else {
            let id = format!("{}{}", item.list.letter(), next_id);
            next_id += 1;
            entries.push(WatcherKeptItem {
                id,
                text,
                touched_at: now.to_string(),
                closed_at: None,
                closed_note: None,
            });
        }
    }

    for list in WatcherKeptList::ALL {
        let items = next.list_mut(list);
        let open_count = items.iter().filter(|l| l.closed_at.is_none()).count();
        let most = list.open_max();
        if changed.contains(&list) && open_count > most {
            return Err(refused(
                "STATE_FULL",
                if list == WatcherKeptList::Rules {
                    format!(
                        "Rules would hold {open_count} open lines, and it holds at most {most}. These are the user's rules: do not drop, merge or close one to make room. Tell the user this rule was not kept, and ask which of their rules no longer applies."
                    )
                } else {
                    format!(
                        "{} would hold {open_count} open lines, and it holds at most {most}. Close the lines that are done or drop ones no longer needed, then add again.",
                        list.display_name()
                    )
                },
            ));
        }
        let mut closed_indices: Vec<(usize, i64)> = items
            .iter()
            .enumerate()
            .filter_map(|(idx, l)| {
                l.closed_at
                    .as_deref()
                    .map(|c| (idx, parse_ms(c).unwrap_or(0)))
            })
            .collect();
        if closed_indices.len() > WATCHER_KEPT_CLOSED_MAX {
            closed_indices.sort_by_key(|(_, ts)| *ts);
            let drop_count = closed_indices.len() - WATCHER_KEPT_CLOSED_MAX;
            let drop_set: HashSet<usize> = closed_indices
                .into_iter()
                .take(drop_count)
                .map(|(i, _)| i)
                .collect();
            let mut idx = 0usize;
            items.retain(|_| {
                let keep = !drop_set.contains(&idx);
                idx += 1;
                keep
            });
        }
    }

    Ok(WatcherKeptRecord {
        decisions: next.decisions,
        rules: next.rules,
        issues: next.issues,
        updated_at: Some(now.to_string()),
        next_id,
    })
}

#[derive(Debug)]
pub struct WatcherStateStore {
    directory: PathBuf,
    history_enabled: bool,
    kept: WatcherKeptRecord,
    unread: bool,
}

impl WatcherStateStore {
    pub fn new(directory: impl Into<PathBuf>, history_enabled: bool) -> Self {
        Self {
            directory: directory.into(),
            history_enabled,
            kept: WatcherKeptRecord::empty(),
            unread: false,
        }
    }

    pub fn path(&self) -> PathBuf {
        self.directory.join(WATCHER_STATE_FILE)
    }

    pub fn load(&mut self) {
        if !self.history_enabled {
            let _ = remove_file_and_backups(&self.directory, WATCHER_STATE_FILE);
            self.kept = WatcherKeptRecord::empty();
            self.unread = false;
            return;
        }
        let path = self.path();
        if !path.exists() {
            self.kept = WatcherKeptRecord::empty();
            self.unread = false;
            return;
        }
        match fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| e.to_string()))
            .and_then(|v| read_kept_record(v, &now_iso()))
        {
            Ok(rec) => {
                self.kept = rec;
                self.unread = false;
            }
            Err(_) => {
                self.unread = true;
            }
        }
    }

    pub fn readable(&self) -> bool {
        !self.unread
    }

    pub fn read(&self) -> WatcherKeptState {
        kept_as_shown(&self.kept, Utc::now().timestamp_millis())
    }

    pub fn keep(
        &mut self,
        input: &WatcherKeepStateInput,
        now: &str,
    ) -> Result<(WatcherKeptState, Vec<WatcherKeptChange>), WatcherKeepRefusal> {
        if self.unread && self.history_enabled {
            self.load();
            if self.unread {
                return Err(WatcherKeepRefusal {
                    code: "INVALID_INPUT",
                    message: "Saved watcher state could not be read. Nothing was kept.".into(),
                });
            }
        }
        let next = apply_keep(&self.kept, input, now)?;
        let at = parse_ms(now).unwrap_or_else(|| Utc::now().timestamp_millis());
        let before = kept_as_shown(&self.kept, at);
        if self.history_enabled {
            write_atomic_json(&self.path(), &next).map_err(|e| WatcherKeepRefusal {
                code: "INVALID_INPUT",
                message: format!("Could not save watcher state ({e}). Nothing was kept."),
            })?;
        } else {
            let _ = remove_file_and_backups(&self.directory, WATCHER_STATE_FILE);
        }
        let after = kept_as_shown(&next, at);
        let changes = kept_changes(&before, &after);
        self.kept = next;
        Ok((after, changes))
    }

    pub fn set_history_enabled(&mut self, enabled: bool) -> Result<(), String> {
        self.history_enabled = enabled;
        if enabled {
            if self.unread {
                self.load();
            }
            if !self.unread {
                write_atomic_json(&self.path(), &self.kept)
                    .map_err(|e| format!("Could not save watcher-state.json: {e}"))?;
            }
            Ok(())
        } else {
            remove_file_and_backups(&self.directory, WATCHER_STATE_FILE)
        }
    }
}

// ---------------------------------------------------------------------------
// WatcherQuestionsStore (`watcher-questions.json`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherQuestionOption {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherQuestion {
    pub id: String,
    pub watcher_thread_id: String,
    pub question: String,
    pub options: Vec<WatcherQuestionOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settle: Option<WatcherThreadTarget>,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choice: Option<String>,
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spent: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asked_under: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherAskInput {
    pub question: String,
    #[serde(default)]
    pub options: Option<Vec<WatcherQuestionOption>>,
    #[serde(default)]
    pub settle: Option<WatcherThreadTarget>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WatcherQuestionsFile {
    version: u32,
    questions: Vec<WatcherQuestion>,
}

#[derive(Debug)]
pub struct WatcherQuestionsStore {
    directory: PathBuf,
    history_enabled: bool,
    questions: Vec<WatcherQuestion>,
}

impl WatcherQuestionsStore {
    pub fn new(directory: impl Into<PathBuf>, history_enabled: bool) -> Self {
        Self {
            directory: directory.into(),
            history_enabled,
            questions: Vec::new(),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.directory.join(WATCHER_QUESTIONS_FILE)
    }

    pub fn load(&mut self) {
        if !self.history_enabled {
            self.questions.clear();
            return;
        }
        let path = self.path();
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(file) = serde_json::from_str::<WatcherQuestionsFile>(&text) {
                if file.version == 1 {
                    self.questions = file.questions;
                    return;
                }
            }
            set_aside_unreadable(&path);
        }
        self.questions.clear();
    }

    fn save(&self) {
        if !self.history_enabled {
            return;
        }
        let file = WatcherQuestionsFile {
            version: 1,
            questions: self.questions.clone(),
        };
        let _ = write_atomic_json(&self.path(), &file);
    }

    pub fn all(&self) -> &[WatcherQuestion] {
        &self.questions
    }

    pub fn for_watcher(&self, watcher_thread_id: &str) -> Vec<WatcherQuestion> {
        self.questions
            .iter()
            .filter(|q| q.watcher_thread_id == watcher_thread_id && q.state != "closed")
            .cloned()
            .collect()
    }

    pub fn open_for(&self, watcher_thread_id: &str) -> Vec<WatcherQuestion> {
        self.questions
            .iter()
            .filter(|q| q.watcher_thread_id == watcher_thread_id && q.state == "open")
            .cloned()
            .collect()
    }

    pub fn ask(
        &mut self,
        watcher_thread_id: &str,
        input: WatcherAskInput,
        asked_under: Option<String>,
    ) -> Result<WatcherQuestion, String> {
        let question_text = input.question.trim().to_string();
        if question_text.is_empty() || question_text.chars().count() > 1_000 {
            return Err("Give a question of 1 to 1000 characters.".into());
        }
        let options = if input.settle.is_some() {
            vec![
                WatcherQuestionOption {
                    label: SETTLE_IT.into(),
                    description: Some(
                        "Stop watching it. The thread stays in All threads.".into(),
                    ),
                },
                WatcherQuestionOption {
                    label: KEEP_WATCHING.into(),
                    description: Some(
                        "Keep it in view in case more work comes in.".into(),
                    ),
                },
            ]
        } else {
            let Some(opts) = input.options else {
                return Err("Give two to four options, or name the thread to settle.".into());
            };
            if opts.len() < 2 || opts.len() > 4 {
                return Err("Give two to four options, or name the thread to settle.".into());
            }
            let mut seen = HashSet::new();
            let mut clean = Vec::with_capacity(opts.len());
            for opt in opts {
                let label = opt.label.trim().to_string();
                if label.is_empty() || label.chars().count() > 80 {
                    return Err("Each option label must be 1 to 80 characters.".into());
                }
                if !seen.insert(label.to_lowercase()) {
                    return Err("Each option needs its own label.".into());
                }
                clean.push(WatcherQuestionOption {
                    label,
                    description: opt
                        .description
                        .map(|d| d.trim().to_string())
                        .filter(|d| !d.is_empty()),
                });
            }
            clean
        };
        let at = now_iso();
        if let Some(ref settle_target) = input.settle {
            for existing in &mut self.questions {
                if existing.state == "open"
                    && existing.watcher_thread_id == watcher_thread_id
                    && existing.settle.as_ref() == Some(settle_target)
                {
                    existing.state = "closed".into();
                    existing.ended_at = Some(at.clone());
                }
            }
        }
        let q = WatcherQuestion {
            id: Uuid::new_v4().to_string(),
            watcher_thread_id: watcher_thread_id.to_string(),
            question: question_text,
            options,
            settle: input.settle,
            state: "open".into(),
            choice: None,
            at,
            ended_at: None,
            spent: None,
            asked_under,
        };
        self.questions.push(q.clone());
        if self.questions.len() > WATCHER_QUESTIONS_KEPT {
            let drain = self.questions.len() - WATCHER_QUESTIONS_KEPT;
            self.questions.drain(0..drain);
        }
        self.save();
        Ok(q)
    }

    pub fn answer(&mut self, id: &str, choice: &str) -> Option<WatcherQuestion> {
        let mut updated = None;
        for q in &mut self.questions {
            if q.id == id && q.state == "open" && q.options.iter().any(|o| o.label == choice) {
                q.state = "answered".into();
                q.choice = Some(choice.to_string());
                q.ended_at = Some(now_iso());
                updated = Some(q.clone());
                break;
            }
        }
        if updated.is_some() {
            self.save();
        }
        updated
    }

    pub fn skip(&mut self, id: &str) -> Option<WatcherQuestion> {
        let mut updated = None;
        for q in &mut self.questions {
            if q.id == id && q.state == "open" {
                q.state = "skipped".into();
                q.ended_at = Some(now_iso());
                updated = Some(q.clone());
                break;
            }
        }
        if updated.is_some() {
            self.save();
        }
        updated
    }

    pub fn close_for_watcher(&mut self, watcher_thread_id: &str) -> Vec<WatcherQuestion> {
        let at = now_iso();
        let mut closed = Vec::new();
        for q in &mut self.questions {
            if q.watcher_thread_id == watcher_thread_id && q.state == "open" {
                q.state = "closed".into();
                q.ended_at = Some(at.clone());
                closed.push(q.clone());
            }
        }
        if !closed.is_empty() {
            self.save();
        }
        closed
    }

    pub fn agreed_settle(&self, watcher_thread_id: &str, target: &WatcherThreadTarget) -> bool {
        self.questions.iter().any(|q| {
            q.watcher_thread_id == watcher_thread_id
                && q.state == "answered"
                && q.choice.as_deref() == Some(SETTLE_IT)
                && q.spent != Some(true)
                && q.settle.as_ref() == Some(target)
        })
    }

    pub fn spend_settle(&mut self, watcher_thread_id: &str, target: &WatcherThreadTarget) {
        let mut changed = false;
        for q in &mut self.questions {
            if q.watcher_thread_id == watcher_thread_id
                && q.state == "answered"
                && q.choice.as_deref() == Some(SETTLE_IT)
                && q.spent != Some(true)
                && q.settle.as_ref() == Some(target)
            {
                q.spent = Some(true);
                changed = true;
            }
        }
        if changed {
            self.save();
        }
    }

    pub fn set_history_enabled(&mut self, enabled: bool) -> Result<(), String> {
        self.history_enabled = enabled;
        if enabled {
            self.save();
            Ok(())
        } else {
            remove_file_and_backups(&self.directory, WATCHER_QUESTIONS_FILE)
        }
    }
}

// ---------------------------------------------------------------------------
// WatcherToldNewsStore (`watcher-told.json`) & `tellWatcher` / `readyToMerge`
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToldUserMessage {
    pub id: String,
    pub words: String,
    pub named: bool,
    pub cut: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadyToMerge {
    pub pull_request: String,
    pub head: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherToldPayload {
    pub words: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_words: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_words_cut: Option<bool>,
    pub opened: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherAnsweredPayload {
    pub question_id: String,
    pub question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settle: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opened: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherEvent {
    pub id: String,
    pub kind: String,
    pub request_id: String,
    pub target: WatcherThreadTarget,
    pub generation: u64,
    pub observed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_card_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_card_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_work_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delegated_thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answered_by_user: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_without_answer: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swarm: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restarted_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restart_cause: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub move_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moved_to: Option<WatcherThreadTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub move_outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub told: Option<WatcherToldPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready: Option<ReadyToMerge>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answered: Option<WatcherAnsweredPayload>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WatcherToldFile {
    version: u32,
    events: Vec<WatcherEvent>,
}

#[derive(Debug)]
pub struct WatcherToldNewsStore {
    directory: PathBuf,
    history_enabled: bool,
    events: Vec<WatcherEvent>,
}

impl WatcherToldNewsStore {
    pub fn new(directory: impl Into<PathBuf>, history_enabled: bool) -> Self {
        Self {
            directory: directory.into(),
            history_enabled,
            events: Vec::new(),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.directory.join(WATCHER_TOLD_FILE)
    }

    pub fn load(&mut self) -> &[WatcherEvent] {
        if !self.history_enabled {
            self.events.clear();
            return &self.events;
        }
        if let Ok(text) = fs::read_to_string(self.path()) {
            if let Ok(file) = serde_json::from_str::<WatcherToldFile>(&text) {
                if file.version == 1 {
                    self.events = file.events;
                    return &self.events;
                }
            }
            set_aside_unreadable(&self.path());
        }
        self.events.clear();
        &self.events
    }

    fn save(&self) -> Result<(), String> {
        if !self.history_enabled {
            return Ok(());
        }
        let file = WatcherToldFile {
            version: 1,
            events: self.events.clone(),
        };
        write_atomic_json(&self.path(), &file)
            .map_err(|e| format!("Could not save watcher-told.json: {e}"))
    }

    pub fn events(&self) -> &[WatcherEvent] {
        &self.events
    }

    pub fn add(&mut self, event: WatcherEvent) -> Result<(), String> {
        self.events.push(event);
        if self.events.len() > WATCHER_TOLD_KEPT_MAX {
            let drain = self.events.len() - WATCHER_TOLD_KEPT_MAX;
            self.events.drain(0..drain);
        }
        self.save()
    }

    pub fn forget(&mut self, ids: &HashSet<String>) -> Result<(), String> {
        let before = self.events.len();
        self.events.retain(|e| !ids.contains(&e.id));
        if self.events.len() != before {
            self.save()?;
        }
        Ok(())
    }

    pub fn set_history_enabled(&mut self, enabled: bool) -> Result<(), String> {
        self.history_enabled = enabled;
        if enabled {
            self.save()
        } else {
            remove_file_and_backups(&self.directory, WATCHER_TOLD_FILE)
        }
    }
}

/// Deterministic UUIDv8-shaped ID for a told request (`src/main/agents/watcher.ts:toldRequestId`).
pub fn told_request_id(root: &str) -> String {
    let hex = sha256_hex(root.as_bytes());
    format!(
        "{}-{}-8{}-8{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..32]
    )
}

pub fn told_request_root(host_id: &str, thread_id: &str, message_id: &str) -> String {
    format!("told:{host_id}:{thread_id}:{message_id}")
}

pub fn answered_request_root(question_id: &str, asked_under: &str) -> String {
    format!("answered:{question_id}:{asked_under}")
}

pub fn cut_to_bytes(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

pub fn plain_words(text: &str) -> String {
    text.chars()
        .filter(|&c| {
            let code = c as u32;
            code == 9 || code == 10 || code == 13 || (code >= 32 && code != 127)
        })
        .collect()
}

pub fn names_watcher(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let needle = b"watcher";
    let mut start = 0;
    while let Some(pos) = lower[start..].find("watcher") {
        let abs = start + pos;
        let left_ok = abs == 0 || !bytes[abs - 1].is_ascii_alphanumeric() && bytes[abs - 1] != b'_';
        let after = abs + needle.len();
        let right_ok =
            after == bytes.len() || !bytes[after].is_ascii_alphanumeric() && bytes[after] != b'_';
        if left_ok && right_ok {
            return true;
        }
        start = abs + 1;
    }
    false
}

pub fn build_told_user_message(id: &str, text: &str) -> Option<ToldUserMessage> {
    let cleaned = plain_words(text);
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    let cut = cut_to_bytes(trimmed, TELL_WATCHER_WORDS_BYTES_MAX);
    let was_cut = cut != trimmed;
    Some(ToldUserMessage {
        id: id.to_string(),
        words: cut,
        named: names_watcher(trimmed),
        cut: was_cut,
    })
}

pub fn is_valid_commit_sha(head: &str) -> bool {
    head.len() == 40 && head.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn is_valid_github_pr_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://github.com/") else {
        return false;
    };
    let parts: Vec<&str> = rest.split('/').collect();
    parts.len() == 4
        && !parts[0].is_empty()
        && !parts[1].is_empty()
        && parts[2] == "pull"
        && !parts[3].is_empty()
        && parts[3].bytes().all(|b| b.is_ascii_digit())
}

pub fn pull_request_key(url: &str) -> String {
    url.trim().trim_end_matches('/').to_ascii_lowercase()
}

// ---------------------------------------------------------------------------
// LimitRestartStore (`limit-restarts.json`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LimitRestartRecord {
    pub thread_id: String,
    pub provider: String,
    pub stopped_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    pub restarts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledRestart {
    pub provider: String,
    pub stopped_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LimitRestartFile {
    version: u32,
    threads: Vec<LimitRestartRecord>,
}

#[derive(Debug)]
pub struct LimitRestartStore {
    directory: PathBuf,
    /// One record per thread in the order Node keeps them, which decides which records the bound keeps.
    records: Vec<LimitRestartRecord>,
}

impl LimitRestartStore {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
            records: Vec::new(),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.directory.join(LIMIT_RESTARTS_FILE)
    }

    pub fn load(&mut self) {
        self.records.clear();
        if let Ok(text) = fs::read_to_string(self.path()) {
            match serde_json::from_str::<LimitRestartFile>(&text) {
                Ok(file) if file.version == 1 => {
                    for rec in file.threads.into_iter().take(LIMIT_RESTARTS_RECORDS_MAX) {
                        self.insert(rec);
                    }
                }
                _ => set_aside_unreadable(&self.path()),
            }
        }
    }

    fn get(&self, thread_id: &str) -> Option<&LimitRestartRecord> {
        self.records.iter().find(|rec| rec.thread_id == thread_id)
    }

    /// Replaces a thread's record where it stands, or adds it last, as Node's `Map.set` does.
    fn insert(&mut self, record: LimitRestartRecord) {
        match self.records.iter_mut().find(|rec| rec.thread_id == record.thread_id) {
            Some(rec) => *rec = record,
            None => self.records.push(record),
        }
    }

    fn remove(&mut self, thread_id: &str) -> bool {
        let before = self.records.len();
        self.records.retain(|rec| rec.thread_id != thread_id);
        self.records.len() != before
    }

    fn save(&self) -> Result<(), String> {
        // The newest records fill the bound, as Node's do.
        let start = self.records.len().saturating_sub(LIMIT_RESTARTS_RECORDS_MAX);
        let threads: Vec<LimitRestartRecord> = self.records[start..].to_vec();
        let file = LimitRestartFile {
            version: 1,
            threads,
        };
        write_atomic_json(&self.path(), &file)
            .map_err(|e| format!("Could not save limit-restarts.json: {e}"))
    }

    pub fn list(&self) -> Vec<LimitRestartRecord> {
        self.records.clone()
    }

    pub fn scheduled(&self, thread_id: &str) -> Option<ScheduledRestart> {
        let rec = self.get(thread_id)?;
        if rec.sent == Some(true) {
            return None;
        }
        let shown_at = rec.at.as_deref().and_then(|at| {
            let ms = parse_ms(at)?;
            DateTime::<Utc>::from_timestamp_millis(ms - LIMIT_RESTART_GRACE_MS)
                .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        });
        Some(ScheduledRestart {
            provider: rec.provider.clone(),
            stopped_at: rec.stopped_at.clone(),
            at: shown_at,
        })
    }

    pub fn record_stop(
        &mut self,
        thread_id: &str,
        provider: &str,
        resets_at: Option<&str>,
        turn_id: Option<&str>,
        now_ms: i64,
    ) -> Result<bool, String> {
        let existing_restarts = self
            .get(thread_id)
            .map(|r| r.restarts)
            .unwrap_or(0);
        if existing_restarts >= LIMIT_RESTARTS_IN_A_ROW_MAX {
            return Ok(false);
        }
        let at = resets_at.and_then(|raw| {
            let ms = parse_ms(raw)?;
            if ms - now_ms > LIMIT_RESTART_HORIZON_MS {
                return None;
            }
            DateTime::<Utc>::from_timestamp_millis(ms + LIMIT_RESTART_GRACE_MS)
                .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        });
        let stopped_at = DateTime::<Utc>::from_timestamp_millis(now_ms)
            .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .unwrap_or_else(now_iso);
        self.insert(LimitRestartRecord {
            thread_id: thread_id.to_string(),
            provider: provider.to_string(),
            stopped_at,
            at,
            restarts: existing_restarts,
            sent: None,
            cause: None,
            turn_id: turn_id.map(ToString::to_string),
        });
        self.save()?;
        Ok(true)
    }

    pub fn cancel(&mut self, thread_id: &str) -> Result<bool, String> {
        let Some(rec) = self.get(thread_id) else {
            return Ok(false);
        };
        if rec.sent == Some(true) {
            return Ok(false);
        }
        self.remove(thread_id);
        self.save()?;
        Ok(true)
    }

    pub fn clear(&mut self, thread_id: &str) -> Result<bool, String> {
        if self.remove(thread_id) {
            self.save()?;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn mark_sent(&mut self, thread_id: &str) -> Result<bool, String> {
        let Some(rec) = self.records.iter_mut().find(|rec| rec.thread_id == thread_id) else {
            return Ok(false);
        };
        if rec.restarts >= LIMIT_RESTARTS_IN_A_ROW_MAX {
            return Ok(false);
        }
        rec.restarts += 1;
        rec.sent = Some(true);
        self.save()?;
        Ok(true)
    }

    pub fn due_restarts(&self, now_ms: i64) -> Vec<LimitRestartRecord> {
        self.records
            .iter()
            .filter(|rec| {
                rec.sent != Some(true)
                    && rec.restarts < LIMIT_RESTARTS_IN_A_ROW_MAX
                    && rec
                        .at
                        .as_deref()
                        .and_then(parse_ms)
                        .is_some_and(|at_ms| at_ms <= now_ms)
            })
            .cloned()
            .collect()
    }
}

// ---------------------------------------------------------------------------
// FollowupStore (`followups.json`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedFollowup {
    pub id: String,
    pub thread_id: String,
    pub draft_id: String,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<Value>>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wake_up: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_after_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub watcher_operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub news: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone_origin: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    /// Fields this build does not know, written back as they were (ADR-0214).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowupReceipt {
    pub thread_id: String,
    pub draft_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FollowupFile {
    #[serde(default)]
    items: Vec<QueuedFollowup>,
    #[serde(default)]
    receipts: Vec<FollowupReceipt>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// Computes the exact SHA-256 digest matching `src/main/agents/followups.ts:followupDigest`.
pub fn followup_digest(
    text: &str,
    attachments: &[Value],
    skills: Option<&[Value]>,
    files: Option<&[Value]>,
) -> String {
    let mut parts: Vec<Value> = vec![
        Value::String(text.trim().to_string()),
        Value::Array(attachments.to_vec()),
    ];
    if let Some(s) = skills.filter(|s| !s.is_empty()) {
        parts.push(Value::Array(s.to_vec()));
    }
    if let Some(f) = files.filter(|f| !f.is_empty()) {
        parts.push(Value::Array(f.to_vec()));
    }
    let json = serde_json::to_string(&Value::Array(parts)).unwrap_or_default();
    sha256_hex(json.as_bytes())
}

fn strip_retired_news(mut items: Vec<QueuedFollowup>) -> Vec<QueuedFollowup> {
    items.retain_mut(|item| {
        let Some(news) = item.news.as_mut() else {
            return true;
        };
        let held = news.len();
        news.retain_mut(|part| {
            let Some(obj) = part.as_object_mut() else {
                return true;
            };
            if obj.get("source").and_then(Value::as_str) == Some("to-do") {
                return false;
            }
            if obj.get("source").and_then(Value::as_str) != Some("watcher") {
                return true;
            }
            let Some(events) = obj.get_mut("events").and_then(Value::as_array_mut) else {
                return true;
            };
            let before = events.len();
            events.retain(|ev| {
                ev.get("kind")
                    .and_then(Value::as_str)
                    .is_none_or(|k| !RETIRED_WATCHER_KINDS.contains(&k))
            });
            // As Node's `withoutRetiredNews`: a part goes only when what was retired was all it held.
            if events.len() == before {
                return true;
            }
            let has_events = !events.is_empty();
            let omitted = obj.get("omitted").and_then(Value::as_u64).unwrap_or(0);
            has_events || omitted > 0
        });
        // An item goes only when its news was all retired, as Node's `withoutRetiredNews`.
        news.len() == held || !news.is_empty()
    });
    items
}

pub(crate) fn is_waiting_wake_up(item: &QueuedFollowup) -> bool {
    item.wake_up == Some(true) && matches!(item.status.as_str(), "queued" | "paused" | "failed")
}

/// News of either restart, as Node's `isAnyRestartNews`: Sotto closing stopped the turn (`restart`), or a usage limit did.
pub(crate) fn is_any_restart_news(part: &Value) -> bool {
    matches!(part.get("source").and_then(Value::as_str), Some("restart" | "limit-restart"))
}

#[derive(Debug)]
pub struct FollowupStore {
    directory: PathBuf,
    history_enabled: bool,
    pub(crate) items: Vec<QueuedFollowup>,
    pub(crate) receipts: Vec<FollowupReceipt>,
    /// Top-level fields this build does not know, written back as they were.
    extra: Map<String, Value>,
}

impl FollowupStore {
    pub fn new(directory: impl Into<PathBuf>, history_enabled: bool) -> Self {
        Self {
            directory: directory.into(),
            history_enabled,
            items: Vec::new(),
            receipts: Vec::new(),
            extra: Map::new(),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.directory.join(FOLLOWUPS_FILE)
    }

    pub fn load(&mut self, watcher_thread_ids: &HashSet<String>) -> Result<(), String> {
        let path = self.path();
        if !path.exists() {
            self.items.clear();
            self.receipts.clear();
            return Ok(());
        }
        let text = fs::read_to_string(&path)
            .map_err(|e| format!("Could not read followups.json: {e}"))?;
        // A queue this build cannot read is set aside, as Node does, so the next save does not write over it.
        let parsed: FollowupFile = serde_json::from_str(&text).map_err(|e| {
            set_aside_unreadable(&path);
            self.items.clear();
            self.receipts.clear();
            format!("Invalid followups.json: {e}")
        })?;
        let mut items = strip_retired_news(parsed.items);
        if !self.history_enabled {
            items.retain(|i| {
                i.watcher_operation_id.is_none() && !watcher_thread_ids.contains(&i.thread_id)
            });
        }
        let mut mutated = false;
        for item in &mut items {
            if item.status == "dispatching" {
                item.status = "uncertain".into();
                item.error = Some(
                    "Dispatch was interrupted. Refresh to reconcile; this message will not be replayed."
                        .into(),
                );
                mutated = true;
            }
        }
        self.items = items;
        self.receipts = parsed.receipts;
        self.extra = parsed.extra;
        if mutated {
            self.save(watcher_thread_ids)?;
        }
        Ok(())
    }

    pub(crate) fn save(&self, watcher_thread_ids: &HashSet<String>) -> Result<(), String> {
        let persisted_items: Vec<QueuedFollowup> = if self.history_enabled {
            self.items.clone()
        } else {
            self.items
                .iter()
                .filter(|i| {
                    i.watcher_operation_id.is_none() && !watcher_thread_ids.contains(&i.thread_id)
                })
                .cloned()
                .collect()
        };
        let file = FollowupFile {
            items: persisted_items,
            receipts: self.receipts.clone(),
            extra: self.extra.clone(),
        };
        write_atomic_json(&self.path(), &file)
            .map_err(|e| format!("Could not save followups.json: {e}"))
    }

    pub fn items(&self) -> &[QueuedFollowup] {
        &self.items
    }

    pub fn receipts(&self) -> &[FollowupReceipt] {
        &self.receipts
    }

    /// Reads the file again as it stands, before a change: in the local engine the coordinator and Watcher each keep a
    /// copy of this store over the same file, so a change made to a copy read earlier would write over the other's. A
    /// file this build cannot parse is set aside, as at start, and the copy held here is written in its place; one that
    /// cannot be read at all refuses the change.
    pub(crate) fn refresh(&mut self) -> Result<(), String> {
        let path = self.path();
        match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<FollowupFile>(&text) {
                Ok(parsed) => {
                    self.items = strip_retired_news(parsed.items);
                    self.receipts = parsed.receipts;
                    self.extra = parsed.extra;
                }
                Err(_) => set_aside_unreadable(&path),
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                self.items.clear();
                self.receipts.clear();
            }
            Err(err) => return Err(format!("Could not read followups.json: {err}")),
        }
        Ok(())
    }

    pub fn cancel_watcher(
        &mut self,
        operation_ids: &HashSet<String>,
        watcher_thread_ids: &HashSet<String>,
    ) -> Result<Vec<String>, String> {
        self.refresh()?;
        let mut failed = Vec::new();
        let before = self.items.len();
        self.items.retain(|item| {
            let Some(ref op_id) = item.watcher_operation_id else {
                return true;
            };
            if !operation_ids.contains(op_id) || crate::followup_queue::is_in_flight(item) {
                return true;
            }
            if item.status == "failed" {
                failed.push(op_id.clone());
            }
            false
        });
        if self.items.len() != before {
            self.save(watcher_thread_ids)?;
        }
        Ok(failed)
    }

    pub fn set_history_enabled(
        &mut self,
        enabled: bool,
        watcher_thread_ids: &HashSet<String>,
    ) -> Result<(), String> {
        self.refresh()?;
        self.history_enabled = enabled;
        self.save(watcher_thread_ids)
    }
}

// ---------------------------------------------------------------------------
// WatcherHoldState (`src/main/agents/watcherHold.ts`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatcherHold {
    pub kind: String,
    pub provider: String,
    pub since: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_try_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_try_at: Option<String>,
    pub tries: u32,
    pub held: u32,
    pub pull_requests: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone)]
struct HoldFailure {
    thread_id: String,
    turn_id: String,
    kind: String,
    provider: String,
    since_ms: i64,
    resets_at_ms: Option<i64>,
    next_try_at_ms: Option<i64>,
    last_try_at_ms: Option<i64>,
    tries: u32,
    detail: Option<String>,
}

#[derive(Debug, Default)]
pub struct WatcherHoldState {
    failure: Option<HoldFailure>,
    last_seen: Option<(String, String, bool)>,
}

impl WatcherHoldState {
    pub fn read(
        &mut self,
        thread: Option<&Value>,
        scheduled: Option<&ScheduledRestart>,
        now_ms: i64,
    ) -> bool {
        let before = self.key();
        self.update(thread, scheduled, now_ms);
        self.key() != before
    }

    fn key(&self) -> Option<String> {
        let f = self.failure.as_ref()?;
        Some(format!(
            "{}|{}|{}|{}|{:?}|{:?}|{}|{:?}",
            f.thread_id,
            f.turn_id,
            f.kind,
            f.provider,
            f.resets_at_ms,
            f.next_try_at_ms,
            f.tries,
            f.detail
        ))
    }

    fn update(
        &mut self,
        thread: Option<&Value>,
        scheduled: Option<&ScheduledRestart>,
        now_ms: i64,
    ) {
        let Some(thread) = thread else {
            self.failure = None;
            self.last_seen = None;
            return;
        };
        let thread_id = thread
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let last_turn = thread.get("lastTurn");
        let turn_status = last_turn
            .and_then(|t| t.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let turn_id = last_turn
            .and_then(|t| t.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let turn_key = if last_turn.is_some() {
            format!("{turn_status} {turn_id}")
        } else {
            String::new()
        };
        let working =
            thread.get("status").and_then(Value::as_str) == Some("running") || turn_status == "running";
        let seen = self
            .last_seen
            .as_ref()
            .filter(|(id, _, _)| id == &thread_id)
            .cloned();
        self.last_seen = Some((thread_id.clone(), turn_key.clone(), working));
        if self
            .failure
            .as_ref()
            .is_some_and(|f| f.thread_id != thread_id)
        {
            self.failure = None;
        }
        if self
            .failure
            .as_ref()
            .and_then(|f| f.resets_at_ms)
            .is_some_and(|r| r + LIMIT_RESTART_GRACE_MS <= now_ms)
        {
            self.failure = None;
        }
        if working {
            return;
        }
        if turn_status != "failed" {
            self.failure = None;
            return;
        }
        let limit_stop = last_turn.and_then(|t| t.get("limitStop")).filter(|v| !v.is_null());
        let at_str = scheduled
            .and_then(|s| s.at.as_deref())
            .or_else(|| limit_stop.and_then(|ls| ls.get("resetsAt")).and_then(Value::as_str));
        let parsed_ms = at_str.and_then(parse_ms);
        if parsed_ms.is_some_and(|ms| ms + LIMIT_RESTART_GRACE_MS <= now_ms) {
            self.failure = None;
            return;
        }
        let reset = parsed_ms.filter(|ms| ms - now_ms <= LIMIT_RESTART_HORIZON_MS);
        let limited = limit_stop.is_some() || scheduled.is_some();
        let provider = scheduled
            .map(|s| s.provider.clone())
            .or_else(|| {
                thread
                    .get("providerId")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .unwrap_or_else(|| "unknown".into());
        let detail = last_turn
            .and_then(|t| t.get("error"))
            .and_then(Value::as_str)
            .map(|s| s.trim().chars().take(WATCHER_HOLD_DETAIL_MAX).collect::<String>())
            .filter(|s| !s.is_empty());

        if let Some(ref mut current) = self.failure {
            if current.turn_id == turn_id {
                if current.resets_at_ms.is_none() && reset.is_some() {
                    current.kind = "limited".into();
                    current.resets_at_ms = reset;
                    current.next_try_at_ms = None;
                }
                if current.detail.is_none() {
                    current.detail = detail;
                }
                return;
            }
        }
        if self.failure.is_none() && !limited {
            let is_old = match seen {
                None => true,
                Some((_, ref prev_turn, prev_running)) => {
                    !prev_running && (prev_turn.is_empty() || prev_turn == &turn_key)
                }
            };
            if is_old {
                return;
            }
        }
        let prev = self.failure.take();
        self.failure = Some(HoldFailure {
            thread_id,
            turn_id,
            kind: if limited { "limited" } else { "failing" }.into(),
            provider,
            since_ms: prev.as_ref().map(|p| p.since_ms).unwrap_or(now_ms),
            resets_at_ms: reset,
            next_try_at_ms: if reset.is_none() {
                Some(now_ms + WATCHER_FAILING_RETRY_MS)
            } else {
                None
            },
            last_try_at_ms: prev.as_ref().map(|_| now_ms),
            tries: prev.as_ref().map(|p| p.tries + 1).unwrap_or(0),
            detail,
        });
    }

    pub fn try_now(&mut self, now_ms: i64) -> bool {
        let Some(ref mut f) = self.failure else {
            return false;
        };
        if f.resets_at_ms.is_some() {
            return false;
        }
        let Some(next) = f.next_try_at_ms else {
            return false;
        };
        if next <= now_ms {
            return false;
        }
        f.next_try_at_ms = Some(now_ms);
        true
    }

    pub fn shown(&self, held_count: u32, pull_requests: u32) -> Option<WatcherHold> {
        let f = self.failure.as_ref()?;
        let iso = |ms: Option<i64>| -> Option<String> {
            ms.and_then(DateTime::<Utc>::from_timestamp_millis)
                .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        };
        Some(WatcherHold {
            kind: f.kind.clone(),
            provider: f.provider.clone(),
            since: iso(Some(f.since_ms)).unwrap_or_else(now_iso),
            resets_at: iso(f.resets_at_ms),
            next_try_at: iso(f.next_try_at_ms),
            last_try_at: iso(f.last_try_at_ms),
            tries: f.tries,
            held: held_count,
            pull_requests,
            detail: f.detail.clone(),
        })
    }
}

// ---------------------------------------------------------------------------
// WatcherRoomBroadcast (`src/main/agents/watcherRoomDesktop.ts`)
// 100% wire-compatible with `applyWatcherRoomUpdate` in `src/shared/watcherRoom.ts`
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherRoomListChange {
    pub length: usize,
    pub at: Vec<(usize, Value)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch: Option<Vec<(usize, WatcherRoomPatch)>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherRoomPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lists: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherRoomUpdate {
    pub revision: u64,
    pub base: Option<u64>,
    pub room: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lists: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<Vec<String>>,
}

#[derive(Debug, Default)]
pub struct WatcherRoomBroadcast {
    revision: u64,
    base: Option<(u64, Value)>,
    resets: u64,
}

impl WatcherRoomBroadcast {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.base = None;
        self.resets += 1;
    }

    /// Computes the next `WatcherRoomUpdate` measured from the last delivered room,
    /// returning `None` if only `observedAt` / `sequence` changed.
    pub fn next_update(&mut self, room: &Value) -> Option<WatcherRoomUpdate> {
        let update = match &self.base {
            None => WatcherRoomUpdate {
                revision: self.revision + 1,
                base: None,
                room: room.clone(),
                lists: None,
                removed: None,
            },
            Some((base_rev, base_room)) => {
                let patch = record_patch(base_room, room, &["observedAt", "sequence"])?;
                let mut set_map = patch.set.unwrap_or_default();
                if let Some(obs) = room.get("observedAt") {
                    set_map.insert("observedAt".into(), obs.clone());
                }
                if let Some(seq) = room.get("sequence") {
                    set_map.insert("sequence".into(), seq.clone());
                }
                WatcherRoomUpdate {
                    revision: self.revision + 1,
                    base: Some(*base_rev),
                    room: Value::Object(set_map),
                    lists: patch.lists,
                    removed: patch.removed,
                }
            }
        };
        self.revision = update.revision;
        Some(update)
    }

    /// Sends `room` via `deliver`, advancing the base only if delivery succeeded without a reset.
    pub fn send<F>(&mut self, room: Value, deliver: F)
    where
        F: FnOnce(&WatcherRoomUpdate) -> bool,
    {
        let resets_before = self.resets;
        let Some(update) = self.next_update(&room) else {
            return;
        };
        if deliver(&update) && self.resets == resets_before {
            self.base = Some((update.revision, room));
        }
    }
}

fn record_patch(before: &Value, after: &Value, ignored: &[&str]) -> Option<WatcherRoomPatch> {
    let (Some(held), Some(next)) = (before.as_object(), after.as_object()) else {
        return None;
    };
    let mut set = Map::new();
    let mut lists = Map::new();
    let mut removed = Vec::new();
    let mut any = false;

    for (key, now_val) in next {
        if ignored.contains(&key.as_str()) {
            continue;
        }
        match held.get(key) {
            Some(was_val) if was_val == now_val => continue,
            Some(Value::Array(was_arr)) if now_val.is_array() => {
                if let Some(change) = list_change(was_arr, now_val.as_array().unwrap()) {
                    lists.insert(
                        key.clone(),
                        serde_json::to_value(change).unwrap_or(Value::Null),
                    );
                    any = true;
                }
            }
            _ => {
                set.insert(key.clone(), now_val.clone());
                any = true;
            }
        }
    }

    for key in held.keys() {
        if !ignored.contains(&key.as_str()) && !next.contains_key(key) {
            removed.push(key.clone());
            any = true;
        }
    }

    if !any {
        return None;
    }
    Some(WatcherRoomPatch {
        set: if set.is_empty() { None } else { Some(set) },
        removed: if removed.is_empty() {
            None
        } else {
            Some(removed)
        },
        lists: if lists.is_empty() { None } else { Some(lists) },
    })
}

fn list_change(before: &[Value], after: &[Value]) -> Option<WatcherRoomListChange> {
    let mut at = Vec::new();
    let mut patch = Vec::new();
    for (index, entry) in after.iter().enumerate() {
        if let Some(was) = before.get(index) {
            if was == entry {
                continue;
            }
            if was.is_object() && entry.is_object() {
                if let Some(changed) = record_patch(was, entry, &[]) {
                    patch.push((index, changed));
                    continue;
                }
            }
        }
        at.push((index, entry.clone()));
    }
    if at.is_empty() && patch.is_empty() && before.len() == after.len() {
        return None;
    }
    Some(WatcherRoomListChange {
        length: after.len(),
        at,
        patch: if patch.is_empty() { None } else { Some(patch) },
    })
}

// ---------------------------------------------------------------------------
// WatcherStateChanges (`changedSince` cursor diffing for `read_state`)
// ---------------------------------------------------------------------------

type SeenStateItems = HashMap<String, (String, Value)>;
type SeenStateSnapshot = HashMap<String, SeenStateItems>;

#[derive(Debug, Default)]
pub struct WatcherStateChanges {
    order: Vec<String>,
    reads: HashMap<String, SeenStateSnapshot>,
}

impl WatcherStateChanges {
    pub fn remember(&mut self, lists: &Value) -> String {
        let mut seen: HashMap<String, HashMap<String, (String, Value)>> = HashMap::new();
        for list_name in ["watching", "mergeQueue", "waitingOnUser", "kept", "staleNotes"] {
            let mut map = HashMap::new();
            for (k, item, gone) in extract_state_items(list_name, lists) {
                let d = sha256_hex(serde_json::to_string(&item).unwrap_or_default().as_bytes());
                map.insert(k, (d, gone));
            }
            seen.insert(list_name.to_string(), map);
        }
        let cursor = Uuid::new_v4().to_string();
        self.order.push(cursor.clone());
        self.reads.insert(cursor.clone(), seen);
        while self.order.len() > WATCHER_STATE_CURSORS_HELD {
            let oldest = self.order.remove(0);
            self.reads.remove(&oldest);
        }
        cursor
    }

    pub fn since(&self, cursor: &str, lists: &Value) -> Option<(Value, Value, Value)> {
        let seen = self.reads.get(cursor)?;
        let mut unchanged = Map::new();
        let mut gone = Map::new();
        let mut changed_map = Map::new();
        let mut kept_changed_ids: HashSet<String> = HashSet::new();

        for list_name in ["watching", "mergeQueue", "waitingOnUser", "kept", "staleNotes"] {
            let before = seen.get(list_name)?;
            let mut now_keys: HashSet<String> = HashSet::new();
            let mut changed_items: Vec<Value> = Vec::new();
            let mut unchanged_count: u64 = 0;

            for (k, item, _) in extract_state_items(list_name, lists) {
                now_keys.insert(k.clone());
                let d = sha256_hex(serde_json::to_string(&item).unwrap_or_default().as_bytes());
                if before.get(&k).map(|(bd, _)| bd.as_str()) == Some(d.as_str()) {
                    unchanged_count += 1;
                } else {
                    if list_name == "kept" {
                        kept_changed_ids.insert(k);
                    }
                    changed_items.push(item);
                }
            }
            let left: Vec<Value> = before
                .iter()
                .filter(|(k, _)| !now_keys.contains(*k))
                .map(|(_, (_, g))| g.clone())
                .collect();
            if left.len() > WATCHER_STATE_GONE_MAX {
                return None;
            }
            unchanged.insert(list_name.into(), json!(unchanged_count));
            if !left.is_empty() {
                gone.insert(list_name.into(), Value::Array(left));
            }
            changed_map.insert(list_name.into(), Value::Array(changed_items));
        }

        let kept_obj = lists.get("kept").cloned().unwrap_or_else(|| json!({}));
        let filter_kept = |field: &str| -> Value {
            Value::Array(
                kept_obj
                    .get(field)
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter(|item| {
                                item.get("id")
                                    .and_then(Value::as_str)
                                    .is_some_and(|id| kept_changed_ids.contains(id))
                            })
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default(),
            )
        };
        let filtered_kept = json!({
            "decisions": filter_kept("decisions"),
            "rules": filter_kept("rules"),
            "issues": filter_kept("issues"),
            "updatedAt": kept_obj.get("updatedAt").cloned().unwrap_or(Value::Null),
        });
        changed_map.insert("kept".into(), filtered_kept);
        Some((
            Value::Object(changed_map),
            Value::Object(unchanged),
            Value::Object(gone),
        ))
    }
}

fn extract_state_items(list_name: &str, lists: &Value) -> Vec<(String, Value, Value)> {
    let mut out = Vec::new();
    match list_name {
        "watching" => {
            for row in lists
                .get("watching")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[])
            {
                let target = row.get("target").cloned().unwrap_or(Value::Null);
                let host = target.get("hostId").and_then(Value::as_str).unwrap_or("");
                let tid = target.get("threadId").and_then(Value::as_str).unwrap_or("");
                out.push((format!("{host}\0{tid}"), row.clone(), target));
            }
        }
        "mergeQueue" => {
            for row in lists
                .get("mergeQueue")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[])
            {
                let target = row.get("target").cloned().unwrap_or(Value::Null);
                let host = target.get("hostId").and_then(Value::as_str).unwrap_or("");
                let tid = target.get("threadId").and_then(Value::as_str).unwrap_or("");
                let pr = row.get("pullRequest").cloned().unwrap_or(Value::Null);
                let pr_ident = pr
                    .get("url")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .or_else(|| pr.get("number").and_then(Value::as_u64).map(|n| n.to_string()))
                    .unwrap_or_default();
                let mut pr_gone = Map::new();
                if let Some(n) = pr.get("number") {
                    pr_gone.insert("number".into(), n.clone());
                }
                if let Some(u) = pr.get("url") {
                    pr_gone.insert("url".into(), u.clone());
                }
                out.push((
                    format!("{host}\0{tid}\0{pr_ident}"),
                    row.clone(),
                    json!({ "target": target, "pullRequest": Value::Object(pr_gone) }),
                ));
            }
        }
        "waitingOnUser" => {
            for row in lists
                .get("waitingOnUser")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[])
            {
                let target = row.get("target").cloned().unwrap_or(Value::Null);
                let host = target.get("hostId").and_then(Value::as_str).unwrap_or("");
                let tid = target.get("threadId").and_then(Value::as_str).unwrap_or("");
                let wf = row.get("waitsFor").and_then(Value::as_str).unwrap_or("");
                let card = row.get("requestCardId").and_then(Value::as_str).unwrap_or("");
                let del = row
                    .get("delegatedThreadId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                out.push((
                    format!("{host}\0{tid}\0{wf}\0{card}\0{del}"),
                    row.clone(),
                    row.clone(),
                ));
            }
        }
        "kept" => {
            if let Some(kept) = lists.get("kept") {
                for field in ["decisions", "rules", "issues"] {
                    for item in kept
                        .get(field)
                        .and_then(Value::as_array)
                        .map(Vec::as_slice)
                        .unwrap_or(&[])
                    {
                        if let Some(id) = item.get("id").and_then(Value::as_str) {
                            out.push((
                                id.to_string(),
                                item.clone(),
                                Value::String(id.to_string()),
                            ));
                        }
                    }
                }
            }
        }
        "staleNotes" => {
            for note in lists
                .get("staleNotes")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[])
            {
                if let Some(id) = note.get("id").and_then(Value::as_str) {
                    out.push((
                        id.to_string(),
                        note.clone(),
                        Value::String(id.to_string()),
                    ));
                }
            }
        }
        _ => {}
    }
    out
}

// ---------------------------------------------------------------------------
// WatcherWaitsOn & Handover helpers
// ---------------------------------------------------------------------------

pub fn watcher_waits_on(
    status: &str,
    connected: bool,
    settled: bool,
    background_work_count: u64,
    paused: bool,
    parked: bool,
    waits_on: &[(String, String)],
) -> &'static str {
    if waits_on.iter().any(|(_, kind)| kind == "permission") {
        return "The user’s answer to its permission request.";
    }
    if !waits_on.is_empty() {
        return "The user’s answer to its question.";
    }
    if status == "unavailable" || !connected {
        return "Its computer or provider to connect again.";
    }
    if paused {
        return "The user’s own turn in it to end. Watcher sends it nothing until then.";
    }
    if status == "running" {
        return "Its turn to finish.";
    }
    if background_work_count > 0 {
        return "The background work or sub-agents its last turn left running to end.";
    }
    if status == "error" {
        return "A look at its failed turn.";
    }
    if settled {
        return "Nothing. It is settled.";
    }
    if parked {
        return "Nothing. It is parked.";
    }
    "Nothing. It is at rest."
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandoverCounts {
    pub total: u64,
    pub carried: u64,
    pub too_long: u64,
    pub not_carried: u64,
    pub images: u64,
    pub files: u64,
    pub visuals: u64,
    pub tool_records: u64,
    pub history_kept: bool,
    pub answered: bool,
}

#[derive(Debug, Clone)]
pub struct HandoverOffer {
    pub source: WatcherIdentity,
    pub to: WatcherThreadTarget,
    pub counts: HandoverCounts,
    pub accepted_draft_id: Option<String>,
}

#[derive(Debug, Clone)]
struct StopAllConfirmation {
    targets: Vec<WatcherThreadTarget>,
    expires_ms: i64,
    signature: String,
    phone_client_id: Option<String>,
}

// ---------------------------------------------------------------------------
// WatcherMaster (RoomBridge, watched-thread registry, handover, stop-all, tell/ready)
// ---------------------------------------------------------------------------

pub struct WatcherMaster {
    directory: PathBuf,
    host_id: String,
    history_enabled: bool,
    closed: bool,
    pub records: WatcherRecordStore,
    pub kept: WatcherStateStore,
    pub questions: WatcherQuestionsStore,
    pub told_saved: WatcherToldNewsStore,
    pub limit_restarts: LimitRestartStore,
    pub followups: FollowupStore,
    pub hold: WatcherHoldState,
    pub broadcast: WatcherRoomBroadcast,
    pub state_changes: WatcherStateChanges,
    news_buffer: Vec<WatcherEvent>,
    handover_offer: Option<HandoverOffer>,
    confirmations: BTreeMap<String, StopAllConfirmation>,
    room_sequence: u64,
    recovery_notice: Option<String>,
    settle_without_asking: bool,
    compact_at: u64,
}

impl WatcherMaster {
    pub fn new(directory: impl Into<PathBuf>, host_id: impl Into<String>, history_enabled: bool) -> Self {
        let dir = directory.into();
        Self {
            records: WatcherRecordStore::new(&dir),
            kept: WatcherStateStore::new(&dir, history_enabled),
            questions: WatcherQuestionsStore::new(&dir, history_enabled),
            told_saved: WatcherToldNewsStore::new(&dir, history_enabled),
            limit_restarts: LimitRestartStore::new(&dir),
            followups: FollowupStore::new(&dir, history_enabled),
            hold: WatcherHoldState::default(),
            broadcast: WatcherRoomBroadcast::new(),
            state_changes: WatcherStateChanges::default(),
            news_buffer: Vec::new(),
            handover_offer: None,
            confirmations: BTreeMap::new(),
            room_sequence: 0,
            recovery_notice: None,
            settle_without_asking: true,
            compact_at: WATCHER_COMPACT_AT_DEFAULT,
            directory: dir,
            host_id: host_id.into(),
            history_enabled,
            closed: false,
        }
    }

    pub fn load(&mut self) -> Result<(), String> {
        if let Err(err) = self.records.load() {
            self.recovery_notice = Some(err);
        }
        self.kept.load();
        self.questions.load();
        let saved_told = self.told_saved.load().to_vec();
        self.news_buffer = saved_told;
        self.limit_restarts.load();
        let watcher_ids = self.watcher_thread_ids();
        let _ = self.followups.load(&watcher_ids);
        Ok(())
    }

    pub fn close(&mut self) {
        self.closed = true;
        self.handover_offer = None;
        self.confirmations.clear();
    }

    pub fn set_history_enabled(&mut self, enabled: bool) -> Result<(), String> {
        self.history_enabled = enabled;
        let watcher_ids = self.watcher_thread_ids();
        self.kept.set_history_enabled(enabled)?;
        self.questions.set_history_enabled(enabled)?;
        self.told_saved.set_history_enabled(enabled)?;
        self.followups.set_history_enabled(enabled, &watcher_ids)?;
        Ok(())
    }

    pub fn watcher_thread_ids(&self) -> HashSet<String> {
        let mut ids = HashSet::new();
        let rec = self.records.view();
        if let Some(ref cur) = rec.current {
            ids.insert(cur.target.thread_id.clone());
        }
        for h in &rec.history {
            ids.insert(h.target.thread_id.clone());
        }
        ids
    }

    pub fn has_standing_watch(&self, target: &WatcherThreadTarget) -> bool {
        self.records
            .view()
            .watches
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .any(|w| w.target == *target)
    }

    pub fn watched_local_thread_ids(&self) -> Vec<String> {
        let rec = self.records.view();
        let mut out = HashSet::new();
        for w in rec.watches.as_deref().unwrap_or(&[]) {
            if w.target.host_id == self.host_id {
                out.insert(w.target.thread_id.clone());
            }
        }
        for req in &rec.requests {
            if req.state != "active" {
                continue;
            }
            for p in &req.participants {
                if p.target.host_id == self.host_id
                    && p.state == "participating"
                    && p.automation_stopped != Some(true)
                {
                    out.insert(p.target.thread_id.clone());
                }
            }
        }
        let mut list: Vec<String> = out.into_iter().collect();
        list.sort();
        list
    }

    /// Gathers snapshots of the local host and every connected remote host.
    async fn collect_host_snapshots(
        &self,
        coordinator: &CoordinatorHandle,
        router: Option<&DesktopHostRouter>,
    ) -> HashMap<String, Value> {
        let mut map = HashMap::new();
        if let Ok(local_shell) = coordinator.shell(true).await {
            if let Some(host) = local_shell.get("host") {
                map.insert(self.host_id.clone(), host.clone());
            }
        }
        if let Some(r) = router {
            for rid in r.connected_remote_ids() {
                if let Some(client) = r.remote_client(&rid) {
                    let shell = client.cached_shell().await;
                    if let Some(host) = shell.get("host") {
                        map.insert(rid, host.clone());
                    }
                }
            }
        }
        map
    }

    /// Builds `WatcherRoomState` matching `src/shared/watcherRoom.ts:watcherRoomStateSchema`.
    pub async fn state(
        &mut self,
        coordinator: &CoordinatorHandle,
        router: Option<&DesktopHostRouter>,
    ) -> Value {
        let snapshots = self.collect_host_snapshots(coordinator, router).await;
        self.build_room_state(&snapshots)
    }

    /// Builds `WatcherRoomState` from already-collected host snapshots (also used in unit tests).
    pub fn build_room_state(&mut self, host_snapshots: &HashMap<String, Value>) -> Value {
        self.room_sequence += 1;
        let rec = self.records.view().clone();
        let local_snap = host_snapshots.get(&self.host_id);
        let current_thread = rec.current.as_ref().and_then(|cur| {
            find_thread_in_snapshot(local_snap, &cur.target.thread_id)
        });

        let current_options = current_thread.map(|thread| {
            let connected = is_thread_provider_connected(local_snap, thread);
            let speed = thread
                .get("speed")
                .cloned()
                .unwrap_or_else(|| {
                    if thread.get("fastMode").and_then(Value::as_bool) == Some(true) {
                        Value::String("fast".into())
                    } else {
                        Value::Null
                    }
                });
            json!({
                "modelId": thread.get("modelId").and_then(Value::as_str).unwrap_or(""),
                "reasoningEffort": thread.get("reasoningEffort").cloned().unwrap_or(Value::Null),
                "speed": speed,
                "runtimeMode": thread.get("runtimeMode").and_then(Value::as_str).unwrap_or("approval-required"),
                "status": normalize_room_status(thread.get("status").and_then(Value::as_str)),
                "connected": connected,
            })
        });

        let runtime_mode = rec
            .last_runtime_mode
            .clone()
            .or_else(|| {
                current_thread
                    .and_then(|t| t.get("runtimeMode"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .unwrap_or_else(|| "approval-required".into());

        let watches = rec.watches.clone().unwrap_or_default();
        let mut target_order: Vec<String> = Vec::new();
        let mut targets_by_key: HashMap<String, WatcherThreadTarget> = HashMap::new();
        let mut participations: HashMap<String, Vec<WatcherParticipant>> = HashMap::new();
        let mut watch_of: HashMap<String, WatcherStandingWatch> = HashMap::new();

        for req in &rec.requests {
            for part in &req.participants {
                let tk = part.target.key();
                if !targets_by_key.contains_key(&tk) {
                    target_order.push(tk.clone());
                    targets_by_key.insert(tk.clone(), part.target.clone());
                }
                participations.entry(tk).or_default().push(part.clone());
            }
        }
        for watch in &watches {
            let tk = watch.target.key();
            if !targets_by_key.contains_key(&tk) {
                target_order.push(tk.clone());
                targets_by_key.insert(tk.clone(), watch.target.clone());
            }
            watch_of.entry(tk).or_insert_with(|| watch.clone());
        }

        let acting_request_ids: HashSet<&str> = rec
            .requests
            .iter()
            .filter(|r| r.state == "active")
            .map(|r| r.id.as_str())
            .collect();

        let mut watched_threads = Vec::new();
        let mut state_watching = Vec::new();
        let mut state_waiting_on_user = Vec::new();

        for tk in &target_order {
            let target = &targets_by_key[tk];
            let watch = watch_of.get(tk);
            let parts = participations.get(tk).cloned().unwrap_or_default();
            let takes_part = parts.iter().any(|p| {
                acting_request_ids.contains(p.request_id.as_str())
                    && p.state == "participating"
                    && p.automation_stopped != Some(true)
            });
            let watched = watch.is_some() || takes_part;
            let paused = watch
                .and_then(|w| w.paused_by_user_message_id.as_ref())
                .and_then(|o| o.as_ref())
                .is_some();
            let parked = watch.and_then(|w| w.parked) == Some(true)
                || parts.iter().any(|p| {
                    p.state == "participating"
                        && p.automation_stopped != Some(true)
                        && p.parked == Some(true)
                        && acting_request_ids.contains(p.request_id.as_str())
                });

            let snap = host_snapshots.get(&target.host_id);
            let thread = find_thread_in_snapshot(snap, &target.thread_id);
            let title = thread
                .and_then(|t| t.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("Unavailable thread")
                .to_string();
            let status = thread
                .and_then(|t| t.get("status"))
                .and_then(Value::as_str)
                .map(|s| match s {
                    "idle" | "running" | "error" => s,
                    _ => "unavailable",
                })
                .unwrap_or("unavailable");
            let connected = thread
                .map(|t| is_thread_provider_connected(snap, t))
                .unwrap_or(false);
            let settled = thread
                .map(|t| is_thread_settled(snap, t))
                .unwrap_or(false);
            let bg_work = thread.map(thread_background_work_count).unwrap_or(0);
            let raw_waits: Vec<(String, String)> = thread
                .and_then(|t| t.get("requests"))
                .and_then(Value::as_array)
                .map(|reqs| {
                    reqs.iter()
                        .filter_map(|r| {
                            let id = r.get("id").and_then(Value::as_str)?;
                            let kind = r.get("kind").and_then(Value::as_str)?;
                            if kind == "question" || kind == "permission" {
                                Some((id.to_string(), kind.to_string()))
                            } else {
                                None
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();

            let waits_on_json: Vec<Value> = raw_waits
                .iter()
                .map(|(id, kind)| {
                    json!({
                        "id": id,
                        "kind": kind,
                        "openTarget": target,
                    })
                })
                .collect();

            let mut row = Map::new();
            row.insert("target".into(), serde_json::to_value(target).unwrap());
            row.insert("title".into(), Value::String(title.clone()));
            row.insert("watched".into(), Value::Bool(watched));
            row.insert("paused".into(), Value::Bool(paused));
            if parked {
                row.insert("parked".into(), Value::Bool(true));
            }
            row.insert("status".into(), Value::String(status.into()));
            row.insert("connected".into(), Value::Bool(connected));
            row.insert("settled".into(), Value::Bool(settled));
            row.insert("backgroundWorkCount".into(), json!(bg_work));
            row.insert("waitsOn".into(), Value::Array(waits_on_json));
            row.insert(
                "participation".into(),
                serde_json::to_value(&parts).unwrap_or_else(|_| json!([])),
            );
            row.insert("evidence".into(), json!([]));
            watched_threads.push(Value::Object(row));

            if watched {
                let waits_sentence = watcher_waits_on(
                    status,
                    connected,
                    settled,
                    bg_work,
                    paused,
                    parked,
                    &raw_waits,
                );
                let mut st = Map::new();
                st.insert("target".into(), serde_json::to_value(target).unwrap());
                st.insert("title".into(), Value::String(title.clone()));
                st.insert("waitsOn".into(), Value::String(waits_sentence.into()));
                if parked {
                    st.insert("parked".into(), Value::Bool(true));
                }
                state_watching.push(Value::Object(st));

                for (card_id, card_kind) in &raw_waits {
                    state_waiting_on_user.push(json!({
                        "target": target,
                        "title": title,
                        "waitsFor": card_kind,
                        "requestCardId": card_id,
                    }));
                }
            }
        }

        // Strip `phoneOrigin` from requests exposed in room state (stays private to record).
        let room_requests: Vec<Value> = rec
            .requests
            .iter()
            .map(|r| {
                let mut copy = r.clone();
                copy.phone_origin = None;
                serde_json::to_value(copy).unwrap_or(Value::Null)
            })
            .collect();

        let offer_json = self
            .current_offer()
            .map(|o| {
                json!({
                    "source": o.source.target,
                    "provider": o.source.provider,
                    "counts": o.counts,
                })
            })
            .unwrap_or(Value::Null);

        let context = current_thread.map(|thread| {
            let tokens = thread
                .get("usage")
                .and_then(|u| u.get("contextTokens").or_else(|| u.get("inputTokens")))
                .and_then(Value::as_u64);
            let compacting = thread
                .get("compaction")
                .and_then(|c| c.get("status"))
                .and_then(Value::as_str)
                == Some("running");
            json!({
                "tokens": tokens,
                "compactAt": self.compact_at,
                "canCompact": false,
                "compacting": compacting,
            })
        });

        let kept_state = self.kept.read();
        let mut state_obj = Map::new();
        state_obj.insert("watching".into(), Value::Array(state_watching));
        state_obj.insert("waitingOnUser".into(), Value::Array(state_waiting_on_user));
        state_obj.insert(
            "kept".into(),
            serde_json::to_value(&kept_state).unwrap_or_else(|_| json!({})),
        );
        if !self.kept.readable() {
            state_obj.insert("unread".into(), Value::Bool(true));
        }

        let mut room = Map::new();
        room.insert(
            "current".into(),
            serde_json::to_value(&rec.current).unwrap_or(Value::Null),
        );
        room.insert(
            "currentOptions".into(),
            current_options.unwrap_or(Value::Null),
        );
        room.insert(
            "history".into(),
            serde_json::to_value(&rec.history).unwrap_or_else(|_| json!([])),
        );
        room.insert("runtimeMode".into(), Value::String(runtime_mode));
        room.insert(
            "standingWatches".into(),
            serde_json::to_value(&watches).unwrap_or_else(|_| json!([])),
        );
        room.insert("ownChanges".into(), json!([]));
        room.insert("requests".into(), Value::Array(room_requests));
        room.insert("watchedThreads".into(), Value::Array(watched_threads));
        room.insert(
            "receipts".into(),
            serde_json::to_value(&rec.operations).unwrap_or_else(|_| json!([])),
        );
        room.insert(
            "news".into(),
            serde_json::to_value(&self.news_buffer).unwrap_or_else(|_| json!([])),
        );
        room.insert(
            "recoveryNotice".into(),
            self.recovery_notice
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        room.insert("observedAt".into(), Value::String(now_iso()));
        room.insert("sequence".into(), json!(self.room_sequence));
        room.insert("creationStopped".into(), Value::Bool(rec.creation.is_some()));
        room.insert("handover".into(), offer_json);
        room.insert("receiptReplies".into(), json!([]));
        room.insert("asks".into(), json!([]));
        room.insert("context".into(), context.unwrap_or(Value::Null));
        room.insert("state".into(), Value::Object(state_obj));

        if let Some(ref cur) = rec.current {
            let qs = self.questions.for_watcher(&cur.target.thread_id);
            if !qs.is_empty() {
                room.insert(
                    "questions".into(),
                    serde_json::to_value(qs).unwrap_or_else(|_| json!([])),
                );
            }
            if let Some(thread) = current_thread {
                if rec.creation.is_none() {
                    let is_running =
                        thread.get("status").and_then(Value::as_str) == Some("running");
                    let has_msgs = thread
                        .get("messages")
                        .and_then(Value::as_array)
                        .is_some_and(|m| !m.is_empty())
                        || thread
                            .get("summary")
                            .and_then(|s| s.get("lastUser"))
                            .is_some_and(|v| !v.is_null());
                    let answer = if is_running {
                        "busy"
                    } else if !has_msgs {
                        "empty"
                    } else {
                        "available"
                    };
                    room.insert("newWatcher".into(), Value::String(answer.into()));
                }
            }
        }

        // Update hold state from current Watcher thread.
        let scheduled = rec
            .current
            .as_ref()
            .and_then(|cur| self.limit_restarts.scheduled(&cur.target.thread_id));
        self.hold
            .read(current_thread, scheduled.as_ref(), Utc::now().timestamp_millis());
        if let Some(hold) = self.hold.shown(self.news_buffer.len() as u32, 0) {
            room.insert(
                "hold".into(),
                serde_json::to_value(hold).unwrap_or(Value::Null),
            );
        }

        Value::Object(room)
    }

    /// `WATCHER_GET`: resets room delta broadcaster so the next push is whole.
    pub async fn get(
        &mut self,
        coordinator: &CoordinatorHandle,
        router: Option<&DesktopHostRouter>,
    ) -> Value {
        self.broadcast.reset();
        let state = self.state(coordinator, router).await;
        json!({ "status": "ok", "state": state })
    }

    /// `WATCHER_OPEN`: opens or reconfigures Watcher on the chosen provider/model.
    pub async fn open(
        &mut self,
        input: &Value,
        coordinator: &CoordinatorHandle,
        router: Option<&DesktopHostRouter>,
    ) -> Value {
        if self.closed {
            return watcher_refusal(
                "NOT_CURRENT_WATCHER",
                self.recovery_notice
                    .as_deref()
                    .unwrap_or("Watcher is stopping. Reopen Sotto."),
                false,
            );
        }
        let Some(obj) = input.as_object() else {
            return watcher_refusal("INVALID_INPUT", "Choose supported Watcher settings.", false);
        };
        let Some(provider) = obj
            .get("provider")
            .and_then(Value::as_str)
            .filter(|p| WATCHER_PROVIDERS.contains(p))
        else {
            return watcher_refusal("INVALID_INPUT", "Choose supported Watcher settings.", false);
        };
        let Some(model_id) = obj
            .get("modelId")
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty() && m.len() <= 512)
        else {
            return watcher_refusal("INVALID_INPUT", "Choose supported Watcher settings.", false);
        };
        let reasoning_effort = obj
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let speed = obj
            .get("speed")
            .and_then(|v| if v.is_null() { Some(None) } else { v.as_str().map(|s| Some(s.to_string())) });

        let local_shell = match coordinator.shell(true).await {
            Ok(s) => s,
            Err(_) => {
                return watcher_refusal(
                    "PROVIDER_UNAVAILABLE",
                    "Watcher could not be opened. Nothing was sent. Check its provider and reopen Watcher.",
                    true,
                )
            }
        };
        let host_snap = local_shell.get("host");
        let model_ready = host_snap
            .and_then(|h| h.get("models"))
            .and_then(Value::as_array)
            .and_then(|models| {
                models.iter().find(|m| {
                    m.get("id").and_then(Value::as_str) == Some(model_id)
                        && m.get("providerId").and_then(Value::as_str) == Some(provider)
                        && m.get("ready").and_then(Value::as_bool) == Some(true)
                })
            });
        if model_ready.is_none() {
            return watcher_refusal(
                "PROVIDER_UNAVAILABLE",
                "Connect the chosen provider and choose one of its ready models.",
                true,
            );
        }

        let previous = self.records.view().current.clone();
        if let Some(ref prev) = previous {
            if prev.provider == provider {
                // Reconfigure current Watcher thread in place.
                let mut cmd = Map::new();
                cmd.insert("type".into(), json!("configure-thread"));
                cmd.insert("threadId".into(), json!(prev.target.thread_id));
                cmd.insert("modelId".into(), json!(model_id));
                if let Some(ref eff) = reasoning_effort {
                    cmd.insert("reasoningEffort".into(), json!(eff));
                }
                if let Some(ref sp) = speed {
                    cmd.insert(
                        "speed".into(),
                        sp.clone().map(Value::String).unwrap_or(Value::Null),
                    );
                }
                if coordinator
                    .run_command(local_desktop_client(), cmd)
                    .await
                    .is_err()
                {
                    return watcher_refusal(
                        "PROVIDER_UNAVAILABLE",
                        "Watcher’s settings could not be changed. Check its provider and reopen Watcher.",
                        true,
                    );
                }
                let state = self.state(coordinator, router).await;
                return json!({ "status": "ok", "state": state });
            }
        }

        // Create a fresh Watcher thread on the chosen provider/model.
        match self
            .replace_watcher(
                previous,
                provider,
                model_id,
                reasoning_effort.as_deref(),
                speed.flatten().as_deref(),
                coordinator,
                router,
            )
            .await
        {
            Ok(state) => json!({ "status": "ok", "state": state }),
            Err(refusal) => refusal,
        }
    }

    /// `WATCHER_START_NEW`: retires current Watcher to history, creates a new one on same settings,
    /// and offers a handover of the retired Watcher's conversation.
    pub async fn start_new(
        &mut self,
        coordinator: &CoordinatorHandle,
        router: Option<&DesktopHostRouter>,
    ) -> Value {
        if self.closed {
            return watcher_refusal(
                "NOT_CURRENT_WATCHER",
                self.recovery_notice
                    .as_deref()
                    .unwrap_or("Watcher is stopping. Reopen Sotto."),
                false,
            );
        }
        let Some(previous) = self.records.view().current.clone() else {
            return watcher_refusal(
                "NOT_CURRENT_WATCHER",
                "There is no Watcher yet. Send Watcher your first message to start it.",
                false,
            );
        };
        let local_shell = match coordinator.shell(true).await {
            Ok(s) => s,
            Err(_) => {
                return watcher_refusal(
                    "PROVIDER_UNAVAILABLE",
                    "Sotto could not start a new Watcher. Nothing was sent. Check its provider and try again.",
                    true,
                )
            }
        };
        let host_snap = local_shell.get("host");
        let Some(thread) = find_thread_in_snapshot(host_snap, &previous.target.thread_id) else {
            return watcher_refusal(
                "PROVIDER_UNAVAILABLE",
                "Watcher’s conversation is unavailable. Reconnect its provider and try again.",
                true,
            );
        };
        if thread.get("status").and_then(Value::as_str) == Some("running") {
            return watcher_refusal(
                "THREAD_BUSY",
                "Wait for Watcher to finish its current turn before starting a new one.",
                true,
            );
        }
        let detail = coordinator
            .detail(previous.target.thread_id.clone())
            .await
            .ok()
            .flatten();
        let msg_count = detail.as_ref().map(|d| d.messages.len()).unwrap_or(0);
        if msg_count == 0 {
            return watcher_refusal(
                "INVALID_INPUT",
                "This Watcher is new, so there is nothing to hand over yet. Nothing was changed.",
                false,
            );
        }
        let model_id = thread
            .get("modelId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let reasoning_effort = thread
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let speed = thread
            .get("speed")
            .and_then(Value::as_str)
            .map(ToString::to_string);

        match self
            .replace_watcher(
                Some(previous),
                thread
                    .get("providerId")
                    .and_then(Value::as_str)
                    .unwrap_or("codex"),
                &model_id,
                reasoning_effort.as_deref(),
                speed.as_deref(),
                coordinator,
                router,
            )
            .await
        {
            Ok(state) => json!({ "status": "ok", "state": state }),
            Err(refusal) => refusal,
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn replace_watcher(
        &mut self,
        previous: Option<WatcherIdentity>,
        provider: &str,
        model_id: &str,
        reasoning_effort: Option<&str>,
        speed: Option<&str>,
        coordinator: &CoordinatorHandle,
        router: Option<&DesktopHostRouter>,
    ) -> Result<Value, Value> {
        let local_shell = coordinator.shell(true).await.map_err(|_| {
            watcher_refusal(
                "PROVIDER_UNAVAILABLE",
                "Watcher could not be opened. Nothing was sent.",
                true,
            )
        })?;
        // Ensure a project exists for Watcher (reuse previous project, or first project, or create watcher folder).
        let project_id = if let Some(ref prev) = previous {
            prev.project_id.clone()
        } else if let Some(pid) = local_shell
            .get("host")
            .and_then(|h| h.get("projects"))
            .and_then(Value::as_array)
            .and_then(|ps| ps.first())
            .and_then(|p| p.get("id"))
            .and_then(Value::as_str)
        {
            pid.to_string()
        } else {
            let watcher_dir = self.directory.join("watcher");
            let _ = fs::create_dir_all(&watcher_dir);
            let mut create_proj = Map::new();
            create_proj.insert("type".into(), json!("create-project"));
            create_proj.insert("title".into(), json!("Watcher"));
            create_proj.insert(
                "workingDirectory".into(),
                json!(watcher_dir.to_string_lossy().to_string()),
            );
            let after_proj = coordinator
                .run_command(local_desktop_client(), create_proj)
                .await
                .map_err(|_| {
                    watcher_refusal(
                        "PROVIDER_UNAVAILABLE",
                        "Watcher’s project folder could not be created.",
                        true,
                    )
                })?;
            after_proj
                .get("host")
                .and_then(|h| h.get("projects"))
                .and_then(Value::as_array)
                .and_then(|ps| ps.last())
                .and_then(|p| p.get("id"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    watcher_refusal(
                        "PROVIDER_UNAVAILABLE",
                        "Watcher’s project folder could not be created.",
                        true,
                    )
                })?
                .to_string()
        };

        let existing_ids: HashSet<String> = coordinator
            .shell(true)
            .await
            .ok()
            .and_then(|s| {
                s.get("host")
                    .and_then(|h| h.get("threads"))
                    .and_then(Value::as_array)
                    .map(|ts| {
                        ts.iter()
                            .filter_map(|t| t.get("id").and_then(Value::as_str).map(ToString::to_string))
                            .collect()
                    })
            })
            .unwrap_or_default();

        let runtime_mode = self
            .records
            .view()
            .last_runtime_mode
            .clone()
            .unwrap_or_else(|| "approval-required".into());

        let mut create_thread = Map::new();
        create_thread.insert("type".into(), json!("create-thread"));
        create_thread.insert("projectId".into(), json!(project_id));
        create_thread.insert("modelId".into(), json!(model_id));
        create_thread.insert("title".into(), json!("Watcher"));
        create_thread.insert("runtimeMode".into(), json!(runtime_mode));
        if let Some(eff) = reasoning_effort {
            create_thread.insert("reasoningEffort".into(), json!(eff));
        }
        if let Some(sp) = speed {
            create_thread.insert("speed".into(), json!(sp));
        }
        let after_create = coordinator
            .run_command(local_desktop_client(), create_thread)
            .await
            .map_err(|_| {
                watcher_refusal(
                    "PROVIDER_UNAVAILABLE",
                    "Watcher could not be opened. Nothing was sent. Check its provider and reopen Watcher.",
                    true,
                )
            })?;

        let new_thread_id = after_create
            .get("host")
            .and_then(|h| h.get("threads"))
            .and_then(Value::as_array)
            .and_then(|ts| {
                ts.iter()
                    .filter_map(|t| t.get("id").and_then(Value::as_str))
                    .find(|id| !existing_ids.contains(*id))
            })
            .ok_or_else(|| {
                watcher_refusal(
                    "PROVIDER_UNAVAILABLE",
                    "Watcher thread was not created. Reopen Watcher.",
                    true,
                )
            })?
            .to_string();

        let new_identity = WatcherIdentity {
            target: WatcherThreadTarget::new(&self.host_id, &new_thread_id),
            project_id,
            provider: provider.to_string(),
            creation_operation_id: Uuid::new_v4().to_string(),
            created_at: now_iso(),
        };

        // Close open questions on the replaced Watcher before switching.
        if let Some(ref prev) = previous {
            let _ = self.questions.close_for_watcher(&prev.target.thread_id);
        }

        let prev_for_handover = previous.clone();
        let new_id_clone = new_identity.clone();
        self.records
            .update(|rec| {
                if let Some(prev) = rec.current.take() {
                    if !rec.history.iter().any(|h| h.target == prev.target) {
                        rec.history.push(prev);
                    }
                }
                rec.current = Some(new_id_clone);
                rec.creation = None;
                Ok(())
            })
            .map_err(|e| watcher_refusal("HOST_DISCONNECTED", &e, true))?;

        // Offer handover when the replaced Watcher has conversation history.
        self.handover_offer = None;
        if let Some(prev) = prev_for_handover {
            if let Ok(Some(detail)) = coordinator.detail(prev.target.thread_id.clone()).await {
                let total = detail.messages.len() as u64;
                if total > 0 {
                    let answered = detail
                        .messages
                        .last()
                        .is_some_and(|m| m.role == "assistant");
                    let tool_records = detail.activities.len() as u64;
                    self.handover_offer = Some(HandoverOffer {
                        source: prev,
                        to: new_identity.target,
                        counts: HandoverCounts {
                            total,
                            carried: total,
                            too_long: 0,
                            not_carried: 0,
                            images: 0,
                            files: 0,
                            visuals: 0,
                            tool_records,
                            history_kept: self.history_enabled,
                            answered,
                        },
                        accepted_draft_id: None,
                    });
                }
            }
        }

        Ok(self.state(coordinator, router).await)
    }

    /// `WATCHER_SET_PERMISSION`: persists `lastRuntimeMode` and updates current Watcher thread.
    pub async fn set_permission(
        &mut self,
        input: &Value,
        coordinator: &CoordinatorHandle,
        router: Option<&DesktopHostRouter>,
    ) -> Value {
        if self.closed {
            return watcher_refusal(
                "NOT_CURRENT_WATCHER",
                "Open Watcher on its desktop to change its permissions.",
                false,
            );
        }
        let Some(runtime_mode) = input
            .get("runtimeMode")
            .and_then(Value::as_str)
            .filter(|m| {
                matches!(
                    *m,
                    "read-only" | "approval-required" | "auto-approve-safe" | "full-access"
                )
            })
        else {
            return watcher_refusal(
                "INVALID_INPUT",
                "Choose a supported Watcher permission mode.",
                false,
            );
        };
        let current = self.records.view().current.clone();
        let previous = self.records.view().last_runtime_mode.clone();
        if let Err(err) = self.records.update(|rec| {
            rec.last_runtime_mode = Some(runtime_mode.to_string());
            Ok(())
        }) {
            return watcher_refusal("HOST_DISCONNECTED", &err, true);
        }
        if let Some(cur) = current {
            let mut cmd = Map::new();
            cmd.insert("type".into(), json!("configure-thread"));
            cmd.insert("threadId".into(), json!(cur.target.thread_id));
            cmd.insert("runtimeMode".into(), json!(runtime_mode));
            if coordinator
                .run_command(local_desktop_client(), cmd)
                .await
                .is_err()
            {
                let _ = self.records.update(|rec| {
                    rec.last_runtime_mode = previous;
                    Ok(())
                });
                return watcher_refusal(
                    "PROVIDER_UNAVAILABLE",
                    "Watcher’s permissions could not be changed. Check its provider and try again.",
                    true,
                );
            }
        }
        let state = self.state(coordinator, router).await;
        json!({ "status": "ok", "state": state })
    }

    /// `WATCHER_WATCH_THREAD`: adds or renews a standing watch on a local or remote thread.
    pub async fn watch_thread(
        &mut self,
        input: &Value,
        by: &str,
        coordinator: &CoordinatorHandle,
        router: Option<&DesktopHostRouter>,
    ) -> Value {
        if self.closed {
            return watcher_refusal(
                "NOT_CURRENT_WATCHER",
                "Assign watched threads on Watcher’s desktop.",
                false,
            );
        }
        let Some(target) = input
            .get("target")
            .and_then(|t| serde_json::from_value::<WatcherThreadTarget>(t.clone()).ok())
        else {
            return watcher_refusal("INVALID_INPUT", "Choose a thread to watch.", false);
        };
        let snapshots = self.collect_host_snapshots(coordinator, router).await;
        let Some(snap) = snapshots.get(&target.host_id) else {
            return watcher_refusal(
                "HOST_DISCONNECTED",
                "That host is not connected. Reconnect it and try again.",
                true,
            );
        };
        let Some(thread) = find_thread_in_snapshot(Some(snap), &target.thread_id) else {
            return watcher_refusal(
                "UNKNOWN_TARGET",
                "That thread is not available on its host.",
                false,
            );
        };
        if thread
            .get("delegatedBy")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
        {
            return watcher_refusal(
                "INVALID_INPUT",
                "Watch the thread that delegated this one instead.",
                false,
            );
        }
        if matches!(
            thread.get("kind").and_then(Value::as_str),
            Some("watcher" | "watcher-history")
        ) {
            return watcher_refusal("INVALID_INPUT", "Watcher cannot watch itself.", false);
        }
        if by == "watcher" {
            if let Some(unwatched) = self
                .records
                .view()
                .user_unwatches
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .find(|u| u.target == target)
            {
                let cur_head = self
                    .records
                    .view()
                    .current
                    .as_ref()
                    .and_then(|c| find_thread_in_snapshot(snapshots.get(&self.host_id), &c.target.thread_id))
                    .and_then(native_head_of_thread);
                if cur_head.is_none() || cur_head == unwatched.watcher_head {
                    return watcher_refusal(
                        "REQUEST_NOT_ACTIVE",
                        "The user stopped watching this thread. Only the user can hand it back, with Watch or in a new message to Watcher. Nothing was watched.",
                        false,
                    );
                }
            }
        }

        let head = native_head_of_thread(thread);
        let paused = if thread.get("status").and_then(Value::as_str) == Some("running") {
            Some(Some(
                head.clone()
                    .unwrap_or_else(|| "unobserved-user-turn".into()),
            ))
        } else {
            Some(None)
        };
        let watch = WatcherStandingWatch {
            id: Uuid::new_v4().to_string(),
            target: target.clone(),
            created_at: now_iso(),
            generation: 0,
            paused_by_user_message_id: paused,
            last_user_message_id: Some(head),
            parked: None,
            remote_origin: None,
        };

        if let Err(err) = self.records.update(|rec| {
            let watches = rec.watches.get_or_insert_with(Vec::new);
            if let Some(existing) = watches.iter_mut().find(|w| w.target == target) {
                if by == "user" {
                    existing.parked = None;
                }
            } else {
                watches.push(watch);
            }
            if let Some(ref mut unwatches) = rec.user_unwatches {
                unwatches.retain(|u| u.target != target);
                if unwatches.is_empty() {
                    rec.user_unwatches = None;
                }
            }
            Ok(())
        }) {
            return watcher_refusal("HOST_DISCONNECTED", &err, true);
        }

        let state = self.build_room_state(&snapshots);
        json!({ "status": "ok", "state": state })
    }

    /// `WATCHER_UNWATCH_THREAD`: withdraws standing watch, fences active participations,
    /// cancels queued Watcher followups, and records `userUnwatches` when initiated by the user.
    pub async fn unwatch_thread(
        &mut self,
        input: &Value,
        by: &str,
        coordinator: &CoordinatorHandle,
        router: Option<&DesktopHostRouter>,
    ) -> Value {
        if self.closed {
            return watcher_refusal(
                "NOT_CURRENT_WATCHER",
                "Stop watching from Watcher’s desktop.",
                false,
            );
        }
        let Some(target) = input
            .get("target")
            .and_then(|t| serde_json::from_value::<WatcherThreadTarget>(t.clone()).ok())
        else {
            return watcher_refusal("INVALID_INPUT", "Choose a thread to stop watching.", false);
        };
        let snapshots = self.collect_host_snapshots(coordinator, router).await;
        let master_head = self
            .records
            .view()
            .current
            .as_ref()
            .and_then(|cur| {
                find_thread_in_snapshot(snapshots.get(&self.host_id), &cur.target.thread_id)
            })
            .and_then(native_head_of_thread);

        let mut cancelled_ops: HashSet<String> = HashSet::new();
        if let Err(err) = self.records.update(|rec| {
            if let Some(ref mut watches) = rec.watches {
                watches.retain(|w| w.target != target);
            }
            for req in &mut rec.requests {
                for part in &mut req.participants {
                    if part.target == target && part.state == "participating" {
                        part.automation_stopped = Some(true);
                    }
                }
            }
            for op in &mut rec.operations {
                if op.target == target && op.delivery_state == "queued" {
                    op.delivery_state = "failed".into();
                    op.refusal_code = Some("REQUEST_NOT_ACTIVE".into());
                    cancelled_ops.insert(op.id.clone());
                }
            }
            if by == "user" {
                let list = rec.user_unwatches.get_or_insert_with(Vec::new);
                list.retain(|u| u.target != target);
                list.push(WatcherUserUnwatch {
                    target: target.clone(),
                    watcher_head: master_head,
                    at: now_iso(),
                });
                if list.len() > WATCHER_USER_UNWATCHES_MAX {
                    let drain = list.len() - WATCHER_USER_UNWATCHES_MAX;
                    list.drain(0..drain);
                }
            }
            Ok(())
        }) {
            return watcher_refusal("HOST_DISCONNECTED", &err, true);
        }

        if !cancelled_ops.is_empty() {
            let watcher_ids = self.watcher_thread_ids();
            let _ = self.followups.cancel_watcher(&cancelled_ops, &watcher_ids);
        }

        let state = self.build_room_state(&snapshots);
        json!({ "status": "ok", "state": state })
    }

    /// `park_thread`: suppresses 20-minute idle pings on a watched thread.
    pub async fn park_thread(
        &mut self,
        watcher_thread_id: &str,
        target: &WatcherThreadTarget,
        parked: bool,
    ) -> Value {
        if self.records.view().current.as_ref().map(|c| c.target.thread_id.as_str())
            != Some(watcher_thread_id)
        {
            return watcher_refusal(
                "NOT_CURRENT_WATCHER",
                "Only the current Watcher can park a watched thread. Nothing was changed.",
                false,
            );
        }
        let rec = self.records.view();
        let has_watch = rec
            .watches
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .any(|w| w.target == *target);
        let has_part = rec.requests.iter().any(|r| {
            r.state == "active"
                && r.participants.iter().any(|p| {
                    p.target == *target
                        && p.state == "participating"
                        && p.automation_stopped != Some(true)
                })
        });
        if !has_watch && !has_part {
            return watcher_refusal(
                "REQUEST_NOT_ACTIVE",
                "This thread is not watched. Watch it before parking or unparking it.",
                false,
            );
        }
        if let Err(err) = self.records.update(|rec| {
            let mut found_watch = false;
            if let Some(ref mut watches) = rec.watches {
                if let Some(w) = watches.iter_mut().find(|w| w.target == *target) {
                    found_watch = true;
                    w.parked = if parked { Some(true) } else { None };
                }
            }
            for req in &mut rec.requests {
                if req.state != "active" {
                    continue;
                }
                for part in &mut req.participants {
                    if part.target == *target
                        && part.state == "participating"
                        && part.automation_stopped != Some(true)
                    {
                        part.parked = if !found_watch && parked {
                            Some(true)
                        } else {
                            None
                        };
                    }
                }
            }
            Ok(())
        }) {
            return watcher_refusal("HOST_DISCONNECTED", &err, true);
        }
        json!({ "status": "ok", "target": target, "parked": parked })
    }

    // -----------------------------------------------------------------------
    // Handover (`readHandover`, `continueWithHandover`, `dismissHandover`)
    // -----------------------------------------------------------------------

    fn current_offer(&self) -> Option<&HandoverOffer> {
        let offer = self.handover_offer.as_ref()?;
        let current = self.records.view().current.as_ref()?;
        if offer.to == current.target {
            Some(offer)
        } else {
            None
        }
    }

    pub async fn read_handover(&self, coordinator: &CoordinatorHandle) -> Value {
        let Some(offer) = self.current_offer().cloned() else {
            return watcher_refusal(
                "TARGET_CHANGED",
                "There is no handover to read: the new Watcher has had its first message, or the offer was put away. The last Watcher’s conversation is in Watcher history on the Threads page.",
                false,
            );
        };
        let Ok(Some(detail)) = coordinator.detail(offer.source.target.thread_id.clone()).await
        else {
            return watcher_refusal(
                "HISTORY_UNAVAILABLE",
                "Sotto could not read the last Watcher’s history, so there is no handover to show. Nothing was sent. Its conversation is still in Watcher history on the Threads page; put the offer away to start the new Watcher without it.",
                false,
            );
        };
        if detail.messages.is_empty() {
            return watcher_refusal(
                "HISTORY_UNAVAILABLE",
                "Sotto could not read the last Watcher’s history, so there is no handover to show. Nothing was sent. Its conversation is still in Watcher history on the Threads page; put the offer away to start the new Watcher without it.",
                false,
            );
        }
        let mut lines = vec![
            "[Handover from the previous Watcher conversation. Context only; not a new request.]"
                .to_string(),
            String::new(),
        ];
        for msg in &detail.messages {
            let speaker = if msg.role == "user" { "User" } else { "Watcher" };
            let text = msg.text.trim();
            if !text.is_empty() && text != WATCHER_SILENT_REPLY {
                lines.push(format!("{speaker}: {text}"));
            }
        }
        let kept = self.kept.read();
        let open_rules: Vec<&WatcherKeptItem> =
            kept.rules.iter().filter(|i| i.closed_at.is_none()).collect();
        if !open_rules.is_empty() {
            lines.push(String::new());
            lines.push("Standing rules the user gave, as kept:".into());
            for rule in open_rules {
                lines.push(format!("- {}: {}", rule.id, rule.text));
            }
        }
        let total = detail.messages.len() as u64;
        let answered = detail
            .messages
            .last()
            .is_some_and(|m| m.role == "assistant");
        let tool_records = detail.activities.len() as u64;
        json!({
            "status": "ok",
            "text": lines.join("\n").trim_end(),
            "counts": HandoverCounts {
                total,
                carried: total,
                too_long: 0,
                not_carried: 0,
                images: 0,
                files: 0,
                visuals: 0,
                tool_records,
                history_kept: self.history_enabled,
                answered,
            },
        })
    }

    pub async fn continue_with_handover(
        &mut self,
        input: &Value,
        coordinator: &CoordinatorHandle,
        router: Option<&DesktopHostRouter>,
    ) -> Value {
        let Some(draft_id) = input
            .get("draftId")
            .and_then(Value::as_str)
            .filter(|id| Uuid::parse_str(id).is_ok())
        else {
            return watcher_refusal(
                "INVALID_INPUT",
                "Write a message to send with the handover.",
                false,
            );
        };
        let current_target = self.records.view().current.as_ref().map(|c| c.target.clone());
        let Some(ref mut offer) = self.handover_offer else {
            return watcher_refusal(
                "TARGET_CHANGED",
                "The handover is no longer offered, so nothing was sent. Retry sends your message to the new Watcher without it.",
                false,
            );
        };
        if current_target.as_ref() != Some(&offer.to) {
            return watcher_refusal(
                "TARGET_CHANGED",
                "The handover is no longer offered, so nothing was sent. Retry sends your message to the new Watcher without it.",
                false,
            );
        }
        offer.accepted_draft_id = Some(draft_id.to_string());
        self.get(coordinator, router).await
    }

    pub async fn dismiss_handover(
        &mut self,
        coordinator: &CoordinatorHandle,
        router: Option<&DesktopHostRouter>,
    ) -> Value {
        if self.current_offer().is_some() {
            self.handover_offer = None;
        }
        self.get(coordinator, router).await
    }

    // -----------------------------------------------------------------------
    // Stop all (`prepareStopAll`, `stopAll`)
    // -----------------------------------------------------------------------

    fn stop_all_scope(&self) -> (Vec<WatcherThreadTarget>, String) {
        let rec = self.records.view();
        let mut ownership: Vec<(WatcherThreadTarget, String, WatcherThreadTarget)> = Vec::new();
        for req in &rec.requests {
            if req.state != "active" {
                continue;
            }
            for p in &req.participants {
                if p.started_by == "watcher" && p.state == "participating" {
                    ownership.push((p.target.clone(), req.id.clone(), req.watcher.clone()));
                }
            }
        }
        ownership.sort_by(|a, b| {
            a.0.json_key()
                .cmp(&b.0.json_key())
                .then_with(|| a.1.cmp(&b.1))
        });
        let mut targets = Vec::new();
        let mut seen = HashSet::new();
        let mut sig_rows = Vec::new();
        for (target, req_id, watcher) in &ownership {
            let tk = target.json_key();
            if seen.insert(tk.clone()) {
                targets.push(target.clone());
            }
            sig_rows.push(json!([tk, req_id, watcher.json_key()]));
        }
        let signature = sha256_hex(
            serde_json::to_string(&Value::Array(sig_rows))
                .unwrap_or_default()
                .as_bytes(),
        );
        (targets, signature)
    }

    fn prune_confirmations(&mut self, now_ms: i64) {
        self.confirmations.retain(|_, c| c.expires_ms >= now_ms);
    }

    pub fn prepare_stop_all(&mut self, phone_client_id: Option<String>) -> Value {
        if self.closed {
            return watcher_refusal(
                "NOT_CURRENT_WATCHER",
                "Watcher is stopping. Nothing was stopped. Reopen Sotto.",
                false,
            );
        }
        let now_ms = Utc::now().timestamp_millis();
        self.prune_confirmations(now_ms);
        let (targets, signature) = self.stop_all_scope();
        let id = Uuid::new_v4().to_string();
        let expires_ms = now_ms + WATCHER_STOP_ALL_TTL_MS;
        self.confirmations.insert(
            id.clone(),
            StopAllConfirmation {
                targets: targets.clone(),
                expires_ms,
                signature,
                phone_client_id: phone_client_id.clone(),
            },
        );
        // Enforce WATCHER_STOP_ALL_PREVIEW_LIMIT per client.
        let mut matching: Vec<(i64, String)> = self
            .confirmations
            .iter()
            .filter(|(_, c)| c.phone_client_id == phone_client_id)
            .map(|(cid, c)| (c.expires_ms, cid.clone()))
            .collect();
        matching.sort_by_key(|(exp, _)| *exp);
        if matching.len() > WATCHER_STOP_ALL_PREVIEW_LIMIT {
            for (_, oldest_id) in matching
                .into_iter()
                .take(self.confirmations.len() - WATCHER_STOP_ALL_PREVIEW_LIMIT)
            {
                self.confirmations.remove(&oldest_id);
            }
        }
        let expires_at = DateTime::<Utc>::from_timestamp_millis(expires_ms)
            .unwrap_or_else(|| Utc::now() + Duration::seconds(60))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        json!({
            "status": "ok",
            "confirmationId": id,
            "targets": targets,
            "expiresAt": expires_at,
        })
    }

    pub async fn stop_all(
        &mut self,
        confirmation_id: &str,
        phone_client_id: Option<String>,
        coordinator: &CoordinatorHandle,
        router: Option<&DesktopHostRouter>,
    ) -> Value {
        if self.closed {
            return watcher_refusal(
                "NOT_CURRENT_WATCHER",
                "Watcher is stopping. Nothing was stopped. Reopen Sotto.",
                false,
            );
        }
        let now_ms = Utc::now().timestamp_millis();
        self.prune_confirmations(now_ms);
        let Some(confirmation) = self.confirmations.get(confirmation_id).cloned() else {
            return watcher_refusal(
                "TARGET_CHANGED",
                "That Stop all preview expired, was replaced by a newer one, or is unavailable. Review Stop all again. Nothing was stopped.",
                false,
            );
        };
        if confirmation.phone_client_id != phone_client_id {
            return watcher_refusal(
                "TARGET_CHANGED",
                "That Stop all preview was opened somewhere else. Review Stop all again here. Nothing was stopped.",
                false,
            );
        }
        self.confirmations.remove(confirmation_id);
        let (_, live_sig) = self.stop_all_scope();
        if confirmation.expires_ms < now_ms || confirmation.signature != live_sig {
            return watcher_refusal(
                "TARGET_CHANGED",
                "The threads to stop changed or the confirmation expired. Review Stop all again.",
                false,
            );
        }

        let target_keys: HashSet<String> =
            confirmation.targets.iter().map(WatcherThreadTarget::key).collect();
        let mut affected_reqs: HashSet<String> = HashSet::new();
        let mut affected_ops: HashSet<String> = HashSet::new();

        for req in &self.records.view().requests {
            if req
                .participants
                .iter()
                .any(|p| target_keys.contains(&p.target.key()))
            {
                affected_reqs.insert(req.id.clone());
            }
        }
        for op in &self.records.view().operations {
            if affected_reqs.contains(&op.request_id) {
                affected_ops.insert(op.id.clone());
            }
        }

        let _ = self.records.update(|rec| {
            let stamp = now_iso();
            for req in &mut rec.requests {
                if affected_reqs.contains(&req.id) && req.state == "active" {
                    req.state = "stopped".into();
                    req.closed_at = Some(stamp.clone());
                }
            }
            for op in &mut rec.operations {
                if affected_ops.contains(&op.id) && op.delivery_state == "queued" {
                    op.delivery_state = "failed".into();
                    op.refusal_code = Some("REQUEST_NOT_ACTIVE".into());
                }
            }
            Ok(())
        });

        let watcher_ids = self.watcher_thread_ids();
        let _ = self.followups.cancel_watcher(&affected_ops, &watcher_ids);

        let mut results = Vec::new();
        for target in &confirmation.targets {
            if target.host_id == self.host_id {
                let mut cmd = Map::new();
                cmd.insert("type".into(), json!("interrupt"));
                cmd.insert("threadId".into(), json!(target.thread_id));
                match coordinator.run_command(local_desktop_client(), cmd).await {
                    Ok(_) => results.push(json!({
                        "target": target,
                        "status": "stopped",
                        "message": "Stopped.",
                    })),
                    Err(_) => results.push(json!({
                        "target": target,
                        "status": "uncertain",
                        "message": "The stop was not confirmed. Reconnect and check this thread.",
                    })),
                }
            } else if let Some(client) = router.and_then(|r| r.remote_client(&target.host_id)) {
                let res = client
                    .command(json!({
                        "type": "interrupt",
                        "threadId": target.thread_id,
                    }))
                    .await;
                match res {
                    Ok(_) => results.push(json!({
                        "target": target,
                        "status": "requested",
                        "message": "Stop requested.",
                    })),
                    Err(_) => results.push(json!({
                        "target": target,
                        "status": "uncertain",
                        "message": "The stop was not confirmed. Reconnect and check this thread.",
                    })),
                }
            } else {
                results.push(json!({
                    "target": target,
                    "status": "refused",
                    "message": "This thread changed or is unavailable. It was not stopped.",
                }));
            }
        }

        let state = self.state(coordinator, router).await;
        json!({ "status": "ok", "state": state, "results": results })
    }

    // -----------------------------------------------------------------------
    // `tryNow` & `readMachines`
    // -----------------------------------------------------------------------

    pub async fn try_now(
        &mut self,
        coordinator: &CoordinatorHandle,
        router: Option<&DesktopHostRouter>,
    ) -> Value {
        let _ = self.hold.try_now(Utc::now().timestamp_millis());
        let state = self.state(coordinator, router).await;
        json!({ "status": "ok", "state": state })
    }

    pub async fn read_machines(
        &self,
        coordinator: &CoordinatorHandle,
        router: Option<&DesktopHostRouter>,
    ) -> Value {
        let local_running = coordinator.running_threads_count().await.unwrap_or(0) as u64;
        let local_facts = Some(global_host_facts_sampler().read_facts()).filter(|v| v.is_object());
        let mut machines = vec![json!({
            "hostId": self.host_id,
            "name": "This computer",
            "thisComputer": true,
            "connected": true,
            "factsState": if local_facts.is_some() { "reported" } else { "unknown" },
            "facts": local_facts,
            "runningThreads": local_running,
        })];

        if let Some(r) = router {
            for rid in r.connected_remote_ids() {
                if let Some(client) = r.remote_client(&rid) {
                    let info = client.info();
                    let shell = client.cached_shell().await;
                    let running = shell
                        .get("host")
                        .and_then(|h| h.get("threads"))
                        .and_then(Value::as_array)
                        .map(|ts| {
                            ts.iter()
                                .filter(|t| t.get("status").and_then(Value::as_str) == Some("running"))
                                .count() as u64
                        })
                        .unwrap_or(0);
                    let facts = client
                        .host_facts()
                        .await
                        .ok()
                        .and_then(|v| v.get("facts").cloned())
                        .filter(|v| v.is_object());
                    let facts_state = if facts.is_some() { "reported" } else { "unknown" };
                    machines.push(json!({
                        "hostId": rid,
                        "name": info.name,
                        "thisComputer": false,
                        "connected": client.is_connected(),
                        "factsState": facts_state,
                        "facts": facts,
                        "runningThreads": running,
                    }));
                }
            }
        }

        json!({
            "status": "ok",
            "machines": machines,
            "observedAt": now_iso(),
        })
    }

    // -----------------------------------------------------------------------
    // `tellWatcher` & `readyToMerge` (`src/main/agents/watcher.ts:1512-1566`)
    // -----------------------------------------------------------------------

    pub fn thread_told(
        &mut self,
        target: WatcherThreadTarget,
        words: &str,
        user_message: Option<ToldUserMessage>,
    ) -> Value {
        let Some(current) = self.records.view().current.clone() else {
            return json!({ "status": "refused", "reason": "no-watcher" });
        };
        if self.closed || current.target == target {
            return json!({ "status": "refused", "reason": "no-watcher" });
        }
        let cleaned_words = cut_to_bytes(plain_words(words).trim(), TELL_WATCHER_WORDS_BYTES_MAX);
        if cleaned_words.is_empty() {
            return json!({ "status": "refused", "reason": "no-watcher" });
        }

        let created_request: Option<WatcherRequest> = user_message.as_ref().and_then(|um| {
            if !um.named {
                return None;
            }
            let root = told_request_root(&target.host_id, &target.thread_id, &um.id);
            let req_id = told_request_id(&root);
            if self.records.view().requests.iter().any(|r| r.id == req_id) {
                return None;
            }
            Some(WatcherRequest {
                id: req_id,
                watcher: current.target.clone(),
                root_user_message_id: root,
                standing_watch_id: None,
                display_prompt: None,
                handover: None,
                phone_origin: None,
                paired_permission_ceiling: None,
                remote_origin: None,
                state: "active".into(),
                created_at: now_iso(),
                closed_at: None,
                user_followups: None,
                participants: Vec::new(),
            })
        });

        let event_id = Uuid::new_v4().to_string();
        let request_id = created_request
            .as_ref()
            .map(|r| r.id.clone())
            .unwrap_or_else(|| WATCHER_UNWATCHED_REQUEST_ID.into());
        let event = WatcherEvent {
            id: event_id,
            kind: "thread-told".into(),
            request_id,
            target,
            generation: 0,
            observed_at: now_iso(),
            turn_id: None,
            request_card_id: None,
            request_card_kind: None,
            revision: None,
            operation_id: None,
            background_work_count: None,
            evidence_ids: None,
            delegated_thread_id: None,
            answered_by_user: None,
            ended_without_answer: None,
            swarm: None,
            restarted_by: None,
            restart_cause: None,
            move_id: None,
            moved_to: None,
            move_outcome: None,
            machine: None,
            told: Some(WatcherToldPayload {
                words: cleaned_words,
                user_words: user_message.as_ref().map(|u| u.words.clone()),
                user_words_cut: user_message.as_ref().and_then(|u| u.cut.then_some(true)),
                opened: created_request.is_some(),
            }),
            ready: None,
            answered: None,
        };

        // Persist told news BEFORE acknowledging to the thread.
        let _ = self.told_saved.add(event.clone());
        let request_opened = created_request.is_some();
        if let Some(req) = created_request {
            let _ = self.records.update(|rec| {
                rec.requests.push(req);
                Ok(())
            });
        }
        self.push_news(event);
        json!({ "status": "told", "requestOpened": request_opened })
    }

    pub fn thread_ready(&mut self, target: WatcherThreadTarget, ready: ReadyToMerge) -> Value {
        let Some(current) = self.records.view().current.clone() else {
            return json!({ "status": "refused", "reason": "no-watcher" });
        };
        if self.closed || current.target == target {
            return json!({ "status": "refused", "reason": "no-watcher" });
        }
        if !is_valid_commit_sha(&ready.head) || !is_valid_github_pr_url(&ready.pull_request) {
            return json!({ "status": "refused", "reason": "no-watcher" });
        }
        let observed_at = now_iso();
        let event = WatcherEvent {
            id: Uuid::new_v4().to_string(),
            kind: "thread-ready".into(),
            request_id: WATCHER_UNWATCHED_REQUEST_ID.into(),
            target: target.clone(),
            generation: 0,
            observed_at: observed_at.clone(),
            turn_id: None,
            request_card_id: None,
            request_card_kind: None,
            revision: None,
            operation_id: None,
            background_work_count: None,
            evidence_ids: None,
            delegated_thread_id: None,
            answered_by_user: None,
            ended_without_answer: None,
            swarm: None,
            restarted_by: None,
            restart_cause: None,
            move_id: None,
            moved_to: None,
            move_outcome: None,
            machine: None,
            told: None,
            ready: Some(ready.clone()),
            answered: None,
        };
        let _ = self.told_saved.add(event.clone());
        let pr_key = pull_request_key(&ready.pull_request);
        let _ = self.records.update(|rec| {
            let list = rec.ready_pull_requests.get_or_insert_with(Vec::new);
            if let Some(existing) = list
                .iter_mut()
                .find(|item| item.target == target && pull_request_key(&item.url) == pr_key)
            {
                let old_ms = parse_ms(&existing.at).unwrap_or(0);
                let new_ms = parse_ms(&observed_at).unwrap_or(0);
                if old_ms <= new_ms {
                    existing.url = ready.pull_request.clone();
                    existing.head = ready.head.clone();
                    existing.at = observed_at.clone();
                }
            } else {
                list.push(WatcherReadyPullRequest {
                    target: target.clone(),
                    url: ready.pull_request.clone(),
                    head: ready.head.clone(),
                    at: observed_at.clone(),
                });
            }
            if list.len() > WATCHER_READY_PRS_MAX {
                let drain = list.len() - WATCHER_READY_PRS_MAX;
                list.drain(0..drain);
            }
            Ok(())
        });
        self.push_news(event);
        json!({ "status": "told", "requestOpened": false })
    }

    // -----------------------------------------------------------------------
    // `keep_state` & `read_state`
    // -----------------------------------------------------------------------

    pub fn keep_state(&mut self, input: &WatcherKeepStateInput) -> Value {
        match self.kept.keep(input, &now_iso()) {
            Ok((state, changed)) => json!({
                "status": "ok",
                "changed": changed,
                "counts": kept_counts(&state),
            }),
            Err(refusal) => watcher_refusal(refusal.code, &refusal.message, false),
        }
    }

    pub async fn read_state(
        &mut self,
        open_only: bool,
        changed_since: Option<&str>,
        coordinator: &CoordinatorHandle,
        router: Option<&DesktopHostRouter>,
    ) -> Value {
        let room = self.state(coordinator, router).await;
        let state_val = room.get("state").cloned().unwrap_or_else(|| json!({}));
        let watching: Vec<Value> = state_val
            .get("watching")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .map(|row| {
                        let mut obj = row.as_object().cloned().unwrap_or_default();
                        obj.insert("pullRequests".into(), json!([]));
                        Value::Object(obj)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let waiting_on_user = state_val
            .get("waitingOnUser")
            .cloned()
            .unwrap_or_else(|| json!([]));
        let raw_kept = self.kept.read();
        let kept = if open_only {
            open_kept(&raw_kept)
        } else {
            raw_kept
        };
        let lists = json!({
            "watching": watching,
            "mergeQueue": [],
            "waitingOnUser": waiting_on_user,
            "kept": kept,
            "staleNotes": [],
        });
        let cursor = self.state_changes.remember(&lists);
        let context_tokens = room
            .get("context")
            .and_then(|c| c.get("tokens"))
            .cloned()
            .unwrap_or(Value::Null);

        if let Some(since_cursor) = changed_since {
            if let Some((delta_lists, unchanged, gone)) =
                self.state_changes.since(since_cursor, &lists)
            {
                let mut out = Map::new();
                out.insert("status".into(), json!("ok"));
                out.insert(
                    "watching".into(),
                    delta_lists.get("watching").cloned().unwrap_or_else(|| json!([])),
                );
                out.insert("nextCursor".into(), Value::Null);
                out.insert(
                    "mergeQueue".into(),
                    delta_lists
                        .get("mergeQueue")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                );
                out.insert(
                    "settleWithoutAsking".into(),
                    Value::Bool(self.settle_without_asking),
                );
                out.insert(
                    "waitingOnUser".into(),
                    delta_lists
                        .get("waitingOnUser")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                );
                out.insert(
                    "kept".into(),
                    delta_lists.get("kept").cloned().unwrap_or_else(|| json!({})),
                );
                out.insert(
                    "staleNotes".into(),
                    delta_lists
                        .get("staleNotes")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                );
                out.insert("contextTokens".into(), context_tokens);
                out.insert("compactAtTokens".into(), json!(self.compact_at));
                out.insert("changeCursor".into(), Value::String(cursor));
                out.insert("unchanged".into(), unchanged);
                if gone.as_object().is_some_and(|m| !m.is_empty()) {
                    out.insert("gone".into(), gone);
                }
                return Value::Object(out);
            }
            return json!({
                "status": "ok",
                "watching": lists["watching"],
                "nextCursor": Value::Null,
                "mergeQueue": [],
                "settleWithoutAsking": self.settle_without_asking,
                "waitingOnUser": lists["waitingOnUser"],
                "kept": lists["kept"],
                "staleNotes": [],
                "contextTokens": context_tokens,
                "compactAtTokens": self.compact_at,
                "changeCursor": cursor,
                "sinceUnknown": true,
            });
        }

        json!({
            "status": "ok",
            "watching": lists["watching"],
            "nextCursor": Value::Null,
            "mergeQueue": [],
            "settleWithoutAsking": self.settle_without_asking,
            "waitingOnUser": lists["waitingOnUser"],
            "kept": lists["kept"],
            "staleNotes": [],
            "contextTokens": context_tokens,
            "compactAtTokens": self.compact_at,
            "changeCursor": cursor,
        })
    }

    fn push_news(&mut self, event: WatcherEvent) {
        self.news_buffer.push(event);
        if self.news_buffer.len() > 400 {
            let drain = self.news_buffer.len() - 400;
            self.news_buffer.drain(0..drain);
        }
    }
}

// ---------------------------------------------------------------------------
// Read-only inspection helper (`--accelerator` mode)
// ---------------------------------------------------------------------------

pub fn read_watcher_readonly(directory: &Path) -> Value {
    let mut records = WatcherRecordStore::new(directory);
    let record_loaded = records.load().is_ok();
    let mut kept = WatcherStateStore::new(directory, true);
    kept.load();
    let mut questions = WatcherQuestionsStore::new(directory, true);
    questions.load();
    let mut told = WatcherToldNewsStore::new(directory, true);
    told.load();
    let mut limits = LimitRestartStore::new(directory);
    limits.load();
    let mut followups = FollowupStore::new(directory, true);
    let _ = followups.load(&HashSet::new());
    let rec = records.view();
    json!({
        "recordLoaded": record_loaded,
        "current": rec.current,
        "historyCount": rec.history.len(),
        "standingWatchesCount": rec.watches.as_ref().map(Vec::len).unwrap_or(0),
        "requestsCount": rec.requests.len(),
        "operationsCount": rec.operations.len(),
        "readyPullRequestsCount": rec.ready_pull_requests.as_ref().map(Vec::len).unwrap_or(0),
        "kept": kept.read(),
        "questionsCount": questions.all().len(),
        "toldCount": told.events().len(),
        "limitRestartsCount": limits.list().len(),
        "followupsCount": followups.items().len(),
    })
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

fn watcher_refusal(code: &str, message: &str, retryable: bool) -> Value {
    json!({
        "status": "refused",
        "code": code,
        "message": message,
        "retryable": retryable,
    })
}

fn local_desktop_client() -> ClientContext {
    ClientContext {
        client_id: "local-desktop".into(),
        user: "Local Desktop".into(),
        may_answer: true,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

fn find_thread_in_snapshot<'a>(snapshot: Option<&'a Value>, thread_id: &str) -> Option<&'a Value> {
    snapshot?
        .get("threads")?
        .as_array()?
        .iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
}

fn normalize_room_status(status: Option<&str>) -> &'static str {
    match status {
        Some("running") => "running",
        Some("error") => "error",
        _ => "idle",
    }
}

fn is_thread_provider_connected(snapshot: Option<&Value>, thread: &Value) -> bool {
    let Some(snap) = snapshot else {
        return false;
    };
    if snap.get("connected").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    let Some(pid) = thread.get("providerId").and_then(Value::as_str) else {
        return true;
    };
    snap.get("providers")
        .and_then(Value::as_array)
        .is_none_or(|providers| {
            providers.iter().any(|p| {
                p.get("id").and_then(Value::as_str) == Some(pid)
                    && p.get("connection").and_then(Value::as_str) == Some("connected")
            })
        })
}

fn is_thread_settled(snapshot: Option<&Value>, thread: &Value) -> bool {
    // Settled in Sotto's workspace, by itself or its project, as Node's Watcher reads it (`isWorkspaceThreadSettled`
    // in `src/main/agents/watcher.ts`). A provider's own `settledAt` is not the workspace's.
    let has_time = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .is_some_and(|time| DateTime::parse_from_rfc3339(time).is_ok())
    };
    if has_time(thread.get("workspaceSettledAt")) {
        return true;
    }
    let Some(project_id) = thread.get("projectId").and_then(Value::as_str) else {
        return false;
    };
    snapshot
        .and_then(|s| s.get("projects"))
        .and_then(Value::as_array)
        .and_then(|ps| {
            ps.iter()
                .find(|p| p.get("id").and_then(Value::as_str) == Some(project_id))
        })
        .is_some_and(|p| has_time(p.get("workspaceSettledAt")))
}

fn thread_background_work_count(thread: &Value) -> u64 {
    thread
        .get("activities")
        .and_then(Value::as_array)
        .map(|acts| {
            acts.iter()
                .filter(|a| {
                    matches!(
                        a.get("kind").and_then(Value::as_str),
                        Some("subagent" | "command")
                    ) && a.get("status").and_then(Value::as_str) == Some("running")
                })
                .count() as u64
        })
        .unwrap_or(0)
}

fn native_head_of_thread(thread: &Value) -> Option<String> {
    if let Some(msgs) = thread.get("messages").and_then(Value::as_array) {
        if let Some(last_user) = msgs
            .iter()
            .rev()
            .find(|m| m.get("role").and_then(Value::as_str) == Some("user"))
            .and_then(|m| m.get("id"))
            .and_then(Value::as_str)
        {
            return Some(last_user.to_string());
        }
    }
    thread
        .get("summary")
        .and_then(|s| s.get("lastUser"))
        .and_then(|u| u.get("id"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn watcher_record_validation_and_reservation_cap_roundtrip() {
        let dir = tempdir().unwrap();
        let mut store = WatcherRecordStore::new(dir.path());
        store.load().unwrap();

        let host_id = Uuid::new_v4().to_string();
        let watcher_target = WatcherThreadTarget::new(&host_id, "w-1");
        let req_id = Uuid::new_v4().to_string();

        // Insert 10 active starts with reservations; disk copy must cap to 8 with unresolved first.
        store
            .update(|rec| {
                rec.current = Some(WatcherIdentity {
                    target: watcher_target.clone(),
                    project_id: "proj-1".into(),
                    provider: "codex".into(),
                    creation_operation_id: Uuid::new_v4().to_string(),
                    created_at: now_iso(),
                });
                let mut participants = Vec::new();
                for i in 0..10u32 {
                    let target = WatcherThreadTarget::new(&host_id, format!("t-{i}"));
                    let op_id = Uuid::new_v4().to_string();
                    participants.push(WatcherParticipant {
                        request_id: req_id.clone(),
                        started_by: "watcher".into(),
                        generation: 1,
                        state: "participating".into(),
                        takeover: None,
                        automation_stopped: None,
                        target: target.clone(),
                        last_user_message_id: None,
                        parked: None,
                        prompt_count: 1,
                    });
                    rec.operations.push(WatcherOperation {
                        id: op_id.clone(),
                        request_id: req_id.clone(),
                        retry_key: Uuid::new_v4().to_string(),
                        digest: sha256_hex(format!("op-{i}").as_bytes()),
                        prompt_turn_id: None,
                        prompt_refunded: None,
                        standing_watch_id: None,
                        input_digest: None,
                        action: "start".into(),
                        target: target.clone(),
                        generation: 1,
                        delivery: Some("now".into()),
                        delivery_state: if i == 9 { "uncertain" } else { "accepted" }.into(),
                        created_at: now_iso(),
                        updated_at: now_iso(),
                        receipt_id: Uuid::new_v4().to_string(),
                        card_id: Uuid::new_v4().to_string(),
                        creation_receipt_id: None,
                        first_prompt_receipt_id: None,
                        command_id: None,
                        draft_id: None,
                        message_id: None,
                        item_id: None,
                        expected_turn_id: None,
                        expected_last_user_message_id: None,
                        anchor_message_id: None,
                        tool_call_id: None,
                        confirmed_stop: None,
                        creation_uncertain: None,
                        refusal_code: None,
                        outcome: None,
                        outcome_at: None,
                        turn_message_id: None,
                        native_turn_id: None,
                        reply_message_id: None,
                    });
                    rec.reservations.push(WatcherReservation {
                        target,
                        request_id: req_id.clone(),
                        operation_id: op_id,
                        generation: 1,
                        reason: "creation".into(),
                    });
                }
                rec.requests.push(WatcherRequest {
                    id: req_id.clone(),
                    watcher: watcher_target.clone(),
                    root_user_message_id: "u-root".into(),
                    standing_watch_id: None,
                    display_prompt: None,
                    handover: None,
                    phone_origin: None,
                    paired_permission_ceiling: None,
                    remote_origin: None,
                    state: "active".into(),
                    created_at: now_iso(),
                    closed_at: None,
                    user_followups: None,
                    participants,
                });
                Ok(())
            })
            .unwrap();

        // Disk file holds exactly 8 reservations, with the uncertain op (`t-9`) first!
        let on_disk: Value =
            serde_json::from_str(&fs::read_to_string(store.path()).unwrap()).unwrap();
        let disk_res = on_disk["watcher"]["reservations"].as_array().unwrap();
        assert_eq!(disk_res.len(), WATCHER_SAVED_RESERVATIONS_MAX);
        assert_eq!(disk_res[0]["target"]["threadId"], "t-9");

        // Reloading rebuilds all 10 reservations!
        let mut reloaded = WatcherRecordStore::new(dir.path());
        reloaded.load().unwrap();
        assert_eq!(reloaded.view().reservations.len(), 10);
    }

    #[test]
    fn watcher_state_store_migrates_legacy_and_enforces_rules_cap() {
        let dir = tempdir().unwrap();
        let legacy = json!({
            "decisions": ["Keep SQLite single-writer"],
            "rules": ["Never drop user rules"],
            "issues": [],
            "updatedAt": "2026-11-24T00:00:00.000Z"
        });
        fs::write(dir.path().join(WATCHER_STATE_FILE), legacy.to_string()).unwrap();

        let mut store = WatcherStateStore::new(dir.path(), true);
        store.load();
        assert!(store.readable());
        let shown = store.read();
        assert_eq!(shown.decisions.len(), 1);
        assert_eq!(shown.decisions[0].id, "d1");
        assert_eq!(shown.rules[0].id, "r2");

        // Edit decision, add issue, close rule.
        let (after, changes) = store
            .keep(
                &WatcherKeepStateInput {
                    edit: Some(vec![WatcherKeepEditItem {
                        id: "d1".into(),
                        text: "Keep SQLite WAL single-writer".into(),
                    }]),
                    add: Some(vec![WatcherKeepAddItem {
                        list: WatcherKeptList::Issues,
                        text: "Track #2850".into(),
                    }]),
                    close: Some(vec![WatcherKeepCloseItem {
                        id: "r2".into(),
                        note: Some("Done".into()),
                    }]),
                    ..Default::default()
                },
                "2026-11-24T01:00:00.000Z",
            )
            .unwrap();
        assert_eq!(after.issues[0].id, "i3");
        assert!(changes.iter().any(|c| c.id == "d1" && c.change == "edited"));
        assert!(changes.iter().any(|c| c.id == "i3" && c.change == "added"));
        assert!(changes.iter().any(|c| c.id == "r2" && c.change == "closed"));

        // Privacy off removes watcher-state.json.
        store.set_history_enabled(false).unwrap();
        assert!(!dir.path().join(WATCHER_STATE_FILE).exists());
    }

    #[test]
    fn watcher_room_broadcast_skips_timestamp_only_and_emits_list_patches() {
        let mut bcast = WatcherRoomBroadcast::new();
        let room1 = json!({
            "observedAt": "2026-11-24T00:00:00.000Z",
            "sequence": 1,
            "recoveryNotice": null,
            "watchedThreads": [
                { "target": { "hostId": "h1", "threadId": "t1" }, "title": "One", "status": "idle" },
                { "target": { "hostId": "h1", "threadId": "t2" }, "title": "Two", "status": "idle" }
            ]
        });
        let mut delivered = Vec::new();
        bcast.send(room1.clone(), |u| {
            delivered.push(u.clone());
            true
        });
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].base, None);
        assert_eq!(delivered[0].revision, 1);

        // Only observedAt & sequence changed -> nothing sent!
        let mut room_same = room1.clone();
        room_same["observedAt"] = json!("2026-11-24T00:00:05.000Z");
        room_same["sequence"] = json!(2);
        bcast.send(room_same, |u| {
            delivered.push(u.clone());
            true
        });
        assert_eq!(delivered.len(), 1);

        // Second watched thread changes status -> patch only entry 1's status!
        let mut room2 = room1.clone();
        room2["observedAt"] = json!("2026-11-24T00:00:10.000Z");
        room2["sequence"] = json!(3);
        room2["watchedThreads"][1]["status"] = json!("running");
        bcast.send(room2, |u| {
            delivered.push(u.clone());
            true
        });
        assert_eq!(delivered.len(), 2);
        assert_eq!(delivered[1].base, Some(1));
        assert_eq!(delivered[1].revision, 2);
        let lists = delivered[1].lists.as_ref().unwrap();
        let wt = &lists["watchedThreads"];
        assert_eq!(wt["length"], 2);
        assert_eq!(wt["at"].as_array().unwrap().len(), 0);
        let patches = wt["patch"].as_array().unwrap();
        assert_eq!(patches.len(), 1);
        assert_eq!(patches[0][0], 1);
        assert_eq!(patches[0][1]["set"]["status"], "running");

        // Reset sends whole room next time.
        bcast.reset();
        bcast.send(room1, |u| {
            delivered.push(u.clone());
            true
        });
        assert_eq!(delivered.len(), 3);
        assert_eq!(delivered[2].base, None);
    }

    #[test]
    fn followups_limit_restarts_and_told_news_roundtrip() {
        let dir = tempdir().unwrap();
        let mut limits = LimitRestartStore::new(dir.path());
        let now_ms = parse_ms("2026-11-24T01:00:00.000Z").unwrap();
        assert!(limits
            .record_stop(
                "t-1",
                "codex",
                Some("2026-11-24T02:00:00.000Z"),
                Some("turn-1"),
                now_ms
            )
            .unwrap());
        let sched = limits.scheduled("t-1").unwrap();
        assert_eq!(sched.at.as_deref(), Some("2026-11-24T02:00:00.000Z"));
        assert!(limits.due_restarts(now_ms + 60 * 60_000).is_empty());
        assert_eq!(
            limits
                .due_restarts(now_ms + 60 * 60_000 + LIMIT_RESTART_GRACE_MS)
                .len(),
            1
        );

        let mut followups = FollowupStore::new(dir.path(), true);
        let op_id = Uuid::new_v4().to_string();
        let draft_id = Uuid::new_v4().to_string();
        let prompt = crate::followup_queue::FollowupPrompt {
            thread_id: "t-1".into(),
            draft_id: draft_id.clone(),
            text: "Check build".into(),
            watcher_operation_id: Some(op_id.clone()),
            ..Default::default()
        };
        followups.enqueue_prompt(prompt, &HashSet::new()).unwrap();
        assert_eq!(followups.items().len(), 1);
        let cancel_set: HashSet<String> = [op_id].into_iter().collect();
        followups
            .cancel_watcher(&cancel_set, &HashSet::new())
            .unwrap();
        assert_eq!(followups.items().len(), 0);

        let host_id = Uuid::new_v4().to_string();
        let mut master = WatcherMaster::new(dir.path(), &host_id, true);
        master
            .records
            .update(|r| {
                r.current = Some(WatcherIdentity {
                    target: WatcherThreadTarget::new(&host_id, "w-main"),
                    project_id: "p1".into(),
                    provider: "codex".into(),
                    creation_operation_id: Uuid::new_v4().to_string(),
                    created_at: now_iso(),
                });
                Ok(())
            })
            .unwrap();
        let um = build_told_user_message("u-1", "Please tell Watcher to start Slice 7").unwrap();
        assert!(um.named);
        let ans = master.thread_told(
            WatcherThreadTarget::new(&host_id, "t-worker"),
            "User asked to start Slice 7.",
            Some(um.clone()),
        );
        assert_eq!(ans["status"], "told");
        assert_eq!(ans["requestOpened"], true);
        // Repeating with same user message does not open a second request.
        let ans2 = master.thread_told(
            WatcherThreadTarget::new(&host_id, "t-worker"),
            "Second ping.",
            Some(um),
        );
        assert_eq!(ans2["status"], "told");
        assert_eq!(ans2["requestOpened"], false);

        let pr_ans = master.thread_ready(
            WatcherThreadTarget::new(&host_id, "t-worker"),
            ReadyToMerge {
                pull_request: "https://github.com/millZach/Sotto/pull/2855".into(),
                head: "0123456789abcdef0123456789abcdef01234567".into(),
            },
        );
        assert_eq!(pr_ans["status"], "told");
        assert_eq!(pr_ans["requestOpened"], false);
        assert_eq!(
            master
                .records
                .view()
                .ready_pull_requests
                .as_deref()
                .unwrap()
                .len(),
            1
        );
    }

    // Node -> Rust -> Node for the Watcher stores the Node host writes too (ADR-0214). Each fixture is a store as Node
    // writes it, with the optional fields Node can write. Node's schemas for these are strict but `followups.json`'s,
    // so only that one carries a field this build does not know.

    const TRIP_HOST: &str = "0b6f1c2d-3e4b-4a5c-8d6e-7f8091a2b3c4";
    const TRIP_MASTER_HOST: &str = "1c7a2d3e-4f5b-4b6c-9d7e-8091a2b3c4d5";
    const TRIP_REQUEST: &str = "2d8b3e4f-5a6c-4c7d-8e8f-91a2b3c4d5e6";
    const TRIP_OPERATION: &str = "3e9c4f5a-6b7d-4d8e-9f9a-a2b3c4d5e6f7";
    const TRIP_TIME: &str = "2026-11-20T10:00:00.000Z";
    const TRIP_DIGEST: &str = "0000000000000000000000000000000000000000000000000000000000000abc";

    fn trip_target(thread_id: &str) -> Value {
        json!({ "hostId": TRIP_HOST, "threadId": thread_id })
    }

    fn trip_identity(thread_id: &str, operation: &str) -> Value {
        json!({ "target": trip_target(thread_id), "projectId": "project-1", "provider": "claude",
            "creationOperationId": operation, "createdAt": TRIP_TIME })
    }

    fn node_watcher_record() -> Value {
        let origin = json!({ "clientId": "client-1", "masterHostId": TRIP_MASTER_HOST,
            "masterCreationOperationId": "4fad5a6b-7c8e-4e9f-8a0b-b3c4d5e6f708", "masterCreatedAt": TRIP_TIME });
        json!({ "watcher": {
            "version": 1,
            "current": trip_identity("watcher-1", "5abe6b7c-8d9f-4f0a-9b1c-c4d5e6f70819"),
            "promptTurns": [{ "id": "6bcf7c8d-9e0a-4a1b-8c2d-d5e6f708192a", "watcher": trip_target("watcher-1"), "createdAt": TRIP_TIME,
                "rootUserMessageId": "m-1", "nativeTurnId": "turn-1", "previousNativeTurnId": "turn-0" }],
            "lastRuntimeMode": "full-access",
            "watches": [{ "id": "7cd08d9e-0f1b-4b2c-9d3e-e6f708192a3b", "target": trip_target("t-1"), "createdAt": TRIP_TIME, "generation": 2,
                "pausedByUserMessageId": null, "lastUserMessageId": "m-2", "parked": true, "remoteOrigin": origin }],
            "readyPullRequests": [{ "target": trip_target("t-1"), "url": "https://github.com/millZach/Sotto/pull/1",
                "head": "0123456789abcdef0123456789abcdef01234567", "at": TRIP_TIME }],
            "watchFences": [{ "id": "8de19eaf-1a2c-4c3d-8e4f-f708192a3b4c", "target": trip_target("t-2"), "remoteOrigin": origin }],
            "userUnwatches": [{ "target": trip_target("t-2"), "watcherHead": null, "at": TRIP_TIME }],
            "localTakeovers": [{ "target": trip_target("t-1"), "at": TRIP_TIME, "lastRequestId": TRIP_REQUEST,
                "userDrafts": [{ "draftId": "9ef2afb0-2b3d-4d4e-9f5a-08192a3b4c5d", "digest": TRIP_DIGEST, "messageId": "m-3" }] }],
            "remoteMasters": [{ "clientId": "client-1", "masterHostId": TRIP_MASTER_HOST,
                "creationOperationId": "4fad5a6b-7c8e-4e9f-8a0b-b3c4d5e6f708", "createdAt": TRIP_TIME }],
            "creation": null,
            "history": [trip_identity("watcher-0", "a0f3b0c1-3c4e-4e5f-8a6b-192a3b4c5d6e")],
            "requests": [{ "id": TRIP_REQUEST, "watcher": trip_target("watcher-1"), "rootUserMessageId": "m-1",
                "standingWatchId": "7cd08d9e-0f1b-4b2c-9d3e-e6f708192a3b",
                "displayPrompt": { "originalLength": 12, "wireDigest": TRIP_DIGEST },
                "pairedPermissionCeiling": "approval-required",
                "state": "active", "createdAt": TRIP_TIME, "closedAt": null,
                "userFollowups": [{ "draftId": "b104c1d2-4d5f-4f6a-9b7c-2a3b4c5d6e7f", "messageId": "m-4", "afterTakeover": true }],
                "participants": [{ "requestId": TRIP_REQUEST, "startedBy": "watcher", "generation": 2, "state": "participating",
                    "target": trip_target("t-1"), "lastUserMessageId": "m-2", "promptCount": 1 }] }],
            "operations": [{ "id": TRIP_OPERATION, "requestId": TRIP_REQUEST, "retryKey": "c215d2e3-5e6a-4a7b-8c8d-3b4c5d6e7f80",
                "digest": TRIP_DIGEST, "promptTurnId": "6bcf7c8d-9e0a-4a1b-8c2d-d5e6f708192a",
                "standingWatchId": "7cd08d9e-0f1b-4b2c-9d3e-e6f708192a3b", "inputDigest": TRIP_DIGEST,
                "action": "send", "target": trip_target("t-1"), "generation": 2, "deliveryState": "accepted",
                "createdAt": TRIP_TIME, "updatedAt": TRIP_TIME, "receiptId": "r-1", "cardId": "c-1", "messageId": "m-5",
                "outcome": "answered", "outcomeAt": TRIP_TIME, "turnMessageId": "m-6", "nativeTurnId": "turn-2", "replyMessageId": "m-7" }],
            "reservations": [{ "target": trip_target("t-1"), "requestId": TRIP_REQUEST, "operationId": TRIP_OPERATION,
                "generation": 2, "reason": "active-turn" }],
            "reads": [{ "target": trip_target("t-1"), "position": { "historyEpoch": "epoch-1", "afterPosition": 3 },
                "readAt": TRIP_TIME, "lastWakeEventId": "e-1" }],
            "remoteAbsences": [{ "operationId": "d326e3f4-6f7b-4b8c-9d9e-4c5d6e7f8091",
                "master": trip_identity("watcher-9", "e437f4a5-7a8c-4c9d-8eaf-5d6e7f8091a2"), "clientId": "client-1", "observedAt": TRIP_TIME }],
            "wakeEventIds": ["e-1"],
        } })
    }

    #[test]
    fn node_watcher_record_survives_a_rust_load_and_save() {
        crate::store_trip::round_trip(WATCHER_RECORD_FILE, node_watcher_record, |dir| {
            let mut store = WatcherRecordStore::new(dir);
            store.load().unwrap();
            let loaded = store.view().clone();
            // The store writes only a record that changed, so it starts from nothing and is handed back what it read.
            store.record = WatcherRecord::empty();
            store.update(|record| { *record = loaded; Ok(()) }).unwrap();
        });
    }

    #[test]
    fn node_watcher_state_survives_a_rust_load_and_save() {
        crate::store_trip::round_trip(WATCHER_STATE_FILE, || json!({
            "decisions": [{ "id": "d1", "text": "Ship the fix", "touchedAt": TRIP_TIME, "closedAt": TRIP_TIME, "closedNote": "Shipped" }],
            "rules": [{ "id": "r2", "text": "Ask before merging", "touchedAt": TRIP_TIME }],
            "issues": [{ "id": "i3", "text": "#2880 is open", "touchedAt": TRIP_TIME }],
            "updatedAt": TRIP_TIME, "nextId": 4,
        }), |dir| {
            let mut store = WatcherStateStore::new(dir, true);
            store.load();
            assert!(store.readable());
            store.set_history_enabled(true).unwrap();
        });
    }

    #[test]
    fn node_watcher_questions_survives_a_rust_load_and_save() {
        crate::store_trip::round_trip(WATCHER_QUESTIONS_FILE, || json!({ "version": 1, "questions": [
            { "id": "f548a5b6-8b9d-4dae-9fb0-6e7f8091a2b3", "watcherThreadId": "watcher-1", "question": "Settle t-1?",
                "options": [{ "label": SETTLE_IT, "description": "Stop watching it." }, { "label": KEEP_WATCHING }],
                "settle": trip_target("t-1"), "state": "answered", "choice": SETTLE_IT, "at": TRIP_TIME, "endedAt": TRIP_TIME,
                "spent": true, "askedUnder": TRIP_REQUEST },
            { "id": "0659b6c7-9cae-4ebf-8ac1-7f8091a2b3c4", "watcherThreadId": "watcher-1", "question": "Which one?",
                "options": [{ "label": "First" }, { "label": "Second" }], "state": "open", "at": TRIP_TIME },
        ] }), |dir| {
            let mut store = WatcherQuestionsStore::new(dir, true);
            store.load();
            assert_eq!(store.all().len(), 2);
            store.save();
        });
    }

    #[test]
    fn node_watcher_told_survives_a_rust_load_and_save() {
        let event = |id: &str, kind: &str| json!({ "id": id, "kind": kind, "requestId": TRIP_REQUEST, "target": trip_target("t-1"),
            "generation": 1, "observedAt": TRIP_TIME });
        let mut full = event("e-4", "thread-moved");
        full.as_object_mut().unwrap().extend(json!({ "turnId": "turn-1", "requestCardId": "card-1", "requestCardKind": "question",
            "revision": "rev-1", "operationId": TRIP_OPERATION, "backgroundWorkCount": 2, "evidenceIds": ["ev-1"],
            "delegatedThreadId": "t-3", "answeredByUser": true, "endedWithoutAnswer": true,
            "swarm": { "id": "1760c7d8-0dbf-4fc0-9bd2-8091a2b3c4d5", "count": 3, "done": 1, "failed": 0, "queued": 2 },
            "restartedBy": "limit", "restartCause": "work-left", "moveId": "2871d8e9-1ec0-4ad1-8ce3-91a2b3c4d5e6",
            "movedTo": trip_target("t-4"), "moveOutcome": "moved", "machine": "forge" }).as_object().unwrap().clone());
        let mut told = event("e-1", "thread-told");
        told["told"] = json!({ "words": "Done with the fix", "userWords": "Ship it", "userWordsCut": true, "opened": false });
        let mut ready = event("e-2", "thread-ready");
        ready["ready"] = json!({ "pullRequest": "https://github.com/millZach/Sotto/pull/2855", "head": "0123456789abcdef0123456789abcdef01234567" });
        let mut answered = event("e-3", "user-answered");
        answered["answered"] = json!({ "questionId": "f548a5b6-8b9d-4dae-9fb0-6e7f8091a2b3", "question": "Settle t-1?",
            "choice": SETTLE_IT, "settle": true, "opened": true });
        crate::store_trip::round_trip(WATCHER_TOLD_FILE, || json!({ "version": 1, "events": [told, ready, answered, full] }), |dir| {
            let mut store = WatcherToldNewsStore::new(dir, true);
            assert_eq!(store.load().len(), 4);
            store.save().unwrap();
        });
    }

    #[test]
    fn node_limit_restarts_survives_a_rust_load_and_save() {
        // Out of thread order on purpose: Node keeps its records in the order they came, and so must a save here.
        crate::store_trip::round_trip(LIMIT_RESTARTS_FILE, || json!({ "version": 1, "threads": [
            { "threadId": "t-b", "provider": "claude", "stoppedAt": TRIP_TIME, "at": "2026-11-20T15:00:00.000Z", "restarts": 1,
                "sent": true, "cause": "work-left", "turnId": "turn-1" },
            { "threadId": "t-a", "provider": "codex", "stoppedAt": TRIP_TIME, "restarts": 0 },
        ] }), |dir| {
            let mut store = LimitRestartStore::new(dir);
            store.load();
            assert_eq!(store.list().len(), 2);
            store.save().unwrap();
        });
    }

    #[test]
    fn node_followups_survives_a_rust_load_and_save() {
        crate::store_trip::round_trip(FOLLOWUPS_FILE, || json!({
            "items": [{ "id": "3982e9fa-2fd1-4be2-9df4-a2b3c4d5e6f7", "threadId": "t-1", "draftId": "4a93fa0b-3ae2-4cf3-8e05-b3c4d5e6f708",
                "text": "Sotto's wake-up", "attachments": [], "createdAt": TRIP_TIME, "updatedAt": TRIP_TIME, "status": "paused",
                "error": "Watcher stopped this thread.", "commandId": "command-1", "messageId": "m-1", "resumeAfterTurnId": "turn-1",
                "wakeUp": true, "pausedBy": "watcher", "watcherOperationId": TRIP_OPERATION,
                "news": [{ "source": "watcher", "watcher": trip_target("watcher-1"), "omitted": 0, "events": [{ "id": "e-1",
                    "kind": "turn-finished", "requestId": TRIP_REQUEST, "target": trip_target("t-1"), "generation": 1, "observedAt": TRIP_TIME }] }],
                "phoneOrigin": { "kind": "phone", "hostId": TRIP_HOST, "clientId": "phone-1" },
                "nodeOnlyField": "kept" }],
            "receipts": [{ "threadId": "t-1", "draftId": "4a93fa0b-3ae2-4cf3-8e05-b3c4d5e6f708", "digest": TRIP_DIGEST, "nodeOnlyField": "kept" }],
            "nodeOnlyField": "kept",
        }), |dir| {
            let mut store = FollowupStore::new(dir, true);
            store.load(&HashSet::new()).unwrap();
            assert_eq!(store.items().len(), 1);
            store.save(&HashSet::new()).unwrap();
        });
    }

    #[test]
    fn rust_created_watcher_state_reads_in_node() {
        let written = crate::store_trip::created(WATCHER_STATE_FILE, |dir| {
            let mut store = WatcherStateStore::new(dir, true);
            store.load();
            let input = WatcherKeepStateInput { add: Some(vec![WatcherKeepAddItem { list: WatcherKeptList::Rules, text: "Ask before merging".into() }]),
                ..Default::default() };
            store.keep(&input, &now_iso()).unwrap();
        });
        assert_eq!(written["rules"][0]["text"], "Ask before merging");
    }

    #[test]
    fn rust_created_watcher_questions_reads_in_node() {
        let written = crate::store_trip::created(WATCHER_QUESTIONS_FILE, |dir| {
            let mut store = WatcherQuestionsStore::new(dir, true);
            store.load();
            let options = vec![WatcherQuestionOption { label: "First".into(), description: Some("The first one.".into()) },
                WatcherQuestionOption { label: "Second".into(), description: None }];
            store.ask("watcher-1", WatcherAskInput { question: "Which one?".into(), options: Some(options), settle: None },
                Some(TRIP_REQUEST.into())).unwrap();
        });
        assert_eq!(written["questions"][0]["askedUnder"], TRIP_REQUEST);
    }

    #[test]
    fn rust_created_limit_restarts_reads_in_node() {
        let written = crate::store_trip::created(LIMIT_RESTARTS_FILE, |dir| {
            let mut store = LimitRestartStore::new(dir);
            store.load();
            let now = Utc::now();
            let resets = (now + Duration::minutes(30)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            assert!(store.record_stop("t-1", "claude", Some(&resets), Some("turn-1"), now.timestamp_millis()).unwrap());
        });
        assert_eq!(written["threads"][0]["turnId"], "turn-1");
    }

    #[test]
    fn rust_created_followups_reads_in_node() {
        let written = crate::store_trip::created(FOLLOWUPS_FILE, |dir| {
            let mut store = FollowupStore::new(dir, true);
            store.load(&HashSet::new()).unwrap();
            let prompt = crate::followup_queue::FollowupPrompt { thread_id: "t-1".into(), draft_id: "4a93fa0b-3ae2-4cf3-8e05-b3c4d5e6f708".into(),
                text: "Next, run the tests".into(), ..Default::default() };
            store.enqueue_prompt(prompt, &HashSet::new()).unwrap();
        });
        assert_eq!(written["items"][0]["status"], "queued");
    }

    #[test]
    fn an_unreadable_watcher_store_is_moved_aside_rather_than_overwritten() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(LIMIT_RESTARTS_FILE), "{ not json").unwrap();
        let mut store = LimitRestartStore::new(dir.path());
        store.load();
        assert!(!dir.path().join(LIMIT_RESTARTS_FILE).exists());
        let aside: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(aside.len(), 1);
        assert!(aside[0].starts_with("limit-restarts.json.corrupt-"));
    }
}
