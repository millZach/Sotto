use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use uuid::Uuid;

pub const DESKTOP_CLIENTS_FILE: &str = "desktop-clients.json";
const DESKTOP_CLIENTS_MAX: usize = 256;
const DESKTOP_CLIENT_ID_MAX: usize = 512;

/// Tracks paired clients recorded as desktops over SSH (`desktop-clients.json`, ADR-0053),
/// matching `src/host/desktopClients.ts`.
pub struct DesktopClients {
    path: PathBuf,
    ids: HashSet<String>,
}

impl DesktopClients {
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join(DESKTOP_CLIENTS_FILE),
            ids: HashSet::new(),
        }
    }

    pub fn has(&self, client_id: &str) -> bool {
        self.ids.contains(client_id)
    }

    pub fn refresh(&mut self) -> &HashSet<String> {
        self.ids = self.read().unwrap_or_default().into_iter().collect();
        &self.ids
    }

    pub fn remove(&mut self, client_id: &str) -> bool {
        self.remove_and_remaining(client_id).is_some()
    }

    /// Removes `client_id` from `desktop-clients.json` when it was recorded as a desktop,
    /// returning the remaining recorded desktop IDs. Returns `None` when `desktop-clients.json`
    /// cannot be read or did not contain `client_id` (matching `DesktopClients.remove` in
    /// `src/host/desktopClients.ts`).
    pub fn remove_and_remaining(&mut self, client_id: &str) -> Option<HashSet<String>> {
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

    fn write(&self, ids: &[String]) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let body = serde_json::to_string_pretty(ids).map_err(std::io::Error::other)?;
        let temp = self
            .path
            .with_extension(format!("json.tmp-{}", Uuid::new_v4()));
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
            fs::rename(&temp, &self.path)
        })();
        if res.is_err() {
            let _ = fs::remove_file(&temp);
        }
        res
    }
}
