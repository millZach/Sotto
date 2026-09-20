# Effort slider, colourways and the highest-level outline

Replace the pixel furnace popover (`docs/plans/effort-furnace.md`) with the effort card Zach chose, make its colour a choice on Settings → Appearance, and dress the composer while a thread sits at a model's highest level. Decision: ADR-0019.

## How the pick was made

Three rounds of prototypes, all in `docs/prototypes/`:

1. Three recompositions of the furnace popover. Rejected: "basically the same thing".
2. Three different controls (a pixel dial, a typographic scale, an inline stepper). Rejected: "horrible".
3. Zach supplied two references: Codex's effort slider (the shape he wanted) and Claude Code's effort picker (the reaction he wanted, without copying it). The slider was rebuilt on Codex's shape with three Sotto-esque arrivals at the top level: Ripple, Wash and Sheen. **Zach chose Wash.**
4. The wash in six colourways: Ember, Cyberpunk, Rainbow, Aurora, Plasma and Theme accent. **Zach liked all six** and asked for them as a choice on Settings → Appearance.
5. The Appearance page with the choice as swatches or as cards, and a sample in the Live appearance card that plays the wash on a pick. **Zach chose swatches**, and asked for a thin outline in the chosen colour running round the composer at the highest level, the way Devin's input shows an agent working. The outline was prototyped as a comet (a brighter run round a faint ring) and a full rotating ring; **the comet ships**.

The prototypes as they stood at the end: `docs/prototypes/effort-slider-prototype.html` (the slider, the wash, the six colourways and the outline on the Threads composer) and `docs/prototypes/effort-color-settings-prototype.html` (the Appearance page). The earlier rounds were overwritten in place; their shape is described above.

## Acceptance

- The card: level word, one line per level saying what it costs, Default when the model reports one, a pill track with a stop per level, `Faster` / `More thorough`, Ultrathink as a check row on Claude threads with an editable draft. No Done.
- Dragging previews and is magnetic near a stop; release saves; wheel, arrows, Home, End, digits; Escape, Tab out and a pointer outside close. Failed saves restore the previous level; an unknown saved level shows as set and asks for a supported one.
- Six colourways as `effortColor` (default Ember), painted as `data-effort-color` on the root; Ember and Theme accent from theme roles, the other four fixed palettes with a light ink each; the tinted word reads at 4.5:1 on the card and the chip for every built-in theme, both modes, every colourway.
- At the highest level: the word, the chip and the composer outline take the colourway; reaching it plays the arrival once; lowering takes it off. Reduced motion shows the settled state with nothing running.
- Settings → Appearance: an Effort color subsection between Themes and the sliders, six swatches in the theme grid's columns with the active one ringed; the Live appearance sample of the composer at its highest level plays the arrival on a pick. Changes save as they are made.
- Verified in the running app at 1600x1000, 1280x800 and 820x560, dark and light, both reduced-motion paths.

## State

- [x] Prototypes reviewed and the picks recorded above.
- [x] Setting, allow-list, appearance state and cache.
- [x] Colourway tokens and the contrast check per colourway.
- [x] The card, the chip mark, the composer outline and arrival.
- [x] The Appearance subsection and the Live appearance sample.
- [x] Unit tests, the Electron spec, docs (ADR-0019, `CONTEXT.md`, `README.md`, `docs/agent-control.md`).

Verification: `docs/verification/effort-slider.md`.
