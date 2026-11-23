use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::workspace::now_iso;
pub use crate::usage_ops::{
    canonical_model_id, filter_usage_read_for_peer, parse_usage_time_zone, usage_clear,
    usage_exclusion_hash, usage_read, usage_refresh, UsageReadQuery, USAGE_LIMIT_PROVIDERS,
    USAGE_PROVIDERS,
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
    if path.len() > 4_096 {
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
        ) {
            return false;
        }
    }
    true
}

/// Lists branches for a thread's working copy matching `gitRefsPageSchema` (`src/shared/gitRefs.ts`).
pub fn git_refs(
    folder: &str,
    query: Option<&str>,
    cursor: Option<usize>,
    limit: Option<usize>,
    include_matching_remote: bool,
) -> Result<Value, String> {
    let is_repo = run_git(folder, &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s.trim() == "true")
        .unwrap_or(false);
    if !is_repo {
        return Ok(json!({
            "refs": [],
            "isRepository": false,
            "hasRemote": false,
            "nextCursor": null,
            "total": 0,
        }));
    }

    let current_branch = run_git(folder, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD");
    let remotes_raw = run_git(folder, &["remote"]).unwrap_or_default();
    let has_remote = remotes_raw.lines().any(|l| !l.trim().is_empty());
    let origin_head = run_git(folder, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .and_then(|s| s.strip_prefix("origin/").map(ToString::to_string));

    let local_raw = run_git(folder, &["branch", "--format=%(refname:short)"]).unwrap_or_default();
    let mut local_names = Vec::new();
    let mut local_set = std::collections::HashSet::new();
    for line in local_raw.lines() {
        let name = line.trim();
        if !name.is_empty() {
            local_names.push(name.to_string());
            local_set.insert(name.to_string());
        }
    }

    let default_branch = origin_head
        .or_else(|| {
            if local_set.contains("main") {
                Some("main".into())
            } else if local_set.contains("master") {
                Some("master".into())
            } else {
                None
            }
        });

    let mut all_refs = Vec::new();
    for name in &local_names {
        let is_current = current_branch.as_deref() == Some(name.as_str());
        let is_default = default_branch.as_deref() == Some(name.as_str());
        all_refs.push(json!({
            "name": name,
            "current": is_current,
            "isDefault": is_default,
            "worktreePath": null,
        }));
    }

    if has_remote {
        let remote_raw =
            run_git(folder, &["branch", "-r", "--format=%(refname:short)"]).unwrap_or_default();
        for line in remote_raw.lines() {
            let name = line.trim();
            if name.is_empty() || name.ends_with("/HEAD") {
                continue;
            }
            let Some((remote, branch_name)) = name.split_once('/') else {
                continue;
            };
            if !include_matching_remote && local_set.contains(branch_name) {
                continue;
            }
            all_refs.push(json!({
                "name": name,
                "remote": remote,
                "current": false,
                "isDefault": false,
                "worktreePath": null,
            }));
        }
    }

    if let Some(q) = query.map(str::trim).filter(|q| !q.is_empty()) {
        let needle = q.to_ascii_lowercase();
        all_refs.retain(|r| {
            r.get("name")
                .and_then(Value::as_str)
                .map(|n| n.to_ascii_lowercase().contains(&needle))
                .unwrap_or(false)
        });
    }

    let total = all_refs.len();
    let start = cursor.unwrap_or(0).min(total);
    let page_limit = limit.unwrap_or(GIT_REFS_MAX_LIMIT).clamp(1, GIT_REFS_MAX_LIMIT);
    let end = (start + page_limit).min(total);
    let next_cursor = if end < total { Some(end) } else { None };
    let page: Vec<Value> = all_refs.into_iter().skip(start).take(page_limit).collect();

    Ok(json!({
        "refs": page,
        "isRepository": true,
        "hasRemote": has_remote,
        "nextCursor": next_cursor,
        "total": total,
    }))
}

/// Lists changed files in a git working tree matching `gitChangedFilesSchema` (`src/shared/gitChangedFiles.ts`).
pub fn git_changed_files(folder: &str) -> Result<Value, String> {
    let is_repo = run_git(folder, &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s.trim() == "true")
        .unwrap_or(false);
    if !is_repo {
        return Ok(json!({
            "isRepository": false,
            "files": [],
            "truncated": false,
        }));
    }
    let raw = run_git(folder, &["status", "--porcelain=v1"])?;
    let numstat = run_git(folder, &["diff", "HEAD", "--numstat"]).unwrap_or_default();
    let mut stats: HashMap<String, (Option<u64>, Option<u64>)> = HashMap::new();
    for line in numstat.lines() {
        let mut parts = line.split('\t');
        let ins = parts.next().and_then(|s| s.parse::<u64>().ok());
        let del = parts.next().and_then(|s| s.parse::<u64>().ok());
        if let Some(p) = parts.next() {
            stats.insert(p.replace('\\', "/"), (ins, del));
        }
    }

    let mut files = Vec::new();
    let mut truncated = false;
    for line in raw.lines() {
        if line.len() < 4 {
            continue;
        }
        if files.len() >= MAX_GIT_FILES {
            truncated = true;
            break;
        }
        let code = &line[..2];
        let raw_path = line[3..].trim();
        let (path, original_path) = if let Some((orig, new_p)) = raw_path.split_once(" -> ") {
            (
                new_p.trim_matches('"').replace('\\', "/"),
                Some(orig.trim_matches('"').replace('\\', "/")),
            )
        } else {
            (raw_path.trim_matches('"').replace('\\', "/"), None)
        };
        let status = porcelain_status(code);
        let (ins, del) = stats.get(&path).copied().unwrap_or((None, None));
        let mut entry = json!({
            "path": path,
            "status": status,
            "insertions": ins,
            "deletions": del,
        });
        if let Some(orig) = original_path {
            entry["originalPath"] = json!(orig);
        }
        files.push(entry);
    }

    Ok(json!({
        "isRepository": true,
        "files": files,
        "truncated": truncated,
    }))
}

fn porcelain_status(code: &str) -> &'static str {
    let trimmed = code.trim();
    if trimmed == "??" {
        "untracked"
    } else if code.contains('U') || trimmed == "AA" || trimmed == "DD" {
        "conflicted"
    } else if code.contains('R') {
        "renamed"
    } else if code.contains('T') {
        "type-changed"
    } else if code.contains('D') {
        "deleted"
    } else if code.contains('A') {
        "added"
    } else {
        "modified"
    }
}

/// Returns git working-tree changes wrapped in `ToolsResult<GitChangeListing>` (`src/shared/gitChanges.ts`).
pub fn thread_changes(workspace: &ThreadWorkspace) -> Value {
    let folder = &workspace.working_directory;
    let is_repo = run_git(folder, &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s.trim() == "true")
        .unwrap_or(false);
    if !is_repo {
        return tools_err("not-repository", "This folder is not a Git repository.");
    }
    let branch = run_git(folder, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD");
    let head = run_git(folder, &["rev-parse", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let Ok(raw) = run_git(folder, &["status", "--porcelain=v1"]) else {
        return tools_err("unavailable", "Could not read Git status for this folder.");
    };
    let mut files = Vec::new();
    let mut truncated = false;
    for line in raw.lines() {
        if line.len() < 4 {
            continue;
        }
        if files.len() >= MAX_GIT_FILES {
            truncated = true;
            break;
        }
        let code = &line[..2];
        let raw_path = line[3..].trim();
        let (path, original_path) = if let Some((orig, new_p)) = raw_path.split_once(" -> ") {
            (
                new_p.trim_matches('"').replace('\\', "/"),
                Some(orig.trim_matches('"').replace('\\', "/")),
            )
        } else {
            (raw_path.trim_matches('"').replace('\\', "/"), None)
        };
        if !is_valid_relative_path(&path) {
            continue;
        }
        let mut entry = json!({
            "path": path,
            "status": porcelain_status(code),
        });
        if let Some(orig) = original_path.filter(|p| is_valid_relative_path(p)) {
            entry["originalPath"] = json!(orig);
        }
        files.push(entry);
    }
    let revision = compute_workspace_id(&head, &raw, folder);
    tools_ok(json!({
        "workspace": workspace,
        "branch": branch,
        "revision": revision,
        "files": files,
        "truncated": truncated,
    }))
}

/// Returns a bounded Git comparison wrapped in `ToolsResult<GitReview>` (`src/shared/gitChanges.ts`).
pub fn thread_changes_review(
    workspace: &ThreadWorkspace,
    scope: &Value,
    ignore_whitespace: bool,
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
    } else {
        None
    };

    let folder = &workspace.working_directory;
    let is_repo = run_git(folder, &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s.trim() == "true")
        .unwrap_or(false);
    if !is_repo {
        return tools_err("not-repository", "This folder is not a Git repository.");
    }
    let head_branch = run_git(folder, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD");
    let head_sha = run_git(folder, &["rev-parse", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    let (resolved_scope, diff_range) = if scope_kind == "branch" {
        let automatic = requested_base.is_none();
        let base = requested_base.or_else(|| {
            run_git(folder, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| is_valid_git_base_ref(s))
        });
        let verified_base = base.filter(|b| {
            let commit_spec = format!("{b}^{{commit}}");
            run_git(folder, &["rev-parse", "--verify", "--end-of-options", &commit_spec]).is_ok()
        });
        let range = verified_base.as_ref().map(|b| format!("{b}...HEAD"));
        (
            json!({
                "kind": "branch",
                "base": verified_base,
                "automatic": automatic,
                "head": head_branch,
            }),
            range,
        )
    } else {
        (json!({ "kind": "working" }), None)
    };

    if scope_kind == "branch" && diff_range.is_none() {
        let revision = compute_workspace_id(&head_sha, "branch:none", folder);
        return tools_ok(json!({
            "workspace": workspace,
            "revision": revision,
            "scope": resolved_scope,
            "files": [],
            "truncated": false,
        }));
    }

    let mut numstat_args = vec!["diff", "--numstat"];
    if ignore_whitespace {
        numstat_args.push("-w");
    }
    let range_str;
    if let Some(ref r) = diff_range {
        range_str = r.clone();
        numstat_args.push(&range_str);
    } else if !head_sha.is_empty() {
        numstat_args.push("HEAD");
    }

    let numstat = run_git(folder, &numstat_args).unwrap_or_default();
    let mut files = Vec::new();
    let mut total_patch_bytes = 0usize;
    let mut truncated = false;

    for line in numstat.lines() {
        if files.len() >= MAX_GIT_FILES {
            truncated = true;
            break;
        }
        let mut parts = line.split('\t');
        let Some(ins_raw) = parts.next() else { continue };
        let Some(del_raw) = parts.next() else { continue };
        let Some(path_raw) = parts.next() else { continue };
        let path = path_raw.replace('\\', "/");
        if !is_valid_relative_path(&path) {
            continue;
        }
        let is_binary = ins_raw == "-" || del_raw == "-";
        let additions = ins_raw.parse::<u64>().ok();
        let deletions = del_raw.parse::<u64>().ok();

        let content = if is_binary {
            json!({ "kind": "binary", "message": "Binary file changes are not shown as text." })
        } else if total_patch_bytes >= MAX_GIT_REVIEW_BYTES {
            truncated = true;
            json!({ "kind": "too-large", "message": "The comparison reached the 2 MiB patch limit." })
        } else {
            let mut p_args = vec!["diff"];
            if ignore_whitespace {
                p_args.push("-w");
            }
            if let Some(ref r) = diff_range {
                p_args.push(r.as_str());
            } else if !head_sha.is_empty() {
                p_args.push("HEAD");
            }
            p_args.push("--");
            p_args.push(path.as_str());
            match run_git(folder, &p_args) {
                Ok(patch) if patch.len() > MAX_GIT_PATCH_BYTES => {
                    json!({ "kind": "too-large", "message": "This patch is larger than 512 KiB." })
                }
                Ok(patch) => {
                    total_patch_bytes = total_patch_bytes.saturating_add(patch.len());
                    json!({ "kind": "text", "patch": patch })
                }
                Err(_) => json!({ "kind": "unavailable", "message": "Could not read this file's patch." }),
            }
        };

        files.push(json!({
            "path": path,
            "status": "modified",
            "additions": additions,
            "deletions": deletions,
            "content": content,
        }));
    }

    let revision = compute_workspace_id(&head_sha, &numstat, folder);
    tools_ok(json!({
        "workspace": workspace,
        "revision": revision,
        "scope": resolved_scope,
        "files": files,
        "truncated": truncated,
    }))
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
/// returning `ToolsResult<FileListing>` (`src/shared/files.ts`).
pub fn thread_files(workspace: &ThreadWorkspace, rel_path: &str) -> Value {
    if !is_valid_relative_path(rel_path) {
        return tools_err("invalid-request", "Use a relative workspace path.");
    }
    let root = Path::new(&workspace.working_directory);
    let Ok(canon_root) = fs::canonicalize(root) else {
        return tools_err("workspace-unavailable", "This thread's folder is unavailable.");
    };
    let Ok(target) = resolve_contained(&canon_root, rel_path) else {
        return tools_err("path-unavailable", "That path is outside this thread's folder.");
    };
    let Ok(rd) = fs::read_dir(&target) else {
        return tools_err("path-unavailable", "Could not read that folder.");
    };
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" || name == "node_modules" || name == "target" {
            continue;
        }
        if entries.len() >= MAX_FILE_ENTRIES {
            truncated = true;
            break;
        }
        let rel = if rel_path.is_empty() {
            name.clone()
        } else {
            format!("{rel_path}/{name}")
        };
        if !is_valid_relative_path(&rel) {
            entries.push(json!({
                "name": name,
                "path": rel,
                "kind": "unavailable",
            }));
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            entries.push(json!({
                "name": name,
                "path": rel,
                "kind": "unavailable",
            }));
            continue;
        };
        entries.push(json!({
            "name": name,
            "path": rel,
            "kind": if meta.is_dir() { "directory" } else { "file" },
        }));
    }
    entries.sort_by(|a, b| {
        let dir_a = a["kind"] != "directory";
        let dir_b = b["kind"] != "directory";
        dir_a
            .cmp(&dir_b)
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    tools_ok(json!({
        "workspace": workspace,
        "path": rel_path,
        "entries": entries,
        "truncated": truncated,
    }))
}

/// Reads a bounded preview strictly contained within `workspace.working_directory`,
/// checking file metadata size before reading and bounding every read with `Read::take`,
/// returning `ToolsResult<FilePreview>` (`src/shared/files.ts`).
pub fn thread_file_preview(workspace: &ThreadWorkspace, rel_path: &str) -> Value {
    if rel_path.is_empty() || !is_valid_relative_path(rel_path) {
        return tools_err("invalid-request", "Use a relative workspace file path.");
    }
    let root = Path::new(&workspace.working_directory);
    let Ok(canon_root) = fs::canonicalize(root) else {
        return tools_err("workspace-unavailable", "This thread's folder is unavailable.");
    };
    let Ok(target) = resolve_contained(&canon_root, rel_path) else {
        return tools_err("path-unavailable", "That path is outside this thread's folder.");
    };
    let Ok(meta) = fs::metadata(&target) else {
        return tools_err("path-unavailable", "File not found.");
    };
    if !meta.is_file() {
        return tools_err("path-unavailable", "Path is not a file.");
    }
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| rel_path.to_string());
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let image_mime = match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    };

    if let Some(mime) = image_mime {
        if meta.len() > MAX_IMAGE_PREVIEW_BYTES as u64 {
            return tools_err("too-large", "Image is larger than the 8 MiB preview limit.");
        }
        let Ok(bytes) = read_bounded(&target, MAX_IMAGE_PREVIEW_BYTES) else {
            return tools_err("too-large", "Image is larger than the 8 MiB preview limit.");
        };
        let data_url = format!("data:{mime};base64,{}", STANDARD.encode(&bytes));
        return tools_ok(json!({
            "workspace": workspace,
            "path": rel_path,
            "name": name,
            "size": bytes.len(),
            "content": {
                "kind": "image",
                "mime": mime,
                "dataUrl": data_url,
            },
        }));
    }

    if meta.len() > MAX_TEXT_PREVIEW_BYTES as u64 {
        return tools_err("too-large", "File is larger than the 512 KiB preview limit.");
    }
    let Ok(bytes) = read_bounded(&target, MAX_TEXT_PREVIEW_BYTES) else {
        return tools_err("too-large", "File is larger than the 512 KiB preview limit.");
    };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let content_kind = if matches!(ext.as_str(), "md" | "markdown" | "mdown") {
        "markdown"
    } else {
        "text"
    };
    tools_ok(json!({
        "workspace": workspace,
        "path": rel_path,
        "name": name,
        "size": bytes.len(),
        "content": {
            "kind": content_kind,
            "text": text,
        },
    }))
}

fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.take((limit as u64).saturating_add(1))
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.len() > limit {
        return Err("File exceeds preview limit.".into());
    }
    Ok(buf)
}

/// Reports machine facts matching `hostMachineReportSchema` (`src/shared/hostFacts.ts`).
pub fn host_facts(running_threads: usize) -> Value {
    let cpus = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    let family = match std::env::consts::OS {
        "windows" => Some("windows"),
        "macos" => Some("macos"),
        "linux" => Some("linux"),
        _ => None,
    };
    let os_name = match std::env::consts::OS {
        "windows" => Some("Windows"),
        "macos" => Some("macOS"),
        "linux" => Some("Linux"),
        _ => None,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    json!({
        "facts": {
            "observedAt": now_iso(),
            "os": {
                "family": family,
                "name": os_name,
                "version": null,
            },
            "architecture": arch,
            "totalMemoryBytes": null,
            "freeMemoryBytes": null,
            "logicalCpuCount": cpus,
        },
        "runningThreads": running_threads,
    })
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

    let db = data_directory.join("threads.sqlite");
    if !db.is_file() {
        return json!({ "found": [] });
    }
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return json!({ "found": [] });
    };
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));

    let has_wake_ups: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'wake_ups' LIMIT 1",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);

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

fn resolve_contained(canon_root: &Path, rel: &str) -> Result<PathBuf, String> {
    let trimmed = rel.trim_start_matches(['/', '\\']);
    let candidate = if trimmed.is_empty() {
        canon_root.to_path_buf()
    } else {
        canon_root.join(trimmed)
    };
    let canon_target = fs::canonicalize(&candidate).map_err(|e| e.to_string())?;
    if !canon_target.starts_with(canon_root) {
        return Err("Path escapes thread working directory.".into());
    }
    Ok(canon_target)
}

fn run_git(folder: &str, args: &[&str]) -> Result<String, String> {
    run_cmd("git", folder, args)
}

fn run_cmd(program: &str, folder: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(folder);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("Could not run {program}: {e}"))?;
    if !out.status.success() {
        return Err(format!("{program} exited with status {}", out.status));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
