# Watcher's night scene is set in a place the user picks

## Status

Accepted October 26, 2026. Zach asked for "the ability to change the watcher theme ... I want to keep the same ascii styling", and picked A, **Places**, of `docs/prototypes/watcher-theme-prototype.html`. It rides Watcher's own switch (ADR-0072): it shows wherever Watcher does, and adds no entry to `src/shared/owlFeatures.ts`. Builds on ADR-0126, whose column share, ink ceiling and never-blink rule it keeps for every place. **Number provisional until merge** (docs/agents/domain.md).

## Context

Watcher's **night scene** had one look: hills, a river, the moon and two trees, drawn in text characters in the theme's colours. Zach wanted to change it while keeping the ASCII look. The prototype offered three ideas of what a Watcher "theme" could be: A, a place the scene is set in; B, the weather over the night wood; C, the scene's own inks, a light and a dark half, apart from the app's theme.

## Decision

**1. A Watcher scene is a place.** The night scene is set in one of four: **Night wood** (the scene as it was, and the default), **Harbour** (the sea, a ship at the quay and a lighthouse whose beam sweeps the right margin), **Snowfield** (snow-capped mountains, snow-laden pines, falling snow and the northern lights) and **Desert** (mesas, dunes, two tall saguaros, a larger moon and drifting sand). The setting is `watcherScene`; an unknown saved value is read as the night wood.

**2. Colours stay the theme's.** A place brings drawing, never colour: its glyphs are the theme's text colour, with the accent where it reads as light (the moon's glow, the river and the moon's path on the sea, the lighthouse's lamp and beam, the ship's lights, the northern lights, the owls' eyes). The column's 85% share and its ink ceiling (ADR-0126) apply to every place unchanged, its moving glyphs included, so every word keeps 4.5:1.

**3. Every place is laid out alike.** `layoutScene` takes no place. The moon, Watcher's owl's home and the place it visits, the composer's branches and every thread owl's spot stand where they do in the night wood, and a place draws its own things at that geometry: a ship's mast and yards where Watcher's tree and its limbs are, a lighthouse and the rope to its signal pole where the bare tree and its long limb are, snow-laden pines and their boughs, saguaros and their arms; a quay, a snowfield's edge or sand where the ground is. Trees and perches stay in the margins, and a margin too narrow for them shows the rail of eyes in every place. Each place is a small module (`src/renderer/src/watcher/place*.ts`) drawing into the same two coverage fields the painter turns into glyphs.

**4. What moves is a fixed few glyphs.** Snow, sand, the lighthouse's beam and the glitter on the sea are a set number of glyphs a frame, drawn like stars through the painter's frame, never under still words, a star or an owl. Nothing in them grows with the room's history or its threads. They step 8 times a second while the scene moves, and hold still, drawn once, with reduced motion. The night wood has none, and paints as often as it did.

**5. Changing place never blinks.** The new place is drawn whole in the frame it is picked, under a copy of the last place's landscape that fades away over 600 ms; with reduced motion the new place replaces the last in that one frame. The owls do not move. `tests/e2e/watcher-scene-steady.spec.ts` reads every frame through a switch to each place.

**6. It is picked in Settings → Appearance**, in a **Watcher scene** section: a radio group of four cards, each with a picture of the place drawn by the scene's own painter, in a small room of its own with Watcher's owl at home and two thread owls, holding still, its name and one line. One Tab stop; the arrow keys, Home and End move to a place and choose it. It saves at once ("Watcher scene saved."). The section shows only where Watcher does.

## Considered options

- **B, weather.** The night wood under rain, snow, fog or fireflies, chosen from Watcher's header, with an option to change it with the clock. A changing sky reads as a mood rather than a choice, a header control adds weight to a room kept quiet, and rain and fog cover the column with moving glyphs. Not picked.
- **C, inks.** The scene's own palette for each half of the theme, chosen beside the theme columns. It makes the scene's colours a second theme to keep in step with the app's, and every ink would need its own ceiling to keep the words at 4.5:1. A theme is a palette in Sotto; the scene follows it. Not picked.

## Consequences

- The desert's moon is drawn 1.6 times larger about the same centre, since the moon's place is the whirlpool's and the flights' and stays where it is; the picker says "a big moon", not the prototype's "big low moon".
- Harbour's left margin shows about half the glyphs the night wood's does, which the never-blinks spec allows for by judging each frame against its own place.
- The pictures in Settings are drawn from a room about two fifths larger than they show, in the theme's inks a step stronger, so the thinner shapes keep their density; on a display at 100% scaling they read as texture more than as glyphs.
