# Watcher's owl family

Zach approved this on October 22, 2026, to be built once the Visualize tab has merged. Prototype:
`docs/prototypes/watcher-owl-family-prototype.html`, tagged `prototype/watcher-owl-family`. It carries Zach's picks
from the October 21 owl scene (glyphs, Watcher's owl in the left tree, the flight across the moon, darker ink in light
mode, no cabins) and the four he made on October 22:

- Owls cross the room's column **behind** it: a flight leaves one margin and comes out of the other.
- On the composer, Watcher's owl stands **beside it in the margin**, on a short ledge that carries the composer's top
  edge out. It never stands on the edge over the transcript.
- A margin too narrow for trees (under 160 px) shows a **rail of owl eyes**, one pair per watched thread.
- The **moon** sits in the right margin, above the limb new owls fill first.

Watcher is an Owl feature (`watcher` in `src/shared/owlFeatures.ts`). The scene is part of it and asks the same gate:
stable builds draw none of it and start none of its timers.

## Where it sits

The Watcher room is full width, and its content is the new thread's 760 px column: `max(24px, (100% - 760px) / 2)` on
each side. The scene lives only in those two margins, below the room's strip and above nothing else. It is drawn the
same way on Conversation, Watched and Visualize, because all three share that column. Nothing is drawn under or over
the column, the strip, the dock or any open menu. Visualize has to keep its drawing inside the column for this to hold;
check that once it merges, and fold its layout into the plan if it doesn't.

- One component, `WatcherOwlScene`, mounted once in the room behind the column (`z-index` under content). It owns two
  canvases: a static one (hills, trees, moon, ground), drawn again only on a layout change or a theme change, and a
  moving one (stars, owls, whirlpool, ripples). Both are `aria-hidden`.
- Above them sits a layer of invisible buttons, one over each perched owl. Hover shows the thread's title and state in
  a tooltip, and a press opens the thread beside Watcher, the same as a Watched card's title (`onOpen`). A glowing owl
  opens the thread at its question or permission, the same as `watcher-answer`. These buttons stay out of the tab
  order: the Watched tab is the keyboard path to the same threads, and twenty-five owls would swamp it.
- The layout comes from a `ResizeObserver` on the room and the composer's rectangle; the ground line sits at the
  composer's middle, as in the prototype. The ripple on a click in the open margin stays, limited to the margins.
- Colours come from theme roles: ink from `--tt-text`, eyes, glow and whirlpool from `--tt-accent`, and the halo fill
  from `--tt-canvas`, read once per theme change. The stylesheet goes on `themeTokens.test.ts`'s `owned` list.
- Spots fill in a fixed order: the right tree's limb (from the column side), then Watcher's tree, then the ground (the
  right margin, then the left). When the threads outnumber the spots, the last spot shows "+N", and a press switches to
  Watched. From the prototype: 29 spots at 1600×1000, 12 at 1280×800 and 6 at 1100×720. The rail holds about 19 a
  margin at 820×560.

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

- **Zero cost when hidden.** No timers, no canvas work and no layout reads while the room is not the visible page or
  the window is hidden (`document.visibilityState`). The Owl gate off means the component never mounts.
- **Static layer:** drawn once per layout, theme or size change, under 8 ms at 1600×1000 on the development laptop.
- **Moving layer:** 30 frames a second only while something flies, the whirlpool is open or a ripple runs. Otherwise a
  check 8 times a second that paints only when the frame's summary changed (a blink, a star's half-second step, a glow's
  step): about 2 to 4 paints a second at rest. With reduced motion there are no flights, owls fade in and out, and once
  the fades end the loop stops until the room changes.
- **Per paint:** the moving layer only, under 2 ms with 25 owls, measured as the prototype's readout does (frames
  ticked, frames painted).
- **No main-process cost.** The scene reads the projection the room already receives and sends nothing to main.
- **A perf test** (`tests/perf/watcherOwlScene.perf.test.ts`, opt-in through `SOTTO_PERF_ASSERT=1`): it builds the scene
  at 1600×1000 with 25 rows, then asserts that idle paints stay under 5 in 2 seconds and that reduced motion schedules
  no frame once its fades end.

## Tests and evidence

- Unit (`tests/unit/renderer/watcher/`): spot order and the "+N" pile, the row to owl state mapping above, diffing
  rows into arrive and leave, the reduced-motion fades, and the margin threshold choosing trees, rail or none.
- E2E: the Watcher room's spec gains a margin check at 1600×1000, 1280×800 and 820×560. Owls appear only outside the
  column, a press on an owl opens its thread, and the Watched tab still reaches every thread from the keyboard.
- Design captures for the room at the three sizes, light and dark, with a fixed seed and motion reduced so captures
  are stable. Regenerating baselines is on purpose and goes in the PR.
- A verification note in `docs/verification/` with screenshots in `artifacts/watcher-owl-family/`.
- Docs: `docs/guide.md` gets a paragraph on the owls under Watcher, and `CONTEXT.md` gets **Owl family** (the scene)
  if the build keeps that name.
