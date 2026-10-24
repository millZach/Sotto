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
  `cloneActivitySnapshot` call, which of them copy the whole state, and which copy Watcher's record. Since October 19 it
  also counts the objects every copier makes, per thread per update, and how often an update reads a provider out of a
  public ID. It fails when one
  update copies more with 200 threads than with 20, or when an update passes its budget. Also since October 19, a thread
  the window shows has a wake-up of delegation news no one is shown (ADR-0081), and the guard fails when an update of
  another thread makes that thread's history again without it (`withoutHiddenWakeUps`): it is made again only when its
  own history changes.
- `tests/unit/main/copySites.test.ts` counts every copy call site in `src/main` and `src/host` (`structuredClone(`,
  `.shell()`, `watcherRecord()`, `cloneHostSnapshot(`, `clonePlainData(`, `cloneActivitySnapshot(`, `copyUnshared(` and JSON round trips) per file, and
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
publish before, and 13 passes and 19% after.

Most of a pass was spent on threads Watcher does not watch. They make no news; their facts only answered Watcher's own
reads and marked a long-silent thread Quiet in `list_threads`. No pass looks at them now. Each Watcher read looks at
every thread first, so it reads them as they are; a thread starts from its facts as they are when it becomes watched, so
what it had before is not told as news; and only a watched thread is marked Quiet, since an unwatched one has no history
of its progress. With the same 150 threads and nothing watched, three seconds of updates spent 695 ms in passes before
and 25 ms with a five-second sweep, which was dropped as well (Zach's call, October 18, 2026).

A failed Watcher send that waits in the queue was recorded again on every snapshot with a new time, which replaced the
record each time and would have run the pass on every update. Its time now changes only when its outcome does.

The shell is copied as plain data, as the record is. The activity snapshots and the window's check are left for a later
change.

### October 19: one copy per publication

The owner's Owl build still lagged now and then while several Claude Code threads worked. A 40-second profile of the
installed build had main about 60% busy. What it spent on each update:

| Work on each update | Main's time in 40 s |
| --- | ---: |
| Activity snapshots copied, `cloneActivitySnapshot` | about 4.4 s |
| The coordinator's shell for the broadcast | about 1.8 s |
| `structuredClone` of each remote host's state | about 1.2 s |
| The usage ledger serialized whole | about 1 s |
| Reading a provider out of a public ID, for every thread | about 0.9 s |

The guard above missed most of it, because it counted calls. An adapter's subscribers each took a copy of every thread
inside the module that made it, where no call was seen. The provider switch copied what it had just been handed, and
the workspace made one copy for each of its subscribers. So the guard now also counts the objects each copier makes,
wherever it is called from, and how often an update reads a provider out of a public ID.

What changed:

- A publication is copied once for all its subscribers, who only read it (ADR-0016, October 19 amendment). The switch
  keeps an adapter's publication and hands on its aggregate as they are, and the workspace copies once per publish.
- The shell a broadcast carries shares the coordinator's thread data rather than copying it. A Watcher change is handed
  on with that shell, where it used to make a whole copy.
- A remote host's state is read in place for the router's publication, the host-update check and Watcher's reads, where
  each made a structured clone of it.
- Which held provider a public ID names is read once per ID. It was read for every thread and every catalog model on
  every publish, on Owl too whenever a provider is held there.
- The usage ledger is written with each thread's part kept from the last write unless that thread changed. The file
  reads exactly as before.
- The Watcher room's copy of its state is a plain-data copy rather than a structured clone.

Per coordinator update while one thread streams, with 200 threads:

| | Objects copied per frame | Per thread per update | Copier calls | Whole-state copies | ID reads |
| --- | ---: | ---: | ---: | ---: | ---: |
| Owl before | 4,592 | 40 | 12.4 | 2.9 | 2,383 |
| Owl after | 2,138 | 17 | 11.5 | 1 | 2 |
| Stable before | 5,380 | 43 | 9.9 | 3.0 | 2,452 |
| Stable after | 2,183 | 19 | 8.9 | 1 | 2 |

The "before" numbers were taken with the copier moved where the guard counts it, and nothing else changed. Two runs
after the change gave the same counts within 5%. The new budgets are 21 objects per thread per update and 5 ID reads,
on both tracks. The call budgets fall to 12.5 on Owl and 9.5 on stable, and the whole-state budget to 1.5.

Two copies of every thread are left on each update: the adapter's, where its own records become a publication, and the
workspace's. Sharing a thread that has not changed through those layers as well is #925's. This was measured on the
copy guard's pipeline, not on the owner's machine; the next profile of an Owl build will say what the change is worth
there.

### October 22: a thread that did not change is not copied again

A one-minute profile of 0.1.38-owl.20261021.2 on Windows had main busy for about 30 s of 62. The workspace's publish
took about 3.6 s of that, nearly all of it in `cloneActivitySnapshot`: its full copy (2.3 s) and its certified copy
(1.8 s), so even the path meant to share certified activity copied most of the snapshot. It ran once per provider chunk.

The workspace's activity publication now hands out a thread that has not changed since the last one as the very record
that one carried, frozen and owned, and copies again only what changed, keeping what did not (ADR-0016, October 22
amendment, #1326). The catalog, the projects and the providers are kept the same way. The guards count the new copier,
`copyOver`, as one copy per publication, sized by the objects it made; a record it keeps as it was counts nothing, and a
publication that kept every record is no copy.

Per coordinator update while one thread streams, with 200 threads (the counts move a little with how many broadcasts a
run makes):

| | Objects copied per frame | Per thread per update | Copier calls | Whole-state copies |
| --- | ---: | ---: | ---: | ---: |
| Owl before | 1,347 | 16.8 | 10.4 | 1 |
| Owl after | 607 to 693 | 7.6 to 7.7 | 10.3 to 10.4 | 0 |
| Stable before | 1,511 | 18.9 | 8.9 | 1 |
| Stable after | 661 to 775 | 8.8 to 9.7 | 8.7 to 8.8 | 0 |

The workspace's share of the objects is now about two per frame: the streaming thread's record and what in it changed.
The whole copy became one copy of what changed, so the copier calls stay where they were. The budgets fall to 9 objects
per thread per update on Owl and 11 on stable, and to no whole-state copy; the copier-call budgets stay at 11 and 9.5.
The objects left are almost all the adapter's copy of every thread for its subscribers, which is #925's.

At the owner's scale (`ownerScaleWorkBudget.perf.test.ts`), per update or per action:

| | Objects copied, Owl | Objects copied, stable | Whole-state copies, Owl | Whole-state copies, stable |
| --- | ---: | ---: | ---: | ---: |
| One thread streaming | 8,100 to 5,809 | 4,457 to 2,176 | 1.85 to 0.85 | 1.92 to 0.92 |
| Three threads streaming | 9,995 to 5,903 | 6,190 to 2,106 | 1.85 to 0.85 | 1.85 to 0.85 |
| Saving an answer draft | 25,906 to 8,216 | 30,597 to 12,943 | 4 to 0 | 4 to 0 |
| Typing in a composer | 27,326 to 18,908 | 19,776 to 9,955 | 4 | 5 |
| Opening a thread | 42,446 to 29,819 | 34,859 to 20,829 | 10 | 11 |
| Sending a message | 104,535 to 67,108 | 88,581 to 49,805 | 19 to 13 | 20 to 14 |

No count rose. Every count that fell has its budget lowered to the new count, with the same room. What Owl's copied
objects grow by along the history is unchanged (2,968 per streamed update on one thread, 21,386 per send: Watcher's room,
#1248), but it is now a larger share of a smaller count, so the growth that test holds it to rose with it, from 1.579 to
2.045 times on one streaming thread.

### October 22: with Watcher's room copied once (#1327 and #1326 together)

The numbers above are #1326 alone, and those in `2026-10-22-watcher-room-one-copy.md` are #1327 alone. Together, with
#1330's changed-records broadcast, per coordinator update while one thread streams with 200 threads: Owl makes 9.3 to
9.7 copier calls and copies 7.5 to 8.0 objects per thread, and stable 8.8 to 8.9 calls and 9.7 to 9.8 objects. The
budgets stay at 10 calls and 9 objects per thread on Owl and 9.5 and 11 on stable, since anything tighter is within a
run's spread.

At the owner's scale, Owl's objects copied (before both, #1327 alone, #1326 alone, together):

| | Before | #1327 | #1326 | Together |
| --- | ---: | ---: | ---: | ---: |
| One thread streaming | 8,100 | 6,663 | 5,809 | 4,372 |
| Three threads streaming | 9,995 | 8,558 | 5,903 | 4,466 |
| Saving an answer draft | 25,906 | 23,032 | 8,216 | 5,342 |
| Typing in a composer | 27,326 | 24,452 | 18,908 | 16,034 |
| Opening a thread | 42,446 | 39,572 | 29,819 | 26,945 |
| Sending a message | 104,535 | 97,350 | 67,108 | 59,923 |

Owl's copier calls fall to 9.85 per streamed update on one thread, 15 per answer draft and 136 per send. Stable's counts are #1326's. What Owl's copied objects grow by along the
history is #1327's, 1,896 per streamed update on one thread, as a share of #1326's smaller count: 1.77 times. The reads
of a thread out of a list moved with #1330, whose broadcast walks the threads once to find the records that changed. On
Owl they rose from 6,002 to 6,114 per streamed update, 13,904 to 14,490 per thread opened and 36,561 to 37,733 per
send, and those budgets are today's counts exactly. On stable they fell, for example 13,847 to 13,172 per thread opened
and 25,846 to 24,664 per send, and those budgets fell with them. Both sides count #1350's host router reuse.

### October 23: the shell a broadcast carries is prepared from what changed (#1334)

A recording of the owner's Owl build (0.1.38-owl.20261023.3, main up 3 h 17 min, 44.7 s busy in a 61 s profile) had the
coordinator's `shellOf` at 1.85 s and the rest of `acceptSnapshot` at 2.9 s, about 11% of main's busy time. Every
broadcast copied everything in the shell but the threads, in two `clonePlainData` calls, and made a new record for every
thread.

The broadcast shell now reads what is not threads against the last broadcast's frozen copy (`immutableUpdates`) and
copies only what changed, since the coordinator writes parts of its state in place. A thread whose record, finish and
failure marks and summary display have not moved is listed as the very record the last broadcast listed, frozen. A list
the Watcher filter takes nothing from is kept as it is. `shell()` still copies all of it for a caller that changes what
it is handed. The question pages' decoration no longer makes a new request list for a thread that asks nothing.

With 200 threads and one streaming, per coordinator update: Owl makes 7.3 to 7.8 copier calls, from 9.3 to 9.7, and its
objects per thread stay within their spread of 7.5 to 8.0; stable makes 6.8 to 6.9 calls, from 8.9, and copies 9.2 to
9.4 objects per thread, from 9.5 to 9.8. The budgets are 8.5 calls on Owl and 7.5 on stable, and 10 objects per thread
on stable. The copy-site list loses one `clonePlainData` call in `control.ts`.

At the owner's scale (`ownerScaleWorkBudget.perf.test.ts`, before and after on the same `main`):

| | Owl copies | Owl objects | Stable copies | Stable objects |
| --- | ---: | ---: | ---: | ---: |
| One thread streaming | 9.85 to 7.85 | 4,372 to 4,329 | 9.58 to 7.58 | 2,176 to 2,138 |
| Three threads streaming | 13.62 to 11.62 | 4,466 to 4,421 | 12.69 to 10.69 | 2,106 to 2,066 |
| Saving an answer draft | 15 to 11 | 5,342 to 5,252 | 17 to 13 | 12,943 to 12,863 |
| Typing in a composer | 21 to 13 | 16,034 to 15,894 | 19 to 10 | 9,955 to 9,829 |
| Opening a thread | 34 to 23 | 26,945 to 26,799 | 32 to 20 | 20,829 to 20,697 |
| Sending a message | 136 to 121 | 59,923 to 59,635 | 130 to 114 | 49,805 to 49,546 |

What Owl's copied objects grow by along the history is unchanged, 1,896 per streamed update on one thread, and is now
1.78 times streaming on one thread, so `KNOWN_HISTORY_GROWTH` moves with it.

### October 23: Watcher's room built when its update goes (#1450)

The desktop room no longer builds and copies the room on every coordinator broadcast. It builds the room when the window's
update goes, at most once a publish window, and the update carries only what changed, so the copy for the publish window
went. The owner-scale gate counts two more kinds of work for it: builds of the room and records of Watcher's history sent
to the window, each watched thread's participations among them. Owl, owner's scale, on `main` with #1334 and with this
change as well:

| | Copier calls | Objects copied | Reads of a thread | Room builds | History records sent |
| --- | --- | --- | --- | --- | --- |
| One thread streaming, per update | 7.85 to 6.85 | 4,329 to 1,729 | 6,114 to 4,996 | 1 to 0.38 | 119 to 0 |
| Three threads streaming, per update | 11.62 to 10.62 | 4,421 to 1,821 | 6,169 to 5,184 | 1 to 0.46 | 143 to 0 |
| Saving an answer draft | 11 to 9 | 5,252 to 52 | 15,593 | 2 | 620 to 0 |
| Typing in a composer | 13 to 11 | 15,894 to 10,694 | 12,148 | 2 | 620 to 0 |
| Opening a thread | 23 to 21 | 26,799 to 21,599 | 14,490 | 2 | 620 to 0 |
| Sending a message | 121 to 116 | 59,635 to 46,635 | 37,733 to 34,077 | 5 to 3 | 930 to 0 |

The threads that stream were let go by earlier requests, and a row that changes goes as what changed in it, so none of
their participations rides again (sent whole, it was 62 records per streamed update on one thread and 320 per save).
Owl's copied objects no longer grow with the history while threads stream or when an answer draft is saved; what still
grows is a command copying Watcher's whole record (#1248). Stable is unchanged.

In the streaming copy budget Owl makes 6.3 to 6.75 copies per update, from 7.3 to 7.8, and its budget is 7.5.

## When a guard goes red

Read the failure: it says what grew, with the measured numbers. Move the copy off the update path, or read the state
without copying it. The copy-site list is different: a new copy that runs only for a command or a read is fine there.
Say why in the PR and rewrite the list:

```powershell
$env:SOTTO_UPDATE_COPY_SITES = '1'; npx vitest run tests/unit/main/copySites.test.ts
```
