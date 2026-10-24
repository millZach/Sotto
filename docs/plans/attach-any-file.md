# Attach any file

The composer attaches PNG, JPEG, GIF and WebP screenshots only. Zach asked to attach any file (October 24, 2026). This plan records the decisions and the build. The decision itself goes in ADR-0127, which amends ADR-0031.

## Decisions (Zach, October 24, 2026)

From the prototype `docs/prototypes/attach-any-file-prototype.html` (kept as the tag `prototype/attach-any-file`):

- **Look: B, Pills.** Screenshots stay 88 px tiles in their own row. Every other file is a one-line pill below them: a type icon, the name cut in the middle so the extension stays visible, the size, and a remove button named "Remove <name>". In a sent message, images come first as today, then each file as today's file tile (`rich-attachment--file`) with an icon for its type and "PDF · 2.4 MB". "No preview for this file type" goes: a file never has a preview.
- **Delivery: native where possible.** Images go as image parts, as today. Every other file is copied into the thread's working folder and its path is named in the prompt, which reaches every provider. PDFs also go natively to Claude, as `document` blocks, and to OpenCode, as `file` parts when the model's catalog lists PDF input. A real Claude Code 2.1.310 run on October 24, 2026 read a base64 PDF `document` block sent over `--input-format stream-json`.
- **Limits: 25 MB a file, 50 MB in all, 8 attachments.** Images keep their own limits: 10 MB each and 20 MB between them, which keeps a Claude request under its 32 MB cap.
- **Owl first.** The Owl feature `attach-any-file` (ADR-0072). With it off, everything is exactly as today: same accept list, same sentences, same limits, and main refuses to stage anything that is not one of the four image types.

## Provider facts (research, October 24, 2026)

| Provider | Images | PDFs | Other files |
|---|---|---|---|
| Claude Code (stream-json) | `image` block | `document` block (base64), when it fits; also by path | by path |
| Codex app-server | `image` (data URL) | by path (no file input type exists) | by path |
| OpenCode | `file` part (data URL) | `file` part when the model lists `pdf` input; also by path | by path |
| Grok (ACP) | refused (no image support) | by path | by path |
| Devin (ACP) | refused (no image support) | by path | by path |
| Muse | `image` part | by path | by path |

Anthropic API: a request is at most 32 MB and a PDF at most 100 pages under a 200K context. A PDF goes by path only when Sotto cannot read its page count, when it has more than 100 pages, or when it would push a message's native bytes (images and PDFs together) past 20 MB. A `document` block that fails stays in Claude's session history and would fail every later turn, so the check is conservative: count pages from the PDF's uncompressed page tree (`/Type /Page` objects, or the root `/Count`), and when the count cannot be read, send by path only.

## How a file reaches the agent

`src/main/agents/attachedFiles.ts`, at the protocol boundary, where adapters already read staged images (ADR-0031):

- **Where.** `<working folder>/.sotto/attachments/<first 12 hex of digest>/<safe name>`, beside the terminal's `.sotto/clipboard/`. `.sotto/attachments/.gitignore` holds `*`, written once with `wx`, so Git ignores the folder and nothing in the user's own files changes.
- **Safe name.** The base name only: path separators, control and bidi characters, `<>:"/\|?*` and whitespace runs become `-`, with leading dots, trailing dots and spaces trimmed, and Windows device names (`CON`, `NUL`, `COM1`...) prefixed with `_`. At most 120 characters, keeping the extension. An empty result becomes `file`. It never contains a space, so it can be named as an `@path` token.
- **No traversal, no following links.** Every folder from `.sotto` down is checked with `lstat`, and anything that is a symbolic link, a junction or not a directory is refused. The file is written with `wx`. When it already exists, its content digest must match, or the send is refused rather than overwriting. The file mode is `0o644`, so nothing is made executable, and Sotto never opens or runs it.
- **The note.** Non-image files are named in a block the adapters add to the text the provider receives, apart from the user's own words:

  ```
  <sotto-attached-files>
  The user attached these files. They are saved in this working folder:
  - .sotto/attachments/3f2a9c1e0b7d/quarterly-report.pdf (quarterly-report.pdf, PDF, 2.4 MB)
  </sotto-attached-files>
  ```

  `stripAttachedFilesNote` removes it wherever an adapter reads a user message back from the provider's own history, so the thread shows only what the user wrote. An origin's digest is taken on the text without the note.
