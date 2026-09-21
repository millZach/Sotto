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

## The lag between choosing a level and seeing it, September 21 2026

Zach reported that a level takes a visible moment to appear: moving the slider to Max left the word reading High, then it blinked to Max with an animation too short to see. He read the cause correctly — the control was waiting on the provider's confirmation, which the user has no reason to wait for. ADR-0019's amendment records the decision and the variant he picked from `docs/prototypes/effort-choice-latency-prototype.html`.

The wait is real and it is not a token round trip: `configure-thread` reaches the adapter and the adapter waits for the provider to agree. `codex.ts` arms a settings confirmation with a 15 second timeout and refuses a second settings change while one is in flight. Release also ended the drag preview, so letting go of the thumb at the top level put the word back to the level it started from before the provider had said anything.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | Clean. |
| `npm run lint` | Clean. |
| `npm test -- --maxWorkers=2` | 4318 passed, 37 skipped, 0 failed (333 files, 18 skipped). Two earlier runs on this branch went red on tests this change does not touch — `devinAdapter`, `codexHost`, `subscriptionClaude`, then `agentTargetRefresh`. Each passed alone on the same commit, and the red runs carried "Worker exited unexpectedly": another full suite was running on the machine at the time. |
| `npm run notices:verify` | 174 components verified; no dependency changes. |
| `npm run build && npx playwright test tests/e2e/effort-picker.spec.ts` | 3 passed, and 3 passed on seven of eight consecutive runs. The eighth failed two tests at `page.emulateMedia`, the first line of each, with "Target page, context or browser has been closed": the app did not start that time. |
| `npm run design:verify` | Red on `settings-feedback.png`, and red the same way on `origin/main` at `a2475d68`: the same capture, the same message, with the run stopping there and nine captures not reached. Nothing of this change is in it; this changes when a level is shown, not how anything is painted, and no stylesheet was touched. Baselines were not regenerated: the branch that moved that surface owns the capture. |

## Measured in the running app

Traced in the built app through a temporary Electron spec, watching the chip's attributes and text with a `MutationObserver` while polling main's own state. The temporary spec was removed; the numbers are one run each, representative of several.

- **Before.** Pressing End: the chip read `Max` only once the provider answered, and the chip was `disabled` from 53ms to 130ms. With the lane split in place but the busy mark still read, the chip went dead from 42ms to 93ms — after `saving` had already cleared, because the coordinator's busy mark for this very save reaches the window after the save's own reply. Escape during that window handed focus to the chip and the disable took it away again, which is what `tests/e2e/effort-picker.spec.ts` caught.
- **After.** Pressing End: the chip reads `Max` at 14ms, and never becomes `disabled` at any point in the save. Pressing End then Home: `Max` at 14ms, `Low` at 54ms, and it stays `Low` — one save for Max, one for Low, nothing in between, and no frame showing a level neither press asked for.
- **Coalescing, twenty times over.** End then Home repeated twenty times against the running provider: the saved level was `low` every time.

## Two flakes in the effort spec, fixed at their cause

Both predate this change and both were proved on `origin/main`'s own build before being touched.

- **The drag preview.** `page.mouse.move(..., { steps: 12 })` returns when the events have been sent, not when the window has drawn them, so reading the slider once caught whichever step had been handled. The values seen in failures — 0.253, 0.38, 0.003 — are exactly the intermediate steps of that drag, and `main` failed the same assertion on one run in three. The spec now waits for the thumb rather than sampling it once. A second cause sat beside it: the card can open on the catalog the provider reported first, which carries two levels, so the track read as halves rather than fifths; the spec now waits for the full set of stops.
- **Reduced motion.** `expect(await runningAnimations(page)).toBe(0)` sampled once, immediately after turning the setting on. Turning it on repaints the window, and the one-shot transitions that carries — the root's colour, font weight and scrollbar, the composer's border taking the colourway — are running for their own moment; eight attempts gave 8, 0, 0, 10, 8, 10 running animations, every one a transition at `currentTime` 0. What reduced motion promises is that nothing keeps running, so the spec polls to zero instead.

## Checked through the tests

- `tests/unit/renderer/threadOptions.test.tsx` renders the chips over a parent that applies main's answer before the command resolves, the way `AgentContext` does, because a static fixture confirms a change and then reports the level it always had. Three tests fail against the old code and pass against the new: the press shows at once and holds when the answer agrees with it; the card stays mounted and live while a selection is being confirmed, where the other two chips are fixed; and presses made during a save land on the card but only the level landed on is sent.
- The existing rejection test still holds the other end: a refused change takes the press back to the saved level and the error under the chips says so.

## After the two-axis review

Both axes found the same defect and it is fixed in its own commit, with a test that fails without it: the press was let go of only when the saved level moved while no save was running, and on the ordinary path the saved level arrives while the save is still in flight, so that never fired. A provider that answered with a level of its own rather than the one asked for left the control showing the press with nothing to correct it. Each pass of the save loop now notes the level reported before it asked and lets go of the press when that has moved.

- `npm run typecheck`, `npm run lint`: clean. `npm test -- --maxWorkers=2`: 4319 passed, 37 skipped, 0 failed. `npm run notices:verify`: 174. `npx playwright test tests/e2e/effort-picker.spec.ts`: 3 passed, three runs in a row.
- The standards axis also called the README out: it described the old rule and now describes this one. The spec axis called two assertions weaker than the ones they replaced, and both were strengthened — endless animations are read straight away, since one is running from the moment it starts, and the two-press check watches the chip through both presses rather than only the level they end on.
- Left as it is, with the reason: the card's save keeps the `onChange` it was given rather than the newest, because a press belongs to the thread it was made on. Effort no longer reads the coordinator's busy mark at all, not only this save's own mark, so a press made while a send or an interrupt is in flight now reaches the provider and can be refused out loud rather than being impossible; a turn under way and an unanswered request still fix the card, which is what a provider itself refuses on.

