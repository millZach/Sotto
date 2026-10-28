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

`spreading-dark.png` and `spreading-light.png` hold the Threads page at 1280 by 800 about half a second after three presses in the conversation, and `crossing-dark.png` and `crossing-light.png` hold it about half a second later. The 0s and 1s are the default theme's accent in its monospace face. The waves spread in uneven blobs with speckled edges and cross where two presses meet. They lie under the page: the user's message bubbles, the composer and the sidebar sit over them, and the conversation's words read over them.

`click-effect-dark.mp4` is about eight seconds of the window at nine frames a second, captured from the window itself: four presses, the waves spreading, crossing, bouncing off the edges and fading to nothing.

The spec also checks, in dark and light:

- nothing runs before a press, and opening a thread, itself a press, calms and stops on its own;
- a press in the composer, on its field and on its card, starts nothing;
- while waves run, a press still reaches its target: the composer takes focus and another thread opens;
- the water calms, the canvas is cleared, and no frame is drawn after that;
- the canvas is hidden from assistive technology.

In a separate test, a theme changed while waves run (dark to light) changes the ink the waves are drawn in within a few frames, while they keep running.

In one Owl run, turning `clickEffect` off through the settings bridge takes the canvas away and the saved setting reads back off, so the switch is on the patch allow-list. A stable run and an Owl run with reduced motion have no canvas at all.

## Watcher's margin

`watcher-margin-press-dark.png` holds Watcher's room just after a press in the open left margin with the click effect on. The waves run under the night scene in the margin, which draws over them unchanged, and none are drawn under the column or the header, where the scene already spends what the words allow: the click effect's canvas had 0 lit pixels across the column and 30,565 in the left margin. The scene's own ripple is not sent: the night scene drew 0 ripple cells behind the column. With motion reduced and the effect still chosen, the same press showed nothing: no canvas and 0 ripple cells. With the click effect turned off it sent the ripple as before, 1,089 cells behind the column. Those were one-off runs, not a kept spec. The existing column spec (`tests/e2e/watcher-column.spec.ts`) keeps the ripple's contrast check, since the design profile leaves the click effect off.

## Contrast

The glyphs go no stronger than leaves every word over them at 4.5:1 (ADR-0156, decision 2), links pointed at included (`--tt-primary-hover`), since the second review measured a hovered link at 4.38:1 without it. In one Owl run each built-in theme, dark and light (t3-code, hush, citrine, graphite, clay and fern), was saved in turn and a press read the ceiling the canvas took: 0.35 in all twelve, against the prototype's 0.65. The spec checks the ceiling is above nothing and no more than 0.65. The frames above are at that ceiling.

## Cost

In Node, on this laptop, one step of the water at 1280 by 800 took about 0.1 ms and walking the glyph grid about 1 ms with eight presses' waves crossing; at 1600 by 1000, 0.14 ms and 0.14 ms. Many presses add drops to the same water, so the work per frame does not grow with them. A single press's waves leave nothing to draw after about nine to ten seconds, and the loop stops then; in the built app the loop drew about 400 frames and stopped 9 seconds after a press. The water steps by the clock, so a 120 Hz display draws more frames without running the water faster, and a window drawn slowly (an occluded one, about a frame a second) ages the water by the steps it missed rather than running it for minutes. The spec passed three times in a row after that change.

## Not checked here

- macOS and Linux were not run; the canvas and the shell's stacking are the same code there.
- The Glass theme was not captured. The canvas lies over the shell's own translucent background, under the panes, and its ceiling reads that background over pure white or pure black, whichever is nearer the text, as the night scene does.
