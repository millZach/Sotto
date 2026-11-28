//! GitHub pull request reads, repository listings, actions, checkouts, rate-limit tracking, and paired-client
//! confirmation receipts for the Rust host (ADR-0027, #820, #1281, #1290, #1691).
//!
//! Mirrors `src/shared/gitPullRequests.ts`, `src/main/agents/git/github.ts` (rate limit & failure classifiers),
//! `src/main/agents/git/gitPullRequests.ts`, and `src/host/pullRequestConfirmations.ts`.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::git_local::{js_space, js_trim, safe_remote};
use crate::github_pr::{base_repository, read_github_remotes, GhRunner, GitHubHosts, SystemGh};
use crate::ops::{run_action_git as git, GhDetailedError, GitHubRepository};
use crate::protocol_fields::protocol_id;
use crate::workspace::{clip_utf16, format_iso_ms, now_ms};

fn is_protocol_uuid(s: &str) -> bool {
    s.len() == 36 && Uuid::parse_str(s).is_ok()
}

fn now_ms_i64() -> i64 {
    now_ms() as i64
}

pub const GIT_PULL_REQUEST_LINKS_MAX: usize = 50;
pub const GIT_PULL_REQUEST_FILES_MAX: usize = 100;
pub const GIT_PULL_REQUEST_LIST_MAX: usize = 50;
pub const PULL_REQUEST_CONFIRMATION_LIFETIME_MS: i64 = 2 * 60_000;
pub const PULL_REQUEST_READ_LIFETIME_MS: i64 = 30 * 60_000;

const MERGE_SETTINGS_FRESH_MS: i64 = 15 * 60_000;
const PRIMED_FRESH_MS: i64 = 15_000;
const VIEW_TIMEOUT: Duration = Duration::from_secs(30);
const ACTION_TIMEOUT: Duration = Duration::from_secs(120);
const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
const BODY_MAX: usize = 65_536;
const RESERVE_RATIO: f64 = 0.1;
const PAUSE_BASE_MS: i64 = 30_000;
const PAUSE_CAP_MS: i64 = 15 * 60_000;
const RECEIPTS_PER_CLIENT: usize = 8;
const RECEIPTS_MAX: usize = 1_024;
const READS_PER_CLIENT: usize = 32;
const READS_MAX: usize = 1_024;

// ---------------------------------------------------------------------------------------------------------------------
// Pull request URLs, references, commit IDs, actions & wire schemas (`src/shared/gitPullRequests.ts`).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestAddress {
    pub owner: String,
    pub name: String,
    pub number: u64,
}

/// Parses a `https://github.com/<owner>/<name>/pull/<number>(?:[/?#]...)` URL (case-insensitive scheme/host).
pub fn parse_pull_request_address(url: &str) -> Option<PullRequestAddress> {
    let trimmed = js_trim(url);
    if trimmed.is_empty() || trimmed.chars().any(js_space) {
        return None;
    }
    let after = trimmed
        .get(.."https://github.com/".len())
        .filter(|head| head.eq_ignore_ascii_case("https://github.com/"))
        .map(|_| &trimmed["https://github.com/".len()..])?;
    let (owner, rest) = after.split_once('/')?;
    if owner.is_empty() || owner.contains(['?', '#']) {
        return None;
    }
    let (name, rest) = rest.split_once('/')?;
    if name.is_empty() || name.contains(['?', '#']) {
        return None;
    }
    let (pull_seg, rest) = rest.split_once('/')?;
    if !pull_seg.eq_ignore_ascii_case("pull") {
        return None;
    }
    let num_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let num_str = &rest[..num_end];
    if num_str.is_empty() || !num_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let number: u64 = num_str.parse().ok().filter(|&n| n > 0)?;
    Some(PullRequestAddress {
        owner: owner.to_string(),
        name: name.to_string(),
        number,
    })
}

/// Canonical `owner/name#number` key, lowercased (mirrors `pullRequestKey` in `src/shared/gitPullRequests.ts`).
pub fn pull_request_key(url: &str) -> Option<String> {
    let addr = parse_pull_request_address(url)?;
    Some(format!("{}/{}#{}", addr.owner, addr.name, addr.number).to_lowercase())
}

/// Strict URL check matching `gitPullRequestUrlSchema` (<= 2,048 UTF-16 units and matching `GITHUB_PULL_REQUEST_URL`).
pub fn is_valid_pull_request_url(url: &str) -> bool {
    url.encode_utf16().count() <= 2_048 && parse_pull_request_address(url).is_some()
}

/// Parses a `gh pr checkout` line, a GitHub pull request URL, `#42` or `42`, matching `parsePullRequestReference`.
pub fn parse_pull_request_reference(input: &str) -> Option<String> {
    let trimmed = js_trim(input);
    if trimmed.is_empty() {
        return None;
    }
    let normalized = strip_gh_pr_checkout(trimmed).unwrap_or(trimmed);
    if normalized.is_empty() {
        return None;
    }
    if parse_pull_request_address(normalized).is_some() {
        return Some(normalized.to_string());
    }
    let digits = normalized.strip_prefix('#').unwrap_or(normalized);
    if (1..=9).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit()) {
        let num: u64 = digits.parse().ok()?;
        if num > 0 {
            return Some(num.to_string());
        }
    }
    None
}

fn strip_gh_pr_checkout(text: &str) -> Option<&str> {
    let mut parts = text.splitn(4, js_space);
    let p0 = parts.next()?;
    if !p0.eq_ignore_ascii_case("gh") {
        return None;
    }
    let rest = js_trim(text[p0.len()..].trim_start_matches(js_space));
    let pr_end = rest.find(js_space)?;
    if !rest[..pr_end].eq_ignore_ascii_case("pr") {
        return None;
    }
    let rest = rest[pr_end..].trim_start_matches(js_space);
    let co_end = rest.find(js_space)?;
    if !rest[..co_end].eq_ignore_ascii_case("checkout") {
        return None;
    }
    let arg = js_trim(&rest[co_end..]);
    (!arg.is_empty()).then_some(arg)
}

/// Lowercase 40- or 64-character hex commit ID (`gitCommitIdSchema`).
pub fn is_valid_git_commit_id(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64)
        && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `owner/name` of a github.com remote URL, lowercased (mirrors `githubRepositoryOf` in `gitPullRequests.ts`).
pub fn github_repository_of(remote: &str) -> Option<String> {
    let trimmed = js_trim(remote);
    let trimmed = trimmed.strip_suffix('/').unwrap_or(trimmed);
    let rest = if let Some(after) = strip_ci_prefix(trimmed, "https://") {
        if let Some(after_at) = after.split_once('@') {
            if after_at.0.contains('/') || after_at.0.is_empty() {
                return None;
            }
            strip_ci_prefix(after_at.1, "github.com/")?
        } else {
            strip_ci_prefix(after, "github.com/")?
        }
    } else if let Some(after) = strip_ci_prefix(trimmed, "git@github.com:") {
        after
    } else {
        strip_ci_prefix(trimmed, "ssh://git@github.com/")?
    };
    let (owner, name_raw) = rest.split_once('/')?;
    if owner.is_empty()
        || name_raw.is_empty()
        || name_raw.contains('/')
        || owner.chars().any(js_space)
        || name_raw.chars().any(js_space)
    {
        return None;
    }
    let name = match name_raw.len().checked_sub(4).and_then(|at| name_raw.split_at_checked(at)) {
        Some((head, tail)) if tail.eq_ignore_ascii_case(".git") => head,
        _ => name_raw,
    };
    if name.is_empty() {
        return None;
    }
    Some(format!("{owner}/{name}").to_lowercase())
}

fn strip_ci_prefix<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    text.get(..prefix.len())
        .filter(|h| h.eq_ignore_ascii_case(prefix))
        .map(|_| &text[prefix.len()..])
}

fn repository_key(repo: &GitHubRepository) -> String {
    format!("{}/{}/{}", repo.host, repo.owner, repo.name).to_lowercase()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitPullRequestMergeMethod {
    Merge,
    Squash,
    Rebase,
}

impl GitPullRequestMergeMethod {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "merge" => Some(Self::Merge),
            "squash" => Some(Self::Squash),
            "rebase" => Some(Self::Rebase),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::Squash => "squash",
            Self::Rebase => "rebase",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitPullRequestAction {
    Merge,
    Ready,
    Draft,
    Close,
    Reopen,
    UpdateBranch,
    EnableAutoMerge,
    DisableAutoMerge,
}

impl GitPullRequestAction {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "merge" => Some(Self::Merge),
            "ready" => Some(Self::Ready),
            "draft" => Some(Self::Draft),
            "close" => Some(Self::Close),
            "reopen" => Some(Self::Reopen),
            "update-branch" => Some(Self::UpdateBranch),
            "enable-auto-merge" => Some(Self::EnableAutoMerge),
            "disable-auto-merge" => Some(Self::DisableAutoMerge),
            _ => None,
        }
    }

    pub fn needs_confirmation_receipt(self) -> bool {
        matches!(self, Self::Merge | Self::EnableAutoMerge | Self::Close)
    }

    pub fn done_notice(self) -> &'static str {
        match self {
            Self::Merge => "Pull request merged.",
            Self::Ready => "Marked ready for review.",
            Self::Draft => "Converted to draft.",
            Self::Close => "Pull request closed.",
            Self::Reopen => "Pull request reopened.",
            Self::UpdateBranch => "Branch updated with the base branch.",
            Self::EnableAutoMerge => "Auto-merge turned on. It merges as soon as GitHub considers it ready, which may be now.",
            Self::DisableAutoMerge => "Auto-merge turned off.",
        }
    }

    fn failed_prefix(self) -> &'static str {
        match self {
            Self::Merge => "Could not merge this pull request.",
            Self::Ready => "Could not mark this ready for review.",
            Self::Draft => "Could not convert this to a draft.",
            Self::Close => "Could not close this pull request.",
            Self::Reopen => "Could not reopen this pull request.",
            Self::UpdateBranch => "Could not update this branch.",
            Self::EnableAutoMerge => "Could not turn on auto-merge.",
            Self::DisableAutoMerge => "Could not turn off auto-merge.",
        }
    }

    fn hint(self, method: Option<GitPullRequestMergeMethod>) -> &'static str {
        if self == Self::UpdateBranch && method == Some(GitPullRequestMergeMethod::Rebase) {
            return "GitHub refused it. A rebase stops at the first commit that does not apply cleanly; Update branch, with a merge commit, may still work.";
        }
        match self {
            Self::Merge => "GitHub refused the merge. Check that you have write access, that the checks it requires have passed, and that the branch is not conflicting.",
            Self::Ready | Self::Draft => "GitHub refused it. Check that you have write access to this repository.",
            Self::Close => "GitHub refused it. Check that you have write access, or that you opened it.",
            Self::Reopen => "GitHub refused it. Check that you have write access, and that the branch still exists.",
            Self::UpdateBranch => "GitHub refused it. Check that you have write access to the branch, and that it does not conflict with the base.",
            Self::EnableAutoMerge => "GitHub refused it. Check that this repository allows auto-merge, that you have write access, and that there is something left for it to wait on.",
            Self::DisableAutoMerge => "GitHub refused it. Check that you have write access, and that the merge has not already happened.",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmedPullRequestAction {
    Merge,
    EnableAutoMerge,
    Close,
}

impl ConfirmedPullRequestAction {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "merge" => Some(Self::Merge),
            "enable-auto-merge" => Some(Self::EnableAutoMerge),
            "close" => Some(Self::Close),
            _ => None,
        }
    }

    pub fn from_action(action: GitPullRequestAction) -> Option<Self> {
        match action {
            GitPullRequestAction::Merge => Some(Self::Merge),
            GitPullRequestAction::EnableAutoMerge => Some(Self::EnableAutoMerge),
            GitPullRequestAction::Close => Some(Self::Close),
            _ => None,
        }
    }

    fn doing(self) -> &'static str {
        match self {
            Self::Merge => "A merge",
            Self::EnableAutoMerge => "Turning on auto-merge",
            Self::Close => "Closing a pull request",
        }
    }

    fn nothing(self) -> &'static str {
        match self {
            Self::Merge => "Nothing was merged.",
            Self::EnableAutoMerge => "Auto-merge was not turned on.",
            Self::Close => "The pull request was not closed.",
        }
    }

    fn control(self) -> &'static str {
        match self {
            Self::Merge => "Merge",
            Self::EnableAutoMerge => "Merge when ready",
            Self::Close => "Close pull request",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitPullRequestReadFailure {
    GhMissing,
    GhSignedOut,
    Offline,
    Unreadable,
}

impl GitPullRequestReadFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GhMissing => "gh-missing",
            Self::GhSignedOut => "gh-signed-out",
            Self::Offline => "offline",
            Self::Unreadable => "unreadable",
        }
    }
}

