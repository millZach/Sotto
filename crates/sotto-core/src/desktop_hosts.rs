//! Desktop remote-host persistence, tailnet connection preferences, retained remote drafts,
//! cross-machine cascaded settles, incremental `FilesBindingsTracker`, and `DesktopHostsManager`.
//!
//! Shares `remote-hosts.json`, `remote-host-tailnet.json`, `remote-drafts.json`, and
//! `cross-machine-settles.json` byte-compatibly with Sotto's TypeScript `DesktopHosts`,
//! `TailnetStore`, `RetainedDraftStore`, and `CascadedSettles`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::workspace::write_atomic_json;

pub const REMOTE_HOSTS_FILE: &str = "remote-hosts.json";
pub const TAILNET_STORE_FILE: &str = "remote-host-tailnet.json";
pub const RETAINED_DRAFTS_FILE: &str = "remote-drafts.json";
pub const CASCADED_SETTLES_FILE: &str = "cross-machine-settles.json";

pub const SAVED_HOSTS_MAX: usize = 20;
pub const TAILNET_ENTRIES_MAX: usize = 100;
pub const RETAINED_DRAFTS_FILE_MAX: usize = 1024;
pub const RETAINED_DRAFTS_LIVE_MAX: usize = 512;
pub const CASCADED_SETTLES_MAX: usize = 10_000;
pub const CASCADED_SETTLE_KEY_MAX: usize = 600;
pub const SETTLE_CASCADE_SKEW_MS: i64 = 2 * 60_000;

pub const DEFAULT_HOST_INSTALL_PATH: &str = "~/.local/share/sotto-host";
pub const DEFAULT_HOST_DATA_DIRECTORY: &str = "~/.sotto";

/// Credential-store slot for a saved remote host's pairing token.
pub fn remote_host_credential_slot(saved_id: &str) -> String {
    format!("remote-host:{saved_id}")
}

// ---------------------------------------------------------------------------
// Saved Hosts (`remote-hosts.json`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedHost {
    pub id: String,
    pub name: String,
    pub target: String,
    #[serde(default)]
    pub identity_file: String,
    pub install_path: String,
    pub data_directory: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
}

