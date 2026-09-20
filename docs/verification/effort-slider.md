# Effort slider, colourways and the highest-level outline

Date: 2026-09-20
Plan: `docs/plans/effort-slider.md`. Decision: ADR-0019.

The effort chip now opens the effort card in place of the pixel furnace: the level word and one line saying what it costs, Default when the model reports one, a pill track with a stop per level and a round thumb, `Faster` / `More thorough`, and Ultrathink as a check row on Claude threads. Its colour at a model's highest level is the effort color chosen on Settings → Appearance, one of six colourways, and while a thread sits there the composer wears a thin outline in that colour with a brighter run travelling round it. Reaching the highest level plays the arrival once: a tide of the colourway through the card and the composer, the letters of the level taking the colour in turn, both borders tinting and fading.

## Gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | Clean. |
| `npm run lint` | Clean. |
| `npm test -- --maxWorkers=2` | 3945 passed, 34 skipped, 0 failed (301 files). A first run failed one `threadsView` test that pressed the furnace's "High effort" button; it now presses End on the slider. |
| `npm run notices:verify` | 174 components verified; no dependency changes. |
| `npm run build && npx playwright test tests/e2e/effort-picker.spec.ts --workers=1` | 2 passed against the final build. The runner's "clear output" step hung on this machine while another session held a file open under `test-results/`; passing `--output` to a folder of its own let it run. |
| `npx playwright test tests/e2e/thread-creation.spec.ts --workers=1` | 2 passed; the spec chose Low from a level button and now presses Home on the slider. |

## Evidence

Captures in `artifacts/effort-slider/`, taken by the Electron spec with the synthetic Claude catalog (low, medium, high, xhigh, max; default low):

- `max-arrival.png`: the moment the level reaches Max from High: the card mid-tide, the letters of Max taking Ember, the composer border tinting.
- `max-settled.png`: the settled state: gold fill to the thumb, Max tinted on the card and the chip, the composer's outline running, Default enabled, the line "Everything the model has. Slowest, costliest."
- `appearance-cyberpunk.png`: Settings → Appearance with the Effort color subsection between Themes and the sliders, Cyberpunk just picked and ringed, "Effort color saved." at the top, and the Live appearance sample playing the arrival in Cyberpunk.
- `composer-cyberpunk.png`: after a reload, the Workshop thread at Max wearing Cyberpunk: the chip's word in cyan, the composer border magenta with the cyan run along its top edge.
- `{dark,light}-{1600,1280,820}.png`: the card open at Max under reduced motion (the app's setting) at each window size and appearance, anchored 8px above its chip, inside the window, nothing overflowing. Light shows the fill tinted toward white and the paper thumb with its edge.

## Checked in the running app through the spec

- A drag previews without saving (the saved level stays Low while the thumb sits between Medium and High) and the release saves the stop the thumb settled on.
- End reaches the top: the saved level is Max, `data-top` and `data-arriving` go true on the card, the chip marks `data-effort-top`, the line names the cost; the arrival ends within 6s and the composer's `::after` outline is at full opacity. Home takes the outline and the marks off again.
- Default returns to the model's default; the wheel over the track steps a level.
- Escape closes and hands focus back to the chip; a pointer outside closes; Tab from the card's last control closes.
- Ultrathink inserts once into the Claude draft and leaves focus in the prompt; its row then reads "Ultrathink is in this prompt" and is disabled.
- Reduced motion by the app's setting: `data-still`, the settled top state, no arrival, the outline present, zero running animations in the document. By the operating system: the same card state, no animation in the card's subtree, no animation on the composer's outline.
- The Appearance choice paints the root at once (`data-effort-color`), saves the setting, plays the sample's arrival, and survives a reload; the thread at Max wears the new colourway.

## Unit

- `tests/unit/renderer/threadOptions.test.tsx`: the card's word and line, saving a step without closing, digits and Default, the chip and card marks at the highest level and the arrival starting and ending, the settled state when opened at the top, Ultra only when advertised (the slider's `max`), failed-save restoration, the card mounted through a pending save, an unknown saved level, a provider-default model without a Default button, Tab dismissal, the single-level model.
- `tests/unit/renderer/themeTokens.test.ts`: the tinted effort word at 4.5:1 on the card and the chip for every built-in theme, both modes and all six colourways, and every colourway declaring its three hues and border hue. The resolver now reads the colourway blocks the way the cascade does.
- `tests/unit/renderer/themeLibrary.test.tsx`: the six swatches in order, the active one named as such, a pick previewing at once, saving with its message, and the sample playing.
- `tests/unit/renderer/appearance.test.ts`, `tests/unit/shared/settings.test.ts`: the attribute on the root, the cache, the fallback to Ember for an unknown value, the schema and defaults.

## Not covered here

- The New thread and New terminal dialogs keep their native Reasoning select, as before.
- Design baselines (`npm run design:capture`) were not regenerated in this pass; the Threads baselines show the composer without a thread at its highest level, which this change does not alter.
