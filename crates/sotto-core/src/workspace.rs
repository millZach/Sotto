use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::stores::StoredMessage;

pub const ACTIVE_PROVIDERS: &[&str] = &[
    "codex",
    "claude",
    "grok",
    "devin",
    "muse",
    "opencode",
    "cursor",
    "deepseek",
    "hermes",
    "antigravity",
];

/// Full provider ID list matching Node's `providerIdSchema` (`src/shared/providerIds.ts`),
/// including `pi` so Disconnect-all and legacy migration never leave unadapted Node providers on.
pub const ALL_PROVIDER_IDS: &[&str] = &[
    "codex",
    "claude",
    "grok",
    "devin",
    "muse",
    "opencode",
    "cursor",
    "deepseek",
    "hermes",
    "antigravity",
    "pi",
];

const REASONING_VALUES: &[&str] = &["none", "codex", "claude", "grok", "openrouter", "openai"];
const ULTRACODE_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const ANTIGRAVITY_SIGN_IN_METHODS: &[&str] = &[
    "oauth-personal",
    "oauth-business",
    "gemini-api-key",
    "agent-platform",
];
const AGENT_SPEEDS: &[&str] = &["fast", "ultrafast"];
const AGENT_RUNTIME_MODES: &[&str] = &[
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
];

pub fn provider_label(provider: &str) -> &'static str {
    match provider {
        "codex" => "Codex",
        "claude" => "Claude Code",
        "grok" => "Grok Build",
        "devin" => "Devin",
        "muse" => "Muse",
        "opencode" => "OpenCode",
        "cursor" => "Cursor",
        "deepseek" => "DeepSeek",
        "hermes" => "Hermes",
        "antigravity" => "Antigravity",
        _ => "Unknown",
    }
}

pub fn public_provider_entity_id(provider: &str, kind: &str, raw_id: &str) -> String {
    format!("native:{provider}:{kind}:{raw_id}")
}

pub fn parse_public_provider_entity_id(id: &str) -> Option<(&str, &str, &str)> {
    let rest = id.strip_prefix("native:")?;
    let (provider, rest) = rest.split_once(':')?;
    let (kind, raw_id) = rest.split_once(':')?;
    (!provider.is_empty() && !kind.is_empty() && !raw_id.is_empty()).then_some((provider, kind, raw_id))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configure_thread: Option<bool>,
    pub interrupt: bool,
    pub message_origin: bool,
    pub observe: bool,
    pub permissions: bool,
    pub projects: bool,
    pub questions: bool,
    pub reconcile: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steer: Option<bool>,
    pub submit: bool,
    pub threads: bool,
}

impl AgentCapabilities {
    pub fn none() -> Self {
        Self::default()
    }

