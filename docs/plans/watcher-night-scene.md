# Watcher's night scene

An ASCII night behind Watcher's room while the room is empty, with an owl that flies once and perches on the composer. The prototype is kept at the tag `prototype/watcher-owl-scene` (`docs/prototypes/watcher-owl-scene-prototype.html` there); its variant A is the spec. The glossary calls it the **night scene**, since Owl already names the release track.

## Zach's picks, October 21, 2026

- **Where.** Behind Watcher's room whenever the room is empty: the first-time screen (the first entry) and a Watcher conversation nothing has been sent to yet, as after a provider change.
- **Variant A, Glyphs.** The whole scene is a density ramp of characters (` .·:-=+*#%@`): the trees, the hills with their ridgelines, the river, the pines on the far hills, the ground with its grass, and the moon with its rim. The accent is for the moon's glow, the river, a few stars, the ripples and the owl's eyes. No cabins.
- **The route plays once when the room opens.** The owl watches the open landscape from a branch of the left tree, glides down to the left of the intro and skims over the composer, rises across the moon, lands in the right tree, then drops onto the composer's top-right corner (`x = composer right - 24 * s`, on its top edge) at every window size, and perches there. Perched, it blinks and turns its head now and then.
- **The owl is a quarter smaller than in the prototype** (25% smaller, October 21). Its scale is `s = clamp(min(W / 1600, H / 1000) * 2.025, 1.125, 2.1)` instead of the prototype's `* 2.7, 1.5, 2.8`. Every other use of `s` is as the prototype has it: the route's offsets, the perches, the final perch 24 `s` in from the composer's right edge, and the padding of the owl's own box.
- **The owl is drawn above the composer**, on its own canvas, with pointer-events none.
- **A click in the open background** (not on a control, the composer, the header or the floating switch) sends out an ASCII ripple in the accent with a trailing echo that bends the landscape as it passes. The perched owl turns its head toward the click.
- **Light themes keep the same night in dark ink**, with much more of it than dark mode: ink alpha times 1.9 and accent times 1.5. Light or dark is decided from the luminance of the surface the scene is drawn on, never from a theme's name.
- **It fades out over about 0.7 s when the first message is sent**, and stops drawing once it has gone.
- **Reduced motion:** no flight. The owl starts perched on the composer, the stars don't twinkle, it doesn't blink, and a click only brightens the spot in place, then fades.
- **Text keeps 4.5:1.** The intro sits in a soft oval of quiet (the scene falls to about 0.12 under it) and the header keeps a clear band.

## How it is built

- `src/renderer/src/watcher/nightScene.ts` is pure: the layout from the room's measurements, the route, the owl's pose at any moment, ripples, pace and ink. Its tests are `tests/unit/renderer/watcherNightScene.test.ts`.
- `src/renderer/src/watcher/nightScenePainter.ts` draws it. The landscape is rasterised once per size on small offscreen canvases (two field pixels to a 7 by 12 glyph cell), and its glyphs are drawn once per size and theme and kept. A frame copies them, clears the cells around the owl, and redraws only the stars and the cells a ripple reaches; the owl is drawn and read in its own box alone.
- `src/renderer/src/watcher/WatcherNightScene.tsx` runs it inside Watcher's pane: the landscape's canvas under everything in the pane, the owl's over the composer and under every menu, panel and toast that opens there. It measures the pane with a ResizeObserver, reads the inks from a probe's computed `--tt-text`, `--tt-accent` and `--tt-font-mono` (Spline Sans Mono) and the surface under the pane, and reads them again when the root's theme changes. It draws at about 30 frames a second while the owl flies or a ripple runs, 10 while it sits, paced from each frame's start inside the display's own frames, and not at all when nothing moves, when the window is hidden, when the room has no composer to measure, and once it has gone. A change of pixel ratio, as on moving to a display with other scaling, lays it out again.
- `WatcherView` decides when the room is empty and when the scene ends. The first entry's end carries to the Watcher its message created, so the scene does not return while the message is on its way; a new Watcher after a provider change is a new conversation. Only a message sent or already there ends it; the room or the conversation loading or failing to load, and the Watched view, put it away without ending it. A capture run's fixed clock (`now`) holds the scene settled with the owl on the composer, so captures repeat.
- Watcher's room exists only behind the Watcher gate (ADR-0072), so stable shows and starts none of it; the scene adds no gate of its own.

## Where it departs from the prototype

- **Nothing is drawn under words.** The prototype's quiet oval keeps the landscape off the intro but still draws faint stars and ripple rings there, and against the muted line of an empty conversation in light mode that measured 3.7:1. The cells under every block of words (the header and needs-you line, the intro, what stands on the composer and the line under it) are left blank, with the oval and the header band as the prototype has them around them.
- **The owl lands on what stands on the composer.** After a provider change the handover offer sits on the composer, and an error line can too; the owl lands on the top edge of the topmost of them, still 24 `s` in from the composer's right edge, so it never covers their words or the offer's close button.
- **The scene covers Watcher's pane, not the whole window.** The floating switch's band below the pane stays plain, and the river ends at the pane's foot. With a thread open beside Watcher, the scene fills Watcher's pane alone.
- **No owl without a composer.** A first entry with no provider connected has no composer for the owl to fly to, and shows no scene.
