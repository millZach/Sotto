//! The GitHub pull request half of T3's stacked Git action (ADR-0027): looking up a branch's own open pull request,
//! picking the base branch, reading the repository's pull request template, drafting the title and body on the thread's
//! own provider (ADR-0026), creating the pull request once through `gh`, and settling a lost create acknowledgement by
//! asking GitHub what is open now.
//!
//! Mirrors `openPullRequest`, `headRepository`, `baseBranch`, `pullRequest`, and `pullRequestTemplate` in
//! `src/main/agents/git/gitActions.ts` together with `GitHubHosts`, `readGitHubRemotes`, `baseRepository`,
//! `sameRepository`, and `isOwnHead` in `src/main/agents/git/github.ts`.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::commit_draft::{CommitDrafts, WritingSettings};
use crate::git_action::{
    config, default_branch, diff_excerpt, lines, parse_upstream, push_remote, read_status, CommitMaterial,
    GitActionEvent, GitActionPhase, GitActionServices, OpenPullRequest, Progress, PullRequestStep, COMMAND_DEADLINE,
    STAND_IN_SUBJECT,
};
use crate::git_local::{js_space, js_trim, safe_remote};
use crate::ops::{run_action_gh_with, run_action_git as git, GitHubRepository};
use crate::pull_request_draft::{PullRequestDrafts, PullRequestMaterial, PullRequestText};
use crate::side_writing::SideWritingThreads;
use crate::workspace::clip_utf16;

const TEMPLATE_MAX_CHARS: usize = 8_000;
const RANGE_LOG_MAX: usize = 20_000;
const RANGE_STAT_MAX: usize = 20_000;
const RANGE_PATCH_MAX: usize = 60_000;
const CREATE_PR_DEADLINE: Duration = Duration::from_secs(120);
const AUTH_STATUS_DEADLINE: Duration = Duration::from_secs(15);
const SSH_LOOKUP_DEADLINE: Duration = Duration::from_secs(5);
const HOSTS_FRESH: Duration = Duration::from_secs(10 * 60);

const SINGLE_TEMPLATE_PATHS: [&str; 6] = [
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
    "docs/pull_request_template.md",
    "docs/PULL_REQUEST_TEMPLATE.md",
];

/// Runs `gh` commands for the GitHub pull request step (real `gh` in production, scripted stand-in in tests).
pub trait GhRunner: Send + Sync {
    fn run_gh(&self, cwd: &str, args: &[&str], deadline: Duration, stdin: Option<&[u8]>) -> Result<String, String>;
    /// Looks up an SSH alias via `ssh -G <alias>` (connects to nothing). Override in tests to avoid reading the host's `~/.ssh/config`.
    fn ssh_hostname(&self, alias: &str) -> Option<String> {
        read_ssh_hostname(alias)
    }
}

/// Production `gh` runner backed by `ops::run_action_gh_with`.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemGh;

impl GhRunner for SystemGh {
    fn run_gh(&self, cwd: &str, args: &[&str], deadline: Duration, stdin: Option<&[u8]>) -> Result<String, String> {
        run_action_gh_with(cwd, args, deadline, stdin)
    }
}

/// Keeps the last `max` UTF-16 code units of `text`, matching JavaScript's `text.slice(-max)` without panicking on UTF-8.
fn tail_utf16(text: &str, max: usize) -> &str {
    let total: usize = text.encode_utf16().count();
    if total <= max {
        return text;
    }
    let skip = total - max;
    let mut seen = 0usize;
    for (byte_idx, ch) in text.char_indices() {
        if seen >= skip {
            return &text[byte_idx..];
        }
        seen += ch.len_utf16();
    }
    ""
}

// ---------------------------------------------------------------------------------------------------------------------
// GitHub remote and host resolution (mirrors `src/main/agents/git/github.ts`).

struct ParsedRemote {
    host: String,
    ssh: bool,
    owner: String,
    name: String,
}

