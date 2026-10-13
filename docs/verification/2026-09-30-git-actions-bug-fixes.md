# Git action bug fixes

Windows verification of pkg-16, issues #500, #501, #503, #504 and #505. The five fixes are commits f3f686c9 through 30caa480; this note and the journey setup update follow them.

PR #628's review follow-up sends every staging add and reset a NUL-separated literal pathspec on stdin. Fake-runner regressions compare the complete argument lists for 3 and 3,000 paths, for both commit-all and selected files with excluded staging. Real Git covers literal bracketed filenames and index restoration on an unborn branch. Both fake-runner cases failed before the stdin change and pass after it. The installed Git is 2.53.0.windows.2; [Git 2.25's reset documentation](https://git-scm.com/docs/git-reset/2.25.0) already supports both stdin options and the global literal-pathspec flag, matching the pathspec interface Changes already needs.

The existing real-Git staged-hunk tests now assert the remaining patch is unstaged in both commit modes. Both fail with `staged` plus `unstaged` committed on the implementation before 9cb1fb66. The fork tests now cover both push settings with forks missing or behind while HEAD matches origin, and assert the actual push and both bare repositories' commits. All four fail with `skipped_up_to_date` before 8d0c20ed. A real conflicted stash pop reproduced the raw `write-tree` error; the guard now refuses before that command and preserves the conflicted index, working file and HEAD.

Follow-up verification: `npx vitest run tests/unit/main/gitActions.test.ts tests/unit/main/gitStatus.test.ts --maxWorkers=2` passed 56 tests. Typecheck, lint, notices verification (174 components), build and the unchanged Electron Git journey passed again. The journey passed in 33.7 seconds; its minimum-size commit dialog captures were inspected in dark and light. No design baselines were regenerated. Full gates and final CI are recorded in the PR body once complete.

`npx vitest run tests/unit/main/gitActions.test.ts tests/unit/main/gitStatus.test.ts --maxWorkers=2`: 50 passed. Regressions reproduced wrong subfolder line counts and pathspec failure, rename copies, whole-file commits replacing staged hunks, lost staging after hook refusal, skipped fork pushes and false publish success before their fixes. Neighboring coverage includes restoring staging after a pathspec failure, first commits with excluded staging, both push-remote settings, stale publish refs and lost replies after a real push. Git is real; GitHub replies are scripted. No provider or GitHub account was used.

`npm run build` and `npx playwright test tests/e2e/git-actions.spec.ts`: build succeeded and one journey passed. Its original setup waited for a thread-options form removed by #347; the helper now waits for the immediately created thread and names it through the bridge. All Git assertions remain: keyboard-opened commit dialog, Escape and return focus, default-branch confirmation, real commit and push to an owned bare remote, scripted pull request creation, branch picker, fast-forward pull and initialization.

The journey checked 1600x1000, 1280x800 and 820x560 in dark and light, and reduced motion for action progress. Visually inspected the minimum-size commit dialog in both appearances and the pushed notice at 1280x800. The controls fit and the result is legible. Retained minimum-size captures:

- [Dark commit dialog](../../artifacts/git-interface/pkg-16-commit-dialog-dark.png)
- [Light commit dialog](../../artifacts/git-interface/pkg-16-commit-dialog-light.png)

No design baselines were regenerated. These captures establish the existing interface; the defect-specific behavior is established by real-Git regressions. macOS and live GitHub publishing remain unverified.
