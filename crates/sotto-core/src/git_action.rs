//! T3's stacked Git action (ADR-0027): one press commits, pushes and opens the pull request, or any prefix of that, as
//! Node's `GitActions.runStackedAction` (`src/main/agents/git/gitActions.ts`) runs it in a thread's folder, and the record
//! of it the thread carries while it runs and once it is over (`GitActionProgress`, `src/shared/gitActions.ts`, as
//! `runGitAction` in `src/main/agents/workspace.ts` keeps it).
//!
//! The steps run in Node's order, each reported as it starts, and every refusal is in T3's words or Git's. Nothing is
//! forced, rebased or resolved, a half-done merge is the user's to finish, the index is put back as it was around a
//! commit of chosen files, and nothing is pushed from the default branch unless the client says the user confirmed it.
//!
//! Two parts are not Git's and come from the caller through [`GitActionServices`]: the commit message the thread's own
//! provider drafts when none is given (ADR-0026), and what GitHub says, for the pull request step and the open pull
//! request a push's notice offers.

use std::collections::HashSet;
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::git_local::{is_repository, js_trim, last_lines, last_two_lines, refused_with, safe_remote};
use crate::ops::{parse_porcelain_v2_changed, run_action_git as git, run_action_git_with, ActionGitExtras, LineSink};
use crate::workspace::clip_utf16;

/// What Node's runner gives a Git command that names no deadline of its own.
const COMMAND_DEADLINE: Duration = Duration::from_secs(30);
/// Node's deadline for cutting a feature branch's checkout.
const CHECKOUT_DEADLINE: Duration = Duration::from_secs(10);
/// Node's `COMMIT_TIMEOUT_MS`: a commit's hooks may take long.
const COMMIT_DEADLINE: Duration = Duration::from_secs(10 * 60);
/// Node's `COMMIT_TIMEOUT_MS`, or the shorter one a test sets on its own thread.
fn commit_deadline() -> Duration {
    #[cfg(test)]
    if let Some(deadline) = tests::COMMIT_DEADLINE.with(std::cell::Cell::get) {
        return deadline;
    }
    COMMIT_DEADLINE
}
/// Node's `PUSH_TIMEOUT_MS`.
const PUSH_DEADLINE: Duration = Duration::from_secs(10 * 60);
/// Node's `FETCH_TIMEOUT_MS` for the status read's fetch.
const FETCH_DEADLINE: Duration = Duration::from_secs(5);

const RECENT_SUBJECTS: &str = "20";
const NAME_STATUS_MAX: usize = 8_000;
const AGENTS_FILE_MAX: usize = 20_000;
const FEATURE_BRANCH_MAX: usize = 64;
/// Node's `COMMIT_SUBJECT_MAX_CHARACTERS`.
pub const COMMIT_SUBJECT_MAX: usize = 72;
/// Node's `COMMIT_DIFF_MAX_CHARACTERS`: the staged diff a commit message is drafted from is cut here.
pub const COMMIT_DIFF_MAX: usize = 12_000;
/// The subject a commit is given when none was written, as Node's `STAND_IN_SUBJECT`.
pub const STAND_IN_SUBJECT: &str = "Update project files";
const HOOK_LINE_MAX: usize = 500;

/// Node's `QUIET_GIT_ENV`: a fetch never asks for a sign-in.
const QUIET_GIT_ENV: [(&str, &str); 6] = [
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_ASKPASS", ""),
    ("SSH_ASKPASS", ""),
    ("SSH_ASKPASS_REQUIRE", "never"),
    ("GCM_INTERACTIVE", "never"),
    ("GH_PROMPT_DISABLED", "1"),
];

const IN_PROGRESS: &str = "Git action in progress.";
const NOT_A_REPOSITORY: &str = "This folder is not a Git repository. Initialize Git first.";
const DETACHED_PUSH: &str = "Cannot push from detached HEAD.";
const MERGE_IN_PROGRESS: &str = "A merge or rebase is in progress. Finish or abort it in a terminal before committing here.";
const BEHIND_UPSTREAM: &str = "Branch is behind upstream. Pull/rebase before pushing.";

/// The five actions of Node's `gitStackedActionSchema`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitStackedAction {
    Commit,
    Push,
    CreatePr,
    CommitPush,
    CommitPushPr,
}

impl GitStackedAction {
    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "commit" => Self::Commit,
            "push" => Self::Push,
            "create_pr" => Self::CreatePr,
            "commit_push" => Self::CommitPush,
            "commit_push_pr" => Self::CommitPushPr,
            _ => return None,
        })
    }
    fn commits(self) -> bool {
        matches!(self, Self::Commit | Self::CommitPush | Self::CommitPushPr)
    }
    fn opens_pull_request(self) -> bool {
        matches!(self, Self::CreatePr | Self::CommitPushPr)
    }
}

/// The steps of an action, as Node's `gitActionPhaseSchema` names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitActionPhase {
    Branch,
    Commit,
    Push,
    Pr,
}

/// The phases an action runs, in order, for the notice's outline: Node's `gitActionPhases`.
pub fn git_action_phases(action: GitStackedAction, feature_branch: bool) -> Vec<GitActionPhase> {
    let mut phases = Vec::new();
    if feature_branch {
        phases.push(GitActionPhase::Branch);
    }
    if action.commits() {
        phases.push(GitActionPhase::Commit);
    }
    if action != GitStackedAction::Commit {
        phases.push(GitActionPhase::Push);
    }
    if action.opens_pull_request() {
        phases.push(GitActionPhase::Pr);
    }
    phases
}

/// T3's stage lines, so the progress notice reads the same in both apps: Node's `gitActionStages`.
pub fn git_action_stages(action: GitStackedAction, has_message: bool, has_changes: bool, push_target: Option<&str>, feature_branch: bool, push_before_pr: bool) -> Vec<String> {
    let owned = |lines: &[&str]| lines.iter().map(ToString::to_string).collect::<Vec<_>>();
    let branch = if feature_branch { owned(&["Preparing feature ref..."]) } else { Vec::new() };
    let push = push_target.filter(|target| !target.is_empty()).map_or_else(|| "Pushing...".to_string(), |target| format!("Pushing to {target}..."));
    let pr = owned(&["Preparing PR...", "Generating PR content...", "Creating pull request..."]);
    match action {
        GitStackedAction::Push => return vec![push],
        GitStackedAction::CreatePr => return if push_before_pr { [vec![push], pr].concat() } else { pr },
        _ => {}
    }
    let commit = if action != GitStackedAction::Commit && !has_changes {
        Vec::new()
    } else if has_message {
        owned(&["Committing..."])
    } else {
        owned(&["Generating commit message...", "Committing..."])
    };
    match action {
        GitStackedAction::Commit => [branch, commit].concat(),
        GitStackedAction::CommitPush => [branch, commit, vec![push]].concat(),
        _ => [branch, commit, vec![push], pr].concat(),
    }
}

