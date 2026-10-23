# The sidebar stays full height under a long page — 2026-10-22

In Owl 0.1.38-owl.20261023.2 on Windows, scrolling to the end of Usage lifted the whole window's contents. The sidebar and its foot (the room switch and the page links) stopped partway down, the page's foot line sat above them, and a black band filled the rest of the window. This note records the cause, the fix and how both were checked in the built app.

## Cause

`html`, `body` and `#root` only have a minimum height, so the document itself can scroll. The shell is exactly one window tall and clips what overflows, but an absolutely positioned element with no positioned ancestor is placed against the document, not the shell. Usage ends with a visually hidden live region (`.tt-visually-hidden` in `.usage-page`). It sat at the foot of the page's content, hundreds of pixels below the window, and made the document taller than the window. Once the Usage page had scrolled to its end, the wheel kept going and scrolled the document, carrying the shell up with it.

## Fix

`.app-shell` in `src/renderer/src/styles/global.css` is now `position: relative` with `overflow: clip`. Every absolutely positioned element without a nearer anchor is placed and clipped inside the shell, so nothing inside it can make the document taller than the window. Unlike `hidden`, `clip` can't be scrolled by script either. The geometry of those elements doesn't change, since the shell covers the window exactly. No height is fixed anywhere new.

## Checks in the built app

A throwaway Playwright probe, which was not committed, launched the built app. On each view it scrolled the main pane past its end with the mouse wheel, then read the document's scroll height and the bottom of the shell and the sidebar.

| View | Before | After |
| --- | --- | --- |
| Usage, Overview, 1600x1032 | document 1064px, shell lifted 32px | document 1032px, shell at 1032 |
| Usage, Overview, 1280x800 | document 1064px, shell lifted 264px | no overflow (the Usage spec's capture check) |
| Usage, Overview, 820x560 | document 923px, shell lifted 363px | document 560px, shell at 560 |
| Usage, Subscriptions, 820x560 | document 993px, shell lifted 433px | document 560px, shell at 560 |
| Usage, Models, 820x560 | document 612px, shell lifted 52px | document 560px, shell at 560 |
| History, Help, Settings (all 15 sections), Watcher's room, a 200-message thread, at 1600x1000 and 820x560 | no overflow | no overflow |

Only Usage had the problem. The other views' hidden live regions already sit inside positioned panes. The shell-level fix covers them anyway, along with any page added later.

Captures (dark, reduced motion on), each taken after scrolling to the end:

- `artifacts/shell-pinned-sidebar/before-usage-overview-1600x1032.png` and `after-usage-overview-1600x1032.png`: the tall window, with the 32px band and without it.
- `artifacts/shell-pinned-sidebar/before-usage-overview-820x560.png` and `after-usage-overview-820x560.png`: the minimum window, where the sidebar's foot had risen to the top third.
- `artifacts/shell-pinned-sidebar/before-usage-subscriptions-820x560.png` and `after-usage-subscriptions-820x560.png`: Subscriptions at the minimum.

## Regression checks

- `tests/e2e/support/usageDashboard.ts` now also fails a Usage capture when the document is taller than the window. Against the unfixed build, `tests/e2e/usage-dashboard.spec.ts` failed on it with `documentOverflow: true`. With the fix, both of its tests pass.
- `pageBoundProblems` in `tests/e2e/support/designCapture.ts` now reports `document-vertical-overflow`, so the design captures and the Watcher specs that use it check every page they visit the same way. `tests/e2e/watcher-gate.spec.ts` passes with it.
