# Watcher's room without making every thread's evidence again - November 13, 2026

Measured with `tests/perf/watcherOwnerRoomEvidence.perf.test.ts`: a desktop's Watcher holding a copy of the owner's
record (`tests/fixtures/watcherOwnerRecord.json.gz`, 942 requests naming 405 threads), each thread holding the evidence
one with a pull request does (its link, state and checks, its working copy and its last turn), building the room again
with nothing changed.

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/watcherOwnerRoomEvidence.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

## What it cost

Watcher's room is built again for every publish. In the owner's 60-second recording on Owl 0.1.43-owl.20261113.1 it was
built about 730 times, 6.9 ms each, 5.0 s of main's minute. On the Owl before (the November 12 recording) it was built
about 450 times, 2.4 ms each, 1.1 s. The part that grew most was `WatcherEvidenceStore.read`, which the room calls for
every thread its record names: 85 ms of main's minute on November 12 and 1,486 ms on November 13. Each call copied up to
100 of the thread's facts and parsed each one's time, so its cost followed the evidence Sotto had gathered over the day,
for every thread the record names, on every publish.

## The change

- A thread's facts are kept in a map that counts its changes. A read keeps the list it made, connected and not, with the
  revision it was made at and the span of clock times over which no fact turns stale or fresh.
- A read inside that span, with the facts unchanged, hands out the same list. The list and its facts are frozen, since
  every caller now shares them.
- A thread whose facts go takes its kept reads with it: they are held by its map, weakly.

## Before and after

On the owner's laptop, Node 24.14.1, three runs each, 60 builds after ten to warm up. Before is the change's parent.

| One room build with nothing changed | Before | After |
| --- | ---: | ---: |
| Median time | 1.48 to 1.60 ms | 0.54 to 0.73 ms |
| Reading every thread's evidence (405 threads) | 1.03 to 1.17 ms | 0.06 to 0.09 ms |
| Threads whose evidence list is made again | 405 | 0 |

The fixture's evidence is lighter than the owner's was at the end of a day, so the live build saves more than this: on
November 13 the reads were about 2.0 ms of each 6.9 ms build.

## The guard

`tests/perf/watcherOwnerRoomEvidence.perf.test.ts`, "hands out each thread's evidence again until that thread's evidence
changes", runs in the default suite. A room built again hands every thread the same evidence list as the build before,
and a new fact on one thread makes that thread's list again and no other. `tests/unit/main/watcherEvidence.test.ts` holds
the clock's edge: a pull request's fact is the same list up to five minutes after its read and a new, stale one after.
