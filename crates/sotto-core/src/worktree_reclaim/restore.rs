//! Putting a thread's own worktree folder back, finishing a removal Sotto started, and reading a working copy again, as
//! Node's host does them: `restore`, `resumeRemoval`, `inspect` and `switchBranch` in `src/main/agents/threadWorktrees.ts`,
//! and the workspace's `updateThreadWorktree`, `threadWorkingDirectory`, `sendWorkingDirectory` and `restoreThreadBranch`
//! in `workspace.ts`. Nothing here resets a branch, removes a checkout Sotto was not already removing, or takes a branch
//! another folder has checked out (ADR-0014, ADR-0041). The words are Node's, since a client shows them.
//!
//! Everything here blocks on Git and the file system, so the coordinator runs it off its own thread, in the thread's lane.

use std::collections::HashMap;
use std::io::Write as _;
use std::sync::{Mutex, MutexGuard, OnceLock};

use super::*;

/// Node's `RESTORE_BRANCH_NEEDS_CONFIRMATION` (`src/shared/agents.ts`).
pub const RESTORE_BRANCH_NEEDS_CONFIRMATION: &str = "This folder has uncommitted changes. They move with the switch, so confirm it first.";
const REPAIR_STOPPED: &str = "Sotto could not put back this worktree’s missing files, so Git cannot use it yet. Nothing committed is lost.";
/// Restore branch for a thread with no shared project checkout, as Node's `restoreThreadBranch` says it.
pub const NO_CHECKOUT_TO_SWITCH: &str = "This thread has no project checkout to switch.";
const NOTHING_SENT_YET: &str = "Sotto has not sent to this thread yet, so there is no earlier branch to restore.";
/// How long Git may take to add a worktree, as Node's deadline for `worktree add`.
const ADD_DEADLINE: Duration = Duration::from_secs(300);

fn repair_failed() -> String {
    format!("{REPAIR_STOPPED} Check that Sotto can write to the folder, then choose Refresh to try again.")
}

/// A repair that stopped, in plain words: what kept it, when Sotto knows, and what to press, as Node's `unfinishedRepair`.
fn unfinished_repair(cause: &RemovalError) -> String {
    match cause {
        RemovalError::Kept(words) => format!("{REPAIR_STOPPED} {words}"),
        RemovalError::Other => repair_failed(),
    }
}

/// A send to a thread whose folder was removed on a commit the repository has since lost, as Node's `detachedCommitGone`.
fn detached_commit_gone(commit: &str) -> String {
    format!("This thread’s folder was removed on commit {}, which this repository no longer has, so Sotto cannot put it back. Nothing was changed. Continue the thread in a new worktree.", short(commit))
}

fn short(commit: &str) -> &str {
    &commit[..commit.len().min(7)]
}

/// A whole commit ID, as Node's `COMMIT_ID`.
fn commit_id(text: &str) -> bool {
    (text.len() == 40 || text.len() == 64) && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

// ---------------------------------------------------------------------------------------------------------------------
// The removals this process finished.

/// The branch, or detached commit, and time of a removal this process finished, as Node's `finishedRemovals` keeps them.
#[derive(Debug, Clone)]
struct Finished {
    branch: Option<String>,
    detached_commit: Option<String>,
    at: String,
}

/// The last removal of each folder in this process, until the folder is put back. A caller that waited its turn behind
/// that removal may hold a record made before the folder moved branch; this is the newer word.
static FINISHED_REMOVALS: OnceLock<Mutex<HashMap<String, Finished>>> = OnceLock::new();

fn finished_removals() -> MutexGuard<'static, HashMap<String, Finished>> {
    FINISHED_REMOVALS.get_or_init(Default::default).lock().unwrap_or_else(PoisonError::into_inner)
}

pub(super) fn record_finished(path: &Path, branch: Option<String>, detached_commit: Option<String>, at: String) {
    finished_removals().insert(path_key(path), Finished { branch, detached_commit, at });
}

// ---------------------------------------------------------------------------------------------------------------------
// Records.

/// A record following the branch its folder has checked out (ADR-0014), as Node's `withCheckedOutBranch`: none for a
/// detached HEAD, and a temporary branch the folder has moved off is no longer the thread's to rename.
pub(super) fn with_checked_out_branch(metadata: &AgentThreadWorktree, branch: Option<String>) -> AgentThreadWorktree {
    let mut record = metadata.clone();
    if record.temporary_branch == Some(true) && branch != record.branch {
        record.temporary_branch = Some(false);
    }
    record.branch = branch;
    record
}

/// A record of a folder removed on `branch`, or with none on `detached_commit`, at `at`, as Node's `reclaimedRecord` and
/// the record of a removal this process finished make it.
pub(super) fn reclaimed_on(metadata: &AgentThreadWorktree, branch: Option<String>, detached_commit: Option<String>, at: String) -> AgentThreadWorktree {
    let mut record = with_checked_out_branch(metadata, branch);
    record.status = "ready".into();
    record.error = None;
    record.extra.remove("dirty");
    match detached_commit {
        Some(commit) => record.extra.insert("detachedCommit".into(), Value::String(commit)),
        None => record.extra.remove("detachedCommit"),
    };
    record.extra.insert("reclaimedAt".into(), Value::String(at));
    record
}

/// A record Git has just confirmed: ready, with no error, and, since its folder is there, not reclaimed.
fn confirmed(mut record: AgentThreadWorktree, dirty: bool) -> AgentThreadWorktree {
    record.status = "ready".into();
    record.error = None;
    record.extra.remove("reclaimedAt");
    record.extra.remove("detachedCommit");
    record.extra.insert("dirty".into(), Value::Bool(dirty));
    record
}

fn dirty(record: &AgentThreadWorktree) -> bool {
    record.extra.get("dirty") == Some(&Value::Bool(true))
}

