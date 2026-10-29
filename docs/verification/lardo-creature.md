# Lardo creature verification

October 28, 2026, on `sotto/lardo-bodybuilder-creature` from `main` at 9bb05ed3f, on forge (Linux, Omarchy). Zach asked for a tiny bodybuilder above the composer in honour of his brother: a classic pose for each thing the creature does, a flex when a turn finishes, and, clicked, a chunk of the composer torn out and thrown at the screen. The decision is ADR-0116, point 8; the glossary term is **Lardo**. He is the Owl feature `lardo-creature`.

## Prototype and Zach's picks

`docs/prototypes/lardo-creature-prototype.html` showed every pose, the flex and the throw against the composer as Sotto draws it, with a pose for each state to remap. The sprites came from one skeleton, `docs/prototypes/lardo-creature-sprites.py`. Zach picked: the prototype's pose mapping; a flex only when Lardo is already up (no pop-up); the smallest bite (56 × 10 px, inside the composer's top padding); mouse only, no tab stop; and his own colours while babysitting rather than the muted ones the other creatures wear.

One thing differs from the request: Zach listed idle, thinking, writing, done and error among the states, but the creature only shows while a thread is Monitoring, Working, Waiting or Babysitting, so those four are the poses Lardo has. Showing a creature in the other states would change every creature and move the composer; it was not done.

## What changed

- `creature` may be `lardo`; `CREATURES` and `CREATURE_LABELS` carry him, and `lardo-creature` is on the Owl list. `creatureShown()` and `offeredCreatures()` in `state/creature.ts` keep him out where he is held: Settings does not offer him, and a saved `lardo` shows and is marked as Sotto's creature while the saved value stays.
- `lardoSprite.ts` holds his fifteen frames as 40 × 32 rows of letters and a 12 × 10 small Lardo; `Lardo.tsx` wears the four poses on the shared frame loop and schedule. The babysitting pose has no frame loop of its own and runs one only while he flexes or rages.
- `LardoTurnRunning`, provided by `ThreadPane` around the ornament, lets him flex on the edge of a turn ending while he is mounted.
- The throw (`LardoThrow`) is a portal over the window with no pointer events: the bite at the composer's top edge, the piece, 22 shards, the cracks, and the bite growing back in 4 px squares. It reads only the composer's place on the screen.
- `lardo.css` is on `themeTokens.test.ts`'s owned list; every colour is a token.

## Checks

- Unit: `lardoSprite.test.tsx` (every frame fills the grid with known letters, stands on the floor row, wears trunks, flushes only in the tantrum; the small Lardo's grid). `lardo.test.tsx` (each pose's stance and prop; babysitting keeps his colours; the flex on a turn's end and not for one that ended before he came; the click's frames, that a press does not take focus, that the prompt's text, caret and focus are unchanged, and that the throw is removed; a second click mid-throw is ignored; reduced motion, the app's and the system's, throws nothing; the Appearance preview's Lardo cannot be clicked; unmounting mid-throw stops every timer and the frame loop). `claudeBotParity.test.tsx` now holds Lardo to Sotto's creature's place, facing, small agents and sand at sampled times on two track widths and under both reduced-motion settings. `creatureChoice.test.tsx` covers the Owl gate, saving Lardo, and a saved Lardo in a held build.
- Electron, `tests/e2e/lardo-creature.spec.ts`, run on an isolated nested desktop (`scripts/verify-linux-window-minimum.mjs --exec`): 4 passed. Monitoring, working and held as Lardo in dark and light at 1280 × 800 and 820 × 560, each with its feet on the composer's edge, inside the window and adding no control. Clicked: the throw shows, text typed mid-throw lands at the caret, and afterwards the composer holds the same text plus what was typed, keeps focus and its caret, and has no border or outline. A turn starting and finishing while he works makes him flex; under reduced motion a click only makes him angry and nothing is thrown. With his Owl feature held, a saved Lardo shows Sotto's creature and stays saved. The verifier's own check that nothing outside its folder changed failed both runs, because other threads' worktrees on forge changed while it ran; the spec's result is unaffected.

Evidence, each viewed: [monitoring, dark 1280](../../artifacts/lardo-creature/lardo-monitoring-dark-1280x800.png) and [light minimum](../../artifacts/lardo-creature/lardo-monitoring-light-820x560.png); [working with three agents](../../artifacts/lardo-creature/lardo-working-dark-1280x800.png); [held beside the hourglass, light](../../artifacts/lardo-creature/lardo-held-light-1280x800.png); [the flex after a turn](../../artifacts/lardo-creature/lardo-flex-light-1280x800.png); the throw, [lifted with the bite in the composer](../../artifacts/lardo-creature/lardo-throw-lift-dark-1280x800.png) and [shattered on the screen](../../artifacts/lardo-creature/lardo-throw-shatter-dark-1280x800.png); [angry under reduced motion](../../artifacts/lardo-creature/lardo-angry-reduced-light-1280x800.png).

## Not verified

- Windows and macOS: everything ran on Linux. Lardo is plain SVG, CSS and Web Animations, and Windows CI runs the gates.
- Babysitting was raised only by unit tests: no end-to-end event raises it without a GitHub fixture.
- Watcher's pane: the bite is painted in the room's colour, which over the night scene reads as a dark notch rather than a see-through hole. It was not captured there.
- No screen-reader pass. Lardo is hidden from assistive technology, like the other creatures, and adds nothing to the tab order.
- Design baselines: they launch the stable track, where Lardo is held, so none changed.
