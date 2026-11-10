# Watcher's night scene comes to life

## Status

Accepted November 10, 2026. Zach asked how Watcher's night scene could "really stand out and [be] fun to watch", and picked E, **The wood mirrors the room**, of the prototype kept at the tag `prototype/watcher-scene-life`. He then asked whether the scene could look better while staying ASCII, and picked **Line art + depth** of the four ways of drawing the same prototype offers. It is an Owl feature (`living-night-scene`, [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)), his call the same day. Builds on [ADR-0126](0126-watchers-conversation-runs-over-a-still-night-scene.md) and [ADR-0149](0149-watchers-night-scene-is-set-in-a-place-the-user-picks.md) and amends both where it says so. **Number provisional until merge** (docs/agents/domain.md).

It was built in three parts behind the one switch: the drawing, decisions 1 to 5; the owls, decisions 6 to 8; and the wood's life, decisions 9 to 11. All three are built.

## Context

Four days earlier Zach had kept the night wood over five other compositions (ADR-0126, amendment of November 6), so the composition was not the question. Two things were.

**Little happened in it.** Stars twinkled, the owls blinked, a thread owl came out of the moon or went back into it, and Watcher's owl flew now and then, at random. The night wood was the one place with nothing else moving (ADR-0149, decision 4), and nothing the threads did showed in the scene but an owl's eyes.

**It was drawn by density.** Each glyph cell became the character for how much of it was covered, from the ramp ` .·:-=+*#%@`. A ridge, a branch and the moon's rim all came out as speckle, a hill showed through the tree in front of it, and far things were as strong as near ones.

The prototype put Sotto's own Watcher room, dumped from the built app, under the real scene source, and offered five answers to the first (A, today; B, the wood breathes; C, the owls have lives; D, things happen at night on a timer; E, all of it tied to the room) and four to the second (today's density; line art; depth; both).

## Decision

**1. A line is drawn as a line.** The landscape and Watcher's owl are drawn on a finer field, sixty pixels to a glyph cell, and a cell that holds a line, or the edge of something filled, takes the line's own character: `_` or `-` for one lying flat, by how high in the cell it lies, `/` or `\` for a slanted one, `|` for an upright one, `'` or `,` for a short thin stub. Where the ink lies and which way it runs are measured in shares of the cell, so the cell being taller than wide makes nothing look upright. A line along the top of a cell has no character of its own and is drawn as the underline of the cell above. A line is drawn in ink as strong as the line, not as faint as its cell's average. A cell that is mostly covered, or holds a blob, a fork or a corner, takes the density ramp as before (`sceneGlyph.ts`). A first attempt matched each cell against every character's own shape and filled the scene with `J`, `L` and `7`; only these line characters are used.

**2. What is in front hides what is behind, and far things are fainter.** A place may be drawn a layer at a time, the farthest first (`ScenePlace.layers`). A nearer layer that covers a cell takes it whole, so a trunk never shares a cell with the hill behind it, and each layer's ink is as strong as it is near: in the night wood the far hills at half, the trees a little over full, the moon the brightest thing. Drawn in layers a hill is stroked along its ridge only, since the ground hides its foot, and the ground's edge carries the line the hills' feet added to it.

**3. The moon has a halo.** A soft wash of the accent round the moon, under the landscape's glyphs, in the moon's own margin and below the header. No word of the conversation or the header stands on it. It is an element under the canvas, not ink on it, so nothing the painter clears makes a hole in it.

**4. Lines stop at the conversation.** Under the column every cell is still drawn by density, at the column's share and under its ink ceiling (ADR-0126, decisions 3 and 4). A solid ridge there read as an underline of the words above it. The layers still apply, so the column is cleaner too.

**5. Only the night wood has layers yet.** Harbour, Snowfield and Desert are drawn by density as they were until each has its own layers, and so is the rail of eyes at a narrow margin. Their owls and what moves in them are unchanged. The pictures in Settings stay drawn by density.

**6. Each thread owl acts out its thread.** Asleep under rising `z`s while its thread rests. While it works, it looks down at its work, turns round, stretches and hops, and watches Watcher's owl fly over. While it waits on the user it waves a wing under a `?` for a question or a `!` for a permission. An owl whose thread's last turn failed winces, feathers ruffled; today it only looks asleep. When a turn finishes it gets a burst of sparks and is happy for a moment before it sleeps. These are poses of the same three-row sprite and a few glyphs round it.

**7. Watcher's owl flies for a reason.** When Watcher sends a watched thread a message, its owl flies to the tree that thread's owl sits in, unless it is there already, and calls to it, a note crossing between them; the thread owl looks up, is happy, and answers. A thread Watcher has only just started is not called to: its owl is on its way out of the moon. A burst of messages is a few calls, not a queue: at most four wait their turn. This amends ADR-0126: it no longer flies at random. It still flies as that record's decision 7 has it, and with motion reduced it keeps that decision's calm steps from perch to perch, at random, since nothing else of the living scene moves then.

