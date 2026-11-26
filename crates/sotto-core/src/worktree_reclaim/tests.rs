//! Each of ADR-0041's guards on a real repository and a real `git worktree`, as Node's own tests of `reclaim` hold them.

use super::*;
use std::process::Command;

const BRANCH: &str = "sotto/reclaim-test";
const FOLDER: &str = "0f6b3d0e-7a5c-4c1e-9a43-3f1d2b8e4c10";

fn sh_git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.name=Sotto Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "init.defaultBranch=main"])
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// A repository with one commit, and a thread's own worktree of it on its own branch in the data folder's reserved place.
struct Fixture {
    _dir: tempfile::TempDir,
    base: PathBuf,
    data: PathBuf,
    repo: PathBuf,
    path: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        Self::at(FOLDER)
    }

    fn at(name: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = realpath(dir.path()).unwrap();
        let data = base.join("data");
        let repo = base.join("repo");
        fs::create_dir_all(data.join(THREAD_WORKTREE_FOLDER)).unwrap();
        fs::create_dir_all(&repo).unwrap();
        sh_git(&repo, &["init", "-q"]);
        fs::write(repo.join("README.md"), "hello\n").unwrap();
        fs::write(repo.join(".gitignore"), "build/\nnode_modules/\n").unwrap();
        sh_git(&repo, &["add", "."]);
        sh_git(&repo, &["commit", "-q", "-m", "First"]);
        let path = data.join(THREAD_WORKTREE_FOLDER).join(name);
        sh_git(&repo, &["worktree", "add", "-q", "-b", BRANCH, &text(&path)]);
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

    fn reclaim(&self, options: &ReclaimOptions) -> Result<AgentThreadWorktree, String> {
        reclaim(&self.data, &self.record(), options)
    }

    fn registered(&self) -> bool {
        let listing = sh_git(&self.repo, &["worktree", "list", "--porcelain", "-z"]);
        registered_worktrees(&listing).iter().any(|entry| path_key(Path::new(&entry.path)) == path_key(&self.path))
    }

    fn branch_kept(&self) -> bool {
        Command::new("git").args(["rev-parse", "--verify", "--quiet", &format!("refs/heads/{BRANCH}")]).current_dir(&self.repo).status().unwrap().success()
    }

    /// Asserts nothing was removed: the folder, its files and Git's registration are all there.
    fn kept(&self) {
        assert!(self.path.join("README.md").exists(), "the folder's files stay");
        assert!(self.registered(), "Git still registers the folder");
        assert!(self.branch_kept());
    }

    /// Everything the preview listed, confirmed as Delete thread… and Remove worktree send it back.
    fn confirm_all(&self, with_uncommitted_changes: bool) -> ReclaimOptions {
        let facts = reclaim_facts(&self.record()).unwrap();
        ReclaimOptions {
            confirmed_ignored: Some(facts.ignored.clone()),
            confirmed_items: Some(facts.items.iter().map(|item| (item.path.clone(), item.file_count)).collect()),
            confirmed_repositories: Some(facts.repositories.clone()),
            with_uncommitted_changes,
        }
    }
}

/// A link at `link` to the folder `target`: a symbolic link, or on Windows a junction, which needs no privilege.
fn link_folder(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(target, link).is_err() {
            let status = Command::new("cmd").args(["/C", "mklink", "/J", &text(link), &text(target)]).output().unwrap();
            assert!(status.status.success(), "{}", String::from_utf8_lossy(&status.stdout));
        }
    }
}

