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

At 1600 by 1000 and at the 820 by 560 minimum (`spreading-dark-1600x1000.png`, `spreading-dark-820x560.png`) the canvas matches the window exactly, nothing clips, and its computed opacity is the ceiling: the glyphs are drawn under it at their relative strength, so overlapping ones never add up past it.

In one Owl run, turning `clickEffect` off through the settings bridge takes the canvas away and the saved setting reads back off, so the switch is on the patch allow-list. A stable run and an Owl run with reduced motion have no canvas at all.

## Watcher's margin

`watcher-margin-press-dark.png` holds Watcher's room just after a press in the open left margin with the click effect on. The waves run under the night scene in the margin, which draws over them unchanged, and none are drawn under the column or the header, where the scene already spends what the words allow: the click effect's canvas had 0 lit pixels across the column and 30,565 in the left margin. The spec now checks this on every run. The column is measured every frame, so opening Watcher's room or a beside pane mid-run keeps it clear. The scene's own ripple is not sent: the night scene drew 0 ripple cells behind the column. With motion reduced and the effect still chosen, the same press showed nothing: no canvas and 0 ripple cells. With the click effect turned off it sent the ripple as before, 1,089 cells behind the column. Those were one-off runs, not a kept spec. The existing column spec (`tests/e2e/watcher-column.spec.ts`) keeps the ripple's contrast check, since the design profile leaves the click effect off.

## Contrast

The glyphs go no stronger than leaves every word over them at 4.5:1 (ADR-0156, decision 2): the text, its secondary and muted tiers, links at rest and pointed at (`--tt-primary-hover`; the second review measured a hovered link at 4.38:1 before it was counted), the accent's text tone and the working words' (`--tt-activity`), and the error, warning and success colours (the fifth review measured dark error text at 3.73:1 before they were counted). It holds too where a control's translucent fill (`--tt-hover`, `--tt-hover-strong`, `--tt-selected`) lies over the waves under its words (the seventh review measured error text on a pressed Discard draft at 4.43:1 before the fills were counted), and it is found in hundredths. In one Owl run each built-in theme was saved in turn and a press read the ceiling the canvas took:

| | T3 Code | Hush | Citrine | Graphite | Clay | Fern |
|---|---|---|---|---|---|---|
| Dark | 0.20 | 0.05 | 0.14 | 0.17 | 0.22 | 0.19 |
| Light | 0.05 | 0.13 | 0.11 | 0.03 | 0.14 | 0.16 |

Zach chose the strict rule after seeing light Graphite at 0.05; counting the controls' fills afterwards brought it to 0.03, and light T3 Code (`spreading-light.png`) to 0.05, where the waves are faint but show. A theme whose ceiling comes to nothing moves no water, draws nothing and stops at once, and later presses start nothing until the theme changes. The faint tier is left out by his earlier choice: counted too, the ceiling fell further, so faint words may dip under 4.5:1 for the second or two a wave passes. The spec checks the ceiling is above nothing and no more than 0.65, and that it is the canvas's computed opacity. The frames in this note are at these ceilings.

## Cost

In Node, on this laptop, one step of the water at 1280 by 800 took about 0.1 ms and walking the glyph grid about 1 ms with eight presses' waves crossing; at 1600 by 1000, 0.14 ms and 0.14 ms. Many presses add drops to the same water, so the work per frame does not grow with them. A single press's waves leave nothing to draw after about nine to ten seconds, and the loop stops then; in the built app the loop drew about 400 frames and stopped 9 seconds after a press. The water steps by the clock and the loop draws only when a step is due, so a 120 Hz display draws about sixty frames a second, as a 60 Hz one does, without running the water faster. A window drawn slowly (an occluded one, about a frame a second) ages the water by the steps it missed rather than running it for minutes: in Node, one press calmed after 9.0 seconds at sixty frames a second, 9.3 at ten and 12.0 at one. The spec passed three times in a row after that change.

## Not checked here

- macOS and Linux were not run; the canvas and the shell's stacking are the same code there.
- The Glass theme was not captured. The canvas lies over the shell's own translucent background, under the panes, and its ceiling reads that background over pure white or pure black, whichever is nearer the text, as the night scene does.
