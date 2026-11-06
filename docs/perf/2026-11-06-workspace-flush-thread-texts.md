# The workspace flush keeps each thread's text - November 6, 2026

Issue #1332, the workspace's part. Every write window, the flush serialized the whole organization record, every thread
in it, only to compare the string with the text it last wrote. Most windows change nothing saved, and the rest change a
thread or two. A one-minute recording of main on the owner's machine put this at about 1.3 s.

## What changed

- **Each thread's text is kept.** The flush keeps the text it made for each thread, with the record it was made from and
  whether local history was on. A thread is serialized again only when the workspace marked it since (the same marks the
  publication and the store save read), another record took its place, or local history was turned on or off. The
  threads' texts are spliced into the organization's at a placeholder, as the catalog's already were (#991).
- **What reaches the disk is the same.** The spliced text is the same, byte for byte, as serializing the whole saved
  state, and it is compared with the last text written exactly as before, so no write is skipped or added. With
  `SOTTO_VERIFY_THREAD_CHANGES=1` every flush also serializes the whole state and fails if the two differ.
- **Every thread is serialized again** after the file is read, while the store is unavailable and records ride in the
  file, and on the first save after either.

## How it was measured

`tests/perf/workspaceFlush.perf.test.ts`, now with 250 threads that each carry a worktree, as the owner's do, and a count
of the characters `JSON.stringify` made during each flush. "Before" is `origin/main` at `52e41729a` with the same
benchmark. Taken on forge (Linux, Node v26.8.1) with other jobs running, three runs each, medians of 15 flushes.

| | Before (three runs) | After (three runs) |
| --- | ---: | ---: |
| Flush, organization unchanged | 0.51, 0.49, 0.48 ms | 0.25, 0.24, 0.25 ms |
| Flush, one thread's usage moved | 5.02, 5.23, 4.99 ms | 4.99, 4.87, 4.61 ms |
| Characters serialized, unchanged | 221,104 | 612 |
| Characters serialized, one thread moved | 221,105 | 1,488 |
| `workspace.json` | 496,376 bytes | 496,376 bytes |

The unchanged flush takes half the time and serializes none of the threads. The flush that writes is the write itself
now; its serializing fell from the whole file to one thread and the organization around the threads.

## Not in this change

The issue's third part, `isDeepStrictEqual` in the thread store's `planActivitySync`, runs on the store worker since
`4e702ef16` (October 26), not on main, so it no longer freezes main.

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/workspaceFlush.perf.test.ts --maxWorkers=1 --disable-console-intercept
npx vitest run tests/unit/main/workspaceThreadTexts.test.ts
```
