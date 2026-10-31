# iPhone Duo tab rails, thread sidebar and New thread verification

October 30, 2026, on `feat/iphone-duo-tab-rails`. This is ADR-0151's October 30 amendment, Zach's picks from `docs/prototypes/iphone-duo-tab-rails-prototype.html`. Captures were taken on the iPhone Duo simulator (iOS 27.1, Xcode 27.1) on GitHub's `xcode-27` runner, with the Debug-only `--ui-fixture`, `--ui-still` and `--ui-watcher` under the Glass theme, the fold moved by the posture tool from the tag `prototype/iphone-duo-layout`. The capture script lived on a throwaway branch, `chore/ios-captures-duo-rails`, with a probe that logged the window to a file.

## Where the screens are

The probe logged both positions. Folded, the app's window is 382×644 points inside a 466×678 screen, with safe-area insets 0 top, 0 left, 34 bottom and 84 right, at compact width and regular height. Unfolded and held the way the inner screen opens, the window is 867×635 with the same 84-point strip on the right, regular in both directions, so `MainTabs` reads it as sideways with the strip trailing.

## What the captures show

All in `artifacts/iphone-duo-tab-rails/`.

1. **Folded, Threads** (`folded-threads.jpg`): New thread's round button stands in the strip just under the clock and battery, the four tabs are centred below it, icons alone, Threads filled on its chip with its badge. The page heading has no **+**.
2. **Folded, Watcher** (`folded-watcher.jpg`): the owl is filled on the chip and keeps its working dot; New thread is still on the rail.
3. **Folded, a thread** (`folded-thread.jpg`): as before, the rail goes under the thread and the strip holds iOS's Back.
4. **Sideways, Threads** (`sideways-threads.jpg`): the rail and New thread stand in the clock's strip; the columns are as on `main`.
5. **Sideways, a thread** (`sideways-thread.jpg`, light in `sideways-thread-light.jpg`): the 280-point sidebar lists Needs you, Working now and Recent, the open thread on the accent chip; the thread's bar has the sidebar button where Back was; the rail stays beside the thread with Threads chosen.
6. **Sideways, sidebar hidden** (`sideways-thread-collapsed.jpg`, launched with `-phoneDuoSidebarHidden YES`): the thread takes its 680-point reading width again.
7. **Sideways, rail on the left** (`sideways-thread-left.jpg`, launched with `-phoneDuoTabsSide left`): the rail stands in its own column down the left edge, the sidebar beside it, and the clock's strip is empty.
8. **Sideways, Watcher** (`sideways-watcher.jpg`): the conversation fades out above the box, so nothing shows beside **+**. This is #1868's fade, now on `main`, and it is the fix for the stray "at" Zach saw there.
9. **Upright layout** (`upright-layout-watcher.jpg`, `upright-layout-sidebar.jpg`): see the limit below. The tabs run along the bottom with New thread at the row's right end, away from the reply box's **+**; the sidebar over a thread keeps a **+** of its own.

## Limits

- **Upright is drawn, not turned.** The simulator would not turn the unfolded Duo: the app's request failed with "The current windowing mode does not allow for programmatic changes to interface orientation", the posture tool has no orientation argument, and the runner has no Simulator app to rotate it. The two upright captures force the upright layout inside the sideways window with a flag that exists only on the capture branch, so they show how the row and the sidebar draw, not the upright window's real size or insets. The code takes upright to be regular in both directions with no side strip; a real Duo held upright confirms that.
- **No regular iPhone on iOS 27.1.** The iOS 27.1 runtime on the runner offers no iPhone but the Duo. Regular iPhones are left to CI's journeys on iPhone SE and iPhone 16 Pro Max (Xcode 26.6), where `DuoLayout` is `.none` and the bar is the code it was.
- **Not seen:** a real Duo, VoiceOver, the swipe itself, the Settings panel (it sits below the first screen of Settings) and the accessibility text sizes.