- **Who may.** A thread with no working folder refuses files: "This thread has no working folder, so files cannot be attached. Remove them, then send again. Your draft is saved." A model without image support refuses images only (today's rule), naming the image.
- **Privacy.** Names, paths and bytes never reach a log. The copy stays in the working folder until the user removes it, as `.sotto/clipboard/` does. The README's "Privacy and cost" says so.

## Staging

- `src/shared/agents.ts`: handles and stage requests take any well-formed MIME type (`type/subtype`, lowercase, at most 127 characters). A name the browser gives no type gets `application/octet-stream`. An attachment is an image when its type is one of the four. An image's bytes must carry that type's signature, as today; a file's bytes are not inspected. `sizeBytes` is at most 10 MiB for an image and 25 MiB for a file. A set holds at most 8, images total at most 20 MiB, and everything totals at most 50 MiB.
- `AttachmentStore` keeps a file as `attachments/<digest>.bin`, with its MIME type in the index. `attachment-content` answers for images only, since a chip draws no file. Previews never hold file bytes; a sent file's tile shows its name, type and size from the reference.
- **Remote hosts.** A file can be larger than a 16 MiB socket frame once it is in base64, so files go in parts. The new host feature `file-staging` adds the request `stage-file-part`: an upload ID, the part's index, the part count, the name, MIME type, total size and digest, and at most 8 MiB of base64 data. The host keeps one upload per client in memory, drops it after two minutes without a part or when the client leaves, checks the size and digest once the last part arrives, then stages the file. A host without the feature refuses files with "This host cannot keep files yet. Update Sotto there, then attach them again. Nothing was attached." Images still use `stage-attachment`. A headless host lists `file-staging` only when its own Owl answer for `attach-any-file` is on.
- **iPhone.** Out of scope for attaching. A sent file in a thread shows its name with a document symbol instead of the photo symbol.

## Composer

`ScreenshotInput.tsx` with the feature on:

- No `accept` filter. The picker's label is "Files to attach", the button is "Attach files", the list is "Attached files", and the status is "Adding files...".
- Picker, paste and drop take any file. Images still go through `prepareScreenshot` (ADR-0030).
- Drag-over shows a quiet dashed outline from a theme token, with "Drop to attach".
- Refusals, decided before anything is read:
  - "Attach up to 8 files at a time. Nothing was attached."
  - "Each file must be 25 MB or smaller. Nothing was attached. Choose a smaller file."
  - "Each image must be 10 MB or smaller. Nothing was attached. Choose a smaller image."
  - "Images must total 20 MB or less. Nothing was attached. Remove an image or choose smaller ones."
  - "Attachments must total 50 MB or less. Nothing was attached. Remove a file or choose smaller ones."
  - "This model does not read images. Choose a model with image support, or remove <name>."
- With the feature off, everything is exactly as today.

New words go through the Lingui catalogs, as `OwnModelServers.tsx` does.

## Tests

- **Unit.** The schemas (any MIME, per-kind limits, totals); the store (files kept as `.bin`, content for images only, sweep); `attachedFiles` (safe names, traversal and Windows device names, a symbolic link or junction at each level, an existing file with the same or a different digest, `.gitignore`, the note and stripping it); PDF page counting; `ScreenshotInput` for picker, paste and drop with files, mixed sets, every refusal, the gate off; the sent-message file tile; host chunked staging (order, a missing part, a digest mismatch, the two-minute drop, one upload per client).
- **Integration.** `tests/integration/adapterContract.ts` sends a staged file through every adapter. The fake provider sees the note, or the native PDF part where one is due, and the file sits in the working folder with its exact bytes. The thread shows the user's text without the note, after a reload too. `hostServiceContract.ts` stages a 20 MiB file over the socket.
- **e2e.** The Threads spec that covers screenshots attaches a PDF and a text file and sends them.

## Documents

ADR-0127 (amends ADR-0031, and ADR-0030 only by name); `CONTEXT.md` (**attached file**, beside **staged image**); `README.md` "Privacy and cost" (the copy in `.sotto/attachments/`, and PDFs sent to Claude and OpenCode); `docs/guide.md` (attaching); the Owl entry in `src/shared/owlFeatures.ts`.
