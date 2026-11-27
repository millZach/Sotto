//! Removing a thread's own worktree folder and nothing else (ADR-0041), as Node's host does it: what the folder holds
//! (`reclaimFacts` in `src/main/agents/threadWorktrees.ts`), every check before anything goes (`reclaim`, `inspectWithin`),
//! the removal under Git's lock (`removeLocked`, `removeFolderContents` in `folderRemoval.ts`), and the workspace's own
//! question of whether another thread works in the folder (`checkoutIsUnreferenced` in `workspace.ts`). The branch keeps
//! its commits and the thread keeps its record. The words are Node's, since a client shows them.
//!
//! Everything here blocks on Git and the file system, so the coordinator runs it off its own thread, in the thread's lane.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::ops::run_worktree_git;
use crate::workspace::{now_iso, AgentThreadWorktree};

/// Node's `RECLAIM_WORKTREE_NEEDS_CONFIRMATION` (`src/shared/agents.ts`).
pub const RECLAIM_WORKTREE_NEEDS_CONFIRMATION: &str = "This folder has uncommitted changes. Removing it loses them, so confirm it first.";
/// The lock reason Sotto gives Git while it removes a worktree (#1297), as Node's `REMOVING_LOCK_REASON`.
pub const REMOVING_LOCK_REASON: &str = "Sotto is removing this folder";
/// The lock reason while Sotto repairs a folder a removal left half done, as Node's `REPAIRING_LOCK_REASON`.
pub const REPAIRING_LOCK_REASON: &str = "Sotto is repairing this folder";
/// Kept beside Git's lock while Sotto removes a folder: the nested worktrees whose registrations go too.
const REMOVAL_RECORD: &str = "sotto-removal.json";
/// Where a thread's worktrees live under the data folder, as Node's `THREAD_WORKTREE_HOME`.
const THREAD_WORKTREE_FOLDER: &str = "thread-worktrees";
const DETACHED_NEEDS_BRANCH: &str = "This folder has no branch checked out, so it goes only under a cleanup rule or when its thread is cleared. Switch it to a branch to remove it now. Nothing was changed.";
const HALF_REMOVED: &str = "Sotto started removing this worktree’s folder and did not finish, so Git cannot use it. Nothing committed is lost. Choose Refresh to finish removing it; sending to the thread then puts it back on its branch or commit.";
const PARTLY_REMOVED: &str = "This worktree’s folder was only partly removed, so Git cannot use it. Nothing committed is lost. Choose Refresh to put its missing files back from Git, then reinstall its dependencies if it had any.";
const CHANGED_DURING_WALK: &str = "The files changed while Sotto was checking them. Nothing was removed. Choose Remove worktree again to review them.";
const FILES_CHANGED: &str = "The files changed. Nothing was removed. Choose Remove worktree again to review them.";
/// How long a removal may go without deleting anything before it stops, as Node's `REMOVAL_STALL_MS`.
const REMOVAL_STALL: Duration = Duration::from_secs(120);
/// Past this many commits fetched by hash, FETCH_HEAD is left out, as Node's `FETCHED_BY_HASH_MAX`.
const FETCHED_BY_HASH_MAX: usize = 64;

/// Of a submodule row's commits not on any remote, the ones FETCH_HEAD says were fetched by hash from `remote` (#687).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedByHash {
    pub remote: String,
    pub commit_count: u64,
}

/// A nested repository's or worktree's row in the removal question, as Node's `NestedRepositoryRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryRow {
    pub path: String,
    pub change_count: u64,
    pub unpushed_commit_count: Option<u64>,
    /// `worktree` or `repository`.
    pub kind: &'static str,
    pub fetched_by_hash: Option<FetchedByHash>,
}

/// An ignored item or folder in the removal question, with what it holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub path: String,
    pub bytes: u64,
    pub file_count: u64,
}

/// What reclaiming a worktree would touch, as Node's `WorktreeReclaimFacts`, so the caller can name it before asking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReclaimFacts {
    pub path: String,
    pub branch: Option<String>,
    pub dirty: bool,
    /// Ignored paths other than installed dependencies.
    pub ignored: Vec<String>,
    pub items: Vec<Item>,
    pub repositories: Vec<RepositoryRow>,
    pub untracked: Vec<String>,
    /// A link inside the folder that leads out of it.
    pub outside_link: Option<String>,
}

impl ReclaimFacts {
    /// The facts as Node's `worktreeReclaimPreview` carries them (`worktreeReclaimPreviewSchema`): a field Node leaves
    /// undefined is left out.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("path".into(), json!(self.path));
        if let Some(branch) = &self.branch {
            out.insert("branch".into(), json!(branch));
        }
        out.insert("dirty".into(), json!(self.dirty));
        out.insert("ignored".into(), json!(self.ignored));
        out.insert("items".into(), self.items.iter().map(|i| json!({ "path": i.path, "bytes": i.bytes, "fileCount": i.file_count })).collect());
        out.insert("repositories".into(), self.repositories.iter().map(repository_json).collect());
        out.insert("untracked".into(), json!(self.untracked));
        if let Some(link) = &self.outside_link {
            out.insert("outsideLink".into(), json!(link));
        }
        Value::Object(out)
    }
}

fn repository_json(row: &RepositoryRow) -> Value {
    let mut out = Map::new();
    out.insert("path".into(), json!(row.path));
    out.insert("changeCount".into(), json!(row.change_count));
    if let Some(count) = row.unpushed_commit_count {
        out.insert("unpushedCommitCount".into(), json!(count));
    }
    out.insert("kind".into(), json!(row.kind));
    if let Some(fetched) = &row.fetched_by_hash {
        out.insert("fetchedByHash".into(), json!({ "remote": fetched.remote, "commitCount": fetched.commit_count }));
    }
    Value::Object(out)
}

/// The user's confirmations for a removal they asked for, as Node's `WorktreeReclaimOptions` for Remove worktree and
/// Delete thread…. A rule acting on its own (`automatic`) is not ported: see `reclaim`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReclaimOptions {
    pub confirmed_ignored: Option<Vec<String>>,
    pub confirmed_items: Option<Vec<(String, u64)>>,
    pub confirmed_repositories: Option<Vec<RepositoryRow>>,
    pub with_uncommitted_changes: bool,
}

fn whole(value: Option<&Value>) -> Option<u64> {
    crate::protocol_fields::whole_number(value?)
}

impl ReclaimOptions {
    /// The confirmations of a `reclaim-thread-worktree` or `delete-thread` command already read as Node's schema reads it
    /// (`delete_command_shape`, `reclaim_command_shape`), as Node's `confirmedWorktreeFiles` passes them on.
    pub fn from_command(command: &Map<String, Value>) -> Self {
        let list = |key: &str| command.get(key).and_then(Value::as_array);
        ReclaimOptions {
            confirmed_ignored: list("confirmedIgnored").map(|items| items.iter().filter_map(Value::as_str).map(ToString::to_string).collect()),
            confirmed_items: list("confirmedItems").map(|items| {
                items.iter().filter_map(|item| Some((item.get("path")?.as_str()?.to_string(), whole(item.get("fileCount"))?))).collect()
            }),
            confirmed_repositories: list("confirmedRepositories").map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        Some(RepositoryRow {
                            path: item.get("path")?.as_str()?.to_string(),
                            change_count: whole(item.get("changeCount"))?,
                            unpushed_commit_count: item.get("unpushedCommitCount").and_then(|n| whole(Some(n))),
                            kind: match item.get("kind")?.as_str()? {
                                "worktree" => "worktree",
                                _ => "repository",
                            },
                            fetched_by_hash: item.get("fetchedByHash").and_then(|f| {
                                Some(FetchedByHash { remote: f.get("remote")?.as_str()?.to_string(), commit_count: whole(f.get("commitCount"))? })
                            }),
                        })
                    })
                    .collect()
            }),
            with_uncommitted_changes: command.get("withUncommittedChanges") == Some(&Value::Bool(true)),
        }
    }
}

/// Whether a `preview-reclaim-thread-worktree` or `reclaim-thread-worktree` command is one Node's strict command schema
/// reads (`agentCommandSchema` in `src/shared/agents.ts`): only its own fields, a thread ID, `afterSettle` only as true,
/// `withUncommittedChanges` a boolean, and the confirmations as Delete thread… limits them.
pub fn reclaim_command_shape(command: &Map<String, Value>) -> bool {
    match command.get("type").and_then(Value::as_str) {
        Some("preview-reclaim-thread-worktree") => {
            crate::thread_clearing::delete_command_shape(&with_type(command, "preview-delete-thread"))
        }
        Some("reclaim-thread-worktree") => {
            if command.get("afterSettle").is_some_and(|v| v != &Value::Bool(true)) || command.get("withUncommittedChanges").is_some_and(|v| !v.is_boolean()) {
                return false;
            }
            let mut rest = with_type(command, "delete-thread");
            rest.remove("afterSettle");
            rest.remove("withUncommittedChanges");
            crate::thread_clearing::delete_command_shape(&rest)
        }
        _ => false,
    }
}

fn with_type(command: &Map<String, Value>, kind: &str) -> Map<String, Value> {
    let mut copy = command.clone();
    copy.insert("type".into(), Value::String(kind.into()));
    copy
}

// ---------------------------------------------------------------------------------------------------------------------
// Paths, as Node's `path` and `fs.realpath` read them.