fn parse_remote_url(url: &str) -> Option<ParsedRemote> {
    let trimmed = js_trim(url).trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let (raw_host, ssh, rest) = if let Some(after) = trimmed.strip_prefix("https://").or_else(|| trimmed.strip_prefix("HTTPS://")) {
        let (authority, path) = after.split_once('/')?;
        let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        let host = host_port.split_once(':').map_or(host_port, |(h, _)| h);
        (host.to_ascii_lowercase(), false, path)
    } else if let Some(after) = trimmed.strip_prefix("ssh://").or_else(|| trimmed.strip_prefix("SSH://")) {
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
    if raw_host.is_empty() || raw_host.chars().any(char::is_whitespace) {
        return None;
    }
    let (owner, name_raw) = rest.split_once('/')?;
    if owner.is_empty()
        || name_raw.is_empty()
        || name_raw.contains('/')
        || owner.chars().any(char::is_whitespace)
        || name_raw.chars().any(char::is_whitespace)
    {
        return None;
    }
    let name = name_raw.strip_suffix(".git").or_else(|| name_raw.strip_suffix(".GIT")).unwrap_or(name_raw);
    if name.is_empty() {
        return None;
    }
    Some(ParsedRemote { host: raw_host, ssh, owner: owner.to_string(), name: name.to_string() })
}

fn is_github_dot_com(host: &str) -> bool {
    host == "github.com" || host.ends_with(".github.com")
}

fn github_api_host(host: &str, ssh: bool) -> Option<String> {
    if is_github_dot_com(host) {
        return Some("github.com".into());
    }
    if ssh && ((!host.contains('.') && host.contains("github")) || host.starts_with("github.com-") || host.starts_with("github.com_")) {
        return Some("github.com".into());
    }
    host.contains("github").then(|| host.to_string())
}

pub(crate) fn same_repository(a: &GitHubRepository, b: &GitHubRepository) -> bool {
    a.host == b.host && a.owner.eq_ignore_ascii_case(&b.owner) && a.name.eq_ignore_ascii_case(&b.name)
}

pub(crate) fn is_own_head(head_owner: Option<&str>, head_cross_repo: bool, pushed_owner: &str, pushed_cross_repo: bool) -> bool {
    head_owner.is_some_and(|owner| owner.eq_ignore_ascii_case(pushed_owner)) && head_cross_repo == pushed_cross_repo
}

fn valid_ssh_alias(alias: &str) -> bool {
    let mut bytes = alias.bytes();
    let Some(first) = bytes.next() else { return false };
    (first.is_ascii_alphanumeric() || first == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn read_ssh_hostname(alias: &str) -> Option<String> {
    if !valid_ssh_alias(alias) {
        return None;
    }
    let mut cmd = Command::new("ssh");
    cmd.args(["-G", alias]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().ok()?;
    let deadline = Instant::now() + SSH_LOOKUP_DEADLINE;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(_) => return None,
        }
    };
    if !status.success() {
        return None;
    }
    let mut buf = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = std::io::Read::read_to_end(&mut stdout, &mut buf);
    }
    let text = String::from_utf8_lossy(&buf);
    for line in text.lines() {
        let trimmed = js_trim(line);
        let mut parts = trimmed.split_whitespace();
        if let (Some(key), Some(val), None) = (parts.next(), parts.next(), parts.next()) {
            if key.eq_ignore_ascii_case("hostname") {
                return Some(val.to_ascii_lowercase());
            }
        }
    }
    None
}

/// Caches `ssh -G` host lookups and `gh auth status` signed-in host names for 10 minutes, matching Node's `GitHubHosts`.
pub struct GitHubHosts {
    gh: Arc<dyn GhRunner>,
    signed_in: Mutex<Option<(Instant, HashSet<String>)>>,
    aliases: Mutex<HashMap<String, (Instant, Option<String>)>>,
}

impl GitHubHosts {
    pub fn new(gh: Arc<dyn GhRunner>) -> Self {
        Self { gh, signed_in: Mutex::new(None), aliases: Mutex::new(HashMap::new()) }
    }

    pub fn repository(&self, url: &str) -> Option<GitHubRepository> {
        let remote = parse_remote_url(url)?;
        let host = if remote.ssh && !is_github_dot_com(&remote.host) {
            self.ssh_hostname(&remote.host).unwrap_or(remote.host)
        } else {
            remote.host
        };
        if let Some(named) = github_api_host(&host, remote.ssh) {
            return Some(GitHubRepository { host: named, owner: remote.owner, name: remote.name });
        }
        self.signed_in_hosts()
            .contains(&host)
            .then_some(GitHubRepository { host, owner: remote.owner, name: remote.name })
    }

    fn ssh_hostname(&self, alias: &str) -> Option<String> {
        let now = Instant::now();
        if let Some((at, value)) = self.aliases.lock().unwrap_or_else(|e| e.into_inner()).get(alias) {
            if now.saturating_duration_since(*at) < HOSTS_FRESH {
                return value.clone();
            }
        }
        let resolved = self.gh.ssh_hostname(alias);
        self.aliases.lock().unwrap_or_else(|e| e.into_inner()).insert(alias.to_string(), (now, resolved.clone()));
        resolved
    }

    fn signed_in_hosts(&self) -> HashSet<String> {
        let now = Instant::now();
        if let Some((at, hosts)) = self.signed_in.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            if now.saturating_duration_since(*at) < HOSTS_FRESH {
                return hosts.clone();
            }
        }
        let hosts = self.list_signed_in();
        *self.signed_in.lock().unwrap_or_else(|e| e.into_inner()) = Some((now, hosts.clone()));
        hosts
    }

    fn list_signed_in(&self) -> HashSet<String> {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let home_str = home.to_string_lossy();
        if let Ok(listed) = self.gh.run_gh(&home_str, &["auth", "status", "--json", "hosts", "--jq", ".hosts | keys[]"], AUTH_STATUS_DEADLINE, None) {
            return listed
                .lines()
                .map(|line| js_trim(line).to_ascii_lowercase())
                .filter(|line| !line.is_empty())
                .collect();
        }
        let text = match self.gh.run_gh(&home_str, &["auth", "status"], AUTH_STATUS_DEADLINE, None) {
            Ok(out) => out,
            Err(err) => err,
        };
        let mut hosts = HashSet::new();
        for line in text.lines() {
            let mut rest = line;
            while let Some(pos) = rest.find("Logged in to ") {
                let after = &rest[pos + "Logged in to ".len()..];
                if let Some(host) = after.split_whitespace().next().filter(|s| !s.is_empty()) {
                    hosts.insert(host.to_ascii_lowercase());
                }
                rest = after;
            }
        }
        hosts
    }
}

