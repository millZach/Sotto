# Start reads each thread's usage view, and its requests when they are needed - November 1, 2026

#1937, part of #555. Measured on forge with `tests/perf/usageLedgerLoad.perf.test.ts`:

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/usageLedgerLoad.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

It seeds a Claude usage folder the size of the owner's once with the working tree: 290 threads of 190 requests and one
of 10,000, 9,823,156 bytes of ledgers. Each run starts from a copy of it in a fresh process
(`tests/fixtures/usageLoadBench.ts`, run with `--expose-gc`). It counts the bytes of ledger and view files read, times
`load()`, measures the heap it leaves behind once collected, and keeps the longest stretch main went without a turn of its
event loop, which bounds the longest task of any kind. Then it times the long thread's first usage report: its own task,
how long until it counted, and the longest stretch through it, the write it sets off included. "Before" is the source at
`f976052cc`. "Upgrade" is the working tree on a folder an earlier build left, with no views and no marks. "Later" is the
working tree on the start after that, whose start before wrote the views and, with Usage on, the marks: the claim.

Each runs again with Usage on. A `UsageService`, as main wires it, reads the threads' saved rows once Claude connects, its
store answering as the usage store's worker does after a structured clone of each flush, as posting it there makes
(`tests/fixtures/usageBenchStore.ts`), and every task it reads in is timed. Three runs each, alternated; the tables give
medians. Every run counts the same tokens. Usage saves the same 65,100 rows before and on the first start, and none on the
later one, no thread having changed.

## What it cost

Every start read every thread's ledger whole: every request each thread ever made, and the keys that keep a replayed
request from counting twice. It re-priced what had no price, summed every thread, and kept all of it on main's heap for
the whole run, although only the threads working that run touch their requests. The round's probe on forge
(October 31) put it at 160 to 250 ms and 17 to 27 MB at the owner's scale, about 290 threads and 9 to 15 MB of ledgers.

With Usage on, Usage then read every thread's saved rows when its provider connected, all in one task on main, and the
store passed over every row it already held.

## The change

**Views.** Beside each thread's ledger file is a small file holding the thread's view, `<hash>.view.json`: what the
thread shows (its totals, latest request, context and duration), the rate table it was priced with, and the size and
modification time of the ledger file it was written with. `NativeUsage` writes it each time it writes the ledger, from
the same moment, with the same atomic store. Nothing that reads ledger files takes it for one. Start reads the view files
alone. It reads a ledger whole, as before, and writes its view file, when the view file is missing or cannot be read, when
it does not match the ledger file as it is now (an earlier build wrote the ledger, or a write failed between the two), or
when the thread may hold unpriced requests and its view was priced with another rate table.

**Held reports.** A report on a thread whose requests are not read yet is held for that thread, in the order reports
arrive, and its ledger is read with the store's own asynchronous read. What a Claude or Grok report says of the thread's
view, its context reading, context window, latest request and duration, shows in the view at once, as a compaction does;
a Codex report does not, since only the requests say whether Codex counted it before, which then changes nothing. Codex's
compaction, which clears the context reading at its end unless one came in while it ran (ADR-0095), now takes the reading
it compares with in the ledger, in the order of the thread's reports (`compactionStarted`, `compactionEnded`), so a report
held meanwhile counts as before or after it began as it came. When the read lands, the ledger's requests are checked
against its schema and normalised a chunk of 2,000 a task, then the held reports are applied, as of when each came in; the
thread is saved and its adapter told. A Claude message's start, deltas and stop are held together, in order. A read that
fails keeps the reports and is tried again after half a second, doubling to thirty, and `flushed()`, which quitting and
reconnecting wait for, tries each held thread's read again first, so no report is lost to a failed read and none is
applied twice: the reports apply after the requests are read, so a request an earlier run counted is among them.

