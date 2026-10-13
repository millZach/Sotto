# A worktree Windows could only half remove

Verified on Windows, October 11, 2026, on `fix/half-removed-worktree` after merging `origin/main`, for #940. No live provider turn and no macOS or Linux run was made; on those systems a held folder is deleted whole, so the half-finished removal does not happen.

## Behaviour

A thread's idle provider client keeps its worktree as its working folder (ADR-0038). When a cleanup rule reclaims that worktree on Windows, `git worktree remove` deletes the files and Git's registration but not the folder. Sotto now counts that as reclaimed. The Working copy panel says the folder was removed and the next send puts it back. The next send fills the empty folder on the recorded branch, and nothing says "Working folder unavailable". A timed-out add into that folder asks only for a retry. First setup fills an empty, unregistered reserved folder the same way, and both still refuse a folder with anything in it, a link, or one Git still registers.

## Evidence

- Reproduced outside Sotto: with a second process holding a worktree folder, `git worktree remove` exited 255, left the folder empty and unregistered, and kept the branch. `git worktree add -- <path> <branch>` into that held, empty folder succeeded.
- The development machine had ten threads stuck this way, the oldest from September 19. Every branch was intact except two whose pull requests had merged (#148, #177).
- Red first: each new integration test failed on the code before its fix. The two folder-refusal tests failed with their guard removed.
- `npx vitest run tests/integration/threadWorktree` and `tests/integration/worktreeCleanup.test.ts`: all passed.
- `npm run build && npx playwright test tests/e2e/thread-worktrees.spec.ts -g "half remove"`: passed twice against the built app (7.6 s and 7.3 s). The test gives a thread its own worktree, holds that folder with a separate process, and turns on **Remove a worktree once its commits are in the default branch** in Settings. It checks that the sweep records the worktree as reclaimed while the empty folder stays, that the panel's words are right, and that the next send restores the checkout on its branch.
- The same end-to-end test against `main`'s worktree service failed at the reclaimed check (`reclaimedAt` stayed undefined), which is the reported bug. An earlier run against `main` failed sooner on an unrelated rename-click timeout and is not counted.
- Gates after merging `origin/main`: typecheck and lint clean, `npm test -- --maxWorkers=2` 9599 passed and 282 skipped, `npm run notices:verify` 189 components. CI ran the gates again on the pull request.

## Rendered review

Both captures are from the end-to-end run, dark, at the test's 1280x800 window.

- [Reclaimed with the folder still held](../../artifacts/half-removed-worktree/half-removed-reclaimed.png): the Working copy panel reads "Folder removed. Sending to this thread puts it back on sotto/75ef6843." The composer stays enabled, and no "Working folder unavailable" notice shows.
- [After the next send](../../artifacts/half-removed-worktree/half-removed-restored.png): the second message went to the restored checkout, and no notice shows.

The change adds no control or copy; both lines already existed. Light, reduced motion and the other window sizes were not captured for this change.

## Not verified

The installed build. The fix reaches it in the next release; the ten stuck threads on the development machine should then recover when opened, on Check again, or on the next send.
