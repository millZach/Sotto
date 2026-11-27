//! Putting a folder back, finishing a removal, and Restore branch on real repositories and real `git worktree`s, as
//! Node's own tests of `restore`, `resumeRemoval` and `restoreThreadBranch` hold them.

use super::*;
use serde_json::{json, Map};
use std::process::Command;

const BRANCH: &str = "sotto/restore-test";
const FOLDER: &str = "3a9e1c52-6d0b-4f7a-8e21-5b4c3d2a1f09";

fn sh_git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.name=Sotto Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "init.defaultBranch=main"])
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A repository with one commit, and a thread's own worktree of it on its own branch, with one commit of its own, in the
/// data folder's reserved place.
struct Fixture {
    _dir: tempfile::TempDir,
    base: PathBuf,
    data: PathBuf,
    repo: PathBuf,
    path: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = realpath(dir.path()).unwrap();
        let (data, repo) = (base.join("data"), base.join("repo"));
        fs::create_dir_all(data.join(THREAD_WORKTREE_FOLDER)).unwrap();
        fs::create_dir_all(&repo).unwrap();
        sh_git(&repo, &["init", "-q"]);
        fs::write(repo.join("README.md"), "hello\n").unwrap();
        sh_git(&repo, &["add", "."]);
        sh_git(&repo, &["commit", "-q", "-m", "First"]);
        let path = data.join(THREAD_WORKTREE_FOLDER).join(FOLDER);
        sh_git(&repo, &["worktree", "add", "-q", "-b", BRANCH, &text(&path)]);
        fs::write(path.join("work.txt"), "the thread's work\n").unwrap();
        sh_git(&path, &["add", "."]);
        sh_git(&path, &["commit", "-q", "-m", "Work"]);
        Fixture { _dir: dir, base, data, repo, path }
    }

    fn record(&self) -> AgentThreadWorktree {
        AgentThreadWorktree {
            mode: "independent".into(),
            status: "ready".into(),
            path: Some(text(&self.path)),
            repository_root: Some(text(&self.repo)),
            branch: Some(BRANCH.into()),
            base_branch: None,
            start_from_origin: None,
            existing_worktree_path: None,
            reused: Some(false),
            temporary_branch: Some(true),
            error: None,
            git: None,
            extra: Map::new(),
        }
    }

    /// The folder removed as Remove worktree removes it, and its reclaimed record.
    fn reclaimed(&self) -> AgentThreadWorktree {
        let record = reclaim(&self.data, &self.record(), &ReclaimOptions::default()).unwrap();
        assert!(record.reclaimed() && !self.path.exists());
        record
    }

    /// The folder locked as Sotto locks one it is removing (#1297), with the removal's record beside the lock.
    fn lock_for_removal(&self) {
        let registration = git_directory(&self.path).unwrap();
        fs::write(registration.join(REMOVAL_RECORD), r#"{"nestedWorktrees":[]}"#).unwrap();
        sh_git(&self.repo, &["worktree", "lock", "--reason", REMOVING_LOCK_REASON, "--", &text(&self.path)]);
    }

    fn registered(&self) -> bool {
        registered_worktrees(&sh_git(&self.repo, &["worktree", "list", "--porcelain", "-z"])).iter().any(|entry| path_key(Path::new(&entry.path)) == path_key(&self.path))
    }

    fn checked_out(&self) -> String {
        sh_git(&self.path, &["branch", "--show-current"])
    }
}

fn send(fixture: &Fixture, record: &AgentThreadWorktree) -> Result<Option<AgentThreadWorktree>, String> {
    send_working_copy(&fixture.data, record, || {})
}

/// A folder Remove worktree took comes back on the next send, on its branch with its commits, as Node's `restore` puts it
/// back (ADR-0014): the record is no longer reclaimed, and the branch the send goes to is recorded as its own.
#[test]
fn a_send_puts_a_removed_folder_back_on_its_branch() {
    let fixture = Fixture::new();
    let record = send(&fixture, &fixture.reclaimed()).unwrap().expect("the record changes");
    assert_eq!(fs::read_to_string(fixture.path.join("work.txt")).unwrap().trim_end(), "the thread's work", "the branch's commits are there");
    assert_eq!(fixture.checked_out(), BRANCH);
    assert!(!record.reclaimed());
    assert_eq!((record.status.as_str(), record.branch.as_deref(), record.error.as_deref()), ("ready", Some(BRANCH), None));
    assert_eq!(record.extra.get("sentBranch"), Some(&json!(BRANCH)));
    assert_eq!(record.extra.get("dirty"), Some(&json!(false)));
    // A ready folder that is there is read from its own files, and nothing changes.
    assert_eq!(send(&fixture, &record).unwrap(), None);
}

/// Refresh reads a folder Sotto removed again, and only a send puts it back, as Node's `updateThreadWorktree` says.
#[test]
fn a_refresh_leaves_a_removed_folder_for_the_next_send() {
    let fixture = Fixture::new();
    let reclaimed = fixture.reclaimed();
    assert_eq!(read_working_copy(&fixture.data, &reclaimed), reclaimed);
    assert!(!fixture.path.exists());
}

