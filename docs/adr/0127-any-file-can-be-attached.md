# Any file can be attached

## Status

Accepted October 24, 2026, as an Owl feature (`attach-any-file`). Zach asked to attach any file and picked B, Pills, of `docs/prototypes/attach-any-file-prototype.html`; the decisions and the build are in `docs/plans/attach-any-file.md`. Amends [ADR-0031](0031-images-are-staged-once-and-carried-by-handle.md), which staged images only, and [ADR-0030](0030-screenshots-are-scaled-to-the-longest-edge-a-model-reads.md) only by name: screenshots are still scaled, files never are. Builds on [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md) (Owl features). **Number provisional until merge** (docs/agents/domain.md).

This record covers staging, the composer and remote hosts, which are built. Handing a file to each provider is the plan's second phase; until it lands, a send that carries a file is refused at the provider boundary, before the provider hears anything, and the draft keeps it.

## Context

The composer attached PNG, JPEG, GIF and WebP screenshots and nothing else. A user who wants an agent to read a PDF, a log or an archive had to save it into the thread's folder and name it by hand.

## Decision

**1. An attachment is an image or a file.** An image is one of the four raster types and keeps every rule of ADR-0030 and ADR-0031: its signature is checked, it is scaled to the screenshot bound, and a chip draws it. Anything else is an **attached file**: any well-formed MIME type (`type/subtype`, lowercase, at most 127 characters), `application/octet-stream` when the browser gives none, whose bytes Sotto never inspects. `isImageAttachment` in `src/shared/agents.ts` is the one test.

**2. Limits by kind.** An image is at most 10 MiB and the images in a set at most 20 MiB between them, as before, which keeps a Claude request under its 32 MB cap. A file is at most 25 MiB. A set holds at most 8 attachments and 50 MiB in all. The composer refuses each before it reads anything, in the plan's sentences; the schemas and the store check them again.

**3. One store, one handle.** A file is staged once and carried by handle exactly as an image is. The store keeps it as `attachments/<digest>.bin`, its MIME type in the index alone. `attachment-content` answers for images only, since a file draws no chip; a submitted preview names a file's handle for its tile and owns none of its bytes.

**4. Remote hosts take files in parts.** A file in base64 can be larger than a 16 MiB frame, so the host feature `file-staging` adds `stage-file-part`: at most 8 MiB of bytes a part, in order, each naming the upload, the file's name, type, size and digest. The host keeps one upload per client in memory, a new one replacing any other that client had under way, lets it go two minutes after its last part or when the client leaves, and checks the size and digest once the last part arrives. Images still go by `stage-attachment`. A desktop asks a host that does not list the feature to keep no file, and says to update it.

**5. Owl first.** With `attach-any-file` off, the composer, its words, its limits and every sent message are exactly as before, and main and the host refuse to stage anything but the four image types. Main and the headless host read the answer once at start; a host lists `file-staging` only on its own answer.

## Consequences

- Private file bytes live beside staged images in `attachments/` on the machine that runs the thread, under the same ownership and one-hour rule.
- A model that reads no images still takes files; only an image is refused there, by name.
- Going back to a build from before this record is not safe with a file in a draft or the queue, for the reason ADR-0031 records for images: the older build cannot read the handle. Someone who must go back sends or clears those drafts and follow-ups first.
