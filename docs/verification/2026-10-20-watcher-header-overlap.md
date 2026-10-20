# Watcher's header at every pane width off macOS, October 20, 2026

Review of pull request #1214 found that off macOS, with a thread open beside Watcher, Watcher's header overlapped in a band of pane widths: the Watched tab ran into Stop all, or into More Watcher actions, and Watcher's name was cut to "Watc…". A 1040 to 1160 pixel window at the even split puts Watcher's pane in that band. The labels on All threads and Stop all came back at 470 and 520 pixels, before the row could hold them.

Measured on Windows, the header's row needs this much pane, with the seeded counts (8 threads, 2 watched) and with both counts at three digits. The counts are uncapped, and a three-digit count is 16.2 pixels wider than a one-digit one.

| Shown | With Stop all, one digit | With Stop all, three digits | Without Stop all, one digit | Without Stop all, three digits |
| --- | --- | --- | --- | --- |
| Every label | 582 px | 611 px | 495 px | 525 px |
| All threads' label, Stop all as its icon | 526 px | 556 px | | |
| Both as icons, with the name | 458 px | 488 px | 427 px | 457 px |
| Both as icons, no name, tabs tightened as below 470 | | 406 px | | |

The last row is why the tabs and All threads tighten again below 420 while Stop all shows: that brings it to about 390.

So `main` overlapped from 470 to 581 pixels with Stop all and from 470 to 494 without it, even with one-digit counts. The labels now come back where the row holds them with three-digit counts on both: All threads' at 540, and while Stop all shows, Stop all's at 630 and All threads' at 570. While Stop all shows, Watcher's name gives the tabs its room below 500, as it already did below 450 without Stop all; the tile still says whose room it is and the heading stays for assistive technology. The tabs tighten below 470 as before, and, while Stop all shows, a little more below 420 along with All threads' padding, so the 400-pixel minimum holds three-digit counts too. The rules are off macOS only (`.watcher-room:not(.threads-view--mac)`); the macOS header starts past the traffic lights and has its own widths from #1214.

## What was checked

On Windows, against Sotto Owl built from the branch, with the room's projection seeded through the end-to-end stand-in and Visual gate flake open beside Watcher:

- `npx playwright test tests/e2e/watcher.spec.ts -g "at every pane width beside a thread"`: in dark and light, with Stop all showing and with Watcher's threads finished so it does not, the divider dragged to every 10 pixels of Watcher's pane from 400 to 800 at 1280x800 and 1600x1000, and to 400 and 411 (its widest there) at 820x560. The sweep runs again at 1280x800 and 820x560 with both counts drawn as 100. At each of the 516 readings the tile, All threads, both tabs, More Watcher actions and Stop all (exactly when it should show) are on screen, and so is the name wherever the styles keep it. No header control's box overlaps another's, each stays inside the header's padding and its one 44-pixel row, and no label, count or name is cut off. The closest the tabs come to the actions, where the row's own gap is 4, is 46 pixels with the seeded counts and 13 pixels with three-digit counts, at 450 without Stop all and 400 with it ([readings](../../artifacts/watcher-header-overlap/readings.json)).
- The same journey on `main`'s styles failed at 30 of its 170 seeded readings in each appearance, at 470 to 580 pixels with Stop all and 470 to 490 without it at both sizes, the first overlap at 470 being Watched over More Watcher actions. At 540 pixels, dark: Watched at 354 to 441, under Stop all at 417 to 502, and the name cut to an ellipsis ([before, dark](../../artifacts/watcher-header-overlap/header-before-stop-all-dark-540px-1280x800.png), [before, light](../../artifacts/watcher-header-overlap/header-before-stop-all-light-540px-1280x800.png)).
- After, at 540 pixels in 1280x800, Stop all and All threads show their icons and the row has room to spare ([dark](../../artifacts/watcher-header-overlap/header-stop-all-dark-540px-1280x800.png), [light](../../artifacts/watcher-header-overlap/header-stop-all-light-540px-1280x800.png)). Without Stop all the row keeps All threads' label ([dark](../../artifacts/watcher-header-overlap/header-no-stop-all-dark-540px-1280x800.png), [light](../../artifacts/watcher-header-overlap/header-no-stop-all-light-540px-1280x800.png)). At 570 pixels, the narrowest that shows All threads' label beside Stop all, with both counts at 100 ([dark](../../artifacts/watcher-header-overlap/header-stop-all-counts-100-dark-570px-1280x800.png), [light](../../artifacts/watcher-header-overlap/header-stop-all-counts-100-light-570px-1280x800.png)).
- An earlier version of this change brought the labels back at 520, 550 and 610 and hid the name below 480. The three-digit pass found it too tight at each of those widths, and at the 400-pixel minimum with Stop all, so the widths above replaced it.

## Not covered

- macOS and Linux windows. The journey skips on macOS, whose header is #1214's. The rules are the same on Windows and Linux, and the run is on Windows.
- Four-digit counts. Each digit is about 8 pixels and the tightest bands leave 9 to spare, so a thousand on one count fits and on both does not.
- The three-digit counts are drawn into the header by the test rather than seeded as threads, since the room's count of all threads comes from the window's own thread list.
