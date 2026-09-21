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

## Repairs, September 21 2026

Three faults Zach found in the running app (#175), all in the arrival or the card around it. Amendment in ADR-0019; the mock-up the two look choices were made from is `docs/prototypes/effort-arrival-repair-prototype.html`, where he chose the word lifting as one (over the letters standing still, and over each letter carrying its own copy of the spectrum) and the shorter Extra high line (over a wider card, and over a line area always two lines tall).

- **The word went blank in Rainbow.** The arrival lifted each letter 1px, and Chromium drops a transformed or positioned descendant out of an ancestor's `background-clip: text`, so the one colourway that paints its word as a gradient had no word for the 1.9 seconds the arrival ran. The letters now take the colour without moving (`effort-letter`) and the word lifts and settles as one (`effort-word`).
- **The Appearance sample would not replay.** `play()` turned `data-arriving` off and on inside one frame, which is never painted, so the browser had nothing to restart. The scene now mounts fresh on every play.
- **The card grew at Extra high.** "Much longer. For problems that resist a first pass." wrapped at the card's width, so the card grew 18px as a drag crossed that level. It now reads "Much longer. For stubborn problems." and every level's line fits one line.

One thing the repairs turned up: the card was placed by watching what resizes, and at the 820x560 minimum the chip moves 6px when a line appears under the composer without anything around it changing size, leaving the card behind. The Electron spec's placement check was failing about half its runs on that. The card now follows its chip every frame it is open.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | Clean. |
| `npm run lint` | Clean. |
| `npm test -- --maxWorkers=2` | 4201 passed, 34 skipped, 0 failed (325 files, 17 skipped). |
| `npm run notices:verify` | 174 components verified; no dependency changes. |
| `npm run build && npx playwright test tests/e2e/effort-picker.spec.ts --workers=1` | 3 passed. The placement check passed every run after the card was made to follow its chip, where it had been failing about every other run. |
| `npm run design:verify` | Red on `settings-providers.png`, and red the same way on `main` at the same commit: the baseline was last taken on September 18 and the Devin tile reached the page on September 20, so the Providers section no longer matches. Nothing of this change is in it. The captures these repairs could touch were not reached, since the run stops at the first difference; the repairs change motion, not the resting look, and the Extra high line lives in a card no baseline holds open. Baselines were not regenerated: the branch that added the tile owns that capture. |

## Evidence for the repairs

Captures the spec writes to `artifacts/effort-slider/`, in Rainbow:

- `rainbow-arrival.png`: the card mid-arrival, the letters of Max wearing the spectrum, the tide rising. The same frame before the repair showed a fragment of the M and nothing else.
- `rainbow-appearance-sample.png`: Settings → Appearance with Rainbow chosen, the Live appearance sample mid-arrival after Play again: the sample's own Max wearing the spectrum.

## Checked in the running app through the spec

- The word keeps its paint through the arrival: the share of the word's box that is ink is the same while the arrival runs as it is at rest (0.250 either way, measured from the window's own pixels). With the letters moving it fell to 0.167, which is the fragment in the capture. Nothing inside the word is transformed or positioned while the arrival plays.
- The Appearance sample's word is measured the same way, since that is the surface the fault was reported on.
- The card is the same height and sits at the same place at every level from Low to Max, and its bottom edge stays 8px above the chip.
- Play again pressed mid-arrival: the tide in the card and in the composer is back under 300ms of its run after being more than 600ms into it.
- `tests/unit/renderer/effortArrival.test.ts` holds the stylesheets to the rule: the letters' keyframes carry colour and nothing else, the word's carry the lift, and no rule moves a letter on either surface.
- `tests/unit/renderer/themeLibrary.test.tsx`: the sample's scene is a fresh element on every play, mid-arrival included.
- `tests/unit/renderer/threadOptions.test.tsx`: the Extra high line reads as the card's description at that level.
