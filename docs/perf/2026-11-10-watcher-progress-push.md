# What a paired desktop is sent when a watched thread takes a step (November 10, 2026)

The November 10 audit (`2026-11-10-performance-and-data-audit.md`, finding 1) found that 90% of what forge's host sent
the laptop was Watcher's projection: up to 1,000 requests and 1,000 operations, pushed whole as `watcher-state` every
time a watched thread took a step, because the projection's revision takes in each watched thread's progress. On forge
each push was 1.98 MB of JSON, 2.1 times a second, and only its 25 KB of progress had changed. This note records what
the new progress push (`watcher-progress`, ADR-0073's November 10 amendment, #2391) sends instead.

## The measure

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/watcherProgressPush.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

The benchmark runs the real socket server, the host service a headless host runs and the desktop's real client. The
host's Watcher is a stand-in that hands out the projection the way `WatcherService.remoteProjection` does, over a
synthetic record of forge's size: 925 requests and 929 operations a desktop's Watcher made there, every request closed,
and 140 watched threads, about the 25 KB of progress forge's push carried. One thread at a time takes a step, 50 times,
and the benchmark counts the Watcher frames two desktops are sent: the desktop's real client, and a desktop whose hello
does not accept `watcher-progress`. Bytes are the JSON text, and on the wire at the socket's own compression, zlib level
6 for a message of 1 KiB or more.

"Before" is the same file run on the code before this change (`chore/performance-and-data-audit` at c9a0940fd), where the
real client knows no `watcher-progress` and is sent `watcher-state`. Both runs were on forge, Node 24.22.1.

| One step in one watched thread | Before | After | Falls by |
|---|---:|---:|---:|
| Frame the desktop's client is sent | `watcher-state` | `watcher-progress` | |
| JSON bytes | 1,640,095 | 434 | 3,781 times |
| Bytes on the wire, compressed | 177,891 | 434 | 410 times |
| On the wire a minute, at forge's 2.1 steps a second | 22.4 MB | 55 KB | |

A progress push is under 1 KiB, so the socket sends it uncompressed. A desktop whose hello does not accept the feature
was sent 1,640,095 bytes a step in both runs, 177,842 compressed after and 177,891 before: it is sent what it was.

The synthetic record compresses better than forge's: its whole push is 1.64 MB of JSON and 178 KB compressed, where
forge's was 1.98 MB and 366 KB. The progress push does not depend on the record's size, so on forge the fall on the wire
should be larger, not smaller. `tests/perf/watcherStatePush.perf.test.ts` times what one whole push costs each end, about
18 ms on the host and 13.5 ms on the laptop's main process for forge's record (the audit's revised figures); a progress
push does none of that work, but its own time was not measured here.

## What still goes whole

A changed request, operation, standing watch or piece of evidence still sends the projection whole, and so does the first
projection after a hello. So does a newly watched thread that sits above the others in the host's list, as the whole
progress list rather than the record. These are as rare as Watcher's own actions; a step is the common case.

## The guard

`tests/integration/watcherProgressPush.test.ts` runs in every test run. Over the real socket server and the real client it
checks that a step sends a desktop that accepted the feature one entry, under 1,000 bytes and with no request, operation
or evidence in it; that the client then holds exactly the projection the host would have sent whole; that a record change
and new evidence still go whole; and that a desktop without the feature is sent every projection whole, as before. With
the progress path turned off it fails, and so it does on the code before this change.

## Not measured yet

The issue's own measure is `watcher-state` bytes a minute in `scripts/perf-bench/host-wire-tally.py` on forge, about 46 MB
before. That needs this change in a release on forge's host and on the laptop, so it was not taken here.

## The host-sized guard

`tests/perf/hostPushSizeBudget.perf.test.ts` (#2390) builds a host the size of forge's and connects a desktop that
accepts what Sotto's own client accepts. It merged after this change was written, so its Watcher budgets are lowered
here, to what it measures with this change in:

| For a change of Watcher's progress alone, to the desktop | Before | After |
| --- | ---: | ---: |
| Bytes of JSON | 1,986,099 | 451 |
| Parts of the push that did not change | 8 | 2 |
| Whole `watcher-state` pushes | 1 | 0 |

`SOTTO_PUSH_SIZES=1 npx vitest run tests/perf/hostPushSizeBudget.perf.test.ts --maxWorkers=1 --disable-console-intercept`
