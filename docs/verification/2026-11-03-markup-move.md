# Moving marks and text in Mark up

November 3, 2026. Forge (Linux), built app under `xvfb-run`; not installed or released. ADR-0170 decisions 25 to 28. Zach's picks came from the prototype kept as the tag `prototype/inline-media-markup-move`.

## What was proved in the running app

`tests/e2e/inline-media-markup.spec.ts`, second journey, over the fake Codex app server with a 1920×1203 picture:

- A box, a note pressed onto it and sized up once, a free note, and an arrow drawn straight across the box. The list reads **Box**, **Note on the box: This total is wrong**, **Note: Free words**, **Arrow**, and the bar's controls stay on one line at 1280×800.
- **Move** takes the box and its note together by the same distance, and leaves the other marks where they were. **Undo** and **Redo** step through it.
- The box's corner handle resizes it. The note dragged off it lists as free and says so.
- At 820×560 nothing scrolls sideways.
- **Add to reply** makes the copy at 1920×1203 with no outline or handle on it. Held against a screenshot of the editor scaled to the same size, 100% of the ink on each has ink within two pixels on the other.
- Across the note's words on the copy, 17% of the rectangle holds the ink, where the old label filled all of it, so the picture shows behind the words.

The first journey, drawing and adding a copy, and `inline-media-callouts.spec.ts` passed in the same build. Add to reply took 118 ms and 168 ms.

Captures in `artifacts/inline-media/`:
- `markup-move-selected-1280-dark.png`: the box moved with its note, selected, with its outline and four handles, and selected in the list.
- `markup-move-free-1280-light.png`: the note freed, in light, with the words on a dark picture.
- `markup-move-820-dark.png`: the minimum.
- `markup-move-added-1280-dark.png`: the copy in the reply box.
- `markup-1280-dark.png`, `markup-1280-light.png`, `markup-820-light.png`, `markup-added-1280-light.png`, `callouts-markup-1280-light.png`: taken again, since the words have no label now and the bar has **Move** and the text buttons.

## What was proved below the app

- `tests/unit/renderer/markupEditor.test.tsx`: which mark a press picks up; a shape moving with its notes; the picture's edge; attaching and freeing; resizing, including that a resize can't lose a mark; the text sizes; a drawing tool never picking a mark up; a press with no move being no step of Undo; a note going with its shape and coming back with Undo; the words having no label; A− and A+ off until there is text to size; the keyboard path, which leaves a chord the dictation hotkey holds alone; Escape stopping a drag; the copy being handed the marks as they stand.

## After review

Sol's Standards and Spec reviews:

- **A flat circle:** a circle drawn or resized to no height took every press on the picture, and every note placed. It now counts as the line it is.
- **Undo:** a run of arrow-key presses after an Undo and another change could fold into that change, so Undo took both. A run now ends whenever anything else changes the marks.
- **A change during a drag (Sotto Bug Bot):** Undo or Delete during a drag was overwritten at release by the marks the drag began on, so a deleted mark came back and Redo was cleared. The drag now stops when the marks change under it, on the desktop and the iPhone. `markupEditor.test.tsx` and `MarkupTests.swift` prove it; the iPhone's stop on the spot, a view change, isn't run by any test.
- **Arrow keys and Alt with them (Sotto Bug Bot):** a move and then a resize of one mark folded into one Undo step. A run now holds to one kind.
- **Text on an arrow:** resizing an arrow left its text behind. The text now turns and stretches with the arrow, and a resized mark's text stays on the picture.
- **Placing and dropping:** placing asked what was under the press and dropping asked what was under the words' middle, so a long note placed near a box's edge came off at the next nudge. Both now ask the same thing. A note moved off a mark with the arrow keys is free, as one dragged off is.
- **Alt and the arrow keys:** they leave a chord the dictation hotkey holds alone.

Two smells stay: the note's four sentences appear in the list and in the status line, since Lingui needs each one written whole.
- `apps/ios/Tests/SottoCoreTests/MarkupTests.swift`: the same rules for the iPhone's marks, ran on forge in a Swift package of `Markup.swift` alone (15 tests).
- `apps/ios/Scripts/check-strings.mjs`: 1028 keys in 30 languages. The ten new iPhone strings are drafts for every language. The desktop's new messages show in English until translated, as the rest of Mark up's do.

## Performance

`tests/perf/markupEditor.perf.test.tsx`, on forge under other threads' load.

| Over a picture with 21 marks | Result |
|---|---|
| Dragging a mark, 200 steps | 199 redraws of that mark and none of the other 20, 0.41 ms a step |
| The pointer passing over the picture with Move | 0.05 ms a move |
| A pen line of 200 moves, as before | 1 redraw, 0.22 ms a move |

## Not proved here

- **The iPhone's editor:** `MarkupViews.swift` compiles only in CI, on the Native iOS client job, and no capture was made: forge has no Mac. The strokes, the ring-drawn edge, the handles and the touch routing with a finger or a Pencil have not been seen running.
- **An Apple Pencil on a device.**
- **VoiceOver on the iPhone:** the picture's touches are hidden from it, as they were for drawing, so **Move** can't be used from it. The desktop's path is the keyboard.
- **Windows and macOS:** the editor was not opened there.