    pub fn full() -> Self {
        Self {
            compact: Some(true),
            configure_thread: Some(true),
            interrupt: true,
            message_origin: true,
            observe: true,
            permissions: true,
            projects: true,
            questions: true,
            reconcile: true,
            skills: Some(true),
            steer: Some(true),
            submit: true,
            threads: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderStatus {
    pub id: String,
    pub name: String,
    pub connection: String,
    pub version: String,
    pub capabilities: AgentCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl AgentProviderStatus {
    pub fn held(id: &str) -> Self {
        let name = provider_label(id);
        Self {
            id: id.to_string(),
            name: name.to_string(),
            connection: "error".into(),
            version: String::new(),
            capabilities: AgentCapabilities::none(),
            error: Some(format!("{name} is available in Sotto Owl; it is not in this build.")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModel {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub provider_id: String,
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_efforts: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_modes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_modes: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_images: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProject {
    pub id: String,
    pub title: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_settled_at: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentThreadSummaryMessage {
    pub id: String,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentThreadSummary {
    pub message_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_user: Option<AgentThreadSummaryMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_assistant: Option<AgentThreadSummaryMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running_turn_started_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnRecord {
    pub id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentThreadWorktree {
    pub mode: String,
    #[serde(default = "default_worktree_status")]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_from_origin: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub existing_worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reused: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temporary_branch: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<Value>,
}

fn default_worktree_status() -> String {
    "ready".into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentThread {
    pub id: String,
    pub project_id: String,
    #[serde(default)]
    pub provider_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub status: String,
    #[serde(default)]
    pub model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_mode: Option<String>,
    #[serde(default)]
    pub native_session_started: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_settled_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegated_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_user_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_turn: Option<AgentTurnRecord>,
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub requests: Vec<Value>,
    #[serde(default)]
    pub activities: Vec<Value>,
    #[serde(default)]
    pub summary: AgentThreadSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<AgentThreadWorktree>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDelivery {
    pub command_id: String,
    pub draft_id: String,
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_feedback_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_latency_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveredDraft {
    pub draft_id: String,
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientUpdateRow {
    pub id: String,
    pub installed: String,
    pub behind: bool,
    pub can_install: bool,
    pub channel: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentConfiguration {
    pub antigravity_binary_path: String,
    pub antigravity_location: String,
    pub antigravity_project: String,
    pub antigravity_sign_in_method: String,
    pub check_client_updates: bool,
    pub claude_ultracode_effort: String,
    pub default_model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disconnected_providers: Option<Vec<String>>,
    pub enabled: bool,
    pub enabled_providers: Vec<String>,
    pub followup_limit: u32,
    pub grok_speech_voice: String,
    pub membership_endpoint: String,
    pub muse_disable_sandbox: bool,
    pub new_thread_model_id: String,
    pub new_thread_reasoning_effort: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_thread_runtime_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_thread_speed: Option<String>,
    pub orb_color: String,
    pub projects_directory: String,
    pub provider: String,
    pub reasoning: String,
    pub reasoning_effort: String,
    pub reasoning_model: String,
    pub speak: bool,
    pub speech_provider: String,
    pub speech_voice: String,
    pub wake_model_directory: String,
    pub wake_runtime_directory: String,
}

impl Default for AgentConfiguration {
    fn default() -> Self {
        Self {
            antigravity_binary_path: String::new(),
            antigravity_location: String::new(),
            antigravity_project: String::new(),
            antigravity_sign_in_method: "oauth-personal".into(),
            check_client_updates: true,
            claude_ultracode_effort: "xhigh".into(),
            default_model_id: String::new(),
            disconnected_providers: None,
            enabled: false,
            enabled_providers: vec![
                "codex".into(),
                "claude".into(),
                "grok".into(),
                "devin".into(),
                "muse".into(),
                "opencode".into(),
                "cursor".into(),
                "hermes".into(),
            ],
            followup_limit: 5,
            grok_speech_voice: "altair".into(),
            membership_endpoint: String::new(),
            muse_disable_sandbox: false,
            new_thread_model_id: String::new(),
            new_thread_reasoning_effort: String::new(),
            new_thread_runtime_mode: None,
            new_thread_speed: None,
            orb_color: "teal".into(),
            projects_directory: String::new(),
            provider: "codex".into(),
            reasoning: "none".into(),
            reasoning_effort: String::new(),
            reasoning_model: String::new(),
            speak: false,
            speech_provider: "grok".into(),
            speech_voice: "F1".into(),
            wake_model_directory: String::new(),
            wake_runtime_directory: String::new(),
        }
    }
}

fn validate_provider_id_list(arr: &[Value], field: &str) -> Result<Vec<String>, String> {
    if arr.len() > ALL_PROVIDER_IDS.len() {
        return Err(format!("{field} has too many providers."));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let Some(id) = item.as_str() else {
            return Err(format!("{field} entries must be provider names."));
        };
        if !ALL_PROVIDER_IDS.contains(&id) {
            return Err(format!("Unknown provider in {field}: {id}"));
        }
        if !seen.insert(id) {
            return Err(format!("Choose each provider once in {field}."));
        }
        out.push(id.to_string());
    }
    Ok(out)
}

fn validate_str_max<'a>(val: &'a Value, field: &str, max_u16: usize) -> Result<&'a str, String> {
    let Some(s) = val.as_str() else {
        return Err(format!("{field} must be text."));
    };
    if s.encode_utf16().count() > max_u16 {
        return Err(format!("{field} is too long."));
    }
    Ok(s)
}

impl AgentConfiguration {
    /// Replaces `disconnected_providers` in `ALL_PROVIDER_IDS` order (preserving any unknown future
    /// provider IDs in sorted order, and storing `None` when empty to match `withTurnedOff` in
    /// `src/main/agents/control.ts`). Updates `enabled_providers` to the subset of `available` not
    /// turned off when `available` is non-empty; leaves `enabled_providers` untouched when no
    /// providers are loaded so an unconfigured host never writes `enabledProviders: []` and triggers
    /// legacy all-off migration on its next start.
    pub fn set_disconnected_providers(&mut self, off: &HashSet<&str>, available: &[String]) {
        let mut ordered: Vec<String> = ALL_PROVIDER_IDS
            .iter()
            .filter(|provider| off.contains(*provider))
            .map(|provider| (*provider).to_string())
            .collect();
        let mut unknown: Vec<String> = off
            .iter()
            .filter(|provider| !ALL_PROVIDER_IDS.contains(*provider))
            .map(|provider| (*provider).to_string())
            .collect();
        unknown.sort();
        ordered.extend(unknown);
        self.disconnected_providers = if ordered.is_empty() { None } else { Some(ordered) };
        if !available.is_empty() {
            self.enabled_providers = available
                .iter()
                .filter(|provider| !off.contains(provider.as_str()))
                .cloned()
                .collect();
        }
    }

    /// Mirrors `turnedOff` + `withTurnedOff` in `src/main/agents/control.ts` (ADR-0036).
    pub fn mark_providers_turned_off(&mut self, off: &[&str], on: &[&str], available: &[String]) {
        let existing: Vec<String> = self.disconnected_providers.clone().unwrap_or_default();
        let mut next: HashSet<&str> = existing.iter().map(String::as_str).collect();
        for &provider in off {
            next.insert(provider);
        }
        for &provider in on {
            next.remove(provider);
        }
        self.set_disconnected_providers(&next, available);
    }

    /// Serializes configuration strictly matching Node's `agentConfigurationSchema` (`src/shared/agents.ts`)
    /// for writing into `agents.json`, omitting legacy Rust-only fields (`followupLimit`, `orbColor`,
    /// retired voice fields) that Node's `.strict()` schema rejects on fallback.
    pub fn to_node_agents_json(&self, extra: &Map<String, Value>) -> Value {
        let mut obj = extra.clone();
        obj.insert("provider".into(), json!(self.provider));
        obj.insert("enabledProviders".into(), json!(self.enabled_providers));
        match &self.disconnected_providers {
            Some(off) if !off.is_empty() => {
                obj.insert("disconnectedProviders".into(), json!(off));
            }
            _ => {
                obj.remove("disconnectedProviders");
            }
        }
        obj.insert("enabled".into(), json!(self.enabled));
        obj.insert("projectsDirectory".into(), json!(self.projects_directory));
        obj.insert("defaultModelId".into(), json!(self.default_model_id));
        obj.insert("reasoning".into(), json!(self.reasoning));
        obj.insert("reasoningModel".into(), json!(self.reasoning_model));
        obj.insert("reasoningEffort".into(), json!(self.reasoning_effort));
        obj.insert("checkClientUpdates".into(), json!(self.check_client_updates));
        obj.insert("museDisableSandbox".into(), json!(self.muse_disable_sandbox));
        obj.insert(
            "claudeUltracodeEffort".into(),
            json!(self.claude_ultracode_effort),
        );
        obj.insert(
            "antigravitySignInMethod".into(),
            json!(self.antigravity_sign_in_method),
        );
        obj.insert("antigravityProject".into(), json!(self.antigravity_project));
        obj.insert(
            "antigravityLocation".into(),
            json!(self.antigravity_location),
        );
        obj.insert(
            "antigravityBinaryPath".into(),
            json!(self.antigravity_binary_path),
        );
        obj.insert("newThreadModelId".into(), json!(self.new_thread_model_id));
        obj.insert(
            "newThreadReasoningEffort".into(),
            json!(self.new_thread_reasoning_effort),
        );
        match &self.new_thread_speed {
            Some(v) => {
                obj.insert("newThreadSpeed".into(), json!(v));
            }
            None => {
                obj.remove("newThreadSpeed");
            }
        }
        match &self.new_thread_runtime_mode {
            Some(v) => {
                obj.insert("newThreadRuntimeMode".into(), json!(v));
            }
            None => {
                obj.remove("newThreadRuntimeMode");
            }
        }
        Value::Object(obj)
    }

    /// Validates every field in `patch` against Node's strict `agentConfigurationSchema`
    /// (`src/shared/agents.ts`) before mutating `self`, refusing invalid values so `agents.json`
    /// can never be corrupted with values Node rejects on rollback.
    pub fn apply_patch(&mut self, patch: &Map<String, Value>) -> Result<(), String> {
        let mut next = self.clone();
        for (key, value) in patch {
            match key.as_str() {
                "provider" => {
                    let v = validate_str_max(value, "provider", 64)?;
                    if !ALL_PROVIDER_IDS.contains(&v) {
                        return Err(format!("Unknown provider: {v}"));
                    }
                    next.provider = v.to_string();
                }
                "enabledProviders" => {
                    let Some(arr) = value.as_array() else {
                        return Err("enabledProviders must be a list.".into());
                    };
                    next.enabled_providers = validate_provider_id_list(arr, "enabledProviders")?;
                }
                "disconnectedProviders" => {
                    let Some(arr) = value.as_array() else {
                        return Err("disconnectedProviders must be a list.".into());
                    };
                    let validated = validate_provider_id_list(arr, "disconnectedProviders")?;
                    let ordered: Vec<String> = ALL_PROVIDER_IDS
                        .iter()
                        .filter(|p| validated.iter().any(|v| v == *p))
                        .map(|p| (*p).to_string())
                        .collect();
                    next.disconnected_providers = if ordered.is_empty() { None } else { Some(ordered) };
                }
                "enabled" => {
                    next.enabled = value
                        .as_bool()
                        .ok_or_else(|| "enabled must be true or false.".to_string())?;
                }
                "checkClientUpdates" => {
                    next.check_client_updates = value
                        .as_bool()
                        .ok_or_else(|| "checkClientUpdates must be true or false.".to_string())?;
                }
                "museDisableSandbox" => {
                    next.muse_disable_sandbox = value
                        .as_bool()
                        .ok_or_else(|| "museDisableSandbox must be true or false.".to_string())?;
                }
                "projectsDirectory" => {
                    next.projects_directory = validate_str_max(value, "projectsDirectory", 4_096)?.to_string();
                }
                "defaultModelId" => {
                    next.default_model_id = validate_str_max(value, "defaultModelId", 6_144)?.to_string();
                }
                "reasoning" => {
                    let v = validate_str_max(value, "reasoning", 64)?;
                    if !REASONING_VALUES.contains(&v) {
                        return Err(format!("Invalid reasoning provider: {v}"));
                    }
                    next.reasoning = v.to_string();
                }
                "reasoningModel" => {
                    next.reasoning_model = validate_str_max(value, "reasoningModel", 512)?.to_string();
                }
                "reasoningEffort" => {
                    next.reasoning_effort = validate_str_max(value, "reasoningEffort", 64)?.to_string();
                }
                "claudeUltracodeEffort" => {
                    let v = validate_str_max(value, "claudeUltracodeEffort", 64)?;
                    if !ULTRACODE_EFFORTS.contains(&v) {
                        return Err(format!("Invalid claudeUltracodeEffort: {v}"));
                    }
                    next.claude_ultracode_effort = v.to_string();
                }
                "antigravitySignInMethod" => {
                    let v = validate_str_max(value, "antigravitySignInMethod", 64)?;
                    if !ANTIGRAVITY_SIGN_IN_METHODS.contains(&v) {
                        return Err(format!("Invalid antigravitySignInMethod: {v}"));
                    }
                    next.antigravity_sign_in_method = v.to_string();
                }
                "antigravityProject" => {
                    next.antigravity_project = validate_str_max(value, "antigravityProject", 256)?.to_string();
                }
                "antigravityLocation" => {
                    next.antigravity_location = validate_str_max(value, "antigravityLocation", 64)?.to_string();
                }
                "antigravityBinaryPath" => {
                    next.antigravity_binary_path = validate_str_max(value, "antigravityBinaryPath", 4_096)?.to_string();
                }
                "newThreadModelId" => {
                    next.new_thread_model_id = validate_str_max(value, "newThreadModelId", 6_144)?.to_string();
                }
                "newThreadReasoningEffort" => {
                    next.new_thread_reasoning_effort = validate_str_max(value, "newThreadReasoningEffort", 64)?.to_string();
                }
                "newThreadRuntimeMode" => {
                    if value.is_null() {
                        next.new_thread_runtime_mode = None;
                    } else {
                        let v = validate_str_max(value, "newThreadRuntimeMode", 64)?;
                        if !AGENT_RUNTIME_MODES.contains(&v) {
                            return Err(format!("Invalid newThreadRuntimeMode: {v}"));
                        }
                        next.new_thread_runtime_mode = Some(v.to_string());
                    }
                }
                "newThreadSpeed" => {
                    if value.is_null() {
                        next.new_thread_speed = None;
                    } else {
                        let v = validate_str_max(value, "newThreadSpeed", 64)?;
                        if !AGENT_SPEEDS.contains(&v) {
                            return Err(format!("Invalid newThreadSpeed: {v}"));
                        }
                        next.new_thread_speed = Some(v.to_string());
                    }
                }
                other => {
                    return Err(format!("Unknown configuration setting: {other}"));
                }
            }
        }
        *self = next;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentThreadDetail {
    pub thread_id: String,
    pub revision: u64,
    pub messages: Vec<StoredMessage>,
    pub activities: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub earlier_available: Option<bool>,
}

/// Computes `AgentThreadSummary` from messages, activities, and thread status (matching
/// `summarizeThread` and #2697's `runningTurnStartedAt` rule).
pub fn summarize_thread(
    messages: &[StoredMessage],
    activities: &[Value],
    status: &str,
) -> AgentThreadSummary {
    let last_user = messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| AgentThreadSummaryMessage {
            id: m.id.clone(),
            text: m.text.clone(),
            created_at: m.created_at.clone(),
        });
    let last_assistant = messages
        .iter()
        .rev()
        .find(|m| m.role == "assistant")
        .map(|m| AgentThreadSummaryMessage {
            id: m.id.clone(),
            text: m.text.clone(),
            created_at: m.created_at.clone(),
        });
    let running_turn_started_at = if status == "running" {
        activities
            .iter()
            .rev()
            .find(|a| {
                a.get("kind").and_then(Value::as_str) == Some("turn")
                    && a.get("status").and_then(Value::as_str) == Some("running")
            })
            .and_then(|a| a.get("startedAt").and_then(Value::as_str))
            .map(ToString::to_string)
    } else {
        None
    };

    AgentThreadSummary {
        message_count: messages.len(),
        last_user,
        last_assistant,
        activity_count: (!activities.is_empty()).then_some(activities.len()),
        running_turn_started_at,
    }
}

/// Strips activity records to the `activity-summaries` wire shape for clients like the iPhone
/// (ADR-0025 October 3 amendment).
pub fn summarize_activity_for_wire(activity: &Value) -> Value {
    let Some(obj) = activity.as_object() else {
        return activity.clone();
    };
    let mut out = Map::new();
    for key in [
        "id",
        "kind",
        "sequence",
        "startedAt",
        "status",
        "title",
        "turnId",
        "parentId",
        "durationMs",
        "exitCode",
        "denied",
    ] {
        if let Some(val) = obj.get(key) {
            out.insert(key.to_string(), val.clone());
        }
    }
    Value::Object(out)
}

/// Computes an `AgentThreadDetailDelta` taking `base` to `next`, or `None` when a whole detail
/// must be sent instead (exact port of `diffAgentThreadDetail` in `src/shared/agentThreadDetail.ts`).
pub fn diff_thread_detail(base: &AgentThreadDetail, next: &AgentThreadDetail) -> Option<Value> {
    if base.thread_id != next.thread_id || next.revision <= base.revision {
        return None;
    }
    if next.messages.len() < base.messages.len() {
        return None;
    }
    let mut message_deltas = Vec::new();
    for (idx, held) in base.messages.iter().enumerate() {
        let msg = &next.messages[idx];
        if msg.id != held.id {
            return None;
        }
        if msg == held {
            continue;
        }
        let mut without_text = msg.clone();
        without_text.text = held.text.clone();
        if msg.text.len() > held.text.len()
            && msg.text.starts_with(&held.text)
            && without_text == *held
        {
            message_deltas.push(json!({
                "id": held.id,
                "appendText": &msg.text[held.text.len()..],
            }));
        } else {
            message_deltas.push(json!({ "message": msg }));
        }
    }
    for msg in &next.messages[base.messages.len()..] {
        message_deltas.push(json!({ "message": msg }));
    }

    let held_map: HashMap<&str, &Value> = base
        .activities
        .iter()
        .filter_map(|a| a.get("id").and_then(Value::as_str).map(|id| (id, a)))
        .collect();
    let next_ids: HashSet<&str> = next
        .activities
        .iter()
        .filter_map(|a| a.get("id").and_then(Value::as_str))
        .collect();

    let mut activity_deltas = Vec::new();
    for rec in &base.activities {
        if let Some(id) = rec.get("id").and_then(Value::as_str) {
            if !next_ids.contains(id) {
                activity_deltas.push(json!({ "id": id, "removed": true }));
            }
        }
    }
    for rec in &next.activities {
        let id = rec.get("id").and_then(Value::as_str)?;
        if held_map.get(id).copied() == Some(rec) {
            continue;
        }
        activity_deltas.push(json!({ "record": rec }));
    }

    // Verify order matches after applying removals/upserts (if reordered, fall back to whole).
    let mut simulated: Vec<String> = base
        .activities
        .iter()
        .filter_map(|a| a.get("id").and_then(Value::as_str).map(ToString::to_string))
        .filter(|id| next_ids.contains(id.as_str()))
        .collect();
    let existing: HashSet<String> = simulated.iter().cloned().collect();
    for rec in &next.activities {
        if let Some(id) = rec.get("id").and_then(Value::as_str) {
            if !existing.contains(id) {
                simulated.push(id.to_string());
            }
        }
    }
    let expected_order: Vec<String> = next
        .activities
        .iter()
        .filter_map(|a| a.get("id").and_then(Value::as_str).map(ToString::to_string))
        .collect();
    if simulated != expected_order {
        return None;
    }

    Some(json!({
        "threadId": next.thread_id,
        "baseRevision": base.revision,
        "revision": next.revision,
        "messageDeltas": message_deltas,
        "activityDeltas": activity_deltas,
    }))
}

pub const MAX_IMAGE_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_FILE_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_VIDEO_ATTACHMENT_BYTES: usize = 500 * 1024 * 1024;
pub const MAX_FILE_PART_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_FILE_PARTS: usize = 4;
pub const MAX_VIDEO_PARTS: usize = 63;
const MAX_PENDING_UPLOADS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedAttachmentHandle {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: usize,
    pub digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<Value>,
}

impl StagedAttachmentHandle {
    pub fn is_image(&self) -> bool {
        self.mime_type.to_ascii_lowercase().starts_with("image/")
    }
}

#[derive(Debug, Clone)]
pub struct StagedAttachmentEntry {
    pub handle: StagedAttachmentHandle,
    pub path: PathBuf,
}

#[derive(Default)]
struct PendingFileUpload {
    name: String,
    mime_type: String,
    size_bytes: usize,
    digest: String,
    count: usize,
    received_bytes: usize,
    parts: BTreeMap<usize, Vec<u8>>,
}

/// Stages remote images (`stage-attachment`) and chunked files (`stage-file-part`) on disk under
/// `<data>/staged-attachments/`, matching ADR-0031 and ADR-0131.
pub struct StagedAttachments {
    directory: PathBuf,
    entries: HashMap<String, StagedAttachmentEntry>,
    uploads: HashMap<String, PendingFileUpload>,
}

impl StagedAttachments {
    pub fn new(data_directory: &Path) -> Self {
        Self {
            directory: data_directory.join("staged-attachments"),
            entries: HashMap::new(),
            uploads: HashMap::new(),
        }
    }

    pub fn stage_image(
        &mut self,
        name: &str,
        mime_type: &str,
        data_b64: &str,
        dimensions: Option<Value>,
    ) -> Result<StagedAttachmentHandle, String> {
        let allowed_mime = matches!(
            mime_type,
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        );
        if !allowed_mime {
            return Err("Only PNG, JPEG, WebP, and GIF images can be attached.".into());
        }
        let max_b64 = MAX_IMAGE_ATTACHMENT_BYTES.div_ceil(3) * 4;
        if data_b64.len() > max_b64 {
            return Err("Attachment image size is out of bounds.".into());
        }
        let bytes = STANDARD
            .decode(data_b64)
            .map_err(|_| "Attachment image data is not valid base64.".to_string())?;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_ATTACHMENT_BYTES {
            return Err("Attachment image size is out of bounds.".into());
        }
        let digest = sha256_hex(&bytes);
        let id = Uuid::new_v4().to_string();
        fs::create_dir_all(&self.directory).map_err(|e| e.to_string())?;
        let file_path = self.directory.join(format!("{id}.bin"));
        fs::write(&file_path, &bytes).map_err(|e| e.to_string())?;
        let handle = StagedAttachmentHandle {
            id: id.clone(),
            name: name.to_string(),
            mime_type: mime_type.to_string(),
            size_bytes: bytes.len(),
            digest,
            dimensions,
        };
        self.entries.insert(
            id,
            StagedAttachmentEntry {
                handle: handle.clone(),
                path: file_path,
            },
        );
        Ok(handle)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn stage_file_part(
        &mut self,
        upload_id: &str,
        index: usize,
        count: usize,
        name: &str,
        mime_type: &str,
        size_bytes: usize,
        digest: &str,
        data_b64: &str,
    ) -> Result<Option<StagedAttachmentHandle>, String> {
        let is_video = mime_type.to_ascii_lowercase().starts_with("video/");
        let max_size = if is_video {
            MAX_VIDEO_ATTACHMENT_BYTES
        } else {
            MAX_FILE_ATTACHMENT_BYTES
        };
        let max_parts = if is_video {
            MAX_VIDEO_PARTS
        } else {
            MAX_FILE_PARTS
        };
        if size_bytes == 0 || size_bytes > max_size {
            return Err("Uploaded file exceeds the allowed size limit.".into());
        }
        if count == 0 || count > max_parts || index >= count {
            return Err("Invalid file upload part index.".into());
        }
        let max_part_b64 = MAX_FILE_PART_BYTES.div_ceil(3) * 4;
        if data_b64.is_empty() || data_b64.len() > max_part_b64 {
            return Err("File upload part exceeds the maximum part size.".into());
        }
        let bytes = STANDARD
            .decode(data_b64)
            .map_err(|_| "File part data is not valid base64.".to_string())?;
        if bytes.is_empty() || bytes.len() > MAX_FILE_PART_BYTES {
            return Err("File upload part exceeds the maximum part size.".into());
        }
        if !self.uploads.contains_key(upload_id) && self.uploads.len() >= MAX_PENDING_UPLOADS {
            return Err("Too many file uploads are in progress.".into());
        }
        let pending = self
            .uploads
            .entry(upload_id.to_string())
            .or_insert_with(|| PendingFileUpload {
                name: name.to_string(),
                mime_type: mime_type.to_string(),
                size_bytes,
                digest: digest.to_string(),
                count,
                received_bytes: 0,
                parts: BTreeMap::new(),
            });
        if pending.count != count
            || pending.size_bytes != size_bytes
            || pending.name != name
            || pending.mime_type != mime_type
            || !pending.digest.eq_ignore_ascii_case(digest)
        {
            self.uploads.remove(upload_id);
            return Err("File upload metadata changed between parts.".into());
        }
        let prev_len = pending.parts.get(&index).map(|v| v.len()).unwrap_or(0);
        let next_total = pending
            .received_bytes
            .saturating_sub(prev_len)
            .checked_add(bytes.len())
            .ok_or_else(|| "Uploaded file exceeds the declared size.".to_string())?;
        if next_total > pending.size_bytes || next_total > max_size {
            self.uploads.remove(upload_id);
            return Err("Uploaded file exceeds the declared size.".into());
        }
        pending.received_bytes = next_total;
        pending.parts.insert(index, bytes);
        if pending.parts.len() < pending.count {
            return Ok(None);
        }
        let completed = self.uploads.remove(upload_id).unwrap();
        let actual_total: usize = completed.parts.values().map(Vec::len).sum();
        if actual_total != completed.size_bytes || actual_total > max_size {
            return Err("Uploaded file size does not match declared size.".into());
        }
        let mut combined = Vec::with_capacity(actual_total);
        for idx in 0..completed.count {
            if let Some(chunk) = completed.parts.get(&idx) {
                combined.extend_from_slice(chunk);
            }
        }
        let actual_digest = sha256_hex(&combined);
        if !actual_digest.eq_ignore_ascii_case(&completed.digest) {
            return Err("Uploaded file checksum does not match.".into());
        }
        let id = Uuid::new_v4().to_string();
        fs::create_dir_all(&self.directory).map_err(|e| e.to_string())?;
        let file_path = self.directory.join(format!("{id}.bin"));
        fs::write(&file_path, &combined).map_err(|e| e.to_string())?;
        let handle = StagedAttachmentHandle {
            id: id.clone(),
            name: completed.name,
            mime_type: completed.mime_type,
            size_bytes: combined.len(),
            digest: actual_digest,
            dimensions: None,
        };
        self.entries.insert(
            id,
            StagedAttachmentEntry {
                handle: handle.clone(),
                path: file_path,
            },
        );
        Ok(Some(handle))
    }

    pub fn get(&self, id: &str) -> Option<&StagedAttachmentEntry> {
        self.entries.get(id)
    }

    pub fn get_by_digest(&self, digest: &str) -> Option<&StagedAttachmentEntry> {
        self.entries
            .values()
            .find(|e| e.handle.digest.eq_ignore_ascii_case(digest))
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

pub fn write_atomic_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    let temp = path.with_extension(format!("json.tmp-{}", Uuid::new_v4()));
    let res = (|| -> std::io::Result<()> {
        let mut opts = OpenOptions::new();
        opts.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&temp)?;
        file.write_all(body.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&temp);
    }
    res
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn computes_append_and_activity_deltas_accurately() {
        let base = AgentThreadDetail {
            thread_id: "t1".into(),
            revision: 1,
            messages: vec![StoredMessage {
                id: "m1".into(),
                role: "assistant".into(),
                text: "Hello".into(),
                created_at: "2026-11-21T00:00:00.000Z".into(),
                command_id: None,
                turn_message_id: None,
                attachments: None,
                watcher_own_change: None,
                watcher_observed_changes: None,
                provider_error: None,
            }],
            activities: vec![json!({ "id": "a1", "kind": "turn", "status": "running", "title": "Working" })],
            earlier_available: None,
        };
        let next = AgentThreadDetail {
            thread_id: "t1".into(),
            revision: 2,
            messages: vec![StoredMessage {
                text: "Hello world".into(),
                ..base.messages[0].clone()
            }],
            activities: vec![json!({ "id": "a1", "kind": "turn", "status": "completed", "title": "Turn completed" })],
            earlier_available: None,
        };
        let delta = diff_thread_detail(&base, &next).unwrap();
        assert_eq!(delta["baseRevision"], 1);
        assert_eq!(delta["revision"], 2);
        assert_eq!(delta["messageDeltas"][0]["id"], "m1");
        assert_eq!(delta["messageDeltas"][0]["appendText"], " world");
        assert_eq!(delta["activityDeltas"][0]["record"]["status"], "completed");
    }

    #[test]
    fn stages_images_and_chunked_files_with_checksum_verification() {
        let dir = tempdir().unwrap();
        let mut staged = StagedAttachments::new(dir.path());
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let img = staged
            .stage_image("Referee.png", "image/png", png, None)
            .unwrap();
        assert_eq!(img.mime_type, "image/png");
        assert!(staged.get(&img.id).is_some());
        let serialized = serde_json::to_value(&img).unwrap();
        assert!(serialized.get("kind").is_none());

        let content = b"Referee notes\nsecond line\n";
        let digest = sha256_hex(content);
        let handle = staged
            .stage_file_part(
                "u1",
                0,
                1,
                "Referee notes.txt",
                "text/plain",
                content.len(),
                &digest,
                &STANDARD.encode(content),
            )
            .unwrap()
            .unwrap();
        assert_eq!(handle.size_bytes, content.len());

        // Oversized sizeBytes declaration must be rejected cleanly before allocation (no panic).
        let huge = staged.stage_file_part(
            "u-huge",
            0,
            1,
            "huge.txt",
            "text/plain",
            usize::MAX,
            &digest,
            &STANDARD.encode(b"x"),
        );
        assert!(huge.is_err());
    }
}
