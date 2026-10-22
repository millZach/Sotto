# Watcher's owl family

Zach approved this on October 22, 2026, to be built once the Visualize tab (PR #1349) has merged. After trying the
updated prototype, with the composer branch and the moon's ripple, he approved it as the spec the same day: "The
updated prototype looks good. and approved". Prototype:
`docs/prototypes/watcher-owl-family-prototype.html`, tagged `prototype/watcher-owl-family`. It carries Zach's picks
from the October 21 owl scene (glyphs, Watcher's owl in the left tree, the flight across the moon, darker ink in light
mode, no cabins) and the four he made on October 22:

- Owls cross the room's column **behind** it: a flight leaves one margin and comes out of the other.
- On the composer, Watcher's owl perches on **a branch growing out of the composer's side** into the margin, one on
  each side, so it never covers text (Zach, after trying the prototype).
- The moon **sends out a ripple** each time its whirlpool opens, for a newcomer or for an owl going home, so the moment
  is easy to notice (Zach, after trying the prototype).
- A margin too narrow for trees (under 160 px) shows a **rail of owl eyes**, one pair per watched thread.
- The **moon** sits in the right margin, above the limb new owls fill first.

Watcher is an Owl feature (`watcher` in `src/shared/owlFeatures.ts`). The scene is part of it and asks the same gate:
stable builds draw none of it and start none of its timers.

## Visualize: the scene steps away (Zach, October 22, at the build)

The plan assumed all three views share the 760 px column. Visualize, as #1349 merged it, does not: its constellation
spreads across the pane's whole width, so on that tab the margins already hold threads. Zach saw the three ways out in
the prototype's Visualize switch (the picture narrowed to the column, no owls on Visualize, or the owls behind its outer
clusters) and picked **no owls on Visualize**. The scene shows on Conversation and Watched, fades while Visualize shows,
and comes back with the owls sitting where they were. This replaces "on all three Watcher screens" from his first ask.

## How it is built

The night scene of October 21 (`docs/plans/watcher-night-scene.md`) is the base: the same landscape, glyph ramp, ink,
ripples and pacing, moved out of the empty room and into the margins.

- **Where it shows.** Always, on Conversation and Watched, whatever the conversation holds: the empty-room rule and the
  fade on the first send are gone. It steps away while Visualize shows, and while the room or Watcher's conversation
  cannot be read yet. The column is the composer's sides, so a thread open beside Watcher narrows the margins with it.
- **`src/renderer/src/watcher/nightScene.ts`** (pure): the layout in the margins (two trees with their limbs, the
  moon on the right, the composer's two branches, every spot in fill order, the rail below 160 px and nothing below
  16 px), Watcher's owl's places and flights (`planFlight`, `nextPlace`, `stayAt`, `owlAt`), ripples that may start
  later than now, the pace, the ink and the stars' half-second twinkle steps.
- **`src/renderer/src/watcher/owlFamily.ts`** (pure): a row's mood (`moodOf`), spot assignment with the "+N" pile
  (`assignSpots`), and `OwlFamily`, which diffs the room's watched rows by target into arrivals out of the moon,
  departures into it, hops from the pile and, with motion reduced or on the rail, fades.
- **`src/renderer/src/watcher/nightScenePainter.ts`** draws it on two canvases. The landscape's canvas sits under
  everything in the pane; the owls' canvas over the composer and under every menu. The landscape's glyphs are kept per
  size and theme; a frame clears the cells under the owls instead of filling them, so no surface colour is ever
  written. A frame whose picture would not change is not painted.
- **`src/renderer/src/watcher/WatcherNightScene.tsx`** runs it: the room's watched rows in, Watcher's owl's random
  flights, the moon's ripples, and a layer of buttons, one over each sitting owl with a thread in this window, and one
  over "+N". The layer is `aria-hidden` and its buttons are out of the tab order: hover shows the thread's name and what
  it is doing, a press opens it beside Watcher (Shift, in Threads), and "+N" shows Watched, which is the keyboard's way
  to the same threads.
- **`WatcherView`** passes the rows, `openThread` and a switch to Watched, and decides when the scene shows.
- Colours come from theme roles through the probe's computed `--tt-text` and `--tt-accent`, and the stylesheet is on
  `themeTokens.test.ts`'s `owned` list, as before.

