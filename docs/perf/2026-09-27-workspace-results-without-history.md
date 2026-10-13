# Thread refreshes and settings results without held histories - September 27, 2026

Issue #368, the follow-up `docs/perf/2026-09-26-snapshot-cloning.md` left. #322 took held histories out of
the activity snapshots the workspace reads on every update. What was left was the adapters' public `view()`
(Codex, Grok and Devin call it `current()`), which copies every held thread's messages. It runs once for a
connect, a `snapshot()`, a thread refresh (`refreshThread`) and a settings result (`configure-thread`). The
workspace reads the last two and discards their messages, since it keeps history from thread events
(ADR-0016). On the way the provider switch copied them twice more: `accept` copied the result into the
provider's slot, and the call returned `cloneHostSnapshot(this.aggregate())`. The slot then kept its copy until
the next emit replaced it.

A thread refresh is not rare. The coordinator reads the thread before every send (`{ beforeSend: true }`),
after an uncertain delivery, when a thread is assigned and in several recovery paths. A settings result comes
back for every chip press the provider confirms.

## What each reader of a refresh needs

Before dropping anything, every reader of `view()` through a refresh or a settings result was checked:

- **The workspace** keeps history from events. `WorkspaceHost.accept` sets `merged.messages = old?.messages`
  and `merged.summary = old?.summary` for a host that publishes events. `trackSubagents`, `mergeActivities` and
  the connection check read no messages. What the workspace hands back, and what the pane draws, is its own
  window from the store.
- **The read before a send** (`ThreadReadPurpose.beforeSend`). The coordinator compares the newest user message
  against the snapshot the workspace hands back, which is the workspace's own window. Codex's newest-turn check
  (`confirmNewestTurn`) works inside the adapter and publishes what it finds as events. Neither needs the
  messages in what the adapter returns.
- **An earlier window.** No adapter's refresh loads one. Show earlier messages is `loadEarlierMessages` on the
  workspace, which widens its window from its own store and never reads the provider.
- **A coordinator wired straight to an adapter, the adapters' own internal refreshes, personal chats and the
  adapter contract** read the messages from what a refresh returns. They never ask for less, so they get them;
  only the two contract cases that check the option ask.

## The change

`ThreadReadPurpose` gains `historyFromEvents`, and so does the `configure-thread` command, with the meaning it
has on `subscribeActivitySnapshots`: the caller keeps history from the host's events and reads none from the
result. Claude, Codex, Grok and Devin then build the result from their activity view, each thread with its
summary and no messages, instead of copying the held histories.

The workspace asks whenever its host publishes events, and never otherwise, whatever its own caller asked. The
provider switch passes the request on only when its activity subscription to that provider asked the same.
What a read hands back becomes the provider's slot, and the slot is what the switch publishes next to every
subscriber, so a subscriber that reads messages must not be handed a slot without them. If one arrives while
a result without messages is on the way, the switch reads the provider whole and takes that in instead; the
review found that window, which nothing in the app opens today. `SottoThreadHost` already passed the purpose
and the command through unchanged.

The option never crosses the host socket. A remote host runs its own workspace over its own provider switch in
one process (`createAgentRuntime`), and the socket carries coordinator commands. The protocol is unchanged, and
an older host keeps working as it did.

## How it was measured

`tests/perf/snapshotCloning.perf.test.ts` gained a second half. After the emits it measures, with the same
held threads, 20 thread refreshes and 20 settings results for the first thread, each through the workspace the
way the coordinator asks for them, after three to warm up. The settings change flips the permission mode, which
the fake CLI takes in place. It reports the objects in what the provider switch hands the workspace, the time
the adapter spends building its result, the switch's own share of the call (its whole call less the provider's:
accepting, publishing and the copy it returns), the workspace's acceptance, and the whole call.

