# A new worktree starts from the local branch when origin does not have it (#328)

Proved in the built app on September 24, 2026, on Windows 11, from `main` at `02e9185a` with this branch on top (`npm run build`, then Playwright). The images named here are in `artifacts/worktree-origin-fallback/`.

## What changed

Start from origin, on by default for a new worktree, used to refuse setup whenever the base branch could not be fetched from origin, including the common case after the shared-checkout default: the project folder is on a branch an agent or a thread made and never pushed. Sotto now does what T3 does (ADR-0014, amended today). It asks origin whether it has the branch; if it does, the worktree starts from origin's commit; if it does not, or the project has no origin at all, the worktree starts from the local branch and a notice above the composer says so once, with a Dismiss. A fetch that fails for any other reason, the connection or the credentials, still refuses with the same words as before.

## The run

```powershell
npm run build
npx playwright test tests/e2e/thread-worktrees.spec.ts
```

5 tests, 1.0 minute. The four existing tests passed. The new one failed once on its own file assertion, because the new checkout wrote Windows line endings; the assertion compares trimmed text now and the test passed on its next two runs (6 seconds each), the second with the light capture added.

After the two-axis review the notice's Dismiss got its full name, its dismissal is remembered on this computer, the outcome values were renamed to read at a glance, and the run's captures moved to an ignored `-run` folder. The test was run again on the rebuilt app with a reload added: 1 passed, 6 seconds. `tests/unit/renderer/localBranchNotice.test.tsx` (2 tests) covers the notice's three states and its dismissal across a remount.

Unit: `npx vitest run tests/unit/main/threadWorktrees.test.ts`, 22 passed. Its origin test now covers the three outcomes on real repositories with a bare remote: origin has the branch (`originBase: 'fetched'`, the worktree carries origin's content), origin lacks it (`originBase: 'not-on-origin'`, the worktree carries the local commit), and a remote that cannot be reached (still "could not be fetched"). A project with no origin remote allocates with `originBase: 'no-origin'`.

## What was checked

The new e2e test makes a repository with a real bare origin that has `main`, leaves the folder on a local-only branch `feat/local-only` with one commit of its own, creates a thread, chooses New worktree with Start from origin left on, and sends.

- The worktree is made and ready, its record reads `baseBranch: 'feat/local-only', originBase: 'not-on-origin'`, and its folder has the local-only commit's file.
- `local-branch-notice-1280x800-dark.png`: above the composer, in the status tone rather than the error tone, "origin/feat/local-only was not found, so the worktree started from the local branch feat/local-only." with **Dismiss** at its right. The pane header shows the worktree's own branch.
- `local-branch-notice-820x560-light.png`: the same notice at the minimum size in light. The sentence wraps onto two lines beside the button; nothing overflows the pane (the test asserts the document is no wider than the window).
- **Dismiss the local branch notice** removes it, and it stays away for that thread on this computer: the test reloads the window and the notice does not come back.

Reduced motion: the notice has no motion of its own; it takes the working-copy notice's styles, which animate nothing.

Not proved by an app capture: the no-origin case and the unreachable-remote case, which the unit tests cover on real repositories. The e2e fixtures used by the four existing tests have no origin, and they still turn Start from origin off on purpose, so their expectations are unchanged.