#[derive(Debug, Clone)]
pub enum GitPullRequestError {
    Refusal { message: String, failure: GitPullRequestReadFailure },
    Limited { retry_at_ms: i64, message: String },
}

impl GitPullRequestError {
    pub fn refusal(message: impl Into<String>) -> Self {
        Self::Refusal { message: message.into(), failure: GitPullRequestReadFailure::Unreadable }
    }

    pub fn refusal_with(message: impl Into<String>, failure: GitPullRequestReadFailure) -> Self {
        Self::Refusal { message: message.into(), failure }
    }

    pub fn limited(retry_at_ms: i64, now_ms: i64) -> Self {
        Self::Limited {
            retry_at_ms,
            message: format!(
                "GitHub is limiting requests from your gh sign-in, so Sotto could not read the pull request. Nothing was lost. Try again {}.",
                retry_words(retry_at_ms, now_ms)
            ),
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Refusal { message, .. } | Self::Limited { message, .. } => message,
        }
    }

    pub fn read_failure(&self) -> GitPullRequestReadFailure {
        match self {
            Self::Refusal { failure, .. } => *failure,
            Self::Limited { .. } => GitPullRequestReadFailure::Unreadable,
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Strict request & command parsers (matching `src/shared/gitPullRequests.ts` & `src/shared/agents.ts`).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitPullRequestRequest {
    pub thread_id: String,
    pub reference: Option<String>,
}

impl GitPullRequestRequest {
    pub fn parse(value: Option<&Value>) -> Option<Self> {
        let obj = value?.as_object()?;
        if obj.keys().any(|k| k != "threadId" && k != "reference") {
            return None;
        }
        let thread_id = protocol_id(obj.get("threadId"))?;
        let reference = match obj.get("reference") {
            None => None,
            Some(v) => {
                let s = v.as_str()?;
                let len = s.encode_utf16().count();
                if len == 0 || len > 2_048 {
                    return None;
                }
                Some(s.to_string())
            }
        };
        Some(Self { thread_id, reference })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitPullRequestListRequest {
    pub thread_id: String,
}

impl GitPullRequestListRequest {
    pub fn parse(value: Option<&Value>) -> Option<Self> {
        let obj = value?.as_object()?;
        if obj.keys().any(|k| k != "threadId") {
            return None;
        }
        Some(Self { thread_id: protocol_id(obj.get("threadId"))? })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestConfirmationRequest {
    pub thread_id: String,
    pub url: String,
    pub action: ConfirmedPullRequestAction,
    pub method: Option<GitPullRequestMergeMethod>,
    pub read_id: Option<String>,
}

impl PullRequestConfirmationRequest {
    pub fn parse(value: Option<&Value>) -> Option<Self> {
        let obj = value?.as_object()?;
        if obj.keys().any(|k| !matches!(k.as_str(), "threadId" | "url" | "action" | "method" | "readId")) {
            return None;
        }
        let thread_id = protocol_id(obj.get("threadId"))?;
        let url = obj.get("url")?.as_str()?;
        if !is_valid_pull_request_url(url) {
            return None;
        }
        let action = ConfirmedPullRequestAction::parse(obj.get("action")?.as_str()?)?;
        let method = match obj.get("method") {
            None => None,
            Some(v) => Some(GitPullRequestMergeMethod::parse(v.as_str()?)?),
        };
        let read_id = match obj.get("readId") {
            None => None,
            Some(v) => {
                let s = v.as_str()?;
                if !is_protocol_uuid(s) {
                    return None;
                }
                Some(s.to_string())
            }
        };
        Some(Self { thread_id, url: url.to_string(), action, method, read_id })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitPullRequestActionCommand {
    pub thread_id: String,
    pub url: String,
    pub action: GitPullRequestAction,
    pub method: Option<GitPullRequestMergeMethod>,
    pub confirmation: Option<String>,
}

impl GitPullRequestActionCommand {
    /// Strict parser matching `agentCommandSchema` for `git-pull-request-action` from a remote client.
    pub fn parse(cmd: &Map<String, Value>) -> Option<Self> {
        if cmd.get("type").and_then(Value::as_str) != Some("git-pull-request-action") {
            return None;
        }
        if cmd.keys().any(|k| !matches!(k.as_str(), "type" | "threadId" | "url" | "action" | "method" | "confirmation")) {
            return None;
        }
        let thread_id = protocol_id(cmd.get("threadId"))?;
        let url = cmd.get("url")?.as_str()?;
        if !is_valid_pull_request_url(url) {
            return None;
        }
        let action = GitPullRequestAction::parse(cmd.get("action")?.as_str()?)?;
        let method = match cmd.get("method") {
            None => None,
            Some(v) => Some(GitPullRequestMergeMethod::parse(v.as_str()?)?),
        };
        let confirmation = match cmd.get("confirmation") {
            None => None,
            Some(v) => {
                let s = v.as_str()?;
                if !is_protocol_uuid(s) {
                    return None;
                }
                Some(s.to_string())
            }
        };
        Some(Self { thread_id, url: url.to_string(), action, method, confirmation })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitLinkPullRequestCommand {
    pub thread_id: String,
    pub reference: String,
}

impl GitLinkPullRequestCommand {
    pub fn parse(cmd: &Map<String, Value>) -> Option<Self> {
        if cmd.get("type").and_then(Value::as_str) != Some("git-link-pull-request") {
            return None;
        }
        if cmd.keys().any(|k| !matches!(k.as_str(), "type" | "threadId" | "reference")) {
            return None;
        }
        let thread_id = protocol_id(cmd.get("threadId"))?;
        let reference = cmd.get("reference")?.as_str()?;
        let len = reference.encode_utf16().count();
        if len == 0 || len > 2_048 {
            return None;
        }
        Some(Self { thread_id, reference: reference.to_string() })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitUnlinkPullRequestCommand {
    pub thread_id: String,
    pub url: String,
}

impl GitUnlinkPullRequestCommand {
    pub fn parse(cmd: &Map<String, Value>) -> Option<Self> {
        if cmd.get("type").and_then(Value::as_str) != Some("git-unlink-pull-request") {
            return None;
        }
        if cmd.keys().any(|k| !matches!(k.as_str(), "type" | "threadId" | "url")) {
            return None;
        }
        let thread_id = protocol_id(cmd.get("threadId"))?;
        let url = cmd.get("url")?.as_str()?;
        if !is_valid_pull_request_url(url) {
            return None;
        }
        Some(Self { thread_id, url: url.to_string() })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullRequestCheckoutMode {
    Local,
    Worktree,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCheckoutPullRequestCommand {
    pub thread_id: String,
    pub reference: String,
    pub mode: PullRequestCheckoutMode,
}

impl GitCheckoutPullRequestCommand {
    pub fn parse(cmd: &Map<String, Value>) -> Option<Self> {
        if cmd.get("type").and_then(Value::as_str) != Some("git-checkout-pull-request") {
            return None;
        }
        if cmd.keys().any(|k| !matches!(k.as_str(), "type" | "threadId" | "reference" | "mode")) {
            return None;
        }
        let thread_id = protocol_id(cmd.get("threadId"))?;
        let reference = cmd.get("reference")?.as_str()?;
        let len = reference.encode_utf16().count();
        if len == 0 || len > 2_048 {
            return None;
        }
        let mode = match cmd.get("mode")?.as_str()? {
            "local" => PullRequestCheckoutMode::Local,
            "worktree" => PullRequestCheckoutMode::Worktree,
            _ => return None,
        };
        Some(Self { thread_id, reference: reference.to_string(), mode })
    }
}

/// Validates any of the 4 PR commands strictly before receipts / dispatch.
pub fn valid_pull_request_command_shape(cmd: &Map<String, Value>) -> bool {
    match cmd.get("type").and_then(Value::as_str) {
        Some("git-pull-request-action") => GitPullRequestActionCommand::parse(cmd).is_some(),
        Some("git-link-pull-request") => GitLinkPullRequestCommand::parse(cmd).is_some(),
        Some("git-unlink-pull-request") => GitUnlinkPullRequestCommand::parse(cmd).is_some(),
        Some("git-checkout-pull-request") => GitCheckoutPullRequestCommand::parse(cmd).is_some(),
        _ => false,
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// GitHub failure classifiers & rate limit (`src/main/agents/git/github.ts`).

fn contains_ci(haystack: &str, needle: &str) -> bool {
    haystack.to_ascii_lowercase().contains(&needle.to_ascii_lowercase())
}

fn contains_word_ci(haystack: &str, phrase: &str) -> bool {
    let lower = haystack.to_ascii_lowercase();
    let needle = phrase.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut start = 0;
    while let Some(pos) = lower[start..].find(&needle) {
        let abs = start + pos;
        let end = abs + needle.len();
        let left_ok = abs == 0 || !is_word_byte(bytes[abs - 1]);
        let right_ok = end == bytes.len() || !is_word_byte(bytes[end]);
        if left_ok && right_ok {
            return true;
        }
        start = abs + 1;
    }
    false
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

pub fn is_rate_limit_answer(message: &str) -> bool {
    contains_word_ci(message, "api rate limit")
        || contains_word_ci(message, "secondary rate limit")
        || contains_word_ci(message, "rate limit exceeded")
        || contains_word_ci(message, "rate limit already exceeded")
        || contains_word_ci(message, "rate_limited")
        || contains_ci(message, "abuse detection")
        || contains_word_ci(message, "http 429")
        || contains_ci(message, "too many requests")
}

pub fn is_unreachable_answer(message: &str) -> bool {
    contains_word_ci(message, "error connecting to")
        || contains_word_ci(message, "dial tcp")
        || contains_word_ci(message, "no such host")
        || contains_word_ci(message, "getaddrinfo")
        || contains_ci(message, "could not resolve host")
        || contains_word_ci(message, "connectex")
        || contains_ci(message, "connection refused")
        || contains_ci(message, "actively refused")
        || contains_ci(message, "network is unreachable")
        || contains_ci(message, "unreachable network")
        || contains_ci(message, "tls handshake timeout")
        || contains_word_ci(message, "x509:")
        || contains_ci(message, "tls: failed to verify")
        || contains_ci(message, "certificate signed by unknown authority")
        || contains_ci(message, "certificate has expired")
        || contains_ci(message, "certificate is not valid")
        || contains_word_ci(message, "proxyconnect")
}

pub fn is_sign_in_refusal(message: &str) -> bool {
    contains_word_ci(message, "http 401")
        || contains_ci(message, "bad credentials")
        || contains_ci(message, "gh auth login")
        || contains_ci(message, "authentication required")
        || contains_ci(message, "not logged in")
        || contains_ci(message, "requires authentication")
}

fn is_primary_limit(message: &str) -> bool {
    (contains_ci(message, "api rate limit exceeded")
        || contains_ci(message, "api rate limit already exceeded")
        || contains_ci(message, "rate_limited"))
        && !contains_ci(message, "secondary")
}

pub fn retry_words(retry_at_ms: i64, now_ms: i64) -> String {
    let wait_ms = (retry_at_ms - now_ms).max(0);
    if wait_ms < 45_000 {
        return "in about a minute".into();
    }
    let minutes = ((wait_ms as f64) / 60_000.0).ceil() as i64;
    if minutes <= 1 {
        "in about a minute".into()
    } else {
        format!("in about {minutes} minutes")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitHubAsk {
    Background,
    User,
}

#[derive(Debug, Clone)]
pub struct GitHubRateLimitReading {
    pub limit: i64,
    pub remaining: i64,
    pub reset_at: String,
}

fn parse_rate_limit_reading(value: Option<&Value>) -> Option<GitHubRateLimitReading> {
    let obj = value?.as_object()?;
    let limit = obj.get("limit")?.as_i64()?;
    if limit < 0 {
        return None;
    }
    let remaining = obj.get("remaining")?.as_i64()?;
    let reset_at = obj.get("resetAt")?.as_str()?.to_string();
    Some(GitHubRateLimitReading { limit, remaining, reset_at })
}

fn refusal_reading(stdout: &str) -> Option<GitHubRateLimitReading> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return None;
    }
    let val: Value = serde_json::from_str(trimmed).ok()?;
    parse_rate_limit_reading(val.get("data").and_then(|d| d.get("rateLimit")))
}

/// Parses an ISO-8601 UTC/offset timestamp into epoch milliseconds (matching `Date.parse` for GitHub timestamps).
fn parse_iso_ms(text: &str) -> Option<i64> {
    let trimmed = text.trim();
    if trimmed.len() < 19 {
        return None;
    }
    let bytes = trimmed.as_bytes();
    let parse_u = |range: std::ops::Range<usize>| -> Option<i64> {
        std::str::from_utf8(bytes.get(range)?).ok()?.parse::<i64>().ok()
    };
    let year = parse_u(0..4)?;
    if bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
        return None;
    }
    let month = parse_u(5..7)?;
    let day = parse_u(8..10)?;
    if !matches!(bytes.get(10), Some(b'T' | b't' | b' ')) {
        return None;
    }
    let hour = parse_u(11..13)?;
    if bytes.get(13) != Some(&b':') || bytes.get(16) != Some(&b':') {
        return None;
    }
    let min = parse_u(14..16)?;
    let sec = parse_u(17..19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || !(0..=23).contains(&hour) || !(0..=59).contains(&min) || !(0..=60).contains(&sec) {
        return None;
    }
    let mut pos = 19;
    let mut millis: i64 = 0;
    if bytes.get(pos) == Some(&b'.') {
        pos += 1;
        let frac_start = pos;
        while pos < bytes.len() && bytes[pos].is_ascii_digit() {
            pos += 1;
        }
        let frac = std::str::from_utf8(&bytes[frac_start..pos]).ok()?;
        if frac.is_empty() {
            return None;
        }
        let padded = format!("{frac:0<3}");
        millis = padded[..3].parse::<i64>().ok()?;
    }
    let offset_secs: i64 = match bytes.get(pos) {
        Some(b'Z' | b'z') if pos + 1 == bytes.len() => 0,
        Some(sign @ (b'+' | b'-')) => {
            let sign_mul = if *sign == b'+' { 1 } else { -1 };
            let rest = std::str::from_utf8(&bytes[pos + 1..]).ok()?;
            let (oh, om) = if rest.len() == 5 && rest.as_bytes()[2] == b':' {
                (rest[0..2].parse::<i64>().ok()?, rest[3..5].parse::<i64>().ok()?)
            } else if rest.len() == 4 {
                (rest[0..2].parse::<i64>().ok()?, rest[2..4].parse::<i64>().ok()?)
            } else {
                return None;
            };
            if oh > 23 || om > 59 {
                return None;
            }
            sign_mul * (oh * 3600 + om * 60)
        }
        _ => return None,
    };
    let days = days_from_civil(year, month, day)?;
    let secs = days * 86_400 + hour * 3600 + min * 60 + sec - offset_secs;
    Some(secs * 1000 + millis)
}

/// Howard Hinnant's civil-to-days algorithm (days since 1970-01-01).
fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => return None,
    };
    if day > max_day {
        return None;
    }
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

#[derive(Default)]
struct HostRateLimit {
    login: Option<String>,
    reading: Option<(i64, i64, i64)>, // (limit, remaining, reset_at_ms)
    pause_until: i64,
    failures: u32,
    paused_at: u64,
    reading_at: u64,
}

struct RateLimitInner {
    hosts: HashMap<String, HostRateLimit>,
    sequence: u64,
}

pub struct GitHubRateLimit {
    inner: Mutex<RateLimitInner>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl Default for GitHubRateLimit {
    fn default() -> Self {
        Self::new()
    }
}

impl GitHubRateLimit {
    pub fn new() -> Self {
        Self::with_clock(Arc::new(now_ms_i64))
    }

    pub fn with_clock(clock: Arc<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Self {
            inner: Mutex::new(RateLimitInner { hosts: HashMap::new(), sequence: 0 }),
            clock,
        }
    }

    pub fn now(&self) -> i64 {
        (self.clock)()
    }

    pub fn retry_at(&self, host: &str, ask: GitHubAsk) -> Option<i64> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let entry = inner.hosts.get(host)?;
        let now = (self.clock)();
        let reading = entry.reading.filter(|&(_, _, reset_at)| reset_at > now);
        if let Some((_, remaining, reset_at)) = reading {
            if remaining <= 0 {
                return Some(reset_at);
            }
        }
        if ask == GitHubAsk::User {
            return None;
        }
        if entry.pause_until > now {
            return Some(entry.pause_until);
        }
        if let Some((limit, remaining, reset_at)) = reading {
            if (remaining as f64) < (limit as f64) * RESERVE_RATIO {
                return Some(reset_at);
            }
        }
        None
    }

    pub fn asking(&self) -> u64 {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.sequence += 1;
        inner.sequence
    }

    pub fn answered(&self, host: &str, asked: u64, reading: Option<&GitHubRateLimitReading>, login: Option<&str>) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let entry = inner.hosts.entry(host.to_string()).or_default();
        if let Some(login) = login.filter(|s| !s.is_empty()) {
            if let Some(ref prev) = entry.login {
                if !prev.eq_ignore_ascii_case(login) {
                    entry.reading = None;
                }
            }
            entry.login = Some(login.to_string());
        }
        if asked > entry.paused_at {
            entry.pause_until = 0;
            entry.failures = 0;
        }
        if let Some(r) = reading {
            if let Some(reset_at) = parse_iso_ms(&r.reset_at) {
                if asked > entry.reading_at {
                    entry.reading = Some((r.limit, r.remaining, reset_at));
                    entry.reading_at = asked;
                }
            }
        }
    }

    pub fn limited(&self, host: &str, message: &str, reading: Option<&GitHubRateLimitReading>) -> i64 {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.sequence += 1;
        let seq = inner.sequence;
        let entry = inner.hosts.entry(host.to_string()).or_default();
        let now = (self.clock)();
        entry.paused_at = seq;
        entry.failures = entry.failures.saturating_add(1);
        if let Some(r) = reading {
            if let Some(reset_at) = parse_iso_ms(&r.reset_at) {
                entry.reading = Some((r.limit, r.remaining, reset_at));
                entry.reading_at = seq;
            }
        }
        let exp = entry.failures.saturating_sub(1).min(10);
        let backoff = PAUSE_BASE_MS.saturating_mul(1_i64 << exp).min(PAUSE_CAP_MS);
        let mut until = now + backoff;
        let spent = is_primary_limit(message) || entry.reading.is_some_and(|(_, rem, _)| rem <= 0);
        if spent {
            if let Some((_, _, reset_at)) = entry.reading {
                if reset_at > now {
                    until = reset_at;
                }
            }
        }
        entry.pause_until = entry.pause_until.max(until);
        entry.pause_until
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Pull request GraphQL reads, list, actions & checkouts (`src/main/agents/git/gitPullRequests.ts`).

fn pull_request_query(with_merge_settings: bool) -> String {
    let settings = if with_merge_settings {
        "\n    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed"
    } else {
        ""
    };
    format!(
        "query PullRequestDetail($owner: String!, $name: String!, $number: Int!, $pullRef: String!) {{\n\
  rateLimit {{ limit remaining resetAt }}\n\
  viewer {{ login }}\n\
  repository(owner: $owner, name: $name) {{{settings}\n\
    pullRequest(number: $number) {{\n\
      number title url body state isDraft mergeable reviewDecision baseRefName headRefName headRefOid isCrossRepository mergedAt createdAt additions deletions author {{ login }}\n\
      headRepositoryOwner {{ login }} autoMergeRequest {{ mergeMethod }} viewerCanUpdateBranch\n\
      baseRef {{ compare(headRef: $pullRef) {{ behindBy }} }}\n\
      latestOpinionatedReviews(last: 50) {{ nodes {{ state url author {{ login }} }} }}\n\
      changedFiles files(first: {GIT_PULL_REQUEST_FILES_MAX}) {{ nodes {{ path additions deletions }} }}\n\
      commits(last: 1) {{ nodes {{ commit {{ statusCheckRollup {{ contexts(first: 100) {{ nodes {{\n\
        __typename\n\
        ... on CheckRun {{ name status conclusion detailsUrl startedAt completedAt checkSuite {{ workflowRun {{ workflow {{ name }} }} }} }}\n\
        ... on StatusContext {{ context state targetUrl description }}\n\
      }} }} }} }} }} }}\n\
    }}\n\
  }}\n\
}}"
    )
}

const PULL_REQUEST_LIST_QUERY: &str = "query PullRequestList($owner: String!, $name: String!) {\n\
  rateLimit { limit remaining resetAt }\n\
  viewer { login }\n\
  repository(owner: $owner, name: $name) {\n\
    pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {\n\
      totalCount\n\
      nodes {\n\
        number title url isDraft updatedAt additions deletions changedFiles reviewDecision headRefName author { login }\n\
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }\n\
      }\n\
    }\n\
  }\n\
}";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestView {
    pub number: u64,
    pub url: String,
    pub title: String,
    pub body: String,
    pub state: String, // "open" | "closed" | "merged"
    pub draft: bool,
    pub base_branch: String,
    pub head_branch: String,
    pub cross_repository: bool,
    pub review_decision: Option<String>,
    pub reviews: Vec<Value>,
    pub mergeable: String,
    pub checks: Vec<Value>,
    pub checks_unknown: bool,
    pub merge_methods: Vec<GitPullRequestMergeMethod>,
    pub auto_merge_allowed: bool,
    pub auto_merge: Option<Value>,
    pub merged_at: Option<String>,
    pub behind_by: Option<u64>,
    pub can_update_branch: bool,
    pub files: Option<Vec<Value>>,
    pub changed_files: Option<u64>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub author: Option<String>,
    pub head_id: Option<String>,
    pub created_at: Option<String>,
    pub observed_at: String,
}

impl PullRequestView {
    pub fn to_detail_json(&self, linked: Option<&str>, branch: bool) -> Value {
        let mut obj = Map::new();
        if let Some(ref head_id) = self.head_id {
            obj.insert("headId".into(), json!(head_id));
        }
        if let Some(ref created_at) = self.created_at {
            obj.insert("createdAt".into(), json!(created_at));
        }
        obj.insert("observedAt".into(), json!(self.observed_at));
        obj.insert("number".into(), json!(self.number));
        obj.insert("url".into(), json!(self.url));
        obj.insert("title".into(), json!(self.title));
        obj.insert("body".into(), json!(self.body));
        obj.insert("state".into(), json!(self.state));
        obj.insert("draft".into(), json!(self.draft));
        obj.insert("baseBranch".into(), json!(self.base_branch));
        obj.insert("headBranch".into(), json!(self.head_branch));
        obj.insert("crossRepository".into(), json!(self.cross_repository));
        obj.insert("reviewDecision".into(), match &self.review_decision {
            Some(v) => json!(v),
            None => Value::Null,
        });
        obj.insert("mergeable".into(), json!(self.mergeable));
        obj.insert("checks".into(), Value::Array(self.checks.clone()));
        obj.insert("checksUnknown".into(), json!(self.checks_unknown));
        obj.insert("reviews".into(), Value::Array(self.reviews.clone()));
        obj.insert(
            "mergeMethods".into(),
            Value::Array(self.merge_methods.iter().map(|m| json!(m.as_str())).collect()),
        );
        obj.insert("autoMergeAllowed".into(), json!(self.auto_merge_allowed));
        obj.insert("autoMerge".into(), self.auto_merge.clone().unwrap_or(Value::Null));
        obj.insert("mergedAt".into(), match &self.merged_at {
            Some(v) => json!(v),
            None => Value::Null,
        });
        obj.insert("behindBy".into(), match self.behind_by {
            Some(v) => json!(v),
            None => Value::Null,
        });
        obj.insert("canUpdateBranch".into(), json!(self.can_update_branch));
        if let Some(ref files) = self.files {
            obj.insert("files".into(), Value::Array(files.clone()));
        }
        if let Some(n) = self.changed_files {
            obj.insert("changedFiles".into(), json!(n));
        }
        if let Some(n) = self.additions {
            obj.insert("additions".into(), json!(n));
        }
        if let Some(n) = self.deletions {
            obj.insert("deletions".into(), json!(n));
        }
        if let Some(ref author) = self.author {
            obj.insert("author".into(), json!(author));
        }
        obj.insert("linked".into(), match linked {
            Some(v) => json!(v),
            None => Value::Null,
        });
        obj.insert("branch".into(), json!(branch));
        Value::Object(obj)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitPullRequestPress {
    pub url: String,
    pub action: GitPullRequestAction,
    pub method: Option<GitPullRequestMergeMethod>,
    pub match_head_commit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedWorktreeBranch {
    pub branch: String,
    pub worktree_path: Option<String>,
}

#[derive(Clone)]
struct MergeSettings {
    at: i64,
    merge_methods: Vec<GitPullRequestMergeMethod>,
    auto_merge_allowed: bool,
}

#[derive(Clone)]
enum PrimedEntry {
    View { at: i64, view: Box<PullRequestView> },
    Limited { at: i64, retry_at_ms: i64 },
}

pub struct GitPullRequests {
    gh: Arc<dyn GhRunner>,
    hosts: Arc<GitHubHosts>,
    rate_limit: Arc<GitHubRateLimit>,
    merge_settings: Mutex<HashMap<String, MergeSettings>>,
    primed: Mutex<HashMap<String, PrimedEntry>>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl GitPullRequests {
    pub fn new(hosts: Arc<GitHubHosts>) -> Self {
        let gh = hosts.runner();
        Self::with_parts(gh, hosts, Arc::new(GitHubRateLimit::new()), Arc::new(now_ms_i64))
    }

    pub fn with_system_gh() -> Self {
        let gh: Arc<dyn GhRunner> = Arc::new(SystemGh);
        let hosts = Arc::new(GitHubHosts::new(Arc::clone(&gh)));
        Self::with_parts(gh, hosts, Arc::new(GitHubRateLimit::new()), Arc::new(now_ms_i64))
    }

    pub fn with_parts(
        gh: Arc<dyn GhRunner>,
        hosts: Arc<GitHubHosts>,
        rate_limit: Arc<GitHubRateLimit>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        Self {
            gh,
            hosts,
            rate_limit,
            merge_settings: Mutex::new(HashMap::new()),
            primed: Mutex::new(HashMap::new()),
            clock,
        }
    }

    pub fn view(&self, cwd: &str, reference: &str) -> Result<PullRequestView, GitPullRequestError> {
        if let Some(key) = pull_request_key(reference) {
            let entry = self.primed.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
            if let Some(entry) = entry {
                let now = (self.clock)();
                match entry {
                    PrimedEntry::View { at, view } if now - at < PRIMED_FRESH_MS => return Ok(*view),
                    PrimedEntry::Limited { at, retry_at_ms } if now - at < PRIMED_FRESH_MS && now < retry_at_ms => {
                        return Err(GitPullRequestError::limited(retry_at_ms, now));
                    }
                    _ => {}
                }
            }
        }
        self.read(cwd, reference)
    }

    fn read(&self, cwd: &str, reference: &str) -> Result<PullRequestView, GitPullRequestError> {
        let selector = parse_pull_request_reference(reference)
            .ok_or_else(|| GitPullRequestError::refusal("Use a pull request URL, 123, or #123."))?;
        let (repo, number) = self.address_of(cwd, &selector)?;
        let now = (self.clock)();
        if let Some(retry_at) = self.rate_limit.retry_at(&repo.host, GitHubAsk::User) {
            return Err(GitPullRequestError::limited(retry_at, now));
        }
        let settings_key = repository_key(&repo);
        let kept = {
            let map = self.merge_settings.lock().unwrap_or_else(|e| e.into_inner());
            map.get(&settings_key)
                .filter(|s| now - s.at < MERGE_SETTINGS_FRESH_MS)
                .cloned()
        };
        let query = pull_request_query(kept.is_none());
        let owner_arg = format!("owner={}", repo.owner);
        let name_arg = format!("name={}", repo.name);
        let number_arg = format!("number={number}");
        let pull_ref_arg = format!("pullRef=refs/pull/{number}/head");
        let query_arg = format!("query={query}");
        let mut args: Vec<&str> = vec!["api", "graphql"];
        if repo.host != "github.com" {
            args.push("--hostname");
            args.push(&repo.host);
        }
        args.extend(["-f", &query_arg, "-f", &owner_arg, "-f", &name_arg, "-F", &number_arg, "-f", &pull_ref_arg]);

        let asked = self.rate_limit.asking();
        let answer: Value = match self.gh.run_gh_detailed(cwd, &args, VIEW_TIMEOUT, None) {
            Ok(stdout) => parse_graphql_answer(&stdout)?,
            Err(err) => {
                if is_rate_limit_answer(&err.message) {
                    let reading = refusal_reading(&err.stdout);
                    let until = self.rate_limit.limited(&repo.host, &err.message, reading.as_ref());
                    return Err(GitPullRequestError::limited(until, (self.clock)()));
                }
                if let Some(partial) = partial_answer(&err.stdout) {
                    partial
                } else {
                    let reason = reason_of(&err.message);
                    let tail = if reason.is_empty() {
                        "Check gh authentication and network access."
                    } else {
                        &reason
                    };
                    return Err(GitPullRequestError::refusal_with(
                        format!("Could not read the pull request. {tail}").trim(),
                        gh_read_failure(&err),
                    ));
                }
            }
        };

        let data = answer.get("data").and_then(Value::as_object).ok_or_else(|| {
            GitPullRequestError::refusal("GitHub answered in a form Sotto could not read. Refresh to try again.")
        })?;
        let rl = parse_rate_limit_reading(data.get("rateLimit"));
        let login = data.get("viewer").and_then(|v| v.get("login")).and_then(Value::as_str);
        self.rate_limit.answered(&repo.host, asked, rl.as_ref(), login);

        let repo_obj = match data.get("repository") {
            Some(Value::Object(obj)) => obj,
            _ => {
                return Err(GitPullRequestError::refusal(format!(
                    "Could not read the pull request. GitHub has no pull request #{number} in {}/{} that your gh sign-in can see.",
                    repo.owner, repo.name
                )));
            }
        };
        let raw = match repo_obj.get("pullRequest") {
            Some(Value::Object(pr)) => pr,
            _ => {
                return Err(GitPullRequestError::refusal(format!(
                    "Could not read the pull request. GitHub has no pull request #{number} in {}/{} that your gh sign-in can see.",
                    repo.owner, repo.name
                )));
            }
        };
        let pr_number = raw.get("number").and_then(Value::as_u64).filter(|&n| n > 0).ok_or_else(|| {
            GitPullRequestError::refusal("GitHub answered in a form Sotto could not read. Refresh to try again.")
        })?;
        let title = raw.get("title").and_then(Value::as_str).ok_or_else(|| {
            GitPullRequestError::refusal("GitHub answered in a form Sotto could not read. Refresh to try again.")
        })?;
        let url = raw.get("url").and_then(Value::as_str).ok_or_else(|| {
            GitPullRequestError::refusal("GitHub answered in a form Sotto could not read. Refresh to try again.")
        })?;
        let raw_state = raw.get("state").and_then(Value::as_str).ok_or_else(|| {
            GitPullRequestError::refusal("GitHub answered in a form Sotto could not read. Refresh to try again.")
        })?;
        if parse_pull_request_address(url).is_none() {
            return Err(GitPullRequestError::refusal("Sotto shows pull requests from GitHub only."));
        }

        let methods = kept.unwrap_or_else(|| self.keep_merge_settings(&settings_key, repo_obj));
        let merged_at = raw.get("mergedAt").and_then(Value::as_str).filter(|s| !s.is_empty()).map(|s| cut_utf16(s, 64));
        let state = if merged_at.is_some() || raw_state.eq_ignore_ascii_case("MERGED") {
            "merged"
        } else if raw_state.eq_ignore_ascii_case("CLOSED") {
            "closed"
        } else {
            "open"
        }
        .to_string();
        let review_decision = raw.get("reviewDecision").and_then(Value::as_str).and_then(|s| {
            match s.to_ascii_uppercase().as_str() {
                "APPROVED" => Some("approved".to_string()),
                "CHANGES_REQUESTED" => Some("changes_requested".to_string()),
                "REVIEW_REQUIRED" => Some("review_required".to_string()),
                _ => None,
            }
        });
        let mergeable = raw
            .get("mergeable")
            .and_then(Value::as_str)
            .map(|s| match s.to_ascii_uppercase().as_str() {
                "MERGEABLE" => "mergeable",
                "CONFLICTING" => "conflicting",
                _ => "unknown",
            })
            .unwrap_or("unknown")
            .to_string();

        let commits = raw.get("commits");
        let contexts = commits
            .and_then(|c| c.get("nodes"))
            .and_then(Value::as_array)
            .and_then(|arr| arr.last())
            .and_then(|n| n.get("commit"))
            .and_then(|c| c.get("statusCheckRollup"))
            .and_then(|r| r.get("contexts"))
            .and_then(|c| c.get("nodes"))
            .and_then(Value::as_array);
        let errors_arr = answer.get("errors").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        let has_null_context = contexts.is_some_and(|nodes| nodes.iter().any(Value::is_null));
        let checks_unknown = commits.is_none_or(Value::is_null) || checks_refused(errors_arr) || has_null_context;
        let checks: Vec<Value> = contexts
            .map(|nodes| nodes.iter().filter_map(|n| n.as_object().map(check_of)).take(200).collect())
            .unwrap_or_default();

        let reviews = raw
            .get("latestOpinionatedReviews")
            .and_then(|r| r.get("nodes"))
            .and_then(Value::as_array)
            .map(|nodes| reviews_of(nodes))
            .unwrap_or_default();

        let files = raw
            .get("files")
            .and_then(|f| f.get("nodes"))
            .and_then(Value::as_array)
            .map(|nodes| files_of(nodes));

        let auto_merge = raw.get("autoMergeRequest").and_then(Value::as_object).map(|req| {
            let method = req.get("mergeMethod").and_then(Value::as_str).and_then(method_of);
            json!({ "method": method.map(GitPullRequestMergeMethod::as_str) })
        });
        let behind_by = raw
            .get("baseRef")
            .and_then(|b| b.get("compare"))
            .and_then(|c| c.get("behindBy"))
            .and_then(Value::as_u64);

        Ok(PullRequestView {
            number: pr_number,
            url: url.to_string(),
            title: cut_utf16(title, 500),
            body: cut_utf16(raw.get("body").and_then(Value::as_str).unwrap_or(""), BODY_MAX),
            state,
            draft: raw.get("isDraft").and_then(Value::as_bool) == Some(true),
            base_branch: raw.get("baseRefName").and_then(Value::as_str).unwrap_or("").to_string(),
            head_branch: raw.get("headRefName").and_then(Value::as_str).unwrap_or("").to_string(),
            cross_repository: raw.get("isCrossRepository").and_then(Value::as_bool) == Some(true),
            review_decision,
            reviews,
            mergeable,
            checks,
            checks_unknown,
            merge_methods: methods.merge_methods,
            auto_merge_allowed: methods.auto_merge_allowed,
            auto_merge,
            merged_at,
            behind_by,
            can_update_branch: raw.get("viewerCanUpdateBranch").and_then(Value::as_bool) == Some(true),
            files,
            changed_files: raw.get("changedFiles").and_then(Value::as_u64),
            additions: raw.get("additions").and_then(Value::as_u64),
            deletions: raw.get("deletions").and_then(Value::as_u64),
            author: raw
                .get("author")
                .and_then(|a| a.get("login"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|s| cut_utf16(s, 100)),
            head_id: raw.get("headRefOid").and_then(Value::as_str).filter(|s| !s.is_empty()).map(ToString::to_string),
            created_at: raw.get("createdAt").and_then(Value::as_str).filter(|s| !s.is_empty()).map(|s| cut_utf16(s, 64)),
            observed_at: format_iso_ms((self.clock)()),
        })
    }

    pub fn list(&self, cwd: &str) -> Result<Option<Value>, GitPullRequestError> {
        let remotes = read_github_remotes(cwd, &self.hosts).unwrap_or_default();
        let Some(repo) = base_repository(&remotes) else {
            return Ok(None);
        };
        let now = (self.clock)();
        if let Some(retry_at) = self.rate_limit.retry_at(&repo.host, GitHubAsk::User) {
            return Err(GitPullRequestError::limited(retry_at, now));
        }
        let query_arg = format!("query={PULL_REQUEST_LIST_QUERY}");
        let owner_arg = format!("owner={}", repo.owner);
        let name_arg = format!("name={}", repo.name);
        let mut args: Vec<&str> = vec!["api", "graphql"];
        if repo.host != "github.com" {
            args.push("--hostname");
            args.push(&repo.host);
        }
        args.extend(["-f", &query_arg, "-f", &owner_arg, "-f", &name_arg]);

        let asked = self.rate_limit.asking();
        let answer: Value = match self.gh.run_gh_detailed(cwd, &args, VIEW_TIMEOUT, None) {
            Ok(stdout) => parse_graphql_list_answer(&stdout)?,
            Err(err) => {
                if is_rate_limit_answer(&err.message) {
                    let reading = refusal_reading(&err.stdout);
                    let until = self.rate_limit.limited(&repo.host, &err.message, reading.as_ref());
                    return Err(GitPullRequestError::limited(until, (self.clock)()));
                }
                let reason = reason_of(&err.message);
                let tail = if reason.is_empty() {
                    "Check gh authentication and network access."
                } else {
                    &reason
                };
                return Err(GitPullRequestError::refusal_with(
                    format!("Could not read the open pull requests. {tail}").trim(),
                    gh_read_failure(&err),
                ));
            }
        };

        let data = answer.get("data").and_then(Value::as_object).ok_or_else(|| {
            GitPullRequestError::refusal("GitHub answered in a form Sotto could not read. Refresh to try again.")
        })?;
        let rl = parse_rate_limit_reading(data.get("rateLimit"));
        let login = data.get("viewer").and_then(|v| v.get("login")).and_then(Value::as_str);
        self.rate_limit.answered(&repo.host, asked, rl.as_ref(), login);

        let prs = data
            .get("repository")
            .and_then(|r| r.get("pullRequests"))
            .and_then(Value::as_object)
            .ok_or_else(|| {
                GitPullRequestError::refusal(format!(
                    "Could not read the open pull requests. GitHub has no repository {}/{} that your gh sign-in can see.",
                    repo.owner, repo.name
                ))
            })?;
        let total = prs.get("totalCount").and_then(Value::as_u64).ok_or_else(|| {
            GitPullRequestError::refusal("GitHub answered in a form Sotto could not read. Refresh to try again.")
        })?;
        let nodes = prs.get("nodes").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        let mut items = Vec::new();
        for node in nodes {
            if items.len() >= GIT_PULL_REQUEST_LIST_MAX {
                break;
            }
            let Some(obj) = node.as_object() else { continue };
            let Some(number) = obj.get("number").and_then(Value::as_u64).filter(|&n| n > 0) else { continue };
            let Some(title) = obj.get("title").and_then(Value::as_str) else { continue };
            let Some(url) = obj.get("url").and_then(Value::as_str) else { continue };
            if parse_pull_request_address(url).is_none() {
                continue;
            }
            let review_decision = obj.get("reviewDecision").and_then(Value::as_str).and_then(|s| {
                match s.to_ascii_uppercase().as_str() {
                    "APPROVED" => Some("approved"),
                    "CHANGES_REQUESTED" => Some("changes_requested"),
                    "REVIEW_REQUIRED" => Some("review_required"),
                    _ => None,
                }
            });
            let rollup_state = obj
                .get("commits")
                .and_then(|c| c.get("nodes"))
                .and_then(Value::as_array)
                .and_then(|arr| arr.last())
                .and_then(|n| n.get("commit"))
                .and_then(|c| c.get("statusCheckRollup"))
                .and_then(|r| r.get("state"))
                .and_then(Value::as_str);
            items.push(json!({
                "number": number,
                "url": cut_utf16(url, 2_048),
                "title": cut_utf16(title, 500),
                "draft": obj.get("isDraft").and_then(Value::as_bool) == Some(true),
                "author": obj.get("author").and_then(|a| a.get("login")).and_then(Value::as_str).filter(|s| !s.is_empty()).map(|s| cut_utf16(s, 100)),
                "headBranch": cut_utf16(obj.get("headRefName").and_then(Value::as_str).unwrap_or(""), 512),
                "updatedAt": time_of(obj.get("updatedAt").and_then(Value::as_str)),
                "additions": obj.get("additions").and_then(Value::as_u64).unwrap_or(0),
                "deletions": obj.get("deletions").and_then(Value::as_u64).unwrap_or(0),
                "changedFiles": obj.get("changedFiles").and_then(Value::as_u64).unwrap_or(0),
                "checks": list_checks_of(rollup_state),
                "reviewDecision": review_decision,
            }));
        }
        Ok(Some(json!({
            "repository": format!("{}/{}", repo.owner, repo.name),
            "total": total,
            "pullRequests": items,
        })))
    }

    pub fn act(&self, cwd: &str, press: &GitPullRequestPress) -> Result<Option<PullRequestView>, GitPullRequestError> {
        if parse_pull_request_address(&press.url).is_none() {
            return Err(GitPullRequestError::refusal("Sotto acts on pull requests from GitHub only."));
        }
        if matches!(press.action, GitPullRequestAction::Merge | GitPullRequestAction::EnableAutoMerge) && press.method.is_none() {
            return Err(GitPullRequestError::refusal("Choose a merge method first."));
        }
        if press.action == GitPullRequestAction::UpdateBranch && press.method == Some(GitPullRequestMergeMethod::Squash) {
            return Err(GitPullRequestError::refusal("Update the branch with a merge commit or a rebase."));
        }
        if let Some(ref commit) = press.match_head_commit {
            if !is_valid_git_commit_id(commit) {
                return Err(GitPullRequestError::refusal(
                    "Sotto could not tell which commit you confirmed. Nothing was changed. Refresh the pull request and press it again.",
                ));
            }
        }
        let head_flag = press
            .match_head_commit
            .as_deref()
            .filter(|_| matches!(press.action, GitPullRequestAction::Merge | GitPullRequestAction::EnableAutoMerge))
            .map(|sha| format!("--match-head-commit={sha}"));
        let method_flag = press.method.map(|m| format!("--{}", m.as_str()));

        let mut args: Vec<&str> = vec!["pr"];
        match press.action {
            GitPullRequestAction::Merge => {
                args.push("merge");
                args.push(&press.url);
                if let Some(ref mf) = method_flag {
                    args.push(mf);
                }
                if let Some(ref hf) = head_flag {
                    args.push(hf);
                }
            }
            GitPullRequestAction::EnableAutoMerge => {
                args.push("merge");
                args.push(&press.url);
                args.push("--auto");
                if let Some(ref mf) = method_flag {
                    args.push(mf);
                }
                if let Some(ref hf) = head_flag {
                    args.push(hf);
                }
            }
            GitPullRequestAction::DisableAutoMerge => {
                args.extend(["merge", &press.url, "--disable-auto"]);
            }
            GitPullRequestAction::UpdateBranch => {
                args.extend(["update-branch", &press.url]);
                if press.method == Some(GitPullRequestMergeMethod::Rebase) {
                    args.push("--rebase");
                }
            }
            GitPullRequestAction::Ready => {
                args.extend(["ready", &press.url]);
            }
            GitPullRequestAction::Draft => {
                args.extend(["ready", &press.url, "--undo"]);
            }
            GitPullRequestAction::Close => {
                args.extend(["close", &press.url]);
            }
            GitPullRequestAction::Reopen => {
                args.extend(["reopen", &press.url]);
            }
        }

        let failure = self.gh.run_gh_detailed(cwd, &args, ACTION_TIMEOUT, None).err();
        let mut after: Option<PullRequestView> = None;
        let mut retry_at_ms: Option<i64> = None;
        match self.read(cwd, &press.url) {
            Ok(v) => after = Some(v),
            Err(GitPullRequestError::Limited { retry_at_ms: r, .. }) => retry_at_ms = Some(r),
            Err(GitPullRequestError::Refusal { .. }) => {}
        }
        if let Some(key) = pull_request_key(&press.url) {
            let at = (self.clock)();
            let mut primed = self.primed.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(ref view) = after {
                primed.insert(key, PrimedEntry::View { at, view: Box::new(view.clone()) });
            } else if let Some(r) = retry_at_ms {
                primed.insert(key, PrimedEntry::Limited { at, retry_at_ms: r });
            }
        }
        let Some(err) = failure else {
            return Ok(after);
        };
        if let Some(ref view) = after {
            if settled(press.action, view) {
                return Ok(after);
            }
            if head_flag.is_some() {
                if let (Some(ref actual), Some(ref expected)) = (&view.head_id, &press.match_head_commit) {
                    if actual != expected {
                        let msg = match press.action {
                            GitPullRequestAction::Merge => "Could not merge this pull request. It has new commits since you confirmed, so nothing was merged. Refresh it, look at the new commits, then press Merge again.",
                            _ => "Could not turn on auto-merge. The pull request has new commits since you confirmed, so auto-merge was not turned on. Refresh it, look at the new commits, then press Merge when ready again.",
                        };
                        return Err(GitPullRequestError::refusal(msg));
                    }
                }
            }
        }
        let reason = reason_of(&err.message);
        let tail = if reason.is_empty() {
            press.action.hint(press.method)
        } else {
            &reason
        };
        Err(GitPullRequestError::refusal(format!("{} {tail}", press.action.failed_prefix()).trim()))
    }

    fn assert_same_repository(&self, cwd: &str, url: &str) -> Result<(), GitPullRequestError> {
        let addr = parse_pull_request_address(url)
            .ok_or_else(|| GitPullRequestError::refusal("Sotto checks out pull requests from GitHub only."))?;
        let origin = git(cwd, &["config", "--get", "remote.origin.url"], VIEW_TIMEOUT)
            .unwrap_or_default();
        let origin = origin.trim();
        if origin.is_empty() {
            return Err(GitPullRequestError::refusal(
                "This project has no origin remote to check the pull request out from.",
            ));
        }
        let expected = format!("{}/{}", addr.owner, addr.name).to_lowercase();
        let repo = github_repository_of(origin);
        if repo.as_deref() != Some(expected.as_str()) {
            return Err(GitPullRequestError::refusal(
                "This pull request is in another repository. Check it out from a clone of that repository.",
            ));
        }
        Ok(())
    }

    pub fn checkout_local(&self, cwd: &str, url: &str) -> Result<(), GitPullRequestError> {
        self.assert_same_repository(cwd, url)?;
        let selector = parse_pull_request_reference(url)
            .ok_or_else(|| GitPullRequestError::refusal("Use a pull request URL, 123, or #123."))?;
        self.gh
            .run_gh_detailed(cwd, &["pr", "checkout", &selector], FETCH_TIMEOUT, None)
            .map(|_| ())
            .map_err(|err| {
                GitPullRequestError::refusal(format!("Could not check out the pull request. {}", reason_of(&err.message)).trim())
            })
    }

    pub fn prepare_worktree_branch(
        &self,
        cwd: &str,
        number: u64,
        url: &str,
        head_branch: &str,
        cross_repository: bool,
    ) -> Result<PreparedWorktreeBranch, GitPullRequestError> {
        self.assert_same_repository(cwd, url)?;
        let branch = if cross_repository || head_branch.is_empty() {
            format!("sotto/pr-{number}/{}", branch_fragment(head_branch))
        } else {
            head_branch.to_string()
        };
        if git(cwd, &["check-ref-format", "--branch", &branch], VIEW_TIMEOUT).is_err() {
            return Err(GitPullRequestError::refusal(format!(
                "The pull request's branch name {branch} is not one Git accepts."
            )));
        }
        let checkouts = list_worktree_checkouts(cwd);
        let ref_name = format!("refs/heads/{branch}");
        let exists = git(cwd, &["show-ref", "--verify", "--quiet", &ref_name], VIEW_TIMEOUT).is_ok();
        if exists {
            let holder = checkouts.iter().find(|entry| entry.branch.as_deref() == Some(branch.as_str()));
            if holder.is_some_and(|h| h.main) {
                return Err(GitPullRequestError::refusal(
                    "This pull request's branch is already checked out in the project folder. Use Local, or switch the project folder off that branch before choosing Worktree.",
                ));
            }
            return Ok(PreparedWorktreeBranch {
                branch,
                worktree_path: holder.map(|h| h.path.clone()),
            });
        }
        let pull_refspec = format!("refs/pull/{number}/head:refs/heads/{branch}");
        let fetch_pull_ref = || git(cwd, &["fetch", "--no-tags", "origin", &pull_refspec], FETCH_TIMEOUT);
        let fetch_result = if cross_repository || head_branch.is_empty() {
            fetch_pull_ref()
        } else {
            let head_refspec = format!("+refs/heads/{head_branch}:refs/remotes/origin/{head_branch}");
            let remote_ref = format!("refs/remotes/origin/{head_branch}");
            match git(cwd, &["fetch", "--no-tags", "origin", &head_refspec], FETCH_TIMEOUT)
                .and_then(|_| git(cwd, &["branch", "--track", &branch, &remote_ref], VIEW_TIMEOUT))
            {
                Ok(out) => Ok(out),
                Err(_) => fetch_pull_ref(),
            }
        };
        if let Err(err) = fetch_result {
            return Err(GitPullRequestError::refusal(
                format!("Could not fetch the pull request's branch. {}", reason_of(&err)).trim(),
            ));
        }
        Ok(PreparedWorktreeBranch { branch, worktree_path: None })
    }

    fn address_of(&self, cwd: &str, selector: &str) -> Result<(GitHubRepository, u64), GitPullRequestError> {
        if let Some(addr) = parse_pull_request_address(selector) {
            return Ok((
                GitHubRepository { host: "github.com".into(), owner: addr.owner, name: addr.name },
                addr.number,
            ));
        }
        let remotes = read_github_remotes(cwd, &self.hosts).unwrap_or_default();
        let repo = base_repository(&remotes).ok_or_else(|| {
            GitPullRequestError::refusal(
                "This project has no GitHub remote to read the pull request from. Use its full GitHub URL.",
            )
        })?;
        let number: u64 = selector
            .parse()
            .map_err(|_| GitPullRequestError::refusal("Use a pull request URL, 123, or #123."))?;
        Ok((repo, number))
    }

    fn keep_merge_settings(&self, key: &str, repo: &Map<String, Value>) -> MergeSettings {
        let mut merge_methods = Vec::new();
        if repo.get("mergeCommitAllowed").and_then(Value::as_bool) != Some(false) {
            merge_methods.push(GitPullRequestMergeMethod::Merge);
        }
        if repo.get("squashMergeAllowed").and_then(Value::as_bool) != Some(false) {
            merge_methods.push(GitPullRequestMergeMethod::Squash);
        }
        if repo.get("rebaseMergeAllowed").and_then(Value::as_bool) != Some(false) {
            merge_methods.push(GitPullRequestMergeMethod::Rebase);
        }
        let settings = MergeSettings {
            at: (self.clock)(),
            merge_methods,
            auto_merge_allowed: repo.get("autoMergeAllowed").and_then(Value::as_bool) != Some(false),
        };
        if repo.get("mergeCommitAllowed").and_then(Value::as_bool).is_some() {
            self.merge_settings.lock().unwrap_or_else(|e| e.into_inner()).insert(key.to_string(), settings.clone());
        }
        settings
    }
}

struct WorktreeCheckout {
    path: String,
    branch: Option<String>,
    main: bool,
}

fn list_worktree_checkouts(cwd: &str) -> Vec<WorktreeCheckout> {
    let Ok(listing) = git(cwd, &["worktree", "list", "--porcelain", "-z"], VIEW_TIMEOUT) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (index, record) in listing.split("\0\0").filter(|r| !r.is_empty()).enumerate() {
        let mut path = String::new();
        let mut branch = None;
        for field in record.split('\0') {
            if let Some(p) = field.strip_prefix("worktree ") {
                path = p.to_string();
            } else if let Some(b) = field.strip_prefix("branch refs/heads/") {
                branch = Some(b.to_string());
            }
        }
        if !path.is_empty() {
            out.push(WorktreeCheckout { path, branch, main: index == 0 });
        }
    }
    out
}

fn branch_fragment(head: &str) -> String {
    let mut mapped = String::new();
    let mut last_dash = false;
    for ch in head.to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '/' | '_' | '-') {
            if ch == '-' {
                if !last_dash {
                    mapped.push('-');
                    last_dash = true;
                }
            } else {
                mapped.push(ch);
                last_dash = false;
            }
        } else if !last_dash {
            mapped.push('-');
            last_dash = true;
        }
    }
    let trimmed = mapped.trim_matches(['-', '/']);
    let clipped = cut_utf16(trimmed, 48);
    let final_s = clipped.trim_end_matches(['-', '/']);
    if final_s.is_empty() { "head".into() } else { final_s.to_string() }
}

fn settled(action: GitPullRequestAction, after: &PullRequestView) -> bool {
    match action {
        GitPullRequestAction::Merge => after.state == "merged",
        GitPullRequestAction::Close => after.state == "closed",
        GitPullRequestAction::Reopen => after.state == "open",
        GitPullRequestAction::Ready => !after.draft,
        GitPullRequestAction::Draft => after.draft,
        GitPullRequestAction::EnableAutoMerge => after.auto_merge.is_some() || after.state == "merged",
        GitPullRequestAction::DisableAutoMerge => after.auto_merge.is_none(),
        GitPullRequestAction::UpdateBranch => after.behind_by == Some(0),
    }
}

fn gh_read_failure(err: &GhDetailedError) -> GitPullRequestReadFailure {
    if err.unavailable {
        GitPullRequestReadFailure::GhMissing
    } else if is_sign_in_refusal(&err.message) {
        GitPullRequestReadFailure::GhSignedOut
    } else if is_unreachable_answer(&err.message) {
        GitPullRequestReadFailure::Offline
    } else {
        GitPullRequestReadFailure::Unreadable
    }
}

fn reason_of(message: &str) -> String {
    let scrubbed = safe_remote(message);
    let non_empty: Vec<&str> = scrubbed.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let start = non_empty.len().saturating_sub(2);
    cut_utf16(&non_empty[start..].join(" "), 600)
}

fn cut_utf16(text: &str, max: usize) -> String {
    clip_utf16(text, max).to_string()
}

fn parse_graphql_answer(stdout: &str) -> Result<Value, GitPullRequestError> {
    let val: Value = serde_json::from_str(stdout)
        .map_err(|_| GitPullRequestError::refusal("GitHub answered in a form Sotto could not read. Refresh to try again."))?;
    let Some(data) = val.get("data").and_then(Value::as_object) else {
        return Err(GitPullRequestError::refusal("GitHub answered in a form Sotto could not read. Refresh to try again."));
    };
    if !data.contains_key("repository") {
        return Err(GitPullRequestError::refusal("GitHub answered in a form Sotto could not read. Refresh to try again."));
    }
    Ok(val)
}

fn parse_graphql_list_answer(stdout: &str) -> Result<Value, GitPullRequestError> {
    let val: Value = serde_json::from_str(stdout)
        .map_err(|_| GitPullRequestError::refusal("GitHub answered in a form Sotto could not read. Refresh to try again."))?;
    let Some(data) = val.get("data").and_then(Value::as_object) else {
        return Err(GitPullRequestError::refusal("GitHub answered in a form Sotto could not read. Refresh to try again."));
    };
    if !data.contains_key("repository") {
        return Err(GitPullRequestError::refusal("GitHub answered in a form Sotto could not read. Refresh to try again."));
    }
    Ok(val)
}

fn partial_answer(stdout: &str) -> Option<Value> {
    if stdout.trim().is_empty() {
        return None;
    }
    let val: Value = serde_json::from_str(stdout).ok()?;
    let pr = val.get("data")?.get("repository")?.get("pullRequest")?.as_object()?;
    pr.get("number")?.as_u64().filter(|&n| n > 0)?;
    pr.get("title")?.as_str()?;
    pr.get("url")?.as_str()?;
    pr.get("state")?.as_str()?;
    Some(val)
}

pub fn checks_refused(errors: &[Value]) -> bool {
    errors.iter().any(|err| {
        let Some(path) = err.get("path").and_then(Value::as_array) else {
            return false;
        };
        let Some(commits) = path.iter().position(|p| p.as_str() == Some("commits")) else {
            return false;
        };
        let contexts = path[commits..].iter().position(|p| p.as_str() == Some("contexts")).map(|i| commits + i);
        match contexts {
            None => true,
            Some(c) => path.len().saturating_sub(c + 1) <= 2,
        }
    })
}

fn check_of(node: &Map<String, Value>) -> Value {
    let upper = |k: &str| node.get(k).and_then(Value::as_str).map(|s| s.trim().to_ascii_uppercase()).unwrap_or_default();
    let typename = node.get("__typename").and_then(Value::as_str);
    let is_status = typename == Some("StatusContext")
        || (node.get("context").is_some_and(|v| !v.is_null()) && node.get("name").is_none_or(Value::is_null));
    let status = if is_status {
        match upper("state").as_str() {
            "SUCCESS" => "success",
            "FAILURE" | "ERROR" => "failure",
            _ => "pending",
        }
    } else if node.get("status").is_some_and(|v| !v.is_null()) && upper("status") != "COMPLETED" {
        if upper("status") == "WAITING" { "action-required" } else { "pending" }
    } else {
        match upper("conclusion").as_str() {
            "SUCCESS" => "success",
            "CANCELLED" => "cancelled",
            "SKIPPED" => "skipped",
            "NEUTRAL" | "STALE" => "neutral",
            "ACTION_REQUIRED" => "action-required",
            "" => "pending",
            _ => "failure",
        }
    };
    let own_raw = if is_status { node.get("context") } else { node.get("name") }
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Check");
    let workflow_name = if is_status {
        None
    } else {
        node.get("checkSuite")
            .and_then(|s| s.get("workflowRun"))
            .and_then(|r| r.get("workflow"))
            .and_then(|w| w.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != own_raw)
    };
    let name = match workflow_name {
        Some(wf) => format!("{wf} / {own_raw}"),
        None => own_raw.to_string(),
    };
    let raw_url = if is_status { node.get("targetUrl") } else { node.get("detailsUrl") }.and_then(Value::as_str);
    let url = raw_url
        .filter(|u| strip_ci_prefix(u, "https://").is_some())
        .map(|u| cut_utf16(u, 2_048));
    let description = node
        .get("description")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| cut_utf16(s, 2_000));
    let mut out = Map::new();
    out.insert("name".into(), json!(cut_utf16(&name, 500)));
    out.insert("status".into(), json!(status));
    out.insert("url".into(), match url { Some(u) => json!(u), None => Value::Null });
    out.insert("description".into(), match description { Some(d) => json!(d), None => Value::Null });
    if !is_status && (node.contains_key("startedAt") || node.contains_key("completedAt")) {
        out.insert("startedAt".into(), match time_of(node.get("startedAt").and_then(Value::as_str)) {
            Some(t) => json!(t),
            None => Value::Null,
        });
        out.insert("completedAt".into(), match time_of(node.get("completedAt").and_then(Value::as_str)) {
            Some(t) => json!(t),
            None => Value::Null,
        });
    }
    Value::Object(out)
}

fn time_of(value: Option<&str>) -> Option<String> {
    let s = value.filter(|s| !s.is_empty())?;
    parse_iso_ms(s)?;
    Some(cut_utf16(s, 64))
}

fn files_of(nodes: &[Value]) -> Vec<Value> {
    nodes
        .iter()
        .filter_map(|node| {
            let obj = node.as_object()?;
            let path = obj.get("path").and_then(Value::as_str).filter(|s| !s.is_empty())?;
            Some(json!({
                "path": cut_utf16(path, 4_096),
                "additions": obj.get("additions").and_then(Value::as_u64).unwrap_or(0),
                "deletions": obj.get("deletions").and_then(Value::as_u64).unwrap_or(0),
            }))
        })
        .take(GIT_PULL_REQUEST_FILES_MAX)
        .collect()
}

fn reviews_of(nodes: &[Value]) -> Vec<Value> {
    let all: Vec<Value> = nodes
        .iter()
        .filter_map(|node| {
            let obj = node.as_object()?;
            let state = match obj.get("state").and_then(Value::as_str)?.to_ascii_uppercase().as_str() {
                "APPROVED" => "approved",
                "CHANGES_REQUESTED" => "changes_requested",
                _ => return None,
            };
            let author = obj
                .get("author")
                .and_then(|a| a.get("login"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())?;
            let url = obj
                .get("url")
                .and_then(Value::as_str)
                .filter(|u| strip_ci_prefix(u, "https://github.com/").is_some())
                .map(|u| cut_utf16(u, 2_048));
            Some(json!({
                "author": cut_utf16(author, 100),
                "state": state,
                "url": url,
            }))
        })
        .collect();
    if all.len() > 50 {
        all[all.len() - 50..].to_vec()
    } else {
        all
    }
}

fn method_of(value: &str) -> Option<GitPullRequestMergeMethod> {
    match value.trim().to_ascii_uppercase().as_str() {
        "MERGE" => Some(GitPullRequestMergeMethod::Merge),
        "SQUASH" => Some(GitPullRequestMergeMethod::Squash),
        "REBASE" => Some(GitPullRequestMergeMethod::Rebase),
        _ => None,
    }
}

fn list_checks_of(state: Option<&str>) -> &'static str {
    match state.unwrap_or("").to_ascii_uppercase().as_str() {
        "SUCCESS" => "passed",
        "FAILURE" | "ERROR" => "failing",
        "PENDING" | "EXPECTED" => "running",
        _ => "none",
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Confirmation receipts (`src/host/pullRequestConfirmations.ts`, #1691).

struct ConfirmationReceipt {
    client_id: String,
    thread_id: String,
    key: String,
    action: ConfirmedPullRequestAction,
    method: Option<GitPullRequestMergeMethod>,
    head: Option<String>,
    expires: i64,
    used: bool,
}

struct StoredReading {
    client_id: String,
    thread_id: String,
    key: String,
    head: Option<String>,
    at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestConfirmation {
    pub confirmation: String,
    pub expires_at: String,
}

impl PullRequestConfirmation {
    pub fn to_json(&self) -> Value {
        json!({
            "confirmation": self.confirmation,
            "expiresAt": self.expires_at,
        })
    }
}

/// In-memory confirmation receipt & reading store shared across both listeners (mirrors `PullRequestConfirmations`).
pub struct PullRequestConfirmations {
    receipts: HashMap<String, ConfirmationReceipt>,
    receipt_order: VecDeque<String>,
    readings: HashMap<String, StoredReading>,
    reading_order: VecDeque<String>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl Default for PullRequestConfirmations {
    fn default() -> Self {
        Self::new()
    }
}

impl PullRequestConfirmations {
    pub fn new() -> Self {
        Self::with_clock(Arc::new(now_ms_i64))
    }

    pub fn with_clock(clock: Arc<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Self {
            receipts: HashMap::new(),
            receipt_order: VecDeque::new(),
            readings: HashMap::new(),
            reading_order: VecDeque::new(),
            clock,
        }
    }

    pub fn read(&mut self, client_id: &str, thread_id: &str, url: &str, head: Option<&str>) -> Option<String> {
        let key = pull_request_key(url)?;
        self.prune_readings();
        let read_id = Uuid::new_v4().to_string();
        let valid_head = head.filter(|h| is_valid_git_commit_id(h)).map(ToString::to_string);
        self.readings.insert(
            read_id.clone(),
            StoredReading {
                client_id: client_id.to_string(),
                thread_id: thread_id.to_string(),
                key,
                head: valid_head,
                at: (self.clock)(),
            },
        );
        self.reading_order.push_back(read_id.clone());
        bound_entries(&mut self.readings, &mut self.reading_order, client_id, READS_PER_CLIENT, READS_MAX, |r| &r.client_id);
        Some(read_id)
    }

    pub fn issue(&mut self, client_id: &str, press: &PullRequestConfirmationRequest) -> Result<PullRequestConfirmation, String> {
        let action = press.action;
        let read_again = format!("Open the pull request again so Sotto reads it, then press {} again.", action.control());
        let Some(ref read_id) = press.read_id else {
            return Err(confirmation_refusal(
                action,
                "This device did not say which reading of the pull request it is showing.",
                &read_again,
            ));
        };
        self.prune_readings();
        let Some(reading) = self.readings.get(read_id).map(|r| (r.client_id.clone(), r.thread_id.clone(), r.key.clone(), r.head.clone())) else {
            return Err(confirmation_refusal(
                action,
                "This host no longer has the reading of the pull request this device is showing. It may be over 30 minutes old, or the host may have restarted.",
                &read_again,
            ));
        };
        if reading.0 != client_id {
            return Err(confirmation_refusal(
                action,
                "That reading of the pull request was made for another device.",
                &read_again,
            ));
        }
        if reading.1 != press.thread_id || Some(reading.2.as_str()) != pull_request_key(&press.url).as_deref() {
            return Err(confirmation_refusal(action, "That reading is of another pull request.", &read_again));
        }
        if action != ConfirmedPullRequestAction::Close && reading.3.is_none() {
            return Err(confirmation_refusal(
                action,
                "GitHub did not say which commit this pull request is on in the reading this device is showing.",
                &read_again,
            ));
        }
        self.prune_receipts();
        let confirmation = Uuid::new_v4().to_string();
        let expires = (self.clock)() + PULL_REQUEST_CONFIRMATION_LIFETIME_MS;
        self.receipts.insert(
            confirmation.clone(),
            ConfirmationReceipt {
                client_id: client_id.to_string(),
                thread_id: press.thread_id.clone(),
                key: reading.2,
                action,
                method: press.method,
                head: reading.3,
                expires,
                used: false,
            },
        );
        self.receipt_order.push_back(confirmation.clone());
        bound_entries(&mut self.receipts, &mut self.receipt_order, client_id, RECEIPTS_PER_CLIENT, RECEIPTS_MAX, |r| &r.client_id);
        Ok(PullRequestConfirmation { confirmation, expires_at: format_iso_ms(expires) })
    }

    pub fn redeem(
        &mut self,
        client_id: &str,
        confirmation: Option<&str>,
        thread_id: &str,
        url: &str,
        action: ConfirmedPullRequestAction,
        method: Option<GitPullRequestMergeMethod>,
    ) -> Result<Option<String>, String> {
        let press_again = format!("Press {} again.", action.control());
        let read_again = format!("Open the pull request again so Sotto reads it, then press {} again.", action.control());
        let Some(confirmation) = confirmation else {
            return Err(confirmation_refusal(
                action,
                &format!("{} from another device needs this host's confirmation, and none came with it.", action.doing()),
                &format!("Update Sotto on this device, then press {} again.", action.control()),
            ));
        };
        self.prune_receipts();
        let now = (self.clock)();
        let Some(receipt) = self.receipts.get_mut(confirmation) else {
            return Err(confirmation_refusal(
                action,
                "This host has no record of that confirmation. It may have restarted since.",
                &press_again,
            ));
        };
        if receipt.client_id != client_id {
            return Err(confirmation_refusal(
                action,
                "That confirmation was given to another device.",
                &format!("Press {} again on this device.", action.control()),
            ));
        }
        if receipt.used {
            return Err(confirmation_refusal(action, "That confirmation was already used.", &press_again));
        }
        receipt.used = true;
        if receipt.expires <= now {
            return Err(confirmation_refusal(
                action,
                "That confirmation expired before the press reached this host.",
                &press_again,
            ));
        }
        if receipt.thread_id != thread_id
            || Some(receipt.key.as_str()) != pull_request_key(url).as_deref()
            || receipt.action != action
            || receipt.method != method
        {
            return Err(confirmation_refusal(action, "That confirmation was for a different press.", &press_again));
        }
        if action == ConfirmedPullRequestAction::Close {
            return Ok(None);
        }
        let Some(ref head) = receipt.head else {
            return Err(confirmation_refusal(
                action,
                "That confirmation does not say which commit this pull request is on.",
                &read_again,
            ));
        };
        Ok(Some(head.clone()))
    }

    fn prune_readings(&mut self) {
        let now = (self.clock)();
        let readings = &mut self.readings;
        self.reading_order.retain(|id| {
            let keep = readings.get(id).is_some_and(|r| r.at + PULL_REQUEST_READ_LIFETIME_MS > now);
            if !keep {
                readings.remove(id);
            }
            keep
        });
    }

    fn prune_receipts(&mut self) {
        let now = (self.clock)();
        let receipts = &mut self.receipts;
        self.receipt_order.retain(|id| {
            let keep = receipts
                .get(id)
                .is_some_and(|r| r.expires + PULL_REQUEST_CONFIRMATION_LIFETIME_MS > now);
            if !keep {
                receipts.remove(id);
            }
            keep
        });
    }
}

fn confirmation_refusal(action: ConfirmedPullRequestAction, happened: &str, next: &str) -> String {
    format!("{happened} {} {next}", action.nothing())
}

fn bound_entries<T>(
    map: &mut HashMap<String, T>,
    order: &mut VecDeque<String>,
    client_id: &str,
    per_client: usize,
    all: usize,
    owner_of: impl Fn(&T) -> &str,
) {
    let mut own_count = order
        .iter()
        .filter(|id| map.get(*id).is_some_and(|entry| owner_of(entry) == client_id))
        .count();
    if own_count > per_client {
        let mut to_drop = own_count - per_client;
        order.retain(|id| {
            if to_drop > 0 && map.get(id).is_some_and(|entry| owner_of(entry) == client_id) {
                map.remove(id);
                to_drop -= 1;
                return false;
            }
            true
        });
    }
    own_count = map.len();
    while own_count > all {
        let Some(oldest) = order.pop_front() else { break };
        if map.remove(&oldest).is_some() {
            own_count -= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
    use tempfile::TempDir;

    type DetailedHandler = dyn Fn(&str, &[String]) -> Result<String, GhDetailedError> + Send + Sync;

    struct ScriptedGh {
        handler: Box<DetailedHandler>,
        calls: Mutex<Vec<Vec<String>>>,
    }

    impl ScriptedGh {
        fn new(f: impl Fn(&str, &[String]) -> Result<String, GhDetailedError> + Send + Sync + 'static) -> Arc<Self> {
            Arc::new(Self { handler: Box::new(f), calls: Mutex::new(Vec::new()) })
        }

        fn recorded(&self) -> Vec<Vec<String>> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl GhRunner for ScriptedGh {
        fn run_gh(&self, cwd: &str, args: &[&str], _: Duration, _: Option<&[u8]>) -> Result<String, String> {
            let owned: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
            self.calls.lock().unwrap().push(owned.clone());
            (self.handler)(cwd, &owned).map_err(|e| e.message)
        }

        fn run_gh_detailed(&self, cwd: &str, args: &[&str], _: Duration, _: Option<&[u8]>) -> Result<String, GhDetailedError> {
            let owned: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
            self.calls.lock().unwrap().push(owned.clone());
            (self.handler)(cwd, &owned)
        }

        fn ssh_hostname(&self, _: &str) -> Option<String> {
            None
        }
    }

    fn make_repo() -> (TempDir, PathBuf, PathBuf) {
        let dir = TempDir::new().unwrap();
        let remote = dir.path().join("remote.git");
        let repo = dir.path().join("repo");
        fs::create_dir_all(&remote).unwrap();
        fs::create_dir_all(&repo).unwrap();
        let run = |p: &Path, args: &[&str]| git(&p.to_string_lossy(), args, VIEW_TIMEOUT).unwrap();
        run(&remote, &["init", "--bare", "--initial-branch=main"]);
        run(&repo, &["init", "--initial-branch=main"]);
        run(&repo, &["config", "user.name", "Test"]);
        run(&repo, &["config", "user.email", "test@example.com"]);
        fs::write(repo.join("README.md"), "hi\n").unwrap();
        run(&repo, &["add", "-A"]);
        run(&repo, &["commit", "-m", "First"]);
        run(&repo, &["remote", "add", "origin", &remote.to_string_lossy()]);
        run(&repo, &["push", "-u", "origin", "main"]);
        (dir, repo, remote)
    }

    #[test]
    fn parses_urls_references_commit_ids_and_github_remotes() {
        let addr = parse_pull_request_address("https://GitHub.com/Org/Repo/pull/0042/files?w=1").unwrap();
        assert_eq!((addr.owner.as_str(), addr.name.as_str(), addr.number), ("Org", "Repo", 42));
        assert_eq!(pull_request_key("  https://github.com/Org/Repo/pull/0042  ").as_deref(), Some("org/repo#42"));
        assert!(parse_pull_request_address("https://gitlab.com/org/repo/pull/42").is_none());

        assert_eq!(parse_pull_request_reference("#42").as_deref(), Some("42"));
        assert_eq!(parse_pull_request_reference("007").as_deref(), Some("7"));
        assert_eq!(parse_pull_request_reference("gh pr checkout 42").as_deref(), Some("42"));
        assert_eq!(
            parse_pull_request_reference("gh pr checkout https://github.com/org/repo/pull/9").as_deref(),
            Some("https://github.com/org/repo/pull/9")
        );
        assert!(parse_pull_request_reference("0").is_none());
        assert!(parse_pull_request_reference("not-a-pr").is_none());

        assert!(is_valid_git_commit_id(&"a".repeat(40)));
        assert!(is_valid_git_commit_id(&"0".repeat(64)));
        assert!(!is_valid_git_commit_id(&"A".repeat(40)));
        assert!(!is_valid_git_commit_id("abc"));

        assert_eq!(github_repository_of("https://github.com/Org/Über.git/").as_deref(), Some("org/über"));
        assert_eq!(github_repository_of("git@github.com:Org/日本").as_deref(), Some("org/日本"));
        assert_eq!(github_repository_of("ssh://git@github.com/Org/App.git").as_deref(), Some("org/app"));
        assert!(github_repository_of("https://gitlab.com/org/app.git").is_none());
    }

    #[test]
    fn rate_limit_tracks_reserve_pauses_and_login_switch() {
        let clock_val = Arc::new(AtomicI64::new(1_000_000));
        let c = Arc::clone(&clock_val);
        let rl = GitHubRateLimit::with_clock(Arc::new(move || c.load(Ordering::SeqCst)));

        let reset = format_iso_ms(1_300_000);
        let a1 = rl.asking();
        rl.answered("github.com", a1, Some(&GitHubRateLimitReading { limit: 5000, remaining: 100, reset_at: reset.clone() }), Some("alice"));
        // 100 < 500 (10% reserve): blocks background, allows user.
        assert_eq!(rl.retry_at("github.com", GitHubAsk::Background), Some(1_300_000));
        assert_eq!(rl.retry_at("github.com", GitHubAsk::User), None);

        // 0 remaining blocks user too.
        let a2 = rl.asking();
        rl.answered("github.com", a2, Some(&GitHubRateLimitReading { limit: 5000, remaining: 0, reset_at: reset }), Some("alice"));
        assert_eq!(rl.retry_at("github.com", GitHubAsk::User), Some(1_300_000));

        // Login change drops prior sign-in's reading.
        let a3 = rl.asking();
        rl.answered("github.com", a3, None, Some("bob"));
        assert_eq!(rl.retry_at("github.com", GitHubAsk::User), None);

        // Secondary rate limit pauses background with doubling backoff.
        let p1 = rl.limited("github.com", "You have exceeded a secondary rate limit", None);
        assert_eq!(p1, 1_030_000);
        let p2 = rl.limited("github.com", "HTTP 429 too many requests", None);
        assert_eq!(p2, 1_060_000);
    }

    #[test]
    fn view_list_and_act_handle_graphql_partial_answers_priming_and_lost_acks() {
        let (_dir, repo, _) = make_repo();
        let cwd = repo.to_string_lossy().into_owned();
        git(&cwd, &["remote", "set-url", "origin", "https://github.com/org/app.git"], VIEW_TIMEOUT).unwrap();
        let sha1 = "a".repeat(40);
        let sha2 = "b".repeat(40);
        let state_cell = Arc::new(Mutex::new(("OPEN".to_string(), false, sha1.clone(), false)));
        let graphql_calls = Arc::new(AtomicUsize::new(0));
        let sc = Arc::clone(&state_cell);
        let gc = Arc::clone(&graphql_calls);
        let sha1_match = sha1.clone();

        let gh = ScriptedGh::new(move |_, args| {
            if args.first().map(String::as_str) == Some("api") && args.get(1).map(String::as_str) == Some("graphql") {
                let n = gc.fetch_add(1, Ordering::SeqCst);
                let query = args.iter().find(|a| a.starts_with("query=")).cloned().unwrap_or_default();
                if query.contains("PullRequestList") {
                    return Ok(json!({
                        "data": {
                            "rateLimit": { "limit": 5000, "remaining": 4999, "resetAt": "2027-01-01T00:00:00Z" },
                            "viewer": { "login": "alice" },
                            "repository": {
                                "pullRequests": {
                                    "totalCount": 1,
                                    "nodes": [{
                                        "number": 12, "title": "Ship it", "url": "https://github.com/org/app/pull/12",
                                        "isDraft": false, "updatedAt": "2026-11-27T00:00:00Z",
                                        "additions": 10, "deletions": 2, "changedFiles": 1,
                                        "reviewDecision": "APPROVED", "headRefName": "feat",
                                        "author": { "login": "alice" },
                                        "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "SUCCESS" } } }] }
                                    }]
                                }
                            }
                        }
                    }).to_string());
                }
                let (st, draft, head_oid, partial_checks_err) = sc.lock().unwrap().clone();
                let check_run = json!({
                    "__typename": "CheckRun",
                    "name": "test",
                    "status": "COMPLETED",
                    "conclusion": "SUCCESS",
                    "detailsUrl": "https://github.com/org/app/runs/1",
                    "startedAt": "2026-11-27T00:00:00Z",
                    "completedAt": "2026-11-27T00:01:00Z",
                    "checkSuite": { "workflowRun": { "workflow": { "name": "CI" } } }
                });
                let commits = json!({
                    "nodes": [{ "commit": { "statusCheckRollup": { "contexts": { "nodes": [check_run] } } } }]
                });
                let pr_json = json!({
                    "number": 12, "title": "Ship it", "url": "https://github.com/org/app/pull/12",
                    "body": "Details", "state": st, "isDraft": draft, "mergeable": "MERGEABLE",
                    "reviewDecision": "APPROVED", "baseRefName": "main", "headRefName": "feat",
                    "headRefOid": head_oid, "isCrossRepository": false,
                    "mergedAt": if st == "MERGED" { json!("2026-11-27T01:00:00Z") } else { Value::Null },
                    "createdAt": "2026-11-26T00:00:00Z", "additions": 10, "deletions": 2, "changedFiles": 1,
                    "author": { "login": "alice" },
                    "autoMergeRequest": Value::Null, "viewerCanUpdateBranch": true,
                    "baseRef": { "compare": { "behindBy": 1 } },
                    "latestOpinionatedReviews": { "nodes": [{ "state": "APPROVED", "url": "https://github.com/org/app/pull/12#r1", "author": { "login": "bob" } }] },
                    "files": { "nodes": [{ "path": "src/a.rs", "additions": 10, "deletions": 2 }] },
                    "commits": commits
                });
                let payload = json!({
                    "data": {
                        "rateLimit": { "limit": 5000, "remaining": 4990, "resetAt": "2027-01-01T00:00:00Z" },
                        "viewer": { "login": "alice" },
                        "repository": {
                            "mergeCommitAllowed": true, "squashMergeAllowed": true, "rebaseMergeAllowed": false, "autoMergeAllowed": true,
                            "pullRequest": pr_json
                        }
                    },
                    "errors": if partial_checks_err { json!([{ "path": ["repository", "pullRequest", "commits", "nodes", 0, "commit", "statusCheckRollup", "contexts", "nodes"] }]) } else { Value::Null }
                });
                if partial_checks_err && n == 0 {
                    return Err(GhDetailedError { unavailable: false, message: "GraphQL partial error".into(), stdout: payload.to_string() });
                }
                return Ok(payload.to_string());
            }
            if args.first().map(String::as_str) == Some("pr") && args.get(1).map(String::as_str) == Some("merge") {
                if args.iter().any(|a| a == &format!("--match-head-commit={sha1_match}")) {
                    // Simulate lost reply after GitHub actually merged.
                    sc.lock().unwrap().0 = "MERGED".into();
                    return Err(GhDetailedError { unavailable: false, message: "connection reset".into(), stdout: String::new() });
                }
                // Head moved to sha2.
                sc.lock().unwrap().2 = sha2.clone();
                return Err(GhDetailedError { unavailable: false, message: "head mismatch".into(), stdout: String::new() });
            }
            Ok(String::new())
        });

        let clock = Arc::new(AtomicI64::new(10_000));
        let c = Arc::clone(&clock);
        let hosts = Arc::new(GitHubHosts::new(gh.clone()));
        let svc = GitPullRequests::with_parts(
            gh.clone(),
            hosts,
            Arc::new(GitHubRateLimit::with_clock(Arc::new(move || c.load(Ordering::SeqCst)))),
            Arc::new(move || clock.load(Ordering::SeqCst)),
        );

        // Partial GraphQL answer recovers PR with checksUnknown = true.
        state_cell.lock().unwrap().3 = true;
        let view = svc.view(&cwd, "12").unwrap();
        assert_eq!(view.number, 12);
        assert!(view.checks_unknown);
        assert_eq!(view.checks[0]["name"], "CI / test");
        assert_eq!(view.merge_methods, vec![GitPullRequestMergeMethod::Merge, GitPullRequestMergeMethod::Squash]);

        // List open PRs.
        let list = svc.list(&cwd).unwrap().unwrap();
        assert_eq!(list["repository"], "org/app");
        assert_eq!(list["total"], 1);
        assert_eq!(list["pullRequests"][0]["checks"], "passed");

        // Head mismatch returns HEAD_MOVED copy.
        state_cell.lock().unwrap().3 = false;
        let err = svc
            .act(
                &cwd,
                &GitPullRequestPress {
                    url: "https://github.com/org/app/pull/12".into(),
                    action: GitPullRequestAction::Merge,
                    method: Some(GitPullRequestMergeMethod::Squash),
                    match_head_commit: Some("c".repeat(40)),
                },
            )
            .unwrap_err();
        assert!(err.message().contains("new commits since you confirmed"), "{}", err.message());

        // Lost reply after merge settles via re-read AND primes the next view (no extra GraphQL call).
        let after = svc
            .act(
                &cwd,
                &GitPullRequestPress {
                    url: "https://github.com/org/app/pull/12".into(),
                    action: GitPullRequestAction::Merge,
                    method: Some(GitPullRequestMergeMethod::Squash),
                    match_head_commit: Some(sha1),
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(after.state, "merged");
        let calls_before = graphql_calls.load(Ordering::SeqCst);
        let cached = svc.view(&cwd, "https://github.com/org/app/pull/12").unwrap();
        assert_eq!(cached.state, "merged");
        assert_eq!(graphql_calls.load(Ordering::SeqCst), calls_before, "primed view must be reused once");
        assert!(!gh.recorded().is_empty());
    }

    #[test]
    fn confirmations_enforce_reading_client_single_use_expiry_and_head_binding() {
        let clock = Arc::new(AtomicI64::new(100_000));
        let c = Arc::clone(&clock);
        let mut store = PullRequestConfirmations::with_clock(Arc::new(move || c.load(Ordering::SeqCst)));
        let url = "https://github.com/org/app/pull/7";
        let sha = "a".repeat(40);

        // Missing readId is refused.
        let req_no_read = PullRequestConfirmationRequest {
            thread_id: "t1".into(),
            url: url.into(),
            action: ConfirmedPullRequestAction::Merge,
            method: Some(GitPullRequestMergeMethod::Squash),
            read_id: None,
        };
        assert!(store.issue("client-a", &req_no_read).unwrap_err().contains("did not say which reading"));

        // Reading without head allows close, refuses merge.
        let rid_no_head = store.read("client-a", "t1", url, None).unwrap();
        let req_merge_no_head = PullRequestConfirmationRequest { read_id: Some(rid_no_head.clone()), ..req_no_read.clone() };
        assert!(store.issue("client-a", &req_merge_no_head).unwrap_err().contains("did not say which commit"));
        let close_receipt = store
            .issue(
                "client-a",
                &PullRequestConfirmationRequest {
                    thread_id: "t1".into(),
                    url: url.into(),
                    action: ConfirmedPullRequestAction::Close,
                    method: None,
                    read_id: Some(rid_no_head),
                },
            )
            .unwrap();
        // Wrong client cannot spend it; right client spends it once.
        assert!(store.redeem("client-b", Some(&close_receipt.confirmation), "t1", url, ConfirmedPullRequestAction::Close, None).is_err());
        assert_eq!(store.redeem("client-a", Some(&close_receipt.confirmation), "t1", url, ConfirmedPullRequestAction::Close, None).unwrap(), None);
        assert!(store.redeem("client-a", Some(&close_receipt.confirmation), "t1", url, ConfirmedPullRequestAction::Close, None).unwrap_err().contains("already used"));

        // Reading with head binds merge receipt to that head.
        let rid = store.read("client-a", "t1", url, Some(&sha)).unwrap();
        let merge_receipt = store
            .issue(
                "client-a",
                &PullRequestConfirmationRequest {
                    thread_id: "t1".into(),
                    url: url.into(),
                    action: ConfirmedPullRequestAction::Merge,
                    method: Some(GitPullRequestMergeMethod::Squash),
                    read_id: Some(rid),
                },
            )
            .unwrap();
        assert_eq!(
            store.redeem("client-a", Some(&merge_receipt.confirmation), "t1", url, ConfirmedPullRequestAction::Merge, Some(GitPullRequestMergeMethod::Squash)).unwrap(),
            Some(sha)
        );
    }

    #[test]
    fn prepare_worktree_branch_handles_same_repo_fork_existing_and_main_checkout_refusal() {
        let (_dir, repo, remote) = make_repo();
        let cwd = repo.to_string_lossy().into_owned();
        // Push a feature branch + pull ref to bare remote, then point origin URL to github.com/org/app only for check?
        // Actually `assert_same_repository` reads remote.origin.url, so let's verify non-matching origin refusal first.
        let gh = ScriptedGh::new(|_, _| Ok(String::new()));
        let hosts = Arc::new(GitHubHosts::new(gh.clone()));
        let svc = GitPullRequests::with_parts(gh, hosts, Arc::new(GitHubRateLimit::new()), Arc::new(now_ms_i64));

        let wrong = svc
            .prepare_worktree_branch(&cwd, 5, "https://github.com/org/app/pull/5", "feat", false)
            .unwrap_err();
        assert!(wrong.message().contains("another repository"), "{}", wrong.message());

        // Set origin URL to match github.com/org/app; `main` is checked out in the project folder -> refused.
        let _ = remote;
        git(&cwd, &["remote", "set-url", "origin", "https://github.com/org/app.git"], VIEW_TIMEOUT).unwrap();
        let on_main = svc
            .prepare_worktree_branch(&cwd, 5, "https://github.com/org/app/pull/5", "main", false)
            .unwrap_err();
        assert!(on_main.message().contains("already checked out in the project folder"), "{}", on_main.message());

        // Existing local branch not checked out anywhere -> reused cleanly without fetching.
        git(&cwd, &["branch", "sotto/pr-5/feat-x"], VIEW_TIMEOUT).unwrap();
        let reused = svc
            .prepare_worktree_branch(&cwd, 5, "https://github.com/org/app/pull/5", "Feat X!", true)
            .unwrap();
        assert_eq!(reused.branch, "sotto/pr-5/feat-x");
        assert_eq!(reused.worktree_path, None);
    }
}
