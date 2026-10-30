# A turn of a thread nobody looks at - October 30, 2026

Part of #1645. Measured with the data-transfer benchmark (`tests/perf/dataTransfer.perf.test.ts`,
`docs/perf/2026-10-29-data-transfer.md`), scenario `background turns`. It runs on the owner-scale pipeline on Owl, with
the thread store on the store worker as the build compiles it (`SOTTO_AUDIT_WORKER=1`). One thread no window looks at
holds 2,000 activity records of about 3 KB. It runs two turns a second apart, and each adds one record.

```sh
SOTTO_PERF_BENCH=1 SOTTO_AUDIT_WORKER=1 SOTTO_AUDIT_PROFILE='background turns' NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/dataTransfer.perf.test.ts -t "measures what main moves" --maxWorkers=1 --disable-console-intercept
```

## What it cost

A thread nobody looks at lets its records go after a save once it is idle (stored activity, ADR-0016). Its provider's
next record read the whole list back on main's connection, at once: the query, a parse and a schema check for each of
2,000 rows. The workspace then merged the provider's list onto it, and every merged record came out as a new object. So
the save after it sent the store worker the list whole, 6.3 MB, because the worker's handle had nothing to send changes
against after the release.

That happened for every turn of a thread run out of view: worker swarms, delegated threads, Watcher's workers and babysat
threads.

## The change

- The record waits, and the list is read back on the store worker, as a window's read is (`readOnWorker`). The record
  merges onto the list once it arrives. While closing, or where the worker cannot read, the list is read on main as before.
- The worker keeps the list it read as the thread's last list, under a version main gave the read. Main takes the records
  it received as the last sent. A list saved, released or forgotten while the read is on its way lets that go
  (`StoreWorker.bases`).
- The merge onto a list just read back gives each record that comes out the same as the record read that record
  (`keepingHeld`, as a read's merge does), so the save sends only the records that changed and every ID.

What the store keeps is unchanged: the merge is the one a read on main gave, and only which object stands for an unchanged
record differs. The guards below check the list on disk, and `workspaceStoredActivity.test.ts` runs each of its cases with
the read on main and on the worker.

## Before and after

Three runs each on forge, the same benchmark before and after. Counts and bytes were the same in every run. Times are the
range of the three, profiled at 200 microseconds, for both turns together.

| Both turns | Before | After |
| --- | ---: | ---: |
| Reads of the list on main | 2 (4,000 records) | 0 |
| Time in those reads | 23.5-24.1 ms | 0 |
| Sent to the store worker | 12,539,626 bytes | 74,657 bytes |
| Records sent | 4,000, whole | 5 changed, with 4,000 IDs |
| Main, taking the record in (`acceptThreads`) | 33.0-33.7 ms | 0.2-0.3 ms |
| Main, merging when the list arrives (`activitiesArrived`) | none | 5.6-5.8 ms |
| Main, receiving the list's pieces (`StoreWorker.heard`) | none | 2.3-5.8 ms |
| Main, the save's post (`saveActivities`) | 8.5-8.8 ms | 1.8-2.0 ms |

Per turn, main's part fell from about 21 ms in one task to about 5 to 7 ms over five tasks: the record taken in, four
pieces received in tasks of their own, and the merge. Of the merge, 2.3 ms for both turns is `keepingHeld` comparing each
merged record with the one read. Every other scenario of the benchmark sends the worker the same bytes as before.

## The guards

- `tests/integration/workspaceActivityReadBack.test.ts`, "reads a stored thread no window looks at on the worker when its
  provider publishes a record, and saves it as what changed": main reads nothing, the record keeps its sequence, and the
  save sends the worker one changed record against the list it read. It fails on `main` before the change.
- `tests/integration/threadStoreWorker.test.ts`, "sends the first save after a read back as what changed since the list
  read, unless a list saved meanwhile replaced it". It fails without the base, and without the rule that a list saved
  while a read is on its way lets the read go, when the worker refuses the next save as one sent against a list it no
  longer holds.
- `tests/unit/main/workspaceStoredActivity.test.ts` runs its cases with the read on main and on the worker, as before.
  On the worker, the case where a changed list reads a stored thread back now counts no read on main.

## What it leaves

Not measured: the worker's own share. It rebuilds the few records that changed rather than 2,000, and its store compares
the same.

Still on main, as #1645 lists them: the adapters' handoff, Watcher's recent activity and a start whose subagent words have
not moved. Without a worker, as under the test runner and in the benchmark's default run, nothing changes.
