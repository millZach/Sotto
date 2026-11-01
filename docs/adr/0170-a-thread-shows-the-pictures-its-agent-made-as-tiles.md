# A thread shows the pictures its agent made as tiles

## Status

Accepted October 31, 2026, by Zach's picks on `docs/prototypes/inline-media-prototype.html`: B (tiles), scene 2 (the owl at the easel), an Owl feature first, and all four sources. **Number provisional until merge** (docs/agents/domain.md). The plan is `docs/plans/inline-media.md`.

Amends [ADR-0031](0031-images-are-staged-once-and-carried-by-handle.md): a second store, kept the same way, holds the pictures an agent made. Leaves [ADR-0056](0056-an-agent-can-draw-a-visual-in-its-thread.md)'s visuals as they are.

## Context

Agents look at pictures and make them. Sotto's browser and the cloud iPhone hand a screenshot back to every provider; Claude Code reads a picture file as an image; Codex and Cursor generate images; agents write screenshots, GIFs and recordings to the working copy. Until now Sotto kept only the words of a tool result and dropped every picture on purpose. A picture arrives as base64 inside the provider's message, sometimes megabytes of it, and the activity record it would ride in is copied, compared and broadcast many times a second while a thread works (`streamingCopyBudget.perf.test.ts`, `ownerScaleWorkBudget.perf.test.ts`).

Zach wants those pictures in the thread, on the desktop and the iPhone, and wants Sotto no slower for it.

## Decision

**1. Handles, never bytes.** An activity record carries an optional `media` list, at most eight handles, each the picture's digest, type, size in bytes and pixels, name and where it came from. The bytes go to the **thread media store** once, by SHA-256, as staged images do (ADR-0031). A record, a window broadcast, a saved thread and the iPhone's live updates carry the handle alone. The record's change signature counts its handles, so a record that gained a picture is sent again.

**2. The thread media store.** `<dataDir>/thread-media/`, one file per content, beside `thread-media.json`, which holds each picture's size and when it was last captured: no names, no text, no thread. It keeps the newest 1 GiB, and past that the pictures captured longest ago go first. While Keep local history is off it holds the pictures in memory alone, at most 128 MiB, as the attachment store holds staged images; turning history off lets every picture go at once. Its upkeep reads its own index, so its cost follows the number of pictures, never the length of a history. A picture that is not one of the four image types, that is not the type it claims, or that is over 10 MiB gets no handle.

The store does not track which thread captured a picture. Inside an adapter a thread is the provider's session, not Sotto's thread (ADR-0002), so a sweep that kept "what a living thread captured" would have to map sessions to threads, and a wrong answer would delete someone's pictures. A size limit lets nothing go that is still new.

**3. Captured where the adapter reads the tool result.** The adapter decodes the image content once, hashes it and puts the handle on the row it is already writing, and hands the bytes to the store, which writes them off the update path. A replayed history meets content the store already holds and writes nothing. A picture is captured only from the thread's own tool results, never from text the agent wrote.

**4. Tiles.** A turn's pictures show as 208x140 tiles under its work, whether its steps are open or folded, in threads and in Watcher. A press opens the viewer (#1059). A tile asks for its thumbnail when it comes within a screen and a half of view, and lets it go once it is further than that; the window keeps the newest 48 thumbnails between scrolls. On the desktop, main makes the thumbnail at tile size with Electron's image tools, and the window never decodes the full picture for a tile. A remote host's picture is read whole from its host, once, and its thumbnail is made by the desktop.

**5. The iPhone reads a picture when its tile shows.** `thread-media` is a new host feature and a new request of that name, answered with the picture's bytes only for a handle on a record the host holds for that thread, on the same one-at-a-time guard as a sent photo's preview. The phone makes its own thumbnail, as it does for sent photos.

**6. Owl first.** All of it sits behind the Owl feature `inline-media`. With it off, Sotto captures nothing, shows no tile and offers no command, and a record saved with handles keeps them for a build that has it.

## Generated images (part 2), October 31, 2026

**7. An image an agent generates is a step that makes an image.** Codex's `imageGeneration` item and Cursor's `cursor/generate_image` each become a tool step marked `generates: 'image'`, titled by what the image shows when the provider says. Codex's step was dropped until now; Cursor's named only the file. The marker is on the record and in the summary the iPhone is sent, so both clients know a step is making an image before any picture exists.

**8. A generated image is captured from its bytes, or from the file its provider saved.** Like the step itself, only while `inline-media` is on; stable shows Codex's image items no more than it did. Codex's finished item carries the image's base64 bytes, captured as a tool result's are, its type read from the bytes. When it carries only the file Codex saved it to, as Cursor's always does, the adapter reads that file once, off the update path, and adds the handle to the step when the read lands. The file is read only for the step the provider made, only up to the 10 MiB image limit, and is kept only if its own first bytes say it is one of the four image types, whatever its name. A Cursor path that is not absolute is read from the thread's folder.

**9. The owl at the easel plays while an image is made.** A step that makes an image, runs, and holds no picture yet shows a tile of the same size with Zach's scene 2: the owl paints on an easel under the night sky, in text, on a 12-row grid with air between its lines, so its characters stay readable in a tile. No provider says how far an image has got, so the painting slows as it goes and the picture arriving ends it. It draws nothing until it first comes on screen, then writes at most twelve frames a second straight into the page, never through React, only while it is on screen and the window is shown; off screen, hidden or once the picture lands it draws nothing and holds no timer, and under reduced motion it draws one still frame when it first shows and holds it. The iPhone plays the same scene, ported to Swift, on the same terms. `inlineMediaTranscript.perf.test.tsx` holds it to that.

## Pictures from the other tools (part 3), November 1, 2026

**10. Every provider's tool pictures, by the same rules.** Grok Build, Devin, DeepSeek Harness and Cursor hand a tool's picture back as ACP image content, captured as decision 3 says. An update that holds no more pictures than its step has handles for hashes nothing, and Cursor's replay of a thread, which comes each time its provider session opens, takes the handles the thread's step already holds. Codex's Computer Use hands its screenshots back as MCP image content (`nodeRepl.emitImage`), so they are an MCP tool's pictures, on its Computer Use step.

**11. A picture Codex viewed is read from the file it names.** Codex's `view_image` arrives as an `imageView` item that names a file and carries no bytes. With `inline-media` on it becomes a **View image** step naming the file, and once the step is done its file is read as decision 8 reads a saved image: once, a file that held no picture included, off the update path, only up to the image limit, its type from its own bytes, and only for a path Codex resolved, never one relative to Sotto's own folder. Without the feature the item stays dropped, as before.

## Consequences

- A thread's pictures cost disk, at most 1 GiB, while history is kept. Deleting a thread does not let its pictures go at once; they go as newer ones take their place, or all at once when history is turned off.
- On the iPhone this first part shows a thread's pictures; Watcher's page on the phone carries no steps yet, so Watcher's own pictures show on the desktop only.
- Pictures an agent saw that were never in a tool result (a page it read as text, a picture only in its own reasoning) still do not show.
- A generated image a provider saved outside the thread's folder is read from where the provider said it saved it, on the computer the thread runs on. Nothing else in that folder is read.
- A generation that fails or is stopped shows no tile; its step says what happened, in Codex's case why when Codex says (its usage limit).
- A Codex item that names its image only by `fileId`, Codex's own attachment store, with neither bytes nor `savedPath`, shows the step without a picture: Sotto has no documented way to read that store.
- Every later part of the plan (generated images, other providers, written files and video, mark up, callouts) adds sources and actions to these handles and tiles, not a new path for bytes.