/// `path.resolve`: absolute, with `.` and `..` taken out and the platform's separators.
fn resolve(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(path) };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(name) => out.push(name),
        }
    }
    out
}

/// Node's `pathKey`: the resolved path, folded to lower case on Windows.
fn path_key(path: &Path) -> String {
    let key = resolve(path).to_string_lossy().into_owned();
    if cfg!(windows) {
        key.to_lowercase()
    } else {
        key
    }
}

/// `fs.realpath`, which names a Windows path without the `\\?\` that Rust's own gives it.
fn realpath(path: &Path) -> io::Result<PathBuf> {
    fs::canonicalize(path).map(without_verbatim)
}

/// A Windows path without the `\\?\` in front, as Node names one.
fn without_verbatim(real: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = real.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    real
}

/// Node's `relative(from, to)`, with `/` between its parts: the way up and down from one folder to another, or `to`
/// itself when the two share no root.
fn relative(from: &Path, to: &Path) -> String {
    let parts = |path: &Path| -> Vec<String> { resolve(path).components().map(|part| part.as_os_str().to_string_lossy().into_owned()).collect() };
    let (from, to) = (parts(from), parts(to));
    let same = |a: &String, b: &String| if cfg!(windows) { a.to_lowercase() == b.to_lowercase() } else { a == b };
    let common = from.iter().zip(&to).take_while(|(a, b)| same(a, b)).count();
    if common == 0 {
        return to.join("/");
    }
    let mut out: Vec<String> = vec!["..".to_string(); from.len() - common];
    out.extend(to[common..].iter().cloned());
    out.join("/")
}

/// Whether `other` is `root` or inside it, as Node's `relative(root, other)` that is neither absolute nor leads up.
fn inside(root: &Path, other: &Path) -> bool {
    let (root, other) = (path_key(root), path_key(other));
    if root == other {
        return true;
    }
    let separator = std::path::MAIN_SEPARATOR;
    let prefix = if root.ends_with(separator) { root } else { format!("{root}{separator}") };
    other.starts_with(&prefix)
}

