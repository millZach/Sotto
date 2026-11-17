# Two reads of the thread store off main's way (November 17, 2026)

Zach's main stopped for 4.3 s at 22:11:10 UTC on Owl 0.1.43-owl.20261117.1, on the Windows laptop. This note names what
the hang recording shows, what was measured, what changed, and what it does not explain.

## What the recording shows

`performance-recordings/sotto-hang-2026-11-17-14-11-10/hang.json` holds two stacks:

- **At 1.42 s**, inside an `observe-threads` command (a pane opened or changed): `commandShell` → `observe` →
  `observeThreads` → `publish` → `applyEvents` → `markWatcherReplies` → `markOwnChanges` → `readWindow` →
  `readMessages`. The pause landed just as the window's `SELECT * FROM messages ...` returned.
- **At 4.26 s**: `threadPrompts` → `promptsBefore` → `statement`, the message scrubber's read for the pane that opened.
  The hang watch asked for this stack about 2.4 s in, and it landed only at 4.26 s, at the first function entry after the
  query before it (`... role = 'user' AND position < ? ... OFFSET 49`) returned. Main ran no JavaScript in between, so
  that one SQLite read held main at least 1.8 s.

Neither stack is a provider start. Pi was not involved.

## What was measured

All on the laptop, on a copy of the owner's store (`VACUUM INTO` from a read-only connection: 888 threads, 1.5 GB),
never on the live file.

| What | Time |
| --- | --- |
| The scrubber's slow query above, on the six largest threads | 0.1 ms |
| `promptsBefore` whole, on the same threads | 1 to 20 ms |
| Watcher's window read (10 turns, 25 rows) | 0.1 to 0.5 ms |
| The workspace's whole `observeThreads` for a thread, Watcher on | 35 to 150 ms |
| Main's reads while another connection wrote 16 MB and checkpointed (PASSIVE or RESTART) | 48 ms at worst |

So the code is not slow at the owner's size, and a checkpoint racing main's reads did not reproduce the stall: at
22:11:10 the live file answered main slowly, for a reason the recording cannot see. Main's connection is opened with a
5 s busy timeout, so a read that meets a lock can wait inside SQLite, where no stack can be taken. That fits, but it was
not reproduced. A 25-minute probe of main's event loop afterwards (14,488 requests to its local tool server, 22:20 to
22:45 UTC) saw no stop over 254 ms.

## What changed

1. **The scrubber's read runs on the store worker** (`read-prompts`, ADR-0016's November 17 amendment), behind every
   write posted before it. A slow store now holds the worker and the scrubber's marks, not the window.
2. **Watcher's window is read again only once something of Watcher's changed.** Out of view, `markWatcherReplies` read
   it from the store on every publish, for every thread's update. Now a mark that read it holds until a change to the
   Watcher thread (`markChanged`) or an event for it.
3. **Slow reads on main are noted.** Any `get` or `all` on main's connection that takes 250 ms or more is appended to
   `store-read-diagnostics.jsonl` (query and milliseconds, at most 200 lines a run), since main's log reaches no file in
   a packaged build.

## Before and after

`tests/perf/storeReadsOffMain.perf.test.ts`, on the development laptop (Node 24), random words:

| Read | Before | After |
| --- | --- | --- |
| Scrubber read over 2,500 turns, main's busy time per read (median, worst of 25) | 41.2 ms, 57.6 ms | 3.4 ms, 5.9 ms |
| Watcher out of view, 200 publishes for another thread: main per publish (median) | 0.41 ms | 0.04 ms |
| The same: reads of Watcher's window | 200 (1 per publish) | 0 |

The scrubber's "before" is the same run's read on main. Watcher's "before" is the bench run with `workspace.ts` from
`origin/main` (8fcfbdeb5). After the change, the scrubber read's wall time is about the same (48 ms); main's share of it
is the answer's structured-clone receive.

To run it:

    PowerShell:  $env:SOTTO_PERF_BENCH = '1'; npx vitest run tests/perf/storeReadsOffMain.perf.test.ts --maxWorkers=1 --disable-console-intercept

## Guards in the default run

- `tests/integration/workspaceStoreWorker.test.ts`, "reads the message scrubber's prompts on the worker rather than on
  main": main's `promptsBefore` is never called while the worker runs, and once the worker has gone it is called once.
  On the old code main's is called: it fails.
- `tests/integration/watcherOwnChangeHistory.test.ts`, "reads Watcher's stored window again only once something of
  Watcher's has changed": ten updates on another thread read Watcher's window 0 times. On the old code they read it 10
  times: it fails.
- `tests/unit/main/slowStoreReads.test.ts`: a read past the threshold is named by its query, never its values.

## The other stops of 1 s or more that day, left for follow-ups

| Local time | Stop | Stack |
| --- | --- | --- |
| 11:13 | 1.5 s | Worktree cleanup's sweep: `sweepWorktrees` → `eligible` → `workspaceSnapshot` → `cloneHostSnapshot`. Each worktree thread it checks clones the whole snapshot twice. |
| 12:30 | 1.6 s | At start: `restore` → `restoreCheckpoint` → `checkpointIdentity` → `observationDigest` → `digest`. |
| 13:12 | 5.6 s | No stack: main was in native code for the whole stop. |
| 14:11 | 4.3 s | This note. |
