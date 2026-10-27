# iPhone Duo columns verification

October 27, 2026, on `feat/iphone-duo-columns`, from `main` at 7afc940d. This is ADR-0151. Captures were taken on the iPhone Duo simulator (iOS 27.1, Xcode 27.1) with the Debug-only `--ui-fixture` host, `--ui-still` and `--ui-watcher --ui-watcher-can-answer`. The simulator was booted headless, and nothing opened on the Mac's screen. Xcode 27.1 has no Simulator app, so the fold was moved with SpringBoard's display tool service from a small simulator-side tool, kept with `capture.sh` at the tag `prototype/iphone-duo-layout` under `apps/ios/Prototypes/duo/`. `--ui-open-thread <id>` and `--ui-open-watcher`, both Debug-only, opened the pages. `sh apps/ios/Scripts/verify.sh` passed: the string check, 273 package tests with one skipped, and the simulator build.

## What the captures show

1. **Unfolded, Threads** (`open-threads.jpg`): the size class is regular, and the app has 867×635 points beside the system's tab rail. Needs you, Working now and Recent stand side by side under one row of computer menu, search and counts. The question cards keep their choices and Send answer at a third of the width. Settled sits under Recent, folded.
2. **Unfolded, a thread** (`open-thread.jpg`): the conversation, its tables and the reply box are 680 points wide in the middle. The bar stays the full width.
3. **Unfolded, a question** (`open-question.jpg`): the request sheet opens in the middle of the screen over the thread, as iOS draws a sheet at regular width.
4. **Unfolded, Watcher** (`open-watcher.jpg`): the bar, the conversation and the box are 680 points wide. The waiting card under the box is there folded too, and on `main`.
5. **Folded** (`folded-threads.jpg`, `folded-thread.jpg`, `folded-watcher.jpg`): the size class is compact, the app has 382×644 points, and every page is as on `main`.
6. **Light, and accessibility text** (`open-threads-light.jpg`, `open-threads-large.jpg`): the columns read in light. At the system's accessibility-large size, three columns broke titles mid-word, so at the accessibility sizes the page keeps its one column; the capture is after that change.
7. **A Max iPhone held sideways** (`max.jpg`, iPhone 17 Pro Max on iOS 27.0, turned by the app for the capture): it is regular width too and gets the columns. The page's 440 points of height scroll as one, the way the single column did.

Not checked here: VoiceOver order across the columns, and a real Duo.
