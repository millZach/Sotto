//! Pull, Switch branch and Initialize Git on real repositories, with a bare repository in the test's own folder as
//! `origin`, as Node's own tests of `GitActions` hold them: nothing reaches the network.

use super::*;
use serde_json::json;
use std::fs;
use std::path::PathBuf;
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

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn commit(cwd: &Path, file: &str, content: &str) {
    fs::write(cwd.join(file), content).unwrap();
    sh_git(cwd, &["add", "."]);
    sh_git(cwd, &["commit", "-q", "-m", file]);
}

/// A bare `origin` with one commit on `main`, and two clones of it: `ours`, where the commands run, and `theirs`, which
/// moves `origin` on.
struct Remote {
    _dir: tempfile::TempDir,
    ours: PathBuf,
    theirs: PathBuf,
}

impl Remote {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = crate::worktree_reclaim::realpath(dir.path()).unwrap();
        let (origin, seed, ours, theirs) = (base.join("origin.git"), base.join("seed"), base.join("ours"), base.join("theirs"));
        fs::create_dir_all(&seed).unwrap();
        sh_git(&base, &["init", "-q", "--bare", &text(&origin)]);
        sh_git(&seed, &["init", "-q"]);
        commit(&seed, "README.md", "hello\n");
        sh_git(&seed, &["remote", "add", "origin", &text(&origin)]);
        sh_git(&seed, &["push", "-q", "origin", "main"]);
        sh_git(&seed, &["push", "-q", "origin", "main:topic"]);
        for clone in [&ours, &theirs] {
            sh_git(&base, &["clone", "-q", &text(&origin), &text(clone)]);
        }
        Remote { _dir: dir, ours, theirs }
    }

    fn ours(&self) -> String {
        text(&self.ours)
    }
}

#[test]
fn reads_only_the_shape_nodes_schema_reads() {
    let read = |command: serde_json::Value| LocalGitCommand::from_command(command.as_object().unwrap());
    assert_eq!(read(json!({ "type": "git-pull", "threadId": "t" })), Some(LocalGitCommand::Pull));
    assert_eq!(read(json!({ "type": "git-init", "threadId": "t" })), Some(LocalGitCommand::Init));
    assert_eq!(read(json!({ "type": "git-switch-branch", "threadId": "t", "ref": "main" })), Some(LocalGitCommand::SwitchBranch { reference: "main".into(), create: false }));
    assert_eq!(read(json!({ "type": "git-switch-branch", "threadId": "t", "ref": "new", "create": true })), Some(LocalGitCommand::SwitchBranch { reference: "new".into(), create: true }));
    for refused in [
        json!({ "type": "git-pull" }),
        json!({ "type": "git-pull", "threadId": "" }),
        json!({ "type": "git-pull", "threadId": "x".repeat(513) }),
        json!({ "type": "git-pull", "threadId": "t", "ref": "main" }),
        json!({ "type": "git-init", "threadId": 1 }),
        json!({ "type": "git-switch-branch", "threadId": "t" }),
        json!({ "type": "git-switch-branch", "threadId": "t", "ref": "" }),
        json!({ "type": "git-switch-branch", "threadId": "t", "ref": "b".repeat(513) }),
        json!({ "type": "git-switch-branch", "threadId": "t", "ref": "main", "create": null }),
        json!({ "type": "git-switch-branch", "threadId": "t", "ref": "main", "create": "yes" }),
    ] {
        assert_eq!(read(refused.clone()), None, "{refused}");
    }
    // 512 UTF-16 code units is the most, as `z.string().max(512)` counts them.
    assert!(read(json!({ "type": "git-switch-branch", "threadId": "t", "ref": "😀".repeat(256) })).is_some());
    assert!(read(json!({ "type": "git-switch-branch", "threadId": "t", "ref": format!("{}a", "😀".repeat(256)) })).is_none());
}

