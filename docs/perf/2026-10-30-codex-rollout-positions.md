# Codex rollouts at a restart - October 30, 2026

Part of #992. Measured with `tests/perf/codexRolloutTail.perf.test.ts`. It saves 46 and 92 Codex threads, each with a
rollout of about 2 MB: turns of a question, two tool outputs and an answer, as Codex writes them. It connects the adapter
over the fake app-server and reads every rollout to its end, as a run leaves them, then quits. Five threads then gain a
turn typed in Codex outside Sotto, and Sotto starts again. Over that second run it reports:

- the connect's time;
- every byte main reads from a file from the connect until the reads settle, and the CPU that took;
- the rollouts each idle tick reads, with no thread open;
- opening five untouched threads and the five with outside work: each open's time and the bytes it read.

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/codexRolloutTail.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

## What it cost

The adapter tailed every saved thread's rollout from its first byte at every connect: a megabyte of each a tick until it
reached the end, then every rollout opened every second. #992 measured 394 MB over 46 threads on the owner's machine, 23.1 s
of wall time and 36.6 s of main's CPU after each start, with the connect waiting 2.5 to 3.9 s on its share.

## The change

Zach's call, October 29: check every second only threads open in a pane, working, or watched by Watcher. Every other
thread catches up when it is opened or sent to, and a thread he comes back to must not open slower.

- Each tick reads only the rollouts in use: those of the threads the coordinator observes, of the threads working, and of
  the threads whose app-server did anything since the last tick. A rollout that leaves those is read once more, and a
  failed read is tried again. The adapter's own reads, at connect and for its snapshot, read the rollouts in use and any
  whose read failed. A thread coming into view reads its rollout to the end at once, even while its session still runs.
- Each tail saves its rollout position: the start of the first line it has not read whole, the file's identity, the user
  messages it reported and each turn's identity rows up to there. A later run reads on from it, so opening a thread reads
  only what was written since. Positions are saved at most twice a minute while a rollout grows, and when the adapter
  stops.
- A thread with no position yet, as every thread has on the first run with this change, is caught up once by the timer
  if the user has not settled it, as every connect did before; a settled one is read when it is opened (Zach's call,
  October 30). The connect waits on none of it.
- A rollout gone from where it was is looked for again, and keeps its position where it is the same file. A line read
  after the adapter stopped is left out of the position, so input it never reported is read again.

## Before and after

Three runs each on forge, the same benchmark before and after; ranges are the three runs, an open the median of five.

| The restart | Before | After |
| --- | ---: | ---: |
| Connect, 46 saved threads | 454-513 ms | 36-38 ms |
| Connect, 92 saved threads | 813-1,221 ms | 35-39 ms |
| Rollout bytes main read, 46 / 92 threads | 92.2 MB / 184.4 MB | 0 / 0 |
| Main's CPU over those reads, 46 threads | 647-709 ms | 9-11 ms |
| Main's CPU over those reads, 92 threads | 1,064-1,509 ms | 10-11 ms |
| Rollouts read per idle tick, nothing open, 46 / 92 threads | 45.4-46 / 92 | 0 / 0 |
| Opening an untouched thread | 47.6-53.9 ms, 0 bytes | 47.3-52.9 ms, 0 bytes |
| Opening a thread with outside work | 41.8-54.8 ms, 0 bytes | 46.2-51.1 ms, 7,502 bytes |

Before, the restart's reads had already read the outside work by the time a thread opened; now the open reads that turn
itself. The open is mostly the fake app-server starting, and its time is the same either side.

The saved positions took 4.8 MB on disk for 92 MB of rollouts and 9.7 MB for 184 MB, about 5%. The owner's 394 MB would
take about 20 MB in the app's data folder.

Taking up a position at a thread's first read costs a fraction of reading its rollout from the first byte, which every
run did before. The same benchmark times both for one thread, the median of three, two runs:

| One thread's rollout | Its position | Taking it up | Reading the rollout from the first byte |
| ---: | ---: | ---: | ---: |
| 2 MB | 105 KB | 0.7-1.0 ms | 6.9-11.9 ms |
| 20 MB | 1.0 MB | 5.0-5.2 ms | 67.4-69.2 ms |

## The guards

- `tests/unit/main/codexSessionLog.test.ts`, "a Codex rollout read on from a saved position", in the default suite:
  - a watcher saves its place mid-turn, between an answer and its native ID, with half the next line written. A new
    watcher restored from that place reads the rest. Between them they report the same user messages, each once, and
    hold the same identity rows for every turn, native IDs included, as one that read the rollout from its first byte;
  - a saved position is not trusted for a file shorter than it read, or another file put in its place;
  - each tick reads only the tails in use, once more after one leaves them, a tail with no saved position until it
    catches up, and a failed read again; the read a connect or a snapshot makes catches none up; a whole read still
    reads every tail;
  - a watcher stopped while a read of the rollout is on its way saves no position past the lines it read after
    stopping, so the next run reports them;
  - a rollout moved from where its position was saved is found again and read on from there;
  - a rollout replaced by another file while the watcher runs is read from its first byte, and the position saved after
    holds what that read holds;
  - a read queued for a thread let go while it waited ends quietly, and does not take the thread up again.
  - the tick catches up only the tails it is told to, and one it leaves is read whole when it is read.
- `tests/unit/main/settledThreadsHandOff.test.ts`: the workspace names the threads the user settled to the adapter by
  the adapter's own IDs, through the provider switch and the identity wrapper, before the adapter connects.
- `tests/integration/codexRolloutPositions.test.ts`:
  - quitting saves the position at the rollout's end; after a restart, neither connecting nor a tick reads the rollout of
    a thread nobody looks at, and opening it reads exactly the bytes typed outside Sotto meanwhile, and shows them;
  - the first connect without saved positions reads no rollout, and the timer's tick catches it up;
  - a thread coming back into view while its session still runs shows work typed outside Sotto at once, with no tick.
  - after the update, the timer catches up only the unsettled thread, and the settled one reads its whole rollout when
    it is opened.

Each fails without its part of the change.

## What it leaves

- The first run with this change reads every unsettled thread's saved rollout once, as every run did before; a settled
  thread's first open after it reads its whole rollout once.
- #992's other items: skipping rollout lines that cannot carry a message before parsing them, the Claude CLI started when
  a thread is viewed, and Devin's idle replays.