/// A `git-action` command, as Node's strict command schema reads it (`agentCommandSchema` in `src/shared/agents.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitActionCommand {
    pub thread_id: String,
    pub action_id: String,
    pub action: GitStackedAction,
    pub commit_message: Option<String>,
    pub feature_branch: Option<bool>,
    pub file_paths: Option<Vec<String>>,
    pub allow_default_branch: Option<bool>,
}

impl GitActionCommand {
    /// The command, when Node's schema takes it: a thread ID of 1 to 512 UTF-16 code units, an action ID Zod takes as a
    /// UUID, one of the five actions, a message of at most 10,000 code units, at most 2,000 file paths of 1 to 4,096 code
    /// units each, the two switches only as booleans, and nothing else. An optional field may be left out but never null.
    pub fn from_command(command: &Map<String, Value>) -> Option<Self> {
        let units = |text: &str| text.encode_utf16().count();
        const FIELDS: [&str; 8] = ["type", "threadId", "actionId", "action", "commitMessage", "featureBranch", "filePaths", "allowDefaultBranch"];
        if command.get("type").and_then(Value::as_str) != Some("git-action") || !command.keys().all(|key| FIELDS.contains(&key.as_str())) {
            return None;
        }
        let thread_id = command.get("threadId").and_then(Value::as_str).filter(|id| (1..=512).contains(&units(id)))?;
        let action_id = command.get("actionId").and_then(Value::as_str).filter(|id| zod_uuid(id))?;
        let action = command.get("action").and_then(Value::as_str).and_then(GitStackedAction::parse)?;
        let switch = |key: &str| match command.get(key) {
            None => Some(None),
            Some(Value::Bool(value)) => Some(Some(*value)),
            Some(_) => None,
        };
        let commit_message = match command.get("commitMessage") {
            None => None,
            Some(Value::String(message)) if units(message) <= 10_000 => Some(message.clone()),
            Some(_) => return None,
        };
        let file_paths = match command.get("filePaths") {
            None => None,
            Some(Value::Array(paths)) if paths.len() <= 2_000 => Some(
                paths.iter().map(|path| path.as_str().filter(|path| (1..=4_096).contains(&units(path))).map(ToString::to_string)).collect::<Option<Vec<_>>>()?,
            ),
            Some(_) => return None,
        };
        Some(Self {
            thread_id: thread_id.to_string(),
            action_id: action_id.to_string(),
            action,
            commit_message,
            feature_branch: switch("featureBranch")?,
            file_paths,
            allow_default_branch: switch("allowDefaultBranch")?,
        })
    }
}

/// Zod 4's `z.uuid()`: versions 1 to 8 with the RFC variant, or the nil and max UUIDs written in lower case.
fn zod_uuid(text: &str) -> bool {
    if text == "00000000-0000-0000-0000-000000000000" || text == "ffffffff-ffff-ffff-ffff-ffffffffffff" {
        return true;
    }
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(at, byte)| match at {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => (b'1'..=b'8').contains(byte),
            19 => b"89abAB".contains(byte),
            _ => byte.is_ascii_hexdigit(),
        })
}

/// What an action tells its watcher as it runs, in T3's shape: Node's `GitActionEvent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitActionEvent {
    ActionStarted { phases: Vec<GitActionPhase>, stages: Vec<String> },
    PhaseStarted { phase: GitActionPhase, stage: String },
    HookStarted { hook_name: String },
    HookOutput { hook_name: Option<String>, text: String },
    HookFinished { hook_name: String },
}

/// Where an action's events go. It is called from Git's output readers as well as the action's own thread.
pub type Progress = Arc<dyn Fn(GitActionEvent) + Send + Sync>;

/// The notice an action ends with: Node's `gitActionToastSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitActionToast {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub cta: GitActionCta,
}

/// What the notice's button does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GitActionCta {
    None,
    OpenPr { label: String, url: String },
    RunAction { label: String, action: GitStackedAction },
}

/// The feature branch step: `created` with its name, or `skipped_not_requested`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BranchStep {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// The commit step: `created` with the commit and its subject, `skipped_no_changes` or `skipped_not_requested`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommitStep {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
}

/// The push step: `pushed` with the branch and upstream, and whether the upstream was set; `skipped_up_to_date` or
/// `skipped_not_requested`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushStep {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set_upstream: Option<bool>,
}

/// The pull request step: `created` or `opened_existing` with what GitHub said of it, or `skipped_not_requested`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PullRequestStep {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

const NOT_REQUESTED: &str = "skipped_not_requested";

/// What an action did, step by step: Node's `gitActionResultSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitActionResult {
    pub action: GitStackedAction,
    pub branch: BranchStep,
    pub commit: CommitStep,
    pub push: PushStep,
    pub pr: PullRequestStep,
    pub toast: GitActionToast,
}

impl GitActionResult {
    fn nothing_yet(action: GitStackedAction) -> Self {
        Self {
            action,
            branch: BranchStep { status: NOT_REQUESTED, name: None },
            commit: CommitStep { status: NOT_REQUESTED, sha: None, subject: None },
            push: PushStep { status: NOT_REQUESTED, branch: None, upstream: None, set_upstream: None },
            pr: PullRequestStep { status: NOT_REQUESTED, url: None, number: None, base: None, head: None, title: None },
            toast: GitActionToast { title: "Done".into(), description: None, cta: GitActionCta::None },
        }
    }
}

/// The hook running and the last line it printed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitActionHook {
    pub name: String,
    pub output: Option<String>,
}

/// A thread's Git action as every client draws it, while it runs and once it is over: Node's `gitActionProgressSchema`,
/// kept the way `runGitAction` keeps it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitActionProgress {
    pub action_id: String,
    pub action: GitStackedAction,
    pub status: &'static str,
    pub phases: Vec<GitActionPhase>,
    pub phase: Option<GitActionPhase>,
    pub stage: Option<String>,
    pub hook: Option<GitActionHook>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub result: Option<GitActionResult>,
    pub error: Option<String>,
}

