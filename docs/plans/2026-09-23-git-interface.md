# Match T3 Code's Git interaction

Issue: [#127](https://github.com/millZach/Sotto/issues/127). Written 2026-09-23.

**The pick, September 23, 2026.** Zach chose T3 Code's Git setup outright: placement A below (the toolbar on the composer, the Git action in the pane header, Changes as T3's diff, the pull request as a Tools surface), and every bend in "Where Sotto's rules bend it" resolved T3's way: the background fetch is on by default under its setting, staging leaves the UI, Git runs on the host, and Proactive panels exist as a setting that is off until turned on. The tickets below are filed as GitHub issues under #127. The placement mock-up is on `prototype/git-interface` for the record; it settled nothing, because the owner picked the reference itself.

The owner's direction on September 23: Sotto's Git interaction should be the same as T3 Code's. This plan therefore describes T3's Git model as read from the pinned source (`7810fb26`, the clone `docs/research/2026-09-19-t3-thread-workspaces.md` studied), maps each piece onto Sotto's surfaces, names the places Sotto's own rules bend it, and lays out the tickets. An earlier draft of this file ranked gaps and proposed three layouts; that ranking is superseded by the direction above and only its findings survive below.

## What Sotto does today, in one paragraph

Changes in the Tools panel lists changed files with their staging, shows one file's diff against HEAD, the index or the working copy, stages and unstages whole files, and holds a **Git actions** drawer (commit with a drafted message, a branch text field with Switch and Create), a **Checkpoints** drawer, and a **Pull request** form (remote, base, title, body, Push branch, Create pull request, then state, review and checks with Refresh). It runs `git` and `gh` from Electron main and never reaches a remote host. Separately, the thread's working copy (shared folder, new worktree, existing worktree) is chosen in New thread, shown in the pane header's Working copy chip, follows its branch (ADR-0014), shows **Branch changed** with **Restore branch** on a shared folder, and can be reclaimed (ADR-0019). There is no pull, no fetch outside worktree setup, no push outside the pull request form, no ahead or behind, no branch picker, no merge.

## T3's Git model

Five pieces, each in a fixed place. Labels are T3's exact strings.

### 1. The branch toolbar, on the composer

A strip under the prompt box, shown for Git repositories. Left to right: **Run on** (the machine: "This device" or a remote environment; static text when there is one), **Workspace** (**Current checkout**, or **Current worktree** once the thread has one; **New worktree**; **Previous worktree (branch)** when another thread of the project has one), the composer's own controls, then at the right a pull request badge (state icon and number, tooltip "PR #12 - Open: title") and the **branch picker**.

The branch picker is a ghost button with the branch name, **Select ref** for a detached HEAD, or **From main** (or **From origin/main**) for a new worktree that has no folder yet. Its popover searches refs ("Search refs..."), lists locals then remotes with badges `current`, `worktree`, `remote`, `default`, pages on scroll, and:

- picking a local or remote ref runs `git checkout <ref> --` (a remote ref with no tracking branch gets `--track`, which creates one); there is no dirty-tree confirmation, Git's own refusal is shown in a toast "Failed to switch ref.";
- picking a ref that is already checked out in another worktree re-points the thread at that worktree instead of checking out;
- in new-worktree mode, picking only records the base, and a footer switch **Start from origin** fetches that branch first;
- typing a name that matches nothing offers **Create new ref "name"** (whitespace to `-`), which creates from HEAD and switches;
- typing a pull request URL, `#42` or a `gh pr checkout` line offers **Checkout pull request**, which opens a dialog with **Local** (`gh pr checkout`) and **Worktree** (fetch the head into a branch and add a worktree);
- right-click copies the branch name.

Workspace and Run on lock to static text once the thread has a message or a session. Shortcuts: branch picker `mod+shift+g`, Workspace `mod+shift+x`, Previous worktree `mod+shift+l`, Run on `mod+shift+h`.

### 2. The Git action, in the pane header

A split button at the end of the header's actions: one quick action whose label follows the status, and a chevron menu (**Commit**, **Push**, **Create PR** or **View PR**, **Publish repository...**). Below a narrow width the label hides and the icon stays. **Initialize Git** replaces it when the folder is not a repository.

The quick action, from `GitActionsControl.logic.ts`:

| Status | Label | Press |
|---|---|---|
| dirty, no remote | Commit | commit |
| dirty, open PR or on the default branch | Commit & push | commit, push |
| dirty, otherwise | Commit, push & PR | commit, push, create PR |
| clean, no upstream, no remote | Publish repository | wizard |
| clean, no upstream, not ahead | Push (disabled, "No local commits to push.") or View PR | |
| clean, no upstream, ahead | Push, or Push & create PR | push (sets upstream) |
| behind | Pull | `git pull --ff-only` |
| diverged | Sync ref (disabled, "Branch has diverged from upstream. Rebase/merge first.") | |
| ahead | Push, or Push & create PR | |
| open PR | View PR | opens it |
| ahead of the default branch | Create PR | |
| detached HEAD | Commit (disabled, "Create and checkout a ref before pushing or opening a pull request.") | |
| current | Commit (disabled, "Branch is up to date. No action needed.") | |

**Push** and **Create PR** run at once; only **Commit** opens a dialog. The commit dialog ("Commit changes") shows the branch with a **Default branch** tag, the changed files with `+ins / -del` and an **Edit** mode to exclude files, and **Commit message (optional)** with the placeholder "Leave empty to auto-generate". Its buttons are **Cancel**, **Commit on new branch** and **Commit**. Any push or pull request from the default branch asks first ("Push to default ref?") with **Abort**, **Push to main** and **Check out feature branch & continue**, which creates `feature/<generated fragment>` from HEAD and reruns.

A stacked action streams its progress into one toast: "Generating commit message...", "Committing...", "Running pre-commit..." with the hook's last output line, "Pushing to origin...", "Preparing PR...", "Generating PR content...", "Creating pull request...". It ends "Committed abc1234" with **Push**, "Pushed abc1234 to origin/branch" with **Create PR** or **View PR**, or "Created PR #12" with **View PR**; failure is "Action failed" with the message. Pull ends "Pulled" or "Already up to date".

Under it, the server: `git reset` then `git add -A` (or `add -A -- <included files>`); a blank message means the provider's CLI writes one (Codex `exec --ephemeral -s read-only`, Claude `-p --tools ""`) from the staged name-status and patch plus the repository's last 20 commit subjects and its `AGENTS.md`; `git commit -m subject -m body` with hooks traced through `GIT_TRACE2_EVENT`; push chooses `branch.<b>.pushRemote`, `remote.pushDefault`, then `origin`, uses `push -u` when there is no upstream, and never forces; create PR refuses a dirty tree or an unpushed branch, finds an open one first (`gh pr list --head`), resolves the base from `branch.<b>.gh-merge-base`, the upstream, `gh repo view defaultBranchRef`, `origin/HEAD` or `main`, writes title and body from `log --oneline`, `diff --stat` and the patch of `base..HEAD` (filling `.github/pull_request_template.md` when there is exactly one), then `gh pr create --base --head --title --body-file`, and links the pull request to the thread.

### 3. Status, streamed

`git status --porcelain=2 --branch` gives the branch, upstream, ahead and behind, and whether the tree is dirty; `diff HEAD --numstat` gives per-file counts; `symbolic-ref refs/remotes/origin/HEAD` the default branch; `rev-list --count base..HEAD` the distance from it. The branch's pull request comes from `gh pr list --head <branch> --state all --limit 20 --json ...`, cached 60 seconds and bypassed after any Git action. A background `git fetch --quiet --no-tags origin` with `GIT_TERMINAL_PROMPT=0` and a 5-second timeout runs before a status read when the last one is older than 15 seconds, and a poller re-reads remote status every 30 seconds (15 in the performance profile, off in battery saver) only while the window is visible and focused or touched in the last 45 seconds. Status is also re-read after every Git action, after every turn, and on window focus. No file watcher. An optional **Automatically pull** setting fast-forwards the default branch when it is clean and behind.

What T3 shows of this: the label and enabled state of the action, warnings in its menu, the pull request badge, and `+adds -dels` in the diff header. No ahead or behind numbers anywhere; no dirty mark on the toolbar.

### 4. The diff, a tab in the right panel