#[test]
fn says_each_notice_in_nodes_words() {
    assert_eq!(switched_notice("feature", true), "Created and switched to feature.");
    assert_eq!(switched_notice("feature", false), "Switched to feature.");
    let pulled = Pulled { moved: true, branch: "main".into(), upstream: "origin/main".into() };
    assert_eq!(pulled.notice(), "Pulled. Updated main from origin/main.");
    assert_eq!(Pulled { moved: false, ..pulled }.notice(), "Already up to date. main matches origin/main.");
}

#[test]
fn creates_and_switches_branches_and_refuses_what_node_refuses() {
    let remote = Remote::new();
    let cwd = remote.ours();
    assert_eq!(switch_branch(&cwd, "feature", true), Ok(Some("feature".into())));
    assert_eq!(switch_branch(&cwd, "feature", true), Err("The branch feature already exists. Switch to it instead.".into()));
    assert_eq!(switch_branch(&cwd, "main", false), Ok(Some("main".into())));
    for invalid in ["-x", "  ", "\u{feff}", "bad..name", "ends.lock"] {
        assert_eq!(switch_branch(&cwd, invalid, false), Err("Enter a valid branch name.".into()), "{invalid:?}");
    }
    let unknown = switch_branch(&cwd, "nowhere", false).unwrap_err();
    assert!(unknown.starts_with("Failed to switch ref. ") && unknown.contains("nowhere"), "{unknown}");
    assert_eq!(sh_git(&remote.ours, &["branch", "--show-current"]), "main");
}

#[test]
fn switching_to_a_remote_branch_tracks_it_once() {
    let remote = Remote::new();
    let cwd = remote.ours();
    assert_eq!(switch_branch(&cwd, "origin/topic", false), Ok(Some("topic".into())));
    assert_eq!(sh_git(&remote.ours, &["rev-parse", "--abbrev-ref", "topic@{upstream}"]), "origin/topic");
    switch_branch(&cwd, "main", false).unwrap();
    // The branch already tracking it is the one checked out, and no second one is made.
    assert_eq!(switch_branch(&cwd, "origin/topic", false), Ok(Some("topic".into())));
    assert_eq!(sh_git(&remote.ours, &["branch", "--list", "--format=%(refname:short)"]), "main\ntopic");
}

#[test]
fn a_switch_that_would_overwrite_uncommitted_work_is_refused_and_keeps_it() {
    let remote = Remote::new();
    let cwd = remote.ours();
    switch_branch(&cwd, "other", true).unwrap();
    commit(&remote.ours, "README.md", "on other\n");
    switch_branch(&cwd, "main", false).unwrap();
    fs::write(remote.ours.join("README.md"), "uncommitted\n").unwrap();
    let refused = switch_branch(&cwd, "other", false).unwrap_err();
    assert!(refused.starts_with("Failed to switch ref. "), "{refused}");
    assert_eq!(fs::read_to_string(remote.ours.join("README.md")).unwrap(), "uncommitted\n");
    assert_eq!(sh_git(&remote.ours, &["branch", "--show-current"]), "main");
}

#[test]
fn initializes_a_folder_once() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = text(dir.path());
    assert_eq!(init(&cwd), Ok(()));
    assert!(dir.path().join(".git").is_dir());
    assert_eq!(init(&cwd), Err("This folder is already a Git repository.".into()));
    // A folder inside a repository is in one, as Node's status read finds it.
    let inner = dir.path().join("inner");
    fs::create_dir_all(&inner).unwrap();
    assert_eq!(init(&text(&inner)), Err("This folder is already a Git repository.".into()));
    assert!(!inner.join(".git").exists());
}

