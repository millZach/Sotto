# Mark up (inline media, part 5)

November 1 and 2, 2026. Forge (Linux), built app on its X display; not installed or released. ADR-0170 decisions 16 to 18, rebased onto the request-only amendment (R1 to R3).

## What was proved in the running app

`tests/e2e/inline-media-markup.spec.ts` drives the built app over the fake Codex app server:

- A turn writes `test-results/checkout.png`, a 1920×1203 screenshot. Under request-only the turn shows nothing of it. The agent then names it to `sotto_media`'s `show_in_thread` as "The checkout page", as it does when the user asks to see it, and the turn shows it as **Picture 1**.
- Pressing the tile opens the viewer, and its **Mark up** opens the editor over the pane, with **Arrow** chosen and focused.
- An arrow and a box are dragged with the pointer. **T** picks **Note**, and a press places the note box, where "This total is wrong" is typed and Enter keeps it. The marks list reads **Arrow**, **Box**, **Note: This total is wrong**.
- At 820×560 the editor's bar wraps onto a second line and nothing scrolls sideways.
- **Add to reply** makes a 1920×1203 PNG. Across the box's top edge it holds the theme's red ink, read from `--tt-ink-red` in the running app. It adds the copy to the reply box as **Picture 1 marked up.png**, closes the viewer and puts the focus in the reply box. The picture in the thread is the same tile.
- Add to reply took 169 ms and 145 ms on two runs before the rebase, and 158 ms after it, from the press to the copy's chip in the reply box: drawing, PNG encoding, staging and the chip's thumbnail.
- The marked copy reaches the thread only as the user's own image in a reply they send. Mark up shows nothing in the thread by itself, so it keeps the request-only rule.

The first run used the theme's danger role for red. On forge's Omarchy theme that role is lavender (`oklab(0.81 0.007 -0.043)`), nearly the theme's text colour, so red and plain inks looked alike. The inks now come from the theme's error and warning colours at full strength (`--tt-ink-red`, `--tt-ink-amber`), as `markup-1280-light.png` shows.

Captures in `artifacts/inline-media/`:
- `markup-1280-dark.png`: the editor with an arrow, a box and a note, and the marks listed.
- `markup-1280-light.png`: the same in light, with the three inks in the bar.
- `markup-820-light.png`: the minimum, with the bar on two lines and the marks under the picture.
- `markup-added-1280-light.png`: the marked copy in the reply box, under the unchanged tile.

The image viewer specs (`image-viewer.spec.ts`, `image-viewer-app.spec.ts`) and two of the earlier inline media specs (`inline-media.spec.ts`, `inline-media-written.spec.ts`) passed in the same build. After the rebase, `inline-media-markup.spec.ts` and `inline-media.spec.ts` passed again, and the captures were taken again from the shown picture.

## What was proved below the app

- `tests/unit/renderer/markupEditor.test.tsx`:
  - **Where Mark up shows:** in a thread pane's viewer, and not in a viewer outside a pane.
  - **Drawing:** the arrow, the box and a pen line are drawn and listed; a box from a slipped press is not a mark. Undo, Redo and removing a mark work, and removing a mark can be undone.
  - **Notes:** a note is placed where it is pressed. Enter keeps it; Escape drops only the note.
  - **The keyboard:** Enter starts a box at the cross, the arrow keys move it and Enter ends it. Escape drops only a mark in progress, then goes back to the viewer with the focus on **Mark up**.
  - **Add to reply:** with nothing drawn it says so and adds nothing. With a mark it hands the pane's reply box a PNG named after the picture and closes. A refusal before drawing keeps the editor shut; a refusal after drawing keeps the marks.
  - **The reply box takes the copy as it takes a paste:** it stages the copy, shows the chip and takes the focus. It refuses for an archived thread, an answer pending or a model that reads no images, each in its own words.
- `apps/ios/Tests/SottoCoreTests/MarkupTests.swift`: the iPhone's marks keep the desktop's sizes. A slip is not a mark. A pen widens with pressure, and the arrow's head is at its end. Undo, Redo and removing work, and removing can be undone. The copy is named as on the desktop. These ran on forge in a Swift package of `Markup.swift` alone (5 tests).

## Performance

`tests/perf/markupEditor.perf.test.tsx` (new) and `tests/perf/inlineMediaTranscript.perf.test.tsx`, on forge, after the rebase. "Before" is main at 52a855e4f, with the new benchmark's viewer half run against it in a worktree of main. Each figure is the median of runs alternated between the two: 8 each for opening the viewer, 3 each for the transcript.

| | Before | After |
|---|---|---|
| Opening a picture in the viewer | 11.4 ms, 3 commits, 36 elements | 13.1 ms, 3 commits, 41 elements (Mark up's button) |
| The same, with Mark up's button hidden | | 11.1 ms, 3 commits, 36 elements |
| Opening the editor | no editor | 0 reads |
| A pen line of 200 moves over 20 marks | no editor | 0.21 ms a move; no earlier mark drawn again |
| Thread, no pictures: open / chunk / scroll step | 75.9 / 12.5 / 1.06 ms | 75.0 / 12.4 / 1.00 ms |
| Thread, pictures: open / chunk / scroll step | 73.7 / 11.9 / 2.46 ms | 72.3 / 11.9 / 2.34 ms |
| Thread, videos: open / chunk / scroll step | 77.0 / 11.0 / 2.04 ms | 74.8 / 11.4 / 2.05 ms |

Opening a picture costs about 1.7 ms more in jsdom, and all of it is drawing Mark up's button and its icon: with the button hidden, the same build opens in 11.1 ms. The viewer commits no more often and reads nothing more. Every count in the transcript benchmark is the same as before: commits, reads, held pictures and video loads. Its milliseconds move both ways within run-to-run noise. A pen line first cost 1.34 ms a move, because each move redrew the whole editor. The line being drawn now has a layer of its own, so a move redraws only that layer.

## Not proved here

- **The iPhone's editor and viewer button:** they compile only in CI, on the Native iOS client job. No capture was made: forge has no Mac, and the iPhone fixtures hold no agent pictures to open.
- **An Apple Pencil:** pressure and the finger moving the picture were not tried on a device.
- **Windows and macOS:** the editor was not opened there.
