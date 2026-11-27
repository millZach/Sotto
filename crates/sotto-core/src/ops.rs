use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::workspace::clip_utf16;
use crate::git_review::{
    detect_raster_image, parse_name_status_z, parse_numstat_z, section_is_binary, section_path,
    split_patch,
};
pub use crate::host_facts::{
    global_host_facts_sampler, host_facts_report, prime_host_facts_load, HostFactsSampler,
};
pub use crate::usage_ops::{
    canonical_model_id, filter_usage_read_for_peer, parse_usage_read_query, parse_usage_time_zone,
    usage_clear, usage_exclusion_hash, usage_query_activity, usage_read, usage_refresh,
    UsageReadQuery, USAGE_LIMIT_PROVIDERS, USAGE_PROVIDERS,
};

pub const MAX_TEXT_PREVIEW_BYTES: usize = 512 * 1024;
pub const MAX_IMAGE_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_GIT_PATCH_BYTES: usize = 512 * 1024;
pub const MAX_GIT_REVIEW_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_GIT_FILES: usize = 2_000;
pub const MAX_FILE_ENTRIES: usize = 1_000;
pub const MAX_HOST_FOLDERS: usize = 1_000;
pub const GIT_REFS_MAX_LIMIT: usize = 200;

/// Authoritative thread workspace identity matching `fileWorkspaceSchema` in `src/shared/files.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadWorkspace {
    pub thread_id: String,
    pub project_id: String,
    pub working_directory: String,
    pub workspace_id: String,
}

impl ThreadWorkspace {
    pub fn build(thread_id: &str, project_id: &str, working_directory: &str) -> Self {
        let canonical = fs::canonicalize(working_directory)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| working_directory.to_string());
        let workspace_id = compute_workspace_id(thread_id, project_id, &canonical);
        Self {
            thread_id: thread_id.to_string(),
            project_id: project_id.to_string(),
            working_directory: working_directory.to_string(),
            workspace_id,
        }
    }
}

pub fn compute_workspace_id(thread_id: &str, project_id: &str, working_directory: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(thread_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(project_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(working_directory.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

pub fn tools_ok(value: Value) -> Value {
    json!({ "ok": true, "value": value })
}

pub fn tools_err(code: &str, message: &str) -> Value {
    json!({ "ok": false, "error": { "code": code, "message": message } })
}

/// Validates a Git branch/ref name matching `gitBaseRefSchema` (`src/shared/gitChanges.ts`):
/// never starts with `-`, never holds whitespace, control characters, revision operators, or glob chars.
pub fn is_valid_git_base_ref(value: &str) -> bool {
    if value.is_empty() || value.len() > 240 || value.starts_with('-') {
        return false;
    }
    if value.contains("..") || value.contains("@{") {
        return false;
    }
    !value.chars().any(|c| {
        c.is_whitespace()
            || matches!(
                c,
                '\x00'..='\x1f' | '\x7f' | '~' | '^' | ':' | '?' | '*' | '[' | '\\'
            )
    })
}

/// Validates a canonical slash-separated relative path matching `fileRelativePathSchema`.
pub fn is_valid_relative_path(path: &str) -> bool {
    if path.is_empty() {
        return true;
    }
    if path.encode_utf16().count() > 4_096 {
        return false;
    }
    if path.chars().any(|c| {
        matches!(
            c,
            '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*' | '\x00'..='\x1f' | '\x7f'
        )
    }) {
        return false;
    }
    for part in path.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with('.')
            || part.ends_with(' ')
        {
            return false;
        }
        let stem = part.split('.').next().unwrap_or("").to_ascii_lowercase();
        if matches!(
            stem.as_str(),
            "con"
                | "conin$"
                | "conout$"
                | "prn"
                | "aux"
                | "nul"
                | "com1"
                | "com2"
                | "com3"
                | "com4"
                | "com5"
                | "com6"
                | "com7"
                | "com8"
                | "com9"
                | "lpt1"
                | "lpt2"
                | "lpt3"
                | "lpt4"
                | "lpt5"
                | "lpt6"
                | "lpt7"
                | "lpt8"
                | "lpt9"
                | "com¹"
                | "com²"
                | "com³"
                | "lpt¹"
                | "lpt²"
                | "lpt³"
        ) {
            return false;
        }
    }
    true
}

const REFS_FRESH_MS: u64 = 120_000;

#[derive(Clone)]
struct CachedLocalRef {
    name: String,
    date: i64,
    worktree_path: Option<String>,
}

#[derive(Clone)]
struct CachedRemoteRef {
    name: String,
    remote: String,
    date: i64,
}

#[derive(Clone)]
struct RefsSnapshot {
    at: Instant,
    locals: Vec<CachedLocalRef>,
    remotes: Vec<CachedRemoteRef>,
    default_branch: Option<String>,
    has_remote: bool,
}

fn refs_cache() -> &'static Mutex<HashMap<String, RefsSnapshot>> {
    static CACHE: OnceLock<Mutex<HashMap<String, RefsSnapshot>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn same_path_str(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let pa = fs::canonicalize(a).unwrap_or_else(|_| PathBuf::from(a));
    let pb = fs::canonicalize(b).unwrap_or_else(|_| PathBuf::from(b));
    if cfg!(windows) {
        pa.to_string_lossy().eq_ignore_ascii_case(&pb.to_string_lossy())
    } else {
        pa == pb
    }
}

fn load_refs_snapshot(folder: &str, common: &str, refresh: bool) -> RefsSnapshot {
    if !refresh {
        if let Ok(guard) = refs_cache().lock() {
            if let Some(cached) = guard.get(common) {
                if cached.at.elapsed() < Duration::from_millis(REFS_FRESH_MS) {
                    return cached.clone();
                }
            }
        }
    }

    let listing = run_git(
        folder,
        &[
            "for-each-ref",
            "--format=%(refname)%09%(committerdate:unix)%09%(symref)",
            "refs/heads",
            "refs/remotes",
        ],
    )
    .unwrap_or_default();
    let remotes_list: Vec<String> = run_git(folder, &["remote"])
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(ToString::to_string)
        .collect();
    let origin_head = run_git(
        folder,
        &["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"],
    )
    .ok()
    .map(|s| s.trim().to_string())
    .unwrap_or_default();
    let mut default_branch = origin_head
        .strip_prefix("origin/")
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);

    let mut worktrees: HashMap<String, String> = HashMap::new();
    let wt_raw = run_git(folder, &["worktree", "list", "--porcelain", "-z"]).unwrap_or_default();
    for record in wt_raw.split("\0\0") {
        let fields: Vec<&str> = record.split('\0').collect();
        let prunable = fields
            .iter()
            .any(|f| *f == "prunable" || f.starts_with("prunable "));
        if prunable {
            continue;
        }
        let path = fields
            .iter()
            .find_map(|f| f.strip_prefix("worktree "))
            .map(ToString::to_string);
        let branch = fields
            .iter()
            .find_map(|f| f.strip_prefix("branch refs/heads/"))
            .map(ToString::to_string);
        if let (Some(p), Some(b)) = (path, branch) {
            worktrees.insert(b, p);
        }
    }

    let mut locals = Vec::new();
    let mut remotes = Vec::new();
    for line in listing.lines() {
        let mut parts = line.split('\t');
        let Some(refname) = parts.next().filter(|s| !s.is_empty()) else {
            continue;
        };
        let date = parts
            .next()
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        let symref = parts.next().unwrap_or("");
        if !symref.is_empty() {
            continue;
        }
        if let Some(name) = refname.strip_prefix("refs/heads/") {
            locals.push(CachedLocalRef {
                name: name.to_string(),
                date,
                worktree_path: worktrees.get(name).cloned(),
            });
        } else if let Some(full) = refname.strip_prefix("refs/remotes/") {
            let mut matching: Vec<&str> = remotes_list
                .iter()
                .map(String::as_str)
                .filter(|cand| full.starts_with(&format!("{cand}/")))
                .collect();
            matching.sort_by_key(|cand| std::cmp::Reverse(cand.len()));
            if let Some(&remote) = matching.first() {
                remotes.push(CachedRemoteRef {
                    name: full.to_string(),
                    remote: remote.to_string(),
                    date,
                });
            }
        }
    }

    if default_branch.is_none() {
        default_branch = ["main", "master"]
            .into_iter()
            .find(|&cand| locals.iter().any(|l| l.name == cand))
            .map(ToString::to_string);
    }

    locals.sort_by(|a, b| {
        b.date
            .cmp(&a.date)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    remotes.sort_by(|a, b| {
        b.date
            .cmp(&a.date)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });

    let snapshot = RefsSnapshot {
        at: Instant::now(),
        locals,
        remotes,
        default_branch,
        has_remote: remotes_list.iter().any(|r| r == "origin"),
    };
    if let Ok(mut guard) = refs_cache().lock() {
        guard.insert(common.to_string(), snapshot.clone());
    }
    snapshot
}

/// Lists branches for a thread's working copy matching `gitRefsPageSchema` (`src/shared/gitRefs.ts`)
/// and `GitStatusService.listRefs` (`src/main/agents/git/gitStatus.ts`).
pub fn git_refs(
    folder: &str,
    query: Option<&str>,
    cursor: Option<usize>,
    limit: Option<usize>,
    include_matching_remote: bool,
) -> Result<Value, String> {
    git_refs_with_refresh(folder, query, cursor, limit, include_matching_remote, false)
}

pub fn git_refs_with_refresh(
    folder: &str,
    query: Option<&str>,
    cursor: Option<usize>,
    limit: Option<usize>,
    include_matching_remote: bool,
    refresh: bool,
) -> Result<Value, String> {
    let common = match run_git_clean(
        folder,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        &[],
        None,
        None,
    ) {
        Ok(out) if !out.stdout.trim().is_empty() => out.stdout.trim().to_string(),
        Err(GitRunError::Unavailable(msg)) => return Err(msg),
        _ => {
            return Ok(json!({
                "refs": [],
                "isRepository": false,
                "hasRemote": false,
                "nextCursor": null,
                "total": 0,
            }));
        }
    };

    let snapshot = load_refs_snapshot(folder, &common, refresh);
    let current = run_git(folder, &["branch", "--show-current"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let here = run_git(folder, &["rev-parse", "--show-toplevel"])
        .ok()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let local_names: HashSet<&str> = snapshot.locals.iter().map(|l| l.name.as_str()).collect();
    let needle = query
        .map(|q| q.trim().to_ascii_lowercase())
        .unwrap_or_default();

    let mut all_refs: Vec<(u8, u8, usize, Value)> = Vec::new();
    let mut seq = 0usize;
    for local in &snapshot.locals {
        if !needle.is_empty() && !local.name.to_ascii_lowercase().contains(&needle) {
            continue;
        }
        let is_current = current.as_deref() == Some(local.name.as_str());
        let is_default = snapshot.default_branch.as_deref() == Some(local.name.as_str());
        let wt_path = local
            .worktree_path
            .as_deref()
            .filter(|p| here.is_empty() || !same_path_str(p, &here));
        let rank = if is_current {
            0
        } else if is_default {
            1
        } else {
            2
        };
        all_refs.push((
            rank,
            0,
            seq,
            json!({
                "name": local.name,
                "current": is_current,
                "isDefault": is_default,
                "worktreePath": wt_path,
            }),
        ));
        seq += 1;
    }

    for remote in &snapshot.remotes {
        let short = remote
            .name
            .get(remote.remote.len() + 1..)
            .unwrap_or("");
        if !include_matching_remote && remote.remote == "origin" && local_names.contains(short) {
            continue;
        }
        if !needle.is_empty() && !remote.name.to_ascii_lowercase().contains(&needle) {
            continue;
        }
        let is_default =
            remote.remote == "origin" && snapshot.default_branch.as_deref() == Some(short);
        let rank = if is_default { 1 } else { 2 };
        all_refs.push((
            rank,
            1,
            seq,
            json!({
                "name": remote.name,
                "remote": remote.remote,
                "current": false,
                "isDefault": is_default,
                "worktreePath": null,
            }),
        ));
        seq += 1;
    }

    all_refs.sort_by_key(|(rank, is_remote, order, _)| (*rank, *is_remote, *order));

    let total = all_refs.len();
    let start = cursor.unwrap_or(0).min(total);
    let page_limit = limit.unwrap_or(100).clamp(1, GIT_REFS_MAX_LIMIT);
    let end = (start + page_limit).min(total);
    let next_cursor = if end < total { Some(end) } else { None };
    let page: Vec<Value> = all_refs
        .into_iter()
        .skip(start)
        .take(page_limit)
        .map(|(_, _, _, v)| v)
        .collect();

    Ok(json!({
        "refs": page,
        "isRepository": true,
        "hasRemote": snapshot.has_remote,
        "nextCursor": next_cursor,
        "total": total,
    }))
}

const UNTRACKED_COUNT_MAX_FILES: usize = 200;
const UNTRACKED_COUNT_MAX_BYTES: u64 = 1_000_000;
const DEFAULT_GIT_CHANGED_FILES_BUDGET: Duration = Duration::from_secs(10);

/// Repo-redirecting Git variables stripped by `GitStatusReader` (`src/main/agents/git/gitStatus.ts`).
/// Keeps `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_COUNT`/`KEY_*`/`VALUE_*`, and
/// transport settings so user excludes and `safe.directory` match TypeScript.
const REDIRECTING_GIT_VARIABLES: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_PREFIX",
    "GIT_EXTERNAL_DIFF",
    "GIT_EDITOR",
    "GIT_SEQUENCE_EDITOR",
    "GIT_PAGER",
];

fn count_untracked_lines(path: &Path) -> Option<(u64, u64)> {
    // Reject symlinks, FIFOs, devices, sockets, and directories BEFORE opening so an untracked
    // symlink to `/dev/zero` or a named pipe can never OOM or block.
    let sym_meta = fs::symlink_metadata(path).ok()?;
    if !sym_meta.file_type().is_file() || sym_meta.len() > UNTRACKED_COUNT_MAX_BYTES {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > UNTRACKED_COUNT_MAX_BYTES {
        return None;
    }
    let size = meta.len();
    let mut buf = Vec::with_capacity(size as usize);
    // Strictly bound read to `UNTRACKED_COUNT_MAX_BYTES + 1` even if the file grows mid-read.
    file.take(UNTRACKED_COUNT_MAX_BYTES.saturating_add(1))
        .read_to_end(&mut buf)
        .ok()?;
    if buf.len() as u64 > UNTRACKED_COUNT_MAX_BYTES {
        return None;
    }
    let check_len = buf.len().min(8_000);
    if buf[..check_len].contains(&0) {
        return None;
    }
    if buf.is_empty() {
        return Some((0, 0));
    }
    let mut lines = buf.iter().filter(|&&b| b == b'\n').count() as u64;
    if buf.last() != Some(&b'\n') {
        lines += 1;
    }
    Some((lines, 0))
}

struct ChangedFileRecord {
    path: String,
    original_path: Option<String>,
    status: &'static str,
}

fn parse_porcelain_v2_changed(output: &str) -> (bool, Vec<ChangedFileRecord>) {
    let records: Vec<&str> = output.split('\0').collect();
    let mut unborn = false;
    let mut result = Vec::new();
    let status_of = |xy: &str| -> &'static str {
        if xy.contains('D') {
            "deleted"
        } else if xy.contains('A') {
            "added"
        } else if xy.contains('T') {
            "type-changed"
        } else {
            "modified"
        }
    };
    let mut index = 0usize;
    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        if let Some(header) = record.strip_prefix("# ") {
            if header == "branch.oid (initial)" {
                unborn = true;
            }
            continue;
        }
        let mut bytes = record.bytes();
        let Some(kind) = bytes.next() else {
            continue;
        };
        if kind == b'?' {
            if record.len() > 2 {
                result.push(ChangedFileRecord {
                    path: record[2..].to_string(),
                    original_path: None,
                    status: "untracked",
                });
            }
            continue;
        }
        if kind == b'!' {
            continue;
        }
        let fields: Vec<&str> = record.split(' ').collect();
        if kind == b'1' && fields.len() >= 9 {
            result.push(ChangedFileRecord {
                path: fields[8..].join(" "),
                original_path: None,
                status: status_of(fields[1]),
            });
        } else if kind == b'u' && fields.len() >= 11 {
            result.push(ChangedFileRecord {
                path: fields[10..].join(" "),
                original_path: None,
                status: "conflicted",
            });
        } else if kind == b'2' && fields.len() >= 10 {
            let path = fields[9..].join(" ");
            let original_path = records
                .get(index)
                .copied()
                .filter(|s| !s.is_empty())
                .map(ToString::to_string);
            index += 1;
            let status = if fields[1].contains('C') {
                "added"
            } else {
                "renamed"
            };
            result.push(ChangedFileRecord {
                path,
                original_path,
                status,
            });
        }
    }
    (unborn, result)
}

fn parse_numstat_z_outputs(outputs: &[String]) -> HashMap<String, Option<(u64, u64)>> {
    let mut counts: HashMap<String, Option<(u64, u64)>> = HashMap::new();
    for output in outputs {
        let records: Vec<&str> = output.split('\0').collect();
        let mut index = 0usize;
        while index < records.len() {
            let record = records[index];
            index += 1;
            if record.is_empty() {
                continue;
            }
            let mut parts = record.splitn(3, '\t');
            let added = parts.next().unwrap_or("");
            let removed = parts.next().unwrap_or("");
            let inline = parts.next().unwrap_or("");
            let path = if inline.is_empty() {
                // Rename: old path record, then new path record.
                index += 1;
                let next_path = records.get(index).copied().unwrap_or("");
                index += 1;
                next_path
            } else {
                inline
            };
            if path.is_empty() {
                continue;
            }
            let value = if added == "-" || removed == "-" {
                None
            } else {
                Some((
                    added.parse::<u64>().unwrap_or(0),
                    removed.parse::<u64>().unwrap_or(0),
                ))
            };
            let entry = counts.entry(path.to_string());
            match entry {
                std::collections::hash_map::Entry::Occupied(mut occ) => {
                    let prev = *occ.get();
                    let next = match (prev, value) {
                        (Some((pi, pd)), Some((vi, vd))) => Some((pi + vi, pd + vd)),
                        (None, _) => None,
                        (Some(_), None) => None,
                    };
                    occ.insert(next);
                }
                std::collections::hash_map::Entry::Vacant(vac) => {
                    vac.insert(value);
                }
            }
        }
    }
    counts
}

/// Lists changed files in a git working tree matching `gitChangedFilesSchema` (`src/shared/gitChangedFiles.ts`)
/// and `GitStatusReader.listChangedFiles` (`src/main/agents/git/gitStatus.ts`).
pub fn git_changed_files(folder: &str) -> Result<Value, String> {
    git_changed_files_with_budget(folder, DEFAULT_GIT_CHANGED_FILES_BUDGET)
}

/// Bounded variant of [`git_changed_files`] enforcing a single total wall-clock `budget` across
/// all serial Git subprocesses and untracked-file reads so timed-out callers never leave orphan
/// Git work holding accelerator permits.
pub fn git_changed_files_with_budget(folder: &str, budget: Duration) -> Result<Value, String> {
    let deadline = Instant::now() + budget;
    let is_repo = match run_git_status_cmd_with_deadline(
        folder,
        &["rev-parse", "--is-inside-work-tree"],
        deadline,
    ) {
        Ok(out) => out.stdout.trim() == "true",
        Err(GitRunError::Unavailable(msg)) => return Err(msg),
        Err(GitRunError::Failed(msg))
            if msg.to_ascii_lowercase().contains("not a git repository") =>
        {
            false
        }
        Err(GitRunError::Failed(msg)) => return Err(msg),
        Err(GitRunError::MaxBuffer(_)) => return Err("git output exceeded buffer limit".into()),
    };
    if !is_repo {
        return Ok(json!({
            "isRepository": false,
            "files": [],
            "truncated": false,
        }));
    }
    let toplevel = run_git_status_with_deadline(folder, &["rev-parse", "--show-toplevel"], deadline)?;
    let cwd = toplevel.trim();
    let porcelain = run_git_status_with_deadline(
        cwd,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
            "-z",
        ],
        deadline,
    )?;
    let (unborn, records) = parse_porcelain_v2_changed(&porcelain);
    if Instant::now() >= deadline {
        return Err("git timed out".into());
    }
    let numstat_outputs = if unborn {
        let a = run_git_status_with_deadline(cwd, &["diff", "--numstat", "-z"], deadline)
            .unwrap_or_default();
        if Instant::now() >= deadline {
            return Err("git timed out".into());
        }
        let b = run_git_status_with_deadline(cwd, &["diff", "--cached", "--numstat", "-z"], deadline)
            .unwrap_or_default();
        vec![a, b]
    } else {
        vec![run_git_status_with_deadline(cwd, &["diff", "--numstat", "-z", "HEAD", "--"], deadline)
            .unwrap_or_default()]
    };
    if Instant::now() >= deadline {
        return Err("git timed out".into());
    }
    let counts = parse_numstat_z_outputs(&numstat_outputs);
    let truncated = records.len() > MAX_GIT_FILES;
    let cwd_path = Path::new(cwd);
    let mut untracked_read = 0usize;
    let mut entries: Vec<(String, Value)> = Vec::with_capacity(records.len().min(MAX_GIT_FILES));

    for record in records.into_iter().take(MAX_GIT_FILES) {
        let mut count = counts
            .get(&record.path)
            .copied()
            .or_else(|| {
                record
                    .original_path
                    .as_ref()
                    .and_then(|orig| counts.get(orig).copied())
            })
            .flatten();
        if record.status == "untracked" && count.is_none() && untracked_read < UNTRACKED_COUNT_MAX_FILES {
            if Instant::now() >= deadline {
                return Err("git timed out".into());
            }
            untracked_read += 1;
            count = count_untracked_lines(&cwd_path.join(&record.path));
        }
        let (ins, del) = match count {
            Some((i, d)) => (Some(i), Some(d)),
            None => (None, None),
        };
        let mut entry = json!({
            "path": record.path,
            "status": record.status,
            "insertions": ins,
            "deletions": del,
        });
        if let Some(orig) = record.original_path {
            entry["originalPath"] = json!(orig);
        }
        entries.push((record.path, entry));
    }
    // Sort by UTF-16 code units to match JS `left.path < right.path` string ordering.
    entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let files: Vec<Value> = entries.into_iter().map(|(_, v)| v).collect();

    Ok(json!({
        "isRepository": true,
        "files": files,
        "truncated": truncated,
    }))
}

fn porcelain_status(code: &str) -> &'static str {
    let trimmed = code.trim();
    if code.contains('U') || trimmed == "AA" || trimmed == "DD" {
        "conflicted"
    } else if trimmed == "??" {
        "untracked"
    } else if code.contains('R') {
        "renamed"
    } else if code.contains('D') {
        "deleted"
    } else if code.contains('A') {
        "added"
    } else if code.contains('T') {
        "type-changed"
    } else {
        "modified"
    }
}

const TOO_LARGE_FILE_DIFF_MSG: &str =
    "This file is past the 512 KiB diff preview limit. Copy its path or open it.";
const TOO_LARGE_REVIEW_DIFF_MSG: &str =
    "This comparison is past the 2 MiB preview limit, so this file is not shown. Copy its path or open it.";
const BINARY_DIFF_MSG: &str = "Binary file: no text diff.";

struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct SafeGitPathInfo {
    stamp: String,
    size: u64,
    regular: bool,
}

fn safe_git_path(root_canon: &Path, rel_path: &str) -> Result<SafeGitPathInfo, ()> {
    let target = root_canon.join(rel_path);
    if !target.starts_with(root_canon) {
        return Err(());
    }
    let mut candidate = target.clone();
    loop {
        match fs::symlink_metadata(&candidate) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(());
                }
                let canon = fs::canonicalize(&candidate).map_err(|_| ())?;
                if !canon.starts_with(root_canon) {
                    return Err(());
                }
                let mtime_ms = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs_f64() * 1000.0)
                    .unwrap_or(0.0);
                #[cfg(unix)]
                let ctime_ms = {
                    use std::os::unix::fs::MetadataExt;
                    (meta.ctime() as f64) * 1000.0 + (meta.ctime_nsec() as f64) / 1_000_000.0
                };
                #[cfg(not(unix))]
                let ctime_ms = meta
                    .created()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs_f64() * 1000.0)
                    .unwrap_or(mtime_ms);
                let size = meta.len();
                let is_exact = candidate == target;
                return Ok(SafeGitPathInfo {
                    stamp: format!("{size}:{mtime_ms}:{ctime_ms}"),
                    size: if is_exact { size } else { 0 },
                    regular: is_exact && meta.is_file(),
                });
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                if candidate == root_canon {
                    return Err(());
                }
                let Some(parent) = candidate.parent() else {
                    return Err(());
                };
                candidate = parent.to_path_buf();
            }
            Err(_) => return Err(()),
        }
    }
}

fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

struct GitChangeEntry {
    path: String,
    original_path: Option<String>,
    status: &'static str,
}

struct GitListingInternal {
    branch: Option<String>,
    revision: String,
    files: Vec<GitChangeEntry>,
    truncated: bool,
}

fn collect_git_listing(workspace: &ThreadWorkspace) -> Result<GitListingInternal, Value> {
    let folder = &workspace.working_directory;
    let Ok(canon_root) = fs::canonicalize(folder) else {
        return Err(tools_err(
            "workspace-unavailable",
            "The thread working directory is unavailable.",
        ));
    };
    let prefix = match run_git_clean(folder, &["rev-parse", "--show-prefix"], &[], None, None) {
        Ok(out) => out.stdout.trim_end().to_string(),
        Err(GitRunError::MaxBuffer(_)) => {
            return Err(tools_err(
                "too-large",
                "The Git change list exceeds the safe preview limit. Open the working directory externally.",
            ));
        }
        Err(_) => {
            return Err(tools_err(
                "not-repository",
                "Git is unavailable or this thread working directory is not a Git repository.",
            ));
        }
    };
    let raw = match run_git_clean(
        folder,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
        &[],
        None,
        Some(MAX_GIT_REVIEW_BYTES),
    ) {
        Ok(out) => out.stdout,
        Err(GitRunError::MaxBuffer(_)) => {
            return Err(tools_err(
                "too-large",
                "The Git change list exceeds the safe preview limit. Open the working directory externally.",
            ));
        }
        Err(_) => {
            return Err(tools_err(
                "not-repository",
                "Git is unavailable or this thread working directory is not a Git repository.",
            ));
        }
    };
    let head = run_git_clean(folder, &["rev-parse", "--verify", "HEAD"], &[], None, None)
        .ok()
        .map(|o| o.stdout.trim().to_string())
        .unwrap_or_default();
    let branch = run_git_clean(
        folder,
        &["symbolic-ref", "--short", "-q", "HEAD"],
        &[],
        None,
        None,
    )
    .ok()
    .map(|o| o.stdout.trim().to_string())
    .filter(|s| !s.is_empty());

    let records: Vec<&str> = raw.split('\0').collect();
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut files: Vec<GitChangeEntry> = Vec::new();
    let mut stamps: Vec<String> = Vec::new();
    let mut truncated = false;

    let mut index = 0usize;
    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.len() < 4 {
            continue;
        }
        let xy = &record[..2];
        let repo_path = &record[3..];
        let original = if xy.contains('R') || xy.contains('C') {
            let orig = records.get(index).copied();
            index += 1;
            orig
        } else {
            None
        };
        let Some(rel_after_prefix) = repo_path.strip_prefix(&prefix) else {
            continue;
        };
        let path = rel_after_prefix.to_string();
        if path.is_empty() || !is_valid_relative_path(&path) {
            truncated = true;
            continue;
        }
        if !seen.contains_key(&path) && files.len() >= MAX_GIT_FILES {
            truncated = true;
            break;
        }
        let status = porcelain_status(xy);
        let original_path = original
            .and_then(|o| o.strip_prefix(&prefix))
            .map(ToString::to_string)
            .filter(|o| !o.is_empty() && is_valid_relative_path(o));

        let stamp = match safe_git_path(&canon_root, &path) {
            Ok(info) => format!("{path}:{}", info.stamp),
            Err(()) => format!("{path}:unavailable"),
        };
        stamps.push(stamp);

        let entry = GitChangeEntry {
            path: path.clone(),
            original_path,
            status,
        };
        if let Some(&pos) = seen.get(&path) {
            files[pos] = entry;
        } else {
            seen.insert(path, files.len());
            files.push(entry);
        }
    }

    let index_state = run_git_clean(folder, &["ls-files", "--stage", "-z"], &[], None, None)
        .map(|o| o.stdout)
        .unwrap_or_default();
    let branch_str = branch.as_deref().unwrap_or("null");
    let revision = sha256_hex(&format!(
        "{branch_str}\0{head}\0{raw}\0{index_state}\0{}",
        stamps.join("\0")
    ));

    Ok(GitListingInternal {
        branch,
        revision,
        files,
        truncated,
    })
}

