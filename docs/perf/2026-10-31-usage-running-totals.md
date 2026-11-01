# A usage report costs the same however long its thread is - October 31, 2026

Part of #555. Measured on forge with `tests/perf/usageLedgerReport.perf.test.ts`:

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/usageLedgerReport.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

It seeds one Claude thread's usage ledger with 1,800, 10,000 and 40,000 requests. Then, in a fresh process, a reply
streams on that thread, with 200 usage reports on its newest request, and the benchmark times each report. It seeds a
Codex thread with as many turns and times 200 replayed reports of its newest turns, each one already counted, as a
thread read again from its rollout sends them. "Before" is
the source at `bde56ebfe` and "after" the working tree, each built into a process of its own from the same workload
(`tests/fixtures/usageReportBench.ts`), three runs each, alternated. Both count the same tokens. Forge's host's longest
thread holds 1,796 requests.

## What it cost

Claude Code reports a reply's usage on nearly every frame. Each report summed every request the thread ever made again:
its money, its rate versions, whether any was unpriced, and each kind of token. The walk ran on main, and its cost grew
with the thread's length, so an extremely long thread made every streamed word dearer.

## The change

`NativeUsage` keeps each thread's totals running (`RunningTotals`). The running totals hold everything the walk adds up
over every request up to the thread's tail, in the ledger's own order. The tail is its newest few requests. A report on a
request in the tail adds the tail's requests to the running totals in the order the walk would, so the totals are the
same numbers to the last bit. A new request joins the tail, and once the tail holds more than 32 requests its oldest go
into the running totals. The request last changed, a streaming reply's, never goes in, so a replay that adds requests
after it while it streams does not make its next report walk.

Three things still walk the whole ledger once:

- a ledger read from disk;
- a change to a request older than the tail, such as a replay carrying a later snapshot of an old request;
- a new key JavaScript would order ahead of the others. No request key Sotto writes is such a key.

Telling a replayed Codex or Grok report from a new one checks a set of the keys the thread saw, made once, rather than
scanning them all. What a ledger holds, and its file, are unchanged.

## Before and after

| One usage report | Before | After |
| --- | ---: | ---: |
| Claude, newest request of a thread of 1,800 requests | 0.547 ms | 0.006 ms |
| Claude, 10,000 requests | 3.580 ms | 0.007 ms |
| Claude, 40,000 requests | 22.634 ms | 0.006 ms |
| Codex, replayed report on a thread of 1,800 turns | 0.012 ms | 0.006 ms |
| Codex, 10,000 turns | 0.048 ms | 0.012 ms |
| Codex, 40,000 turns | 0.173 ms | 0.035 ms |

The Codex figures after include making the thread's set of keys once, spread over the 200 reports timed.

At about ten reports a second while a reply streams, a 10,000-request thread spent 36 ms of main's time a second on its
totals, and a 40,000-request thread 226 ms. Both now spend under 0.1 ms.

## The guards

- `tests/perf/usageLedgerReport.perf.test.ts`, in the default suite:
  - 200 reports on a 5,000-request thread's streaming reply walk none of its requests, and neither do 200 more after a
    replay added 50 requests behind it (on `bde56ebfe`, 200 walks);
  - 200 replayed Codex reports and one new one on a 5,000-turn thread scan none of the keys it saw (on `bde56ebfe`, 200).
- `tests/unit/main/nativeUsageRunningTotals.test.ts`: 400 seeded steps of new, growing and replayed requests, priced and
  unpriced, some growing behind requests a replay added, some with keys JavaScript orders first. After every 50 steps
  the thread's totals equal what the walk written out in the test makes of the requests in its file, and the money
  equals it to the last bit.

The ledger's growth on disk, and the write of a long thread's ledger once a second while it streams, are #1938's.
