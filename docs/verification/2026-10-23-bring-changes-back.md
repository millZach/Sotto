# Bring a worktree's commits back to its parent's branch

October 23, 2026, Windows 11, for #1030. The built Electron app ran on the Owl track with the real Claude Code and Codex adapters over the fake CLIs in `tests/fixtures/`, and a real temporary Git repository. No provider account or paid turn was used. The source was `feat/bring-back` after the merge of `origin/feat/start-from-branch` at `7a9a7e339`.

## What worked in the app

`tests/e2e/bring-changes-back.spec.ts` passed in 54 seconds. A Claude Code thread on the project's shared checkout delegated to a Codex thread in a new worktree, which started from `main`, the parent's branch. The strip above the Codex thread's composer named that branch, where it is checked out and the parent thread, as in variant B of `prototype/continue-and-bring-back` (`96de16018`).

- Pressing **Bring changes to main** from the keyboard fast-forwarded `main` and the project folder's files. The outcome took the strip's place and the focus.
- After both branches moved on, the first item in **More Git actions** asked **Make a merge commit on main?** in the strip. Escape (Not now) left `main` as it was and gave the focus back to the offer. A second press and **Make merge commit** made a merge commit with both tips as parents.
- When both branches changed the same line, the strip showed Git's own `CONFLICT (content): Merge conflict in wavStream.ts`, and `main` and the project folder stayed clean and unchanged.
- No page errors.

The journey checked four states at 1600x1000, 1280x800 and 820x560 in dark and light, plus the merged outcome: 30 views, nothing wider than the window, lowest text contrast 4.97:1 (`checks.json`). I looked at the kept captures; the question and outcome replace the strip in place, and the text and buttons fit at the minimum size.

## What the app journey does not show

A child on another machine was not run in the app: there is no second machine in the Playwright journey, and no live laptop and forge run was made. That path is proved in `tests/integration/bringBackAcrossMachines.test.ts` over two real clones behind a real socket host, with the branch crossing as bundles: fast-forward, a merge after asking with a fresh move, a stale yes refused, a conflict refused in Git's words, uncommitted work refused before anything crosses, and a test-run snapshot refused. `tests/integration/bringChangesBack.test.ts` covers the host's half (`away`), including the outcome on the parent's `broughtBack`, a dirty parent folder, a parent no longer on its branch, and the incoming ref removed after every press. `tests/unit/main/bringChangesBackRemote.test.ts` covers the desktop's router.

## Kept evidence

`artifacts/bring-changes-back/`:

- `ready-820x560-dark.png`: the offer at the minimum window size.
- `question-820x560-light.png`: the merge-commit question and both choices.
- `fast-forward-1280x800-light.png`: the outcome after the keyboard press.
- `conflict-1600x1000-dark.png`: Git's conflict words, with main unchanged.
- `checks.json`: all 30 views with their lowest contrast.
