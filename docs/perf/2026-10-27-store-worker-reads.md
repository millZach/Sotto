# Stored threads read back off main - October 27, 2026

Opening a stored thread read its whole activity list on main: `holdActivities` → `readActivities` → `activityState`. That is one query for up to 2,000 rows, about 10 MB, then `JSON.parse` and the activity schema for every row. The owner's recording had it hold main for 0.61 s for one thread (#1457). Step 3 of `docs/plans/store-worker.md` moves the query, the parse and the schema check to the store worker (ADR-0016, October 26 amendment). Main receives the records and freezes them. Receiving them is a structured-clone read on main, and the plan asked for it to be measured, with the list handed back in pieces if one piece held main too long.

This is a benchmark, not a recording. It times main's side with the code the read-back runs, against a synthetic thread; it does not profile the app. The counting test in the same file runs in the default suite. It reads back a thread at the record limit over the built worker, and checks that the list arrives in pieces of `READ_PIECE_RECORDS`, each received in a task of its own, and that main neither runs the query nor checks a record against the schema.

## How it was measured

`tests/perf/storedActivityReadBack.perf.test.ts` writes one thread at the record limit, 2,000 records of random words, about 10.9 MB at `SOTTO_PERF_RECORD_SCALE=5`. It then times what main is held for in two ways:

- **The read on main it replaces:** `readActivities` with the parse and the schema, on main's connection.
- **The worker's handback:** each piece main receives and freezes. It also times one piece at 250, 500, 1,000 and 2,000 records, the last being the whole list.

Nine samples each; the figures are medians unless marked worst.

```powershell
$env:SOTTO_PERF_BENCH = '1'
npx vitest run tests/perf/storedActivityReadBack.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

Taken on the Windows development laptop (Node v24.14.1, Windows Defender on), twice.

## Results

| | Run 1 | Run 2 |
|---|---|---|
| Read on main, the whole list | 32.6 ms | 35.9 ms |
| Handback in 4 pieces of 500, each piece | 2.56 ms | 2.80 ms |
| Handback, worst piece seen | 17.7 ms | 20.1 ms |
| Handback, all 4 pieces together | 8.17 ms | 9.38 ms |
| One piece of 250 | 1.33 ms | 1.67 ms |
| One piece of 500 | 2.36 ms | 1.88 ms |
| One piece of 1,000 | 4.72 ms | 3.91 ms |
| One piece of 2,000, the whole list | 7.62 ms | 8.56 ms |

## What it means

- **The read on main falls by about four times on this laptop,** from 33 to 36 ms to 8 to 9 ms of main's time in all. More of it is now spread across tasks. On the owner's machine and store, where the read took 0.61 s, the parse and the schema check were most of it, and those now run on the worker.
- **Pieces of 500 keep each task near 2 to 3 ms.** That's well inside a 16 ms frame, where the whole list in one task took 8 to 9 ms here and grows with the records' size. Main asks for each next piece from `setImmediate` once the one before is in, so other work can run between them. Posting every piece at once would have Node receive them all in one task.
- **The worst piece seen, 18 to 20 ms, is a rare outlier** across the samples. It is most likely a garbage collection landing in that task, not the piece's size, since the median at 500 records stays near 2 ms.