/// `relative(root, path)` for a path inside `root`, with `/` between its parts; `None` for one outside.
fn relative_inside(root: &Path, path: &Path) -> Option<String> {
    let (root, path) = (resolve(root), resolve(path));
    if !inside(&root, &path) {
        return None;
    }
    let count = root.components().count();
    Some(path.components().skip(count).map(|part| part.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"))
}

/// The parent folder, as Node's `dirname`.
fn dirname(path: &Path) -> PathBuf {
    resolve(path).parent().map(Path::to_path_buf).unwrap_or_else(|| resolve(path))
}

fn not_found(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound || error.kind() == io::ErrorKind::NotADirectory
}

/// What an entry is, as Node's `entryKind`: a junction is a link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    Directory,
    Link,
    Other,
    None,
}

fn kind_of(file_type: fs::FileType) -> Kind {
    if file_type.is_symlink() {
        Kind::Link
    } else if file_type.is_dir() {
        Kind::Directory
    } else if file_type.is_file() {
        Kind::File
    } else {
        Kind::Other
    }
}

/// `lstat`, with nothing there read as `None`.
fn present(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(Some(meta)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn present_kind(path: &Path) -> Result<Kind, String> {
    Ok(present(path)?.map_or(Kind::None, |meta| kind_of(meta.file_type())))
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// JavaScript's default sort, which orders strings by their UTF-16 code units.
fn js_sort(list: &mut [String]) {
    list.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// Close to `String.prototype.localeCompare` under Node's root collation: punctuation before digits before letters,
/// letters compared without case first, and lower case before upper case when nothing else differs.
fn locale_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    const PUNCTUATION: &str = "\t\n\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    let weight = |c: char| -> u32 {
        if let Some(index) = PUNCTUATION.find(c) {
            index as u32
        } else if c.is_ascii_digit() {
            100 + c as u32
        } else if c.is_ascii_alphabetic() {
            200 + c.to_ascii_lowercase() as u32
        } else {
            1000 + c.to_lowercase().next().unwrap_or(c) as u32
        }
    };
    a.chars()
        .map(weight)
        .cmp(b.chars().map(weight))
        .then_with(|| a.chars().map(|c| c.is_uppercase()).cmp(b.chars().map(|c| c.is_uppercase())))
        .then_with(|| a.cmp(b))
}

// ---------------------------------------------------------------------------------------------------------------------
// Git, through the helper the rest of the host uses.

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    run_worktree_git(&text(cwd), args, Some(Duration::from_secs(30)))
}

/// One repository's registry, as Node's `RegistryIdentity`: its common Git directory and that directory's key.
#[derive(Debug, Clone)]
struct RegistryIdentity {
    common: String,
    key: String,
}

fn registry_identity(cwd: &Path) -> Result<RegistryIdentity, String> {
    let common = git(cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?.trim().to_string();
    let key = path_key(&realpath(Path::new(&common)).map_err(|e| e.to_string())?);
    Ok(RegistryIdentity { common, key })
}

/// Operations that take turns, by key, as Node's `takeTurns`: Git's registry of one repository (`coordinateRegistry`), and
/// the removals of one reserved folder (`removalTurn`).
fn take_turns<T>(lanes: &'static Lanes, key: &str, run: impl FnOnce() -> T) -> T {
    let lanes = lanes.get_or_init(Default::default);
    let lane = lanes.lock().unwrap_or_else(PoisonError::into_inner).entry(key.to_string()).or_default().clone();
    let result = {
        let _turn = lane.lock().unwrap_or_else(PoisonError::into_inner);
        run()
    };
    let mut map = lanes.lock().unwrap_or_else(PoisonError::into_inner);
    if map.get(key).is_some_and(|held| Arc::strong_count(held) == 2) {
        map.remove(key);
    }
    result
}

/// Each key's turn, taken while its operation runs.
type Lanes = OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>>;

static REGISTRY_OPERATIONS: Lanes = OnceLock::new();
static REMOVAL_OPERATIONS: Lanes = OnceLock::new();

fn coordinate_registry<T>(identity: &RegistryIdentity, run: impl FnOnce() -> T) -> T {
    take_turns(&REGISTRY_OPERATIONS, &identity.key, run)
}

/// Git in `cwd` in its repository's registry lane, as Node's `registry`.
fn registry(cwd: &Path, args: &[&str], identity: Option<&RegistryIdentity>) -> Result<String, String> {
    let identity = match identity {
        Some(identity) => identity.clone(),
        None => registry_identity(cwd)?,
    };
    coordinate_registry(&identity, || git(cwd, args))
}

/// One worktree Git lists, as Node's `registeredWorktrees` reads `git worktree list --porcelain -z`.
#[derive(Debug, Clone, Default)]
struct Registered {
    path: String,
    branch: Option<String>,
    head: Option<String>,
    detached: bool,
    locked: bool,
    lock_reason: Option<String>,
    prunable: bool,
}

fn registered_worktrees(output: &str) -> Vec<Registered> {
    output
        .split("\0\0")
        .filter(|record| !record.is_empty())
        .map(|record| {
            let fields: Vec<&str> = record.split('\0').collect();
            let after = |prefix: &str| fields.iter().find_map(|field| field.strip_prefix(prefix)).map(ToString::to_string);
            Registered {
                path: after("worktree ").unwrap_or_default(),
                branch: after("branch "),
                head: after("HEAD "),
                detached: fields.contains(&"detached"),
                locked: fields.iter().any(|field| *field == "locked" || field.starts_with("locked ")),
                lock_reason: after("locked "),
                prunable: fields.iter().any(|field| *field == "prunable" || field.starts_with("prunable ")),
            }
        })
        .collect()
}

/// A checkout's own Git directory, from the `.git` entry at its root, as Node's `gitDirectories` reads it.
fn git_directory(root: &Path) -> Option<PathBuf> {
    let marker = root.join(".git");
    let entry = fs::metadata(&marker).ok()?;
    if entry.is_dir() {
        return Some(marker);
    }
    if !entry.is_file() {
        return None;
    }
    let pointer = fs::read_to_string(&marker).ok()?;
    let target = pointer.trim().strip_prefix("gitdir: ")?.trim().to_string();
    Some(resolve(&root.join(target)))
}

/// The folder a `.git` file names, as Node reads one: `gitdir: ` taken off the front of its trimmed text.
fn pointed_directory(root: &Path) -> Result<PathBuf, String> {
    let pointer = fs::read_to_string(root.join(".git")).map_err(|e| e.to_string())?;
    let trimmed = pointer.trim();
    Ok(resolve(&root.join(trimmed.strip_prefix("gitdir: ").unwrap_or(trimmed))))
}

fn count(output: &str) -> Result<u64, String> {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return Ok(0);
    }
    trimmed.parse().map_err(|_| "Git could not finish this action.".to_string())
}

fn split_nul(output: &str) -> Vec<String> {
    output.split('\0').filter(|entry| !entry.is_empty()).map(ToString::to_string).collect()
}

/// Installed dependencies, which a removal never asks about, as Node's `DEPENDENCY_FOLDER`.
fn dependency_folder(entry: &str) -> bool {
    entry == "node_modules/" || entry.ends_with("/node_modules/")
}

// ---------------------------------------------------------------------------------------------------------------------
// The folder, as Node's `existingWorkingDirectory`, `workingDirectory` and `inspectWithin` check it.

/// Why a working folder cannot be used, and whether it is simply not there.
struct FolderRefused {
    words: String,
    missing: bool,
}

fn existing_working_directory(path: &Path) -> Result<PathBuf, FolderRefused> {
    if !path.is_absolute() {
        return Err(FolderRefused { words: "The working folder must be an absolute path.".into(), missing: false });
    }
    let canonical = realpath(path).map_err(|error| FolderRefused {
        missing: error.kind() == io::ErrorKind::NotFound,
        words: if error.kind() == io::ErrorKind::NotFound {
            format!("The folder {} is not there any more. Move it back, or add the project again from where it is now.", text(path))
        } else {
            error.to_string()
        },
    })?;
    match fs::metadata(&canonical) {
        Ok(meta) if meta.is_dir() => Ok(canonical),
        Ok(_) => Err(FolderRefused { words: "The working folder is not a directory.".into(), missing: false }),
        Err(error) => Err(FolderRefused { words: error.to_string(), missing: false }),
    }
}

fn working_directory(metadata: &AgentThreadWorktree) -> Result<PathBuf, String> {
    let path = metadata.path.as_deref().ok_or("The working folder is not allocated.")?;
    let root = existing_working_directory(Path::new(path)).map_err(|refused| refused.words)?;
    let relative = metadata.extra.get("projectRelativePath").and_then(Value::as_str).unwrap_or(".");
    let requested = resolve(&root.join(relative));
    if !inside(&root, &requested) {
        return Err("The project subdirectory is outside its allocated worktree.".into());
    }
    let directory = existing_working_directory(&requested).map_err(|refused| refused.words)?;
    if !inside(&root, &directory) {
        return Err("The project subdirectory was redirected outside its allocated worktree.".into());
    }
    Ok(directory)
}

/// What inspection reads of a worktree the walk is about to check, as Node's `inspectWithin` for a reclaim: that the folder
/// is the checkout the record names, one the original repository's registry lists and has not locked, with the branch
/// it has checked out and whether anything in it is uncommitted. `observed` is what was read inside the registry lane.
/// A reclaim counts a submodule's changes as uncommitted too (`reclaiming`); an ordinary inspection, as Node's `inspect`, does not.
fn inspect_within(metadata: &AgentThreadWorktree, identity: Option<RegistryIdentity>, observed: Option<(String, String)>, reclaiming: bool) -> Result<(Option<String>, bool, RegistryIdentity), String> {
    let recorded = metadata.path.as_deref().ok_or("The working folder is not allocated. Retry setup.")?;
    let path = existing_working_directory(Path::new(recorded)).map_err(|refused| refused.words)?;
    let repository_root = metadata.repository_root.as_deref().ok_or("The worktree binding is incomplete.")?;
    let identity = match identity {
        Some(identity) => identity,
        None => registry_identity(Path::new(repository_root))?,
    };
    let (root, common, listing) = match observed {
        Some((root, listing)) => (Ok(root), git(&path, &["rev-parse", "--path-format=absolute", "--git-common-dir"]), Ok(listing)),
        None => (
            git(&path, &["rev-parse", "--show-toplevel"]),
            git(&path, &["rev-parse", "--path-format=absolute", "--git-common-dir"]),
            registry(Path::new(repository_root), &["worktree", "list", "--porcelain", "-z"], Some(&identity)),
        ),
    };
    let entries = registered_worktrees(&listing?);
    let registered = entries.into_iter().find(|entry| path_key(Path::new(&entry.path)) == path_key(&path));
    if let Some(entry) = &registered {
        let reason = entry.lock_reason.as_deref();
        if reason == Some(REMOVING_LOCK_REASON) || reason == Some(REPAIRING_LOCK_REASON) || (entry.prunable && !entry.locked) {
            return Err(if metadata.reused == Some(true) {
                "This worktree’s folder was only partly removed, so Git cannot use it. Nothing on its branch was lost. Choose another working copy for this thread.".into()
            } else if reason == Some(REMOVING_LOCK_REASON) {
                HALF_REMOVED.into()
            } else {
                PARTLY_REMOVED.into()
            });
        }
        if entry.locked || entry.prunable {
            return Err("Git has locked this worktree or reports an incomplete checkout. Restore the checkout before continuing.".into());
        }
    }
    let Some(registered) = registered.filter(|_| path_key(&path) == path_key(Path::new(recorded))) else {
        return Err("The working folder is no longer this thread’s Git worktree. Restore its checkout before continuing.".into());
    };
    let branch = registered.branch.as_deref().and_then(|b| b.strip_prefix("refs/heads/")).map(ToString::to_string);
    let (root, common) = (root?, common?);
    if path_key(Path::new(root.trim())) != path_key(&path) || path_key(Path::new(common.trim())) != path_key(Path::new(&identity.common)) {
        return Err("The working folder no longer belongs to the original repository.".into());
    }
    working_directory(metadata)?;
    let status: &[&str] = if reclaiming { &["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"] } else { &["status", "--porcelain", "--untracked-files=normal"] };
    let dirty = !git(&path, status)?.is_empty();
    Ok((branch, dirty, identity))
}

// ---------------------------------------------------------------------------------------------------------------------
// The walk, as Node's `reclaimFactsWithin` makes it.

/// A nested worktree whose registration goes with the folder, as Node's `NestedWorktree`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct NestedWorktree {
    path: String,
    common_directory: String,
}

/// One walk of a worktree's folder. Node reads a folder's listing for an entry's type only while nothing has been
/// waited on since; here every entry is read with `lstat` at its turn, a directory immediately before it is listed, and
/// every folder with entries is listed again once they are done, which is that rule wherever anything was read.
struct Walk {
    path: PathBuf,
    root: PathBuf,
    canonical_root: PathBuf,
    ignored: Vec<String>,
    ignored_set: HashSet<String>,
    items: Vec<Item>,
    repositories: Vec<RepositoryRow>,
    inspected_submodule_directories: HashSet<String>,
    /// Each plain nested repository's row and Git directory, whose submodules' history is counted once the walk is done.
    nested_repositories: Vec<(usize, PathBuf)>,
    nested_worktrees: Vec<NestedWorktree>,
    outside_link: Option<String>,
}

struct Entry {
    name: std::ffi::OsString,
    listed: Kind,
}

struct Markers {
    git: Option<fs::Metadata>,
    bare_candidate: bool,
}

fn changed() -> String {
    CHANGED_DURING_WALK.into()
}

impl Walk {
    fn add_ignored(&mut self, entry: &str) -> bool {
        if self.ignored_set.contains(entry) {
            return false;
        }
        self.ignored.push(entry.to_string());
        self.ignored_set.insert(entry.to_string());
        true
    }

    fn list(&self, directory: &Path) -> Result<Vec<Entry>, String> {
        let at_root = path_key(directory) == path_key(&self.root);
        let mut entries = Vec::new();
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            // The worktree's own .git is its registration, not part of its contents.
            if at_root && entry.file_name() == ".git" {
                continue;
            }
            let listed = entry.file_type().map(kind_of).unwrap_or(Kind::Other);
            entries.push(Entry { name: entry.file_name(), listed });
        }
        Ok(entries)
    }

    /// Git in a folder of the walk, only where the folder really is the one the walk means.
    fn git(&self, cwd: &Path, args: &[&str]) -> Result<String, String> {
        let real = realpath(cwd).map_err(|e| e.to_string())?;
        let local = relative_inside(&self.root, cwd).ok_or_else(changed)?;
        let expected = if local.is_empty() { self.canonical_root.clone() } else { self.canonical_root.join(&local) };
        if path_key(&real) != path_key(&expected) {
            return Err(changed());
        }
        git(cwd, args)
    }

    /// Whether a remote's URL may lead to another copy of a submodule's commits: a network URL, or a path or `file://`
    /// URL that resolves outside the folder being removed and outside the submodule's own Git directory.
    fn remote_elsewhere(&self, url: &str, base: &Path, git_directory: &Path) -> bool {
        let file = url.len() >= 7 && url[..7].eq_ignore_ascii_case("file://");
        let colon = url.find(':');
        let slash = url.find(['\\', '/']);
        let drive = url.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) && url.as_bytes().get(1) == Some(&b':');
        // Git reads a URL with no colon, a slash before its first colon or a drive letter as a path.
        if !file && colon.is_some() && slash.is_none_or(|slash| Some(slash) > colon) && !drive {
            return true;
        }
        let target = if file { file_url_path(url) } else { Some(resolve(&base.join(url))) };
        let Some(place) = target.and_then(|target| realpath(&target).ok()) else {
            return false;
        };
        let own = realpath(git_directory).unwrap_or_else(|_| git_directory.to_path_buf());
        ![&self.canonical_root, &own].iter().any(|folder| inside(folder, &place))
    }

    fn markers(&self, full: &Path) -> Result<Markers, String> {
        let git = present(&full.join(".git"))?;
        let bare_candidate = git.is_none()
            && fs::symlink_metadata(full.join("HEAD")).is_ok_and(|m| m.is_file())
            && fs::symlink_metadata(full.join("objects")).is_ok_and(|m| m.is_dir());
        Ok(Markers { git, bare_candidate })
    }

    /// Walks one folder: every entry its listing names, and then the listing again, where an entry that has become
    /// something else refuses the walk and a new one is walked like the rest.
    fn visit(&mut self, directory: &Path, directory_local: &str, row: Option<usize>, git_metadata: bool, index_root: &Path) -> Result<(), String> {
        let child_prefix = if directory_local.is_empty() { String::new() } else { format!("{directory_local}/") };
        // The rows that hold this directory count every file directly in it.
        let enclosing: Vec<usize> = if child_prefix.is_empty() {
            Vec::new()
        } else {
            (0..self.items.len()).filter(|&i| self.items[i].path.ends_with('/') && child_prefix.starts_with(&self.items[i].path)).collect()
        };
        let first = self.list(directory)?;
        let mut seen: HashMap<std::ffi::OsString, Kind> = HashMap::new();
        for entry in &first {
            let used = self.visit_entry(directory, &child_prefix, &enclosing, row, git_metadata, index_root, entry)?;
            seen.insert(entry.name.clone(), used);
        }
        if first.is_empty() {
            return Ok(());
        }
        for entry in self.list(directory)? {
            match seen.get(&entry.name) {
                None => {
                    self.visit_entry(directory, &child_prefix, &enclosing, row, git_metadata, index_root, &entry)?;
                }
                Some(&used) => {
                    let now = present_kind(&directory.join(&entry.name))?;
                    if now != Kind::None && now != used {
                        return Err(changed());
                    }
                }
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn visit_entry(&mut self, directory: &Path, child_prefix: &str, enclosing: &[usize], row: Option<usize>, git_metadata: bool, index_root: &Path, entry: &Entry) -> Result<Kind, String> {
        let name = entry.name.to_string_lossy().into_owned();
        let full = directory.join(&entry.name);
        let local = format!("{child_prefix}{name}");
        let ignored_path = if self.ignored_set.contains(&local) {
            Some(local.clone())
        } else if self.ignored_set.contains(&format!("{local}/")) {
            Some(format!("{local}/"))
        } else {
            None
        };
        let summary = match ignored_path {
            Some(path) => {
                self.items.push(Item { path, bytes: 0, file_count: 0 });
                Some(self.items.len() - 1)
            }
            None => row,
        };
        let counted = summary.is_some() || enclosing.iter().any(|&i| Some(i) != summary);
        let info = match fs::symlink_metadata(&full) {
            Ok(meta) => Some(meta),
            // A plain file nothing counts that went since the listing is what Node never reads again.
            Err(error) if error.kind() == io::ErrorKind::NotFound && !counted && entry.listed == Kind::File => None,
            Err(error) => return Err(error.to_string()),
        };
        let kind = info.as_ref().map_or(entry.listed, |meta| kind_of(meta.file_type()));
        if kind == Kind::Link {
            let target = without_verbatim(fs::read_link(&full).map_err(|e| e.to_string())?);
            let target = resolve(&directory.join(target));
            let canonical = realpath(&target).unwrap_or(target);
            if !inside(&self.canonical_root, &canonical) && self.outside_link.is_none() {
                self.outside_link = Some(local.clone());
            }
        }
        if kind == Kind::Directory {
            // Dependencies need link inspection but never become rows. Inside Git metadata no marker is used.
            let markers = !git_metadata && name != ".git";
            let found = if markers { self.markers(&full)? } else { Markers { git: None, bare_candidate: false } };
            let bare = found.bare_candidate && self.git(&full, &["rev-parse", "--is-bare-repository"])?.trim() == "true";
            let git_marker_kind = found.git.as_ref().map_or(Kind::None, |m| kind_of(m.file_type()));
            if markers && (found.git.is_some() || bare) {
                self.nested_repository(&full, &local, index_root, &found, bare)?;
            }
            if found.git.is_some() || found.bare_candidate {
                // Git ran here, so the folder, its listing and its markers are read again before it is walked.
                if present_kind(&full)? != Kind::Directory {
                    return Err(changed());
                }
                let now = self.markers(&full)?;
                if now.git.as_ref().map_or(Kind::None, |m| kind_of(m.file_type())) != git_marker_kind || now.bare_candidate != found.bare_candidate {
                    return Err(changed());
                }
            }
            let next_index_root = if found.git.is_some() && markers { full.clone() } else { index_root.to_path_buf() };
            let next_row = if name == "node_modules" { None } else { summary };
            self.visit(&full, &local, next_row, git_metadata || name == ".git" || bare, &next_index_root)?;
        } else if counted {
            let size = info.as_ref().map_or(0, fs::Metadata::len);
            if let Some(i) = summary {
                self.items[i].bytes += size;
                self.items[i].file_count += 1;
            }
            // Nested repository rows can overlap an ignored parent row. Count their contents too.
            for &i in enclosing {
                if Some(i) != summary {
                    self.items[i].bytes += size;
                    self.items[i].file_count += 1;
                }
            }
        }
        Ok(kind)
    }

    /// A repository or worktree found inside the folder, and its row when it holds anything at risk.
    fn nested_repository(&mut self, full: &Path, local: &str, index_root: &Path, found: &Markers, bare: bool) -> Result<(), String> {
        let git_marker = found.git.as_ref();
        let marker_file = git_marker.is_some_and(fs::Metadata::is_file);
        let indexed_path = relative_inside(index_root, full).unwrap_or_default();
        let index_entry = self.git(index_root, &["--literal-pathspecs", "ls-files", "--stage", "-z", "--", &indexed_path])?;
        let submodule = index_entry.split('\0').any(|record| record.starts_with("160000 ") && record.find('\t').is_some_and(|tab| record[tab + 1..] == indexed_path));
        let status = if bare { String::new() } else { self.git(full, &["status", "--porcelain", "--untracked-files=all", "-z"])? };
        let ignored_module: Vec<String> = if submodule {
            split_nul(&self.git(full, &["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])?).into_iter().filter(|item| !dependency_folder(item)).collect()
        } else {
            Vec::new()
        };
        // A submodule's .git file points into metadata removed with the parent worktree.
        let kind = if !submodule && marker_file { "worktree" } else { "repository" };
        let unpushed = if kind == "repository" { Some(count(&self.git(full, &["rev-list", "--count", "--all", "--not", "--remotes"])?)?) } else { None };
        let fetched = match unpushed {
            Some(unpushed) if submodule && unpushed > 0 => {
                let run = |args: &[&str]| self.git(full, args);
                let elsewhere = |url: &str, git_directory: &Path| self.remote_elsewhere(url, full, git_directory);
                fetched_by_hash(&run, unpushed, &elsewhere)?
            }
            _ => None,
        };
        if submodule {
            let directory = if marker_file { pointed_directory(full)? } else { full.join(".git") };
            let real = realpath(&directory).map_err(|e| e.to_string())?;
            self.inspected_submodule_directories.insert(path_key(&real));
        }
        if !submodule && marker_file {
            let common_directory = self.git(full, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?.trim().to_string();
            // The registry Git named is read where it is, often outside the folder; listing it reads no status.
            let listing = git(Path::new(&common_directory), &["worktree", "list", "--porcelain", "-z"])?;
            let registration = registered_worktrees(&listing).into_iter().find(|item| path_key(Path::new(&item.path)) == path_key(full));
            if registration.is_some_and(|r| r.locked) {
                return Err("A nested worktree is locked. Nothing was removed. Unlock it in its own repository, then choose Remove worktree again.".into());
            }
            // A repository inside the removed folder loses its own registry with it.
            if !inside(&self.canonical_root, Path::new(&common_directory)) {
                self.nested_worktrees.push(NestedWorktree { path: text(full), common_directory });
            }
        }
        if !submodule || !status.is_empty() || !ignored_module.is_empty() || unpushed.is_some_and(|n| n > 0) {
            let records = split_nul(&status);
            // Porcelain -z gives a second path for renames, not a second change.
            let mut change_count = 0;
            let mut i = 0;
            while i < records.len() {
                change_count += 1;
                let bytes = records[i].as_bytes();
                if matches!(bytes.first(), Some(b'R' | b'C')) || matches!(bytes.get(1), Some(b'R' | b'C')) {
                    i += 1;
                }
                i += 1;
            }
            let repository_path = format!("{local}/");
            self.repositories.push(RepositoryRow { path: repository_path.clone(), change_count, unpushed_commit_count: unpushed, kind, fetched_by_hash: fetched });
            if !submodule && (bare || git_marker.is_some_and(fs::Metadata::is_dir)) {
                self.nested_repositories.push((self.repositories.len() - 1, if bare { full.to_path_buf() } else { full.join(".git") }));
            }
            if self.add_ignored(&repository_path) {
                self.items.push(Item { path: repository_path, bytes: 0, file_count: 0 });
            }
        }
        Ok(())
    }

    /// A nested repository's own submodules keep their history in its Git directory, and a deinitialized one keeps nothing
    /// else, so removal would delete it unseen (#687).
    fn retained_history(&self, directory: &Path) -> Result<u64, String> {
        if present_kind(directory)? != Kind::Directory {
            return Ok(0);
        }
        if present_kind(&directory.join("HEAD"))? == Kind::File {
            let real = realpath(directory).map_err(|e| e.to_string())?;
            let counted = self.inspected_submodule_directories.contains(&path_key(&real));
            let place = text(directory);
            // Recursive deinit keeps core.worktree pointing at a deleted checkout, so it is overridden.
            let own = if counted { 0 } else { count(&self.git(directory, &["--git-dir", &place, "--work-tree", &place, "rev-list", "--count", "--all", "--not", "--remotes"])?)? };
            return Ok(own + self.retained_history(&directory.join("modules"))?);
        }
        // A module name with slashes is a folder of folders before its metadata.
        let mut total = 0;
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                total += self.retained_history(&directory.join(entry.file_name()))?;
            }
        }
        Ok(total)
    }

    /// The worktree's own Git directory's submodule metadata, which force removal destroys with it, as Node's
    /// `retainedModules`.
    fn retained_modules(&mut self, directory: &Path, modules_directory: &Path, canonical_modules: &mut Option<PathBuf>, module_paths: &mut Option<HashMap<String, String>>) -> Result<(), String> {
        let Some(info) = present(directory)? else {
            return Ok(());
        };
        if info.file_type().is_symlink() {
            if self.outside_link.is_none() {
                self.outside_link = Some(".git/modules/".into());
            }
            return Ok(());
        }
        if !info.is_dir() {
            return Ok(());
        }
        if present(&directory.join("HEAD"))?.is_some_and(|head| head.is_file()) {
            // Git runs in this metadata only where it really is.
            if canonical_modules.is_none() {
                *canonical_modules = Some(realpath(modules_directory).map_err(|e| e.to_string())?);
            }
            let real = realpath(directory).map_err(|e| e.to_string())?;
            let module_name = relative_inside(modules_directory, directory).unwrap_or_default();
            let expected = canonical_modules.as_ref().map(|root| if module_name.is_empty() { root.clone() } else { root.join(&module_name) }).unwrap_or_default();
            if path_key(&real) != path_key(&expected) {
                return Err(changed());
            }
            if !self.inspected_submodule_directories.contains(&path_key(&real)) {
                let place = text(directory);
                let run = |args: &[&str]| -> Result<String, String> {
                    let mut all = vec!["--git-dir", place.as_str(), "--work-tree", place.as_str()];
                    all.extend_from_slice(args);
                    git(directory, &all)
                };
                let unpushed = count(&run(&["rev-list", "--count", "--all", "--not", "--remotes"])?)?;
                if unpushed > 0 {
                    let fetched = {
                        let elsewhere = |url: &str, git_directory: &Path| self.remote_elsewhere(url, directory, git_directory);
                        fetched_by_hash(&run, unpushed, &elsewhere)?
                    };
                    // The checkout path from the parent's .gitmodules when it is still recorded.
                    if module_paths.is_none() {
                        let mut paths = HashMap::new();
                        let gitmodules = self.path.join(".gitmodules");
                        if present(&gitmodules)?.is_some_and(|m| m.is_file()) {
                            let listing = git(&self.path, &["config", "--file", &text(&gitmodules), "--null", "--list"])?;
                            for record in listing.split('\0') {
                                if let Some((key, value)) = record.split_once('\n') {
                                    if let Some(name) = key.strip_prefix("submodule.").and_then(|rest| rest.strip_suffix(".path")) {
                                        if !name.is_empty() && !value.is_empty() && !name.contains('\n') {
                                            paths.insert(name.to_string(), value.to_string());
                                        }
                                    }
                                }
                            }
                        }
                        *module_paths = Some(paths);
                    }
                    let recorded = module_paths.as_ref().and_then(|paths| paths.get(&module_name).cloned());
                    let checkout = recorded.and_then(|recorded| relative_inside(&self.canonical_root, &resolve(&self.path.join(recorded)))).filter(|c| !c.is_empty());
                    let metadata_path = format!(".git/modules/{module_name}/");
                    let local = checkout.map_or_else(|| metadata_path.clone(), |c| format!("{c}/"));
                    // A replacement checkout may already have its own row; retained history still needs one.
                    let repository_path = if self.repositories.iter().any(|r| r.path == local) { metadata_path } else { local };
                    let existing = self.items.iter().position(|item| item.path == repository_path);
                    self.repositories.push(RepositoryRow { path: repository_path.clone(), change_count: 0, unpushed_commit_count: Some(unpushed), kind: "repository", fetched_by_hash: fetched });
                    self.add_ignored(&repository_path);
                    let row = match existing {
                        Some(index) => index,
                        None => {
                            self.items.push(Item { path: repository_path, bytes: 0, file_count: 0 });
                            self.items.len() - 1
                        }
                    };
                    // Git ran in this metadata since it was found to be a folder; a link there now is not walked.
                    if present_kind(directory)? != Kind::Directory {
                        return Err(changed());
                    }
                    let local = relative(&self.path, directory);
                    let root = self.path.clone();
                    self.visit(directory, &local, Some(row), true, &root)?;
                }
            }
            return self.retained_modules(&directory.join("modules"), modules_directory, canonical_modules, module_paths);
        }
        // Read again: the folder was seen before its HEAD was read, and a link there now is not walked.
        if present_kind(directory)? != Kind::Directory {
            return Err(changed());
        }
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            self.retained_modules(&directory.join(entry.file_name()), modules_directory, canonical_modules, module_paths)?;
        }
        Ok(())
    }
}

/// A `file://` URL's path, as Node's `fileURLToPath` reads a local one; none for one it would refuse.
fn file_url_path(url: &str) -> Option<PathBuf> {
    let rest = &url[7..];
    let slash = rest.find('/')?;
    let (host, path) = (&rest[..slash], &rest[slash..]);
    let mut bytes = Vec::new();
    let raw = path.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() {
            let hex = std::str::from_utf8(&raw[i + 1..i + 3]).ok()?;
            bytes.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            bytes.push(raw[i]);
            i += 1;
        }
    }
    let decoded = String::from_utf8(bytes).ok()?;
    if cfg!(windows) {
        let local = decoded.trim_start_matches('/').replace('/', "\\");
        if !host.is_empty() && !host.eq_ignore_ascii_case("localhost") {
            return Some(PathBuf::from(format!(r"\\{host}\{local}")));
        }
        let drive = local.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) && local.as_bytes().get(1) == Some(&b':');
        drive.then(|| PathBuf::from(local))
    } else {
        (host.is_empty() || host == "localhost").then(|| PathBuf::from(decoded))
    }
}

/// A URL without its user and password, as Git's `transport_anonymize_url` writes it (Node's `anonymizedUrl`).
fn anonymized_url(url: &str) -> String {
    let (at, colon, slash, scheme) = (url.find('@'), url.find(':'), url.find('/'), url.find("://"));
    let drive = url.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) && url.as_bytes().get(1) == Some(&b':');
    let (Some(at), Some(colon)) = (at, colon) else {
        return url.to_string();
    };
    if slash.is_some_and(|slash| slash < colon) || drive {
        return url.to_string();
    }
    let rest = &url[at + 1..];
    let Some(scheme) = scheme else {
        return if rest.contains(':') { rest.to_string() } else { url.to_string() };
    };
    let path = url[scheme + 3..].find('/').map(|p| p + scheme + 3);
    let plain_scheme = url[..scheme].chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    if !plain_scheme || path.is_some_and(|path| path < at) {
        url.to_string()
    } else {
        format!("{}{rest}", &url[..scheme + 3])
    }
}

