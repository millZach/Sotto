# Text sizes and corners on the named scale (#1833)

Checked October 30 and 31, 2026, on forge, in the nested Omarchy desktop (`scripts/verify-linux-window-minimum.mjs --exec`), on a build of `main` at `ea190335d` and a build of `feat/type-radius-scale`. Decision: [ADR-0169](../adr/0169-text-sizes-and-corners-come-from-a-named-scale.md).

## What was compared

Dictate (a week of transcripts), Settings › Providers, the Threads room with Visual gate flake open and its request card showing, and the New thread dialog, each at 1600 × 1000 and at the 820 × 560 minimum, in dark and light. A throwaway Playwright spec opened each the same way on both builds, wrote one fixed folder path in place of the profile's random temporary one, and checked each view for clipped or overflowing controls (`pageBoundProblems`). Every view passed that check on both builds, so nothing clips at 820 × 560. Memory's room and Usage's empty room were captured the same way at 1600 × 1000, because they hold titles the scale moves by 2 px.

`sharp` compared each pair pixel by pixel. "Past the floor" counts pixels where a channel moved by more than 6, the design gate's noise floor. The largest box is the biggest group of changed pixels that lie within 6 px of each other. Two runs of the `main` build were compared the same way, to show what moves between runs with nothing changed: only Threads at 820 × 560 does, by the working words' light crossing "Combing the desert".

The after captures are in [`artifacts/type-radius-scale/`](../../artifacts/type-radius-scale/).

| Capture | Pixels changed at all | Past the floor | Largest changed box (w × h at x, y) | Two `main` runs, past the floor |
|---|---:|---:|---|---:|
| `dictate-dark-1600x1000` | 166,510 | 162,242 (10.1%) | 744 × 132 at 393, 127 | 0 |
| `dictate-dark-820x560` | 69,378 | 68,098 (14.8%) | 495 × 111 at 282, 291 | 0 |
| `dictate-light-1600x1000` | 167,209 | 121,417 (7.6%) | 744 × 132 at 393, 127 | 0 |
| `dictate-light-820x560` | 69,644 | 38,904 (8.5%) | 495 × 111 at 282, 291 | 0 |
| `settings-providers-dark-1600x1000` | 27,847 | 26,355 (1.6%) | 551 × 14 at 545, 651 | 0 |
| `settings-providers-dark-820x560` | 30,644 | 29,375 (6.4%) | 494 × 13 at 288, 109 | 0 |
| `settings-providers-light-1600x1000` | 27,990 | 26,388 (1.6%) | 551 × 14 at 545, 651 | 0 |
| `settings-providers-light-820x560` | 30,665 | 29,247 (6.4%) | 229 × 29 at 10, 449 | 0 |
| `threads-dark-1600x1000` | 30,284 | 28,716 (1.8%) | 739 × 16 at 561, 238 | 0 |
| `threads-dark-820x560` | 9,111 | 8,447 (1.8%) | 490 × 10 at 302, 88 | 707 |
| `threads-light-1600x1000` | 30,328 | 27,946 (1.7%) | 739 × 16 at 561, 238 | 0 |
| `threads-light-820x560` | 9,194 | 8,520 (1.9%) | 490 × 11 at 302, 87 | 777 |
| `new-thread-dark-1600x1000` | 132,062 | 21,999 (1.4%) | 590 × 21 at 505, 273 | 0 |
| `new-thread-dark-820x560` | 51,705 | 18,849 (4.1%) | 590 × 21 at 115, 487 | 0 |
| `new-thread-light-1600x1000` | 164,372 | 28,249 (1.8%) | 590 × 33 at 505, 260 | 0 |
| `new-thread-light-820x560` | 69,926 | 20,329 (4.4%) | 494 × 24 at 157, 78 | 0 |
| `moved-memory-dark-1600x1000` | 24,269 | 23,198 (1.4%) | 620 × 18 at 412, 479 | not run |
| `moved-memory-light-1600x1000` | 24,342 | 23,122 (1.4%) | 620 × 18 at 412, 479 | not run |
| `moved-usage-empty-dark-1600x1000` | 7,310 | 6,807 (0.4%) | 558 × 14 at 430, 189 | not run |
| `moved-usage-empty-light-1600x1000` | 7,349 | 6,791 (0.4%) | 558 × 14 at 430, 189 | not run |

