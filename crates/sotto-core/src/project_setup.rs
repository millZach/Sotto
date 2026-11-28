//! Setting up a copy of a project on this machine for a worker placed here (#1690, `project-setup` op).
//!
//! Mirrors `src/shared/workerMachine.ts` (`projectSetup*Schema`), `src/main/agents/projectSetup.ts` (`ProjectCopies`),
//! and `src/main/agents/mainCheckout.ts` (`checkoutBlock`, `originDefaultBranch`).

use std::collections::HashMap;
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::sync::{watch, Notify};

use crate::ops::{parse_github_remote, run_action_git_with, ActionGitExtras, GitHubRepository, GIT_ABORTED, GIT_MISSING};

const SCAN_MAX: usize = 500;
const CLONE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const MERGE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const QUICK_TIMEOUT: Duration = Duration::from_secs(30);

const IN_PROGRESS_MARKERS: &[(&str, &str)] = &[
    ("rebase-merge", "rebase"),
    ("rebase-apply", "rebase"),
    ("MERGE_HEAD", "merge"),
    ("CHERRY_PICK_HEAD", "cherry-pick"),
    ("REVERT_HEAD", "revert"),
];

fn quiet_git_env() -> Vec<(String, String)> {
    vec![
        ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ("GIT_ASKPASS".into(), String::new()),
        ("SSH_ASKPASS".into(), String::new()),
        ("SSH_ASKPASS_REQUIRE".into(), "never".into()),
        ("GCM_INTERACTIVE".into(), "never".into()),
        ("GH_PROMPT_DISABLED".into(), "1".into()),
    ]
}

