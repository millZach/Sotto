# Watcher's record stopped shrinking: stopped threads kept every request (November 12, 2026)

Zach reported two freezes of about 1.7 s on Owl 0.1.43-owl.20261112.1, both on clicking into Watcher's composer: one just
after Sotto updated and restarted, one after a new Watcher replaced a long one. This note records what was measured on
his Windows laptop, what the measurements showed, and what they did not.

## What Sotto recorded

Record a minute, pressed at 17:47:59 UTC, kept the minute before it as numbers: main was blocked for 11% of it, with ten
freezes over 100 ms, the longest 1,935 ms at about 17:47:29 and another of about 1,840 ms at about 17:47:53. The window's
profile of the minute after is quiet, so the freezes were in main. The recorded minute holds neither freeze, so there is
no stack for them: the watch that takes one waits for five seconds without an answer (ADR-0098).

In the recorded minute main was busy 27% of the time. The largest single cost was Watcher's reconcile with the paired
host, 5.7 s of the minute, which searches the record's requests and operations on every push.

## What was wrong

Watcher's live record was 5.8 MB: 3,264 requests, 2,064 operations and 1,610 prompt turns. The archive (ADR-0073,
October 28) is meant to leave the newest 200 closed requests and what something still names. Of 3,206 closed or stopped
requests, 3,036 were held by one rule: a participation still taking part with its automation stopped. Stop watching and
Watcher's Stop mark every request a thread took part in, so every request of a stopped thread stayed, across 327
threads, 417 requests for the one with most. Only 38 requests were due, fewer than a batch, so nothing had been archived
since November 10, and the record gained 534 requests that day and 767 the next.

Every change to the record copies it, compares it, checks it against its schema, freezes it and serializes it.

## Measurements

All on the laptop, on the record as it stood at about 18:25 UTC. Nothing was written to Sotto's data.

| | Before | After |
|---|---|---|
| Requests in the live record | 3,264 | 697 |
| Operations | 2,064 | 700 |
| The record as JSON | 5.8 MB | 2.3 MB |
| One change to the record (copy, compare, check, freeze, serialize), median of 7 | 83 ms | 21 ms |
| A message to Watcher and its reply: main blocked in all | 410 to 616 ms | 241 to 263 ms |
| New Watcher: main blocked in all | 443 to 468 ms | 142 to 149 ms |
| The first message to the new Watcher: main blocked in all | 552 to 579 ms | 193 to 217 ms |
| Watcher's recovery at start: main blocked in all | 129 to 149 ms | 56 to 59 ms |

"After" is the same record with the requests the new rule lets go taken out by `removeArchivedWork`: 2,567 of them. The
last four rows are two runs each of the real `WatcherService` and coordinator over the fake providers, with the record's
requests, operations and history laid into the fixture's record, timed by a 5 ms timer's lateness as main's own monitor
times a freeze. The world around the record is a test's, a few threads and no paired host, so these are what the record
alone costs. Sotto's own recording agrees where the two can be compared: about 390 ms blocked across the real message
to Watcher at 17:47:38.

## What this does not show

No step measured blocks main for 1.9 s. The two freezes fall 7 s after the new Watcher was made and 15 s after its first
message, and nothing found says what ran at those instants. Ruled out by measurement: the handover of the last
conversation (15 to 29 ms on the real 2,220 messages), the checkpoint file (30 MB; 223 ms at start and about 100 ms for
each whole rewrite), and a new Codex thread starting, with and without its own worktree (no block of 150 ms or more).
The next freeze of a second or more is to leave a stack of its own (ADR-0098's amendment of the same day).

## Guards

- `tests/unit/main/watcherArchive.test.ts`: the newest request recording each thread's stop stays and the older go; a
  record of 3,000 stopped requests over 300 threads comes down to its newest 200 and one for each other thread, with
  every thread's queue held as before.
- `tests/perf/ownerScaleWorkBudget.perf.test.ts`: the fixture's Watcher history now leaves each request's thread
  stopped, as the owner's record does. With the old rule its long Watcher record archives nothing and the test fails.

## Found on the way, not changed here

- The checkpoint file holds 13,354 records, 9,444 of them from Watcher conversations whose folder Git cannot list, so no
  checkpoint was ever taken for them.
- Each reconcile with the paired host searches every request and operation for each one the host names, and copies the
  configuration once for each stopped request.
- The worktree sweep copies the whole thread list once for each thread it looks at.
- Keep main up to date's pass blocked main for 553 ms once, at 18:15:16 UTC.