impl GitActionProgress {
    /// An action admitted and under way, with nothing reported yet.
    pub fn running(action_id: &str, action: GitStackedAction, started_at: String) -> Self {
        Self { action_id: action_id.into(), action, status: "running", phases: Vec::new(), phase: None, stage: None, hook: None, started_at, finished_at: None, result: None, error: None }
    }

    /// The record after `event`, as Node's `onProgress` changes it.
    pub fn apply(&mut self, event: &GitActionEvent) {
        match event {
            GitActionEvent::ActionStarted { phases, stages } => {
                self.phases = phases.clone();
                self.stage = stages.first().cloned();
            }
            GitActionEvent::PhaseStarted { phase, stage } => {
                self.phase = Some(*phase);
                self.stage = Some(stage.clone());
                self.hook = None;
            }
            GitActionEvent::HookStarted { hook_name } => self.hook = Some(GitActionHook { name: hook_name.clone(), output: None }),
            GitActionEvent::HookOutput { hook_name, text } => {
                let name = hook_name.clone().or_else(|| self.hook.as_ref().map(|hook| hook.name.clone())).unwrap_or_else(|| "hook".into());
                self.hook = Some(GitActionHook { name, output: Some(text.clone()) });
            }
            GitActionEvent::HookFinished { .. } => self.hook = None,
        }
    }

    /// The record once the action is over: its result, or Node's words for why it failed.
    pub fn finish(&mut self, outcome: Result<GitActionResult, String>, finished_at: String) {
        self.phase = None;
        self.stage = None;
        self.hook = None;
        self.finished_at = Some(finished_at);
        match outcome {
            Ok(result) => {
                self.status = "done";
                self.result = Some(result);
            }
            Err(error) => {
                self.status = "failed";
                self.error = Some(error);
            }
        }
    }
}

/// A Git diff cut for a provider to describe, as Node's `diffExcerpt` (`src/main/llm/diffExcerpt.ts`) cuts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffExcerpt {
    pub text: String,
    pub truncated: bool,
}

const TRUNCATION_NOTE: &str = "[The diff was longer than this and was cut here. Describe only what is above.]";

/// Node's `diffExcerpt`: the diff with Windows line endings made plain and trimmed, or, when it is longer than `max`
/// UTF-16 code units, cut at a line boundary in its second half, or where the room ends, with a note that says so.
pub fn diff_excerpt(diff: &str, max: usize) -> DiffExcerpt {
    let plain = diff.replace("\r\n", "\n");
    let text = js_trim(&plain);
    if text.encode_utf16().count() <= max {
        return DiffExcerpt { text: text.to_string(), truncated: false };
    }
    let room = max.saturating_sub(TRUNCATION_NOTE.encode_utf16().count() + 2);
    let cut = clip_utf16(text, room);
    let kept = match cut.rfind('\n') {
        Some(at) if cut[..at].encode_utf16().count() * 2 > room => &cut[..at],
        _ => cut,
    };
    let kept = kept.trim_end_matches(crate::git_local::js_space);
    DiffExcerpt { text: format!("{kept}\n\n{TRUNCATION_NOTE}"), truncated: true }
}

/// What a commit message is drafted from, as Node's `CommitMaterial` carries it: the staged diff, cut, and what the
/// repository says about its own commits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitMaterial {
    pub diff: DiffExcerpt,
    pub name_status: String,
    pub subjects: Vec<String>,
    pub agents_file: Option<String>,
}

/// An open pull request GitHub lists for a branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenPullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub base: String,
}

/// What an action needs from outside Git, as Node's `GitActionsDependencies` and its GitHub helpers give it.
pub trait GitActionServices: Sync {
    /// The thread's own provider's draft of a commit message (ADR-0026), or `None` when it wrote nothing.
    fn write_commit_message(&self, thread_id: &str, material: &CommitMaterial) -> Option<String>;
    /// The branch's own open pull request on GitHub, as Node's `openPullRequest` finds it.
    fn open_pull_request(&self, cwd: &str, branch: &str) -> Result<Option<OpenPullRequest>, String>;
    /// The pull request step, as Node's `pullRequest` runs it once the branch is pushed.
    fn pull_request(&self, thread_id: &str, cwd: &str, branch: &str, progress: &Progress) -> Result<PullRequestStep, String>;
}

/// An action on a thread's folder: the command and the folder Git runs in.
#[derive(Debug, Clone)]
pub struct GitActionInput {
    pub thread_id: String,
    pub cwd: String,
    pub action: GitStackedAction,
    pub commit_message: Option<String>,
    pub feature_branch: Option<bool>,
    pub file_paths: Option<Vec<String>>,
    pub allow_default_branch: Option<bool>,
}

impl GitActionInput {
    /// The action a command asks for, in the folder Git runs it in.
    pub fn new(command: &GitActionCommand, cwd: String) -> Self {
        Self {
            thread_id: command.thread_id.clone(),
            cwd,
            action: command.action,
            commit_message: command.commit_message.clone(),
            feature_branch: command.feature_branch,
            file_paths: command.file_paths.clone(),
            allow_default_branch: command.allow_default_branch,
        }
    }
}

/// The folder's status an action decides on, read as Node's `GitStatusReader.read` reads it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ActionStatus {
    pub is_repository: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
    pub dirty: bool,
    pub is_default_branch: bool,
}

/// The status of `cwd`, read for a decision about to be acted on, never one read before. With `fetch`, `origin` is
/// fetched first, as Node's remote read does when its fetch is due; a fetch that fails leaves the last fetched refs.
///
/// Node's read also counts the changed lines and asks GitHub for the branch's pull request; no step of an action reads
/// either, so neither is read here. Its stand-in for `ahead` on a branch with no upstream is not read either: every step
/// that reads `ahead` reads it only for a branch with one.
pub fn read_status(cwd: &str, fetch: bool) -> Result<ActionStatus, String> {
    if !is_repository(cwd)? {
        return Ok(ActionStatus::default());
    }
    let has_origin = lines(&git(cwd, &["remote"], COMMAND_DEADLINE).unwrap_or_default()).iter().any(|remote| remote == "origin");
    if fetch && has_origin {
        fetch_origin(cwd);
    }
    let porcelain = git(cwd, &["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"], COMMAND_DEADLINE)?;
    let parsed = parse_porcelain(&porcelain);
    let default_branch = default_branch(cwd, has_origin);
    let is_default_branch = parsed.branch.is_some() && parsed.branch == default_branch;
    let (ahead, behind) = if parsed.upstream.is_some() { (parsed.ahead, parsed.behind) } else { (0, 0) };
    Ok(ActionStatus { is_repository: true, branch: parsed.branch, upstream: parsed.upstream, ahead, behind, dirty: parsed.changed_files > 0, is_default_branch })
}