fn automatic_branch_base(cwd: &str, branch: &str) -> Option<String> {
    let ref_exists = |r: &str| -> bool {
        run_git_clean(cwd, &["show-ref", "--verify", "--quiet", r], &[], None, None).is_ok()
    };
    let merge_base_key = format!("branch.{branch}.gh-merge-base");
    let configured = run_git_clean(cwd, &["config", "--get", &merge_base_key], &[], None, None)
        .ok()
        .map(|o| o.stdout.trim().to_string())
        .filter(|s| !s.is_empty());
    let remotes: Vec<String> = run_git_clean(cwd, &["remote"], &[], None, None)
        .ok()
        .map(|o| {
            o.stdout
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();
    let primary: Option<&str> = if remotes.iter().any(|r| r == "origin") {
        Some("origin")
    } else {
        remotes.first().map(String::as_str)
    };
    let head = primary
        .and_then(|p| {
            let sym = format!("refs/remotes/{p}/HEAD");
            run_git_clean(cwd, &["symbolic-ref", "--short", "-q", &sym], &[], None, None)
                .ok()
                .map(|o| o.stdout.trim().to_string())
        })
        .unwrap_or_default();
    let default_branch = primary
        .and_then(|p| head.strip_prefix(&format!("{p}/")))
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);

    let candidates = [
        configured,
        default_branch,
        Some("main".to_string()),
        Some("master".to_string()),
    ];
    for cand in candidates.into_iter().flatten() {
        let name = if let Some(s) = cand.strip_prefix("origin/") {
            s
        } else if let Some(p) = primary {
            cand.strip_prefix(&format!("{p}/")).unwrap_or(&cand)
        } else {
            &cand
        };
        if name.is_empty() || name == branch || name.starts_with('-') {
            continue;
        }
        if let Some(p) = primary {
            let remote_ref = format!("refs/remotes/{p}/{name}");
            if ref_exists(&remote_ref) {
                return Some(format!("{p}/{name}"));
            }
        }
        let local_ref = format!("refs/heads/{name}");
        if ref_exists(&local_ref) {
            return Some(name.to_string());
        }
    }
    None
}

/// Returns git working-tree changes wrapped in `ToolsResult<GitChangeListing>` (`src/shared/gitChanges.ts`).
pub fn thread_changes(workspace: &ThreadWorkspace) -> Value {
    let listing = match collect_git_listing(workspace) {
        Ok(l) => l,
        Err(err_val) => return err_val,
    };
    let files: Vec<Value> = listing
        .files
        .into_iter()
        .map(|f| {
            let mut obj = json!({
                "path": f.path,
                "status": f.status,
            });
            if let Some(orig) = f.original_path {
                obj["originalPath"] = json!(orig);
            }
            obj
        })
        .collect();
    tools_ok(json!({
        "workspace": workspace,
        "branch": listing.branch,
        "revision": listing.revision,
        "files": files,
        "truncated": listing.truncated,
    }))
}

/// Returns a bounded Git comparison wrapped in `ToolsResult<GitReview>` (`src/shared/gitChanges.ts`),
/// matching `GitChangesService.readReview` (`src/main/tools/gitChanges.ts`).
pub fn thread_changes_review(
    workspace: &ThreadWorkspace,
    scope: &Value,
    ignore_whitespace: bool,
) -> Value {
    thread_changes_review_inner(workspace, scope, ignore_whitespace, true)
}

fn thread_changes_review_inner(
    workspace: &ThreadWorkspace,
    scope: &Value,
    ignore_whitespace: bool,
    retry: bool,
) -> Value {
    let scope_kind = scope
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("working");
    let requested_base = if scope_kind == "branch" {
        match scope.get("base") {
            Some(Value::String(s)) => {
                if !is_valid_git_base_ref(s) {
                    return tools_err("invalid-request", "Use a valid branch name.");
                }
                Some(s.clone())
            }
            Some(Value::Null) | None => None,
            Some(_) => return tools_err("invalid-request", "Use a valid branch name."),
        }
    } else if scope_kind == "working" {
        None
    } else {
        return tools_err("invalid-request", "Invalid comparison scope.");
    };

    let listing = match collect_git_listing(workspace) {
        Ok(l) => l,
        Err(err_val) => return err_val,
    };
    let folder = &workspace.working_directory;
    let Ok(canon_root) = fs::canonicalize(folder) else {
        return tools_err(
            "workspace-unavailable",
            "The thread working directory is unavailable.",
        );
    };
    let has_head = run_git_clean(folder, &["rev-parse", "--verify", "-q", "HEAD"], &[], None, None)
        .is_ok();

    let mut extra_files: Vec<Value> = Vec::new();
    let mut _temp_guard: Option<TempDirGuard> = None;
    let mut extra_env: Vec<(String, String)> = Vec::new();

    let (resolved_scope, range) = if scope_kind == "working" {
        let range = if has_head {
            "HEAD".to_string()
        } else {
            match run_git_clean(
                folder,
                &["hash-object", "-t", "tree", "--stdin"],
                &[],
                Some(b""),
                None,
            ) {
                Ok(out) => out.stdout.trim().to_string(),
                Err(_) => {
                    return tools_err("unavailable", "Could not read Git comparison.");
                }
            }
        };

        let mut untracked_to_add: Vec<String> = Vec::new();
        for f in listing.files.iter().filter(|f| f.status == "untracked") {
            match safe_git_path(&canon_root, &f.path) {
                Ok(info) if info.regular => {
                    if info.size > MAX_GIT_PATCH_BYTES as u64 {
                        extra_files.push(json!({
                            "path": f.path,
                            "status": "untracked",
                            "additions": null,
                            "deletions": null,
                            "content": { "kind": "too-large", "message": TOO_LARGE_FILE_DIFF_MSG },
                        }));
                    } else {
                        untracked_to_add.push(f.path.clone());
                    }
                }
                _ => {
                    extra_files.push(json!({
                        "path": f.path,
                        "status": "untracked",
                        "additions": null,
                        "deletions": null,
                        "content": { "kind": "unavailable", "message": "This path is not an available regular file." },
                    }));
                }
            }
        }

        if !untracked_to_add.is_empty() {
            let temp_dir = std::env::temp_dir()
                .join(format!("sotto-changes-{}", uuid::Uuid::new_v4()));
            if fs::create_dir_all(&temp_dir).is_err() {
                return tools_err("unavailable", "Could not prepare temporary Git index.");
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&temp_dir, fs::Permissions::from_mode(0o700));
            }
            let temp_index = temp_dir.join("index");
            _temp_guard = Some(TempDirGuard(temp_dir));
            let temp_index_str = temp_index.to_string_lossy().into_owned();
            extra_env.push(("GIT_INDEX_FILE".into(), temp_index_str));

            let real_index_rel = run_git_clean(
                folder,
                &["rev-parse", "--git-path", "index"],
                &[],
                None,
                None,
            )
            .map(|o| o.stdout.trim().to_string())
            .unwrap_or_default();
            let real_index = Path::new(folder).join(&real_index_rel);
            if real_index.exists() {
                if fs::copy(&real_index, &temp_index).is_err() {
                    return tools_err("unavailable", "Could not copy Git index.");
                }
            } else if run_git_clean(folder, &["read-tree", "--empty"], &extra_env, None, None)
                .is_err()
            {
                return tools_err("unavailable", "Could not initialize temporary Git index.");
            }
            let _ = run_git_clean(
                folder,
                &["-c", "core.splitIndex=false", "update-index", "--no-split-index"],
                &extra_env,
                None,
                None,
            );
            let mut pathspec = Vec::new();
            for p in &untracked_to_add {
                pathspec.extend_from_slice(p.as_bytes());
                pathspec.push(0);
            }
            if run_git_clean(
                folder,
                &[
                    "-c",
                    "core.splitIndex=false",
                    "add",
                    "--intent-to-add",
                    "--pathspec-from-file=-",
                    "--pathspec-file-nul",
                ],
                &extra_env,
                Some(&pathspec),
                None,
            )
            .is_err()
            {
                return tools_err("unavailable", "Could not read untracked files for diff.");
            }
        }

        (json!({ "kind": "working" }), range)
    } else {
        if !has_head {
            return tools_err(
                "blocked",
                "This branch has no commits yet, so there are no branch changes to compare.",
            );
        }
        let Some(ref branch) = listing.branch else {
            return tools_err(
                "blocked",
                "Branch changes compare a branch with its base. This working copy is on a detached HEAD.",
            );
        };
        let automatic = requested_base.is_none();
        let base = requested_base.or_else(|| automatic_branch_base(folder, branch));
        let Some(base) = base else {
            return tools_ok(json!({
                "workspace": workspace,
                "revision": listing.revision,
                "scope": {
                    "kind": "branch",
                    "base": null,
                    "automatic": automatic,
                    "head": branch,
                },
                "files": [],
                "truncated": false,
            }));
        };
        let commit_spec = format!("{base}^{{commit}}");
        let known = run_git_clean(
            folder,
            &["rev-parse", "--verify", "-q", "--end-of-options", &commit_spec],
            &[],
            None,
            None,
        )
        .is_ok();
        if !known {
            return tools_err(
                "path-unavailable",
                &format!("{base} is not a branch in this repository. Choose another base."),
            );
        }
        (
            json!({
                "kind": "branch",
                "base": base,
                "automatic": automatic,
                "head": branch,
            }),
            format!("{base}...HEAD"),
        )
    };

    let mut diff_base: Vec<&str> = vec![
        "-c",
        "core.bigFileThreshold=512k",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--relative",
        "--src-prefix=a/",
        "--dst-prefix=b/",
    ];
    if ignore_whitespace {
        diff_base.push("--ignore-all-space");
    }

    let mut name_status_args = diff_base.clone();
    name_status_args.extend(["--name-status", "-z", range.as_str(), "--"]);
    let name_status_raw = match run_git_clean(
        folder,
        &name_status_args,
        &extra_env,
        None,
        Some(MAX_GIT_REVIEW_BYTES),
    ) {
        Ok(o) => o.stdout,
        Err(GitRunError::MaxBuffer(_)) => {
            return tools_err(
                "too-large",
                "This comparison is too large to list. Review it with Git directly.",
            );
        }
        Err(_) => return tools_err("unavailable", "Could not read Git comparison."),
    };
    let name_status = parse_name_status_z(&name_status_raw);

    let mut numstat_args = diff_base.clone();
    numstat_args.extend(["--numstat", "-z", range.as_str(), "--"]);
    let numstat_raw = match run_git_clean(
        folder,
        &numstat_args,
        &extra_env,
        None,
        Some(MAX_GIT_REVIEW_BYTES),
    ) {
        Ok(o) => o.stdout,
        Err(GitRunError::MaxBuffer(_)) => {
            return tools_err(
                "too-large",
                "This comparison is too large to list. Review it with Git directly.",
            );
        }
        Err(_) => return tools_err("unavailable", "Could not read Git comparison."),
    };
    let numstat_entries = parse_numstat_z(&numstat_raw);
    let numstat_map: HashMap<String, (Option<u64>, Option<u64>)> = numstat_entries
        .iter()
        .map(|e| (e.path.clone(), (e.additions, e.deletions)))
        .collect();

    let hidden_whitespace = if ignore_whitespace {
        let mut all_args: Vec<&str> = diff_base
            .iter()
            .copied()
            .filter(|&f| f != "--ignore-all-space")
            .collect();
        all_args.extend(["--numstat", "-z", range.as_str(), "--"]);
        let all_raw = run_git_clean(
            folder,
            &all_args,
            &extra_env,
            None,
            Some(MAX_GIT_REVIEW_BYTES),
        )
        .map(|o| o.stdout)
        .unwrap_or_default();
        let all_entries = parse_numstat_z(&all_raw);
        let (mut all_add, mut all_del) = (0u64, 0u64);
        for e in &all_entries {
            all_add = all_add.saturating_add(e.additions.unwrap_or(0));
            all_del = all_del.saturating_add(e.deletions.unwrap_or(0));
        }
        let (mut shown_add, mut shown_del) = (0u64, 0u64);
        for e in &numstat_entries {
            shown_add = shown_add.saturating_add(e.additions.unwrap_or(0));
            shown_del = shown_del.saturating_add(e.deletions.unwrap_or(0));
        }
        Some(json!({
            "additions": all_add.saturating_sub(shown_add),
            "deletions": all_del.saturating_sub(shown_del),
        }))
    } else {
        None
    };

    let mut patch_args = diff_base;
    patch_args.extend(["--patch", range.as_str(), "--"]);
    let (patch, overflowed) = match run_git_clean(
        folder,
        &patch_args,
        &extra_env,
        None,
        Some(MAX_GIT_REVIEW_BYTES),
    ) {
        Ok(o) => (o.stdout, false),
        Err(GitRunError::MaxBuffer(partial)) => (partial, true),
        Err(_) => return tools_err("unavailable", "Could not read Git comparison."),
    };

    let sections = split_patch(&patch);
    let incomplete_idx = if overflowed && !sections.is_empty() {
        Some(sections.len() - 1)
    } else {
        None
    };
    let mut by_path: HashMap<String, (usize, &str)> = HashMap::new();
    for (idx, sec) in sections.iter().enumerate() {
        if let Some(p) = section_path(sec) {
            by_path.entry(p).or_insert((idx, *sec));
        }
    }

    let untracked_paths: HashSet<&str> = listing
        .files
        .iter()
        .filter(|f| f.status == "untracked")
        .map(|f| f.path.as_str())
        .collect();

    let mut files: Vec<(String, Value)> = extra_files
        .into_iter()
        .map(|v| {
            let p = v["path"].as_str().unwrap_or("").to_string();
            (p, v)
        })
        .collect();

    for entry in name_status {
        if !is_valid_relative_path(&entry.path)
            || entry
                .original_path
                .as_deref()
                .is_some_and(|o| !is_valid_relative_path(o))
        {
            continue;
        }
        let counts = numstat_map.get(&entry.path).copied();
        if ignore_whitespace && counts.is_none() {
            continue;
        }
        let content = match by_path.get(&entry.path) {
            None => {
                if overflowed {
                    json!({ "kind": "too-large", "message": TOO_LARGE_REVIEW_DIFF_MSG })
                } else {
                    json!({ "kind": "unavailable", "message": "Git gave no text diff for this file." })
                }
            }
            Some(&(idx, _)) if Some(idx) == incomplete_idx => {
                json!({ "kind": "too-large", "message": TOO_LARGE_REVIEW_DIFF_MSG })
            }
            Some(&(_, sec)) if section_is_binary(sec) => {
                let size = if scope_kind == "working" && entry.status != "deleted" {
                    safe_git_path(&canon_root, &entry.path)
                        .map(|info| info.size)
                        .unwrap_or(0)
                } else {
                    0
                };
                if size > MAX_GIT_PATCH_BYTES as u64 {
                    json!({ "kind": "too-large", "message": TOO_LARGE_FILE_DIFF_MSG })
                } else {
                    json!({ "kind": "binary", "message": BINARY_DIFF_MSG })
                }
            }
            Some(&(_, sec)) if sec.encode_utf16().count() > MAX_GIT_PATCH_BYTES => {
                json!({ "kind": "too-large", "message": TOO_LARGE_FILE_DIFF_MSG })
            }
            Some(&(_, sec)) => json!({ "kind": "text", "patch": sec }),
        };

        let status = if scope_kind == "working"
            && entry.status == "added"
            && untracked_paths.contains(entry.path.as_str())
        {
            "untracked"
        } else {
            entry.status
        };
        let (additions, deletions) = counts.unwrap_or((None, None));
        let mut file_val = json!({
            "path": entry.path,
            "status": status,
            "additions": additions,
            "deletions": deletions,
            "content": content,
        });
        if let Some(orig) = entry.original_path {
            file_val["originalPath"] = json!(orig);
        }
        files.push((entry.path, file_val));
    }

    files.sort_by(|a, b| a.0.cmp(&b.0));
    let truncated =
        files.len() > MAX_GIT_FILES || (scope_kind == "working" && listing.truncated);

    if scope_kind == "working" && retry {
        if let Ok(current) = collect_git_listing(workspace) {
            if current.revision != listing.revision {
                drop(_temp_guard);
                return thread_changes_review_inner(workspace, scope, ignore_whitespace, false);
            }
        }
    }

    let capped_files: Vec<Value> = files
        .into_iter()
        .take(MAX_GIT_FILES)
        .map(|(_, v)| v)
        .collect();
    let mut out = json!({
        "workspace": workspace,
        "revision": listing.revision,
        "scope": resolved_scope,
        "files": capped_files,
        "truncated": truncated,
    });
    if let Some(hw) = hidden_whitespace {
        out["hiddenWhitespace"] = hw;
    }
    tools_ok(out)
}

