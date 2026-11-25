//! Durable per-turn file checkpoints matching `src/main/tools/checkpoints.ts`,
//! `checkpointStore.ts`, `checkpointCapture.ts`, `checkpointPaths.ts`, and
//! `checkpointReferences.ts` (ADR-0215 Phase 4b).
//!
//! Uses the exact same on-disk layout (`checkpoints.json`, `checkpoints.journal`,
//! `blobs/<sha256>`, and `checkpoints.json.corrupt-<uuid>` backups) so TypeScript and Rust
//! read and write the same data directory interchangeably.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::ops::{is_valid_relative_path, tools_err, tools_ok};
use crate::workspace::now_iso;

pub const CHECKPOINT_STORAGE_VERSION: u32 = 2;
pub const CHECKPOINT_FILE_LIMIT: usize = 10_000;
pub const CHECKPOINT_FILE_BYTE_LIMIT: u64 = 8 * 1024 * 1024;
pub const CHECKPOINT_TOTAL_BYTE_LIMIT: u64 = 64 * 1024 * 1024;
pub const CHECKPOINT_TEXT_PATCH_MAX_BYTES: usize = 256 * 1024;
pub const CHECKPOINT_JOURNAL_FOLD_BYTES: u64 = 64 * 1024;
pub const CHECKPOINT_DEFAULT_MAX_BYTES: u64 = 500_000_000;
const CHECKPOINT_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const RACY_NS: i128 = 3_000_000_000;
const REMEMBERED_FOLDERS: usize = 32;
const GIT_CHECKPOINT_TIMEOUT: Duration = Duration::from_secs(15);
const GIT_MAX_BUFFER: usize = 8 * 1024 * 1024;

pub const REASON_INTERRUPTED: &str = "Checkpoint capture was interrupted before its completed file snapshot was saved. Later edits cannot be safely attributed to that turn.";
pub const REASON_CAPTURE_UNAVAILABLE: &str = "File checkpoint capture was unavailable.";
pub const REASON_OVERLAPPED: &str = "Other thread work overlapped in this shared working copy. Its files cannot be safely attributed to this turn.";
pub const REASON_BINDING_CHANGED: &str = "The native conversation binding changed during this turn.";
pub const REASON_SNAPSHOT_UNAVAILABLE: &str = "Completed file snapshot was unavailable.";
pub const REASON_HISTORY_CHANGED: &str = "This turn changed Git history or staging. Review and restore it with Git.";
pub const REASON_ROLLBACK_UNCONFIRMED: &str = "Native rollback has not been confirmed. Check recovery before continuing; Sotto will not send it again.";
pub const REASON_REVERT_INTERRUPTED: &str = "Revert was interrupted. Check recovery to reconcile native history and finish restoring files.";

const COUNT_MESSAGE: &str = "This working copy exceeds the 10,000-file checkpoint limit.";
const SIZE_MESSAGE: &str =
    "This working copy exceeds the checkpoint size limit (64 MiB total, 8 MiB per file).";
const UNLISTED_MESSAGE: &str = "Git cannot list the files in this working copy, so no checkpoint was taken. Checkpoints need a folder inside a Git repository that Git trusts.";
const LINK_MESSAGE: &str = "Checkpoint paths cannot follow symbolic links or directory junctions.";
const UNSAFE_NAME_MESSAGE: &str =
    "This working copy contains a file name that checkpoint storage cannot safely represent.";
