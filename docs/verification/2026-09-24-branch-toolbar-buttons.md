# The branch toolbar as its own row of buttons (#325)

Proved in the built app on September 24, 2026, on Windows 11, from `main` at `02e9185a` with this branch on top (`npm run build`, then Playwright). The images named here are in `artifacts/branch-toolbar-buttons/`; the run writes every capture to `artifacts/git-interface-run/`, which is not committed.

## What changed

The branch toolbar (Run on, Workspace, the pull request badge and the branch picker) used to sit inside the composer card under a hairline. It is now its own row under the card: each control a bordered pill on the hairline, 30px, the option chips' pill a size smaller. Run on and a locked Workspace wear the same pill, muted and without a chevron, since they are labels rather than controls; their key words stay in the text for the screen reader behind a laptop, server or folder glyph. The pull request badge and the picker sit at the right and wrap together at the narrow width.

The pick was made from `docs/prototypes/branch-toolbar-prototype.html` (variant A, Buttons, chosen by Zach over a tray and a segmented control).

The picker's list also stops clipping. `.branch-toolbar__refs` is a grid whose column was `auto`, so it sized itself to the widest no-wrap row, the list scrolled sideways and a long name pushed its badges out of view. The column is now `minmax(0, 1fr)` with no sideways scroll, so a long name ellipsizes with its badges in place.

## The run

```powershell
npm run build
npx playwright test tests/e2e/git-actions.spec.ts tests/e2e/thread-worktrees.spec.ts tests/e2e/pull-request-surface.spec.ts
```

Passed, 6 tests, 1.4 minutes, nothing retried. A first run failed one test on the Workspace chip's text, because the hidden key word carried a trailing space the old markup did not have; the markup was corrected and the run repeated.

## What was checked

`git-actions.spec.ts` opens the picker with `mod+shift+g` on a topic branch with its pull request and captures it at 1280x800 and the 820x560 minimum, dark and light:

- `branch-picker-1280x800-dark.png` and `branch-picker-1280x800-light.png`: the card ends at the send disc; below it **This computer**, **Current checkout**, and at the right **#74** and **feat/header** as separate pills. The picker's panel rises above the row anchored to the branch pill, with `feat/header` (current) and `main` (default), both badges in view.
- `branch-picker-820x560-dark.png` and `branch-picker-820x560-light.png`: the row wraps. **This computer** stays on the first line; **#74** and **feat/header** move together to the second line and stay at the right. Nothing overflows or clips the pane.

`thread-worktrees.spec.ts` covers the rest of the toolbar's behaviour unchanged: Workspace's choices and the `mod+shift+l` shortcut, the picker recording a base and creating a ref, the branch-changed notice and Restore branch, a failed first send, and reclaim. `pull-request-surface.spec.ts` covers Checkout pull request from the picker and the notice under the row.

Not proved by an app capture: the long-name case for the list, since the fixture repositories carry short branch names only. The prototype's "Show today's clipping" toggle shows the before and after on the real branch list, and `tests/unit/renderer/branchToolbar.test.tsx` pins the three rules the fix depends on.

The design captures were run against the committed baselines (`node scripts/capture-design.mjs`, then `verify-design-captures.mjs`, on the build above). Three of the ten tests fail before any change on `main` at `02e9185a`: `help.png`, `help-light.png` and `scale-100-help.png` differ by the About block's version string, since the baselines read 0.1.16 and the release bumped the package to 0.1.17 without recapturing them (#326). The spec runs serially, so those three stop the tests after them; excluded with `--grep-invert`, the other seven pass and no baseline changes. The design captures do not include a thread whose folder is a Git repository, so this change has no baseline of its own to regenerate.
