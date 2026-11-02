# Pictures and videos only when asked (inline media, request-only)

November 1, 2026. Forge (Linux), built app on its X display; not installed or released. ADR-0170's request-only amendment, decisions R1 to R3.

## What was proved in the running app

- `tests/e2e/inline-media.spec.ts`: a Claude Code thread over the fake CLI takes a screenshot with Sotto's browser tool.
  - **The turn shows no tile for it**, with `inline-media` on and with it off. Before this change, the same turn showed it as **Picture 1**.
  - **Shown on request:** the agent then names the file to `show_in_thread` with the title "The checkout page". The turn shows it as a tile, **Open picture 1 of 1, from The checkout page**. The tile holds main's thumbnail, opens in the viewer at 1920 px, and passes the dark, light and 820×560 checks as before.
- `tests/e2e/inline-media-shown.spec.ts` (was `inline-media-written.spec.ts`): a Codex thread writes a screenshot and a WebM recording into its git-ignored `test-results/`, and its turn ends.
  - **No tile on its own:** nothing shows, where before the turn's end added **Pictures and videos it wrote**.
  - **Shown on request:** the agent names both files to `show_in_thread` as "The sign-up flow", and both show under that title. The recording behaves as part 4's did:
    - its first frame comes through `sotto-media:`;
    - it stays paused for half a second;
    - it plays when pressed and pauses once scrolled away.
- `tests/e2e/inline-media-generated.spec.ts`: an image Codex generates still plays the owl at the easel, then shows as a tile.

Captures in `artifacts/inline-media/`:
- `shown-1280-dark.png`: the picture and the recording under "The sign-up flow", before play.
- `shown-playing-1280-dark.png`: the recording playing.
- `shown-1280-light.png`.
- `shown-820-light.png`: the minimum.

## What was proved below the app

- `tests/unit/main/shownMedia.test.ts`:
  - **Generated images only:** `requestedCaptures` keeps an image the agent generated, by bytes or saved file. It keeps no tool result's picture, viewed picture or file.
  - **Showing files:** each picture is kept in the store and each video by its file, numbered in the order named.
    - A file that is gone, is no picture or video, or is a video over 200 MiB is refused with why.
    - The same file named twice shows once.
    - A path outside the folder is allowed.
    - No handle carries a path.
  - **Through the workspace, the media tool and the coordinator:** the turn's end adds nothing. The call adds one step under the agent's title, and its 9 MiB video is read back in its two parts until the agent writes over it. The tool's answers are covered too: the count shown, files not shown and why, a call that shows nothing, a malformed call, and a thread that can't show pictures.
- `tests/integration/hostOpenCode.test.ts`: a headless host on Owl now offers its threads `sotto_delegate` and `sotto_media`; stable offers neither.
- `tests/unit/main/devinPolicy.test.ts`: Devin is allowed `sotto_media` unasked, as it is Sotto's other tools.

## Performance

Before is main at 09bb4f4ac; after is this branch, both on forge.

| | Before | After |
|---|---|---|
| Codex update, Computer Use screenshot, feature on | 16.2 µs, screenshot hashed and kept once | 14.4 µs, nothing kept |
| Codex update, `view_image`, feature on | 4.96 µs, file read once | 4.66 µs, no file read |
| Cursor update, tool screenshot, feature on | 1.63 µs, hashed and kept once | 1.14 µs, nothing kept |
| A turn's end (`writtenMediaTurnEnd`) | 5.4 ms of Git listing and stats | nothing runs; the benchmark is gone with the listing |
| Thread, no pictures: open / chunk / scroll step | 76.4 / 12.5 / 1.06 ms | 75.7 / 12.0 / 1.06 ms |
| Thread, pictures: open / chunk / scroll step | 73.2 / 11.7 / 2.43 ms | 74.8 / 11.7 / 2.39 ms |
| Thread, videos: open / chunk / scroll step | 73.6 / 11.1 / 2.02 ms | 78.3 / 12.7 / 2.06 ms |
| The owl at the easel | 0 frames off screen, 10 a second in view | the same |

The tool-update rows are `tests/perf/toolPictureCapture.perf.test.ts`; the projections are now given what the runtime gives them, `requestedCaptures`. The thread rows are `inlineMediaTranscript.perf.test.tsx`. Every count in it is the same as before: commits, reads, held pictures and video loads. Its milliseconds move both ways within run-to-run noise.

## Not proved here

- **Switching `inline-media` off on the laptop and forge before this lands:** installed builds have no switch for an Owl feature. They ignore `SOTTO_OWL_FEATURES` (`src/main/runningVersion.ts`), and the headless host takes none (`src/host/index.ts`).
- **A real agent:** no Claude Code, Codex or Cursor session was asked to show a picture. The tool's wording was not tried against a live model.
- **The full unit suite on forge:** 6 tests failed. One was the host's OpenCode test, now updated. The other five are in `claudeClientUpdates.test.ts`, which fails the same way on a clean checkout of main (#2013).
