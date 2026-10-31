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
| `threads-dark-1600x1000` | 30,322 | 28,760 (1.8%) | 739 × 16 at 561, 238 | 0 |
| `threads-dark-820x560` | 8,886 | 8,227 (1.8%) | 490 × 10 at 302, 88 | 707 |
| `threads-light-1600x1000` | 30,364 | 28,004 (1.8%) | 739 × 16 at 561, 238 | 0 |
| `threads-light-820x560` | 9,212 | 8,561 (1.9%) | 490 × 11 at 302, 87 | 777 |
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
- **Corners.** Where a corner was off a step it rounds a pixel or two differently: 12 px corners went to 10, 7 to 6, 5 to 4 and 3 to 2, and the composer's to 14 (below).

## What moved visibly

- **Settings' titles.** The sidebar's "Settings" went from 24 px to 22 (from 25 in a window 900 px wide or less), and a section's title, "Providers" here, from 26 to 28. [Before and after, dark](../../artifacts/type-radius-scale/moved-settings-titles-dark-before-after.png).
- **Memory's title**, "What Sotto remembers", went from 30 px to 28. [Before and after, dark](../../artifacts/type-radius-scale/moved-memory-title-dark-before-after.png).
- **The composer's corner** is the card step: 14 px, down from 16 on the full composer and 18 on Zach's two-row composer, the default. It now matches the effort trace drawn round it. Drake's pill went from 24 to 20.
- **Not captured here:** the phone pairing code (36 to 28 px), Usage's large ring figure (34 to 28) and its other ring figures (26 to 28). They need a paired phone and a week of usage, which the throwaway spec did not set up.

## Specs that measure sizes and boxes

Run on the branch build in the nested desktop: `composer-no-edge`, `composer-short-window`, `footer-status-clearance`, `new-thread-greeting`, `opencode-model-menu`, `pane-header`, `sidebar-crossing`, `tools-workspace` and `workspace-projects`. 19 passed and 4 failed. Each failure fails the same way on the `main` build: `workspace-projects`' "project folders hold several threads" (already known), `composer-no-edge`'s thread test (its effort chip never reads the highest level), `composer-short-window` (a row's Open beside button takes the pointer's hover at 1280 × 560) and `opencode-model-menu` (the Updates offer covers the model chip).

## Not checked

- Windows and macOS. Their design baselines will be retaken on Windows.
- Reduced motion: the scale changes no motion, and the captures were taken with animations stopped.
- The floating widget, which keeps its sizes (ADR-0169, decision 5): its stylesheet's only changes draw the same.