/// A clean worktree on its branch goes, and only it: the branch keeps its commit, Git forgets the folder, and the record
/// comes back reclaimed on its branch with the incoming ref it was made from gone, as Node's `reclaimedRecord` and
/// `withoutIncomingRef` leave it.
#[test]
fn removes_a_clean_worktree_and_keeps_its_branch() {
    let fixture = Fixture::new();
    let facts = reclaim_facts(&fixture.record()).unwrap();
    assert_eq!(facts.to_json(), json!({ "path": text(&fixture.path), "branch": BRANCH, "dirty": false, "ignored": [], "items": [], "repositories": [], "untracked": [] }));
    let incoming = "refs/sotto/incoming/7c1b0a4e-2f3d-4e5a-8b6c-9d0e1f2a3b4c/feature";
    sh_git(&fixture.repo, &["update-ref", incoming, "HEAD"]);
    let mut record = fixture.record();
    record.extra.insert("incomingRef".into(), json!(incoming));
    record.extra.insert("dirty".into(), json!(false));
    let reclaimed = reclaim(&fixture.data, &record, &ReclaimOptions::default()).unwrap();
    assert!(!fixture.path.exists(), "the folder is gone");
    assert!(!fixture.registered(), "Git no longer registers it");
    assert!(fixture.branch_kept(), "the branch keeps its commits");
    assert_eq!(reclaimed.branch.as_deref(), Some(BRANCH));
    assert_eq!(reclaimed.status, "ready");
    assert_eq!(reclaimed.temporary_branch, Some(true), "the branch it was made on is still the thread's to rename");
    assert!(reclaimed.extra.get("reclaimedAt").and_then(Value::as_str).is_some_and(|at| at.ends_with('Z')));
    assert!(!reclaimed.extra.contains_key("dirty") && !reclaimed.extra.contains_key("incomingRef"));
    assert!(!Command::new("git").args(["rev-parse", "--verify", "--quiet", incoming]).current_dir(&fixture.repo).status().unwrap().success(), "the incoming ref goes with the folder");
    assert!(fixture.repo.join("README.md").exists(), "the project's own checkout is untouched");
}

/// Only a worktree Sotto made for this thread, in its reserved folder under a token name, is ever removed.
#[test]
fn refuses_a_folder_that_is_not_this_threads_own() {
    let fixture = Fixture::new();
    for (mode, reused) in [("shared", Some(false)), ("independent", Some(true))] {
        let record = AgentThreadWorktree { mode: mode.into(), reused, ..fixture.record() };
        assert_eq!(reclaim(&fixture.data, &record, &ReclaimOptions::default()).unwrap_err(), "Only a worktree Sotto made for this thread can be removed. A shared or reused folder stays.");
    }
    fixture.kept();
    // A folder outside the reserved one, and one there not named as Sotto names its own, are not Sotto's to remove.
    let elsewhere = fixture.base.join("elsewhere").join(FOLDER);
    sh_git(&fixture.repo, &["worktree", "add", "-q", "-b", "sotto/elsewhere", &text(&elsewhere)]);
    let named = fixture.data.join(THREAD_WORKTREE_FOLDER).join("not-a-token");
    sh_git(&fixture.repo, &["worktree", "add", "-q", "-b", "sotto/named", &text(&named)]);
    for path in [&elsewhere, &named] {
        let record = AgentThreadWorktree { path: Some(text(path)), ..fixture.record() };
        assert_eq!(reclaim(&fixture.data, &record, &ReclaimOptions::default()).unwrap_err(), "This folder is outside Sotto’s reserved worktree folder. Nothing was changed.");
        assert!(path.join("README.md").exists());
    }
}

/// A folder moved away, or a different checkout in its place, is no longer the thread's: nothing is removed from either.
#[test]
fn refuses_a_moved_or_replaced_folder() {
    let fixture = Fixture::new();
    let moved = fixture.base.join("moved");
    sh_git(&fixture.repo, &["worktree", "move", &text(&fixture.path), &text(&moved)]);
    let refused = fixture.reclaim(&ReclaimOptions::default()).unwrap_err();
    assert_eq!(refused, format!("The folder {} is not there any more. Move it back, or add the project again from where it is now.", text(&fixture.path)));
    assert!(reclaim_facts(&fixture.record()).is_err(), "the preview cannot read it either");
    assert!(moved.join("README.md").exists(), "the moved folder is untouched");
    // Another repository's worktree where the thread's was.
    let other = fixture.base.join("other");
    fs::create_dir_all(&other).unwrap();
    sh_git(&other, &["init", "-q"]);
    fs::write(other.join("README.md"), "other\n").unwrap();
    sh_git(&other, &["add", "."]);
    sh_git(&other, &["commit", "-q", "-m", "Other"]);
    sh_git(&other, &["worktree", "add", "-q", "-b", "elsewhere", &text(&fixture.path)]);
    assert_eq!(fixture.reclaim(&ReclaimOptions::default()).unwrap_err(), "The working folder is no longer this thread’s Git worktree. Restore its checkout before continuing.");
    assert!(fixture.path.join("README.md").exists(), "the checkout in its place is untouched");
    assert!(moved.join("README.md").exists());
}

