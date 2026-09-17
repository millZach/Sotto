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

## After (previews fetched on demand)

`get()` now publishes `preview: { available: true }` instead of the image bytes, and the window asks for one
image at a time over `agents.attachmentPreview({ threadId, messageId, attachmentId })`, caching what comes back.

| Stage | ms |
| --- | ---: |
| structuredClone of the state in main | 5.1 |
| Attachment preview decoration | 5.6 |
| Serialise for IPC | 2.6 |
| Deserialise in the window | 1.0 |
| Schema parse in preload | 2.2 |
| **Total per publish** | **16.4** |

Payload: 1,534 KB per publish, 1 KB of it attachment metadata. The 5,059 KB of image bytes is now sent once
per image instead of on every provider event.