const HARD_LINK_MESSAGE: &str = "Checkpoint capture requires regular files without hard links.";
const INTEGRITY_MESSAGE: &str = "A checkpoint file backup failed its integrity check.";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotFile {
    pub hash: String,
    pub mode: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckpointSnapshot {
    pub files: BTreeMap<String, SnapshotFile>,
    pub index: String,
    pub head: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckpointStatus {
    Capturing,
    Ready,
    Reverting,
    Uncertain,
    Reverted,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnavailableReason {
    SharedCheckout,
    CaptureUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointRecord {
    pub id: String,
    pub thread_id: String,
    pub workspace_id: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkout: Option<String>,
    pub provider_id: String,
    pub binding_id: String,
    pub created_at: String,
    pub before_users: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_users: Option<Vec<String>>,
    pub before: CheckpointSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<CheckpointSnapshot>,
    pub status: CheckpointStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<UnavailableReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckpointStorageFile {
    version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation: Option<String>,
    records: Vec<CheckpointRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalLine {
    generation: String,
    record: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointThreadInfo {
    pub thread_id: String,
    pub provider_id: String,
    pub binding_id: String,
    pub user_message_ids: Vec<String>,
    #[serde(default)]
    pub busy: Option<bool>,
    #[serde(default)]
    pub running: Option<bool>,
    #[serde(default)]
    pub rollback_supported: bool,
    #[serde(default)]
    pub unsupported_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointChangeEntry {
    pub path: String,
    pub change: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointBlobPair {
    pub path: String,
    #[serde(default)]
    pub before_hash: Option<String>,
    #[serde(default)]
    pub after_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointPatch {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
    pub binary: bool,
}

#[derive(Debug, Clone)]
pub struct CheckpointError {
    pub code: &'static str,
    pub message: String,
}

impl CheckpointError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn to_tools_err(&self) -> Value {
        tools_err(self.code, &self.message)
    }
}

pub fn blob_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

pub fn is_valid_sha256_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn is_valid_checkpoint_path(path: &str) -> bool {
    !path.is_empty()
        && !matches!(path, "__proto__" | "constructor" | "prototype")
        && is_valid_relative_path(path)
}

fn validate_record(record: &CheckpointRecord) -> bool {
    if Uuid::parse_str(&record.id).is_err() {
        return false;
    }
    if DateTime::parse_from_rfc3339(&record.created_at).is_err() {
        return false;
    }
    let check_snap = |snap: &CheckpointSnapshot| -> bool {
        snap.files
            .iter()
            .all(|(p, f)| is_valid_checkpoint_path(p) && is_valid_sha256_hex(&f.hash))
    };
    if !check_snap(&record.before) {
        return false;
    }
    if let Some(ref after) = record.after {
        if !check_snap(after) {
            return false;
        }
    }
    true
}

/// Recovers complete valid `CheckpointRecord` JSON objects from a partially corrupted file
/// using balanced-brace scanning (matching `readableRecords` in `checkpointStore.ts`).
fn readable_records(text: &str) -> Vec<CheckpointRecord> {
    let mut records = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut quoted = false;
    let mut escaped = false;
    for (idx, ch) in text.char_indices() {
        if quoted {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                quoted = false;
            }
            continue;
        }
        if ch == '"' {
            quoted = true;
            continue;
        }
        if ch == '{' {
            starts.push(idx);
        } else if ch == '}' {
            if let Some(start) = starts.pop() {
                if let Ok(rec) = serde_json::from_str::<CheckpointRecord>(&text[start..=idx]) {
                    if validate_record(&rec) {
                        records.push(rec);
                    }
                }
            }
        }
    }
    records
}

/// Reads a single content-addressed blob from `blobs_dir`, rejecting symlinks/non-regular files,
/// enforcing `CHECKPOINT_FILE_BYTE_LIMIT`, and verifying its SHA-256 digest.
pub fn read_verified_blob(blobs_dir: &Path, hash: &str) -> Result<Vec<u8>, CheckpointError> {
    if !is_valid_sha256_hex(hash) {
        return Err(CheckpointError::new("invalid-request", "Invalid checkpoint blob hash."));
    }
    let path = blobs_dir.join(hash);
    let sym_meta = fs::symlink_metadata(&path).map_err(|_| {
        CheckpointError::new(
            "unavailable",
            "This tool is unavailable. Refresh and try again.",
        )
    })?;
    if !sym_meta.file_type().is_file() || sym_meta.len() > CHECKPOINT_FILE_BYTE_LIMIT {
        return Err(CheckpointError::new("blocked", INTEGRITY_MESSAGE));
    }
    let file = fs::File::open(&path).map_err(|_| {
        CheckpointError::new(
            "unavailable",
            "This tool is unavailable. Refresh and try again.",
        )
    })?;
    let meta = file.metadata().map_err(|_| {
        CheckpointError::new(
            "unavailable",
            "This tool is unavailable. Refresh and try again.",
        )
    })?;
    if !meta.is_file() || meta.len() > CHECKPOINT_FILE_BYTE_LIMIT {
        return Err(CheckpointError::new("blocked", INTEGRITY_MESSAGE));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(CHECKPOINT_FILE_BYTE_LIMIT.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| CheckpointError::new("blocked", INTEGRITY_MESSAGE))?;
    if bytes.len() as u64 > CHECKPOINT_FILE_BYTE_LIMIT || blob_hash(&bytes) != hash {
        return Err(CheckpointError::new("blocked", INTEGRITY_MESSAGE));
    }
    Ok(bytes)
}

/// Reads an existing regular non-symlink working-tree file up to `limit` bytes.
/// Returns `Ok(None)` if the path does not exist, or an error if it is a symlink/non-regular file
/// or exceeds `limit` (avoiding unbounded reads on FIFOs, devices, or tampered large files).
fn read_bounded_regular_file(
    path: &Path,
    limit: u64,
    rel: &str,
) -> Result<Option<Vec<u8>>, CheckpointError> {
    let sym_meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(CheckpointError::new(
                "unavailable",
                format!("Could not inspect {rel}: {e}"),
            ));
        }
    };
    if sym_meta.file_type().is_symlink() {
        return Err(CheckpointError::new("blocked", LINK_MESSAGE));
    }
    if !sym_meta.file_type().is_file() || sym_meta.len() > limit {
        return Err(CheckpointError::new(
            "blocked",
            format!("Later edits in {rel} would be overwritten."),
        ));
    }
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(CheckpointError::new(
                "unavailable",
                format!("Could not read {rel}: {e}"),
            ));
        }
    };
    let meta = file.metadata().map_err(|e| {
        CheckpointError::new("unavailable", format!("Could not inspect {rel}: {e}"))
    })?;
    if !meta.is_file() || meta.len() > limit {
        return Err(CheckpointError::new(
            "blocked",
            format!("Later edits in {rel} would be overwritten."),
        ));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| CheckpointError::new("unavailable", format!("Could not read {rel}: {e}")))?;
    if bytes.len() as u64 > limit {
        return Err(CheckpointError::new(
            "blocked",
            format!("Later edits in {rel} would be overwritten."),
        ));
    }
    Ok(Some(bytes))
}

fn rename_with_retry(src: &Path, dst: &Path) -> std::io::Result<()> {
    for attempt in 0..3 {
        match fs::rename(src, dst) {
            Ok(()) => return Ok(()),
            Err(err)
                if cfg!(windows)
                    && matches!(
                        err.kind(),
                        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::WouldBlock
                    )
                    && attempt < 2 =>
            {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(err) => return Err(err),
        }
    }
    unreachable!()
}

/// Pure read-only blob inspection helper matching `CheckpointService.inspectCheckpoint` (`checkpoints.ts:430-436`).
/// Verifies every referenced blob's SHA-256 digest, detects binary files (NUL byte or > 256 KiB),
/// and decodes UTF-8 patches off the Node event loop.
pub fn inspect_checkpoint_blobs(
    blobs_dir: &Path,
    pairs: &[CheckpointBlobPair],
) -> Result<Vec<CheckpointPatch>, CheckpointError> {
    let mut patches = Vec::with_capacity(pairs.len());
    for pair in pairs {
        if !is_valid_checkpoint_path(&pair.path) {
            return Err(CheckpointError::new(
                "invalid-request",
                "Invalid checkpoint patch path.",
            ));
        }
        let before = match pair.before_hash.as_deref() {
            Some(h) => Some(read_verified_blob(blobs_dir, h)?),
            None => None,
        };
        let after = match pair.after_hash.as_deref() {
            Some(h) => Some(read_verified_blob(blobs_dir, h)?),
            None => None,
        };
        let is_binary = [&before, &after].into_iter().any(|opt| {
            opt.as_ref().is_some_and(|bytes| {
                bytes.len() > CHECKPOINT_TEXT_PATCH_MAX_BYTES || bytes.contains(&0)
            })
        });
        patches.push(CheckpointPatch {
            path: pair.path.clone(),
            before: if is_binary {
                None
            } else {
                before.map(|b| String::from_utf8_lossy(&b).into_owned())
            },
            after: if is_binary {
                None
            } else {
                after.map(|b| String::from_utf8_lossy(&b).into_owned())
            },
            binary: is_binary,
        });
    }
    Ok(patches)
}

/// Writes `bytes` exclusively (`create_new(true)`) into `blobs_dir/<hash>` with `0600` mode,
/// skipping if the content-addressed blob already exists.
fn write_blob_if_absent(blobs_dir: &Path, hash: &str, bytes: &[u8]) -> Result<(), CheckpointError> {
    fs::create_dir_all(blobs_dir)
        .map_err(|e| CheckpointError::new("unavailable", format!("Could not create blobs directory: {e}")))?;
    let path = blobs_dir.join(hash);
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    match opts.open(&path) {
        Ok(mut f) => {
            f.write_all(bytes)
                .map_err(|e| CheckpointError::new("unavailable", format!("Could not write blob: {e}")))?;
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(CheckpointError::new(
            "unavailable",
            format!("Could not write blob: {e}"),
        )),
    }
}

fn write_atomic_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let write_res = (|| -> std::io::Result<()> {
        let mut f = opts.open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        Ok(())
    })();
    if let Err(err) = write_res {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    if let Err(err) = rename_with_retry(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(())
}

/// Reads `checkpoints.json` + matching `checkpoints.journal` lines in strictly read-only mode
/// without rewriting files or creating corrupt backups (safe for `--accelerator` inspection).
pub fn read_checkpoints_readonly(directory: &Path) -> Result<Vec<CheckpointRecord>, String> {
    let path = directory.join("checkpoints.json");
    let text = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Could not read checkpoints.json: {e}")),
    };
    let (mut records, generation, _damaged) = parse_checkpoint_file_text(&text);
    let journal_path = directory.join("checkpoints.journal");
    if let Ok(jtext) = fs::read_to_string(&journal_path) {
        let (jrecs, _jdamaged) = parse_journal_text(&jtext, generation.as_deref());
        fold_journal_records(&mut records, jrecs);
    }
    Ok(records)
}

fn parse_checkpoint_file_text(text: &str) -> (Vec<CheckpointRecord>, Option<String>, bool) {
    let mut damaged = false;
    let mut generation: Option<String> = None;
    let candidates: Vec<Value> = match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(arr)) => arr,
        Ok(Value::Object(mut obj)) => {
            let version_ok = matches!(
                obj.get("version").and_then(Value::as_u64),
                Some(1 | 2)
            );
            if let Some(gen_val) = obj.get("generation").and_then(Value::as_str) {
                if Uuid::parse_str(gen_val).is_ok() {
                    generation = Some(gen_val.to_string());
                } else {
                    damaged = true;
                }
            }
            if !version_ok || !obj.get("records").is_some_and(Value::is_array) {
                damaged = true;
            }
            for k in obj.keys() {
                if !matches!(k.as_str(), "version" | "generation" | "records") {
                    damaged = true;
                }
            }
            match obj.remove("records") {
                Some(Value::Array(arr)) => arr,
                _ => Vec::new(),
            }
        }
        _ => {
            let recovered = readable_records(text);
            return (recovered, None, true);
        }
    };
    let mut records = Vec::new();
    let mut seen = HashSet::new();
    for cand in candidates {
        match serde_json::from_value::<CheckpointRecord>(cand) {
            Ok(rec) if validate_record(&rec) && seen.insert(rec.id.clone()) => {
                records.push(rec);
            }
            _ => damaged = true,
        }
    }
    (records, generation, damaged)
}

fn parse_journal_text(text: &str, generation: Option<&str>) -> (Vec<CheckpointRecord>, bool) {
    let mut records = Vec::new();
    let mut damaged = false;
    let mut lines: Vec<&str> = text.split('\n').collect();
    // Drop trailing partial line (matching `lines.pop()` in `checkpointStore.ts:150`).
    lines.pop();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<JournalLine>(line) else {
            damaged = true;
            continue;
        };
        if Uuid::parse_str(&entry.generation).is_err() {
            damaged = true;
            continue;
        }
        if generation != Some(entry.generation.as_str()) {
            continue;
        }
        match serde_json::from_value::<CheckpointRecord>(entry.record) {
            Ok(rec) if validate_record(&rec) => records.push(rec),
            _ => damaged = true,
        }
    }
    (records, damaged)
}

fn fold_journal_records(records: &mut Vec<CheckpointRecord>, journal_records: Vec<CheckpointRecord>) {
    for rec in journal_records {
        if let Some(pos) = records.iter().position(|existing| existing.id == rec.id) {
            records[pos] = rec;
        } else {
            records.push(rec);
        }
    }
}

/// Manages `checkpoints.json` and `checkpoints.journal` with atomic writes, generation-tagged
/// journaling, and corrupt-file backup recovery matching `CheckpointStore` (`checkpointStore.ts`).
pub struct CheckpointStore {
    pub directory: PathBuf,
    pub path: PathBuf,
    pub journal: PathBuf,
    generation: Option<String>,
    appended: u64,
    file_bytes: u64,
    behind: bool,
    sizes: HashMap<String, u64>,
}

impl CheckpointStore {
    pub fn new(directory: PathBuf) -> Self {
        let path = directory.join("checkpoints.json");
        let journal = directory.join("checkpoints.journal");
        Self {
            directory,
            path,
            journal,
            generation: None,
            appended: 0,
            file_bytes: 0,
            behind: false,
            sizes: HashMap::new(),
        }
    }

    pub fn journal_bytes(&self) -> u64 {
        self.appended
    }

    pub fn load(&mut self) -> Result<(Vec<CheckpointRecord>, Option<PathBuf>), String> {
        let text = match fs::read_to_string(&self.path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), None)),
            Err(e) => {
                return Err(format!(
                    "Checkpoint storage at {} could not be read: {e}",
                    self.path.display()
                ));
            }
        };
        let (mut records, generation, damaged) = parse_checkpoint_file_text(&text);
        let (journal_text, journal_records, journal_damaged) =
            match fs::read_to_string(&self.journal) {
                Ok(jtext) => {
                    let (jrecs, jdmg) = parse_journal_text(&jtext, generation.as_deref());
                    (jtext, jrecs, jdmg)
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (String::new(), Vec::new(), false),
                Err(e) => {
                    return Err(format!(
                        "Checkpoint journal at {} could not be read: {e}",
                        self.journal.display()
                    ));
                }
            };
        fold_journal_records(&mut records, journal_records);

        if damaged {
            let backup = self.backup_path();
            copy_exclusive(&self.path, &backup).map_err(|e| {
                format!(
                    "Checkpoint storage at {} could not be backed up to {}: {e}",
                    self.path.display(),
                    backup.display()
                )
            })?;
            if !journal_text.is_empty() && (generation.is_none() || journal_damaged) {
                let _ = self.set_aside_journal(&journal_text);
            }
            self.write(&records)?;
            return Ok((records, Some(backup)));
        }

        if !journal_text.is_empty() {
            let backup = if journal_damaged {
                Some(self.set_aside_journal(&journal_text)?)
            } else {
                None
            };
            self.write(&records)?;
            return Ok((records, backup));
        }

        self.generation = generation;
        self.measure(&records, None);
        Ok((records, None))
    }

    fn backup_path(&self) -> PathBuf {
        self.directory
            .join(format!("checkpoints.json.corrupt-{}", Uuid::new_v4()))
    }

    fn set_aside_journal(&self, text: &str) -> Result<PathBuf, String> {
        let backup = self.backup_path();
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts
            .open(&backup)
            .map_err(|e| format!("Could not write journal backup: {e}"))?;
        f.write_all(text.as_bytes())
            .map_err(|e| format!("Could not write journal backup: {e}"))?;
        Ok(backup)
    }

    fn record_bytes(record: &CheckpointRecord) -> u64 {
        serde_json::to_string_pretty(record)
            .map(|s| {
                let lines = s.lines().count() as u64;
                (s.len() as u64) + lines * 4 + 2
            })
            .unwrap_or(0)
    }

    pub fn measure(
        &mut self,
        records: &[CheckpointRecord],
        changed: Option<&[CheckpointRecord]>,
    ) -> u64 {
        if let Some(ch) = changed {
            for r in ch {
                self.sizes.insert(r.id.clone(), Self::record_bytes(r));
            }
        } else {
            for r in records {
                self.sizes.insert(r.id.clone(), Self::record_bytes(r));
            }
        }
        self.file_size(records) + if changed.is_some() { self.appended } else { 0 }
    }

    fn file_size(&mut self, records: &[CheckpointRecord]) -> u64 {
        let mut bytes = 96u64 + if records.is_empty() { 0 } else { 2 };
        for r in records {
            let sz = *self
                .sizes
                .entry(r.id.clone())
                .or_insert_with(|| Self::record_bytes(r));
            bytes = bytes.saturating_add(sz);
        }
        bytes
    }

    pub fn size_of(&self, id: &str) -> u64 {
        self.sizes.get(id).copied().unwrap_or(0)
    }

    pub fn retain(&mut self, kept: &HashSet<String>) {
        self.sizes.retain(|id, _| kept.contains(id));
    }

    fn must_rewrite(&self) -> bool {
        self.generation.is_none()
            || self.behind
            || self.appended > CHECKPOINT_JOURNAL_FOLD_BYTES.max(self.file_bytes)
    }

    pub fn commit(
        &mut self,
        records: &[CheckpointRecord],
        changed: Option<&[CheckpointRecord]>,
    ) -> Result<(), String> {
        let bytes = self.file_size(records);
        let res = match changed {
            Some(ch) if !self.must_rewrite() => self.append(ch, records, bytes),
            _ => self.write_with_bytes(records, Some(bytes)),
        };
        if res.is_err() {
            self.behind = true;
        }
        res
    }

    pub fn write(&mut self, records: &[CheckpointRecord]) -> Result<(), String> {
        self.write_with_bytes(records, None)
    }

    fn write_with_bytes(
        &mut self,
        records: &[CheckpointRecord],
        bytes: Option<u64>,
    ) -> Result<(), String> {
        let generation = Uuid::new_v4().to_string();
        let storage = CheckpointStorageFile {
            version: CHECKPOINT_STORAGE_VERSION,
            generation: Some(generation.clone()),
            records: records.to_vec(),
        };
        let mut serialized = serde_json::to_string_pretty(&storage)
            .map_err(|e| format!("Could not serialize checkpoints: {e}"))?;
        serialized.push('\n');
        write_atomic_private(&self.path, serialized.as_bytes())
            .map_err(|e| format!("Could not write checkpoints.json: {e}"))?;
        self.generation = Some(generation);
        self.appended = 0;
        self.behind = false;
        self.file_bytes = bytes.unwrap_or_else(|| self.measure(records, None));
        let _ = fs::remove_file(&self.journal);
        Ok(())
    }

    fn append(
        &mut self,
        changed: &[CheckpointRecord],
        all: &[CheckpointRecord],
        bytes: u64,
    ) -> Result<(), String> {
        let Some(ref generation) = self.generation else {
            return self.write_with_bytes(all, Some(bytes));
        };
        if self.behind {
            return self.write_with_bytes(all, Some(bytes));
        }
        let mut data = String::new();
        for rec in changed {
            let line = serde_json::to_string(&json!({
                "generation": generation,
                "record": rec,
            }))
            .map_err(|e| format!("Could not serialize journal record: {e}"))?;
            data.push_str(&line);
            data.push('\n');
        }
        let mut opts = OpenOptions::new();
        opts.write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let append_res = (|| -> std::io::Result<()> {
            if let Some(parent) = self.journal.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut file = opts.open(&self.journal)?;
            let size = file.metadata()?.len();
            if size < self.appended {
                return Err(std::io::Error::other(
                    "The checkpoint journal lost lines it was given.",
                ));
            }
            if size > self.appended {
                file.set_len(self.appended)?;
            }
            file.seek(SeekFrom::Start(self.appended))?;
            file.write_all(data.as_bytes())?;
            file.sync_all()?;
            Ok(())
        })();
        if append_res.is_err() {
            return self.write_with_bytes(all, Some(bytes));
        }
        self.appended = self.appended.saturating_add(data.len() as u64);
        Ok(())
    }
}

fn copy_exclusive(src: &Path, dst: &Path) -> std::io::Result<()> {
    let mut reader = fs::File::open(src)?;
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut writer = opts.open(dst)?;
    std::io::copy(&mut reader, &mut writer)?;
    writer.sync_all()?;
    Ok(())
}

#[derive(Clone, PartialEq, Eq)]
struct FileStamp {
    size: u64,
    mtime_ns: i128,
    ctime_ns: i128,
    ino: u64,
    mode: u32,
}

#[derive(Clone)]
struct SeenFile {
    stamp: FileStamp,
    hash: String,
    reusable: bool,
}

#[derive(Default)]
struct FolderCache {
    checkout: Option<String>,
    files: HashMap<String, SeenFile>,
}

fn file_stamp(meta: &fs::Metadata) -> FileStamp {
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i128)
        .unwrap_or(0);
    #[cfg(unix)]
    let (ctime_ns, ino, mode) = {
        use std::os::unix::fs::MetadataExt;
        (
            (meta.ctime() as i128) * 1_000_000_000 + (meta.ctime_nsec() as i128),
            meta.ino(),
            meta.mode(),
        )
    };
    #[cfg(not(unix))]
    let (ctime_ns, ino, mode) = {
        let ctime = meta
            .created()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as i128)
            .unwrap_or(mtime_ns);
        // Match Node.js (libuv) `st_mode` on Windows: regular files report `0o100666` when
        // writable and `0o100444` when read-only.
        let mode = if meta.permissions().readonly() {
            0o100444
        } else {
            0o100666
        };
        (ctime, 0u64, mode)
    };
    FileStamp {
        size: meta.len(),
        mtime_ns,
        ctime_ns,
        ino,
        mode,
    }
}

