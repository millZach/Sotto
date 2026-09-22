# Reclaiming a thread's worktree (ADR-0019), 2026-09-22

Proof that a thread's own worktree can be given back from the running app, that its branch survives, that the next send puts the folder back, and that the four cleanup rules appear in Settings and start off. Screenshots are in `artifacts/reclaim-worktrees/`; `index.html` there lays them out.

## What was found first

On September 21 `%APPDATA%\sotto` held 31.8 GB in 758,435 files. `thread-worktrees\` was 30.6 GB: sixteen worktrees, each with a 1.4 GB `node_modules` an agent had installed, three with a 600 MB `release/`, two with a nested `.worktrees/`. Thirteen belonged to settled threads. The repository's own `.worktrees/` and `.claude/worktrees/` held another 75 GB across 130 worktrees; 82 of the 160 carried a `node_modules` junction into the real install. All 149 idle worktrees were removed by hand that evening (branches kept, 14 patches of uncommitted work saved under `%APPDATA%\sotto\backup-worktree-patches\`), and the app was given a way to do it itself.

## Unit and integration

```powershell
npx vitest run tests/unit/main/threadWorktrees.test.ts tests/unit/main/worktreeCleanup.test.ts tests/unit/main/workspace.test.ts tests/unit/renderer/threadWorktreeReclaim.test.tsx tests/unit/shared/settings.test.ts --maxWorkers=2
```

- `threadWorktrees.test.ts` (3 new, real Git): a clean worktree is reclaimed and `restore` puts it back on its branch with its commits; uncommitted work goes only with the user's answer and never for a rule, even one told `withUncommittedChanges`; a rule leaves alone a folder with `out/` among its ignored files; a `node_modules` junction to a folder outside the worktree is refused and the folder behind it is untouched; a detached HEAD and a shared folder are refused.
- `worktreeCleanup.test.ts` (5 new, real Git): nothing happens with every rule off; the idle rule takes an old idle thread and leaves a recent or running one; `unchanged` takes a folder whose HEAD is in `main` and leaves one with its own commits; the merged rule asks the GitHub hook only when on and skips dirty and built folders; a settle triggers a sweep only with `onSettle`, and a rules change triggers one.
- `workspace.test.ts` (1 new): a running thread, a thread with a terminal open and a rule's refusal all leave the record alone; a request reclaims and publishes `reclaimedAt`; a refresh does not put the folder back; the next send does and clears `reclaimedAt`.
- `threadWorktreeReclaim.test.tsx` (5 new): the panel offers Remove worktree only for the thread's own folder; Escape inside the question closes the question and not the panel; the dirty wording appears when main knows of work the record did not; Settle settles first and then asks; a shared folder or a refused settle asks nothing.

The full suite: 340 files passed, 18 skipped. Typecheck, lint and `notices:verify` green.

## In the built app

```powershell
npm run build && npx playwright test tests/e2e/thread-worktrees.spec.ts
```

4 passed. The new test, "a worktree can be reclaimed from the pane or on settle, keeps its branch, and comes back on the next send", against a real repository and the fixture provider:

1. Settings → Application shows **Remove idle worktrees after** at Never and the three toggles off, at 1600×1000, 1280×800 and 820×560 in dark and light with no horizontal overflow (`settings-worktree-cleanup-*.png`). Choosing 30 days saves and reads back; Never restores it.
2. A thread on a new worktree sends once; `node_modules/dep` is written into the folder to stand for an install.
3. **Remove worktree** in the Working copy panel opens "Remove this worktree?" naming the branch that stays (`remove-worktree-clean.png`). Escape keeps the folder.
4. With `README.md` edited in the folder, the same press names the uncommitted changes and the confirm reads **Remove and lose changes** (`remove-worktree-dirty.png`). On that answer the folder is gone, `git worktree list` shows one, and the branch is still listed.
5. The panel says "Folder removed. Sending to this thread puts it back on `<branch>`" and withholds Open folder (`working-copy-reclaimed.png`).
6. The next send puts the folder back on that branch with the committed `README.md`, and `reclaimedAt` clears.
7. **Settle** settles the thread and then asks "Remove its worktree too?" (`settle-asks.png`); **Keep folder** leaves it, and a later Remove worktree takes it with the branch still there.

Two things the real app caught that the unit tests had not, both fixed in this change: Escape from inside the question was closing the Working copy panel behind it rather than the question, because the panel's own Escape handler stopped the event first; and the checkpoint guard that runs before a send resolved the thread's folder and refused a reclaimed one before the restore path could put it back, so a reclaimed worktree now counts as unallocated there, the way a not-yet-created one does.

## Not covered here

The hourly sweep and the `merged` rule are exercised by unit tests with real Git and a stubbed GitHub hook, not against GitHub. `npm run design:verify` will differ on the Settings → Application capture, since four rows were added; the baseline needs `npm run design:capture` on purpose.
