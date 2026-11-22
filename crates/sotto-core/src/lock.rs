use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "macos", windows))]
use std::process::Command;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

/// Exit code when another live host already holds the data folder's lock (`EX_TEMPFAIL`, ADR-0054).
pub const HOST_LOCK_HELD_EXIT_CODE: i32 = 75;

#[derive(Debug, Error)]
pub enum HostLockError {
    #[error("Another Sotto host is already using this data folder (pid {pid}).")]
    Held { pid: u32 },
    #[error("Could not acquire host lock: {0}")]
    Contended(String),
    #[error("I/O error on host lock: {0}")]
    Io(#[from] std::io::Error),
}

impl HostLockError {
    pub fn exit_code(&self) -> i32 {
        match self {
            HostLockError::Held { .. } => HOST_LOCK_HELD_EXIT_CODE,
            HostLockError::Contended(_) | HostLockError::Io(_) => 1,
        }
    }
}

/// Written into `host-listener.lock`, matching `src/host/lock.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostLease {
    pub pid: u32,
    pub nonce: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boot: Option<String>,
}

impl HostLease {
    pub fn current(boot: Option<String>) -> Self {
        Self {
            pid: std::process::id(),
            nonce: Uuid::new_v4().to_string(),
            boot,
        }
    }
}

/// Checks whether a process with `pid` is currently running, matching `processAlive` in `src/host/lock.ts`.
pub fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        if pid > i32::MAX as u32 {
            return false;
        }
        // `kill(pid, 0)`: 0 means alive; EPERM means alive under another account; ESRCH means gone.
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        let rc = unsafe { kill(pid as i32, 0) };
        if rc == 0 {
            return true;
        }
        matches!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(code) if code == 1 /* EPERM */
        )
    }
    #[cfg(windows)]
    {
        const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
        const STILL_ACTIVE: u32 = 259;
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn GetExitCodeProcess(handle: *mut std::ffi::c_void, code: *mut u32) -> i32;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            // ERROR_ACCESS_DENIED (5) means the process exists under another privilege level.
            return matches!(std::io::Error::last_os_error().raw_os_error(), Some(5));
        }
        let mut exit_code: u32 = 0;
        let ok = unsafe { GetExitCodeProcess(handle, &mut exit_code) };
        unsafe {
            CloseHandle(handle);
        }
        ok != 0 && exit_code == STILL_ACTIVE
    }
}

/// Judges whether the holder named by `lease` may still be alive, considering boot identity first.
pub fn lease_holder_alive(lease: &HostLease, current_boot: Option<&str>) -> bool {
    if let (Some(lease_boot), Some(boot)) = (lease.boot.as_deref(), current_boot) {
        if lease_boot != boot {
            return false;
        }
    }
    process_alive(lease.pid)
}

/// Reads the machine's boot identity, formatted identically to `readBootId` in `src/host/lock.ts`.
pub fn read_boot_id() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let raw = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
        let trimmed = raw.trim();
        (!trimmed.is_empty()).then(|| format!("linux:{trimmed}"))
    }
    #[cfg(target_os = "macos")]
    {
        let out = Command::new("/usr/sbin/sysctl")
            .args(["-n", "kern.bootsessionuuid"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let trimmed = String::from_utf8(out.stdout).ok()?;
        let trimmed = trimmed.trim();
        (!trimmed.is_empty()).then(|| format!("darwin:{trimmed}"))
    }
    #[cfg(windows)]
    {
        let out = Command::new("reg")
            .args([
                "query",
                r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters",
                "/v",
                "BootId",
            ])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8(out.stdout).ok()?;
        for token in text.split_whitespace() {
            if token.starts_with("0x") || token.starts_with("0X") {
                return Some(format!("win32:{}", token.to_ascii_lowercase()));
            }
        }
        None
    }
}

fn parse_lease(text: &str) -> Result<HostLease, HostLockError> {
    let lease: HostLease = serde_json::from_str(text)
        .map_err(|_| HostLockError::Contended("lock file is unreadable".into()))?;
    if lease.pid == 0 {
        return Err(HostLockError::Contended("lock pid is invalid".into()));
    }
    Ok(lease)
}

fn place_exclusive(path: &Path, content: &str) -> std::io::Result<()> {
    let draft = path.with_extension(format!("lock.{}.new", Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut opts = OpenOptions::new();
        opts.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&draft)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::hard_link(&draft, path)
    })();
    let _ = fs::remove_file(&draft);
    result
}

const TURN_WAIT_MS: u64 = 50;
const TURN_LOOKS: usize = 60;

enum Removal {
    Removed,
    Gone,
    Changed,
    Lost,
}

fn reclaim_turn_path(path: &Path) -> PathBuf {
    let mut os = path.as_os_str().to_os_string();
    os.push(".reclaim");
    PathBuf::from(os)
}

