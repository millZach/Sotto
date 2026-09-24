# The Git interface, end to end (#272)

Proved in the built app on September 24, 2026, on Windows 11, from `main` at `e4d09733` with this branch's documentation on top (`npm run build`, then Playwright). It covers the whole Git interface #127 asked for, as ADR-0027 and its amendments record it: the branch toolbar and branch picker, the Git action with its commit dialog, default-branch question and notice, Changes and its scopes, review comments, the pull request checklist and Settings → Git.

Git, every repository and its owned bare remote are real. GitHub is the scripted `gh` in `tests/fixtures/fakeGh.mjs`, reached through the host's test seam (`SOTTO_E2E_GH_SCRIPT`, development builds only), and the threads run on the fake providers in `tests/fixtures/`. No live GitHub or provider was contacted.

The images named here are in `artifacts/git-interface/`. The run writes every capture to `artifacts/git-interface-run/`, which is not committed. Where a surface was already proved with its own captures, this note reruns that spec and links its note rather than capturing it again.

## The run

```powershell
npm run build
npx playwright test tests/e2e/git-actions.spec.ts
npx playwright test tests/e2e/thread-worktrees.spec.ts tests/e2e/tools-sidecar.spec.ts tests/e2e/pull-request-surface.spec.ts tests/e2e/review-comments.spec.ts tests/e2e/git-settings.spec.ts
```

The first passed (1 test). The second passed (9 tests, 2.8 minutes). Nothing was retried.

## The Git action, the commit dialog, the default-branch question and the notice

`tests/e2e/git-actions.spec.ts` gives a thread a repository on `main` with an owned bare remote. This run added the captures below, each at 1280x800 and the 820x560 minimum, dark and light, and at each it checked that nothing scrolls sideways and that the dialog's buttons or the notice are inside the window.

1. Clean and level with its upstream, the header reads **Commit**, disabled, with "Branch is up to date. No action needed." as its reason. After an edit it reads **Commit & push**, because the branch is the default one.
2. Enter on the button opens **Commit changes**. It shows `main` with its **Default branch** tag, `greeting.txt` with `+1 −1` and **Edit**, **Commit message (optional)** with the focus in it, and **Cancel**, **Commit on new branch** and **Commit & push**. Escape closes it and gives the focus back to the button. `commit-dialog-1280x800-dark.png`, `commit-dialog-820x560-light.png`.
3. **Commit & push** from `main` asks **Push to default ref?** first, with the focus on **Abort**, and offers **Check out feature branch & continue** and **Push to main**. At 820x560 the three answers wrap onto two rows inside the dialog. `default-branch-question-1280x800-light.png`, `default-branch-question-820x560-dark.png`.
4. **Push to main** commits under the typed message and pushes it. The notice above the composer reads "Pushed abc1234 to origin/main" until **Dismiss the Git notice** is pressed. The remote's `main` is the new commit.
5. On a topic branch the header reads **Commit, push & PR**. With the message left empty, the fake provider writes nothing, so the commit takes the stand-in subject "Update project files". The pull request is created through the scripted `gh`. The running notice keeps its words and drops its spin under reduced motion. It ends at **Created PR #74** with **View PR**. The toolbar gains the pull request badge (#74) and the header's action becomes **View PR**. `pull-request-created-1280x800-light.png`, `pull-request-created-820x560-dark.png`.
6. Moving the remote from a second clone turns the action on `main` into **Pull**, which ends "Pulled. Updated main from origin/main." with the folder at the remote's commit. At 820x560 the label leaves the button and its name stays. A plain folder offers **Initialize Git**, then **Publish repository...** in the menu.

## The branch toolbar and the branch picker

Still in `git-actions.spec.ts`, on the topic branch with its pull request, `mod+shift+g` opens the branch picker with the focus in **Search refs...**. It lists `feat/header` (current) and `main` (default), and its panel stays inside the window at both sizes. At 820x560 the toolbar wraps, with the picker on a line of its own. `branch-picker-1280x800-dark.png`, `branch-picker-820x560-light.png`.

`tests/e2e/thread-worktrees.spec.ts` covers the rest of the toolbar (4 tests; the earlier record is `docs/verification/2026-09-20-new-thread-setup.md`):

- **Workspace.** Current checkout is the default. New worktree is made on first send and never before, with **Start from origin**. **Previous worktree (branch)** is offered for another thread's worktree, and `mod+shift+l` takes it.
- **The picker.** It records a base for a worktree not made yet. **Create new ref "name"** makes a branch from HEAD and checks it out.
- **The branch-changed notice.** It shows for a shared folder moved from outside, survives a pane remount once dismissed, and **Restore branch** asks first when there is uncommitted work.
- **A failed first send** keeps the draft and retries without sending twice.
- **Reclaim.** A worktree is reclaimed from the Working copy panel or on settle, and comes back on the next send. The record is `docs/verification/reclaim-worktrees.md`.

## Changes and its scopes

`tests/e2e/tools-sidecar.spec.ts` (2 tests) walks **Working tree** and **Branch changes** at 1600x1000, 1280x800 and 820x560, at three panel widths, dark and light, with the file tree, and checks that the text contrast holds. It also sends three turns to a fixture thread and reads **Latest turn**, **Turn N** and an unavailable turn from Sotto's checkpoints. The captures and the full account are in `docs/verification/changes-diff.md` (`artifacts/changes-diff/`).

## Review comments

`tests/e2e/review-comments.spec.ts` (1 test) picks lines in Changes with the mouse and then the keyboard alone. It writes two comments, sees them as chips on the composer and markers under the lines at three sizes, dark and light, with reduced motion too, and sends them with the next prompt as text after the message. The captures and the account are in `docs/verification/review-comments.md` (`artifacts/review-comments/`).

## The pull request checklist

`tests/e2e/pull-request-surface.spec.ts` (1 test) checks out pull request #74 from the branch picker. It opens the **Pull request** surface from the toolbar's badge, reads the merge checklist, and merges only after the confirmation. The captures (1600x1000, 1280x800 and 820x560, dark and light) and the account are in `docs/verification/2026-09-23-pull-request-surface.md` (`artifacts/pull-request-surface/`).

## Settings → Git

`tests/e2e/git-settings.spec.ts` (1 test) opens **Settings → Git** with its four groups (When a thread commits, When a pull request is made or merged, When you read Changes, In the background). It fits every size in both themes and saves from the keyboard. The captures and the account are in `docs/verification/2026-09-23-git-settings-grouped.md` (`artifacts/git-settings/`).

## The usage figures

The context and cost figures that sat under the composer are gone on Threads and Chats. None of the captures above shows them, and `docs/verification/remove-usage-figures.md` records their removal.

## What this run does not prove

- **Live GitHub.** Every `gh` answer came from the fixture. The `gh` commands' shapes are checked in the unit and integration tests (`tests/unit/main/gitActions.test.ts`, `gitPullRequests.test.ts`), not against github.com.
- **A paired host.** The branch toolbar, the Git action and the pull request run on the thread's host through the same commands. The socket operations and the remote command list they use are covered by `tests/integration/socketHost.test.ts` and `tests/unit/main/socketHostService.test.ts`, not by this run. Changes for a remote thread says it is on the host machine.
- **macOS.** This run was on Windows only.
