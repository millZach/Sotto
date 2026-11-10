# Videos from the iPhone

Zach asked, November 9, 2026: "Could we make it possible so I can add videos from my iPhone in the app?" This plan records his picks and the build. It amends [ADR-0131](../adr/0131-any-file-can-be-attached.md) (see its November 9 amendment).

## Decided

Two before the prototype, on cards:

- **Size: raise the cap for videos.** The original file goes, not a shrunk copy.
- **What the agent gets: just the file.** Sotto pulls no frames and makes no transcript. The agent uses ffmpeg or the like if it needs to see the video.

From `docs/prototypes/iphone-videos-prototype.html` (kept as the tag `prototype/iphone-videos`):

| Question | Pick |
|---|---|
| How a video waits in the reply box | **A · Tile.** A square tile in the photo strip: the video's first frame, its length on a badge, a remove button. While it uploads, a ring with the percentage sits on the tile, and one line beneath reads `IMG_0412.MOV · 13 MB of 84 MB · about 34 s left`. Once it is up, the line reads `IMG_0412.MOV · 0:48 · 84 MB`. |
| Limit for one video | **500 MB.** While it waits, the phone keeps a protected temporary copy of the video, deleted once it is sent or removed. The computer writes it to disk even with history off. |
| How videos count in a reply | **Their own total.** A reply's videos may hold 500 MB between them. Photos and other files keep their 50 MB. |
| Connection drops, or Sotto leaves the screen | **Carry on where it stopped.** The computer keeps the parts it has for 10 minutes, and the phone carries on from the last finished part when it reconnects or comes back. It starts again on its own, without waiting for Send. |
| Where videos are picked | **With photos.** The + menu's Photo library becomes **Photos and videos**, one system picker showing both. |
| Pressing a sent video | **Shows only.** The tile shows its frame (while the phone still has it), length and size. Pressing it says where the video is. |
| Desktop | **Same limit.** A video dropped into the desktop composer follows the same limits. A large one is staged from its path, not read into the window. |
| Owl or stable | **Under `attach-any-file`.** No new switch. |

## What a video is

An attached file whose MIME type starts with `video/` (`isVideoAttachment` in `src/shared/agents.ts`). It is still an attached file in every other way (ADR-0131 decisions 3, 5 and 7): staged once and carried by handle, copied into the working folder under `.sotto/attachments/`, and named in the note by its extension, as `(IMG_0412.MOV, MOV, 84 MB)`.

## Limits

- `AGENT_MAX_VIDEO_BYTES` = 500 MiB a video.
- `AGENT_MAX_VIDEOS_TOTAL_BYTES` = 500 MiB of videos a set.
- The 50 MiB set total (`AGENT_MAX_ATTACHMENTS_TOTAL_BYTES`) now counts images and files that are not videos.
- The 8 attachments a set holds count videos too.

Sentences (shared by the desktop and the phone):

- `VIDEO_TOO_LARGE`: "Each video must be 500 MB or smaller. Nothing was attached. Trim it, or choose a shorter one."
- `VIDEOS_TOO_LARGE_IN_TOTAL`: "Videos must total 500 MB or less. Nothing was attached. Send these first, or remove a video."

Phone only:

- Host without `video-staging`, video over 25 MB: "<computer> can’t take videos over 25 MB yet. Update Sotto there to attach this one."
- No room for the temporary copy: "This iPhone doesn’t have room to keep a copy of this video while it uploads. Nothing was attached. Free up some space, then attach it again."

## Wire: host feature `video-staging`

Protocol version stays 1. A host lists `video-staging` only where it lists `file-staging`, so only with its `attach-any-file` answer on. With it:

