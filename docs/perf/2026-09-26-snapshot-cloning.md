# Snapshot cloning across held threads - September 26, 2026

Issue #322. Both performance reviews pointed at `view()` in the Claude and Codex adapters: every adapter emit
was said to clone every held thread's history. A held thread (`CONTEXT.md`) is one whose messages the
adapter's message log keeps in memory: it is in the watched set, its provider session is open, or nothing has
yet said what is watched. The session reaper keeps an idle session for thirty minutes, so during a working
session most threads are held. The issue asked for numbers before any
change: objects traversed and time per `view()` and per `shell()` with 1, 4 and 8 threads and short and long
histories, the process memory split, and how much of `view()` is held-thread cloning.

The issue's line references have moved since it was written. `ThreadMessageLog` now puts messages away in
`observe` and `release` (`src/main/agents/threadMessageLog.ts`), and all four native adapters (Claude, Codex,
Grok and Devin) publish through it and through the owned activity path of ADR-0016's September 23 amendment.

## What runs on each update

Reading the code first changed the question. `view()` (Codex calls it `current()`) is not on the per-update
path in the running app. It feeds the adapter's ordinary `subscribe` listeners, and in main nothing
subscribes to a thread adapter that way: `SottoThreadHost`, the provider switch and the workspace all use
`subscribeActivitySnapshots`, and personal chats run their own adapter instances. `view()` runs on connect, on
`snapshot()`, on a thread refresh and on a settings result.

What does run on every emit is the activity path, and it copied every held thread's messages four times:

1. `ThreadMessageLog.published` took a `structuredClone` of the held window, new strings included.
2. The adapter handed each activity listener its own `cloneActivitySnapshot` of that.
3. `ConfiguredProviderHost.accept` copied it again into the provider's slot, and kept that copy.
4. `ConfiguredProviderHost.publish` copied the aggregate again for the workspace.

The workspace then threw all of it away. A host that publishes thread events has already said what each
thread said, and `WorkspaceHost.accept` keeps the history it built from those events (`merged.messages =
old?.messages`). The coordinator's `shell()` never saw any of it: it carries summaries and the watched
threads' windows, not held histories.

## How it was measured

`tests/perf/snapshotCloning.perf.test.ts` runs the real Claude adapter over the fake CLI
(`tests/fixtures/fakeClaudeThread.mjs`), behind `SottoThreadHost`, the provider switch, the workspace and a
coordinator. It opens 1, 4 or 8 threads, sends each one prompt so its CLI stays open, and then has each CLI
report a history: 20 frames (21 messages) or 1,000 frames (1,001 messages) of filler text, 160 and 640
characters a message. Either one pane views the first thread, or no pane views any; every other thread is
held by its open CLI alone. It then publishes the same state 65 times and reports medians of the last 60.
It wraps the adapter's publisher, the switch's `accept` and `publish` and the workspace's `accept` with a
timer, and times `view()`, `view()`'s clone with every thread's messages emptied, and `shell()` beside them.
It counts objects a copy visits (frozen activity trees are shared, so they are not counted), from a
subscription that asks what the provider switch asks, and reads the heap after two forced collections. The
code before the change ignores that option. Nothing a thread said is printed.

The development machine: Windows 11, Intel Core Ultra 9 275HX, Node v24.14.1. Other agents' builds and suites
were running on it, so read the times as proportions rather than budgets. "Before" is the benchmark run over
`origin/main` at `37cc4a99`, with only the unused `summarizedThread` added to the log; "after" is the branch.
Two after runs are given as a range; a second before run with an earlier version of the benchmark (no window
variants) gave 9.8 ms an emit for the eight long threads.

## Before

One emit, window with one pane:

| Threads, messages each | Objects per copy (messages) | Emit, total | Adapter | Switch accept | Switch publish | Workspace accept | Retained heap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 x 21 | 35 (22) | 0.08 ms | 0.03 ms | 0.009 ms | 0.034 ms | 0.006 ms | 47.4 MiB |
| 4 x 21 | 113 (88) | 0.16 ms | 0.08 ms | 0.020 ms | 0.052 ms | 0.014 ms | 48.2 MiB |
| 8 x 21 | 217 (176) | 0.27 ms | 0.15 ms | 0.038 ms | 0.075 ms | 0.019 ms | 49.1 MiB |
| 1 x 1,001 | 1,015 (1,002) | 1.16 ms | 0.75 ms | 0.16 ms | 0.21 ms | 0.014 ms | 51.2 MiB |
| 4 x 1,001 | 4,033 (4,008) | 5.87 ms | 4.20 ms | 0.70 ms | 0.72 ms | 0.050 ms | 58.6 MiB |
| 8 x 1,001 | 8,057 (8,016) | 11.19 ms | 7.89 ms | 1.65 ms | 1.58 ms | 0.069 ms | 68.4 MiB |

