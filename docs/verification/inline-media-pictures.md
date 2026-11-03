# An agent's pictures as tiles (ADR-0170, part 1)

Checked October 31, 2026, on forge (Omarchy), in the built app on an owned nested desktop (`scripts/verify-linux-window-minimum.mjs --exec`), with `tests/e2e/inline-media.spec.ts`.

## What was run

A Claude Code thread over the fake CLI (`tests/fixtures/fakeClaudeThread.mjs`) calls Sotto's browser screenshot tool, and the tool's result hands back a 1920×1203 PNG as a Messages API image block, then the turn ends with a reply. The app ran once with `SOTTO_OWL_FEATURES=inline-media=1` and once with `=0`.

## What it showed

- **The tile.** The turn shows one tile between its folded work line ("Worked for 0.1s · 1 step") and its reply, named Picture 1 with **PNG · 1920×1203** under it (`artifacts/inline-media/tile-1280-dark.png`, `tile-1280-light.png`).
- **A thumbnail, not the picture.** The tile's image is a JPEG data URL no wider than 416 pixels, which main made with Electron's image tools; the window never received the whole picture for the tile.
- **The viewer.** A press opens the viewer over the pane on the whole picture, 1920 pixels wide, titled Picture 1; Escape closes it and focus goes back to the tile (`viewer-1280-dark.png`).
- **The minimum.** At 820×560 the tile and the reply fit the pane and nothing scrolls sideways (`tile-820-light.png`).
- **Owl off.** With `inline-media=0` the same turn shows no tile, and nothing reads a picture.
- **The record.** Before the window drew the tile, the thread's detail held the tool's record with one handle in `media`, and the turn record with none.

## Not checked here

- Windows and macOS: the spec ran only here, on Omarchy. CI's desktop journeys do not include it.
- The iPhone: the Swift compiles only in CI's Native iOS client job. Its decoding of a step's pictures and the `thread-media` request are covered by `PhotoTests`; the tiles were not seen on a device or simulator.
- Codex: covered by `tests/unit/main/threadMedia.test.ts`, not in the running app.
