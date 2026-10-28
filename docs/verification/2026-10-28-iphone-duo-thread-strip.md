# iPhone Duo thread strip verification

October 28, 2026, on `fix/iphone-duo-thread-strip`. This is ADR-0151's fourth amendment. Captures were taken on the iPhone Duo simulator (iOS 27.1, Xcode 27.1), booted headless, with the Debug-only `--ui-fixture`, `--ui-still`, `--ui-watcher` and `--ui-open-thread <id>`, the fold moved by `capture.sh` from the tag `prototype/iphone-duo-layout`.

## What went wrong

On Drake's Duo (TestFlight build 37, the first built with Xcode 27.1) a thread's strip held iOS's Back button, then the owl, with the "Working" pill drawn across the strip under it. The simulator showed the same (`artifacts/iphone-duo-thread-strip/folded-thread-before.jpg`). UIKit 27.1 moves a page's bar items into the vertical bar where it can (`UIBarButtonItem.AxisBehavior`), and the thread's state, Watch and ••• are one item, far wider than the strip.

## What the captures show

1. **Folded, a working thread** (`folded-thread.jpg`): the state, the owl and ••• sit in the bar over the thread's column, beside the title once it has scrolled off. The strip holds only Back, under the clock, battery and page dots. Nothing overlaps.
2. **Folded, a thread that needs you** (`folded-thread-request.jpg`): the same bar with Watch named, over the question sheet.
3. **Unfolded** (`open-thread.jpg`): the same bar at the top, the strip holding only Back.
4. **Folded, Watcher** (`folded-watcher.jpg`): unchanged, the tab rail in the strip.
5. **Upright iPhone** (`upright-thread.jpg`, iPhone 17 Pro on iOS 27.0, since the 27.1 runtime here offers only the Duo): unchanged. An upright iPhone has no vertical bar, and before iOS 27.1 the code path is the old one.

`sh apps/ios/Scripts/verify.sh` passed: the string check, 165 package tests and the simulator build. No unit test reads where iOS puts a bar item, so the captures are the evidence.

Not checked here: a real Duo, light appearance, and VoiceOver order in the strip.
