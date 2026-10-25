# Clear settled threads verification

October 23 and 25, 2026. `feat/clear-old-threads`, the Owl feature `clear-threads` (ADR-0140, pick C of `docs/prototypes/clear-threads-prototype.html`), on Windows 11.

## October 23: the built app

The screenshots in `artifacts/clear-threads/` come from `tests/e2e/clear-threads.spec.ts` on the built app with `SOTTO_E2E_EVIDENCE=publish`, before `main` was merged in on October 25. They show light and dark at 1280x800 and the 820x560 minimum:

- `settings-clearing-threads-*`: **Clearing threads** in Settings → Threads. These show **Clear settled threads after** on Never, the default at the time. The default is now 30 days (below), and the section is otherwise unchanged.
- `clear-settled-threads-*`: **Clear settled threads**, with the threads that go, the ones kept and why, and what clearing keeps.
- `cleared-1280x800-dark.png`: the notice after a clear.
- `delete-thread-*`, `delete-thread-kept-1280x800-dark.png` and `deleted-1280x800-dark.png`: **Delete thread…** in a settled thread's menu, a thread it keeps, and the notice after a deletion.

## October 25: the 30-day default

Zach chose 30 days as the default for **Clear settled threads after**, with Never still a choice. An Owl user who never chose has no saved value, so they get 30 days. `tests/unit/main/clearThreadsControl.test.ts` runs the first sweep after such an upgrade through the worktree sweep and the real coordinator. It clears only a settled thread quiet for longer than 30 days, and keeps back threads that are:

- settled or active within the 30 days;
- not settled;
- working or waiting on the user;
- holding an open pull request, or babysat or watched;
- delegating to a thread still at work;
- holding uncommitted changes, ignored files or a folder in use in their worktree;
- Watcher's own thread.

The hour after, it keeps the same threads and logs nothing more. Dropping the watch from the test makes it fail, so the test checks the guard.

Run for this change:

```sh
npm run typecheck
npm run lint
npx vitest run tests/unit/main/clearThreadsControl.test.ts tests/unit/main/threadClearing.test.ts tests/unit/shared/threadClear.test.ts tests/unit/shared/settings.test.ts tests/unit/renderer/features/settings/clearThreadsSettings.test.tsx tests/unit/renderer/deleteThread.test.tsx tests/integration/workspaceThreadDeletion.test.ts tests/integration/settingsHistoryIpc.test.ts tests/integration/socketHostFeatures.test.ts tests/unit/shared/interfaceCatalogs.test.ts tests/perf/streamingCopyBudget.perf.test.ts tests/perf/ownerScaleWorkBudget.perf.test.ts tests/unit/main/copySites.test.ts
```

The Playwright spec was updated for the new default but not run again on this computer, and the screenshots were not captured again.