pub(crate) struct GitHubRemote {
    pub repository: Option<GitHubRepository>,
    pub gh_resolved: Option<String>,
}

/// Reads each remote's URL and `gh-resolved` mark from git config, matching `readGitHubRemotes` in `github.ts`.
pub(crate) fn read_github_remotes(cwd: &str, hosts: &GitHubHosts) -> Result<Vec<(String, GitHubRemote)>, String> {
    let listing = match git(cwd, &["config", "--get-regexp", r"^remote\..*\.(url|gh-resolved)$"], COMMAND_DEADLINE) {
        Ok(out) => out,
        Err(err) if err == "git exited with 1." => String::new(),
        Err(err) => return Err(err),
    };
    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    for line in listing.split('\n') {
        let trimmed = js_trim(line);
        let Some((key, value)) = trimmed.split_once(' ') else { continue };
        let Some(rest) = key.strip_prefix("remote.") else { continue };
        let (name, field) = if let Some(name) = rest.strip_suffix(".url") {
            (name, "url")
        } else if let Some(name) = rest.strip_suffix(".gh-resolved") {
            (name, "gh-resolved")
        } else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        if !map.contains_key(name) {
            order.push(name.to_string());
        }
        let entry = map.entry(name.to_string()).or_insert((None, None));
        if field == "url" && entry.0.is_none() {
            entry.0 = Some(value.to_string());
        } else if field == "gh-resolved" {
            entry.1 = Some(value.to_string());
        }
    }
    Ok(order
        .into_iter()
        .map(|name| {
            let (url, gh_resolved) = map.remove(&name).unwrap_or((None, None));
            let repository = url.as_deref().and_then(|u| hosts.repository(u));
            (name, GitHubRemote { repository, gh_resolved })
        })
        .collect())
}

/// Mirrors `baseRepository` in `src/main/agents/git/github.ts`.
pub(crate) fn base_repository(remotes: &[(String, GitHubRemote)]) -> Option<GitHubRepository> {
    let rank = |name: &str| match name.to_ascii_lowercase().as_str() {
        "upstream" => 0usize,
        "github" => 1,
        "origin" => 2,
        _ => 3,
    };
    let mut ordered: Vec<(&str, &GitHubRepository, Option<&str>)> = remotes
        .iter()
        .filter_map(|(name, remote)| {
            let repo = remote.repository.as_ref()?;
            let mark = remote.gh_resolved.as_deref().map(js_trim).filter(|m| !m.is_empty());
            Some((name.as_str(), repo, mark))
        })
        .collect();
    ordered.sort_by_key(|(name, _, _)| rank(name));
    if let Some((_, repo, Some(mark))) = ordered.iter().find(|(_, _, mark)| mark.is_some()) {
        if *mark == "base" {
            return Some((*repo).clone());
        }
        let parts: Vec<&str> = mark.split('/').collect();
        if (parts.len() == 2 || parts.len() == 3) && parts.iter().all(|p| !p.is_empty()) {
            return Some(GitHubRepository {
                host: repo.host.clone(),
                owner: parts[parts.len() - 2].to_string(),
                name: parts[parts.len() - 1].to_string(),
            });
        }
    }
    ordered.first().map(|(_, repo, _)| (*repo).clone())
}

struct HeadRepository {
    owner: String,
    cross_repository: bool,
}

fn head_repository(cwd: &str, branch: &str, hosts: &GitHubHosts) -> Option<HeadRepository> {
    let remotes = read_github_remotes(cwd, hosts).ok()?;
    let base = base_repository(&remotes)?;
    let remote_name = push_remote(cwd, Some(branch))?;
    let pushed = remotes.iter().find(|(name, _)| name == &remote_name)?.1.repository.as_ref()?;
    Some(HeadRepository { owner: pushed.owner.clone(), cross_repository: !same_repository(&base, pushed) })
}

