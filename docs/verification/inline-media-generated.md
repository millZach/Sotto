# Generated images and the owl at the easel (ADR-0170, part 2)

Checked October 31, 2026, on forge (Omarchy), in the built app on an owned nested desktop (`scripts/verify-linux-window-minimum.mjs --exec`), with `tests/e2e/inline-media-generated.spec.ts`. `tests/e2e/inline-media.spec.ts` (part 1) passed in the same run.

## What was run

A Codex thread over the fake app server (`tests/fixtures/fakeCodexAppServer.mjs`) with `SOTTO_OWL_FEATURES=inline-media=1`. Its turn stays open while the fake sends an `imageGeneration` item as Codex does: started with no result, then completed with only `fileId` and `savedPath`, the file a 1920×1203 PNG. A second item is then started and left running.

## What it showed

- **The owl at the easel.** While the item runs, the turn shows a tile named **Making the image**, with **It shows here when it is done** under it, where the owl paints at its easel under the stars (`artifacts/inline-media/making-1280-dark.png`). Its text changes from frame to frame.
- **Reduced motion.** With reduced motion emulated, the scene changes to its still frame, the painting half done, and holds it.
- **The picture lands.** Once the item completes, the scene is gone and the tile is **Picture 1**, **PNG · 1920×1203**, its thumbnail a JPEG no wider than 416 pixels, read by main from the file Codex saved (`generated-1280-dark.png`). Its button is named from what Codex said the image shows. A press opens the whole picture in the viewer; Escape closes it.
- **Both together, light, and the minimum.** A finished picture and an image still being made sit side by side (`making-1280-light.png`), and at 820×560 the tiles fit the pane with nothing scrolling sideways (`making-820-light.png`).

## Measured

`tests/perf/inlineMediaTranscript.perf.test.tsx` on forge, `main` at 62d33bce7 (before) and this branch (after), two runs each. The thread is the benchmark's 400 messages, 200 turns, each with a screenshot.

| | Before | After |
| --- | --- | --- |
| Chunk commits, 20 chunks, with pictures | 20 | 20 |
| Chunk React time, with pictures | 6.15 / 7.16 ms | 8.30 / 6.23 ms |
| Mount, with pictures | 77.0 / 74.3 ms | 72.8 / 76.7 ms |
| Scroll step, with pictures | 2.44 / 2.41 ms | 2.44 / 2.42 ms |
| Reads: chunk, mount, scroll | 0, 6, 30 | 0, 6, 30 |

The without-pictures numbers moved the same way between runs (chunk React 8.67 / 7.46 ms before, 8.48 / 8.42 ms after), so the chunk spread is the machine, not the change. The new case, with two images being made:

| | Count |
| --- | --- |
| Frames drawn before a scene first comes on screen | 0 |
| Frames drawn in 2 s off screen, and frame requests left waiting | 0, 0 |
| Frames per scene per second in view | 10 (at most 12, plus one as it comes on screen) |
| React commits while the scenes play | 0 |
| Time per frame drawn | 0.05 ms |
| Frames drawn in 2 s after the pictures land, and requests left waiting | 0, 0 |

## Not checked here

- Windows and macOS: the spec ran only here. CI's desktop journeys do not include it.
- The iPhone: the scene's port is in SottoCore (`OwlEasel.swift`), compiled and run on its own here with Swift 6.4 against the same checks as `OwlEaselTests`; SottoCore as a whole and the tile view compile only in CI's Native iOS client job. The tile was not seen on a device or simulator.
- Cursor: covered by `tests/integration/generatedImages.test.ts` over the fake Cursor client, not in the running app.
- A real Codex or Cursor generating an image: the fakes send the shapes Codex 0.166.0's protocol schema and Cursor's ACP extension describe.
