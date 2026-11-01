# A word streaming into a pane leaves its branch toolbar as it was - November 1, 2026

Part of #993, the composer half of its second item; #1957 did the panes. Measured on forge with
`tests/perf/threadsRender.perf.test.tsx`, in jsdom, on a copy of forge's host data (66 threads; the open thread holds
1,119 messages, the second pane's 552):

```sh
SOTTO_PERF_BENCH=1 SOTTO_PERF_DATA=<a Sotto data folder> NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/threadsRender.perf.test.tsx --maxWorkers=1 --disable-console-intercept
```

"Before" is the same file run on `origin/main`, alternated with "after". The benchmark now also reports the render time of
each pane's composer and of its branch toolbar (`composerMsPerUpdate`, `toolbarMsPerUpdate`), from a React Profiler
around each. Its React figures are React's render time for an update, the Profiler's `actualDuration`, averaged over
the timed updates.

## What it cost

After #1957, the pane whose own thread streams is the one pane still drawn for every word, and its composer with it.
Profiled per chunk on the open thread, a first look at the composer's parts gave this render time:

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

The chips, the editor and the composer's own body still draw with each chunk, so this item is part of the composer's
boundary, not all of it. They read the thread's newest user message, its summary and its usage, and they're handed props
made afresh on each pane draw. What is left of them, 0.84-1.82 ms per chunk below, is about what the toolbar was. #1969
has the rest.

## Before and after

Per chunk on the open thread, the median time of an update and, in order, React's render time for the page, the panes'
composers and their branch toolbars. "Before" ran on `origin/main` at `f976052cc` (two runs), "after" on this branch
(three), alternated.

| Update | Before | After |
| --- | --- | --- |
| 1 pane, update | 23.5-26.7 ms | 22.3-23.2 ms |
| 1 pane, page / composer / toolbar | 11.1-16.9 / 2.75-4.05 / 1.23-1.67 ms | 10.2-11.7 / 1.60-1.82 / 0 ms |
| 2 panes, update | 17.7-25.0 ms | 15.7-16.9 ms |
| 2 panes, page / composer / toolbar | 8.3-11.8 / 2.05-2.89 / 1.06-1.25 ms | 6.6-8.2 / 0.84-1.18 / 0 ms |

The page-level figures scatter by a few milliseconds between runs on forge, which other work shares; the composer's and
the toolbar's are steadier. The figures are jsdom on forge, so they are the ratio rather than the laptop's
milliseconds.

## The guards

- `tests/unit/renderer/agents/paneMemo.test.tsx`, in the default suite: a word streaming onto a shown thread's reply draws
  its pane and not its branch toolbar. Without the toolbar's boundary, or with one that compares records by identity
  alone, it draws once per word.
- `tests/unit/renderer/agents/paneWorld.test.ts`: `ownStreaming` keeps a part as it was while its own thread streams, but
  not when its first message lands or anything else of it changes.
