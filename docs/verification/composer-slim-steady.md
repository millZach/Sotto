# The slim composer moves without moving anything else, the scene never blinks, and nothing round the composer or the scrubber is a box

October 24, 2026. `fix/composer-slim-jump-double-scrollbar`, on Windows 11 at 150% display scaling, with the built app (`npm run build`). It fixes what the user reported on Owl 0.1.41-owl.20261024.1, in Watcher and in threads, after #1458 (the floating composer), #1472 (the slim composer and Watcher's column over the still night scene) and #1471 (keeping the reader's place in Watcher's conversation).

## What the user saw

From the user's recording (12.7 seconds at 150%, Watcher first, then a thread):

- **Two scroll bars at the end of Watcher.** At rest at the end, a full-height bar stood beside the transcript's own (0.0 s, 2.0 to 2.8 s, and from 3.7 s on). In threads one showed for a moment as the composer came back full (10.4 s).
- **The view jumped when the composer slimmed or widened.** Slimming (0.8 s), the card leapt about 94 px up into the conversation, with words showing under it. Widening (1.8 s in Watcher, 10.4 s in a thread), the card went off the bottom of the pane for a frame and the transcript resized, moving the words 62 px with no scroll from the reader.
- **The screen blinked.** Each time the composer slimmed or widened, Watcher's night scene went blank for 1 to 6 frames (0.37 s, 0.80 to 0.88 s, 1.27 to 1.33 s, 1.68 to 1.77 s), and came back with its trees and owls somewhere else.

## Why

- **The card was moved twice.** The slim motion animated the card's height with the card standing at the composer's foot, and also translated it by the change in its top, which already followed the height. Slimming, it started 94 px too high.
- **Widening, the composer's box followed the card's moving height.** Only a slim composer kept the full card's room; the moment it was full again its box was as tall as the card in motion. The pane measured it every frame and wrote that height as the transcript's room, so the transcript changed size, the pane had up to 157 px to scroll (a second scroll bar), and the card stood below the pane's foot. A widening card also holds its full content, cut only by its clip path, which the pane could still scroll to.
- **The composer's height was read in whole pixels.** `offsetHeight` rounds. At 150% Watcher's composer with its compaction line is 188.58 px, read as 189: the transcript, which fills what the composer's room leaves, ran 0.42 px past the pane's foot, and the pane kept a scroll bar of its own at rest. A thread's composer without a second line rounded down, so threads kept only the brief one.
- **The scene laid itself out by the moving card.** Watcher's night scene measured the card every frame of the move, and slim it measured a card whose row underneath had stepped away, so it laid out somewhere else at each change. Laying out clears its canvases, and it drew again only on a later frame: the blank. The pane's brief scroll bar also narrowed the transcript, which moved the message scrubber's lane 5 px and laid the scene out once more after the move.
- **With motion reduced, the room lagged.** Reduced motion gives every property a 1 ms transition (`global.css`), so the composer's room grew from 0 when it slimmed, and the pane measured the slim card as the room: 59 px for the pane to scroll.

## What changed

- `slimComposer.ts`, `threads.css`: while the card moves, the composer carries `data-slim-moving`. It keeps the full card's room and stands the card at its foot both ways, and the pane clips at its own edges rather than scrolling, so the content a widening card already holds is never something to scroll to, and a picker opening above the card is not cut. The card is moved only by any change in its foot.
- `threads.css`: while slim, the branch toolbar and the row under the card hide but keep their place, so the card's foot never moves and only its top comes down. The user, shown the first pass, saw the card slide down by the row's height as it finished: "no movement other than the shrink of the composer".
- `ThreadPane.tsx`: the pane reads nothing while the card moves, reads the composer's height to the fraction of a pixel, and remembers the full card's exact height and how far its foot stands above the composer's.
- `threads.css`: the composer, its card and its field take no transitions, so their size changes at once with motion reduced too.
- `nightScene.ts`, `WatcherNightScene.tsx`: the scene holds its layout while the card moves, keeps the full card's place while the composer is slim (`heldRoom`, and the remembered height and foot when the room changed meanwhile), and draws in the same frame it lays out, so its canvases never show blank. An end-to-end run counts its layouts on the pane (`data-night-scene-layouts`).

## The scene never blinks

The user's rule, the same day: whatever changes in Watcher, the night scene never goes black, not for one frame. `watcher-scene-steady.spec.ts` records every frame the screen draws while the room gets a reply with a fold under it, opens and closes the fold, slims and widens the composer, opens Watched and comes back, takes a draft, takes three changes of its projection from the stand-in (an owl wakes, a newcomer joins, a question waits) and is resized. It reads the scene's glyphs in the left margin of each frame and fails on any frame that loses most of them.