"Adapter" is the emit less the switch's two stages: the log's `structuredClone` and the adapter's own copy.
"Switch publish" includes the workspace's acceptance, which is the next column. The heap is cumulative across
cases in one process, so compare it within a row, before against after.

`view()` and `shell()`, same runs:

| Threads, messages each | `view()` | `view()` without messages | Messages' share of `view()`'s objects | `shell()` | `shell()` objects |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 x 21 | 0.028 ms | 0.005 ms | 22 of 37 | 0.026 ms | 45 |
| 8 x 21 | 0.155 ms | 0.012 ms | 176 of 233 | 0.066 ms | 108 |
| 1 x 1,001 | 0.77 ms | 0.006 ms | 1,002 of 1,017 | 0.046 ms | 45 |
| 8 x 1,001 | 7.97 ms | 0.024 ms | 8,016 of 8,073 | 0.131 ms | 108 |

So nearly all of `view()` is held-thread cloning: 99% of its objects and all but 0.02 ms of its time with
long histories. The rest of the snapshot is small. `shell()` grows with the thread count, not with history,
and stays under 0.2 ms, so a per-thread change report into the coordinator would have saved almost nothing.

A window with no pane gave the same numbers within noise (8 x 1,001: 11.46 ms an emit, 8.23 ms a `view()`),
because every thread is held by its open CLI either way. A minimised window does not change what main
holds, so it was not measured separately. The watched set is what the page sends with `observe-threads`, and
the page sends it only when its panes or its pin change and, with an empty list, when the Threads page
unmounts (`ThreadWorkspace.tsx`, the `observe` callback and its unmount effect). Nothing sends it on
`visibilitychange`: the page's only listener for it, in `AgentContext.tsx`, flushes a pending shell update when
the window is hidden and changes nothing main holds. So a minimised window keeps the same watched set, and
main's side of the numbers is the same as for a visible one.

## The change

A subscriber that keeps history from the host's thread events now says so:
`subscribeActivitySnapshots(listener, { historyFromEvents: true })`. The workspace asks it whenever its host
publishes events. The provider switch passes it on to a provider that publishes events when every one of its
own activity subscribers asked it and nobody reads its ordinary `subscribe`, and asks again whenever a
subscriber comes or goes; when messages are wanted again it reads each connected provider afresh, since what
they last published carries none. An adapter that publishes events then hands that subscriber every thread the
way it already handed over a thread nobody is watching: an empty `messages` array and its summary from the
log's own facts (`ThreadMessageLog.activityThread`). Claude, Codex, Grok and Devin all do, through one
`ActivitySubscribers` helper that builds each form once a publication; the switch keeps its own subscribers in
the same helper.

A subscriber that does not ask still gets the messages. That keeps a coordinator wired straight to an adapter,
as a dozen integration tests do, reading them where it always did; in the app the coordinator reads the
workspace, whose own snapshots are unchanged. Nothing is put away by the change: the watched set, pinning and
the reaper decide what the log holds as before, and the adapters' public `snapshot()`, `connect()`, a thread
refresh and command results still carry a held thread's messages. The switch's own `connect()` is not one of
those: for a provider already connected it returns what that provider last published, which for the
workspace carries no messages, and the workspace reads none from it. ADR-0016 has the amendment, and
`AgentHost.subscribeActivitySnapshots` says it.

A first version left the messages out for every activity subscriber. The full suite caught the coordinator
tests above, which is why the option exists; its numbers matched the final code's within noise.

## After

One emit, window with one pane, two runs of the final code:

| Threads, messages each | Objects per copy (messages) | Emit, total | Adapter | Switch accept | Switch publish | Retained heap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 x 21 | 17 (1) | 0.04-0.06 ms | 0.010-0.015 ms | 0.005-0.007 ms | 0.028-0.038 ms | 47.4 MiB |
| 4 x 21 | 41 (4) | 0.07 ms | 0.021 ms | 0.007-0.008 ms | 0.039-0.040 ms | 48.2 MiB |
| 8 x 21 | 73 (8) | 0.09 ms | 0.028-0.029 ms | 0.012 ms | 0.048-0.050 ms | 49.0 MiB |
| 1 x 1,001 | 17 (1) | 0.04 ms | 0.009-0.010 ms | 0.004 ms | 0.025-0.026 ms | 50.2 MiB |
| 4 x 1,001 | 41 (4) | 0.09-0.10 ms | 0.026-0.027 ms | 0.008-0.009 ms | 0.057 ms | 54.3 MiB |
| 8 x 1,001 | 73 (8) | 0.16-0.20 ms | 0.062-0.072 ms | 0.015-0.017 ms | 0.086-0.105 ms | 59.7-59.8 MiB |