fn is_valid_segment(text: &str) -> bool {
    let len = text.encode_utf16().count();
    (1..=100).contains(&len)
        && text != "."
        && text != ".."
        && text.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

fn is_valid_host(text: &str) -> bool {
    let len = text.encode_utf16().count();
    (1..=253).contains(&len)
        && text.contains("github")
        && text.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-'))
}

pub fn is_valid_setup_repository(repo: &GitHubRepository) -> bool {
    is_valid_host(&repo.host) && is_valid_segment(&repo.owner) && is_valid_segment(&repo.name)
}

/// Validates a project title before any clone/fetch runs so unusable or whitespace-only titles
/// fail immediately without cloning a repository that `add_project_for_setup` would reject (N3).
fn usable_project_title(title: &str) -> bool {
    if title.trim().is_empty() {
        return false;
    }
    if cfg!(windows) {
        if title.chars().any(|c| "<>:\"/\\|?*".contains(c)) || title.ends_with('.') || title.ends_with(' ') {
            return false;
        }
        let lower = title.to_lowercase();
        let stem = lower.split('.').next().unwrap_or(&lower).trim_end_matches(' ');
        let reserved = matches!(
            stem,
            "con" | "prn" | "aux" | "nul"
                | "com0" | "com1" | "com2" | "com3" | "com4" | "com5" | "com6" | "com7" | "com8" | "com9"
                | "com¹" | "com²" | "com³"
                | "lpt0" | "lpt1" | "lpt2" | "lpt3" | "lpt4" | "lpt5" | "lpt6" | "lpt7" | "lpt8" | "lpt9"
                | "lpt¹" | "lpt²" | "lpt³"
        );
        !reserved
    } else {
        !title.contains('/') && title != "." && title != ".."
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectSetupRequest {
    pub repository: GitHubRepository,
    pub title: String,
}

impl ProjectSetupRequest {
    /// Strict parser matching `projectSetupRequestSchema` (`src/shared/workerMachine.ts:83-85`).
    pub fn parse(value: Option<&Value>) -> Option<Self> {
        let obj = value?.as_object()?;
        if obj.keys().any(|k| !matches!(k.as_str(), "repository" | "title")) {
            return None;
        }
        let repo_obj = obj.get("repository")?.as_object()?;
        if repo_obj.keys().any(|k| !matches!(k.as_str(), "host" | "owner" | "name")) {
            return None;
        }
        let host = repo_obj.get("host")?.as_str()?;
        let owner = repo_obj.get("owner")?.as_str()?;
        let name = repo_obj.get("name")?.as_str()?;
        let repository = GitHubRepository {
            host: host.to_string(),
            owner: owner.to_string(),
            name: name.to_string(),
        };
        if !is_valid_setup_repository(&repository) {
            return None;
        }
        let title = obj.get("title")?.as_str()?;
        let title_len = title.encode_utf16().count();
        if title_len == 0 || title_len > 512 {
            return None;
        }
        Some(Self { repository, title: title.to_string() })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectSetupResult {
    Ok {
        project_id: String,
        title: String,
        path: String,
        how: &'static str, // "added" | "cloned"
        current: bool,
        reason: Option<String>,
        fetched: Option<String>,
    },
    Err {
        message: String,
    },
}

impl ProjectSetupResult {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Ok { project_id, title, path, how, current, reason, fetched } => {
                let mut obj = Map::new();
                obj.insert("ok".into(), Value::Bool(true));
                obj.insert("projectId".into(), json!(project_id));
                obj.insert("title".into(), json!(title));
                obj.insert("path".into(), json!(path));
                obj.insert("how".into(), json!(how));
                obj.insert("current".into(), Value::Bool(*current));
                if let Some(ref r) = reason {
                    obj.insert("reason".into(), json!(r));
                }
                if let Some(ref f) = fetched {
                    obj.insert("fetched".into(), json!(f));
                }
                Value::Object(obj)
            }
            Self::Err { message } => json!({ "ok": false, "message": message }),
        }
    }
}

/// Snapshot of workspace paths needed to locate or clone a project copy.
#[derive(Debug, Clone)]
pub struct ProjectSetupContext {
    pub projects_directory: String,
    pub project_paths: Vec<String>,
    /// Resolved home directory (absolute), or `None` when the environment names none (never falls back to `own_folder`).
    pub home: Option<PathBuf>,
    pub own_folder: Option<PathBuf>,
}

/// Single-flight coordinator for `project-setup` operations on a host (`ProjectCopies`).
/// Calling `close()` stops every clone/fetch under way (killing its git process tree and removing any
/// newly created unfinished copy) and refuses new setups, matching `src/main/agents/projectSetup.ts:82-90`.
#[derive(Clone, Default)]
pub struct ProjectCopies {
    running: Arc<Mutex<HashMap<String, watch::Receiver<Option<ProjectSetupResult>>>>>,
    closing: Arc<AtomicBool>,
    active_count: Arc<AtomicUsize>,
    idle_notify: Arc<Notify>,
}

impl ProjectCopies {
    pub fn new() -> Self {
        Self::default()
    }

    /// Stops every setup under way and waits for in-flight git children and unfinished-folder cleanup to settle.
    pub async fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let notified = self.idle_notify.notified();
            if self.active_count.load(Ordering::SeqCst) == 0 {
                break;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                break;
            }
        }
    }

    pub async fn set_up<C, CFut, F, Fut>(
        &self,
        request: ProjectSetupRequest,
        context: ProjectSetupContext,
        current_projects: C,
        add_project: F,
    ) -> ProjectSetupResult
    where
        C: FnOnce() -> CFut + Send + 'static,
        CFut: Future<Output = Result<Vec<String>, String>> + Send,
        F: FnOnce(String, String) -> Fut + Send + 'static,
        Fut: Future<Output = Result<String, String>> + Send,
    {
        self.set_up_with_clone_url(request, context, None, current_projects, add_project).await
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) async fn set_up_with_clone_url<C, CFut, F, Fut>(
        &self,
        request: ProjectSetupRequest,
        context: ProjectSetupContext,
        clone_url_override: Option<String>,
        current_projects: C,
        add_project: F,
    ) -> ProjectSetupResult
    where
        C: FnOnce() -> CFut + Send + 'static,
        CFut: Future<Output = Result<Vec<String>, String>> + Send,
        F: FnOnce(String, String) -> Fut + Send + 'static,
        Fut: Future<Output = Result<String, String>> + Send,
    {
        if self.closing.load(Ordering::SeqCst) {
            return ProjectSetupResult::Err {
                message: "Sotto is closing there, so it set nothing up. Try again once it is open.".into(),
            };
        }
        let key = format!(
            "{}/{}/{}",
            request.repository.host, request.repository.owner, request.repository.name
        )
        .to_lowercase();
        let fallback_err = format!(
            "Sotto could not set up a copy of {}/{} there. Try again, or add the project there yourself.",
            request.repository.owner, request.repository.name
        );

        let mut rx = {
            let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
            if self.closing.load(Ordering::SeqCst) {
                return ProjectSetupResult::Err {
                    message: "Sotto is closing there, so it set nothing up. Try again once it is open.".into(),
                };
            }
            if let Some(existing) = running.get(&key).cloned() {
                existing
            } else {
                let (tx, rx) = watch::channel(None);
                running.insert(key.clone(), rx.clone());
                self.active_count.fetch_add(1, Ordering::SeqCst);
                let running_map = Arc::clone(&self.running);
                let closing = Arc::clone(&self.closing);
                let active_count = Arc::clone(&self.active_count);
                let idle_notify = Arc::clone(&self.idle_notify);
                let slot_key = key.clone();
                // Run the setup in its own task so a single caller disconnecting never cancels
                // an in-flight clone/fetch or breaks single-flight mutual exclusion; only `close()` aborts it.
                tokio::spawn(async move {
                    struct SlotGuard {
                        running: Arc<Mutex<HashMap<String, watch::Receiver<Option<ProjectSetupResult>>>>>,
                        active_count: Arc<AtomicUsize>,
                        idle_notify: Arc<Notify>,
                        key: String,
                    }
                    impl Drop for SlotGuard {
                        fn drop(&mut self) {
                            self.running.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.key);
                            if self.active_count.fetch_sub(1, Ordering::SeqCst) == 1 {
                                self.idle_notify.notify_waiters();
                            }
                        }
                    }
                    let _guard = SlotGuard {
                        running: running_map,
                        active_count,
                        idle_notify,
                        key: slot_key,
                    };
                    let result = set_up_now(
                        request,
                        context,
                        clone_url_override,
                        closing,
                        current_projects,
                        add_project,
                    )
                    .await;
                    let _ = tx.send(Some(result));
                });
                rx
            }
        };

        loop {
            if let Some(result) = rx.borrow().clone() {
                return result;
            }
            if rx.changed().await.is_err() {
                return ProjectSetupResult::Err { message: fallback_err };
            }
        }
    }
}

fn default_clone_url(repo: &GitHubRepository) -> String {
    format!("https://{}/{}/{}.git", repo.host, repo.owner, repo.name)
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(comp.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            Component::Normal(s) => out.push(s),
        }
    }
    out
}