On `origin/main` it failed: 29 blank frames of 443, while the composer slimmed (11) and widened (12), on Watched and back (1 each) and while the window was resized (4). Each was a layout: laying the scene out clears its canvases, and it drew again only on a later frame. On this branch it passes, 445 frames with none blank. Beyond the layouts, which now draw in their own frame, the painter no longer clears its canvases when the room has no composer for a moment, as between one Watcher and the next: the scene keeps its last frame until it can draw the next. The scene's own motion (its owls, stars and ripples) and a resize of the window still move it, as they always have; a reply, a fold, the composer, the tabs and the room's updates do not.

## The scrubber's lane floats

The user pointed at the message scrubber's ticks beside Watcher's conversation: "right now the lane is a long rectangular black box". The lane paints nothing of its own, in a thread or in Watcher; the box was the night scene, which counted the lane among the room's still words and drew nothing within it, so the hills and the ground broke off in a straight-edged empty strip down the margin.

- `nightScene.ts`, `nightScenePainter.ts`: the lane is no longer a word. The sky and the hills run on under it at the column's share and under the column's ink ceiling, and no owl, ripple or glow is drawn in it (`inLane`). The left margin's tree and owls are still laid out from its outer edge (ADR-0109, Zach's pick on October 22).
- `nightScene.css`: in Watcher the ticks take the secondary tier where they would be muted, as the names and times do (pick D2), so the ceiling keeps them clear of the glyphs. A soft canvas glow under each tick was tried first; with the ticks 9 to 20 pixels apart the glows joined into a dark band, a box again, so it was dropped.
- `messageScrubber.css`: once the pointer or the keyboard reaches the lane, every tick is drawn at 80% or more of its colour, so the far ones keep 3:1 too, in a thread as in Watcher. In light themes the far ticks had 2.4:1 over the bare room before.

`watcher-night-scene.spec.ts` now checks that the lane paints no background, that the landscape runs under it wherever it runs in the margin beside it, that no owl is drawn in it and no owl's button lies over it, and, from captures with the scene shown and hidden, that the ticks reached by the pointer keep 3:1 against the pixels beside them (5.3:1 by night, 3.9:1 by day) while the resting lane stays faint, about 1.3:1 over the scene against 1.8 to 2.2 over the bare room, as ADR-0109 means it to. `message-scrubber.spec.ts` checks that a thread's lane paints nothing and that its ticks reached by the pointer keep 3:1.

## No edge round the composer

The user asked, the same day, for the thin border round the composer to go. A thread's card had no edge at rest, pointed at or with focus since October 23; what the user saw was Watcher's glass card, which kept a faint hairline in every state, and the two edges a thread's card wore to say something: the activity colour while a turn runs, and the effort colourway's outline with a travelling ring at a model's highest level. Asked whether those two should stay, the user chose every edge, and the caret alone for focus.

- `threads.css`: the running edge, the highest-effort outline, its tint transitions and its ring (`::after`, moving and still) are gone. The card keeps a transparent border, so it keeps its size, and the arrival's tide through the card stays.
- `nightScene.css`: Watcher's glass card loses its hairline.
- `themes.css`, `global.css`: Settings → Appearance's effort sample shows the composer without the outline too, and the ring's keyframes and angle property, which nothing uses now, are gone.
- ADR-0110, ADR-0019 and ADR-0126 are amended; `CONTEXT.md` and `docs/guide.md` no longer promise the outline.

`composer-no-edge.spec.ts` reads the composer, its card and its field, with their `::before` and `::after`, for any border with a colour, outline, shadow or ring. On a thread and on Watcher, in each of the six built-in themes, dark and light: at rest, pointed at, focused by a click and by Tab, and slim; on a thread also at the highest effort, running at the highest effort, and idle again. Run on the build before this change it failed on Watcher's hairline in every theme and state and on the running edge; on this branch it passes. The highest effort's outline was already covered the other way round by `effort-picker.spec.ts`, which now expects none at every level.

The user also asked about a creature above the composer sitting in a black box, then withdrew it: the creature does float. Nothing about the creature changed here.

## How it was run

```sh
npm run typecheck
npm run lint
npx vitest run tests/unit/renderer/slimComposer.test.tsx tests/unit/renderer/watcherNightScene.test.ts tests/unit/renderer/readingPlace.test.ts tests/unit/renderer/threadWorkspace.test.tsx tests/unit/renderer/themeTokens.test.ts
npm run build
SOTTO_E2E_EVIDENCE=publish npx playwright test tests/e2e/composer-slim-steady.spec.ts tests/e2e/composer-no-edge.spec.ts tests/e2e/watcher-scene-steady.spec.ts
npx playwright test tests/e2e/watcher-night-scene.spec.ts tests/e2e/message-scrubber.spec.ts
npx playwright test tests/e2e/effort-picker.spec.ts tests/e2e/composer-shrink.spec.ts tests/e2e/watcher-column.spec.ts tests/e2e/watcher-night-scene.spec.ts tests/e2e/composer-float.spec.ts tests/e2e/claude-bot-creature.spec.ts
npm run design:verify
```

