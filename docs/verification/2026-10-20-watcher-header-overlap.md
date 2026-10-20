# Watcher's header at every pane width off macOS, October 20, 2026

Review of pull request #1214 found that off macOS, with a thread open beside Watcher, Watcher's header overlapped in a band of pane widths: the Watched tab ran into Stop all, or into More Watcher actions, and Watcher's name was cut to "Watc…". A 1040 to 1160 pixel window at the even split puts Watcher's pane in that band. The labels on All threads and Stop all came back at 470 and 520 pixels, before the row could hold them.

Measured on Windows, the header's row needs, from the pane's edge, with a one-digit count on All threads and on Watched:

| Shown | With Stop all | Without Stop all |
| --- | --- | --- |
| Every label | 582 px | 495 px |
| All threads' label, Stop all as its icon | 526 px | |
| Both as icons | 458 px | 427 px |

So `main` overlapped from 470 to 581 pixels with Stop all and from 470 to 494 without it. The labels now come back where the row holds them, with room to spare for longer counts: All threads' at 520, and while Stop all shows, Stop all's at 610 and All threads' at 550. Below 480, while Stop all shows, Watcher's name gives the tabs its room, as it already did below 450; the tile still says whose room it is and the heading stays for assistive technology. The tabs tighten below 470 as before. The rules are off macOS only (`.watcher-room:not(.threads-view--mac)`); the macOS header starts past the traffic lights and has its own widths in #1214.

## What was checked

On Windows, against Sotto Owl built from the branch, with the room's projection seeded through the end-to-end stand-in and Visual gate flake open beside Watcher:

- `npx playwright test tests/e2e/watcher.spec.ts -g "at every pane width beside a thread"`: in dark and light, with Stop all showing and with Watcher's threads finished so it does not, the divider dragged to every 10 pixels of Watcher's pane from 400 to 800 at 1280x800 and 1600x1000, and to 400 and 411 (its widest there) at 820x560. At each of the 340 widths no header control's box overlaps another's, each stays inside the header's padding and its one 44-pixel row, and no label, count or name is cut off. The closest the tabs come to the actions is 29 pixels, at 480 with Stop all, where the row's own gap is 4; a digit of a count is about 7.5 ([readings](../../artifacts/watcher-header-overlap/readings.json)).
- The same journey on `main`'s styles failed at 30 of its 170 readings in each appearance, at 470 to 580 pixels with Stop all and 470 to 490 without it at both sizes, the first overlap at 470 being Watched over More Watcher actions. At 540 pixels, dark: Watched at 354 to 441, under Stop all at 417 to 502, and the name cut to an ellipsis ([before, dark](../../artifacts/watcher-header-overlap/header-before-stop-all-dark-540px-1280x800.png), [before, light](../../artifacts/watcher-header-overlap/header-before-stop-all-light-540px-1280x800.png)).
- After, at 540 pixels in 1280x800: the tabs end at 384, and Stop all, now its icon, starts at 473 ([dark](../../artifacts/watcher-header-overlap/header-stop-all-dark-540px-1280x800.png), [light](../../artifacts/watcher-header-overlap/header-stop-all-light-540px-1280x800.png)). Without Stop all the row keeps All threads' label ([dark](../../artifacts/watcher-header-overlap/header-no-stop-all-dark-540px-1280x800.png), [light](../../artifacts/watcher-header-overlap/header-no-stop-all-light-540px-1280x800.png)).

## Not covered

- macOS and Linux windows. The rules are the same off macOS on Windows and Linux, and the run is on Windows; macOS is #1214's.
- Longer counts were not seeded. The design-threads scenario has 8 threads and 2 watched; the 25 pixels to spare hold two more digits across the two counts at every width.
