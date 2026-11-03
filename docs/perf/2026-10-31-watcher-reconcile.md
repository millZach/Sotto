# A paired host's reconcile without copying Watcher's record - October 31, 2026

Measured with `tests/perf/watcherRemoteReconcile.perf.test.ts`: a desktop's Watcher with work on one paired host, every
request taking part there and a thread there it watches and has stopped, reconciling the host's projection as it does
when the host pushes one. The projection says what the record already holds, so each pass changes nothing; it still
hears the stop's receipt and fences the watch's turn again.

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/watcherRemoteReconcile.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

It prints `WATCHER-RECONCILE` for the owner's history (`watcher x1`: about 160 requests and 150 operations) and eight times
it (`watcher x8`). At eight times, Watcher's pruning already holds the live record near 250 KB, so `x8` is the largest
record a pass meets today.

## What it cost

A desktop reconciles a paired host on every projection the host pushes while Watcher has work in flight there (#1781).
Each host's pass copied Watcher's whole record, tried the host's receipts on the copy, and serialized both to see
whether anything had changed. The pass then serialized the record twice more, before and after Watcher's observe pass.
A pass that changed nothing still copied the record once and serialized it four times.

## The change

- Each host's change is tried against the record as read, which is frozen, instead of a copy. A write it would make
  throws, which means the pass changes something, and only then is the change made through `updateWatcher`, as before.
  The change writes a field only when its value differs (`setIfChanged`), so one that would change nothing writes
  nothing.
- A record that is not frozen is copied to try the change on, as before, and so is every one in a build where a write
  to a frozen object would pass silently rather than throw. Both builds compile `watcher.ts` strict, and a probe when
  the module loads checks it.
- After observing, the pass compares the record it holds with the one before by identity. `mutateWatcher` keeps the
  very record when a change leaves it as it was, so another record is a change to save.

A write the change would make still counts as a change if `setIfChanged` is missed somewhere: the pass then costs the
copy it did before and loses nothing.

## Before and after

Three runs each on forge, `main` (`ea190335d`) and the change taking turns, 40 passes each after five to warm up.

| A pass that changes nothing | Before | After |
| --- | ---: | ---: |
| Time, owner's history | 3.99-4.14 ms | 1.61-1.79 ms |
| Time, eight times it | 4.29-4.57 ms | 1.97-2.12 ms |
| Copies of Watcher's record | 1 | 0 |
| Characters serialized, owner's history | 1,189,427 | 176,455 |
| Characters serialized, eight times it | 1,247,267 | 205,855 |
| Longest one serialization | 253,243 (the record) | 258 (Watcher's identity) |
| Changes handed to `updateWatcher` | 0 | 0 |

What a pass still serializes is a thread's key, `[hostId, threadId]`, for each record it compares with the host's: a few
thousand small strings a pass here. That work reads what the host projects and grows with it; it is not the record copied
or serialized whole.

## The guard

`tests/perf/watcherRemoteReconcile.perf.test.ts`, "copies and serializes nothing the size of the record on a reconcile
that changes nothing", runs in the default suite: with the owner's history and with four times it, a pass copies nothing
of the record, hands nothing to `updateWatcher`, and serializes nothing a twentieth of the record's size or more (about
12 KB; its shortest list is 30 KB). Its stopped thread makes each
pass fence the watch's turn again, so the fence's writes are tried too. It fails on `main` at the copy, and fails the
same way if the prompt turn writes the native turn it already holds.
The paired-host suites (`watcherPairedReconciliation.test.ts`, `watcherPairedHosts.test.ts`) and every other Watcher
suite cover the passes that do change the record.
