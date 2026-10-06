# A reply's first words to the window - October 6, 2026

Issue #771, part of #762. Once a provider streamed its first words, main held them behind timers before the window
could paint them. Every layer between an adapter and the window coalesces a streaming burst, and the echo of the
prompt opens each layer's window just before the reply starts, so the first words usually waited for the window's
trailing edge:

- the adapter's snapshot publisher was trailing-only: even the first streamed frame waited 16 ms;
- the workspace host's publish and the coordinator's broadcast send the first change of a burst at once, then hold a
  16 ms window;
- the IPC boundary's per-thread detail coalescer does the same with a 50 ms window, and that is the one the first
  words waited for.

Now each of those layers sends a change at once, inside an open window, when it brings a message's first words or a
new activity record: the publisher when the count of recorded messages and activity records has moved since its
last publish, the workspace when an event adds a message or a provider snapshot adds a record, the coordinator when a
thread a window is looking at ends in a message or record that window was not sent, and the IPC lane when a delta
carries a message or record it has not sent. The adapter's publisher also sends the first frame of a burst at once
now, as the others already did. Later chunks of the same message ride the windows as before.

In the window, a detail commits with the shell it holds as soon as it arrives, as a transition, which is unchanged.
The shell waiting in its own window now goes just ahead of a detail that opens a message, so the two are painted in
one commit. "The window's commit" below has both, and why an urgent commit was tried and taken back.

## First chunk to the bridge

`tests/perf/firstWordsBridge.perf.test.ts` runs main's own chain with real timers: a provider that records through
the adapters' `ThreadMessageLog` and publishes through their `ProviderSnapshotPublisher`, the `WorkspaceHost`, the
`AgentControl` coordinator with the thread observed, and `coalesceAgentThreadDetailPublishes`, whose send stands for
the window's bridge. Each trial lets every window close, publishes a prompt's echo the way an adapter does, waits a
gap, then publishes the reply's first chunk and times it to the first send that carries the reply. Fifteen trials
per gap, two runs of each version alternating, Windows 11, the development machine with another build running.
"Before" is `origin/main` at `be3e7946`, run by putting its sources back under the same benchmark.

| Gap after the echo | Before, median | After, median |
| ---: | ---: | ---: |
| 0 ms | 50.1-50.2 ms | 1.7-2.3 ms |
| 5 ms | 44.9-45.0 ms | 1.8-2.2 ms |
| 10 ms | 39.2-40.3 ms | 1.6-2.1 ms |
| 30 ms | 20.1-21.6 ms | 2.0 ms |

Before, the wait was the IPC lane's 50 ms window, opened by the echo, less the gap. After, no trial waited on a
timer: the benchmark also times how much of each trial came after the chunk's own task had returned, and that was
0 ms in every one of the 120 trials. What the 2 ms is, and the occasional slow trial (68 ms and 116 ms at most across
both runs), is work done inside the chunk's task, almost all of it the workspace writing the chunk's event to
`threads.sqlite`; a timed run of that layer put 1-5 ms in `writeEvents` on most trials and 93 ms on one. #767 owns
the writes between provider events.

Forty more chunks, 2 ms apart, became a median of 3 sends to the bridge in both versions (at most 4): later chunks
still coalesce.

## The render and state pipeline benchmarks

Run before and after, alternating, against a copy of the local data folder (165 threads, 7,504 messages, the open
thread holding 347), `SOTTO_PERF_BENCH=1` with `SOTTO_PERF_DATA`. Two runs of each:

| Benchmark | Figure | Before | After |
| --- | --- | ---: | ---: |
| `threadsRender` | ms per update | 63.0, 33.8 | 31.9, 31.4 |
| `longTranscript` | ms per update | 63.6, 45.5 | 59.8, 30.0 |
| `markdownRender` | incremental median ms per chunk | 0.99, 1.86 | 1.37, 1.02 |
| `statePipeline` | full state, ms per publish | 44.6, 60.5 | 49.4, 46.0 |
| `statePipeline` | shell alone, ms per publish | 11.8, 14.5 | 14.8, 12.5 |
| `statePipeline` | streaming delta, ms per flush | 0.07, 0.08 | 0.08, 0.09 |
| `shellDetailCommits` | commits per chunk, shell first | 1 | 1 |

No regression. The spread between runs of one version is wider than any gap between versions: the machine was
running another build throughout. The render benchmarks mount the Threads page with a mocked connection, so they
measure what a commit costs, which this change leaves alone. `shellDetailCommits`, which drives the real
connection hook, still makes one commit per streamed chunk.

## The window's commit

The issue asked for the thread on screen to commit its detail promptly without letting a long transcript make
typing lag. The render benchmarks above do not go through the connection, so this part was checked in the running
app with `tests/e2e/workspace-performance.spec.ts`, which streams into four panes over 80 and 2,000 messages of
history while sending, typing and switching panes, and holds frame and staleness budgets (100, 200 and 300 ms).

