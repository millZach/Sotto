use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use thiserror::Error;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

pub const PAIRING_CODE_LIFETIME_SECS: u64 = 5 * 60;
pub const SESSION_LIFETIME_SECS: u64 = 12 * 60 * 60;
pub const PAIRING_CODE_REJECTED: &str =
    "This pairing code is not valid any more. Make a new one on this PC.";

const CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH: usize = 8;
const MIN_SECRET_BYTES: usize = 32;
const MAX_PENDING_CODES: usize = 100;
const MAX_PAIRED_CLIENTS: usize = 1000;

#[derive(Debug, Error)]
pub enum PairingError {
    #[error("{PAIRING_CODE_REJECTED}")]
    CodeRejected,
    #[error("This host has reached its paired device limit. Revoke an unused device first.")]
    CapacityReached,
    #[error("Pairing store is unreadable or corrupt: {0}")]
    Corrupt(String),
    #[error("I/O error on pairing store: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairedClient {
    #[serde(rename = "clientId")]
    pub client_id: String,
    pub name: String,
    #[serde(rename = "pairedAt")]
    pub paired_at: String,
    #[serde(rename = "tokenHash")]
    pub token_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PairedClientsFile {
    secret: String,
    clients: Vec<PairedClient>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairingCode {
    pub code: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingResult {
    #[serde(rename = "clientId")]
    pub client_id: String,
    pub name: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionToken {
    pub session: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

struct PendingCode {
    code: String,
    expires: Instant,
}

/// Manages paired clients, single-use pairing codes, and stateless HMAC-signed sessions
/// matching `src/main/agents/pairing.ts` byte-for-byte.
pub struct PairedClients {
    path: PathBuf,
    secret_b64: String,
    secret_bytes: Vec<u8>,
    clients: Vec<PairedClient>,
    pending_codes: Vec<PendingCode>,
}

impl PairedClients {
    pub fn load(directory: &Path) -> Result<Self, PairingError> {
        let path = directory.join("paired-clients.json");
        let (secret_b64, clients) = match fs::read_to_string(&path) {
            Ok(text) => {
                let parsed: PairedClientsFile = serde_json::from_str(&text)
                    .map_err(|err| PairingError::Corrupt(err.to_string()))?;
                (parsed.secret, parsed.clients)
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => (new_secret(), Vec::new()),
            Err(err) => return Err(PairingError::Io(err)),
        };

        let secret_bytes = URL_SAFE_NO_PAD
            .decode(&secret_b64)
            .map_err(|err| PairingError::Corrupt(err.to_string()))?;
        if secret_bytes.len() < MIN_SECRET_BYTES {
            return Err(PairingError::Corrupt(
                "Pairing signing secret is too short.".into(),
            ));
        }

        Ok(Self {
            path,
            secret_b64,
            secret_bytes,
            clients,
            pending_codes: Vec::new(),
        })
    }

    pub fn list(&self) -> &[PairedClient] {
        &self.clients
    }

    pub fn is_paired(&self, client_id: &str) -> bool {
        self.clients.iter().any(|c| c.client_id == client_id)
    }

    pub fn issue_pairing_code(&mut self) -> PairingCode {
        let now = Instant::now();
        self.pending_codes.retain(|entry| entry.expires > now);
        while self.pending_codes.len() >= MAX_PENDING_CODES {
            self.pending_codes.remove(0);
        }
        let code = random_code();
        let lifetime = Duration::from_secs(PAIRING_CODE_LIFETIME_SECS);
        let expires_at: DateTime<Utc> =
            Utc::now() + chrono::Duration::seconds(PAIRING_CODE_LIFETIME_SECS as i64);
        self.pending_codes.push(PendingCode {
            code: code.clone(),
            expires: now + lifetime,
        });
        PairingCode {
            code,
            expires_at: expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        }
    }

    pub fn cancel_pairing_code(&mut self, code: &str) {
        let normalized: String = code
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric())
            .map(|ch| ch.to_ascii_uppercase())
            .collect();
        self.pending_codes
            .retain(|entry| !constant_time_eq(entry.code.as_bytes(), normalized.as_bytes()));
    }

    pub fn redeem_pairing_code(
        &mut self,
        code: &str,
        raw_name: &str,
    ) -> Result<PairingResult, PairingError> {
        let now = Instant::now();
        self.pending_codes.retain(|entry| entry.expires > now);
        let normalized: String = code
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric())
            .map(|ch| ch.to_ascii_uppercase())
            .collect();

        let matched = self
            .pending_codes
            .iter()
            .position(|entry| constant_time_eq(entry.code.as_bytes(), normalized.as_bytes()));
        let Some(index) = matched else {
            return Err(PairingError::CodeRejected);
        };
        if self.clients.len() >= MAX_PAIRED_CLIENTS {
            return Err(PairingError::CapacityReached);
        }
        self.pending_codes.remove(index);

        let client_id = Uuid::new_v4().to_string();
        let token = new_secret();
        let token_hash = hmac_hash(&self.secret_bytes, &format!("token:{token}"));
        let name = sanitize_device_name(raw_name);
        let paired_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        self.clients.push(PairedClient {
            client_id: client_id.clone(),
            name: name.clone(),
            paired_at,
            token_hash,
        });
        self.save()?;

        Ok(PairingResult {
            client_id,
            name,
            token,
        })
    }

    pub fn verify_token(&self, token: &str) -> Option<String> {
        if token.is_empty() {
            return None;
        }
        let candidate = hmac_hash(&self.secret_bytes, &format!("token:{token}"));
        for client in &self.clients {
            if constant_time_eq(client.token_hash.as_bytes(), candidate.as_bytes()) {
                return Some(client.client_id.clone());
            }
        }
        None
    }

    /// Signs a stateless session `<clientId>.<expiryMs>.<hmac>` matching `signSession` in `pairing.ts`.
    pub fn issue_session(&mut self, client_id: &str) -> Option<SessionToken> {
        if !self.is_paired(client_id) {
            return None;
        }
        let expires_at = Utc::now() + chrono::Duration::seconds(SESSION_LIFETIME_SECS as i64);
        let expiry_ms = expires_at.timestamp_millis();
        let body = format!("{client_id}.{expiry_ms}");
        let signature = hmac_hash(&self.secret_bytes, &format!("session:{body}"));
        Some(SessionToken {
            session: format!("{body}.{signature}"),
            expires_at: expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        })
    }

    pub fn verify_session_with_expiry(&mut self, session: &str) -> Option<(String, i64)> {
        if session.is_empty() {
            return None;
        }
        let mut parts = session.split('.');
        let client_id = parts.next()?;
        let expiry_str = parts.next()?;
        let signature = parts.next()?;
        if parts.next().is_some() {
            return None;
        }
        let expected = hmac_hash(
            &self.secret_bytes,
            &format!("session:{client_id}.{expiry_str}"),
        );
        if !constant_time_eq(signature.as_bytes(), expected.as_bytes()) {
            return None;
        }
        let expiry_ms: i64 = expiry_str.parse().ok()?;
        if expiry_ms <= Utc::now().timestamp_millis() {
            return None;
        }
        self.is_paired(client_id)
            .then(|| (client_id.to_string(), expiry_ms))
    }

    /// Verifies a stateless signed session `<clientId>.<expiryMs>.<hmac>` matching `verifySession` in `pairing.ts`.
    pub fn verify_session(&mut self, session: &str) -> Option<String> {
        self.verify_session_with_expiry(session).map(|(id, _)| id)
    }

    pub fn revoke(&mut self, client_id: &str) -> Result<bool, PairingError> {
        let next: Vec<PairedClient> = self
            .clients
            .iter()
            .filter(|c| c.client_id != client_id)
            .cloned()
            .collect();
        let removed = next.len() != self.clients.len();
        if removed {
            // Persist before mutating in-memory state so a failed write can be retried cleanly.
            self.save_clients(&next)?;
            self.clients = next;
        }
        Ok(removed)
    }

    fn save(&self) -> Result<(), PairingError> {
        self.save_clients(&self.clients)
    }

    fn save_clients(&self, clients: &[PairedClient]) -> Result<(), PairingError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temp = self
            .path
            .with_extension(format!("json.tmp-{}", Uuid::new_v4()));
        let file_data = PairedClientsFile {
            secret: self.secret_b64.clone(),
            clients: clients.to_vec(),
        };
        let encoded = serde_json::to_string_pretty(&file_data)
            .map_err(|err| PairingError::Corrupt(err.to_string()))?;

        let result = (|| -> std::io::Result<()> {
            let mut opts = OpenOptions::new();
            opts.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut file = opts.open(&temp)?;
            file.write_all(encoded.as_bytes())?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temp, &self.path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result?;
        Ok(())
    }
}

fn new_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn random_code() -> String {
    let mut bytes = [0u8; CODE_LENGTH];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|b| CODE_ALPHABET[(*b as usize) % CODE_ALPHABET.len()] as char)
        .collect()
}

fn hmac_hash(secret: &[u8], value: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts keys of any length");
    mac.update(value.as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

fn sanitize_device_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let truncated: String = cleaned.chars().take(256).collect();
    if truncated.is_empty() {
        "Paired client".to_string()
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn issues_redeems_verifies_persists_and_revokes_clients() {
        let dir = tempdir().unwrap();
        let mut store = PairedClients::load(dir.path()).unwrap();
        let code = store.issue_pairing_code();
        assert_eq!(code.code.len(), CODE_LENGTH);

        let paired = store
            .redeem_pairing_code(&code.code, "  Zach's Laptop \n ")
            .unwrap();
        assert_eq!(paired.name, "Zach's Laptop");
        assert_eq!(
            store.verify_token(&paired.token).as_deref(),
            Some(paired.client_id.as_str())
        );

        // Single-use code cannot be redeemed twice.
        assert!(matches!(
            store.redeem_pairing_code(&code.code, "Again"),
            Err(PairingError::CodeRejected)
        ));

        // Reloading from disk verifies the exact same token.
        let mut reloaded = PairedClients::load(dir.path()).unwrap();
        assert_eq!(
            reloaded.verify_token(&paired.token).as_deref(),
            Some(paired.client_id.as_str())
        );
        let session = reloaded.issue_session(&paired.client_id).unwrap();
        assert_eq!(
            reloaded.verify_session(&session.session).as_deref(),
            Some(paired.client_id.as_str())
        );

        assert!(reloaded.revoke(&paired.client_id).unwrap());
        assert!(reloaded.verify_token(&paired.token).is_none());
        assert!(reloaded.verify_session(&session.session).is_none());
    }

    #[test]
    fn node_paired_clients_survives_a_rust_load_and_save() {
        // Node's schema is strict, as Rust's is, so neither side writes a field the other does not know.
        let node = || {
            serde_json::json!({
                "secret": "A".repeat(43),
                "clients": [
                    { "clientId": "11111111-1111-4111-8111-111111111111", "name": "Zach's iPhone", "pairedAt": "2026-11-20T10:00:00.000Z", "tokenHash": "hash-1" },
                    { "clientId": "22222222-2222-4222-8222-222222222222", "name": "Forge", "pairedAt": "2026-11-21T10:00:00.000Z", "tokenHash": "hash-2" },
                ],
            })
        };
        crate::store_trip::round_trip("paired-clients.json", node, |dir| {
            PairedClients::load(dir).unwrap().save().unwrap();
        });
    }

    #[test]
    fn rust_created_paired_clients_reads_in_node() {
        let written = crate::store_trip::created("paired-clients.json", |dir| {
            let mut store = PairedClients::load(dir).unwrap();
            let code = store.issue_pairing_code();
            store.redeem_pairing_code(&code.code, "Zach's iPhone").unwrap();
        });
        assert_eq!(written["secret"].as_str().unwrap().len(), 43);
        assert_eq!(written["clients"][0]["name"], "Zach's iPhone");
    }

    #[test]
    fn a_paired_clients_file_that_does_not_read_is_kept_unchanged() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("paired-clients.json");
        fs::write(&path, "{ not json").unwrap();
        assert!(matches!(PairedClients::load(dir.path()), Err(PairingError::Corrupt(_))));
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
    }
}