## What the numbers are

- **Most of it is text half a pixel smaller or larger.** 12.5 px metadata, times, statuses and chips went to 12, and 13.5 px labels to 13. Each glyph redraws, and a line under it moves up a pixel, so a changed region is usually one line of text as wide as its column (the 739 × 16 box in Threads is the reply's first line, under its 12 px name and time).
- **Dictate moved most, by reflow.** The Dictate bar's explanation is 12 px now and fits on fewer lines: two at 1600 instead of three, four at 820 instead of five. The bar is a line shorter and the whole Journal and the stats below it move up with it, which is why a tenth of the window counts as changed. Each part looks as it did. [Before and after at 820 × 560, light](../../artifacts/type-radius-scale/moved-dictate-bar-light-820-before-after.png).
- **The New thread dialog** counts the blurred room behind it, which changed with the room; the dialog's own changes are its 12.5 px descriptions going to 12.
- **Corners.** Where a corner was off a step it rounds a pixel or two differently: 12 px corners went to 10, 7 to 6, 5 to 4 and 3 to 2, and the composer's to the overlay step (below).

## What moved visibly

- **Settings' titles.** The sidebar's "Settings" went from 24 px to 22 (from 25 in a window 900 px wide or less), and a section's title, "Providers" here, from 26 to 28. [Before and after, dark](../../artifacts/type-radius-scale/moved-settings-titles-dark-before-after.png).
- **Memory's title**, "What Sotto remembers", went from 30 px to 28. [Before and after, dark](../../artifacts/type-radius-scale/moved-memory-title-dark-before-after.png).
- **The composer's corner** follows the mapping: Zach's two-row composer, the default and the one in the Threads captures, went from 18 px to the overlay step's 20, and the full composer from 16 to the card step's 14. Drake's pill keeps 24 px, an exception in the scale check: in the built app it is 46 px tall on one line (6 + 32 + 6 inside its 1 px transparent border), so 24 rounds its ends whole and 20 would leave a flat stretch at each end. On two lines, at 820 × 560 here, it is 56 px tall. The Threads captures were retaken for this change, in the same nested desktop and the same steps.
- **The phone pairing code** went from 36 px to 28: the code is about a fifth smaller in its box. [Before and after, dark](../../artifacts/type-radius-scale/moved-pairing-code-dark-before-after.png), from `phones.spec.ts`'s own capture at 1600 × 1000 on each build ([after, whole window](../../artifacts/type-radius-scale/moved-pairing-code-dark-1600x1000.png)). Each run makes its own code, so the two codes differ.
- **Usage's large ring figure**, From cache's share of input, went from 34 px to 28 inside its 156 px ring: [before and after, dark](../../artifacts/type-radius-scale/moved-usage-ring-dark-before-after.png), on the Usage harness's seeded prompts ([after, dark](../../artifacts/type-radius-scale/moved-usage-ring-dark-1600x1000.png), [after, light](../../artifacts/type-radius-scale/moved-usage-ring-light-1600x1000.png)). 36,647 pixels past the floor in dark and 36,460 in light, almost all of it the figure and the 12.5 px words in the rows beside it. Usage's smaller ring figures (26 to 28 px) were not captured; they need a provider's limits.
- The pairing code and the ring were captured after `main` had moved to `7240d3078`, so their before build is that commit's renderer. Its merges since `ea190335d` (#1932, #1940) change neither surface.

## Specs that measure sizes and boxes

Run on the branch build in the nested desktop: `composer-no-edge`, `composer-short-window`, `footer-status-clearance`, `new-thread-greeting`, `opencode-model-menu`, `pane-header`, `sidebar-crossing`, `tools-workspace` and `workspace-projects`. 19 passed and 4 failed. Each failure fails the same way on the `main` build: `workspace-projects`' "project folders hold several threads" (already known), `composer-no-edge`'s thread test (its effort chip never reads the highest level), `composer-short-window` (a row's Open beside button takes the pointer's hover at 1280 × 560) and `opencode-model-menu` (the Updates offer covers the model chip).

## Not checked

- Windows and macOS. Their design baselines will be retaken on Windows.
- Reduced motion: the scale changes no motion, and the captures were taken with animations stopped.
- The floating widget, which keeps its sizes (ADR-0169, decision 5): its stylesheet's only changes draw the same.
