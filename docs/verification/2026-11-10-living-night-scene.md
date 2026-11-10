# The living night scene: line art and depth

November 10, 2026. [ADR-0199](../adr/0199-watchers-night-scene-comes-to-life.md), decisions 1 to 5. Owl only, behind `living-night-scene`. Prototype: tag `prototype/watcher-scene-life`.

## What was run

On the Windows laptop, after `npm run build`, on the Owl track, with main's Watcher stood in for by each spec's seeded room. Each spec runs in order and stops at its first failure, so the tests were run by name.

`tests/e2e/watcher-night-scene.spec.ts`:

1. **The first entry and a conversation with thread owls at three sizes, dark and light: passed.** At 1600 by 1000 and 1280 by 800 the pane reports the night wood drawn as line art and holds one halo; at 820 by 560, where the margins show the rail of eyes, it reports density and no halo. Nothing overflows the window at any of the three.
2. **A conversation longer than its window, reduced motion, Watcher's own owl glowing in dark and light, and a newcomer out of the moon: passed**, five tests.
3. **The message scrubber's lane, dark and light: failed, and not from this change.** The check reads the resting ticks' contrast as 1 over the scene and 1 over the bare room, the room with the scene's canvases hidden, so it is not finding the ticks at all.

`tests/e2e/watcher-column.spec.ts`:

4. **Every word keeps 4.5:1 over the scene, in every built-in theme and in every place with its moving glyphs, dark and light; over a ripple, dark and light; and an owl crossing the column shows behind the words: passed**, seven tests.
5. **The composer floats as glass and slims while reading back, dark and light: failed, and not from this change.** At 1600 by 1000 the check reads `underStrip` as false where it expects true. Why was not looked into.

`tests/e2e/watcher-scene-steady.spec.ts`:

6. **The night scene never blinks while the room changes: passed.**

The four failures in 3 and 5 fail with the same words on `main`'s own source at `fd2d17e39`, built and run the same way in the same checkout.

The three specs opened the room through the Page switch's Watcher tab, which the Threads rail has not had under a 1000 pixel window since November 5 (ADR-0110). They now press the room's keys there, as `watcher.spec.ts` does.

## What it looks like

- [room-dark-1600.png](../../artifacts/living-night-scene/room-dark-1600.png): Watcher's room at 1600 by 1000, dark. The trunks have edges of `|`, the bare tree's branches are `/`, `\` and `|`, the ridges in the margins are lines of `_` and `-`, the river is a run of `/` in the accent, and the moon stands in its halo. Under the conversation the hills are rows of dots.
- [room-light-1280.png](../../artifacts/living-night-scene/room-light-1280.png): the same room at 1280 by 800, light.

## Not checked here

- macOS and Linux.
- How a dragged window edge feels in the running app. Laying the scene out was timed with the painter alone in headless Chromium, twelve layouts at shrinking sizes: about 22 ms as line art against 8 ms by density at 1600 by 954, 29 ms against 9 ms at 1920 by 1034, and 15 ms against 5 ms at 1280 by 754. It runs on a change of size, place or feature, never for a frame.
- A change of place between the night wood and one with no layers, in the running app. The painter's unit tests cover it; no spec switches place with the feature on and looks at the halo.