- **An urgent commit of the first words was tried and taken back.** Committing the delta that brought a new
  message or record to the active thread urgently, and everything else as a transition, missed a budget in each
  of three runs: a four-pane stream's next frame at p95 296 ms against 200, a stream's visible update gap of
  368 ms against 200, a send's next frame at 173 ms against 100. An urgent commit renders the whole Threads page
  without yielding, and each send and each finished reply in the spec made one. The window still commits a detail
  as a transition the moment it arrives, which lands within the next frames when nothing urgent is waiting.
- **The shell now goes just ahead of an opening detail.** A detail that opens a message left the IPC boundary at
  once while the shell from the same broadcast could still be waiting in its own 50 ms window, so the window
  painted twice, once for each. The desktop now delivers its held shell just before such a detail
  (`beforeOpening` on the detail lane), and the window paints them in one commit, as it does every other chunk.

Runs of this spec on one machine shared with another build vary more than any change here moves them, so the
final comparison interleaved the two builds, rebuilding between each run: four of `origin/main` (which moved
from `be3e7946` to `2e47e2d6` while they ran) and four of this branch.

| Build | Runs | Runs that missed a frame budget | Worst four-pane staleness, 2,000 messages |
| --- | ---: | ---: | ---: |
| `origin/main` | 4 | 1 (309 ms against 300) | 218-309 ms |
| this branch | 4 | 0 | 178-281 ms |

Every run of every build, `origin/main` included, failed the spec's `messageCount <= 81` check, which this change
does not touch. Serial runs of this branch before the shell pairing, done while the machine was busier, missed a
budget more often than serial runs of `origin/main` done at other times; interleaved, the difference did not hold.

## Per-chunk work in main

- **Grok** handed every live chunk to `record()`, which copied each durable message and gave the whole list to
  the message log, which looked each one up in the held window: a cost that grew with the square of the thread.
  A chunk on a reply the log already holds as its newest message, at exactly the words before the chunk, is now an
  append. `tests/perf/grokChunkAppend.perf.test.ts` times 200 chunks after the first on threads holding 10, 500 and
  2,000 messages:

  Two runs of each, 20-character chunks on a thread of 400-character messages, "before" being `grok.ts`, the message log and the publisher from `be3e7946`:

  | Messages held | Median per chunk, before | after | 200 chunks, before | after |
  | ---: | ---: | ---: | ---: | ---: |
  | 10 | 0.024-0.026 ms | 0.010-0.011 ms | 5.7-6.6 ms | 3.4-3.9 ms |
  | 500 | 0.44-0.86 ms | 0.012 ms | 123-180 ms | 2.8-3.3 ms |
  | 2,000 | 5.8-7.0 ms | 0.020-0.025 ms | 1,233-1,583 ms | 4.9-7.6 ms |

  `tests/unit/main/grokLiveAppend.test.ts` holds the shape: the four chunks after the first make no `set` or `add`
  call and four appends, at 10 and at 2,000 held messages alike. Anything else, a chunk on a reply the durable
  history says more about for instance, still goes through `record()`, whose `set` now indexes the held window once
  rather than searching it per message.
- **Claude** ran the activity merge on every frame and swapped in a new array even when nothing changed. A frame
  that changes no record now hands back the records it was given, so the workspace's merge, the pane's view and the
  detail signature, which reuse a thread's records by identity, see nothing changed.
- **Every provider**: the message log re-hashed the whole growing reply on every delta to keep its mark. The hash is
  FNV-1a, which carries on from where it stopped, so it is now kept as the reply grows and each delta hashes only
  itself. The mark is the same string it was; `tests/unit/main/threadMessageLog.test.ts` reads a re-read of a
  streamed reply against it.

## What the numbers are not

- The benchmark stops at the IPC boundary's send. The window's own frame (a shell held for its animation frame, the
  React commit) comes after it, and so does Electron's IPC.
- The provider in the benchmark is a fake that publishes through the real log and publisher; no provider CLI ran, and
  nothing was sent to a model. The time a provider takes to send its first words is not in it.
- The provider switch and the desktop host router sit between the workspace and the coordinator in the app. Neither
  holds a timer on this path.
- The socket server for remote clients uses the same detail coalescer, so a phone gets the same change; it was not
  measured separately.

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/firstWordsBridge.perf.test.ts --maxWorkers=1 --disable-console-intercept
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/grokChunkAppend.perf.test.ts --maxWorkers=1 --disable-console-intercept
SOTTO_PERF_BENCH=1 SOTTO_PERF_DATA=<folder with workspace.json> npx vitest run tests/perf/threadsRender.perf.test.tsx tests/perf/longTranscript.perf.test.tsx tests/perf/markdownRender.perf.test.tsx tests/perf/statePipeline.perf.test.ts tests/perf/shellDetailCommits.perf.test.tsx --maxWorkers=1 --disable-console-intercept
```

"Before" is the same commands with the source files this change touched taken from `be3e7946`.