#[test]
fn pulls_only_a_fast_forward_from_a_local_origin() {
    let remote = Remote::new();
    let cwd = remote.ours();
    let up_to_date = Pulled { moved: false, branch: "main".into(), upstream: "origin/main".into() };
    assert_eq!(pull(&cwd), Ok(up_to_date.clone()));

    commit(&remote.theirs, "theirs.txt", "from theirs\n");
    sh_git(&remote.theirs, &["push", "-q", "origin", "main"]);
    assert_eq!(pull(&cwd), Ok(Pulled { moved: true, ..up_to_date.clone() }));
    assert!(remote.ours.join("theirs.txt").is_file());

    // Both sides moved: nothing is merged or rebased, and our commit stays.
    commit(&remote.ours, "ours.txt", "from ours\n");
    let ours_head = sh_git(&remote.ours, &["rev-parse", "HEAD"]);
    commit(&remote.theirs, "again.txt", "again\n");
    sh_git(&remote.theirs, &["push", "-q", "origin", "main"]);
    assert_eq!(pull(&cwd), Err("Branch has diverged from upstream. Rebase/merge first.".into()));
    assert_eq!(sh_git(&remote.ours, &["rev-parse", "HEAD"]), ours_head);
}

#[test]
fn refuses_a_pull_with_nothing_to_pull_from() {
    let remote = Remote::new();
    let cwd = remote.ours();
    switch_branch(&cwd, "local-only", true).unwrap();
    assert_eq!(pull(&cwd), Err("Current branch has no upstream configured. Push with upstream first.".into()));
    sh_git(&remote.ours, &["checkout", "-q", "--detach"]);
    assert_eq!(pull(&cwd), Err("Cannot pull from detached HEAD.".into()));
    let plain = tempfile::tempdir().unwrap();
    assert_eq!(pull(&text(plain.path())), Err("This folder is not a Git repository.".into()));
}

/// An `origin` that is gone: Git's last two lines, on one line.
#[test]
fn a_pull_git_refuses_says_what_git_said() {
    let remote = Remote::new();
    let gone = remote.ours.parent().unwrap().join("gone.git");
    sh_git(&remote.ours, &["remote", "set-url", "origin", &text(&gone)]);
    let refused = pull(&remote.ours()).unwrap_err();
    assert!(refused.starts_with("Pull failed. ") && refused.contains("the repository exists"), "{refused}");
    assert!(!refused.contains('\n'), "{refused}");
}

#[test]
fn keeps_what_node_keeps_of_what_git_said() {
    assert_eq!(safe_remote("fatal: unable to access 'https://user:token@host/repo.git/': no"), "fatal: unable to access 'https://host/repo.git/': no");
    assert_eq!(safe_remote("HTTPS://me@host and ssh://git@host/x and http://a@b"), "HTTPS://host and ssh://host/x and http://b");
    assert_eq!(safe_remote("https://@host https://no-at/host git@host:x"), "https://@host https://no-at/host git@host:x");
    assert_eq!(last_two_lines("one\ntwo\nthree"), "two three");
    assert_eq!(last_two_lines("only"), "only");
    assert_eq!(refused_with("Pull failed.", "", 600), "Pull failed.");
    assert_eq!(refused_with("Pull failed.", &"é".repeat(700), 600).encode_utf16().count(), "Pull failed. ".len() + 600);
}

/// A thread whose folder was never a repository, then is one: Initialize Git reads its shared record again so the record
/// says it is a repository on `main`, and the choices on the record are kept.
#[test]
fn initialize_git_reads_a_shared_folder_again() {
    let dir = tempfile::tempdir().unwrap();
    let folder = text(&crate::worktree_reclaim::realpath(dir.path()).unwrap());
    let mut record = shared_working_copy(None, &folder).unwrap();
    assert_eq!(record.branch, None);
    record.extra.insert("sentBranch".into(), json!("earlier"));
    let thread = ThreadFolder { worktree: Some(record), working_directory: Some(folder.clone()), project_path: folder.clone(), started: true };
    let (kept, done) = run(dir.path(), &thread, &LocalGitCommand::Init);
    assert_eq!(done, Ok(INITIALIZED_NOTICE.into()));
    let kept = kept.expect("the record says it is a repository now");
    assert_eq!(kept.mode, "shared");
    assert_eq!(kept.path.as_deref(), Some(folder.as_str()));
    assert!(kept.repository_root.is_some());
    assert_eq!(kept.extra.get("sentBranch"), Some(&json!("earlier")));
    commit(dir.path(), "README.md", "hello\n");
    // A switch made here moves the branch of the last send with it.
    let thread = ThreadFolder { worktree: Some(kept), ..thread };
    let (kept, done) = run(dir.path(), &thread, &LocalGitCommand::SwitchBranch { reference: "feature".into(), create: true });
    assert_eq!(done, Ok("Created and switched to feature.".into()));
    let kept = kept.unwrap();
    assert_eq!((kept.branch.as_deref(), kept.extra.get("sentBranch")), (Some("feature"), Some(&json!("feature"))));
}