/// A remote's URL as Git writes it for the source of a fetch in FETCH_HEAD, as Node's `fetchHeadSource`.
fn fetch_head_source(url: &str) -> String {
    let anonymized = anonymized_url(url);
    let mut end = anonymized.len();
    while end > 0 && anonymized.as_bytes()[end - 1] == b'/' {
        end -= 1;
    }
    if end > 5 && &anonymized.as_bytes()[end - 4..end] == b".git" {
        end -= 4;
    }
    anonymized[..end].replace('\n', "\\n")
}

fn commit_id(text: &str, lower_only: bool) -> bool {
    (text.len() == 40 || text.len() == 64) && text.chars().all(|c| c.is_ascii_digit() || if lower_only { matches!(c, 'a'..='f') } else { c.is_ascii_hexdigit() })
}

/// A FETCH_HEAD line for a commit fetched by its hash, `<commit>\t[not-for-merge]\t'<commit>' of <source>`, read as
/// Node's `FETCHED_BY_HASH` reads it: the commit and its source.
fn fetched_by_hash_line(line: &str) -> Option<(String, String)> {
    let mut parts = line.splitn(3, '\t');
    let (commit, flag, rest) = (parts.next()?, parts.next()?, parts.next()?);
    if !commit_id(commit, true) || !(flag.is_empty() || flag == "not-for-merge") {
        return None;
    }
    let rest = rest.strip_prefix('\'')?;
    let quote = rest.find('\'')?;
    let named = &rest[..quote];
    let source = rest[quote..].strip_prefix("' of ")?;
    // JavaScript's `.` reads no line ending, so a source holding one is no match.
    if source.contains(['\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    (commit_id(named, false) && named.to_ascii_lowercase() == commit).then(|| (commit.to_string(), source.to_string()))
}

/// Of a submodule's `unpushed` commits, the ones FETCH_HEAD records as fetched by their hash from one of its remotes, as
/// Node's `fetchedByHash`: the commits stay counted, and the row only says they may already be there.
fn fetched_by_hash(run: &dyn Fn(&[&str]) -> Result<String, String>, unpushed: u64, elsewhere: &dyn Fn(&str, &Path) -> bool) -> Result<Option<FetchedByHash>, String> {
    let fetch_head = run(&["rev-parse", "--path-format=absolute", "--git-path", "FETCH_HEAD"])?.trim().to_string();
    let contents = fs::read_to_string(&fetch_head).unwrap_or_default();
    let fetched: Vec<(String, String)> = contents.split('\n').filter_map(fetched_by_hash_line).collect();
    if fetched.is_empty() || fetched.len() > FETCHED_BY_HASH_MAX {
        return Ok(None);
    }
    // `remote -v` gives each remote's fetch URL as Git fetches from it, with any `insteadOf` applied.
    let remotes: Vec<(String, String, String)> = run(&["remote", "-v"])?
        .split('\n')
        .filter_map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let (name, rest) = line.split_once('\t')?;
            let at = rest.rfind(" (fetch)")?;
            let after = &rest[at + 8..];
            let noted = after.len() >= 3 && after.starts_with(" [") && after.ends_with(']') && !after[2..after.len() - 1].contains(']');
            if !after.is_empty() && !noted {
                return None;
            }
            let url = &rest[..at];
            Some((name.to_string(), url.to_string(), fetch_head_source(url)))
        })
        .collect();
    let folder = dirname(Path::new(&fetch_head));
    let mut from: Option<(String, String)> = None;
    let mut sources: Vec<&str> = Vec::new();
    for (_, source) in &fetched {
        if !sources.contains(&source.as_str()) {
            sources.push(source);
        }
    }
    for source in sources {
        for (name, url, remote_source) in &remotes {
            if remote_source != source || !elsewhere(url, &folder) {
                continue;
            }
            if from.is_some() {
                return Ok(None);
            }
            from = Some((source.to_string(), name.clone()));
            break;
        }
    }
    let Some((source, remote)) = from else {
        return Ok(None);
    };
    let mut commits: Vec<&str> = Vec::new();
    for (commit, line_source) in &fetched {
        if *line_source == source && !commits.contains(&commit.as_str()) {
            commits.push(commit);
        }
    }
    let mut args = vec!["rev-list", "--count", "--ignore-missing", "--all", "--not", "--remotes"];
    args.extend(commits);
    let commit_count = unpushed.saturating_sub(count(&run(&args)?)?);
    Ok((commit_count > 0).then_some(FetchedByHash { remote, commit_count }))
}