/// Lists directories inside a requested host folder matching `hostFoldersResultSchema` (`src/shared/hostFolders.ts`).
pub fn host_folders(requested: Option<Option<&str>>, fallback: &Path) -> Value {
    let separator = if cfg!(windows) { "\\" } else { "/" };
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| fallback.to_string_lossy().into_owned());

    // Explicit `path: null` on Windows lists drives; on Unix lists `/`.
    let target_path: Option<PathBuf> = match requested {
        Some(None) => {
            if cfg!(windows) {
                None
            } else {
                Some(PathBuf::from("/"))
            }
        }
        Some(Some(p)) if !p.trim().is_empty() => Some(PathBuf::from(p)),
        _ => Some(PathBuf::from(&home)),
    };

    let Some(target) = target_path else {
        // Windows machine top: drive letters.
        let mut folders = Vec::new();
        for letter in b'A'..=b'Z' {
            let root = format!("{}:\\", letter as char);
            if Path::new(&root).is_dir() {
                folders.push(json!({
                    "name": format!("{}:", letter as char),
                    "path": root,
                    "git": false,
                }));
            }
        }
        return json!({
            "status": "listed",
            "path": null,
            "home": home,
            "separator": separator,
            "crumbs": [{ "name": "Computer", "path": null }],
            "folders": folders,
            "truncated": false,
        });
    };

    if !target.exists() || !target.is_dir() {
        return json!({
            "status": "missing",
            "path": target.to_string_lossy(),
        });
    }
    let Ok(rd) = fs::read_dir(&target) else {
        return json!({
            "status": "unreadable",
            "path": target.to_string_lossy(),
        });
    };
    let listed_path = target.to_string_lossy().into_owned();
    let mut folders = Vec::new();
    let mut truncated = false;
    for entry in rd.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_dir() {
            continue;
        }
        if folders.len() >= MAX_HOST_FOLDERS {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let git = path.join(".git").exists();
        folders.push(json!({
            "name": name,
            "path": path.to_string_lossy(),
            "git": git,
        }));
    }
    folders.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));

    let crumbs = build_folder_crumbs(&target);
    json!({
        "status": "listed",
        "path": listed_path,
        "home": home,
        "separator": separator,
        "crumbs": crumbs,
        "folders": folders,
        "truncated": truncated,
    })
}

fn build_folder_crumbs(path: &Path) -> Vec<Value> {
    let mut chain = Vec::new();
    let mut current = Some(path);
    while let Some(p) = current {
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| p.to_string_lossy().into_owned());
        chain.push(json!({
            "name": name,
            "path": p.to_string_lossy(),
        }));
        current = p.parent().filter(|parent| *parent != p);
    }
    if cfg!(windows) {
        chain.push(json!({ "name": "Computer", "path": null }));
    }
    chain.reverse();
    if chain.is_empty() {
        chain.push(json!({ "name": "/", "path": "/" }));
    }
    chain
}

/// Safely lists files and subdirectories inside `workspace.working_directory/rel_path`,
/// returning `ToolsResult<FileListing>` (`src/shared/files.ts`) matching `FilesService.list`.
pub fn thread_files(workspace: &ThreadWorkspace, rel_path: &str) -> Value {
    if !is_valid_relative_path(rel_path) {
        return tools_err("invalid-request", "Use a relative workspace path.");
    }
    let root = Path::new(&workspace.working_directory);
    let Ok(canon_root) = fs::canonicalize(root) else {
        return tools_err("workspace-unavailable", "This thread's folder is unavailable.");
    };
    let target = match resolve_contained_checked(&canon_root, rel_path) {
        Ok(p) => p,
        Err(ContainedError::Outside) => {
            return tools_err(
                "path-outside-workspace",
                "This path points outside the thread working directory.",
            );
        }
        Err(ContainedError::Unavailable) => {
            return tools_err(
                "path-unavailable",
                "This path is unavailable or changed. Refresh Files and try again.",
            );
        }
    };
    let Ok(target_meta) = fs::metadata(&target) else {
        return tools_err(
            "path-unavailable",
            "This path is unavailable or changed. Refresh Files and try again.",
        );
    };
    if !target_meta.is_dir() {
        return tools_err("not-directory", "Select a directory to browse.");
    }
    // Pin an open directory handle and prove it still resolves inside `canon_root` so an
    // intermediate symlink swap between resolve and read_dir cannot leak outside entries.
    let Ok(dir_handle) = open_contained_dir(&target) else {
        return tools_err(
            "path-unavailable",
            "This path is unavailable or changed. Refresh Files and try again.",
        );
    };
    if !verify_open_handle_inside(&canon_root, &dir_handle) {
        return tools_err(
            "path-unavailable",
            "This path changed while it was being read. Refresh Files and try again.",
        );
    }
    #[cfg(target_os = "linux")]
    let rd_res = {
        use std::os::fd::AsRawFd;
        fs::read_dir(format!("/proc/self/fd/{}", dir_handle.as_raw_fd()))
    };
    #[cfg(not(target_os = "linux"))]
    let rd_res = fs::read_dir(&target);
    let Ok(rd) = rd_res else {
        return tools_err("path-unavailable", "Could not read that folder.");
    };
    let Ok(after_target) = resolve_contained_checked(&canon_root, rel_path) else {
        return tools_err(
            "path-unavailable",
            "This path changed while it was being read. Refresh Files and try again.",
        );
    };
    if after_target != target || !verify_open_handle_inside(&canon_root, &dir_handle) {
        return tools_err(
            "path-unavailable",
            "This path changed while it was being read. Refresh Files and try again.",
        );
    }
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in rd.flatten() {
        if entries.len() >= MAX_FILE_ENTRIES {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = if rel_path.is_empty() {
            name.clone()
        } else {
            format!("{rel_path}/{name}")
        };
        if !is_valid_relative_path(&rel) {
            if rel.encode_utf16().count() <= 4_096 {
                entries.push(json!({
                    "name": name,
                    "path": rel,
                    "kind": "unavailable",
                }));
            } else {
                truncated = true;
            }
            continue;
        }
        // Broken or escaping symlinks are visible as `unavailable`, never followed into previews.
        let kind = match resolve_contained_checked(&canon_root, &rel)
            .ok()
            .and_then(|child| fs::metadata(child).ok())
        {
            Some(meta) if meta.is_dir() => "directory",
            Some(meta) if meta.is_file() => "file",
            _ => "unavailable",
        };
        entries.push(json!({
            "name": name,
            "path": rel,
            "kind": kind,
        }));
    }
    // Re-verify the directory path after reading so a mid-read symlink swap cannot leak entries.
    if resolve_contained_checked(&canon_root, rel_path).ok().as_deref() != Some(target.as_path())
        || !verify_open_handle_inside(&canon_root, &dir_handle)
    {
        return tools_err(
            "path-unavailable",
            "This path changed while it was being read. Refresh Files and try again.",
        );
    }
    entries.sort_by(|a, b| {
        let dir_a = a["kind"] != "directory";
        let dir_b = b["kind"] != "directory";
        let na = a["name"].as_str().unwrap_or("");
        let nb = b["name"].as_str().unwrap_or("");
        dir_a
            .cmp(&dir_b)
            .then_with(|| na.to_lowercase().cmp(&nb.to_lowercase()))
            .then_with(|| na.cmp(nb))
    });
    tools_ok(json!({
        "workspace": workspace,
        "path": rel_path,
        "entries": entries,
        "truncated": truncated,
    }))
}

fn open_contained_dir(path: &Path) -> std::io::Result<fs::File> {
    let mut opts = fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(all(target_os = "linux", any(target_arch = "aarch64", target_arch = "arm")))]
        const FLAGS: i32 = 0o100000 | 0o40000; // O_NOFOLLOW | O_DIRECTORY (ARM/ARM64 Linux)
        #[cfg(all(
            target_os = "linux",
            not(any(target_arch = "aarch64", target_arch = "arm"))
        ))]
        const FLAGS: i32 = 0o400000 | 0o200000; // O_NOFOLLOW | O_DIRECTORY (x86_64/generic Linux)
        #[cfg(target_os = "macos")]
        const FLAGS: i32 = 0x0100 | 0x0010_0000; // O_NOFOLLOW | O_DIRECTORY
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        const FLAGS: i32 = 0;
        if FLAGS != 0 {
            opts.custom_flags(FLAGS);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        opts.custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    }
    opts.open(path)
}

#[cfg(target_os = "linux")]
pub(crate) fn verify_open_handle_inside(canon_root: &Path, file: &fs::File) -> bool {
    use std::os::fd::AsRawFd;
    let fd_path = format!("/proc/self/fd/{}", file.as_raw_fd());
    fs::canonicalize(fd_path).is_ok_and(|p| p.starts_with(canon_root))
}

#[cfg(target_os = "macos")]
pub(crate) fn verify_open_handle_inside(canon_root: &Path, file: &fs::File) -> bool {
    use std::ffi::CStr;
    use std::os::fd::AsRawFd;
    const F_GETPATH: i32 = 50;
    extern "C" {
        fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    }
    let mut buf = [0u8; 4096];
    let rc = unsafe { fcntl(file.as_raw_fd(), F_GETPATH, buf.as_mut_ptr()) };
    if rc == -1 {
        return false;
    }
    let Ok(cstr) = CStr::from_bytes_until_nul(&buf) else {
        return false;
    };
    let Ok(path_str) = cstr.to_str() else {
        return false;
    };
    fs::canonicalize(path_str).is_ok_and(|p| p.starts_with(canon_root))
}

#[cfg(windows)]
pub(crate) fn verify_open_handle_inside(canon_root: &Path, file: &fs::File) -> bool {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFinalPathNameByHandleW(
            h_file: *mut std::ffi::c_void,
            lpsz_file_path: *mut u16,
            cch_file_path: u32,
            dw_flags: u32,
        ) -> u32;
    }
    let mut buf = vec![0u16; 4096];
    let len = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buf.as_mut_ptr(),
            buf.len() as u32,
            0,
        )
    } as usize;
    if len == 0 || len >= buf.len() {
        return false;
    }
    let path = PathBuf::from(std::ffi::OsString::from_wide(&buf[..len]));
    let norm = fs::canonicalize(&path).unwrap_or(path);
    norm.starts_with(canon_root)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn verify_open_handle_inside(_canon_root: &Path, _file: &fs::File) -> bool {
    true
}

pub(crate) fn open_preview_file(path: &Path) -> std::io::Result<fs::File> {
    let mut opts = fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Avoid hanging on a FIFO or following a last-component symlink exchange.
        #[cfg(all(target_os = "linux", any(target_arch = "aarch64", target_arch = "arm")))]
        const FLAGS: i32 = 0o100000 | 0o4000; // O_NOFOLLOW | O_NONBLOCK (ARM/ARM64 Linux)
        #[cfg(all(
            target_os = "linux",
            not(any(target_arch = "aarch64", target_arch = "arm"))
        ))]
        const FLAGS: i32 = 0o400000 | 0o4000; // O_NOFOLLOW | O_NONBLOCK (x86_64/generic Linux)
        #[cfg(target_os = "macos")]
        const FLAGS: i32 = 0x0100 | 0x0004; // O_NOFOLLOW | O_NONBLOCK
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        const FLAGS: i32 = 0;
        if FLAGS != 0 {
            opts.custom_flags(FLAGS);
        }
    }
    opts.open(path)
}

fn same_file_revision(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    let basic = a.len() == b.len() && a.modified().ok() == b.modified().ok();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        basic && a.dev() == b.dev() && a.ino() == b.ino() && a.ctime_nsec() == b.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        basic
    }
}