/// A folder reached through a link is not the folder Sotto made.
#[test]
fn refuses_a_folder_reached_through_a_link() {
    let fixture = Fixture::new();
    let real = fixture.base.join("real");
    sh_git(&fixture.repo, &["worktree", "move", &text(&fixture.path), &text(&real)]);
    link_folder(&real, &fixture.path);
    assert_eq!(fixture.reclaim(&ReclaimOptions::default()).unwrap_err(), "The working folder is no longer this thread’s Git worktree. Restore its checkout before continuing.");
    assert!(real.join("README.md").exists());
}

/// A worktree Git holds locked stays, whoever locked it; one Sotto's own removal locked says so in Node's words.
#[test]
fn refuses_a_locked_worktree() {
    let fixture = Fixture::new();
    sh_git(&fixture.repo, &["worktree", "lock", "--reason", "kept by hand", &text(&fixture.path)]);
    assert_eq!(fixture.reclaim(&ReclaimOptions::default()).unwrap_err(), "Git has locked this worktree or reports an incomplete checkout. Restore the checkout before continuing.");
    fixture.kept();
    sh_git(&fixture.repo, &["worktree", "unlock", &text(&fixture.path)]);
    sh_git(&fixture.repo, &["worktree", "lock", "--reason", REMOVING_LOCK_REASON, &text(&fixture.path)]);
    assert_eq!(fixture.reclaim(&ReclaimOptions::default()).unwrap_err(), HALF_REMOVED);
    fixture.kept();
}

/// Uncommitted work goes only after the user's answer.
#[test]
fn keeps_uncommitted_work_until_the_user_confirms_it() {
    let fixture = Fixture::new();
    fs::write(fixture.path.join("README.md"), "changed\n").unwrap();
    assert!(reclaim_facts(&fixture.record()).unwrap().dirty);
    assert_eq!(fixture.reclaim(&ReclaimOptions::default()).unwrap_err(), RECLAIM_WORKTREE_NEEDS_CONFIRMATION);
    assert_eq!(fs::read_to_string(fixture.path.join("README.md")).unwrap(), "changed\n");
    fixture.reclaim(&ReclaimOptions { with_uncommitted_changes: true, ..Default::default() }).unwrap();
    assert!(!fixture.path.exists());
    assert!(fixture.branch_kept());
}

/// Ignored files other than installed dependencies are listed with what they hold, and go only when the user confirmed
/// exactly that list and those counts.
#[test]
fn keeps_ignored_files_until_the_user_confirms_exactly_them() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.path.join("build")).unwrap();
    fs::write(fixture.path.join("build").join("out.txt"), "12345").unwrap();
    fs::create_dir_all(fixture.path.join("node_modules").join("left-pad")).unwrap();
    fs::write(fixture.path.join("node_modules").join("left-pad").join("index.js"), "x").unwrap();
    let facts = reclaim_facts(&fixture.record()).unwrap();
    assert_eq!(facts.ignored, ["build/"], "installed dependencies are not asked about");
    assert_eq!(facts.items, [Item { path: "build/".into(), bytes: 5, file_count: 1 }]);
    assert!(!facts.dirty);
    let ignored = |list: &[&str]| Some(list.iter().map(ToString::to_string).collect());
    assert_eq!(fixture.reclaim(&ReclaimOptions::default()).unwrap_err(), "This folder holds ignored files. Nothing was removed. Choose Remove worktree to review them.");
    assert_eq!(
        fixture.reclaim(&ReclaimOptions { confirmed_ignored: ignored(&["dist/"]), ..Default::default() }).unwrap_err(),
        "The ignored items changed. Nothing was removed. Close this question and choose Remove worktree again to review them."
    );
    assert_eq!(
        fixture.reclaim(&ReclaimOptions { confirmed_ignored: ignored(&["build/"]), ..Default::default() }).unwrap_err(),
        "The folder changed. Nothing was removed. Choose Remove worktree again to see the new list."
    );
    assert_eq!(
        fixture.reclaim(&ReclaimOptions { confirmed_ignored: ignored(&["build/"]), confirmed_items: Some(vec![("build/".into(), 2)]), ..Default::default() }).unwrap_err(),
        "The folder changed. Nothing was removed. Choose Remove worktree again to see the new list.",
        "a count that is not the folder's"
    );
    fixture.kept();
    assert!(fixture.path.join("build").join("out.txt").exists());
    fixture.reclaim(&fixture.confirm_all(false)).unwrap();
    assert!(!fixture.path.exists());
    assert!(fixture.branch_kept());
}