/// A folder deleted by hand is put back by Refresh before it is read, so a refresh never turns a missing folder into an
/// error the next send would then refuse to repair.
#[test]
fn a_refresh_puts_a_deleted_folder_back() {
    let fixture = Fixture::new();
    fs::remove_dir_all(&fixture.path).unwrap();
    let record = read_working_copy(&fixture.data, &fixture.record());
    assert_eq!((record.status.as_str(), record.error.as_deref()), ("ready", None));
    assert_eq!(fixture.checked_out(), BRANCH);
    assert!(fixture.path.join("work.txt").exists());
}

/// A branch another folder has checked out is never taken: nothing is put back, and that folder is left as it is.
#[test]
fn a_branch_checked_out_elsewhere_is_not_taken() {
    let fixture = Fixture::new();
    let reclaimed = fixture.reclaimed();
    let elsewhere = fixture.base.join("elsewhere");
    sh_git(&fixture.repo, &["worktree", "add", "-q", &text(&elsewhere), BRANCH]);
    let words = send(&fixture, &reclaimed).unwrap_err();
    assert_eq!(words, format!("The branch {BRANCH} is checked out in {}, so this thread’s folder cannot be put back on it. Nothing was lost or changed. Close that folder’s checkout or move it to another branch, then retry.", text(&elsewhere).replace('\\', "/")));
    assert!(!fixture.path.exists());
    assert!(elsewhere.join("work.txt").exists());
}

/// Anything else at a removed folder's place is not Sotto's to fill: it is kept, and the send says the folder is not the
/// thread's checkout.
#[test]
fn an_occupied_place_is_kept() {
    let fixture = Fixture::new();
    let reclaimed = fixture.reclaimed();
    fs::create_dir_all(&fixture.path).unwrap();
    fs::write(fixture.path.join("mine.txt"), "the user's\n").unwrap();
    let words = send(&fixture, &reclaimed).unwrap_err();
    assert_eq!(words, "The working folder is no longer this thread’s Git worktree. Restore its checkout before continuing.");
    assert_eq!(fs::read_to_string(fixture.path.join("mine.txt")).unwrap(), "the user's\n");
    assert!(!fixture.registered());
}

/// A removal Sotto started and did not finish (#1297) is finished by Refresh: the folder goes, the branch keeps its
/// commits and the record comes back reclaimed on that branch; the next send puts the folder back.
#[test]
fn a_refresh_finishes_a_removal_sotto_started() {
    let fixture = Fixture::new();
    fixture.lock_for_removal();
    fs::remove_file(fixture.path.join("README.md")).unwrap();
    // Inspection refuses the folder meanwhile, in Node's words.
    assert_eq!(inspect(&fixture.record()).unwrap_err(), HALF_REMOVED);
    let record = read_working_copy(&fixture.data, &fixture.record());
    assert!(record.reclaimed(), "{record:?}");
    assert_eq!((record.status.as_str(), record.branch.as_deref(), record.error.as_deref()), ("ready", Some(BRANCH), None));
    assert!(!fixture.path.exists() && !fixture.registered());
    let back = send(&fixture, &record).unwrap().unwrap();
    assert!(!back.reclaimed());
    assert!(fixture.path.join("work.txt").exists() && fixture.path.join("README.md").exists());
}

/// A half-removed folder on a detached HEAD whose commit no branch has stays, locked with its commit, until a branch has
/// it; then Refresh finishes it on that commit, and a send puts it back detached on the commit.
#[test]
fn a_detached_removal_waits_for_its_commit_to_be_on_a_branch() {
    let fixture = Fixture::new();
    sh_git(&fixture.path, &["checkout", "-q", "--detach"]);
    fs::write(fixture.path.join("loose.txt"), "on no branch\n").unwrap();
    sh_git(&fixture.path, &["add", "."]);
    sh_git(&fixture.path, &["commit", "-q", "-m", "Loose"]);
    let commit = sh_git(&fixture.path, &["rev-parse", "HEAD"]);
    fixture.lock_for_removal();
    let mut detached = fixture.record();
    detached.branch = None;

    let record = read_working_copy(&fixture.data, &detached);
    assert_eq!(record.status, "error");
    assert_eq!(record.error.unwrap(), format!("Sotto started removing this worktree’s folder, which has no branch checked out, and no branch or remote branch has its commit {} any more. Nothing more was removed. Create a branch at that commit, then choose Refresh to finish removing the folder.", &commit[..7]));
    assert!(fixture.path.join("loose.txt").exists() && fixture.registered(), "nothing more was removed");

    sh_git(&fixture.repo, &["branch", "keep-loose", &commit]);
    let record = read_working_copy(&fixture.data, &detached);
    assert!(record.reclaimed() && record.branch.is_none());
    assert_eq!(record.extra.get("detachedCommit"), Some(&json!(commit)));
    assert!(!fixture.path.exists());
    let back = send(&fixture, &record).unwrap().unwrap();
    assert!(!back.reclaimed() && back.extra.get("detachedCommit").is_none());
    assert_eq!(sh_git(&fixture.path, &["rev-parse", "HEAD"]), commit);
    assert_eq!(fixture.checked_out(), "", "detached on its commit");
}