// ---------------------------------------------------------------------------------------------------------------------
// GitHub PR lookup, base branch, template reading, and creation (`src/main/agents/git/gitActions.ts`).

fn open_pull_request_with(gh: &dyn GhRunner, hosts: &GitHubHosts, cwd: &str, branch: &str) -> Result<Option<OpenPullRequest>, String> {
    let raw = gh.run_gh(
        cwd,
        &[
            "pr",
            "list",
            "--head",
            branch,
            "--state",
            "open",
            "--limit",
            "20",
            "--json",
            "number,title,url,baseRefName,headRefName,state,headRepositoryOwner,isCrossRepository",
        ],
        COMMAND_DEADLINE,
        None,
    )?;
    let list: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let items = list.as_array().ok_or_else(|| "Expected an array of pull requests from gh.".to_string())?;
    let head = head_repository(cwd, branch, hosts);
    for item in items {
        let Some(number) = item.get("number").and_then(Value::as_u64).filter(|&n| n > 0) else {
            return Err("Invalid pull request entry from gh.".into());
        };
        let Some(title) = item.get("title").and_then(Value::as_str) else {
            return Err("Invalid pull request entry from gh.".into());
        };
        let Some(url) = item.get("url").and_then(Value::as_str) else {
            return Err("Invalid pull request entry from gh.".into());
        };
        let Some(base_ref) = item.get("baseRefName").and_then(Value::as_str) else {
            return Err("Invalid pull request entry from gh.".into());
        };
        let Some(head_ref) = item.get("headRefName").and_then(Value::as_str) else {
            return Err("Invalid pull request entry from gh.".into());
        };
        if item.get("state").and_then(Value::as_str).is_none() {
            return Err("Invalid pull request entry from gh.".into());
        }
        if head_ref != branch {
            continue;
        }
        let head_owner = item.pointer("/headRepositoryOwner/login").and_then(Value::as_str);
        let is_cross = item.get("isCrossRepository").and_then(Value::as_bool) == Some(true);
        if let Some(ref pushed) = head {
            if !is_own_head(head_owner, is_cross, &pushed.owner, pushed.cross_repository) {
                continue;
            }
        }
        return Ok(Some(OpenPullRequest {
            number,
            title: title.to_string(),
            url: url.to_string(),
            base: base_ref.to_string(),
        }));
    }
    Ok(None)
}

fn base_branch_with(gh: &dyn GhRunner, cwd: &str, branch: &str) -> String {
    let recorded = config(cwd, &format!("branch.{branch}.gh-merge-base"));
    if !recorded.is_empty() {
        return recorded;
    }
    let status = read_status(cwd, false).unwrap_or_default();
    if let Some((_, upstream_branch)) = status.upstream.as_deref().map(parse_upstream) {
        if upstream_branch != branch {
            return upstream_branch;
        }
    }
    if let Ok(raw) = gh.run_gh(cwd, &["repo", "view", "--json", "defaultBranchRef"], COMMAND_DEADLINE, None) {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if let Some(name) = val.pointer("/defaultBranchRef/name").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                return name.to_string();
            }
        }
    }
    let has_origin = lines(&git(cwd, &["remote"], COMMAND_DEADLINE).unwrap_or_default()).iter().any(|r| r == "origin");
    default_branch(cwd, has_origin).unwrap_or_else(|| "main".into())
}

