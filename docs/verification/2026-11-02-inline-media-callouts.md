# Callouts (inline media, part 6)

November 2, 2026. Forge (Linux), built app on its X display; not installed or released. ADR-0170 decisions 19 to 21, on Zach's picks from `docs/prototypes/inline-media-callouts-prototype.html`: option 2 (the tile draws the boxes, pins and count) and the editor's **Show** and **Keep the callouts in the copy**, both on.

## What was proved in the running app

`tests/e2e/inline-media-callouts.spec.ts` drives the built app over the fake Codex app server:

- A turn writes `test-results/checkout.png`, a 1920×1203 screenshot. The agent names it to `sotto_media`'s `show_in_thread` as "The checkout page", with two callouts: a box near its top right, "The zoom controls sit too close to Copy image.", and one across its lower part, "The strip under the picture has no label." The tool answers that it showed 1 file with 2 callouts.
- The tile is **Open picture 1 of 1, from The checkout page, with 2 callouts**. It draws both dashed boxes with their numbered pins over the picture, and a count of 2 in its corner.
- The viewer draws the two boxes over the picture. Their layer and the picture have the same bounds as the picture grows into place, so each box lands where the agent put it. The notes are listed beside the picture under **Callouts from Codex**. At 820×560 the list moves under the picture and nothing scrolls sideways.
- **Mark up** lists the callouts above **Your marks**, with **Show** and **Keep the callouts in the copy** both ticked, and draws them over the picture.
- **Add to reply**, with no mark of the user's own, makes a 1920×1203 PNG. Along the second box's top edge it holds the theme's accent, read from `--tt-accent` in the running app. The copy goes into the reply box as **Picture 1 marked up.png**, and the tile in the thread still draws its callouts. Add to reply took 154 ms, from the press to the copy's chip.

`tests/e2e/inline-media-markup.spec.ts` (part 5) passed in the same build, now on the shared setup in `tests/e2e/support/shownPictureThread.ts`: Add to reply took 151 ms.

Captures in `artifacts/inline-media/`:
- `callouts-tile-1280-dark.png`: the tile with two boxes, their pins and the count.
- `callouts-viewer-1280-dark.png` and `callouts-viewer-1280-light.png`: the viewer with the boxes over the picture and the notes beside it.
- `callouts-viewer-820-light.png`: the minimum, with the notes under the picture.
- `callouts-markup-1280-light.png`: the editor with the callouts listed above the user's marks, **Show** and **Keep the callouts in the copy** ticked.

The part 5 captures (`markup-*.png`) were taken again in the same run.

## What was proved below the app

- `tests/unit/main/shownCallouts.test.ts`: a callout goes on the picture its path names, as shares of the picture's size to four places, numbered by picture and then as given. A box partly off the picture is cut to it, and one drawn from its far corner counts the same. A callout whose picture was not shown, is a video or has no size, or whose box lies outside the picture, is refused with that reason. At most 12 are placed.
- `tests/unit/main/shownMedia.test.ts`: through the workspace, the media tool and the coordinator, a call with three callouts shows the picture and the video. It places the picture's callout and names the video's and the off-picture one back with why. A call with 13 callouts is refused.
- `tests/unit/renderer/mediaCallouts.test.tsx`:
  - **The tile:** it draws the boxes, pins and count, and says how many in its name. The layer is laid over the picture at its own shape, with pins of a fixed size on screen. A picture without callouts draws none.
  - **The viewer:** it lists the notes under **Callouts from Codex** and draws the boxes in a layer with the picture's own size and place, so zoom and pan carry them. The next picture, without callouts, has neither.
  - **The editor:** it lists the callouts, with **Show** and **Keep the callouts in the copy** ticked. Kept callouts make Add to reply work with no marks, and the copy draws them under the marks. Unkept, they don't make the copy worth adding on their own. Hidden, they are off the picture, and Keep is unticked and disabled.
  - **The drawing:** a callout's shape is a share of the picture on a copy, and a fixed size given a tile's scale. On a canvas it draws a dashed box, a pin and its number, and leaves the canvas as it found it.
- `apps/ios/Tests/SottoCoreTests/CalloutTests.swift`: the iPhone reads a picture's callouts from its handle, and none from an older computer. Its shapes match the desktop's. A picture fills a tile, cut to it, and fits the viewer whole. The geometry ran on forge, compiled with `Markup.swift` and a stand-in for the wire type, and gave the numbers the tests expect. The decoding test, the SwiftUI drawing in the tile, the viewer and the editor, and the iPhone strings in all 30 languages compile only in CI's Native iOS job. `check-strings` passes on forge.

## After review

Sol's Standards and Spec reviews of the branch led to these fixes:

- **Keyboard:** the viewer's list of notes takes the focus after the picture, so long notes can be reached and scrolled from the keyboard. `mediaCallouts.test.tsx` checks Tab lands on it.
- **iPhone tiles:** a picture with callouts shows whole in its tile, at its own shape, as on the desktop, so no box near its edge is cut off. A GIF with callouts plays fitted the same way, so its boxes stay on it, and its pins keep a fixed size on screen.
- **Partly off the picture:** a box that overlaps the picture by part of a pixel is cut to it rather than refused. Only a box with no overlap is refused.
- **Evidence:** the inline-media journeys' captures go through `tests/fixtures/evidence.ts`, to `artifacts/e2e-runs/inline-media/` and to `artifacts/inline-media/` with `SOTTO_E2E_EVIDENCE=publish`. #2021 still covers the other three inline-media specs.
- **Paired files:** `shownMedia` hands back each picture with the file it was read from, and the callouts are placed by that.

After the fixes, both specs passed again in a new build: Add to reply took 155 ms (callouts) and 152 ms (mark up). The captures from that run matched the committed ones apart from the time in the sidebar, so the committed ones stay.

## Performance

`tests/perf/inlineMediaTranscript.perf.test.tsx`, the median of three runs each on forge. Main is `d2d5b05f5`; the callouts are the same 200-turn thread with three on each picture.

| | Main, pictures | Branch, pictures | Branch, callouts |
|---|---|---|---|
| Opening the thread | 73.7 ms | 74.0 ms | 74.8 ms |
| Streamed chunk | 12.2 ms | 12.8 ms | 11.3 ms |
| Chunk, React commit time | 7.2 ms | 7.5 ms | 5.9 ms |
| Chunk commits | 20 | 20 | 20 |
| Scroll step | 2.48 ms | 2.43 ms | 2.95 ms |
| Reads: opening, chunk, scroll | 6, 0, 30 | 6, 0, 30 | 6, 0, 30 |

Callouts read nothing more and commit no more for a chunk. A scroll step costs about 0.5 ms more, for drawing a tile's three boxes as it comes near. The test asserts every count on every run.

`tests/perf/markupEditor.perf.test.tsx`, the median of three runs, with their range:

| | Main | Branch | Branch, three callouts |
|---|---|---|---|
| Opening a picture in the viewer | 14.4 ms (14.1 to 21.0) | 11.9 ms (11.5 to 15.0) | 9.7 ms (9.5 to 9.9) |
| Elements the viewer draws | 41 | 42 | 54 |
| A pen move over 20 marks | 0.26 ms | 0.21 ms | 0.12 ms |
| Marks redrawn by a 200-move line | 1 | 1 | 1 |

The viewer's one new element is the box that holds the picture and the callout list. With callouts it draws 12 more: the list and the layer over the picture. The callout runs come after the plain ones in the same process, so they run warmer; their milliseconds are not a saving.
