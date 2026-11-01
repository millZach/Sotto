# A word streaming into a pane leaves its branch toolbar as it was - November 1, 2026

Part of #993, the composer half of its second item; #1957 did the panes. Measured on forge with
`tests/perf/threadsRender.perf.test.tsx`, in jsdom, on a copy of forge's host data (66 threads; the open thread holds
1,119 messages, the second pane's 552):

```sh
SOTTO_PERF_BENCH=1 SOTTO_PERF_DATA=<a Sotto data folder> NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/threadsRender.perf.test.tsx --maxWorkers=1 --disable-console-intercept
```

"Before" is the same file run on `origin/main` at `6e97b4f16`, four runs each, alternated, two rounds with the order
reversed.

## What it cost

After #1957, the pane whose own thread streams is the one pane still drawn for every word, and its composer with it.
Profiled per chunk on the open thread, the composer took 2.4-3.2 ms of React's time:

| Part | React time per chunk |
| --- | ---: |
| Branch toolbar | 1.0-1.25 ms |
| Thread options (the chips) | 0.34-0.64 ms |
| Editor | 0.20-0.33 ms |
| Follow-ups | 0.03 ms |

The branch toolbar ordered the project's other threads by when each was last active on every draw. To do that it parsed
the date of every message they held, and the open threads hold hundreds each.

## The change

- **Remembered activity times.** Each thread record's last-active time is remembered by the record itself
  (`lastActive` in `branchToolbar.logic.ts`). Records are never written into, and an update hands back the very record
  of a thread it left alone, so only a thread that changed is read again.
- **The toolbar's memo boundary.** The toolbar sits behind a memo boundary of its own. It reads nothing of its own thread's
  streaming but whether it has a message yet. So its world is `samePaneWorld` with `ownStreaming`: the pane's own thread
  may also have moved in what moves while it streams (its messages, activity, summary, `updatedAt` and usage), so long as
  it still has a message or still has none. Of its row the toolbar reads only the thread.

The chips, the editor and the composer's own body still draw with each chunk: they read the thread's newest user
message, its summary and its usage, and are a third of what the toolbar was.

## Before and after

Milliseconds per update for a chunk on the open thread, the medians of each run, with React's own commit time in brackets:

| Update | Before (4 runs) | After (4 runs) |
| --- | ---: | ---: |
| 1 pane, chunk on the open thread | 19.1-23.0 (9.9-11.3) | 18.1-21.3 (8.6-9.4) |
| 2 panes, chunk on the open thread | 15.8-17.3 (6.6-8.9) | 15.9-16.7 (7.7-8.2) |

Profiled the same way, the toolbar's own time per chunk fell from 1.0-1.25 ms to 0, and the composer's whole from
2.4-3.2 ms to 1.2-1.37 ms. The page-level figures scatter by about 1.5 ms between rounds on forge. The two-pane React time
came out higher after in the first round (8.1-8.2 against 6.6-7.3) and lower after in the second (7.7-8.2 against 7.8-8.9);
the profile shows nothing of this change running there more often. The figures are jsdom on forge, so they are the ratio
rather than the laptop's milliseconds.

## The guards

- `tests/unit/renderer/agents/paneMemo.test.tsx`, in the default suite: a word on a shown thread draws its pane and not
  its branch toolbar. Without the toolbar's boundary it draws once per word.
- `tests/unit/renderer/agents/paneWorld.test.ts`: `ownStreaming` keeps a part as it was while its own thread streams, but
  not when its first message lands or anything else of it changes.