**What a report costs.** Checking and normalising a ledger walks every request. That runs once for a thread in a run,
when its requests are first read, a chunk a task and never in a report's task; every report after it costs what it cost
before (#555's running totals). So the work of a report does not grow with the thread's history, as `AGENTS.md` requires;
what grows with it is the one read of the thread's ledger in a run, and Usage reading its rows again, also a chunk a task.

**Usage reads only what changed.** Each ledger has a revision, in its view, that every change to one of its requests moves
on, a model corrected with no token changing among them. Usage keeps a mark per thread in its own store, a `visit_marks`
table beside the history cursors: the thread's usage as it was when Usage last read its rows, its revision with its last
report time, rate versions, totals and whether any is partial. A flush writes the marks of the threads read since the last
one after its rows, so a mark commits only once every row its read gave has; a failed flush keeps them for its retry, and
a read that lost a row to a full buffer leaves none. When a provider connects, Usage asks for the marks first and passes
over every Claude, Codex and Grok thread of a connected provider whose usage shows the mark it was last read at, and reads
it after all should its usage move on later in the run. A ledger an earlier build wrote has no revision: it is read at
every start until Usage has read it, which gives it one, so a request corrected by an earlier build is never passed over.
The first start after this change reads every thread, as before; later starts read only the threads whose requests changed
since. Muse's and OpenCode's threads are read at every start as before. A thread Usage reads is read as a report's is,
once, in the background; Usage visits it again once its requests are in, and keeps them.

**Usage reads a few at a time.** Usage takes at most three threads a task, read or passed over on its mark, and begins no
further one once 5 ms have passed; a thread's rows are handed over 500 a task, so a long thread's never fill one. A thread
of 190 requests takes about 1.2 ms, a row about 6 microseconds, and a flush of the store's full 4,096-row buffer, which the
rows can set off, about 5 ms more. A thread queued twice is read once, a thread whose requests are still being read is
visited again 25 ms later, and closing stops the reading. A thread whose rows cannot be read is tried again with the next
publication, and until it is read Usage says it could not save and Clear refuses. A Usage read or Clear waits for every
thread queued, being read or mid-visit, and the legacy seed goes with a flush only when none of these is left and no thread
is unread.

## Before and after

| Start, Usage off, 291 threads | Before | Upgrade | Later |
| --- | ---: | ---: | ---: |
| Bytes of ledgers parsed | 9,823,156 | 9,823,156 | 0 |
| `load()` | 191.9 ms | 141.7 ms | 13.9 ms |
| Heap kept | 18.4 MB | 18.5 MB | 0.6 MB |
| Longest stretch on main | 12.9 ms | 8.8 ms | 2.6 ms |

A later start reads 145,026 bytes of views. The first start after an upgrade reads what every start read, sooner, since
it reads sixteen files at once where the old start read one at a time; in the background after it, it writes the 291
view files.

| Start and Usage, Usage on, 291 threads | Before | Upgrade | Later |
| --- | ---: | ---: | ---: |
| Bytes of ledgers parsed | 9,823,156 | 9,823,156 | 0 |
| `load()` | 192.7 ms | 142.3 ms | 13.8 ms |
| Usage's visit, first task to last | 432.9 ms | 449.1 ms | 1.8 ms |
| Threads Usage read | 291 | 291 | 0 |
| Tasks it read or checked in | 1 | 122 | 97 |
| Longest task | 432.8 ms | 11.2 ms | 0.3 ms |
| Longest stretch on main | 437.6 ms | 11.3 ms | 2.6 ms |
| CPU through both | 791 ms | 752 ms | 29 ms |
| Heap kept | 18.7 MB | 19.1 MB | 0.9 MB |

The worst of three runs gives the same picture: the longest task 436.3 ms before, 11.5 on the first start, 0.3 later. On
the first start the long thread's 10,000 rows go 500 a task; the longest tasks hold a flush of the store's full buffer.
That start keeps what it read, as every start before this change did. A later start checks the 291 threads' marks three a
task.

| The long thread's first report after start | Before, Usage off | Later, Usage off | Before, Usage on | Later, Usage on |
| --- | ---: | ---: | ---: | ---: |
| Its own task | 0.77 ms | 0.51 ms | 1.28 ms | 0.54 ms |
| Until it counted | 0.77 ms | 36.5 ms | 1.28 ms | 37.8 ms |
| Rows Usage read again after it | | | 1 | 10,002 |
| Longest stretch on main through it | 6.9 ms | 10.4 ms | 6.6 ms | 10.5 ms |

The report's own task is shorter: its request is held. Its thread's 1.5 MB ledger is read off it and counts 37 ms later.
The longest stretch is the task the file lands in, its JSON parse, about 7 ms of it; checking and normalising the requests
follow in chunks of about a millisecond. With Usage connected, the report moves the thread's mark, so Usage reads its
10,002 rows again, in 35 tasks of which the longest took 9.5 ms, one holding a flush of Usage's buffer. The source at BASE
had read them at start and reads none again; its 6.6 to 6.9 ms are the report and its write's encoding. Checked whole and
normalised in one task, as an earlier commit on this branch did, the read alone held main for 20.2 ms; visited in one task,
as the commit before this one did, Sol's review measured 70 ms for the thread's 10,001 rows. Forge's host's longest thread holds 1,796 requests,
a sixth of this one.

### Writes

Each ledger write now writes the view file after it; no later change here touches a write. On
`usageStreamWrites.perf.test.ts`, with its baseline set to `f976052cc` for the run, a reply streaming 150 usage frames made
five ledger writes before and after, and five view writes after, 2,442 bytes in all; its CPU over the three-second reply
went from 16.5 ms to 18.7 ms (medians of four).

## What to know

- **A price added without a new rate version.** Start reads a ledger whole to price its unpriced requests only when its
  view was priced with another rate table (`USAGE_RATE_VERSION`). A price added without bumping it, such as a new
  spelling of a priced model that `canonicalModelId` learns, reaches a thread's totals only when its requests are next
  read: its next report, or Usage reading it. The rate table already says new pricing needs a new version.
- **A restored backup.** A copy of the folder has new modification times, so no view matches its ledger: the first start
  from it reads every ledger whole, as before this change, and writes the views again.
- **A thread's first report counts once its ledger is read**, tens of milliseconds later on a long thread. A thread whose
  ledger cannot be read keeps its reports until it can; quitting meanwhile loses them, as a crash loses the last second of
  counts, and the provider reports them again when the thread is read.

## The guards

- `tests/unit/main/nativeUsageLazyLoad.test.ts`, in the default suite:
  - a start of 30 threads, views written, reads no ledger file; the first report on one of them shows its reading at
    once, holds its request, reads that thread's ledger once, and applies with the streamed message behind it, in order
    (with every view ignored, the test fails);
  - the first start after an earlier build reads each ledger once and writes only the views, and the next reads none;
  - for Claude, Codex and Grok, a thread replaying ten requests an earlier run counted, then two new ones, counts twelve,
    and ends with the same view and the same saved ledger as a start that read every ledger whole;
  - for Claude, Codex and Grok, a saved request, a read that fails for the next and a good one after end where reading every
    ledger at start ends, with nothing replayed by hand; a failed read is tried again on its own after half a second;
  - a thread that reports and is visited by Usage before its read lands reads its ledger once, and Usage's read waits for it;
  - a long thread's rows are handed to Usage at most 500 a visit, at start and when its first report moves its mark, and
    Usage's read and the legacy seed wait for all of them (with the thread mid-visit kept out of the seed's guard, the test
    fails);
  - a ledger Usage cannot read keeps Usage saying it could not save, and Clear refusing, until it can;
  - a model corrected on an older request, no total or time moving, moves the revision, so the next start reads the thread;
    a ledger an earlier build wrote, with no revision, is read at every start until it has one, though an earlier build
    corrected a request in between (with a revisionless ledger marked, the test fails);
  - a Codex compaction ordered among held reports keeps a reading that came in while it ran, and clears it when what came in
    was a report Codex had counted, as reading every ledger at start does, and that report changes nothing in the view;
  - a 4,500-request ledger is checked and normalised over several tasks, to the same view and saved ledger;
  - a view a failed write or an earlier build left behind, a view priced with another rate table, a view that cannot be
    read, and a ledger unreadable or holding a request its schema refuses by its first report are each handled as above.
- `tests/unit/main/usageService.test.ts`: at most three threads a task, on a clock that stands still, and none in the
  publication's own; a task stops once its 5 ms are spent; a thread passed over on its mark counts against the three; the
  seed waits for every queued thread, though a connected publication with none came first and a flush came between; a
  thread queued twice is read once and a failed one again with the next publication; closing stops the reading; a later
  start reads only the threads that changed or are new; a thread passed over on its mark is read once its usage moves on,
  and one whose provider connects with newer usage is read; a mark is written only after its rows, and not by a flush that
  failed.
- `tests/unit/main/usageStoreRequests.test.ts`: a flush writes its visit marks after its rows, Clear keeps them, and a flush
  whose rows fail writes none.

A long ledger is still written whole once a second while it streams; that is #1938's.