1. **`stage-file-part` takes videos.** A part whose `mimeType` starts with `video/` may name a `sizeBytes` up to 500 MiB and a `count` up to 63 (`HOST_VIDEO_PARTS_MAX`). Every other file keeps the 25 MiB and 4 parts limits. The part shape is unchanged.
2. **A video's parts go to disk on the host**, to `attachments/uploads/<random>.part` (mode `0o600`), hashed as they arrive. A file's parts stay in memory as before. On the last part, the size and digest are checked and the file moves into the store as `<digest>.bin`, whatever the history setting.
3. **A video upload outlives its sockets.** It is kept for 10 minutes after its last part (`VIDEO_UPLOAD_IDLE_MS`), including when every socket of its client closes. A file upload is still let go after two minutes or when its client leaves. A first part (index 0) still replaces whatever upload that client had under way.
4. **New request `file-upload-progress`**: `{ op: 'file-upload-progress', uploadId }`. It answers `{ parts: n }`, the number of parts the host holds for that upload from this client, so the next part to send is `n`, or `null` when the host holds no such upload. Then the client starts again from part 0 under a new upload ID.
5. Leftover `.part` files are removed when the host starts.

A client that sees no `video-staging` sends a video of 25 MB or less as a file, as today, and refuses a larger one with the sentence above.

## The iPhone

- **Picker.** `.photosPicker(matching: .any(of: [.images, .videos]), preferredItemEncoding: .current)`, so the original file comes without transcoding. The menu item reads **Photos and videos**. Through **Files**, a file whose type conforms to `UTType.movie` is a video too.
- **The temporary copy.** A video comes through a `Transferable` `FileRepresentation` and is moved into its own random folder under `tmp/reply-videos/`, with complete file protection and excluded from backup. Its size is checked against the limits before anything is uploaded. It is deleted when the video is removed from the box, when its reply is sent and accepted, and, for anything a crash or force quit left, at the next launch. Its bytes are never logged. The video is hashed in a streaming pass over the file and read one 8 MiB part at a time, so it is never held whole in memory.
- **Its frame and length** come from `AVURLAsset` and `AVAssetImageGenerator` (first frame, long edge about 300 points), kept in memory by digest for the sent tile.
- **Upload** goes on the per-computer large-request queue as a file's does, one part at a time, with progress counted in bytes. When the connection drops or the app goes to the background, it stops, and a part cut off on its way is sent again. When the connection is back, the phone asks `file-upload-progress` and carries on from there, or starts again at 0 when the host answers null. The 45-minute restaging rule still applies to the staged handle.
- **iCloud.** A video that has to download first shows "Getting it from iCloud · 42%" on its line. It gets ten minutes rather than two before it is refused with the photo library's "didn’t arrive in time" sentence.
- **Look (A · Tile).** In `DraftPhotoStrip`, the same size as a photo: frame, `▶︎ 0:48` badge bottom-left, remove button named "Remove <name>", and a ring with the percentage while uploading or paused. One line beneath the strip, for the video that is uploading or paused, reads `<name> · 13 MB of 84 MB · about 34 s left`, `Paused at 37% · waiting for <computer>`, or `Getting it from iCloud · 42%`. Once it is up: `<name> · 0:48 · 84 MB`. A paused upload's line is calm (muted), because nothing was lost.
- **Sent.** A tile above the words with the frame while the phone has it, a film symbol on a plain tile otherwise, and the length (or size) badge. Pressing it shows: "This video is on <computer>, in the thread’s working folder under .sotto/attachments."

## The desktop

- The composer refuses a video over 500 MB, or videos over 500 MB together, before reading anything, in the sentences above.
- A video over 25 MiB is staged from its path. The preload resolves the dropped or chosen `File` with `webUtils.getPathForFile`, and main streams it into the store (`stageFile`) with no copy in the window. A smaller video, or one with no path, such as a pasted one, goes by bytes as files do today.
- For a thread on a remote host, the desktop sends the video from its path in 8 MiB parts, and only to a host that lists `video-staging`.
- The composer draws a video as the file pill it draws today.

## Main and the store

- `AttachmentStore.stageFile({ name, mimeType, path, sizeBytes?, digest?, move? })` hashes a file by streaming it when no digest is given, checks the limits, and moves or copies it into the store as `<digest>.bin`, on disk whatever the history setting.
- `PromptImage` gains `path?()`, the store's file. `saveAttachedFiles` streams a file that has one into the working folder (`wx`, `0o644`, hashed as it copies) rather than reading it whole. A PDF still goes by bytes for its native block.

## Not in this build

- Share to Sotto and paste keep the 25 MB file limit for videos (follow-up).
- Android attaches nothing yet (ADR-0059's port).
- Playing a sent video on the phone. Zach picked **Shows only**.