**8. The owls notice the pointer.** Watcher's owl's eyes follow the pointer while it moves in a margin, and let go a moment after it stops; a thread owl hops when pointed at. A press on a thread owl still opens its thread, and a press in the open margin still sends out its ripple.

**9. The wood follows how busy the room is.** How busy is the share of the watched threads that are working, counted against at least four, so one or two working threads are not a storm. The busier, the more often a gust crosses from the left, every 6 seconds or so against every 26: grass leans, the crowns sway a cell, leaves fly off Watcher's tree, and the river's glints run faster. The quieter, the more fireflies, 16 against 5, and the thicker the mist between the hills. The fireflies keep clear of a pointer resting in the pane. This amends ADR-0149, decision 4: the night wood has things that move. It is the night wood's own: the other places keep what moves in them, and their owls.

**10. Nothing happens on a timer; the wood answers the room.** A turn that finishes sends a shooting star. A turn that fails scatters bats from the bare tree. A thread whose work settles gets a meteor shower. Each answers once however many threads it came from at once. While nothing has worked for twenty seconds the wood's animals come out, one at a time and about a minute and a half apart, in turn: a fox crosses the ground and stops to look up, a fish jumps in the river, a cloud drifts over the moon, and Watcher's owl dives for a mouse under its tree, which bolts as it lands. The owl hunts from home: one its last call left in the other tree flies home first, and a hunt that cannot start, the owl in the air or a call under way, keeps its turn and is tried again a few seconds on. Whatever ends a hunt early, a new size, another place, the feature going or motion reduced, puts an owl on the ground back home at once. Work starting again sends the animals home. It reads all of this off the watched rows the room already holds, comparing each with what it was when last looked at, so nothing is replayed and nothing is kept but one small record a thread.

**11. It keeps the scene's rules.** Colours stay the theme's two inks. Every glyph it adds goes through the painter's guard: one to a cell, at the column's share and under its ceiling, never under still words, a star or an owl. What moves is a bounded number of glyphs that does not grow with the room's history or its threads, stepping eight times a second and faster only while something quick crosses. With reduced motion nothing moves: the `z`s, the `?` and `!` and the fireflies are drawn once where they rest.

## Considered options

- **B, the wood breathes, alone.** Pleasant and meaningless: decoration that tells the user nothing.
- **C, the owls have lives, alone.** The heart of it, and built as decisions 6 to 8.
- **D, things happen at night, on a timer.** Fun at first and soon noise: a set piece that means nothing wears out. Its set pieces are kept and given causes (decision 10).
- **Line art alone, or depth alone.** Each helps; Zach picked both.
- **Smaller cells, or braille and block characters.** Sharper, but the thread owls shrink with the cell, and blocks are not the typed look he asked to keep.

## Consequences

- Laying the scene out draws each of a place's layers in turn, nine for the night wood, on a field fifteen times the pixels of the density fields, and reads back only the part of the pane that layer draws in. It runs when the window's size, the place or the feature changes, never for a frame. Measured with the painter alone in headless Chromium on the Windows laptop, a layout at 1600 by 954 took about 22 ms as line art against 8 ms by density, and 29 ms against 9 ms at 1920 by 1034, so the scene follows a dragged window edge more slowly than it did.
- Watcher's owl is drawn twice a painted frame while line art shows, once on each field, and only the box round it is cleared and read.
- A star is not placed where line art drew a glyph that density would have left empty, so the night wood's sky has a few stars fewer near its lines.
- The room's watched rows now tell the scene three more things each: whether the last turn failed, what the thread waits on the user for, and how many messages Watcher has sent it. They are read off the row the room already holds, and the scene remembers one small record a watched thread, dropped when the thread is no longer watched.
- A resting scene with sleepers or a waiting owl is painted again when a `z` rises or a `?` bobs, a few times a second at most, and not between.
- `watcher-column.spec.ts` waited for a random flight to check an owl crossing the column. On Owl it now has Watcher send a thread a message.
- The night wood on Owl paints eight times a second at rest, as the other three places already do for what moves in them, and faster only while something quick crosses. `watcher-night-scene.spec.ts` holds a resting scene under 8.5 paintings a second, and it still passes.
- What a frame of the wood's life draws is bounded by the pane: a fixed few fireflies, glints and wisps, a cell a column of grass, the crowns' own cells while a gust crosses them, and at most six things happening at once.
- Stable shows and starts none of it. Turning the feature off draws every cell as it was.
