use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const DESKTOP_CLIENTS_FILE: &str = "desktop-clients.json";
pub const DESKTOP_IDENTITIES_FILE: &str = "desktop-identities.json";
const DESKTOP_CLIENTS_MAX: usize = 1000;
const DESKTOP_CLIENT_ID_MAX: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DesktopIdentitiesFile {
    version: u32,
    desktops: BTreeMap<String, String>,
}

/// Tracks paired clients recorded as desktops over SSH (`desktop-clients.json`, ADR-0053)
/// and their SSH-recorded persistent desktop host IDs (`desktop-identities.json`, #2863),
/// matching `src/host/desktopClients.ts`.
pub struct DesktopClients {
    path: PathBuf,
    identities_path: PathBuf,
    ids: HashSet<String>,
    host_ids: HashMap<String, String>,
}

impl DesktopClients {
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join(DESKTOP_CLIENTS_FILE),
            identities_path: directory.join(DESKTOP_IDENTITIES_FILE),
            ids: HashSet::new(),
            host_ids: HashMap::new(),
        }
    }

    pub fn has(&self, client_id: &str) -> bool {
        self.ids.contains(client_id)
    }

    /// Returns the SSH-recorded persistent desktop `hostId` bound to `client_id`, if any.
    pub fn host_id_of(&self, client_id: &str) -> Option<&str> {
        self.host_ids.get(client_id).map(String::as_str)
    }

    pub fn refresh(&mut self) -> &HashSet<String> {
        self.ids = self.read().unwrap_or_default().into_iter().collect();
        self.host_ids = self
            .read_identities()
            .map(|file| file.desktops.into_iter().collect())
            .unwrap_or_default();
        &self.ids
    }

    pub fn remove(&mut self, client_id: &str) -> bool {
        self.remove_and_remaining(client_id).is_some()
    }

    /// Removes `client_id` from `desktop-clients.json` (and `desktop-identities.json` when present)
    /// when it was recorded as a desktop, returning the remaining recorded desktop IDs. Returns `None`
    /// when `desktop-clients.json` cannot be read or did not contain `client_id` (matching
    /// `DesktopClients.remove` in `src/host/desktopClients.ts`).
    pub fn remove_and_remaining(&mut self, client_id: &str) -> Option<HashSet<String>> {
        if let Some(mut identities) = self.read_identities() {
            let removed_identity = identities.desktops.remove(client_id).is_some();
            self.host_ids = identities
                .desktops
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            if removed_identity {
                let _ = self.write_identities(&identities);
            }
        } else {
            self.host_ids.clear();
        }
        let current = self.read()?;
        let had = current.iter().any(|id| id == client_id);
        let left: Vec<String> = current
            .into_iter()
            .filter(|id| id != client_id)
            .collect();
        self.ids = left.iter().cloned().collect();
        if !had {
            return None;
        }
        let _ = self.write(&left);
        Some(self.ids.clone())
    }

    fn read(&self) -> Option<Vec<String>> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Some(Vec::new()),
            Err(_) => return None,
        };
        let parsed: Vec<String> = serde_json::from_str(&text).ok()?;
        if parsed.len() > DESKTOP_CLIENTS_MAX
            || parsed
                .iter()
                .any(|id| id.is_empty() || id.len() > DESKTOP_CLIENT_ID_MAX)
        {
            return None;
        }
        Some(parsed)
    }

    fn read_identities(&self) -> Option<DesktopIdentitiesFile> {
        let text = match fs::read_to_string(&self.identities_path) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Some(DesktopIdentitiesFile {
                    version: 1,
                    desktops: BTreeMap::new(),
                });
            }
            Err(_) => return None,
        };
        let parsed: DesktopIdentitiesFile = serde_json::from_str(&text).ok()?;
        if parsed.version != 1
            || parsed.desktops.len() > DESKTOP_CLIENTS_MAX
            || parsed.desktops.iter().any(|(cid, host_id)| {
                cid.is_empty()
                    || cid.len() > DESKTOP_CLIENT_ID_MAX
                    || Uuid::parse_str(host_id).is_err()
            })
        {
            return None;
        }
        Some(parsed)
    }

    fn write(&self, ids: &[String]) -> std::io::Result<()> {
        write_private_json(&self.path, ids)
    }

    fn write_identities(&self, file: &DesktopIdentitiesFile) -> std::io::Result<()> {
        write_private_json(&self.identities_path, file)
    }
}

fn write_private_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> std::io::Result<()> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn reads_and_removes_desktop_identity_bindings_failing_closed_on_corrupt_file() {
        let dir = tempdir().unwrap();
        let host_a = Uuid::new_v4().to_string();
        let host_b = Uuid::new_v4().to_string();
        fs::write(
            dir.path().join(DESKTOP_CLIENTS_FILE),
            serde_json::to_string(&vec!["client-a", "client-b"]).unwrap(),
        )
        .unwrap();
        fs::write(
            dir.path().join(DESKTOP_IDENTITIES_FILE),
            serde_json::json!({
                "version": 1,
                "desktops": {
                    "client-a": host_a,
                    "client-b": host_b,
                }
            })
            .to_string(),
        )
        .unwrap();

        let mut clients = DesktopClients::new(dir.path());
        clients.refresh();
        assert!(clients.has("client-a"));
        assert_eq!(clients.host_id_of("client-a"), Some(host_a.as_str()));
        assert_eq!(clients.host_id_of("client-b"), Some(host_b.as_str()));

        let remaining = clients.remove_and_remaining("client-a").unwrap();
        assert!(!remaining.contains("client-a"));
        assert!(remaining.contains("client-b"));
        assert_eq!(clients.host_id_of("client-a"), None);
        assert_eq!(clients.host_id_of("client-b"), Some(host_b.as_str()));

        // Reload confirms persisted removal.
        let mut reloaded = DesktopClients::new(dir.path());
        reloaded.refresh();
        assert_eq!(reloaded.host_id_of("client-a"), None);
        assert_eq!(reloaded.host_id_of("client-b"), Some(host_b.as_str()));

        // Corrupt identities file fails closed to no bindings without breaking desktop-clients.json.
        fs::write(dir.path().join(DESKTOP_IDENTITIES_FILE), "{ not valid").unwrap();
        reloaded.refresh();
        assert!(reloaded.has("client-b"));
        assert_eq!(reloaded.host_id_of("client-b"), None);
    }
}
