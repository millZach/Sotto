# The read before a send - October 30, 2026

Measured with the data-transfer benchmark (`tests/perf/dataTransfer.perf.test.ts`, `docs/perf/2026-10-29-data-transfer.md`):
the owner-scale pipeline on Owl, three observed threads of 2,000 activity records.

## What it cost

Every send reads its thread first, through the provider switch (ADR-0005's read before writing). The switch answered
that read, and every connect and settings result, with `cloneHostSnapshot` of every thread of every provider: a deep copy
of every activity record, though it holds those records certified and frozen. The workspace could not trust the copies,
so it merged every record of every thread again and kept the result uncertified. The thread store's worker was then sent
those lists whole, because none of their records was one it had been sent before. With three long threads on screen, a
send posted 76.6 MB to the worker in 54 posts, against 1.0 MB with short threads, and every later update and save worked
through the uncertified lists too.

## The change

The switch hands a caller its own copy of everything, as before, except the activity lists and the model catalog it holds
certified, which it shares, frozen, as its subscribers are handed them (`cloneSnapshotSharingActivities`). Nothing a
caller could write into is shared: every thread record and every other part is still the caller's copy.

A read still reconciles every record it brings, as reads always did. A certified list can match the workspace's last
merge, and the merge's cached path would then keep, at the record limit, a different set of the oldest records than a
read always kept. So only a publication takes that path, and a read's records that come out the same as the records held
are the records held. What the workspace keeps, saves and publishes is the same, byte for byte; only how many times it is
copied changes.

| A send, three observed threads of 2,000 records | Before | After |
| --- | ---: | ---: |
| Posted to the store worker | 76.6 MB in 54 posts | 100 KB in 6 posts |
| Benchmark CPU for the send scenario | 233 ms | 129 ms |

At the owner's scale (`ownerScaleWorkBudget.perf.test.ts`, Owl):

| | Before | After |
| --- | ---: | ---: |
| Copies per send | 83 | 33 |
| Objects copied per send | 11,925 | 8,507 |
| Thread visits per send | 7,045 | 4,146 |
| Serializations per send | 1,263 | 793 |
| Objects copied per streamed update, three threads | 101.5 | 20.2 |

## The guards

The owner-scale gate's budgets drop to these counts. `providerSwitch.test.ts` holds a thread read to the switch's own
certified records, the same objects read after read, and a caller's copy of the rest. `workspaceReadActivity.test.ts`
holds a read at the record limit to exactly what a read of copies kept, and its unchanged records to the objects held.

## What it leaves

A turn of a thread nobody is looking at still reads its stored records back on main and sends them to the worker whole,
because the thread's records are let go once it is idle. That is #1645's, next.