Same machine as the #322 note: Windows 11, Intel Core Ultra 9 275HX, Node v24.14.1, with other agents' suites
running beside it. "Before" is the benchmark over `origin/main` at `020df63a` with only the benchmark changed;
"after" is the branch. The whole call waits on the fake CLI and the disk, and settings wait for the CLI to
confirm the change, so read the copy columns rather than the whole call. The benchmark reads the heap twice:
before the reads (`heapMiB`, as the #322 note did) and after them (`heapAfterReadsMiB`).

## Before and after

A thread refresh, window with one pane:

| Threads, messages each | Objects handed (messages) | Adapter result | Switch's share | Copies | Whole call |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 x 21, before | 47 (23) | 0.070 ms | 0.124 ms | 0.19 ms | 4.0 ms |
| 1 x 21, after | 28 (1) | 0.043 ms | 0.125 ms | 0.17 ms | 4.5 ms |
| 8 x 21, before | 243 (177) | 0.622 ms | 0.698 ms | 1.32 ms | 8.6 ms |
| 8 x 21, after | 98 (8) | 0.129 ms | 0.391 ms | 0.52 ms | 7.7 ms |
| 4 x 1,001, before | 4,051 (4,009) | 5.16 ms | 2.87 ms | 8.03 ms | 16.5 ms |
| 4 x 1,001, after | 58 (4) | 0.050 ms | 0.137 ms | 0.19 ms | 6.4 ms |
| 8 x 1,001, before | 8,083 (8,017) | 11.18 ms | 6.22 ms | 17.40 ms | 25.8 ms |
| 8 x 1,001, after | 98 (8) | 0.062 ms | 0.174 ms | 0.24 ms | 7.2 ms |

A settings result, same runs:

| Threads, messages each | Objects handed (messages) | Adapter result | Switch's share | Copies | Whole call |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 x 21, before | 47 (23) | 0.064 ms | 0.073 ms | 0.14 ms | 73.6 ms |
| 1 x 21, after | 28 (1) | 0.014 ms | 0.059 ms | 0.07 ms | 72.1 ms |
| 8 x 21, before | 243 (177) | 0.603 ms | 0.333 ms | 0.94 ms | 92.5 ms |
| 8 x 21, after | 98 (8) | 0.081 ms | 0.239 ms | 0.32 ms | 100.5 ms |
| 4 x 1,001, before | 4,051 (4,009) | 5.74 ms | 1.59 ms | 7.33 ms | 87.0 ms |
| 4 x 1,001, after | 58 (4) | 0.019 ms | 0.064 ms | 0.08 ms | 67.4 ms |
| 8 x 1,001, before | 8,083 (8,017) | 9.92 ms | 3.30 ms | 13.22 ms | 94.0 ms |
| 8 x 1,001, after | 98 (8) | 0.027 ms | 0.093 ms | 0.12 ms | 94.1 ms |

"Copies" is the adapter's result and the switch's share together. "Objects handed" counts what the switch
returns to the workspace; with no messages each thread's empty array is still one object. A window with no
pane gave the same shape (8 x 1,001: copies 13.61 to 0.21 ms for a refresh and 11.79 to 0.10 ms for a settings
result, 8,083 to 98 objects).

With eight long held threads, the copies a refresh makes for the workspace fell from about 14-17 ms to about
0.2 ms, and a settings result's from about 12-13 ms to about 0.1 ms. The whole refresh fell with them, from
about 26 ms to about 7 ms in the pane runs, though the fake CLI makes that column noisy (11.3 ms after with no
pane). A settings result's whole call is the CLI's confirmation and did not move. The heap read after the
reads (`heapAfterReadsMiB`) fell by about 5 MiB at eight long threads (65.1 to 60.2 MiB with a pane, 64.4 to 58.9 MiB without): the
switch's slot no longer keeps a copy of every held history from the last refresh until the next emit. That is
the retained heap the #322 note reported after its change (59.7-59.8 MiB), which it measured before any
refresh.

## What was not changed

- The adapters' `connect()` and `snapshot()` still copy every held history, and so do the provider switch's
  project checks in `create-thread`, which read the provider's `snapshot()`. They run once per connection, per
  Refresh press and per project a provider has not seen, not per send or per chip press, and the issue scoped
  them out.
- The adapters' own internal refreshes (before a Claude or Grok send, a Codex send's read) still build a
  `view()` their caller throws away. They ask for nothing, so they still copy. Filed as #372.
- The emit path, the session reaper and what the log holds are untouched.

## Tests

- `tests/integration/adapterContract.ts` gains two cases every event-publishing adapter passes (Claude,
  Codex, Grok and Devin): a refresh that asks for history from events hands back the thread with its summary and
  no messages, while a plain refresh and a read before a send still carry them; and a confirmed settings change
  that asks hands back its snapshot with the new settings, the summary and no messages, while the public
  snapshot still carries them.
- `tests/integration/workspaceResultsWithoutHistory.test.ts` runs the real Claude adapter under Sotto's thread
  identities, the provider switch and the workspace with two held threads. What the switch hands the workspace
  for a refresh and a settings result carries neither thread's messages, and what the pane is given, in the
  workspace's results and its snapshot afterwards, is the same history as before.
- `tests/unit/main/threadReadPurpose.test.ts` checks that the workspace asks for no messages beside what the
  read is for when its host publishes events, that the switch asks for them when something else reads its
  messages, and that a workspace over a host that publishes none reads it whole whatever its own caller asked.

Run the benchmark on an idle machine:

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/snapshotCloning.perf.test.ts --maxWorkers=1 --disable-console-intercept
```
