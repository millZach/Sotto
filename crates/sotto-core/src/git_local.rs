//! Pull, Switch branch and Initialize Git on a thread's working copy (T3's Git commands, ADR-0027), as Node's
//! `GitActions` runs them (`pull`, `switchBranch` and `init` in `src/main/agents/git/gitActions.ts`) in the folder Node's
//! `threadWorkingDirectory` gives them, and the notice Node's coordinator says for each (`gitCommand` in
//! `src/main/agents/control.ts`). None of them reaches GitHub. A pull only fast-forwards; a switch never forces, so Git
//! refuses one that would lose work; nothing answers a prompt. Every refusal is in T3's words, or Git's, and leaves the
//! folder as it was. The checkout these run in is held by the coordinator while they run.

use std::path::Path;
use std::time::Duration;

use serde_json::{Map, Value};

use crate::ops::{run_action_git, GIT_MISSING};
use crate::workspace::{clip_utf16, AgentThreadWorktree};
use crate::worktree_reclaim::{checked_working_copy, existing_folder, inspect, shared_working_copy, with_repository};

/// What Node's runner gives a Git command that names no deadline of its own.
const COMMAND_DEADLINE: Duration = Duration::from_secs(30);
/// Node's deadline for a branch, a checkout and `git init`.
const QUICK_DEADLINE: Duration = Duration::from_secs(10);
/// Node's `PULL_TIMEOUT_MS`.
const PULL_DEADLINE: Duration = Duration::from_secs(30);

/// What Initialize Git says once the folder is a repository, as Node's coordinator says it.
pub const INITIALIZED_NOTICE: &str = "Git initialized.";
const INVALID_BRANCH_NAME: &str = "Enter a valid branch name.";

/// One of the three local Git commands, as a paired client sends it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalGitCommand {
    Pull,
    SwitchBranch { reference: String, create: bool },
    Init,
}

impl LocalGitCommand {
    /// The command, when it is one Node's strict command schema reads (`agentCommandSchema` in `src/shared/agents.ts`): a
    /// thread ID of 1 to 512 UTF-16 code units, and for a switch a `ref` of the same length and `create` only as a boolean,
    /// with nothing else. The socket server reads it before anything turns the command down or keeps its receipt.
    pub fn from_command(command: &Map<String, Value>) -> Option<Self> {
        let bounded = |text: &str| !text.is_empty() && text.encode_utf16().count() <= 512;
        command.get("threadId").and_then(Value::as_str).filter(|id| bounded(id))?;
        let only = |fields: &[&str]| command.keys().all(|key| key == "type" || key == "threadId" || fields.contains(&key.as_str()));
        match command.get("type").and_then(Value::as_str)? {
            "git-pull" => only(&[]).then_some(Self::Pull),
            "git-init" => only(&[]).then_some(Self::Init),
            "git-switch-branch" => {
                let reference = command.get("ref").and_then(Value::as_str).filter(|reference| bounded(reference))?;
                let create = match command.get("create") {
                    None => false,
                    Some(Value::Bool(create)) => *create,
                    Some(_) => return None,
                };
                only(&["ref", "create"]).then(|| Self::SwitchBranch { reference: reference.to_string(), create })
            }
            _ => None,
        }
    }
}

/// A thread's working copy as a Git command finds it: its record, its own working folder, its project's folder, and
/// whether its provider session has started (`nativeSessionStarted !== false`).
#[derive(Debug, Clone)]
pub struct ThreadFolder {
    pub worktree: Option<AgentThreadWorktree>,
    pub working_directory: Option<String>,
    pub project_path: String,
    pub started: bool,
}

impl ThreadFolder {
    /// The folder Node's `discoverWorkingCopy` reads for a thread with no record: its own, or its project's.
    fn directory(&self) -> String {
        self.working_directory.clone().unwrap_or_else(|| self.project_path.clone())
    }
}

