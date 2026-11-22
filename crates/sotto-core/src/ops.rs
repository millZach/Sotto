use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};

use crate::stores::{SubagentStore, ThreadStore, UsageStore};

const MAX_TEXT_PREVIEW_BYTES: usize = 512 * 1024;
const MAX_IMAGE_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
const MAX_GIT_DIFF_BYTES: usize = 2 * 1024 * 1024;

/// Lists local branches, current branch, and tags for a project/worktree folder.
pub fn git_refs(folder: &str) -> Result<Value, String> {
    let head = run_git(folder, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD");
    let branches: Vec<String> = run_git(folder, &["branch", "--format=%(refname:short)"])
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(ToString::to_string)
        .collect();
    let tags: Vec<String> = run_git(folder, &["tag", "--list"])
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .take(200)
        .map(ToString::to_string)
        .collect();
    Ok(json!({
        "branch": head,
        "branches": branches,
        "tags": tags,
    }))
}

/// Lists changed files in a git working tree using `git status --porcelain=v1`.
pub fn git_changed_files(folder: &str) -> Result<Value, String> {
    let raw = run_git(folder, &["status", "--porcelain=v1"])?;
    let mut files = Vec::new();
    for line in raw.lines() {
        if line.len() < 4 {
            continue;
        }
        let code = &line[..2];
        let path = line[3..].trim();
        let staged = code.as_bytes()[0] != b' ' && code.as_bytes()[0] != b'?';
        let status = match code.trim() {
            "??" => "untracked",
            s if s.contains('D') => "deleted",
            s if s.contains('A') => "added",
            s if s.contains('R') => "renamed",
            _ => "modified",
        };
        files.push(json!({
            "path": path,
            "status": status,
            "staged": staged,
        }));
    }
    Ok(json!({ "files": files }))
}

/// Returns git working-tree changes with per-file insertion/deletion numstat counts.
pub fn git_changes(folder: &str) -> Value {
    let Ok(mut base) = git_changed_files(folder) else {
        return json!({ "ok": false, "error": "This folder is not a Git repository." });
    };
    let numstat = run_git(folder, &["diff", "--numstat"]).unwrap_or_default();
    let mut stats = std::collections::HashMap::new();
    for line in numstat.lines() {
        let mut parts = line.split('\t');
        let ins = parts.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let del = parts.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        if let Some(p) = parts.next() {
            stats.insert(p.to_string(), (ins, del));
        }
    }
    if let Some(arr) = base.get_mut("files").and_then(Value::as_array_mut) {
        for item in arr {
            if let Some(obj) = item.as_object_mut() {
                if let Some(path) = obj.get("path").and_then(Value::as_str).map(ToString::to_string) {
                    if let Some((ins, del)) = stats.get(&path) {
                        obj.insert("insertions".into(), json!(ins));
                        obj.insert("deletions".into(), json!(del));
                    }
                }
            }
        }
    }
    json!({
        "ok": true,
        "files": base["files"],
    })
}

/// Returns a bounded unified diff (up to 2 MiB) for a thread's working tree.
pub fn git_review(folder: &str) -> Value {
    let Ok(mut diff) = run_git(folder, &["diff"]) else {
        return json!({ "ok": false, "error": "Could not read Git diff for this folder." });
    };
    let truncated = diff.len() > MAX_GIT_DIFF_BYTES;
    if truncated {
        let mut end = MAX_GIT_DIFF_BYTES;
        while end > 0 && !diff.is_char_boundary(end) {
            end -= 1;
        }
        diff.truncate(end);
    }
    json!({
        "ok": true,
        "diff": diff,
        "truncated": truncated,
    })
}

/// Reads the current branch's pull request via `gh pr view`.
pub fn git_pull_request(folder: &str) -> Result<Value, String> {
    let out = run_cmd(
        "gh",
        folder,
        &[
            "pr",
            "view",
            "--json",
            "number,title,url,state,headRefName,baseRefName,headRefOid,isDraft",
        ],
    )?;
    serde_json::from_str::<Value>(&out).map_err(|e| format!("Could not parse gh pr view: {e}"))
}

/// Lists open pull requests via `gh pr list`.
pub fn git_pull_request_list(folder: &str) -> Result<Value, String> {
    let out = run_cmd(
        "gh",
        folder,
        &[
            "pr",
            "list",
            "--limit",
            "25",
            "--json",
            "number,title,url,state,headRefName,baseRefName,isDraft",
        ],
    )?;
    let list = serde_json::from_str::<Value>(&out)
        .map_err(|e| format!("Could not parse gh pr list: {e}"))?;
    Ok(json!({ "pullRequests": list }))
}

/// Lists directories inside a requested host folder (used by remote project picker).
pub fn host_folders(requested: Option<&str>, fallback: &Path) -> Result<Value, String> {
    let target = match requested.filter(|s| !s.trim().is_empty()) {
        Some(p) => PathBuf::from(p),
        None => fallback.to_path_buf(),
    };
    let canon = fs::canonicalize(&target).map_err(|e| format!("Folder unavailable: {e}"))?;
    let mut entries = Vec::new();
    let rd = fs::read_dir(&canon).map_err(|e| format!("Could not read folder: {e}"))?;
    for entry in rd.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let is_git = path.join(".git").exists();
        entries.push(json!({
            "name": name,
            "path": path.to_string_lossy(),
            "isGit": is_git,
        }));
    }
    entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    let parent = canon.parent().map(|p| p.to_string_lossy().into_owned());
    Ok(json!({
        "path": canon.to_string_lossy(),
        "parent": parent,
        "entries": entries,
    }))
}