fn folder_key(path: &Path) -> String {
    let norm = normalize_lexical(path);
    let s = norm.to_string_lossy();
    #[cfg(windows)]
    {
        let normalized = s.replace('/', "\\").to_lowercase();
        // Preserve Windows drive roots like `c:\` so they never collide with drive-relative `c:`.
        let is_drive_root = normalized.len() == 3 && normalized.as_bytes()[1] == b':' && normalized.as_bytes()[2] == b'\\';
        if is_drive_root || normalized.len() <= 1 {
            normalized
        } else {
            let trimmed = normalized.trim_end_matches('\\');
            if trimmed.len() == 2 && trimmed.as_bytes()[1] == b':' {
                format!("{trimmed}\\")
            } else if trimmed.is_empty() {
                normalized
            } else {
                trimmed.to_string()
            }
        }
    }
    #[cfg(not(windows))]
    {
        if s.len() > 1 {
            let t = s.trim_end_matches('/');
            if t.is_empty() { "/".to_string() } else { t.to_string() }
        } else {
            s.into_owned()
        }
    }
}

fn inside(folder: &Path, path: &Path) -> bool {
    let a = folder_key(folder);
    let b = folder_key(path);
    if a == b {
        return true;
    }
    let sep = std::path::MAIN_SEPARATOR;
    if a.ends_with(sep) {
        b.starts_with(&a)
    } else {
        b.starts_with(&a) && b.as_bytes().get(a.len()) == Some(&(sep as u8))
    }
}

fn same_repository(left: &GitHubRepository, right: &GitHubRepository) -> bool {
    left.host.eq_ignore_ascii_case(&right.host)
        && left.owner.eq_ignore_ascii_case(&right.owner)
        && left.name.eq_ignore_ascii_case(&right.name)
}

pub fn usual_folder(ctx: &ProjectSetupContext) -> Option<PathBuf> {
    let configured = ctx.projects_directory.trim();
    if !configured.is_empty() {
        let p = Path::new(configured);
        if p.is_absolute() {
            return Some(normalize_lexical(p));
        }
    }
    let home_key = ctx.home.as_ref().map(|h| folder_key(h));
    let mut order: Vec<String> = Vec::new();
    let mut counts: HashMap<String, (PathBuf, usize)> = HashMap::new();
    for raw in &ctx.project_paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let p = Path::new(trimmed);
        if !p.is_absolute() {
            continue;
        }
        let resolved = normalize_lexical(p);
        let Some(parent) = resolved.parent() else { continue };
        if home_key.as_deref() == Some(folder_key(&resolved).as_str()) || parent == resolved {
            continue;
        }
        if ctx.own_folder.as_ref().is_some_and(|own| inside(own, &resolved)) {
            continue;
        }
        let key = folder_key(parent);
        if let Some(entry) = counts.get_mut(&key) {
            entry.1 += 1;
        } else {
            order.push(key.clone());
            counts.insert(key, (parent.to_path_buf(), 1));
        }
    }
    let mut best: Option<(PathBuf, usize)> = None;
    for key in order {
        if let Some((folder, count)) = counts.get(&key) {
            if best.as_ref().is_none_or(|(_, best_count)| *count > *best_count) {
                best = Some((folder.clone(), *count));
            }
        }
    }
    best.map(|(f, _)| f)
        .or_else(|| ctx.home.as_ref().filter(|h| h.is_absolute()).map(|h| normalize_lexical(&h.join("Projects"))))
}

fn git_quiet(cwd: &Path, args: &[&str], timeout: Duration, cancel: Option<&AtomicBool>) -> Result<String, String> {
    let env = quiet_git_env();
    let cwd_str = cwd.to_string_lossy();
    run_action_git_with(&cwd_str, args, timeout, ActionGitExtras { env: &env, stdin: None, lines: None, cancel })
}

fn top_level(path: &Path, cancel: Option<&AtomicBool>) -> bool {
    git_quiet(path, &["rev-parse", "--show-cdup"], QUICK_TIMEOUT, cancel)
        .map(|s| s.trim().is_empty())
        .unwrap_or(false)
}

