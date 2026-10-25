# History saves that do not wait for the disk - October 19, 2026

A live profile of the installed Owl build (`v0.1.38-owl.20261019.2`) while several threads ran showed main's thread held
by two history saves: 426 ms in one usage commit (`UsageStore.observeTokens`) and 345 ms in one activity commit
(`ThreadStore.syncActivitiesMany`). Main's thread is the window's UI thread, so a stall there delays keystrokes. Both
stores ran WAL at `synchronous=FULL`, against a 514 MB `threads.sqlite` and a 263 MB `usage.sqlite`, each with its log
at SQLite's 4 MB automatic checkpoint size. Zach chose to let saves stop waiting for the disk (ADR-0016, October 19
amendment). This note measures what that changes.

## How it was measured

`tests/perf/historySaveSync.perf.test.ts` fills a real `threads.sqlite` with synthetic messages to 547 MB, then times
600 `appendMany` calls of six messages each, about what one 16 ms publish window commits for a few streaming threads.
It runs once at `FULL` and once at `NORMAL`, and reads SQLite's shared-memory header around each commit to tell the
commits that ran an automatic checkpoint from those that did not. Every word is random; no user profile is opened.

```powershell
$env:SOTTO_PERF_BENCH = '1'; $env:SOTTO_PERF_STORE_MIB = '514'
npx vitest run tests/perf/historySaveSync.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

Taken on the Windows development laptop (Node v24.14.1, Windows Defender on), three runs.

## Results

| Setting | Median commit | p95 | Worst | Commits over 50 ms | Checkpoints | Checkpoint commit median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `FULL` (before) | 1.06 to 2.13 ms | 1.6 to 25.9 ms | 12.1 to 54.3 ms | 0 to 1 | 11 | 10.6 to 13.4 ms |
| `NORMAL` (after) | 0.17 to 0.20 ms | 0.3 to 0.4 ms | 17.7 to 32.1 ms | 0 | 9 | 14.9 to 22.5 ms |

An ordinary commit no longer waits for the disk, and it is five to ten times shorter. The slowest ordinary commits at
`FULL` were the disk's flush tail, and that tail is gone. A commit that runs SQLite's automatic checkpoint still flushes
the log and the file, so it costs about the same at either setting.

This benchmark did not reproduce the 300 to 400 ms stalls of the live profile. An earlier harness on a store of the same
size, at `FULL`, measured checkpoint commits at 94 to 112 ms at the median and up to 256 ms, and commits without a
checkpoint up to 417 ms. The live stalls likely depend on what this synthetic store lacks: a file in use for months,
activity rewrites with `secure_delete` overwriting freed pages, and the disk shared with everything else the laptop
runs. The next Owl build's profile is the measure of what this change does there.

## What was tried and dropped

A worker thread that ran PASSIVE checkpoints on its own connection, with main's connections at
`wal_autocheckpoint=0`, was built and measured. While threads stream, main commits in every 16 ms publish window,
which is sooner than a checkpoint can flush a large file. So the passive checkpoint never caught up, and the log never
started over: it reached 18,000 pages (74 MB) in 2,000 commits. Catching up would take a FULL or RESTART checkpoint,
which blocks main's next commit for the same flush, or a fallback to inline checkpoints while streaming, when the
stalls happen. ADR-0016's October 19 amendment records the decision and what a power cut can now lose.

October 23, 2026: the worker came back, with a RESTART checkpoint once the log passes 16 MB, after a profile of the
owner's build caught a 1.19 s commit running SQLite's checkpoint on main (#1451). The RESTART holds main's next save
only while it copies and flushes what the passive checkpoint just before it left, not the whole log. `2026-10-23-checkpoints-off-main.md`
has the figures.
