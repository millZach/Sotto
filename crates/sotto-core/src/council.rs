//! The Council (ADR-0177) persistence, v1->v2 migration, stage machine, counts,
//! privacy word-stripping, view projection, and command coordinator.
//!
//! Shares `councils.json` (version 2) byte-compatibly with Sotto's TypeScript
//! `CouncilStore` / `CouncilService`, preserving sibling `ClimbRecord` entries
//! (`"phase"` key present) verbatim so neither runtime ever drops Climb history.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::workspace::{provider_label, write_atomic_json};

pub const COUNCIL_PANELISTS_MIN: usize = 2;
pub const COUNCIL_PANELISTS_MAX: usize = 5;
pub const COUNCIL_PANELISTS_DEFAULT: usize = 3;
pub const COUNCIL_LETTERS: [&str; 5] = ["A", "B", "C", "D", "E"];
pub const COUNCIL_CHAIR: &str = "chair";
pub const COUNCIL_STAGE_DEADLINE_MIN: u32 = 1;
pub const COUNCIL_STAGE_DEADLINE_MAX: u32 = 120;
pub const COUNCIL_STAGE_DEADLINE_DEFAULT: u32 = 10;
pub const COUNCIL_FAIRNESS_WAIT_MS: i64 = 2 * 60_000;
pub const COUNCIL_QUESTION_MAX: usize = 20_000;
pub const COUNCIL_VIEWS_MAX: usize = 50;
pub const COUNCIL_RECORDS_MAX: usize = 200;
pub const COUNCIL_FIELD_MAX: usize = 2_000;
pub const COUNCIL_VERDICT_MAX: usize = 390_000;
pub const COUNCIL_HISTORY_INLINE_MAX: usize = 40_000;
pub const COUNCIL_HISTORY_PART_MAX: usize = 194_000;
pub const COUNCIL_ASKED_WORDS_MAX: usize = 600;
pub const COUNCIL_MODEL_NAME_MAX: usize = 512;

const STAGE_ORDER: [CouncilTurnStage; 8] = [
    CouncilTurnStage::History,
    CouncilTurnStage::Framing,
    CouncilTurnStage::Answer,
    CouncilTurnStage::Review,
    CouncilTurnStage::Crux,
    CouncilTurnStage::Verdict,
    CouncilTurnStage::Fairness,
    CouncilTurnStage::Amend,
];

/// Client-only host-qualified entity key (`host:<hostId>:<id>`), matching
/// `src/shared/clientIdentity.ts#hostEntityKey`.
pub fn host_entity_key(host_id: Option<&str>, id: &str) -> String {
    match host_id {
        Some(hid) if !hid.is_empty() => format!("host:{hid}:{id}"),
        _ => id.to_string(),
    }
}

/// Parses a `host:<uuid>:<id>` key, matching `src/shared/clientIdentity.ts#parseHostEntityKey`.
pub fn parse_host_entity_key(key: &str) -> Option<(String, String)> {
    let rest = key.strip_prefix("host:")?;
    let colon = rest.find(':')?;
    let candidate = &rest[..colon];
    if Uuid::parse_str(candidate).is_err() {
        return None;
    }
    let id = &rest[colon + 1..];
    if id.is_empty() {
        return None;
    }
    Some((candidate.to_string(), id.to_string()))
}

pub fn is_council_remote_provider(provider: Option<&str>) -> bool {
    matches!(provider, Some("devin"))
}

