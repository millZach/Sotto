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

Two changes. The coordinator now coalesces its broadcasts onto one run per 16 ms, so a burst of
provider frames costs one copy of the state instead of dozens; a command's own response is still the
exact state it produced. And the preload no longer revalidates the agent-state and chat-state
channels against their schemas: both carry Sotto's own state from Sotto's own main process on this
machine, and a structural guard is what that side needs.

| Stage | ms |
| --- | ---: |
| structuredClone of the state in main | 4.7 |
| Attachment preview decoration | 4.9 |
| Serialise for IPC | 11.3 |
| Deserialise in the window | 4.3 |
| Structural guard in preload | 0.0 |
| **Total per broadcast** | **25.3** |

The schema parse the guard replaced measured 51.6 ms on this run. Payload is unchanged: the
attachment preview images are still embedded, and remain the next thing worth moving.
