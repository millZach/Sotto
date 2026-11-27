//! Choosing a thread's working copy before its first send, as Node's host does it: the command's shape
//! (`agentWorkingCopySelectionSchema` in `src/shared/agents.ts`), the record the choice makes (`selectedWorkingCopy` in
//! `src/main/agents/workspace.ts`), and, at that first send, taking the existing worktree the user chose (`allocate` in
//! `threadWorktrees.ts`). Choosing changes no folder: only the record moves, and an existing worktree stays the user's
//! (`reused`), so nothing Sotto removes. The words are Node's, since a client shows them.
//!
//! Everything here blocks on Git and the file system, so the coordinator runs it off its own thread, in the thread's lane.

use super::*;

/// The folders under the data folder that hold the checks' and Councils' own worktrees, which no thread is offered, as
/// Node's `CHECK_WORKTREE_FOLDER` and `COUNCIL_WORKTREE_FOLDER`.
const CHECK_WORKTREE_FOLDER: &str = "check-worktrees";
const COUNCIL_WORKTREE_FOLDER: &str = "council-worktrees";
const NOT_AN_AVAILABLE_WORKTREE: &str = "That folder is not an available worktree of this project. Refresh the worktree list and choose again.";

/// The working copy a `configure-thread-working-copy` command chooses, as Node's `AgentWorkingCopySelection`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkingCopySelection {
    pub shared: bool,
    pub base_branch: Option<String>,
    pub start_from_origin: Option<bool>,
    pub existing_worktree_path: Option<String>,
}

/// A string zod's `z.string().min(1).max(max)` takes: its length counted in UTF-16 code units, as JavaScript counts it.
fn bounded(value: &Value, max: usize) -> Option<String> {
    let text = value.as_str()?;
    let length = text.encode_utf16().count();
    (1..=max).contains(&length).then(|| text.to_string())
}

impl WorkingCopySelection {
    /// The command read as Node's strict command schema reads it (`agentCommandSchema`): a thread ID, `workingCopy` as
    /// `independent` or `shared`, `baseBranch` and `existingWorktreePath` as non-empty strings within their limits,
    /// `startFromOrigin` as a boolean, and nothing else. `None` for any other shape, which is `invalid_request`.
    pub fn from_command(command: &Map<String, Value>) -> Option<Self> {
        if command.get("type").and_then(Value::as_str) != Some("configure-thread-working-copy") {
            return None;
        }
        bounded(command.get("threadId")?, 512)?;
        let shared = match command.get("workingCopy")?.as_str()? {
            "shared" => true,
            "independent" => false,
            _ => return None,
        };
        let mut selection = Self { shared, base_branch: None, start_from_origin: None, existing_worktree_path: None };
        for (key, value) in command {
            match key.as_str() {
                "type" | "threadId" | "workingCopy" => {}
                "baseBranch" => selection.base_branch = Some(bounded(value, 512)?),
                "startFromOrigin" => selection.start_from_origin = Some(value.as_bool()?),
                "existingWorktreePath" => selection.existing_worktree_path = Some(bounded(value, 4096)?),
                _ => return None,
            }
        }
        Some(selection)
    }

    /// The folder whose checkout the choice reads, and so holds from changes while it is made, as Node's
    /// `reserveWorkingCopySelection`: the project's for the shared one, the chosen worktree's, or none for a new worktree.
    pub fn read_folder<'a>(&'a self, project_path: &'a str) -> Option<&'a str> {
        if self.shared {
            Some(project_path)
        } else {
            self.existing_worktree_path.as_deref()
        }
    }
}

/// Node's `sameFolder` in `workspace.ts`: trailing separators dropped, `\` read as `/`, case folded.
fn same_folder(left: &str, right: &str) -> bool {
    let fold = |path: &str| path.trim_end_matches(['\\', '/']).replace('\\', "/").to_lowercase();
    fold(left) == fold(right)
}

/// The branch of the worktree at `existing` among those a project offers, as Node's `options` lists them and
/// `selectedWorkingCopy` finds one: none when the project is not a repository, the folder is not one of them, or the
/// list could not be read (`.catch(() => null)`).
fn offered_branch(data_directory: &Path, project_path: &str, existing: &str) -> Option<String> {
    let cwd = existing_working_directory(Path::new(project_path)).ok()?;
    let identity = registry_identity(&cwd).ok()?;
    let listed = registry(&cwd, &["worktree", "list", "--porcelain", "-z"], Some(&identity)).ok()?;
    let held = |folder: &str| realpath(&data_directory.join(folder)).ok().map(|real| format!("{}{}", path_key(&real), std::path::MAIN_SEPARATOR));
    let (checks, councils) = (held(CHECK_WORKTREE_FOLDER), held(COUNCIL_WORKTREE_FOLDER));
    let within = |prefix: &Option<String>, path: &str| prefix.as_ref().is_some_and(|prefix| path_key(Path::new(path)).starts_with(prefix));
    registered_worktrees(&listed)
        .into_iter()
        .filter(|entry| !entry.locked && !entry.prunable && !within(&checks, &entry.path) && !within(&councils, &entry.path))
        .find(|entry| same_folder(&entry.path, existing))?
        .branch
        .map(|branch| branch.strip_prefix("refs/heads/").map(ToString::to_string).unwrap_or(branch))
        .filter(|branch| !branch.is_empty())
}

