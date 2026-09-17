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

## Shell and detail

The state above still carried every thread's history on every provider event. It is now split in two.

- **The shell** is every thread with the facts its sidebar row reads — a running turn's start, the last
  prompt and the last reply as excerpts, the message and activity counts — and none of the history behind
  them. It goes to both windows on `sotto:agents:state`, as before, and is also what `agents.get()` and a
  command's own answer return.
- **The detail** is one thread's messages and activity, on `sotto:agents:thread-detail`, sent only for the
  threads the management window has declared viewed (plus the selected thread and any with work in flight),
  and only when that thread's own history changed. `agents.threadDetail(threadId)` fetches one on demand.
  Both are coalesced per thread the way the shell is.

The window splices the detail it holds back into each arriving shell, so consumers still read one whole
`AgentState`. What is left is a thread it is looking at whose history has not arrived yet, which it draws
as `historyStatus: 'loading'`.

Measured on the same folder (5 threads, 48 messages, 283 activity records), medians of 20, three runs:

| | full state | shell alone |
| --- | ---: | ---: |
| payload | 1,534 KB | 17 KB |
| clone in main | 4.9 ms | 0.24 ms |
| preview decoration | 4.8 ms | 0 |
| serialise for IPC | 2.7 ms | 0.07 ms |
| deserialise in the window | 1.4 ms | 0.12 ms |
| structural guard in preload | 0.0 ms | 0.0 ms |
| **total per publish** | **13.8 ms** | **0.43 ms** |

Activity, not messages, was the weight: of the 1,532 KB of thread history, 1,467 KB was activity records
and 55 KB was messages. The busiest thread alone (31 messages, 202 records) is 936 KB and 2.6 ms to copy —
and that is now paid once per 16 ms for the one or two threads on screen, instead of for all five on every
provider frame. A thread nobody has open is never copied at all.

### Painting before main answers

The window keeps its newest shell in `localStorage` (at most one write every two seconds) and paints it on
the first frame after a restart, marked `stale` and reported as disconnected, until the first live shell
replaces it. Only what a row draws is kept: no transcript, no activity, no attachment bytes, no drafts and
no attention queue — attention is live state, and a restored queue would let the review speak and navigate
before main has said anything. Nothing is written at all while Keep local history is off, and the cache is
cleared when it is turned off.