/// `git fetch` of `origin` as Node's status reader runs it: quietly, without tags, writing no `FETCH_HEAD`, or without
/// that flag for a Git older than 2.29.
fn fetch_origin(cwd: &str) {
    let env: Vec<(String, String)> = QUIET_GIT_ENV.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect();
    let fetch = |args: &[&str]| run_action_git_with(cwd, args, FETCH_DEADLINE, ActionGitExtras { env: &env, ..ActionGitExtras::default() });
    if let Err(words) = fetch(&["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin"]) {
        if words.contains("no-write-fetch-head") {
            let _ = fetch(&["fetch", "--quiet", "--no-tags", "origin"]);
        }
    }
}

/// The repository's default branch, as Node's `defaultBranch` finds it: where `origin/HEAD` points, else `main` or
/// `master` when there is such a branch here.
fn default_branch(cwd: &str, has_origin: bool) -> Option<String> {
    if has_origin {
        let head = git(cwd, &["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], COMMAND_DEADLINE).unwrap_or_default();
        if let Some(name) = js_trim(&head).strip_prefix("origin/") {
            return Some(name.to_string());
        }
    }
    ["main", "master"].into_iter().find(|name| git(cwd, &["rev-parse", "--verify", "-q", &format!("refs/heads/{name}")], COMMAND_DEADLINE).is_ok()).map(ToString::to_string)
}

#[derive(Debug, Default)]
struct Porcelain {
    branch: Option<String>,
    upstream: Option<String>,
    ahead: u64,
    behind: u64,
    changed_files: usize,
}

/// `status --porcelain=v2 --branch -z`, as Node's `parsePorcelain` reads it.
fn parse_porcelain(output: &str) -> Porcelain {
    let mut result = Porcelain::default();
    let records: Vec<&str> = output.split('\0').collect();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        if let Some(header) = record.strip_prefix("# ") {
            let (name, value) = header.split_once(' ').unwrap_or((header, ""));
            match name {
                "branch.head" => result.branch = (value != "(detached)" && !value.is_empty()).then(|| value.to_string()),
                "branch.upstream" => result.upstream = (!value.is_empty()).then(|| value.to_string()),
                "branch.ab" => {
                    if let Some((ahead, behind)) = value.strip_prefix('+').and_then(|rest| rest.split_once(" -")) {
                        if let (Ok(ahead), Ok(behind)) = (digits(ahead), digits(behind)) {
                            result.ahead = ahead;
                            result.behind = behind;
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        match record.as_bytes()[0] {
            b'1' | b'u' | b'?' => result.changed_files += 1,
            b'2' => {
                result.changed_files += 1;
                // The original path follows as its own record.
                index += 1;
            }
            _ => {}
        }
    }
    result
}

/// A count written in ASCII digits alone, as Node's `\d+` takes one.
fn digits(text: &str) -> Result<u64, ()> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(());
    }
    text.parse().map_err(|_| ())
}

/// The lines of Git's output, trimmed, without the empty ones.
fn lines(output: &str) -> Vec<String> {
    output.split('\n').map(js_trim).filter(|line| !line.is_empty()).map(ToString::to_string).collect()
}

/// A path list on standard input, as `--pathspec-file-nul` reads it.
fn pathspec_input(paths: &[String]) -> Vec<u8> {
    let mut input = paths.join("\0").into_bytes();
    input.push(0);
    input
}

fn git_with_input(cwd: &str, args: &[&str], input: &[u8]) -> Result<String, String> {
    run_action_git_with(cwd, args, COMMAND_DEADLINE, ActionGitExtras { stdin: Some(input), ..ActionGitExtras::default() })
}

/// The folders an action is running in, as Node's `GitActions` holds one action per folder at a time.
fn busy() -> &'static Mutex<HashSet<String>> {
    static BUSY: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    BUSY.get_or_init(Mutex::default)
}

/// A folder held for one action, let go when it is dropped.
struct Exclusive(String);

impl Exclusive {
    fn hold(cwd: &str) -> Result<Self, String> {
        let mut held = busy().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if !held.insert(cwd.to_string()) {
            return Err(IN_PROGRESS.into());
        }
        Ok(Self(cwd.to_string()))
    }
}

impl Drop for Exclusive {
    fn drop(&mut self) {
        busy().lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&self.0);
    }
}

/// T3's `runStackedAction`, as Node runs it: the branch, commit, push and pull request steps in that order, each
/// reported to `progress` as it starts, after every refusal Node makes before any of them, in Node's order and words.
/// `fetch` says whether the first read of the folder fetches `origin` first, as Node's does when its fetch is due.
pub fn run_stacked_action(input: &GitActionInput, fetch: bool, services: &dyn GitActionServices, progress: &Progress) -> Result<GitActionResult, String> {
    let _held = Exclusive::hold(&input.cwd)?;
    let (cwd, action) = (input.cwd.as_str(), input.action);
    let status = read_status(cwd, fetch)?;
    if !status.is_repository {
        return Err(NOT_A_REPOSITORY.into());
    }
    let wants_commit = action.commits();
    let wants_pr = action.opens_pull_request();
    let wants_push = matches!(action, GitStackedAction::Push | GitStackedAction::CommitPush | GitStackedAction::CommitPushPr)
        || (action == GitStackedAction::CreatePr && (status.upstream.is_none() || status.ahead > 0));
    let feature_branch = input.feature_branch == Some(true);
    if feature_branch && !wants_commit && !wants_push {
        return Err("A feature branch is cut only for an action that commits or pushes.".into());
    }
    if input.file_paths.as_ref().is_some_and(Vec::is_empty) {
        return Err("Choose at least one file to commit.".into());
    }
    if action == GitStackedAction::CreatePr && status.dirty {
        return Err("Commit local changes before creating a PR.".into());
    }
    if status.branch.is_none() && wants_push && !feature_branch {
        return Err(DETACHED_PUSH.into());
    }
    if status.branch.is_none() && wants_pr {
        return Err("Cannot create a pull request from detached HEAD.".into());
    }
    if status.is_default_branch && (wants_push || wants_pr) && !feature_branch && input.allow_default_branch != Some(true) {
        let what = if wants_pr { "creating a pull request" } else { "pushing" };
        return Err(format!("Confirm {what} from the default branch first, or commit on a new branch."));
    }
    let push_target = push_remote(cwd, status.branch.as_deref());
    let has_message = input.commit_message.as_deref().is_some_and(|message| !js_trim(message).is_empty());
    progress(GitActionEvent::ActionStarted {
        phases: git_action_phases(action, feature_branch),
        stages: git_action_stages(action, has_message, status.dirty, push_target.as_deref(), feature_branch, action == GitStackedAction::CreatePr && wants_push),
    });
    let mut result = GitActionResult::nothing_yet(action);
    let mut branch = status.branch.clone();
    // "Check out feature branch & continue" on a push from the default branch: the branch is cut from HEAD and named
    // after its last commit, since there is no new commit to name it after.
    if feature_branch && !wants_commit {
        let subject = git(cwd, &["log", "-1", "--format=%s"], COMMAND_DEADLINE).unwrap_or_default();
        let subject = js_trim(&subject);
        if subject.is_empty() {
            return Err("Cannot create a feature branch because there are no commits to push.".into());
        }
        progress(GitActionEvent::PhaseStarted { phase: GitActionPhase::Branch, stage: "Preparing feature ref...".into() });
        let name = cut_feature_branch(cwd, subject)?;
        result.branch = BranchStep { status: "created", name: Some(name.clone()) };
        branch = Some(name);
    }
    if wants_commit {
        // A merge, cherry-pick or rebase half done is the user's to finish: staging afresh here would drop its state.
        for marker in ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"] {
            if git(cwd, &["rev-parse", "-q", "--verify", marker], COMMAND_DEADLINE).is_ok() {
                return Err(MERGE_IN_PROGRESS.into());
            }
        }
        let staged = Staged::stage(cwd, input.file_paths.as_deref())?;
        let mut committed = false;
        let step = (|| -> Result<(), String> {
            if !staged.has_changes {
                if feature_branch {
                    return Err("Cannot create a feature branch because there are no changes to commit.".into());
                }
                result.commit = CommitStep { status: "skipped_no_changes", sha: None, subject: None };
                return Ok(());
            }
            let message = commit_message(input, services, progress)?;
            if feature_branch {
                progress(GitActionEvent::PhaseStarted { phase: GitActionPhase::Branch, stage: "Preparing feature ref...".into() });
                let name = cut_feature_branch(cwd, &message.subject)?;
                result.branch = BranchStep { status: "created", name: Some(name.clone()) };
                branch = Some(name);
            }
            progress(GitActionEvent::PhaseStarted { phase: GitActionPhase::Commit, stage: "Committing...".into() });
            let sha = commit(cwd, &message, progress)?;
            committed = true;
            result.commit = CommitStep { status: "created", sha: Some(sha), subject: Some(message.subject) };
            Ok(())
        })();
        // As Node's `finally`: the index is put back whatever happened, and a failure to put it back is the one said.
        staged.restore(committed)?;
        step?;
    }
    if wants_push {
        let stage = push_target.as_deref().map_or_else(|| "Pushing...".to_string(), |target| format!("Pushing to {target}..."));
        progress(GitActionEvent::PhaseStarted { phase: GitActionPhase::Push, stage });
        result.push = push(cwd, branch.as_deref())?;
    }
    if wants_pr {
        progress(GitActionEvent::PhaseStarted { phase: GitActionPhase::Pr, stage: "Preparing PR...".into() });
        // Refused above for a detached HEAD, which a feature branch would not have left.
        let head = branch.clone().unwrap_or_default();
        result.pr = services.pull_request(&input.thread_id, cwd, &head, progress)?;
    }
    result.toast = toast(cwd, &result, branch.as_deref(), status.is_default_branch, services);
    Ok(result)
}

/// T3's branch fragment, as Node's `featureBranchName` makes it: lower case, quotes gone, anything odd a dash, at most
/// 64 characters, and a `feature/` namespace unless one is given.
pub fn feature_branch_name(fragment: &str) -> String {
    let lowered = js_trim(fragment).to_lowercase();
    let mut name = String::new();
    let mut odd = false;
    for c in lowered.chars().filter(|c| !"\"'\u{201c}\u{201d}\u{2018}\u{2019}`".contains(*c)) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '/' || c == '_' || c == '-' {
            if odd {
                name.push('-');
                odd = false;
            }
            name.push(c);
        } else {
            odd = true;
        }
    }
    if odd {
        name.push('-');
    }
    let mut collapsed = String::with_capacity(name.len());
    for c in name.chars() {
        if !(c == '-' && collapsed.ends_with('-')) {
            collapsed.push(c);
        }
    }
    let mut name = collapsed.trim_matches(['-', '/']).to_string();
    if name.is_empty() {
        name = "update".into();
    }
    if !name.contains('/') {
        name = format!("feature/{name}");
    }
    if name.len() > FEATURE_BRANCH_MAX {
        name.truncate(FEATURE_BRANCH_MAX);
        name = name.trim_end_matches(['-', '/']).to_string();
    }
    name
}

