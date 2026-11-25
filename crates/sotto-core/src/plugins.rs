//! Local plugin stores and state machines (ADR-0205, ADR-0141) matching:
//! - `src/main/plugins/accounts.ts` (`plugin-accounts.json` v1–v6)
//! - `src/main/plugins/useRecord.ts` (`plugin-use.json` v1)
//! - `src/main/plugins/mailGrants.ts` (`plugin-mail-grants.json` v1)
//! - `src/main/plugins/copySync.ts` (`plugin-account-copy-choices.json` v1)
//! - `src/main/plugins/spending.ts` (`plugin-meshy-spending.json`, `plugin-elevenlabs-spending.json`)
//! - `src/main/tools/meshy/records.ts` (`3d-models.json` v1)
//! - `src/main/tools/elevenlabs/records.ts` (`sounds.json` v1)
//! - `src/main/plugins/github/signIn.ts` (`gh auth status`)
//! - `src/main/plugins/pendingChanges.ts` (`PluginChangeRequests`)
//!
//! Uses exact on-disk JSON schemas so TypeScript and Rust interoperate transparently over
//! the same user-data directory. No secret is ever written to JSON, returned to a renderer,
//! or logged.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use chrono::{DateTime, Datelike, Local, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::workspace::now_iso;

pub const PLUGIN_ACCOUNTS_MAX: usize = 10;
pub const PLUGIN_ACCOUNT_NAME_MAX: usize = 40;
pub const PLUGIN_SECRET_MAX: usize = 1_000;
pub const PLUGIN_ACCOUNT_PROJECTS_MAX: usize = 200;
pub const PLUGIN_MONTHLY_LIMIT_MAX: u64 = 1_000_000;
pub const MESHY_MONTHLY_LIMIT_DEFAULT: u64 = 1_000;
pub const ELEVENLABS_MONTHLY_LIMIT_DEFAULT: u64 = 10;
pub const PLUGIN_USE_KEPT: usize = 200;
pub const MAIL_GRANTS_MAX: usize = 500;
pub const MODEL_RECORDS_KEPT: usize = 2_000;
pub const SOUND_RECORDS_KEPT: usize = 2_000;
pub const PLUGIN_CHANGE_PREFIX: &str = "sotto:plugin-change:";
const SPENT_KEPT_MS: i64 = 62 * 24 * 60 * 60 * 1000;
const EARLIER_SUFFIX: &str = "#earlier";
const GH_HOST: &str = "github.com";
const GH_TIMEOUT: Duration = Duration::from_secs(15);

pub const ACCOUNT_PLUGIN_IDS: &[&str] = &["vercel", "gmail", "proton-mail", "meshy", "elevenlabs"];
pub const MAIL_PLUGIN_IDS: &[&str] = &["gmail", "proton-mail"];
pub const SPENDING_PLUGIN_IDS: &[&str] = &["meshy", "elevenlabs"];

pub fn is_account_plugin(plugin: &str) -> bool {
    ACCOUNT_PLUGIN_IDS.contains(&plugin)
}

pub fn is_mail_plugin(plugin: &str) -> bool {
    MAIL_PLUGIN_IDS.contains(&plugin)
}

pub fn is_bridge_plugin(plugin: &str) -> bool {
    plugin == "proton-mail"
}

pub fn is_spending_plugin(plugin: &str) -> bool {
    SPENDING_PLUGIN_IDS.contains(&plugin)
}

pub fn plugin_account_slot(id: &str) -> String {
    format!("plugin:{id}")
}

/// Normalizes a pasted secret matching `pluginSecretAsKept` (`src/main/plugins/accounts.ts:48`).
pub fn plugin_secret_as_kept(plugin: &str, secret: &str) -> String {
    match plugin {
        "gmail" => secret.chars().filter(|c| !c.is_whitespace()).collect(),
        "meshy" | "elevenlabs" => secret.trim().to_string(),
        _ => secret.to_string(),
    }
}

pub fn same_account_name(one: &str, other: &str) -> bool {
    one.trim().to_lowercase() == other.trim().to_lowercase()
}

pub fn is_valid_account_name(name: &str) -> bool {
    let trimmed = name.trim();
    let count = trimmed.chars().count();
    (1..=PLUGIN_ACCOUNT_NAME_MAX).contains(&count)
        && trimmed.chars().all(|c| (c as u32) >= 0x20 && (c as u32) != 0x7f)
}

pub fn current_local_month() -> String {
    let now = Local::now();
    format!("{:04}-{:02}", now.year(), now.month())
}

pub fn month_of_rfc3339(ts: &str) -> Option<String> {
    let dt = DateTime::parse_from_rfc3339(ts).ok()?;
    let local = dt.with_timezone(&Local);
    Some(format!("{:04}-{:02}", local.year(), local.month()))
}

/// Adds the fields of `extra` that `value` does not already have, so a save keeps what Node wrote.
fn with_extra(mut value: Value, extra: &Map<String, Value>) -> Value {
    if let Value::Object(ref mut object) = value {
        for (key, held) in extra {
            object.entry(key.clone()).or_insert_with(|| held.clone());
        }
    }
    value
}

