# Watcher scenes

Branch `feat/watcher-scenes`, Windows 11 on LAPTOP-RUSSH2J5, October 26, 2026. Zach's pick A of `docs/prototypes/watcher-theme-prototype.html` (ADR-0149): Watcher's night scene set in Night wood, Harbour, Snowfield or Desert, picked in Settings → Appearance → Watcher scene, its colours still the theme's.

## What was checked on the built app

- **Never blinks.** `tests/e2e/watcher-scene-steady.spec.ts` reads every frame the screen draws while the place changes through all four and back, beside the changes it already read (a reply, a fold, the composer slimming, Watched and back, a resize). No frame lost the margin's glyphs. The switch fades the last place out while the new one fades in, linearly and in step, so their opacities add to one; with motion reduced the new place replaces the last in one frame.
- **Words keep 4.5:1 in every place.** `tests/e2e/watcher-column.spec.ts` measures every word in the column against every pixel the scene draws under it, in each place, dark and light, with snow, sand and the lighthouse running. It passes. Because the two layers of a switch add to one, where they overlap their ink lays down c − a(1 − a)c², never more than the column's ceiling c.
- **Pre-existing, not from this change.** The same spec's "every built-in theme" case fails on the glass composer's placeholder over a white backdrop (2.5:1), and `watcher-night-scene.spec.ts`'s scrubber-lane case reads 1.05 against 1.2. Both fail the same way on the base commit.
- **The picker.** Four cards in a radio group, one Tab stop; the arrows, Home and End move and choose; a failed save puts the saved place back. Each card's picture is the scene's own painter in the theme's inks, moving at twelve frames a second while on screen, and still with motion reduced or under a test.

## Captures

- `artifacts/watcher-scenes/room-harbour-dark.png`: Harbour by night, the ship's mast where Watcher's tree stands and the lighthouse on the right, the owls on their usual perches.
- `artifacts/watcher-scenes/room-snowfield-dark.png`: Snowfield, pines and falling snow.
- `artifacts/watcher-scenes/room-desert-light.png`: Desert by day, saguaros and dunes.
- `artifacts/watcher-scenes/picker-light-820.png`: the Watcher scene section at the 820x560 minimum, Snowfield chosen.