`composer-slim-steady.spec.ts` runs at 150% scaling at 1280x800, on Watcher with five watched threads and a thread, each with a second line under the composer as the compaction line gives Watcher. It reads every frame while the composer slims and widens. In each frame the transcript keeps its height, the message under the reader's eye has moved by the scroll asked for and no more, the pane has nothing to scroll, the card shows, opaque and on top, on the pane, its top between where it stood and where it goes and its foot where it stood, and on Watcher the scene neither lays out again nor goes blank. Then the reader's own wheel slims and widens it, and at the end the pane has nothing to scroll. At rest at the end, with the composer's height an eighth of a pixel over each of eight steps, the pane has nothing to scroll and the transcript stops at the pane's foot. With motion reduced the composer changes in the first frame, with no motion, and the same checks hold.

Run on `origin/main` (the before), it failed each of those: the card's top 94 px out, the pane with 157 px and then 0.42 px to scroll, the transcript changing height by up to 94 px, the card 74 px off the pane, the scene laid out again and blank, and 59 px to scroll with motion reduced (`artifacts/composer-slim-steady/before-readings.json`). On this branch all three cases pass (the per-case `*.json` beside it).

`composer-shrink`, `watcher-column` (its 4.5:1 contrast for every word over the scene and on the glass, in every built-in theme), `watcher-night-scene`, `composer-float` and `effort-picker` pass, and the place keeper's unit tests (#1471) pass. `npm run design:verify` changed in `threads-populated` (a running thread's composer edge) and `appearance-system-dark` (the effort sample's outline), both on purpose, and those two baselines are updated. Its other two changes, `scale-125-onboarding` and `widget-idle-light`, are a pixel or two of height on this machine in surfaces this change does not touch, and their baselines are left as they were.

`composer-short-window.spec.ts` (an attached image at 820x560), the "stable shows no scrubber" case of `message-scrubber.spec.ts` and the "readout is words on the room" case of `claude-bot-creature.spec.ts` fail on this machine on `origin/main`'s source as well, the same way, so they are not this change. In the unit suite, `hostBuildScripts.test.ts` and `stableHostPromotion.test.mjs` need Node 24.22.1 and this machine has 24.14.1; the rest passes.

## Evidence

In `artifacts/composer-slim-steady/`, before from `origin/main`, after from this branch, Watcher with its compaction line at 150%:

- `scrollbars-at-end.png`: the right edge at rest at the end. Before, the transcript's bar and a full-height one for the pane; after, one.
- `slimming-moment.png`: the second frame of slimming, before above and after below. Before, the card stands up in the conversation and the scene is gone; after, the card shrinks at its foot over the scene.
- `widening-moment.png`: a frame of widening. Before, the card is off the pane, a second scroll bar shows and the scene is blank; after, the card grows in place.
- `watcher-before.mp4`, `watcher-after.mp4`, `thread-before.mp4`, `thread-after.mp4`: the screen as drawn while each pane slims and comes back full, slowed down.
- `watcher-wheel-after.mp4`, `thread-wheel-after.mp4`: at real speed, the reader's wheel scrolling back until the composer slims and down until it widens, after.
- `scene-slim-frames-before.png`, `scene-slim-frames-after.png`, `scene-before.mp4`, `scene-after.mp4`: twelve frames as Watcher's composer slims, and the whole run of room changes, before and after; `before-scene-ink.json` and `scene-ink.json` have every frame's ink and the step it was drawn in.
- `reported-double-scrollbar.png`, `reported-blank-scene.png`, `reported-lane-and-hairline.png`: what the user sent: the two scroll bars at the end of Watcher, the blank scene at 0.83 s of their recording (`2026-10-24_09-20-49.mp4`, kept on their machine), and the scrubber's lane with Watcher's glass hairline.
- `lane-before-after.png`: the scrubber's lane in Watcher's left margin, before by night, after by night and by day.
- `edge-*.png`: the composer's card in each state the edge check reads, after; `edge-before-after-watcher-rest-dark.png`, `-watcher-rest-light.png`, `-watcher-focus-dark.png` and `-thread-running-dark.png` pair before (above) with after (below).

The user looked at these on their phone before the pull request opened; their first look found the card's foot still sliding as it slimmed, which is fixed above. The header differs between the two captures because `main` moved between them; the change here does not touch it.
