# A Needs you entry says what it needs, and pops its card open

October 29, 2026. Branch `feat/needs-you-trim`, from `60ac741f4` on `origin/main`. Records the October 29 amendment to [ADR-0135](../adr/0135-the-threads-sidebar-opens-on-needs-you.md), variant B of `docs/prototypes/needs-you-trim-prototype.html` as Zach picked it, checked in the built app on Linux (Omarchy, forge) through a nested desktop (`scripts/verify-linux-window-minimum.mjs --exec`).

## What was run

`tests/e2e/needs-you-queue.spec.ts` launches the built app with `needs-you-queue` and `sidebar-rail` on and the unpackaged E2E host. Workshop waits on a permission, "Run the build?", and Tidy the docs index has a failed turn nobody has seen.

- **The entry.** Workshop's entry reads its title, its wait, **Needs your approval** and **Open to answer**. The ask's words and Allow are not in the sidebar. The button's accessible name is "Open to answer the approval in Workshop".
- **The card.** At 1600x1000, 1280x800 and 820x560, in dark and light, the press pops Workshop's card open under its entry: the title, "Needs your approval · just now", "Run the build?", Deny and Allow, and Open thread. The card stands whole inside the window and scrolls nothing sideways. Escape closes it and the focus is back on **Open to answer**.
- **The rail.** With the sidebar collapsed, Workshop's tile carries the same name, and a press pops the same card beside the rail. Escape closes it with the focus back on the tile.
- **Answering.** Allow in the card sends the answer, the request leaves the host's state, and the card and the entry go.
- **Dismissing.** Dismiss on the failed thread's entry marks it seen, and with nothing left the queue goes.
- **Off.** With the feature off there is no queue and the folder dots stand.

Both journeys passed (2 passed, 31 s). The proof harness then reported that a live Omarchy theme file changed during the run, which it guards and which the live desktop rewrites; the spec's own result is the line above.

## Fit and contrast

The entry's need words and the card's line are the theme's warning text on the card and on the elevated surface. `themeTokens.test.ts` now holds both pairs at 4.5:1 in every built-in theme, light and dark (`tests/fixtures/renderer/paintedTextPairs.ts`). The new styles read `--tt-*` tokens only. Reduced motion is on throughout the spec; the card has no motion of its own.

## Captures

In `artifacts/needs-you-trim/`:

- `queue-1280x800-dark.png`: the trimmed queue, an approval and a failure.
- `card-1280x800-dark.png`, `card-820x560-light.png`: Workshop's card popped open over the sidebar.
- `rail-card-1280x800-dark.png`: the same card beside the collapsed rail.