/// Removes `path` only if it still holds `seen` (matching `removeIfStill` in `src/host/lock.ts`).
/// Moves the file aside first and verifies what was moved; if another live lease appeared in the
/// same instant, links it back into place without deleting it.
fn remove_if_still(path: &Path, seen: &str) -> Result<Removal, HostLockError> {
    let now = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Removal::Gone),
        Err(err) => return Err(HostLockError::Io(err)),
    };
    if now != seen {
        return Ok(Removal::Changed);
    }
    let aside = path.with_extension(format!("lock.{}.stale", Uuid::new_v4()));
    match fs::rename(path, &aside) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Removal::Gone),
        Err(err) => return Err(HostLockError::Io(err)),
    }
    let moved = fs::read_to_string(&aside).ok();
    if moved.as_deref() == Some(seen) {
        let _ = fs::remove_file(&aside);
        return Ok(Removal::Removed);
    }
    let restored = match fs::hard_link(&aside, path) {
        Ok(()) => true,
        Err(err) if err.kind() != std::io::ErrorKind::AlreadyExists => moved
            .as_deref()
            .is_some_and(|body| place_exclusive(path, body).is_ok()),
        Err(_) => false,
    };
    if restored {
        let _ = fs::remove_file(&aside);
        Ok(Removal::Changed)
    } else {
        Ok(Removal::Lost)
    }
}

/// Acquires `host-listener.lock.reclaim` so only one host clears a stale lock at a time
/// (matching `takeReclaimTurn` in `src/host/lock.ts`).
fn take_reclaim_turn(
    turn: &Path,
    content: &str,
    boot: Option<&str>,
) -> Result<(), HostLockError> {
    for _ in 0..TURN_LOOKS {
        match place_exclusive(turn, content) {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(err) => return Err(HostLockError::Io(err)),
        }
        let seen = match fs::read_to_string(turn) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                thread::sleep(Duration::from_millis(TURN_WAIT_MS));
                continue;
            }
        };
        let Ok(holder) = parse_lease(&seen) else {
            thread::sleep(Duration::from_millis(TURN_WAIT_MS));
            continue;
        };
        if lease_holder_alive(&holder, boot) {
            thread::sleep(Duration::from_millis(TURN_WAIT_MS));
            continue;
        }
        let _ = remove_if_still(turn, &seen);
    }
    Err(HostLockError::Contended(
        "another host kept its turn to clear this data folder's lock".into(),
    ))
}

/// Acquires `host-listener.lock`, reclaiming a stale lock atomically if the recorded holder is gone.
pub fn acquire_host_lock(
    path: &Path,
    lease: &HostLease,
    boot: Option<&str>,
) -> Result<(), HostLockError> {
    let content = format!(
        "{}\n",
        serde_json::to_string(lease).map_err(|err| HostLockError::Contended(err.to_string()))?
    );
    let turn = reclaim_turn_path(path);

    for _ in 0..4 {
        match place_exclusive(path, &content) {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(err) => return Err(HostLockError::Io(err)),
        }

        let existing_text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(HostLockError::Io(err)),
        };

        let existing = parse_lease(&existing_text)?;
        if lease_holder_alive(&existing, boot) {
            return Err(HostLockError::Held { pid: existing.pid });
        }

        // Serialize stale-lock removal through the reclaim turn file, then verify the exact dead
        // lease is still at `path` before removing it so a concurrent winner's live lease is never removed.
        take_reclaim_turn(&turn, &content, boot)?;
        let removal = (|| -> Result<Removal, HostLockError> {
            let latest_text = match fs::read_to_string(path) {
                Ok(text) => text,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Removal::Gone),
                Err(err) => return Err(HostLockError::Io(err)),
            };
            let latest = parse_lease(&latest_text)?;
            if lease_holder_alive(&latest, boot) {
                return Err(HostLockError::Held { pid: latest.pid });
            }
            remove_if_still(path, &latest_text)
        })();
        let _ = release_host_lock(&turn, lease);

        match removal? {
            Removal::Removed | Removal::Gone | Removal::Changed => continue,
            Removal::Lost => {
                return Err(HostLockError::Contended(
                    "another host acquired the lock while clearing a stale lease".into(),
                ));
            }
        }
    }

    Err(HostLockError::Contended(
        "lock contention during startup".into(),
    ))
}

/// Releases `host-listener.lock` only if it still carries this lease's nonce.
pub fn release_host_lock(path: &Path, lease: &HostLease) -> Result<(), HostLockError> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(HostLockError::Io(err)),
    };
    if let Ok(existing) = parse_lease(&text) {
        if existing.nonce == lease.nonce && existing.pid == lease.pid {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn acquires_blocks_live_holder_and_releases() {
        let dir = tempdir().unwrap();
        let lock_path = dir.path().join("host-listener.lock");
        let first = HostLease::current(Some("test:boot1".into()));
        let second = HostLease::current(Some("test:boot1".into()));

        acquire_host_lock(&lock_path, &first, Some("test:boot1")).unwrap();
        let err = acquire_host_lock(&lock_path, &second, Some("test:boot1")).unwrap_err();
        assert!(matches!(err, HostLockError::Held { pid } if pid == first.pid));
        assert_eq!(err.exit_code(), HOST_LOCK_HELD_EXIT_CODE);

        release_host_lock(&lock_path, &first).unwrap();
        assert!(!lock_path.exists());
    }

    #[test]
    fn reclaims_stale_lock_from_previous_boot() {
        let dir = tempdir().unwrap();
        let lock_path = dir.path().join("host-listener.lock");
        let old = HostLease {
            pid: std::process::id(),
            nonce: "old-nonce".into(),
            boot: Some("test:boot-old".into()),
        };
        fs::write(&lock_path, serde_json::to_string(&old).unwrap()).unwrap();

        let fresh = HostLease::current(Some("test:boot-new".into()));
        acquire_host_lock(&lock_path, &fresh, Some("test:boot-new")).unwrap();
        release_host_lock(&lock_path, &fresh).unwrap();
    }
}