/// Cuts a feature branch named from `subject` at HEAD, unique among the branches here, and checks it out.
fn cut_feature_branch(cwd: &str, subject: &str) -> Result<String, String> {
    let name = unique_branch(cwd, &feature_branch_name(subject));
    git(cwd, &["branch", &name], COMMAND_DEADLINE)?;
    git(cwd, &["checkout", &name, "--"], CHECKOUT_DEADLINE)?;
    Ok(name)
}

/// `wanted`, or the first of `wanted-2`, `wanted-3` and on that no branch here has, whatever the case.
fn unique_branch(cwd: &str, wanted: &str) -> String {
    let listing = git(cwd, &["branch", "--list", "--no-column", "--format=%(refname:short)"], COMMAND_DEADLINE).unwrap_or_default();
    let taken: HashSet<String> = lines(&listing).into_iter().map(|line| line.to_lowercase()).collect();
    if !taken.contains(&wanted.to_lowercase()) {
        return wanted.to_string();
    }
    (2..).map(|suffix| format!("{wanted}-{suffix}")).find(|candidate| !taken.contains(&candidate.to_lowercase())).unwrap_or_default()
}

/// Adds `path` to an ordered set kept as a list and a set.
fn add_once(set: &mut HashSet<String>, list: &mut Vec<String>, path: &str) {
    if set.insert(path.to_string()) {
        list.push(path.to_string());
    }
}

/// The index as it was before an action staged its commit, and what the commit takes, as Node's `stage` leaves them.
struct Staged {
    top: String,
    original_tree: String,
    selected: Vec<String>,
    excluded: Vec<String>,
    has_changes: bool,
}

