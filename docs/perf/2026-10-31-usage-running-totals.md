# A usage report costs the same however long its thread is - October 31, 2026

Part of #555. Measured on forge with `tests/perf/usageLedgerReport.perf.test.ts`:

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/usageLedgerReport.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

It seeds one Claude thread's usage ledger with 1,800, 10,000 and 40,000 requests. Then, in a fresh process, a reply
streams on that thread, with 200 usage reports on its newest request, and the benchmark times each report. "Before" is
the source at `bde56ebfe` and "after" the working tree, each built into a process of its own from the same workload
(`tests/fixtures/usageReportBench.ts`), three runs each, alternated. Both count the same tokens. Forge's host's longest
thread holds 1,796 requests.

## What it cost

Claude Code reports a reply's usage on nearly every frame. Each report summed every request the thread ever made again:
its money, its rate versions, whether any was unpriced, and each kind of token. The walk ran on main, and its cost grew
with the thread's length, so an extremely long thread made every streamed word dearer.

## The change

`NativeUsage` keeps each thread's totals running (`RunningTotals`): everything the walk adds up over every request but the
newest, in the ledger's own order. A report on the newest request adds that request to them in the order the walk would,
so the totals are the same numbers to the last bit. A new request moves the old newest into the running totals.

Three things still walk the whole ledger once: a ledger read from disk, a change to an older request (a replay carrying
a later snapshot of it), and a new key JavaScript would order ahead of the others. No request key Sotto writes is such a
key.

Telling a replayed Codex or Grok report from a new one checks a set of the keys the thread saw, made once, rather than
scanning them all. What a ledger holds, and its file, are unchanged.

## Before and after

| One usage report on the newest request | Before | After |
| --- | ---: | ---: |
| Thread of 1,800 requests | 0.545 ms | 0.004 ms |
| Thread of 10,000 requests | 3.419 ms | 0.005 ms |
| Thread of 40,000 requests | 21.523 ms | 0.004 ms |

At about ten reports a second while a reply streams, a 10,000-request thread spent 34 ms of main's time a second on its
totals, and a 40,000-request thread 215 ms. Both now spend under 0.1 ms.

## The guards

- `tests/perf/usageLedgerReport.perf.test.ts`, in the default suite: 200 reports on a 5,000-request thread walk none of its
  requests (on `bde56ebfe`, 200 walks), and the tokens add up.
- `tests/unit/main/nativeUsageRunningTotals.test.ts`: 400 seeded steps of new, growing and replayed requests, priced and
  unpriced, some with keys JavaScript orders first. After every 50 steps the thread's totals equal what the walk written
  out in the test makes of the requests in its file, and the money equals it to the last bit.

The ledger's growth on disk, and the write of a long thread's ledger once a second while it streams, are #1938's.