/// What reclaiming a worktree would touch, as Node's `reclaimFacts`, and, inside the registry lane, what was read there.
fn reclaim_facts_within(metadata: &AgentThreadWorktree, identity_in_lane: Option<&RegistryIdentity>) -> Result<(ReclaimFacts, RegistryIdentity, Vec<NestedWorktree>), String> {
    let observed = match identity_in_lane {
        Some(_) => {
            let recorded = metadata.path.as_deref().ok_or("The working folder is not allocated. Retry setup.")?;
            let repository_root = metadata.repository_root.as_deref().ok_or("The worktree binding is incomplete.")?;
            let root = git(Path::new(recorded), &["rev-parse", "--show-toplevel"])?.trim().to_string();
            Some((root, git(Path::new(repository_root), &["worktree", "list", "--porcelain", "-z"])?))
        }
        None => None,
    };
    let (branch, dirty, identity) = inspect_within(metadata, identity_in_lane.cloned(), observed, true)?;
    let path = PathBuf::from(metadata.path.clone().unwrap_or_default());
    let listing = git(&path, &["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])?;
    let untracked_listing = git(&path, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    let mut ignored: Vec<String> = split_nul(&listing).into_iter().filter(|entry| !dependency_folder(entry)).collect();
    js_sort(&mut ignored);
    let canonical_root = realpath(&path).map_err(|e| e.to_string())?;
    let mut walk = Walk {
        root: resolve(&path),
        path: path.clone(),
        canonical_root,
        ignored_set: ignored.iter().cloned().collect(),
        ignored,
        items: Vec::new(),
        repositories: Vec::new(),
        inspected_submodule_directories: HashSet::new(),
        nested_repositories: Vec::new(),
        nested_worktrees: Vec::new(),
        outside_link: None,
    };
    let root = walk.root.clone();
    walk.visit(&root, "", None, false, &path)?;
    for (row, git_directory) in walk.nested_repositories.clone() {
        let retained = walk.retained_history(&git_directory.join("modules"))?;
        if retained > 0 {
            let row = &mut walk.repositories[row];
            row.unpushed_commit_count = Some(row.unpushed_commit_count.unwrap_or(0) + retained);
        }
    }
    // Deinitializing a submodule empties its checkout but keeps its history in this worktree's Git directory.
    let root_marker = fs::symlink_metadata(path.join(".git")).map_err(|e| e.to_string())?;
    if root_marker.is_file() {
        let modules = pointed_directory(&path)?.join("modules");
        walk.retained_modules(&modules, &modules, &mut None, &mut None)?;
    }
    let mut untracked = split_nul(&untracked_listing);
    js_sort(&mut untracked);
    js_sort(&mut walk.ignored);
    walk.repositories.sort_by(|a, b| locale_cmp(&a.path, &b.path));
    let facts = ReclaimFacts {
        path: text(&path),
        branch,
        dirty,
        ignored: walk.ignored,
        items: walk.items,
        repositories: walk.repositories,
        untracked,
        outside_link: walk.outside_link,
    };
    Ok((facts, identity, walk.nested_worktrees))
}

/// What reclaiming this thread's own worktree would touch, as Node's `reclaimFacts`.
pub fn reclaim_facts(metadata: &AgentThreadWorktree) -> Result<ReclaimFacts, String> {
    reclaim_facts_within(metadata, None).map(|(facts, _, _)| facts)
}

// ---------------------------------------------------------------------------------------------------------------------
// The removal.

/// Why a removal stopped: words already plain for the person reading them (Node's `RemovalKept` and
/// `FolderRemovalStalled`), or anything else.
#[derive(Debug)]
enum RemovalError {
    Kept(String),
    /// Anything else, whose own words Node keeps out of what it says (`unfinishedRemoval`).
    Other,
}

impl From<String> for RemovalError {
    fn from(_words: String) -> Self {
        RemovalError::Other
    }
}

/// A removal that stopped again, in plain words, as Node's `unfinishedRemoval`.
fn unfinished_removal(cause: &RemovalError) -> String {
    let kept = match cause {
        RemovalError::Kept(words) => format!("{words} "),
        RemovalError::Other => String::new(),
    };
    format!("Sotto could not finish removing this worktree’s folder, so Git cannot use it. The branch keeps its commits. {kept}Choose Refresh to try again.")
}

/// What `io` says of an entry being removed, as Node's error codes name it.
fn error_code(error: &io::Error) -> &'static str {
    match error.kind() {
        io::ErrorKind::NotFound => return "ENOENT",
        io::ErrorKind::DirectoryNotEmpty => return "ENOTEMPTY",
        io::ErrorKind::ResourceBusy => return "EBUSY",
        io::ErrorKind::PermissionDenied => return "EPERM",
        _ => {}
    }
    match error.raw_os_error() {
        // ERROR_SHARING_VIOLATION and ERROR_LOCK_VIOLATION, as libuv maps them.
        #[cfg(windows)]
        Some(32 | 33) => "EBUSY",
        #[cfg(windows)]
        Some(145) => "ENOTEMPTY",
        #[cfg(windows)]
        Some(4) => "EMFILE",
        #[cfg(unix)]
        Some(24) => "EMFILE",
        #[cfg(unix)]
        Some(23) => "ENFILE",
        _ => "",
    }
}

const BUSY: [&str; 6] = ["EBUSY", "ENOTEMPTY", "EPERM", "EACCES", "EMFILE", "ENFILE"];

/// Deletes everything inside a folder except the top-level names in `keep`, and leaves the folder, as Node's
/// `removeFolderContents`: a link or junction is removed as itself and never followed, a busy entry is retried with a
/// growing pause, and the removal stops only when nothing has been deleted for the stall.
struct Remover {
    progress_at: Instant,
    stall: Duration,
}

impl Remover {
    fn progressed(&mut self) {
        self.progress_at = Instant::now();
    }

    /// One file system call, retried while the entry is busy, as Node's `attempt`. `writable` makes a read-only entry
    /// writable once; none for a link, whose target is not the removal's to change.
    fn attempt<T>(&mut self, path: &Path, writable: bool, mut before_retry: impl FnMut(&mut Self) -> Result<(), RemovalError>, io_work: &dyn Fn() -> io::Result<T>, gone: T) -> Result<T, RemovalError> {
        let mut tries: u32 = 0;
        loop {
            match io_work() {
                Ok(result) => {
                    self.progressed();
                    return Ok(result);
                }
                Err(error) => {
                    let code = error_code(&error);
                    if code == "ENOENT" {
                        self.progressed();
                        return Ok(gone);
                    }
                    if !BUSY.contains(&code) {
                        return Err(RemovalError::Other);
                    }
                    if self.progress_at.elapsed() > self.stall {
                        return Err(RemovalError::Kept("A file in the folder stayed in use. Close any program using the folder.".into()));
                    }
                    if tries == 0 && code == "EPERM" {
                        make_writable(&dirname(path));
                        if writable {
                            make_writable(path);
                        }
                    }
                    if code == "ENOTEMPTY" {
                        before_retry(self)?;
                    }
                    std::thread::sleep(Duration::from_millis(1_000.min(10 * 2u64.pow(tries.min(7)))));
                    tries += 1;
                }
            }
        }
    }

    fn remove_entry(&mut self, path: &Path) -> Result<(), RemovalError> {
        let info = match fs::symlink_metadata(path) {
            Ok(info) => info,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(RemovalError::Other),
        };
        if info.is_dir() {
            self.remove_children(path, &[])?;
            // Something that wrote into the folder after its entries went is taken too before asking again.
            let owned = path.to_path_buf();
            return self.attempt(path, true, |remover| remover.remove_children(&owned, &[]), &|| fs::remove_dir(path), ());
        }
        if info.file_type().is_symlink() && link_to_directory(&info) {
            // A junction or a link to a folder goes as itself, and the folder it leads to stays.
            return self.attempt(path, false, |_| Ok(()), &|| fs::remove_dir(path), ());
        }
        let writable = !info.file_type().is_symlink();
        self.attempt(path, writable, |_| Ok(()), &|| fs::remove_file(path), ())
    }

    fn remove_children(&mut self, directory: &Path, keep: &[&str]) -> Result<(), RemovalError> {
        let names = self.attempt(directory, true, |_| Ok(()), &|| fs::read_dir(directory).and_then(|entries| entries.map(|e| e.map(|e| e.file_name())).collect::<io::Result<Vec<_>>>()), Vec::new())?;
        for name in names {
            if keep.iter().any(|kept| name == *kept) {
                continue;
            }
            self.remove_entry(&directory.join(name))?;
        }
        Ok(())
    }
}

#[cfg(windows)]
fn link_to_directory(info: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    info.file_attributes() & 0x10 != 0
}

#[cfg(not(windows))]
fn link_to_directory(_info: &fs::Metadata) -> bool {
    false
}

fn make_writable(path: &Path) {
    let Ok(meta) = fs::symlink_metadata(path) else { return };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if meta.is_dir() { 0o700 } else { 0o600 };
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    {
        let mut permissions = meta.permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        let _ = fs::set_permissions(path, permissions);
    }
}

fn remove_folder_contents(root: &Path, keep: &[&str], stall: Duration) -> Result<(), RemovalError> {
    Remover { progress_at: Instant::now(), stall }.remove_children(root, keep)
}

/// A reserved folder reached through a link or junction, its own or a parent's, is not the folder Sotto made.
fn refuse_redirected(path: &Path) -> Result<(), RemovalError> {
    let real = realpath(path).map_err(|_| RemovalError::Other)?;
    if path_key(&real) != path_key(path) {
        return Err(RemovalError::Kept("The worktree’s folder now leads to another folder through a link, so nothing was removed. Put the original folder back where Sotto made it, then choose Refresh.".into()));
    }
    Ok(())
}

/// Whether the reserved folder is empty or gone and Git no longer registers it, as Node's `emptiedAndUnregistered`.
fn emptied_and_unregistered(repository_root: &Path, path: &Path) -> bool {
    let occupied = match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(_) => true,
        Ok(info) if !info.is_dir() => true,
        Ok(_) => !(realpath(path).is_ok_and(|real| path_key(&real) == path_key(path)) && fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_none())),
    };
    !occupied
        && git(repository_root, &["worktree", "list", "--porcelain", "-z"])
            .is_ok_and(|listing| !registered_worktrees(&listing).iter().any(|entry| path_key(Path::new(&entry.path)) == path_key(path)))
}