With eight long held threads an emit went from about 11 ms to about 0.2 ms, and a copy now visits eight
objects a thread whatever its history holds, the summary's among them, where it was over a thousand. The
retained heap fell by 8.7 MiB at eight long threads and 4.3 MiB at four. That is the provider switch's slot,
which kept its own copy of every held history, with new strings from the log's `structuredClone`, until the
next emit replaced it. Streaming publishes at most every 16 ms, so before the change eight long held threads
cost the main thread about two thirds of each streaming interval in copies.

A window with no pane gave the same numbers (8 x 1,001: 0.14-0.17 ms an emit). `view()` and `shell()` did
not change (8 x 1,001: 6.8-8.4 ms and 0.11-0.13 ms), as expected. A run after the review fixes, which made the
switch ask again when a subscriber comes or goes, gave 0.22 ms an emit, 10.0-10.6 ms a `view()` and
0.16 ms a `shell()` for 8 x 1,001 on a busier machine, with the same object counts.

Each activity publication still works out a held thread's summary, which the workspace then ignores, since
it keeps the summary it built from events (`old?.summary` in `WorkspaceHost.accept`). That is accepted: the
summary costs the same for every thread whatever its history holds, a handful of objects and two short
messages, and the activity summaries it rests on are cached per frozen activity array. Leaving it out would
make an activity snapshot's thread differ from the one every other reader sees for a thread nobody watches.

## Process memory

Only main is changed. The renderer receives the same shell and the same thread detail, and each provider
process receives the same protocol traffic, so neither is affected by this. The benchmark runs main's stack in
one Node process and has no renderer, and its provider is the fake CLI, whose memory says nothing about Claude
Code's. The in-app split was last measured by `tests/e2e/multi-thread-cpu.spec.ts` on September 23
(`evidence/2026-09-23-multi-thread-cpu-electron.json`): main 501-615 MiB working set, the primary renderer
274-290 MiB, the GPU process 125 MiB and the utility process 48 MiB. That spec drives a synthetic provider on
the legacy snapshot contract, not the native adapters, so it cannot show this change, and it was not run again
here. How much of main's working set in a real session is held histories depends on how many threads are held
and how long they are; the heap figures above are the benchmark's share of it. The per-process split with the
native adapters was not measured here; `2026-09-27-native-process-memory.md` (#369) measures it over the fake
CLIs, before and after this change.

## What was not changed

- `view()` still clones every held history, 7-10 ms with eight long threads. It runs once for a connect, a
  `snapshot()`, a thread refresh or a settings result, not for each update, and its readers outside the
  workspace, the adapter contract among them, expect the messages there. The workspace discards those too
  when it accepts a refresh or a settings result, and the provider switch copies them again on the way; #368
  is the follow-up that drops them for that caller alone (`2026-09-27-workspace-results-without-history.md`).
- The session reaper keeps its thirty minutes, as the issue asked.

## Tests

- `tests/integration/adapterContract.ts` gains a case every event-publishing adapter passes: across a sent
  turn, no activity publication to a subscriber that asked for history from events carries a watched thread's
  messages, the last one carries its summary with the reply, and the events carry the prompt; a subscriber
  that did not ask, and the public snapshot, still carry the messages.
- `tests/unit/main/activitySnapshotProviders.test.ts` checks that the provider switch, through the Sotto
  identity wrapper, asks a provider to leave messages out only when that provider publishes events, every
  subscriber keeps history from events and nobody reads its ordinary subscription, and that a subscriber that
  reads messages and arrives after connect makes it ask again and is handed the messages.
- `tests/unit/main/activitySnapshots.test.ts` checks that `ActivitySubscribers` builds each form once and
  hands every subscriber its own copy, and `tests/unit/main/threadMessageLog.test.ts` that summarizing a held
  thread copies nothing and puts nothing away.
- The benchmark's own file checks, in the default suite, that the private members it times still exist.
- The existing workspace, parity, streaming and coordinator suites (`multiThreadUpdateParity`,
  `workspacePaneActivity`, `nativeStreamingResponsiveness`, `codexStreamingResponsiveness`,
  `nativeQueueOwnership`, `confirmedNativeDelivery`, among others) pass unchanged, so the history the
  workspace keeps and the pane draws is the same.

Run the benchmark on an idle machine:

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/snapshotCloning.perf.test.ts --maxWorkers=1 --disable-console-intercept
```