/// A record that is not ready refuses in its own words, and a folder that is gone in Node's, before Git runs.
#[test]
fn refuses_a_folder_that_is_not_ready_or_gone() {
    let dir = tempfile::tempdir().unwrap();
    let folder = text(&crate::worktree_reclaim::realpath(dir.path()).unwrap());
    let mut record = shared_working_copy(None, &folder).unwrap();
    record.status = "error".into();
    record.error = Some("The worktree could not be made.".into());
    record.path = None;
    let thread = ThreadFolder { worktree: Some(record), working_directory: None, project_path: folder.clone(), started: true };
    assert_eq!(run(dir.path(), &thread, &LocalGitCommand::Init).1, Err("The worktree could not be made.".into()));
    assert!(!dir.path().join(".git").exists());
    let gone = format!("{folder}/gone");
    let thread = ThreadFolder { worktree: None, working_directory: Some(gone.clone()), project_path: folder, started: false };
    assert_eq!(run(dir.path(), &thread, &LocalGitCommand::Init).1, Err(format!("The folder {gone} is not there any more. Move it back, or add the project again from where it is now.")));
}

/// Writes `hook` in `repository`'s hooks folder as a shell script Git can run, here and on Windows.
fn write_hook(repository: &Path, hook: &str, script: &str) {
    let path = repository.join(".git").join("hooks").join(hook);
    fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
}

/// A hook that leaves a process holding Git's output open once Git has exited does not hold the command past its
/// deadline: it settles on Node's timer, the deadline and two seconds' grace, as "did not finish in time"
/// (`spawnCommand` in `src/main/agents/git/gitStatus.ts`), rather than wait for the process to let go.
#[test]
fn settles_on_its_deadline_when_a_hook_holds_the_output_after_git_exits() {
    let remote = Remote::new();
    sh_git(&remote.ours, &["branch", "other"]);
    write_hook(&remote.ours, "post-checkout", "#!/bin/sh\nsleep 8 &\nexit 0\n");
    let started = std::time::Instant::now();
    let switched = git(&remote.ours(), &["checkout", "other", "--"], Duration::from_secs(1));
    let took = started.elapsed();
    assert_eq!(switched, Err("git did not finish in time.".to_string()));
    assert!(took < Duration::from_secs(5), "settled after {took:?}, past the deadline and its grace");
}

/// A Git write stopped at its deadline is sent SIGTERM, as Node's `child.kill()` sends it, so Git removes the
/// `index.lock` it holds before it goes and the next Git write in the checkout is not refused. SIGKILL would leave the
/// lock behind. Unix only: Windows has no SIGTERM, and Node's stop there is TerminateProcess, as this host's is.
#[cfg(unix)]
#[test]
fn a_switch_stopped_at_its_deadline_leaves_no_index_lock() {
    let remote = Remote::new();
    sh_git(&remote.ours, &["checkout", "-q", "-b", "slow"]);
    fs::write(remote.ours.join(".gitattributes"), "*.slow filter=slow\n").unwrap();
    commit(&remote.ours, "big.slow", "slow\n");
    sh_git(&remote.ours, &["checkout", "-q", "main"]);
    // Checking `big.slow` out passes it through a filter that takes longer than the deadline, with the index locked.
    sh_git(&remote.ours, &["config", "filter.slow.smudge", "sleep 5; cat"]);
    let switched = git(&remote.ours(), &["checkout", "slow", "--"], Duration::from_secs(1));
    assert_eq!(switched, Err("git did not finish in time.".to_string()));
    assert!(!remote.ours.join(".git").join("index.lock").exists(), "Git was stopped without the chance to remove its lock");
}