/// The record a thread's chosen working copy makes, as Node's `selectedWorkingCopy`: the shared project folder, where any
/// link in it leads, read as Git has it now (`inspect(allocate(project, 'shared'))`); or a worktree still to make or take
/// at the first send, with where it starts from, or the existing worktree and the branch it has, when the project offers it.
pub fn selected_working_copy(data_directory: &Path, project_path: &str, selection: &WorkingCopySelection) -> Result<AgentThreadWorktree, String> {
    if selection.shared {
        let path = existing_working_directory(Path::new(project_path)).map_err(|refused| refused.words)?;
        let record = AgentThreadWorktree {
            mode: "shared".into(),
            status: "ready".into(),
            path: Some(text(&path)),
            repository_root: None,
            branch: None,
            base_branch: None,
            start_from_origin: None,
            existing_worktree_path: None,
            reused: None,
            temporary_branch: None,
            error: None,
            git: None,
            extra: Map::new(),
        };
        return restore::inspect(&record);
    }
    let existing = selection.existing_worktree_path.clone();
    let branch = existing.as_deref().and_then(|existing| offered_branch(data_directory, project_path, existing));
    Ok(AgentThreadWorktree {
        mode: "independent".into(),
        status: "pending".into(),
        path: None,
        repository_root: None,
        branch,
        base_branch: selection.base_branch.clone(),
        start_from_origin: selection.start_from_origin,
        existing_worktree_path: existing,
        reused: None,
        temporary_branch: None,
        error: None,
        git: None,
        extra: Map::new(),
    })
}

/// The existing worktree a thread's first send works in, as Node's `allocate` takes one: the folder, where any link in it
/// leads, must be a worktree the project's repository lists and has not locked or marked prunable; it is recorded as the
/// user's own (`reused`), with its repository and the project's place in it, and read as Git has it now. Nothing is
/// made, moved or removed. A project that is not a repository has no worktrees, so the thread works in the project folder
/// itself, as Node's `allocate` answers then; any other failure of Git is Git's own words.
pub fn existing_worktree(project_path: &str, existing: &str) -> Result<AgentThreadWorktree, String> {
    let cwd = existing_working_directory(Path::new(project_path)).map_err(|refused| refused.words)?;
    let root = match git(&cwd, &["rev-parse", "--show-toplevel"]) {
        Ok(root) => PathBuf::from(root.trim()),
        Err(words) if words.contains("not a git repository") => {
            return Ok(AgentThreadWorktree {
                mode: "shared".into(),
                status: "ready".into(),
                path: Some(text(&cwd)),
                repository_root: None,
                branch: None,
                base_branch: None,
                start_from_origin: None,
                existing_worktree_path: None,
                reused: None,
                temporary_branch: None,
                error: None,
                git: None,
                extra: Map::new(),
            })
        }
        Err(words) => return Err(words),
    };
    let path = existing_working_directory(Path::new(existing)).map_err(|refused| refused.words)?;
    let identity = registry_identity(&root)?;
    let listed = registry(&root, &["worktree", "list", "--porcelain", "-z"], Some(&identity))?;
    let available = registered_worktrees(&listed).into_iter().find(|entry| path_key(Path::new(&entry.path)) == path_key(&path)).is_some_and(|entry| !entry.locked && !entry.prunable);
    if !available {
        return Err(NOT_AN_AVAILABLE_WORKTREE.into());
    }
    let root = realpath(&root).map_err(|error| error.to_string())?;
    let mut extra = Map::new();
    extra.insert("projectRelativePath".into(), Value::String(relative(&root, &cwd)));
    restore::inspect(&AgentThreadWorktree {
        mode: "independent".into(),
        status: "ready".into(),
        path: Some(text(&path)),
        repository_root: Some(text(&root)),
        branch: None,
        base_branch: None,
        start_from_origin: None,
        existing_worktree_path: None,
        reused: Some(true),
        temporary_branch: None,
        error: None,
        git: None,
        extra,
    })
}

#[cfg(test)]
mod tests;