/// A repository inside the folder with commits no remote has is nested work: listed with its unpushed commits and its
/// files, and removed only when the user confirmed that row, its files and the uncommitted change it makes.
#[test]
fn keeps_unpushed_nested_work_until_the_user_confirms_it() {
    let fixture = Fixture::new();
    let nested = fixture.path.join("nested");
    fs::create_dir_all(&nested).unwrap();
    sh_git(&nested, &["init", "-q"]);
    fs::write(nested.join("work.txt"), "mine").unwrap();
    sh_git(&nested, &["add", "."]);
    sh_git(&nested, &["commit", "-q", "-m", "Unpushed"]);
    let facts = reclaim_facts(&fixture.record()).unwrap();
    assert_eq!(facts.repositories, [RepositoryRow { path: "nested/".into(), change_count: 0, unpushed_commit_count: Some(1), kind: "repository", fetched_by_hash: None }]);
    assert_eq!(facts.ignored, ["nested/"], "nested work is an item to tick");
    assert_eq!(facts.items.len(), 1);
    assert!(facts.items[0].file_count > 1, "its files, its history included, are counted: {:?}", facts.items);
    assert!(facts.dirty, "Git sees the repository as untracked");
    let confirmed = fixture.confirm_all(true);
    assert_eq!(
        fixture.reclaim(&ReclaimOptions { confirmed_repositories: None, ..confirmed.clone() }).unwrap_err(),
        "The nested work changed. Nothing was removed. Choose Remove worktree again to review it."
    );
    let more = RepositoryRow { unpushed_commit_count: Some(2), ..facts.repositories[0].clone() };
    assert_eq!(
        fixture.reclaim(&ReclaimOptions { confirmed_repositories: Some(vec![more]), ..confirmed.clone() }).unwrap_err(),
        "The nested work changed. Nothing was removed. Choose Remove worktree again to review it.",
        "a row that is not the folder's"
    );
    assert_eq!(fixture.reclaim(&ReclaimOptions { with_uncommitted_changes: false, ..confirmed.clone() }).unwrap_err(), RECLAIM_WORKTREE_NEEDS_CONFIRMATION);
    assert!(nested.join("work.txt").exists());
    fixture.kept();
    fixture.reclaim(&confirmed).unwrap();
    assert!(!fixture.path.exists());
}

/// Another repository's worktree inside the folder is nested work of the `worktree` kind; once confirmed it goes with
/// the folder, and its registration is cleared in its own repository, as Node's `clearNestedWorktree` clears it.
#[test]
fn clears_a_nested_worktrees_registration_in_its_own_repository() {
    let fixture = Fixture::new();
    let other = fixture.base.join("other");
    fs::create_dir_all(&other).unwrap();
    sh_git(&other, &["init", "-q"]);
    fs::write(other.join("README.md"), "other\n").unwrap();
    sh_git(&other, &["add", "."]);
    sh_git(&other, &["commit", "-q", "-m", "Other"]);
    let nested = fixture.path.join("nested-wt");
    sh_git(&other, &["worktree", "add", "-q", "-b", "nested", &text(&nested)]);
    let facts = reclaim_facts(&fixture.record()).unwrap();
    assert_eq!(facts.repositories, [RepositoryRow { path: "nested-wt/".into(), change_count: 0, unpushed_commit_count: None, kind: "worktree", fetched_by_hash: None }]);
    fixture.reclaim(&fixture.confirm_all(true)).unwrap();
    assert!(!fixture.path.exists());
    let listing = sh_git(&other, &["worktree", "list", "--porcelain", "-z"]);
    assert!(!registered_worktrees(&listing).iter().any(|entry| path_key(Path::new(&entry.path)) == path_key(&nested)), "its registration went with it");
    assert!(other.join("README.md").exists(), "its own repository stays");
}