/// Reads a bounded preview strictly contained within `workspace.working_directory`,
/// matching `FilesService.preview` (`src/main/files/service.ts`): magic-byte raster image detection
/// (never filename MIME inference), strict UTF-8 & control-byte checks, and bounded reads.
pub fn thread_file_preview(workspace: &ThreadWorkspace, rel_path: &str) -> Value {
    if rel_path.is_empty() || !is_valid_relative_path(rel_path) {
        return tools_err("invalid-request", "Use a relative workspace file path.");
    }
    let root = Path::new(&workspace.working_directory);
    let Ok(canon_root) = fs::canonicalize(root) else {
        return tools_err("workspace-unavailable", "This thread's folder is unavailable.");
    };
    let target = match resolve_contained_checked(&canon_root, rel_path) {
        Ok(p) => p,
        Err(ContainedError::Outside) => {
            return tools_err(
                "path-outside-workspace",
                "This path points outside the thread working directory.",
            );
        }
        Err(ContainedError::Unavailable) => {
            return tools_err(
                "path-unavailable",
                "This path is unavailable or changed. Refresh Files and try again.",
            );
        }
    };
    let Ok(meta) = fs::metadata(&target) else {
        return tools_err("path-unavailable", "File not found.");
    };
    if !meta.is_file() {
        return tools_err("not-file", "Select a regular file to preview.");
    }
    if meta.len() > MAX_IMAGE_PREVIEW_BYTES as u64 {
        return tools_err("too-large", "This file exceeds the 8 MiB preview limit.");
    }

    let Ok(file) = open_preview_file(&target) else {
        return tools_err(
            "path-unavailable",
            "This path is unavailable or changed. Refresh Files and try again.",
        );
    };
    // Prove the opened file descriptor itself lives inside `canon_root` (blocks intermediate dir symlink swap).
    if !verify_open_handle_inside(&canon_root, &file) {
        return tools_err(
            "path-unavailable",
            "This file changed. Refresh Files and try again.",
        );
    }
    let Ok(before) = file.metadata() else {
        return tools_err(
            "path-unavailable",
            "This file changed. Refresh Files and try again.",
        );
    };
    if !before.is_file() || !same_file_revision(&before, &meta) {
        return tools_err(
            "path-unavailable",
            "This file changed. Refresh Files and try again.",
        );
    }

    let mut bytes = Vec::new();
    let max_read = (MAX_IMAGE_PREVIEW_BYTES as u64).saturating_add(1);
    if file.take(max_read).read_to_end(&mut bytes).is_err() {
        return tools_err(
            "path-unavailable",
            "This file changed while it was being read. Refresh Files and try again.",
        );
    }
    if bytes.len() > MAX_IMAGE_PREVIEW_BYTES {
        return tools_err("too-large", "This file exceeds the 8 MiB preview limit.");
    }
    let after_ok = resolve_contained_checked(&canon_root, rel_path)
        .ok()
        .as_deref()
        == Some(target.as_path())
        && fs::metadata(&target)
            .ok()
            .is_some_and(|after_meta| same_file_revision(&before, &after_meta))
        && bytes.len() as u64 == before.len();
    if !after_ok {
        return tools_err(
            "path-unavailable",
            "This file changed while it was being read. Refresh Files and try again.",
        );
    }

    let name = rel_path
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(rel_path);

    match preview_content(&bytes, rel_path) {
        Ok(content) => tools_ok(json!({
            "workspace": workspace,
            "path": rel_path,
            "name": name,
            "size": bytes.len(),
            "content": content,
        })),
        Err(refused) => refused,
    }
}

/// Whether a name ends as a Markdown file's does, as Node's `isMarkdownFileName` (`src/shared/files.ts`) reads it.
pub fn is_markdown_file_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".md", ".markdown", ".mdown"].iter().any(|ending| lower.ends_with(ending))
}

/// UTF-8 text, or the refusal for anything that reads as binary, as Node's `textOf` (`src/main/files/service.ts`).
pub(crate) fn text_of(bytes: &[u8]) -> Result<String, Value> {
    let Ok(raw_text) = std::str::from_utf8(bytes) else {
        return Err(tools_err(
            "binary",
            "This file is not supported UTF-8 text or a raster image.",
        ));
    };
    // Match `new TextDecoder('utf-8', { fatal: true })`, which strips a leading UTF-8 BOM.
    let text = raw_text.strip_prefix('\u{feff}').unwrap_or(raw_text);
    if text
        .bytes()
        .any(|b| matches!(b, 0x00..=0x08 | 0x0b | 0x0e..=0x1f | 0x7f))
    {
        return Err(tools_err("binary", "Binary files cannot be previewed as text."));
    }
    Ok(text.to_string())
}

/// What a preview shows of a file's bytes, as Node's `previewContent` (`src/main/files/service.ts`): a raster picture
/// found by its first bytes (never by its name), or text within the text limit, Markdown when `name` ends as Markdown.
pub(crate) fn preview_content(bytes: &[u8], name: &str) -> Result<Value, Value> {
    if let Some(image) = detect_raster_image(bytes) {
        let pixels = (image.width as u64).saturating_mul(image.height as u64);
        if image.width == 0
            || image.height == 0
            || image.width > 16_384
            || image.height > 16_384
            || pixels > 40_000_000
        {
            return Err(tools_err("too-large", "This image exceeds the preview dimensions limit."));
        }
        let data_url = format!("data:{};base64,{}", image.mime, STANDARD.encode(bytes));
        return Ok(json!({ "kind": "image", "mime": image.mime, "dataUrl": data_url }));
    }
    if bytes.len() > MAX_TEXT_PREVIEW_BYTES {
        return Err(tools_err("too-large", "Text previews are limited to 512 KiB."));
    }
    let text = text_of(bytes)?;
    if text.encode_utf16().count() > MAX_TEXT_PREVIEW_BYTES {
        return Err(tools_err("too-large", "Text previews are limited to 512 KiB."));
    }
    let kind = if is_markdown_file_name(name) { "markdown" } else { "text" };
    Ok(json!({ "kind": kind, "text": text }))
}

/// Reports machine facts matching `hostMachineReportSchema` (`src/shared/hostFacts.ts`).
pub fn host_facts(running_threads: usize) -> Value {
    host_facts_report(running_threads, false)
}

/// The most of a sent message a stored prompt carries, as Node's `THREAD_PROMPT_TEXT`.
const THREAD_PROMPT_TEXT: usize = 400;
/// The start and end of a turn's last reply a stored prompt carries, as Node's `THREAD_PROMPT_REPLY_HEAD` and `_TAIL`.
const THREAD_PROMPT_REPLY_HEAD: usize = 300;
const THREAD_PROMPT_REPLY_TAIL: usize = 300;
/// The most messages the user sent one answer covers, as Node's `THREAD_PROMPTS_MOST`.
const THREAD_PROMPTS_MOST: usize = 5_000;
/// The most attachments a stored prompt counts, as Node's schema allows.
const THREAD_PROMPT_ATTACHMENTS_MOST: usize = 1_000;

/// One prompt the message scrubber marks, as Node's `agentThreadPromptSchema` has it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadPrompt {
    id: String,
    created_at: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    attachments: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reply: Option<ThreadPromptReply>,
}

/// The last reply with words of a prompt's turn.
#[derive(Serialize)]
struct ThreadPromptReply {
    id: String,
    text: String,
}

/// `threads.sqlite`, opened strictly read-only so a read never creates a database or contends for write locks beside
/// the host that writes it. `None` when there is none or it cannot be opened.
fn open_thread_store_read_only(data_directory: &Path) -> Option<rusqlite::Connection> {
    let db = data_directory.join("threads.sqlite");
    if !db.is_file() {
        return None;
    }
    let conn = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let _ = conn.busy_timeout(Duration::from_secs(5));
    Some(conn)
}

/// Whether the store has the wake-ups table, which a store from before it was added does not.
fn has_wake_ups_table(conn: &rusqlite::Connection) -> bool {
    conn.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'wake_ups' LIMIT 1", [], |_| Ok(true))
        .unwrap_or(false)
}

/// The messages the user sent before `before_message_id`, oldest first, each with its turn's last reply with words: what
/// the message scrubber marks above a pane's window (ADR-0109), as Node's `promptsBefore` reads them from the same
/// `threads.sqlite`. Only the start of each message and the start and end of each reply are read, a page of the newest at
/// a time: `next` is the message the next page is read before, absent once the page reaches the first. A message the
/// store does not hold has nothing before it. Wake-ups are Sotto's, so they are left out. `None` when the store cannot
/// answer.
pub fn thread_prompts(data_directory: &Path, thread_id: &str, before_message_id: &str) -> Option<Value> {
    use rusqlite::OptionalExtension;
    let conn = open_thread_store_read_only(data_directory)?;
    let before: Option<i64> = conn
        .query_row(
            "SELECT position FROM messages WHERE thread_id = ?1 AND message_id = ?2 LIMIT 1",
            rusqlite::params![thread_id, before_message_id],
            |row| row.get(0),
        )
        .optional()
        .ok()?;
    let Some(before) = before else {
        return Some(json!({ "prompts": [] }));
    };
    // Only the newest prompts an answer carries are read, so a longer history costs no more. The page is counted in the
    // messages the user's role sent, wake-ups among them, so where it starts says whether there is more.
    let start: Option<(i64, String)> = conn
        .query_row(
            &format!("SELECT position, message_id FROM messages WHERE thread_id = ?1 AND role = 'user' AND position < ?2 ORDER BY position DESC LIMIT 1 OFFSET {}", THREAD_PROMPTS_MOST - 1),
            rusqlite::params![thread_id, before],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .ok()?;
    let from = start.as_ref().map_or(0, |(position, _)| *position);
    let mut skip = HashSet::new();
    if has_wake_ups_table(&conn) {
        let mut wake_ups = conn.prepare("SELECT message_id FROM wake_ups WHERE thread_id = ?1").ok()?;
        let ids = wake_ups.query_map([thread_id], |row| row.get::<_, String>(0)).ok()?;
        for id in ids {
            skip.insert(id.ok()?);
        }
    }
    let whole = THREAD_PROMPT_REPLY_HEAD + THREAD_PROMPT_REPLY_TAIL;
    let mut rows = conn
        .prepare(&format!(
            "SELECT role, message_id, created_at, attachments, substr(text, 1, CASE WHEN role = 'user' THEN {THREAD_PROMPT_TEXT} ELSE {whole} END) AS head,
               CASE WHEN role = 'assistant' AND length(text) > {whole} THEN substr(text, -{tail}) END AS tail
             FROM messages WHERE thread_id = ?1 AND position >= ?2 AND position < ?3 AND (role = 'user' OR trim(text, char(32, 9, 10, 11, 12, 13)) <> '') ORDER BY position",
            tail = THREAD_PROMPT_REPLY_TAIL * 2
        ))
        .ok()?;
    let read = rows
        .query_map(rusqlite::params![thread_id, from, before], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .ok()?;
    let mut prompts: Vec<ThreadPrompt> = Vec::new();
    // A wake-up starts a turn of its own, so what answers it is no prompt's reply.
    let mut takes_reply = false;
    for row in read {
        let (role, id, created_at, attachments, head, tail) = row.ok()?;
        if role == "user" {
            if skip.contains(&id) {
                takes_reply = false;
                continue;
            }
            // A list the store cannot read leaves the whole read unanswered, as Node's parse does.
            let attached = match attachments {
                None => 0,
                Some(text) => serde_json::from_str::<Vec<Value>>(&text).ok()?.len(),
            };
            prompts.push(ThreadPrompt {
                id,
                created_at,
                text: clip_utf16(&head, THREAD_PROMPT_TEXT).to_string(),
                attachments: (attached > 0).then(|| attached.min(THREAD_PROMPT_ATTACHMENTS_MOST)),
                reply: None,
            });
            takes_reply = true;
        } else if takes_reply {
            // A reply of space alone is no reply with words, whatever kind of space the store's own trim leaves.
            if tail.is_some() || !head.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}').is_empty() {
                if let Some(prompt) = prompts.last_mut() {
                    prompt.reply = Some(ThreadPromptReply { id, text: prompt_reply_text(&head, tail.as_deref()) });
                }
            }
        }
    }
    let mut answer = json!({ "prompts": prompts });
    if let Some((_, message_id)) = start.filter(|_| from > 0) {
        answer["next"] = json!(message_id);
    }
    Some(answer)
}

/// A reply as a stored prompt carries it, as Node's `promptReplyText`: whole when it is short, otherwise its start and
/// its end from a paragraph's start, so a question it closes on is still its last words. Counted in UTF-16 units.
fn prompt_reply_text(head: &str, tail: Option<&str>) -> String {
    let Some(tail) = tail else {
        return clip_utf16(head, THREAD_PROMPT_REPLY_HEAD + THREAD_PROMPT_REPLY_TAIL).to_string();
    };
    let units: Vec<u16> = tail.encode_utf16().collect();
    let paragraph = units.windows(2).position(|pair| pair == [10, 10]);
    let end = match paragraph {
        Some(at) if at + 2 < units.len() => &units[at + 2..],
        _ => &units[..],
    };
    let last = if end.len() > THREAD_PROMPT_REPLY_TAIL { &end[end.len() - THREAD_PROMPT_REPLY_TAIL..] } else { end };
    // A cut through a pair of surrogates leaves the low half alone, which is no character.
    let last = if last.first().is_some_and(|unit| (0xDC00..=0xDFFF).contains(unit)) { &last[1..] } else { last };
    format!("{}\n\n{}", clip_utf16(head, THREAD_PROMPT_REPLY_HEAD), String::from_utf16_lossy(last))
}

/// Searches thread messages for a query string matching `agentThreadWordsSchema`
/// (`src/shared/threadWords.ts`) and `ThreadStore.threadWords` (`src/main/agents/threadStore.ts`).
/// Opens `threads.sqlite` strictly read-only so it never creates a database or contends for write
/// locks when running beside Node's `AgentControl`.
pub fn search_thread_words(data_directory: &Path, query: &str) -> Value {
    let trimmed = query.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() {
        return json!({ "found": [] });
    }
    // Truncate query to 200 UTF-16 code units matching `threadWordsQuery`.
    let mut needle = String::new();
    let mut u16_len = 0usize;
    for ch in trimmed.chars() {
        let w = ch.len_utf16();
        if u16_len + w > 200 {
            break;
        }
        needle.push(ch);
        u16_len += w;
    }
    let needle = needle.trim().to_string();
    if needle.is_empty() {
        return json!({ "found": [] });
    }

    let Some(conn) = open_thread_store_read_only(data_directory) else {
        return json!({ "found": [] });
    };
    let has_wake_ups = has_wake_ups_table(&conn);

    let mut escaped = String::with_capacity(needle.len() + 2);
    escaped.push('%');
    for ch in needle.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped.push('%');

    let wake_up_clause = if has_wake_ups {
        "WHERE NOT EXISTS (SELECT 1 FROM wake_ups w WHERE w.thread_id = h.thread_id AND w.message_id = h.message_id)"
    } else {
        ""
    };
    let threads_sql = format!(
        "WITH hits AS MATERIALIZED (
             SELECT m.thread_id, m.message_id, m.position, m.created_at
             FROM messages m
             WHERE m.role IN ('user', 'assistant') AND m.text LIKE ?1 ESCAPE '\\'
         )
         SELECT g.thread_id, g.hits, g.last
         FROM (
             SELECT h.thread_id, COUNT(*) AS hits, MAX(h.position) AS last
             FROM hits h
             {wake_up_clause}
             GROUP BY h.thread_id
         ) g
         JOIN messages n ON n.thread_id = g.thread_id AND n.position = g.last
         ORDER BY n.created_at DESC
         LIMIT 200"
    );

    let Ok(mut threads_stmt) = conn.prepare(&threads_sql) else {
        return json!({ "found": [] });
    };
    let Ok(thread_rows) = threads_stmt.query_map([escaped.as_str()], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    }) else {
        return json!({ "found": [] });
    };

    let Ok(mut newest_stmt) = conn.prepare(
        "SELECT role, message_id, text
         FROM messages
         WHERE thread_id = ?1 AND position = ?2
         LIMIT 1",
    ) else {
        return json!({ "found": [] });
    };

    let needle_lower = needle.to_lowercase();
    let mut found: Vec<Value> = Vec::new();
    for item in thread_rows.flatten() {
        let (tid, hits, last_pos) = item;
        let Ok((role, message_id, text)) = newest_stmt.query_row(
            rusqlite::params![tid.as_str(), last_pos],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        ) else {
            continue;
        };
        let role_norm = if role == "user" { "user" } else { "assistant" };
        let quote = build_word_quote(&text, &needle_lower);
        let more = (hits - 1).clamp(0, 999);
        found.push(json!({
            "threadId": tid,
            "messageId": message_id,
            "role": role_norm,
            "quote": quote,
            "more": more,
        }));
    }
    json!({ "found": found })
}

