# Threads render cost

What the window re-renders when one agent state update arrives. Measured with

```
npx vitest run tests/perf/threadsRender.perf.test.tsx --disable-console-intercept
```

over a copy of the local Sotto data folder (5 threads, 48 messages, the open thread running and holding 31),
with the Threads page mounted and one thread open. Each update is a whole new state object off the wire with
one more streaming chunk appended to the open thread's newest reply — what arrives many times a second while
an agent works. Ten warm-up updates, then the median of twenty, Windows 11, jsdom, dev build.

`msPerUpdate` is the median wall time from receiving the state to the commit being painted; it includes what
the receive path does to the arrival. `reactMsPerUpdate` is React's own `actualDuration` for the committed
tree, averaged over the twenty.

## Before and after

Three runs of each, alternating, on a busy machine — the run-to-run spread is wide, so the medians below say
more than any single number.

| | before | after |
| --- | ---: | ---: |
| ms per update | 47 (29–51) | 23 (19–28) |
| React ms per update | 30 (27–36) | 17 (15–22) |
| Commits per update | 1 | 1 |
| Message articles re-rendered per update | every drawn message | 1 |

Before, `setSnapshot` replaced the whole state object, so `ThreadsView` re-derived its rows and organization,
every sidebar row re-rendered, and every message and activity group in the open pane was rebuilt for one
changed character.

After, the receive path shares the structure of the arriving state, the facts derived from it (rows, project
folders, pane labels, activity placement, the split into turns) are shared in turn, and the leaves are
memoised. One chunk now re-renders the turn it landed in and the one message inside it.

## What is left

A profile of the pane (`Profiler` around its header, transcript and composer) puts almost all of the remaining
cost in the transcript, and inside it in the message that actually changed: re-parsing the Markdown block
being written. The header is about 0.4 ms per update, so it was left alone rather than memoised. The composer
area is about 6 ms per update and is the next place to look.

## Two messages, one commit

The table above was measured with one whole state per update. Since the shell and detail split
(`state-pipeline.md`), a streamed chunk reaches the window as two IPC messages, the shell and then the
open thread's detail delta, and for the first 2,000 characters of a reply the shell changes on every
chunk too, because the sidebar's excerpt is still growing. `tests/perf/shellDetailCommits.perf.test.tsx`
drives `useAgentConnection` with a fake bridge and counts renders per chunk:

| Arrival order | Commits per chunk, before | after |
| --- | ---: | ---: |
| shell, then detail | 2 | 1 |
| detail, then shell (not the order main sends) | 2 | 2 |

Main sends the shell first, so the second row is the fixture's order rather than the app's. Each chunk's
frame finishes before the next chunk begins; a detail-first pair still costs two commits.
Swapping the order main sends in would not have helped: each message changed something and each was
committed. Instead the window holds a shell for one animation frame when it has a detail channel. A
detail arriving inside that frame commits together with the held shell; a shell nothing follows commits
in the frame it would have painted in; a second shell inside the frame commits the first, so nothing
main publishes is skipped. Command responses, the first `get()` and the cached shell stay immediate,
which is what the 100 ms feedback budgets in `docs/ci.md` measure. The widget has no detail channel and
is unchanged.

Hidden main windows commit shell updates immediately, because Electron can suspend their animation frames.
Hiding the window also flushes a shell already waiting for its frame. Widget microphone commands therefore
still reach the main renderer's voice controller while the main window is hidden. Visible windows keep
the shell-first batching measured above.
