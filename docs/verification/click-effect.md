# A press sends waves of 0s and 1s through the room: verification

October 27, 2026. On Windows 11 with the built app (`npm run build`), an Owl build through the end-to-end harness, on its own throwaway profile. It covers [ADR-0156](../adr/0156-a-press-sends-waves-of-0s-and-1s-through-the-room.md): Zach's pick N, **Both, ragged**, from round four of `docs/prototypes/click-binary-prototype.html`.

## How it was run

```sh
npm run typecheck
npm run lint
npx vitest run tests/unit/renderer/clickWater.test.ts tests/unit/renderer/clickEffect.test.tsx tests/unit/shared/settings.test.ts tests/unit/shared/owlFeatures.test.ts tests/unit/shared/interfaceCatalogs.test.ts tests/unit/renderer/themeTokens.test.ts tests/unit/renderer/watcherNightScene.test.ts tests/unit/renderer/features/settings/settingsReachable.test.tsx
npm run build
SOTTO_E2E_EVIDENCE=publish npx playwright test tests/e2e/click-effect.spec.ts
```

The full suite and `npm run notices:verify` run in CI on GitHub, as Zach asked for this work; this laptop runs only targeted checks.

## The waves in the running app

`spreading-dark.png` and `spreading-light.png` hold the Threads page at 1280 by 800 about half a second after three presses in the conversation, and `crossing-dark.png` and `crossing-light.png` hold it about half a second later. The 0s and 1s are the default theme's accent in its monospace face, up to 65% strong. The waves spread in uneven blobs with speckled edges and cross where two presses meet. They lie under the page: the user's message bubbles, the composer and the sidebar sit over them.

The spec also checks, in dark and light:

- once earlier waves calm, nothing runs until the next press that counts;
- a press on a thread's row in the sidebar starts nothing, and nor does one in the composer, on its field or its card;
- while waves run, a press still reaches its target: the composer takes focus and another thread opens;
- the water calms, the canvas is cleared, and no frame is drawn after that;
- the canvas is hidden from assistive technology.

The unit tests add a press on the sidebar's open space, which starts nothing either, and a press on a menu the composer opened, which does send waves.

In a separate test, a theme changed while waves run (dark to light) changes the ink the waves are drawn in within a few frames, while they keep running.

At 1600 by 1000 and at the 820 by 560 minimum (`spreading-dark-1600x1000.png`, `spreading-dark-820x560.png`) the canvas matches the window exactly, nothing clips, and it is fully opaque.

In one Owl run, turning `clickEffect` off through the settings bridge takes the canvas away and the saved setting reads back off, so the switch is on the patch allow-list. A stable run and an Owl run with reduced motion have no canvas at all.

## Every theme

In one Owl run each built-in theme, dark and light, was saved in turn and three presses were made in the conversation. Every one of the twelve drew waves, about 2,900 to 3,600 glyphs half a second later, on a canvas at full opacity. `every-theme-light-graphite.png` and `every-theme-dark-hush.png` hold two that an earlier build's contrast cap had left at 3% and 5%, where the waves barely showed. Words over a passing wave read less well for the second or two it passes, as in the prototype; Zach chose that over the cap (ADR-0156, decision 2).

## Watcher's room

A press in Watcher's open left margin sends waves there, and the spec checks the canvas lights pixels in the margin. The waves run under the whole pane and the night scene draws over them unchanged. While the effect is chosen, the scene sends no ripple of its own for that press.

## Cost

In Node, on this laptop, one step of the water at 1280 by 800 took about 0.1 ms and walking the glyph grid about 1 ms with eight presses' waves crossing; at 1600 by 1000, 0.14 ms and 0.14 ms. Many presses add drops to the same water, so the work per frame does not grow with them. A single press's waves leave nothing to draw after about nine to ten seconds, and the loop stops then; in the built app the loop drew about 400 frames and stopped 9 seconds after a press. The water steps by the clock and the loop draws only when a step is due, so a 120 Hz display draws about sixty frames a second, as a 60 Hz one does, without running the water faster. A window drawn slowly (an occluded one, about a frame a second) ages the water by the steps it missed rather than running it for minutes: in Node, one press calmed after 9.0 seconds at sixty frames a second, 9.3 at ten and 12.0 at one.

## Not checked here

- macOS and Linux were not run; the canvas and the shell's stacking are the same code there.
- The Glass theme was not captured.
