# A pane is drawn again only when something it reads changed - October 31, 2026

Part of #993. Measured on forge with `tests/perf/threadsRender.perf.test.tsx`, in jsdom, on a copy of forge's host data
(64 threads, the open one with 1,119 messages, the second pane's with 552). It draws the Threads page with one pane and
with two, and times three kinds of update, ten to warm up and twenty timed: nothing changed, one more streamed chunk
on the open thread, and one more on a thread on no pane.

```sh
SOTTO_PERF_BENCH=1 SOTTO_PERF_DATA=<a Sotto data folder> NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/threadsRender.perf.test.tsx --maxWorkers=1 --disable-console-intercept
```

"Before" is the same file run on `origin/main` at `b00aa6ae9`, two rounds each, alternated. The benchmark now keeps one
command for the whole run, as `AgentContext` does. Before, it made a new command for every update, which redrew every
pane whatever the page did.

## What it cost

Every update drew every pane again: its header, its transcript's frame and its composer. Only the transcript's rows and
the sidebar's rows were memoised. Most updates are a streamed word on one thread, so with two panes open, the pane
whose thread did not change was drawn again for every word, as was every pane while a thread on no pane streamed.

## The change

- **The memo boundary.** Each pane in the workspace sits behind a memo boundary (`ShownPane` in `ThreadsView.tsx`). It is
  drawn again when one of its props changes, or when `samePaneWorld` (`paneWorld.ts`) finds its world changed.
- **What `samePaneWorld` checks.** Everything in the state but the thread list must be the same. The list must hold the
  same threads in the same order. The pane's own thread, and every thread related to it by delegation, a swarm, a
  continuation or a start, must be unchanged. Another thread may have changed only in what moves while it streams: its
  messages, activity, summary, `updatedAt` and usage. Even then, the change must leave the branch toolbar's order of
  working copies as it was, since that order follows the project's threads' activity.
- **When in doubt, redraw.** Any doubt redraws the pane.
- **Stable slots.** The pane slots (`ThreadWorkspace.tsx`) are made once.
- **Stable chrome.** Each pane's chrome (`ThreadPanes.tsx`) stays the same object while what it shows stays the same, and its
  presses run the newest chrome made for that pane.
- **The clock.** The page's 30-second clock still redraws every pane, as before, for the parts that work out what they say
  from the time as they draw.

## Before and after

Milliseconds per update, the two rounds' medians; React's own commit time in brackets.

| Update | Before | After |
| --- | ---: | ---: |
| 1 pane, nothing changed | 9.6-10.0 (6.0-6.2) | 3.2 (2.5) |
| 1 pane, chunk on the open thread | 21.7-23.4 (12.1-13.1) | 23.1-23.7 (10.5-11.7) |
| 1 pane, chunk on a thread on no pane | 12.6-12.9 (4.7-5.4) | 10.1-10.7 (2.1-2.6) |
| 2 panes, nothing changed | 7.2 (4.8-4.9) | 1.6-3.4 (1.0-2.6) |
| 2 panes, chunk on the open thread | 27.7-28.3 (14.1-14.2) | 17.2-17.6 (7.2-9.3) |
| 2 panes, chunk on a thread on no pane | 15.2-17.8 (8.6-9.3) | 12.6-12.8 (4.5-4.6) |

The figures are jsdom on forge, so they are the ratio rather than the laptop's milliseconds. What is left of an update
to a thread on no pane is the page's own work and the sidebar, which are outside this change.

## The guards

- `tests/unit/renderer/agents/paneMemo.test.tsx`, in the default suite: with two panes, five streamed words on a thread on
  no pane draw neither pane, a word on a shown thread draws its pane alone, and a rename of another thread draws both.
- `tests/unit/renderer/agents/paneWorld.test.ts`: each rule of `samePaneWorld` and `relatedThreadIds`.