fn format_iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse_iso_ms(text: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn clip(text: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn effort_words(effort: &str) -> &str {
    match effort {
        "none" => "no reasoning",
        "minimal" => "minimal reasoning",
        "low" => "low reasoning",
        "medium" => "medium reasoning",
        "high" => "high reasoning",
        "xhigh" | "max" => "extra-high reasoning",
        other => other,
    }
}

// ---------------------------------------------------------------------------
// Core Enums & Record Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilKind {
    Decision,
    Fact,
    Review,
    Ideas,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilStage {
    Framing,
    Answers,
    Reviews,
    Crux,
    Verdict,
    Fairness,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilTurnStage {
    History,
    Framing,
    Answer,
    Review,
    Crux,
    Verdict,
    Fairness,
    Amend,
}

impl CouncilTurnStage {
    pub fn round_stage(self) -> Option<CouncilStage> {
        match self {
            Self::History => None,
            Self::Framing => Some(CouncilStage::Framing),
            Self::Answer => Some(CouncilStage::Answers),
            Self::Review => Some(CouncilStage::Reviews),
            Self::Crux => Some(CouncilStage::Crux),
            Self::Verdict => Some(CouncilStage::Verdict),
            Self::Fairness | Self::Amend => Some(CouncilStage::Fairness),
        }
    }

    fn order_index(self) -> usize {
        STAGE_ORDER.iter().position(|s| *s == self).unwrap_or(0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilThreadState {
    Working,
    Waiting,
    Done,
    Failed,
    Stopped,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilRowAction {
    Retry,
    Replace,
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilDelivery {
    Queued,
    Dispatching,
    Accepted,
    Failed,
    Unconfirmed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilTurnOutcome {
    Working,
    Answered,
    Failed,
    Stopped,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilTurnResult {
    Pending,
    Valid,
    Invalid,
    Unavailable,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilRole {
    Panelist,
    Chair,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilMode {
    Standard,
    Climb,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CouncilStoppedBecause {
    #[serde(rename = "user")]
    User,
    #[serde(rename = "words-lost")]
    WordsLost,
    #[serde(rename = "snapshot")]
    Snapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilObjectionAnswer {
    Pending,
    Amended,
    Stands,
    Unanswered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilCitationCheck {
    Matches,
    Differs,
    Missing,
    Unchecked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilCitationOf {
    Command,
    Source,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilCitation {
    pub finding: String,
    pub path: String,
    pub lines: String,
    pub check: CouncilCitationCheck,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub of: Option<CouncilCitationOf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilLegacySnapshot {
    pub path: String,
    pub repository_root: String,
    pub commit: String,
    pub branch: String,
    pub untracked: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirty: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilEvidenceSourceKind {
    Git,
    Folder,
    Artifacts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum CouncilEvidence {
    #[serde(rename = "frozen", rename_all = "camelCase")]
    Frozen {
        id: String,
        source_kind: CouncilEvidenceSourceKind,
        manifest_hash: String,
        files: u64,
        bytes: u64,
        retained: bool,
        captured_at: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        removed_at: Option<String>,
    },
    #[serde(rename = "legacyGit", rename_all = "camelCase")]
    LegacyGit {
        id: String,
        snapshot: CouncilLegacySnapshot,
    },
    #[serde(rename = "legacyLive", rename_all = "camelCase")]
    LegacyLive { id: String },
}

impl CouncilEvidence {
    pub fn id(&self) -> &str {
        match self {
            Self::Frozen { id, .. } | Self::LegacyGit { id, .. } | Self::LegacyLive { id } => id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilRoundEvidence {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incumbent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
}

impl CouncilRoundEvidence {
    fn ids(&self) -> Vec<&str> {
        [
            self.source.as_deref(),
            self.baseline.as_deref(),
            self.candidate.as_deref(),
            self.incumbent.as_deref(),
            self.reference.as_deref(),
        ]
        .into_iter()
        .flatten()
        .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilAskedDeliveryState {
    Queued,
    Dispatching,
    Sent,
    Unconfirmed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilAskedDelivery {
    pub draft_id: String,
    pub message_id: String,
    pub state: CouncilAskedDeliveryState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilAskedBy {
    pub provider: String,
    pub user_message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<CouncilAskedDelivery>,
}

// ---------------------------------------------------------------------------
// Result Block Types (matching src/shared/councilBlocks.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilCriterionSource {
    Question,
    Assumed,
    User,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilCriterion {
    pub id: String,
    pub source: CouncilCriterionSource,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilAngle {
    pub seat: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilFramingResearch {
    pub needed: bool,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilFraming {
    pub kinds: Vec<CouncilKind>,
    pub criteria: Vec<CouncilCriterion>,
    pub headings: Vec<String>,
    pub words: u64,
    pub angles: Vec<CouncilAngle>,
    pub research: CouncilFramingResearch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilFindingKind {
    Observed,
    Inferred,
    Judgement,
    Source,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilAnswerFinding {
    pub id: String,
    pub kind: CouncilFindingKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    pub claim: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilAnswerChallenge {
    pub criterion: String,
    pub problem: String,
    pub why: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilAnswer {
    pub answer: String,
    pub findings: Vec<CouncilAnswerFinding>,
    pub challenges: Vec<CouncilAnswerChallenge>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilReviewVerdict {
    Confirmed,
    Rejected,
    Unchecked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilReviewFinding {
    pub id: String,
    pub verdict: CouncilReviewVerdict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilReviewAdded {
    pub id: String,
    pub claim: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilReviewScore {
    pub id: String,
    pub score: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilReview {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ranking: Option<Vec<String>>,
    pub findings: Vec<CouncilReviewFinding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports: Option<String>,
    pub added: Vec<CouncilReviewAdded>,
    pub scores: Vec<CouncilReviewScore>,
    pub favourites: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_answer: Option<String>,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilCruxMeaning {
    pub result: String,
    pub meaning: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilCrux {
    pub test: String,
    pub lookup: bool,
    pub sides: [Vec<String>; 2],
    pub meanings: Vec<CouncilCruxMeaning>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CouncilCruxOutcome {
    Number(u8),
    Text(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilCruxResult {
    pub result: String,
    pub outcome: CouncilCruxOutcome,
}

// ---------------------------------------------------------------------------
// Persisted Record Shapes (matching src/main/council/councilRecord.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilTurn {
    pub id: String,
    pub round: usize,
    pub seat: String,
    pub thread: String,
    pub stage: CouncilTurnStage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repair_of: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub establish: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objections: Option<Vec<String>>,
    pub draft_id: String,
    pub message_id: String,
    pub delivery: CouncilDelivery,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<CouncilTurnOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queued_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub briefs: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_message_id: Option<String>,
    pub result: CouncilTurnResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citations: Option<Vec<CouncilCitation>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilObjection {
    pub seat: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passage: Option<String>,
    pub answer: CouncilObjectionAnswer,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilRound {
    pub index: usize,
    pub asked_at: String,
    pub stage: CouncilStage,
    pub left_out: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_plan: Option<BTreeMap<String, Vec<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub framing_fallback: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<CouncilKind>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub research: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reframed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub criteria: Option<Vec<CouncilCriterion>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crux_runners: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crux_done: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fairness_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done_at: Option<String>,
    pub objections: Vec<CouncilObjection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub framing: Option<CouncilFraming>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crux: Option<CouncilCrux>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amended: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<CouncilRoundEvidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilSeat {
    pub seat: String,
    pub role: CouncilRole,
    pub model_id: String,
    pub model_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    pub effort: Option<String>,
    pub thread: String,
    pub former_threads: Vec<String>,
    pub started: bool,
    pub context: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilHistoryMeta {
    pub messages: u64,
    pub words: u64,
    pub tools: u64,
    pub parts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilRecord {
    pub id: String,
    pub mode: CouncilMode,
    pub created_at: String,
    pub origin_thread: String,
    pub origin_title: String,
    pub project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<CouncilLegacySnapshot>,
    pub history: CouncilHistoryMeta,
    pub seats: Vec<CouncilSeat>,
    pub rounds: Vec<CouncilRound>,
    pub turns: Vec<CouncilTurn>,
    pub deadline_minutes: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped_because: Option<CouncilStoppedBecause>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settled_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asked_by: Option<CouncilAskedBy>,
    pub evidence: Vec<CouncilEvidence>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyCouncilRecord {
    id: String,
    created_at: String,
    origin_thread: String,
    origin_title: String,
    project_id: String,
    #[serde(default)]
    snapshot: Option<CouncilLegacySnapshot>,
    history: CouncilHistoryMeta,
    seats: Vec<CouncilSeat>,
    rounds: Vec<CouncilRound>,
    turns: Vec<CouncilTurn>,
    deadline_minutes: u32,
    #[serde(default)]
    stopped_at: Option<String>,
    #[serde(default)]
    stopped_because: Option<CouncilStoppedBecause>,
    #[serde(default)]
    settled_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyCouncilFile {
    version: u32,
    councils: Vec<LegacyCouncilRecord>,
}

// ---------------------------------------------------------------------------
// IPC Wire Shapes (matching src/shared/council.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilSeatChoice {
    pub model_id: String,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum CouncilCommand {
    #[serde(rename = "start", rename_all = "camelCase")]
    Start {
        origin_thread: String,
        question: String,
        panelists: Vec<CouncilSeatChoice>,
        chair: CouncilSeatChoice,
    },
    #[serde(rename = "retry", rename_all = "camelCase")]
    Retry { council: String, turn: String },
    #[serde(rename = "skip", rename_all = "camelCase")]
    Skip { council: String, turn: String },
    #[serde(rename = "replace", rename_all = "camelCase")]
    Replace {
        council: String,
        turn: String,
        seat: CouncilSeatChoice,
    },
    #[serde(rename = "follow-up", rename_all = "camelCase")]
    FollowUp { council: String, question: String },
    #[serde(rename = "reframe", rename_all = "camelCase")]
    Reframe {
        council: String,
        #[serde(default)]
        kinds: Option<Vec<CouncilKind>>,
        #[serde(default)]
        research: Option<bool>,
        #[serde(default)]
        criteria: Option<Vec<String>>,
    },
    #[serde(rename = "stop", rename_all = "camelCase")]
    Stop { council: String },
    #[serde(rename = "settle", rename_all = "camelCase")]
    Settle { council: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CouncilCommandResult {
    Ok { ok: bool, council: String },
    Err { ok: bool, message: String },
}

impl CouncilCommandResult {
    pub fn ok(council: impl Into<String>) -> Self {
        Self::Ok {
            ok: true,
            council: council.into(),
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self::Err {
            ok: false,
            message: clip(&message.into(), 1_000),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CouncilEstimate {
    Ready {
        messages: u64,
        words: u64,
        tools: u64,
        characters: u64,
        parts: u32,
    },
    Unavailable {
        unavailable: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilRankingCount {
    pub letter: String,
    pub first: u64,
    pub of: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilFindingCount {
    pub finding: String,
    pub confirmed: u64,
    pub rejected: u64,
    pub unchecked: u64,
    pub of: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilSupportCount {
    pub letter: String,
    pub count: u64,
    pub of: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilFavouriteCount {
    pub finding: String,
    pub count: u64,
    pub of: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilCounts {
    pub answered: u64,
    pub partial: bool,
    pub rankings: Vec<CouncilRankingCount>,
    pub findings: Vec<CouncilFindingCount>,
    pub supports: Vec<CouncilSupportCount>,
    pub favourites: Vec<CouncilFavouriteCount>,
    pub changed: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilRowSource {
    pub finding: String,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilRowResult {
    Pending,
    Valid,
    Unavailable,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilRow {
    pub turn: String,
    pub seat: String,
    pub stage: CouncilTurnStage,
    pub state: CouncilThreadState,
    pub late: bool,
    pub repair: bool,
    pub result: CouncilRowResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citations: Option<Vec<CouncilCitation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<CouncilRowSource>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed: Option<bool>,
    pub thread: String,
    pub actions: Vec<CouncilRowAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilSeatView {
    pub seat: String,
    pub role: CouncilRole,
    pub model_id: String,
    pub model_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    pub effort: Option<String>,
    pub thread: String,
    pub remote: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilFramingResearchView {
    pub needed: bool,
    pub reason: String,
    pub by_user: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilFramingView {
    pub kinds: Vec<CouncilKind>,
    pub criteria: Vec<CouncilCriterion>,
    pub headings: Vec<String>,
    pub words: u64,
    pub angles: Vec<CouncilAngle>,
    pub research: CouncilFramingResearchView,
    pub fallback: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilObjectionViewAnswer {
    Pending,
    Amended,
    Stands,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilObjectionView {
    pub seat: String,
    pub claim: String,
    pub passage: String,
    pub answer: CouncilObjectionViewAnswer,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilCruxView {
    pub test: String,
    pub lookup: bool,
    pub sides: [Vec<String>; 2],
    pub meanings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilVerdictView {
    pub text: Option<String>,
    pub counts: CouncilCounts,
    pub fairness_done: bool,
    pub objections: Vec<CouncilObjectionView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilRoundView {
    pub index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<CouncilRoundEvidence>,
    pub question: Option<String>,
    pub asked_at: String,
    pub stage: CouncilStage,
    pub framing: Option<CouncilFramingView>,
    pub rows: Vec<CouncilRow>,
    pub left_out: Vec<String>,
    pub reframable: bool,
    pub crux: Option<CouncilCruxView>,
    pub verdict: Option<CouncilVerdictView>,
    pub draft: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilAskedByView {
    pub provider: String,
    pub words: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilOriginView {
    pub thread: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilSnapshotView {
    pub commit: String,
    pub branch: String,
    pub untracked: u64,
    pub dirty: bool,
    pub removed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilHistoryView {
    pub messages: u64,
    pub words: u64,
    pub parts: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CouncilViewStatus {
    Working,
    Waiting,
    Done,
    Stopped,
    Settled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum CouncilEvidenceView {
    #[serde(rename = "frozen", rename_all = "camelCase")]
    Frozen {
        id: String,
        source_kind: CouncilEvidenceSourceKind,
        manifest_hash: String,
        files: u64,
        bytes: u64,
        retained: bool,
        captured_at: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        removed_at: Option<String>,
        removed: bool,
    },
    #[serde(rename = "legacyGit", rename_all = "camelCase")]
    LegacyGit { id: String, removed: bool },
    #[serde(rename = "legacyLive", rename_all = "camelCase")]
    LegacyLive { id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CouncilView {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<CouncilMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Vec<CouncilEvidenceView>>,
    pub created_at: String,
    pub origin: CouncilOriginView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asked_by: Option<CouncilAskedByView>,
    pub status: CouncilViewStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped_because: Option<CouncilStoppedBecause>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<CouncilSnapshotView>,
    pub history: CouncilHistoryView,
    pub seats: Vec<CouncilSeatView>,
    pub rounds: Vec<CouncilRoundView>,
    pub deadline_minutes: u32,
}

// ---------------------------------------------------------------------------
// Store: councils.json v2, v1->v2 migration, .v1-backup, savedRecord
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct CouncilLoadedFile {
    pub records: Vec<CouncilRecord>,
    /// Sibling Climb records (`"phase"` key present), preserved verbatim so ordinary
    /// Council writes never drop Climb history.
    pub climb_records: Vec<Value>,
}

/// Validates a v2 ordinary `CouncilRecord` against the same invariants enforced by
/// `councilRecordSchema.superRefine` in `src/main/council/councilRecord.ts`.
pub fn validate_council_record(record: &CouncilRecord) -> Result<(), String> {
    if record.seats.len() < 3 || record.seats.len() > 6 {
        return Err("Council record has invalid seat count.".into());
    }
    if record.rounds.is_empty() || record.rounds.len() > 50 {
        return Err("Council record has invalid round count.".into());
    }
    if record.turns.len() > 2_000 {
        return Err("Council record has too many turns.".into());
    }
    let mut ids = HashSet::new();
    for item in &record.evidence {
        if !ids.insert(item.id()) {
            return Err("Evidence identities must be unique.".into());
        }
    }
    for round in &record.rounds {
        let Some(ev) = round.evidence.as_ref() else {
            return Err("Every round must name its recorded evidence.".into());
        };
        let round_ids = ev.ids();
        if round_ids.is_empty() || round_ids.iter().any(|id| !ids.contains(*id)) {
            return Err("Every round must name its recorded evidence.".into());
        }
    }
    Ok(())
}

/// Strips words from a record when Keep local history is off, matching
/// `savedRecord()` in `src/main/council/councilRecord.ts`.
pub fn saved_record(record: &CouncilRecord, keep_words: bool) -> CouncilRecord {
    let mut out = record.clone();
    if keep_words {
        return out;
    }
    for round in &mut out.rounds {
        round.question = None;
        round.framing = None;
        round.crux = None;
        round.verdict = None;
        round.criteria = None;
        for objection in &mut round.objections {
            objection.claim = None;
            objection.passage = None;
            objection.reason = None;
        }
    }
    for turn in &mut out.turns {
        turn.block = None;
        turn.summary = None;
        turn.reason = None;
    }
    if let Some(asked) = out.asked_by.as_mut() {
        asked.words = None;
    }
    out
}

fn migrate_v1_record(legacy: LegacyCouncilRecord) -> CouncilRecord {
    let source = format!("{}:legacy", legacy.id);
    let evidence = match legacy.snapshot.clone() {
        Some(snapshot) => vec![CouncilEvidence::LegacyGit {
            id: source.clone(),
            snapshot,
        }],
        None => vec![CouncilEvidence::LegacyLive { id: source.clone() }],
    };
    let rounds = legacy
        .rounds
        .into_iter()
        .map(|mut round| {
            round.evidence = Some(CouncilRoundEvidence {
                source: Some(source.clone()),
                ..CouncilRoundEvidence::default()
            });
            round
        })
        .collect();
    CouncilRecord {
        id: legacy.id,
        mode: CouncilMode::Standard,
        created_at: legacy.created_at,
        origin_thread: legacy.origin_thread,
        origin_title: legacy.origin_title,
        project_id: legacy.project_id,
        snapshot: legacy.snapshot,
        history: legacy.history,
        seats: legacy.seats,
        rounds,
        turns: legacy.turns,
        deadline_minutes: legacy.deadline_minutes,
        stopped_at: legacy.stopped_at,
        stopped_because: legacy.stopped_because,
        settled_at: legacy.settled_at,
        asked_by: None,
        evidence,
    }
}

#[derive(Debug, Clone)]
pub struct CouncilStore {
    file: PathBuf,
    backup_may_exist: bool,
}

impl CouncilStore {
    pub fn new(data_directory: &Path) -> Self {
        Self {
            file: data_directory.join("councils.json"),
            backup_may_exist: true,
        }
    }

    pub fn file_path(&self) -> &Path {
        &self.file
    }

    pub fn backup_path(&self) -> PathBuf {
        PathBuf::from(format!("{}.v1-backup", self.file.display()))
    }

    /// Reads `councils.json`, migrating v1 to v2 with an exclusive `.v1-backup`
    /// and refusing unknown versions or conflicting backups without mutating disk.
    pub fn read(&mut self) -> Result<CouncilLoadedFile, String> {
        let bytes = match fs::read_to_string(&self.file) {
            Ok(text) => text,
            Err(err) if err.kind() == ErrorKind::NotFound => {
                return Ok(CouncilLoadedFile::default());
            }
            Err(err) => return Err(format!("Could not read councils.json: {err}")),
        };
        let raw: Value = serde_json::from_str(&bytes)
            .map_err(|err| format!("Council history is not valid JSON: {err}"))?;
        let obj = raw
            .as_object()
            .ok_or_else(|| "Council history has no file version.".to_string())?;
        let version = obj
            .get("version")
            .ok_or_else(|| "Council history has no file version.".to_string())?;
        let version_num = version
            .as_u64()
            .ok_or_else(|| "This Council history needs a newer Sotto. Its file was kept unchanged.".to_string())?;

        if version_num == 2 {
            // Strict key check: only `version` and `councils` allowed at top level.
            if obj.keys().any(|k| k != "version" && k != "councils") {
                return Err("Council history has unexpected fields.".into());
            }
            let list = obj
                .get("councils")
                .and_then(Value::as_array)
                .ok_or_else(|| "Council history has no councils array.".to_string())?;
            let mut records = Vec::new();
            let mut climb_records = Vec::new();
            for entry in list {
                let is_climb = entry
                    .as_object()
                    .map(|m| m.contains_key("phase"))
                    .unwrap_or(false);
                if is_climb {
                    climb_records.push(entry.clone());
                } else {
                    let rec: CouncilRecord = serde_json::from_value(entry.clone())
                        .map_err(|err| format!("Invalid Council record: {err}"))?;
                    validate_council_record(&rec)?;
                    records.push(rec);
                }
            }
            if records.len() > COUNCIL_RECORDS_MAX {
                return Err("Too many ordinary Councils.".into());
            }
            return Ok(CouncilLoadedFile {
                records,
                climb_records,
            });
        }

        if version_num != 1 {
            return Err(
                "This Council history needs a newer Sotto. Its file was kept unchanged.".into(),
            );
        }

        let legacy: LegacyCouncilFile = serde_json::from_value(raw)
            .map_err(|err| format!("Invalid v1 Council history: {err}"))?;
        if legacy.councils.len() > COUNCIL_RECORDS_MAX {
            return Err("Too many ordinary Councils.".into());
        }
        let migrated_records: Vec<CouncilRecord> = legacy
            .councils
            .into_iter()
            .map(migrate_v1_record)
            .collect();
        for rec in &migrated_records {
            validate_council_record(rec)?;
        }

        // Write `councils.json.v1-backup` exclusively; if it already exists, accept only identical bytes.
        let backup = self.backup_path();
        match OpenOptions::new().write(true).create_new(true).open(&backup) {
            Ok(mut handle) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = handle.set_permissions(fs::Permissions::from_mode(0o600));
                }
                handle
                    .write_all(bytes.as_bytes())
                    .map_err(|err| format!("Could not write Council migration backup: {err}"))?;
                let _ = handle.sync_all();
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => {
                let existing = fs::read_to_string(&backup)
                    .map_err(|e| format!("Could not read existing Council migration backup: {e}"))?;
                if existing != bytes {
                    return Err(
                        "A different Council migration backup already exists. Council history was kept unchanged."
                            .into(),
                    );
                }
            }
            Err(err) => {
                return Err(format!("Could not create Council migration backup: {err}"));
            }
        }

        self.write(&migrated_records, &[], true)?;
        Ok(CouncilLoadedFile {
            records: migrated_records,
            climb_records: Vec::new(),
        })
    }

    /// Writes `councils.json` atomically (`0600` on Unix) and deletes `.v1-backup`
    /// once a history-off write succeeds.
    pub fn write(
        &mut self,
        records: &[CouncilRecord],
        climb_records: &[Value],
        keep_history: bool,
    ) -> Result<(), String> {
        let mut combined: Vec<Value> = Vec::with_capacity(records.len() + climb_records.len());
        for record in records {
            let kept = saved_record(record, keep_history);
            combined.push(
                serde_json::to_value(kept)
                    .map_err(|err| format!("Could not serialize Council record: {err}"))?,
            );
        }
        for climb in climb_records {
            combined.push(climb.clone());
        }
        let payload = json!({
            "version": 2,
            "councils": combined,
        });
        write_atomic_json(&self.file, &payload)
            .map_err(|err| format!("Could not write councils.json: {err}"))?;

        if !keep_history && self.backup_may_exist {
            let backup = self.backup_path();
            match fs::remove_file(&backup) {
                Ok(()) => {}
                Err(err) if err.kind() == ErrorKind::NotFound => {}
                Err(err) => {
                    return Err(format!("Could not remove Council migration backup: {err}"));
                }
            }
            self.backup_may_exist = false;
        }
        Ok(())
    }
}

/// Non-mutating summary of `councils.json` for `--accelerator` mode (`ops.councilsReadOnly`).
pub fn read_councils_readonly(data_directory: &Path) -> Value {
    let file = data_directory.join("councils.json");
    let backup = PathBuf::from(format!("{}.v1-backup", file.display()));
    let has_backup = backup.exists();
    let bytes = match fs::read_to_string(&file) {
        Ok(text) => text,
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return json!({
                "version": 2,
                "councilCount": 0,
                "climbCount": 0,
                "hasV1Backup": has_backup,
                "storageError": Value::Null,
            });
        }
        Err(err) => {
            return json!({
                "version": Value::Null,
                "councilCount": 0,
                "climbCount": 0,
                "hasV1Backup": has_backup,
                "storageError": format!("Could not read councils.json: {err}"),
            });
        }
    };
    let parsed: Result<Value, _> = serde_json::from_str(&bytes);
    let Ok(val) = parsed else {
        return json!({
            "version": Value::Null,
            "councilCount": 0,
            "climbCount": 0,
            "hasV1Backup": has_backup,
            "storageError": "Council history is not valid JSON.",
        });
    };
    let Some(obj) = val.as_object() else {
        return json!({
            "version": Value::Null,
            "councilCount": 0,
            "climbCount": 0,
            "hasV1Backup": has_backup,
            "storageError": "Council history has no file version.",
        });
    };
    let version = obj.get("version").and_then(Value::as_u64);
    let list = obj.get("councils").and_then(Value::as_array);
    match (version, list) {
        (Some(v @ (1 | 2)), Some(arr)) => {
            let mut councils = 0usize;
            let mut climbs = 0usize;
            for item in arr {
                if item
                    .as_object()
                    .map(|m| m.contains_key("phase"))
                    .unwrap_or(false)
                {
                    climbs += 1;
                } else {
                    councils += 1;
                }
            }
            json!({
                "version": v,
                "councilCount": councils,
                "climbCount": climbs,
                "hasV1Backup": has_backup,
                "storageError": Value::Null,
            })
        }
        (Some(other), _) => json!({
            "version": other,
            "councilCount": 0,
            "climbCount": 0,
            "hasV1Backup": has_backup,
            "storageError": "This Council history needs a newer Sotto. Its file was kept unchanged.",
        }),
        _ => json!({
            "version": Value::Null,
            "councilCount": 0,
            "climbCount": 0,
            "hasV1Backup": has_backup,
            "storageError": "Council history has no file version.",
        }),
    }
}

// ---------------------------------------------------------------------------
// Review Assignments & Counts (matching src/shared/councilFlow.ts)
// ---------------------------------------------------------------------------

/// Who reads whose answer in a Council's review, and in what order (ADR-0177 decision 4).
pub fn review_assignments(
    answers: &[String],
    readers: &[String],
) -> BTreeMap<String, Vec<String>> {
    let mut sorted: Vec<String> = answers.to_vec();
    sorted.sort();
    let each = if sorted.len() >= 4 {
        2
    } else {
        sorted.len().saturating_sub(1)
    };
    let mut plan = BTreeMap::new();
    for reader in readers {
        let around: Vec<String> = match sorted.iter().position(|s| s == reader) {
            Some(at) => sorted[at + 1..]
                .iter()
                .chain(sorted[..at].iter())
                .cloned()
                .collect(),
            None => sorted.clone(),
        };
        plan.insert(reader.clone(), around.into_iter().take(each).collect());
    }
    plan
}

pub struct CountedReview<'a> {
    pub reader: &'a str,
    pub assigned: &'a [String],
    pub block: Option<&'a CouncilReview>,
}

/// Sotto's own counts beside the verdict (ADR-0177 decision 5).
pub fn council_counts(
    answers: &BTreeMap<String, Option<CouncilAnswer>>,
    reviews: &[CountedReview<'_>],
) -> CouncilCounts {
    let answered = answers.len() as u64;
    if answered <= 2 {
        return CouncilCounts {
            answered,
            partial: false,
            rankings: Vec::new(),
            findings: Vec::new(),
            supports: Vec::new(),
            favourites: Vec::new(),
            changed: Vec::new(),
        };
    }
    let valid: Vec<(&CountedReview<'_>, &CouncilReview)> = reviews
        .iter()
        .filter_map(|r| r.block.map(|b| (r, b)))
        .collect();
    let partial =
        reviews.iter().any(|r| r.block.is_none()) || answers.values().any(|a| a.is_none());

    let readers_of = |letter: &str| -> Vec<&CouncilReview> {
        valid
            .iter()
            .filter(|(r, _)| r.assigned.iter().any(|a| a == letter))
            .map(|(_, b)| *b)
            .collect()
    };

    let letters: Vec<&String> = answers.keys().collect();
    let mut rankings = Vec::new();
    for letter in &letters {
        let ranked: Vec<&CouncilReview> = readers_of(letter)
            .into_iter()
            .filter(|b| {
                b.ranking
                    .as_ref()
                    .map(|r| r.iter().any(|item| item == *letter))
                    .unwrap_or(false)
            })
            .collect();
        if !ranked.is_empty() {
            let first = ranked
                .iter()
                .filter(|b| {
                    b.ranking
                        .as_ref()
                        .and_then(|r| r.first())
                        .map(|s| s == *letter)
                        .unwrap_or(false)
                })
                .count() as u64;
            rankings.push(CouncilRankingCount {
                letter: (*letter).clone(),
                first,
                of: ranked.len() as u64,
            });
        }
    }

    let mut findings = Vec::new();
    let mut favourites = Vec::new();
    for letter in &letters {
        let answer = answers.get(*letter).and_then(|a| a.as_ref());
        let readers = readers_of(letter);
        if let Some(ans) = answer {
            for finding in &ans.findings {
                let mut confirmed = 0u64;
                let mut rejected = 0u64;
                let mut unchecked = 0u64;
                let mut total_verdicts = 0u64;
                for rev in &readers {
                    for item in &rev.findings {
                        if item.id == finding.id {
                            total_verdicts += 1;
                            match item.verdict {
                                CouncilReviewVerdict::Confirmed => confirmed += 1,
                                CouncilReviewVerdict::Rejected => rejected += 1,
                                CouncilReviewVerdict::Unchecked => unchecked += 1,
                            }
                        }
                    }
                }
                if total_verdicts > 0 {
                    findings.push(CouncilFindingCount {
                        finding: finding.id.clone(),
                        confirmed,
                        rejected,
                        unchecked,
                        of: readers.len() as u64,
                    });
                }
                let liked = readers
                    .iter()
                    .filter(|rev| rev.favourites.iter().any(|f| f == &finding.id))
                    .count() as u64;
                if liked > 0 {
                    favourites.push(CouncilFavouriteCount {
                        finding: finding.id.clone(),
                        count: liked,
                        of: readers.len() as u64,
                    });
                }
            }
        }
    }

    let said: Vec<&str> = valid
        .iter()
        .filter_map(|(_, b)| b.supports.as_deref())
        .collect();
    let unique_said: BTreeSet<&str> = said.iter().copied().collect();
    let supports = unique_said
        .into_iter()
        .map(|letter| CouncilSupportCount {
            letter: letter.to_string(),
            count: said.iter().filter(|item| **item == letter).count() as u64,
            of: said.len() as u64,
        })
        .collect();

    let mut changed: Vec<String> = valid
        .iter()
        .filter(|(_, b)| b.answer.as_deref() == Some("changed"))
        .map(|(r, _)| r.reader.to_string())
        .collect();
    changed.sort();

    CouncilCounts {
        answered,
        partial,
        rankings,
        findings,
        supports,
        favourites,
        changed,
    }
}

// ---------------------------------------------------------------------------
// Pure Stage Machine (matching src/main/council/councilStages.ts)
// ---------------------------------------------------------------------------

pub struct StageClock<F: FnMut() -> String> {
    pub now_ms: i64,
    pub new_id: F,
}

impl StageClock<fn() -> String> {
    pub fn system(now_ms: i64) -> Self {
        fn gen() -> String {
            Uuid::new_v4().to_string()
        }
        Self {
            now_ms,
            new_id: gen,
        }
    }
}

pub fn is_panelist(seat: &CouncilSeat) -> bool {
    seat.role == CouncilRole::Panelist
}

pub fn current_round(record: &CouncilRecord) -> &CouncilRound {
    record
        .rounds
        .last()
        .expect("CouncilRecord always has at least one round")
}

pub fn current_round_mut(record: &mut CouncilRecord) -> &mut CouncilRound {
    record
        .rounds
        .last_mut()
        .expect("CouncilRecord always has at least one round")
}

pub fn active_panelists<'a>(record: &'a CouncilRecord, round: &CouncilRound) -> Vec<&'a CouncilSeat> {
    record
        .seats
        .iter()
        .filter(|s| is_panelist(s) && !round.left_out.iter().any(|lo| lo == &s.seat))
        .collect()
}

pub fn current_turn<'a>(
    record: &'a CouncilRecord,
    round_index: usize,
    stage: CouncilTurnStage,
    seat: &str,
) -> Option<&'a CouncilTurn> {
    record.turns.iter().rev().find(|t| {
        t.round == round_index
            && t.stage == stage
            && t.seat == seat
            && t.repair_of.is_none()
            && t.superseded != Some(true)
    })
}

pub fn repair_for<'a>(record: &'a CouncilRecord, turn_id: &str) -> Option<&'a CouncilTurn> {
    record
        .turns
        .iter()
        .rev()
        .find(|t| t.repair_of.as_deref() == Some(turn_id) && t.superseded != Some(true))
}

pub fn is_final(turn: &CouncilTurn) -> bool {
    matches!(
        turn.delivery,
        CouncilDelivery::Failed | CouncilDelivery::Unconfirmed
    ) || matches!(
        turn.outcome,
        Some(
            CouncilTurnOutcome::Answered
                | CouncilTurnOutcome::Failed
                | CouncilTurnOutcome::Stopped
                | CouncilTurnOutcome::Unknown
        )
    )
}

pub fn is_complete(turn: &CouncilTurn) -> bool {
    turn.outcome == Some(CouncilTurnOutcome::Answered)
        && matches!(
            turn.result,
            CouncilTurnResult::Valid | CouncilTurnResult::Unavailable | CouncilTurnResult::None
        )
}

pub fn answered_letters(record: &CouncilRecord, round_index: usize) -> Vec<String> {
    record
        .seats
        .iter()
        .filter(|s| is_panelist(s))
        .filter_map(|seat| {
            let turn = current_turn(record, round_index, CouncilTurnStage::Answer, &seat.seat)?;
            if is_complete(turn) {
                Some(seat.seat.clone())
            } else {
                None
            }
        })
        .collect()
}

pub fn crux_runners(record: &CouncilRecord, round: &CouncilRound, crux: &CouncilCrux) -> Vec<String> {
    let sitting: Vec<String> = active_panelists(record, round)
        .into_iter()
        .map(|s| s.seat.clone())
        .collect();
    let sides_set: HashSet<&str> = crux
        .sides
        .iter()
        .flat_map(|side| side.iter().map(String::as_str))
        .collect();
    if let Some(neutral) = sitting.iter().find(|s| !sides_set.contains(s.as_str())) {
        return vec![neutral.clone()];
    }
    let mut out = Vec::new();
    for side in &crux.sides {
        if let Some(first) = side.iter().find(|letter| sitting.contains(*letter)) {
            out.push(first.clone());
        }
    }
    out
}

#[derive(Default)]
struct QueueExtra {
    repair_of: Option<String>,
    establish: Option<u8>,
    part: Option<u32>,
    objections: Option<Vec<String>>,
}

fn queue_turn<F: FnMut() -> String>(
    record: &mut CouncilRecord,
    round_index: usize,
    seat: &str,
    stage: CouncilTurnStage,
    clock: &mut StageClock<F>,
    extra: QueueExtra,
) -> String {
    let thread = record
        .seats
        .iter()
        .find(|s| s.seat == seat)
        .map(|s| s.thread.clone())
        .unwrap_or_default();
    let queued_at = format_iso(clock.now_ms);
    if stage != CouncilTurnStage::History
        && record.history.parts > 1
        && !record.turns.iter().any(|t| {
            t.thread == thread && t.stage == CouncilTurnStage::History && t.superseded != Some(true)
        })
    {
        for part in 1..=record.history.parts {
            record.turns.push(CouncilTurn {
                id: (clock.new_id)(),
                round: round_index,
                seat: seat.to_string(),
                thread: thread.clone(),
                stage: CouncilTurnStage::History,
                repair_of: None,
                establish: None,
                part: Some(part),
                objections: None,
                draft_id: (clock.new_id)(),
                message_id: (clock.new_id)(),
                delivery: CouncilDelivery::Queued,
                outcome: None,
                queued_at: Some(queued_at.clone()),
                sent_at: None,
                briefs: None,
                reply_message_id: None,
                result: CouncilTurnResult::Pending,
                superseded: None,
                block: None,
                summary: None,
                reason: None,
                citations: None,
            });
        }
    }
    let id = (clock.new_id)();
    record.turns.push(CouncilTurn {
        id: id.clone(),
        round: round_index,
        seat: seat.to_string(),
        thread,
        stage,
        repair_of: extra.repair_of,
        establish: extra.establish,
        part: extra.part,
        objections: extra.objections,
        draft_id: (clock.new_id)(),
        message_id: (clock.new_id)(),
        delivery: CouncilDelivery::Queued,
        outcome: None,
        queued_at: Some(queued_at),
        sent_at: None,
        briefs: None,
        reply_message_id: None,
        result: CouncilTurnResult::Pending,
        superseded: None,
        block: None,
        summary: None,
        reason: None,
        citations: None,
    });
    id
}

fn step_round<F: FnMut() -> String>(
    record: &mut CouncilRecord,
    round_pos: usize,
    clock: &mut StageClock<F>,
) -> bool {
    let at = format_iso(clock.now_ms);
    let round_index = record.rounds[round_pos].index;
    let stage = record.rounds[round_pos].stage;

    match stage {
        CouncilStage::Framing => {
            if record.rounds[round_pos].framing_fallback == Some(true) {
                record.rounds[round_pos].stage = CouncilStage::Answers;
                return true;
            }
            let Some(turn) =
                current_turn(record, round_index, CouncilTurnStage::Framing, COUNCIL_CHAIR)
                    .cloned()
            else {
                queue_turn(
                    record,
                    round_index,
                    COUNCIL_CHAIR,
                    CouncilTurnStage::Framing,
                    clock,
                    QueueExtra::default(),
                );
                return true;
            };
            if is_complete(&turn)
                || (is_final(&turn) && turn.outcome != Some(CouncilTurnOutcome::Answered))
            {
                if turn.result == CouncilTurnResult::Valid {
                    if let Some(block) = turn.block.as_ref() {
                        if let Ok(framing) = serde_json::from_value::<CouncilFraming>(block.clone())
                        {
                            record.rounds[round_pos].framing = Some(framing);
                        } else {
                            record.rounds[round_pos].framing_fallback = Some(true);
                        }
                    } else {
                        record.rounds[round_pos].framing_fallback = Some(true);
                    }
                } else {
                    record.rounds[round_pos].framing_fallback = Some(true);
                }
                record.rounds[round_pos].stage = CouncilStage::Answers;
                return true;
            }
            false
        }
        CouncilStage::Answers => {
            let sitting: Vec<String> = active_panelists(record, &record.rounds[round_pos])
                .into_iter()
                .map(|s| s.seat.clone())
                .collect();
            let missing: Vec<String> = sitting
                .iter()
                .filter(|seat| {
                    current_turn(record, round_index, CouncilTurnStage::Answer, seat).is_none()
                })
                .cloned()
                .collect();
            for seat in &missing {
                queue_turn(
                    record,
                    round_index,
                    seat,
                    CouncilTurnStage::Answer,
                    clock,
                    QueueExtra::default(),
                );
            }
            if !missing.is_empty() {
                return true;
            }
            let all_done = sitting.iter().all(|seat| {
                current_turn(record, round_index, CouncilTurnStage::Answer, seat)
                    .map(is_complete)
                    .unwrap_or(false)
            });
            if !all_done {
                return false;
            }
            let letters = answered_letters(record, round_index);
            if letters.is_empty() {
                record.rounds[round_pos].stage = CouncilStage::Done;
                record.rounds[round_pos].done_at = Some(at);
                return true;
            }
            if letters.len() == 1 {
                record.rounds[round_pos].stage = CouncilStage::Verdict;
                return true;
            }
            let left_out = &record.rounds[round_pos].left_out;
            let readers: Vec<String> = letters
                .iter()
                .filter(|l| !left_out.contains(*l))
                .cloned()
                .collect();
            record.rounds[round_pos].review_plan = Some(review_assignments(&letters, &readers));
            record.rounds[round_pos].stage = CouncilStage::Reviews;
            true
        }
        CouncilStage::Reviews => {
            let left_out = record.rounds[round_pos].left_out.clone();
            let readers: Vec<String> = record.rounds[round_pos]
                .review_plan
                .as_ref()
                .map(|m| {
                    m.keys()
                        .filter(|l| !left_out.contains(*l))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            let missing: Vec<String> = readers
                .iter()
                .filter(|r| {
                    current_turn(record, round_index, CouncilTurnStage::Review, r).is_none()
                })
                .cloned()
                .collect();
            for reader in &missing {
                queue_turn(
                    record,
                    round_index,
                    reader,
                    CouncilTurnStage::Review,
                    clock,
                    QueueExtra::default(),
                );
            }
            if !missing.is_empty() {
                return true;
            }
            let all_done = readers.iter().all(|r| {
                current_turn(record, round_index, CouncilTurnStage::Review, r)
                    .map(is_complete)
                    .unwrap_or(false)
            });
            if !all_done {
                return false;
            }
            record.rounds[round_pos].stage = CouncilStage::Verdict;
            true
        }
        CouncilStage::Verdict => {
            let Some(turn) =
                current_turn(record, round_index, CouncilTurnStage::Verdict, COUNCIL_CHAIR)
                    .cloned()
            else {
                queue_turn(
                    record,
                    round_index,
                    COUNCIL_CHAIR,
                    CouncilTurnStage::Verdict,
                    clock,
                    QueueExtra::default(),
                );
                return true;
            };
            if !is_complete(&turn) {
                return false;
            }
            if turn.result == CouncilTurnResult::Valid
                && turn.block.is_some()
                && record.rounds[round_pos].crux_done != Some(true)
            {
                if let Ok(crux) =
                    serde_json::from_value::<CouncilCrux>(turn.block.clone().unwrap())
                {
                    let runners = crux_runners(record, &record.rounds[round_pos], &crux);
                    record.rounds[round_pos].crux = Some(crux);
                    record.rounds[round_pos].crux_runners = Some(runners);
                    if let Some(t) = record.turns.iter_mut().find(|t| t.id == turn.id) {
                        t.superseded = Some(true);
                    }
                    record.rounds[round_pos].stage = CouncilStage::Crux;
                    return true;
                }
            }
            if turn.result == CouncilTurnResult::Unavailable {
                record.rounds[round_pos].crux_done = Some(true);
                if let Some(t) = record.turns.iter_mut().find(|t| t.id == turn.id) {
                    t.superseded = Some(true);
                }
                return true;
            }
            record.rounds[round_pos].stage = CouncilStage::Fairness;
            true
        }
        CouncilStage::Crux => {
            let all_runners = record.rounds[round_pos]
                .crux_runners
                .clone()
                .unwrap_or_default();
            let left_out = record.rounds[round_pos].left_out.clone();
            let runners: Vec<String> = all_runners
                .iter()
                .filter(|r| !left_out.contains(*r))
                .cloned()
                .collect();
            let missing: Vec<String> = runners
                .iter()
                .filter(|r| current_turn(record, round_index, CouncilTurnStage::Crux, r).is_none())
                .cloned()
                .collect();
            let two = all_runners.len() == 2;
            for runner in &missing {
                let establish = if two {
                    let pos = all_runners.iter().position(|r| r == runner).unwrap_or(0);
                    Some(if pos == 0 { 1 } else { 0 })
                } else {
                    None
                };
                queue_turn(
                    record,
                    round_index,
                    runner,
                    CouncilTurnStage::Crux,
                    clock,
                    QueueExtra {
                        establish,
                        ..QueueExtra::default()
                    },
                );
            }
            if !missing.is_empty() {
                return true;
            }
            let all_done = runners.iter().all(|r| {
                current_turn(record, round_index, CouncilTurnStage::Crux, r)
                    .map(is_complete)
                    .unwrap_or(false)
            });
            if !all_done {
                return false;
            }
            record.rounds[round_pos].crux_done = Some(true);
            record.rounds[round_pos].stage = CouncilStage::Verdict;
            true
        }
        CouncilStage::Fairness => {
            let letters = answered_letters(record, round_index);
            let sitting: Vec<String> = active_panelists(record, &record.rounds[round_pos])
                .into_iter()
                .filter(|s| letters.contains(&s.seat))
                .map(|s| s.seat.clone())
                .collect();
            let missing: Vec<String> = sitting
                .iter()
                .filter(|s| {
                    current_turn(record, round_index, CouncilTurnStage::Fairness, s).is_none()
                })
                .cloned()
                .collect();
            for seat in &missing {
                queue_turn(
                    record,
                    round_index,
                    seat,
                    CouncilTurnStage::Fairness,
                    clock,
                    QueueExtra::default(),
                );
            }
            let waiting_indices: Vec<usize> = record.rounds[round_pos]
                .objections
                .iter()
                .enumerate()
                .filter(|(_, o)| o.answer == CouncilObjectionAnswer::Pending && o.turn.is_none())
                .map(|(i, _)| i)
                .collect();
            let amend_active =
                current_turn(record, round_index, CouncilTurnStage::Amend, COUNCIL_CHAIR)
                    .map(|t| !is_final(t))
                    .unwrap_or(false);
            if !waiting_indices.is_empty() && !amend_active {
                let seats: Vec<String> = waiting_indices
                    .iter()
                    .map(|&i| record.rounds[round_pos].objections[i].seat.clone())
                    .collect();
                let turn_id = queue_turn(
                    record,
                    round_index,
                    COUNCIL_CHAIR,
                    CouncilTurnStage::Amend,
                    clock,
                    QueueExtra {
                        objections: Some(seats),
                        ..QueueExtra::default()
                    },
                );
                for i in waiting_indices {
                    record.rounds[round_pos].objections[i].turn = Some(turn_id.clone());
                }
                return true;
            }
            if !missing.is_empty() {
                return true;
            }
            let all_fairness_done = sitting.iter().all(|seat| {
                current_turn(record, round_index, CouncilTurnStage::Fairness, seat)
                    .map(is_complete)
                    .unwrap_or(false)
            });
            let all_amends_done = record
                .turns
                .iter()
                .filter(|t| {
                    t.round == round_index
                        && t.stage == CouncilTurnStage::Amend
                        && t.repair_of.is_none()
                        && t.superseded != Some(true)
                })
                .all(is_complete);
            if all_fairness_done && all_amends_done && waiting_indices.is_empty() {
                record.rounds[round_pos].stage = CouncilStage::Done;
                record.rounds[round_pos].done_at = Some(at);
                return true;
            }
            false
        }
        CouncilStage::Done => false,
    }
}

/// Moves the current round on as far as its prompts allow, including queueing
/// one repair per invalid block and marking failed repairs unavailable.
pub fn advance_round<F: FnMut() -> String>(
    record: &mut CouncilRecord,
    clock: &mut StageClock<F>,
) -> bool {
    if record.stopped_at.is_some() || record.settled_at.is_some() {
        return false;
    }
    let round_pos = record.rounds.len() - 1;
    let round_index = record.rounds[round_pos].index;
    let mut changed = false;

    let repair_candidates: Vec<(String, String, CouncilTurnStage, Option<Vec<String>>)> = record
        .turns
        .iter()
        .filter(|t| {
            t.round == round_index
                && t.superseded != Some(true)
                && t.repair_of.is_none()
                && t.outcome == Some(CouncilTurnOutcome::Answered)
                && t.result == CouncilTurnResult::Invalid
        })
        .map(|t| (t.id.clone(), t.seat.clone(), t.stage, t.objections.clone()))
        .collect();

    for (turn_id, seat, stage, objections) in repair_candidates {
        match repair_for(record, &turn_id).cloned() {
            None => {
                queue_turn(
                    record,
                    round_index,
                    &seat,
                    stage,
                    clock,
                    QueueExtra {
                        repair_of: Some(turn_id),
                        objections,
                        ..QueueExtra::default()
                    },
                );
                changed = true;
            }
            Some(repair) => {
                if is_final(&repair)
                    && repair.result != CouncilTurnResult::Valid
                    && !(repair.outcome == Some(CouncilTurnOutcome::Answered)
                        && repair.result == CouncilTurnResult::Pending)
                {
                    if let Some(target) = record.turns.iter_mut().find(|t| t.id == turn_id) {
                        target.result = CouncilTurnResult::Unavailable;
                        changed = true;
                    }
                }
            }
        }
    }

    for _ in 0..12 {
        if !step_round(record, round_pos, clock) {
            break;
        }
        changed = true;
    }
    changed
}

pub fn turn_state(turn: &CouncilTurn, waiting_on_user: bool) -> CouncilThreadState {
    if turn.delivery == CouncilDelivery::Failed {
        return CouncilThreadState::Failed;
    }
    if turn.delivery == CouncilDelivery::Unconfirmed {
        return CouncilThreadState::Unknown;
    }
    match turn.outcome {
        Some(CouncilTurnOutcome::Answered) => CouncilThreadState::Done,
        Some(CouncilTurnOutcome::Failed) => CouncilThreadState::Failed,
        Some(CouncilTurnOutcome::Stopped) => CouncilThreadState::Stopped,
        Some(CouncilTurnOutcome::Unknown) => CouncilThreadState::Unknown,
        _ => {
            if waiting_on_user {
                CouncilThreadState::Waiting
            } else {
                CouncilThreadState::Working
            }
        }
    }
}

fn deadline_from(turn: &CouncilTurn) -> Option<&str> {
    turn.sent_at.as_deref().or(turn.queued_at.as_deref())
}

fn waits_on_parts(record: &CouncilRecord, turn: &CouncilTurn) -> bool {
    turn.stage != CouncilTurnStage::History
        && record.turns.iter().any(|item| {
            item.thread == turn.thread
                && item.stage == CouncilTurnStage::History
                && item.superseded != Some(true)
                && !is_complete(item)
        })
}

pub fn is_late(
    turn: &CouncilTurn,
    now_ms: i64,
    deadline_ms: i64,
    record: Option<&CouncilRecord>,
) -> bool {
    let Some(since) = deadline_from(turn).and_then(parse_iso_ms) else {
        return false;
    };
    if is_final(turn) || now_ms <= since + deadline_ms {
        return false;
    }
    if let Some(rec) = record {
        if turn.delivery == CouncilDelivery::Queued && waits_on_parts(rec, turn) {
            return false;
        }
    }
    true
}

pub fn row_actions(
    record: &CouncilRecord,
    turn: &CouncilTurn,
    now_ms: i64,
    waiting_on_user: bool,
) -> Vec<CouncilRowAction> {
    let round = current_round(record);
    if record.stopped_at.is_some()
        || record.settled_at.is_some()
        || turn.superseded == Some(true)
        || turn.repair_of.is_some()
        || turn.round != round.index
        || round.stage == CouncilStage::Done
        || (turn.stage != CouncilTurnStage::History
            && turn.stage.round_stage() != Some(round.stage))
    {
        return Vec::new();
    }
    let stuck = matches!(
        turn.delivery,
        CouncilDelivery::Failed | CouncilDelivery::Unconfirmed
    ) || matches!(
        turn.outcome,
        Some(
            CouncilTurnOutcome::Failed
                | CouncilTurnOutcome::Stopped
                | CouncilTurnOutcome::Unknown
        )
    ) || is_late(
        turn,
        now_ms,
        i64::from(record.deadline_minutes) * 60_000,
        Some(record),
    );
    if !stuck {
        return Vec::new();
    }
    let mut actions = Vec::new();
    if !waiting_on_user {
        actions.push(CouncilRowAction::Retry);
    }
    actions.push(CouncilRowAction::Replace);
    if turn.seat != COUNCIL_CHAIR
        || matches!(
            turn.stage,
            CouncilTurnStage::Framing | CouncilTurnStage::Amend
        )
    {
        actions.push(CouncilRowAction::Skip);
    }
    actions
}

pub fn retry_turn<F: FnMut() -> String>(
    record: &mut CouncilRecord,
    turn_id: &str,
    clock: &mut StageClock<F>,
) {
    let Some(turn) = record.turns.iter().find(|t| t.id == turn_id).cloned() else {
        return;
    };
    for t in &mut record.turns {
        if t.id == turn_id || t.repair_of.as_deref() == Some(turn_id) {
            t.superseded = Some(true);
        }
    }
    if turn.stage == CouncilTurnStage::Amend {
        if let Some(round) = record.rounds.iter_mut().find(|r| r.index == turn.round) {
            for objection in &mut round.objections {
                if objection.turn.as_deref() == Some(turn_id) {
                    objection.turn = None;
                }
            }
        }
        return;
    }
    queue_turn(
        record,
        turn.round,
        &turn.seat,
        turn.stage,
        clock,
        QueueExtra {
            establish: turn.establish,
            part: turn.part,
            ..QueueExtra::default()
        },
    );
}

pub fn leave_out(record: &mut CouncilRecord, turn_id: &str) {
    let Some(turn) = record.turns.iter().find(|t| t.id == turn_id).cloned() else {
        return;
    };
    if let Some(t) = record.turns.iter_mut().find(|t| t.id == turn_id) {
        t.superseded = Some(true);
    }
    if let Some(round) = record.rounds.iter_mut().find(|r| r.index == turn.round) {
        if turn.seat == COUNCIL_CHAIR {
            if turn.stage == CouncilTurnStage::Framing {
                round.framing_fallback = Some(true);
            }
            if turn.stage == CouncilTurnStage::Amend {
                for objection in &mut round.objections {
                    if objection.turn.as_deref() == Some(turn_id) {
                        objection.answer = CouncilObjectionAnswer::Unanswered;
                    }
                }
            }
            return;
        }
        if !round.left_out.contains(&turn.seat) {
            round.left_out.push(turn.seat.clone());
        }
    }
    for item in &mut record.turns {
        if item.seat == turn.seat
            && item.round == turn.round
            && item.delivery == CouncilDelivery::Queued
        {
            item.superseded = Some(true);
        }
    }
}

pub struct ReplacementSeatSpec {
    pub model_id: String,
    pub model_name: String,
    pub provider: Option<String>,
    pub effort: Option<String>,
}

pub fn replace_seat<F: FnMut() -> String>(
    record: &mut CouncilRecord,
    turn_id: &str,
    replacement: ReplacementSeatSpec,
    new_thread_id: String,
    clock: &mut StageClock<F>,
) {
    let Some(turn) = record.turns.iter().find(|t| t.id == turn_id).cloned() else {
        return;
    };
    if let Some(held) = record.seats.iter_mut().find(|s| s.seat == turn.seat) {
        held.former_threads.push(held.thread.clone());
        if held.former_threads.len() > 20 {
            let drain = held.former_threads.len() - 20;
            held.former_threads.drain(..drain);
        }
        held.model_id = replacement.model_id;
        held.model_name = clip(&replacement.model_name, COUNCIL_MODEL_NAME_MAX);
        held.provider = replacement.provider;
        held.effort = replacement.effort;
        held.thread = new_thread_id;
        held.started = false;
        held.context = false;
    }
    if turn.stage == CouncilTurnStage::History {
        if let Some(t) = record.turns.iter_mut().find(|t| t.id == turn_id) {
            t.superseded = Some(true);
        }
        return;
    }
    retry_turn(record, turn_id, clock);
}

pub fn fairness_done(record: &CouncilRecord, round: &CouncilRound, now_ms: i64) -> bool {
    let Some(fairness_at) = round.fairness_at.as_deref().and_then(parse_iso_ms) else {
        return false;
    };
    if round
        .objections
        .iter()
        .any(|o| o.answer == CouncilObjectionAnswer::Pending)
    {
        return false;
    }
    if record.turns.iter().any(|t| {
        t.round == round.index
            && t.stage == CouncilTurnStage::Amend
            && t.superseded != Some(true)
            && !is_complete(t)
    }) {
        return false;
    }
    if now_ms >= fairness_at + COUNCIL_FAIRNESS_WAIT_MS {
        return true;
    }
    let letters = answered_letters(record, round.index);
    active_panelists(record, round)
        .into_iter()
        .filter(|s| letters.contains(&s.seat))
        .all(|seat| {
            current_turn(record, round.index, CouncilTurnStage::Fairness, &seat.seat)
                .map(is_complete)
                .unwrap_or(false)
        })
}

pub fn next_clock_change(record: &CouncilRecord, now_ms: i64) -> Option<i64> {
    if record.stopped_at.is_some() || record.settled_at.is_some() {
        return None;
    }
    let deadline_ms = i64::from(record.deadline_minutes) * 60_000;
    let mut best: Option<i64> = None;
    let mut consider = |t: i64| {
        if t > now_ms {
            best = Some(match best {
                Some(prev) => prev.min(t),
                None => t,
            });
        }
    };
    for turn in &record.turns {
        if turn.superseded != Some(true) && !is_final(turn) {
            if let Some(since) = deadline_from(turn).and_then(parse_iso_ms) {
                consider(since + deadline_ms + 1);
            }
        }
    }
    for round in &record.rounds {
        if let Some(fair_at) = round.fairness_at.as_deref().and_then(parse_iso_ms) {
            if !fairness_done(record, round, now_ms) {
                consider(fair_at + COUNCIL_FAIRNESS_WAIT_MS);
            }
        }
    }
    best
}

pub fn kinds_of(round: &CouncilRound) -> Vec<CouncilKind> {
    if let Some(k) = &round.kinds {
        return k.clone();
    }
    if let Some(f) = &round.framing {
        return f.kinds.clone();
    }
    vec![CouncilKind::Decision]
}

pub fn criteria_of(round: &CouncilRound) -> Vec<CouncilCriterion> {
    if let Some(c) = &round.criteria {
        return c.clone();
    }
    if let Some(f) = &round.framing {
        return f.criteria.clone();
    }
    Vec::new()
}

pub fn research_of(round: &CouncilRound) -> bool {
    if let Some(r) = round.research {
        return r;
    }
    if let Some(f) = &round.framing {
        return f.research.needed;
    }
    false
}

pub fn reframable(record: &CouncilRecord) -> bool {
    let round = current_round(record);
    record.stopped_at.is_none()
        && record.settled_at.is_none()
        && matches!(round.stage, CouncilStage::Answers | CouncilStage::Reviews)
}

pub struct ReframeChange {
    pub kinds: Option<Vec<CouncilKind>>,
    pub research: Option<bool>,
    pub criteria: Option<Vec<String>>,
}

/// Applies a user reframe in place, superseding current answers/reviews and returning
/// the unique thread IDs that were still running so the caller can interrupt them.
pub fn reframe(
    record: &mut CouncilRecord,
    change: ReframeChange,
    now_ms: i64,
) -> Option<Vec<String>> {
    if !reframable(record) {
        return None;
    }
    let round_pos = record.rounds.len() - 1;
    let round_index = record.rounds[round_pos].index;
    let cur_kinds = kinds_of(&record.rounds[round_pos]);
    let cur_research = research_of(&record.rounds[round_pos]);
    let cur_criteria: Vec<String> = criteria_of(&record.rounds[round_pos])
        .into_iter()
        .map(|c| c.text)
        .collect();

    let same_kinds = match &change.kinds {
        None => true,
        Some(k) => *k == cur_kinds,
    };
    let same_research = match change.research {
        None => true,
        Some(r) => r == cur_research,
    };
    let same_criteria = match &change.criteria {
        None => true,
        Some(c) => *c == cur_criteria,
    };
    if same_kinds && same_research && same_criteria {
        return None;
    }

    if let Some(kinds) = change.kinds {
        record.rounds[round_pos].kinds = Some(kinds);
    }
    if let Some(criteria) = change.criteria {
        if !same_criteria {
            record.rounds[round_pos].criteria = Some(
                criteria
                    .into_iter()
                    .enumerate()
                    .map(|(i, text)| CouncilCriterion {
                        id: format!("C{}", i + 1),
                        source: CouncilCriterionSource::User,
                        text,
                    })
                    .collect(),
            );
        }
    }
    if let Some(research) = change.research {
        record.rounds[round_pos].research = Some(research);
    }
    record.rounds[round_pos].reframed_at = Some(format_iso(now_ms));

    let mut running = Vec::new();
    let mut seen = HashSet::new();
    for turn in &mut record.turns {
        if turn.round != round_index
            || turn.superseded == Some(true)
            || !matches!(
                turn.stage,
                CouncilTurnStage::Answer | CouncilTurnStage::Review
            )
        {
            continue;
        }
        if !is_final(turn)
            && turn.delivery != CouncilDelivery::Queued
            && seen.insert(turn.thread.clone())
        {
            running.push(turn.thread.clone());
        }
        turn.superseded = Some(true);
    }
    record.rounds[round_pos].review_plan = None;
    record.rounds[round_pos].stage = CouncilStage::Answers;
    Some(running)
}

pub fn add_round(record: &mut CouncilRecord, question: String, now_ms: i64) {
    let index = record.rounds.len();
    let evidence = record.rounds.first().and_then(|r| r.evidence.clone());
    record.rounds.push(CouncilRound {
        index,
        asked_at: format_iso(now_ms),
        stage: CouncilStage::Framing,
        left_out: Vec::new(),
        review_plan: None,
        framing_fallback: None,
        kinds: None,
        research: None,
        reframed_at: None,
        criteria: None,
        crux_runners: None,
        crux_done: None,
        fairness_at: None,
        done_at: None,
        objections: Vec::new(),
        question: Some(question),
        framing: None,
        crux: None,
        verdict: None,
        amended: None,
        evidence,
    });
}

// ---------------------------------------------------------------------------
// View Projection & Draft Builder (matching councilService.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct CouncilThreadViewContext {
    pub title: String,
    pub has_pending_requests: bool,
}

fn held_answer(turn: Option<&CouncilTurn>) -> Option<CouncilAnswer> {
    let t = turn?;
    if t.result != CouncilTurnResult::Valid {
        return None;
    }
    serde_json::from_value(t.block.clone()?).ok()
}

fn held_review(turn: Option<&CouncilTurn>) -> Option<CouncilReview> {
    let t = turn?;
    if t.result != CouncilTurnResult::Valid {
        return None;
    }
    serde_json::from_value(t.block.clone()?).ok()
}

fn held_crux_result(turn: Option<&CouncilTurn>) -> Option<CouncilCruxResult> {
    let t = turn?;
    if t.result != CouncilTurnResult::Valid {
        return None;
    }
    serde_json::from_value(t.block.clone()?).ok()
}

pub fn counts_for_round(record: &CouncilRecord, round: &CouncilRound) -> CouncilCounts {
    let letters = answered_letters(record, round.index);
    let mut answers = BTreeMap::new();
    for letter in letters {
        let turn = current_turn(record, round.index, CouncilTurnStage::Answer, &letter);
        answers.insert(letter, held_answer(turn));
    }
    let mut owned_reviews: Vec<(String, Vec<String>, Option<CouncilReview>)> = Vec::new();
    if let Some(plan) = &round.review_plan {
        for (reader, assigned) in plan {
            let turn = current_turn(record, round.index, CouncilTurnStage::Review, reader);
            owned_reviews.push((reader.clone(), assigned.clone(), held_review(turn)));
        }
    }
    let counted: Vec<CountedReview<'_>> = owned_reviews
        .iter()
        .map(|(reader, assigned, block)| CountedReview {
            reader: reader.as_str(),
            assigned: assigned.as_slice(),
            block: block.as_ref(),
        })
        .collect();
    council_counts(&answers, &counted)
}

pub fn draft_verdict(record: &CouncilRecord, round: &CouncilRound, verdict: &str) -> String {
    let counts = counts_for_round(record, round);
    let format_seat = |item: &CouncilSeat| -> String {
        match item.provider.as_deref() {
            Some(provider) => {
                let label = provider_label(provider);
                match item.effort.as_deref() {
                    Some(effort) => format!("{} ({}, {})", item.model_name, label, effort_words(effort)),
                    None => format!("{} ({})", item.model_name, label),
                }
            }
            None => item.model_name.clone(),
        }
    };
    let panel = record
        .seats
        .iter()
        .filter(|s| is_panelist(s))
        .map(|s| format!("{} = {}", s.seat, format_seat(s)))
        .collect::<Vec<_>>()
        .join("; ");
    let chair = record
        .seats
        .iter()
        .find(|s| s.seat == COUNCIL_CHAIR)
        .map(format_seat)
        .unwrap_or_default();

    let mut lines = vec![
        format!(
            "The Council's verdict on: {}",
            clip(&collapse_whitespace(round.question.as_deref().unwrap_or("")), 300)
        ),
        verdict.to_string(),
        format!("Panelists: {panel}. Chair: {chair}."),
    ];

    let left_panelists: Vec<&str> = round
        .left_out
        .iter()
        .filter(|l| l.as_str() != COUNCIL_CHAIR)
        .map(String::as_str)
        .collect();
    if !left_panelists.is_empty() {
        lines.push(format!(
            "The Council went on without {}.",
            left_panelists.join(", ")
        ));
    }
    let partial_suffix = if counts.partial { " (partial)" } else { "" };
    if !counts.rankings.is_empty() {
        let joined = counts
            .rankings
            .iter()
            .map(|r| format!("{} by {} of {}", r.letter, r.first, r.of))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("Ranked first: {joined}{partial_suffix}."));
    }
    if !counts.findings.is_empty() {
        let joined = counts
            .findings
            .iter()
            .map(|f| {
                format!(
                    "{} confirmed by {}, rejected by {}, unchecked by {} of {}",
                    f.finding, f.confirmed, f.rejected, f.unchecked, f.of
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        lines.push(format!("Findings: {joined}{partial_suffix}."));
    }
    if !counts.supports.is_empty() {
        let joined = counts
            .supports
            .iter()
            .map(|s| format!("{} for {} of {}", s.letter, s.count, s.of))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("The evidence supports: {joined}."));
    }
    if !counts.favourites.is_empty() {
        let joined = counts
            .favourites
            .iter()
            .map(|f| format!("{} for {} of {}", f.finding, f.count, f.of))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("Favourites: {joined}."));
    }
    for obj in &round.objections {
        let passage = obj.passage.as_deref().unwrap_or("");
        let answer = match obj.answer {
            CouncilObjectionAnswer::Amended => "the chair amended it".to_string(),
            CouncilObjectionAnswer::Stands => match obj.reason.as_deref() {
                Some(reason) if !reason.is_empty() => format!("it stands, because {reason}"),
                _ => "it stands".to_string(),
            },
            CouncilObjectionAnswer::Pending | CouncilObjectionAnswer::Unanswered => {
                "the chair has not answered".to_string()
            }
        };
        lines.push(format!(
            "{} objected to \"{passage}\": {answer}.",
            obj.seat
        ));
    }
    lines.join("\n\n")
}

pub fn project_council_view(
    record: &CouncilRecord,
    threads: &HashMap<String, CouncilThreadViewContext>,
    local_host_id: Option<&str>,
    now_ms: i64,
) -> CouncilView {
    let win_id = |id: &str| host_entity_key(local_host_id, id);
    let round0 = current_round(record);
    let status = if record.settled_at.is_some() {
        CouncilViewStatus::Settled
    } else if record.stopped_at.is_some() {
        CouncilViewStatus::Stopped
    } else if round0.stage == CouncilStage::Done {
        CouncilViewStatus::Done
    } else {
        let any_waiting = record.turns.iter().any(|turn| {
            if turn.superseded == Some(true) || turn.round != round0.index {
                return false;
            }
            let has_req = threads
                .get(&turn.thread)
                .map(|t| t.has_pending_requests)
                .unwrap_or(false);
            !row_actions(record, turn, now_ms, has_req).is_empty()
                || (!is_final(turn) && has_req)
        });
        if any_waiting {
            CouncilViewStatus::Waiting
        } else {
            CouncilViewStatus::Working
        }
    };

    let evidence = record
        .evidence
        .iter()
        .map(|item| match item {
            CouncilEvidence::Frozen {
                id,
                source_kind,
                manifest_hash,
                files,
                bytes,
                retained,
                captured_at,
                removed_at,
            } => CouncilEvidenceView::Frozen {
                id: id.clone(),
                source_kind: *source_kind,
                manifest_hash: manifest_hash.clone(),
                files: *files,
                bytes: *bytes,
                retained: *retained,
                captured_at: captured_at.clone(),
                removed_at: removed_at.clone(),
                removed: removed_at.is_some(),
            },
            CouncilEvidence::LegacyGit { id, snapshot } => CouncilEvidenceView::LegacyGit {
                id: id.clone(),
                removed: snapshot.removed_at.is_some(),
            },
            CouncilEvidence::LegacyLive { id } => CouncilEvidenceView::LegacyLive { id: id.clone() },
        })
        .collect();

    let origin_title = threads
        .get(&record.origin_thread)
        .map(|t| t.title.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| record.origin_title.clone());

    let asked_by = record.asked_by.as_ref().map(|a| CouncilAskedByView {
        provider: a.provider.clone(),
        words: a.words.clone(),
    });

    let stopped_because = if record.stopped_at.is_some() {
        record.stopped_because
    } else {
        None
    };

    let snapshot = record.snapshot.as_ref().map(|snap| CouncilSnapshotView {
        commit: snap.commit.chars().take(12).collect(),
        branch: snap.branch.clone(),
        untracked: snap.untracked,
        dirty: snap.dirty == Some(true),
        removed: snap.removed_at.is_some(),
    });

    let seats = record
        .seats
        .iter()
        .map(|seat| CouncilSeatView {
            seat: seat.seat.clone(),
            role: seat.role,
            model_id: seat.model_id.clone(),
            model_name: seat.model_name.clone(),
            provider: seat.provider.clone(),
            effort: seat.effort.clone(),
            thread: win_id(&seat.thread),
            remote: is_council_remote_provider(seat.provider.as_deref()),
        })
        .collect();

    let rounds = record
        .rounds
        .iter()
        .map(|round| project_round_view(record, round, threads, local_host_id, now_ms))
        .collect();

    CouncilView {
        id: record.id.clone(),
        mode: Some(record.mode),
        evidence: Some(evidence),
        created_at: record.created_at.clone(),
        origin: CouncilOriginView {
            thread: win_id(&record.origin_thread),
            title: clip(&origin_title, 512),
        },
        asked_by,
        status,
        stopped_because,
        snapshot,
        history: CouncilHistoryView {
            messages: record.history.messages,
            words: record.history.words,
            parts: record.history.parts,
        },
        seats,
        rounds,
        deadline_minutes: record.deadline_minutes,
    }
}

fn project_round_view(
    record: &CouncilRecord,
    round: &CouncilRound,
    threads: &HashMap<String, CouncilThreadViewContext>,
    local_host_id: Option<&str>,
    now_ms: i64,
) -> CouncilRoundView {
    let win_id = |id: &str| host_entity_key(local_host_id, id);
    let deadline_ms = i64::from(record.deadline_minutes) * 60_000;
    let round_research = research_of(round);

    let mut active_turns: Vec<&CouncilTurn> = record
        .turns
        .iter()
        .filter(|t| t.round == round.index && t.superseded != Some(true))
        .collect();
    active_turns.sort_by_key(|t| (t.stage.order_index(), usize::from(t.repair_of.is_some())));

    let rows: Vec<CouncilRow> = active_turns
        .into_iter()
        .map(|turn| {
            let waiting = !is_final(turn)
                && threads
                    .get(&turn.thread)
                    .map(|t| t.has_pending_requests)
                    .unwrap_or(false);
            let result = match turn.result {
                CouncilTurnResult::Pending | CouncilTurnResult::Invalid => CouncilRowResult::Pending,
                CouncilTurnResult::Valid => CouncilRowResult::Valid,
                CouncilTurnResult::Unavailable => CouncilRowResult::Unavailable,
                CouncilTurnResult::None => CouncilRowResult::None,
            };
            let sources = if round_research
                && turn.stage == CouncilTurnStage::Answer
                && turn.repair_of.is_none()
            {
                held_answer(Some(turn)).and_then(|ans| {
                    let list: Vec<CouncilRowSource> = ans
                        .findings
                        .into_iter()
                        .filter_map(|f| {
                            if f.kind == CouncilFindingKind::Source {
                                f.evidence.map(|url| CouncilRowSource {
                                    finding: f.id,
                                    url,
                                })
                            } else {
                                None
                            }
                        })
                        .take(40)
                        .collect();
                    if list.is_empty() {
                        None
                    } else {
                        Some(list)
                    }
                })
            } else {
                None
            };
            let changed = if turn.stage == CouncilTurnStage::Review
                && held_review(Some(turn))
                    .and_then(|r| r.answer)
                    .as_deref()
                    == Some("changed")
            {
                Some(true)
            } else {
                None
            };
            let citations = turn.citations.clone().filter(|c| !c.is_empty());
            CouncilRow {
                turn: turn.id.clone(),
                seat: turn.seat.clone(),
                stage: turn.stage,
                state: turn_state(turn, waiting),
                late: is_late(turn, now_ms, deadline_ms, Some(record)),
                repair: turn.repair_of.is_some(),
                result,
                summary: turn.summary.clone(),
                citations,
                sources,
                changed,
                thread: win_id(&turn.thread),
                actions: row_actions(record, turn, now_ms, waiting),
            }
        })
        .collect();

    let verdict = if round.verdict.is_none()
        && !matches!(round.stage, CouncilStage::Fairness | CouncilStage::Done)
    {
        None
    } else {
        Some(CouncilVerdictView {
            text: round.verdict.clone(),
            counts: counts_for_round(record, round),
            fairness_done: fairness_done(record, round, now_ms),
            objections: round
                .objections
                .iter()
                .map(|o| CouncilObjectionView {
                    seat: o.seat.clone(),
                    claim: o.claim.clone().unwrap_or_default(),
                    passage: o.passage.clone().unwrap_or_default(),
                    answer: match o.answer {
                        CouncilObjectionAnswer::Amended => CouncilObjectionViewAnswer::Amended,
                        CouncilObjectionAnswer::Stands => CouncilObjectionViewAnswer::Stands,
                        CouncilObjectionAnswer::Pending | CouncilObjectionAnswer::Unanswered => {
                            CouncilObjectionViewAnswer::Pending
                        }
                    },
                    reason: o.reason.clone(),
                })
                .collect(),
        })
    };

    let research_view = CouncilFramingResearchView {
        needed: round_research,
        reason: if round.research.is_none() {
            round
                .framing
                .as_ref()
                .map(|f| f.research.reason.clone())
                .unwrap_or_default()
        } else {
            String::new()
        },
        by_user: round.research.is_some(),
    };

    let framing = if let Some(f) = &round.framing {
        Some(CouncilFramingView {
            kinds: kinds_of(round),
            criteria: criteria_of(round),
            headings: f.headings.clone(),
            words: f.words,
            angles: f.angles.clone(),
            research: research_view,
            fallback: false,
        })
    } else if round.framing_fallback == Some(true) {
        Some(CouncilFramingView {
            kinds: kinds_of(round),
            criteria: criteria_of(round),
            headings: Vec::new(),
            words: 0,
            angles: Vec::new(),
            research: research_view,
            fallback: true,
        })
    } else {
        None
    };

    let crux = round.crux.as_ref().map(|c| {
        let result = round
            .crux_runners
            .as_ref()
            .and_then(|runners| {
                runners.iter().find_map(|runner| {
                    let turn = current_turn(record, round.index, CouncilTurnStage::Crux, runner);
                    held_crux_result(turn).map(|r| r.result)
                })
            });
        CouncilCruxView {
            test: c.test.clone(),
            lookup: c.lookup,
            sides: c.sides.clone(),
            meanings: c
                .meanings
                .iter()
                .map(|m| format!("{} => {}", m.result, m.meaning))
                .collect(),
            result,
        }
    });

    let draft = match &verdict {
        Some(v) if v.fairness_done => v
            .text
            .as_deref()
            .map(|text| clip(&draft_verdict(record, round, text), 400_000)),
        _ => None,
    };

    CouncilRoundView {
        index: round.index,
        evidence: round.evidence.clone(),
        question: round.question.clone(),
        asked_at: round.asked_at.clone(),
        stage: round.stage,
        framing,
        rows,
        left_out: round.left_out.clone(),
        reframable: round.index == current_round(record).index && reframable(record),
        crux,
        verdict,
        draft,
    }
}

// ---------------------------------------------------------------------------
// CouncilManager (state + recovery + commands + privacy)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct CouncilOriginThreadInfo {
    pub id: String,
    pub title: String,
    pub project_id: String,
    pub kind: Option<String>,
    pub provider_id: Option<String>,
    pub working_directory: Option<String>,
    pub remote_host: bool,
    pub host_id: Option<String>,
    pub messages_count: u64,
    pub words_count: u64,
    pub tools_count: u64,
    pub characters_count: u64,
    pub last_message_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CouncilModelInfo {
    pub id: String,
    pub name: String,
    pub provider_id: Option<String>,
    pub ready: bool,
}

#[derive(Debug, Clone, Default)]
pub struct CouncilCommandContext {
    pub local_host_id: Option<String>,
    pub threads: HashMap<String, CouncilOriginThreadInfo>,
    pub thread_views: HashMap<String, CouncilThreadViewContext>,
    pub models: Vec<CouncilModelInfo>,
    pub deadline_minutes: u32,
}

#[derive(Debug, Clone)]
pub struct CouncilCommandOutcome {
    pub result: CouncilCommandResult,
    pub changed_ids: Vec<String>,
    pub interrupt_threads: Vec<String>,
    pub settle_threads: Vec<String>,
}

fn is_open(record: &CouncilRecord) -> bool {
    record.settled_at.is_none()
}

fn is_evictable(record: &CouncilRecord) -> bool {
    record.settled_at.is_some()
        && record
            .snapshot
            .as_ref()
            .map(|s| s.removed_at.is_some())
            .unwrap_or(true)
}

pub struct CouncilManager {
    store: CouncilStore,
    records: Vec<CouncilRecord>,
    climb_records: Vec<Value>,
    keep_history: bool,
    storage_error: Option<String>,
    closed: bool,
}

impl CouncilManager {
    pub fn new(data_directory: &Path) -> Self {
        Self {
            store: CouncilStore::new(data_directory),
            records: Vec::new(),
            climb_records: Vec::new(),
            keep_history: true,
            storage_error: None,
            closed: false,
        }
    }

    pub fn records(&self) -> &[CouncilRecord] {
        &self.records
    }

    pub fn records_mut(&mut self) -> &mut Vec<CouncilRecord> {
        &mut self.records
    }

    pub fn climb_records(&self) -> &[Value] {
        &self.climb_records
    }

    pub fn storage_error(&self) -> Option<&str> {
        self.storage_error.as_deref()
    }

    pub fn keep_history(&self) -> bool {
        self.keep_history
    }

    pub fn close(&mut self) {
        self.closed = true;
    }

    /// Reads `councils.json` (migrating v1 if needed), converts in-flight
    /// `dispatching` turns/deliveries to `unconfirmed`, stops open unfinished
    /// Councils whose question was lost with `words-lost`, and persists.
    pub fn recover(&mut self) -> Vec<String> {
        self.recover_at(now_ms())
    }

    pub fn recover_at(&mut self, ts_ms: i64) -> Vec<String> {
        let loaded = match self.store.read() {
            Ok(file) => {
                self.storage_error = None;
                file
            }
            Err(_) => {
                self.storage_error = Some(
                    "Council history could not be read. Its file was kept unchanged. Update Sotto or restore councils.json before starting another Council."
                        .into(),
                );
                return Vec::new();
            }
        };
        self.records = loaded.records;
        self.climb_records = loaded.climb_records;

        let at = format_iso(ts_ms);
        for record in &mut self.records {
            for ev in &mut record.evidence {
                if let CouncilEvidence::Frozen {
                    retained,
                    removed_at,
                    ..
                } = ev
                {
                    if !*retained && removed_at.is_none() {
                        *removed_at = Some(at.clone());
                    }
                }
            }
            for turn in &mut record.turns {
                if turn.delivery == CouncilDelivery::Dispatching {
                    turn.delivery = CouncilDelivery::Unconfirmed;
                    turn.outcome = Some(CouncilTurnOutcome::Unknown);
                }
            }
            if let Some(asked) = record.asked_by.as_mut() {
                if let Some(delivery) = asked.delivery.as_mut() {
                    if delivery.state == CouncilAskedDeliveryState::Dispatching {
                        delivery.state = CouncilAskedDeliveryState::Unconfirmed;
                    }
                }
            }
            let open_unfinished_no_question = is_open(record)
                && record.stopped_at.is_none()
                && current_round(record).stage != CouncilStage::Done
                && current_round(record).question.is_none();
            if open_unfinished_no_question {
                record.stopped_at = Some(at.clone());
                record.stopped_because = Some(CouncilStoppedBecause::WordsLost);
            }
        }

        let _ = self.persist();
        self.records
            .iter()
            .filter(|r| is_open(r))
            .map(|r| r.id.clone())
            .collect()
    }

    /// Updates Keep local history and immediately persists (stripping words on disk
    /// and removing `councils.json.v1-backup` when turned off).
    pub fn set_history_enabled(&mut self, enabled: bool) -> Result<(), String> {
        self.keep_history = enabled;
        self.persist()
    }

    pub fn persist(&mut self) -> Result<(), String> {
        if self.storage_error.is_some() {
            return Ok(());
        }
        self.store
            .write(&self.records, &self.climb_records, self.keep_history)
    }

    /// Projects up to `COUNCIL_VIEWS_MAX` newest-first Council views.
    pub fn views(
        &self,
        threads: &HashMap<String, CouncilThreadViewContext>,
        local_host_id: Option<&str>,
    ) -> Vec<CouncilView> {
        self.views_at(threads, local_host_id, now_ms())
    }

    pub fn views_at(
        &self,
        threads: &HashMap<String, CouncilThreadViewContext>,
        local_host_id: Option<&str>,
        ts_ms: i64,
    ) -> Vec<CouncilView> {
        let start = self.records.len().saturating_sub(COUNCIL_VIEWS_MAX);
        self.records[start..]
            .iter()
            .rev()
            .map(|r| project_council_view(r, threads, local_host_id, ts_ms))
            .collect()
    }

    /// Resolves a window-qualified origin thread key (`host:<hostId>:<id>` or bare `<id>`)
    /// to this computer's local thread ID, returning `None` if it belongs to another host.
    pub fn own_thread_id(local_host_id: Option<&str>, key: &str) -> Option<String> {
        match parse_host_entity_key(key) {
            Some((hid, id)) => {
                if local_host_id == Some(hid.as_str()) {
                    Some(id)
                } else {
                    None
                }
            }
            None => Some(key.to_string()),
        }
    }

    pub fn estimate(
        &self,
        origin_key: &str,
        ctx: &CouncilCommandContext,
    ) -> CouncilEstimate {
        if let Some(err) = &self.storage_error {
            return CouncilEstimate::Unavailable {
                unavailable: err.clone(),
            };
        }
        let Some(local_id) = Self::own_thread_id(ctx.local_host_id.as_deref(), origin_key) else {
            return CouncilEstimate::Unavailable {
                unavailable: "A Council starts from a thread on this computer.".into(),
            };
        };
        let Some(thread) = ctx.threads.get(&local_id) else {
            return CouncilEstimate::Unavailable {
                unavailable: "That thread is not on this computer.".into(),
            };
        };
        if thread.provider_id.is_none() || thread.remote_host {
            return CouncilEstimate::Unavailable {
                unavailable: "That thread is not on this computer.".into(),
            };
        }
        let parts = if thread.characters_count as usize <= COUNCIL_HISTORY_INLINE_MAX {
            1
        } else {
            ((thread.characters_count as usize).div_ceil(COUNCIL_HISTORY_PART_MAX)).max(1) as u32
        };
        CouncilEstimate::Ready {
            messages: thread.messages_count,
            words: thread.words_count,
            tools: thread.tools_count,
            characters: thread.characters_count,
            parts,
        }
    }

    pub fn command(
        &mut self,
        command: CouncilCommand,
        ctx: &CouncilCommandContext,
    ) -> CouncilCommandOutcome {
        self.command_at(command, ctx, now_ms())
    }

    pub fn command_at(
        &mut self,
        command: CouncilCommand,
        ctx: &CouncilCommandContext,
        ts_ms: i64,
    ) -> CouncilCommandOutcome {
        let empty = |res| CouncilCommandOutcome {
            result: res,
            changed_ids: Vec::new(),
            interrupt_threads: Vec::new(),
            settle_threads: Vec::new(),
        };
        if self.closed {
            return empty(CouncilCommandResult::err(
                "Sotto is closing. Nothing was changed.",
            ));
        }
        if let Some(err) = &self.storage_error {
            return empty(CouncilCommandResult::err(err.clone()));
        }

        match command {
            CouncilCommand::Start {
                origin_thread,
                question,
                panelists,
                chair,
            } => self.cmd_start(origin_thread, question, panelists, chair, ctx, ts_ms),
            CouncilCommand::Stop { council } => self.cmd_stop(&council, ts_ms),
            CouncilCommand::Settle { council } => self.cmd_settle(&council, ts_ms),
            CouncilCommand::Reframe {
                council,
                kinds,
                research,
                criteria,
            } => self.cmd_reframe(&council, kinds, research, criteria, ts_ms),
            CouncilCommand::FollowUp { council, question } => {
                self.cmd_follow_up(&council, question, ts_ms)
            }
            CouncilCommand::Retry { council, turn } => {
                self.cmd_row_action(&council, &turn, CouncilRowAction::Retry, None, ctx, ts_ms)
            }
            CouncilCommand::Skip { council, turn } => {
                self.cmd_row_action(&council, &turn, CouncilRowAction::Skip, None, ctx, ts_ms)
            }
            CouncilCommand::Replace {
                council,
                turn,
                seat,
            } => self.cmd_row_action(
                &council,
                &turn,
                CouncilRowAction::Replace,
                Some(seat),
                ctx,
                ts_ms,
            ),
        }
    }

    fn cmd_start(
        &mut self,
        origin_key: String,
        question: String,
        panelists: Vec<CouncilSeatChoice>,
        chair: CouncilSeatChoice,
        ctx: &CouncilCommandContext,
        ts_ms: i64,
    ) -> CouncilCommandOutcome {
        let err = |msg: &str| CouncilCommandOutcome {
            result: CouncilCommandResult::err(msg),
            changed_ids: Vec::new(),
            interrupt_threads: Vec::new(),
            settle_threads: Vec::new(),
        };

        let question = question.trim().to_string();
        if question.is_empty() || question.chars().count() > COUNCIL_QUESTION_MAX {
            return err("Give a question for the Council. Nothing was started.");
        }
        if !(COUNCIL_PANELISTS_MIN..=COUNCIL_PANELISTS_MAX).contains(&panelists.len()) {
            return err("Choose two to five panelists. Nothing was started.");
        }
        let Some(origin_id) = Self::own_thread_id(ctx.local_host_id.as_deref(), &origin_key) else {
            return err("A Council starts from a thread on this computer. Choose one of this computer's threads. Nothing was started.");
        };
        let Some(origin) = ctx.threads.get(&origin_id) else {
            return err("A Council starts from a thread on this computer. Choose one of this computer's threads. Nothing was started.");
        };
        if origin.remote_host
            || (origin.host_id.is_some() && origin.host_id != ctx.local_host_id)
        {
            return err("A Council starts from a thread on this computer. Choose one of this computer's threads. Nothing was started.");
        }
        if matches!(
            origin.kind.as_deref(),
            Some("watcher" | "watcher-history")
        ) {
            return err("A Council starts from an ordinary thread, not Watcher. Nothing was started.");
        }
        if origin.working_directory.as_deref().unwrap_or("").is_empty() {
            return err("That thread has no folder for the Council to work in. Nothing was started.");
        }
        if self.records.len() >= COUNCIL_RECORDS_MAX
            && !self.records.iter().any(is_evictable)
        {
            return err(&format!(
                "Sotto keeps {COUNCIL_RECORDS_MAX} Councils, and one makes room only once it is settled and its snapshot is removed. Settle a Council, then ask again. Nothing was started."
            ));
        }

        let mut seats = Vec::with_capacity(panelists.len() + 1);
        for (idx, choice) in panelists.iter().enumerate() {
            let Some(model) = ctx
                .models
                .iter()
                .find(|m| m.id == choice.model_id && m.ready)
            else {
                return err("A seat's model is not ready: its provider is not connected. Choose another model for it, then ask again. Nothing was started.");
            };
            seats.push(CouncilSeat {
                seat: COUNCIL_LETTERS[idx].to_string(),
                role: CouncilRole::Panelist,
                model_id: model.id.clone(),
                model_name: clip(&model.name, COUNCIL_MODEL_NAME_MAX),
                provider: model.provider_id.clone(),
                effort: choice.reasoning_effort.clone(),
                thread: Uuid::new_v4().to_string(),
                former_threads: Vec::new(),
                started: false,
                context: false,
            });
        }
        let Some(chair_model) = ctx
            .models
            .iter()
            .find(|m| m.id == chair.model_id && m.ready)
        else {
            return err("A seat's model is not ready: its provider is not connected. Choose another model for it, then ask again. Nothing was started.");
        };
        seats.push(CouncilSeat {
            seat: COUNCIL_CHAIR.to_string(),
            role: CouncilRole::Chair,
            model_id: chair_model.id.clone(),
            model_name: clip(&chair_model.name, COUNCIL_MODEL_NAME_MAX),
            provider: chair_model.provider_id.clone(),
            effort: chair.reasoning_effort,
            thread: Uuid::new_v4().to_string(),
            former_threads: Vec::new(),
            started: false,
            context: false,
        });

        let id = Uuid::new_v4().to_string();
        let source = format!("{id}:legacy");
        let now = format_iso(ts_ms);
        let parts = if origin.characters_count as usize <= COUNCIL_HISTORY_INLINE_MAX {
            1
        } else {
            ((origin.characters_count as usize).div_ceil(COUNCIL_HISTORY_PART_MAX)).max(1) as u32
        };
        let deadline = ctx
            .deadline_minutes
            .clamp(COUNCIL_STAGE_DEADLINE_MIN, COUNCIL_STAGE_DEADLINE_MAX);
        let deadline_minutes = if ctx.deadline_minutes == 0 {
            COUNCIL_STAGE_DEADLINE_DEFAULT
        } else {
            deadline
        };

        let mut record = CouncilRecord {
            id: id.clone(),
            mode: CouncilMode::Standard,
            created_at: now.clone(),
            origin_thread: origin.id.clone(),
            origin_title: clip(&origin.title, 512),
            project_id: origin.project_id.clone(),
            snapshot: None,
            history: CouncilHistoryMeta {
                messages: origin.messages_count,
                words: origin.words_count,
                tools: origin.tools_count,
                parts,
                last_message_id: origin.last_message_id.clone(),
            },
            seats,
            rounds: vec![CouncilRound {
                index: 0,
                asked_at: now,
                stage: CouncilStage::Framing,
                left_out: Vec::new(),
                review_plan: None,
                framing_fallback: None,
                kinds: None,
                research: None,
                reframed_at: None,
                criteria: None,
                crux_runners: None,
                crux_done: None,
                fairness_at: None,
                done_at: None,
                objections: Vec::new(),
                question: Some(question),
                framing: None,
                crux: None,
                verdict: None,
                amended: None,
                evidence: Some(CouncilRoundEvidence {
                    source: Some(source.clone()),
                    ..CouncilRoundEvidence::default()
                }),
            }],
            turns: Vec::new(),
            deadline_minutes,
            stopped_at: None,
            stopped_because: None,
            settled_at: None,
            asked_by: None,
            evidence: vec![CouncilEvidence::LegacyLive { id: source }],
        };

        let mut clock = StageClock::system(ts_ms);
        advance_round(&mut record, &mut clock);
        self.records.push(record);
        self.evict();
        let _ = self.persist();

        CouncilCommandOutcome {
            result: CouncilCommandResult::ok(id.clone()),
            changed_ids: vec![id],
            interrupt_threads: Vec::new(),
            settle_threads: Vec::new(),
        }
    }

    fn cmd_stop(&mut self, council_id: &str, ts_ms: i64) -> CouncilCommandOutcome {
        let Some(pos) = self.records.iter().position(|r| r.id == council_id) else {
            return CouncilCommandOutcome {
                result: CouncilCommandResult::err("That Council is no longer here."),
                changed_ids: Vec::new(),
                interrupt_threads: Vec::new(),
                settle_threads: Vec::new(),
            };
        };
        let mut interrupt = Vec::new();
        let record = &mut self.records[pos];
        if record.stopped_at.is_none() && record.settled_at.is_none() {
            record.stopped_at = Some(format_iso(ts_ms));
            record.stopped_because = Some(CouncilStoppedBecause::User);
            let mut seen = HashSet::new();
            for turn in &mut record.turns {
                if turn.delivery == CouncilDelivery::Queued {
                    turn.superseded = Some(true);
                } else if turn.superseded != Some(true)
                    && !is_final(turn)
                    && seen.insert(turn.thread.clone())
                {
                    interrupt.push(turn.thread.clone());
                }
            }
            let _ = self.persist();
        }
        CouncilCommandOutcome {
            result: CouncilCommandResult::ok(council_id),
            changed_ids: vec![council_id.to_string()],
            interrupt_threads: interrupt,
            settle_threads: Vec::new(),
        }
    }

    fn cmd_settle(&mut self, council_id: &str, ts_ms: i64) -> CouncilCommandOutcome {
        let Some(pos) = self.records.iter().position(|r| r.id == council_id) else {
            return CouncilCommandOutcome {
                result: CouncilCommandResult::err("That Council is no longer here."),
                changed_ids: Vec::new(),
                interrupt_threads: Vec::new(),
                settle_threads: Vec::new(),
            };
        };
        let mut interrupt = Vec::new();
        let mut settle_threads = Vec::new();
        let record = &mut self.records[pos];
        if record.settled_at.is_none() {
            if record.stopped_at.is_none() {
                record.stopped_at = Some(format_iso(ts_ms));
                record.stopped_because = Some(CouncilStoppedBecause::User);
                let mut seen = HashSet::new();
                for turn in &mut record.turns {
                    if turn.delivery == CouncilDelivery::Queued {
                        turn.superseded = Some(true);
                    } else if turn.superseded != Some(true)
                        && !is_final(turn)
                        && seen.insert(turn.thread.clone())
                    {
                        interrupt.push(turn.thread.clone());
                    }
                }
            }
            record.settled_at = Some(format_iso(ts_ms));
            for seat in &record.seats {
                if seat.started {
                    settle_threads.push(seat.thread.clone());
                }
                settle_threads.extend(seat.former_threads.iter().cloned());
            }
            let _ = self.persist();
        }
        CouncilCommandOutcome {
            result: CouncilCommandResult::ok(council_id),
            changed_ids: vec![council_id.to_string()],
            interrupt_threads: interrupt,
            settle_threads,
        }
    }

    fn cmd_reframe(
        &mut self,
        council_id: &str,
        kinds: Option<Vec<CouncilKind>>,
        research: Option<bool>,
        criteria: Option<Vec<String>>,
        ts_ms: i64,
    ) -> CouncilCommandOutcome {
        let Some(pos) = self.records.iter().position(|r| r.id == council_id) else {
            return CouncilCommandOutcome {
                result: CouncilCommandResult::err("That Council is no longer here."),
                changed_ids: Vec::new(),
                interrupt_threads: Vec::new(),
                settle_threads: Vec::new(),
            };
        };
        let Some(running) = reframe(
            &mut self.records[pos],
            ReframeChange {
                kinds,
                research,
                criteria,
            },
            ts_ms,
        ) else {
            return CouncilCommandOutcome {
                result: CouncilCommandResult::err(
                    "The framing can change only after it is in and before the verdict, and only to something new. Nothing was changed.",
                ),
                changed_ids: Vec::new(),
                interrupt_threads: Vec::new(),
                settle_threads: Vec::new(),
            };
        };
        let mut clock = StageClock::system(ts_ms);
        advance_round(&mut self.records[pos], &mut clock);
        let _ = self.persist();
        CouncilCommandOutcome {
            result: CouncilCommandResult::ok(council_id),
            changed_ids: vec![council_id.to_string()],
            interrupt_threads: running,
            settle_threads: Vec::new(),
        }
    }

    fn cmd_follow_up(
        &mut self,
        council_id: &str,
        question: String,
        ts_ms: i64,
    ) -> CouncilCommandOutcome {
        let err = |msg: &str| CouncilCommandOutcome {
            result: CouncilCommandResult::err(msg),
            changed_ids: Vec::new(),
            interrupt_threads: Vec::new(),
            settle_threads: Vec::new(),
        };
        let question = question.trim().to_string();
        if question.is_empty() || question.chars().count() > COUNCIL_QUESTION_MAX {
            return err("Give a follow-up question. Nothing was changed.");
        }
        let Some(pos) = self.records.iter().position(|r| r.id == council_id) else {
            return err("That Council is no longer here.");
        };
        if self.records[pos].stopped_at.is_some() || self.records[pos].settled_at.is_some() {
            return err(
                "This Council has stopped, so it takes no follow-up. Ask a new Council instead.",
            );
        }
        if current_round(&self.records[pos]).stage != CouncilStage::Done {
            return err("Wait for the verdict and its fairness check before asking a follow-up.");
        }
        add_round(&mut self.records[pos], question, ts_ms);
        let mut clock = StageClock::system(ts_ms);
        advance_round(&mut self.records[pos], &mut clock);
        let _ = self.persist();
        CouncilCommandOutcome {
            result: CouncilCommandResult::ok(council_id),
            changed_ids: vec![council_id.to_string()],
            interrupt_threads: Vec::new(),
            settle_threads: Vec::new(),
        }
    }

    fn cmd_row_action(
        &mut self,
        council_id: &str,
        turn_id: &str,
        action: CouncilRowAction,
        seat_choice: Option<CouncilSeatChoice>,
        ctx: &CouncilCommandContext,
        ts_ms: i64,
    ) -> CouncilCommandOutcome {
        let err = |msg: &str| CouncilCommandOutcome {
            result: CouncilCommandResult::err(msg),
            changed_ids: Vec::new(),
            interrupt_threads: Vec::new(),
            settle_threads: Vec::new(),
        };
        let Some(pos) = self.records.iter().position(|r| r.id == council_id) else {
            return err("That Council is no longer here.");
        };
        let Some(turn) = self.records[pos]
            .turns
            .iter()
            .find(|t| t.id == turn_id)
            .cloned()
        else {
            return err("That row has nothing to do now. Nothing was changed.");
        };
        let waiting = ctx
            .thread_views
            .get(&turn.thread)
            .map(|t| t.has_pending_requests)
            .unwrap_or(false);
        let offered = row_actions(&self.records[pos], &turn, ts_ms, waiting);
        if !offered.contains(&action) {
            return err("That row has nothing to do now. Nothing was changed.");
        }
        let replacement = if action == CouncilRowAction::Replace {
            let Some(choice) = seat_choice else {
                return err("Choose a model. Nothing was changed.");
            };
            let Some(model) = ctx
                .models
                .iter()
                .find(|m| m.id == choice.model_id && m.ready)
            else {
                return err("That model is not ready: its provider is not connected. Choose another. Nothing was changed.");
            };
            Some(ReplacementSeatSpec {
                model_id: model.id.clone(),
                model_name: model.name.clone(),
                provider: model.provider_id.clone(),
                effort: choice.reasoning_effort,
            })
        } else {
            None
        };

        let interrupt = if !is_final(&turn) && turn.delivery != CouncilDelivery::Queued {
            vec![turn.thread.clone()]
        } else {
            Vec::new()
        };

        let mut clock = StageClock::system(ts_ms);
        match action {
            CouncilRowAction::Retry => retry_turn(&mut self.records[pos], turn_id, &mut clock),
            CouncilRowAction::Skip => leave_out(&mut self.records[pos], turn_id),
            CouncilRowAction::Replace => replace_seat(
                &mut self.records[pos],
                turn_id,
                replacement.unwrap(),
                Uuid::new_v4().to_string(),
                &mut clock,
            ),
        }
        advance_round(&mut self.records[pos], &mut clock);
        let _ = self.persist();

        CouncilCommandOutcome {
            result: CouncilCommandResult::ok(council_id),
            changed_ids: vec![council_id.to_string()],
            interrupt_threads: interrupt,
            settle_threads: Vec::new(),
        }
    }

    fn evict(&mut self) {
        if self.records.len() <= COUNCIL_RECORDS_MAX {
            return;
        }
        let mut excess = self.records.len() - COUNCIL_RECORDS_MAX;
        self.records.retain(|rec| {
            if excess > 0 && is_evictable(rec) {
                excess -= 1;
                false
            } else {
                true
            }
        });
    }
}

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn sample_v1_json(id: &str) -> Value {
        json!({
            "version": 1,
            "councils": [
                {
                    "id": id,
                    "createdAt": "2026-11-01T10:00:00.000Z",
                    "originThread": "thread-origin",
                    "originTitle": "Origin thread",
                    "projectId": "proj-1",
                    "history": {
                        "messages": 4,
                        "words": 120,
                        "tools": 1,
                        "parts": 1,
                        "lastMessageId": "msg-4"
                    },
                    "seats": [
                        {
                            "seat": "A",
                            "role": "panelist",
                            "modelId": "claude-opus",
                            "modelName": "Claude Opus",
                            "provider": "claude",
                            "effort": "high",
                            "thread": "t-a",
                            "formerThreads": [],
                            "started": true,
                            "context": true
                        },
                        {
                            "seat": "B",
                            "role": "panelist",
                            "modelId": "gpt-6-sol",
                            "modelName": "GPT-6 Sol",
                            "provider": "codex",
                            "effort": "high",
                            "thread": "t-b",
                            "formerThreads": [],
                            "started": true,
                            "context": true
                        },
                        {
                            "seat": "chair",
                            "role": "chair",
                            "modelId": "grok-4",
                            "modelName": "Grok 4",
                            "provider": "grok",
                            "effort": "high",
                            "thread": "t-c",
                            "formerThreads": [],
                            "started": true,
                            "context": true
                        }
                    ],
                    "rounds": [
                        {
                            "index": 0,
                            "askedAt": "2026-11-01T10:00:00.000Z",
                            "stage": "framing",
                            "leftOut": [],
                            "objections": [],
                            "question": "Should we migrate to SQLite?"
                        }
                    ],
                    "turns": [
                        {
                            "id": "11111111-1111-4111-8111-111111111111",
                            "round": 0,
                            "seat": "chair",
                            "thread": "t-c",
                            "stage": "framing",
                            "draftId": "22222222-2222-4222-8222-222222222222",
                            "messageId": "33333333-3333-4333-8333-333333333333",
                            "delivery": "dispatching",
                            "queuedAt": "2026-11-01T10:00:00.000Z",
                            "sentAt": "2026-11-01T10:00:01.000Z",
                            "result": "pending",
                            "summary": "framing summary"
                        }
                    ],
                    "deadlineMinutes": 10
                }
            ]
        })
    }

    #[test]
    fn host_entity_key_round_trip() {
        let host = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let keyed = host_entity_key(Some(host), "thread-1");
        assert_eq!(keyed, format!("host:{host}:thread-1"));
        assert_eq!(
            parse_host_entity_key(&keyed),
            Some((host.to_string(), "thread-1".to_string()))
        );
        assert_eq!(parse_host_entity_key("thread-1"), None);
        assert_eq!(host_entity_key(None, "thread-1"), "thread-1");
    }

    #[test]
    fn v1_migration_creates_backup_and_refuses_conflict() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("councils.json");
        let cid = "00000000-0000-4000-8000-000000000001";
        let raw = serde_json::to_string_pretty(&sample_v1_json(cid)).unwrap();
        fs::write(&file, &raw).unwrap();

        let mut store = CouncilStore::new(dir.path());
        let loaded = store.read().unwrap();
        assert_eq!(loaded.records.len(), 1);
        assert_eq!(loaded.records[0].mode, CouncilMode::Standard);
        assert_eq!(
            loaded.records[0].rounds[0]
                .evidence
                .as_ref()
                .and_then(|e| e.source.as_deref()),
            Some("00000000-0000-4000-8000-000000000001:legacy")
        );

        let backup = dir.path().join("councils.json.v1-backup");
        assert!(backup.exists());
        assert_eq!(fs::read_to_string(&backup).unwrap(), raw);

        // History-off write strips words and deletes .v1-backup.
        store.write(&loaded.records, &[], false).unwrap();
        assert!(!backup.exists());

        let reloaded = store.read().unwrap();
        assert_eq!(reloaded.records[0].rounds[0].question, None);
        assert_eq!(reloaded.records[0].turns[0].summary, None);

        // Conflicting backup refuses v1 migration without modifying councils.json.
        fs::write(&file, &raw).unwrap();
        fs::write(&backup, "{\"version\":1,\"councils\":[]}").unwrap();
        let err = store.read().unwrap_err();
        assert!(err.contains("different Council migration backup"));
        assert_eq!(fs::read_to_string(&file).unwrap(), raw);
    }

    #[test]
    fn store_refuses_unknown_version_and_preserves_climb_records() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("councils.json");
        fs::write(&file, r#"{"version":9,"councils":[]}"#).unwrap();
        let mut store = CouncilStore::new(dir.path());
        let err = store.read().unwrap_err();
        assert!(err.contains("newer Sotto"));

        // v2 with a Climb sibling entry (has "phase" key).
        let climb = json!({
            "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "phase": "setup",
            "goal": "Improve perf"
        });
        fs::write(
            &file,
            serde_json::to_string_pretty(&json!({
                "version": 2,
                "councils": [climb]
            }))
            .unwrap(),
        )
        .unwrap();
        let loaded = store.read().unwrap();
        assert!(loaded.records.is_empty());
        assert_eq!(loaded.climb_records.len(), 1);
        assert_eq!(loaded.climb_records[0]["phase"], "setup");

        store
            .write(&loaded.records, &loaded.climb_records, true)
            .unwrap();
        let again = store.read().unwrap();
        assert_eq!(again.climb_records.len(), 1);
        assert_eq!(again.climb_records[0]["goal"], "Improve perf");
    }

    #[test]
    fn review_assignments_and_counts_match_spec() {
        let three = vec!["A".into(), "B".into(), "C".into()];
        let plan3 = review_assignments(&three, &three);
        assert_eq!(plan3["A"], vec!["B", "C"]);
        assert_eq!(plan3["B"], vec!["C", "A"]);
        assert_eq!(plan3["C"], vec!["A", "B"]);

        let four = vec!["A".into(), "B".into(), "C".into(), "D".into()];
        let plan4 = review_assignments(&four, &four);
        assert_eq!(plan4["A"], vec!["B", "C"]);
        assert_eq!(plan4["D"], vec!["A", "B"]);

        let mut answers = BTreeMap::new();
        answers.insert(
            "A".into(),
            Some(CouncilAnswer {
                answer: "Use SQLite".into(),
                findings: vec![CouncilAnswerFinding {
                    id: "A1".into(),
                    kind: CouncilFindingKind::Observed,
                    evidence: Some("src/db.rs:10".into()),
                    quote: None,
                    claim: "Fast reads".into(),
                }],
                challenges: vec![],
            }),
        );
        answers.insert(
            "B".into(),
            Some(CouncilAnswer {
                answer: "Use JSON".into(),
                findings: vec![],
                challenges: vec![],
            }),
        );
        answers.insert(
            "C".into(),
            Some(CouncilAnswer {
                answer: "Use SQLite".into(),
                findings: vec![],
                challenges: vec![],
            }),
        );

        let rev_b = CouncilReview {
            ranking: Some(vec!["A".into(), "C".into()]),
            findings: vec![CouncilReviewFinding {
                id: "A1".into(),
                verdict: CouncilReviewVerdict::Confirmed,
            }],
            supports: Some("A".into()),
            added: vec![],
            scores: vec![],
            favourites: vec!["A1".into()],
            answer: Some("changed".into()),
            new_answer: Some("SQLite".into()),
            evidence: vec!["src/db.rs:10".into()],
        };
        let rev_c = CouncilReview {
            ranking: Some(vec!["A".into(), "B".into()]),
            findings: vec![CouncilReviewFinding {
                id: "A1".into(),
                verdict: CouncilReviewVerdict::Rejected,
            }],
            supports: Some("A".into()),
            added: vec![],
            scores: vec![],
            favourites: vec![],
            answer: Some("same".into()),
            new_answer: None,
            evidence: vec![],
        };
        let reviews = vec![
            CountedReview {
                reader: "B",
                assigned: &plan3["B"],
                block: Some(&rev_b),
            },
            CountedReview {
                reader: "C",
                assigned: &plan3["C"],
                block: Some(&rev_c),
            },
            CountedReview {
                reader: "A",
                assigned: &plan3["A"],
                block: None,
            },
        ];
        let counts = council_counts(&answers, &reviews);
        assert_eq!(counts.answered, 3);
        assert!(counts.partial);
        assert_eq!(counts.rankings[0].letter, "A");
        assert_eq!(counts.rankings[0].first, 2);
        assert_eq!(counts.rankings[0].of, 2);
        assert_eq!(counts.findings[0].finding, "A1");
        assert_eq!(counts.findings[0].confirmed, 1);
        assert_eq!(counts.findings[0].rejected, 1);
        assert_eq!(counts.findings[0].of, 2);
        assert_eq!(counts.supports[0].letter, "A");
        assert_eq!(counts.supports[0].count, 2);
        assert_eq!(counts.changed, vec!["B"]);
    }

    #[test]
    fn full_stage_machine_and_recovery_lifecycle() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("councils.json");
        let cid = "00000000-0000-4000-8000-000000000099";
        fs::write(&file, serde_json::to_string_pretty(&sample_v1_json(cid)).unwrap()).unwrap();

        let mut mgr = CouncilManager::new(dir.path());
        let open = mgr.recover_at(1_760_000_000_000);
        assert_eq!(open, vec![cid.to_string()]);
        // Dispatching turn recovered as unconfirmed/unknown.
        assert_eq!(
            mgr.records()[0].turns[0].delivery,
            CouncilDelivery::Unconfirmed
        );
        assert_eq!(
            mgr.records()[0].turns[0].outcome,
            Some(CouncilTurnOutcome::Unknown)
        );

        // Row actions should offer retry, replace, skip for chair framing.
        let actions = row_actions(
            &mgr.records()[0],
            &mgr.records()[0].turns[0],
            1_760_000_000_000,
            false,
        );
        assert_eq!(
            actions,
            vec![
                CouncilRowAction::Retry,
                CouncilRowAction::Replace,
                CouncilRowAction::Skip
            ]
        );

        // Skip chair framing -> fallback advances to answers and queues A & B!
        let ctx = CouncilCommandContext::default();
        let skip_res = mgr.command_at(
            CouncilCommand::Skip {
                council: cid.into(),
                turn: "11111111-1111-4111-8111-111111111111".into(),
            },
            &ctx,
            1_760_000_001_000,
        );
        assert!(matches!(skip_res.result, CouncilCommandResult::Ok { .. }));
        assert_eq!(mgr.records()[0].rounds[0].stage, CouncilStage::Answers);
        assert_eq!(mgr.records()[0].rounds[0].framing_fallback, Some(true));
        let answer_turns: Vec<&CouncilTurn> = mgr.records()[0]
            .turns
            .iter()
            .filter(|t| t.stage == CouncilTurnStage::Answer && t.superseded != Some(true))
            .collect();
        assert_eq!(answer_turns.len(), 2);

        // Reframe during answers supersedes old answer turns and queues fresh ones.
        let ref_res = mgr.command_at(
            CouncilCommand::Reframe {
                council: cid.into(),
                kinds: Some(vec![CouncilKind::Fact]),
                research: Some(true),
                criteria: Some(vec!["Latency under 5ms".into()]),
            },
            &ctx,
            1_760_000_002_000,
        );
        assert!(matches!(ref_res.result, CouncilCommandResult::Ok { .. }));
        assert_eq!(
            mgr.records()[0].rounds[0].kinds,
            Some(vec![CouncilKind::Fact])
        );
        assert_eq!(mgr.records()[0].rounds[0].research, Some(true));

        // Disable history, reload a fresh manager: open Council with missing question stops with words-lost!
        mgr.set_history_enabled(false).unwrap();
        let mut mgr2 = CouncilManager::new(dir.path());
        mgr2.recover_at(1_760_000_005_000);
        assert_eq!(
            mgr2.records()[0].stopped_because,
            Some(CouncilStoppedBecause::WordsLost)
        );
        assert!(mgr2.records()[0].stopped_at.is_some());
    }
}
