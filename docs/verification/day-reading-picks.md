# Reading by day, Zach's picks: verification

November 7, 2026. `fix/day-reading-picks`, on Windows 11 with the built app (`npm run build`) and the review evidence harness (`tests/e2e/review-evidence-capture.spec.ts`), which drives the real app over a real Git repository and scripted `gh`. It covers two of Zach's November 6 picks from the follow-up mock-ups (`sotto-council/prototypes/followups/day.html`, kept outside the repository): B for faint secondary text by day ([ADR-0024](../adr/0024-sotto-ships-its-own-palettes-in-light-and-dark-columns.md), November 7 amendment) and B for faint edges on light cards ([ADR-0110](../adr/0110-containers-are-filled-cards-and-no-control-is-a-pill.md), November 7 amendment). The Settings toggles, item 3, are unchanged: Zach keeps them as they are.

## How it was run

```sh
npm run typecheck
npx vitest run tests/unit/renderer/themeTokens.test.ts tests/unit/renderer/scaleTokens.test.ts tests/unit/renderer/hasSelectors.test.ts tests/unit/shared/omarchyThemes.test.ts --maxWorkers=1
npx vitest run tests/unit/renderer/sidebarFrameStyles.test.ts tests/unit/renderer/threadWorkingDisplay.test.tsx tests/unit/renderer/cssSelectors.test.ts tests/unit/renderer/tools/pullRequestSurface.test.tsx tests/unit/renderer/jumpBand.test.tsx --maxWorkers=1
node scripts/capture-review-evidence.mjs <out> --states thread-idle,pr,changes,pages
npx playwright test tests/e2e/pull-request-surface.spec.ts
```

The capture spec shoots 1280 and 820 in dark only. For this note it was run once more with a local, uncommitted edit that shot those sizes in light too. The full suite runs in CI on the pull request, not on this machine.

## Before

The `before-*` images are the captures from the design pass's last review round (`81e191f02`), cropped to the item, as the mock-up's A showed them: the sidebar, the transcript and the Pull request surface (`before-day1-*`), and Settings and Changes (`before-day2-*`). Times, counts and summaries are at weight 400. A card is 4% of the text over the room, and its row lines barely show.

## After, by day

- `after-thread-idle-light-1600.png`: the sidebar's times, a working row's Working and its clock, and each folder's count are at 500. In the transcript the message times and the Worked for line are at 500, and the names keep their weight. The composer's card is still the lighter 4% card.
- `after-pr-ready-light-1600.png`: 5 of 5 done, the done lines, Checks' 10 passed, Changed files' 30, the peeked files and 22 more files are at 500. The two cards are 7%, so their edges and the room-coloured lines between their folds show. There is no outline.
- `after-settings-light-1600.png`: each group of rows is a 7% card with its row lines showing. The toggles are drawn exactly as before.
- `after-changes-big-light-1600.png`: the line under a file's head is the reading hairline. Sampled at x 1200, it paints 192,187,179 on the 242,240,234 sidebar, about 1.6:1. The faint rule it replaces was 213,208,200, about 1.3:1.
- `after-*-light-820.png`: the same at the 820 by 560 minimum. Nothing clips or overflows, and the heavier words take no more room than the ellipses already allow.

## By night

`after-pr-ready-dark-1600.png`: nothing changes by night. The weight token is 400 there, a sidebar word that stood at 450 stays at 450, and the card and hairline changes are written for the Sotto theme's light half only. The dark Pull request surface at 1600 and Settings at 820 were checked against the design pass's dark look and read the same.

## Contrast

Weight moves no ink, so item 1 changes no contrast. At 7% the Sotto theme's faint ink measured 4.39:1 on the card. It now takes 8% of the text, so it reads 4.5:1 or better there. The composer keeps its 4% card and its faint ink, so no pixel of it changes. `paintedTextPairs.ts` now measures the composer's placeholder and effort offer on the composer's own card, and adds the composer's faint ink on that card. In the other built-in light halves a 7% card misses pairs they hold today: Graphite's warning on a selected card (4.45:1), and Hush's and Glass's third chart series on a card (2.92 and 2.89:1, where 3:1 is the floor). So those halves keep 4%.

## Keyboard and reduced motion

Nothing moved and no control changed. Focus order, names and Escape are as they were, and nothing here animates.
