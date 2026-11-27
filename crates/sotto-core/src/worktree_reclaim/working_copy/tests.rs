//! Choosing a thread's working copy and taking an existing worktree at its first send, on real repositories and real
//! `git worktree`s, as Node's `selectedWorkingCopy` and `allocate` make the records.

use super::*;
use serde_json::json;
use std::process::Command;

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

/// A repository with one commit, a data folder beside it, and a worktree of it the user made on branch `user-work`.
struct Fixture {
    _dir: tempfile::TempDir,
    base: PathBuf,
    data: PathBuf,
    repo: PathBuf,
    user: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = realpath(dir.path()).unwrap();
        let (data, repo, user) = (base.join("data"), base.join("repo"), base.join("user-worktree"));
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&repo).unwrap();
        sh_git(&repo, &["init", "-q"]);
        fs::write(repo.join("README.md"), "hello\n").unwrap();
        sh_git(&repo, &["add", "."]);
        sh_git(&repo, &["commit", "-q", "-m", "First"]);
        sh_git(&repo, &["worktree", "add", "-q", "-b", "user-work", &text(&user)]);
        fs::write(user.join("draft.txt"), "the user's own work\n").unwrap();
        Fixture { _dir: dir, base, data, repo, user }
    }

    fn repo(&self) -> String {
        text(&self.repo)
    }
}

fn command(fields: Value) -> Map<String, Value> {
    let mut command = json!({ "type": "configure-thread-working-copy", "threadId": "00000000-0000-4000-8000-000000000001" });
    command.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
    command.as_object().unwrap().clone()
}

/// Only the strict schema's shape is read: the two working copies, the optional fields as their types within their
/// limits counted in UTF-16 code units, and nothing else.
#[test]
fn reads_the_command_as_nodes_strict_schema_does() {
    let read = |fields: Value| WorkingCopySelection::from_command(&command(fields));
    assert_eq!(read(json!({ "workingCopy": "shared" })), Some(WorkingCopySelection { shared: true, base_branch: None, start_from_origin: None, existing_worktree_path: None }));
    assert_eq!(
        read(json!({ "workingCopy": "independent", "baseBranch": "hotfix", "startFromOrigin": true, "existingWorktreePath": "C:/wt/0" })),
        Some(WorkingCopySelection { shared: false, base_branch: Some("hotfix".into()), start_from_origin: Some(true), existing_worktree_path: Some("C:/wt/0".into()) })
    );
    for refused in [
        json!({}),
        json!({ "workingCopy": "elsewhere" }),
        json!({ "workingCopy": "shared", "baseBranch": "" }),
        json!({ "workingCopy": "shared", "baseBranch": null }),
        json!({ "workingCopy": "independent", "startFromOrigin": "yes" }),
        json!({ "workingCopy": "independent", "existingWorktreePath": "" }),
        json!({ "workingCopy": "independent", "existingWorktreePath": "x".repeat(4097) }),
        json!({ "workingCopy": "independent", "baseBranch": "😀".repeat(257) }),
        json!({ "workingCopy": "shared", "extra": true }),
        json!({ "workingCopy": "shared", "threadId": "" }),
    ] {
        assert_eq!(read(refused.clone()), None, "{refused}");
    }
    assert!(read(json!({ "workingCopy": "independent", "baseBranch": "😀".repeat(256), "existingWorktreePath": "x".repeat(4096) })).is_some());
}

/// The shared project folder is recorded where any link in it leads and read as Git has it now; a new worktree is only
/// recorded, to be made at the first send; an existing one carries the branch the project lists it with. No folder moves.
#[test]
fn records_the_chosen_working_copy_as_node_does() {
    let fixture = Fixture::new();
    fs::write(fixture.repo.join("README.md"), "changed\n").unwrap();
    let shared = WorkingCopySelection { shared: true, base_branch: None, start_from_origin: None, existing_worktree_path: None };
    let record = selected_working_copy(&fixture.data, &fixture.repo(), &shared).unwrap();
    assert_eq!((record.mode.as_str(), record.status.as_str()), ("shared", "ready"));
    assert_eq!(record.path.as_deref(), Some(fixture.repo().as_str()));
    assert_eq!(record.branch.as_deref(), Some("main"));
    assert_eq!(record.extra.get("dirty"), Some(&Value::Bool(true)));
    assert!(record.repository_root.is_some());

    let new = WorkingCopySelection { shared: false, base_branch: Some("main".into()), start_from_origin: Some(true), existing_worktree_path: None };
    let record = selected_working_copy(&fixture.data, &fixture.repo(), &new).unwrap();
    let expected = json!({ "mode": "independent", "status": "pending", "baseBranch": "main", "startFromOrigin": true });
    assert_eq!(serde_json::to_value(&record).unwrap(), expected);

    let existing = WorkingCopySelection { shared: false, base_branch: None, start_from_origin: None, existing_worktree_path: Some(text(&fixture.user)) };
    let record = selected_working_copy(&fixture.data, &fixture.repo(), &existing).unwrap();
    let expected = json!({ "mode": "independent", "status": "pending", "existingWorktreePath": text(&fixture.user), "branch": "user-work" });
    assert_eq!(serde_json::to_value(&record).unwrap(), expected);

    // A folder the project does not list is recorded all the same, without a branch: the first send refuses it.
    let elsewhere = fixture.base.join("elsewhere");
    let unknown = WorkingCopySelection { existing_worktree_path: Some(text(&elsewhere)), ..existing };
    let record = selected_working_copy(&fixture.data, &fixture.repo(), &unknown).unwrap();
    assert_eq!((record.branch, record.existing_worktree_path), (None, Some(text(&elsewhere))));
    assert_eq!(fs::read_to_string(fixture.user.join("draft.txt")).unwrap(), "the user's own work\n");
}