`mod+d` toggles a **Diff** surface in the right panel (a side panel above 980 pixels, a sheet below, with **Maximize panel**). Its header: a scope menu (**Working tree**, **Branch changes**, **Latest turn**, **Turn ▸ N**), and for branch changes a base picker (**Automatic**, then refs in **Branch | Remote** columns with a **Use remote version** switch and **Remote only** marks); then `+adds -dels`, **Refresh diff**, **Expand all files** / **Collapse all files**, **Stacked diff view** / **Split diff view**, line wrapping, **Hide whitespace changes**, and a **file tree** aside. Each file is a collapsible block with its status, counts, **Copy path**, and its name opens the file. Working tree is the working copy against HEAD including untracked files (through a temporary index with `add --intent-to-add`); branch changes is `base...HEAD`, the merge-base diff; turns are checkpoint refs T3 writes per turn. **There is no staging, discard, revert or hunk action.** Selecting lines adds a comment ("Add a comment…", **Comment**) that becomes a chip on the composer (`app.ts L12 to L20`) and goes out with the next message as a fenced hunk.

### 5. Pull requests

A **Pull request** surface for the branch's linked pull request: tabs **Summary / Timeline / Code**; the summary has the description (editable), checks (a popover with each check), comments, reviewers and labels; the header's primary action is **Merge** / **Squash and merge** / **Rebase and merge** (a confirmation, method remembered), **Ready for review**, **Resolve conflicts** (hands the conflict to a thread), or an auto-merge badge; the ⋯ menu has Refresh, **Ask a question**, **Explain this PR**, **Fix findings in this thread**, **Convert to draft**, **Merge now**, **Enable auto-merge**, **Open on GitHub**, **Copy link**, **Close pull request**, **Revert changes**; a stale base shows **Update branch** / **Update with rebase**. A **Linked pull requests** surface lists the thread's pull requests with a **Link** dialog ("Pull request URL or #42"). A **Pull Requests** page lists the repository's with state, involvement, sort and filters. All of it runs through `gh` (`gh pr view/list/merge/ready/close/reopen/update-branch`, `gh api` for the rest) on `gh`'s own sign-in.

### Settings T3 keeps for this

Workspace default and **Start from origin** for new threads (Sotto has both); **Automatically pull**; **Default merge method**; **Git fetch interval** (seconds, 0 off); **Diff layout**, **Hide whitespace changes**, **Default diff file state**; **Proactive panels** (open the diff on its own after a big change); **Auto-settle merged threads**; writing style for commit and pull request text (**Repository conventions**, **Conventional Commits**, **Custom instructions**), follow pull request templates, and a separate writer model; worktree cleanup rules (Sotto has them).

## Mapping T3 onto Sotto

