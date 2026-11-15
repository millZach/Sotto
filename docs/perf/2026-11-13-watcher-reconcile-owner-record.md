# A paired host's reconcile with the owner's own Watcher record - November 13, 2026

Measured with `tests/perf/watcherOwnerRecordReconcile.perf.test.ts`: a desktop's Watcher holding a copy of the owner's
record, paired with the host where most of its watched threads ran, reconciling a projection the host pushed. The
projection says what the record already holds, so each pass changes nothing.

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/watcherOwnerRecordReconcile.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

## The record

`tests/fixtures/watcherOwnerRecord.json.gz` is the owner's `watcher-record.json` as it stood on November 13, 2026: 942
requests, 1,110 operations, 823 prompt turns and 499 watch fences, 2.7 MB. It holds no words. Every ID, digest and
message ID in it was replaced, consistently, so what refers to what is the owner's and nothing else is. The live file
was copied once and never changed.

The benchmark that came before it, `watcherRemoteReconcile.perf.test.ts`, builds a record of about 160 requests and at
most 250 KB. The owner's is ten times that. A pass's cost grew with the record times what the host projects, so a
synthetic record a tenth the size could not show it.

## What it cost

The owner's 60-second recording on Owl 0.1.43-owl.20261113.1 (`main.cpuprofile`, 17 to 19% of main blocked, 35 to 50
freezes over 100 ms a minute) had `reconcileRemoteNow` in nearly every freeze. It ran about 64 times a minute, once for
each projection the paired host pushed, and took 90 to 175 ms each time: 5.8 s of main's minute. Almost all of it was
self time in the closure that tries the host's projection on the record (`apply`, under `changesRecord`). The recording
of November 12, on the Owl before, shows the same 5.7 s, so this is not new in that build. It is the largest single
thing in the freezes.

Each projected request was found with `record.requests.find`, and each projected receipt with `record.operations.find`:
483 searches of 942 requests and 518 of 1,110 operations a pass. With timers around each loop, the two took about 29 ms
and 27 ms of a 60 ms pass. The stopped-request list each pass sends with a host read searched the operations once for
each stopped request too (about 4 ms a pass in the recording).

## The change

- The record's requests and operations are gathered by ID once a pass, each ID's in record order, so a projected
  request or receipt finds what a search of the record found first.
- The requests with an operation on the host are gathered in one walk of the operations, for the check that the host
  has work and for the stopped-request list.
- A reservation's operations are matched by host and thread without building a key for each operation.

## Before and after

On the owner's laptop, Node 24.14.1, three runs each, 30 passes each after five to warm up. "Before" is `57b02f3b1`.

| A pass that changes nothing | Before | After |
| --- | ---: | ---: |
| Median time | 64.8, 74.5, 79.8 ms | 3.7 to 6.1 ms |
| Walks of the record's requests | 490 | 8 |
| Walks of the record's operations | 523 | 6 |

At the recording's 64 passes a minute, that is about 4.5 s of main's minute back.

## The guard

`tests/perf/watcherOwnerRecordReconcile.perf.test.ts`, "walks the owner's record a fixed number of times a reconcile, not
once for each item the host projects", runs in the default suite. It counts the array searches and walks a pass makes
over the record's requests and operations, and allows 12 of each. The code before the change makes 490 and 523.
