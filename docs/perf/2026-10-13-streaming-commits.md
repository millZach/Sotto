# Committing streamed history - October 13, 2026

Issue #991, step 1 of the October 12 audit's sequence. While threads streamed, the workspace committed
each streaming thread's events in its own fsynced transaction on every 16 ms publish window, and every
streamed chunk was its own event row. This note measures that storage cost with 1, 3 and 6 threads
streaming, before and after committing one transaction per window and moving streamed text appends to
the 250 ms write window.

## How it was measured

`tests/perf/streamingCommits.perf.test.ts` runs one event-sourced adapter built like the native ones
(their message log and snapshot publisher) into the workspace host over a real `threads.sqlite`, with a
coordinator-style activity subscription so each publish applies events and reads windows back as the app
does. It streams one chunk per thread per 16 ms window for 100 windows, three rounds, into 1, 3 and then
6 watched threads, and reports medians: main's CPU per chunk, event-loop active time per window, the
time the thread store's commit calls took per window and how many there were, and how many
`message-text-appended` rows each chunk wrote. Each round asserts the stored text is whole. Every
payload is generated in the test; no user profile is opened and nothing a thread "said" is printed.

"Before" is `origin/main` at `32f8e477a`; "after" is this change. Taken on the Windows development
machine (Node v24.14.1) with other sessions running beside the benchmark, so read the times as
proportions rather than budgets; fsync tails are especially noisy. Two runs of "after" are given.

## Results

| Streaming threads | | Before | After (two runs) |
| ---: | --- | ---: | ---: |
| 1 | Commits per window | 1 | 0.06, 0.06 |
| | Commit time per window | 3.05 ms | 0.28, 0.63 ms |
| | Main CPU per chunk | 1.25 ms | 0.47, 0.62 ms |
| | Event-loop active per window | 3.85 ms | 1.01, 1.14 ms |
| 3 | Commits per window | 3 | 0.06, 0.06 |
| | Commit time per window | 5.14 ms | 0.29, 1.30 ms |
| | Main CPU per chunk | 0.99 ms | 0.16, 0.26 ms |
| | Event-loop active per window | 6.22 ms | 0.94, 1.93 ms |
| 6 | Commits per window | 6 | 0.06, 0.06 |
| | Commit time per window | 15.47 ms | 0.29, 0.76 ms |
| | Main CPU per chunk | 0.73 ms | 0.16, 0.24 ms |
| | Event-loop active per window | 16.65 ms | 1.15, 1.80 ms |
| any | Append rows per chunk | 1 | 0.07, 0.07 |

Before, commits per window were the streaming-thread count itself, and at six threads the commit time
alone overran the 16 ms window. After, a window costs about one commit every 250 ms whatever is
streaming (0.06 per 16 ms window), so the commit cost no longer grows with the number of streaming
threads, and a reply's appends over one write window fold into one event: about fourteen times fewer
append rows for the same words.

All of it sits behind the Owl switch as the `streaming-publish-cost` feature until Zach sends it to
stable (ADR-0072); the benchmark and the tests below run with it on, and one case pins stable's
unchanged behaviour with it off.

## What changed

- **One transaction per publish window.** `ThreadStore.appendBatches` writes every thread's due events
  in a single `BEGIN IMMEDIATE … COMMIT`, a savepoint per thread. A batch that fails rolls its own
  savepoint back, is named as failed, and stays waiting for the existing paced retry (#378); the other
  threads in the same window commit.
- **Appends commit on the write window.** At a publish, the workspace writes each thread's events up to
  its last non-append; trailing `message-text-appended` events wait for the 250 ms flush, consecutive
  ones to a message folding into a single event (`foldAppends`). A failed thread's batch remains one
  retry unit, appends included.
- **The pane reads over the wait.** The stored window a pane is given has the waiting appends laid over
  it, and so do the sidebar's excerpts, so display cadence is unchanged. Anything that reads the store
  itself (`eventsAfter`, message identities, one stored message, anchoring a visual, `flush()`,
  shutdown) commits the waiting appends first, so phones, remote clients and adapters read only
  committed events, as before.
- **A cursor waits for the flush.** The history source gains `flushEvents(threadId)`. Claude's alias
  write — the one place its transcript cursor reaches disk — asks for that flush first for every
  advanced cursor, and writes a cursor as it last was saved while the store cannot take the words, so
  no saved cursor ever passes uncommitted text (ADR-0016, October 13 amendment).

## What did not change

- WAL with `synchronous=FULL`; every committed event keeps its durability.
- What the window, phones and stores receive: the same messages, summaries, shells and event stream,
  with a run of appends inside one write window arriving as one append of the same words.
- The legacy snapshot path (`record()`), activity saves, and every other store keep their cadence.
  `syncActivities` still commits per thread on the 250 ms flush; it was not part of this step's
  per-publish cost.

## Tests

- `tests/unit/main/threadStore.test.ts`: several threads commit in one `appendBatches` call; a batch
  the log refuses rolls back alone, ahead-of-failure events included, and can be retried whole.
- `tests/unit/main/workspaceStreamingCommits.test.ts`: a pane and the sidebar show held appends before
  the store holds them (read through a second connection), the flush commits them as one folded event,
  a non-append commits the held words at once, and `flushEvents` answers false while storage cannot
  take a batch and true once its retry lands.
- `tests/integration/claudeTranscriptCatchUp.test.ts`: with event commits failing, a disconnect saves
  no transcript cursor; once storage returns and the words commit, the cursor is saved whole.
- `tests/integration/workspaceHistoryRetry.test.ts` keeps its #378 and #487 cases, with its failure
  seam moved from `appendMany` to `appendBatches` and its streaming case now expecting the folded
  append.

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/streamingCommits.perf.test.ts --maxWorkers=1 --disable-console-intercept
npx vitest run tests/unit/main/workspaceStreamingCommits.test.ts tests/unit/main/threadStore.test.ts tests/integration/workspaceHistoryRetry.test.ts
```