/// Clears a nested worktree's registration in its own repository, as Node's `clearNestedWorktree`.
fn clear_nested_worktree(nested: &NestedWorktree) -> Result<(), RemovalError> {
    let common = Path::new(&nested.common_directory);
    // Node stops no `git worktree remove` (`runWorktreeGitProcess`), so this one has no deadline either.
    let removed = registry_identity(common)
        .and_then(|identity| coordinate_registry(&identity, || run_worktree_git(&text(common), &["worktree", "remove", "--force", "--", &nested.path], None)));
    if removed.is_ok() {
        return Ok(());
    }
    let gone = match git(common, &["worktree", "list", "--porcelain", "-z"]) {
        Ok(listing) => !registered_worktrees(&listing).iter().any(|entry| path_key(Path::new(&entry.path)) == path_key(Path::new(&nested.path))),
        Err(_) => fs::symlink_metadata(common).is_err_and(|error| not_found(&error)),
    };
    if gone {
        Ok(())
    } else {
        Err(RemovalError::Kept("Git would not clear the registration of a worktree that was inside it, in that worktree’s own repository.".into()))
    }
}

/// The removal itself, for a worktree Git holds locked for Sotto's removal, as Node's `removeLocked`: everything but the
/// `.git` file goes, then the nested worktrees' registrations, then Git removes the `.git` file, the folder and its own.
fn remove_locked(repository_root: &Path, path: &Path, identity: &RegistryIdentity, nested: &[NestedWorktree], stall: Duration) -> Result<(), RemovalError> {
    if present(path)?.is_some() {
        refuse_redirected(path)?;
        remove_folder_contents(path, &[".git"], stall)?;
    }
    for worktree in nested {
        clear_nested_worktree(worktree)?;
    }
    coordinate_registry(identity, || {
        let place = text(path);
        match run_worktree_git(&text(repository_root), &["worktree", "remove", "--force", "--force", "--", &place], None) {
            Ok(_) => Ok(()),
            // On Windows a process working in the folder stops Git deleting the folder itself after it has deleted the
            // files and its registration. An empty or missing folder Git no longer registers is removed.
            Err(_) if emptied_and_unregistered(repository_root, path) => Ok(()),
            Err(_) => Err(RemovalError::Other),
        }
    })
}

