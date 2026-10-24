# Log checkpoints off main - October 23, 2026

A one-minute profile of main on the owner's Owl build (`0.1.38-owl.20261023.3`, Windows, after 3 h 17 min of running)
had its longest freeze, 1.19 s, inside a publish: `activityPublication` → `applyEvents` → `writeEvents` →
`ThreadStore.appendBatchesNow`, with 1.08 s in native code directly under the commit (#1451). `threads.sqlite` was
860 MB, in WAL at `synchronous=NORMAL` with `secure_delete=ON` and SQLite's automatic checkpoint. At NORMAL a commit
does not wait for the disk, except the one that grows the log past 1,000 pages: SQLite runs the checkpoint inside it,
flushing the log, copying its pages into the file and flushing the file, on main. This note checks that explanation and
measures moving the checkpoint to a worker thread (ADR-0016, October 23 amendment).

## Checking the explanation

`tests/integration/walCheckpointer.test.ts` reads SQLite's write-ahead log index around each save. Without the worker,
the saves that grow the log past its threshold put pages into the file themselves: the checkpoint runs inside the
commit. With the worker held aside, 400 saves grow the log past 1,000 pages and none does.

On a synthetic 861 MB store shaped like the owner's (activity records up to 78 KB, `secure_delete` on, a few threads
appending events every 16 ms and rewriting large records every quarter second), the commits that ran SQLite's
checkpoint held main for 0.15 to 0.86 s on an otherwise quiet disk and up to 7 s while the disk was still writing out the store,
against 0.3 ms at the median for every other commit. That is the 1.19 s freeze's shape.

## How it was measured

`tests/perf/historyCheckpointOffMain.perf.test.ts` fills a real `threads.sqlite` with random words and activity records,
then makes 2,134 saves at a 16 ms pace: four threads' events every step and every fifteenth step an activity save that
rewrites each thread's newest large record. It runs twice with SQLite's own checkpoint and twice with the worker's,
alternating, and reports each save's time on main. "Held" adds up every save over 16 ms, a frame.

```powershell
$env:SOTTO_PERF_BENCH = '1'; $env:SOTTO_PERF_STORE_MIB = '512'
npx vitest run tests/perf/historyCheckpointOffMain.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

Taken on the Windows development laptop (Node v24.14.1, Windows Defender on, the system disk 95% full), on a 555 MB store.

## Results

| Checkpoint | Median save | p99 | Worst | Saves over 16 ms | Over 100 ms | Held | Largest log |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| SQLite's, inside the save (before) | 0.8 to 1.0 ms | 48 to 56 ms | 1.24 to 2.22 s | 62 to 67 | 7 to 9 | 6.2 to 10.0 s | 4.4 MB |
| The worker's (after) | 0.8 to 0.9 ms | 16 to 59 ms | 0.65 to 0.85 s | 22 to 41 | 4 to 8 | 2.2 to 3.7 s | 21.8 MB |

No save on main runs a checkpoint any more, and the time main spends held by saves fell to about a third, the worst
save to under half. The log grows past SQLite's 4 MB while saves keep coming, up to the 16 MB at which the worker
runs a RESTART, and starts over at the save after it.

It is not the whole of #1451's first expectation, no disk wait on main longer than a frame or two. Main still writes its
saves to the log on its own thread, and on this laptop a write on one thread waits while another thread flushes a
large file on the same disk: a plain 16 KB write, with no SQLite in it, took up to 529 ms while a worker flushed 4 MB
of random pages into a 900 MB file. So main's saves still pay for the worker's flushes now and then, in smaller and
fewer pieces. Taking those waits off main means taking the saves off main, which this change does not do.

## The worker that was dropped on October 19

That worker ran PASSIVE checkpoints only, and while main committed in every publish window a passive checkpoint never
caught up, so the log never started over (74 MB in 2,000 commits). This one adds a RESTART once the log holds 4,096
pages. The RESTART holds main's next save while it copies and flushes the pages the passive checkpoint just before it
left, which is far less than the whole log. That puts the whole log in the file, and the save after it starts the log
over, as SQLite does whenever a save finds the log all in the file.

A run of the benchmark with the RESTART turned off reproduced the October 19 finding, the log reaching 122 to 230 MB,
and held main no less: 3.4 to 6.1 s held and a worst save of 0.28 to 0.73 s, beside 15.0 to 16.0 s held with SQLite's
own checkpoint in the same run. The RESTART's integration test, with a restart size of 200 pages, makes one save for
each of the worker's passes as the pass starts, and the log never held more than 220 pages on Windows or Linux.
