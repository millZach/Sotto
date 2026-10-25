# The sidebar stays full height under a long page — 2026-10-23

In Owl 0.1.38-owl.20261023.2 on Windows, scrolling to the end of Usage lifted the whole window's contents. The sidebar and its foot (the switch and the page links) stopped partway down, the page's foot line sat above them, and a black band filled the rest of the window. This note records the cause, the fix and how both were checked in the built app.

## Cause

`html`, `body` and `#root` only have a minimum height, so the document itself can scroll. The shell is exactly one window tall and clips what overflows, but an absolutely positioned element with no positioned ancestor is placed against the document, not the shell. Usage ends with a visually hidden live region (`.tt-visually-hidden` in `.usage-page`). It sat at the foot of the page's content, hundreds of pixels below the window, and made the document taller than the window. Once the Usage page had scrolled to its end, the wheel kept going and scrolled the document, carrying the shell up with it.

## Fix

`.app-shell` in `src/renderer/src/styles/global.css` is now `position: relative` with `overflow: clip`. Every absolutely positioned element without a nearer anchor is placed and clipped inside the shell, so nothing inside it can make the document taller than the window. Unlike `hidden`, `clip` can't be scrolled by script either. The geometry of those elements doesn't change, since the shell covers the window exactly. No height is fixed anywhere new.

The taller document also gave the window a 10px scrollbar on every Usage visit. That narrowed the Usage room, and at the 820x560 minimum it kept the figure tiles at two columns. At the room's true width the tiles' grid (`minmax(150px, 1fr)`) fits three 152px columns, and "100% in Sotto" (117px) no longer fits its 112px value. The narrow grid's minimum is now 168px (`src/renderer/src/features/usage/usage.css`). That gives two columns at 820 again, the look Usage has had, and at least 128px for a value wherever three columns fit.

## Checks in the built app

A throwaway Playwright probe, which was not committed, launched the built app on current `main` with and without the fix. On each view it scrolled the main pane past its end with the mouse wheel, then read the document's scroll height and the bottom of the shell.

| View | Before | After |
| --- | --- | --- |
| Usage, Overview, 1600x1032 | document 1081px, shell lifted 49px | document 1032px, shell at 1032 |
| Usage, Overview, 820x560 | document 1333px, shell lifted 773px, off the window entirely | document 560px, shell at 560 |
| Usage, Subscriptions, 820x560 | document 1149px, shell lifted 589px | document 560px, shell at 560 |
| Usage, Models, 820x560 | document 630px, shell lifted 70px | document 560px, shell at 560 |
| Dictate room, Help, all 11 Settings sections, Watcher's room and a 200-message thread, at 1600x1032 and 820x560 | no overflow | no overflow |

Only Usage had the problem. The other views' hidden live regions already sit inside positioned panes. The shell-level fix covers them anyway, along with any page added later.

Captures (dark, reduced motion on), each taken after scrolling to the end:

- `artifacts/shell-pinned-sidebar/before-usage-overview-1600x1032.png` and `after-usage-overview-1600x1032.png`: the tall window, with the band and without it.
- `artifacts/shell-pinned-sidebar/before-usage-overview-820x560.png` and `after-usage-overview-820x560.png`: the minimum window. Before, the whole app has scrolled out of view.
- `artifacts/shell-pinned-sidebar/before-usage-subscriptions-820x560.png` and `after-usage-subscriptions-820x560.png`: Subscriptions at the minimum.
- `artifacts/shell-pinned-sidebar/after-usage-tiles-820x560.png`: the Usage spec's own 820 capture with figures, two columns, nothing clipped.

## Regression checks

- `tests/e2e/support/usageDashboard.ts` now also fails a Usage capture when the document is taller than the window. Against the unfixed build, `tests/e2e/usage-dashboard.spec.ts` failed on it with `documentOverflow: true`.
- Its `resize` now waits for the shell to follow the window as well. After a resize, `innerHeight` changes a frame before `100vh` does, so a check made in that frame saw a shell 200px taller than the window.
- The spec's keyboard check of the "…" menu now lets the scroll that focusing the button causes land before pressing Down. The menu closes on a scroll, by design, and a key pressed in the same frame lost that race in two of four runs. It passed in four of four runs afterwards.
- `pageBoundProblems` in `tests/e2e/support/designCapture.ts` now reports `document-vertical-overflow`, so the design captures and the Watcher specs that use it check every page they visit the same way. `tests/e2e/watcher-gate.spec.ts` passes with it (4 tests).

`npx playwright test tests/e2e/usage-dashboard.spec.ts` runs three tests. With the fix, the first and third pass. The second, "splits the Per day chart by model and provider", fails the same way on unchanged `main` (yesterday's figure reads 5, not 10). It is date-dependent and unrelated to this change. One run of the first test also missed a limits reading ("Room left 80%"), early in the journey, and passed on the next run.