/// Safely lists files and subdirectories inside `root/rel_path`, refusing any path outside `root`.
pub fn thread_files(root: &Path, rel_path: Option<&str>) -> Value {
    let Ok(target) = resolve_contained(root, rel_path.unwrap_or("")) else {
        return json!({ "ok": false, "error": "That path is outside this thread's folder." });
    };
    let Ok(rd) = fs::read_dir(&target) else {
        return json!({ "ok": false, "error": "Could not read that folder." });
    };
    let mut entries = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" || name == "node_modules" || name == "target" {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let rel = entry
            .path()
            .strip_prefix(fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf()))
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| name.clone());
        entries.push(json!({
            "name": name,
            "path": rel,
            "kind": if meta.is_dir() { "directory" } else { "file" },
            "sizeBytes": if meta.is_file() { meta.len() } else { 0 },
        }));
    }
    entries.sort_by(|a, b| {
        let dir_a = a["kind"] != "directory";
        let dir_b = b["kind"] != "directory";
        dir_a
            .cmp(&dir_b)
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    json!({
        "ok": true,
        "entries": entries,
    })
}

/// Reads a bounded preview (up to 512 KiB UTF-8 text or 8 MiB image) strictly contained within `root`.
pub fn thread_file_preview(root: &Path, rel_path: &str) -> Value {
    let Ok(target) = resolve_contained(root, rel_path) else {
        return json!({ "ok": false, "error": "That path is outside this thread's folder." });
    };
    let Ok(meta) = fs::metadata(&target) else {
        return json!({ "ok": false, "error": "File not found." });
    };
    if !meta.is_file() {
        return json!({ "ok": false, "error": "Path is not a file." });
    }
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
        if meta.len() as usize > MAX_IMAGE_PREVIEW_BYTES {
            return json!({ "ok": false, "error": "Image is larger than the 8 MiB preview limit." });
        }
        let Ok(bytes) = fs::read(&target) else {
            return json!({ "ok": false, "error": "Could not read image." });
        };
        return json!({
            "ok": true,
            "kind": "image",
            "mimeType": mime,
            "sizeBytes": bytes.len(),
            "data": STANDARD.encode(&bytes),
        });
    }

    let Ok(bytes) = fs::read(&target) else {
        return json!({ "ok": false, "error": "Could not read file." });
    };
    let truncated = bytes.len() > MAX_TEXT_PREVIEW_BYTES;
    let slice = if truncated {
        &bytes[..MAX_TEXT_PREVIEW_BYTES]
    } else {
        &bytes
    };
    let text = String::from_utf8_lossy(slice).into_owned();
    json!({
        "ok": true,
        "kind": "text",
        "sizeBytes": bytes.len(),
        "truncated": truncated,
        "text": text,
    })
}

