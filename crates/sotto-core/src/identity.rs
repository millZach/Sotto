use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum HostIdentityError {
    #[error("Host identity file is unreadable or corrupt: {0}")]
    Corrupt(String),
    #[error("I/O error reading or writing host identity: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HostIdentityFile {
    #[serde(rename = "hostId")]
    host_id: Uuid,
}

/// Loads `host.json` from `directory`, creating it atomically on first start via an
/// exclusive hard link so concurrent first starts converge on one identity
/// (matching `src/main/agents/hostIdentity.ts`).
pub fn load_host_identity(directory: &Path) -> Result<String, HostIdentityError> {
    let path = directory.join("host.json");
    match read_host_id(&path) {
        Ok(id) => return Ok(id),
        Err(HostIdentityError::Io(err)) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }

    fs::create_dir_all(directory)?;
    let host_id = Uuid::new_v4();
    let temp = directory.join(format!("host.json.tmp-{}", Uuid::new_v4()));

    let write_result = (|| -> std::io::Result<()> {
        let mut opts = OpenOptions::new();
        opts.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&temp)?;
        let body = serde_json::to_string(&HostIdentityFile { host_id })
            .map_err(std::io::Error::other)?;
        file.write_all(body.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);

        match fs::hard_link(&temp, &path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(err) => Err(err),
        }
    })();

    let _ = fs::remove_file(&temp);
    write_result?;
    read_host_id(&path)
}

fn read_host_id(path: &Path) -> Result<String, HostIdentityError> {
    let text = fs::read_to_string(path)?;
    let parsed: HostIdentityFile =
        serde_json::from_str(&text).map_err(|err| HostIdentityError::Corrupt(err.to_string()))?;
    Ok(parsed.host_id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn creates_and_reuses_valid_uuid_host_identity() {
        let dir = tempdir().unwrap();
        let first = load_host_identity(dir.path()).unwrap();
        assert!(Uuid::parse_str(&first).is_ok());
        let second = load_host_identity(dir.path()).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn refuses_corrupt_host_identity_without_overwriting() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("host.json");
        fs::write(&path, r#"{"hostId":"not-a-uuid"}"#).unwrap();
        let err = load_host_identity(dir.path()).unwrap_err();
        assert!(matches!(err, HostIdentityError::Corrupt(_)));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"{"hostId":"not-a-uuid"}"#
        );
    }
}
