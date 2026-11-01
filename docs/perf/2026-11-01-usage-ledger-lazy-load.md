# Start reads each thread's usage view, and its requests when they are needed - November 1, 2026

#1937, part of #555. Measured on forge with `tests/perf/usageLedgerLoad.perf.test.ts`:

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/usageLedgerLoad.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

It seeds a Claude usage folder the size of the owner's once with the working tree: 290 threads of 190 requests and one
of 10,000, 9,818,789 bytes of ledgers. Each run starts from a copy of it in a fresh process
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
arrive, and its ledger is read with the store's own asynchronous read. Once it lands, normalising the ledger and applying
the held reports run in a task of their own; then the thread is saved and its adapter told, so it shows the new totals.
Until then the thread shows its view. A Claude message's start, deltas and stop are held together, in order. A read that
fails keeps the reports and is tried again after half a second, doubling to thirty, and `flushed()`, which quitting and
reconnecting wait for, tries each held thread's read again first, so no report is lost to a failed read and none is
applied twice: the reports apply after the requests are read, so a request an earlier run counted is among them.

**What a report costs.** Normalising a ledger walks every request. It runs once for a thread in a run, when its requests
are first read, in a task of its own and never in a report's; every report after it costs what it cost before (#555's
running totals). So the work of a report does not grow with the thread's history, as `AGENTS.md` requires; what grows
with it is the one read of the thread's ledger in a run.

**Usage reads only what changed.** Usage keeps a mark per thread in its own store, a `visit_marks` table beside the history
cursors: the thread's usage as it was when Usage last read its rows (its last report time, rate versions, totals and
whether any is partial). A flush writes the marks of the threads read since the last one after its rows, so a mark
commits only once every row its read gave has; a failed flush keeps them for its retry, and a read that lost a row to a
full buffer leaves none. When a provider connects, Usage asks for the marks first and passes over every Claude, Codex and
Grok thread whose usage shows the mark it was last read at. The first start after this change reads every thread, as
before; later starts read only the threads that reported since. Muse's and OpenCode's threads are read at every start as
before. A thread Usage does read keeps its requests, since it is likely to report this run.

**Usage reads a few at a time.** Usage reads the threads it is to read at most three per task, and begins no further one
once 5 ms have passed. A thread of 190 requests takes about 1.2 ms there, and a flush of the store's full 4,096-row buffer
about 6 ms more, so three threads leave room for one in about 8 ms. A thread queued twice is read once, a failed read is
tried again with the next publication, closing stops the reading, a Usage read or Clear waits for the queue, and the legacy
seed goes with a flush only when no thread is left queued.

## Before and after

| Start, Usage off, 291 threads | Before | Upgrade | Later |
| --- | ---: | ---: | ---: |
| Bytes of ledgers parsed | 9,818,789 | 9,818,789 | 0 |
| `load()` | 193.5 ms | 149.4 ms | 13.9 ms |
| Heap kept | 18.4 MB | 18.5 MB | 0.6 MB |
| Longest stretch on main | 13.2 ms | 8.9 ms | 2.5 ms |

A later start reads 140,655 bytes of views. The first start after an upgrade reads what every start read, sooner, since
it reads sixteen files at once where the old start read one at a time; in the background after it, it writes the 291
view files.

| Start and Usage, Usage on, 291 threads | Before | Upgrade | Later |
| --- | ---: | ---: | ---: |
| Bytes of ledgers parsed | 9,818,789 | 9,818,789 | 0 |
| `load()` | 182.7 ms | 150.2 ms | 13.8 ms |
| Usage's visit, first task to last | 450.5 ms | 456.7 ms | 0.7 ms |
| Threads Usage read | 291 | 291 | 0 |
| Tasks it read in | 1 | 103 | 1 |
| Longest task | 450.5 ms | 65.3 ms | 0.4 ms |
| Longest stretch on main | 455.9 ms | 70.5 ms | 2.5 ms |
| CPU through both | 800 ms | 767 ms | 26 ms |
| Heap kept | 18.7 MB | 19.1 MB | 0.7 MB |

The worst of three runs gives the same picture: the longest task 452.5 ms before, 65.8 on the first start, 0.4 later. On
the first start the longest task is Usage reading the 10,000-request thread's rows, which it does in one task however many
there are; the other tasks over 8 ms each hold a flush of the store's full buffer. That start keeps what it read, as every
start before this change did.

| The long thread's first report after start | Before | Later, Usage off | Later, Usage on |
| --- | ---: | ---: | ---: |
| Its own task | 0.77 ms | 0.36 ms | 0.35 ms |
| Until it counted | 0.77 ms | 37.1 ms | 37.2 ms |
| Longest stretch on main through it | 7.1 ms | 20.7 ms | 20.5 ms |

The report's own task is shorter: it is held. Its thread's 1.5 MB ledger is read off it and lands 37 ms later. The longest
stretch is that ledger's parse, the first ledger the process checks against the ledger's schema, which the source at BASE
did at start among all the others (its longest stretch then, 13 to 16 ms, was a warmer parse of the same file); after it,
normalising the ledger, applying the report and encoding the write it sets off take about 15 ms more in a task of their
own. A probe of a fresh process put the parse at 26 to 30 ms, of which 16 to 20 the schema check. Forge's host's longest
thread holds 1,796 requests, a sixth of this one. The source at BASE's 7.1 ms is the report and its write's encoding.

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
  - a start of 30 threads, views written, reads no ledger file; the first report on one of them is held, reads that
    thread's ledger once, and applies with the streamed message behind it, in order (with every view ignored, the test
    fails);
  - the first start after an earlier build reads each ledger once and writes only the views, and the next reads none;
  - for Claude, Codex and Grok, a thread replaying ten requests an earlier run counted, then two new ones, counts twelve,
    and ends with the same view and the same saved ledger as a start that read every ledger whole;
  - for Claude, Codex and Grok, a saved request, a read that fails for the next and a good one after end where reading every
    ledger at start ends, with nothing replayed by hand; a failed read is tried again on its own after half a second;
  - a view a failed write or an earlier build left behind, a view priced with another rate table, a view that cannot be
    read, a ledger unreadable by its first report, and Usage visiting a thread before its read lands are each handled as
    above.
- `tests/unit/main/usageService.test.ts`: at most three threads a task and none in the publication's own; a task stops once
  its 5 ms are spent, on an injected clock; the seed waits for every queued thread, though a connected publication with
  none came first and a flush came between; a thread queued twice is read once and a failed one again with the next
  publication; closing stops the reading; a later start reads only the threads that changed or are new; a mark is written
  only after its rows, and not by a flush that failed. Each fails when its rule is taken out.
- `tests/unit/main/usageStoreRequests.test.ts`: a flush writes its visit marks after its rows, Clear keeps them, and a flush
  whose rows fail writes none.
- `tests/unit/main/atomicJsonStore.test.ts`: `readSync`, which Usage's read of a thread uses, reads what `read` reads and
  sets a bad file aside under the same name, with its exact bytes.

A long ledger is still written whole once a second while it streams; that is #1938's.