/// A folder a Git action holds refuses Pull, Switch branch and Initialize Git until it is let go, as Node's one busy map
/// in `GitActions` holds all of them.
#[test]
fn a_folder_a_git_action_holds_refuses_pull_switch_and_init() {
    let remote = Remote::new();
    let empty = tempfile::tempdir().unwrap();
    let held = [Exclusive::hold(&remote.ours()).unwrap(), Exclusive::hold(&text(empty.path())).unwrap()];
    assert_eq!(pull(&remote.ours()).unwrap_err(), "Git action in progress.");
    assert_eq!(switch_branch(&remote.ours(), "topic", false).unwrap_err(), "Git action in progress.");
    assert_eq!(init(&text(empty.path())).unwrap_err(), "Git action in progress.");
    assert_eq!(publish(&remote.ours(), "org/repo", "private").unwrap_err(), "Git action in progress.");
    drop(held);
    assert!(pull(&remote.ours()).is_ok());
    assert_eq!(switch_branch(&remote.ours(), "topic", false).unwrap(), Some("topic".into()));
    assert!(init(&text(empty.path())).is_ok());
}

#[test]
fn git_publish_validates_schema_repo_name_existing_origin_and_lost_reply() {
    assert_eq!(
        LocalGitCommand::from_command(json!({ "type": "git-publish", "threadId": "t1", "repository": "org/app", "visibility": "private" }).as_object().unwrap()),
        Some(LocalGitCommand::Publish { repository: "org/app".into(), visibility: "private".into() })
    );
    for bad in [
        json!({ "type": "git-publish", "threadId": "t1", "repository": "ab", "visibility": "private" }),
        json!({ "type": "git-publish", "threadId": "t1", "repository": "org/app", "visibility": "internal" }),
        json!({ "type": "git-publish", "threadId": "t1", "repository": "org/app", "visibility": "public", "extra": 1 }),
    ] {
        assert_eq!(LocalGitCommand::from_command(bad.as_object().unwrap()), None);
    }

    let empty = tempfile::tempdir().unwrap();
    let empty_str = text(empty.path());
    assert_eq!(
        publish_with_gh(&empty_str, "-bad/repo", "private", |_, _| Ok(String::new())),
        Err("Name the repository as owner/name.".into())
    );
    assert_eq!(
        publish_with_gh(&empty_str, "org/repo", "private", |_, _| Ok(String::new())),
        Err("Initialize Git before publishing.".into())
    );

    let remote = Remote::new();
    assert_eq!(
        publish_with_gh(&remote.ours(), "org/repo", "private", |_, _| Ok(String::new())),
        Err("This repository already has an origin remote.".into())
    );

    let repo = tempfile::tempdir().unwrap();
    let repo_str = text(repo.path());
    sh_git(repo.path(), &["init", "-q", "-b", "main"]);
    commit(repo.path(), "README.md", "hi\n");
    let url = publish_with_gh(&repo_str, "org/app", "public", |_, args| {
        assert!(args.contains(&"--public"));
        assert!(args.contains(&"--push"));
        Ok("https://github.com/org/app\n".into())
    })
    .unwrap();
    assert_eq!(url, "https://github.com/org/app");

    let bare = tempfile::tempdir().unwrap();
    sh_git(bare.path(), &["init", "--bare", "-q", "-b", "main"]);
    let bare_str = text(bare.path());
    let repo_str_clone = repo_str.clone();
    let recovered = publish_with_gh(&repo_str, "org/app", "private", move |_, _| {
        sh_git(Path::new(&repo_str_clone), &["remote", "add", "origin", &bare_str]);
        sh_git(Path::new(&repo_str_clone), &["push", "-q", "-u", "origin", "main"]);
        Err("connection reset".into())
    })
    .unwrap();
    assert_eq!(recovered, "https://github.com/org/app");
}