fn build_word_quote(text: &str, needle_lower: &str) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = normalized.chars().collect();
    // Build the lowercased string while recording each lowercased byte's originating index
    // in `chars` so characters whose lowercase form expands (such as Turkish `İ` -> `i\u{307}`)
    // never produce an out-of-bounds index into `chars`.
    let mut lower = String::with_capacity(normalized.len());
    let mut orig_char_by_lower_byte: Vec<usize> = Vec::with_capacity(normalized.len());
    for (orig_idx, &ch) in chars.iter().enumerate() {
        for lower_ch in ch.to_lowercase() {
            let mut buf = [0u8; 4];
            let encoded = lower_ch.encode_utf8(&mut buf);
            lower.push_str(encoded);
            for _ in 0..encoded.len() {
                orig_char_by_lower_byte.push(orig_idx);
            }
        }
    }
    let hit_char_idx = lower
        .find(needle_lower)
        .and_then(|byte_idx| orig_char_by_lower_byte.get(byte_idx).copied())
        .unwrap_or(0);
    let start_char = hit_char_idx.saturating_sub(48).min(chars.len());
    let mut slice = String::new();
    let mut u16_len = 0usize;
    let mut end_char = start_char;
    for &ch in &chars[start_char..] {
        let w = ch.len_utf16();
        if u16_len + w > 180 {
            break;
        }
        slice.push(ch);
        u16_len += w;
        end_char += 1;
    }
    let prefix = if start_char > 0 { "…" } else { "" };
    let suffix = if end_char < chars.len() { "…" } else { "" };
    format!("{prefix}{}{suffix}", slice.trim())
}

pub const SUBAGENT_PAGE_SIZE: usize = 50;
pub const SUBAGENT_ASSIGNMENT_PAGE_SIZE: usize = 10;

/// Reads subagent page from `subagents.sqlite` matching `subagentPageSchema` (`src/shared/subagents.ts`)
/// and `SubagentStore.page` (`src/main/agents/subagentStore.ts`), including parent rows split across pages.
pub fn read_subagent_page(data_directory: &Path, thread_id: &str, before: Option<i64>) -> Value {
    let empty_summary = json!({
        "total": 0,
        "working": 0,
        "completed": 0,
        "failed": 0,
        "interrupted": 0,
        "unknown": 0,
    });
    let db = data_directory.join("subagents.sqlite");
    if !db.is_file() {
        return json!({
            "threadId": thread_id,
            "revision": 0,
            "rows": [],
            "summary": empty_summary,
        });
    }
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return json!({
            "threadId": thread_id,
            "revision": 0,
            "rows": [],
            "summary": empty_summary,
        });
    };
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));

    let thread_state: Option<Value> = conn
        .query_row(
            "SELECT value FROM subagent_threads WHERE thread_id = ?1",
            [thread_id],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok());
    let revision = thread_state
        .as_ref()
        .and_then(|v| v.get("revision"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let mut summary = thread_state
        .as_ref()
        .and_then(|v| v.get("summary"))
        .cloned()
        .unwrap_or(empty_summary);
    // Rust host does not write live subagents to `subagents.sqlite`; any persisted `working` count
    // belongs to a stopped Node host and must surface as `unknown` (matching Node after restart).
    if let Some(obj) = summary.as_object_mut() {
        let working = obj.get("working").and_then(Value::as_u64).unwrap_or(0);
        if working > 0 {
            let unknown = obj.get("unknown").and_then(Value::as_u64).unwrap_or(0);
            obj.insert("working".into(), json!(0));
            obj.insert("unknown".into(), json!(unknown.saturating_add(working)));
        }
    }

    let cutoff = before.unwrap_or(i64::MAX);
    let fetch = (SUBAGENT_PAGE_SIZE + 1) as i64;
    let raw_rows: Vec<String> = conn
        .prepare(
            "SELECT value FROM subagent_rows
             WHERE thread_id = ?1 AND sequence < ?2
             ORDER BY sequence DESC
             LIMIT ?3",
        )
        .and_then(|mut stmt| {
            let mapped = stmt.query_map(rusqlite::params![thread_id, cutoff, fetch], |r| {
                r.get::<_, String>(0)
            })?;
            Ok(mapped.flatten().collect())
        })
        .unwrap_or_default();

    let has_more = raw_rows.len() > SUBAGENT_PAGE_SIZE;
    let mut rows: Vec<Value> = raw_rows
        .into_iter()
        .take(SUBAGENT_PAGE_SIZE)
        .filter_map(|raw| serde_json::from_str::<Value>(&raw).ok())
        .collect();
    rows.reverse();

    let next_before = if has_more {
        rows.first()
            .and_then(|r| r.get("sequence"))
            .and_then(Value::as_i64)
    } else {
        None
    };

    // Bring missing parent rows along so workflow agents are never orphaned by a page split.
    let present_ids: std::collections::HashSet<String> = rows
        .iter()
        .filter_map(|r| r.get("id").and_then(Value::as_str).map(ToString::to_string))
        .collect();
    let mut missing_parents: Vec<String> = Vec::new();
    let mut seen_missing: std::collections::HashSet<String> = std::collections::HashSet::new();
    for row in &rows {
        if let Some(pid) = row.get("parentId").and_then(Value::as_str) {
            if !present_ids.contains(pid) && seen_missing.insert(pid.to_string()) {
                missing_parents.push(pid.to_string());
                if missing_parents.len() >= SUBAGENT_PAGE_SIZE {
                    break;
                }
            }
        }
    }
    let mut combined: Vec<Value> = Vec::with_capacity(missing_parents.len() + rows.len());
    if !missing_parents.is_empty() {
        if let Ok(mut parent_stmt) =
            conn.prepare("SELECT value FROM subagent_rows WHERE thread_id = ?1 AND agent_id = ?2")
        {
            for pid in &missing_parents {
                if let Ok(raw) = parent_stmt.query_row(
                    rusqlite::params![thread_id, pid.as_str()],
                    |r| r.get::<_, String>(0),
                ) {
                    if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                        combined.push(val);
                    }
                }
            }
        }
    }
    combined.extend(rows);
    for row in &mut combined {
        if let Some(obj) = row.as_object_mut() {
            if obj.get("status").and_then(Value::as_str) == Some("running") {
                obj.insert("status".into(), json!("unknown"));
            }
        }
    }
    combined.sort_by_key(|r| r.get("sequence").and_then(Value::as_i64).unwrap_or(0));

    let mut out = json!({
        "threadId": thread_id,
        "revision": revision,
        "rows": combined,
        "summary": summary,
    });
    if let Some(cursor) = next_before.filter(|&n| n > 0) {
        out["before"] = json!(cursor);
    }
    out
}

/// Reads subagent assignments page from `subagents.sqlite` matching `subagentAssignmentsPageSchema`
/// (`src/shared/subagents.ts`) and `SubagentStore.assignments` (`src/main/agents/subagentStore.ts`).
pub fn read_subagent_assignments(
    data_directory: &Path,
    thread_id: &str,
    agent_id: &str,
    before: Option<i64>,
) -> Value {
    let db = data_directory.join("subagents.sqlite");
    if !db.is_file() {
        return json!({
            "threadId": thread_id,
            "agentId": agent_id,
            "assignments": [],
        });
    }
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return json!({
            "threadId": thread_id,
            "agentId": agent_id,
            "assignments": [],
        });
    };
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));

    let cutoff = before.unwrap_or(i64::MAX);
    let fetch = (SUBAGENT_ASSIGNMENT_PAGE_SIZE + 1) as i64;
    let raw_rows: Vec<String> = conn
        .prepare(
            "SELECT value FROM subagent_assignments
             WHERE thread_id = ?1 AND agent_id = ?2 AND sequence < ?3
             ORDER BY sequence DESC
             LIMIT ?4",
        )
        .and_then(|mut stmt| {
            let mapped = stmt.query_map(
                rusqlite::params![thread_id, agent_id, cutoff, fetch],
                |r| r.get::<_, String>(0),
            )?;
            Ok(mapped.flatten().collect())
        })
        .unwrap_or_default();

    let has_more = raw_rows.len() > SUBAGENT_ASSIGNMENT_PAGE_SIZE;
    let assignments: Vec<Value> = raw_rows
        .into_iter()
        .take(SUBAGENT_ASSIGNMENT_PAGE_SIZE)
        .filter_map(|raw| serde_json::from_str::<Value>(&raw).ok())
        .collect();
    let next_before = if has_more {
        assignments
            .last()
            .and_then(|a| a.get("sequence"))
            .and_then(Value::as_i64)
    } else {
        None
    };

    let mut out = json!({
        "threadId": thread_id,
        "agentId": agent_id,
        "assignments": assignments,
    });
    if let Some(cursor) = next_before.filter(|&n| n > 0) {
        out["before"] = json!(cursor);
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepository {
    pub host: String,
    pub owner: String,
    pub name: String,
}

/// Parses a Git remote URL into a GitHub repository matching `parseGitHubRemote` in
/// `src/main/agents/git/github.ts`.
pub fn parse_github_remote(url: &str) -> Option<GitHubRepository> {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let (raw_host, ssh, rest) = if let Some(after) = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("HTTPS://"))
    {
        let (authority, path) = after.split_once('/')?;
        let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        let host = host_port.split_once(':').map_or(host_port, |(h, _)| h);
        (host.to_ascii_lowercase(), false, path)
    } else if let Some(after) = trimmed
        .strip_prefix("ssh://")
        .or_else(|| trimmed.strip_prefix("SSH://"))
    {
        let (authority, path) = after.split_once('/')?;
        let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        let host = host_port.split_once(':').map_or(host_port, |(h, _)| h);
        (host.to_ascii_lowercase(), true, path)
    } else if let Some((left, path)) = trimmed.split_once(':') {
        if path.starts_with('/') || left.contains('/') {
            return None;
        }
        let host = left.rsplit_once('@').map_or(left, |(_, h)| h);
        (host.to_ascii_lowercase(), true, path)
    } else {
        return None;
    };

    let (owner, name_raw) = rest.split_once('/')?;
    if owner.is_empty() || name_raw.is_empty() || name_raw.contains('/') || owner.contains(char::is_whitespace) || name_raw.contains(char::is_whitespace) {
        return None;
    }
    let name = name_raw
        .strip_suffix(".git")
        .or_else(|| name_raw.strip_suffix(".GIT"))
        .unwrap_or(name_raw);
    if name.is_empty() {
        return None;
    }

    let api_host = if raw_host == "github.com"
        || raw_host.ends_with(".github.com")
        || (ssh
            && ((!raw_host.contains('.') && raw_host.contains("github"))
                || raw_host.starts_with("github.com-")
                || raw_host.starts_with("github.com_")))
    {
        Some("github.com".to_string())
    } else if raw_host.contains("github") {
        Some(raw_host)
    } else {
        None
    }?;

    Some(GitHubRepository {
        host: api_host,
        owner: owner.to_string(),
        name: name.to_string(),
    })
}

