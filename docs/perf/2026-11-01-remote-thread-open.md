# Opening a thread on a remote host sends it whole once where it can - November 1, 2026

Part of #996, the item "Read a remote thread whole once when it opens". Counted with
`tests/integration/remoteThreadOpen.test.ts`: a desktop client paired with a real headless host over its socket, counting
each time one of the host's threads reaches the client whole, pushed or read. "Before" ran the same sequences on
origin/main at `a028edc36`, with the window's read going to `readThreadDetail` as it did there.

```sh
NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/integration/remoteThreadOpen.test.ts --maxWorkers=1
```

## What it cost

A thread on a remote host reaches the desktop whole in three ways: the host pushes it when the desktop starts observing
it, the desktop reads it after a command on a thread it does not follow, and the router reads it when the window asks for
a history it does not hold. Opening a thread could do all three.

- **A click in the sidebar** sent `select-thread`. The thread was not observed yet, so the command read it whole. The
  window had already asked for its history, which the router read whole again. Then the pane observed it, and the host
  pushed it whole a third time.
- **A thread coming on screen** in a pane (a split, the window opening on its panes): the window asked for the history
  before it told main which panes were open, so the router read the thread, and the observe that followed pushed it again.
- **The window catching up** on a thread it already follows, after a delta it could not apply, read it from the host,
  though the desktop held it current.

Each whole transfer is the thread's whole detail: 0.2-3.7 MB raw for the development install's threads, about 0.6 MB
compressed for the largest (`docs/perf/2026-10-18-remote-thread-open-bytes.md`), 1.6 s at the 370 KB/s measured on that
link. Every read also made a whole `structuredClone` of the held detail in main before the router copied it again.

## The change

- The window tells main which panes are open, or which thread is selected, before it asks for their histories. Main
  takes both in order, and the router reaches the socket's observe without waiting on anything, so the ask finds the
  observe under way.
- The router reads a remote thread's history through `windowDetail`. A thread the desktop follows is answered from the
  copy the host's pushes keep current; one an unanswered observe names waits for that observe, since the host sends each
  newly observed thread whole before it answers. Anything else is read from the host as before. The held copy is not
  copied first: the router builds the window's copy from it.
- Selecting a thread no longer reads it whole after the host confirms the selection. Selecting changes nothing in its
  history, and the window's ask and the pane's observe bring it.

## Before and after

Whole transfers of one thread, per open. The counts are the same on every run.

| | Before | After |
| --- | ---: | ---: |
| A click in the sidebar | 3 | 2 |
| A thread coming on screen in a pane | 2 | 1 |
| The window catching up on a thread it follows | 1 | 0 |

For the largest thread on the development install, a click now moves about 0.6 MB less over the link, and a thread
coming on screen or a catch-up about 0.6 MB less again, each about 1.6 s at 370 KB/s.

## What is left

A click still sends the thread twice. The window asks for the history before the pane observes the thread, so the router
reads it; the host counts a read as held only for a thread already observed, so the observe sends it again. Telling the
host which revision the desktop holds would need the revision to name the same history across observations, and it does
not: the coordinator drops a thread's revision record when nobody observes it, and without `streamingPublishCost` the
count starts again. Waiting in the router for an observe that may never come would delay a history the window needs.
This is left for a host feature that can name a history across observations.

## Guarded by

- `tests/integration/remoteThreadOpen.test.ts`: the four counts above, and a thread nobody observes read once.
- `tests/unit/renderer/detailAskAfterCommand.test.tsx`: main hears `observe-threads` and `select-thread` before the
  window's ask. It fails on the old order.
- `tests/unit/main/socketHostFeatures.test.ts`: a selection reads nothing; another command still reads a thread the
  host's pushes do not keep current.