/// Runs `command` on a thread's working copy, as Node's workspace does in the thread's Git lane once its checkout is held.
/// First the folder, as Node's `threadWorkingDirectory` finds it: a started thread with no record has one made for its
/// folder; a worktree that was deleted is put back on its recorded branch and read, and a branch switched inside it is
/// adopted (ADR-0014); a record that is not ready refuses. Then Git, and then the record follows what Git did
/// (`followGitChange`): read again, and for a switch the branch of the last send moves with it, so the branch notice never
/// shows for a switch made here. Initialize Git finds a shared folder again, since it is now a repository.
///
/// Answered with the record to keep, `None` when it stays as it was, which a refusal after the folder was read keeps too,
/// and the notice to say, or why not in Node's words.
pub fn run(data_directory: &Path, thread: &ThreadFolder, command: &LocalGitCommand) -> (Option<AgentThreadWorktree>, Result<String, String>) {
    let mut current = thread.worktree.clone();
    let kept = |current: Option<AgentThreadWorktree>| current.filter(|record| Some(record) != thread.worktree.as_ref());
    if current.is_none() && thread.started {
        match shared_working_copy(None, &thread.directory()) {
            Ok(found) => current = Some(found),
            Err(words) => return (None, Err(words)),
        }
    }
    if let Some(worktree) = current.as_ref() {
        let filled = with_repository(worktree, &thread.project_path);
        match checked_working_copy(data_directory, &filled) {
            Ok(read) => current = Some(read.unwrap_or(filled)),
            Err(words) => return (kept(current), Err(words)),
        }
    }
    let cwd = match working_folder(current.as_ref(), thread) {
        Ok(cwd) => cwd,
        Err(words) => return (kept(current), Err(words)),
    };
    let done = match command {
        LocalGitCommand::Pull => pull(&cwd).map(|pulled| pulled.notice()),
        LocalGitCommand::SwitchBranch { reference, create } => switch_branch(&cwd, reference, *create).map(|_| switched_notice(reference, *create)),
        LocalGitCommand::Init => init(&cwd).map(|()| INITIALIZED_NOTICE.to_string()),
    };
    if done.is_err() {
        return (kept(current), done);
    }
    if *command == LocalGitCommand::Init {
        // A folder that just became a repository is found again so its record says so; the record keeps what the thread
        // already chose on it. What cannot be read now is read by the next refresh.
        let directory = thread.directory();
        match current.as_ref() {
            Some(worktree) if worktree.mode == "shared" && !directory.is_empty() => {
                if let Ok(found) = shared_working_copy(Some(worktree), &directory) {
                    current = Some(found);
                }
            }
            None if thread.started => current = shared_working_copy(None, &directory).ok(),
            _ => {}
        }
    }
    let follow_sent_branch = matches!(command, LocalGitCommand::SwitchBranch { .. });
    if let Some(worktree) = current.as_ref().filter(|worktree| worktree.status == "ready" && worktree.path.is_some()) {
        // A folder that stopped being the thread's is reported by the next send.
        if let Ok(mut inspected) = inspect(worktree) {
            let sent = worktree.extra.contains_key("sentBranch");
            if let (true, true, Some(branch)) = (follow_sent_branch, sent, inspected.branch.clone()) {
                inspected.extra.insert("sentBranch".into(), Value::String(branch));
            }
            current = Some(inspected);
        }
    }
    (kept(current), done)
}

/// The folder Git runs in, as Node's `resolveThreadWorkingDirectory` and `existingWorkingDirectory` give it: the thread's
/// own working folder, else its worktree's with the project's place in it, else its project's, where any link leads.
fn working_folder(worktree: Option<&AgentThreadWorktree>, thread: &ThreadFolder) -> Result<String, String> {
    if let Some(worktree) = worktree.filter(|worktree| worktree.status != "ready") {
        return Err(worktree.error.clone().unwrap_or_else(|| "This thread’s working folder is not ready. Retry working-copy setup.".into()));
    }
    let checkout = worktree.and_then(|worktree| {
        let path = worktree.path.clone()?;
        Some(match worktree.extra.get("projectRelativePath").and_then(Value::as_str).filter(|place| !place.is_empty()) {
            Some(place) => format!("{path}/{place}"),
            None => path,
        })
    });
    let directory = thread.working_directory.clone().or(checkout).unwrap_or_else(|| thread.project_path.clone());
    if directory.is_empty() {
        return Err("This thread’s working folder is unavailable.".into());
    }
    existing_folder(&directory)
}