/// Reports machine facts for the host (`host-facts` op).
pub fn host_facts(sotto_version: &str) -> Value {
    let cpus = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "sotto-host".into());
    json!({
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "cpus": cpus,
        "hostname": hostname,
        "runtime": "rust",
        "sottoVersion": sotto_version,
    })
}

/// Searches stored thread messages in `threads.sqlite` (`thread-words` op).
pub fn search_thread_words(data_directory: &Path, query: &str) -> Value {
    let needle = query.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return json!({ "found": [] });
    }
    let db = data_directory.join("threads.sqlite");
    let Ok(store) = ThreadStore::open(&db) else {
        return json!({ "found": [] });
    };
    let ids = store.list_thread_ids().unwrap_or_default();
    let mut found = Vec::new();
    for tid in ids {
        if let Ok(msgs) = store.read_messages(&tid) {
            if let Some(m) = msgs
                .iter()
                .rev()
                .find(|m| m.text.to_ascii_lowercase().contains(&needle))
            {
                let snippet: String = m.text.chars().take(160).collect();
                found.push(json!({
                    "threadId": tid,
                    "messageId": m.id,
                    "snippet": snippet,
                }));
            }
        }
    }
    json!({ "found": found })
}

/// Reads subagent row count and status from `subagents.sqlite`.
pub fn read_subagent_page(data_directory: &Path, thread_id: &str) -> Value {
    let db = data_directory.join("subagents.sqlite");
    let count = SubagentStore::open(&db)
        .and_then(|s| s.row_count(thread_id))
        .unwrap_or(0);
    json!({
        "threadId": thread_id,
        "totalCount": count,
        "rows": [],
    })
}

/// Reads usage dashboard metadata from `usage.sqlite`.
pub fn read_usage_summary(data_directory: &Path) -> Value {
    let db = data_directory.join("usage.sqlite");
    let meta = UsageStore::open(&db)
        .and_then(|s| s.read_meta())
        .ok()
        .flatten();
    json!({
        "meta": meta,
    })
}

fn resolve_contained(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let canon_root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let trimmed = rel.trim_start_matches(['/', '\\']);
    let candidate = if trimmed.is_empty() {
        canon_root.clone()
    } else {
        canon_root.join(trimmed)
    };
    let canon_target = fs::canonicalize(&candidate).map_err(|e| e.to_string())?;
    if !canon_target.starts_with(&canon_root) {
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
    fn thread_files_and_preview_enforce_root_containment() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("src");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("hello.txt"), "Hello from Sotto").unwrap();

        let listed = thread_files(dir.path(), Some("src"));
        assert_eq!(listed["ok"], true);
        assert_eq!(listed["entries"][0]["name"], "hello.txt");

        let preview = thread_file_preview(dir.path(), "src/hello.txt");
        assert_eq!(preview["ok"], true);
        assert_eq!(preview["text"], "Hello from Sotto");

        // Escape attempts must be refused.
        let escaped = thread_file_preview(dir.path(), "../outside.txt");
        assert_eq!(escaped["ok"], false);
    }

    #[test]
    fn host_facts_reports_rust_runtime() {
        let facts = host_facts("0.1.44-owl.20261118.2");
        assert_eq!(facts["runtime"], "rust");
        assert_eq!(facts["sottoVersion"], "0.1.44-owl.20261118.2");
        assert!(facts["cpus"].as_u64().unwrap() >= 1);
    }
}
