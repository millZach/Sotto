# iPhone Duo upright: the page runs to the top edge and under the rail

November 11, 2026, on `fix/duo-upright-top-and-rail`. This is ADR-0151's ninth amendment and Zach's report of three faults that show only on the Duo unfolded and held upright. The Threads page's content stopped and faded at the status bar's band instead of scrolling to the screen's top edge. The page's accent wash stopped at a hard edge where the rail began, leaving the rail on plain black. And an open thread and Watcher had the same cut-off at the top. Zach picked variant B of the prototype `docs/prototypes/duo-upright-top-edge-prototype.html`: content passes under the clock, with nothing behind it.

The captures were taken on the iPhone Duo simulator (iOS 27.2) on GitHub's `xcode-27` runner by `Scripts/duo-captures.sh`, with the Debug-only `--ui-fixture`, `--ui-still` and `--ui-watcher`. The "after" pictures come from run 42982345064, on this branch's three commits. The "before" pictures come from run 42970780542, on a capture branch whose app code is the same as this branch's merge base. Neither branch stays.

## Turning the simulator upright

Earlier notes, including `2026-11-03-iphone-duo-thread-rail.md`, record that the simulator's inner screen stayed at 951×669 in every orientation, so upright could only be drawn inside the sideways window. Swapping the posture again with the posture tool's orientation field set to 3 turns it upright: the screen reads 2007×2853 pixels, 669×951 points. Fields 1, 2 and 4 leave it sideways. The captures script now does this, and upright is one of its default postures. Upright it runs only the Threads page, a thread and Watcher, the pages this change touches.

## What the captures show

All in `artifacts/ios-duo-upright-top-and-rail/`, each with the "before" picture on the left and the "after" on the right.

1. **The wash under the rail** (`upright-threads-top.jpg`, the top of the Threads page). Before: a plain black block stands behind the clock and the rail's top, where the rail had a column of its own. After: the wash runs on to the screen's right edge. Along the top row of the source pictures, the two samples nearest the right edge read RGB (4, 5, 7) before and (47, 46, 24) after, which is the wash.
2. **Threads, scrolled** (`upright-threads-scrolled.jpg`). Before: the cards stop at a band under the status bar. After: "Needs you" and "Working now" scroll on to the top edge and pass under the clock. The cards keep clear of the rail.
3. **A thread, scrolled up** (`upright-thread-earlier.jpg`). Before: the first message fades out under the band. After: the messages run to the top edge. Text, the code block and the tables end at the rail rather than running under it.
4. **Watcher, scrolled up** (`upright-watcher-earlier.jpg`). The same as the thread: the page's top line scrolls up under the clock.

## Folded and sideways

The fix applies only upright. The rail's space is added only when `duoLayout` is `.upright`, and the status bar's fade keeps its old form in every other posture. The same run took all 66 folded and sideways shots. `folded-threads-dark` and `sideways-threads-dark` were checked by eye and look as before.

## Tests

The 25 capture tests passed: 11 folded, 11 sideways and 3 upright.

## Limits

- **Not seen:** a real Duo, VoiceOver, the accessibility text sizes and reduced motion. The simulator's pictures are dark mode, apart from the light shots of the Threads page and a thread.
- **Computers, Settings, a computer's page and a delegated thread** take the same rail space as Threads, Watcher and an open thread. They were checked by compiling only; the captures don't open them upright.
