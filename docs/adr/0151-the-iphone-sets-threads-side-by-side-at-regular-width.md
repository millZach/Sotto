# The iPhone sets Threads side by side at regular width

## Status

Accepted October 27, 2026. Drake picked layout 7 of eight from `docs/prototypes/iphone-duo-layout-prototype.html`, kept at the tag `prototype/iphone-duo-layout`, captured on the iPhone Duo simulator. It changes only how the iPhone client lays out its pages; no computer offers anything new, so there is nothing to gate.

Amended October 27, 2026 by the tab bar's amendment to [ADR-0051](0051-the-iphone-takes-the-glow-look.md): Sotto now draws its own tab bar on the page. It sits along the bottom at every width, so the unfolded Duo shows it along the bottom too, not as a rail at the right edge. The columns get the screen's full width and lose the bar's height.

Amended October 27, 2026: on the folded Duo's cover screen the bar stands in the strip down the right edge. That screen is 466×678 points and the app's window covers all of it; the strip is an 84-point safe-area inset on the trailing side, under the clock and battery, so the app may draw there, as the system's own tab rail did before Sotto drew its bar. Drake asked for the tabs there. So when the width is compact and one side's inset is at least 60 points wider than the other's, the bar is a rail in that strip: the same tabs, badges and Watcher's dot, icons only, the chosen one in the accent, stacked from the bottom of the strip and clear of the clock and battery. Pages get the whole height. The rail goes under a thread and the keyboard as the bar does, which leaves the strip to the thread's Back button. Every other layout, the unfolded Duo included, keeps the bar along the bottom.

Amended October 28, 2026: the rail did not show on Drake's iPhone Duo (TestFlight builds 35 and 36, iOS 27.2). The bar stayed along the bottom of a page about 357 points wide, with nothing of Sotto's in the strip. Those builds were linked against the iOS 26.6 SDK, since the TestFlight workflow used Xcode 26.6, while the simulator captures above were built with Xcode 27.1. UIKit's 27.1 headers call the strip the vertical bar and say it brings a leading or trailing safe-area inset into the app's window, so the code reads it the right way. Our inference, not yet seen on the device, is that iOS gives an app linked against an older SDK a window beside the strip, as it letterboxed apps built before the iPhone X. TestFlight now builds with Xcode 27.1 (ADR-0032, amended). Until the phone confirms it, Settings → About carries a line of numbers: the window's size and position, the screen's size, then the window's safe-area insets top, left, bottom and right. A window narrower than the screen means the strip is still outside it. The line is numbers only, so it needs no translations, and it goes once the phone has settled this.

Amended October 28, 2026: iOS 27.1 moves a page's trailing bar items into the vertical bar beside it, so on Drake's Duo a thread's state, Watch and ••• went into the strip as one item too wide for it and overlapped. A thread marks that group horizontal-only: it stays in the bar over the thread's column, folded and unfolded, and the strip holds only iOS's own Back button under the page dots. An upright iPhone has no vertical bar and is unchanged.

## Context

The iPhone Duo folds. Folded, its cover screen gives the app 382×644 points at compact width, and Sotto looks as it does on any iPhone. Unfolded, the inner screen is landscape, 951×669 points. Beside the tab bar, which iOS 27.1 draws as a floating rail at the right edge, the app gets 867×635 points at regular width. The client had no layout for regular width, so every page stretched to the full 867 points: a thread's lines ran to about 140 characters and its tables spread across the screen.

The eight layouts tried were: the Threads list beside the open thread; two threads, one on each half; Watcher beside Threads; every page at a reading width; a column of every waiting request beside the open thread; a labelled sidebar in place of the tab bar; Threads' sections side by side; and a strip of thread marks beside the open thread. Each one that shares the screen between two pages meets two things in the way. iOS draws a pane's Back button in the status column at the right edge, away from its pane, and Sotto's model holds one open thread's conversation at a time.

## Decision

1. **Threads sets its sections side by side.** At regular width the Threads home lays Needs you, Working now and Recent (with Settled under it) out as columns. The columns share the width, and a section with no threads takes none, as on the phone. They are the same cards, answered the same way. At the accessibility text sizes a third of the width can't hold a title, so the page keeps its one column there. The heading, the computer menu, search and the counts sit above them in one row instead of three, and the whole page still scrolls as one and refreshes on a pull.
2. **A thread and Watcher keep a reading width.** At regular width a thread's conversation and reply box, and Watcher's bar, conversation, box and Watched page, are 680 points wide in the middle of the screen. A drag in the margins still scrolls the page.
3. **Compact width is unchanged**, which covers the Duo folded and every other iPhone held upright. A Max iPhone held sideways is also regular width, so it gets the columns too. Its 440 points of height scroll as one page, as the single column did.
4. **One page at a time.** Nothing shares the screen between two pages, so no Back button sits away from its page, and the model keeps one open thread.

## Consequences

- `readingWidth()` in `Design.swift` is the one place the 680 points are kept. A new page that should read the same at regular width uses it.
- A thread and Watcher still open over the whole screen, as on the phone. A request sheet opens over a thread in the middle of the screen, as iOS draws a sheet at regular width.
- Laying two pages beside each other later means a second open conversation in the model and a second subscription to its computer. That is a decision of its own.
