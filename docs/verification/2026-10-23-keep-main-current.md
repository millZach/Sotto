# Keep main up to date, October 23, 2026

On Owl, each project's checkout is now fetched every 15 minutes and after a pull request merges. Its default branch is fast-forwarded when nothing of the user's is in the way, and the project row says why when something is. This is the Owl feature `keep-main-current` ([ADR-0142](../adr/0142-sotto-keeps-each-projects-main-up-to-date.md)). Checked on Windows 11 in the built app, over real repositories, and in tests.

## What was checked

- **The built app.** `tests/e2e/keep-main-current.spec.ts` runs with the feature on. It uses a real project repository whose local remote has one more commit, which changes `package-lock.json`. With a local edit to a tracked file, the project row reads "main is 1 behind · local changes block the update", and `HEAD` does not move. **Show changes** lists `tracked.txt` with **Open folder** beside it, and Escape closes the list. Once the edit is reverted, the next check fast-forwards the folder to the remote's commit. The row then reads "Updated main · dependencies changed, run install", and **What changed** lists `package-lock.json`. The thread sharing the folder stops offering **Pull** once its status is read again, and the dismiss press clears the row. No page errors.
- **Screenshots.** The blocked line with Show changes open, dark and light at 1280x800 (`artifacts/keep-main-current/blocked-1280x800-dark.png`, `artifacts/keep-main-current/blocked-1280x800-light.png`). The same at the 820x560 minimum (`artifacts/keep-main-current/blocked-820x560-dark.png`), where it wraps inside the sidebar without clipping. The dependencies line after the update (`artifacts/keep-main-current/updated-1280x800-dark.png`).
- **The safety rules, over real Git.** `tests/integration/mainCheckout.test.ts` covers each rule:
  - a clean default branch two commits behind is fast-forwarded and the line goes;
  - a lockfile change at any depth is said, survives a new keeper reading the same data folder, and goes on dismiss;
  - tracked changes, an untracked file the update would overwrite, another branch checked out, a local commit, and a merge in progress each leave `HEAD` and `refs/heads/main` where they were, and are said;
  - a checkout a thread holds is not touched and says nothing, even when its edits would block the update, and once the thread rests the block is said;
  - an ignored file the incoming commits track is named as in the way and keeps its contents;
  - untracked files left by a checkout stopped part way, each the incoming version exactly, are replaced by the update; when one of them differs, every file stays as it was and the line says they are in the way;
  - an unreachable remote keeps the last line;
  - a project switched off is left alone and its line forgotten;
  - a merged pull request checks only the projects whose `origin` is its repository on the same host, once.
- **The checkout guard.** `tests/integration/workspaceProjectCheckout.test.ts`: while a thread's Git action holds the project folder, the update runs nothing. While the update runs, a Git action in that folder is refused with "Sotto is pulling this folder."
- **The mock-up.** `design/keep-main-current/mockup.html` offered three variants. Zach picked A, the line under the project's name, and Show changes rather than an Update now press.

## Covered by unit tests

- `tests/unit/renderer/mainCheckoutLine.test.tsx`: the words for every block, Show changes and Show commits, Open folder, Escape returning focus, dismiss, no line without the bridge, and the open list read again when what blocks the update changes.
- `tests/unit/main/mainCheckoutParsing.test.ts`: repository names from HTTPS, SSH and pull request URLs, the files in Git's refusals with LF and CRLF, and tracked changes from `status -z`.
- `tests/unit/shared/settings.test.ts`: on by default, per-project answers kept, and unreadable ones dropped.

## Not covered

- macOS and Linux. The commands are the same Git, but the app was run only on Windows.
- A real GitHub merge waking the check. The merge listener was exercised with URLs, and the three places that call it (the Pull request surface, babysitting and a thread's status read) were not driven end to end.
- The 15-minute timer itself. Every check in these runs was asked for by saving the switch.
- A repository whose `post-merge` hook does something slow. The fast-forward runs it as the user's own pull would; one that outlasts the timeout after the branch moved still counts as the update.

## Rerun October 26, 2026

After `main` was merged in and the review's fixes landed, `tests/e2e/keep-main-current.spec.ts` passed again in the built app on Windows 11. The first attempt timed out resizing the window before the screenshots, after every assertion about the line had passed; the second run passed whole. The screenshots were not regenerated.
