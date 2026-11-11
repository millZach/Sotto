# The living night scene

November 10, 2026. [ADR-0199](../adr/0199-watchers-night-scene-comes-to-life.md), all eleven decisions. Owl only, behind `living-night-scene`. Prototype: tag `prototype/watcher-scene-life`. The drawing was checked first, then the owls, then the wood's life, each on its own build; the later two are at the end of this note.

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

## The owls

The same specs, by name, after the owls were built, on a fresh build:

7. `watcher-night-scene.spec.ts`: the same seven tests as 1 and 2 passed, among them the one that holds a resting scene to painting only what changes.
8. `watcher-column.spec.ts`: every word keeps 4.5:1 over the scene in every theme and place and over a ripple, six tests, passed. **An owl crossing the column** failed as it stood: it waited for Watcher's owl to fly at random, which the living scene no longer does. It now has Watcher send the first watched thread a message fifteen seconds after the room opens; the owl flies across the column to call to that thread's owl, shows behind the words at 4.5:1 or better, never over them, and leaves nothing behind. It passed.
9. `watcher-scene-steady.spec.ts`: passed.

## The wood's life

The same specs, by name, after the wood's life was built, on a fresh build:

10. `watcher-night-scene.spec.ts`: the seven tests passed. The night wood now paints eight times a second at rest; the test that holds a resting scene under 8.5 a second passed, and so did the one that expects it to leave that rate only when an owl flies.
11. `watcher-column.spec.ts`: every word keeps 4.5:1 over the scene in every theme and place, over a ripple, and with the owl crossing to call, seven tests, passed, with the mist, the glints and the fireflies drawn under the column's ceiling like everything else.
12. `watcher-scene-steady.spec.ts`: passed.

## What it looks like

- [room-dark-1600.png](../../artifacts/living-night-scene/room-dark-1600.png): Watcher's room at 1600 by 1000, dark. The trunks have edges of `|`, the bare tree's branches are `/`, `\` and `|`, the ridges in the margins are lines of `_` and `-`, the river is a run of `/` in the accent, and the moon stands in its halo. Under the conversation the hills are rows of dots.
- [room-light-1280.png](../../artifacts/living-night-scene/room-light-1280.png): the same room at 1280 by 800, light.
- [owls-dark-1600.png](../../artifacts/living-night-scene/owls-dark-1600.png): the owls on a running clock, on the bare tree's branch: one looking up, one waving a wing under its `!` in its glow, and a working one turned round.
- [wood-dark-1600.png](../../artifacts/living-night-scene/wood-dark-1600.png): the same room with the wood's life: wisps of mist in the right margin and along the ground on the left, and the river's glints in the accent at the foot of the left margin.

## Not checked here

- The wood's events in the built app: a gust, a shooting star, the bats, the meteor shower, the fox, the fish, the cloud and the owl's dive. Each needs the room to change or to rest a while, and no spec waits for one. They were watched in the prototype; here `watcherWoodLife.test.ts` holds what each draws and when it starts. The owl's dive is the least covered: its flight to the ground and back is the scene's own code and has no test.
- The owls' lives by eye over time. The captures are single frames; the poses, the `z`s, the sparks and the call's note were watched moving in the prototype, and here are checked by `watcherOwlLife.test.ts` and by the crossing in 8.
- The pointer: Watcher's owl's eyes following it, and a thread owl hopping when pointed at. No spec moves the pointer over the margin and looks.
- macOS and Linux.
- How a dragged window edge feels in the running app. Laying the scene out was timed with the painter alone in headless Chromium, twelve layouts at shrinking sizes: about 22 ms as line art against 8 ms by density at 1600 by 954, 29 ms against 9 ms at 1920 by 1034, and 15 ms against 5 ms at 1280 by 754. It runs on a change of size, place or feature, never for a frame.
- A change of place between the night wood and one with no layers, in the running app. The painter's unit tests cover it; no spec switches place with the feature on and looks at the halo.