/// What Switch branch says once it is done, as Node's coordinator says it.
pub fn switched_notice(reference: &str, create: bool) -> String {
    if create {
        format!("Created and switched to {reference}.")
    } else {
        format!("Switched to {reference}.")
    }
}

/// What a pull did: whether the branch moved, and the branch and the upstream it follows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pulled {
    pub moved: bool,
    pub branch: String,
    pub upstream: String,
}

impl Pulled {
    /// What Pull says once it is done, as Node's coordinator says it.
    pub fn notice(&self) -> String {
        if self.moved {
            format!("Pulled. Updated {} from {}.", self.branch, self.upstream)
        } else {
            format!("Already up to date. {} matches {}.", self.branch, self.upstream)
        }
    }
}

fn git(cwd: &str, args: &[&str], deadline: Duration) -> Result<String, String> {
    run_action_git(cwd, args, deadline)
}

/// Whether `cwd` is in a repository, as Node's status read decides it (`rev-parse --git-common-dir`). Git missing is its
/// own failure, never a folder called "not a repository".
fn is_repository(cwd: &str) -> Result<bool, String> {
    match git(cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir"], COMMAND_DEADLINE) {
        Ok(_) => Ok(true),
        Err(words) if words == GIT_MISSING => Err(words),
        Err(_) => Ok(false),
    }
}

/// T3's switch, as Node's `switchBranch`: a name Git takes as a branch, then, to create, a new branch that does not exist
/// yet; otherwise the local branch, a local branch already tracking the remote one named, a new one tracking it, or
/// whatever Git checks out by that name. Git refuses a checkout that would overwrite uncommitted work, and nothing is
/// forced. Answered with the branch the folder is on afterwards, `None` when it is detached.
pub fn switch_branch(cwd: &str, reference: &str, create: bool) -> Result<Option<String>, String> {
    if js_trim(reference).is_empty() || reference.starts_with('-') {
        return Err(INVALID_BRANCH_NAME.into());
    }
    git(cwd, &["check-ref-format", "--branch", reference], COMMAND_DEADLINE).map_err(|_| INVALID_BRANCH_NAME.to_string())?;
    let exists = |candidate: &str| git(cwd, &["show-ref", "--verify", "--quiet", candidate], COMMAND_DEADLINE).is_ok();
    let failed = |words: String| refused_with("Failed to switch ref.", &last_two_lines(&words), 600);
    let checkout = |name: &str| git(cwd, &["checkout", name, "--"], QUICK_DEADLINE).map_err(failed);
    let local = format!("refs/heads/{reference}");
    if create {
        if exists(&local) {
            return Err(format!("The branch {reference} already exists. Switch to it instead."));
        }
        git(cwd, &["branch", reference], QUICK_DEADLINE).map_err(failed)?;
        checkout(reference)?;
    } else if exists(&local) {
        checkout(reference)?;
    } else if exists(&format!("refs/remotes/{reference}")) {
        let listing = git(cwd, &["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"], COMMAND_DEADLINE).unwrap_or_default();
        let tracking = listing.split('\n').find_map(|line| {
            let mut parts = line.split('\t');
            let name = parts.next().unwrap_or_default();
            (parts.next() == Some(reference) && !name.is_empty()).then(|| name.to_string())
        });
        match tracking {
            Some(tracking) => {
                checkout(&tracking)?;
            }
            None => {
                git(cwd, &["checkout", "--track", reference, "--"], QUICK_DEADLINE).map_err(failed)?;
            }
        }
    } else {
        checkout(reference)?;
    }
    let branch = git(cwd, &["branch", "--show-current"], COMMAND_DEADLINE)?;
    let branch = js_trim(&branch);
    Ok((!branch.is_empty()).then(|| branch.to_string()))
}

