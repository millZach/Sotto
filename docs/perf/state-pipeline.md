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

### An unchanged model catalog

The shell still carried a host's whole model catalog on every publish even when nothing in it had
changed — on the owner's 608-model catalog, most of the shell's weight and about 4 ms of the window's read.
ADR-0027 has the coalesced broadcast omit a catalog a window was already sent, tagged with a revision so
the window can tell an omission from an empty list and recover with `agents.get()` if it is missing what a
broadcast names. `AGENT_GET` and a command's own answer are unaffected: both still return the catalog in
full, because they are that recovery path. Measured on the same owner catalog (`node:v8`'s `serialize`, which
approximates what Electron's structured clone puts on the wire): an unchanged repeat fell from 649 KB to
1.1 KB, and detecting "unchanged" costs about 0.5 ms per publish across both windows.

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

### Streaming deltas

The detail above was still the whole thread on every flush: the busiest one, 936 KB, copied, serialised and
taken apart again every 16 ms for as long as an agent streamed into it. Once a window holds a revision, what
follows it is the difference.

- Main keeps, per detail target, the history that window was last sent and the revision that stands for it,
  and diffs the next one against it. A message that grew by a suffix is that suffix (`{ id, appendText }`);
  a message that changed some other way, or a new one, is the message; an activity record is the record as
  it now stands, or its id and `removed`. Anything no delta can say — a message removed or reordered, a
  record that would land in the wrong place — falls back to the whole detail, as does first delivery and
  every answer to `agents.threadDetail`. The snapshots are bounded by the detail targets: a thread that
  leaves the viewed set frees its snapshot on the next broadcast.
- The window applies a delta only when its `baseRevision` is the revision it holds, and asks for the whole
  detail when it is not. Answering that request also resets what main measures from, so the two cannot
  drift apart. Only the message that changed becomes a new object, so the structural sharing behind the
  render still sees every other message as the same one.
- Because the diff is taken once, at the end of the coalescing window, rather than as each provider event
  lands, five updates to one activity record inside a window are one delta and several appends to one
  message are one append.

Same folder and the same busiest thread (31 messages, 202 activity records), one 40-character append,
medians of 20, three runs:

| | full detail per flush | streaming delta |
| --- | ---: | ---: |
| payload | 936 KB | 213 bytes |
| produce in main | 2.5 ms (clone) | 0.4 ms (diff) |
| serialise for IPC | 1.2 ms | 0.01 ms |
| deserialise in the window | 0.6 ms | 0 ms |
| apply in the window | — | 0.03 ms |
| **total per flush** | **4.4 ms** | **0.44 ms** |

The delta is measured against the whole activity of the thread every time — the diff walks 202 records and
31 messages to find the one chunk that moved — which is the 0.4 ms, and it replaces a 936 KB copy.

### Painting before main answers

The window keeps its newest shell in `localStorage` (at most one write every two seconds) and paints it on
the first frame after a restart, marked `stale` and reported as disconnected, until the first live shell
replaces it. Only what a row draws is kept: no transcript, no activity, no attachment bytes, no drafts and
no attention queue — attention is live state, and a restored queue would let the review speak and navigate
before main has said anything. Nothing is written at all while Keep local history is off, and the cache is
cleared when it is turned off.

## A flood from one adapter

The coalescing above lives in the coordinator. Below it, `WorkspaceHost` still copied the whole workspace
and queued a `workspace.json` write for every publish any adapter made, so one chatty provider set the cost
for everything. Measured with `npx vitest run tests/unit/main/workspacePublishCoalescing.test.ts`: a fake
adapter emits 2,000 snapshots over about 100 ms, yielding to the event loop every 20, and the test counts
the host's publishes (one copy of the workspace each) and the store's writes. Three runs, Windows 11.

| | before | after |
| --- | ---: | ---: |
| workspace copies | 2,000 | 10-13 |
| `workspace.json` writes | 48-53 | 1 |

Provider publishes are now gathered into a 16 ms window and provider writes into a 250 ms one; the first
publish of a burst still goes out at once, so a reply appearing is as immediate as it was. The fixture
workspace is small, so each copy costs about 13 us here; on the folder measured above, where one copy is
4.5 ms, the same burst is the difference between roughly 9 s of copying and 60 ms.

The counts in the table are the burst at its measured length. On a loaded CI runner the same burst has taken
long enough for the 250 ms write window to fire forty times, so the test asserts the shape on every run (at
most one publish per 16 ms window and one write per 250 ms window of the time the burst actually took) and
the absolute counts only under `SOTTO_PERF_ASSERT=1`, as `docs/ci.md` describes for stopwatch budgets.

The runner also showed a second cost the first measurement missed: a state dirtied again during a slow write
was written again as soon as that write finished, so a flood over a slow disk became a run of back-to-back
writes with no window between them. A write in flight is now followed at once only for a caller who asked
for the state to be on disk; a provider that kept publishing during it waits for the next window.

A user command is unchanged: it writes through `flush()`, which takes over any waiting provider write, and
publishes directly, so the command still returns after its own write.