fn find_clone(folder: &Path, repository: &GitHubRepository, cancel: Option<&AtomicBool>) -> Option<PathBuf> {
    let entries = std::fs::read_dir(folder).ok()?;
    let mut dirs: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        dirs.push(name);
    }
    let wanted = repository.name.to_lowercase();
    let mut named_for: Vec<String> = dirs
        .iter()
        .filter(|n| n.to_lowercase() == wanted)
        .cloned()
        .collect();
    named_for.sort_by_key(|n| usize::from(*n != repository.name));
    let others = dirs.into_iter().filter(|n| n.to_lowercase() != wanted).take(SCAN_MAX);
    for name in named_for.into_iter().chain(others) {
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            return None;
        }
        let candidate = folder.join(name);
        let origin = git_quiet(&candidate, &["config", "--get", "remote.origin.url"], QUICK_TIMEOUT, cancel)
            .ok()
            .and_then(|url| parse_github_remote(&url));
        if origin.as_ref().is_some_and(|o| same_repository(o, repository)) && top_level(&candidate, cancel) {
            return Some(candidate);
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CheckoutBlock {
    InProgress(&'static str),
    Branch(bool),
    Diverged,
    Changes,
}

fn block_words(block: &CheckoutBlock) -> String {
    match block {
        CheckoutBlock::InProgress(op) => format!("a {op} is under way in it"),
        CheckoutBlock::Branch(true) => "it is on another branch".into(),
        CheckoutBlock::Branch(false) => "it has no branch checked out".into(),
        CheckoutBlock::Diverged => "it has commits GitHub does not have".into(),
        CheckoutBlock::Changes => "it has uncommitted changes".into(),
    }
}

fn origin_default_branch(top: &Path, cancel: Option<&AtomicBool>) -> Option<String> {
    if let Ok(head) = git_quiet(top, &["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], QUICK_TIMEOUT, cancel) {
        let trimmed = head.trim();
        if let Some(branch) = trimmed.strip_prefix("origin/") {
            if !branch.is_empty() {
                return Some(branch.to_string());
            }
        }
    }
    for candidate in ["main", "master"] {
        let verify = format!("refs/remotes/origin/{candidate}^{{commit}}");
        if git_quiet(top, &["rev-parse", "--verify", "-q", &verify], QUICK_TIMEOUT, cancel).is_ok() {
            return Some(candidate.to_string());
        }
    }
    None
}

fn checkout_block(top: &Path, branch: &str, ahead: u64, cancel: Option<&AtomicBool>) -> Result<Option<CheckoutBlock>, String> {
    for &(marker, op) in IN_PROGRESS_MARKERS {
        if let Ok(out) = git_quiet(top, &["rev-parse", "--git-path", marker], QUICK_TIMEOUT, cancel) {
            let trimmed = out.trim();
            if !trimmed.is_empty() {
                let p = Path::new(trimmed);
                let full = if p.is_absolute() { p.to_path_buf() } else { top.join(p) };
                if full.exists() {
                    return Ok(Some(CheckoutBlock::InProgress(op)));
                }
            }
        }
    }
    let current = git_quiet(top, &["symbolic-ref", "--short", "-q", "HEAD"], QUICK_TIMEOUT, cancel)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if current != branch {
        return Ok(Some(CheckoutBlock::Branch(!current.is_empty())));
    }
    if ahead > 0 {
        return Ok(Some(CheckoutBlock::Diverged));
    }
    let porcelain = git_quiet(top, &["status", "--porcelain=v1", "-z", "--untracked-files=no"], QUICK_TIMEOUT, cancel)?;
    if !porcelain.is_empty() {
        return Ok(Some(CheckoutBlock::Changes));
    }
    Ok(None)
}

fn in_the_way_reason(detail: &str) -> Option<&'static str> {
    let lower = detail.to_ascii_lowercase();
    if lower.contains("untracked working tree files would be overwritten")
        || lower.contains("untracked working tree files would be removed")
    {
        return Some("files in it that Git does not track are in the way");
    }
    if lower.contains("local changes to the following files would be overwritten") {
        return Some("it has uncommitted changes");
    }
    None
}

struct UpdateOutcome {
    current: bool,
    reason: Option<String>,
    fetched: Option<String>,
}

enum FetchInspect {
    Done(UpdateOutcome),
    ReadyToFastForward { remote: String, fetched: Option<String> },
}

fn fetch_and_inspect_for_ff(top: &Path, cancel: Option<&AtomicBool>) -> FetchInspect {
    if git_quiet(top, &["fetch", "--quiet", "origin"], FETCH_TIMEOUT, cancel).is_err() {
        return FetchInspect::Done(UpdateOutcome {
            current: false,
            reason: Some("Sotto could not fetch it from GitHub".into()),
            fetched: None,
        });
    }
    let head = git_quiet(top, &["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], QUICK_TIMEOUT, cancel)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if head.is_empty() {
        let _ = git_quiet(top, &["remote", "set-head", "origin", "--auto"], FETCH_TIMEOUT, cancel);
    }
    let Some(branch) = origin_default_branch(top, cancel) else {
        return FetchInspect::Done(UpdateOutcome {
            current: false,
            reason: Some("Sotto could not tell which branch is its default".into()),
            fetched: None,
        });
    };
    let local = format!("refs/heads/{branch}");
    let remote = format!("refs/remotes/origin/{branch}");
    let verify_remote = format!("{remote}^{{commit}}");
    let fetched = git_quiet(top, &["rev-parse", "--verify", "--quiet", &verify_remote], QUICK_TIMEOUT, cancel)
        .ok()
        .map(|_| branch.clone());
    let range = format!("{local}...{remote}");
    let counts = git_quiet(top, &["rev-list", "--left-right", "--count", &range, "--"], QUICK_TIMEOUT, cancel)
        .ok()
        .and_then(|text| {
            let mut parts = text.split_whitespace();
            let ahead = parts.next()?.parse::<u64>().ok()?;
            let behind = parts.next()?.parse::<u64>().ok()?;
            Some((ahead, behind))
        });
    let ahead = counts.map_or(0, |(a, _)| a);
    let block = checkout_block(top, &branch, ahead, cancel).unwrap_or(Some(CheckoutBlock::Changes));
    if matches!(block, Some(CheckoutBlock::Branch(_))) {
        return FetchInspect::Done(UpdateOutcome {
            current: false,
            reason: block.as_ref().map(block_words),
            fetched,
        });
    }
    let Some((_, behind)) = counts else {
        return FetchInspect::Done(UpdateOutcome {
            current: false,
            reason: Some("Sotto could not compare it with GitHub".into()),
            fetched,
        });
    };
    if behind == 0 && matches!(block, None | Some(CheckoutBlock::Changes)) {
        return FetchInspect::Done(UpdateOutcome { current: true, reason: None, fetched: None });
    }
    if let Some(ref b) = block {
        return FetchInspect::Done(UpdateOutcome { current: false, reason: Some(block_words(b)), fetched });
    }
    FetchInspect::ReadyToFastForward { remote, fetched }
}

fn finish_fast_forward(
    top: &Path,
    remote: &str,
    fetched: Option<String>,
    live_projects: Result<&[String], &str>,
    cancel: Option<&AtomicBool>,
) -> UpdateOutcome {
    let Ok(live_projects) = live_projects else {
        // Fail closed: if we could not confirm whether another project claimed this folder during fetch,
        // never run `git merge --ff-only` underneath potentially active work (N1).
        return UpdateOutcome {
            current: false,
            reason: Some("Sotto could not check this machine's projects".into()),
            fetched,
        };
    };
    let top_key = folder_key(top);
    if live_projects.iter().any(|p| !p.trim().is_empty() && folder_key(Path::new(p)) == top_key) {
        return UpdateOutcome {
            current: false,
            reason: Some("another project there already uses that folder".into()),
            fetched,
        };
    }
    match git_quiet(
        top,
        &["merge", "--ff-only", "--no-autostash", "--no-overwrite-ignore", "--quiet", "--end-of-options", remote],
        MERGE_TIMEOUT,
        cancel,
    ) {
        Ok(_) => UpdateOutcome { current: true, reason: None, fetched: None },
        Err(detail) => UpdateOutcome {
            current: false,
            reason: Some(in_the_way_reason(&detail).unwrap_or("Git could not move it forward").into()),
            fetched,
        },
    }
}

fn remove_unfinished(target: &Path) -> bool {
    for _ in 0..5 {
        match std::fs::remove_dir_all(target) {
            Ok(()) => return true,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) => std::thread::sleep(Duration::from_millis(80)),
        }
    }
    !target.exists()
}

fn clone_repo(
    repository: &GitHubRepository,
    folder: &Path,
    target: &Path,
    clone_url: &str,
    closing: &AtomicBool,
) -> Result<(), String> {
    let named = format!("{}/{}", repository.owner, repository.name);
    let folder_disp = folder.to_string_lossy();
    let target_disp = target.to_string_lossy();
    if closing.load(Ordering::SeqCst) {
        return Err("Sotto is closing there, so it set nothing up. Try again once it is open.".into());
    }
    if std::fs::create_dir_all(folder).is_err() {
        return Err(format!(
            "Sotto could not make the folder {folder_disp} there. Clone {named} there yourself, or name another machine."
        ));
    }
    if let Err(err) = std::fs::create_dir(target) {
        if err.kind() == std::io::ErrorKind::AlreadyExists {
            return Err(format!(
                "There is already a folder named {} in {folder_disp} that is not a copy of {named}. Clone {named} there under another name yourself, or name another machine.",
                repository.name
            ));
        }
        return Err(format!(
            "Sotto could not make the folder {target_disp} there. Clone {named} there yourself, or name another machine."
        ));
    }
    let target_str = target.to_string_lossy().into_owned();
    if let Err(err) = git_quiet(
        folder,
        &["clone", "--quiet", "--filter=blob:none", "--", clone_url, &target_str],
        CLONE_TIMEOUT,
        Some(closing),
    ) {
        let removed = remove_unfinished(target);
        let leftover = if removed {
            "Sotto removed the unfinished copy.".to_string()
        } else {
            format!("Sotto could not remove the unfinished copy at {target_disp}; remove it before trying again.")
        };
        if err == GIT_MISSING {
            return Err(format!(
                "Git is not installed there, so Sotto could not clone {named}. Install Git there, or name another machine."
            ));
        }
        if err == GIT_ABORTED || closing.load(Ordering::SeqCst) {
            return Err(format!(
                "Sotto closed there while cloning {named}. {leftover} Try again once it is open."
            ));
        }
        if err == "git did not finish in time." {
            return Err(format!(
                "Cloning {named} into {target_disp} took more than ten minutes, so Sotto stopped it. {leftover} Clone it there yourself, or name another machine."
            ));
        }
        return Err(format!(
            "Git could not clone {named} into {target_disp}; that machine may not reach GitHub or may not be signed in to it. {leftover} Clone it there yourself, or name another machine."
        ));
    }
    Ok(())
}

enum PreparedCopy {
    AddedDone { path: PathBuf, update: UpdateOutcome },
    AddedReadyToFastForward { path: PathBuf, remote: String, fetched: Option<String> },
    Cloned { path: PathBuf },
}

async fn set_up_now<C, CFut, F, Fut>(
    request: ProjectSetupRequest,
    context: ProjectSetupContext,
    clone_url_override: Option<String>,
    closing: Arc<AtomicBool>,
    current_projects: C,
    add_project: F,
) -> ProjectSetupResult
where
    C: FnOnce() -> CFut + Send + 'static,
    CFut: Future<Output = Result<Vec<String>, String>> + Send,
    F: FnOnce(String, String) -> Fut + Send + 'static,
    Fut: Future<Output = Result<String, String>> + Send,
{
    if closing.load(Ordering::SeqCst) {
        return ProjectSetupResult::Err {
            message: "Sotto is closing there, so it set nothing up. Try again once it is open.".into(),
        };
    }
    let repository = request.repository;
    let named = format!("{}/{}", repository.owner, repository.name);
    if !is_valid_setup_repository(&repository) {
        return ProjectSetupResult::Err {
            message: format!("{named} is not a GitHub repository Sotto can clone. Nothing was set up."),
        };
    }
    // Validate project title before touching disk or cloning so a blank/invalid title never leaves a clone behind (N3).
    if !usable_project_title(&request.title) {
        return ProjectSetupResult::Err {
            message: "Choose a project name that can be used as a folder name.".into(),
        };
    }
    let repo_for_work = repository.clone();
    let named_for_work = named.clone();
    let closing_for_work = Arc::clone(&closing);
    let prepared = tokio::task::spawn_blocking(move || -> Result<PreparedCopy, String> {
        let Some(folder) = usual_folder(&context).filter(|f| f.is_absolute()) else {
            return Err(format!(
                "Sotto could not find an absolute projects folder there for {named_for_work}. Configure a default projects folder there, or add the project yourself."
            ));
        };
        if let Some(found) = find_clone(&folder, &repo_for_work, Some(&closing_for_work)) {
            if closing_for_work.load(Ordering::SeqCst) {
                return Err("Sotto is closing there, so it set nothing up. Try again once it is open.".into());
            }
            let found_key = folder_key(&found);
            let listed = context
                .project_paths
                .iter()
                .any(|p| !p.trim().is_empty() && folder_key(Path::new(p)) == found_key);
            if listed {
                return Ok(PreparedCopy::AddedDone {
                    path: found,
                    update: UpdateOutcome {
                        current: false,
                        reason: Some("another project there already uses that folder".into()),
                        fetched: None,
                    },
                });
            }
            return match fetch_and_inspect_for_ff(&found, Some(&closing_for_work)) {
                FetchInspect::Done(update) => Ok(PreparedCopy::AddedDone { path: found, update }),
                FetchInspect::ReadyToFastForward { remote, fetched } => {
                    Ok(PreparedCopy::AddedReadyToFastForward { path: found, remote, fetched })
                }
            };
        }
        if closing_for_work.load(Ordering::SeqCst) {
            return Err("Sotto is closing there, so it set nothing up. Try again once it is open.".into());
        }
        let target = folder.join(&repo_for_work.name);
        if target.parent().map(folder_key) != Some(folder_key(&folder)) {
            return Err(format!("{named_for_work} is not a GitHub repository Sotto can clone. Nothing was set up."));
        }
        let url = clone_url_override.unwrap_or_else(|| default_clone_url(&repo_for_work));
        clone_repo(&repo_for_work, &folder, &target, &url, &closing_for_work)?;
        Ok(PreparedCopy::Cloned { path: target })
    })
    .await;

    let prepared = match prepared {
        Ok(Ok(p)) => p,
        Ok(Err(message)) => return ProjectSetupResult::Err { message },
        Err(_) => {
            return ProjectSetupResult::Err {
                message: format!("Sotto could not set up a copy of {named} there. Try again, or add the project there yourself."),
            };
        }
    };

    if closing.load(Ordering::SeqCst) {
        return ProjectSetupResult::Err {
            message: "Sotto is closing there, so it set nothing up. Try again once it is open.".into(),
        };
    }

    let (path, how, current, reason, fetched, done_lead) = match prepared {
        PreparedCopy::AddedDone { path, update } => {
            let path_str = path.to_string_lossy().into_owned();
            let lead = format!("Sotto found {named} at {path_str}");
            (path_str, "added", update.current, update.reason, update.fetched, lead)
        }
        PreparedCopy::AddedReadyToFastForward { path, remote, fetched } => {
            // Re-read live projects after fetch so a project added meanwhile is never fast-forwarded underneath active work (projectSetup.ts:197).
            let live_projects = current_projects().await;
            let path_for_ff = path.clone();
            let closing_for_ff = Arc::clone(&closing);
            let update = tokio::task::spawn_blocking(move || {
                finish_fast_forward(
                    &path_for_ff,
                    &remote,
                    fetched,
                    live_projects.as_deref().map_err(String::as_str),
                    Some(&closing_for_ff),
                )
            })
            .await
            .unwrap_or(UpdateOutcome {
                current: false,
                reason: Some("Git could not move it forward".into()),
                fetched: None,
            });
            let path_str = path.to_string_lossy().into_owned();
            let lead = format!("Sotto found {named} at {path_str}");
            (path_str, "added", update.current, update.reason, update.fetched, lead)
        }
        PreparedCopy::Cloned { path } => {
            let path_str = path.to_string_lossy().into_owned();
            let lead = format!("Sotto cloned {named} into {path_str}");
            (path_str, "cloned", true, None, None, lead)
        }
    };

    match add_project(request.title.clone(), path.clone()).await {
        Ok(project_id) => ProjectSetupResult::Ok {
            project_id,
            title: request.title,
            path,
            how,
            current,
            reason,
            fetched,
        },
        Err(err) => {
            let said = if err.trim().is_empty() { "Try again." } else { err.trim() };
            ProjectSetupResult::Err {
                message: format!("{done_lead} but could not add it as a project. {said}"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn git_ok(cwd: &Path, args: &[&str]) {
        git_quiet(cwd, args, QUICK_TIMEOUT, None).unwrap();
    }

    fn make_remote_and_clone() -> (TempDir, PathBuf, PathBuf) {
        let dir = TempDir::new().unwrap();
        let remote = dir.path().join("remote.git");
        let seed = dir.path().join("seed");
        fs::create_dir_all(&remote).unwrap();
        fs::create_dir_all(&seed).unwrap();
        git_ok(&remote, &["init", "--bare", "--initial-branch=main"]);
        git_ok(&seed, &["init", "--initial-branch=main"]);
        git_ok(&seed, &["config", "user.name", "Test"]);
        git_ok(&seed, &["config", "user.email", "test@example.com"]);
        git_ok(&seed, &["config", "commit.gpgsign", "false"]);
        git_ok(&seed, &["config", "core.autocrlf", "false"]);
        fs::write(seed.join("README.md"), "v1\n").unwrap();
        git_ok(&seed, &["add", "-A"]);
        git_ok(&seed, &["commit", "-m", "Initial"]);
        git_ok(&seed, &["remote", "add", "origin", &remote.to_string_lossy()]);
        git_ok(&seed, &["push", "-u", "origin", "main"]);
        (dir, remote, seed)
    }

    #[test]
    fn parses_project_setup_request_strictly() {
        let good = json!({
            "repository": { "host": "github.com", "owner": "millZach", "name": "Sotto" },
            "title": "Sotto"
        });
        assert!(ProjectSetupRequest::parse(Some(&good)).is_some());

        for bad in [
            json!({ "repository": { "host": "gitlab.com", "owner": "a", "name": "b" }, "title": "x" }),
            json!({ "repository": { "host": "GitHub.com", "owner": "a", "name": "b" }, "title": "x" }),
            json!({ "repository": { "host": "github.com", "owner": "..", "name": "b" }, "title": "x" }),
            json!({ "repository": { "host": "github.com", "owner": "a", "name": "." }, "title": "x" }),
            json!({ "repository": { "host": "github.com", "owner": "a/b", "name": "c" }, "title": "x" }),
            json!({ "repository": { "host": "github.com", "owner": "a", "name": "b" }, "title": "" }),
            json!({ "repository": { "host": "github.com", "owner": "a", "name": "b", "extra": 1 }, "title": "x" }),
            json!({ "repository": { "host": "github.com", "owner": "a", "name": "b" }, "title": "x", "extra": 1 }),
        ] {
            assert!(ProjectSetupRequest::parse(Some(&bad)).is_none(), "should reject {bad}");
        }
    }

    #[test]
    fn usual_folder_prefers_configured_then_majority_parent_excluding_home_and_own_folder() {
        let dir = TempDir::new().unwrap();
        let home = dir.path().join("home");
        let own = dir.path().join("sotto-data");
        let work = dir.path().join("work");
        let alt = dir.path().join("alt");
        let ctx = ProjectSetupContext {
            projects_directory: String::new(),
            project_paths: vec![
                home.to_string_lossy().into_owned(),
                own.join("watcher").to_string_lossy().into_owned(),
                own.join("other").to_string_lossy().into_owned(),
                alt.join("one").to_string_lossy().into_owned(),
                work.join("a").to_string_lossy().into_owned(),
                work.join("b").to_string_lossy().into_owned(),
            ],
            home: Some(home.clone()),
            own_folder: Some(own.clone()),
        };
        assert_eq!(folder_key(&usual_folder(&ctx).unwrap()), folder_key(&work));

        let configured = ProjectSetupContext {
            projects_directory: alt.to_string_lossy().into_owned(),
            ..ctx.clone()
        };
        assert_eq!(folder_key(&usual_folder(&configured).unwrap()), folder_key(&alt));

        let fallback = ProjectSetupContext {
            projects_directory: String::new(),
            project_paths: Vec::new(),
            home: Some(home.clone()),
            own_folder: None,
        };
        assert_eq!(folder_key(&usual_folder(&fallback).unwrap()), folder_key(&home.join("Projects")));

        // Missing home and no configured/existing project folders must return None (never fall back to own_folder).
        let no_home = ProjectSetupContext {
            projects_directory: String::new(),
            project_paths: Vec::new(),
            home: None,
            own_folder: Some(own),
        };
        assert!(usual_folder(&no_home).is_none());

        #[cfg(not(windows))]
        assert!(inside(Path::new("/"), Path::new("/foo")));
        #[cfg(windows)]
        assert!(inside(Path::new(r"C:\"), Path::new(r"C:\foo")));
    }

    #[tokio::test]
    async fn set_up_clones_refuses_non_clone_collision_and_fast_forwards_existing_copy() {
        let (dir, remote, seed) = make_remote_and_clone();
        let projects_root = dir.path().join("Projects");
        let repo = GitHubRepository { host: "github.com".into(), owner: "org".into(), name: "app".into() };
        let closing = Arc::new(AtomicBool::new(false));

        // 0. Blank title is refused BEFORE cloning (target folder is never created).
        let ctx = ProjectSetupContext {
            projects_directory: projects_root.to_string_lossy().into_owned(),
            project_paths: Vec::new(),
            home: Some(dir.path().to_path_buf()),
            own_folder: None,
        };
        let blank_res = set_up_now(
            ProjectSetupRequest { repository: repo.clone(), title: "   ".into() },
            ctx.clone(),
            Some(remote.to_string_lossy().into_owned()),
            Arc::clone(&closing),
            || async { Ok(Vec::new()) },
            |_, _| async { Ok("proj-never".into()) },
        )
        .await;
        match blank_res {
            ProjectSetupResult::Err { message } => assert!(message.contains("folder name"), "{message}"),
            ProjectSetupResult::Ok { .. } => panic!("expected blank title refusal"),
        }
        assert!(!projects_root.join("app").exists(), "blank title must not create clone folder");

        // 1. Fresh clone into projects_root/app via local bare remote override.
        let req = ProjectSetupRequest { repository: repo.clone(), title: "App".into() };
        let res = set_up_now(
            req.clone(),
            ctx.clone(),
            Some(remote.to_string_lossy().into_owned()),
            Arc::clone(&closing),
            || async { Ok(Vec::new()) },
            |_, _| async { Ok("proj-1".into()) },
        )
        .await;
        match res {
            ProjectSetupResult::Ok { project_id, how, current, .. } => {
                assert_eq!(project_id, "proj-1");
                assert_eq!(how, "cloned");
                assert!(current);
            }
            ProjectSetupResult::Err { message } => panic!("expected clone ok, got: {message}"),
        }

        // 2. Existing non-clone folder with the repo name is refused cleanly.
        let other_root = dir.path().join("OtherProjects");
        fs::create_dir_all(other_root.join("app")).unwrap();
        let collide = set_up_now(
            req.clone(),
            ProjectSetupContext {
                projects_directory: other_root.to_string_lossy().into_owned(),
                ..ctx.clone()
            },
            Some(remote.to_string_lossy().into_owned()),
            Arc::clone(&closing),
            || async { Ok(Vec::new()) },
            |_, _| async { Ok("proj-x".into()) },
        )
        .await;
        match collide {
            ProjectSetupResult::Err { message } => {
                assert!(message.contains("already a folder named app"), "{message}");
            }
            ProjectSetupResult::Ok { .. } => panic!("expected collision refusal"),
        }

        // 3. Push a new commit to remote and verify fetch + live post-fetch collision/error fail-closed + fast-forward.
        // Leave `cloned_path`'s `core.autocrlf` untouched so it stays consistent with whatever line endings
        // `git clone` wrote on Windows runners (`core.autocrlf=true`), then normalize `\r\n` when asserting content.
        let cloned_path = projects_root.join("app");
        fs::write(seed.join("README.md"), "v2\n").unwrap();
        git_ok(&seed, &["add", "-A"]);
        git_ok(&seed, &["commit", "-m", "Second"]);
        git_ok(&seed, &["push", "origin", "main"]);
        let (ff_remote, fetched) = match fetch_and_inspect_for_ff(&cloned_path, None) {
            FetchInspect::ReadyToFastForward { remote, fetched } => (remote, fetched),
            FetchInspect::Done(outcome) => {
                panic!(
                    "expected ReadyToFastForward, got Done(current={}, reason={:?}, fetched={:?})",
                    outcome.current, outcome.reason, outcome.fetched
                );
            }
        };
        // Recheck failure fails closed (N1) without running `git merge --ff-only`.
        let failed_recheck = finish_fast_forward(&cloned_path, &ff_remote, fetched.clone(), Err("coordinator stopped"), None);
        assert!(!failed_recheck.current);
        assert_eq!(failed_recheck.reason.as_deref(), Some("Sotto could not check this machine's projects"));
        assert_eq!(failed_recheck.fetched.as_deref(), Some("main"));
        assert_eq!(fs::read_to_string(cloned_path.join("README.md")).unwrap().replace("\r\n", "\n"), "v1\n");

        // If another project appeared on the folder during fetch, fast-forward is skipped.
        let claimed = [cloned_path.to_string_lossy().into_owned()];
        let blocked = finish_fast_forward(&cloned_path, &ff_remote, fetched.clone(), Ok(&claimed), None);
        assert!(!blocked.current);
        assert_eq!(blocked.reason.as_deref(), Some("another project there already uses that folder"));
        assert_eq!(blocked.fetched.as_deref(), Some("main"));
        // Otherwise fast-forward succeeds cleanly.
        let update = finish_fast_forward(&cloned_path, &ff_remote, fetched, Ok(&[]), None);
        assert!(update.current, "reason={:?}", update.reason);
        assert_eq!(
            fs::read_to_string(cloned_path.join("README.md")).unwrap().replace("\r\n", "\n"),
            "v2\n"
        );
    }

    #[tokio::test]
    async fn close_aborts_in_flight_clone_cleans_up_folder_and_refuses_new_setups() {
        let dir = TempDir::new().unwrap();
        let projects_root = dir.path().join("Projects");
        let target = projects_root.join("slow-app");
        // Bind a local TCP listener that accepts connections and never sends bytes, so `git clone http://127.0.0.1:<port>/repo.git`
        // blocks until `ProjectCopies::close()` terminates the git process tree cleanly.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let stop_server = Arc::new(AtomicBool::new(false));
        let stop_flag = Arc::clone(&stop_server);
        let server_thread = std::thread::spawn(move || {
            let _ = listener.set_nonblocking(true);
            let mut held = Vec::new();
            while !stop_flag.load(Ordering::Relaxed) {
                if let Ok((stream, _)) = listener.accept() {
                    held.push(stream);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            drop(held);
        });

        let copies = ProjectCopies::new();
        let copies_task = copies.clone();
        let req = ProjectSetupRequest {
            repository: GitHubRepository { host: "github.com".into(), owner: "org".into(), name: "slow-app".into() },
            title: "Slow App".into(),
        };
        let ctx = ProjectSetupContext {
            projects_directory: projects_root.to_string_lossy().into_owned(),
            project_paths: Vec::new(),
            home: Some(dir.path().to_path_buf()),
            own_folder: None,
        };
        let setup_handle = tokio::spawn(async move {
            copies_task
                .set_up_with_clone_url(
                    req,
                    ctx,
                    Some(format!("http://{addr}/org/slow-app.git")),
                    || async { Ok(Vec::new()) },
                    |_, _| async { Ok("proj-never".into()) },
                )
                .await
        });

        // Wait until clone_repo has created the target directory and launched git.
        let wait_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !target.exists() && tokio::time::Instant::now() < wait_deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(target.exists(), "clone should have created target directory before close");

        let started_close = std::time::Instant::now();
        copies.close().await;
        let close_elapsed = started_close.elapsed();
        assert!(close_elapsed < Duration::from_secs(8), "close took too long: {close_elapsed:?}");

        let res = setup_handle.await.unwrap();
        match res {
            ProjectSetupResult::Err { message } => {
                assert!(message.contains("Sotto closed there while cloning org/slow-app"), "{message}");
                assert!(message.contains("Sotto removed the unfinished copy."), "{message}");
            }
            ProjectSetupResult::Ok { .. } => panic!("expected aborted clone refusal"),
        }
        assert!(!target.exists(), "unfinished clone directory must be removed on close");

        // Any new setup after close is refused immediately.
        let after = copies
            .set_up(
                ProjectSetupRequest {
                    repository: GitHubRepository { host: "github.com".into(), owner: "org".into(), name: "next".into() },
                    title: "Next".into(),
                },
                ProjectSetupContext {
                    projects_directory: projects_root.to_string_lossy().into_owned(),
                    project_paths: Vec::new(),
                    home: Some(dir.path().to_path_buf()),
                    own_folder: None,
                },
                || async { Ok(Vec::new()) },
                |_, _| async { Ok("proj-never".into()) },
            )
            .await;
        assert_eq!(
            after,
            ProjectSetupResult::Err {
                message: "Sotto is closing there, so it set nothing up. Try again once it is open.".into()
            }
        );

        stop_server.store(true, Ordering::Relaxed);
        let _ = server_thread.join();
    }
}