/// A detached HEAD's folder goes only under a rule or a clear; the user's own removal asks for a branch.
#[test]
fn refuses_a_detached_head() {
    let fixture = Fixture::new();
    sh_git(&fixture.path, &["checkout", "-q", "--detach"]);
    let facts = reclaim_facts(&fixture.record()).unwrap();
    assert_eq!(facts.branch, None);
    assert_eq!(fixture.reclaim(&ReclaimOptions::default()).unwrap_err(), DETACHED_NEEDS_BRANCH);
    assert_eq!(worktree_deletion_hold(&fixture.record(), true).0, Some(crate::thread_clearing::KeptReason::WorktreeError));
    assert!(fixture.path.join("README.md").exists());
}

/// A link out of the folder keeps it, so removing it never touches what the link leads to. One that stays inside does not.
#[test]
fn refuses_a_folder_holding_a_link_out_of_itself() {
    let fixture = Fixture::new();
    let outside = fixture.base.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("precious.txt"), "keep").unwrap();
    fs::create_dir_all(fixture.path.join("inner")).unwrap();
    link_folder(&fixture.path.join("inner"), &fixture.path.join("inward"));
    assert_eq!(reclaim_facts(&fixture.record()).unwrap().outside_link, None, "a link that stays inside is no reason");
    link_folder(&outside, &fixture.path.join("escape"));
    let facts = reclaim_facts(&fixture.record()).unwrap();
    assert_eq!(facts.outside_link.as_deref(), Some("escape"));
    assert_eq!(
        fixture.reclaim(&ReclaimOptions::default()).unwrap_err(),
        "This folder contains a link to another folder (escape). Remove the link first so nothing outside the folder is touched. Nothing was changed."
    );
    // Delete thread… names uncommitted work before the link, as Node's `worktreeDeletionHold` does: the new link is both.
    assert_eq!(worktree_deletion_hold(&fixture.record(), true).0, Some(crate::thread_clearing::KeptReason::Uncommitted));
    assert!(outside.join("precious.txt").exists());
    fixture.kept();
}

/// Delete thread…'s own read of the folder, as Node's `worktreeDeletionHold`: a folder another thread works in is in use,
/// uncommitted work keeps it, and a clean folder may go with its facts for the question.
#[test]
fn reads_why_a_deletion_keeps_the_folder() {
    use crate::thread_clearing::KeptReason;
    let fixture = Fixture::new();
    assert_eq!(worktree_deletion_hold(&fixture.record(), false), (Some(KeptReason::WorktreeInUse), None));
    let (kept, facts) = worktree_deletion_hold(&fixture.record(), true);
    assert_eq!(kept, None);
    assert_eq!(facts.unwrap().branch.as_deref(), Some(BRANCH));
    fs::write(fixture.path.join("new.txt"), "x").unwrap();
    assert_eq!(worktree_deletion_hold(&fixture.record(), true).0, Some(KeptReason::Uncommitted));
    let missing = AgentThreadWorktree { path: Some(text(&fixture.base.join("gone"))), ..fixture.record() };
    assert_eq!(worktree_deletion_hold(&missing, true), (Some(KeptReason::WorktreeError), None));
}

/// Another thread works in the folder when its own folder, or the nearest one of it that is there, is in that checkout.
#[test]
fn finds_another_thread_working_in_the_folder() {
    let fixture = Fixture::new();
    let folder = text(&fixture.path);
    let project = text(&fixture.repo);
    assert!(owns_checkout_alone(&folder, &[]));
    assert!(owns_checkout_alone(&folder, &[Some(project.clone())]), "the project's own checkout is another checkout");
    assert!(!owns_checkout_alone(&folder, &[Some(folder.clone())]));
    fs::create_dir_all(fixture.path.join("sub")).unwrap();
    assert!(!owns_checkout_alone(&folder, &[Some(text(&fixture.path.join("sub")))]), "a subfolder of it");
    assert!(!owns_checkout_alone(&folder, &[Some(text(&fixture.path.join("sub").join("missing")))]), "a missing folder read through its parent");
    assert!(!owns_checkout_alone(&folder, &[None]), "a thread with no folder leaves ownership unproven");
}