/// Reads each project's `origin` GitHub repository without network calls, matching
/// `readProjectOrigins` in `src/main/agents/projectOrigins.ts`.
pub fn project_origins(projects: &[(String, String)]) -> Value {
    const PROJECT_ORIGINS_MAX: usize = 1_000;
    let listed = &projects[..projects.len().min(PROJECT_ORIGINS_MAX)];
    let mut by_path: HashMap<&str, Option<GitHubRepository>> = HashMap::new();
    for (_, path) in listed {
        let key = path.as_str();
        if by_path.contains_key(key) {
            continue;
        }
        let repo = if key.trim().is_empty() {
            None
        } else {
            run_git(key, &["config", "--get", "remote.origin.url"])
                .ok()
                .and_then(|url| parse_github_remote(&url))
        };
        by_path.insert(key, repo);
    }
    let items: Vec<Value> = listed
        .iter()
        .map(|(project_id, path)| {
            let repository = by_path
                .get(path.as_str())
                .and_then(|opt| opt.as_ref())
                .map(|repo| {
                    json!({
                        "host": repo.host,
                        "owner": repo.owner,
                        "name": repo.name,
                    })
                });
            json!({
                "projectId": project_id,
                "repository": repository,
            })
        })
        .collect();
    json!({ "projects": items })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingCopyOptions {
    pub is_git: bool,
    pub current_branch: Option<String>,
    pub worktrees: Vec<WorktreeEntry>,
    pub branches: Vec<String>,
}

/// Inspects a project directory's Git working-copy choices for Watcher's `list_working_copies`
/// and `start_thread`, matching `WorktreeManager.options`.
pub fn working_copy_options(project_path: &str) -> WorkingCopyOptions {
    let root = Path::new(project_path);
    if project_path.trim().is_empty() || !root.is_dir() {
        return WorkingCopyOptions {
            is_git: false,
            current_branch: None,
            worktrees: Vec::new(),
            branches: Vec::new(),
        };
    }
    let is_git = run_git(project_path, &["rev-parse", "--is-inside-work-tree"])
        .ok()
        .is_some_and(|out| out.trim() == "true");
    if !is_git {
        return WorkingCopyOptions {
            is_git: false,
            current_branch: None,
            worktrees: Vec::new(),
            branches: Vec::new(),
        };
    }
    let current_branch = run_git(project_path, &["symbolic-ref", "--short", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let mut worktrees = Vec::new();
    if let Ok(porcelain) = run_git(project_path, &["worktree", "list", "--porcelain"]) {
        let mut cur_path: Option<String> = None;
        let mut cur_branch: Option<String> = None;
        let flush = |worktrees: &mut Vec<WorktreeEntry>, cur_path: &mut Option<String>, cur_branch: &mut Option<String>| {
            if let Some(p) = cur_path.take() {
                let canon_p = fs::canonicalize(&p).ok();
                let canon_root = fs::canonicalize(root).ok();
                let is_main = canon_p.is_some() && canon_p == canon_root || p == project_path;
                if !is_main {
                    worktrees.push(WorktreeEntry {
                        path: p,
                        branch: cur_branch.take(),
                    });
                } else {
                    cur_branch.take();
                }
            }
        };
        for line in porcelain.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                flush(&mut worktrees, &mut cur_path, &mut cur_branch);
            } else if let Some(p) = trimmed.strip_prefix("worktree ") {
                flush(&mut worktrees, &mut cur_path, &mut cur_branch);
                cur_path = Some(p.trim().to_string());
            } else if let Some(b) = trimmed.strip_prefix("branch refs/heads/") {
                cur_branch = Some(b.trim().to_string());
            }
        }
        flush(&mut worktrees, &mut cur_path, &mut cur_branch);
    }

    let mut branches = Vec::new();
    if let Ok(raw) = run_git(
        project_path,
        &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"],
    ) {
        for line in raw.lines() {
            let name = line.trim();
            if !name.is_empty() && !branches.iter().any(|b| b == name) {
                branches.push(name.to_string());
                if branches.len() >= 100 {
                    break;
                }
            }
        }
    }

    WorkingCopyOptions {
        is_git: true,
        current_branch,
        worktrees,
        branches,
    }
}

enum ContainedError {
    Outside,
    Unavailable,
}

fn resolve_contained_checked(canon_root: &Path, rel: &str) -> Result<PathBuf, ContainedError> {
    let trimmed = rel.trim_start_matches(['/', '\\']);
    let candidate = if trimmed.is_empty() {
        canon_root.to_path_buf()
    } else {
        canon_root.join(trimmed)
    };
    let canon_target = fs::canonicalize(&candidate).map_err(|_| ContainedError::Unavailable)?;
    if !canon_target.starts_with(canon_root) {
        return Err(ContainedError::Outside);
    }
    Ok(canon_target)
}

struct GitRunOutput {
    stdout: String,
}

enum GitRunError {
    Unavailable(String),
    MaxBuffer(String),
    Failed(String),
}

fn run_git_clean(
    folder: &str,
    args: &[&str],
    extra_env: &[(String, String)],
    stdin_bytes: Option<&[u8]>,
    max_buffer: Option<usize>,
) -> Result<GitRunOutput, GitRunError> {
    run_git_impl(
        folder,
        args,
        extra_env,
        stdin_bytes,
        max_buffer,
        true,
        Instant::now() + Duration::from_secs(10),
        TimeoutStop::Kill,
    )
}

fn run_git_status_cmd_with_deadline(
    folder: &str,
    args: &[&str],
    deadline: Instant,
) -> Result<GitRunOutput, GitRunError> {
    run_git_impl(folder, args, &[], None, None, false, deadline, TimeoutStop::Kill)
}

fn run_git_status_with_deadline(
    folder: &str,
    args: &[&str],
    deadline: Instant,
) -> Result<String, String> {
    run_git_status_cmd_with_deadline(folder, args, deadline)
        .map(|o| o.stdout)
        .map_err(|e| match e {
            GitRunError::Unavailable(msg) => msg,
            GitRunError::MaxBuffer(_) => "git output exceeded buffer limit".into(),
            GitRunError::Failed(msg) => msg,
        })
}

/// How long a command stopped at its deadline is given to finish before it settles, as Node's `spawnCommand` gives it.
const TIMEOUT_GRACE: Duration = Duration::from_secs(2);

/// How Git is stopped at its deadline.
#[derive(Clone, Copy, PartialEq, Eq)]
enum TimeoutStop {
    /// Killed at once.
    Kill,
    /// Sent SIGTERM, as Node's `spawnCommand` stops a Git action with `child.kill()`, so Git removes the `index.lock` it
    /// holds before it goes; one still running when the grace ends is killed. Windows has no SIGTERM: there Node's
    /// `child.kill()` is TerminateProcess, and so is this.
    Terminate,
}

/// Stops `child`, which has run past its deadline, as `stop` says, and reaps it. A Git sent SIGTERM has until `grace` to
/// go by itself.
fn stop_at_deadline(child: &mut std::process::Child, stop: TimeoutStop, grace: Instant) -> std::io::Result<std::process::ExitStatus> {
    #[cfg(unix)]
    if stop == TimeoutStop::Terminate {
        extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        const SIGTERM: i32 = 15;
        // SAFETY: `kill` takes two integers and touches no memory of ours. The child has not been reaped, so its pid is
        // still its own and the signal reaches no other process.
        if unsafe { kill(child.id() as i32, SIGTERM) } == 0 {
            while Instant::now() < grace {
                if let Some(status) = child.try_wait()? {
                    return Ok(status);
                }
                std::thread::sleep(Duration::from_millis(15));
            }
        }
    }
    #[cfg(not(unix))]
    let _ = (stop, grace);
    let _ = child.kill();
    child.wait()
}

#[allow(clippy::too_many_arguments)]
fn run_git_impl(
    folder: &str,
    args: &[&str],
    extra_env: &[(String, String)],
    stdin_bytes: Option<&[u8]>,
    max_buffer: Option<usize>,
    strip_all_git_env: bool,
    deadline: Instant,
    stop: TimeoutStop,
) -> Result<GitRunOutput, GitRunError> {
    if Instant::now() >= deadline {
        return Err(GitRunError::Failed("git timed out".into()));
    }
    let opts = crate::cli_lookup::CliLookupOptions::from_process_env();
    let mut cmd = match crate::cli_lookup::resolve_tool_cli("git", &opts) {
        Some(res) => {
            let mut c = Command::new(&res.executable);
            res.apply_std(&mut c);
            c
        }
        None => Command::new("git"),
    };
    cmd.args([
        "--no-optional-locks",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.quotePath=false",
        "-c",
        "diff.external=",
    ])
    .args(args)
    .current_dir(folder)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    if stdin_bytes.is_some() {
        cmd.stdin(Stdio::piped());
    } else {
        cmd.stdin(Stdio::null());
    }
    for (k, _) in std::env::vars() {
        let upper = k.to_ascii_uppercase();
        if strip_all_git_env {
            if upper.starts_with("GIT_") {
                cmd.env_remove(&k);
            }
        } else if REDIRECTING_GIT_VARIABLES.contains(&upper.as_str()) {
            cmd.env_remove(&k);
        }
    }
    if !strip_all_git_env {
        cmd.env("LC_ALL", "C");
        cmd.env("GH_PROMPT_DISABLED", "1");
        cmd.env("GCM_INTERACTIVE", "never");
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            GitRunError::Unavailable("Git is unavailable.".into())
        } else {
            GitRunError::Failed(format!("Could not run git: {e}"))
        }
    })?;

    if let Some(input) = stdin_bytes {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(input);
        }
    }

    // Drain stdout and bounded stderr on dedicated reader threads while enforcing `deadline`
    // so a stalled git clean filter or hook is always terminated instead of wedging a worker.
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let reader = std::thread::spawn(move || -> (Vec<u8>, bool) {
        let mut buf = Vec::new();
        let mut overflowed = false;
        if let Some(mut stdout) = stdout_pipe {
            if let Some(limit) = max_buffer {
                let mut limited = stdout.take((limit as u64).saturating_add(1));
                let _ = limited.read_to_end(&mut buf);
                if buf.len() > limit {
                    buf.truncate(limit);
                    overflowed = true;
                }
            } else {
                let _ = stdout.read_to_end(&mut buf);
            }
        }
        (buf, overflowed)
    });
    let stderr_reader = std::thread::spawn(move || -> Vec<u8> {
        let mut buf = Vec::new();
        if let Some(stderr) = stderr_pipe {
            // As much of what Git said as its output may hold, so the last lines a refusal quotes are there.
            let limit = max_buffer.unwrap_or(16 * 1024) as u64;
            let _ = stderr.take(limit).read_to_end(&mut buf);
        }
        buf
    });

    let mut timed_out = false;
    // When a command stopped at its deadline settles: Node's runner gives it two seconds from the stop (`spawnCommand`).
    let mut settle_by = deadline;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Ok(st),
            Ok(None) => {
                if Instant::now() >= deadline {
                    timed_out = true;
                    settle_by = Instant::now() + TIMEOUT_GRACE;
                    break stop_at_deadline(&mut child, stop, settle_by);
                }
                if reader.is_finished() {
                    // Reader stopped early (e.g., max_buffer overflow); kill if still running.
                    let _ = child.kill();
                    break child.wait();
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(e) => break Err(e),
        }
    };
    if timed_out {
        // A hook or a remote helper the command started can hold its pipes open after it is gone, so a timeout settles on
        // its own grace, as Node's runner does (`spawnCommand`), rather than wait for a close a grandchild may never allow.
        while !(reader.is_finished() && stderr_reader.is_finished()) && Instant::now() < settle_by {
            std::thread::sleep(Duration::from_millis(15));
        }
        return Err(GitRunError::Failed("git timed out".into()));
    }
    let (buf, overflowed) = reader.join().unwrap_or_default();
    let stderr_buf = stderr_reader.join().unwrap_or_default();
    let status =
        status.map_err(|e| GitRunError::Failed(format!("Could not wait for git: {e}")))?;
    let stdout_str = String::from_utf8_lossy(&buf).into_owned();
    if overflowed {
        return Err(GitRunError::MaxBuffer(stdout_str));
    }
    if !status.success() {
        let stderr_str = String::from_utf8_lossy(&stderr_buf).trim().to_string();
        let msg = if stderr_str.is_empty() {
            format!("git exited with status {status}")
        } else {
            stderr_str
        };
        return Err(GitRunError::Failed(msg));
    }
    Ok(GitRunOutput { stdout: stdout_str })
}

/// Git as Node's `runWorktreeGitProcess` (`src/main/agents/threadWorktrees.ts`) runs it for a thread's own worktree:
/// `LC_ALL=C` with nothing that redirects Git, at most 2,000,000 bytes back, and Node's deadline, which is 30 seconds
/// unless `deadline` says otherwise (`None` for a removal, which Node never stops). Failures are in Node's words.
pub(crate) fn run_worktree_git(folder: &str, args: &[&str], deadline: Option<Duration>) -> Result<String, String> {
    // Node gives a removal no deadline at all; a day stands for none.
    let deadline = Instant::now() + deadline.unwrap_or(Duration::from_secs(86_400));
    run_git_impl(folder, args, &[], None, Some(2_000_000), false, deadline, TimeoutStop::Kill).map(|o| o.stdout).map_err(|e| match e {
        GitRunError::Unavailable(_) => "Git is unavailable. Install Git or explicitly choose a shared working copy.".into(),
        GitRunError::MaxBuffer(_) => "Git returned too much output. Nothing was removed.".into(),
        GitRunError::Failed(msg) if msg == "git timed out" => "Git took too long.".into(),
        GitRunError::Failed(msg) if msg.starts_with("git exited with status") => "Git could not finish this action.".into(),
        GitRunError::Failed(msg) => msg,
    })
}

/// What Node's runner says when Git itself is missing (`GitUnavailableError`).
pub(crate) const GIT_MISSING: &str = "git is not installed or is not on PATH.";

/// Git as Node's `runGitStatusCommand` (`src/main/agents/git/gitStatus.ts`) runs it for a Git action: `LC_ALL=C` with
/// nothing that redirects Git, at most 8,000,000 bytes back, stopped at `deadline` with SIGTERM so Git can remove its
/// locks, and failing in Node's words: what Git said on its error stream, or that it exited, did not finish or is missing.
pub(crate) fn run_action_git(folder: &str, args: &[&str], deadline: Duration) -> Result<String, String> {
    run_git_impl(folder, args, &[], None, Some(8_000_000), false, Instant::now() + deadline, TimeoutStop::Terminate).map(|o| o.stdout).map_err(|e| match e {
        GitRunError::Unavailable(_) => GIT_MISSING.into(),
        GitRunError::MaxBuffer(_) => "git output exceeded buffer limit".into(),
        GitRunError::Failed(msg) if msg == "git timed out" => "git did not finish in time.".into(),
        GitRunError::Failed(msg) => match msg.strip_prefix("git exited with status ") {
            // `ExitStatus` says "exit code: 1" on Windows and "exit status: 1" elsewhere; a signal has no code.
            Some(status) => match status.rsplit_once(": ").map(|(_, code)| code).filter(|code| code.parse::<i64>().is_ok()) {
                Some(code) if !status.starts_with("signal") => format!("git exited with {code}."),
                _ => "git exited with a signal.".into(),
            },
            None => msg,
        },
    })
}

fn run_git(folder: &str, args: &[&str]) -> Result<String, String> {
    run_git_clean(folder, args, &[], None, None)
        .map(|o| o.stdout)
        .map_err(|e| match e {
            GitRunError::Unavailable(msg) => msg,
            GitRunError::MaxBuffer(_) => "git output exceeded buffer limit".into(),
            GitRunError::Failed(msg) => msg,
        })
}

#[cfg(test)]
mod tests {
    /// `fileRelativePathSchema` (`src/shared/files.ts`) refuses the superscript device names Windows keeps, as a whole
    /// name or before an ending.
    #[test]
    fn refuses_the_superscript_device_names_as_files_ts_does() {
        for path in ["com¹", "com²", "com³", "lpt¹", "lpt²", "lpt³", "COM¹.txt", "docs/lpt³.md"] {
            assert!(!super::is_valid_relative_path(path), "{path}");
        }
        assert!(super::is_valid_relative_path("com¹x.txt"));
        assert!(super::is_valid_relative_path("docs/com10"));
    }

    use super::*;

