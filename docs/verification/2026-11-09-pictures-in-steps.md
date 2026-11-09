# Pictures in steps (inline media)

November 9, 2026. Forge (Linux), built app under a virtual display at 1920x1200; not installed or released. ADR-0170, decisions 29 to 32. Zach's picks are on the prototype kept as the tag `prototype/pictures-in-steps`: variant A, three pictures before a count, the capture switch kept, a generated image kept as a tile, desktop and iPhone.

## What was proved in the running app

`tests/e2e/inline-media-every-picture.spec.ts`, a Codex thread over the fake app server with **Show every picture and video an agent makes** on:

- **One picture.** The turn wrote one screenshot. It shows small, 34 by 24, at the end of the folded **Worked for** line, after **Wrote checkout.png**, and no tile stands in the thread. A press opens the viewer with **Mark up**, and Escape closes it.
- **Steps open.** Opening the line moves the picture to the end of its step's row, **Wrote test-results/checkout.png**, before the chevron. Checked at 1280x800 in dark and light, and at the 820x560 minimum in light.
- **Five pictures.** The turn wrote five. The line shows the newest three and **+2**, whose name is **Open all 5 pictures**. The count opens the viewer at Picture 1, and the Right key goes to Picture 2. Opened, the step's row carries the same strip.
- **Switch off.** Turned off from Settings, the next turn's file shows nothing, as before.

The other five picture journeys pass unchanged: `inline-media.spec.ts` (both cases), `inline-media-shown.spec.ts`, `inline-media-markup.spec.ts` (both), `inline-media-generated.spec.ts` and `inline-media-callouts.spec.ts`. What an agent shows through show_in_thread, and an image Codex makes, still stand as tiles, with callouts, the owl at the easel and Mark up.

Captures in `artifacts/inline-media/`:

- `written-in-step-1280-dark.png`: the folded line with its picture.
- `written-in-step-viewer-1280-dark.png`: the viewer opened from it, Mark up in its bar.
- `written-in-step-open-1280-dark.png`, `written-in-step-open-1280-light.png`, `written-in-step-open-820-light.png`: the picture at the end of its step's row.
- `five-in-step-1280-dark.png`, `five-in-step-open-1280-dark.png`: three pictures and **+2**, folded and open.

## What was proved by tests, not seen

- **The strip.** `stepPictures.test.tsx`: the newest three and the count, read at tile size by handle; shown and generated steps left out; the viewer stepping through the pictures of the work around the line; the count opening the first it stands for; a video's mark playing a tile under the line and taking it away; nothing while hidden, with `inline-media` off, or outside a thread.
- **Tiles.** `threadMediaTiles.test.tsx`: a tool's pictures and a turn's written files make no tile; shown and generated ones keep every tile behaviour.
- **Catalogs.** `threadMediaTilesCatalog.test.tsx`: tiles and a step's pictures are named from the compiled catalogs with no warning.
- **iPhone.** `StepPicturesTests.swift` in SottoCore holds which pictures sit in a step and which stand as tiles, and the newest three with the count. `check-strings.mjs` passes with the three new strings in every language.

## Not checked

- **The iPhone app itself.** Forge can only syntax-parse Swift; the pull request's macOS job is the first compile, and no simulator screenshot was taken.
- **A running turn's working line, a browser line and Watcher's room** with pictures. Each uses the same strip and the same rule; none was seen in the running app.
- **A real provider.** The journeys use the fake Codex app server's written files, not a live tool's screenshots.
- **Windows and macOS.** CI runs their gates; the journeys above ran on Linux.

## Performance

`tests/perf/inlineMediaTranscript.perf.test.tsx`, medians of three runs on forge: a thread of 200 turns, each with a tool's screenshot. Before is main at 40496f630, where each screenshot was a tile. After is this branch, where it sits at the end of its turn's line.

| | Before: tiles | After: in steps | No pictures |
|---|---|---|---|
| Pictures on the page | 40 | 40 | 0 |
| Tiles standing in the thread | 40 | 0 | 0 |
| Opening the thread | 72.9 ms | 69.5 ms | 81.4 ms |
| Streamed chunk | 11.7 ms | 9.0 ms | 12.1 ms |
| Chunk commits | 20 | 20 | 20 |
| Scroll step | 2.36 ms | 2.03 ms | 1.06 ms |
| Reads: opening, chunk, scroll | 6, 0, 30 | 6, 0, 30 | 0, 0, 0 |
| Most pictures held at once | 6 | 6 | 0 |

Every count is the same, and the milliseconds move within run-to-run spread. The benchmark now also holds a thread whose pictures are in steps to the tiles' counts, and its tile cases are on show_in_thread steps, where tiles now come from.
