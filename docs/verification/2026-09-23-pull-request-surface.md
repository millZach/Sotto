# Pull request surface (#269)

Verified September 23, 2026, on Windows 11, in the built app under Playwright. GitHub is the scripted `gh` in `tests/fixtures/fakeGh.mjs`, reached through the host's test seam (`SOTTO_E2E_GH_SCRIPT`); Git, the repository and its owned bare remote are real; the project's origin is written as the pull request's GitHub URL and rewritten by Git's `insteadOf` to the owned remote, so the checkout's repository check passes as it would against GitHub. No live GitHub was contacted.

## What `tests/e2e/pull-request-surface.spec.ts` drove

1. A thread that has not started, on `main`. Typing `#74` into the branch picker put **Checkout pull request** first; Enter opened the dialog, which resolved the pull request through `gh` as "Greet the reviewer, #74 · feat/greeting to main". **Local** ran `gh pr checkout` and the project folder landed on `feat/greeting`; the toolbar said "Checked out PR #74 on feat/greeting." and focus went back to the branch picker.
2. The badge under the composer ("Open PR #74 - Open: Greet the reviewer in Tools") opened Tools on **Pull request** (the PR tile) with the title, head and base, review decision, the check "CI / Owned build" and the description (`draft-1280-dark.png`).
3. The fake then closed the pull request behind the surface's back. **Ready for review** was refused in the host's words ("Could not mark this ready for review. GraphQL: Pull request is closed (markPullRequestReadyForReview)"), the surface read it again as closed, and **Reopen pull request** put it back.
4. **Ready for review** marked it ready without a confirmation. The merge method was changed to Squash and merge; **Squash and merge** opened "Merge pull request?" with Cancel focused, and Escape closed it with no `gh pr merge` in the fake's call log (`ready-1280-light.png`, taken in light while the method was chosen).
5. Pressed again and confirmed, the pull request merged once: the fake records exactly `pr merge <url> --squash` and the pull request as merged with squash. The surface said "Pull request merged." and "Merged.".
6. **Linked pull requests** listed it as "Checked out from the branch picker"; Back returned focus to the control that opened the list.
7. At 820x560 nothing overflowed the window and no control on the surface clipped (`merged-820-dark.png`).

`tests/e2e/daily-workspace.spec.ts` now creates its pull request from the pane header's Git action (Create PR, which pushes to the owned remote first), opens it from the badge, and merges it after the confirmation, in place of the old form's Push branch and Create pull request with an `ipcMain` stand-in.

Captures are in `artifacts/pull-request-surface/`.