    /// A thread store as Node and this host share it, holding `rows` of one thread: role, text, attachments.
    fn store_with(rows: &[(&str, &str, Option<&str>)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        drop(crate::stores::ThreadStore::open(&dir.path().join("threads.sqlite")).unwrap());
        let conn = rusqlite::Connection::open(dir.path().join("threads.sqlite")).unwrap();
        for (position, (role, text, attachments)) in rows.iter().enumerate() {
            conn.execute(
                "INSERT INTO messages (thread_id, position, message_id, role, text, created_at, attachments) VALUES ('t', ?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![position as i64, format!("m{position}"), role, text, format!("2026-11-25T10:00:{position:02}.000Z"), attachments],
            )
            .unwrap();
        }
        dir
    }

    /// The prompts above a window, as Node's `promptsBefore` reads them (ADR-0109): the user's messages before the one
    /// named, oldest first, each with its turn's last reply with words, never a wake-up or what answers it.
    #[test]
    fn reads_the_prompts_before_a_message_as_node_does() {
        let dir = store_with(&[
            ("user", "First", Some(r#"[{"id":"a"},{"id":"b"}]"#)),
            ("assistant", "Thinking", None),
            ("assistant", "Done first", None),
            ("user", "Wake up", None),
            ("assistant", "Woke", None),
            ("user", "Second", None),
            ("assistant", "  \n ", None),
            ("user", "Third", None),
        ]);
        let conn = rusqlite::Connection::open(dir.path().join("threads.sqlite")).unwrap();
        conn.execute("INSERT INTO wake_ups (thread_id, message_id) VALUES ('t', 'm3')", []).unwrap();
        let read = thread_prompts(dir.path(), "t", "m7").unwrap();
        assert_eq!(read, json!({ "prompts": [
            { "id": "m0", "createdAt": "2026-11-25T10:00:00.000Z", "text": "First", "attachments": 2, "reply": { "id": "m2", "text": "Done first" } },
            { "id": "m5", "createdAt": "2026-11-25T10:00:05.000Z", "text": "Second" },
        ] }));
        assert_eq!(thread_prompts(dir.path(), "t", "not-held").unwrap(), json!({ "prompts": [] }));
        assert_eq!(thread_prompts(dir.path(), "t", "m0").unwrap(), json!({ "prompts": [] }));
        assert!(thread_prompts(&dir.path().join("nowhere"), "t", "m7").is_none(), "a store that cannot answer says so");
    }

    /// A page holds the newest `THREAD_PROMPTS_MOST` messages the user sent, and names the message the next page is read
    /// before; the next page reaches the first and names none. An attachments list the store cannot read answers nothing.
    #[test]
    fn reads_a_long_history_a_page_at_a_time() {
        let rows: Vec<(&str, &str, Option<&str>)> = (0..=THREAD_PROMPTS_MOST + 1).map(|_| ("user", "Prompt", None)).collect();
        let dir = store_with(&rows);
        let last = format!("m{}", THREAD_PROMPTS_MOST + 1);
        let page = thread_prompts(dir.path(), "t", &last).unwrap();
        assert_eq!(page["prompts"].as_array().unwrap().len(), THREAD_PROMPTS_MOST);
        assert_eq!(page["prompts"][0]["id"], "m1");
        assert_eq!(page["next"], "m1");
        let rest = thread_prompts(dir.path(), "t", "m1").unwrap();
        assert_eq!(rest, json!({ "prompts": [{ "id": "m0", "createdAt": "2026-11-25T10:00:00.000Z", "text": "Prompt" }] }));

        let broken = store_with(&[("user", "Prompt", Some("not json")), ("user", "Next", None)]);
        assert!(thread_prompts(broken.path(), "t", "m1").is_none());
    }

    #[test]
    fn a_long_message_and_reply_are_cut_as_node_cuts_them() {
        let long_reply = format!("{}\n\n{}", "h".repeat(500), "t".repeat(700));
        let dir = store_with(&[("user", &"x".repeat(450), None), ("assistant", &long_reply, None), ("user", "Next", None)]);
        let read = thread_prompts(dir.path(), "t", "m2").unwrap();
        let prompt = &read["prompts"][0];
        assert_eq!(prompt["text"].as_str().unwrap().len(), THREAD_PROMPT_TEXT);
        assert_eq!(prompt["reply"]["text"], format!("{}\n\n{}", "h".repeat(300), "t".repeat(300)));
        // A short reply is whole; the low half of a wide character cut at the tail's start never stands alone.
        assert_eq!(prompt_reply_text("Short", None), "Short");
        let tail = format!("{}{}", "\u{1F600}", "b".repeat(299));
        assert_eq!(prompt_reply_text("a", Some(&tail)), format!("a\n\n{}", "b".repeat(299)));
    }

    #[test]
    fn thread_files_and_preview_enforce_root_containment_and_size_bounds() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("src");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("hello.txt"), "Hello from Sotto").unwrap();
        fs::write(sub.join("huge.txt"), vec![b'a'; MAX_TEXT_PREVIEW_BYTES + 16]).unwrap();

        let ws = ThreadWorkspace::build("t1", "p1", &dir.path().to_string_lossy());
        let listed = thread_files(&ws, "src");
        assert_eq!(listed["ok"], true);
        assert_eq!(listed["value"]["entries"][0]["name"], "hello.txt");

        let preview = thread_file_preview(&ws, "src/hello.txt");
        assert_eq!(preview["ok"], true);
        assert_eq!(preview["value"]["content"]["text"], "Hello from Sotto");

        // Oversized text preview must be refused with too-large before allocating unbounded memory.
        let huge = thread_file_preview(&ws, "src/huge.txt");
        assert_eq!(huge["ok"], false);
        assert_eq!(huge["error"]["code"], "too-large");

        // Escape attempts must be refused.
        let escaped = thread_file_preview(&ws, "../outside.txt");
        assert_eq!(escaped["ok"], false);
    }

    #[test]
    fn host_facts_matches_host_machine_report_schema() {
        let report = host_facts(2);
        assert_eq!(report["runningThreads"], 2);
        assert!(report["facts"]["observedAt"].is_string());
        assert!(report["facts"]["logicalCpuCount"].as_u64().unwrap() >= 1);
    }

    #[test]
    fn thread_changes_review_rejects_git_option_injection_in_base() {
        assert!(!is_valid_git_base_ref("--output=/tmp/pwn"));
        assert!(!is_valid_git_base_ref("-n"));
        assert!(!is_valid_git_base_ref("main..HEAD"));
        assert!(!is_valid_git_base_ref("main@{0}"));
        assert!(is_valid_git_base_ref("origin/main"));

        let dir = tempfile::tempdir().unwrap();
        let ws = ThreadWorkspace::build("t1", "p1", &dir.path().to_string_lossy());
        let res = thread_changes_review(
            &ws,
            &json!({ "kind": "branch", "base": "--output=/tmp/evil" }),
            false,
        );
        assert_eq!(res["ok"], false);
        assert!(matches!(
            res["error"]["code"].as_str(),
            Some("invalid-request" | "not-repository")
        ));
    }

    #[test]
    fn build_word_quote_handles_expanding_unicode_lowercase_without_panicking() {
        // Turkish capital dotted I (`İ`) expands to two Unicode scalar values (`i\u{307}`) when lowercased.
        let text = format!("{} target word here", "İ".repeat(100));
        let quote = build_word_quote(&text, "target");
        assert!(quote.contains("target word here"));
        assert!(quote.encode_utf16().count() <= 182);
    }

    #[test]
    fn reads_real_subagent_pages_with_parent_inclusion_and_assignments_pagination() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("subagents.sqlite");
        let _store = crate::stores::SubagentStore::open(&db_path).unwrap();
        let conn = crate::stores::open_sqlite(&db_path).unwrap();

        let summary = json!({
            "total": 2,
            "working": 1,
            "completed": 1,
            "failed": 0,
            "interrupted": 0,
            "unknown": 0,
        });
        conn.execute(
            "INSERT INTO subagent_threads (thread_id, value) VALUES (?1, ?2)",
            rusqlite::params![
                "t-sub",
                json!({ "revision": 7, "sequence": 52, "summary": summary }).to_string()
            ],
        )
        .unwrap();

        // Sequence 1 is a workflow parent; sequences 2..=52 are children (51 children -> page size 50 splits parent off!).
        let parent_row = json!({
            "id": "wf-1",
            "sequence": 1,
            "revision": 1,
            "assignmentId": "wf-1:initial",
            "assignmentCount": 1,
            "title": "Workflow",
            "description": "Parent workflow",
            "status": "running",
            "lastObservedAt": "2026-11-22T00:00:00.000Z",
            "kind": "workflow",
        });
        conn.execute(
            "INSERT INTO subagent_rows (thread_id, agent_id, sequence, status, value) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params!["t-sub", "wf-1", 1i64, "running", parent_row.to_string()],
        )
        .unwrap();
        for seq in 2..=52i64 {
            let aid = format!("agent-{seq}");
            let row = json!({
                "id": aid,
                "parentId": "wf-1",
                "sequence": seq,
                "revision": 1,
                "assignmentId": format!("{aid}:a1"),
                "assignmentCount": 1,
                "title": format!("Agent {seq}"),
                "description": "Worker task",
                "status": if seq == 52 { "running" } else { "completed" },
                "lastObservedAt": "2026-11-22T00:01:00.000Z",
            });
            conn.execute(
                "INSERT INTO subagent_rows (thread_id, agent_id, sequence, status, value) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params!["t-sub", aid, seq, row["status"].as_str().unwrap(), row.to_string()],
            )
            .unwrap();
        }

        // Insert 12 assignments for agent-52 to test newest-first paging (page size 10).
        for seq in 1..=12i64 {
            let asgn_id = format!("asgn-{seq}");
            let asgn = json!({
                "id": asgn_id,
                "sequence": seq,
                "title": format!("Task {seq}"),
                "status": "completed",
                "prompt": format!("Prompt {seq}"),
                "result": format!("Result {seq}"),
            });
            conn.execute(
                "INSERT INTO subagent_assignments (thread_id, agent_id, assignment_id, sequence, value, fingerprint, observed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    "t-sub",
                    "agent-52",
                    asgn_id,
                    seq,
                    asgn.to_string(),
                    "fp",
                    "2026-11-22T00:01:00.000Z",
                ],
            )
            .unwrap();
        }
        drop(conn);

        let page1 = read_subagent_page(dir.path(), "t-sub", None);
        assert_eq!(page1["revision"], 7);
        assert_eq!(page1["summary"]["total"], 2);
        // Stored `running` rows from a stopped Node host map to `unknown` on the read-only Rust host.
        assert_eq!(page1["summary"]["working"], 0);
        assert_eq!(page1["summary"]["unknown"], 1);
        assert_eq!(page1["before"], 3);
        let rows = page1["rows"].as_array().unwrap();
        // 50 rows (seq 3..=52) + workflow parent (seq 1) brought along, sorted ascending by sequence.
        assert_eq!(rows.len(), 51);
        assert_eq!(rows[0]["id"], "wf-1");
        assert_eq!(rows[0]["status"], "unknown");
        assert_eq!(rows[1]["sequence"], 3);
        assert_eq!(rows.last().unwrap()["sequence"], 52);
        assert_eq!(rows.last().unwrap()["status"], "unknown");

        let page2 = read_subagent_page(dir.path(), "t-sub", Some(3));
        assert!(page2.get("before").is_none());
        let rows2 = page2["rows"].as_array().unwrap();
        assert_eq!(rows2.len(), 2);
        assert_eq!(rows2[0]["sequence"], 1);
        assert_eq!(rows2[1]["sequence"], 2);

        let asgn_page1 = read_subagent_assignments(dir.path(), "t-sub", "agent-52", None);
        let a1 = asgn_page1["assignments"].as_array().unwrap();
        assert_eq!(a1.len(), 10);
        assert_eq!(a1[0]["sequence"], 12);
        assert_eq!(a1[9]["sequence"], 3);
        assert_eq!(asgn_page1["before"], 3);

        let asgn_page2 = read_subagent_assignments(dir.path(), "t-sub", "agent-52", Some(3));
        let a2 = asgn_page2["assignments"].as_array().unwrap();
        assert_eq!(a2.len(), 2);
        assert_eq!(a2[0]["sequence"], 2);
        assert_eq!(a2[1]["sequence"], 1);
        assert!(asgn_page2.get("before").is_none());
    }

    #[test]
    fn git_changed_files_matches_porcelain_v2_sorting_and_untracked_line_counts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let status = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "Test")
                .env("GIT_AUTHOR_EMAIL", "test@example.com")
                .env("GIT_COMMITTER_NAME", "Test")
                .env("GIT_COMMITTER_EMAIL", "test@example.com")
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?} failed");
        };

        // Non-repo returns isRepository: false.
        let non_repo = git_changed_files(&root.to_string_lossy()).unwrap();
        assert_eq!(non_repo["isRepository"], false);

        git(&["init", "-b", "main"]);
        fs::write(root.join("z.txt"), "one\ntwo\n").unwrap();
        fs::write(root.join("old.txt"), "alpha\nbeta\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "init"]);

        // Modify z.txt, rename old.txt -> m.txt, add untracked a.txt (3 lines) and binary b.bin.
        fs::write(root.join("z.txt"), "one\ntwo\nthree\n").unwrap();
        git(&["mv", "old.txt", "m.txt"]);
        fs::write(root.join("a.txt"), "l1\nl2\nl3").unwrap();
        fs::write(root.join("b.bin"), [0u8, 1, 2, 3]).unwrap();

        let res = git_changed_files(&root.to_string_lossy()).unwrap();
        assert_eq!(res["isRepository"], true);
        assert_eq!(res["truncated"], false);
        let files = res["files"].as_array().unwrap();
        let paths: Vec<&str> = files
            .iter()
            .map(|f| f["path"].as_str().unwrap())
            .collect();
        assert_eq!(paths, vec!["a.txt", "b.bin", "m.txt", "z.txt"]);
        assert_eq!(files[0]["status"], "untracked");
        assert_eq!(files[0]["insertions"], 3);
        assert_eq!(files[0]["deletions"], 0);
        assert_eq!(files[1]["status"], "untracked");
        assert!(files[1]["insertions"].is_null());
        assert_eq!(files[2]["status"], "renamed");
        assert_eq!(files[2]["originalPath"], "old.txt");
        assert_eq!(files[3]["status"], "modified");
        assert_eq!(files[3]["insertions"], 1);
        assert_eq!(files[3]["deletions"], 0);
    }

    #[test]
    fn git_changed_files_handles_untracked_symlinks_utf16_sort_and_budget_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let status = Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "Test")
                .env("GIT_AUTHOR_EMAIL", "test@example.com")
                .env("GIT_COMMITTER_NAME", "Test")
                .env("GIT_COMMITTER_EMAIL", "test@example.com")
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?} failed");
        };

        git(&["init", "-b", "main"]);
        fs::write(root.join("init.txt"), "ok\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "init"]);

        // L1: Untracked symlink to /dev/zero must never OOM or read unbounded bytes.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/dev/zero", root.join("zero-link")).unwrap();
        }
        // N5: Astral character (UTF-16 surrogate 0xD83D) sorts BEFORE U+FF21 in JS `<`/`>`
        // (and U+FF21 is an assigned Unicode code point accepted by macOS APFS, unlike U+FF00).
        let astral_name = "\u{1F600}.txt";
        let high_bmp_name = "\u{FF21}.txt";
        fs::write(root.join(astral_name), "a\n").unwrap();
        fs::write(root.join(high_bmp_name), "b\n").unwrap();

        let res = git_changed_files(&root.to_string_lossy()).unwrap();
        assert_eq!(res["isRepository"], true);
        let files = res["files"].as_array().unwrap();
        #[cfg(unix)]
        {
            let link_entry = files
                .iter()
                .find(|f| f["path"] == "zero-link")
                .expect("expected untracked symlink entry");
            assert!(link_entry["insertions"].is_null());
            assert!(link_entry["deletions"].is_null());
        }
        let astral_idx = files
            .iter()
            .position(|f| f["path"] == astral_name)
            .expect("expected astral filename");
        let high_bmp_idx = files
            .iter()
            .position(|f| f["path"] == high_bmp_name)
            .expect("expected high BMP filename");
        assert!(
            astral_idx < high_bmp_idx,
            "UTF-16 sort must place U+1F600 before U+FF21 matching JS"
        );

        // L3: Zero budget aborts immediately with timeout error.
        let timed = git_changed_files_with_budget(&root.to_string_lossy(), Duration::from_millis(0));
        assert!(timed.is_err());
        assert!(timed.unwrap_err().contains("timed out"));
    }
}