fn sent_branch(record: &AgentThreadWorktree) -> Option<String> {
    record.extra.get("sentBranch").and_then(Value::as_str).map(ToString::to_string)
}

fn with_sent_branch(mut record: AgentThreadWorktree, branch: Option<String>) -> AgentThreadWorktree {
    match branch {
        Some(branch) => record.extra.insert("sentBranch".into(), Value::String(branch)),
        None => record.extra.remove("sentBranch"),
    };
    record
}

/// Whether a Retry, Refresh or Restore branch command is one Node's strict command schema reads (`agentCommandSchema` in
/// `src/shared/agents.ts`): a thread ID, and `background` or `withUncommittedChanges` only as a boolean, on the command
/// that takes it. The socket server reads it before anything turns the command down or keeps its receipt, as Node's does.
pub fn working_copy_command_shape(command: &serde_json::Map<String, Value>) -> bool {
    let flag = match command.get("type").and_then(Value::as_str) {
        Some("retry-thread-worktree") => None,
        Some("refresh-thread-worktree") => Some("background"),
        Some("restore-thread-branch") => Some("withUncommittedChanges"),
        _ => return false,
    };
    let thread_id = command.get("threadId").and_then(Value::as_str).is_some_and(|id| !id.is_empty() && id.encode_utf16().count() <= 512);
    thread_id && command.iter().all(|(key, value)| key == "type" || key == "threadId" || (Some(key.as_str()) == flag && value.is_boolean()))
}

/// A record with the repository its worktree belongs to. Node records it whenever it takes an existing worktree
/// (`allocate`); this host's own records of one did not, so it is the project's, read as Node reads it then. Inspection
/// needs it to check that the folder is still that repository's checkout.
pub fn with_repository(metadata: &AgentThreadWorktree, project_path: &str) -> AgentThreadWorktree {
    if metadata.mode != "independent" || metadata.reused != Some(true) || metadata.repository_root.is_some() {
        return metadata.clone();
    }
    let root = git(Path::new(project_path), &["rev-parse", "--show-toplevel"]).ok().and_then(|root| realpath(Path::new(root.trim())).ok());
    let mut record = metadata.clone();
    record.repository_root = root.map(|root| text(&root));
    record
}

/// Whether `path` is a folder Sotto reserved for a thread's worktree: a whole UUID's name directly in `allocation_root`.
pub(super) fn reserved_place(path: &Path, allocation_root: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    path_key(&dirname(path)) == path_key(allocation_root) && name.len() == 36 && name.bytes().all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9' | b'-'))
}

// ---------------------------------------------------------------------------------------------------------------------
// The folder on disk, as Node reads it without Git.

/// What is at a reserved worktree path, as Node's `reservedFolder`. A link or junction is never empty here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reserved {
    Missing,
    Empty,
    Occupied,
}

fn reserved_folder(path: &Path) -> Result<Reserved, String> {
    let info = match fs::symlink_metadata(path) {
        Ok(info) => info,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Reserved::Missing),
        Err(error) => return Err(error.to_string()),
    };
    if !info.is_dir() || info.file_type().is_symlink() {
        return Ok(Reserved::Occupied);
    }
    let empty = realpath(path).is_ok_and(|real| path_key(&real) == path_key(path)) && fs::read_dir(path).is_ok_and(|mut names| names.next().is_none());
    Ok(if empty { Reserved::Empty } else { Reserved::Occupied })
}