fn write_atomic_private_json_compact<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string(value).map_err(std::io::Error::other)?;
    let tmp = path.with_extension(format!("json.tmp-{}", Uuid::new_v4()));
    let write_res = (|| -> std::io::Result<()> {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&tmp)?;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(err) = write_res {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Plugin Accounts (`plugin-accounts.json` v1–v6)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSpending {
    pub ask_before: bool,
    pub monthly_limit: u64,
    /// Fields Node wrote that this build does not know, kept as they were.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginBridge {
    pub imap_port: u16,
    pub smtp_port: u16,
    pub certificate: String,
    /// Fields Node wrote that this build does not know, kept as they were.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAccount {
    pub id: String,
    pub plugin: String,
    pub name: String,
    pub saved_at: String,
    pub signed_in_as: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(default = "default_true")]
    pub on: bool,
    #[serde(default)]
    pub projects: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spending: Option<PluginSpending>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bridge: Option<PluginBridge>,
    /// Fields Node wrote that this build does not know, kept as they were.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl PluginAccount {
    pub fn admits(&self, project_id: Option<&str>) -> bool {
        if !self.on {
            return false;
        }
        match &self.projects {
            None => true,
            Some(list) => project_id.is_some_and(|pid| list.iter().any(|p| p == pid)),
        }
    }

    pub fn may_be_copied(&self) -> bool {
        self.projects.is_none() && !is_bridge_plugin(&self.plugin)
    }

    fn is_valid(&self) -> bool {
        if Uuid::parse_str(&self.id).is_err() || !is_account_plugin(&self.plugin) {
            return false;
        }
        if !is_valid_account_name(&self.name) || DateTime::parse_from_rfc3339(&self.saved_at).is_err()
        {
            return false;
        }
        if let Some(ref s) = self.signed_in_as {
            if s.chars().count() > 200 {
                return false;
            }
        }
        if let Some(ref list) = self.projects {
            if list.len() > PLUGIN_ACCOUNT_PROJECTS_MAX {
                return false;
            }
        }
        if let Some(ref sp) = self.spending {
            if sp.monthly_limit > PLUGIN_MONTHLY_LIMIT_MAX {
                return false;
            }
        }
        if let Some(ref br) = self.bridge {
            if br.imap_port == 0
                || br.smtp_port == 0
                || br.certificate.len() != 64
                || !br
                    .certificate
                    .bytes()
                    .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            {
                return false;
            }
        }
        true
    }
}

fn deserialize_double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAccountUpdate {
    pub id: String,
    #[serde(default)]
    pub on: Option<bool>,
    #[serde(default)]
    pub ask_before: Option<bool>,
    #[serde(default)]
    pub monthly_limit: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub projects: Option<Option<Vec<String>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PluginAccountResult {
    Ok { ok: bool, accounts: Vec<PluginAccount> },
    Err { ok: bool, problem: String },
}

impl PluginAccountResult {
    pub fn ok(accounts: Vec<PluginAccount>) -> Self {
        Self::Ok { ok: true, accounts }
    }

    pub fn err(problem: &str) -> Self {
        Self::Err {
            ok: false,
            problem: problem.to_string(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct PluginAccountsFileRaw {
    version: u32,
    accounts: Vec<Value>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// Manages `plugin-accounts.json` v1–v6 with exact TS serialization & version-bump parity.
pub struct PluginAccountsStore {
    path: PathBuf,
    accounts: Option<Vec<PluginAccount>>,
    file_extra: Map<String, Value>,
}

impl PluginAccountsStore {
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join("plugin-accounts.json"),
            accounts: None,
            file_extra: Map::new(),
        }
    }

    pub fn invalidate_cache(&mut self) {
        self.accounts = None;
    }

    /// Loads accounts filtered by `has_secret(slot)`. Refuses corrupt/unsupported files instead
    /// of silently returning empty (matching `PluginAccountsUnreadable`).
    pub fn load<F>(&mut self, has_secret: F) -> Result<Vec<PluginAccount>, String>
    where
        F: Fn(&str) -> bool,
    {
        if let Some(ref cached) = self.accounts {
            return Ok(cached
                .iter()
                .filter(|a| has_secret(&plugin_account_slot(&a.id)))
                .cloned()
                .collect());
        }
        let text = match fs::read_to_string(&self.path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.accounts = Some(Vec::new());
                return Ok(Vec::new());
            }
            Err(e) => return Err(format!("Plugin accounts unreadable: {e}")),
        };
        let raw: PluginAccountsFileRaw =
            serde_json::from_str(&text).map_err(|_| "Plugin accounts unreadable.".to_string())?;
        if !(1..=6).contains(&raw.version) {
            return Err("Plugin accounts file version is unsupported.".to_string());
        }
        self.file_extra = raw.extra;
        let mut parsed = Vec::new();
        for entry in raw.accounts {
            if let Ok(acc) = serde_json::from_value::<PluginAccount>(entry) {
                if acc.is_valid() {
                    parsed.push(acc);
                }
            }
        }
        self.accounts = Some(parsed.clone());
        Ok(parsed
            .into_iter()
            .filter(|a| has_secret(&plugin_account_slot(&a.id)))
            .collect())
    }

    /// Writes `plugin-accounts.json` omitting default `on: true` and `projects: null` and
    /// selecting the exact minimum version `1..=6` matching `PluginAccounts.write`.
    pub fn write(&mut self, accounts: &[PluginAccount]) -> Result<(), String> {
        let mut stored: Vec<Value> = Vec::with_capacity(accounts.len());
        let mut has_non_default_scope = false;
        let mut has_mail = false;
        let mut has_bridge = false;
        let mut has_meshy = false;
        let mut has_elevenlabs = false;

        for acc in accounts {
            if acc.plugin == "elevenlabs" {
                has_elevenlabs = true;
            } else if acc.plugin == "meshy" {
                has_meshy = true;
            } else if is_bridge_plugin(&acc.plugin) {
                has_bridge = true;
            } else if is_mail_plugin(&acc.plugin) {
                has_mail = true;
            }
            if !acc.on || acc.projects.is_some() {
                has_non_default_scope = true;
            }
            let mut obj = serde_json::Map::new();
            obj.insert("id".into(), json!(acc.id));
            obj.insert("plugin".into(), json!(acc.plugin));
            obj.insert("name".into(), json!(acc.name));
            obj.insert("savedAt".into(), json!(acc.saved_at));
            obj.insert("signedInAs".into(), json!(acc.signed_in_as));
            if let Some(ref addr) = acc.address {
                obj.insert("address".into(), json!(addr));
            }
            if !acc.on {
                obj.insert("on".into(), json!(false));
            }
            if let Some(ref projects) = acc.projects {
                obj.insert("projects".into(), json!(projects));
            }
            if let Some(ref sp) = acc.spending {
                obj.insert("spending".into(), json!(sp));
            }
            if let Some(ref br) = acc.bridge {
                obj.insert("bridge".into(), json!(br));
            }
            stored.push(with_extra(Value::Object(obj), &acc.extra));
        }

        let version: u32 = if has_elevenlabs {
            6
        } else if has_meshy {
            5
        } else if has_bridge {
            4
        } else if has_mail {
            3
        } else if has_non_default_scope {
            2
        } else {
            1
        };

        let payload = with_extra(json!({ "version": version, "accounts": stored }), &self.file_extra);
        write_atomic_private_json_compact(&self.path, &payload)
            .map_err(|e| format!("Could not write plugin-accounts.json: {e}"))?;
        self.accounts = Some(accounts.to_vec());
        Ok(())
    }

    pub fn update<F>(
        &mut self,
        request: &PluginAccountUpdate,
        has_secret: F,
    ) -> PluginAccountResult
    where
        F: Fn(&str) -> bool,
    {
        if request.on.is_none()
            && request.projects.is_none()
            && request.ask_before.is_none()
            && request.monthly_limit.is_none()
        {
            return PluginAccountResult::err("refused");
        }
        let Ok(mut accounts) = self.load(&has_secret) else {
            return PluginAccountResult::err("store");
        };
        let Some(pos) = accounts.iter().position(|a| a.id == request.id) else {
            return PluginAccountResult::err("gone");
        };
        let spending_change = request.ask_before.is_some() || request.monthly_limit.is_some();
        if spending_change && accounts[pos].spending.is_none() {
            return PluginAccountResult::err("refused");
        }
        if let Some(limit) = request.monthly_limit {
            if limit > PLUGIN_MONTHLY_LIMIT_MAX {
                return PluginAccountResult::err("refused");
            }
        }
        if let Some(on) = request.on {
            accounts[pos].on = on;
        }
        if spending_change {
            if let Some(ref mut sp) = accounts[pos].spending {
                if let Some(ask) = request.ask_before {
                    sp.ask_before = ask;
                }
                if let Some(limit) = request.monthly_limit {
                    sp.monthly_limit = limit;
                }
            }
        }
        if let Some(ref proj_opt) = request.projects {
            match proj_opt {
                None => accounts[pos].projects = None,
                Some(list) => {
                    if list.is_empty() || list.len() > PLUGIN_ACCOUNT_PROJECTS_MAX {
                        return PluginAccountResult::err("refused");
                    }
                    let mut seen = HashSet::new();
                    let mut deduped = Vec::with_capacity(list.len());
                    for p in list {
                        if seen.insert(p.clone()) {
                            deduped.push(p.clone());
                        }
                    }
                    accounts[pos].projects = Some(deduped);
                }
            }
        }
        if self.write(&accounts).is_err() {
            return PluginAccountResult::err("store");
        }
        PluginAccountResult::ok(accounts)
    }

    /// Removes `id` from `plugin-accounts.json` after its secret has already been cleared from
    /// the credential store (so `id` is matched against the raw stored records rather than filtered
    /// out by `has_secret`).
    pub fn remove_record_only<F>(&mut self, id: &str, has_secret: F) -> PluginAccountResult
    where
        F: Fn(&str) -> bool,
    {
        if self.load(|_| true).is_err() {
            return PluginAccountResult::err("store");
        }
        let raw = self.accounts.clone().unwrap_or_default();
        if !raw.iter().any(|a| a.id == id) {
            return PluginAccountResult::err("gone");
        }
        let next_raw: Vec<PluginAccount> = raw.into_iter().filter(|a| a.id != id).collect();
        if self.write(&next_raw).is_err() {
            self.accounts = Some(next_raw.clone());
        }
        let visible: Vec<PluginAccount> = next_raw
            .into_iter()
            .filter(|a| has_secret(&plugin_account_slot(&a.id)))
            .collect();
        PluginAccountResult::ok(visible)
    }
}

// ---------------------------------------------------------------------------
// Plugin Use Record (`plugin-use.json` v1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUse {
    pub id: String,
    pub at: String,
    pub thread_id: String,
    pub plugin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub tool: String,
    pub kind: String,
    pub outcome: String,
    /// Fields Node wrote that this build does not know, kept as they were.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUseReport {
    pub thread_id: String,
    pub plugin: String,
    #[serde(default)]
    pub account_id: Option<String>,
    pub tool: String,
    pub kind: String,
    pub outcome: String,
}

#[derive(Debug, Deserialize)]
struct PluginUseFileRaw {
    version: u32,
    uses: Vec<Value>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

pub struct PluginUseStore {
    path: PathBuf,
    uses: Option<Vec<PluginUse>>,
    file_extra: Map<String, Value>,
    history_enabled: bool,
}

impl PluginUseStore {
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join("plugin-use.json"),
            uses: None,
            file_extra: Map::new(),
            history_enabled: true,
        }
    }

    pub fn set_history_enabled(&mut self, enabled: bool) -> Result<(), String> {
        self.history_enabled = enabled;
        if !enabled {
            self.clear()?;
        }
        Ok(())
    }

    pub fn list(&mut self) -> Vec<PluginUse> {
        if !self.history_enabled {
            return Vec::new();
        }
        self.load().clone()
    }

    pub fn add(&mut self, report: PluginUseReport) -> Result<(), String> {
        if !self.history_enabled {
            return Ok(());
        }
        let mut next = self.load().clone();
        next.insert(
            0,
            PluginUse {
                id: Uuid::new_v4().to_string(),
                at: now_iso(),
                thread_id: report.thread_id,
                plugin: report.plugin,
                account_id: report.account_id,
                tool: report.tool,
                kind: report.kind,
                outcome: report.outcome,
                extra: Map::new(),
            },
        );
        next.truncate(PLUGIN_USE_KEPT);
        self.write(&next)
    }

    pub fn forget_threads(&mut self, thread_ids: &[String]) -> Result<(), String> {
        let gone: HashSet<&str> = thread_ids.iter().map(String::as_str).collect();
        let current = self.load().clone();
        let kept: Vec<PluginUse> = current
            .iter()
            .filter(|u| !gone.contains(u.thread_id.as_str()))
            .cloned()
            .collect();
        if kept.len() != current.len() {
            self.write(&kept)?;
        }
        Ok(())
    }

    pub fn forget_account(&mut self, account_id: &str) -> Result<(), String> {
        let current = self.load().clone();
        let kept: Vec<PluginUse> = current
            .iter()
            .filter(|u| u.account_id.as_deref() != Some(account_id))
            .cloned()
            .collect();
        if kept.len() != current.len() {
            self.write(&kept)?;
        }
        Ok(())
    }

    pub fn clear(&mut self) -> Result<(), String> {
        self.uses = Some(Vec::new());
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Could not remove plugin-use.json: {e}")),
        }
    }

    fn load(&mut self) -> &Vec<PluginUse> {
        if self.uses.is_none() {
            let mut uses = Vec::new();
            if let Ok(text) = fs::read_to_string(&self.path) {
                if let Ok(raw) = serde_json::from_str::<PluginUseFileRaw>(&text) {
                    if raw.version == 1 {
                        self.file_extra = raw.extra;
                        for entry in raw.uses {
                            if let Ok(u) = serde_json::from_value::<PluginUse>(entry) {
                                if Uuid::parse_str(&u.id).is_ok()
                                    && DateTime::parse_from_rfc3339(&u.at).is_ok()
                                {
                                    uses.push(u);
                                }
                            }
                        }
                    }
                }
            }
            self.uses = Some(uses);
        }
        self.uses.as_ref().unwrap()
    }

    fn write(&mut self, uses: &[PluginUse]) -> Result<(), String> {
        let payload = with_extra(json!({ "version": 1, "uses": uses }), &self.file_extra);
        write_atomic_private_json_compact(&self.path, &payload)
            .map_err(|e| format!("Could not write plugin-use.json: {e}"))?;
        self.uses = Some(uses.to_vec());
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Mail Grants (`plugin-mail-grants.json` v1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailGrant {
    pub thread_id: String,
    pub account_id: String,
    pub at: String,
    /// Fields Node wrote that this build does not know, kept as they were.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadMailGrant {
    pub account_id: String,
    pub plugin: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
struct MailGrantsFileRaw {
    version: u32,
    grants: Vec<Value>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

pub fn mail_grants_shown(
    grants: &[MailGrant],
    accounts: &[PluginAccount],
    thread_id: &str,
    project_id: Option<&str>,
) -> Vec<ThreadMailGrant> {
    let mut out = Vec::new();
    for g in grants.iter().filter(|g| g.thread_id == thread_id) {
        if let Some(acc) = accounts.iter().find(|a| a.id == g.account_id) {
            if is_mail_plugin(&acc.plugin) && acc.admits(project_id) {
                out.push(ThreadMailGrant {
                    account_id: acc.id.clone(),
                    plugin: acc.plugin.clone(),
                    name: acc.name.clone(),
                });
            }
        }
    }
    out
}

pub struct MailGrantsStore {
    path: PathBuf,
    grants: Option<Vec<MailGrant>>,
    file_extra: Map<String, Value>,
    behind: bool,
    generations: HashMap<String, u64>,
}

impl MailGrantsStore {
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join("plugin-mail-grants.json"),
            grants: None,
            file_extra: Map::new(),
            behind: false,
            generations: HashMap::new(),
        }
    }

    pub fn generation(&self, account_id: &str) -> u64 {
        self.generations.get(account_id).copied().unwrap_or(0)
    }

    pub fn list(&mut self) -> Vec<MailGrant> {
        self.load().clone()
    }

    pub fn has(&mut self, thread_id: &str, account_id: &str, thread_is_open: bool) -> bool {
        let grants = self.load().clone();
        if !grants
            .iter()
            .any(|g| g.thread_id == thread_id && g.account_id == account_id)
        {
            return false;
        }
        if thread_is_open {
            return true;
        }
        let next: Vec<MailGrant> = grants
            .into_iter()
            .filter(|g| g.thread_id != thread_id)
            .collect();
        self.keep(next);
        false
    }

    pub fn grant(
        &mut self,
        thread_id: &str,
        account_id: &str,
        thread_is_open: bool,
        expected_generation: Option<u64>,
    ) -> bool {
        if !thread_is_open {
            return false;
        }
        if let Some(gen) = expected_generation {
            if self.generation(account_id) != gen {
                return false;
            }
        }
        let mut grants = self.load().clone();
        if grants
            .iter()
            .any(|g| g.thread_id == thread_id && g.account_id == account_id)
        {
            return true;
        }
        grants.push(MailGrant {
            thread_id: thread_id.to_string(),
            account_id: account_id.to_string(),
            at: now_iso(),
            extra: Map::new(),
        });
        if grants.len() > MAIL_GRANTS_MAX {
            let drain = grants.len() - MAIL_GRANTS_MAX;
            grants.drain(0..drain);
        }
        self.keep(grants);
        true
    }

    /// Stops a thread's mail grant. Writes disk BEFORE returning `true` so a restart never
    /// resurrects a stopped grant (matching `MailGrants.stop`).
    pub fn stop(&mut self, thread_id: &str, account_id: &str) -> bool {
        let grants = self.load().clone();
        let next: Vec<MailGrant> = grants
            .iter()
            .filter(|g| g.thread_id != thread_id || g.account_id != account_id)
            .cloned()
            .collect();
        if next.len() == grants.len() && !self.behind {
            return true;
        }
        self.write(&next).is_ok()
    }

    pub fn forget_threads(&mut self, thread_ids: &[String]) {
        let gone: HashSet<&str> = thread_ids.iter().map(String::as_str).collect();
        let grants = self.load().clone();
        let next: Vec<MailGrant> = grants
            .iter()
            .filter(|g| !gone.contains(g.thread_id.as_str()))
            .cloned()
            .collect();
        if next.len() != grants.len() {
            self.keep(next);
        }
    }

    pub fn forget_account(&mut self, account_id: &str) {
        let next_gen = self.generation(account_id) + 1;
        self.generations.insert(account_id.to_string(), next_gen);
        let grants = self.load().clone();
        let next: Vec<MailGrant> = grants
            .iter()
            .filter(|g| g.account_id != account_id)
            .cloned()
            .collect();
        if next.len() != grants.len() {
            self.keep(next);
        }
    }

    fn keep(&mut self, grants: Vec<MailGrant>) {
        self.grants = Some(grants.clone());
        if self.write(&grants).is_err() {
            self.behind = true;
        }
    }

    fn load(&mut self) -> &Vec<MailGrant> {
        if self.grants.is_none() {
            let mut grants = Vec::new();
            if let Ok(text) = fs::read_to_string(&self.path) {
                if let Ok(raw) = serde_json::from_str::<MailGrantsFileRaw>(&text) {
                    if raw.version == 1 {
                        self.file_extra = raw.extra;
                        for entry in raw.grants {
                            if let Ok(g) = serde_json::from_value::<MailGrant>(entry) {
                                if !g.thread_id.is_empty()
                                    && Uuid::parse_str(&g.account_id).is_ok()
                                    && DateTime::parse_from_rfc3339(&g.at).is_ok()
                                {
                                    grants.push(g);
                                }
                            }
                        }
                    }
                }
            }
            self.grants = Some(grants);
        }
        self.grants.as_ref().unwrap()
    }

    fn write(&mut self, grants: &[MailGrant]) -> Result<(), String> {
        let payload = with_extra(json!({ "version": 1, "grants": grants }), &self.file_extra);
        write_atomic_private_json_compact(&self.path, &payload)
            .map_err(|e| format!("Could not write plugin-mail-grants.json: {e}"))?;
        self.grants = Some(grants.to_vec());
        self.behind = false;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Copy Choices (`plugin-account-copy-choices.json` v1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyChoicesFile {
    pub version: u32,
    pub copy_new: bool,
    pub choices: BTreeMap<String, BTreeMap<String, bool>>,
    /// Fields Node wrote that this build does not know, kept as they were.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for CopyChoicesFile {
    fn default() -> Self {
        Self {
            version: 1,
            copy_new: true,
            choices: BTreeMap::new(),
            extra: Map::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyComputerView {
    pub id: String,
    pub name: String,
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCopyEntryView {
    pub account_id: String,
    pub computer_id: String,
    pub state: String,
    pub leaving: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCopiesView {
    pub copy_new: bool,
    pub readable: bool,
    pub computers: Vec<CopyComputerView>,
    pub copies: Vec<PluginCopyEntryView>,
}

pub struct PluginCopyChoicesStore {
    path: PathBuf,
    kept: Option<CopyChoicesFile>,
}

impl PluginCopyChoicesStore {
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join("plugin-account-copy-choices.json"),
            kept: None,
        }
    }

    pub fn read(&mut self) -> Result<CopyChoicesFile, String> {
        if let Some(ref c) = self.kept {
            return Ok(c.clone());
        }
        let text = match fs::read_to_string(&self.path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let def = CopyChoicesFile::default();
                self.kept = Some(def.clone());
                return Ok(def);
            }
            Err(e) => return Err(format!("Copy choices unreadable: {e}")),
        };
        let parsed: CopyChoicesFile =
            serde_json::from_str(&text).map_err(|_| "Copy choices unreadable.".to_string())?;
        if parsed.version != 1 {
            return Err("Copy choices version unsupported.".to_string());
        }
        self.kept = Some(parsed.clone());
        Ok(parsed)
    }

    pub fn set_copy(&mut self, account_id: &str, computer_id: &str, on: bool) -> Result<(), String> {
        let mut choices = self.read()?;
        choices
            .choices
            .entry(account_id.to_string())
            .or_default()
            .insert(computer_id.to_string(), on);
        write_atomic_private_json_compact(&self.path, &choices)
            .map_err(|e| format!("Could not write copy choices: {e}"))?;
        self.kept = Some(choices);
        Ok(())
    }

    pub fn set_copy_new(&mut self, copy_new: bool) -> Result<(), String> {
        let mut choices = self.read()?;
        choices.copy_new = copy_new;
        write_atomic_private_json_compact(&self.path, &choices)
            .map_err(|e| format!("Could not write copy choices: {e}"))?;
        self.kept = Some(choices);
        Ok(())
    }

    pub fn view(
        &mut self,
        accounts: &[PluginAccount],
        computers: &[CopyComputerView],
    ) -> PluginCopiesView {
        let loaded = self.read();
        let (readable, copy_new, choices_map) = match loaded {
            Ok(c) => (true, c.copy_new, Some(c)),
            Err(_) => (false, false, None),
        };
        let mut copies = Vec::new();
        for acc in accounts {
            for comp in computers {
                let state = if !acc.may_be_copied() {
                    "here-only"
                } else if !readable {
                    "no-record"
                } else {
                    let wanted = choices_map
                        .as_ref()
                        .and_then(|c| c.choices.get(&acc.id))
                        .and_then(|m| m.get(&comp.id))
                        .copied()
                        .unwrap_or(copy_new);
                    if wanted {
                        "waiting"
                    } else {
                        "off"
                    }
                };
                copies.push(PluginCopyEntryView {
                    account_id: acc.id.clone(),
                    computer_id: comp.id.clone(),
                    state: state.to_string(),
                    leaving: "no".to_string(),
                });
            }
        }
        PluginCopiesView {
            copy_new,
            readable,
            computers: computers.to_vec(),
            copies,
        }
    }
}

// ---------------------------------------------------------------------------
// Heard Spending (`plugin-meshy-spending.json` & `plugin-elevenlabs-spending.json`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpendingReport {
    pub account_id: String,
    pub month: String,
    pub credits: u64,
    pub session: String,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeardSpendingEntry {
    pub month: String,
    pub credits: u64,
    pub heard_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    /// Fields Node wrote that this build does not know, kept as they were.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeardSpendingFile {
    version: u32,
    heard: BTreeMap<String, BTreeMap<String, HeardSpendingEntry>>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeardReport {
    pub from: String,
    pub credits: u64,
    pub heard_at: String,
}

fn sender_of(key: &str) -> &str {
    key.strip_suffix(EARLIER_SUFFIX).unwrap_or(key)
}

pub struct HeardSpendingStore {
    path: PathBuf,
    kept: Option<HeardSpendingFile>,
    behind: HashSet<String>,
}

impl HeardSpendingStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            kept: None,
            behind: HashSet::new(),
        }
    }

    pub fn hear(&mut self, from: &str, reports: &[SpendingReport]) -> Result<bool, String> {
        let mut file = self.read()?;
        let mut mine = file.heard.get(from).cloned().unwrap_or_default();
        let earlier_key = format!("{from}{EARLIER_SUFFIX}");
        let mut earlier = file.heard.get(&earlier_key).cloned().unwrap_or_default();
        let mut changed = false;

        for report in reports {
            let before = mine.get(&report.account_id).cloned();
            if let Some(ref prev) = before {
                if prev.session.as_deref() == Some(report.session.as_str())
                    && prev.revision.is_some_and(|r| r >= report.revision)
                {
                    continue;
                }
            }
            let entry = HeardSpendingEntry {
                month: report.month.clone(),
                credits: report.credits,
                heard_at: now_iso(),
                session: Some(report.session.clone()),
                revision: Some(report.revision),
                extra: Map::new(),
            };
            if let Some(ref prev) = before {
                if report.month < prev.month {
                    let prev_earlier = earlier
                        .get(&report.account_id)
                        .map(|e| e.month.as_str())
                        .unwrap_or("");
                    if prev_earlier <= report.month.as_str() {
                        earlier.insert(report.account_id.clone(), entry);
                        changed = true;
                    }
                    continue;
                }
                if report.month > prev.month {
                    earlier.insert(report.account_id.clone(), prev.clone());
                }
                if prev.month != report.month || prev.credits != report.credits {
                    changed = true;
                }
            } else {
                changed = true;
            }
            mine.insert(report.account_id.clone(), entry);
        }

        file.heard.insert(from.to_string(), mine);
        if !earlier.is_empty() {
            file.heard.insert(earlier_key, earlier);
        }
        match write_atomic_private_json_compact(&self.path, &file) {
            Ok(()) => {
                for r in reports {
                    self.behind.remove(&r.account_id);
                }
                self.kept = Some(file);
                Ok(changed)
            }
            Err(e) => {
                for r in reports {
                    self.behind.insert(r.account_id.clone());
                }
                Err(format!("Could not write heard spending: {e}"))
            }
        }
    }

    pub fn heard_from(&mut self, account_id: &str, month: &str) -> Result<Vec<HeardReport>, String> {
        if self.behind.contains(account_id) {
            return Err("PLUGIN_SPENDING_UNKNOWN".into());
        }
        let file = self.read()?;
        let mut out = Vec::new();
        for (key, accounts) in &file.heard {
            if let Some(entry) = accounts.get(account_id) {
                if entry.month == month {
                    out.push(HeardReport {
                        from: sender_of(key).to_string(),
                        credits: entry.credits,
                        heard_at: entry.heard_at.clone(),
                    });
                }
            }
        }
        Ok(out)
    }

    pub fn total(&mut self, account_id: &str, month: &str, except: Option<&str>) -> Result<u64, String> {
        let reports = self.heard_from(account_id, month)?;
        Ok(reports
            .into_iter()
            .filter(|r| except.is_none_or(|ex| r.from != ex))
            .map(|r| r.credits)
            .sum())
    }

    fn read(&mut self) -> Result<HeardSpendingFile, String> {
        if let Some(ref f) = self.kept {
            return Ok(f.clone());
        }
        let text = match fs::read_to_string(&self.path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let empty = HeardSpendingFile {
                    version: 1,
                    heard: BTreeMap::new(),
                    extra: Map::new(),
                };
                self.kept = Some(empty.clone());
                return Ok(empty);
            }
            Err(_) => return Err("PLUGIN_SPENDING_UNKNOWN".into()),
        };
        let parsed: HeardSpendingFile =
            serde_json::from_str(&text).map_err(|_| "PLUGIN_SPENDING_UNKNOWN".to_string())?;
        if parsed.version != 1 {
            return Err("PLUGIN_SPENDING_UNKNOWN".into());
        }
        self.kept = Some(parsed.clone());
        Ok(parsed)
    }
}

// ---------------------------------------------------------------------------
// 3D Models (`3d-models.json` v1) & Sounds (`sounds.json` v1) Records
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ModelSource {
    Words {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        words: Option<String>,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    #[serde(rename_all = "camelCase")]
    Photo {
        file_name: String,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshyJob {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refine: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub photo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asking: Option<String>,
    /// Fields Node wrote that this build does not know, kept as they were.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRecord {
    pub id: String,
    pub thread_id: String,
    pub account_id: String,
    pub name: String,
    pub source: ModelSource,
    pub root: String,
    pub folder: String,
    pub formats: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub triangles: Option<u32>,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    pub credits: u64,
    pub asked_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub still: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
    #[serde(default)]
    pub job: MeshyJob,
    /// Fields Node wrote that this build does not know, kept as they were.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelSpentEntry {
    account_id: String,
    asked_at: String,
    credits: u64,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

#[derive(Debug, Deserialize)]
struct ModelRecordsFileRaw {
    version: u32,
    models: Vec<Value>,
    #[serde(default)]
    spent: Vec<Value>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

pub struct ModelRecordsStore {
    path: PathBuf,
    records: Option<Vec<ModelRecord>>,
    spent: Vec<ModelSpentEntry>,
    file_extra: Map<String, Value>,
    /// The file is there and could not be read now, so nothing is written over it until it is read again.
    unreadable: bool,
    history_enabled: bool,
}

impl ModelRecordsStore {
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join("3d-models.json"),
            records: None,
            spent: Vec::new(),
            file_extra: Map::new(),
            unreadable: false,
            history_enabled: true,
        }
    }

    pub fn set_history_enabled(&mut self, enabled: bool) -> Result<(), String> {
        self.history_enabled = enabled;
        if !enabled {
            self.load();
            let mut changed = false;
            if let Some(ref mut recs) = self.records {
                for r in recs.iter_mut() {
                    if let ModelSource::Words { ref mut words, .. } = r.source {
                        if words.is_some() {
                            *words = None;
                            changed = true;
                        }
                    }
                }
            }
            if changed {
                self.write()?;
            }
        }
        Ok(())
    }

    pub fn list(&mut self) -> Vec<Value> {
        self.load();
        self.records
            .as_ref()
            .unwrap()
            .iter()
            .map(Self::strip_job)
            .collect()
    }

    pub fn model(&mut self, id: &str) -> Option<Value> {
        self.load();
        self.records
            .as_ref()
            .unwrap()
            .iter()
            .find(|r| r.id == id)
            .map(Self::strip_job)
    }

    pub fn month_credits(&mut self, month: &str) -> BTreeMap<String, u64> {
        self.load();
        let mut out: BTreeMap<String, u64> = BTreeMap::new();
        for r in self.records.as_ref().unwrap() {
            if r.credits > 0 && month_of_rfc3339(&r.asked_at).as_deref() == Some(month) {
                *out.entry(r.account_id.clone()).or_insert(0) += r.credits;
            }
        }
        for s in &self.spent {
            if s.credits > 0 && month_of_rfc3339(&s.asked_at).as_deref() == Some(month) {
                *out.entry(s.account_id.clone()).or_insert(0) += s.credits;
            }
        }
        out
    }

    pub fn forget_threads(&mut self, thread_ids: &[String]) -> Result<Vec<String>, String> {
        self.load();
        let gone: HashSet<&str> = thread_ids.iter().map(String::as_str).collect();
        let mut removed_ids = Vec::new();
        let mut kept = Vec::new();
        for rec in self.records.take().unwrap_or_default() {
            if gone.contains(rec.thread_id.as_str()) {
                removed_ids.push(rec.id.clone());
                if rec.credits > 0 {
                    self.spent.push(ModelSpentEntry {
                        account_id: rec.account_id,
                        asked_at: rec.asked_at,
                        credits: rec.credits,
                        extra: Map::new(),
                    });
                }
            } else {
                kept.push(rec);
            }
        }
        self.records = Some(kept);
        if !removed_ids.is_empty() {
            self.prune_spent();
            self.write()?;
        }
        Ok(removed_ids)
    }

    fn strip_job(rec: &ModelRecord) -> Value {
        let mut val = serde_json::to_value(rec).unwrap_or_else(|_| json!({}));
        if let Some(obj) = val.as_object_mut() {
            obj.remove("job");
        }
        val
    }

    fn prune_spent(&mut self) {
        let cutoff = Utc::now().timestamp_millis() - SPENT_KEPT_MS;
        self.spent.retain(|s| {
            DateTime::parse_from_rfc3339(&s.asked_at)
                .map(|dt| dt.timestamp_millis() >= cutoff)
                .unwrap_or(false)
        });
    }

    fn load(&mut self) {
        if self.records.is_some() && !self.unreadable {
            return;
        }
        let mut recs = Vec::new();
        let mut spent = Vec::new();
        // A file that is there and cannot be read now is never written over with nothing, as in Node. One that does
        // not parse starts over, as in Node.
        self.unreadable = false;
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => Some(text),
            Err(e) => {
                self.unreadable = e.kind() != std::io::ErrorKind::NotFound;
                None
            }
        };
        if let Some(text) = text {
            if let Ok(raw) = serde_json::from_str::<ModelRecordsFileRaw>(&text) {
                if raw.version == 1 {
                    self.file_extra = raw.extra;
                    for entry in raw.models {
                        if let Ok(mut r) = serde_json::from_value::<ModelRecord>(entry) {
                            if !self.history_enabled {
                                if let ModelSource::Words { ref mut words, .. } = r.source {
                                    *words = None;
                                }
                            }
                            recs.push(r);
                        }
                    }
                    for entry in raw.spent {
                        if let Ok(s) = serde_json::from_value::<ModelSpentEntry>(entry) {
                            spent.push(s);
                        }
                    }
                }
            }
        }
        recs.truncate(MODEL_RECORDS_KEPT);
        self.records = Some(recs);
        self.spent = spent;
    }

    fn write(&mut self) -> Result<(), String> {
        if self.unreadable {
            return Err("3d-models.json could not be read, so it was kept unchanged.".into());
        }
        let payload = if self.spent.is_empty() {
            json!({ "version": 1, "models": self.records.as_deref().unwrap_or(&[]) })
        } else {
            json!({ "version": 1, "models": self.records.as_deref().unwrap_or(&[]), "spent": self.spent })
        };
        let payload = with_extra(payload, &self.file_extra);
        write_atomic_private_json_compact(&self.path, &payload)
            .map_err(|e| format!("Could not write 3d-models.json: {e}"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundRecord {
    pub id: String,
    pub thread_id: String,
    pub account_id: String,
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub words: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seconds: Option<f64>,
    pub folder: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    pub cost: f64,
    pub asked_at: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
    /// Fields Node wrote that this build does not know, kept as they were.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SoundSpentEntry {
    account_id: String,
    asked_at: String,
    cost: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

#[derive(Debug, Deserialize)]
struct SoundRecordsFileRaw {
    version: u32,
    sounds: Vec<Value>,
    #[serde(default)]
    spent: Vec<Value>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

pub struct SoundRecordsStore {
    path: PathBuf,
    records: Option<Vec<SoundRecord>>,
    spent: Vec<SoundSpentEntry>,
    file_extra: Map<String, Value>,
    /// The file is there and could not be read, so nothing is written over it until it is read again.
    unreadable: bool,
    history_enabled: bool,
}

impl SoundRecordsStore {
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join("sounds.json"),
            records: None,
            spent: Vec::new(),
            file_extra: Map::new(),
            unreadable: false,
            history_enabled: true,
        }
    }

    pub fn set_history_enabled(&mut self, enabled: bool) -> Result<(), String> {
        self.history_enabled = enabled;
        if !enabled {
            self.load();
            let mut changed = false;
            if let Some(ref mut recs) = self.records {
                for r in recs.iter_mut() {
                    if r.words.is_some() {
                        r.words = None;
                        changed = true;
                    }
                }
            }
            if changed {
                self.write()?;
            }
        }
        Ok(())
    }

    pub fn sound(&mut self, id: &str) -> Option<SoundRecord> {
        self.load();
        self.records
            .as_ref()
            .unwrap()
            .iter()
            .find(|r| r.id == id)
            .cloned()
    }

    pub fn list(&mut self) -> Vec<SoundRecord> {
        self.load();
        self.records.as_ref().unwrap().clone()
    }

    pub fn settle_unfinished(&mut self) -> Result<(), String> {
        self.load();
        let mut changed = false;
        if let Some(ref mut recs) = self.records {
            for r in recs.iter_mut() {
                if r.state == "making" {
                    r.state = "failed".to_string();
                    r.failure = Some("stopped".to_string());
                    changed = true;
                }
            }
        }
        if changed {
            self.write()?;
        }
        Ok(())
    }

    pub fn month_spent(&mut self, month: &str) -> BTreeMap<String, f64> {
        self.load();
        let mut out: BTreeMap<String, f64> = BTreeMap::new();
        for r in self.records.as_ref().unwrap() {
            if r.cost > 0.0 && month_of_rfc3339(&r.asked_at).as_deref() == Some(month) {
                *out.entry(r.account_id.clone()).or_insert(0.0) += r.cost;
            }
        }
        for s in &self.spent {
            if s.cost > 0.0 && month_of_rfc3339(&s.asked_at).as_deref() == Some(month) {
                *out.entry(s.account_id.clone()).or_insert(0.0) += s.cost;
            }
        }
        out
    }

    pub fn forget_threads(&mut self, thread_ids: &[String]) -> Result<(), String> {
        self.load();
        let gone: HashSet<&str> = thread_ids.iter().map(String::as_str).collect();
        let mut changed = false;
        let mut kept = Vec::new();
        for rec in self.records.take().unwrap_or_default() {
            if gone.contains(rec.thread_id.as_str()) {
                changed = true;
                if rec.cost > 0.0 {
                    self.spent.push(SoundSpentEntry {
                        account_id: rec.account_id,
                        asked_at: rec.asked_at,
                        cost: rec.cost,
                        id: if rec.state == "making" {
                            Some(rec.id)
                        } else {
                            None
                        },
                        extra: Map::new(),
                    });
                }
            } else {
                kept.push(rec);
            }
        }
        self.records = Some(kept);
        if changed {
            self.prune_spent();
            self.write()?;
        }
        Ok(())
    }

    fn prune_spent(&mut self) {
        let cutoff = Utc::now().timestamp_millis() - SPENT_KEPT_MS;
        self.spent.retain(|s| {
            DateTime::parse_from_rfc3339(&s.asked_at)
                .map(|dt| dt.timestamp_millis() >= cutoff)
                .unwrap_or(false)
        });
    }

    fn load(&mut self) {
        if self.records.is_some() && !self.unreadable {
            return;
        }
        let mut recs = Vec::new();
        let mut spent = Vec::new();
        // A file that is there and cannot be read or parsed is never written over, as in Node: every change refuses
        // until it can be read.
        self.unreadable = false;
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => Some(text),
            Err(e) => {
                self.unreadable = e.kind() != std::io::ErrorKind::NotFound;
                None
            }
        };
        if let Some(text) = text {
            match serde_json::from_str::<SoundRecordsFileRaw>(&text) {
                Ok(raw) if raw.version == 1 => {
                    self.file_extra = raw.extra;
                    for entry in raw.sounds {
                        if let Ok(mut r) = serde_json::from_value::<SoundRecord>(entry) {
                            if !self.history_enabled {
                                r.words = None;
                            }
                            recs.push(r);
                        }
                    }
                    for entry in raw.spent {
                        if let Ok(s) = serde_json::from_value::<SoundSpentEntry>(entry) {
                            spent.push(s);
                        }
                    }
                }
                _ => self.unreadable = true,
            }
        }
        recs.truncate(SOUND_RECORDS_KEPT);
        self.records = Some(recs);
        self.spent = spent;
    }

    fn write(&mut self) -> Result<(), String> {
        if self.unreadable {
            return Err("sounds.json could not be read, so it was kept unchanged.".into());
        }
        let payload = if self.spent.is_empty() {
            json!({ "version": 1, "sounds": self.records.as_deref().unwrap_or(&[]) })
        } else {
            json!({ "version": 1, "sounds": self.records.as_deref().unwrap_or(&[]), "spent": self.spent })
        };
        let payload = with_extra(payload, &self.file_extra);
        write_atomic_private_json_compact(&self.path, &payload)
            .map_err(|e| format!("Could not write sounds.json: {e}"))
    }
}

// ---------------------------------------------------------------------------
// GitHub CLI Sign-In (`src/main/plugins/github/signIn.ts`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum GitHubSignIn {
    SignedIn { login: String },
    SignedOut,
    NotInstalled,
    Unknown,
}

fn valid_github_login(login: &str) -> bool {
    !login.is_empty()
        && login.len() <= 100
        && login
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub fn parse_github_sign_in_json(output: &str) -> GitHubSignIn {
    let Ok(val) = serde_json::from_str::<Value>(output) else {
        return GitHubSignIn::Unknown;
    };
    let Some(hosts) = val.get("hosts").and_then(Value::as_object) else {
        return GitHubSignIn::Unknown;
    };
    let accounts = hosts
        .get(GH_HOST)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if accounts.is_empty() {
        return GitHubSignIn::SignedOut;
    }
    let active = accounts
        .iter()
        .find(|e| e.get("active").and_then(Value::as_bool) == Some(true))
        .or_else(|| if accounts.len() == 1 { accounts.first() } else { None });
    let Some(account) = active else {
        return GitHubSignIn::Unknown;
    };
    match account.get("state").and_then(Value::as_str) {
        Some("success") => match account.get("login").and_then(Value::as_str) {
            Some(login) if valid_github_login(login) => GitHubSignIn::SignedIn {
                login: login.to_string(),
            },
            _ => GitHubSignIn::Unknown,
        },
        Some("error" | "refresh_expired") => GitHubSignIn::SignedOut,
        _ => GitHubSignIn::Unknown,
    }
}

pub fn parse_github_sign_in_words(text: &str) -> GitHubSignIn {
    struct Block {
        kind: &'static str,
        login: String,
        active: Option<bool>,
    }
    let mut blocks: Vec<Block> = Vec::new();
    for line in text.lines() {
        let mut matched: Option<(&'static str, &str)> = None;
        for (prefix, kind) in [
            ("Logged in to github.com account ", "logged-in"),
            ("Logged in to github.com as ", "logged-in"),
            ("Failed to log in to github.com account ", "failed"),
            ("Failed to log in to github.com as ", "failed"),
            ("Timeout trying to log in to github.com account ", "timeout"),
            ("Timeout trying to log in to github.com as ", "timeout"),
        ] {
            if let Some(pos) = line.find(prefix) {
                let rest = &line[pos + prefix.len()..];
                if let Some(login) = rest.split_whitespace().next() {
                    matched = Some((kind, login));
                    break;
                }
            }
        }
        if let Some((kind, login)) = matched {
            blocks.push(Block {
                kind,
                login: login.to_string(),
                active: None,
            });
        } else if let Some(last) = blocks.last_mut() {
            if let Some(pos) = line.find("Active account: ") {
                let rest = &line[pos + "Active account: ".len()..];
                if rest.starts_with("true") {
                    last.active = Some(true);
                } else if rest.starts_with("false") {
                    last.active = Some(false);
                }
            }
        }
    }
    if blocks.is_empty() {
        return if text.to_ascii_lowercase().contains("not logged in") {
            GitHubSignIn::SignedOut
        } else {
            GitHubSignIn::Unknown
        };
    }
    let marked = blocks.iter().any(|b| b.active.is_some());
    let acting = if marked {
        blocks.iter().find(|b| b.active == Some(true))
    } else {
        blocks.first()
    };
    let Some(acting) = acting else {
        return GitHubSignIn::Unknown;
    };
    match acting.kind {
        "logged-in" if valid_github_login(&acting.login) => GitHubSignIn::SignedIn {
            login: acting.login.clone(),
        },
        "failed" => GitHubSignIn::SignedOut,
        _ => GitHubSignIn::Unknown,
    }
}

fn run_gh_command(args: &[&str]) -> Result<(Option<i32>, String, String), std::io::Error> {
    use std::io::Read;
    let opts = crate::cli_lookup::CliLookupOptions::from_process_env();
    let mut cmd = match crate::cli_lookup::resolve_tool_cli("gh", &opts) {
        Some(res) => {
            let mut c = std::process::Command::new(&res.executable);
            res.apply_std(&mut c);
            c
        }
        None => std::process::Command::new("gh"),
    };
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn()?;
    let out_pipe = child.stdout.take();
    let err_pipe = child.stderr.take();
    let out_t = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = out_pipe {
            let _ = p.take(1024 * 1024).read_to_end(&mut buf);
        }
        String::from_utf8_lossy(&buf).into_owned()
    });
    let err_t = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = err_pipe {
            let _ = p.take(1024 * 1024).read_to_end(&mut buf);
        }
        String::from_utf8_lossy(&buf).into_owned()
    });
    let deadline = Instant::now() + GH_TIMEOUT;
    let code = loop {
        match child.try_wait()? {
            Some(st) => break st.code(),
            None => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
        }
    };
    Ok((code, out_t.join().unwrap_or_default(), err_t.join().unwrap_or_default()))
}

pub fn read_github_sign_in() -> GitHubSignIn {
    match run_gh_command(&["auth", "status", "--hostname", GH_HOST, "--json", "hosts"]) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => GitHubSignIn::NotInstalled,
        Err(_) => GitHubSignIn::Unknown,
        Ok((Some(0), stdout, _)) => parse_github_sign_in_json(&stdout),
        Ok((_, stdout, stderr)) => {
            let combined = format!("{stdout}\n{stderr}");
            let lower = combined.to_ascii_lowercase();
            if lower.contains("unknown flag")
                || lower.contains("unknown shorthand")
                || lower.contains("--json")
            {
                return match run_gh_command(&["auth", "status", "--hostname", GH_HOST]) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        GitHubSignIn::NotInstalled
                    }
                    Err(_) => GitHubSignIn::Unknown,
                    Ok((_, w_out, w_err)) => parse_github_sign_in_words(&format!("{w_out}\n{w_err}")),
                };
            }
            if lower.contains("not logged in") {
                GitHubSignIn::SignedOut
            } else {
                GitHubSignIn::Unknown
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Pending Plugin Change Requests (`src/main/plugins/pendingChanges.ts`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginChangeCard {
    pub text: String,
    pub action: String,
    pub target: String,
    pub details: String,
    pub plugin: String,
    pub allow: String,
    pub deny: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginChangeAnswer {
    Allowed,
    Denied,
    Lapsed,
    Stopped,
}

struct PendingChangeEntry {
    thread_id: String,
    request: Value,
    tx: Option<tokio::sync::oneshot::Sender<PluginChangeAnswer>>,
}

/// Holds pending plugin change approval cards (ADR-0205, ADR-0004). Nothing here ever
/// auto-approves; only explicit `answer` settles as `Allowed`/`Denied`.
pub struct PluginChangeRequests {
    waiting: BTreeMap<String, PendingChangeEntry>,
    closed: bool,
}

impl Default for PluginChangeRequests {
    fn default() -> Self {
        Self::new()
    }
}

impl PluginChangeRequests {
    pub fn new() -> Self {
        Self {
            waiting: BTreeMap::new(),
            closed: false,
        }
    }

    pub fn ask(
        &mut self,
        thread_id: &str,
        card: PluginChangeCard,
    ) -> Option<(String, tokio::sync::oneshot::Receiver<PluginChangeAnswer>)> {
        if self.closed {
            return None;
        }
        let id = format!("{PLUGIN_CHANGE_PREFIX}{}", Uuid::new_v4());
        let request = json!({
            "id": id,
            "kind": "permission",
            "text": card.text,
            "options": [],
            "permissionChoices": [
                { "id": "allow", "label": card.allow, "kind": "allow-once" },
                { "id": "deny", "label": card.deny, "kind": "deny" }
            ],
            "context": {
                "toolName": card.plugin,
                "action": card.action,
                "target": card.target,
                "details": card.details
            },
            "since": now_iso(),
        });
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.waiting.insert(
            id.clone(),
            PendingChangeEntry {
                thread_id: thread_id.to_string(),
                request,
                tx: Some(tx),
            },
        );
        Some((id, rx))
    }

    pub fn answer(&mut self, thread_id: &str, request_id: &str, approved: bool) -> Result<(), String> {
        let Some(entry) = self.waiting.get(request_id) else {
            return Err("This request is no longer pending. Refresh the thread.".to_string());
        };
        if entry.thread_id != thread_id {
            return Err("This request is no longer pending. Refresh the thread.".to_string());
        }
        if let Some(mut removed) = self.waiting.remove(request_id) {
            if let Some(tx) = removed.tx.take() {
                let _ = tx.send(if approved {
                    PluginChangeAnswer::Allowed
                } else {
                    PluginChangeAnswer::Denied
                });
            }
        }
        Ok(())
    }

    pub fn requests_by_thread(&self) -> BTreeMap<String, Vec<Value>> {
        let mut out: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for entry in self.waiting.values() {
            out.entry(entry.thread_id.clone())
                .or_default()
                .push(entry.request.clone());
        }
        out
    }

    pub fn forget_threads(&mut self, thread_ids: &[String]) {
        let gone: HashSet<&str> = thread_ids.iter().map(String::as_str).collect();
        let ids: Vec<String> = self
            .waiting
            .iter()
            .filter(|(_, e)| gone.contains(e.thread_id.as_str()))
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(mut entry) = self.waiting.remove(&id) {
                if let Some(tx) = entry.tx.take() {
                    let _ = tx.send(PluginChangeAnswer::Stopped);
                }
            }
        }
    }

    pub fn close(&mut self) {
        self.closed = true;
        let ids: Vec<String> = self.waiting.keys().cloned().collect();
        for id in ids {
            if let Some(mut entry) = self.waiting.remove(&id) {
                if let Some(tx) = entry.tx.take() {
                    let _ = tx.send(PluginChangeAnswer::Stopped);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Unified LocalPluginsManager + Read-Only Inspector
// ---------------------------------------------------------------------------

pub struct LocalPluginsManager {
    pub accounts: PluginAccountsStore,
    pub uses: PluginUseStore,
    pub mail_grants: MailGrantsStore,
    pub copy_choices: PluginCopyChoicesStore,
    pub meshy_spending: HeardSpendingStore,
    pub elevenlabs_spending: HeardSpendingStore,
    pub models3d: ModelRecordsStore,
    pub sounds: SoundRecordsStore,
    pub pending_changes: PluginChangeRequests,
}

impl LocalPluginsManager {
    pub fn new(directory: &Path) -> Self {
        Self {
            accounts: PluginAccountsStore::new(directory),
            uses: PluginUseStore::new(directory),
            mail_grants: MailGrantsStore::new(directory),
            copy_choices: PluginCopyChoicesStore::new(directory),
            meshy_spending: HeardSpendingStore::new(directory.join("plugin-meshy-spending.json")),
            elevenlabs_spending: HeardSpendingStore::new(
                directory.join("plugin-elevenlabs-spending.json"),
            ),
            models3d: ModelRecordsStore::new(directory),
            sounds: SoundRecordsStore::new(directory),
            pending_changes: PluginChangeRequests::new(),
        }
    }

    /// Aggregates monthly Meshy credits matching `meshyCreditsSchema` (`src/shared/plugins.ts:251`).
    pub fn meshy_credits<F>(&mut self, has_secret: F, host_names: &HashMap<String, String>) -> Value
    where
        F: Fn(&str) -> bool,
    {
        let month = current_local_month();
        let own = self.models3d.month_credits(&month);
        let accounts = self.accounts.load(&has_secret).unwrap_or_default();
        let mut result = serde_json::Map::new();
        for acc in accounts.into_iter().filter(|a| a.plugin == "meshy") {
            let here = own.get(&acc.id).copied().unwrap_or(0);
            let heard = self
                .meshy_spending
                .heard_from(&acc.id, &month)
                .unwrap_or_default();
            let others: u64 = heard.iter().map(|r| r.credits).sum();
            let across: Vec<String> = heard
                .iter()
                .filter(|r| r.credits > 0)
                .map(|r| {
                    host_names
                        .get(&r.from)
                        .cloned()
                        .unwrap_or_else(|| r.from.clone())
                })
                .collect();
            result.insert(
                acc.id,
                json!({
                    "here": here,
                    "credits": here.saturating_add(others),
                    "across": across,
                }),
            );
        }
        Value::Object(result)
    }

    /// Aggregates monthly ElevenLabs spend in US dollars matching `elevenLabsSpentSchema`.
    pub fn elevenlabs_spent<F>(&mut self, has_secret: F, host_names: &HashMap<String, String>) -> Value
    where
        F: Fn(&str) -> bool,
    {
        let month = current_local_month();
        let own = self.sounds.month_spent(&month);
        let accounts = self.accounts.load(&has_secret).unwrap_or_default();
        let mut result = serde_json::Map::new();
        for acc in accounts.into_iter().filter(|a| a.plugin == "elevenlabs") {
            let here = own.get(&acc.id).copied().unwrap_or(0.0);
            let heard = self
                .elevenlabs_spending
                .heard_from(&acc.id, &month)
                .unwrap_or_default();
            let others_cents: u64 = heard.iter().map(|r| r.credits).sum();
            let across: Vec<String> = heard
                .iter()
                .filter(|r| r.credits > 0)
                .map(|r| {
                    host_names
                        .get(&r.from)
                        .cloned()
                        .unwrap_or_else(|| r.from.clone())
                })
                .collect();
            let total = (here + (others_cents as f64) / 100.0).max(0.0);
            result.insert(
                acc.id,
                json!({
                    "spent": total,
                    "across": across,
                }),
            );
        }
        Value::Object(result)
    }

    pub fn forget_threads(&mut self, thread_ids: &[String]) -> Result<Vec<String>, String> {
        self.uses.forget_threads(thread_ids)?;
        self.mail_grants.forget_threads(thread_ids);
        self.pending_changes.forget_threads(thread_ids);
        let removed_models = self.models3d.forget_threads(thread_ids)?;
        self.sounds.forget_threads(thread_ids)?;
        Ok(removed_models)
    }

    pub fn set_history_enabled(&mut self, enabled: bool) -> Result<(), String> {
        self.uses.set_history_enabled(enabled)?;
        self.models3d.set_history_enabled(enabled)?;
        self.sounds.set_history_enabled(enabled)?;
        Ok(())
    }
}

/// Strictly read-only snapshot of local plugin JSON stores (safe for `--accelerator` mode).
pub fn read_plugins_readonly(data_directory: &Path) -> Value {
    let mut mgr = LocalPluginsManager::new(data_directory);
    let accounts = mgr.accounts.load(|_| true).ok();
    let uses = mgr.uses.list();
    let mail_grants = mgr.mail_grants.list();
    let models = mgr.models3d.list();
    let sounds = mgr.sounds.list();
    json!({
        "accounts": accounts,
        "uses": uses,
        "mailGrants": mail_grants,
        "models3d": models,
        "sounds": sounds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store_trip::{created, round_trip};

    const ACCOUNT: &str = "0f8c1d2e-3b4a-4c5d-8e6f-001122334455";
    const MAIL: &str = "1a9d2e3f-4c5b-4d6e-9f70-112233445566";
    const PROTON: &str = "2b0e3f40-5d6c-4e7f-a081-223344556677";
    const MESHY: &str = "3c1f4051-6e7d-4f80-b192-334455667788";
    const SOUNDS: &str = "4d205162-7f8e-4091-82a3-445566778899";
    const SESSION: &str = "5e316273-809f-41a2-93b4-5566778899aa";
    const USE: &str = "6f427384-91a0-42b3-a4c5-66778899aabb";

    fn node_accounts() -> Value {
        json!({ "version": 6, "nodeOnlyField": "kept", "accounts": [
            { "id": ACCOUNT, "plugin": "vercel", "name": "Personal", "savedAt": "2026-11-20T10:00:00.000Z", "signedInAs": "zach", "on": false, "projects": ["project-1"], "nodeOnlyField": "kept" },
            { "id": MAIL, "plugin": "gmail", "name": "Work mail", "savedAt": "2026-11-20T10:01:00.000Z", "signedInAs": null, "address": "zach@example.com", "nodeOnlyField": "kept" },
            { "id": PROTON, "plugin": "proton-mail", "name": "Proton", "savedAt": "2026-11-20T10:02:00.000Z", "signedInAs": null, "address": "zach@proton.me",
              "bridge": { "imapPort": 1143, "smtpPort": 1025, "certificate": "ab".repeat(32), "nodeOnlyField": "kept" }, "nodeOnlyField": "kept" },
            { "id": MESHY, "plugin": "meshy", "name": "Meshy", "savedAt": "2026-11-20T10:03:00.000Z", "signedInAs": null,
              "spending": { "askBefore": false, "monthlyLimit": 500, "nodeOnlyField": "kept" }, "nodeOnlyField": "kept" },
            { "id": SOUNDS, "plugin": "elevenlabs", "name": "Studio", "savedAt": "2026-11-20T10:04:00.000Z", "signedInAs": "studio",
              "spending": { "askBefore": true, "monthlyLimit": 10 }, "nodeOnlyField": "kept" },
        ] })
    }

    #[test]
    fn node_plugin_accounts_survives_a_rust_load_and_save() {
        round_trip("plugin-accounts.json", node_accounts, |dir| {
            let mut store = PluginAccountsStore::new(dir);
            let accounts = store.load(|_| true).unwrap();
            assert_eq!(accounts.len(), 5);
            store.write(&accounts).unwrap();
        });
    }

    #[test]
    fn node_plugin_use_survives_a_rust_load_and_save() {
        round_trip(
            "plugin-use.json",
            || json!({ "version": 1, "nodeOnlyField": "kept", "uses": [
                { "id": USE, "at": "2026-11-20T10:00:00.000Z", "threadId": "thread-1", "plugin": "gmail", "accountId": MAIL, "tool": "plugin_read", "kind": "mail-search", "outcome": "done", "nodeOnlyField": "kept" },
                { "id": SESSION, "at": "2026-11-20T09:00:00.000Z", "threadId": "thread-2", "plugin": "github", "tool": "github_comment", "kind": "comment", "outcome": "denied" },
            ] }),
            |dir| {
                let mut store = PluginUseStore::new(dir);
                let uses = store.load().clone();
                assert_eq!(uses.len(), 2);
                store.write(&uses).unwrap();
            },
        );
    }

    #[test]
    fn rust_created_plugin_use_reads_in_node() {
        let written = created("plugin-use.json", |dir| {
            let report = PluginUseReport { thread_id: "thread-1".into(), plugin: "meshy".into(), account_id: Some(MESHY.into()), tool: "make_3d_model".into(), kind: "3d-model".into(), outcome: "done".into() };
            PluginUseStore::new(dir).add(report).unwrap();
        });
        assert_eq!(written["version"], 1);
        assert_eq!(written["uses"][0]["accountId"], MESHY);
    }

    #[test]
    fn node_plugin_mail_grants_survives_a_rust_load_and_save() {
        round_trip(
            "plugin-mail-grants.json",
            || json!({ "version": 1, "nodeOnlyField": "kept", "grants": [
                { "threadId": "thread-1", "accountId": MAIL, "at": "2026-11-20T10:00:00.000Z", "nodeOnlyField": "kept" },
                { "threadId": "host-1:thread-2", "accountId": PROTON, "at": "2026-11-20T11:00:00.000Z" },
            ] }),
            |dir| {
                let mut store = MailGrantsStore::new(dir);
                let grants = store.load().clone();
                assert_eq!(grants.len(), 2);
                store.write(&grants).unwrap();
            },
        );
    }

    #[test]
    fn rust_created_plugin_mail_grants_reads_in_node() {
        let written = created("plugin-mail-grants.json", |dir| {
            assert!(MailGrantsStore::new(dir).grant("thread-1", MAIL, true, None));
        });
        assert_eq!(written["grants"][0]["accountId"], MAIL);
    }

    #[test]
    fn node_plugin_account_copy_choices_survives_a_rust_load_and_save() {
        round_trip(
            "plugin-account-copy-choices.json",
            || json!({ "version": 1, "copyNew": false, "nodeOnlyField": "kept", "choices": { ACCOUNT: { "computer-1": true, "computer-2": false }, MESHY: { "computer-1": false } } }),
            |dir| {
                let mut store = PluginCopyChoicesStore::new(dir);
                let choices = store.read().unwrap();
                store.set_copy_new(choices.copy_new).unwrap();
            },
        );
    }

    #[test]
    fn rust_created_plugin_account_copy_choices_reads_in_node() {
        let written = created("plugin-account-copy-choices.json", |dir| {
            PluginCopyChoicesStore::new(dir).set_copy(ACCOUNT, "computer-1", false).unwrap();
        });
        assert_eq!(written["copyNew"], true);
        assert_eq!(written["choices"][ACCOUNT]["computer-1"], false);
    }

    fn node_heard_spending() -> Value {
        json!({ "version": 1, "nodeOnlyField": "kept", "heard": {
            "host-a": { MESHY: { "month": "2026-11", "credits": 60, "heardAt": "2026-11-20T10:00:00.000Z", "session": SESSION, "revision": 2, "nodeOnlyField": "kept" } },
            "host-a#earlier": { MESHY: { "month": "2026-10", "credits": 40, "heardAt": "2026-10-30T10:00:00.000Z" } },
        } })
    }

    fn heard_trip(file: &str) {
        round_trip(file, node_heard_spending, |dir| {
            let mut store = HeardSpendingStore::new(dir.join(file));
            assert_eq!(store.total(MESHY, "2026-11", None).unwrap(), 60);
            store.hear("host-a", &[]).unwrap();
        });
    }

    #[test]
    fn node_plugin_meshy_spending_survives_a_rust_load_and_save() {
        heard_trip("plugin-meshy-spending.json");
    }

    #[test]
    fn node_plugin_elevenlabs_spending_survives_a_rust_load_and_save() {
        heard_trip("plugin-elevenlabs-spending.json");
    }

    #[test]
    fn rust_created_plugin_meshy_spending_reads_in_node() {
        let written = created("plugin-meshy-spending.json", |dir| {
            let report = SpendingReport { account_id: MESHY.into(), month: "2026-11".into(), credits: 30, session: SESSION.into(), revision: 1 };
            HeardSpendingStore::new(dir.join("plugin-meshy-spending.json")).hear("host-a", &[report]).unwrap();
        });
        assert_eq!(written["heard"]["host-a"][MESHY]["credits"], 30);
    }

    #[test]
    fn node_3d_models_survives_a_rust_load_and_save() {
        round_trip(
            "3d-models.json",
            || json!({ "version": 1, "nodeOnlyField": "kept", "models": [
                { "id": "model-1", "threadId": "thread-1", "accountId": MESHY, "name": "Chair", "source": { "kind": "words", "words": "a wooden chair", "nodeOnlyField": "kept" },
                  "root": "/home/zach/work", "folder": "/home/zach/work/models", "formats": ["glb", "usdz"], "triangles": 30000, "state": "making", "stage": "texture", "credits": 30,
                  "askedAt": "2026-11-20T10:00:00.000Z", "files": [], "job": { "preview": "task-1", "refine": "task-2", "asking": "refine", "nodeOnlyField": "kept" }, "nodeOnlyField": "kept" },
                { "id": "model-2", "threadId": "thread-2", "accountId": MESHY, "name": "Lamp", "source": { "kind": "photo", "fileName": "lamp.png" },
                  "root": "/home/zach/work", "folder": "/home/zach/work/models", "formats": ["glb"], "state": "done", "credits": 20, "askedAt": "2026-11-19T10:00:00.000Z",
                  "endedAt": "2026-11-19T10:05:00.000Z", "files": ["lamp.glb"], "still": "lamp-still.png", "job": { "photo": "task-3" } },
                { "id": "model-3", "threadId": "thread-2", "accountId": MESHY, "name": "Vase", "source": { "kind": "words" }, "root": "/home/zach/work", "folder": "/home/zach/work/models",
                  "formats": ["stl"], "state": "failed", "credits": 0, "askedAt": "2026-11-18T10:00:00.000Z", "endedAt": "2026-11-18T10:01:00.000Z", "files": [], "failure": "no-credits", "job": {} },
            ], "spent": [{ "accountId": MESHY, "askedAt": "2026-11-17T10:00:00.000Z", "credits": 10, "nodeOnlyField": "kept" }] }),
            |dir| {
                let mut store = ModelRecordsStore::new(dir);
                store.load();
                assert_eq!(store.records.as_ref().unwrap().len(), 3);
                store.write().unwrap();
            },
        );
    }

    #[test]
    fn node_sounds_survives_a_rust_load_and_save() {
        round_trip(
            "sounds.json",
            || json!({ "version": 1, "nodeOnlyField": "kept", "sounds": [
                { "id": "sound-1", "threadId": "thread-1", "accountId": SOUNDS, "kind": "speech", "name": "Welcome", "words": "Hello there", "voice": "voice-1", "seconds": 2.5,
                  "folder": "/home/zach/work/sounds", "fileName": "welcome.mp3", "bytes": 40000, "cost": 0.25, "askedAt": "2026-11-20T10:00:00.000Z", "state": "made", "nodeOnlyField": "kept" },
                { "id": "sound-2", "threadId": "thread-2", "accountId": SOUNDS, "kind": "effect", "name": "Door", "folder": "/home/zach/work/sounds", "cost": 0.5,
                  "askedAt": "2026-11-19T10:00:00.000Z", "state": "failed", "failure": "busy" },
            ], "spent": [{ "accountId": SOUNDS, "askedAt": "2026-11-17T10:00:00.000Z", "cost": 0.75, "id": "sound-0", "nodeOnlyField": "kept" }] }),
            |dir| {
                let mut store = SoundRecordsStore::new(dir);
                assert_eq!(store.list().len(), 2);
                store.write().unwrap();
            },
        );
    }

    #[test]
    fn a_sounds_file_that_does_not_parse_is_kept_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sounds.json");
        fs::write(&path, "{ not json").unwrap();
        let mut store = SoundRecordsStore::new(dir.path());
        assert!(store.list().is_empty());
        assert!(store.write().is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
    }

    #[test]
    fn accounts_store_preserves_v1_to_v6_versioning_default_omission_and_corrupt_refusal() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = PluginAccountsStore::new(dir.path());
        let id1 = Uuid::new_v4().to_string();
        let id2 = Uuid::new_v4().to_string();

        // Version 1: single Vercel account, on: true, projects: null (omitted on disk).
        let acc1 = PluginAccount {
            id: id1.clone(),
            plugin: "vercel".into(),
            name: "Personal".into(),
            saved_at: now_iso(),
            signed_in_as: Some("zach".into()),
            address: None,
            on: true,
            projects: None,
            spending: None,
            bridge: None,
            extra: Map::new(),
        };
        store.write(std::slice::from_ref(&acc1)).unwrap();
        let raw1: Value = serde_json::from_str(
            &fs::read_to_string(dir.path().join("plugin-accounts.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(raw1["version"], 1);
        assert!(raw1["accounts"][0].get("on").is_none());
        assert!(raw1["accounts"][0].get("projects").is_none());

        // Switching off bumps version to 2 and persists `on: false`.
        let upd = store.update(
            &PluginAccountUpdate {
                id: id1.clone(),
                on: Some(false),
                ask_before: None,
                monthly_limit: None,
                projects: None,
            },
            |_| true,
        );
        assert!(matches!(upd, PluginAccountResult::Ok { .. }));
        let raw2: Value = serde_json::from_str(
            &fs::read_to_string(dir.path().join("plugin-accounts.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(raw2["version"], 2);
        assert_eq!(raw2["accounts"][0]["on"], false);

        // Adding ElevenLabs bumps version to 6.
        let acc2 = PluginAccount {
            id: id2.clone(),
            plugin: "elevenlabs".into(),
            name: "Studio".into(),
            saved_at: now_iso(),
            signed_in_as: None,
            address: None,
            on: true,
            projects: None,
            spending: Some(PluginSpending {
                ask_before: true,
                monthly_limit: 10,
                extra: Map::new(),
            }),
            bridge: None,
            extra: Map::new(),
        };
        store.write(&[acc1, acc2]).unwrap();
        let raw6: Value = serde_json::from_str(
            &fs::read_to_string(dir.path().join("plugin-accounts.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(raw6["version"], 6);

        // Secret normalization matches TS rules.
        assert_eq!(plugin_secret_as_kept("gmail", "abcd efgh ijkl mnop"), "abcdefghijklmnop");
        assert_eq!(plugin_secret_as_kept("meshy", "  msy_123 \n"), "msy_123");

        // Corrupt file refuses load without overwriting.
        fs::write(dir.path().join("plugin-accounts.json"), "{broken").unwrap();
        let mut corrupt = PluginAccountsStore::new(dir.path());
        assert!(corrupt.load(|_| true).is_err());
    }

    #[test]
    fn mail_grants_copy_choices_spending_and_records_enforce_parity_invariants() {
        let dir = tempfile::tempdir().unwrap();
        let acc_mail = Uuid::new_v4().to_string();
        let acc_meshy = Uuid::new_v4().to_string();
        let sess = Uuid::new_v4().to_string();
        let month = current_local_month();

        // Mail grants: grant, generation invalidation, stop persistence.
        let mut grants = MailGrantsStore::new(dir.path());
        let gen0 = grants.generation(&acc_mail);
        assert!(grants.grant("t-1", &acc_mail, true, Some(gen0)));
        assert!(grants.has("t-1", &acc_mail, true));
        grants.forget_account(&acc_mail);
        assert!(!grants.grant("t-1", &acc_mail, true, Some(gen0)));
        assert!(grants.grant("t-1", &acc_mail, true, Some(grants.generation(&acc_mail))));
        assert!(grants.stop("t-1", &acc_mail));
        let mut reloaded_grants = MailGrantsStore::new(dir.path());
        assert!(!reloaded_grants.has("t-1", &acc_mail, true));

        // HeardSpending: #earlier month rollover + monotonic revision check.
        let mut heard = HeardSpendingStore::new(dir.path().join("plugin-meshy-spending.json"));
        heard
            .hear(
                "host-a",
                &[SpendingReport {
                    account_id: acc_meshy.clone(),
                    month: month.clone(),
                    credits: 60,
                    session: sess.clone(),
                    revision: 2,
                }],
            )
            .unwrap();
        // Stale revision 1 from same session is ignored.
        let changed = heard
            .hear(
                "host-a",
                &[SpendingReport {
                    account_id: acc_meshy.clone(),
                    month: month.clone(),
                    credits: 999,
                    session: sess.clone(),
                    revision: 1,
                }],
            )
            .unwrap();
        assert!(!changed);
        assert_eq!(heard.total(&acc_meshy, &month, None).unwrap(), 60);

        // Next month arrives from host-a: previous month stays counted under #earlier!
        heard
            .hear(
                "host-a",
                &[SpendingReport {
                    account_id: acc_meshy.clone(),
                    month: "2099-01".into(),
                    credits: 0,
                    session: sess,
                    revision: 3,
                }],
            )
            .unwrap();
        assert_eq!(heard.total(&acc_meshy, &month, None).unwrap(), 60);

        // Copy choices: project-scoped or proton-mail accounts stay `here-only`.
        let mut copies = PluginCopyChoicesStore::new(dir.path());
        copies.set_copy(&acc_meshy, "comp-1", false).unwrap();
        let view = copies.view(
            &[
                PluginAccount {
                    id: acc_meshy.clone(),
                    plugin: "meshy".into(),
                    name: "Meshy".into(),
                    saved_at: now_iso(),
                    signed_in_as: None,
                    address: None,
                    on: true,
                    projects: None,
                    spending: Some(PluginSpending {
                        ask_before: true,
                        monthly_limit: 1000,
                        extra: Map::new(),
                    }),
                    bridge: None,
                    extra: Map::new(),
                },
                PluginAccount {
                    id: acc_mail,
                    plugin: "proton-mail".into(),
                    name: "Proton".into(),
                    saved_at: now_iso(),
                    signed_in_as: None,
                    address: Some("a@proton.me".into()),
                    on: true,
                    projects: None,
                    spending: None,
                    bridge: None,
                    extra: Map::new(),
                },
            ],
            &[CopyComputerView {
                id: "comp-1".into(),
                name: "Forge".into(),
                connected: true,
            }],
        );
        assert!(view.readable);
        assert_eq!(view.copies[0].state, "off");
        assert_eq!(view.copies[1].state, "here-only");
    }

    #[test]
    fn parses_gh_auth_status_json_and_legacy_worded_output() {
        assert_eq!(
            parse_github_sign_in_json(
                r#"{"hosts":{"github.com":[{"active":false,"login":"old","state":"success"},{"active":true,"login":"millZach","state":"success"}]}}"#
            ),
            GitHubSignIn::SignedIn {
                login: "millZach".into()
            }
        );
        assert_eq!(
            parse_github_sign_in_json(
                r#"{"hosts":{"github.com":[{"active":true,"login":"millZach","state":"refresh_expired"}]}}"#
            ),
            GitHubSignIn::SignedOut
        );
        assert_eq!(
            parse_github_sign_in_words(
                "github.com\n  ✓ Logged in to github.com account millZach (keyring)\n  - Active account: true\n"
            ),
            GitHubSignIn::SignedIn {
                login: "millZach".into()
            }
        );
        assert_eq!(
            parse_github_sign_in_words("You are not logged into any GitHub hosts."),
            GitHubSignIn::SignedOut
        );
        assert_eq!(
            parse_github_sign_in_words("gh: connection timed out"),
            GitHubSignIn::Unknown
        );
    }
}