## Where the build departs from the prototype

- **No first flight.** The October 21 scene flew a route over the composer once when the room opened. That route
  crossed the column in front of it, so it is gone: Watcher's owl starts in its tree and its random flights are the
  only ones.
- **The right-hand branch is used too.** From the other tree the owl now and then drops onto the composer's right
  branch rather than going home, so both branches are perches, not one perch and one ornament.
- **The rail's eyes are two glyphs.** The prototype's eyes were `o,o`, for 30 px margins at 820x560. The room's
  composer leaves 16 px there, so the eyes are `oo`, `--` asleep and `OO` waiting, and owls keep 2 px from the column
  where the landscape keeps 8. Below 16 px nothing is drawn.
- **Spot counts** follow the room's own measurements, so they differ a little from the prototype's 27, 10 and 4; the
  unit tests check the order, not the number.

## What the room already gives each owl

`useWatcherRoom()` holds main's `WatcherRoomState`, and `watchedRows(state)` is the list of owls, with no new channel and
no change in main. Each row carries everything the scene needs:

| Owl | From the row |
|---|---|
| One owl per watched thread | `watchedRows` (`isWatchedRow`: under a standing watch, or taking part in an active request) |
| Its identity across updates | `target` (`hostId`, `threadId`); `threadForTarget` gives the window's thread for opening |
| Title on hover | `title` |
| Awake and blinking | `status === 'running'` |
| Asleep (eyes closed) | `status === 'idle'`, or `settled` while still watched. `error` and `unavailable` sleep too, and Watched says why |
| Glows in the accent | `waitsOn.length > 0` (a `question` or `permission`, with its `openTarget`) |
| Flies back into the moon | the row leaves `watchedRows` (settled, or unwatched) |
| A newcomer from the whirlpool | a target in `watchedRows` that the scene hasn't drawn before. The first read after the room opens places owls without flights |
| Paused watching | `paused`: draw it like asleep. The thread is the user's for now |

The scene diffs `watchedRows` by target on each projection, so it reads the rows it is given and copies nothing it
doesn't keep.

## Performance budget

- **Zero cost when hidden.** No timers, no canvas work and no layout reads while the room is not the visible page, the
  scene has stepped away for Visualize, or the window is hidden (`document.visibilityState`). The Owl gate off means the
  component never mounts.
- **Static layer:** drawn once per layout, theme or size change.
- **Moving layer:** about 30 frames a second only while something flies, fades, the whirlpool turns or a ripple
  spreads. Otherwise a check 8 times a second that paints only when the frame's summary changed: a blink, a star's
  half-second step, a glowing owl's step. With motion reduced, or a capture's fixed clock, the loop stops once the fades
  end, until the room changes.
- **No main-process cost.** The scene reads the projection the room already receives and sends nothing to main.
- **Checked in the built app**, not in a perf test: canvas drawing needs a real renderer. `tests/e2e/watcher-night-scene.spec.ts`
  counts the frames painted on Watcher's pane and holds the resting rate under 8.5 a second, the flight between 22 and
  33, and reduced motion at none once still. The measured rates are in the verification note.

## Tests and evidence

- Unit: `tests/unit/renderer/watcherNightScene.test.ts` (the margins, the spot order, trees or rail or nothing,
  Watcher's owl's places and flights, pace, ripples that start later, stars, ink) and
  `tests/unit/renderer/watcherOwlFamily.test.ts` (moods, the "+N" pile, arrivals, departures, hops, fades, relayout).
  `tests/unit/renderer/watcherView.test.tsx` checks when the room shows the scene.
- E2E: `tests/e2e/watcher-night-scene.spec.ts`, at 1600x1000, 1280x800 and 820x560 in dark and light: not one painted
  pixel in the column on either canvas, an owl for each watched thread, Watched keeping the scene and Visualize putting it
  away, reduced motion, a newcomer's flight, hover and press.
- No design-capture baseline shows Watcher's room, so none changes.
- A verification note, `docs/verification/2026-10-22-watcher-owl-family.md`, with its captures in
  `artifacts/watcher-owl-family/`.
- Docs: `docs/guide.md` describes the owls under Watcher's room, and `CONTEXT.md`'s **Night scene** entry now names the
  **thread owl**. "Owl family" stays this plan's name only, since Owl is the release track.
