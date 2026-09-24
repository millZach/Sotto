# Pull request surface (#269)

Verified September 23, 2026, on Windows 11, in the built app under Playwright, after the surface was rebuilt as the merge checklist (the owner's pick, variant C, "Checklist to merge"). GitHub is the scripted `gh` in `tests/fixtures/fakeGh.mjs`, reached through the host's test seam (`SOTTO_E2E_GH_SCRIPT`); Git, the repository and its owned bare remote are real; the project's origin is written as the pull request's GitHub URL and rewritten by Git's `insteadOf` to the owned remote, so the checkout's repository check passes as it would against GitHub. No live GitHub was contacted.

## What `tests/e2e/pull-request-surface.spec.ts` drove

1. A thread that has not started, on `main`, with Tools on **Pull request**: "Nothing to merge yet", "main is the default branch. Once this thread is on a branch with a pull request, this lists what stands between it and main.", **Create PR** held back with the Git action's reason, and **Link pull request** (`none-1280-dark.png`).
2. Typing `#74` into the branch picker put **Checkout pull request** first; Enter opened the dialog, which resolved the pull request through `gh` as "Greet the reviewer, #74 · feat/greeting to main". **Local** ran `gh pr checkout` and the project folder landed on `feat/greeting`; the toolbar said "Checked out PR #74 on feat/greeting." and focus went back to the branch picker.
3. The badge under the composer ("Open PR #74 - Open: Greet the reviewer in Tools") opened the checklist: "#74 Greet the reviewer", tagged Draft, "Before merging, 3 of 5 done", "CI / Owned build passed", "Reviewers wait until it is ready", "Still a draft" with its **Ready for review** press, and **Merge #74** disabled. The description opened from its fold (`draft-1280-dark.png`, `draft-1280-light.png`).
4. The fake then closed the pull request behind the surface's back. The draft line's **Ready for review** was refused in the host's words ("Could not mark this ready for review. GraphQL: Pull request is closed (markPullRequestReadyForReview)"), the surface read it again as closed, "Closed without merging" took Merge's place, and **Reopen** put it back.
5. **Ready for review** marked it ready without a confirmation. The review line then read "Nobody has reviewed it yet", the hint "1 line left before this can merge.", and a forced press on the disabled Merge opened nothing.
6. The fake recorded an approval by `mira`. **Refresh** read it: "Approved by mira", "Ready to merge, 5 of 5 done", and Merge enabled.
7. From the keyboard, **Merge method: Merge** opened the method menu on the method in use; Down and Enter chose Squash and merge, focus went back to the button, now **Merge method: Squash and merge**, and the hint read "One commit on main.".
8. **Merge #74** opened "Merge pull request?" ("This merges #74 into main using squash and merge.") with Cancel focused; Escape closed it with no `gh pr merge` in the fake's call log (`ready-1280-light.png`, `ready-1600-light.png`, `ready-1600-dark.png`).
9. At 820x560 nothing overflowed the window, and the method menu opened inside the Tools panel (`method-820-dark.png`); Escape closed it.
10. Pressed again and confirmed, the pull request merged once: the fake records exactly `pr merge <url> --squash`. The surface said "Pull request merged.", the heading became "Merge checklist", and "Merged into main" with the time took Merge's place.
11. **Linked pull requests**, focused and opened with Enter, listed it as "Checked out from the branch picker".
12. At 820x560 again, nothing overflowed and no control on the surface clipped (`merged-820-dark.png`, `merged-820-light.png`).

At steps 3 and 8, in dark and in light, the spec measured the checklist's count, reasons, hint, state tag, line labels and the disabled Merge's text against what they sit on: every ratio was at least 4.5:1.

`tests/e2e/daily-workspace.spec.ts` creates its pull request from the pane header's Git action, opens it from the badge, reads the checklist ("CI / Owned build passed", "No review required", "Ready to merge, 5 of 5 done") and merges it after the confirmation.

Captures are in `artifacts/pull-request-surface/`.