impl Staged {
    /// Keeps the hunks already staged; stages only the chosen files not staged yet, everything when none were chosen,
    /// and leaves staged files that were not chosen out for now. A conflicted file refuses before the index is touched.
    fn stage(cwd: &str, file_paths: Option<&[String]>) -> Result<Self, String> {
        let top = js_trim(&git(cwd, &["rev-parse", "--show-toplevel"], COMMAND_DEADLINE)?).to_string();
        let (_, records) = parse_porcelain_v2_changed(&git(&top, &["status", "--porcelain=v2", "-z", "--untracked-files=all"], COMMAND_DEADLINE)?);
        if records.iter().any(|record| record.status == "conflicted") {
            return Err("Resolve the conflicted files before committing here.".into());
        }
        let original_tree = js_trim(&git(&top, &["write-tree"], COMMAND_DEADLINE)?).to_string();
        // Sets in the order their paths came, as Node's `Set`s keep them.
        let mut selected = Vec::new();
        let mut chosen = HashSet::new();
        let paths: Vec<&str> = match file_paths {
            Some(paths) => paths.iter().map(String::as_str).collect(),
            None => records.iter().map(|record| record.path.as_str()).collect(),
        };
        for path in paths {
            add_once(&mut chosen, &mut selected, path);
        }
        for record in &records {
            if let (true, Some(original)) = (record.status == "renamed", record.original_path.as_deref()) {
                if chosen.contains(&record.path) {
                    add_once(&mut chosen, &mut selected, original);
                }
            }
        }
        let (mut staged_paths, mut staged_set) = (Vec::new(), HashSet::new());
        for path in git(&top, &["diff", "--cached", "--name-only", "--no-renames", "-z"], COMMAND_DEADLINE)?.split('\0').filter(|path| !path.is_empty()) {
            add_once(&mut staged_set, &mut staged_paths, path);
        }
        let excluded: Vec<String> = staged_paths.iter().filter(|path| !chosen.contains(*path)).cloned().collect();
        let unstaged: Vec<String> = selected.iter().filter(|path| !staged_set.contains(*path)).cloned().collect();
        let mut staged = Self { top, original_tree, selected, excluded, has_changes: false };
        let attempt = (|| -> Result<bool, String> {
            if !staged.excluded.is_empty() {
                git_with_input(&staged.top, &["--literal-pathspecs", "reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], &pathspec_input(&staged.excluded))?;
            }
            if !unstaged.is_empty() {
                git_with_input(&staged.top, &["--literal-pathspecs", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], &pathspec_input(&unstaged))?;
            }
            Ok(!js_trim(&git(&staged.top, &["diff", "--cached", "--name-status"], COMMAND_DEADLINE)?).is_empty())
        })();
        match attempt {
            Ok(has_changes) => {
                staged.has_changes = has_changes;
                Ok(staged)
            }
            Err(words) => {
                staged.restore(false)?;
                Err(words)
            }
        }
    }

    /// Puts the index back: as it was, or, once the commit is made, as it was for the files the commit did not take.
    fn restore(&self, committed: bool) -> Result<(), String> {
        if committed && self.excluded.is_empty() {
            return Ok(());
        }
        git(&self.top, &["read-tree", &self.original_tree], COMMAND_DEADLINE)?;
        if committed {
            git_with_input(&self.top, &["--literal-pathspecs", "reset", "-q", "HEAD", "--pathspec-from-file=-", "--pathspec-file-nul"], &pathspec_input(&self.selected))?;
        }
        Ok(())
    }
}

/// A commit's subject and body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitMessage {
    pub subject: String,
    pub body: String,
}

/// Node's `splitMessage`: the first line, trimmed, its trailing periods gone, cut to 72 characters, or the stand-in
/// subject when nothing is left; the rest, trimmed, is the body.
pub fn split_message(message: &str) -> CommitMessage {
    let (first, rest) = message.split_once('\n').unwrap_or((message, ""));
    let subject = js_trim(clip_utf16(js_trim(first).trim_end_matches('.'), COMMIT_SUBJECT_MAX));
    let subject = if subject.is_empty() { STAND_IN_SUBJECT } else { subject };
    CommitMessage { subject: subject.to_string(), body: js_trim(rest).to_string() }
}

/// The message given, or the provider's draft from the staged diff and the repository's conventions, as Node's
/// `commitMessage` asks for it: the last 20 subjects, the `AGENTS.md` in the thread's folder, and the files staged.
fn commit_message(input: &GitActionInput, services: &dyn GitActionServices, progress: &Progress) -> Result<CommitMessage, String> {
    if let Some(given) = input.commit_message.as_deref().map(js_trim).filter(|given| !given.is_empty()) {
        return Ok(split_message(given));
    }
    let cwd = input.cwd.as_str();
    progress(GitActionEvent::PhaseStarted { phase: GitActionPhase::Commit, stage: "Generating commit message...".into() });
    let name_status = clip_utf16(js_trim(&git(cwd, &["diff", "--cached", "--name-status"], COMMAND_DEADLINE)?), NAME_STATUS_MAX).to_string();
    let patch = git(cwd, &["diff", "--no-ext-diff", "--cached", "--patch", "--minimal"], COMMAND_DEADLINE).unwrap_or_default();
    let subjects = lines(&git(cwd, &["log", "-n", RECENT_SUBJECTS, "--no-merges", "--pretty=format:%s"], COMMAND_DEADLINE).unwrap_or_default());
    let agents_file = std::fs::read(Path::new(cwd).join("AGENTS.md")).ok().map(|bytes| clip_utf16(&String::from_utf8_lossy(&bytes), AGENTS_FILE_MAX).to_string());
    let material = CommitMaterial { diff: diff_excerpt(&patch, COMMIT_DIFF_MAX), name_status, subjects, agents_file };
    let written = services.write_commit_message(&input.thread_id, &material);
    Ok(split_message(written.as_deref().map(js_trim).filter(|written| !written.is_empty()).unwrap_or(STAND_IN_SUBJECT)))
}

/// What Git's trace says of a commit's hooks so far.
struct HookTrace {
    path: std::path::PathBuf,
    seen: usize,
    hook: Option<String>,
}

impl HookTrace {
    /// Reads the trace's new whole lines and reports each hook that started or exited, as Node's `readTrace` does.
    fn read(&mut self, progress: &Progress) {
        let text = std::fs::read(&self.path).map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).unwrap_or_default();
        let lines: Vec<&str> = text.split('\n').collect();
        let whole = lines.len().saturating_sub(1);
        for raw in lines.get(self.seen..whole).unwrap_or_default() {
            self.seen += 1;
            let Ok(event) = serde_json::from_str::<Value>(raw) else { continue };
            if event.get("child_class").and_then(Value::as_str) != Some("hook") {
                continue;
            }
            let argv: Vec<&str> = event.get("argv").and_then(Value::as_array).map(|argv| argv.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
            let name = hook_name_of(&argv);
            match event.get("event").and_then(Value::as_str) {
                Some("child_start") => {
                    self.hook = Some(name.clone());
                    progress(GitActionEvent::HookStarted { hook_name: name });
                }
                Some("child_exit") => {
                    progress(GitActionEvent::HookFinished { hook_name: name.clone() });
                    if self.hook.as_deref() == Some(name.as_str()) {
                        self.hook = None;
                    }
                }
                _ => {}
            }
        }
    }
}

/// The hook a trace event ran, as Node's `hookNameOf` names it: the file name of the argument that is a script in a
/// `hooks` folder, else of the first argument.
fn hook_name_of(argv: &[&str]) -> String {
    let in_hooks = |argument: &&&str| {
        argument.rfind(['/', '\\']).is_some_and(|at| at + 1 < argument.len() && argument[..at].ends_with("hooks"))
    };
    let script = argv.iter().find(in_hooks).or_else(|| argv.first()).copied().unwrap_or("hook");
    script.rsplit(['/', '\\']).next().unwrap_or("hook").to_string()
}

/// `git commit` with its hooks, as Node's `commit` runs it: the message on standard input, so no argument or file
/// carries it; each line Git and its hooks print passed on as the running hook's output; and the hooks named from Git's
/// own trace of its processes, read every 200 ms while it runs and once after. Answered with the commit made.
fn commit(cwd: &str, message: &CommitMessage, progress: &Progress) -> Result<String, String> {
    let trace_dir = std::env::temp_dir().join(format!("sotto-git-trace-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&trace_dir).map_err(|error| error.to_string())?;
    let trace = Arc::new(Mutex::new(HookTrace { path: trace_dir.join("trace.jsonl"), seen: 0, hook: None }));
    let (stop, stopped) = mpsc::channel::<()>();
    let ticker = {
        let (trace, progress) = (Arc::clone(&trace), Arc::clone(progress));
        std::thread::spawn(move || {
            while let Err(mpsc::RecvTimeoutError::Timeout) = stopped.recv_timeout(Duration::from_millis(200)) {
                lock(&trace).read(&progress);
            }
        })
    };
    let sink: LineSink = {
        let (trace, progress) = (Arc::clone(&trace), Arc::clone(progress));
        Arc::new(move |text: &str| {
            let line = clip_utf16(js_trim(text), HOOK_LINE_MAX);
            if !line.is_empty() {
                let hook_name = lock(&trace).hook.clone();
                progress(GitActionEvent::HookOutput { hook_name, text: line.to_string() });
            }
        })
    };
    let input = if message.body.is_empty() { format!("{}\n", message.subject) } else { format!("{}\n\n{}\n", message.subject, message.body) };
    let env = [("GIT_TRACE2_EVENT".to_string(), lock(&trace).path.to_string_lossy().into_owned())];
    let made = run_action_git_with(cwd, &["commit", "-F", "-"], commit_deadline(), ActionGitExtras { env: &env, stdin: Some(input.as_bytes()), lines: Some(sink) });
    drop(stop);
    let _ = ticker.join();
    lock(&trace).read(progress);
    remove_trace(&trace_dir);
    if let Err(detail) = made {
        return Err(refused_with("Commit failed.", &last_lines(&detail, 3), 600));
    }
    if let Some(hook_name) = lock(&trace).hook.take() {
        progress(GitActionEvent::HookFinished { hook_name });
    }
    Ok(js_trim(&git(cwd, &["rev-parse", "HEAD"], COMMAND_DEADLINE)?).to_string())
}

/// The trace, whichever reader held it last.
fn lock(trace: &Mutex<HookTrace>) -> std::sync::MutexGuard<'_, HookTrace> {
    trace.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Removes a commit's trace folder, trying again for a while as Node's `rm` does with `maxRetries`.
fn remove_trace(folder: &Path) {
    for _ in 0..6 {
        if std::fs::remove_dir_all(folder).is_ok() || !folder.exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// A Git setting, trimmed, or nothing when it is not set: Node's `config --get` with `.catch(() => '')`.
fn config(cwd: &str, key: &str) -> String {
    js_trim(&git(cwd, &["config", "--get", key], COMMAND_DEADLINE).unwrap_or_default()).to_string()
}

/// The remote a push goes to, as T3 chooses it: `branch.<b>.pushRemote`, then `remote.pushDefault`, when either names a
/// remote this repository has, then `origin`, then the first remote.
fn push_remote(cwd: &str, branch: Option<&str>) -> Option<String> {
    let remotes = lines(&git(cwd, &["remote"], COMMAND_DEADLINE).unwrap_or_default());
    let configured = [branch.map(|branch| config(cwd, &format!("branch.{branch}.pushRemote"))).unwrap_or_default(), config(cwd, "remote.pushDefault")];
    configured
        .into_iter()
        .find(|value| !value.is_empty() && remotes.contains(value))
        .or_else(|| if remotes.iter().any(|remote| remote == "origin") { Some("origin".into()) } else { remotes.first().cloned() })
}

/// A branch's upstream as its remote and branch, as Node's `parseUpstream` reads it.
fn parse_upstream(upstream: &str) -> (String, String) {
    match upstream.split_once('/') {
        Some((remote, branch)) => (remote.to_string(), branch.to_string()),
        None => ("origin".to_string(), upstream.to_string()),
    }
}

/// T3's push, as Node's `push` runs it. A branch with no upstream is published under its own name and tracks it; so is
/// one fetched from one remote and pushed to another, and a topic branch tracking another branch, which records that
/// branch as its pull request's base. Only a branch with its upstream's own name is pushed to its upstream, and only
/// when it is ahead or behind. Never forced: a remote that moved refuses in T3's words.
fn push(cwd: &str, branch: Option<&str>) -> Result<PushStep, String> {
    let Some(branch) = branch else {
        return Err(DETACHED_PUSH.into());
    };
    let status = read_status(cwd, false)?;
    let remote = push_remote(cwd, Some(branch));
    // A branch named after its remote's ref, as `origin/fix`, is published without the remote's name.
    let publish = match (remote.as_deref(), branch.split_once('/')) {
        (Some(remote), Some((first, rest))) if !first.is_empty() && first == remote => rest.to_string(),
        _ => branch.to_string(),
    };
    let Some(remote) = remote else {
        return Err("Cannot push because no git remote is configured for this repository.".into());
    };
    let upstream = status.upstream.as_deref().map(parse_upstream);
    // Publishes the branch under its own name and makes that its upstream.
    let publish_here = || -> Result<PushStep, String> {
        git(cwd, &["push", "-u", &remote, &format!("HEAD:refs/heads/{publish}")], PUSH_DEADLINE)?;
        Ok(PushStep { status: "pushed", branch: Some(publish.clone()), upstream: Some(format!("{remote}/{publish}")), set_upstream: Some(true) })
    };
    let attempt = (|| -> Result<PushStep, String> {
        let Some((upstream_remote, upstream_branch)) = upstream.as_ref() else {
            let pushed_already = git(cwd, &["rev-parse", "--verify", "-q", &format!("refs/remotes/{remote}/{publish}")], COMMAND_DEADLINE).unwrap_or_default();
            let pushed_already = js_trim(&pushed_already);
            if !pushed_already.is_empty() && pushed_already == js_trim(&git(cwd, &["rev-parse", "HEAD"], COMMAND_DEADLINE)?) {
                return Ok(PushStep { status: "skipped_up_to_date", branch: None, upstream: None, set_upstream: None });
            }
            return publish_here();
        };
        let elsewhere = &remote != upstream_remote;
        let configured_elsewhere = (elsewhere && config(cwd, &format!("branch.{branch}.pushRemote")) == remote) || (elsewhere && config(cwd, "remote.pushDefault") == remote);
        if configured_elsewhere {
            // A triangular workflow: fetched from one remote, pushed to another. Git's own push would go there, so this one does too.
            return publish_here();
        }
        // Only a branch with the upstream's own name, or one named after the remote ref itself, is the same branch.
        // `fix/main` tracking `origin/main` is a topic branch, and its push publishes it under its own name.
        let same_branch = upstream_branch == branch || branch == format!("{upstream_remote}/{upstream_branch}");
        if !same_branch {
            // A branch cut from `origin/main` tracks main; pushing publishes it under its own name and moves the upstream there.
            let base = format!("branch.{branch}.gh-merge-base");
            if config(cwd, &base).is_empty() {
                let _ = git(cwd, &["config", &base, upstream_branch], COMMAND_DEADLINE);
            }
            return publish_here();
        }
        if status.ahead == 0 && status.behind == 0 {
            return Ok(PushStep { status: "skipped_up_to_date", branch: None, upstream: None, set_upstream: None });
        }
        git(cwd, &["push", upstream_remote, &format!("HEAD:refs/heads/{upstream_branch}")], PUSH_DEADLINE)?;
        Ok(PushStep { status: "pushed", branch: Some(upstream_branch.clone()), upstream: status.upstream.clone(), set_upstream: None })
    })();
    attempt.map_err(|detail| {
        let lower = detail.to_lowercase();
        if lower.contains("non-fast-forward") || lower.contains("fetch first") {
            BEHIND_UPSTREAM.to_string()
        } else {
            refused_with("Push failed.", &last_two_lines(&safe_remote(&detail)), 600)
        }
    })
}

/// A notice line cut to 72 characters, as Node's `cut` does.
fn cut(text: &str) -> String {
    if text.encode_utf16().count() > 72 {
        format!("{}...", clip_utf16(text, 69))
    } else {
        text.to_string()
    }
}

/// A notice's description, cut, when there is text for one: Node leaves an empty one out.
fn described(text: Option<&str>) -> Option<String> {
    text.filter(|text| !text.is_empty()).map(cut)
}

/// The notice an action ends with, as Node's `toast` words it: the pull request opened, else what was pushed with the
/// pull request a branch other than the default one has or could have, else what was committed, else why nothing was.
fn toast(cwd: &str, result: &GitActionResult, branch: Option<&str>, is_default_branch: bool, services: &dyn GitActionServices) -> GitActionToast {
    let short = |sha: &str| sha.chars().take(7).collect::<String>();
    let notice = |title: String, description: Option<String>, cta: GitActionCta| GitActionToast { title, description, cta };
    if result.pr.status == "created" || result.pr.status == "opened_existing" {
        let title = match result.pr.number {
            Some(number) => format!("{} PR #{number}", if result.pr.status == "created" { "Created" } else { "Opened" }),
            None => "Created the pull request".into(),
        };
        let cta = result.pr.url.clone().map_or(GitActionCta::None, |url| GitActionCta::OpenPr { label: "View PR".into(), url });
        return notice(title, described(result.pr.title.as_deref()), cta);
    }
    if result.push.status == "pushed" {
        let target = result.push.upstream.clone().or_else(|| result.push.branch.clone()).unwrap_or_else(|| "the remote".into());
        let title = match result.commit.sha.as_deref() {
            Some(sha) => format!("Pushed {} to {target}", short(sha)),
            None => format!("Pushed to {target}"),
        };
        let description = described(result.commit.subject.as_deref());
        if let (false, Some(branch)) = (is_default_branch, branch) {
            let cta = match services.open_pull_request(cwd, branch) {
                Ok(Some(open)) => GitActionCta::OpenPr { label: "View PR".into(), url: open.url },
                _ => GitActionCta::RunAction { label: "Create PR".into(), action: GitStackedAction::CreatePr },
            };
            return notice(title, description, cta);
        }
        return notice(title, description, GitActionCta::None);
    }
    if let (true, Some(sha)) = (result.commit.status == "created", result.commit.sha.as_deref()) {
        let cta = if result.action == GitStackedAction::Commit { GitActionCta::RunAction { label: "Push".into(), action: GitStackedAction::Push } } else { GitActionCta::None };
        return notice(format!("Committed {}", short(sha)), described(result.commit.subject.as_deref()), cta);
    }
    if result.push.status == "skipped_up_to_date" {
        return notice("Already up to date".into(), Some("Nothing to push.".into()), GitActionCta::None);
    }
    if result.commit.status == "skipped_no_changes" {
        return notice("Nothing to commit".into(), Some("The working tree is clean.".into()), GitActionCta::None);
    }
    notice("Done".into(), None, GitActionCta::None)
}

#[cfg(test)]
mod tests;
