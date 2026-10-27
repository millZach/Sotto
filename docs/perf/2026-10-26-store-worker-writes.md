# Thread-store writes off main - October 26, 2026

After the log's checkpoints moved off main (`2026-10-23-checkpoints-off-main.md`), main still committed every thread-history
write itself, inside the publish: 0.65 s of a minute at 16:54 on October 23 (0.1.41-owl.20261023.5), with single saves
held up to about 0.85 s while another thread flushed a large file on the same disk (#1457). Step 2 of
`docs/plans/store-worker.md` moves every write to the store worker, and main's connection only reads (ADR-0016,
October 26 amendment). This note measures what a save holds main for, before and after.

This is a benchmark, not a recording. It times main's side of each save with the code the publish runs, against a large
synthetic store; it does not profile the app. What shows no SQLite write inside `publishNow` is the counting test in the
same file, which runs in the default suite: it streams past SQLite's checkpoint threshold through the writer the
workspace uses, with main's connection read only (`query_only`) throughout, so a write on main would have thrown.

## How it was measured

`tests/perf/threadStoreWorker.perf.test.ts` fills a real `threads.sqlite` with random words and activity records, then
makes 2,000 saves at a 16 ms pace, as a publish makes them: four threads' events every step, and every fifteenth step an
activity save that rewrites each thread's newest large record (20 to 60 KB). After each save it reads the watched
thread's window, forty messages, with what is posted laid over it, inside one read transaction. "Save" is the time from
the post to its return on main, where the writer on main also commits; "read" is the window. It runs twice with the
writer on main and twice with the worker, alternating.

```powershell
$env:SOTTO_PERF_BENCH = '1'; $env:SOTTO_PERF_STORE_MIB = '512'
npx vitest run tests/perf/threadStoreWorker.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

Taken on the Windows development laptop (Node v24.14.1, Windows Defender on), on a 555 MB store.

## Results

| Writer | Median save | p99 | Worst | Saves over 16 ms | Over 100 ms | Saves in all | Median read | Reads in all |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| On main (before) | 0.64 to 0.68 ms | 29 to 65 ms | 36 to 125 ms | 59 to 64 | 0 to 4 | 3.6 to 5.4 s | 0.20 to 0.21 ms | 0.44 to 0.46 s |
| The store worker (after) | 0.31 ms | 2.8 ms | 4.1 to 4.7 ms | 0 | 0 | 0.87 to 0.88 s | 0.36 to 0.37 ms | 0.79 to 0.80 s |

Main is held by saves for about a fifth of the time it was, and no save holds it for a frame: the worst is under 5 ms,
where it was up to 125 ms. What is left of a save on main is the copy of what is posted to the worker; the largest are
the activity saves, which now cross as the records that changed rather than the whole list. The read costs main a
little more, about 0.15 ms each: it opens a read transaction, and checks which posted writes the file already holds.
Taken together, main spent 1.7 s in 2,000 steps where it spent 4.1 to 5.9 s.

The log grows a little further, up to 6.6 MB against 4.4 MB, since the worker checkpoints between its writes rather
than inside them; with no other writer, its passive checkpoint catches up and the log starts over as it goes.
