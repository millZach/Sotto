use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rand::RngCore;
use scrypt::{scrypt, Params};
use thiserror::Error;
use uuid::Uuid;

const HEADER: &[u8; 6] = b"SOTTO1";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const MIN_CIPHERTEXT_LEN: usize = HEADER.len() + SALT_LEN + NONCE_LEN + TAG_LEN;

pub const CREDENTIAL_UNLOCK_ERROR: &str =
    "Host credentials could not be unlocked. Restore the credential file and supply its original key file.";

#[derive(Debug, Error)]
pub enum CredentialError {
    #[error("The host key file must contain at least 16 characters.")]
    KeyTooShort,
    #[error("Supply a host key file before saving credentials.")]
    NoKey,
    #[error("{CREDENTIAL_UNLOCK_ERROR}")]
    UnlockFailed,
    #[error("I/O error on credentials store: {0}")]
    Io(#[from] std::io::Error),
}

/// Encrypts and decrypts host credentials using the exact `SOTTO1` + `scrypt(N=16384, r=8, p=1)`
/// + `AES-256-GCM` (AAD = `"SOTTO1"`) layout of `src/host/credentials.ts`.
pub struct HostCredentialEncryption {
    secret: Option<String>,
}

impl HostCredentialEncryption {
    pub fn new(secret: Option<String>) -> Result<Self, CredentialError> {
        if let Some(ref s) = secret {
            if s.len() < 16 {
                return Err(CredentialError::KeyTooShort);
            }
        }
        Ok(Self { secret })
    }

    pub fn is_available(&self) -> bool {
        self.secret.is_some()
    }

    pub fn encrypt_string(&self, plaintext: &str) -> Result<Vec<u8>, CredentialError> {
        let Some(ref secret) = self.secret else {
            return Err(CredentialError::NoKey);
        };
        let mut salt = [0u8; SALT_LEN];
        let mut nonce_bytes = [0u8; NONCE_LEN];
        let mut rng = rand::thread_rng();
        rng.fill_bytes(&mut salt);
        rng.fill_bytes(&mut nonce_bytes);

        let mut key = derive_key(secret.as_bytes(), &salt)?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| CredentialError::UnlockFailed)?;
        let nonce = Nonce::from_slice(&nonce_bytes);
        let encrypted = cipher
            .encrypt(
                nonce,
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: HEADER,
                },
            )
            .map_err(|_| CredentialError::UnlockFailed);
        key.fill(0);
        let encrypted = encrypted?;
        if encrypted.len() < TAG_LEN {
            return Err(CredentialError::UnlockFailed);
        }
        // `aes-gcm` appends the 16-byte tag at the end; Node's `SOTTO1` puts tag before ciphertext.
        let split = encrypted.len() - TAG_LEN;
        let (ciphertext, tag) = encrypted.split_at(split);

        let mut out = Vec::with_capacity(MIN_CIPHERTEXT_LEN + ciphertext.len());
        out.extend_from_slice(HEADER);
        out.extend_from_slice(&salt);
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(tag);
        out.extend_from_slice(ciphertext);
        Ok(out)
    }

    pub fn decrypt_string(&self, encoded: &[u8]) -> Result<String, CredentialError> {
        let Some(ref secret) = self.secret else {
            return Err(CredentialError::UnlockFailed);
        };
        if encoded.len() < MIN_CIPHERTEXT_LEN || &encoded[..HEADER.len()] != HEADER {
            return Err(CredentialError::UnlockFailed);
        }
        let salt = &encoded[6..22];
        let nonce_bytes = &encoded[22..34];
        let tag = &encoded[34..50];
        let ciphertext = &encoded[50..];

        let mut key = derive_key(secret.as_bytes(), salt)?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| CredentialError::UnlockFailed)?;
        let nonce = Nonce::from_slice(nonce_bytes);

        let mut combined = Vec::with_capacity(ciphertext.len() + TAG_LEN);
        combined.extend_from_slice(ciphertext);
        combined.extend_from_slice(tag);

        let plaintext = cipher
            .decrypt(
                nonce,
                Payload {
                    msg: &combined,
                    aad: HEADER,
                },
            )
            .map_err(|_| CredentialError::UnlockFailed);
        key.fill(0);
        let plaintext = plaintext?;
        String::from_utf8(plaintext).map_err(|_| CredentialError::UnlockFailed)
    }
}

