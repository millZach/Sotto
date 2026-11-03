# Each thread's usage ledger in a file of its own - October 30, 2026

Measured with `tests/perf/usageStreamWrites.perf.test.ts`. It seeds a Claude usage ledger of forty threads with six
hundred requests each, 3.8 MB in the one file earlier builds kept, then in a fresh process streams a reply on one thread,
150 output counts 20 ms apart and then the turn's end, and counts every synced write of the ledger and its bytes, and the
process's CPU. It runs the commit this change started from (`6ebcc2599`) and the working tree, four runs each, alternated,
and reports each one's medians.

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/usageStreamWrites.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

It prints `usage-stream-writes` for `before` and `after`. Both start the reply one write interval after loading, since
moving the one file across makes a write at load in the working tree.

## What it cost

The ledger was written about once a second while the reply streamed, and each write synced the whole file: every thread's
every request, for one thread's change.

## The change

Each thread's ledger is a file of its own in `claude-usage/` (and `codex-usage/`, `grok-usage/`), and a write writes the
threads that changed (ADR-0083, October 30 amendment). The one file of earlier builds is read at start and moved across.

## Before and after

Three rounds on forge, each the median of four runs.

| One streamed reply | Before | After |
| --- | ---: | ---: |
| Synced writes of the ledger | 5 | 5 |
| Bytes written | 19,004,865 | 473,680 |
| A write | about 3.80 MB | about 95 KB |
| The process's CPU | 107.4-117.5 ms | 87.2-100.1 ms |

The bytes were the same in every round. On forge's host the shared file was 2.4 MB and on the owner's computer 12.7 MB,
so each write there fell from that to the streaming thread's own ledger: a median of 35 KB on forge's host, and 371 KB for
its largest.

## The guards

- `tests/perf/usageLedgerEncodeBudget.perf.test.ts`, in the default suite: each write while a reply streams encodes and
  writes the streaming thread's ledger alone, under a twentieth of all forty ledgers, and every thread's file holds its
  ledger whole.
- `tests/unit/main/nativeUsagePersistence.test.ts`:
  - only the thread that changed is serialized and written;
  - an earlier build's one file is moved across, stays while a ledger has not reached its own file, and is removed once
    every one has;
  - failures stay visible per thread until a later write lands, writes coalesce while one is in flight, and a streaming
    reply is written at most once an interval and at once at its turn's end, as before.

- `tests/unit/main/nativeUsagePersistence.test.ts` also holds that at most eight threads' files are written at once, and
  that the threads' folder is synced before an earlier build's one file is removed.

`tests/e2e/native-usage-persistence.spec.ts` holds the ledger's writes while Sotto quits; it now holds each thread's own
file. It did not open its window on forge under Xvfb, on main as with this change, so it was not run here.

## What it leaves

A thread's ledger is still read at start, every thread's, since the thread list shows each one's usage from its ledger;
loading a thread's requests only when it first reports usage would need the totals kept apart from the requests.