impl SavedHost {
    pub fn is_enabled(&self) -> bool {
        self.enabled.unwrap_or(true)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("Host id is required.".into());
        }
        let name = self.name.trim();
        if name.is_empty() || name.chars().count() > 80 {
            return Err("Host name must be 1 to 80 characters.".into());
        }
        let target = self.target.trim();
        if target.is_empty() || target.chars().count() > 256 {
            return Err("Host target must be 1 to 256 characters.".into());
        }
        if self.install_path.is_empty() || self.install_path.chars().count() > 4096 {
            return Err("Host installPath is invalid.".into());
        }
        if self.data_directory.is_empty() || self.data_directory.chars().count() > 4096 {
            return Err("Host dataDirectory is invalid.".into());
        }
        if let Some(port) = self.ssh_port {
            if port == 0 {
                return Err("SSH port must be between 1 and 65535.".into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct SavedHostsStore {
    file: PathBuf,
    hosts: Vec<SavedHost>,
}

impl SavedHostsStore {
    pub fn new(data_directory: &Path) -> Self {
        Self {
            file: data_directory.join(REMOTE_HOSTS_FILE),
            hosts: Vec::new(),
        }
    }

    pub fn load(&mut self) -> Result<(), String> {
        let text = match fs::read_to_string(&self.file) {
            Ok(t) => t,
            Err(err) if err.kind() == ErrorKind::NotFound => {
                self.hosts.clear();
                return Ok(());
            }
            Err(err) => return Err(format!("Could not read remote-hosts.json: {err}")),
        };
        let parsed: Vec<SavedHost> = serde_json::from_str(&text)
            .map_err(|err| format!("Invalid remote-hosts.json: {err}"))?;
        if parsed.len() > SAVED_HOSTS_MAX {
            return Err(format!(
                "remote-hosts.json exceeds {SAVED_HOSTS_MAX} saved hosts."
            ));
        }
        for host in &parsed {
            host.validate()?;
        }
        self.hosts = parsed;
        Ok(())
    }

    pub fn list(&self) -> &[SavedHost] {
        &self.hosts
    }

    pub fn get(&self, id: &str) -> Option<&SavedHost> {
        self.hosts.iter().find(|h| h.id == id)
    }

    pub fn upsert(&mut self, host: SavedHost) -> Result<(), String> {
        host.validate()?;
        if let Some(existing) = self.hosts.iter_mut().find(|h| h.id == host.id) {
            *existing = host;
        } else {
            if self.hosts.len() >= SAVED_HOSTS_MAX {
                return Err(format!("Sotto keeps at most {SAVED_HOSTS_MAX} saved hosts."));
            }
            self.hosts.push(host);
        }
        self.persist()
    }

    pub fn rename(&mut self, id: &str, name: &str) -> Result<bool, String> {
        let trimmed = name.trim();
        if trimmed.is_empty() || trimmed.chars().count() > 80 {
            return Err("Host name must be 1 to 80 characters.".into());
        }
        let Some(host) = self.hosts.iter_mut().find(|h| h.id == id) else {
            return Ok(false);
        };
        host.name = trimmed.to_string();
        self.persist()?;
        Ok(true)
    }

    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<bool, String> {
        let Some(host) = self.hosts.iter_mut().find(|h| h.id == id) else {
            return Ok(false);
        };
        host.enabled = Some(enabled);
        self.persist()?;
        Ok(true)
    }

    pub fn set_identity(
        &mut self,
        id: &str,
        host_id: Option<String>,
        client_id: Option<String>,
    ) -> Result<bool, String> {
        let Some(host) = self.hosts.iter_mut().find(|h| h.id == id) else {
            return Ok(false);
        };
        if host_id.is_some() {
            host.host_id = host_id;
        }
        if client_id.is_some() {
            host.client_id = client_id;
        }
        self.persist()?;
        Ok(true)
    }

    pub fn remove(&mut self, id: &str) -> Result<Option<SavedHost>, String> {
        let Some(pos) = self.hosts.iter().position(|h| h.id == id) else {
            return Ok(None);
        };
        let removed = self.hosts.remove(pos);
        self.persist()?;
        Ok(Some(removed))
    }

    fn persist(&self) -> Result<(), String> {
        write_atomic_json(&self.file, &self.hosts)
            .map_err(|err| format!("Could not write remote-hosts.json: {err}"))
    }
}

// ---------------------------------------------------------------------------
// Tailnet Store (`remote-host-tailnet.json`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostConnectionPreference {
    Ssh,
    Tailnet,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailnetEntry {
    pub id: String,
    pub prefer: HostConnectionPreference,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address_seen: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boot_start: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// Preserves unknown fields added by newer Sotto builds (matching `z.looseObject`).
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone)]
pub struct TailnetStore {
    file: PathBuf,
    entries: Vec<TailnetEntry>,
}

impl TailnetStore {
    pub fn new(data_directory: &Path) -> Self {
        Self {
            file: data_directory.join(TAILNET_STORE_FILE),
            entries: Vec::new(),
        }
    }

    pub fn load(&mut self) -> Result<(), String> {
        let text = match fs::read_to_string(&self.file) {
            Ok(t) => t,
            Err(err) if err.kind() == ErrorKind::NotFound => {
                self.entries.clear();
                return Ok(());
            }
            Err(err) => return Err(format!("Could not read remote-host-tailnet.json: {err}")),
        };
        let parsed: Vec<TailnetEntry> = serde_json::from_str(&text)
            .map_err(|err| format!("Invalid remote-host-tailnet.json: {err}"))?;
        if parsed.len() > TAILNET_ENTRIES_MAX {
            return Err("remote-host-tailnet.json has too many entries.".into());
        }
        self.entries = parsed;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<&TailnetEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    pub fn prefer_of(&self, id: &str) -> HostConnectionPreference {
        self.get(id)
            .map(|e| e.prefer)
            .unwrap_or(HostConnectionPreference::Ssh)
    }

    pub fn has(&self, id: &str) -> bool {
        self.entries.iter().any(|e| e.id == id)
    }

    pub fn set_preference(
        &mut self,
        id: &str,
        prefer: HostConnectionPreference,
        address: Option<Option<String>>,
        address_seen: Option<Option<u64>>,
        system: Option<Option<String>>,
    ) -> Result<(), String> {
        let mut next = self
            .entries
            .iter()
            .find(|e| e.id == id)
            .cloned()
            .unwrap_or_else(|| TailnetEntry {
                id: id.to_string(),
                prefer,
                address: None,
                address_seen: None,
                boot_start: None,
                system: None,
                extra: BTreeMap::new(),
            });
        next.prefer = prefer;
        if let Some(addr) = address {
            next.address = addr;
        }
        if let Some(seen) = address_seen {
            next.address_seen = seen;
        }
        if let Some(sys) = system {
            next.system = sys;
        }
        self.entries.retain(|e| e.id != id);
        self.entries.push(next);
        write_atomic_json(&self.file, &self.entries)
            .map_err(|err| format!("Could not write remote-host-tailnet.json: {err}"))
    }

    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        let before = self.entries.len();
        self.entries.retain(|e| e.id != id);
        if self.entries.len() != before {
            write_atomic_json(&self.file, &self.entries)
                .map_err(|err| format!("Could not write remote-host-tailnet.json: {err}"))?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Retained Draft Store (`remote-drafts.json`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetainedSendAttempt {
    pub command_id: String,
    pub draft_id: String,
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packet_digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetainedDraft {
    pub host_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registration_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_kind: Option<String>,
    pub draft: Value,
    pub questions_digest: Option<String>,
    pub saved: bool,
    pub recovery: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_draft_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_draft_id: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub send_attempt: Option<RetainedSendAttempt>,
}

impl RetainedDraft {
    fn thread_id(&self) -> Option<&str> {
        self.draft.get("threadId").and_then(Value::as_str)
    }

    fn draft_id(&self) -> Option<&str> {
        self.draft.get("draftId").and_then(Value::as_str)
    }
}

#[derive(Debug, Clone)]
pub struct RetainedDraftStore {
    file: PathBuf,
    edits: BTreeMap<(String, String), RetainedDraft>,
    saved_hosts: Option<HashMap<String, String>>,
    forgotten_hosts: HashSet<String>,
    keep_history: bool,
    storage_available: bool,
}

impl RetainedDraftStore {
    pub fn new(data_directory: &Path) -> Self {
        Self {
            file: data_directory.join(RETAINED_DRAFTS_FILE),
            edits: BTreeMap::new(),
            saved_hosts: None,
            forgotten_hosts: HashSet::new(),
            keep_history: true,
            storage_available: true,
        }
    }

    pub fn storage_available(&self) -> bool {
        self.storage_available
    }

    pub fn load(&mut self) -> Result<(), String> {
        let text = match fs::read_to_string(&self.file) {
            Ok(t) => t,
            Err(err) if err.kind() == ErrorKind::NotFound => {
                self.storage_available = true;
                return Ok(());
            }
            Err(err) => {
                self.storage_available = false;
                return Err(format!("Could not read remote-drafts.json: {err}"));
            }
        };
        let parsed: Vec<RetainedDraft> = match serde_json::from_str(&text) {
            Ok(list) => list,
            Err(err) => {
                self.storage_available = false;
                return Err(format!("Saved remote drafts could not be read: {err}"));
            }
        };
        if parsed.len() > RETAINED_DRAFTS_FILE_MAX {
            self.storage_available = false;
            return Err("remote-drafts.json exceeds maximum capacity.".into());
        }
        self.storage_available = true;
        if !self.keep_history {
            self.persist()?;
            return Ok(());
        }
        for mut edit in parsed {
            if !self.accepts_edit(&edit) {
                continue;
            }
            let Some(tid) = edit.thread_id().map(ToString::to_string) else {
                continue;
            };
            let key = (edit.host_id.clone(), tid);
            edit.recovery = !edit.saved || edit.recovery;
            self.edits.entry(key).or_insert(edit);
        }
        Ok(())
    }

    pub fn set_saved_hosts(&mut self, hosts: Vec<(String, String)>) {
        let map: HashMap<String, String> = hosts.into_iter().collect();
        self.saved_hosts = Some(map);
        let before = self.edits.len();
        let saved_hosts = &self.saved_hosts;
        let forgotten_hosts = &self.forgotten_hosts;
        self.edits.retain(|_, edit| Self::accepts_edit_parts(saved_hosts, forgotten_hosts, edit));
        if self.edits.len() != before {
            let _ = self.persist();
        }
    }

    pub fn allow_host(&mut self, host_id: &str, registration_id: Option<String>) {
        if let (Some(map), Some(reg)) = (self.saved_hosts.as_mut(), registration_id) {
            map.insert(host_id.to_string(), reg);
        }
        self.forgotten_hosts.remove(host_id);
        let before = self.edits.len();
        let saved_hosts = &self.saved_hosts;
        let forgotten_hosts = &self.forgotten_hosts;
        self.edits.retain(|_, edit| Self::accepts_edit_parts(saved_hosts, forgotten_hosts, edit));
        if self.edits.len() != before {
            let _ = self.persist();
        }
    }

    fn accepts_edit(&self, edit: &RetainedDraft) -> bool {
        Self::accepts_edit_parts(&self.saved_hosts, &self.forgotten_hosts, edit)
    }

    fn accepts_edit_parts(
        saved_hosts: &Option<HashMap<String, String>>,
        forgotten_hosts: &HashSet<String>,
        edit: &RetainedDraft,
    ) -> bool {
        if forgotten_hosts.contains(&edit.host_id) {
            return false;
        }
        if let Some(ref map) = saved_hosts {
            match map.get(&edit.host_id) {
                Some(reg) => edit.registration_id.as_deref() == Some(reg.as_str()),
                None => false,
            }
        } else {
            true
        }
    }

    pub fn get(&self, host_id: &str, thread_id: &str) -> Option<&RetainedDraft> {
        let edit = self
            .edits
            .get(&(host_id.to_string(), thread_id.to_string()))?;
        if self.accepts_edit(edit) {
            Some(edit)
        } else {
            None
        }
    }

    pub fn list(&self, host_id: &str) -> Vec<RetainedDraft> {
        self.edits
            .values()
            .filter(|e| e.host_id == host_id && self.accepts_edit(e))
            .cloned()
            .collect()
    }

    pub fn put(&mut self, edit: RetainedDraft) -> Result<(), String> {
        if !self.accepts_edit(&edit) {
            return Ok(());
        }
        let Some(tid) = edit.thread_id().map(ToString::to_string) else {
            return Err("Retained draft requires draft.threadId.".into());
        };
        let key = (edit.host_id.clone(), tid);
        if !self.edits.contains_key(&key) && self.edits.len() >= RETAINED_DRAFTS_LIVE_MAX {
            return Err(
                "This computer has too many unsent remote drafts. Save or clear a draft before starting another."
                    .into(),
            );
        }
        self.edits.insert(key, edit);
        self.persist()
    }

    pub fn mark_saved(
        &mut self,
        host_id: &str,
        thread_id: &str,
        draft_id: &str,
        acknowledged: Value,
    ) -> Result<(), String> {
        let key = (host_id.to_string(), thread_id.to_string());
        let Some(edit) = self.edits.get_mut(&key) else {
            return Ok(());
        };
        if edit.draft_id() != Some(draft_id) {
            return Ok(());
        }
        let ack_draft_id = acknowledged
            .get("draftId")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let mut merged = acknowledged;
        if let Some(obj) = merged.as_object_mut() {
            obj.insert("draftId".into(), Value::String(draft_id.to_string()));
        }
        edit.draft = merged;
        edit.saved = true;
        edit.recovery = false;
        edit.host_draft_id = ack_draft_id.clone();
        edit.base_draft_id = Some(ack_draft_id);
        self.persist()
    }

    pub fn remove(
        &mut self,
        host_id: &str,
        thread_id: &str,
        draft_id: Option<&str>,
    ) -> Result<(), String> {
        let key = (host_id.to_string(), thread_id.to_string());
        let matches = self
            .edits
            .get(&key)
            .map(|e| draft_id.is_none() || e.draft_id() == draft_id)
            .unwrap_or(false);
        if matches {
            self.edits.remove(&key);
            self.persist()?;
        }
        Ok(())
    }

    pub fn forget_host(&mut self, host_id: &str) -> Result<(), String> {
        self.forgotten_hosts.insert(host_id.to_string());
        if let Some(ref mut map) = self.saved_hosts {
            map.remove(host_id);
        }
        self.edits.retain(|(h, _), _| h != host_id);
        self.persist()
    }

    pub fn set_history_enabled(&mut self, enabled: bool) -> Result<(), String> {
        self.keep_history = enabled;
        self.persist()
    }

    fn persist(&self) -> Result<(), String> {
        if !self.storage_available && self.keep_history {
            return Err("Saved remote drafts could not be read. The original file was preserved. Repair local storage before saving draft text.".into());
        }
        let snapshot: Vec<&RetainedDraft> = if self.keep_history {
            self.edits.values().collect()
        } else {
            Vec::new()
        };
        write_atomic_json(&self.file, &snapshot)
            .map_err(|err| format!("Could not write remote-drafts.json: {err}"))
    }
}

// ---------------------------------------------------------------------------
// Cascaded Settles (`cross-machine-settles.json`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CascadedSettleEntry {
    pub parent: String,
    pub settled: Vec<String>,
    pub left: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uncertain: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CascadedSettlesFile {
    version: u32,
    settles: Vec<CascadedSettleEntry>,
}

/// Whether a remote delegated thread settled within `SETTLE_CASCADE_SKEW_MS` (2 min) of its parent.
pub fn settled_with_parent(parent_settled_at: Option<&str>, child_settled_at: Option<&str>) -> bool {
    let (Some(p), Some(c)) = (parent_settled_at, child_settled_at) else {
        return false;
    };
    let (Ok(p_dt), Ok(c_dt)) = (
        DateTime::parse_from_rfc3339(p),
        DateTime::parse_from_rfc3339(c),
    ) else {
        return false;
    };
    (c_dt.timestamp_millis() - p_dt.timestamp_millis()).abs() <= SETTLE_CASCADE_SKEW_MS
}

#[derive(Debug, Clone)]
pub struct CascadedSettlesStore {
    file: PathBuf,
    /// Insertion-ordered entries (newest at the back, matching JS Map iteration order).
    entries: Vec<CascadedSettleEntry>,
}

impl CascadedSettlesStore {
    pub fn new(data_directory: &Path) -> Self {
        Self {
            file: data_directory.join(CASCADED_SETTLES_FILE),
            entries: Vec::new(),
        }
    }

    pub fn load(&mut self) -> Result<(), String> {
        let text = match fs::read_to_string(&self.file) {
            Ok(t) => t,
            Err(err) if err.kind() == ErrorKind::NotFound => {
                self.entries.clear();
                return Ok(());
            }
            Err(err) => return Err(format!("Could not read cross-machine-settles.json: {err}")),
        };
        let parsed: CascadedSettlesFile = serde_json::from_str(&text)
            .map_err(|err| format!("Invalid cross-machine-settles.json: {err}"))?;
        if parsed.version != 1 || parsed.settles.len() > CASCADED_SETTLES_MAX {
            return Err("Invalid cross-machine-settles.json version or capacity.".into());
        }
        self.entries = parsed.settles;
        Ok(())
    }

    pub fn of(&self, parent: &str) -> Option<&CascadedSettleEntry> {
        self.entries.iter().find(|e| e.parent == parent)
    }

    pub fn keep(
        &mut self,
        parent: &str,
        settled: Vec<String>,
        left: Vec<String>,
        uncertain: Vec<String>,
    ) -> Result<(), String> {
        let fits = |k: &String| !k.is_empty() && k.len() <= CASCADED_SETTLE_KEY_MAX;
        self.entries.retain(|e| e.parent != parent);
        if parent.is_empty() || parent.len() > CASCADED_SETTLE_KEY_MAX {
            return self.persist();
        }
        let settled: Vec<String> = settled.into_iter().filter(fits).collect();
        let left: Vec<String> = left.into_iter().filter(fits).collect();
        let uncertain_clean: Vec<String> = uncertain.into_iter().filter(fits).collect();
        self.entries.push(CascadedSettleEntry {
            parent: parent.to_string(),
            settled,
            left,
            uncertain: if uncertain_clean.is_empty() {
                None
            } else {
                Some(uncertain_clean)
            },
        });
        if self.entries.len() > CASCADED_SETTLES_MAX {
            self.entries.remove(0);
        }
        self.persist()
    }

    pub fn forget(&mut self, parent: &str) -> Result<bool, String> {
        let before = self.entries.len();
        self.entries.retain(|e| e.parent != parent);
        if self.entries.len() != before {
            self.persist()?;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn forget_all(&mut self, parents: &[String]) -> Result<(), String> {
        let set: HashSet<&str> = parents.iter().map(String::as_str).collect();
        let before = self.entries.len();
        self.entries.retain(|e| !set.contains(e.parent.as_str()));
        if self.entries.len() != before {
            self.persist()?;
        }
        Ok(())
    }

    fn persist(&self) -> Result<(), String> {
        let payload = CascadedSettlesFile {
            version: 1,
            settles: self.entries.clone(),
        };
        write_atomic_json(&self.file, &payload)
            .map_err(|err| format!("Could not write cross-machine-settles.json: {err}"))
    }
}

// ---------------------------------------------------------------------------
// FilesBindingsTracker (`FilesBindingsDelta`, matching filesBindingsMirror.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesBindingEntry {
    pub thread_id: String,
    pub project_id: String,
    pub working_directory: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_only: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostThreadFoldersEntry {
    pub host_id: String,
    pub project_id: String,
    pub working_directory: String,
    pub project_folder: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTerminalHostEntry {
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesBindingsDelta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bindings: Option<BTreeMap<String, Option<FilesBindingEntry>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_folders: Option<BTreeMap<String, Option<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_titles: Option<BTreeMap<String, Option<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hosted_folders: Option<BTreeMap<String, Option<HostThreadFoldersEntry>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_hosts: Option<BTreeMap<String, Option<SshTerminalHostEntry>>>,
}

#[derive(Debug, Default)]
pub struct FilesBindingsTracker {
    bindings: BTreeMap<String, FilesBindingEntry>,
    project_folders: BTreeMap<String, String>,
    thread_titles: BTreeMap<String, String>,
    hosted_folders: BTreeMap<String, HostThreadFoldersEntry>,
    terminal_hosts: BTreeMap<String, SshTerminalHostEntry>,
}

impl FilesBindingsTracker {
    pub fn sync_local(&mut self, host: &Value) -> Option<FilesBindingsDelta> {
        let mut project_patch: BTreeMap<String, Option<String>> = BTreeMap::new();
        let mut seen_projects: HashSet<String> = HashSet::new();
        let mut project_map: HashMap<String, String> = HashMap::new();

        if let Some(projects) = host.get("projects").and_then(Value::as_array) {
            for p in projects {
                let (Some(id), Some(path)) = (
                    p.get("id").and_then(Value::as_str),
                    p.get("path").and_then(Value::as_str),
                ) else {
                    continue;
                };
                seen_projects.insert(id.to_string());
                project_map.insert(id.to_string(), path.to_string());
                if self.project_folders.get(id).map(String::as_str) != Some(path) {
                    self.project_folders.insert(id.to_string(), path.to_string());
                    project_patch.insert(id.to_string(), Some(path.to_string()));
                }
            }
        }
        let stale_projects: Vec<String> = self
            .project_folders
            .keys()
            .filter(|id| !seen_projects.contains(*id))
            .cloned()
            .collect();
        for id in stale_projects {
            self.project_folders.remove(&id);
            project_patch.insert(id, None);
        }

        let mut binding_patch: BTreeMap<String, Option<FilesBindingEntry>> = BTreeMap::new();
        let mut title_patch: BTreeMap<String, Option<String>> = BTreeMap::new();
        let mut seen_threads: HashSet<String> = HashSet::new();

        if let Some(threads) = host.get("threads").and_then(Value::as_array) {
            for t in threads {
                let Some(tid) = t.get("id").and_then(Value::as_str) else {
                    continue;
                };
                seen_threads.insert(tid.to_string());
                let project_id = t
                    .get("projectId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let working_dir = t
                    .get("workingDirectory")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string)
                    .or_else(|| project_map.get(&project_id).cloned());
                let title = t.get("title").and_then(Value::as_str).unwrap_or("");

                if let Some(wd) = working_dir {
                    let next = FilesBindingEntry {
                        thread_id: tid.to_string(),
                        project_id,
                        working_directory: wd,
                        preview_only: None,
                    };
                    if self.bindings.get(tid) != Some(&next) {
                        self.bindings.insert(tid.to_string(), next.clone());
                        binding_patch.insert(tid.to_string(), Some(next));
                    }
                } else if self.bindings.remove(tid).is_some() {
                    binding_patch.insert(tid.to_string(), None);
                }

                if self.thread_titles.get(tid).map(String::as_str) != Some(title) {
                    self.thread_titles.insert(tid.to_string(), title.to_string());
                    title_patch.insert(tid.to_string(), Some(title.to_string()));
                }
            }
        }
        let stale_bindings: Vec<String> = self
            .bindings
            .keys()
            .filter(|id| !seen_threads.contains(*id))
            .cloned()
            .collect();
        for id in stale_bindings {
            self.bindings.remove(&id);
            binding_patch.insert(id, None);
        }
        let stale_titles: Vec<String> = self
            .thread_titles
            .keys()
            .filter(|id| !seen_threads.contains(*id))
            .cloned()
            .collect();
        for id in stale_titles {
            self.thread_titles.remove(&id);
            title_patch.insert(id, None);
        }

        if binding_patch.is_empty() && project_patch.is_empty() && title_patch.is_empty() {
            return None;
        }
        Some(FilesBindingsDelta {
            reset: None,
            bindings: if binding_patch.is_empty() {
                None
            } else {
                Some(binding_patch)
            },
            project_folders: if project_patch.is_empty() {
                None
            } else {
                Some(project_patch)
            },
            thread_titles: if title_patch.is_empty() {
                None
            } else {
                Some(title_patch)
            },
            hosted_folders: None,
            terminal_hosts: None,
        })
    }

    pub fn sync_hosted(
        &mut self,
        hosted: &BTreeMap<String, HostThreadFoldersEntry>,
        terminals: &BTreeMap<String, SshTerminalHostEntry>,
    ) -> Option<FilesBindingsDelta> {
        let mut hosted_patch: BTreeMap<String, Option<HostThreadFoldersEntry>> = BTreeMap::new();
        for (id, entry) in hosted {
            if self.hosted_folders.get(id) != Some(entry) {
                self.hosted_folders.insert(id.clone(), entry.clone());
                hosted_patch.insert(id.clone(), Some(entry.clone()));
            }
        }
        let stale_hosted: Vec<String> = self
            .hosted_folders
            .keys()
            .filter(|id| !hosted.contains_key(*id))
            .cloned()
            .collect();
        for id in stale_hosted {
            self.hosted_folders.remove(&id);
            hosted_patch.insert(id, None);
        }

        let mut terminal_patch: BTreeMap<String, Option<SshTerminalHostEntry>> = BTreeMap::new();
        for (id, entry) in terminals {
            if self.terminal_hosts.get(id) != Some(entry) {
                self.terminal_hosts.insert(id.clone(), entry.clone());
                terminal_patch.insert(id.clone(), Some(entry.clone()));
            }
        }
        let stale_terms: Vec<String> = self
            .terminal_hosts
            .keys()
            .filter(|id| !terminals.contains_key(*id))
            .cloned()
            .collect();
        for id in stale_terms {
            self.terminal_hosts.remove(&id);
            terminal_patch.insert(id, None);
        }

        if hosted_patch.is_empty() && terminal_patch.is_empty() {
            return None;
        }
        Some(FilesBindingsDelta {
            reset: None,
            bindings: None,
            project_folders: None,
            thread_titles: None,
            hosted_folders: if hosted_patch.is_empty() {
                None
            } else {
                Some(hosted_patch)
            },
            terminal_hosts: if terminal_patch.is_empty() {
                None
            } else {
                Some(terminal_patch)
            },
        })
    }

    pub fn snapshot(&self) -> FilesBindingsDelta {
        FilesBindingsDelta {
            reset: Some(true),
            bindings: Some(
                self.bindings
                    .iter()
                    .map(|(k, v)| (k.clone(), Some(v.clone())))
                    .collect(),
            ),
            project_folders: Some(
                self.project_folders
                    .iter()
                    .map(|(k, v)| (k.clone(), Some(v.clone())))
                    .collect(),
            ),
            thread_titles: Some(
                self.thread_titles
                    .iter()
                    .map(|(k, v)| (k.clone(), Some(v.clone())))
                    .collect(),
            ),
            hosted_folders: Some(
                self.hosted_folders
                    .iter()
                    .map(|(k, v)| (k.clone(), Some(v.clone())))
                    .collect(),
            ),
            terminal_hosts: Some(
                self.terminal_hosts
                    .iter()
                    .map(|(k, v)| (k.clone(), Some(v.clone())))
                    .collect(),
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// DesktopHostsManager (`hosts:get` / `hosts:command` state)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatusView {
    pub id: String,
    pub name: String,
    pub target: String,
    pub identity_file: String,
    pub install_path: String,
    pub data_directory: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_port: Option<u16>,
    pub enabled: bool,
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefer: Option<HostConnectionPreference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<HostConnectionPreference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tailnet_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tailnet_seen: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostsStateView {
    pub hosts: Vec<HostStatusView>,
    pub local_host_enabled: bool,
    pub local_host_running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_host_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_host_id: Option<String>,
}

pub struct DesktopHostsManager {
    pub saved: SavedHostsStore,
    pub tailnet: TailnetStore,
    pub drafts: RetainedDraftStore,
    pub settles: CascadedSettlesStore,
    local_host_id: String,
    active_host_id: Option<String>,
    local_host_enabled: bool,
    local_host_running: bool,
    live_phases: HashMap<String, (String, Option<String>, Option<HostConnectionPreference>)>,
}

impl DesktopHostsManager {
    pub fn new(data_directory: &Path, local_host_id: String) -> Self {
        Self {
            saved: SavedHostsStore::new(data_directory),
            tailnet: TailnetStore::new(data_directory),
            drafts: RetainedDraftStore::new(data_directory),
            settles: CascadedSettlesStore::new(data_directory),
            active_host_id: Some(local_host_id.clone()),
            local_host_id,
            local_host_enabled: true,
            local_host_running: true,
            live_phases: HashMap::new(),
        }
    }

    pub fn load(&mut self) -> Result<(), String> {
        self.saved.load()?;
        self.tailnet.load()?;
        let pairs: Vec<(String, String)> = self
            .saved
            .list()
            .iter()
            .filter_map(|h| h.host_id.as_ref().map(|hid| (hid.clone(), h.id.clone())))
            .collect();
        self.drafts.set_saved_hosts(pairs);
        let _ = self.drafts.load();
        let _ = self.settles.load();
        Ok(())
    }

    pub fn set_live_phase(
        &mut self,
        saved_id: &str,
        phase: impl Into<String>,
        version: Option<String>,
        via: Option<HostConnectionPreference>,
    ) {
        self.live_phases
            .insert(saved_id.to_string(), (phase.into(), version, via));
    }

    pub fn select_host(&mut self, host_id: String) {
        self.active_host_id = Some(host_id);
    }

    pub fn state(&self) -> HostsStateView {
        let hosts = self
            .saved
            .list()
            .iter()
            .map(|h| {
                let tn = self.tailnet.get(&h.id);
                let (phase, version, via) = self
                    .live_phases
                    .get(&h.id)
                    .cloned()
                    .unwrap_or_else(|| ("disconnected".to_string(), None, None));
                HostStatusView {
                    id: h.id.clone(),
                    name: h.name.clone(),
                    target: h.target.clone(),
                    identity_file: h.identity_file.clone(),
                    install_path: h.install_path.clone(),
                    data_directory: h.data_directory.clone(),
                    ssh_port: h.ssh_port,
                    enabled: h.is_enabled(),
                    phase,
                    host_id: h.host_id.clone(),
                    client_id: h.client_id.clone(),
                    version,
                    prefer: tn.map(|e| e.prefer),
                    via,
                    tailnet_address: tn.and_then(|e| e.address.clone()),
                    tailnet_seen: tn.and_then(|e| e.address_seen),
                    error: None,
                }
            })
            .collect();
        HostsStateView {
            hosts,
            local_host_enabled: self.local_host_enabled,
            local_host_running: self.local_host_running,
            active_host_id: self.active_host_id.clone(),
            local_host_id: Some(self.local_host_id.clone()),
        }
    }

    pub fn forget_host(&mut self, id: &str) -> Result<Option<SavedHost>, String> {
        let removed = self.saved.remove(id)?;
        let _ = self.tailnet.delete(id);
        self.live_phases.remove(id);
        if let Some(ref host) = removed {
            if let Some(ref hid) = host.host_id {
                let _ = self.drafts.forget_host(hid);
            }
        }
        Ok(removed)
    }
}

/// Non-mutating summary of desktop-hosts stores for `--accelerator` mode (`ops.desktopHostsReadOnly`).
pub fn read_desktop_hosts_readonly(data_directory: &Path) -> Value {
    let mut saved = SavedHostsStore::new(data_directory);
    let saved_ok = saved.load().is_ok();
    let mut tailnet = TailnetStore::new(data_directory);
    let tailnet_ok = tailnet.load().is_ok();
    let mut drafts = RetainedDraftStore::new(data_directory);
    let drafts_ok = drafts.load().is_ok();
    let mut settles = CascadedSettlesStore::new(data_directory);
    let settles_ok = settles.load().is_ok();

    json!({
        "savedHosts": saved.list().len(),
        "savedHostsReadable": saved_ok,
        "tailnetEntries": tailnet.entries.len(),
        "tailnetReadable": tailnet_ok,
        "retainedDrafts": drafts.edits.len(),
        "retainedDraftsReadable": drafts_ok,
        "cascadedSettles": settles.entries.len(),
        "cascadedSettlesReadable": settles_ok,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn saved_hosts_tailnet_drafts_and_settles_round_trip_with_ts_schemas() {
        let dir = TempDir::new().unwrap();
        let host_reg_id = "11111111-1111-4111-8111-111111111111";
        let remote_host_id = "22222222-2222-4222-8222-222222222222";

        let mut mgr = DesktopHostsManager::new(dir.path(), "local-host-id".into());
        mgr.saved
            .upsert(SavedHost {
                id: host_reg_id.into(),
                name: "Forge".into(),
                target: "zach@forge".into(),
                identity_file: "".into(),
                install_path: DEFAULT_HOST_INSTALL_PATH.into(),
                data_directory: DEFAULT_HOST_DATA_DIRECTORY.into(),
                ssh_port: Some(2222),
                enabled: Some(true),
                host_id: Some(remote_host_id.into()),
                client_id: Some("client-1".into()),
            })
            .unwrap();
        mgr.tailnet
            .set_preference(
                host_reg_id,
                HostConnectionPreference::Tailnet,
                Some(Some("https://forge.tail.ts.net:10000".into())),
                Some(Some(1_760_000_000_000)),
                Some(Some("linux-x64".into())),
            )
            .unwrap();
        mgr.drafts
            .set_saved_hosts(vec![(remote_host_id.into(), host_reg_id.into())]);
        mgr.drafts
            .put(RetainedDraft {
                host_id: remote_host_id.into(),
                registration_id: Some(host_reg_id.into()),
                provider_id: Some("codex".into()),
                thread_kind: None,
                draft: json!({
                    "threadId": "t-1",
                    "draftId": "33333333-3333-4333-8333-333333333333",
                    "text": "unsent words",
                    "updatedAt": "2026-11-23T00:00:00.000Z"
                }),
                questions_digest: None,
                saved: false,
                recovery: false,
                editing: Some(true),
                host_draft_id: None,
                base_draft_id: None,
                send_attempt: None,
            })
            .unwrap();
        mgr.settles
            .keep(
                "host:local:parent-1",
                vec![format!("host:{remote_host_id}:child-1")],
                vec![],
                vec![],
            )
            .unwrap();

        // Reload in a fresh manager and confirm everything persists and marks unsaved draft recovery = true.
        let mut mgr2 = DesktopHostsManager::new(dir.path(), "local-host-id".into());
        mgr2.load().unwrap();
        assert_eq!(mgr2.saved.list().len(), 1);
        assert_eq!(
            mgr2.tailnet.prefer_of(host_reg_id),
            HostConnectionPreference::Tailnet
        );
        let loaded_draft = mgr2.drafts.get(remote_host_id, "t-1").unwrap();
        assert!(loaded_draft.recovery);
        assert_eq!(
            mgr2.settles.of("host:local:parent-1").unwrap().settled,
            vec![format!("host:{remote_host_id}:child-1")]
        );
        assert!(settled_with_parent(
            Some("2026-11-23T10:00:00.000Z"),
            Some("2026-11-23T10:01:30.000Z")
        ));
        assert!(!settled_with_parent(
            Some("2026-11-23T10:00:00.000Z"),
            Some("2026-11-23T10:05:00.000Z")
        ));

        // Privacy off clears remote-drafts.json on disk.
        mgr2.drafts.set_history_enabled(false).unwrap();
        let disk_drafts: Vec<Value> =
            serde_json::from_str(&fs::read_to_string(dir.path().join(RETAINED_DRAFTS_FILE)).unwrap())
                .unwrap();
        assert!(disk_drafts.is_empty());
    }

    #[test]
    fn files_bindings_tracker_emits_minimal_deltas_and_removals() {
        let mut tracker = FilesBindingsTracker::default();
        let host = json!({
            "projects": [{ "id": "p1", "path": "/repo" }],
            "threads": [{ "id": "t1", "projectId": "p1", "title": "First", "workingDirectory": "/repo/wt" }]
        });
        let delta1 = tracker.sync_local(&host).unwrap();
        assert_eq!(
            delta1.project_folders.as_ref().unwrap()["p1"].as_deref(),
            Some("/repo")
        );
        assert_eq!(
            delta1.bindings.as_ref().unwrap()["t1"]
                .as_ref()
                .unwrap()
                .working_directory,
            "/repo/wt"
        );
        // Second identical sync emits None (zero noise during streaming).
        assert!(tracker.sync_local(&host).is_none());

        // Removing thread emits null tombstone.
        let empty = json!({ "projects": [{ "id": "p1", "path": "/repo" }], "threads": [] });
        let delta2 = tracker.sync_local(&empty).unwrap();
        assert_eq!(delta2.bindings.as_ref().unwrap()["t1"], None);
        assert_eq!(delta2.thread_titles.as_ref().unwrap()["t1"], None);
        assert!(delta2.project_folders.is_none());
    }
}
