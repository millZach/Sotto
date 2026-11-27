//! The stacked Git action on real repositories, with a bare repository in the test's own folder as `origin`, as Node's
//! own tests of `GitActions.runStackedAction` hold it (`tests/unit/main/gitActions.test.ts`). The provider's draft and
//! GitHub are stand-ins: nothing reaches the network or a provider.

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

fn sh_git_fails(cwd: &Path, args: &[&str]) {
    let out = Command::new("git").args(args).current_dir(cwd).output().unwrap();
    assert!(!out.status.success(), "git {args:?} was meant to fail");
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn commit_all(cwd: &Path, message: &str) {
    sh_git(cwd, &["add", "."]);
    sh_git(cwd, &["commit", "-q", "-m", message]);
}

/// The repository's own settings, so a commit the action makes needs nothing from the machine's.
fn configure(cwd: &Path) {
    for (key, value) in [("user.name", "Fixture"), ("user.email", "fixture@example.invalid"), ("commit.gpgSign", "false"), ("core.autocrlf", "false"), ("core.hooksPath", ".githooks")] {
        sh_git(cwd, &["config", key, value]);
    }
}

/// A repository on `main` with one commit, `First`, pushed to a bare `origin`, and a second clone that moves `origin`.
struct Fixture {
    dir: tempfile::TempDir,
    repo: PathBuf,
    remote: PathBuf,
    other: PathBuf,
}

impl Fixture {
    fn new(with_remote: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        let remote = dir.path().join("remote.git");
        let other = dir.path().join("other");
        fs::create_dir(&repo).unwrap();
        sh_git(&repo, &["init", "-q", "-b", "main"]);
        configure(&repo);
        fs::write(repo.join("work.txt"), "first\n").unwrap();
        commit_all(&repo, "First");
        if with_remote {
            sh_git(dir.path(), &["init", "-q", "--bare", "-b", "main", &text(&remote)]);
            sh_git(&repo, &["remote", "add", "origin", &text(&remote)]);
            sh_git(&repo, &["push", "-q", "-u", "origin", "main"]);
            sh_git(dir.path(), &["clone", "-q", &text(&remote), &text(&other)]);
            configure(&other);
        }
        Self { dir, repo, remote, other }
    }
    fn write(&self, file: &str, content: &str) {
        fs::write(self.repo.join(file), content).unwrap();
    }
    fn git(&self, args: &[&str]) -> String {
        sh_git(&self.repo, args)
    }
}

/// The provider and GitHub, stood in for: the draft it writes, what GitHub lists as open, and what each was asked.
struct StandIns {
    draft: Option<String>,
    open: Result<Option<OpenPullRequest>, String>,
    pull_request: Result<PullRequestStep, String>,
    drafts: Mutex<Vec<CommitMaterial>>,
    lookups: Mutex<Vec<String>>,
    pull_requests: Mutex<Vec<String>>,
}

impl StandIns {
    fn new() -> Self {
        Self {
            draft: Some("Write the commit from the diff\n\nBecause the fixture asked.".into()),
            open: Err("gh: not signed in".into()),
            pull_request: Err("gh: not signed in".into()),
            drafts: Mutex::default(),
            lookups: Mutex::default(),
            pull_requests: Mutex::default(),
        }
    }
}

impl GitActionServices for StandIns {
    fn write_commit_message(&self, _thread_id: &str, material: &CommitMaterial) -> Option<String> {
        self.drafts.lock().unwrap().push(material.clone());
        self.draft.clone()
    }
    fn open_pull_request(&self, _cwd: &str, branch: &str) -> Result<Option<OpenPullRequest>, String> {
        self.lookups.lock().unwrap().push(branch.to_string());
        self.open.clone()
    }
    fn pull_request(&self, _thread_id: &str, _cwd: &str, branch: &str, _progress: &Progress) -> Result<PullRequestStep, String> {
        self.pull_requests.lock().unwrap().push(branch.to_string());
        self.pull_request.clone()
    }
}

/// What an action reported, in order.
struct Events(Arc<Mutex<Vec<GitActionEvent>>>);

impl Events {
    fn new() -> (Self, Progress) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        (Self(events), Arc::new(move |event| sink.lock().unwrap().push(event)))
    }
    fn all(&self) -> Vec<GitActionEvent> {
        self.0.lock().unwrap().clone()
    }
    fn stages(&self) -> Vec<String> {
        self.all().into_iter().find_map(|event| match event {
            GitActionEvent::ActionStarted { stages, .. } => Some(stages),
            _ => None,
        }).unwrap_or_default()
    }
    fn phases(&self) -> Vec<GitActionPhase> {
        self.all().into_iter().filter_map(|event| match event {
            GitActionEvent::PhaseStarted { phase, .. } => Some(phase),
            _ => None,
        }).fold(Vec::new(), |mut phases, phase| {
            if phases.last() != Some(&phase) {
                phases.push(phase);
            }
            phases
        })
    }
}

fn quiet() -> Progress {
    Arc::new(|_| {})
}

fn input(cwd: &Path, action: GitStackedAction) -> GitActionInput {
    GitActionInput { thread_id: "t".into(), cwd: text(cwd), action, commit_message: None, feature_branch: None, file_paths: None, allow_default_branch: None }
}

fn with_message(mut input: GitActionInput, message: &str) -> GitActionInput {
    input.commit_message = Some(message.into());
    input
}

fn run(input: &GitActionInput, services: &StandIns) -> Result<GitActionResult, String> {
    run_stacked_action(input, true, services, &quiet())
}