/// `lstat` answering only whether something is there; anything but its absence is an error.
fn there(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if not_found(&error) => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

/// Where a linked worktree's `.git` file points, without reading anything there, as Node's `pointerTarget`; none for a
/// file that names nothing.
fn pointer_target(root: &Path) -> io::Result<Option<PathBuf>> {
    let contents = fs::read_to_string(root.join(".git"))?;
    let trimmed = contents.trim();
    Ok(trimmed.strip_prefix("gitdir: ").filter(|rest| !rest.is_empty() && !rest.contains(['\n', '\r', '\u{2028}', '\u{2029}'])).map(|rest| resolve(&root.join(rest.trim()))))
}

/// A checkout's own Git directory and its repository's common one, from the `.git` entry at its root, as Node's
/// `gitDirectories`: a directory for a main checkout, or a file pointing at the one Git keeps for a linked worktree.
struct GitDirectories {
    git_dir: PathBuf,
    common_dir: PathBuf,
    linked: bool,
}

fn git_directories(root: &Path) -> Result<Option<GitDirectories>, String> {
    let marker = root.join(".git");
    let entry = fs::metadata(&marker).map_err(|e| e.to_string())?;
    if entry.is_dir() {
        return Ok(Some(GitDirectories { git_dir: marker.clone(), common_dir: marker, linked: false }));
    }
    if !entry.is_file() {
        return Ok(None);
    }
    let Some(git_dir) = pointer_target(root).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    match fs::read_to_string(git_dir.join("commondir")) {
        Ok(common) => Ok(Some(GitDirectories { common_dir: resolve(&git_dir.join(common.trim())), git_dir, linked: true })),
        Err(error) if not_found(&error) => Ok(Some(GitDirectories { common_dir: git_dir.clone(), git_dir, linked: false })),
        Err(error) => Err(error.to_string()),
    }
}

/// The repository a folder is in, read from the `.git` entries on disk as Node's `checkoutOnDisk` reads them: the
/// nearest folder, this one or above, holding a `.git` file or a `.git` directory with a HEAD, objects and refs;
/// `Some(None)` for a folder in no repository; `None` when the file system would not answer.
fn repository_on_disk(folder: &Path) -> Option<Option<PathBuf>> {
    let mut candidate = folder.to_path_buf();
    loop {
        match fs::metadata(candidate.join(".git")) {
            Ok(entry) if entry.is_file() => return Some(Some(candidate)),
            Ok(entry) if entry.is_dir() => {
                let git = candidate.join(".git");
                if fs::metadata(git.join("HEAD")).is_ok_and(|m| m.is_file()) && fs::metadata(git.join("objects")).is_ok_and(|m| m.is_dir()) && fs::metadata(git.join("refs")).is_ok_and(|m| m.is_dir()) {
                    return Some(Some(candidate));
                }
            }
            Ok(_) => {}
            Err(error) if not_found(&error) => {}
            Err(_) => return None,
        }
        match candidate.parent() {
            Some(parent) => candidate = parent.to_path_buf(),
            None => return Some(None),
        }
    }
}

/// The branch a Git directory's HEAD names, `Some(None)` for a detached HEAD, or `None` for a HEAD only Git can read, as
/// Node's `headBranch`.
fn head_branch(git_dir: &Path) -> Option<Option<String>> {
    let head = fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    if let Some(reference) = head.strip_prefix("ref: ") {
        // A reftable repository keeps this stand-in in HEAD and its real HEAD elsewhere.
        if reference.is_empty() || reference.chars().any(char::is_whitespace) || reference == "refs/heads/.invalid" {
            return None;
        }
        return Some(reference.strip_prefix("refs/heads/").map(ToString::to_string));
    }
    commit_id(head).then_some(None)
}

/// The branch a ready record's folder has checked out, read from the checkout's own files instead of Git, as Node's
/// `checkoutFiles`: the folder is there and is the checkout the record names (for a worktree, not reached through a link,
/// and one its repository's registry lists, points back at and has not locked). `None` whenever the files do not settle
/// all of that, and then Git is asked.
fn branch_on_disk(metadata: &AgentThreadWorktree) -> Option<Option<String>> {
    let recorded = PathBuf::from(metadata.path.as_deref()?);
    if metadata.status != "ready" || metadata.reclaimed() {
        return None;
    }
    let path = realpath(&recorded).ok()?;
    if !fs::metadata(&path).ok()?.is_dir() {
        return None;
    }
    if metadata.mode == "shared" {
        let Some(root) = repository_on_disk(&path)? else {
            // A folder outside any repository, as it was when it was last inspected.
            return metadata.repository_root.is_none().then_some(None);
        };
        if metadata.repository_root.as_deref().is_none_or(|recorded| path_key(&root) != path_key(Path::new(recorded))) {
            return None;
        }
        return head_branch(&git_directories(&root).ok()??.git_dir);
    }
    let repository_root = metadata.repository_root.as_deref()?;
    // A worktree reached through a link is not the checkout Sotto made.
    if path_key(&path) != path_key(&recorded) {
        return None;
    }
    let directories = git_directories(&path).ok()??;
    let mut git_dir = directories.git_dir;
    if directories.linked {
        // Git's registry entry for this checkout: under the original repository's worktrees, naming this folder.
        let expected = git_directories(&realpath(Path::new(repository_root)).ok()?).ok()??;
        let common = realpath(&directories.common_dir).ok()?;
        if path_key(&common) != path_key(&realpath(&expected.common_dir).ok()?) {
            return None;
        }
        git_dir = realpath(&git_dir).ok()?;
        if path_key(&dirname(&git_dir)) != path_key(&common.join("worktrees")) {
            return None;
        }
        let named = fs::read_to_string(git_dir.join("gitdir")).ok()?;
        if path_key(&resolve(&git_dir.join(named.trim()))) != path_key(&path.join(".git")) || !matches!(there(&git_dir.join("locked")), Ok(false)) {
            return None;
        }
    } else if path_key(&path) != path_key(&realpath(Path::new(repository_root)).ok()?) {
        return None;
    }
    if let Some(relative) = metadata.extra.get("projectRelativePath").and_then(Value::as_str).filter(|r| !r.is_empty()) {
        let directory = realpath(&resolve(&path.join(relative))).ok()?;
        if !inside(&path, &directory) || !fs::metadata(&directory).ok()?.is_dir() {
            return None;
        }
    }
    head_branch(&git_dir)
}

// ---------------------------------------------------------------------------------------------------------------------
// Git, in a repository's registry lane where Node takes it.

fn git_until(cwd: &Path, args: &[&str], deadline: Option<Duration>) -> Result<String, String> {
    run_worktree_git(&text(cwd), args, deadline)
}

/// A repository's registry identity, verifying `reference` in the same Git call, as Node's `registryIdentity(cwd, verifyRef)`.
fn registry_identity_verifying(cwd: &Path, reference: &str) -> Result<RegistryIdentity, String> {
    let output = git(cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir", "--verify", reference])?;
    // Only the final object ID Git prints after the common directory is taken off.
    let body = output.trim_end_matches(['\r', '\n']);
    let common = match body.rfind('\n') {
        Some(at) if commit_id(&body[at + 1..]) => body[..at].trim_end_matches('\r'),
        _ => body,
    }
    .trim()
    .to_string();
    let key = path_key(&realpath(Path::new(&common)).map_err(|e| e.to_string())?);
    Ok(RegistryIdentity { common, key })
}

/// The folder Git keeps for the linked worktree at `path`: the one under `worktrees/` whose `gitdir` names its `.git`, as
/// Node's `registrationOf`.
fn registration_of(common: &Path, path: &Path) -> Option<PathBuf> {
    let registrations = common.join("worktrees");
    let wanted = path_key(&path.join(".git"));
    fs::read_dir(&registrations).ok()?.flatten().map(|entry| registrations.join(entry.file_name())).find(|registration| {
        fs::read_to_string(registration.join("gitdir")).is_ok_and(|gitdir| path_key(&resolve(&registration.join(gitdir.trim()))) == wanted)
    })
}

/// Whether a local branch or remote-tracking ref has `commit`, as Node's `onABranch`; tags do not count.
fn on_a_branch(cwd: &Path, commit: &str) -> Result<bool, String> {
    Ok(git(cwd, &["rev-list", "--max-count=1", commit, "--not", "--branches", "--remotes"])?.trim().is_empty())
}

/// Adds a worktree in the repository's registry lane, writing a new checkout's files in parallel unless the user's Git
/// config says otherwise, as Node's `addWorktree` and `parallelCheckout`. Node cleans up an add that ran out of time when
/// Git left the checkout it started and nothing else; this host keeps any folder Git left, and says so.
fn add_worktree(repository_root: &Path, path: &Path, checkout: &str, args: &[&str], identity: &RegistryIdentity) -> Result<(), String> {
    coordinate_registry(identity, || {
        let parallel = git(repository_root, &["config", "--get", "checkout.workers"]).is_err();
        let mut all: Vec<&str> = if parallel { vec!["-c", "checkout.workers=0"] } else { Vec::new() };
        all.extend_from_slice(args);
        match git_until(repository_root, &all, Some(ADD_DEADLINE)) {
            Ok(_) => Ok(()),
            Err(words) if words == "Git took too long." => Err(if emptied_and_unregistered(repository_root, path) {
                format!("Worktree setup took too long. Retry setup to continue on the same {}.", if checkout.starts_with("refs/heads/") { "branch" } else { "commit" })
            } else {
                "Worktree setup took too long. The incomplete folder was kept because it could not be safely removed. Move any local files out and restore the checkout before retrying.".into()
            }),
            Err(words) => Err(words),
        }
    })
}

/// The first entry in a checkout, as a folder-relative path, that is not a real folder where one of `files` needs its
/// folders to be: a file, or a link or junction, which Git never writes through, as Node's `inTheWay`.
fn in_the_way(root: &Path, files: &[String]) -> Result<Option<String>, String> {
    let mut checked = std::collections::HashSet::new();
    for file in files {
        let parts: Vec<&str> = file.split('/').collect();
        for depth in 1..parts.len() {
            let local = parts[..depth].join("/");
            if !checked.insert(local.clone()) {
                continue;
            }
            let info = match fs::symlink_metadata(parts[..depth].iter().fold(root.to_path_buf(), |path, part| path.join(part))) {
                Ok(info) => info,
                Err(error) if not_found(&error) => break,
                Err(error) => return Err(error.to_string()),
            };
            if info.file_type().is_symlink() || !info.is_dir() {
                return Ok(Some(local));
            }
        }
    }
    Ok(None)
}

/// Puts back, from the index, the tracked files missing from a checkout, and changes nothing that is there (#1301), as
/// Node's `putBackMissingFiles`. Where something in the folder stands where Git needs a folder, the repair stops naming it,
/// so the user's file is moved by the user rather than overwritten.
fn put_back_missing_files(path: &Path) -> Result<(), RemovalError> {
    let mut missing: Vec<String> = Vec::new();
    for file in split_nul(&git(path, &["ls-files", "--deleted", "-z"])?) {
        if !missing.contains(&file) {
            missing.push(file);
        }
    }
    // Bound each argument list on Windows.
    for batch in missing.chunks(100) {
        let mut args = vec!["checkout-index", "--"];
        args.extend(batch.iter().map(String::as_str));
        if git(path, &args).is_err() {
            if let Some(blocking) = in_the_way(path, batch)? {
                return Err(RemovalError::Kept(format!("{blocking} is in the way of the files Git puts back, and Sotto left it as it is. Move it out of the folder, then choose Refresh to try again.")));
            }
            return Err(RemovalError::Other);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------------
// Finishing a removal.

/// How a removal Sotto started is settled inside the registry lane.
enum Settle {
    Finish { branch: Option<String>, detached_head: Option<String>, nested: Vec<NestedWorktree> },
    Repair,
}

/// Finishes a removal Sotto started and did not finish, as Node's `resumeRemoval`. A folder Git holds locked for Sotto's
/// removal is finished: the answer is reclaimed, on the branch or detached commit Git has for the folder, and the next
/// send puts it back. A detached folder whose commit no branch has any more is left locked, with its commit, until one
/// does. A folder Git reports prunable without that lock, as a `git worktree remove` cut off before #1297 left it, has
/// nothing more of it deleted: its `.git` file is written back and the tracked files missing from it are put back from
/// Git's index. Anything that is not Sotto's own removal or repair comes back as it was.
pub(super) fn resume_removal(data_directory: &Path, metadata: &AgentThreadWorktree) -> Result<AgentThreadWorktree, String> {
    let (Some(path), Some(repository_root)) = (metadata.path.as_deref(), metadata.repository_root.as_deref()) else {
        return Ok(metadata.clone());
    };
    if metadata.mode != "independent" || metadata.reused == Some(true) {
        return Ok(metadata.clone());
    }
    let allocation_root = realpath(data_directory).unwrap_or_else(|_| resolve(data_directory)).join(THREAD_WORKTREE_FOLDER);
    let (path, repository_root) = (PathBuf::from(path), PathBuf::from(repository_root));
    if !reserved_place(&path, &allocation_root) {
        return Ok(metadata.clone());
    }
    take_turns(&REMOVAL_OPERATIONS, &path_key(&path), || resume_in_turn(metadata, &path, &repository_root))
}

fn resume_in_turn(metadata: &AgentThreadWorktree, path: &Path, repository_root: &Path) -> Result<AgentThreadWorktree, String> {
    // A folder this process removed, and that is still gone or emptied, is reclaimed on the branch that removal found.
    let after_removal = || -> AgentThreadWorktree {
        let finished = finished_removals().get(&path_key(path)).cloned();
        match finished {
            Some(finished) if !metadata.reclaimed() && reserved_folder(path).unwrap_or(Reserved::Occupied) != Reserved::Occupied => {
                reclaimed_on(metadata, finished.branch, finished.detached_commit, finished.at)
            }
            _ => metadata.clone(),
        }
    };
    // Read from disk first, so an ordinary folder starts no Git process here.
    let folder = match fs::symlink_metadata(path) {
        Ok(info) => Some(info),
        Err(error) if not_found(&error) => None,
        Err(error) => return Err(error.to_string()),
    };
    if folder.as_ref().is_some_and(|info| !info.is_dir() || info.file_type().is_symlink()) {
        return Ok(metadata.clone());
    }
    let marker = match folder {
        Some(_) => match fs::symlink_metadata(path.join(".git")) {
            Ok(info) => Some(info),
            Err(error) if not_found(&error) => None,
            Err(error) => return Err(error.to_string()),
        },
        None => None,
    };
    if folder.is_none() || marker.is_some() {
        if marker.as_ref().is_some_and(|info| !info.is_file()) {
            return Ok(metadata.clone());
        }
        // A missing folder is found through the repository's registrations. A `.git` file a cut-off write left pointing
        // nowhere is passed over the same way; one that cannot be read, or points at a folder that is there, is followed.
        let registration = (|| -> Result<Option<PathBuf>, String> {
            let target = if marker.is_some() { pointer_target(path).map_err(|e| e.to_string())? } else { None };
            if let Some(target) = target {
                if there(&target)? {
                    return Ok(Some(target));
                }
            }
            Ok(git_directories(repository_root).ok().flatten().and_then(|found| registration_of(&found.common_dir, path)))
        })();
        let Ok(registration) = registration else {
            return Ok(metadata.clone());
        };
        let reason = registration.as_ref().and_then(|r| fs::read_to_string(r.join("locked")).ok()).map(|reason| reason.trim().to_string());
        if reason.as_deref() != Some(REMOVING_LOCK_REASON) && reason.as_deref() != Some(REPAIRING_LOCK_REASON) {
            return Ok(if folder.is_none() && registration.is_none() { after_removal() } else { metadata.clone() });
        }
    }
    let Ok(identity) = registry_identity(repository_root) else {
        return Ok(metadata.clone());
    };
    let place = text(path);
    let settle = coordinate_registry(&identity, || -> Result<Option<Settle>, String> {
        let listing = git(repository_root, &["worktree", "list", "--porcelain", "-z"])?;
        let Some(entry) = registered_worktrees(&listing).into_iter().find(|item| path_key(Path::new(&item.path)) == path_key(path)) else {
            return Ok(None);
        };
        let removing = entry.locked && entry.lock_reason.as_deref() == Some(REMOVING_LOCK_REASON);
        let repairing = entry.locked && entry.lock_reason.as_deref() == Some(REPAIRING_LOCK_REASON);
        if repairing && folder.is_none() {
            // A folder that went while it was being repaired is a missing folder, which restore puts back.
            git(repository_root, &["worktree", "unlock", "--", &place]).map_err(|_| repair_failed())?;
            return Ok(None);
        }
        // A missing folder Git still registers, and not for Sotto's removal, is one restore already puts back.
        if !removing && !repairing && (folder.is_none() || marker.is_some() || entry.locked || !entry.prunable) {
            return Ok(None);
        }
        if folder.is_some() {
            let real = realpath(path).map_err(|e| e.to_string())?;
            if path_key(&real) != path_key(path) {
                return Err("The worktree’s folder now leads to another folder through a link, so nothing was removed. Put the original folder back where Sotto made it, then choose Refresh.".into());
            }
        }
        let registration = registration_of(Path::new(&identity.common), path);
        // Git removes and reads a worktree only through its `.git` file. Write it back, pointing at the registration Git
        // kept, when it is gone or, under Sotto's own lock, when a write cut off left it pointing nowhere. One that points
        // at another registration is not Sotto's to change.
        let write_pointer = || -> Result<(), String> {
            let registration = registration.as_ref().ok_or("Git kept no registration for this folder.")?;
            let target = if marker.is_some() { pointer_target(path).map_err(|e| e.to_string())? } else { None };
            if let Some(target) = target {
                if there(&target)? {
                    if path_key(&realpath(&target).map_err(|e| e.to_string())?) != path_key(&realpath(registration).map_err(|e| e.to_string())?) {
                        return Err("The folder’s .git file points at another registration.".into());
                    }
                    return Ok(());
                }
            }
            // Git marks `.git` hidden on Windows, and Windows will not overwrite a hidden file, so one pointing nowhere goes first.
            if marker.is_some() {
                match fs::remove_file(path.join(".git")) {
                    Err(error) if !not_found(&error) => return Err(error.to_string()),
                    _ => {}
                }
            }
            let named = if cfg!(windows) { text(registration).replace('\\', "/") } else { text(registration) };
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path.join(".git")).map_err(|e| e.to_string())?;
            file.write_all(format!("gitdir: {named}\n").as_bytes()).map_err(|e| e.to_string())
        };
        if !removing {
            // Nothing records that this removal was decided, so nothing more is deleted. Git's lock records the repair
            // until it is done, so a repair cut off is taken up again rather than mistaken for a whole checkout.
            let locked = if repairing { Ok(String::new()) } else { git(repository_root, &["worktree", "lock", "--reason", REPAIRING_LOCK_REASON, "--", &place]) };
            locked.and_then(|_| write_pointer()).map_err(|_| repair_failed())?;
            return Ok(Some(Settle::Repair));
        }
        // A detached folder is finished only while a branch or remote branch has its commit. Until then Git's
        // registration, which Sotto's lock keeps, holds the commit, and nothing more is removed.
        let detached_head = if entry.detached { entry.head.clone() } else { None };
        if let Some(head) = &detached_head {
            if !on_a_branch(repository_root, head)? {
                return Err(format!("Sotto started removing this worktree’s folder, which has no branch checked out, and no branch or remote branch has its commit {} any more. Nothing more was removed. Create a branch at that commit, then choose Refresh to finish removing the folder.", short(head)));
            }
        }
        if folder.is_some() {
            write_pointer().map_err(|_| unfinished_removal(&RemovalError::Other))?;
        }
        let record: Option<Value> = registration.as_ref().and_then(|r| fs::read_to_string(r.join(REMOVAL_RECORD)).ok()).and_then(|text| serde_json::from_str(&text).ok());
        let nested = record
            .as_ref()
            .and_then(|record| record.get("nestedWorktrees"))
            .and_then(Value::as_array)
            .map(|listed| {
                listed
                    .iter()
                    .filter_map(|item| Some(NestedWorktree { path: item.get("path")?.as_str()?.to_string(), common_directory: item.get("commonDirectory")?.as_str()?.to_string() }))
                    .collect()
            })
            .unwrap_or_default();
        let branch = entry.branch.as_deref().and_then(|b| b.strip_prefix("refs/heads/")).map(ToString::to_string);
        Ok(Some(Settle::Finish { branch, detached_head, nested }))
    })?;
    match settle {
        None => Ok(after_removal()),
        Some(Settle::Repair) => {
            put_back_missing_files(path)
                .and_then(|()| registry(repository_root, &["worktree", "unlock", "--", &place], Some(&identity)).map(drop).map_err(RemovalError::from))
                .map_err(|cause| unfinished_repair(&cause))?;
            Ok(metadata.clone())
        }
        Some(Settle::Finish { branch, detached_head, nested }) => {
            remove_locked(repository_root, path, &identity, &nested, REMOVAL_STALL).map_err(|cause| unfinished_removal(&cause))?;
            // A detached folder is reclaimed on the commit Git still records for it, whatever branch an older record names.
            let branch = if detached_head.is_some() { None } else { branch.or_else(|| metadata.branch.clone()) };
            Ok(reclaimed_record(metadata, branch, detached_head))
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Putting a folder back.

/// Puts back a checkout Sotto made and then lost, on the branch it recorded (ADR-0014), or, for a folder reclaimed on a
/// detached HEAD, on the commit it recorded, detached (ADR-0041), as Node's `restore`. A removal that stopped partway is
/// settled first. Best effort: a folder that is still there with anything in it, a thread with neither a branch nor such a
/// commit, and a branch that no longer exists all come back unchanged, so the caller reports the real problem. An empty
/// folder Git no longer registers is filled like a missing one. Never resets a branch, never removes a checkout, and never
/// takes a branch another folder has.
pub(super) fn restore(data_directory: &Path, recorded: &AgentThreadWorktree) -> Result<AgentThreadWorktree, String> {
    if recorded.mode != "independent" || recorded.path.is_none() || recorded.repository_root.is_none() {
        return Ok(recorded.clone());
    }
    let metadata = resume_removal(data_directory, recorded)?;
    let (Some(path), Some(repository_root)) = (metadata.path.clone().map(PathBuf::from), metadata.repository_root.clone().map(PathBuf::from)) else {
        return Ok(metadata);
    };
    let branch = metadata.branch.clone();
    let commit = if branch.is_some() { None } else { metadata.extra.get("detachedCommit").and_then(Value::as_str).filter(|c| commit_id(c)).map(ToString::to_string) };
    // What the folder is put back on: its branch's ref, or its commit.
    let checkout = match (&branch, &commit) {
        (Some(branch), _) => format!("refs/heads/{branch}"),
        (None, Some(commit)) => commit.clone(),
        (None, None) => return Ok(metadata),
    };
    // Anything at the path but nothing or an empty real folder, a link or junction included, is not Sotto's to fill.
    let folder = reserved_folder(&path)?;
    if folder == Reserved::Occupied {
        return Ok(metadata);
    }
    // Sotto's own data folder and the repository have to be there before anything is put back.
    let Ok(allocation_root) = realpath(data_directory).map(|real| real.join(THREAD_WORKTREE_FOLDER)) else {
        return Ok(metadata);
    };
    if existing_working_directory(&repository_root).is_err() || !reserved_place(&path, &allocation_root) {
        return Ok(metadata);
    }
    let verify = if branch.is_some() { checkout.clone() } else { format!("{checkout}^{{commit}}") };
    let identity = match registry_identity_verifying(&repository_root, &verify) {
        Ok(identity) => identity,
        // A commit the repository no longer has cannot come back, which a send says rather than that the folder is missing.
        Err(_) if branch.is_none() && registry_identity(&repository_root).is_ok() => return Err(detached_commit_gone(&checkout)),
        Err(_) => return Ok(metadata),
    };
    let listing = || registry(&repository_root, &["worktree", "list", "--porcelain", "-z"], Some(&identity)).map(|listing| registered_worktrees(&listing));
    let registered = |entries: &[Registered]| entries.iter().any(|entry| path_key(Path::new(&entry.path)) == path_key(&path));
    let refuse_another_folder = || -> Result<Vec<Registered>, String> {
        let entries = listing()?;
        // A branch is checked out in one folder at a time; a commit can be checked out detached in any number of them.
        if let Some(branch) = &branch {
            if let Some(occupant) = entries.iter().find(|entry| entry.branch.as_deref() == Some(checkout.as_str()) && path_key(Path::new(&entry.path)) != path_key(&path)) {
                return Err(format!("The branch {branch} is checked out in {}, so this thread’s folder cannot be put back on it. Nothing was lost or changed. Close that folder’s checkout or move it to another branch, then retry.", occupant.path));
            }
        }
        Ok(entries)
    };
    // An empty folder Git still registers is a checkout Git knows about, not a half-finished removal.
    if folder == Reserved::Empty && registered(&listing()?) {
        return Ok(metadata);
    }
    let place = text(&path);
    // Remove only this missing folder's registration. Other missing checkouts may be on unplugged drives.
    if registered(&refuse_another_folder()?) {
        coordinate_registry(&identity, || git_until(&repository_root, &["worktree", "remove", "--", &place], None))?;
    }
    refuse_another_folder()?;
    fs::create_dir_all(&allocation_root).map_err(|e| e.to_string())?;
    if path_key(&realpath(&allocation_root).map_err(|e| e.to_string())?) != path_key(&allocation_root) {
        return Err("The reserved worktree parent folder was redirected. Nothing was changed.".into());
    }
    // No -b and no -B: the recorded branch is checked out as it stands, with its commits; a detached folder gets its commit.
    let args: Vec<&str> = match &branch {
        Some(branch) => vec!["worktree", "add", "--", &place, branch],
        None => vec!["worktree", "add", "--detach", "--", &place, &checkout],
    };
    if let Err(words) = add_worktree(&repository_root, &path, &checkout, &args, &identity) {
        let lost = match &branch {
            Some(branch) => format!("{branch}. Nothing was lost; the branch still has its commits."),
            None => format!("commit {}. Nothing was lost; the repository still has that commit.", short(&checkout)),
        };
        return Err(format!("This thread’s working folder was missing and Sotto could not put it back on {lost} {words}").trim().to_string());
    }
    finished_removals().remove(&path_key(&path));
    let mut record = metadata;
    record.status = "ready".into();
    record.error = None;
    record.extra.remove("reclaimedAt");
    record.extra.remove("detachedCommit");
    Ok(record)
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a working copy.

/// What a shared folder's inspection reads, as Node's `inspectSharedFolder`: no repository, or its root, its branch and
/// whether anything in it is uncommitted.
fn inspect_shared_folder(metadata: &AgentThreadWorktree, folder: &str) -> Result<AgentThreadWorktree, String> {
    let path = existing_working_directory(Path::new(folder)).map_err(|refused| refused.words)?;
    let no_repository = || {
        let mut record = metadata.clone();
        record.branch = None;
        record.status = "ready".into();
        record.error = None;
        record.extra.insert("dirty".into(), Value::Bool(false));
        record
    };
    // No `.git` on disk at or above the folder: Git would only refuse, so it is not asked.
    if repository_on_disk(&path) == Some(None) {
        return Ok(no_repository());
    }
    let root = match git(&path, &["rev-parse", "--show-toplevel"]) {
        Ok(root) => root.trim().to_string(),
        Err(words) if words.contains("not a git repository") || words.contains("Git is unavailable") => return Ok(no_repository()),
        Err(words) => return Err(words),
    };
    let branch = git(&path, &["branch", "--show-current"])?.trim().to_string();
    let dirty = !git(&path, &["status", "--porcelain", "--untracked-files=normal"])?.is_empty();
    let mut record = metadata.clone();
    record.repository_root = Some(root);
    record.branch = (!branch.is_empty()).then_some(branch);
    record.status = "ready".into();
    record.error = None;
    record.extra.insert("dirty".into(), Value::Bool(dirty));
    Ok(record)
}

/// What Git reads of a working copy, as Node's `inspect`: for a shared folder its repository, branch and uncommitted
/// changes; for a worktree, that it is still the checkout the record names, and the branch it has checked out, which the
/// thread follows (ADR-0014). Inspection never creates a replacement for a deleted checkout. A folder that is there was not
/// reclaimed, whatever the record last said.
pub fn inspect(metadata: &AgentThreadWorktree) -> Result<AgentThreadWorktree, String> {
    inspect_with_identity(metadata).map(|(record, _)| record)
}

fn inspect_with_identity(metadata: &AgentThreadWorktree) -> Result<(AgentThreadWorktree, Option<RegistryIdentity>), String> {
    let path = metadata.path.as_deref().ok_or("The working folder is not allocated. Retry setup.")?;
    if metadata.mode == "shared" {
        return inspect_shared_folder(metadata, path).map(|record| (record, None));
    }
    let (branch, dirty, identity) = inspect_within(metadata, None, None, false)?;
    Ok((confirmed(with_checked_out_branch(metadata, branch), dirty), Some(identity)))
}

/// Whether Restore branch may name `branch` to Git, as Node's pattern for it: nothing that could read as an option or a path.
fn restorable_branch_name(branch: &str) -> bool {
    // JavaScript's `\s`: Unicode's white space without NEL, and the byte order mark.
    let space = |c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}';
    !branch.is_empty() && !branch.starts_with('-') && !branch.contains("..") && !branch.chars().any(|c| space(c) || matches!(c, ':' | '?' | '*' | '~' | '^' | '[' | ']' | '\\'))
}

/// Switches a working copy back to `branch`, which the user asked for by hand, as Node's `switchBranch`: the folder is
/// verified first, the branch must already exist, and uncommitted work is left where it is for Git to carry across or refuse.
fn switch_branch(metadata: &AgentThreadWorktree, branch: &str) -> Result<AgentThreadWorktree, String> {
    if !restorable_branch_name(branch) {
        return Err("That branch name cannot be restored. Switch it in the folder itself.".into());
    }
    let (inspected, identity) = inspect_with_identity(metadata)?;
    if inspected.branch.as_deref() == Some(branch) {
        return Ok(inspected);
    }
    let path = PathBuf::from(inspected.path.clone().unwrap_or_default());
    let reference = format!("refs/heads/{branch}");
    let gone = || format!("The branch {branch} no longer exists in this repository. Nothing was changed.");
    let identity = match identity {
        Some(identity) => git(&path, &["rev-parse", "--verify", &reference]).map(|_| identity).map_err(|_| gone())?,
        None => registry_identity_verifying(&path, &reference).map_err(|_| gone())?,
    };
    // --no-guess never creates a branch from a remote; a conflicting change makes Git refuse and nothing moves.
    registry(&path, &["switch", "--no-guess", branch], Some(&identity))?;
    inspect(&inspected)
}

/// The record a thread's working copy has once its folder is put back and read, as Node's `threadWorkingDirectory`, which
/// a send and a Git action run first: a ready or failed worktree is put back on its recorded branch and inspected; one
/// that cannot be put back keeps a ready record's failure as the answer, and a record that is still not ready answers
/// with its own error, as Node's `resolveThreadWorkingDirectory` does: nothing works in a folder Git will not confirm.
/// `None` when nothing in the record changed.
fn thread_working_directory(data_directory: &Path, metadata: &AgentThreadWorktree) -> Result<Option<AgentThreadWorktree>, String> {
    let mut changed = None;
    if metadata.path.is_some() && (metadata.status == "ready" || metadata.status == "error") {
        match restore(data_directory, metadata).and_then(|restored| inspect(&restored)) {
            Ok(inspected) => changed = (inspected != *metadata).then_some(inspected),
            Err(words) if metadata.status == "ready" => return Err(words),
            Err(_) => {}
        }
    }
    let current = changed.as_ref().unwrap_or(metadata);
    if current.status != "ready" {
        return Err(current.error.clone().unwrap_or_else(|| "This thread’s working folder is not ready. Retry working-copy setup.".into()));
    }
    if let Some(path) = current.path.as_deref() {
        existing_working_directory(Path::new(path)).map_err(|refused| refused.words)?;
    }
    Ok(changed)
}

/// The record a send's prompt goes out with, or why it may not go, as Node's `sendWorkingDirectory` and `recordSentBranch`:
/// never into a deleted, reclaimed or failed working copy, which is put back and inspected first (ADR-0014), and a branch
/// switched inside the folder is adopted. A ready folder that is there is read from its own files, starting no Git process
/// before the prompt (#766). The branch the send goes to is recorded as the one Restore branch goes back to. `None` when
/// the record stays as it is. `before_git` runs first when Git has to be asked, which may put the folder back or finish
/// its removal.
pub fn send_working_copy(data_directory: &Path, metadata: &AgentThreadWorktree, before_git: impl FnOnce()) -> Result<Option<AgentThreadWorktree>, String> {
    let read = match branch_on_disk(metadata) {
        Some(branch) => (branch != metadata.branch).then(|| with_checked_out_branch(metadata, branch)),
        None => {
            before_git();
            thread_working_directory(data_directory, metadata)?
        }
    };
    let record = read.clone().unwrap_or_else(|| metadata.clone());
    if record.status != "ready" || sent_branch(&record) == record.branch {
        return Ok(read);
    }
    let branch = record.branch.clone();
    Ok(Some(with_sent_branch(record, branch)))
}

/// What Refresh or Retry reads of a thread's working copy with a folder, as Node's `updateThreadWorktree`: a folder that
/// was deleted is put back before it is read, so a refresh never turns a missing folder into an error the next send would
/// refuse to repair (ADR-0014); a removal Sotto started and did not finish is finished, and like any reclaimed folder only
/// a send puts it back; a reclaimed folder is only read again, in case it came back. What cannot be read is the record's
/// error.
pub fn read_working_copy(data_directory: &Path, metadata: &AgentThreadWorktree) -> AgentThreadWorktree {
    if metadata.reclaimed() {
        return inspect(metadata).unwrap_or_else(|_| metadata.clone());
    }
    let read = resume_removal(data_directory, metadata).and_then(|resumed| if resumed.reclaimed() { Ok(resumed) } else { restore(data_directory, &resumed).and_then(|restored| inspect(&restored)) });
    read.unwrap_or_else(|words| {
        let mut record = metadata.clone();
        record.status = "error".into();
        record.error = Some(words);
        record
    })
}

/// Switches a thread's project checkout back to the branch of its last send, because the user pressed Restore branch, as
/// Node's `restoreThreadBranch`. `with_uncommitted_changes` is their answer to the confirmation; without it a folder with
/// uncommitted work on another branch is left exactly as it is. A refusal carries the record to keep when it read one.
pub fn restore_thread_branch(data_directory: &Path, metadata: &AgentThreadWorktree, with_uncommitted_changes: bool) -> Result<AgentThreadWorktree, (String, Option<Box<AgentThreadWorktree>>)> {
    let read = thread_working_directory(data_directory, metadata).map_err(|words| (words, None))?;
    let worktree = read.clone().unwrap_or_else(|| metadata.clone());
    let refused = |words: String| (words, read.clone().map(Box::new));
    if worktree.mode != "shared" || worktree.status != "ready" {
        return Err(refused(NO_CHECKOUT_TO_SWITCH.into()));
    }
    let Some(target) = sent_branch(&worktree) else {
        return Err(refused(NOTHING_SENT_YET.into()));
    };
    let inspected = inspect(&worktree).map_err(refused)?;
    if dirty(&inspected) && !with_uncommitted_changes && inspected.branch.as_deref() != Some(target.as_str()) {
        return Err((RESTORE_BRANCH_NEEDS_CONFIRMATION.into(), Some(Box::new(with_sent_branch(inspected, Some(target))))));
    }
    let switched = switch_branch(&inspected, &target).map_err(refused)?;
    Ok(with_sent_branch(switched, Some(target)))
}

#[cfg(test)]
mod tests;
