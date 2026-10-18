# Copy budget — October 15, 2026

Main's update path runs on every streamed chunk, for every thread. In October 2026 it came to spend most of its time
copying state. A live profile of the owner's Owl build, with 232 threads, showed main's JavaScript thread busy 82% of
the time over five and a half minutes, with 1,032 stretches of 100 ms or more without a break, the longest 1.5 seconds.
Deep copies were 47% of main's time. Typing lagged because main could not answer the window.

Three copies were new or had become hot, and none came from a performance change:

- Watcher's observe pass copied the Watcher record about three times per thread on every update (#1038), about 21% of
  main.
- The host-update pill asked which threads keep a host busy by rebuilding every host's shell, twice per waiting host per
  change, about 17% of main while a saved host ran an older Sotto.
- The local host forwarded a fresh full shell to the router for every Watcher publish, which follows every coordinator
  broadcast.

Each looked harmless where it was written, and cost nothing with a few threads. Timing checks are opt-in because they
are flaky, so nothing in CI noticed.

## The guards

Two checks run in every CI run. They count calls; they never time anything.

- `tests/perf/streamingCopyBudget.perf.test.ts` runs the update path as `src/main/index.ts` wires it: an event-sourced
  adapter, the provider switch, the workspace, the coordinator, Watcher on Owl, the local host service, the desktop
  router, the window's publisher and broadcaster, the Watcher room's publisher, and the host-update busy check with one
  saved host on an older Sotto. On Owl, Watcher is open and watching the streaming thread. It streams one reply with
  20 threads and with 200, and counts every `structuredClone`, `cloneHostSnapshot`, `clonePlainData` and
  `cloneActivitySnapshot` call, which of them copy the whole state, and which copy Watcher's record. It fails when one
  update copies more with 200 threads than with 20, or when an update passes its budget.
- `tests/unit/main/copySites.test.ts` counts every copy call site in `src/main` and `src/host` (`structuredClone(`,
  `.shell()`, `watcherRecord()`, `cloneHostSnapshot(`, `clonePlainData(`, `cloneActivitySnapshot(` and JSON round trips) per file, and
  fails when the count differs from `tests/fixtures/copySites.json`. A new copy shows up in review that way.

`tests/e2e/main-freeze.spec.ts` is the timing side, opt-in like the other benchmarks: it measures main's freezes and the
composer's keystroke latency in the built app while threads stream (`docs/perf/2026-10-15-main-freeze.md`).

## Numbers

Per coordinator update while one thread streams, with Watcher open and watching that thread on Owl:

| | Copies, 20 threads | Copies, 200 threads | Whole-state copies |
| --- | ---: | ---: | ---: |
| Owl before the fixes | 95.5 | 635.5 | 7.9 |
| Owl after | 20.5 | 20.5 | 2.9 |
| Stable before | 12.9 | 12.9 | 5.0 |
| Stable after | 8.9 | 8.9 | 2.95 |

Three runs after the fixes gave the same counts to two decimals. The whole-state copies left are the coordinator's shell
for the broadcast and the workspace's activity snapshots; sharing unchanged threads through those layers is #925's.

The budgets are 14.5 copies, 3.5 whole-state copies and 1.5 copies of Watcher's record per update on Owl, and 10.5,
3.5 and none on stable. They only tighten: a change that lowers a count lowers its budget in the same PR, and a change
that needs more copies on this path asks Zach first. The October 17 Watcher recovery follow-up removed two copies per
Owl update (matched parent 21.4, candidate 19.4), and its budget fell by two.

### October 17: Watcher's record

The owner's Owl 0.1.38-owl.20261017.1 lagged again while threads streamed. A 30-second profile of the running app had
main busy 66% of the time, with `structuredClone` alone 18%. Most of that was Watcher's record, copied 11 times per
update: eight copies only to read it, in the room state, the wake-up's workers, the watched-thread list, the pause check
and the remote-guard prune, and three in the observe pass's changes, each of which also checked the whole record
against its schema and usually changed nothing.

