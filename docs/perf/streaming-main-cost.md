# Main's cost while a thread streams

October 10, 2026, issue #917. With the lag in #914 fixed, main still spent about a quarter of its time while two
threads streamed on the development machine (196 threads, 108 MB of activity records, a 608-model catalog). A CPU
profile of the installed 0.1.36 put about 11% in copying activity snapshots between the adapter and the workspace,
5.5% in the host router's shell and its `mapHostReferences` walk, and 4% in the coordinator's `shell()` clone.

## The benchmark

`tests/perf/streamingMainCost.perf.test.ts` runs the app's own chain on generated data shaped like that machine:
two event-sourced adapters built like Claude's and Codex's, `SottoThreadHost`, the provider switch, the workspace,
the coordinator, the local host service, the desktop host router, and the window's state and detail publishers as
`src/main/index.ts` wires them. 50 threads publish 400 records each, 4 hold 1,100 records their adapter has not read
this run, 140 have none, and the catalog has 608 models. It streams 300 chunks 2 ms apart into one thread, with a
command record every 25 chunks, five times, and reports medians.

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/streamingMainCost.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

`SOTTO_PERF_PROFILE=<file.cpuprofile>` also writes a CPU profile of the first round.

## Results

Windows 11, the development laptop, nothing else running, medians of five rounds of 300 chunks. Two runs of each,
alternating, against main at 1ad5f0b38.

| | Before (two runs) | After (two runs) |
| --- | ---: | ---: |
| Main CPU per chunk | 6.20, 6.15 ms | 1.72, 1.77 ms |
| Main busy per chunk (event loop active) | 8.29, 8.31 ms | 2.21, 3.46 ms |
| Event-loop utilisation | 77%, 77% | 45%, 56% |
| Garbage collection per round | 46, 46 ms | 6.8, 7.0 ms |
| Heap growth within a round | 53, 61 MB | 49, 38 MB |
| Wall time for 300 chunks | 3.2, 3.2 s | 1.5, 1.8 s |
| Coordinator shells per state sent | 3.35, 3.19 | 2.00, 1.67 |

CPU is the steadiest of these; the event loop's active time moves with timer scheduling. An earlier run against
f3e5e2041, while two of the owner's threads streamed in the installed app beside it, read 13.3 ms busy and 12.7 ms CPU
per chunk before and 2.6 and 2.2 ms after. Heap growth within a round says little here: the benchmark's heap is
mostly the generated archive.

#922, merged while this was under review, had the router check whether a thread is a Watcher thread before forwarding
each detail, by reading the host's shell: another structured clone of the coordinator's state per streamed detail. The
router now asks the host for the thread's kind without copying its state (see below). Against main at ccd21ff67, with #922, on a busier
machine (the owner's app running beside it), two alternating runs each:

| | Before (two runs) | After (two runs) |
| --- | ---: | ---: |
| Main CPU per chunk | 8.80, 10.36 ms | 3.02, 2.50 ms |
| Garbage collection per round | 58, 65 ms | 10.5, 8.7 ms |
| Coordinator shells per state sent | 4.46, 3.92 | 1.60, 1.65 |

What changed:

- **Router.** The router answered every coordinator broadcast, about 60 a second while a thread streams, by asking the
  coordinator for its shell again, a second structured clone of the whole state. A publication the local host's
  broadcast set off is now built from that shell. Every other host in it, and every publication a broadcast did not set
  off, such as the one after a command, is read afresh, since a command can change the coordinator's state without a
  broadcast. A remote host's push carries the histories it has cached, so it is still read afresh. Listeners that only
  need to know something changed (`subscribeChanges`) have no state built for them.
- **Unread activity.** A thread its provider published with no activity (Codex before a thread is opened) had the
  workspace's whole list rebuilt on every accept and copied whole into every publish; it is now certified once.
- **Projection.** `clientAgentState` no longer walks the threads it rebuilds anyway, or the catalog, which names no
  Sotto entity.
- **Shared catalog.** Adapters certify their catalog; the switch, the workspace and the coordinator's shell share it
  until it changes (ADR-0016 and ADR-0028, October 10 amendments). A catalog no adapter certified is copied and merged
  as before.
- **Watcher check.** The router asks the host for the thread's kind as it is now (`threadKind`), which the coordinator
  and the socket client answer from the state they hold, without copying it. A host that cannot answer that way is
  still read through its shell.

Building the window's state when the window takes it, rather than when something changes, measured a little lower
still, but a router-only change made between the two, such as a command clearing its notice, could then replace what
the window had been about to show, so it was not kept.

## What is left

The coordinator still clones its shell, every thread's metadata included, on each 16 ms broadcast, and each layer from
the adapter to the workspace copies every thread object it passes on. Sharing unchanged threads through those layers
would remove most of what remains, but it changes ADR-0016's rule that snapshot containers are isolated per consumer,
and is left for its own issue.
