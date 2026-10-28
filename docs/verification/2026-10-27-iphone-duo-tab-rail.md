# iPhone Duo tab rail verification

October 27, 2026, on `feat/iphone-duo-tab-rail`. This is ADR-0151's second amendment. Captures were taken on the iPhone Duo simulator (iOS 27.1, Xcode 27.1), booted headless, with the Debug-only `--ui-fixture`, `--ui-still` and `--ui-watcher`, the fold moved by `capture.sh` from the tag `prototype/iphone-duo-layout`.

## Where the strip is

A probe logged the folded Duo's scene at launch: the screen is 466×678 points (1398×2034 pixels at 3x), the app's window is the same 466×678, and its safe-area insets are 0 top, 0 left, 34 bottom and 84 right. The strip under the clock and battery is the 84-point trailing inset, inside the window, so the app may draw there. Before Sotto drew its own bar, the system's tab rail stood in it (`artifacts/iphone-duo-layout/00-now-folded-watcher.jpg`).

## What the captures show

1. **Folded, Threads** (`artifacts/iphone-duo-tab-rail/folded-threads.jpg`): the four tabs stand in the strip from its bottom, clear of the clock, battery and page dots. Threads is in the accent with its badge. The page runs to the bottom of the screen.
2. **Folded, Watcher** (`folded-watcher.jpg`): the owl carries its working dot, in the accent as the chosen tab.
3. **Folded, a thread** (`folded-thread.jpg`): the rail goes under the thread, and iOS puts the thread's Back button in the strip.
4. **Unfolded** (`open-threads.jpg`): unchanged, the bar along the bottom.

A one-off UI test, not committed, found `tab-computers` at x 382, 84×52 points, in the 466×678 window, and a tap on it, then on `tab-watcher`, chose each.

Not checked here: a real Duo, light appearance, VoiceOver order, and the accessibility text sizes in the rail (icons only, so no text to grow).