/// The command's shape, as Node's strict schema reads `preview-reclaim-thread-worktree` and `reclaim-thread-worktree`, and
/// its confirmations as Node's `confirmedWorktreeFiles` passes them on.
#[test]
fn reads_reclaim_commands_as_nodes_schema_reads_them() {
    let read = |command: Value| reclaim_command_shape(command.as_object().unwrap());
    assert!(read(json!({ "type": "preview-reclaim-thread-worktree", "threadId": "t" })));
    assert!(read(json!({ "type": "reclaim-thread-worktree", "threadId": "t", "afterSettle": true, "withUncommittedChanges": false, "confirmedIgnored": ["a/"],
        "confirmedItems": [{ "path": "a/", "fileCount": 1 }], "confirmedRepositories": [{ "path": "r/", "changeCount": 0, "kind": "worktree" }] })));
    for refused in [
        json!({ "type": "preview-reclaim-thread-worktree", "threadId": "t", "afterSettle": true }),
        json!({ "type": "reclaim-thread-worktree", "threadId": "" }),
        json!({ "type": "reclaim-thread-worktree", "threadId": "t", "afterSettle": false }),
        json!({ "type": "reclaim-thread-worktree", "threadId": "t", "withUncommittedChanges": "yes" }),
        json!({ "type": "reclaim-thread-worktree", "threadId": "t", "confirmedItems": [{ "path": "a/", "fileCount": -1 }] }),
        json!({ "type": "reclaim-thread-worktree", "threadId": "t", "later": 1 }),
    ] {
        assert!(!read(refused.clone()), "{refused}");
    }
    let options = ReclaimOptions::from_command(
        json!({ "type": "reclaim-thread-worktree", "threadId": "t", "withUncommittedChanges": true, "confirmedIgnored": ["a/"], "confirmedItems": [{ "path": "a/", "fileCount": 3.0 }],
            "confirmedRepositories": [{ "path": "r/", "changeCount": 1, "unpushedCommitCount": 2, "kind": "repository", "fetchedByHash": { "remote": "origin", "commitCount": 1 } }] })
        .as_object()
        .unwrap(),
    );
    assert_eq!(options, ReclaimOptions {
        confirmed_ignored: Some(vec!["a/".into()]),
        confirmed_items: Some(vec![("a/".into(), 3)]),
        confirmed_repositories: Some(vec![RepositoryRow { path: "r/".into(), change_count: 1, unpushed_commit_count: Some(2), kind: "repository", fetched_by_hash: Some(FetchedByHash { remote: "origin".into(), commit_count: 1 }) }]),
        with_uncommitted_changes: true,
    });
}

/// A fetch's source as Git writes it in FETCH_HEAD, as Node's `fetchHeadSource` and `FETCHED_BY_HASH` read it.
#[test]
fn reads_fetch_head_as_node_does() {
    assert_eq!(fetch_head_source("https://user:secret@example.com/team/repo.git/"), "https://example.com/team/repo");
    assert_eq!(fetch_head_source("git@example.com:team/repo.git"), "example.com:team/repo");
    assert_eq!(fetch_head_source("C:/repos/a@b"), "C:/repos/a@b");
    assert_eq!(fetch_head_source("a.git"), "a.git", "Git keeps the ending of a name that short");
    let commit = "0123456789abcdef0123456789abcdef01234567";
    assert_eq!(fetched_by_hash_line(&format!("{commit}\tnot-for-merge\t'{}' of https://example.com/repo", commit.to_uppercase())), Some((commit.into(), "https://example.com/repo".into())));
    assert_eq!(fetched_by_hash_line(&format!("{commit}\t\tbranch 'main' of https://example.com/repo")), None);
    assert_eq!(fetched_by_hash_line(&format!("{commit}\t\t'{commit}' of https://example.com/repo\r")), None);
}

/// The removal itself deletes everything but the kept names, and a link inside goes as itself, never what it leads to.
#[test]
fn removes_contents_without_following_links() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("root");
    let outside = dir.path().join("outside");
    fs::create_dir_all(root.join("a").join("b")).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("precious.txt"), "keep").unwrap();
    fs::write(root.join("a").join("b").join("file.txt"), "x").unwrap();
    fs::write(root.join(".git"), "gitdir: elsewhere").unwrap();
    link_folder(&outside, &root.join("a").join("link"));
    remove_folder_contents(&root, &[".git"], REMOVAL_STALL).unwrap();
    assert_eq!(fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name()).collect::<Vec<_>>(), [std::ffi::OsString::from(".git")]);
    assert!(outside.join("precious.txt").exists());
}
