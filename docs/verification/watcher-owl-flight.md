# Watcher's owl flies on slow, deep beats

Checked on an Apple silicon Mac from branch `feat/owl-flight-slow-beats`, October 27, 2026, after Drake picked E,
"Slow, deep beats", of the five flights in the prototype kept at the tag `prototype/owl-flight`. ADR-0126's decision 7
records the flight.

## How it was checked

The app was not launched. Each capture comes from a page that runs the night scene's own modules: `layoutScene`,
`planFlight`, `owlAt` and `NightScenePainter`, at 7 by 12 cells, with inks read through a probe from the real `--tt-*`
tokens of `tokens.css` and `nightScene.css`, as `WatcherNightScene.tsx` reads them. The pane is 1100 by 640 with a
660-pixel column, so the margins have trees. A fixed clock steps the page 1/30 s at a time and headless Chromium
screenshots the pane each step. The "before" page is the prototype's own, built at the tag from the code on `main`
before this change; the "after" page builds the same harness against this branch. Vellum, the theme in pull request
#1667, is read from that thread's checkout while it is unmerged.

Every capture is the crossing from Watcher's tree to the other tree, the longest flight, which passes behind the
conversation's words.

## Captures

| | Before | After |
|---|---|---|
| Dark, Citrine | `before-dark.mp4` | `after-dark.mp4` |
| Light, Sotto | `before-light.mp4` | `after-light.mp4` |
| Vellum, light | `before-vellum-light.mp4` | `after-vellum-light.mp4` |
| Vellum, dark | `before-vellum-dark.mp4` | `after-vellum-dark.mp4` |
| Reduced motion, dark | `before-reduced-motion.mp4` | `after-reduced-motion.mp4` |

All are in `artifacts/owl-flight/`. The strips there show the flight frame by frame, cropped round the owl:
`before-dark-strip.png` every sixth frame, `after-dark-strip.png` and `after-vellum-light-strip.png` every ninth, and
`after-reduced-motion-strip.png` every sixth.

- Before, the owl's body and wings are redrawn every frame. Its glyphs change from frame to frame even across the
  steady middle of the flight, and faint dots scatter at its wing edges.
- After, the owl crouches, lifts off on two beats, crosses on slow beats with its wings at their widest, flares with its
  wings up and legs reaching, and folds its wings on the branch. Between beats its drawing holds, and it moves a cell at
  a time. A faint `·` or `:` shows for a frame or two where a wing just was.
- In both Vellum halves the owl's body takes the theme's text colour and its eyes the theme's ink-blue accent, and it
  reads against the warm surface by day and the sepia by night.
- With motion reduced, before, the owl never leaves home. After, it sits for 0.7 s, shows at two points along the way
  with its wings spread and still, 0.7 s each, and then sits on the other tree. Nothing moves between steps.

## Numbers

On the crossing, from the page's own counts (glyphs whose character changed against the frame before, once the owl's
own movement is taken out), and CDP's `TaskDuration` over 12 seconds for the renderer, two runs each:

| | Before | After |
|---|---|---|
| Owl glyphs changing per painted frame | 63 of 66 | about 24 of 63, measured on the prototype's E |
| Frames painted a second in flight | 26 | 24 |
| One painted frame | 0.30 ms | 0.29 to 0.31 ms |
| Renderer, scene still | 1.8 to 2.4% | 1.8% |
| Renderer, looping crossings | 7.0% | 6.1 to 6.5% |
| Renderer, looping crossings, motion reduced | 1.8 to 2.4% (it stays home) | 2.6 to 2.7% |

These are the prototype page's numbers in headless Chromium, not the app's. They compare the two flights on the same
page and machine.

## What was not checked here

The flight was not watched in the running app, and the end-to-end specs that cover the night scene
(`watcher-night-scene.spec.ts`, `watcher-scene-steady.spec.ts`, `watcher-column.spec.ts`) ran in CI rather than on this
Mac. Their captures hold the scene on a fixed clock with the owl at home, which this change leaves as it was.
