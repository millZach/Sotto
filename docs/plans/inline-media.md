# Inline media

Zach asked on October 31, 2026 for pictures and videos in threads and in Watcher: screenshots an agent takes or reads, images it generates, its screen recordings and GIFs, and his own attachments full size. He wants to mark any picture up and send the marked copy back as his reply, to have agents place callouts on a picture, and to watch an ASCII scene while an image is being made. Desktop, iPhone and the unfolded Duo (pen) together. ADR-0170 records the decisions; the prototype is `docs/prototypes/inline-media-prototype.html`, kept at the tag `prototype/inline-media` once the work is final.

## Zach's picks, October 31, 2026

- **B, tiles.** A turn's pictures and videos show as 208x140 tiles under its work, the size of the user's own sent images. A press opens the viewer from #1059.
- **Scene 2, the owl at the easel.** Watcher's owl paints the picture on an easel under the night sky while an image is made. Inside a tile it uses a coarser grid, so its characters stay readable.
- **An Owl feature first** (`inline-media`, ADR-0072).
- **All four sources:** Sotto's browser and cloud iPhone screenshots, Codex's and Cursor's generated images, pictures inside tool results, and image and video files an agent writes.

## Request-only, November 1, 2026

Zach changed the plan's priority on November 1: "only embed images or videos if requested ... User requests it then it happens, not the models doing it for everything." A prototype with a link needs no picture. So before part 5 lands:

- Sotto stops capturing on its own: no tiles from tool-result pictures, screenshots, viewed images or written files (parts 1, 3 and 4's sources). Images the user asked to be generated still show, with the owl at the easel.
- An agent shows a picture or video only through `sotto_media`'s `show_in_thread`, which its instructions say to call only when the user asked in this conversation. The tiles, the viewer, video playback and every performance rule below stay for what is shown.
- `inline-media` was meant to go off on both of Zach's computers until this lands, but installed builds have no switch for an Owl feature (`src/main/runningVersion.ts`), so it could not be turned off.

ADR-0170's request-only amendment records the decisions. Parts 5 and 6 follow on top of it.

## The rule that comes first

Zach: Sotto is "performing better than ever" and must not slow down. So:

- **Handles, never bytes.** A record carries a small `media` list of handles (digest, type, size, name). Bytes live in the thread media store on disk and are read only when a tile asks. No thread record, window broadcast or iPhone live update carries them.
- **Tiles load near the screen and let go far from it.** A tile asks for its thumbnail when it comes within a screen and a half of view and lets it go once it is further than that. Main makes thumbnails at tile size, so the window never decodes a full screenshot for a tile.
- **Videos never autoplay** and pause the moment they leave the screen.
- **The scene costs nothing off screen or finished.** It draws twelve text frames a second only while it is in view and the image has not landed, and holds still under reduced motion.
- **Measured.** `tests/perf/inlineMediaTranscript.perf.test.tsx` opens a 400-message thread whose 200 turns each took a screenshot, against the same thread with none, and counts what opening it, a streamed chunk and scrolling do. It runs in CI on every pull request and holds a chunk to the same commits as a thread with no pictures and no reads, opening to the near tiles' reads, and a scroll step to the one tile that came near. Its milliseconds print every run and are asserted under `SOTTO_PERF_ASSERT=1`. Part 4 adds videos to it. Every PR in this plan shows its before and after numbers.

## The pull requests

Each one ships desktop and iPhone together, behind `inline-media`.

1. **Pictures from tool results.** (Since request-only, a tool result's picture is not shown on its own; the foundation stays.) The foundation: the thread media store, `media` handles on activity records, tiles in threads and Watcher, the viewer, lazy loading, the benchmark and its guard, and the iPhone's tiles and viewer. First source: image content in a tool result. That covers Sotto's browser and the cloud iPhone for every provider, Claude Code reading a picture, and any MCP picture, on Claude Code and Codex.
2. **Generated images.** Codex's `imageGeneration` and Cursor's `generate_image`, with the owl at the easel while they run, on desktop and iPhone. The benchmark adds the scene: frames drawn off screen, in view and after the picture lands, and React commits while it plays.
3. **Tool-result pictures on the other providers.** (Since request-only, not shown on their own.) Grok Build, Devin and DeepSeek Harness (ACP image content) first (#1979). Then Codex `view_image`, Codex Computer Use and Cursor's tool results, because `view_image` names a file on disk and reads it the way part 2 reads a saved image. `tests/perf/toolPictureCapture.perf.test.ts` times an update of each, with and without a picture, and counts that a repeated update hashes nothing.
4. **Image and video files an agent writes.** (Superseded by request-only: written files are no longer looked for, and an agent shows one through `show_in_thread`.) Found through the turn's changed files; videos and GIFs play inline, never autoplaying. Zach's picks on November 1: git-ignored folders count too (never `node_modules`), and a video plays from the file it was written to, up to 200 MiB on the desktop and 50 MiB on the iPhone, rather than being copied (ADR-0170 decisions 12 to 15). `tests/perf/writtenMediaTurnEnd.perf.test.ts` timed the listing at a turn's end until request-only removed it.
5. **Mark up.** Arrow, circle, box, pen and note over any picture, desktop and iPhone, with the Duo's pen drawing and a finger moving the picture. Add to reply stages the marked copy as an attachment; the original stays.
6. **Callouts.** A Sotto thread tool lets an agent place numbered boxes with notes on a picture it showed. They are drawn on its tile and listed beside it in the viewer and the editor.

Android is not in this plan; its follow-up is #1955.
