# The transcript runs under a waiting question's card

## Result

Drake saw a black background behind Watcher's question card. Nothing behind the
card paints black. Every pixel around the card in his screenshot is the
theme's canvas (16, 20, 23 in his theme), the same as the conversation above
it. What read as a slab was the transcript ending in a hard line about 10px
above the card. A waiting question stacks the composer under the transcript
(`.thread-pane[data-questions]`, since the composer started floating on
October 23, 2026), so the transcript's scroller stopped at the composer's top.
A message crossing that edge was cut flat, with empty canvas between the cut
and the card. Thread panes did the same.

The scroller of a pane with a waiting question now reaches 26px further down,
under the composer's top padding and the card's rounded corners, with 26px more
bottom padding so its end still clears the card. The transcript's box, the
composer and the card keep every size and position they had, so short panes and
the 420px container rules behave as before. Nothing changed in the quiet
composer or pill work merged on October 29.

## How it was checked

No app was launched. The real `WatcherView` and `ThreadsView` were rendered in
jsdom from a scratch test (deleted afterwards), with a pending question on
Watcher's own thread and on a project thread and 24 messages so the transcript
overflows. The dumped DOM was then drawn in headless Chromium against the
renderer's whole stylesheet as esbuild bundles it from `main.tsx`, with the
theme applied by `applyAppearance`. The transcript was scrolled so a message
crossed the card's top edge.

| Size | Transcript box | Composer top | Card top and height | Scroller |
| --- | --- | --- | --- | --- |
| 1600x1000 | 359 before and after | 446 before and after | 456, 416 before and after | 359 → 385 |
| 1280x800 | 160 before and after | 247 before and after | 257, 415 before and after | 160 → 186 |
| 820x560 | 96 before and after | 183 before and after | 187, 261 before and after | 96 → 122 |

At the end of the transcript the last line sits where it did before. Checked in
the Sotto theme dark and light, at 820x560 and in Citrine dark. Glass was
checked by its colours only: headless Chromium cannot draw a see-through window,
and the change sets no colour.

- [Watcher, before](../../artifacts/question-card-edge/watcher-before-dark.png)
- [Watcher, after](../../artifacts/question-card-edge/watcher-after-dark.png)
- [Watcher, after, light](../../artifacts/question-card-edge/watcher-after-light.png)
- [Watcher, after, 820x560](../../artifacts/question-card-edge/watcher-after-dark-820x560.png)
- [Thread pane, before](../../artifacts/question-card-edge/thread-before-dark.png)
- [Thread pane, after](../../artifacts/question-card-edge/thread-after-dark.png)