The thread count does not change this cost; the record's size does, and the record grows with use. It keeps every prompt
turn Watcher has been sent, up to 10,000, and the last 1,000 wake-up event IDs. The owner's was 373 KB, with 513 prompt
turns and 535 wake-up IDs. One copy of it took 1.7 ms and one schema check 2.5 ms, so the record alone cost main about
26 ms per update. The Owl builds of October 16 and 17 measure the same: the lag had grown with the record, not with
either build.

The record is replaced on every change and never edited, so the readers now use it without a copy. The room state is
the exception: its readers may change what they are given, so it copies the records it hands out (current, history,
requests, standing watches and operations) and reads the rest, most of the record, in place. The observe pass
changes the record only when the record does not already hold the change, and a change that leaves the record equal
skips the schema check and keeps the record it had. With 230 threads and a record of the owner's shape (180 KB), main's
CPU per streamed chunk went from 52–56 ms to 29–37 ms, and copying from about 18 ms to under 5 ms per update:

| Owl, per update | Copies | Copies of Watcher's record |
| --- | ---: | ---: |
| Owl 20261017.1 | 20.5 | 11 |
| Main after the Watcher recovery follow-up | 19.4 | 7 |
| After | 12.4 | 1 |

The copy left is the operations change in the observe pass, which still copies the record once per update to find out
whether anything changed. The count is of copies of the record object itself. The window's Watcher room still copies
the room state for each publication, and that state carries the record's requests, operations and standing watches; the
total copy budget counts it, but its size is not measured.

That last copy stays, made cheaper rather than removed. Removing it would mean deciding whether the operations change
does anything without running it, a second copy of its rules that would have to stay true to the first; a missed
change there is lost silently. Instead the record is smaller and cheaper to copy:

- Owl keeps only the prompt turns something reads: those an operation counts against, each Watcher's newest, and the
  50 most recent. The rest go on the next change to the record; the owner's 513 turns become about 50. Turns an
  operation counts against are always kept, so a Watcher that acts in most of its turns keeps more. Stable keeps the
  record whole (ADR-0072).
- The record is copied as plain schema data, its containers copied and its strings kept, as host snapshots already are, and so
  are the records the room state hands out.

Measured in one run on a busy machine, a copy of the owner's record took 3.4 ms with `structuredClone` and 0.66 ms as
plain data, and a copy with 60 turns 1.2 ms and 0.35 ms. `copySites.test.ts` counts the new copier, and the budget's record count follows either copier.

### October 18: Watcher's pass and the shell

The owner's Owl 0.1.38-owl.20261018.1, with both changes above, still lagged while threads worked. A 30-second profile
had main busy 96% of the time and an event-loop delay of 68 ms on average, 406 ms at worst. Watcher's record no
longer showed. What did was work done on each coordinator update, which comes up to every 16 ms while threads stream:

| Work on each update | Share of main |
| --- | --- |
| Watcher's wake-up pass over every thread | 19% |
| The coordinator's shell, copied with `structuredClone` | 13% |
| Activity snapshots, copied and published | about 29% |
| The window's same-content check | 9% |

The wake-up pass now runs at once only when something it reacts to moves: a thread's status or last turn, its request
cards, its background work, its connection, or the Watcher record. A turn that finishes as the next one starts is seen
only in the update between them, so those never wait. Otherwise, as while a thread streams, it runs at most every 250 ms
and once more after the last update; news waits two seconds before it goes in any case. With 150 paired threads, where
one pass took about 70 ms, three seconds of updates every 16 ms ran 29 passes and spent 71% of main in Watcher's
publish before, and 13 passes and 19% after. The shell is copied as plain data, as the record is. The activity
snapshots and the window's check are left for a later change.

## When a guard goes red

Read the failure: it says what grew, with the measured numbers. Move the copy off the update path, or read the state
without copying it. The copy-site list is different: a new copy that runs only for a command or a read is fine there.
Say why in the PR and rewrite the list:

```powershell
$env:SOTTO_UPDATE_COPY_SITES = '1'; npx vitest run tests/unit/main/copySites.test.ts
```