/// Mirrors `pullRequestTemplate` in `src/main/agents/git/gitActions.ts`.
pub(crate) fn pull_request_template(cwd: &str, reference: &str) -> Option<String> {
    let mut args = vec!["ls-tree", "-r", "-z", "--full-tree", reference, "--"];
    args.extend_from_slice(&SINGLE_TEMPLATE_PATHS);
    args.extend_from_slice(&[".github/PULL_REQUEST_TEMPLATE", "PULL_REQUEST_TEMPLATE", "docs/PULL_REQUEST_TEMPLATE"]);
    let listing = git(cwd, &args, COMMAND_DEADLINE).unwrap_or_default();
    let mut entries: Vec<(&str, &str)> = Vec::new();
    for record in listing.split('\0').filter(|s| !s.is_empty()) {
        let Some((meta, path)) = record.split_once('\t') else { continue };
        let mut parts = meta.split(' ');
        let (Some(mode), Some(kind), Some(oid), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if kind == "blob" && !mode.is_empty() && mode.bytes().all(|b| b.is_ascii_digit()) && !oid.is_empty() && oid.bytes().all(|b| b.is_ascii_hexdigit()) {
            entries.push((oid, path));
        }
    }
    let chosen_oid = SINGLE_TEMPLATE_PATHS
        .iter()
        .find_map(|wanted| entries.iter().find(|(_, path)| path == wanted).map(|(oid, _)| *oid))
        .or_else(|| {
            let inside: Vec<&str> = entries
                .iter()
                .filter(|(_, path)| is_single_nested_template_md(path))
                .map(|(oid, _)| *oid)
                .collect();
            (inside.len() == 1).then(|| inside[0])
        })?;
    let text = git(cwd, &["cat-file", "blob", chosen_oid], COMMAND_DEADLINE).unwrap_or_default();
    if text.is_empty() {
        None
    } else {
        Some(clip_utf16(&text, TEMPLATE_MAX_CHARS).to_string())
    }
}

/// Matches `/PULL_REQUEST_TEMPLATE\/[^/]+\.md$/iu`.
fn is_single_nested_template_md(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let Some(pos) = lower.rfind("pull_request_template/") else {
        return false;
    };
    let tail = &lower[pos + "pull_request_template/".len()..];
    !tail.contains('/') && tail.len() > 3 && tail.ends_with(".md")
}

/// Strip leading `^\S+\s+` from one `git log --oneline` line.
fn strip_oneline_sha(line: &str) -> &str {
    let after_sha = line.trim_start_matches(|c: char| !js_space(c));
    if after_sha.len() == line.len() {
        return js_trim(line);
    }
    let after_space = after_sha.trim_start_matches(js_space);
    if after_space.len() == after_sha.len() {
        return js_trim(line);
    }
    js_trim(after_space)
}

type PrWriterFn = Arc<dyn Fn(&str, &PullRequestMaterial) -> Option<PullRequestText> + Send + Sync>;

/// Production `GitActionServices` implementation: wires commit drafting, PR text drafting, and GitHub PR creation.
pub struct HostGitActionServices {
    data_directory: PathBuf,
    commit_drafts: CommitDrafts,
    pr_drafts: PullRequestDrafts,
    gh: Arc<dyn GhRunner>,
    hosts: GitHubHosts,
    /// Optional override for tests that supply a custom PR writer without spawning a provider.
    pr_writer_override: Option<PrWriterFn>,
}

impl HostGitActionServices {
    pub fn new(data_directory: PathBuf, runtime: tokio::runtime::Handle, threads: SideWritingThreads) -> Self {
        Self::with_gh(data_directory, runtime, threads, Arc::new(SystemGh))
    }

    pub fn with_gh(data_directory: PathBuf, runtime: tokio::runtime::Handle, threads: SideWritingThreads, gh: Arc<dyn GhRunner>) -> Self {
        let hosts = GitHubHosts::new(Arc::clone(&gh));
        let commit_drafts = CommitDrafts::new(data_directory.clone(), runtime.clone(), Arc::clone(&threads));
        let pr_drafts = PullRequestDrafts::new(data_directory.clone(), runtime, threads);
        Self { data_directory, commit_drafts, pr_drafts, gh, hosts, pr_writer_override: None }
    }

    #[cfg(test)]
    pub(crate) fn with_pr_writer(mut self, writer: PrWriterFn) -> Self {
        self.pr_writer_override = Some(writer);
        self
    }

    fn write_pr_text(&self, thread_id: &str, material: &PullRequestMaterial) -> Option<PullRequestText> {
        match &self.pr_writer_override {
            Some(writer) => writer(thread_id, material),
            None => self.pr_drafts.write(thread_id, material),
        }
    }
}

impl GitActionServices for HostGitActionServices {
    fn write_commit_message(&self, thread_id: &str, material: &CommitMaterial) -> Option<String> {
        self.commit_drafts.write(thread_id, material)
    }

    fn open_pull_request(&self, cwd: &str, branch: &str) -> Result<Option<OpenPullRequest>, String> {
        open_pull_request_with(self.gh.as_ref(), &self.hosts, cwd, branch)
    }

    fn pull_request(&self, thread_id: &str, cwd: &str, branch: &str, progress: &Progress) -> Result<PullRequestStep, String> {
        let status = read_status(cwd, false)?;
        let Some(upstream) = status.upstream.as_deref() else {
            return Err("Current branch has not been pushed. Push before creating a PR.".into());
        };
        let existing = self.open_pull_request(cwd, branch).map_err(|err| {
            let safe = safe_remote(&err);
            let tail = tail_utf16(&safe, 300);
            js_trim(&format!("Could not reach GitHub. Check gh authentication and network access. {tail}")).to_string()
        })?;
        if let Some(existing) = existing {
            return Ok(PullRequestStep {
                status: "opened_existing",
                url: Some(existing.url),
                number: Some(existing.number),
                base: Some(existing.base),
                head: Some(branch.to_string()),
                title: Some(existing.title),
            });
        }
        let base = base_branch_with(self.gh.as_ref(), cwd, branch);
        progress(GitActionEvent::PhaseStarted { phase: GitActionPhase::Pr, stage: "Generating PR content...".into() });
        let (remote, _) = parse_upstream(upstream);
        let remote_ref = format!("refs/remotes/{remote}/{base}^{{commit}}");
        let range = git(cwd, &["rev-parse", "--verify", "-q", &remote_ref], COMMAND_DEADLINE)
            .ok()
            .map(|sha| js_trim(&sha).to_string())
            .filter(|sha| !sha.is_empty())
            .unwrap_or_else(|| base.clone());
        let range_spec = format!("{range}..HEAD");
        let raw_log = git(cwd, &["log", "--oneline", "--no-merges", &range_spec], COMMAND_DEADLINE).unwrap_or_default();
        let mut subjects: Vec<String> = clip_utf16(&raw_log, RANGE_LOG_MAX)
            .split('\n')
            .map(strip_oneline_sha)
            .filter(|line| !line.is_empty())
            .map(ToString::to_string)
            .collect();
        subjects.reverse();
        let stat = clip_utf16(&git(cwd, &["diff", "--stat", &range_spec], COMMAND_DEADLINE).unwrap_or_default(), RANGE_STAT_MAX).to_string();
        let patch = clip_utf16(
            &git(cwd, &["diff", "--no-ext-diff", "--patch", "--minimal", &range_spec], COMMAND_DEADLINE).unwrap_or_default(),
            RANGE_PATCH_MAX,
        )
        .to_string();
        // Follow pull request templates off: the template is not read at all, and the body is Sotto's own sections.
        let follow = WritingSettings::read(&self.data_directory).is_none_or(|s| s.follow_pull_request_templates);
        let template = if follow { pull_request_template(cwd, &range) } else { None };
        let material = PullRequestMaterial {
            subjects: subjects.clone(),
            diff: diff_excerpt(&patch, RANGE_PATCH_MAX).text,
            stat,
            template: template.clone(),
        };
        let written = self.write_pr_text(thread_id, &material);
        let title = written
            .as_ref()
            .map(|w| w.title.clone())
            .or_else(|| subjects.last().cloned())
            .unwrap_or_else(|| STAND_IN_SUBJECT.to_string());
        let body = written
            .as_ref()
            .map(|w| w.body.clone())
            .or(template)
            .unwrap_or_else(|| subjects.iter().map(|s| format!("- {s}")).collect::<Vec<_>>().join("\n"));
        progress(GitActionEvent::PhaseStarted { phase: GitActionPhase::Pr, stage: "Creating pull request...".into() });
        let creation_error = self
            .gh
            .run_gh(
                cwd,
                &["pr", "create", "--base", &base, "--head", branch, "--title", &title, "--body-file", "-"],
                CREATE_PR_DEADLINE,
                Some(body.as_bytes()),
            )
            .err();
        // The write is never repeated. A lost acknowledgement is settled by asking what GitHub now lists: a pull
        // request that is there was created, whatever the reply said; one that is not is the refusal.
        let created = self.open_pull_request(cwd, branch).ok().flatten();
        if let (Some(err), None) = (creation_error, &created) {
            let safe = safe_remote(&err);
            let tail = tail_utf16(&safe, 400);
            return Err(js_trim(&format!("Could not create the pull request. {tail}")).to_string());
        }
        Ok(PullRequestStep {
            status: "created",
            head: Some(branch.to_string()),
            base: Some(base),
            title: Some(created.as_ref().map_or(title, |pr| pr.title.clone())),
            url: created.as_ref().map(|pr| pr.url.clone()),
            number: created.as_ref().map(|pr| pr.number),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::json;
    use tempfile::TempDir;

    use super::*;
    use crate::git_action::{run_stacked_action, GitActionCta, GitActionInput, GitStackedAction};

    type FakeGhHandler = Box<dyn Fn(&[&str], Option<&[u8]>) -> Result<String, String> + Send + Sync>;

    struct FakeGh {
        calls: Mutex<Vec<(Vec<String>, Option<String>)>>,
        handler: FakeGhHandler,
    }

    impl FakeGh {
        fn new(handler: impl Fn(&[&str], Option<&[u8]>) -> Result<String, String> + Send + Sync + 'static) -> Arc<Self> {
            Arc::new(Self { calls: Mutex::new(Vec::new()), handler: Box::new(handler) })
        }
        fn recorded(&self) -> Vec<(Vec<String>, Option<String>)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl GhRunner for FakeGh {
        fn run_gh(&self, _cwd: &str, args: &[&str], _deadline: Duration, stdin: Option<&[u8]>) -> Result<String, String> {
            self.calls
                .lock()
                .unwrap()
                .push((args.iter().map(|s| s.to_string()).collect(), stdin.map(|b| String::from_utf8_lossy(b).into_owned())));
            (self.handler)(args, stdin)
        }
        fn ssh_hostname(&self, _alias: &str) -> Option<String> {
            None
        }
    }

    struct RepoFixture {
        _dir: TempDir,
        data: PathBuf,
        repo: PathBuf,
        remote: PathBuf,
    }

    impl RepoFixture {
        fn new() -> Self {
            let dir = TempDir::new().unwrap();
            let data = dir.path().join("data");
            let repo = dir.path().join("repo");
            let remote = dir.path().join("remote.git");
            fs::create_dir_all(&data).unwrap();
            fs::create_dir_all(&repo).unwrap();
            fs::create_dir_all(&remote).unwrap();
            let run = |cwd: &Path, args: &[&str]| {
                git(&cwd.to_string_lossy(), args, COMMAND_DEADLINE).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
            };
            run(&remote, &["init", "--bare", "--initial-branch=main"]);
            run(&repo, &["init", "--initial-branch=main"]);
            run(&repo, &["config", "user.name", "Test"]);
            run(&repo, &["config", "user.email", "test@example.com"]);
            fs::write(repo.join("work.txt"), "first\n").unwrap();
            run(&repo, &["add", "-A"]);
            run(&repo, &["commit", "-m", "First"]);
            run(&repo, &["remote", "add", "origin", &remote.to_string_lossy()]);
            run(&repo, &["push", "-u", "origin", "main"]);
            Self { _dir: dir, data, repo, remote }
        }

        fn git(&self, args: &[&str]) -> String {
            git(&self.repo.to_string_lossy(), args, COMMAND_DEADLINE).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
        }

        fn cwd(&self) -> String {
            self.repo.to_string_lossy().into_owned()
        }
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    fn no_threads() -> SideWritingThreads {
        Arc::new(|_| Box::pin(async { None }))
    }

    fn record_progress() -> (Progress, Arc<Mutex<Vec<GitActionEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        (Arc::new(move |ev| sink.lock().unwrap().push(ev)), events)
    }

    #[test]
    fn opens_existing_pr_and_ignores_fork_prs_of_the_same_branch_name() {
        let f = RepoFixture::new();
        let rt = runtime();
        let created = Arc::new(AtomicUsize::new(0));
        let created_c = Arc::clone(&created);
        let gh = FakeGh::new(move |args, _| {
            if args.get(1) == Some(&"list") {
                let fork = json!({ "number": 9, "title": "Someone else's feature", "url": "https://github.com/o/r/pull/9", "baseRefName": "main", "headRefName": "feature", "state": "OPEN", "headRepositoryOwner": { "login": "someone" }, "isCrossRepository": true });
                let own = json!({ "number": 35, "title": "Ship the feature", "url": "https://github.com/o/r/pull/35", "baseRefName": "main", "headRefName": "feature", "state": "OPEN", "headRepositoryOwner": { "login": "o" }, "isCrossRepository": false });
                let list = if created_c.load(Ordering::SeqCst) > 0 { json!([fork, own]) } else { json!([fork]) };
                return Ok(list.to_string());
            }
            if args.get(1) == Some(&"create") {
                created_c.fetch_add(1, Ordering::SeqCst);
                return Ok("https://github.com/o/r/pull/35\n".into());
            }
            if args.first() == Some(&"repo") {
                return Ok(json!({ "defaultBranchRef": { "name": "main" } }).to_string());
            }
            Ok(String::new())
        });
        f.git(&["config", &format!("url.{}.insteadOf", f.remote.to_string_lossy()), "https://github.com/o/r"]);
        f.git(&["remote", "set-url", "origin", "https://github.com/o/r"]);
        f.git(&["switch", "-q", "-c", "feature"]);
        fs::write(f.repo.join("work.txt"), "feature\n").unwrap();
        f.git(&["add", "-A"]);
        f.git(&["commit", "-m", "Feature work"]);
        f.git(&["push", "-q", "-u", "origin", "feature"]);

        let services = HostGitActionServices::with_gh(f.data.clone(), rt.handle().clone(), no_threads(), gh.clone())
            .with_pr_writer(Arc::new(|_, _| Some(PullRequestText { title: "Ship the feature".into(), body: "## What changed\n- Feature work".into() })));
        let (progress, _) = record_progress();
        let input = GitActionInput { thread_id: "t".into(), cwd: f.cwd(), action: GitStackedAction::CreatePr, commit_message: None, feature_branch: None, file_paths: None, allow_default_branch: None };
        let res = run_stacked_action(&input, false, &services, &progress).unwrap();
        assert_eq!(res.pr.status, "created");
        assert_eq!(res.pr.number, Some(35));
        assert_eq!(res.pr.url.as_deref(), Some("https://github.com/o/r/pull/35"));
        assert_eq!(gh.recorded().iter().filter(|(a, _)| a.get(1).map(String::as_str) == Some("create")).count(), 1);

        // Running again now sees the branch's own open PR and opens it instead of creating a second.
        let res2 = run_stacked_action(&input, false, &services, &progress).unwrap();
        assert_eq!(res2.pr.status, "opened_existing");
        assert_eq!(res2.pr.number, Some(35));
        assert_eq!(res2.toast.title, "Opened PR #35");
        assert_eq!(res2.toast.cta, GitActionCta::OpenPr { label: "View PR".into(), url: "https://github.com/o/r/pull/35".into() });
        assert_eq!(gh.recorded().iter().filter(|(a, _)| a.get(1).map(String::as_str) == Some("create")).count(), 1);
    }

    #[test]
    fn pushes_reads_template_honors_follow_setting_and_settles_lost_create_ack() {
        let f = RepoFixture::new();
        let rt = runtime();
        fs::create_dir_all(f.repo.join(".github")).unwrap();
        fs::write(f.repo.join(".github").join("pull_request_template.md"), "## What changed\n<!-- say it -->\n\n## Test plan\n").unwrap();
        f.git(&["add", "-A"]);
        f.git(&["commit", "-m", "Add the template"]);
        f.git(&["push", "-q"]);
        f.git(&["switch", "-q", "-c", "feature"]);
        fs::write(f.repo.join("work.txt"), "feature\n").unwrap();
        f.git(&["add", "-A"]);
        f.git(&["commit", "-m", "Feature work"]);

        // First call: create fails AND list stays empty -> refused; second call: create fails BUT list shows #55 -> settled as created!
        let create_calls = Arc::new(AtomicUsize::new(0));
        let create_calls_c = Arc::clone(&create_calls);
        let gh = FakeGh::new(move |args, _| {
            if args.get(1) == Some(&"list") {
                if create_calls_c.load(Ordering::SeqCst) >= 2 {
                    return Ok(json!([{ "number": 55, "title": "Ship the feature", "url": "https://github.com/o/r/pull/55", "baseRefName": "main", "headRefName": "feature", "state": "OPEN" }]).to_string());
                }
                return Ok("[]".into());
            }
            if args.get(1) == Some(&"create") {
                create_calls_c.fetch_add(1, Ordering::SeqCst);
                return Err("gh: connection reset".into());
            }
            if args.first() == Some(&"repo") {
                return Ok(json!({ "defaultBranchRef": { "name": "main" } }).to_string());
            }
            Ok(String::new())
        });

        let seen_templates: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_c = Arc::clone(&seen_templates);
        let services = HostGitActionServices::with_gh(f.data.clone(), rt.handle().clone(), no_threads(), gh.clone())
            .with_pr_writer(Arc::new(move |_, mat| {
                seen_c.lock().unwrap().push(mat.template.clone());
                Some(PullRequestText { title: "Ship the feature".into(), body: "## What changed\n- Done".into() })
            }));

        let (progress, events) = record_progress();
        let input = GitActionInput { thread_id: "t".into(), cwd: f.cwd(), action: GitStackedAction::CreatePr, commit_message: None, feature_branch: None, file_paths: None, allow_default_branch: None };
        let err = run_stacked_action(&input, false, &services, &progress).unwrap_err();
        assert!(err.contains("Could not create the pull request.") && err.contains("connection reset"), "{err}");
        assert!(seen_templates.lock().unwrap()[0].as_deref().is_some_and(|t| t.contains("## Test plan")));
        let stages: Vec<String> = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                GitActionEvent::PhaseStarted { stage, .. } => Some(stage.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(stages, vec!["Pushing to origin...", "Preparing PR...", "Generating PR content...", "Creating pull request..."]);

        // Turn off Follow pull request templates -> template must not be read.
        fs::write(f.data.join("settings.json"), json!({ "followPullRequestTemplates": false }).to_string()).unwrap();
        let res = run_stacked_action(&input, false, &services, &progress).unwrap();
        assert_eq!(res.pr.status, "created");
        assert_eq!(res.pr.number, Some(55));
        assert_eq!(res.toast.title, "Created PR #55");
        assert_eq!(seen_templates.lock().unwrap()[1], None);
        assert_eq!(create_calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn base_repository_honors_gh_resolved_and_remote_order() {
        let mk = |host: &str, owner: &str, name: &str| GitHubRepository { host: host.into(), owner: owner.into(), name: name.into() };
        let remotes = vec![
            ("origin".into(), GitHubRemote { repository: Some(mk("github.com", "fork", "app")), gh_resolved: None }),
            ("upstream".into(), GitHubRemote { repository: Some(mk("github.com", "org", "app")), gh_resolved: None }),
        ];
        assert_eq!(base_repository(&remotes), Some(mk("github.com", "org", "app")));

        let marked = vec![
            ("origin".into(), GitHubRemote { repository: Some(mk("github.com", "fork", "app")), gh_resolved: Some("other/repo".into()) }),
            ("upstream".into(), GitHubRemote { repository: Some(mk("github.com", "org", "app")), gh_resolved: None }),
        ];
        assert_eq!(base_repository(&marked), Some(mk("github.com", "other", "repo")));
    }
}
