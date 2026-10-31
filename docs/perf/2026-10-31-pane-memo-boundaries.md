# A pane is drawn again only when something it reads changed - October 31, 2026

Part of #993. Measured on forge with `tests/perf/threadsRender.perf.test.tsx`, in jsdom, on a copy of forge's host data
(64 threads, the open one with 1,119 messages, the second pane's with 552). It draws the Threads page with one pane and
with two, and times three kinds of update, ten to warm up and twenty timed: nothing changed, one more streamed chunk
on the open thread, and one more on a thread on no pane.

```sh
SOTTO_PERF_BENCH=1 SOTTO_PERF_DATA=<a Sotto data folder> NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/threadsRender.perf.test.tsx --maxWorkers=1 --disable-console-intercept
```

"Before" is the same file run on `origin/main` at `b00aa6ae9`. "After" is this branch with the review's fixes in. The two
were run alternately, two rounds each, in two sessions. The benchmark now keeps one command for the whole run, as
`AgentContext` does. Before, it made a new command for every update, which redrew every pane whatever the page did.

The benchmark mocks `useAgents`. In the app, its context value is new with every update, so a pane part reading it would
be drawn again regardless. The one part that did, the transcript reading Response streaming, now reads that setting from
a context of its own (`responseStreaming.ts`). No part of a pane reads the agent context now, so the mock does not hide a
redraw.

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
- **Orders that follow activity.** Two orders a pane shows follow other threads' activity: the branch toolbar's working
  copies, which follow the activity of the threads in the pane's project, and a new thread's greeting's recent projects,
  which follow every thread's time. Each is worked out again only when a change could move it.
- **Stable slots.** The pane slots (`ThreadWorkspace.tsx`) are made once.
- **Stable chrome.** Each pane's chrome (`ThreadPanes.tsx`) stays the same object while what it shows stays the same, and its
  presses run the newest chrome made for that pane.
- **The clock.** The page's 30-second clock still redraws every pane, as before, for the parts that work out what they say
  from the time as they draw.

## Before and after

Milliseconds per update, the medians of each run, with React's own commit time in brackets. The second session ran with
other work on forge, so its totals scatter more. React's commit time is the steadier measure of what this change removes.
What remains of an update to a thread on no pane is the page's own work and the sidebar, which are outside this change.

| Update | Before (4 runs) | After (2 runs) |
| --- | ---: | ---: |
| 1 pane, nothing changed | 9.6-10.0 (6.0-6.5) | 3.3-3.9 (2.5-2.9) |
| 1 pane, chunk on the open thread | 21.7-26.1 (12.1-15.0) | 24.7-25.0 (13.0-13.6) |
| 1 pane, chunk on a thread on no pane | 12.6-19.0 (4.7-11.5) | 13.1-17.2 (2.2-3.7) |
| 2 panes, nothing changed | 7.2-7.9 (4.8-5.3) | 3.0-3.5 (1.9-2.4) |
| 2 panes, chunk on the open thread | 20.8-28.3 (12.1-14.2) | 21.7-22.0 (9.9-11.7) |
| 2 panes, chunk on a thread on no pane | 15.2-22.2 (8.6-11.4) | 17.1-19.7 (3.2-4.9) |

With one pane, a chunk on the open thread draws that pane, as before. The gain is in every pane whose thread did not change.

The comparison costs each pane, per update, with 290 threads: 24 us when another thread's words moved, and 113 us when its
time moved too, which works the recent projects out again.

The figures are jsdom on forge, so they are the ratio rather than the laptop's milliseconds.

## The guards

- `tests/unit/renderer/agents/paneMemo.test.tsx`, in the default suite: with two panes, five streamed words on a thread on
  no pane draw neither pane, a word on a shown thread draws its pane alone, and a rename of another thread draws both.
- `tests/unit/renderer/agents/paneWorld.test.ts`: each rule of `samePaneWorld` and `relatedThreadIds`, the greeting's recent
  projects and a shared worktree's name among them.