| T3 | Sotto surface | Exists today | Changes |
|---|---|---|---|
| Branch toolbar on the composer | The composer's control row (model, effort, permissions) and the pane header's Working copy chip | Working copy is chosen in New thread and locked after first send; the chip shows folder and branch | A branch picker and the Workspace and host choices join the composer's control row for a draft thread; after first send, Workspace and host become static text and the picker keeps working. The Working copy chip stays for folder, repository, Open folder and Remove worktree. |
| Git split button in the header | The pane header, before the layout and ⋯ buttons | Commit, branch and pull request live in drawers inside Changes | The split button and commit dialog replace the Git actions drawer and the pull request form's Push and Create. |
| Status stream | Main, and the host for remote threads | `list` polls every 2 seconds while Changes is open; the worktree record carries `dirty` after a turn | One status service on the runtime: porcelain v2, counts, default branch, the pull request, the gated fetch. Feeds the button, the badge, the Changes dot and the footer. |
| Diff surface, `mod+d` | Changes on the Tools rail | Working copy, staged, unstaged scopes; split and stacked; wrap | Scopes become Working tree, Branch changes with the base picker, Latest turn and Turn N (from Sotto's checkpoints, not Git refs); whitespace toggle, file tree, collapse all, counts. Stage and Unstage file, and the staged and unstaged scopes, retire in favour of the commit dialog's file list. A shortcut toggles Changes. |
| Diff comments to the composer | The composer's mentions | `@path` file mentions | A review comment is a mention with a line range and a fenced hunk. |
| Pull request surface | Changes' pull request view, then its own surface | State, review decision, checks list, Refresh | Summary essentials (description, checks, merge with method, ready and draft, close and reopen, update branch, Open on GitHub, Copy link), then Linked pull requests and Link. Timeline, Code with reviews, and the repository page come after. |
| Publish repository, Initialize Git | The split button's menu | Nothing | `gh repo create` for GitHub; `git init`. |
| Checkpoints as Git refs | `CheckpointService` | Sotto's own blob store and journal (phase 4) | Kept. Turn diffs are built from Sotto's checkpoints. |
| Previous worktree, worktree reuse | New thread's existing worktree choice | Exists | Surfaces in the Workspace menu on the composer. |
| Setup script after a worktree is made | Nothing | Nothing | Not in this plan; noted as a gap. |

## Where Sotto's rules bend it

Each of these is a deliberate difference or a decision the implementation ADR must record. The rest of T3's model is taken as is.

1. **The background fetch is a new periodic network action.** ADR-0019 refused an hourly fetch for the `unchanged` cleanup rule; T3's status model does not work without one (Pull never appears, Push is blind to a rejected non-fast-forward). Decision to record: Sotto fetches the way T3 does, `git fetch --quiet --no-tags origin` of the project's own configured remote over Git's existing authentication, with prompts disabled, at most every 15 seconds and only while the window is in front, under a **Git fetch interval** setting whose 0 turns it off. The README's privacy section names it. Recommendation: on by default to match T3, because the whole action button depends on it; the owner may choose off.
2. **Pull request status asks GitHub more often.** The README says `gh` asks GitHub hourly for the merged rule; now it asks on status refresh (cached a minute, bypassed after an action) and once after each turn. README line.
3. **Commit and pull request text read more of the repository.** T3 sends the last 20 commit subjects, the repository's `AGENTS.md` and the pull request template to the writer. ADR-0026's side call already goes to the thread's own provider in the working folder, so nothing new leaves the machine, but the README sentence that says "the staged diff alone" changes.
4. **One press can commit, push and open a pull request.** The button's name says all three, which satisfies "a control's name says what a press does". The default-branch confirmation stays. T3's **Proactive panels** (open the diff on its own after a big change) ships as a setting that is off until the user turns it on, so nothing announces itself unasked.
5. **Staging retires from the UI.** T3 has no Stage or Unstage; the commit dialog's file list is the choice. Sotto's `stage` and `unstage` actions and the staged and unstaged scopes go, with their tests. Confirmed by the owner with the pick.
6. **Branch switch keeps the thread right.** T3 switches without asking; Git refuses when work would be lost. Sotto does the same, and after the switch sends `refresh-thread-worktree` so `sentBranch`, the label and the shared-folder notice follow (ADR-0014). Restore branch keeps its confirmation.
7. **GitHub only, through `gh`.** T3 supports five hosting providers; Sotto's README names its hosts one by one. Publish, pull requests and merge are GitHub through `gh` on its own sign-in; another provider is an ADR.
8. **Git runs on the host.** T3's server does all Git for a thread; Sotto's Changes runs in Electron and skips remote threads. The new status and action services are built Electron-free beside `ThreadWorktrees`, wired in `createAgentRuntime`, and carried over the host protocol, so a remote thread gets the same button. The remote command list grows by the Git actions; the ones that discard work (there are none; a checkout that Git refuses loses nothing) need no answer policy.
9. **The shortcut checks the dictation hotkey.** `mod+d` is claimed only if it does not collide with the global hotkey; otherwise the Changes toggle takes `mod+shift+d`, and none when the hotkey holds both (#268, ADR-0027's amendment).
10. **Sotto's checkpoints stay Sotto's.** Turn diffs come from the content-addressed blobs, not from `refs/t3/checkpoints`; a turn whose checkpoint is unavailable says so.

## The prototype

#127 asks for a prototype with two variants and a pick. The direction settles the model, so the variants are about placement inside Sotto's shell, not about what Git does:

- **A. As T3.** Branch picker, Workspace and Run on on the composer's control row; the Git split button in the pane header; Changes with T3's diff header; the pull request as a Tools surface.
- **B. Sotto's places.** Branch picker inside the Working copy chip's popover in the header; the Git split button on Changes' line of chrome; otherwise as A.

One file, `docs/prototypes/git-interface-prototype.html` on `prototype/git-interface`, the app's tokens and Figtree, dark and light, 1600x1000, 1280x800 and 820x560, with the states: clean and current, dirty, ahead, behind, diverged, detached, no upstream, no remote, default branch, open pull request with a failing check, a draft thread on New worktree with Start from origin. The pick is A, recorded at the top of this file.

## Tickets

In build order. Main-process work is the same under A and B.

1. **Git status on the runtime.** A `GitStatus` service beside `ThreadWorktrees`: local status from `status --porcelain=2 --branch`, `diff HEAD --numstat`, `symbolic-ref refs/remotes/origin/HEAD`, `rev-list --count`; remote status with the gated fetch and `rev-list --left-right --count HEAD...@{upstream}`; the branch's pull request from `gh pr list --head`, cached a minute with an epoch; a stream of `snapshot`, `localUpdated`, `remoteUpdated` events; re-read after actions, after turns (`HEAD_MOVING_KINDS` already exists), on focus. Host protocol messages and the preload bridge. Schema in `src/shared/`. The **Git fetch interval** setting on the patch allow-list. Tests: real temporary repositories with a bare remote, `gh` fixtures, the stream's fingerprinting.
2. **Actions on the runtime.** `runStackedAction` for commit, push, create PR, commit and push, all three; `featureBranch`; included files as `reset` then `add -A -- paths`; commit and pull request drafts through the existing writers with the extra inputs (subjects, `AGENTS.md`, template); hooks traced and streamed; push remote resolution and `push -u`; `pull --ff-only`; `switch`, `create-and-switch`, tracking a remote ref; `init`; `gh repo create` for publish. Progress and result events with the toast text and CTAs. Refusals in T3's words. Tests: real repositories, faithful `gh` fixtures, a scripted lost acknowledgement.
3. **The branch toolbar.** Branch picker (search, paging, badges, create, remote tracking, worktree re-point, Start from origin, copy name, Checkout pull request), Workspace and host on the composer for a draft, locked after first send, with the shortcuts. `ThreadWorkingCopyFields` and `WorkingCopyFieldset` fold into it; New thread keeps its dialog for name, project and model. Tests: `threadWorkingCopy.test.tsx` grows; E2E `thread-worktrees.spec.ts`.
4. **The Git split button and commit dialog.** Quick action from a pure rules module with a table test mirroring T3's; the menu; the dialog with file exclusion and **Commit on new branch**; the default-branch confirmation; the progress and result notices; Pull; Initialize Git; Publish repository. Removes the Git actions drawer. E2E: a new `git-actions.spec.ts` pushing to an owned bare remote, as phase 5 did.
5. **Changes as T3's diff.** Scopes and the base picker, whitespace, file tree, collapse, counts, the toggle shortcut; Turn scopes from checkpoints; staging controls retire. Tests: `changesSurface.test.tsx`, `tools-sidecar.spec.ts` matrix; `design:capture` regenerated on purpose.
6. **Pull request surface.** Summary essentials and actions through `gh`; Linked pull requests and Link; the badge on the toolbar; Checkout pull request from the picker (local and worktree). Replaces the pull request form. Tests: `gitPullRequests.test.ts`, `gitPullRequest.test.tsx`.
7. **Review comments.** Line selection in Changes to a composer mention with a fenced hunk. Tests: composer mention tests.
8. **Settings.** Automatically pull, default merge method, diff layout and whitespace and file-state defaults, writing style, auto-settle merged threads, Proactive panels (off). Each on the patch allow-list; `ipc.test.ts` catches misses.
9. **Docs.** The ADR for the bends above; `CONTEXT.md` (**Branch picker**, **Git action**, **Review comment**; "Diff" is avoided in favour of Changes); README's Threads and privacy sections; `docs/agent-control.md` gains a Changes section; a verification note with captures in `artifacts/git-interface/`.

After these, each its own ticket once the nine are in: Timeline and Code tabs with reviews and files viewed; the repository's Pull Requests page; Resolve conflicts and Explain this PR as thread hand-offs; a setup script after a worktree is made.

## Constraints the tickets inherit

- `zod` and `node-pty` stay the only production dependencies; the diff viewer, hunk parser and toast are Sotto's own.
- Every new stylesheet goes on `themeTokens.test.ts`'s `owned` list; colour through `--tt-*`; 4.5:1; light, dark and reduced motion; 820x560 without clipping.
- Nothing runs unattended except the fetch and the cleanup rules, both under a setting.
- Logs carry event names, never a path, a branch, a message or a diff.
- ADR numbers are claimed at merge; check `docs/adr/` on `main` first.