/// Opens and validates `credentials.json` against an optional `--key-file`, failing closed if any
/// stored slot cannot be decrypted (matching `openHostCredentials` in `src/host/credentials.ts`).
pub struct HostCredentials {
    path: PathBuf,
    encryption: HostCredentialEncryption,
    values: BTreeMap<String, String>,
}

impl HostCredentials {
    pub fn open(directory: &Path, key_file: Option<&Path>) -> Result<Self, CredentialError> {
        let secret = match key_file {
            Some(path) => {
                let raw = fs::read_to_string(path)?;
                Some(raw.trim_end().to_string())
            }
            None => None,
        };
        let encryption = HostCredentialEncryption::new(secret)?;
        let path = directory.join("credentials.json");
        let mut values = BTreeMap::new();

        match fs::read_to_string(&path) {
            Ok(text) => {
                let encoded_map: BTreeMap<String, String> =
                    serde_json::from_str(&text).map_err(|_| CredentialError::UnlockFailed)?;
                for (slot, b64) in encoded_map {
                    if b64.is_empty() {
                        return Err(CredentialError::UnlockFailed);
                    }
                    let bytes = STANDARD
                        .decode(&b64)
                        .map_err(|_| CredentialError::UnlockFailed)?;
                    if STANDARD.encode(&bytes) != b64 {
                        return Err(CredentialError::UnlockFailed);
                    }
                    let decrypted = encryption.decrypt_string(&bytes)?;
                    values.insert(slot, decrypted);
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(CredentialError::Io(err)),
        }

        Ok(Self {
            path,
            encryption,
            values,
        })
    }

    pub fn is_secure(&self) -> bool {
        self.encryption.is_available()
    }

    pub fn get(&self, slot: &str) -> Option<&str> {
        self.values.get(slot).map(String::as_str)
    }

    pub fn has(&self, slot: &str) -> bool {
        self.values.contains_key(slot)
    }

    pub fn set(&mut self, slot: impl Into<String>, value: impl Into<String>) -> Result<(), CredentialError> {
        if !self.encryption.is_available() {
            return Err(CredentialError::NoKey);
        }
        self.values.insert(slot.into(), value.into());
        self.save()
    }

    pub fn remove(&mut self, slot: &str) -> Result<bool, CredentialError> {
        let removed = self.values.remove(slot).is_some();
        if removed {
            self.save()?;
        }
        Ok(removed)
    }

    fn save(&self) -> Result<(), CredentialError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut encoded = BTreeMap::new();
        for (slot, value) in &self.values {
            let bytes = self.encryption.encrypt_string(value)?;
            encoded.insert(slot.clone(), STANDARD.encode(bytes));
        }
        let body = serde_json::to_string_pretty(&encoded)
            .map_err(|_| CredentialError::UnlockFailed)?;
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
        res?;
        Ok(())
    }
}

fn derive_key(secret: &[u8], salt: &[u8]) -> Result<[u8; 32], CredentialError> {
    // Node's default `scryptSync` parameters: N = 16384 (log_n = 14), r = 8, p = 1.
    let params = Params::new(14, 8, 1, 32).map_err(|_| CredentialError::UnlockFailed)?;
    let mut key = [0u8; 32];
    scrypt(secret, salt, &params, &mut key).map_err(|_| CredentialError::UnlockFailed)?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn round_trips_credentials_and_rejects_wrong_key() {
        let dir = tempdir().unwrap();
        let key_path = dir.path().join("host.key");
        fs::write(&key_path, "sotto-test-host-key-0123456789\n").unwrap();

        let mut creds = HostCredentials::open(dir.path(), Some(&key_path)).unwrap();
        assert!(creds.is_secure());
        creds.set("formatting", "sk-test-secret").unwrap();

        let reopened = HostCredentials::open(dir.path(), Some(&key_path)).unwrap();
        assert_eq!(reopened.get("formatting"), Some("sk-test-secret"));

        let wrong_key = dir.path().join("wrong.key");
        fs::write(&wrong_key, "different-host-key-9876543210\n").unwrap();
        assert!(matches!(
            HostCredentials::open(dir.path(), Some(&wrong_key)),
            Err(CredentialError::UnlockFailed)
        ));
    }

    #[test]
    fn rejects_short_key_file() {
        let dir = tempdir().unwrap();
        let key_path = dir.path().join("short.key");
        fs::write(&key_path, "too-short").unwrap();
        assert!(matches!(
            HostCredentials::open(dir.path(), Some(&key_path)),
            Err(CredentialError::KeyTooShort)
        ));
    }
}