/// A project in a subfolder of its repository works in the same subfolder of the existing worktree, as Node's
/// `allocate` records `projectRelativePath` and `workingDirectory` reads it.
#[test]
fn works_in_the_projects_place_in_an_existing_worktree() {
    let fixture = Fixture::new();
    let app = fixture.repo.join("packages").join("app");
    fs::create_dir_all(&app).unwrap();
    fs::write(app.join("index.txt"), "app\n").unwrap();
    sh_git(&fixture.repo, &["add", "."]);
    sh_git(&fixture.repo, &["commit", "-q", "-m", "App"]);
    let other = fixture.base.join("other-worktree");
    sh_git(&fixture.repo, &["worktree", "add", "-q", "-b", "other-work", &text(&other)]);
    let record = existing_worktree(&text(&app), &text(&other)).unwrap();
    assert_eq!(record.extra.get("projectRelativePath"), Some(&json!("packages/app")));
    assert_eq!(project_working_directory(&record).unwrap(), text(&other.join("packages").join("app")));
}

/// The project folder gone is Node's words for it, and nothing is recorded.
#[test]
fn a_missing_project_folder_is_refused() {
    let fixture = Fixture::new();
    let gone = fixture.base.join("gone");
    let shared = WorkingCopySelection { shared: true, base_branch: None, start_from_origin: None, existing_worktree_path: None };
    let words = selected_working_copy(&fixture.data, &text(&gone), &shared).unwrap_err();
    assert_eq!(words, format!("The folder {} is not there any more. Move it back, or add the project again from where it is now.", text(&gone)));
}

/// At the first send, an existing worktree the repository lists is taken as the user's own, with its repository and
/// branch; a folder it does not list, and one it has locked, are refused in Node's words, and nothing is removed.
#[test]
fn takes_only_an_available_existing_worktree() {
    let fixture = Fixture::new();
    let record = existing_worktree(&fixture.repo(), &text(&fixture.user)).unwrap();
    assert_eq!((record.mode.as_str(), record.status.as_str(), record.reused), ("independent", "ready", Some(true)));
    assert_eq!(record.path.as_deref(), Some(text(&fixture.user).as_str()));
    assert_eq!(record.repository_root.as_deref(), Some(fixture.repo().as_str()));
    assert_eq!(record.branch.as_deref(), Some("user-work"));
    assert_eq!(record.extra.get("projectRelativePath"), Some(&json!("")));

    let plain = fixture.base.join("plain");
    fs::create_dir_all(&plain).unwrap();
    assert_eq!(existing_worktree(&fixture.repo(), &text(&plain)).unwrap_err(), NOT_AN_AVAILABLE_WORKTREE);
    assert_eq!(existing_worktree(&fixture.repo(), &fixture.repo()).map(|record| record.reused), Ok(Some(true)), "the main checkout is a worktree Git lists");

    sh_git(&fixture.repo, &["worktree", "lock", "--", &text(&fixture.user)]);
    assert_eq!(existing_worktree(&fixture.repo(), &text(&fixture.user)).unwrap_err(), NOT_AN_AVAILABLE_WORKTREE);
    assert_eq!(fs::read_to_string(fixture.user.join("draft.txt")).unwrap(), "the user's own work\n");
    assert!(plain.is_dir());

    // A project that is not a repository has no worktrees: the thread works in the project folder, as Node's `allocate`.
    let record = existing_worktree(&text(&plain), &text(&fixture.user)).unwrap();
    assert_eq!(serde_json::to_value(&record).unwrap(), json!({ "mode": "shared", "status": "ready", "path": text(&plain) }));
}