/// `git init` for a folder that is not in a repository yet, as Node's `init`.
pub fn init(cwd: &str) -> Result<(), String> {
    if is_repository(cwd)? {
        return Err("This folder is already a Git repository.".into());
    }
    git(cwd, &["init", "-q"], QUICK_DEADLINE).map_err(|words| refused_with("Git initialization failed.", &words, 400))?;
    Ok(())
}

/// T3's pull, as Node's `pull`: only a branch that tracks an upstream, and only a fast-forward (`git pull --ff-only`), so a
/// branch that has diverged is refused and nothing is merged or rebased.
pub fn pull(cwd: &str) -> Result<Pulled, String> {
    if !is_repository(cwd)? {
        return Err("This folder is not a Git repository.".into());
    }
    let (branch, upstream) = branch_and_upstream(&git(cwd, &["status", "--porcelain=v2", "--branch", "--untracked-files=no"], COMMAND_DEADLINE)?);
    let Some(branch) = branch else {
        return Err("Cannot pull from detached HEAD.".into());
    };
    let Some(upstream) = upstream else {
        return Err("Current branch has no upstream configured. Push with upstream first.".into());
    };
    let head = || git(cwd, &["rev-parse", "HEAD"], COMMAND_DEADLINE).map(|head| js_trim(&head).to_string());
    let before = head()?;
    if let Err(detail) = git(cwd, &["pull", "--ff-only"], PULL_DEADLINE) {
        let lower = detail.to_lowercase();
        if lower.contains("not possible to fast-forward") || lower.contains("diverg") {
            return Err("Branch has diverged from upstream. Rebase/merge first.".into());
        }
        return Err(refused_with("Pull failed.", &last_two_lines(&safe_remote(&detail)), 600));
    }
    let after = head()?;
    Ok(Pulled { moved: before != after, branch, upstream })
}

/// The branch and the upstream `status --porcelain=v2 --branch` names, as Node's `parsePorcelain` reads them: no branch
/// when the folder is detached.
fn branch_and_upstream(porcelain: &str) -> (Option<String>, Option<String>) {
    let (mut branch, mut upstream) = (None, None);
    for line in porcelain.split('\n') {
        if let Some(head) = line.strip_prefix("# branch.head ") {
            branch = (head != "(detached)" && !head.is_empty()).then(|| head.to_string());
        } else if let Some(name) = line.strip_prefix("# branch.upstream ") {
            upstream = (!name.is_empty()).then(|| name.to_string());
        }
    }
    (branch, upstream)
}

/// JavaScript's white space, as `trim` and `\s` take it: Unicode's white space without NEL, and the byte order mark.
fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

/// The last two lines of what Git said, joined, as Node keeps them (`split('\n').slice(-2).join(' ')`).
fn last_two_lines(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    lines[lines.len().saturating_sub(2)..].join(" ")
}

/// `{lead} {detail}` with `detail` cut to `max` UTF-16 code units, trimmed, as Node's refusals build it.
fn refused_with(lead: &str, detail: &str, max: usize) -> String {
    js_trim(&format!("{lead} {}", clip_utf16(detail, max))).to_string()
}

/// What Git said with any user name or token in a remote's address taken out, as Node's `safeRemote`
/// (`((?:https?|ssh):\/\/)[^\s/@]+@`, without regard to case).
fn safe_remote(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(c) = rest.chars().next() {
        let scheme = ["https://", "http://", "ssh://"].into_iter().find(|scheme| rest.get(..scheme.len()).is_some_and(|start| start.eq_ignore_ascii_case(scheme)));
        if let Some(scheme) = scheme {
            let after = &rest[scheme.len()..];
            let user = after.find(|c: char| js_space(c) || c == '/' || c == '@').unwrap_or(after.len());
            if user > 0 && after[user..].starts_with('@') {
                out.push_str(&rest[..scheme.len()]);
                rest = &after[user + 1..];
                continue;
            }
        }
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

#[cfg(test)]
mod tests;