/// A folder a `git worktree remove` cut off before #1297 left, its `.git` file and some files gone, has nothing more
/// deleted: Refresh writes its `.git` back and puts back the missing tracked files, and what the user added stays.
#[test]
fn a_refresh_repairs_a_partly_removed_folder() {
    let fixture = Fixture::new();
    fs::write(fixture.path.join("notes.txt"), "the user's\n").unwrap();
    fs::remove_file(fixture.path.join(".git")).unwrap();
    fs::remove_file(fixture.path.join("work.txt")).unwrap();
    let record = read_working_copy(&fixture.data, &fixture.record());
    assert_eq!((record.status.as_str(), record.error.as_deref()), ("ready", None), "{record:?}");
    assert!(!record.reclaimed());
    assert_eq!(fs::read_to_string(fixture.path.join("work.txt")).unwrap().trim_end(), "the thread's work");
    assert_eq!(fs::read_to_string(fixture.path.join("notes.txt")).unwrap(), "the user's\n");
    assert_eq!(fixture.checked_out(), BRANCH);
    let listing = sh_git(&fixture.repo, &["worktree", "list", "--porcelain", "-z"]);
    assert!(registered_worktrees(&listing).iter().all(|entry| !entry.locked), "the repair's lock is let go");
}

/// Restore branch on a shared project checkout, as Node's `restoreThreadBranch`: refused before a send recorded a branch
/// and for a thread on a worktree of its own; back to the sent branch when the folder is clean; with uncommitted work on
/// another branch, only after the user's answer, which carries the work across; and refused for a branch that is gone.
#[test]
fn restore_branch_goes_back_to_the_sent_branch_as_node_does() {
    let fixture = Fixture::new();
    let shared = AgentThreadWorktree { mode: "shared".into(), path: Some(text(&fixture.repo)), repository_root: None, branch: None, reused: None, temporary_branch: None, ..fixture.record() };
    let restore = |record: &AgentThreadWorktree, with: bool| restore_thread_branch(&fixture.data, record, with);

    assert_eq!(restore(&shared, false).unwrap_err().0, NOTHING_SENT_YET);
    assert_eq!(restore(&fixture.record(), false).unwrap_err().0, NO_CHECKOUT_TO_SWITCH);

    // The send reads the checkout with Git the first time, and records its repository and the branch it went to.
    let sent = send(&fixture, &shared).unwrap().unwrap();
    assert_eq!(sent.branch.as_deref(), Some("main"));
    assert_eq!(sent.extra.get("sentBranch"), Some(&json!("main")));
    assert_eq!(sent.repository_root.as_deref().map(|root| path_key(Path::new(root))), Some(path_key(&fixture.repo)));
    assert_eq!(send(&fixture, &sent).unwrap(), None, "then from its own files");

    sh_git(&fixture.repo, &["switch", "-q", "-c", "elsewhere"]);
    let back = restore(&sent, false).unwrap();
    assert_eq!(sh_git(&fixture.repo, &["branch", "--show-current"]), "main");
    assert_eq!((back.branch.as_deref(), back.extra.get("sentBranch")), (Some("main"), Some(&json!("main"))));

    sh_git(&fixture.repo, &["switch", "-q", "elsewhere"]);
    fs::write(fixture.repo.join("README.md"), "changed\n").unwrap();
    let (words, kept) = restore(&back, false).unwrap_err();
    assert_eq!(words, RESTORE_BRANCH_NEEDS_CONFIRMATION);
    let kept = *kept.unwrap();
    assert_eq!((kept.branch.as_deref(), kept.extra.get("dirty"), kept.extra.get("sentBranch")), (Some("elsewhere"), Some(&json!(true)), Some(&json!("main"))));
    assert_eq!(sh_git(&fixture.repo, &["branch", "--show-current"]), "elsewhere", "nothing moved");
    let moved = restore(&kept, true).unwrap();
    assert_eq!(sh_git(&fixture.repo, &["branch", "--show-current"]), "main");
    assert_eq!(fs::read_to_string(fixture.repo.join("README.md")).unwrap(), "changed\n", "the work came across");
    assert_eq!(moved.extra.get("dirty"), Some(&json!(true)));

    sh_git(&fixture.repo, &["switch", "-q", "elsewhere"]);
    let mut gone = moved;
    gone.extra.insert("sentBranch".into(), json!("deleted-branch"));
    assert_eq!(restore(&gone, true).unwrap_err().0, "The branch deleted-branch no longer exists in this repository. Nothing was changed.");
    gone.extra.insert("sentBranch".into(), json!("-x"));
    assert_eq!(restore(&gone, true).unwrap_err().0, "That branch name cannot be restored. Switch it in the folder itself.");
    assert_eq!(sh_git(&fixture.repo, &["branch", "--show-current"]), "elsewhere");
}
