# Watcher's observation pass with a paired host

Issue #1023. Watcher hears when background work ends (#1050) and reports outcomes for every start and send (#1052). Both asked for a paired host's features inside loops: once or twice for every finished thread in each observation pass, and once for every accepted remote start or send in each room state read. Listing the remote hosts read each paired host's shell for its permission ceiling, and the socket service copies its whole cached shell, about 1 MB for a 204-thread host, on every read. Main runs a pass on every publish while Watcher is on, including every streamed chunk on this computer, so with a paired host connected the app froze. Lane perf-check measured it (`.zstack/watcher-orchestration-engine/perf-check.result.md`).

## What changed

- **The host list copies nothing.** `DesktopHostRouter.watcherHosts().hosts()` reads a host's permission ceiling only when it is asked for, which happens once per start on that host, not on every list.
- **One pass, one read of each.** `WatcherWakeUp` runs an observation pass, a news read, a batch flush and the recheck of a batch just before it is delivered each as one pass. Within it, the merged snapshot, the Watcher record and the list of hosts that report work are read at most once. Before this, each finished thread, each event and each due check read them again. A recheck after the delivery wait starts a new pass, so it reads the state as it is then. Main has long rebuilt the merged snapshot for each news event in every room state read. That was the cost #1053's "no full-shell clones" figure did not cover once Watcher had news, and this fix removes it too.
- **Only a watched thread's finish costs its extras.** The pass already dropped finishes on threads no request watches. It now skips their work counts and their answer as well. The answer gets the pass's record instead of copying the whole record again.
- **One host list per room state read.** `outcomeOf` asks a host list read once per `state()` instead of once per accepted remote start or send.

The work-settled rules, the outcomes and the room publication are unchanged; their suites pass as before.

## Measurements

`tests/perf/watcherObservePass.perf.test.ts` (from #1069): the generated 204-thread paired host over a real socket, 200 of its threads with a finished turn, six participants and six accepted starts there, and the wake-up observation started. `tests/perf/watcherRoomRemote.perf.test.ts`: room state and Get at 1, 3 and 6 targets, with no news. Run interleaved A B A B A B on the Windows laptop: A is `origin/main` at `f4f945bfe` (E1, E2 and E3 merged), B is the fix, with the same benchmark files on both sides. CPU load at each run's start was 60, 30 and 31% (A) and 26, 25 and 20% (B), with 7.7 to 9.1 GB free and other sessions' node processes running. Counts are exact in every run; times are medians of three runs, with the range of the run medians.

| Per call | Before (A) | After (B) |
| --- | ---: | ---: |
| observe: CPU ms | 4,203 (4,109-4,286) | 21 (16-26) |
| observe: wall ms | 4,366 (4,271-4,501) | 16 (16-19) |
| observe: whole-shell clones | 438 | 1 |
| observe: remote host lists | 419 | 2 |
| observe: Watcher record clones | 246 | 1 |
| state: CPU ms | 364 (302-550) | 12.5 (11-14) |
| state: wall ms | 377 (305-570) | 10.6 (10-13) |
| state: whole-shell clones | 42 | 1 |
| state: remote host lists | 24 | 2 |
| state: Watcher record clones | 38 | 3 |

The pre-E1 baseline was 38 whole-shell clones and about 0.35 s per pass (perf-check, `efc0ea617`). A pass now copies the paired shell once, for the merged snapshot it reads at the start.

`watcherRoomRemote`, medians of three runs, ms per ten reads (no whole-shell clones on either side, as before):

| Targets | state before | state after | Get before | Get after |
| --- | ---: | ---: | ---: | ---: |
| 1 | 0.71 | 0.92 | 0.49 | 0.64 |
| 3 | 0.99 | 1.15 | 1.01 | 1.17 |
| 6 | 1.97 | 2.02 | 1.78 | 2.37 |

These are fractions of a millisecond per ten reads, and the run ranges overlap for most rows. This benchmark never starts the wake-up observation, so the news read it times has no events; the only new work on that path is the pass scope's bookkeeping. Read it as unchanged.

## The guard CI runs

`tests/unit/main/watcherObserveCounts.test.ts` runs in the ordinary suite. It drives one observation pass and one room state read through the real router, with a paired host of 2 and then 24 finished, watched threads, each with an accepted Watcher start whose turn it answers. It counts shell reads (each one a whole-shell copy in the socket service), remote host lists and Watcher record reads. It fails if any count differs between the two sizes, or if a pass reads the shell or the record more than once. A second guard in `tests/unit/main/watcherWakeUp.test.ts` delivers a batch of 2 and then 24 events and requires the same number of snapshot and record reads for both; without the pass around the recheck before delivery it counted 3 and 7 against 25 and 51. On `origin/main` the counts were 18 shells, 11 lists and 24 records per pass at size 2, and 194, 121 and 244 at size 24. On this branch they are 1, 2 and 1 at both sizes.

## Not covered

After each pass, main prunes queued Watcher wake-ups and asks whether each queued event is still due, one event at a time from `control.ts`. Each ask still reads the merged snapshot and the record. That is #1070.
