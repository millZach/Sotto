# iPhone narrow thread bar verification

October 29, 2026, on `fix/iphone-narrow-thread-bar`. This is ADR-0151's fifth amendment. Captures were taken with Xcode 27.1 on the iPhone Duo simulator (iOS 27.1), booted headless and folded or unfolded with the posture tool from the tag `prototype/iphone-duo-layout`, and on an iPhone 17 Pro simulator (iOS 27.0), with the Debug-only `--ui-fixture`, `--ui-still`, `--ui-watcher`, `--ui-agents`, `--ui-watcher-asks`, `--ui-long-thread`, `--ui-light` and `--ui-open-thread <id>`. Each "before" is the same build without this change.

## What went wrong

Drake's folded Duo (two screenshots, October 29) showed a thread's bar with **Agents** as a bare mark with no count, **Watch** cut to one letter and the title cut to "Next prompt…", and Watcher's **Answer Watcher's request first.** as a thin full-width pill over the question card under it.

The bar's words were squeezed, not clipped by the strip. Where a bar is short, iOS gives its trailing group the smallest size the group can take, so every word in it that can shrink shrinks to nothing. The state was already held at its own size, so Agents and Watch gave up their words first. The simulator showed the same, and showed it on an upright iPhone 17 Pro too, where the group also ran into Back (`folded-thread-before.jpg`, `upright-thread-before.jpg`).

The pill was one of two notices over the reply box with only words in them and 8 points above and below. The reconnecting line, the message banner and the cards around the box use 12; the other notices, Try again's and Undo's, are as tall as their buttons.

## What the captures show

1. **Folded, a working thread with agents and Watch** (`folded-thread.jpg`): the title, Agents as its mark, light and count, Working, the owl and •••, all whole. The strip holds Back, as before.
2. **Folded, a finished thread with a long title** (`folded-done.jpg`): the title gets about 165 points.
3. **Folded, Largest text** (`folded-thread-largest.jpg`): the group fits whole; the title gives way.
4. **Upright iPhone 17 Pro** (`upright-thread.jpg`): Back, then the same group, apart from it.
5. **Unfolded** (`open-thread.jpg`): regular width, unchanged: Agents, Working with its time, Watch and the whole title.
6. **Folded, Watcher waiting on its own question** (`folded-watcher.jpg`): the notice has the 16 and 12 points of padding that the cards around it have, on the same type step as their second lines.
7. **Folded, a watched thread** (`folded-watched.jpg`): the watched line has the same padding.
8. **Light** (`folded-thread-light.jpg`, `folded-watcher-light.jpg`): the same.

`node apps/ios/Scripts/check-strings.mjs` passed (no strings changed) and the simulator build succeeded. No unit test reads how iOS sizes a bar item, so the captures are the evidence.

Not checked here: a real Duo, VoiceOver, and the accessibility text sizes at the iPhone SE's width with Agents, Watch and ••• all showing, where the group, held at its own width, may be wider than the bar and run into Back, as it did before this change at the default size on a 402-point iPhone.
