# Pictures and videos an agent writes (inline media, part 4)

November 1, 2026. Forge (Linux), built app on its X display; not installed or released. ADR-0170 decisions 12 to 15.

## What was proved in the running app

`tests/e2e/inline-media-written.spec.ts` drives the built app over the fake Codex app server:

- The thread works in a Git project that ignores `test-results/`.
- During the turn the agent writes `test-results/signup/last-step.png` and `test-results/signup/flow.webm`, a 3-second, 320×200 VP9 recording from `tests/fixtures/media/recording.webm`.
- When the turn ends, the turn shows **Picture 1** (PNG · 1920×1203) and **Video 1** (WebM · 25 KB) under the step **Pictures and videos it wrote**.
- The video's first frame came through `sotto-media:`: `readyState` 2 or more, `videoWidth` 320. It stayed paused at `currentTime` 0 for half a second, so it does not play on its own.
- After **Play video 1** was pressed, it played past 0.3 s from its file.
- Scrolled to the top of the thread, it was paused.
- At 820×560 the pane does not scroll sideways.

Captures in `artifacts/inline-media/`:
- `written-1280-dark.png`: before play, with the play button.
- `written-playing-1280-dark.png`: playing, with the player's controls.
- `written-1280-light.png`.
- `written-820-light.png`: the minimum.

The two existing inline media specs (`inline-media.spec.ts` and `inline-media-generated.spec.ts`) passed in the same run.

## What was proved below the app

- `tests/unit/main/writtenMedia.test.ts`, over a real Git working copy:
  - **Listing:**
    - Changed and new files are listed, git-ignored ones included.
    - Files in `node_modules` and committed files that haven't changed are not.
    - A folder that is not a Git working copy lists nothing.
  - **Choosing:** files changed since the turn began are kept, newest first, at most eight.
  - **Videos:**
    - A video is recognised by its own bytes, and its handle carries the digest of the whole file.
    - It is read back only while the file is unchanged; written again, it is no longer read.
  - **Through the workspace and coordinator:** a send starts a turn, the agent writes a screenshot and a 9 MiB recording, and the turn's end adds the step. Its two 8 MiB parts rebuild the recording, and once the agent writes over it no part is answered.
- `tests/unit/main/threadMediaScheme.test.ts`: the `sotto-media:` answers.
  - Each range is answered from the part that holds its start.
  - A request with no range gets the start.
  - Anything else is not found or out of range.
- `tests/unit/renderer/threadMediaTiles.test.tsx`:
  - A video tile never plays until pressed, and pauses when it leaves the screen.
  - A failed video says it could not play.
  - A GIF stays still until played, and stops off screen.
- `tests/integration/socketThreadMedia.test.ts`: a host lists `thread-media-video` only with `inline-media` on, and answers no part for a handle no record names.
- `apps/ios/Tests/SottoCoreTests/AgentVideoTests.swift` (macOS CI only): a video is put together part by part into a file, and the file is removed when the parts are not the video named.
- **No path in a record:**
  - A video's handle carries no path.
  - The thread media store remembers its file by digest, keeps it across a restart, and forgets it when history is turned off.
  - Staged changes count as written.

## Before and after

Forge, the benchmark runs interleaved between this branch and `main`'s sources at c2fc1abee.

- `tests/perf/inlineMediaTranscript.perf.test.tsx`: no media and pictures stay within the spread between runs on both sides. The window's tile code changed, so this is the comparison that matters. Values below are the range over two runs on each side.

  | | `main` | Branch |
  | --- | --- | --- |
  | Mount, no media | 74.7 / 81.6 ms | 73.6 / 74.9 ms |
  | Mount, pictures | 71.2 / 72.4 ms | 72.0 / 76.1 ms |
  | Chunk, React, pictures | 7.6 / 8.0 ms | 6.9 / 8.2 ms |
  | Scroll step, pictures | 2.38 / 2.45 ms | 2.45 / 2.50 ms |

  - **The new thread with a video in every turn, on the branch:**
    - A chunk commits 20 times in 20, as without media.
    - Nothing plays on its own.
    - No picture reads.
    - Opening gives 6 players a source, and each scroll step gives one more.
    - At most 6 sources are held near the screen.
  - **The same handles on `main`:** they show as pictures that cannot load.
- `tests/perf/writtenMediaTurnEnd.perf.test.ts`: the listing at a turn's end, once a turn, in Git's own process.
  - About 5 ms in its folder: 300 committed pictures, a `node_modules` of 3,000 files and 40 ignored screenshots.
  - About 20 ms in this repository, with its 1.2 GB `node_modules`, which Git never enters.
  - Before this part, a turn's end did nothing.

## Not proved

- **The iPhone's video and GIF tiles:** they compile only in CI; this note's tests cover the video download, not the views.
- **A remote host's video played on the desktop:** it goes through the same `thread-media-part` request the socket test reaches, but no remote host with a written video was driven.
- **macOS and Windows:** the e2e ran on Linux only.
