# State pipeline cost

What one published agent state costs on the way from main to the window. Measured with
`npx vitest run tests/perf/statePipeline.perf.test.ts` over a copy of the local Sotto data folder
(5 threads, 48 messages, 5 image attachments). Medians of 20 runs, Windows 11, dev build.

Every provider event publishes, including streaming chunks, so this cost is paid many times per second while an agent works.

## Before (main at 4b51e8e)

| Stage | ms |
| --- | ---: |
| structuredClone of the state in main | 5.3 |
| Attachment preview decoration | 5.7 |
| Serialise for IPC | 12.4 |
| Deserialise in the window | 5.3 |
| Schema parse in preload | 67.1 |
| **Total per publish** | **95.7** |

Payload: 6,593 KB per publish, of which 5,060 KB is embedded attachment preview images.

## After

Three changes to the pipeline itself.

- **Previews leave the state.** `get()` publishes `preview: { available: true }` instead of the image bytes, and the
  window asks for one image at a time over `agents.attachmentPreview({ threadId, messageId, attachmentId })`,
  caching what comes back. The image bytes are sent once per image instead of on every provider event.
- **Broadcasts coalesce inside the coordinator.** A burst of provider frames costs one copy of the state per 16 ms
  instead of one per frame, ahead of the existing 50 ms coalescer at the IPC boundary. A command's own response is
  still the exact state it produced.
- **No schema parse on the state channels.** The preload no longer revalidates the agent-state and chat-state
  channels; both carry Sotto's own state from Sotto's own main process, and a structural guard is what that side needs.

Measured on the merged branch:

| Stage | ms |
| --- | ---: |
| structuredClone of the state in main | 4.5 |
| Attachment preview decoration | 4.5 |
| Serialise for IPC | 2.6 |
| Deserialise in the window | 0.9 |
| Structural guard in preload | 0.0 |
| **Total per publish** | **12.6** |

Payload: 1,534 KB per publish, 1 KB of it attachment metadata. The clone and decoration are now paid once per
16 ms window rather than once per provider event, so a streaming burst costs a fraction of even this.

What the window then does with an update is measured separately in `threads-render.md`: 47 ms before, 23 ms after.