/// A reclaimed record on the branch the folder had, or, with none, on the commit it had, which `restore` checks out, as
/// Node's `reclaimedRecord` with `withoutIncomingRef`: the incoming ref a moved branch's worktree was made from goes with
/// the folder (ADR-0082 decision 3). The removal is remembered until the folder is put back (`finishedRemovals`).
fn reclaimed_record(metadata: &AgentThreadWorktree, branch: Option<String>, detached_commit: Option<String>) -> AgentThreadWorktree {
    let at = now_iso();
    let commit = if branch.is_some() { None } else { detached_commit };
    if let Some(path) = metadata.path.as_deref() {
        restore::record_finished(Path::new(path), branch.clone(), commit.clone(), at.clone());
    }
    let mut record = restore::reclaimed_on(metadata, branch, commit, at);
    if let Some(Value::String(reference)) = record.extra.remove("incomingRef") {
        let incoming = reference
            .strip_prefix("refs/sotto/incoming/")
            .and_then(|rest| rest.split_once('/'))
            .is_some_and(|(id, branch)| id.len() == 36 && id.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f' | '-')) && !branch.is_empty());
        if let (true, Some(root)) = (incoming, record.repository_root.as_deref()) {
            let _ = git(Path::new(root), &["update-ref", "-d", "--no-deref", &reference]);
        }
    }
    record
}

/// The ignored items' rows, sorted by path and compared only by path and count, as Node's `counts`.
fn counts(items: impl Iterator<Item = (String, u64)>) -> Vec<(String, u64)> {
    let mut list: Vec<(String, u64)> = items.collect();
    list.sort_by(|a, b| locale_cmp(&a.0, &b.0));
    list
}

/// Removes this thread's own worktree folder and nothing else, as Node's `reclaim` does for a removal the user asked for
/// (Remove worktree, or Delete thread…). The branch keeps its commits and the thread keeps its record, which comes back
/// marked reclaimed. It refuses a folder that is not this thread's own, one outside Sotto's reserved folder, one Git does
/// not register as this repository's unlocked checkout, one on a detached HEAD, one holding a link out of itself, one with
/// ignored files, nested work or files the user did not confirm, one whose files changed since they were listed, one with
/// uncommitted changes the user did not confirm, and one that is a repository of its own. A rule acting alone
/// (`automatic`) is not ported. A removal Sotto started and did not finish is refused here, as inspection refuses it, and
/// finished by Refresh (`restore::resume_removal`).
pub fn reclaim(data_directory: &Path, metadata: &AgentThreadWorktree, options: &ReclaimOptions) -> Result<AgentThreadWorktree, String> {
    if metadata.mode != "independent" || metadata.reused == Some(true) {
        return Err("Only a worktree Sotto made for this thread can be removed. A shared or reused folder stays.".into());
    }
    let allocation_root = realpath(data_directory).map_err(|e| e.to_string())?.join(THREAD_WORKTREE_FOLDER);
    if !metadata.path.as_deref().is_some_and(|path| restore::reserved_place(Path::new(path), &allocation_root)) {
        return Err("This folder is outside Sotto’s reserved worktree folder. Nothing was changed.".into());
    }
    let (facts, identity, _) = reclaim_facts_within(metadata, None)?;
    // Only a rule or a clear takes a detached HEAD's folder; the user's own removal asks for a branch.
    if facts.branch.is_none() {
        return Err(DETACHED_NEEDS_BRANCH.into());
    }
    if let Some(link) = &facts.outside_link {
        return Err(format!("This folder contains a link to another folder ({link}). Remove the link first so nothing outside the folder is touched. Nothing was changed."));
    }
    if !facts.ignored.is_empty() && options.confirmed_ignored.is_none() {
        return Err("This folder holds ignored files. Nothing was removed. Choose Remove worktree to review them.".into());
    }
    if let Some(confirmed) = &options.confirmed_ignored {
        let mut sorted = confirmed.clone();
        js_sort(&mut sorted);
        if sorted != facts.ignored {
            return Err("The ignored items changed. Nothing was removed. Close this question and choose Remove worktree again to review them.".into());
        }
    }
    // A row confirmed without the note on commits fetched from a remote read "not on any remote" for them, as a client
    // from before the note shows it, so the note is not held against it.
    let confirmable: Vec<RepositoryRow> = facts
        .repositories
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let noted = options.confirmed_repositories.as_ref().and_then(|rows| rows.get(index)).is_some_and(|confirmed| confirmed.fetched_by_hash.is_some());
            if row.fetched_by_hash.is_some() && !noted {
                RepositoryRow { fetched_by_hash: None, ..row.clone() }
            } else {
                row.clone()
            }
        })
        .collect();
    if !facts.repositories.is_empty() && options.confirmed_repositories.as_ref() != Some(&confirmable) {
        return Err("The nested work changed. Nothing was removed. Choose Remove worktree again to review it.".into());
    }
    if facts.dirty && !options.with_uncommitted_changes {
        return Err(RECLAIM_WORKTREE_NEEDS_CONFIRMATION.into());
    }
    let path = PathBuf::from(&facts.path);
    // A linked worktree's .git is a file; a directory there is a repository of its own and is never removed.
    if !fs::symlink_metadata(path.join(".git")).map_err(|e| e.to_string())?.is_file() {
        return Err("This folder is a repository of its own, not a worktree. Nothing was changed.".into());
    }
    let repository_root = PathBuf::from(metadata.repository_root.clone().unwrap_or_default());
    // The last observation is taken inside the registry lane, immediately before the folder is locked for removal.
    take_turns(&REMOVAL_OPERATIONS, &path_key(&path), || {
        let nested = coordinate_registry(&identity, || -> Result<Vec<NestedWorktree>, String> {
            let (latest, nested) = reclaim_facts_within(metadata, Some(&identity)).map(|(facts, _, nested)| (facts, nested))?;
            let confirmed_items = counts(options.confirmed_items.clone().unwrap_or_default().into_iter());
            if confirmed_items != counts(latest.items.iter().map(|item| (item.path.clone(), item.file_count))) {
                return Err("The folder changed. Nothing was removed. Choose Remove worktree again to see the new list.".into());
            }
            if latest.outside_link.is_some()
                || latest.branch != facts.branch
                || latest.dirty != facts.dirty
                || latest.ignored != facts.ignored
                || latest.untracked != facts.untracked
                || latest.repositories != facts.repositories
            {
                return Err(FILES_CHANGED.into());
            }
            let ignored_now = git(&path, &["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])?;
            let untracked_now = git(&path, &["ls-files", "--others", "--exclude-standard", "-z"])?;
            let status_now = git(&path, &["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"])?;
            let mut rows: Vec<String> = Vec::new();
            for entry in split_nul(&ignored_now).into_iter().filter(|item| !dependency_folder(item)).chain(latest.repositories.iter().map(|r| r.path.clone())) {
                if !rows.contains(&entry) {
                    rows.push(entry);
                }
            }
            js_sort(&mut rows);
            let mut untracked = split_nul(&untracked_now);
            js_sort(&mut untracked);
            if rows != facts.ignored || untracked != facts.untracked || status_now.is_empty() == facts.dirty {
                return Err(FILES_CHANGED.into());
            }
            // Nothing is deleted until Git holds the folder locked for Sotto's removal (#1297).
            if let Some(registration) = git_directory(&path) {
                let record = json!({ "nestedWorktrees": nested.iter().map(|n| json!({ "path": n.path, "commonDirectory": n.common_directory })).collect::<Vec<_>>() });
                fs::write(registration.join(REMOVAL_RECORD), record.to_string()).map_err(|e| e.to_string())?;
            }
            git(&repository_root, &["worktree", "lock", "--reason", REMOVING_LOCK_REASON, "--", &facts.path])?;
            Ok(nested)
        })?;
        // Outside the registry lane, so other threads' Git work in the repository does not wait for a large folder.
        remove_locked(&repository_root, &path, &identity, &nested, REMOVAL_STALL).map_err(|cause| unfinished_removal(&cause))?;
        Ok(reclaimed_record(metadata, facts.branch.clone(), None))
    })
}

/// Why a thread's own worktree folder keeps it back from Delete thread…, read from the folder, with the facts read, as
/// Node's `worktreeDeletionHold` for a deletion the user asked for: a folder another thread works in, one with
/// uncommitted changes, one with a link out of it and one on a detached HEAD are kept. Ignored files and nested work are
/// the question's to list. `owns_alone` is the workspace's answer of whether no other thread works in the folder.
pub fn worktree_deletion_hold(metadata: &AgentThreadWorktree, owns_alone: bool) -> (Option<crate::thread_clearing::KeptReason>, Option<ReclaimFacts>) {
    use crate::thread_clearing::KeptReason;
    if !owns_alone {
        return (Some(KeptReason::WorktreeInUse), None);
    }
    let Ok(facts) = reclaim_facts(metadata) else {
        return (Some(KeptReason::WorktreeError), None);
    };
    if facts.dirty {
        return (Some(KeptReason::Uncommitted), Some(facts));
    }
    if facts.outside_link.is_some() || facts.branch.is_none() {
        return (Some(KeptReason::WorktreeError), Some(facts));
    }
    (None, Some(facts))
}

// ---------------------------------------------------------------------------------------------------------------------
// Whether another thread works in the folder, as Node's workspace asks it.

/// Git's own discovery for a folder, read from the `.git` entries on disk, as Node's `checkoutOnDisk`: the nearest folder,
/// this one or above, holding a `.git` file or a `.git` directory with a HEAD, objects and refs, or, in no repository,
/// the nearest `.git` of any kind. `None` when the file system would not answer.
fn checkout_on_disk(folder: &Path) -> Option<Option<PathBuf>> {
    let mut marker = None;
    let mut candidate = folder.to_path_buf();
    loop {
        match fs::metadata(candidate.join(".git")) {
            Ok(entry) if entry.is_file() => return Some(Some(candidate)),
            Ok(entry) => {
                let git = candidate.join(".git");
                if entry.is_dir() && fs::metadata(git.join("HEAD")).is_ok_and(|m| m.is_file()) && fs::metadata(git.join("objects")).is_ok_and(|m| m.is_dir()) && fs::metadata(git.join("refs")).is_ok_and(|m| m.is_dir()) {
                    return Some(Some(candidate));
                }
                if marker.is_none() {
                    marker = Some(candidate.clone());
                }
            }
            Err(error) if not_found(&error) => {}
            Err(_) => return None,
        }
        let Some(parent) = candidate.parent().map(Path::to_path_buf) else {
            return Some(marker);
        };
        candidate = parent;
    }
}

/// One checkout's identity, as Node's `checkoutIdentity` for a folder that is there: its checkout root on disk, the
/// nearest `.git` of any kind, the root Git names, or the folder itself.
fn checkout_identity(directory: &Path) -> Result<String, FolderRefused> {
    let real = existing_working_directory(directory)?;
    match checkout_on_disk(&real) {
        Some(found) => Ok(path_key(&found.unwrap_or_else(|| real.clone()))),
        None => match git(&real, &["rev-parse", "--show-toplevel"]) {
            Ok(root) => Ok(path_key(&realpath(Path::new(root.trim())).unwrap_or_else(|_| PathBuf::from(root.trim())))),
            Err(_) => {
                let mut candidate = real.clone();
                loop {
                    match fs::symlink_metadata(candidate.join(".git")) {
                        Ok(_) => return Ok(path_key(&candidate)),
                        Err(error) if not_found(&error) => {}
                        Err(error) => return Err(FolderRefused { words: error.to_string(), missing: false }),
                    }
                    match candidate.parent() {
                        Some(parent) => candidate = parent.to_path_buf(),
                        None => return Ok(path_key(&real)),
                    }
                }
            }
        },
    }
}

/// Whether no other thread works in `folder`'s checkout, as Node's `ownsCheckoutAlone` and `checkoutIsUnreferenced`.
/// `others` holds each other thread's folder as the workspace names it (its working folder, its worktree's, the one it
/// reused, or its project's), or `None` for a thread with none, which leaves ownership unproven.
pub fn owns_checkout_alone(folder: &str, others: &[Option<String>]) -> bool {
    let Ok(identity) = checkout_identity(Path::new(folder)) else {
        return false;
    };
    let mut known: HashMap<String, Result<String, bool>> = HashMap::new();
    let mut identify = |path: &str| -> Result<String, bool> {
        known.entry(path.to_string()).or_insert_with(|| checkout_identity(Path::new(path)).map_err(|refused| refused.missing)).clone()
    };
    for other in others {
        let Some(path) = other else {
            return false;
        };
        match identify(path) {
            Ok(found) if found == identity => return false,
            Ok(_) => {}
            // A missing folder is read through its nearest parent that is there; anything else leaves ownership unproven.
            Err(true) => {
                let mut parent = dirname(Path::new(path));
                loop {
                    match identify(&text(&parent)) {
                        Ok(found) if found == identity => return false,
                        Ok(_) => break,
                        Err(true) => {
                            let next = dirname(&parent);
                            if next == parent {
                                break;
                            }
                            parent = next;
                        }
                        Err(false) => return false,
                    }
                }
            }
            Err(false) => return false,
        }
    }
    true
}

mod restore;
pub use restore::{read_working_copy, restore_thread_branch, send_working_copy, with_repository, working_copy_command_shape, NO_CHECKOUT_TO_SWITCH, RESTORE_BRANCH_NEEDS_CONFIRMATION};

#[cfg(test)]
mod tests;