fn hook(repo: &Path, name: &str, script: &str) {
    let hooks = repo.join(".githooks");
    fs::create_dir_all(&hooks).unwrap();
    let path = hooks.join(name);
    fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[test]
fn commits_everything_with_the_message_given_and_offers_push() {
    let f = Fixture::new(true);
    f.write("work.txt", "second\n");
    f.write("new.txt", "new\n");
    let services = StandIns::new();
    let (events, progress) = Events::new();
    let result = run_stacked_action(&with_message(input(&f.repo, GitStackedAction::Commit), "Second change.\n\nWith a body."), true, &services, &progress).unwrap();
    assert_eq!(result.commit.status, "created");
    assert_eq!(result.commit.subject.as_deref(), Some("Second change"));
    assert_eq!(f.git(&["log", "-1", "--pretty=%s%n%b"]), "Second change\nWith a body.");
    assert_eq!(f.git(&["status", "--porcelain"]), "");
    let sha = result.commit.sha.clone().unwrap();
    assert_eq!(result.toast, GitActionToast { title: format!("Committed {}", &sha[..7]), description: Some("Second change".into()), cta: GitActionCta::RunAction { label: "Push".into(), action: GitStackedAction::Push } });
    assert!(services.drafts.lock().unwrap().is_empty());
    assert_eq!(events.stages(), ["Committing..."]);
    // Git's own commit summary lines ride along as output, the way T3 passes every line on.
    let kinds: Vec<&str> = events.all().iter().filter(|event| !matches!(event, GitActionEvent::HookOutput { .. })).map(|event| match event {
        GitActionEvent::ActionStarted { .. } => "action_started",
        GitActionEvent::PhaseStarted { .. } => "phase_started",
        _ => "hook",
    }).collect();
    assert_eq!(kinds, ["action_started", "phase_started"]);
}

#[test]
fn commits_only_the_chosen_files_and_asks_the_provider_with_the_repository_conventions() {
    let f = Fixture::new(true);
    f.write("AGENTS.md", "# Rules\nSubjects in the imperative.\n");
    commit_all(&f.repo, "Add the rules");
    f.write("work.txt", "second\n");
    f.write("skip.txt", "not this one\n");
    // Staged beforehand, and still left out: the chosen files are the whole commit.
    f.git(&["add", "skip.txt"]);
    let services = StandIns::new();
    let (events, progress) = Events::new();
    let mut chosen = input(&f.repo, GitStackedAction::Commit);
    chosen.file_paths = Some(vec!["work.txt".into()]);
    let result = run_stacked_action(&chosen, true, &services, &progress).unwrap();
    assert_eq!(result.commit.subject.as_deref(), Some("Write the commit from the diff"));
    assert_eq!(f.git(&["log", "-1", "--pretty=%b"]), "Because the fixture asked.");
    let shown = f.git(&["show", "--stat", "--pretty=", "HEAD"]);
    assert!(shown.contains("work.txt") && !shown.contains("skip.txt"), "{shown}");
    assert_eq!(f.git(&["status", "--porcelain"]), "A  skip.txt");
    let drafts = services.drafts.lock().unwrap();
    let material = &drafts[0];
    assert!(material.diff.text.contains("+second"), "{}", material.diff.text);
    assert_eq!(material.subjects, ["Add the rules", "First"]);
    assert!(material.agents_file.as_deref().unwrap().contains("Subjects in the imperative"));
    assert!(material.name_status.split('\n').any(|line| line == "M\twork.txt"), "{}", material.name_status);
    assert_eq!(events.stages(), ["Generating commit message...", "Committing..."]);
}

#[test]
fn falls_back_to_a_stand_in_subject_when_the_provider_writes_nothing_and_skips_a_commit_with_nothing_to_commit() {
    let f = Fixture::new(true);
    f.write("work.txt", "second\n");
    let mut services = StandIns::new();
    services.draft = None;
    assert_eq!(run(&input(&f.repo, GitStackedAction::Commit), &services).unwrap().commit.subject.as_deref(), Some(STAND_IN_SUBJECT));
    let empty = run(&input(&f.repo, GitStackedAction::Commit), &services).unwrap();
    assert_eq!(empty.commit, CommitStep { status: "skipped_no_changes", sha: None, subject: None });
    assert_eq!(empty.toast, GitActionToast { title: "Nothing to commit".into(), description: Some("The working tree is clean.".into()), cta: GitActionCta::None });
}

#[test]
fn preserves_staged_hunks_and_excluded_staging() {
    for exclude in [false, true] {
        let f = Fixture::new(false);
        f.write("work.txt", "staged\n");
        f.git(&["add", "work.txt"]);
        f.write("work.txt", "staged\nunstaged\n");
        if exclude {
            f.write("skip.txt", "excluded\n");
            f.git(&["add", "skip.txt"]);
        }
        let mut press = with_message(input(&f.repo, GitStackedAction::Commit), "Commit staged hunk");
        if exclude {
            press.file_paths = Some(vec!["work.txt".into()]);
        }
        run(&press, &StandIns::new()).unwrap();
        assert_eq!(f.git(&["show", "HEAD:work.txt"]), "staged");
        assert_eq!(fs::read_to_string(f.repo.join("work.txt")).unwrap(), "staged\nunstaged\n");
        assert_eq!(f.git(&["diff", "--cached", "--name-only"]), if exclude { "skip.txt" } else { "" });
        assert_eq!(f.git(&["diff", "--name-only"]), "work.txt");
        assert!(f.git(&["diff", "--", "work.txt"]).contains("+unstaged"));
        if exclude {
            assert_eq!(f.git(&["show", ":skip.txt"]), "excluded");
        }
    }
}

#[test]
fn keeps_pathspecs_literal_when_adding_and_restoring_selected_staging() {
    let f = Fixture::new(false);
    f.write("[a].txt", "chosen\n");
    f.write("a.txt", "excluded\n");
    f.write("[skip].txt", "also excluded\n");
    f.git(&["add", "a.txt", "[skip].txt"]);
    let mut press = with_message(input(&f.repo, GitStackedAction::Commit), "Add literal filename");
    press.file_paths = Some(vec!["[a].txt".into()]);
    assert_eq!(run(&press, &StandIns::new()).unwrap().commit.status, "created");
    assert_eq!(f.git(&["show", "--pretty=", "--name-only", "HEAD"]), "[a].txt");
    assert_eq!(f.git(&["diff", "--cached", "--name-only"]), "[skip].txt\na.txt");
    assert_eq!(f.git(&["show", ":a.txt"]), "excluded");
}

#[test]
fn commits_both_ends_of_a_selected_rename_and_leaves_an_excluded_file_alone() {
    let f = Fixture::new(false);
    f.git(&["mv", "work.txt", "renamed.txt"]);
    f.write("skip.txt", "excluded\n");
    let mut press = with_message(input(&f.repo, GitStackedAction::Commit), "Rename work");
    press.file_paths = Some(vec!["renamed.txt".into()]);
    run(&press, &StandIns::new()).unwrap();
    assert_eq!(f.git(&["ls-tree", "--name-only", "HEAD"]), "renamed.txt");
    assert_eq!(f.git(&["status", "--porcelain"]), "?? skip.txt");
}

#[test]
fn commits_repository_relative_selected_paths_from_a_project_subfolder() {
    let f = Fixture::new(false);
    let sub = f.repo.join("sub");
    fs::create_dir(&sub).unwrap();
    fs::write(sub.join("chosen.txt"), "one\ntwo\n").unwrap();
    f.write("work.txt", "excluded\n");
    let mut press = with_message(input(&sub, GitStackedAction::Commit), "Add chosen file");
    press.file_paths = Some(vec!["sub/chosen.txt".into()]);
    assert_eq!(run(&press, &StandIns::new()).unwrap().commit.status, "created");
    assert_eq!(f.git(&["show", "--pretty=", "--name-only", "HEAD"]), "sub/chosen.txt");
    assert!(f.git(&["status", "--porcelain"]).contains("work.txt"));
}

#[test]
fn preserves_excluded_staging_when_committing_selected_files_in_an_unborn_repository() {
    let f = Fixture::new(false);
    let repo = f.dir.path().join("unborn");
    fs::create_dir(&repo).unwrap();
    sh_git(&repo, &["init", "-q", "-b", "main"]);
    configure(&repo);
    fs::write(repo.join("chosen.txt"), "chosen\n").unwrap();
    fs::write(repo.join("skip.txt"), "excluded\n").unwrap();
    sh_git(&repo, &["add", "skip.txt"]);
    let mut press = with_message(input(&repo, GitStackedAction::Commit), "First selected commit");
    press.file_paths = Some(vec!["chosen.txt".into()]);
    run(&press, &StandIns::new()).unwrap();
    assert_eq!(sh_git(&repo, &["ls-tree", "--name-only", "HEAD"]), "chosen.txt");
    assert_eq!(sh_git(&repo, &["diff", "--cached", "--name-only"]), "skip.txt");
}

#[test]
fn refuses_a_conflicted_stash_pop_before_changing_the_index_or_working_files() {
    let f = Fixture::new(false);
    f.write("work.txt", "stashed\n");
    f.git(&["stash", "push", "-qm", "Stashed edit"]);
    f.write("work.txt", "committed\n");
    commit_all(&f.repo, "Conflicting edit");
    sh_git_fails(&f.repo, &["stash", "pop"]);
    let (index, working, head) = (f.git(&["ls-files", "--unmerged"]), fs::read_to_string(f.repo.join("work.txt")).unwrap(), f.git(&["rev-parse", "HEAD"]));
    assert!(!index.is_empty());
    let refused = run(&with_message(input(&f.repo, GitStackedAction::Commit), "Refused"), &StandIns::new()).unwrap_err();
    assert_eq!(refused, "Resolve the conflicted files before committing here.");
    assert_eq!(f.git(&["ls-files", "--unmerged"]), index);
    assert_eq!(fs::read_to_string(f.repo.join("work.txt")).unwrap(), working);
    assert_eq!(f.git(&["rev-parse", "HEAD"]), head);
}

#[test]
fn restores_the_original_index_after_a_refused_commit_and_after_a_failed_staging() {
    let f = Fixture::new(false);
    f.write("work.txt", "staged\n");
    f.git(&["add", "work.txt"]);
    f.write("work.txt", "staged\nunstaged\n");
    f.write("skip.txt", "excluded\n");
    f.git(&["add", "skip.txt"]);
    let before = f.git(&["write-tree"]);
    let mut missing = with_message(input(&f.repo, GitStackedAction::Commit), "Refused");
    missing.file_paths = Some(vec!["missing.txt".into()]);
    let refused = run(&missing, &StandIns::new()).unwrap_err();
    assert!(refused.contains("pathspec"), "{refused}");
    assert_eq!(f.git(&["write-tree"]), before);
    hook(&f.repo, "pre-commit", "#!/bin/sh\nexit 1\n");
    let mut chosen = with_message(input(&f.repo, GitStackedAction::Commit), "Refused");
    chosen.file_paths = Some(vec!["work.txt".into()]);
    let refused = run(&chosen, &StandIns::new()).unwrap_err();
    assert!(refused.starts_with("Commit failed"), "{refused}");
    assert_eq!(f.git(&["write-tree"]), before);
    assert_eq!(fs::read_to_string(f.repo.join("work.txt")).unwrap(), "staged\nunstaged\n");
}

#[test]
fn streams_what_a_commit_hook_prints_names_the_hook_and_says_its_last_words_when_it_refuses() {
    let f = Fixture::new(false);
    hook(&f.repo, "pre-commit", "#!/bin/sh\necho \"checking the tree\"\necho \"still checking\" 1>&2\nexit 0\n");
    f.write("work.txt", "second\n");
    let (events, progress) = Events::new();
    let result = run_stacked_action(&with_message(input(&f.repo, GitStackedAction::Commit), "Hooked"), false, &StandIns::new(), &progress).unwrap();
    assert_eq!(result.commit.status, "created");
    let all = events.all();
    let output: Vec<&str> = all.iter().filter_map(|event| match event {
        GitActionEvent::HookOutput { text, .. } => Some(text.as_str()),
        _ => None,
    }).collect();
    assert!(output.contains(&"checking the tree") && output.contains(&"still checking"), "{output:?}");
    assert!(all.contains(&GitActionEvent::HookStarted { hook_name: "pre-commit".into() }), "{all:?}");
    assert!(all.contains(&GitActionEvent::HookFinished { hook_name: "pre-commit".into() }), "{all:?}");

    hook(&f.repo, "pre-commit", "#!/bin/sh\necho \"lint failed: trailing space\" 1>&2\nexit 1\n");
    f.write("work.txt", "third\n");
    let refused = run(&with_message(input(&f.repo, GitStackedAction::Commit), "Blocked"), &StandIns::new()).unwrap_err();
    assert!(refused.starts_with("Commit failed. ") && refused.contains("lint failed: trailing space"), "{refused}");
    assert_eq!(f.git(&["log", "-1", "--pretty=%s"]), "Hooked");
}

#[test]
fn commits_on_a_new_feature_branch_named_from_the_subject_unique_among_the_branches_there() {
    let f = Fixture::new(true);
    f.git(&["branch", "feature/second-change"]);
    f.write("work.txt", "second\n");
    let (events, progress) = Events::new();
    let mut press = with_message(input(&f.repo, GitStackedAction::Commit), "Second change");
    press.feature_branch = Some(true);
    let result = run_stacked_action(&press, true, &StandIns::new(), &progress).unwrap();
    assert_eq!(result.branch, BranchStep { status: "created", name: Some("feature/second-change-2".into()) });
    assert_eq!(f.git(&["branch", "--show-current"]), "feature/second-change-2");
    assert_eq!(f.git(&["log", "-1", "--pretty=%s"]), "Second change");
    assert_eq!(f.git(&["log", "-1", "--pretty=%s", "main"]), "First");
    assert_eq!(events.phases(), [GitActionPhase::Branch, GitActionPhase::Commit]);
    let mut again = input(&f.repo, GitStackedAction::Commit);
    again.feature_branch = Some(true);
    assert_eq!(run(&again, &StandIns::new()).unwrap_err(), "Cannot create a feature branch because there are no changes to commit.");
}

#[test]
fn pushes_from_the_default_branch_onto_a_feature_branch_named_after_the_last_commit() {
    let f = Fixture::new(true);
    f.write("work.txt", "second\n");
    commit_all(&f.repo, "Second change on main");
    let (events, progress) = Events::new();
    let mut press = input(&f.repo, GitStackedAction::Push);
    press.feature_branch = Some(true);
    let result = run_stacked_action(&press, true, &StandIns::new(), &progress).unwrap();
    assert_eq!(result.branch, BranchStep { status: "created", name: Some("feature/second-change-on-main".into()) });
    assert_eq!(result.push, PushStep { status: "pushed", branch: Some("feature/second-change-on-main".into()), upstream: Some("origin/feature/second-change-on-main".into()), set_upstream: Some(true) });
    assert_eq!(f.git(&["branch", "--show-current"]), "feature/second-change-on-main");
    assert!(sh_git(&f.other, &["ls-remote", "--heads", "origin", "feature/second-change-on-main"]).contains("feature/second-change-on-main"));
    assert!(sh_git(&f.other, &["ls-remote", "--heads", "origin", "main"]).contains(&f.git(&["rev-parse", "main~1"])));
    assert_eq!(events.phases(), [GitActionPhase::Branch, GitActionPhase::Push]);
}

#[test]
fn pushes_a_branch_with_no_upstream_by_setting_one_says_when_there_is_nothing_to_push_and_never_forces() {
    let f = Fixture::new(true);
    f.git(&["switch", "-q", "-c", "feature"]);
    f.write("work.txt", "feature\n");
    commit_all(&f.repo, "Feature work");
    let services = StandIns::new();
    let (events, progress) = Events::new();
    let pushed = run_stacked_action(&input(&f.repo, GitStackedAction::Push), true, &services, &progress).unwrap();
    assert_eq!(pushed.push, PushStep { status: "pushed", branch: Some("feature".into()), upstream: Some("origin/feature".into()), set_upstream: Some(true) });
    assert_eq!(f.git(&["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/feature");
    assert_eq!(sh_git(&f.remote, &["log", "-1", "--pretty=%s", "feature"]), "Feature work");
    // GitHub could not be asked, so the notice offers to create the pull request, as Node's does.
    assert_eq!(pushed.toast, GitActionToast { title: "Pushed to origin/feature".into(), description: None, cta: GitActionCta::RunAction { label: "Create PR".into(), action: GitStackedAction::CreatePr } });
    assert_eq!(*services.lookups.lock().unwrap(), ["feature"]);
    assert_eq!(events.stages(), ["Pushing to origin..."]);
    assert_eq!(run(&input(&f.repo, GitStackedAction::Push), &services).unwrap().push, PushStep { status: "skipped_up_to_date", branch: None, upstream: None, set_upstream: None });
    // The remote moves under the branch: the push is refused in T3's words and nothing is forced.
    fs::write(f.other.join("other.txt"), "remote\n").unwrap();
    commit_all(&f.other, "Remote commit");
    sh_git(&f.other, &["push", "-q"]);
    f.git(&["switch", "-q", "main"]);
    f.write("work.txt", "diverging\n");
    commit_all(&f.repo, "Diverging");
    let mut confirmed = input(&f.repo, GitStackedAction::Push);
    confirmed.allow_default_branch = Some(true);
    assert_eq!(run(&confirmed, &services).unwrap_err(), "Branch is behind upstream. Pull/rebase before pushing.");
    assert_eq!(sh_git(&f.remote, &["log", "-1", "--pretty=%s", "main"]), "Remote commit");
}

#[test]
fn a_push_on_a_branch_with_an_open_pull_request_offers_to_view_it() {
    let f = Fixture::new(true);
    f.git(&["switch", "-q", "-c", "feature"]);
    f.write("work.txt", "feature\n");
    let mut services = StandIns::new();
    services.open = Ok(Some(OpenPullRequest { number: 12, title: "Already open".into(), url: "https://github.com/o/r/pull/12".into(), base: "main".into() }));
    let result = run(&with_message(input(&f.repo, GitStackedAction::CommitPush), "Feature work"), &services).unwrap();
    let sha = result.commit.sha.clone().unwrap();
    assert_eq!(result.toast, GitActionToast { title: format!("Pushed {} to origin/feature", &sha[..7]), description: Some("Feature work".into()), cta: GitActionCta::OpenPr { label: "View PR".into(), url: "https://github.com/o/r/pull/12".into() } });
}

#[test]
fn commits_and_pushes_from_one_press_and_asks_for_the_default_branch_confirmation_first() {
    let f = Fixture::new(true);
    f.write("work.txt", "second\n");
    let services = StandIns::new();
    let press = with_message(input(&f.repo, GitStackedAction::CommitPush), "Second");
    assert_eq!(run(&press, &services).unwrap_err(), "Confirm pushing from the default branch first, or commit on a new branch.");
    assert_eq!(f.git(&["log", "-1", "--pretty=%s"]), "First");
    let mut pr = input(&f.repo, GitStackedAction::CommitPushPr);
    pr.commit_message = Some("Second".into());
    assert_eq!(run(&pr, &services).unwrap_err(), "Confirm creating a pull request from the default branch first, or commit on a new branch.");
    let mut confirmed = press.clone();
    confirmed.allow_default_branch = Some(true);
    let (events, progress) = Events::new();
    let result = run_stacked_action(&confirmed, true, &services, &progress).unwrap();
    assert_eq!(result.commit.subject.as_deref(), Some("Second"));
    assert_eq!(result.push, PushStep { status: "pushed", branch: Some("main".into()), upstream: Some("origin/main".into()), set_upstream: None });
    assert_eq!(sh_git(&f.remote, &["log", "-1", "--pretty=%s", "main"]), "Second");
    let sha = result.commit.sha.clone().unwrap();
    assert_eq!(result.toast, GitActionToast { title: format!("Pushed {} to origin/main", &sha[..7]), description: Some("Second".into()), cta: GitActionCta::None });
    assert_eq!(events.stages(), ["Committing...", "Pushing to origin..."]);
    // From the default branch the notice asks GitHub nothing.
    assert!(services.lookups.lock().unwrap().is_empty());
}

#[test]
fn refuses_a_pull_request_from_a_dirty_tree_or_a_detached_head_and_hands_the_pull_request_step_on() {
    let f = Fixture::new(true);
    f.git(&["switch", "-q", "-c", "feature"]);
    f.write("work.txt", "feature\n");
    commit_all(&f.repo, "Feature work");
    f.write("work.txt", "dirty\n");
    let mut services = StandIns::new();
    assert_eq!(run(&input(&f.repo, GitStackedAction::CreatePr), &services).unwrap_err(), "Commit local changes before creating a PR.");
    f.git(&["checkout", "-q", "--", "work.txt"]);
    f.git(&["push", "-q", "-u", "origin", "feature"]);
    services.pull_request = Ok(PullRequestStep { status: "opened_existing", url: Some("https://github.com/o/r/pull/12".into()), number: Some(12), base: Some("main".into()), head: Some("feature".into()), title: Some("Already open".into()) });
    let (events, progress) = Events::new();
    let result = run_stacked_action(&input(&f.repo, GitStackedAction::CreatePr), true, &services, &progress).unwrap();
    assert_eq!(result.push.status, NOT_REQUESTED);
    assert_eq!(*services.pull_requests.lock().unwrap(), ["feature"]);
    assert_eq!(result.toast, GitActionToast { title: "Opened PR #12".into(), description: Some("Already open".into()), cta: GitActionCta::OpenPr { label: "View PR".into(), url: "https://github.com/o/r/pull/12".into() } });
    assert_eq!(events.stages(), ["Preparing PR...", "Generating PR content...", "Creating pull request..."]);
    f.git(&["switch", "-q", "--detach"]);
    // With no upstream the action would push first, so the push refusal comes first, as in T3.
    assert_eq!(run(&input(&f.repo, GitStackedAction::CreatePr), &services).unwrap_err(), "Cannot push from detached HEAD.");
}

#[test]
fn refuses_in_t3s_words_no_files_chosen_no_remote_no_repository_a_merge_half_done() {
    let f = Fixture::new(false);
    f.write("work.txt", "second\n");
    let services = StandIns::new();
    let mut none = input(&f.repo, GitStackedAction::Commit);
    none.file_paths = Some(Vec::new());
    assert_eq!(run(&none, &services).unwrap_err(), "Choose at least one file to commit.");
    let mut push = with_message(input(&f.repo, GitStackedAction::CommitPush), "Second");
    push.allow_default_branch = Some(true);
    assert_eq!(run(&push, &services).unwrap_err(), "Cannot push because no git remote is configured for this repository.");
    // The commit stood; only the push was refused.
    assert_eq!(f.git(&["log", "-1", "--pretty=%s"]), "Second");
    let plain = f.dir.path().join("plain");
    fs::create_dir(&plain).unwrap();
    assert_eq!(run(&input(&plain, GitStackedAction::Commit), &services).unwrap_err(), "This folder is not a Git repository. Initialize Git first.");
    let mut branch_only = input(&f.repo, GitStackedAction::CreatePr);
    branch_only.feature_branch = Some(true);
    f.git(&["remote", "add", "origin", &text(&f.dir.path().join("nowhere.git"))]);
    f.git(&["config", "branch.main.remote", "origin"]);
    f.git(&["config", "branch.main.merge", "refs/heads/main"]);
    // A branch level with an upstream it tracks needs no push, so no feature branch can be cut for it.
    f.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
    assert_eq!(run(&branch_only, &services).unwrap_err(), "A feature branch is cut only for an action that commits or pushes.");
    // A merge in progress is the user's to finish: nothing is staged or committed over it.
    f.git(&["switch", "-q", "-c", "side", "HEAD~1"]);
    f.write("work.txt", "side\n");
    commit_all(&f.repo, "Side");
    f.git(&["switch", "-q", "main"]);
    sh_git_fails(&f.repo, &["merge", "side"]);
    let refused = run(&with_message(input(&f.repo, GitStackedAction::Commit), "Over the merge"), &services).unwrap_err();
    assert_eq!(refused, "A merge or rebase is in progress. Finish or abort it in a terminal before committing here.");
    assert!(!f.git(&["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_empty());
}

#[test]
fn publishes_a_topic_branch_cut_from_the_default_branch_under_its_own_name() {
    let f = Fixture::new(true);
    // Tracks origin/main, as `git switch -c` from a remote ref does.
    f.git(&["switch", "-q", "-c", "fix/main", "origin/main"]);
    assert_eq!(f.git(&["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/main");
    f.write("work.txt", "fix\n");
    commit_all(&f.repo, "Fix on a topic branch");
    let result = run(&input(&f.repo, GitStackedAction::Push), &StandIns::new()).unwrap();
    assert_eq!(result.push, PushStep { status: "pushed", branch: Some("fix/main".into()), upstream: Some("origin/fix/main".into()), set_upstream: Some(true) });
    assert_eq!(sh_git(&f.remote, &["log", "-1", "--pretty=%s", "main"]), "First");
    assert_eq!(sh_git(&f.remote, &["log", "-1", "--pretty=%s", "fix/main"]), "Fix on a topic branch");
    assert_eq!(f.git(&["config", "--get", "branch.fix/main.gh-merge-base"]), "main");
}

#[test]
fn pushes_to_a_configured_push_remote_in_a_triangular_workflow() {
    for setting in ["remote.pushDefault", "branch.main.pushRemote"] {
        let f = Fixture::new(true);
        let fork = f.dir.path().join("fork.git");
        sh_git(f.dir.path(), &["init", "-q", "--bare", "-b", "main", &text(&fork)]);
        f.git(&["remote", "add", "fork", &text(&fork)]);
        f.git(&["config", setting, "fork"]);
        f.write("work.txt", "second\n");
        commit_all(&f.repo, "Second");
        let mut press = input(&f.repo, GitStackedAction::Push);
        press.allow_default_branch = Some(true);
        let result = run(&press, &StandIns::new()).unwrap();
        assert_eq!(result.push, PushStep { status: "pushed", branch: Some("main".into()), upstream: Some("fork/main".into()), set_upstream: Some(true) }, "{setting}");
        assert_eq!(sh_git(&fork, &["log", "-1", "--pretty=%s", "main"]), "Second");
        assert_eq!(sh_git(&f.remote, &["log", "-1", "--pretty=%s", "main"]), "First");
    }
}

#[test]
fn runs_one_action_per_folder_at_a_time() {
    let f = Fixture::new(false);
    f.write("work.txt", "second\n");
    let held = Exclusive::hold(&text(&f.repo)).unwrap();
    assert_eq!(run(&with_message(input(&f.repo, GitStackedAction::Commit), "Third"), &StandIns::new()).unwrap_err(), "Git action in progress.");
    drop(held);
    assert_eq!(run(&with_message(input(&f.repo, GitStackedAction::Commit), "Third"), &StandIns::new()).unwrap().commit.status, "created");
}

#[test]
fn names_a_feature_branch_the_way_t3_does() {
    assert_eq!(feature_branch_name("Add the commit dialog!"), "feature/add-the-commit-dialog");
    assert_eq!(feature_branch_name("\"Quoted\" subject"), "feature/quoted-subject");
    assert_eq!(feature_branch_name("fix/keep-namespace"), "fix/keep-namespace");
    assert_eq!(feature_branch_name(""), "feature/update");
    assert_eq!(feature_branch_name("--Ünïcode  & spaces--"), "feature/n-code-spaces");
    assert!(feature_branch_name(&"x".repeat(100)).len() <= 64);
    assert_eq!(feature_branch_name(&format!("{}-tail", "a".repeat(59))), "feature/".to_string() + &"a".repeat(56));
}

#[test]
fn lists_the_stages_a_notice_shows_in_t3s_words() {
    assert_eq!(git_action_stages(GitStackedAction::CommitPushPr, false, true, Some("origin"), true, false), [
        "Preparing feature ref...", "Generating commit message...", "Committing...", "Pushing to origin...", "Preparing PR...", "Generating PR content...", "Creating pull request...",
    ]);
    assert_eq!(git_action_stages(GitStackedAction::CommitPush, true, false, None, false, false), ["Pushing..."]);
    assert_eq!(git_action_stages(GitStackedAction::CreatePr, false, false, None, false, false), ["Preparing PR...", "Generating PR content...", "Creating pull request..."]);
    assert_eq!(git_action_phases(GitStackedAction::CommitPushPr, true), [GitActionPhase::Branch, GitActionPhase::Commit, GitActionPhase::Push, GitActionPhase::Pr]);
    assert_eq!(git_action_phases(GitStackedAction::Commit, false), [GitActionPhase::Commit]);
}

#[test]
fn reads_the_command_as_nodes_strict_schema_does() {
    let base = json!({ "type": "git-action", "threadId": "t", "actionId": "123e4567-e89b-42d3-a456-426614174000", "action": "commit_push" });
    let read = |value: Value| GitActionCommand::from_command(value.as_object().unwrap());
    let command = read(base.clone()).unwrap();
    assert_eq!(command.action, GitStackedAction::CommitPush);
    assert_eq!((command.commit_message, command.feature_branch, command.file_paths, command.allow_default_branch), (None, None, None, None));
    let with = |key: &str, value: Value| {
        let mut command = base.clone();
        command[key] = value;
        command
    };
    let full = read(json!({ "type": "git-action", "threadId": "t", "actionId": "00000000-0000-0000-0000-000000000000", "action": "create_pr", "commitMessage": "m", "featureBranch": true, "filePaths": ["a.txt"], "allowDefaultBranch": false })).unwrap();
    assert_eq!((full.feature_branch, full.allow_default_branch, full.file_paths), (Some(true), Some(false), Some(vec!["a.txt".to_string()])));
    for refused in [
        with("extra", json!(1)),
        with("commitMessage", Value::Null),
        with("featureBranch", json!("yes")),
        with("action", json!("force_push")),
        with("actionId", json!("123e4567-e89b-02d3-a456-426614174000")),
        with("actionId", json!("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF")),
        with("threadId", json!("")),
        with("threadId", json!("t".repeat(513))),
        with("commitMessage", json!("m".repeat(10_001))),
        with("filePaths", json!([""])),
        with("filePaths", json!(vec!["a"; 2_001])),
    ] {
        assert!(read(refused.clone()).is_none(), "{refused}");
    }
    assert!(read(with("filePaths", json!([]))).is_some());
}

#[test]
fn keeps_the_record_as_nodes_run_git_action_does() {
    let mut progress = GitActionProgress::running("a", GitStackedAction::Commit, "2026-11-27T00:00:00.000Z".into());
    assert_eq!(serde_json::to_value(&progress).unwrap(), json!({
        "actionId": "a", "action": "commit", "status": "running", "phases": [], "phase": null, "stage": null, "hook": null,
        "startedAt": "2026-11-27T00:00:00.000Z", "finishedAt": null, "result": null, "error": null,
    }));
    progress.apply(&GitActionEvent::ActionStarted { phases: vec![GitActionPhase::Commit], stages: vec!["Committing...".into()] });
    progress.apply(&GitActionEvent::PhaseStarted { phase: GitActionPhase::Commit, stage: "Committing...".into() });
    progress.apply(&GitActionEvent::HookOutput { hook_name: None, text: "early".into() });
    assert_eq!(progress.hook, Some(GitActionHook { name: "hook".into(), output: Some("early".into()) }));
    progress.apply(&GitActionEvent::HookStarted { hook_name: "pre-commit".into() });
    progress.apply(&GitActionEvent::HookOutput { hook_name: None, text: "checking".into() });
    assert_eq!(progress.hook, Some(GitActionHook { name: "pre-commit".into(), output: Some("checking".into()) }));
    progress.apply(&GitActionEvent::HookFinished { hook_name: "pre-commit".into() });
    assert_eq!((progress.phase, progress.stage.as_deref(), progress.hook.as_ref()), (Some(GitActionPhase::Commit), Some("Committing..."), None));
    let mut result = GitActionResult::nothing_yet(GitStackedAction::Commit);
    result.commit = CommitStep { status: "created", sha: Some("abcdef1234".into()), subject: Some("Second".into()) };
    result.toast = GitActionToast { title: "Committed abcdef1".into(), description: Some("Second".into()), cta: GitActionCta::RunAction { label: "Push".into(), action: GitStackedAction::Push } };
    let mut done = progress.clone();
    done.finish(Ok(result), "2026-11-27T00:00:01.000Z".into());
    assert_eq!(serde_json::to_value(&done).unwrap(), json!({
        "actionId": "a", "action": "commit", "status": "done", "phases": ["commit"], "phase": null, "stage": null, "hook": null,
        "startedAt": "2026-11-27T00:00:00.000Z", "finishedAt": "2026-11-27T00:00:01.000Z", "error": null,
        "result": {
            "action": "commit", "branch": { "status": "skipped_not_requested" }, "commit": { "status": "created", "sha": "abcdef1234", "subject": "Second" },
            "push": { "status": "skipped_not_requested" }, "pr": { "status": "skipped_not_requested" },
            "toast": { "title": "Committed abcdef1", "description": "Second", "cta": { "kind": "run_action", "label": "Push", "action": "push" } },
        },
    }));
    progress.finish(Err("Commit failed. no".into()), "2026-11-27T00:00:01.000Z".into());
    assert_eq!((progress.status, progress.error.as_deref(), progress.result.is_none()), ("failed", Some("Commit failed. no"), true));
    let pushed = PushStep { status: "pushed", branch: Some("f".into()), upstream: Some("origin/f".into()), set_upstream: Some(true) };
    assert_eq!(serde_json::to_value(&pushed).unwrap(), json!({ "status": "pushed", "branch": "f", "upstream": "origin/f", "setUpstream": true }));
    let open = GitActionCta::OpenPr { label: "View PR".into(), url: "u".into() };
    assert_eq!(serde_json::to_value(&open).unwrap(), json!({ "kind": "open_pr", "label": "View PR", "url": "u" }));
    assert_eq!(serde_json::to_value(GitActionCta::None).unwrap(), json!({ "kind": "none" }));
}

#[test]
fn splits_a_message_and_cuts_a_diff_as_node_does() {
    assert_eq!(split_message("  Subject...  \n\n Body line \n"), CommitMessage { subject: "Subject".into(), body: "Body line".into() });
    assert_eq!(split_message("...\nbody"), CommitMessage { subject: STAND_IN_SUBJECT.into(), body: "body".into() });
    assert_eq!(split_message(&"s".repeat(80)).subject.len(), COMMIT_SUBJECT_MAX);
    assert_eq!(diff_excerpt(" a\r\nb \n", 100), DiffExcerpt { text: "a\nb".into(), truncated: false });
    let long = (0..400).map(|line| format!("line {line:03}")).collect::<Vec<_>>().join("\n");
    let cut = diff_excerpt(&long, 1_000);
    assert!(cut.truncated && cut.text.encode_utf16().count() <= 1_000);
    assert!(cut.text.ends_with(&format!("\n\n{TRUNCATION_NOTE}")));
    // Cut at the last whole line in the room it had.
    let kept = cut.text.strip_suffix(&format!("\n\n{TRUNCATION_NOTE}")).unwrap();
    assert!(kept.split('\n').all(|line| line.len() == 8), "{kept}");
    assert_eq!(hook_name_of(&["/repo/.githooks/pre-commit"]), "pre-commit");
    assert_eq!(hook_name_of(&["sh", "C:\\repo\\.git\\hooks\\commit-msg", "x"]), "commit-msg");
    assert_eq!(hook_name_of(&["sh", "-c", "run"]), "sh");
}

#[test]
fn reads_the_folder_as_nodes_status_reader_does() {
    let f = Fixture::new(true);
    let status = read_status(&text(&f.repo), true).unwrap();
    assert_eq!(status, ActionStatus { is_repository: true, branch: Some("main".into()), upstream: Some("origin/main".into()), ahead: 0, behind: 0, dirty: false, is_default_branch: true });
    fs::write(f.other.join("other.txt"), "remote\n").unwrap();
    commit_all(&f.other, "Remote commit");
    sh_git(&f.other, &["push", "-q"]);
    f.write("untracked.txt", "new\n");
    // Without the fetch the remote's new commit is not seen; with it, it is.
    assert_eq!(read_status(&text(&f.repo), false).unwrap().behind, 0);
    let fetched = read_status(&text(&f.repo), true).unwrap();
    assert_eq!((fetched.behind, fetched.dirty), (1, true));
    f.git(&["switch", "-q", "--detach"]);
    assert_eq!(read_status(&text(&f.repo), false).unwrap().branch, None);
    assert!(!read_status(&text(f.dir.path()), false).unwrap().is_repository);
}

/// A Git action that prints more than Node's runner keeps is neither stopped nor failed: the first 8,000,000 bytes come
/// back and every line still reaches the line reader, as Node's `spawnCommand` reads on.
#[test]
fn a_git_action_that_prints_more_than_the_limit_keeps_the_first_part_and_finishes() {
    let f = Fixture::new(false);
    let line = "x".repeat(99);
    f.write("big.txt", &format!("{line}\n").repeat(90_000));
    let oid = f.git(&["hash-object", "-w", "big.txt"]);
    let seen = Arc::new(Mutex::new(0usize));
    let counter = Arc::clone(&seen);
    let lines: LineSink = Arc::new(move |_| *counter.lock().unwrap() += 1);
    let printed = run_action_git_with(&text(&f.repo), &["cat-file", "blob", &oid], COMMAND_DEADLINE, ActionGitExtras { lines: Some(lines), ..ActionGitExtras::default() }).unwrap();
    assert_eq!(printed.len(), 8_000_000);
    assert_eq!(*seen.lock().unwrap(), 90_000);
}