fn nlink_count(meta: &fs::Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.nlink()
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        1
    }
}

/// Runs Git in `cwd` matching `CheckpointService.git` (`checkpoints.ts:303-307`):
/// strips all `GIT_*` env vars, enforces `GIT_CHECKPOINT_TIMEOUT`, and caps stdout at 8 MiB.
fn run_checkpoint_git(cwd: &Path, args: &[&str], deadline: Instant) -> Result<String, CheckpointError> {
    if Instant::now() >= deadline {
        return Err(CheckpointError::new("unavailable", "Git timed out during checkpoint capture."));
    }
    let mut cmd = Command::new("git");
    cmd.args([
        "--no-optional-locks",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
    ])
    .args(args)
    .current_dir(cwd)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    for (k, _) in std::env::vars() {
        if k.to_ascii_uppercase().starts_with("GIT_") {
            cmd.env_remove(&k);
        }
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|_| CheckpointError::new("not-repository", UNLISTED_MESSAGE))?;
    let stdout_pipe = child.stdout.take();
    let reader = std::thread::spawn(move || -> (Vec<u8>, bool) {
        let mut buf = Vec::new();
        let mut overflow = false;
        if let Some(stdout) = stdout_pipe {
            let _ = stdout
                .take((GIT_MAX_BUFFER as u64).saturating_add(1))
                .read_to_end(&mut buf);
            if buf.len() > GIT_MAX_BUFFER {
                overflow = true;
            }
        }
        (buf, overflow)
    });
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Ok(st),
            Ok(None) => {
                if Instant::now() >= deadline {
                    timed_out = true;
                    let _ = child.kill();
                    break child.wait();
                }
                if reader.is_finished() {
                    let _ = child.kill();
                    break child.wait();
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => break Err(e),
        }
    };
    let (buf, overflow) = reader.join().unwrap_or_default();
    if timed_out {
        return Err(CheckpointError::new("unavailable", "Git timed out during checkpoint capture."));
    }
    if overflow {
        return Err(CheckpointError::new("too-large", COUNT_MESSAGE));
    }
    let status = status.map_err(|_| CheckpointError::new("not-repository", UNLISTED_MESSAGE))?;
    if !status.success() {
        return Err(CheckpointError::new("not-repository", UNLISTED_MESSAGE));
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Strips Windows `\\?\` verbatim prefixes on standard drive/UNC paths so canonical paths match
/// Node.js `fs.realpath` (and work cleanly as `git.exe` working directories on Windows).
fn normalize_canonical_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            if rest.len() < 248
                && rest.as_bytes().get(1) == Some(&b':')
                && rest.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            {
                return PathBuf::from(rest);
            }
        }
    }
    path
}

/// Joins a validated slash-separated relative checkpoint path onto `root` component by component
/// so Windows verbatim `\\?\` paths never receive unnormalized `/` separators.
fn join_rel_path(root: &Path, rel: &str) -> PathBuf {
    let mut out = root.to_path_buf();
    for part in rel.split('/') {
        if !part.is_empty() {
            out.push(part);
        }
    }
    out
}

/// Resolves a checkout identity matching `checkoutIdentity` (`src/main/agents/threadWorktrees.ts`):
/// the canonical Git directory path if inside a repository, else the canonical folder path.
pub fn checkout_identity(folder: &Path) -> String {
    let canon = fs::canonicalize(folder)
        .map(normalize_canonical_path)
        .unwrap_or_else(|_| folder.to_path_buf());
    let deadline = Instant::now() + GIT_CHECKPOINT_TIMEOUT;
    if let Ok(git_dir) = run_checkpoint_git(&canon, &["rev-parse", "--absolute-git-dir"], deadline) {
        let trimmed = git_dir.trim();
        if !trimmed.is_empty() {
            let gd = fs::canonicalize(trimmed)
                .map(normalize_canonical_path)
                .unwrap_or_else(|_| PathBuf::from(trimmed));
            return gd.to_string_lossy().into_owned();
        }
    }
    canon.to_string_lossy().into_owned()
}

/// Validates that `rel` is safe inside `canon_root` without following any symlink or junction
/// along any path component (matching `CheckpointService.safe`).
pub fn safe_checkpoint_target(canon_root: &Path, rel: &str) -> Result<PathBuf, CheckpointError> {
    if !is_valid_checkpoint_path(rel) {
        return Err(CheckpointError::new("blocked", UNSAFE_NAME_MESSAGE));
    }
    let mut current = canon_root.to_path_buf();
    for part in rel.split('/') {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(CheckpointError::new("blocked", LINK_MESSAGE));
                }
                let resolved = fs::canonicalize(&current)
                    .map(normalize_canonical_path)
                    .map_err(|_| CheckpointError::new("blocked", LINK_MESSAGE))?;
                if !resolved.starts_with(canon_root) {
                    return Err(CheckpointError::new("blocked", LINK_MESSAGE));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => {
                return Err(CheckpointError::new(
                    "unavailable",
                    format!("Could not inspect checkpoint path: {e}"),
                ));
            }
        }
    }
    let target = join_rel_path(canon_root, rel);
    if !target.starts_with(canon_root) {
        return Err(CheckpointError::new(
            "blocked",
            "A checkpoint path is outside the working folder.",
        ));
    }
    Ok(target)
}

/// Captures working-tree snapshots into `blobs/` with stat caching and strict safety bounds,
/// matching `CheckpointCapture` (`src/main/tools/checkpointCapture.ts`).
pub struct CheckpointCapture {
    blobs_dir: PathBuf,
    blob_sizes: HashMap<String, u64>,
    folders: HashMap<PathBuf, FolderCache>,
    folder_order: Vec<PathBuf>,
}

impl CheckpointCapture {
    pub fn new(blobs_dir: PathBuf) -> Self {
        Self {
            blobs_dir,
            blob_sizes: HashMap::new(),
            folders: HashMap::new(),
            folder_order: Vec::new(),
        }
    }

    pub fn forget(&mut self) {
        self.folders.clear();
        self.folder_order.clear();
    }

    pub fn blob_sizes(&self) -> &HashMap<String, u64> {
        &self.blob_sizes
    }

    pub fn blob_sizes_mut(&mut self) -> &mut HashMap<String, u64> {
        &mut self.blob_sizes
    }

    pub fn checkout(&mut self, canon_root: &Path) -> String {
        let entry = self.touch_folder(canon_root);
        if let Some(ref co) = entry.checkout {
            return co.clone();
        }
        let co = checkout_identity(canon_root);
        self.folders
            .entry(canon_root.to_path_buf())
            .or_default()
            .checkout = Some(co.clone());
        co
    }

    fn touch_folder(&mut self, canon_root: &Path) -> &mut FolderCache {
        let key = canon_root.to_path_buf();
        self.folder_order.retain(|p| p != &key);
        self.folder_order.push(key.clone());
        while self.folder_order.len() > REMEMBERED_FOLDERS {
            let oldest = self.folder_order.remove(0);
            self.folders.remove(&oldest);
        }
        self.folders.entry(key).or_default()
    }

    pub fn snapshot(
        &mut self,
        cwd: &Path,
        reuse: bool,
    ) -> Result<CheckpointSnapshot, CheckpointError> {
        let canon_root = fs::canonicalize(cwd)
            .map(normalize_canonical_path)
            .map_err(|e| CheckpointError::new("workspace-unavailable", format!("Working folder unavailable: {e}")))?;
        let deadline = Instant::now() + GIT_CHECKPOINT_TIMEOUT;
        let started_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as i128)
            .unwrap_or(0);

        let listing = run_checkpoint_git(
            &canon_root,
            &["ls-files", "-c", "-o", "--exclude-standard", "-z", "--", "."],
            deadline,
        )?;
        let mut path_set: HashSet<&str> = HashSet::new();
        let mut paths: Vec<String> = Vec::new();
        for p in listing.split('\0').filter(|s| !s.is_empty()) {
            if path_set.insert(p) {
                paths.push(p.to_string());
            }
        }
        paths.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));

        if paths.len() > CHECKPOINT_FILE_LIMIT {
            return Err(CheckpointError::new("too-large", COUNT_MESSAGE));
        }

        // Validate every path, directory safety, symlink/hard-link rules, and size limits before reading.
        let mut total_bytes: u64 = 0;
        let mut entries: Vec<Option<(String, PathBuf, FileStamp)>> = Vec::with_capacity(paths.len());
        let mut checked_dirs: HashSet<String> = HashSet::new();

        for rel in &paths {
            if matches!(rel.as_str(), "__proto__" | "constructor" | "prototype") {
                return Err(CheckpointError::new("blocked", UNSAFE_NAME_MESSAGE));
            }
            if !is_valid_checkpoint_path(rel) {
                return Err(CheckpointError::new(
                    "invalid-request",
                    "This tool request is invalid. Refresh the tools panel.",
                ));
            }
            // Verify parent directories are not symlinks and stay inside `canon_root`.
            if let Some(cut) = rel.rfind('/') {
                let parent_rel = &rel[..cut];
                if checked_dirs.insert(parent_rel.to_string()) {
                    let mut acc = canon_root.clone();
                    for part in parent_rel.split('/') {
                        acc.push(part);
                        match fs::symlink_metadata(&acc) {
                            Ok(meta) => {
                                if meta.file_type().is_symlink() {
                                    return Err(CheckpointError::new("blocked", LINK_MESSAGE));
                                }
                                let resolved = fs::canonicalize(&acc)
                                    .map(normalize_canonical_path)
                                    .map_err(|_| CheckpointError::new("blocked", LINK_MESSAGE))?;
                                if !resolved.starts_with(&canon_root) {
                                    return Err(CheckpointError::new("blocked", LINK_MESSAGE));
                                }
                                if !meta.is_dir() {
                                    break;
                                }
                            }
                            Err(e)
                                if matches!(
                                    e.kind(),
                                    std::io::ErrorKind::NotFound
                                        | std::io::ErrorKind::NotADirectory
                                ) =>
                            {
                                break;
                            }
                            Err(e) => {
                                return Err(CheckpointError::new(
                                    "unavailable",
                                    format!("Could not stat parent directory: {e}"),
                                ));
                            }
                        }
                    }
                }
            }

            let abs = join_rel_path(&canon_root, rel);
            let meta = match fs::symlink_metadata(&abs) {
                Ok(m) => m,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) =>
                {
                    entries.push(None);
                    continue;
                }
                Err(e) => {
                    return Err(CheckpointError::new(
                        "unavailable",
                        format!("Could not stat file: {e}"),
                    ));
                }
            };
            if meta.file_type().is_symlink() {
                return Err(CheckpointError::new("blocked", LINK_MESSAGE));
            }
            if !meta.is_file() || nlink_count(&meta) > 1 {
                return Err(CheckpointError::new("blocked", HARD_LINK_MESSAGE));
            }
            let stamp = file_stamp(&meta);
            if stamp.size > CHECKPOINT_FILE_BYTE_LIMIT {
                return Err(CheckpointError::new("too-large", SIZE_MESSAGE));
            }
            total_bytes = total_bytes.saturating_add(stamp.size);
            if total_bytes > CHECKPOINT_TOTAL_BYTE_LIMIT {
                return Err(CheckpointError::new("too-large", SIZE_MESSAGE));
            }
            entries.push(Some((rel.clone(), abs, stamp)));
        }

        let previous_files = if reuse {
            self.folders
                .get(&canon_root)
                .map(|f| f.files.clone())
                .unwrap_or_default()
        } else {
            HashMap::new()
        };

        let mut files: BTreeMap<String, SnapshotFile> = BTreeMap::new();
        let mut remembered: HashMap<String, SeenFile> = HashMap::new();

        for item in entries.into_iter().flatten() {
            let (rel, abs, stamp) = item;
            if let Some(prev) = previous_files.get(&rel) {
                if prev.reusable
                    && prev.stamp == stamp
                    && self.blob_sizes.contains_key(&prev.hash)
                    && self.blobs_dir.join(&prev.hash).exists()
                {
                    files.insert(
                        rel.clone(),
                        SnapshotFile {
                            hash: prev.hash.clone(),
                            mode: prev.stamp.mode,
                        },
                    );
                    remembered.insert(rel, prev.clone());
                    continue;
                }
            }
            let file = match fs::File::open(&abs) {
                Ok(f) => f,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) =>
                {
                    continue;
                }
                Err(e) => {
                    return Err(CheckpointError::new(
                        "unavailable",
                        format!("Could not read file for checkpoint: {e}"),
                    ));
                }
            };
            let file_meta = file.metadata().map_err(|e| {
                CheckpointError::new(
                    "unavailable",
                    format!("Could not inspect file for checkpoint: {e}"),
                )
            })?;
            if !file_meta.is_file() || nlink_count(&file_meta) > 1 {
                return Err(CheckpointError::new("blocked", HARD_LINK_MESSAGE));
            }
            let mut bytes = Vec::with_capacity(stamp.size as usize);
            file.take(CHECKPOINT_FILE_BYTE_LIMIT.saturating_add(1))
                .read_to_end(&mut bytes)
                .map_err(|e| {
                    CheckpointError::new("unavailable", format!("Could not read file: {e}"))
                })?;
            if bytes.len() as u64 > CHECKPOINT_FILE_BYTE_LIMIT {
                return Err(CheckpointError::new("too-large", SIZE_MESSAGE));
            }
            let hash = blob_hash(&bytes);
            write_blob_if_absent(&self.blobs_dir, &hash, &bytes)?;
            self.blob_sizes.insert(hash.clone(), bytes.len() as u64);

            let trusted =
                stamp.mtime_ns < started_ns - RACY_NS && stamp.ctime_ns < started_ns - RACY_NS;
            let reusable = trusted && (bytes.len() as u64) == stamp.size;
            files.insert(
                rel.clone(),
                SnapshotFile {
                    hash: hash.clone(),
                    mode: stamp.mode,
                },
            );
            remembered.insert(
                rel,
                SeenFile {
                    stamp,
                    hash,
                    reusable,
                },
            );
        }

        let index = run_checkpoint_git(&canon_root, &["ls-files", "--stage", "-z"], deadline)?;
        let head = run_checkpoint_git(&canon_root, &["rev-parse", "--verify", "HEAD"], deadline)
            .map(|s| s.trim().to_string())
            .unwrap_or_default();

        self.touch_folder(&canon_root).files = remembered;

        Ok(CheckpointSnapshot { files, index, head })
    }
}

/// Full stateful checkpoint manager owning `checkpoints.json`, `checkpoints.journal`, `blobs/`,
/// overlap detection, inspection, pre-revert file verification, atomic restore, retention, and GC.
pub struct CheckpointManager {
    directory: PathBuf,
    blobs_dir: PathBuf,
    store: CheckpointStore,
    capture: CheckpointCapture,
    records: Vec<CheckpointRecord>,
    loaded: bool,
    history_enabled: bool,
    max_bytes: u64,
    locks: HashSet<String>,
    recovery_backup: Option<PathBuf>,
}

impl CheckpointManager {
    pub fn new(directory: PathBuf) -> Self {
        let blobs_dir = directory.join("blobs");
        Self {
            store: CheckpointStore::new(directory.clone()),
            capture: CheckpointCapture::new(blobs_dir.clone()),
            directory,
            blobs_dir,
            records: Vec::new(),
            loaded: false,
            history_enabled: true,
            max_bytes: CHECKPOINT_DEFAULT_MAX_BYTES,
            locks: HashSet::new(),
            recovery_backup: None,
        }
    }

    pub fn with_max_bytes(mut self, max_bytes: u64) -> Self {
        self.max_bytes = max_bytes;
        self
    }

    pub fn set_history_enabled(&mut self, enabled: bool) -> Result<(), String> {
        self.history_enabled = enabled;
        self.ensure_loaded()?;
        if !enabled {
            self.capture.forget();
        }
        self.save(None)
    }

    pub fn ensure_loaded(&mut self) -> Result<(), String> {
        if self.loaded {
            return Ok(());
        }
        let (mut records, set_aside) = self.store.load()?;
        if let Some(backup) = set_aside {
            self.recovery_backup = Some(backup);
        }
        for rec in &mut records {
            if rec.status == CheckpointStatus::Capturing {
                rec.status = CheckpointStatus::Unavailable;
                rec.unavailable_reason = Some(UnavailableReason::CaptureUnavailable);
                rec.reason = Some(REASON_INTERRUPTED.to_string());
            }
        }
        self.records = records;
        self.loaded = true;
        Ok(())
    }

    pub fn records(&self) -> &[CheckpointRecord] {
        &self.records
    }

    pub fn recovery_backup(&self) -> Option<&Path> {
        self.recovery_backup.as_deref()
    }

    fn unresolved(record: &CheckpointRecord) -> bool {
        matches!(
            record.status,
            CheckpointStatus::Reverting | CheckpointStatus::Uncertain
        )
    }

    pub fn is_blocked(&self, thread_id: &str) -> bool {
        if self.locks.contains(thread_id) {
            return true;
        }
        let cwd = self
            .records
            .iter()
            .find(|r| r.thread_id == thread_id)
            .map(|r| r.cwd.as_str());
        self.records.iter().any(|r| {
            (r.thread_id == thread_id || cwd.is_some_and(|c| c == r.cwd)) && Self::unresolved(r)
        })
    }

    pub fn is_workspace_blocked(
        &mut self,
        thread_id: &str,
        folder: Option<&Path>,
    ) -> Result<bool, String> {
        self.ensure_loaded()?;
        if self.is_blocked(thread_id) {
            return Ok(true);
        }
        let pending: Vec<CheckpointRecord> = self
            .records
            .iter()
            .filter(|r| Self::unresolved(r) || self.locks.contains(&r.thread_id))
            .cloned()
            .collect();
        if pending.is_empty() {
            return Ok(false);
        }
        let Some(f) = folder else {
            return Ok(false);
        };
        let checkout = checkout_identity(f);
        Ok(pending.iter().any(|r| {
            r.checkout
                .as_deref()
                .map(|co| co == checkout)
                .unwrap_or_else(|| checkout_identity(Path::new(&r.cwd)) == checkout)
        }))
    }

    /// Computes changed file paths between `before` and `after` snapshots sorted by UTF-16 code
    /// units (matching JS `Array.prototype.sort()` in `CheckpointService.changes`).
    pub fn changes(record: &CheckpointRecord) -> Vec<CheckpointChangeEntry> {
        let Some(ref after) = record.after else {
            return Vec::new();
        };
        let mut keys: Vec<&str> = record
            .before
            .files
            .keys()
            .chain(after.files.keys())
            .map(String::as_str)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let mut out = Vec::new();
        for path in keys {
            let b = record.before.files.get(path);
            let a = after.files.get(path);
            if b == a {
                continue;
            }
            let change = if b.is_none() {
                "added"
            } else if a.is_none() {
                "deleted"
            } else {
                "modified"
            };
            out.push(CheckpointChangeEntry {
                path: path.to_string(),
                change,
            });
        }
        out
    }

    fn matches_thread(record: &CheckpointRecord, thread: &CheckpointThreadInfo) -> bool {
        record.thread_id == thread.thread_id
            && record.provider_id == thread.provider_id
            && record.binding_id == thread.binding_id
    }

    fn public_checkpoint(record: &CheckpointRecord, thread: Option<&CheckpointThreadInfo>) -> Value {
        let supported = thread.is_some_and(|t| t.rollback_supported && Self::matches_thread(record, t));
        let status = match record.status {
            CheckpointStatus::Capturing => "unavailable",
            CheckpointStatus::Ready => "ready",
            CheckpointStatus::Reverting => "reverting",
            CheckpointStatus::Uncertain => "uncertain",
            CheckpointStatus::Reverted => "reverted",
            CheckpointStatus::Unavailable => "unavailable",
        };
        let reason: Option<String> = if let Some(ref r) = record.reason {
            Some(r.clone())
        } else if !supported {
            Some(
                thread
                    .and_then(|t| t.unsupported_reason.clone())
                    .unwrap_or_else(|| {
                        "This provider does not expose matching native conversation rollback."
                            .to_string()
                    }),
            )
        } else {
            None
        };
        let mut obj = json!({
            "id": record.id,
            "threadId": record.thread_id,
            "createdAt": record.created_at,
            "status": status,
            "files": Self::changes(record),
            "supported": supported,
        });
        if let Some(r) = reason {
            obj["reason"] = json!(r);
        }
        obj
    }

    pub fn before_turn(
        &mut self,
        thread: &CheckpointThreadInfo,
        workspace_id: &str,
        working_directory: &Path,
    ) -> Result<Option<CheckpointRecord>, CheckpointError> {
        self.ensure_loaded()
            .map_err(|e| CheckpointError::new("unavailable", e))?;
        if self
            .is_workspace_blocked(&thread.thread_id, Some(working_directory))
            .map_err(|e| CheckpointError::new("unavailable", e))?
        {
            return Err(CheckpointError::new(
                "blocked",
                "Resolve the interrupted checkpoint revert before sending more work.",
            ));
        }
        if !self.history_enabled {
            self.capture.forget();
            self.save(None)
                .map_err(|e| CheckpointError::new("unavailable", e))?;
            return Ok(None);
        }
        let mut removed_pending = false;
        if let Some(pos) = self
            .records
            .iter()
            .position(|r| r.thread_id == thread.thread_id && r.status == CheckpointStatus::Capturing)
        {
            if self.records[pos].before_users != thread.user_message_ids
                || thread.running == Some(true)
            {
                return Ok(None);
            }
            self.records.remove(pos);
            removed_pending = true;
        }
        let canon = fs::canonicalize(working_directory)
            .map(normalize_canonical_path)
            .map_err(|e| {
                CheckpointError::new("workspace-unavailable", format!("Working folder unavailable: {e}"))
            })?;
        let mut capture_reason: Option<String> = None;
        let before = match self.capture.snapshot(&canon, true) {
            Ok(snap) => snap,
            Err(err) => {
                capture_reason = Some(err.message);
                CheckpointSnapshot::default()
            }
        };
        let checkout = self.capture.checkout(&canon);
        let mut changed_ids: Vec<String> = Vec::new();
        let mut overlapped = false;
        for other in &mut self.records {
            if other.thread_id != thread.thread_id && other.status == CheckpointStatus::Capturing {
                let same_co = other
                    .checkout
                    .as_deref()
                    .map(|c| c == checkout)
                    .unwrap_or_else(|| checkout_identity(Path::new(&other.cwd)) == checkout);
                if same_co {
                    overlapped = true;
                    other.reason = Some(REASON_OVERLAPPED.to_string());
                    other.unavailable_reason = Some(UnavailableReason::SharedCheckout);
                    changed_ids.push(other.id.clone());
                }
            }
        }
        let mut record = CheckpointRecord {
            id: Uuid::new_v4().to_string(),
            thread_id: thread.thread_id.clone(),
            workspace_id: workspace_id.to_string(),
            cwd: canon.to_string_lossy().into_owned(),
            checkout: Some(checkout),
            provider_id: thread.provider_id.clone(),
            binding_id: thread.binding_id.clone(),
            created_at: now_iso(),
            before_users: thread.user_message_ids.clone(),
            after_users: None,
            before,
            after: None,
            status: CheckpointStatus::Capturing,
            reason: if overlapped {
                Some(REASON_OVERLAPPED.to_string())
            } else {
                None
            },
            unavailable_reason: if overlapped {
                Some(UnavailableReason::SharedCheckout)
            } else {
                None
            },
        };
        if let Some(reason) = capture_reason {
            record.status = CheckpointStatus::Unavailable;
            record.unavailable_reason = Some(UnavailableReason::CaptureUnavailable);
            let truncated: String = reason.chars().take(2000).collect();
            record.reason = Some(truncated);
        }
        changed_ids.push(record.id.clone());
        let saved_record = record.clone();
        self.records.push(record);
        let changed_records: Option<Vec<CheckpointRecord>> = if removed_pending {
            None
        } else {
            Some(
                self.records
                    .iter()
                    .filter(|r| changed_ids.contains(&r.id))
                    .cloned()
                    .collect(),
            )
        };
        self.save(changed_records.as_deref())
            .map_err(|e| CheckpointError::new("unavailable", e))?;
        Ok(Some(saved_record))
    }

    pub fn after_turn(
        &mut self,
        thread: &CheckpointThreadInfo,
    ) -> Result<Option<CheckpointRecord>, CheckpointError> {
        self.ensure_loaded()
            .map_err(|e| CheckpointError::new("unavailable", e))?;
        if !self.history_enabled {
            self.capture.forget();
            self.save(None)
                .map_err(|e| CheckpointError::new("unavailable", e))?;
            return Ok(None);
        }
        let Some(pos) = self
            .records
            .iter()
            .position(|r| r.thread_id == thread.thread_id && r.status == CheckpointStatus::Capturing)
        else {
            return Ok(None);
        };
        if thread.running.or(thread.busy) != Some(false) {
            return Ok(None);
        }
        let rec_ref = &self.records[pos];
        let prefix_matches = thread.user_message_ids.len() >= rec_ref.before_users.len()
            && thread.user_message_ids[..rec_ref.before_users.len()] == rec_ref.before_users[..];
        if !Self::matches_thread(rec_ref, thread) || !prefix_matches {
            self.records[pos].status = CheckpointStatus::Unavailable;
            self.records[pos].unavailable_reason = Some(UnavailableReason::CaptureUnavailable);
            self.records[pos].reason = Some(REASON_BINDING_CHANGED.to_string());
            let updated = self.records[pos].clone();
            self.save(None)
                .map_err(|e| CheckpointError::new("unavailable", e))?;
            return Ok(Some(updated));
        }
        if thread.user_message_ids.len() == rec_ref.before_users.len() {
            return Ok(None);
        }
        let cwd = PathBuf::from(&self.records[pos].cwd);
        let after = match self.capture.snapshot(&cwd, true) {
            Ok(snap) => snap,
            Err(err) => {
                self.records[pos].status = CheckpointStatus::Unavailable;
                self.records[pos].unavailable_reason = Some(UnavailableReason::CaptureUnavailable);
                self.records[pos].reason = Some(err.message.chars().take(2000).collect());
                let updated = self.records[pos].clone();
                self.save(None)
                    .map_err(|e| CheckpointError::new("unavailable", e))?;
                return Ok(Some(updated));
            }
        };
        let rec = &mut self.records[pos];
        let history_changed = rec.before.index != after.index || rec.before.head != after.head;
        rec.after = Some(after);
        rec.after_users = Some(thread.user_message_ids.clone());
        rec.status = if rec.reason.is_some() {
            CheckpointStatus::Unavailable
        } else {
            CheckpointStatus::Ready
        };
        if history_changed {
            rec.status = CheckpointStatus::Unavailable;
            rec.unavailable_reason = Some(UnavailableReason::CaptureUnavailable);
            rec.reason = Some(REASON_HISTORY_CHANGED.to_string());
        }
        let updated = rec.clone();
        self.save(None)
            .map_err(|e| CheckpointError::new("unavailable", e))?;
        Ok(Some(updated))
    }

    pub fn list(
        &mut self,
        thread_id: &str,
        workspace_id: &str,
        thread: Option<&CheckpointThreadInfo>,
    ) -> Value {
        if let Err(err) = self.ensure_loaded() {
            return tools_err("unavailable", &err);
        }
        let checkpoints: Vec<Value> = self
            .records
            .iter()
            .rev()
            .filter(|r| {
                r.thread_id == thread_id
                    && r.workspace_id == workspace_id
                    && r.status != CheckpointStatus::Capturing
            })
            .map(|r| Self::public_checkpoint(r, thread))
            .collect();
        let supported = thread.is_some_and(|t| t.rollback_supported);
        let mut value = json!({
            "checkpoints": checkpoints,
            "supported": supported,
        });
        let mut reasons: Vec<String> = Vec::new();
        if let Some(ref backup) = self.recovery_backup {
            if backup.exists() {
                let name = backup
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("checkpoints.json.corrupt");
                reasons.push(format!(
                    "Sotto set aside a checkpoint file it could not read as {name} and kept the rest."
                ));
            }
        }
        if !supported {
            reasons.push(
                thread
                    .and_then(|t| t.unsupported_reason.clone())
                    .unwrap_or_else(|| {
                        "Native conversation rollback is unavailable for this provider.".to_string()
                    }),
            );
        }
        if !reasons.is_empty() {
            value["reason"] = json!(reasons.join(" "));
        }
        tools_ok(value)
    }

    pub fn inspect(
        &mut self,
        thread_id: &str,
        workspace_id: &str,
        checkpoint_id: &str,
        thread: &CheckpointThreadInfo,
    ) -> Value {
        if let Err(err) = self.ensure_loaded() {
            return tools_err("unavailable", &err);
        }
        let Some(record) = self.records.iter().find(|r| r.id == checkpoint_id).cloned() else {
            return tools_err(
                "workspace-changed",
                "This checkpoint no longer matches the selected native thread and working copy.",
            );
        };
        if record.workspace_id != workspace_id
            || record.thread_id != thread_id
            || !Self::matches_thread(&record, thread)
        {
            return tools_err(
                "workspace-changed",
                "This checkpoint no longer matches the selected native thread and working copy.",
            );
        }
        let pairs: Vec<CheckpointBlobPair> = Self::changes(&record)
            .into_iter()
            .map(|entry| CheckpointBlobPair {
                before_hash: record.before.files.get(&entry.path).map(|f| f.hash.clone()),
                after_hash: record
                    .after
                    .as_ref()
                    .and_then(|s| s.files.get(&entry.path))
                    .map(|f| f.hash.clone()),
                path: entry.path,
            })
            .collect();
        match inspect_checkpoint_blobs(&self.blobs_dir, &pairs) {
            Ok(patches) => tools_ok(json!({
                "checkpoint": Self::public_checkpoint(&record, Some(thread)),
                "patches": patches,
            })),
            Err(err) => err.to_tools_err(),
        }
    }

    pub fn check_files(
        &mut self,
        record: &CheckpointRecord,
        recovery: bool,
    ) -> Result<(), CheckpointError> {
        let Some(ref after) = record.after else {
            return Err(CheckpointError::new(
                "blocked",
                "This checkpoint has no completed file snapshot.",
            ));
        };
        let current = self.capture.snapshot(Path::new(&record.cwd), false)?;
        if current.head != after.head || current.index != after.index {
            return Err(CheckpointError::new(
                "blocked",
                "Git history or staging changed after this checkpoint. Preserve those changes before reverting.",
            ));
        }
        for entry in Self::changes(record) {
            let cur = current.files.get(&entry.path);
            let aft = after.files.get(&entry.path);
            let bef = record.before.files.get(&entry.path);
            if cur != aft && !(recovery && cur == bef) {
                return Err(CheckpointError::new(
                    "blocked",
                    format!(
                        "Later edits in {} would be overwritten. Preserve them before reverting.",
                        entry.path
                    ),
                ));
            }
            if let Some(before_file) = bef {
                let _ = read_verified_blob(&self.blobs_dir, &before_file.hash)?;
            }
        }
        Ok(())
    }

    pub fn restore_checkpoint_files(&mut self, checkpoint_id: &str) -> Result<CheckpointRecord, CheckpointError> {
        self.ensure_loaded()
            .map_err(|e| CheckpointError::new("unavailable", e))?;
        let Some(pos) = self.records.iter().position(|r| r.id == checkpoint_id) else {
            return Err(CheckpointError::new(
                "workspace-changed",
                "This checkpoint no longer exists.",
            ));
        };
        let record = self.records[pos].clone();
        self.check_files(&record, true)?;
        let canon_root = fs::canonicalize(&record.cwd)
            .map(normalize_canonical_path)
            .map_err(|e| {
                CheckpointError::new("workspace-unavailable", format!("Working folder unavailable: {e}"))
            })?;
        for entry in Self::changes(&record) {
            let target = safe_checkpoint_target(&canon_root, &entry.path)?;
            let before = record.before.files.get(&entry.path);
            let after_hash = record
                .after
                .as_ref()
                .and_then(|s| s.files.get(&entry.path))
                .map(|f| f.hash.as_str());
            if let Some(existing_bytes) =
                read_bounded_regular_file(&target, CHECKPOINT_FILE_BYTE_LIMIT, &entry.path)?
            {
                let h = blob_hash(&existing_bytes);
                if Some(h.as_str()) != after_hash && Some(h.as_str()) != before.map(|b| b.hash.as_str()) {
                    return Err(CheckpointError::new(
                        "blocked",
                        format!("Later edits in {} would be overwritten.", entry.path),
                    ));
                }
            }
            if let Some(before_file) = before {
                let bytes = read_verified_blob(&self.blobs_dir, &before_file.hash)?;
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| {
                        CheckpointError::new("unavailable", format!("Could not create directory: {e}"))
                    })?;
                }
                let _ = safe_checkpoint_target(&canon_root, &entry.path)?;
                let temp = target.with_file_name(format!(
                    "{}.sotto-revert-{}",
                    target
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("file"),
                    Uuid::new_v4()
                ));
                let mut opts = OpenOptions::new();
                opts.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    opts.mode(before_file.mode);
                }
                let write_res = (|| -> std::io::Result<()> {
                    let mut f = opts.open(&temp)?;
                    f.write_all(&bytes)?;
                    f.sync_all()?;
                    Ok(())
                })();
                if let Err(err) = write_res {
                    let _ = fs::remove_file(&temp);
                    return Err(CheckpointError::new(
                        "unavailable",
                        format!("Could not restore {}: {err}", entry.path),
                    ));
                }
                if let Err(err) = rename_with_retry(&temp, &target) {
                    let _ = fs::remove_file(&temp);
                    return Err(CheckpointError::new(
                        "unavailable",
                        format!("Could not replace {}: {err}", entry.path),
                    ));
                }
            } else if let Err(err) = fs::remove_file(&target) {
                if err.kind() != std::io::ErrorKind::NotFound {
                    return Err(CheckpointError::new(
                        "unavailable",
                        format!("Could not remove {}: {err}", entry.path),
                    ));
                }
            }
        }
        self.records[pos].status = CheckpointStatus::Reverted;
        self.records[pos].reason = None;
        let updated = self.records[pos].clone();
        self.save(None)
            .map_err(|e| CheckpointError::new("unavailable", e))?;
        Ok(updated)
    }

    pub fn forget_thread(&mut self, thread_id: &str) -> Result<(), String> {
        self.ensure_loaded()?;
        self.records
            .retain(|r| r.thread_id != thread_id || Self::unresolved(r));
        self.save(None)?;
        // Remove recovery backups that mention the forgotten thread (matching `checkpoints.ts:264`).
        let needle = serde_json::to_string(thread_id).unwrap_or_default();
        if let Ok(rd) = fs::read_dir(&self.directory) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !name.starts_with("checkpoints.json.corrupt-") {
                    continue;
                }
                let path = entry.path();
                if let Ok(meta) = fs::symlink_metadata(&path) {
                    if !meta.file_type().is_file() {
                        continue;
                    }
                }
                if let Ok(text) = fs::read_to_string(&path) {
                    if text.contains("\"threadId\"") && text.contains(&needle) {
                        let _ = fs::remove_file(&path);
                        if self.recovery_backup.as_deref() == Some(path.as_path()) {
                            self.recovery_backup = None;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn save(&mut self, changed: Option<&[CheckpointRecord]>) -> Result<(), String> {
        let now_ms = Utc::now().timestamp_millis();
        let cutoff_ms = now_ms - CHECKPOINT_RETENTION_MS;
        let before_len = self.records.len();
        let history_off = !self.history_enabled;
        self.records.retain(|r| {
            if Self::unresolved(r) {
                return true;
            }
            if history_off {
                return false;
            }
            DateTime::parse_from_rfc3339(&r.created_at)
                .map(|dt| dt.timestamp_millis() >= cutoff_ms)
                .unwrap_or(true)
        });
        let mut removed = self.records.len() != before_len;

        // Discover existing blobs in `blobs/` so unreferenced backups can be collected.
        let mut regular_blobs: HashSet<String> = HashSet::new();
        if let Ok(rd) = fs::read_dir(&self.blobs_dir) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !is_valid_sha256_hex(&name) {
                    continue;
                }
                if let Ok(meta) = fs::symlink_metadata(entry.path()) {
                    if meta.file_type().is_file() {
                        regular_blobs.insert(name.clone());
                        self.capture
                            .blob_sizes_mut()
                            .entry(name)
                            .or_insert(meta.len());
                    }
                }
            }
        }

        // Compute reference counts and total bytes across active checkpoints.
        let mut ref_counts: HashMap<String, usize> = HashMap::new();
        let mut blob_total: u64 = 0;
        for rec in &self.records {
            let mut seen_rec: HashSet<&str> = HashSet::new();
            for snap in std::iter::once(&rec.before).chain(rec.after.iter()) {
                for file in snap.files.values() {
                    if seen_rec.insert(file.hash.as_str()) {
                        let count = ref_counts.entry(file.hash.clone()).or_insert(0);
                        if *count == 0 {
                            blob_total = blob_total.saturating_add(
                                self.capture.blob_sizes().get(&file.hash).copied().unwrap_or(0),
                            );
                        }
                        *count += 1;
                    }
                }
            }
        }
        let mut total_bytes = self.store.measure(&self.records, changed) + blob_total;

        // Evict oldest resolved checkpoints while over storage budget.
        if total_bytes > self.max_bytes {
            let mut order: Vec<(i64, String)> = self
                .records
                .iter()
                .filter(|r| !Self::unresolved(r))
                .map(|r| {
                    let ts = DateTime::parse_from_rfc3339(&r.created_at)
                        .map(|dt| dt.timestamp_millis())
                        .unwrap_or(0);
                    (ts, r.id.clone())
                })
                .collect();
            order.sort_by_key(|(ts, _)| *ts);
            let mut evicted: HashSet<String> = HashSet::new();
            for (_, id) in order {
                if total_bytes <= self.max_bytes {
                    break;
                }
                if let Some(rec) = self.records.iter().find(|r| r.id == id) {
                    let mut seen_rec: HashSet<&str> = HashSet::new();
                    for snap in std::iter::once(&rec.before).chain(rec.after.iter()) {
                        for file in snap.files.values() {
                            if seen_rec.insert(file.hash.as_str()) {
                                if let Some(c) = ref_counts.get_mut(&file.hash) {
                                    *c = c.saturating_sub(1);
                                    if *c == 0 {
                                        ref_counts.remove(&file.hash);
                                        total_bytes = total_bytes.saturating_sub(
                                            self.capture
                                                .blob_sizes()
                                                .get(&file.hash)
                                                .copied()
                                                .unwrap_or(0),
                                        );
                                    }
                                }
                            }
                        }
                    }
                    total_bytes = total_bytes.saturating_sub(self.store.size_of(&id));
                    evicted.insert(id);
                    removed = true;
                }
            }
            if !evicted.is_empty() {
                self.records.retain(|r| !evicted.contains(&r.id));
            }
        }

        let kept_ids: HashSet<String> = self.records.iter().map(|r| r.id.clone()).collect();
        self.store.retain(&kept_ids);

        // Commit metadata BEFORE deleting any unreferenced blobs.
        let journal_changed: Option<Vec<CheckpointRecord>> = if removed {
            None
        } else {
            changed.map(|ch| {
                ch.iter()
                    .filter(|r| kept_ids.contains(&r.id))
                    .cloned()
                    .collect()
            })
        };
        self.store
            .commit(&self.records, journal_changed.as_deref())?;

        // Garbage-collect unreferenced blobs.
        for name in regular_blobs {
            if !ref_counts.contains_key(&name) {
                let _ = fs::remove_file(self.blobs_dir.join(&name));
                self.capture.blob_sizes_mut().remove(&name);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_git_repo(dir: &Path) {
        let git = |args: &[&str]| {
            let st = Command::new("git")
                .args(args)
                .current_dir(dir)
                .env("GIT_AUTHOR_NAME", "Test")
                .env("GIT_AUTHOR_EMAIL", "test@example.com")
                .env("GIT_COMMITTER_NAME", "Test")
                .env("GIT_COMMITTER_EMAIL", "test@example.com")
                .status()
                .unwrap();
            assert!(st.success(), "git {args:?} failed");
        };
        git(&["init", "-b", "main"]);
        fs::write(dir.join("app.txt"), "v1\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "init"]);
    }

    #[test]
    fn captures_inspects_restores_and_gc_prunes_checkpoints_with_journal_parity() {
        let data_dir = tempfile::tempdir().unwrap();
        let repo_dir = tempfile::tempdir().unwrap();
        init_git_repo(repo_dir.path());

        let cp_dir = data_dir.path().join("checkpoints");
        let mut mgr = CheckpointManager::new(cp_dir.clone());
        let ws_id = "ws-1";

        let thread_before = CheckpointThreadInfo {
            thread_id: "t-1".into(),
            provider_id: "codex".into(),
            binding_id: "codex:sess-1".into(),
            user_message_ids: vec!["u1".into()],
            busy: Some(false),
            running: Some(false),
            rollback_supported: true,
            unsupported_reason: None,
        };

        let created = mgr
            .before_turn(&thread_before, ws_id, repo_dir.path())
            .unwrap()
            .expect("before_turn should create capturing record");
        assert_eq!(created.status, CheckpointStatus::Capturing);

        // Simulate agent turn modifying app.txt and adding new.txt.
        fs::write(repo_dir.path().join("app.txt"), "v2\nline2\n").unwrap();
        fs::write(repo_dir.path().join("new.txt"), "added\n").unwrap();

        let thread_after = CheckpointThreadInfo {
            user_message_ids: vec!["u1".into(), "u2".into()],
            ..thread_before.clone()
        };
        let finished = mgr
            .after_turn(&thread_after)
            .unwrap()
            .expect("after_turn should finalize checkpoint");
        assert_eq!(finished.status, CheckpointStatus::Ready);

        // List & inspect match `checkpointListingSchema` / `checkpointInspectionSchema`.
        let listed = mgr.list("t-1", ws_id, Some(&thread_after));
        assert_eq!(listed["ok"], true);
        assert_eq!(listed["value"]["checkpoints"].as_array().unwrap().len(), 1);
        assert_eq!(listed["value"]["checkpoints"][0]["status"], "ready");

        let inspected = mgr.inspect("t-1", ws_id, &finished.id, &thread_after);
        assert_eq!(inspected["ok"], true);
        let patches = inspected["value"]["patches"].as_array().unwrap();
        assert_eq!(patches.len(), 2);
        assert_eq!(patches[0]["path"], "app.txt");
        assert_eq!(patches[0]["before"], "v1\n");
        assert_eq!(patches[0]["after"], "v2\nline2\n");
        assert_eq!(patches[0]["binary"], false);
        assert_eq!(patches[1]["path"], "new.txt");
        assert!(patches[1]["before"].is_null());
        assert_eq!(patches[1]["after"], "added\n");

        // Restoring reverts app.txt to v1 and deletes new.txt.
        let reverted = mgr.restore_checkpoint_files(&finished.id).unwrap();
        assert_eq!(reverted.status, CheckpointStatus::Reverted);
        assert_eq!(fs::read_to_string(repo_dir.path().join("app.txt")).unwrap(), "v1\n");
        assert!(!repo_dir.path().join("new.txt").exists());

        // Reloading from disk preserves records; forgetting thread prunes blobs.
        let mut reloaded = CheckpointManager::new(cp_dir.clone());
        reloaded.ensure_loaded().unwrap();
        assert_eq!(reloaded.records().len(), 1);
        reloaded.forget_thread("t-1").unwrap();
        assert_eq!(reloaded.records().len(), 0);
        let remaining_blobs = fs::read_dir(cp_dir.join("blobs")).unwrap().count();
        assert_eq!(remaining_blobs, 0);
    }

    #[test]
    fn refuses_later_edits_on_restore_and_detects_corrupt_blob_integrity() {
        let data_dir = tempfile::tempdir().unwrap();
        let repo_dir = tempfile::tempdir().unwrap();
        init_git_repo(repo_dir.path());

        let cp_dir = data_dir.path().join("checkpoints");
        let mut mgr = CheckpointManager::new(cp_dir.clone());
        let thread = CheckpointThreadInfo {
            thread_id: "t-edit".into(),
            provider_id: "codex".into(),
            binding_id: "codex:s2".into(),
            user_message_ids: vec!["u1".into()],
            busy: Some(false),
            running: Some(false),
            rollback_supported: true,
            unsupported_reason: None,
        };
        mgr.before_turn(&thread, "ws-e", repo_dir.path()).unwrap();
        fs::write(repo_dir.path().join("app.txt"), "turn-edit\n").unwrap();
        let thread_after = CheckpointThreadInfo {
            user_message_ids: vec!["u1".into(), "u2".into()],
            ..thread
        };
        let cp = mgr.after_turn(&thread_after).unwrap().unwrap();

        // Later manual edit blocks restore.
        fs::write(repo_dir.path().join("app.txt"), "later-user-edit\n").unwrap();
        let err = mgr.restore_checkpoint_files(&cp.id).unwrap_err();
        assert_eq!(err.code, "blocked");
        assert!(err.message.contains("Later edits"));

        // Corrupting a blob on disk fails integrity check on inspect.
        let hash = cp.before.files.get("app.txt").unwrap().hash.clone();
        fs::write(cp_dir.join("blobs").join(&hash), b"tampered").unwrap();
        let inspected = mgr.inspect("t-edit", "ws-e", &cp.id, &thread_after);
        assert_eq!(inspected["ok"], false);
        assert_eq!(inspected["error"]["code"], "blocked");
    }

    #[test]
    fn folds_journal_lines_and_recovers_corrupt_checkpoints_json_with_backup() {
        let data_dir = tempfile::tempdir().unwrap();
        let cp_dir = data_dir.path().join("checkpoints");
        fs::create_dir_all(&cp_dir).unwrap();

        let id1 = Uuid::new_v4().to_string();
        let id2 = Uuid::new_v4().to_string();
        let gen = Uuid::new_v4().to_string();
        let rec1 = CheckpointRecord {
            id: id1.clone(),
            thread_id: "t1".into(),
            workspace_id: "ws1".into(),
            cwd: "/tmp/repo".into(),
            checkout: None,
            provider_id: "codex".into(),
            binding_id: "codex:1".into(),
            created_at: now_iso(),
            before_users: vec!["u1".into()],
            after_users: Some(vec!["u1".into(), "u2".into()]),
            before: CheckpointSnapshot::default(),
            after: Some(CheckpointSnapshot::default()),
            status: CheckpointStatus::Ready,
            reason: None,
            unavailable_reason: None,
        };
        let mut rec2 = rec1.clone();
        rec2.id = id2.clone();
        rec2.status = CheckpointStatus::Capturing;

        // Write valid v2 file + journal line + truncated torn tail line.
        fs::write(
            cp_dir.join("checkpoints.json"),
            serde_json::to_string_pretty(&json!({
                "version": 2,
                "generation": gen,
                "records": [rec1],
            }))
            .unwrap(),
        )
        .unwrap();
        let jline = serde_json::to_string(&json!({ "generation": gen, "record": rec2 })).unwrap();
        fs::write(
            cp_dir.join("checkpoints.journal"),
            format!("{jline}\n{{\"generation\":\"torn"),
        )
        .unwrap();

        // Read-only load sees both records without mutating files.
        let ro = read_checkpoints_readonly(&cp_dir).unwrap();
        assert_eq!(ro.len(), 2);

        // Manager load folds journal and converts leftover `capturing` to `unavailable`.
        let mut mgr = CheckpointManager::new(cp_dir.clone());
        mgr.ensure_loaded().unwrap();
        assert_eq!(mgr.records().len(), 2);
        let folded2 = mgr.records().iter().find(|r| r.id == id2).unwrap();
        assert_eq!(folded2.status, CheckpointStatus::Unavailable);
        assert_eq!(folded2.reason.as_deref(), Some(REASON_INTERRUPTED));

        // Corrupt JSON recovery backs up original and salvages valid record objects.
        let good_json = serde_json::to_string(&rec1).unwrap();
        fs::write(
            cp_dir.join("checkpoints.json"),
            format!("{{\"version\":2,\"records\":[{good_json}, {{\"broken\":true"),
        )
        .unwrap();
        let mut recovered_mgr = CheckpointManager::new(cp_dir.clone());
        recovered_mgr.ensure_loaded().unwrap();
        assert_eq!(recovered_mgr.records().len(), 1);
        assert_eq!(recovered_mgr.records()[0].id, id1);
        assert!(recovered_mgr.recovery_backup().is_some());
        assert!(recovered_mgr.recovery_backup().unwrap().exists());
    }

    /// `checkpoints.json` as Node writes it, with every optional field a record can have. Node's schemas are strict,
    /// so a field Sotto does not know marks a record damaged on both sides, and both set the file aside first. The
    /// fixture has no `generation`: it names each write, so every save, Node's or Rust's, gives it a new one.
    fn node_checkpoints() -> Value {
        let snapshot = |hash: char| {
            json!({ "files": { "app.txt": { "hash": hash.to_string().repeat(64), "mode": 33188 }, "src/main.ts": { "hash": "b".repeat(64), "mode": 33261 } },
                "index": "index-tree", "head": "head-commit" })
        };
        let ready = json!({
            "id": "6f1c2d3e-4b5a-4c6d-8e7f-001122334455", "threadId": "thread-1", "workspaceId": "c".repeat(64), "cwd": "/home/zach/work",
            "checkout": "/home/zach/work", "providerId": "codex", "bindingId": "codex:session-1", "createdAt": "2026-11-20T10:00:00.000Z",
            "beforeUsers": ["u1"], "afterUsers": ["u1", "u2"], "before": snapshot('a'), "after": snapshot('d'), "status": "ready",
        });
        let unavailable = json!({
            "id": "7a2b3c4d-5e6f-4a7b-9c8d-112233445566", "threadId": "thread-2", "workspaceId": "c".repeat(64), "cwd": "/home/zach/work",
            "providerId": "claude", "bindingId": "claude:session-2", "createdAt": "2026-11-20T11:00:00.000Z", "beforeUsers": [],
            "before": { "files": {}, "index": "", "head": "" }, "status": "unavailable", "reason": "Another thread shares this checkout.",
            "unavailableReason": "shared-checkout",
        });
        json!({ "version": 2, "records": [ready, unavailable] })
    }

    #[test]
    fn node_checkpoints_survives_a_rust_load_and_save() {
        crate::store_trip::round_trip("checkpoints/checkpoints.json", node_checkpoints, |dir| {
            let mut store = CheckpointStore::new(dir.join("checkpoints"));
            let (records, set_aside) = store.load().unwrap();
            assert_eq!((records.len(), set_aside), (2, None));
            store.write(&records).unwrap();
        });
    }

    #[test]
    fn rust_created_checkpoints_reads_in_node() {
        let repo_dir = tempfile::tempdir().unwrap();
        init_git_repo(repo_dir.path());
        let written = crate::store_trip::created("checkpoints/checkpoints.json", |dir| {
            let mut mgr = CheckpointManager::new(dir.join("checkpoints"));
            let thread = CheckpointThreadInfo {
                thread_id: "t-1".into(),
                provider_id: "codex".into(),
                binding_id: "codex:sess-1".into(),
                user_message_ids: vec!["u1".into()],
                busy: Some(false),
                running: Some(false),
                rollback_supported: true,
                unsupported_reason: None,
            };
            mgr.before_turn(&thread, &"c".repeat(64), repo_dir.path()).unwrap().unwrap();
            fs::write(repo_dir.path().join("app.txt"), "v2\n").unwrap();
            let after = CheckpointThreadInfo { user_message_ids: vec!["u1".into(), "u2".into()], ..thread };
            mgr.after_turn(&after).unwrap().unwrap();
            // A full save, so the record is in the file rather than only in the journal.
            mgr.set_history_enabled(true).unwrap();
        });
        assert_eq!(written["version"], 2);
        let record = &written["records"][0];
        assert_eq!((record["status"].as_str(), record["afterUsers"].as_array().map(Vec::len)), (Some("ready"), Some(2)));
        assert!(record["before"]["files"]["app.txt"]["hash"].as_str().is_some_and(is_valid_sha256_hex));
    }

    #[test]
    fn capture_rejects_symlinks_in_working_copy() {
        #[cfg(unix)]
        {
            let data_dir = tempfile::tempdir().unwrap();
            let repo_dir = tempfile::tempdir().unwrap();
            init_git_repo(repo_dir.path());
            std::os::unix::fs::symlink("/etc/hosts", repo_dir.path().join("link.txt")).unwrap();
            let mut cap = CheckpointCapture::new(data_dir.path().join("blobs"));
            let err = cap.snapshot(repo_dir.path(), false).unwrap_err();
            assert_eq!(err.code, "blocked");
            assert!(err.message.contains("symbolic links"));
        }
    }

    #[test]
    fn inspect_checkpoint_blobs_handles_text_binary_missing_and_symlink_blobs() {
        let dir = tempfile::tempdir().unwrap();
        let blobs = dir.path().join("blobs");
        fs::create_dir_all(&blobs).unwrap();

        let text_a = b"alpha\n";
        let text_b = b"beta\n";
        let bin_bytes = b"abc\x00def";
        let large_text = vec![b'x'; CHECKPOINT_TEXT_PATCH_MAX_BYTES + 1];

        let h_a = blob_hash(text_a);
        let h_b = blob_hash(text_b);
        let h_bin = blob_hash(bin_bytes);
        let h_large = blob_hash(&large_text);
        fs::write(blobs.join(&h_a), text_a).unwrap();
        fs::write(blobs.join(&h_b), text_b).unwrap();
        fs::write(blobs.join(&h_bin), bin_bytes).unwrap();
        fs::write(blobs.join(&h_large), &large_text).unwrap();

        let patches = inspect_checkpoint_blobs(
            &blobs,
            &[
                CheckpointBlobPair {
                    path: "a.txt".into(),
                    before_hash: Some(h_a.clone()),
                    after_hash: Some(h_b.clone()),
                },
                CheckpointBlobPair {
                    path: "bin.dat".into(),
                    before_hash: None,
                    after_hash: Some(h_bin),
                },
                CheckpointBlobPair {
                    path: "big.txt".into(),
                    before_hash: Some(h_a.clone()),
                    after_hash: Some(h_large),
                },
            ],
        )
        .unwrap();
        assert_eq!(patches.len(), 3);
        assert_eq!(patches[0].before.as_deref(), Some("alpha\n"));
        assert_eq!(patches[0].after.as_deref(), Some("beta\n"));
        assert!(!patches[0].binary);
        assert!(patches[1].binary);
        assert!(patches[1].before.is_none() && patches[1].after.is_none());
        assert!(patches[2].binary);
        assert!(patches[2].before.is_none() && patches[2].after.is_none());

        // Missing blob returns `unavailable` (matching TS ENOENT handling).
        let missing_hash = blob_hash(b"missing");
        let missing_err = inspect_checkpoint_blobs(
            &blobs,
            &[CheckpointBlobPair {
                path: "m.txt".into(),
                before_hash: Some(missing_hash),
                after_hash: None,
            }],
        )
        .unwrap_err();
        assert_eq!(missing_err.code, "unavailable");

        // Tampered blob returns `blocked` integrity error.
        fs::write(blobs.join(&h_a), b"corrupted").unwrap();
        let tamper_err = inspect_checkpoint_blobs(
            &blobs,
            &[CheckpointBlobPair {
                path: "a.txt".into(),
                before_hash: Some(h_a),
                after_hash: None,
            }],
        )
        .unwrap_err();
        assert_eq!(tamper_err.code, "blocked");

        #[cfg(unix)]
        {
            let link_hash = blob_hash(b"dev-zero-guard");
            std::os::unix::fs::symlink("/dev/zero", blobs.join(&link_hash)).unwrap();
            let link_err = inspect_checkpoint_blobs(
                &blobs,
                &[CheckpointBlobPair {
                    path: "z.bin".into(),
                    before_hash: Some(link_hash),
                    after_hash: None,
                }],
            )
            .unwrap_err();
            assert_eq!(link_err.code, "blocked");
        }
    }
}
