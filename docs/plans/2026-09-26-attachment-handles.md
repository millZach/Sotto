# Stage images once and carry a handle

Issue #320. Branch: `perf/attachment-handles`. Decision: [ADR-0031](../adr/0031-images-are-staged-once-and-carried-by-handle.md).

## What was asked

An image's base64 data URL travelled with every draft save, every shell broadcast to the main window and the widget, every write of `agents.json`, and every send (as a rewrite of the whole preview file). The issue asks for one attachment module owned by main that stages bytes once and hands back a handle, keeps one file per attachment with a small index, retains content while something owns it, and resolves bytes only for restore, preview and provider submission. Remote hosts stage on the host that runs the provider. With history off, staged draft bytes stay in memory.

## Where the code has moved since the issue

- `threadDraftStore.ts:316` is still the debounced save; the line is unchanged.
- `control.ts:403` is now `shell()` at line 425, and it also hashes every draft (`draftSignatures`) for the save-state evidence it publishes. `persist()` is at line 567.
- `index.ts:685` is now the `agentStatePublisher` at line 672, which sends the shell to both windows through `AgentStateBroadcaster` (ADR-0028). The catalog omission does not touch drafts.
- `attachmentPreviews.ts` no longer blocks the send (#316); it still rewrites one file of up to 100 MiB.

## Steps

1. **Shared shapes** (`src/shared/agents.ts`). `agentAttachmentHandleSchema` (`id`, `name`, `mimeType`, `sizeBytes`, `digest`) and its list schema with the eight-image and 20 MiB rules; drafts, follow-ups, the coordinator's draft and every command that carried `agentAttachmentsSchema` take handles. The inline schema stays for old files and previews. A byte-level signature check joins the data URL one.
2. **The store** (`src/main/agents/attachmentStore.ts`). `stage`, `verify`, `read`, `sweep(owned)`, `load`. Content files are `attachments/<digest>.<ext>`; the index is `attachments/index.json`. Memory-only mode while history is off. Unit tests: stage writes the file before answering; same bytes stored once; a bad signature or size is refused; sweep keeps owned content, keeps unowned content for the hour and removes it after; load removes temporary files and anything that is not content, takes a content file the index does not name back into it as unowned, and drops an index entry whose file is gone; history off writes nothing.
3. **Previews** (`attachmentPreviews.ts`). Entries hold handles, version 2, `preview()` reads through the store. Conversion of version 1. Existing tests move to the new shape.
4. **Coordinator** (`control.ts`, `followups.ts`). Verify handles on every command that carries them; outbox send and steer entries record their digests; owners are drafts, follow-ups, outbox entries and previews; sweep at start, with the 30-second upkeep, and at once for previews when history goes off. Conversion of inline images in `agents.json` and `followups.json` at start; drafts and follow-ups whose content is gone lose it at start, and such a follow-up is paused with a sentence that says why. `stageAttachment` and `attachmentContent` on the control and `LocalHostService`.
5. **Adapter boundary** (`host.ts`, `threadOptions.ts`, `claude.ts`, `codex.ts`, `grok.ts`, `devin.ts`, `e2e/agentEffects.ts`). `PromptImage` = handle and `read()`. Dispatch builds them from the store. The contract test sends one through every adapter.
6. **Wire.** IPC channels `sotto:agents:stage-attachment` and `sotto:agents:attachment-content` (the main window and the widget, both of which have a composer; ADR-0031), the preload bridge, the router picking the host from the thread key, host feature `attachment-staging` with `stage-attachment` and `attachment-content`, the socket client, `docs/host-protocol.md`.
7. **Window.** `stagedImages.ts`: stage a blob (the seam #321's resize runs in front of), keep a bounded thumbnail per digest, fetch content for a chip it has no copy of. `ScreenshotInput`, the thread composer, the coordinator's composer and browser feedback stage before they edit the draft.
8. **Evidence.** `tests/perf/attachmentHandles.perf.test.ts` counts bytes per draft save, per shell and per persist with an 8 MiB screenshot (asserted, in the default run) and times them under `SOTTO_PERF_BENCH=1`. Note in `docs/perf/2026-09-26-attachment-handles.md`, before and after against `origin/main`.
9. **Docs.** `CONTEXT.md` (**Staged image**, the Draft entry), `README.md` "Privacy and cost", `docs/guide.md`, `docs/agent-control.md`, `docs/host-protocol.md`, `docs/ci.md`'s perf paragraph.

## Acceptance, and the test that shows each

- A text-only draft save carries no image bytes over IPC: `threadDraftStore` test on the command it sends, and the perf test's byte count.
- A shell broadcast during streaming carries no image bytes on either window: coordinator test on `shell()` and the published state while a draft holds an image; perf test.
- A send with an image resolves the same digest, including after a restart and a retry: coordinator test that stages, saves, restarts a new `AgentControl` on the same folder, queues and resumes a follow-up, and checks the bytes the host received hash to the digest.
- Refusal, cancel and clear release content under the rules, and a crash between stage and draft save leaves no orphan the index cannot find: store tests with an injected clock, and a coordinator test that stages without saving, restarts and sweeps.
- `adapterContract.ts` sends a staged image through every adapter.

## Out of scope

Downscaling before staging is #321. Showing a pending message's thumbnail in the transcript, and moving memory-only content to disk when history is turned back on, are not asked for.
