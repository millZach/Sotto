# Start reads each thread's usage view, and its requests when they are needed - November 1, 2026

#1937, part of #555. Measured on forge with `tests/perf/usageLedgerLoad.perf.test.ts`:

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/usageLedgerLoad.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

It seeds a Claude usage folder the size of the owner's once with the working tree: 290 threads of 190 requests and one
of 10,000, 9,818,789 bytes of ledgers. Each run starts from a copy of it in a fresh process
(`tests/fixtures/usageLoadBench.ts`, run with `--expose-gc`), times `load()`, measures the heap it leaves behind once
collected, then times the long thread's first usage report. "Before" is the source at `f976052cc`. "Upgrade" is the working
tree on a folder an earlier build left, with no views. "Later" is the working tree on the start after that, views
written: the claim.

Each runs again with Usage on. A `UsageService`, as main wires it, reads every thread's saved rows once Claude connects,
its store answering as the usage store's worker does after a structured clone of each flush, as posting it there makes.
Every task the visit runs in is timed. Three runs each, alternated; the tables give medians. Every run counts the same
tokens, and Usage saves the same 65,100 rows.

## What it cost

Every start read every thread's ledger whole: every request each thread ever made, and the keys that keep a replayed
request from counting twice. It re-priced what had no price, summed every thread, and kept all of it on main's heap for
the whole run, although only the threads working that run touch their requests. The round's probe on forge
(October 31) put it at 160 to 250 ms and 17 to 27 MB at the owner's scale, about 290 threads and 9 to 15 MB of ledgers.

With Usage on, Usage then read every thread's saved rows when its provider connected, all in one task on main.

## The change

Beside each thread's ledger file is a small file holding the thread's view, `<hash>.view.json`: what the thread shows
(its totals, latest request, context and duration), the rate table it was priced with, and the size and modification
time of the ledger file it was written with. `NativeUsage` writes it each time it writes the ledger, from the same moment,
with the same atomic store. Nothing that reads ledger files takes it for one.

Start reads the view files alone. It reads a ledger whole, as before, and writes its view file, when the view file is
missing, when it does not match the ledger file as it is now (an earlier build wrote the ledger, or a write failed between
the two), or when the thread may hold unpriced requests and its view was priced with another rate table.

A thread's requests are read the first time something needs them: any usage report, or Usage visiting the thread. A report
reads its thread's ledger file then, on main, since it counts at once, and does to it what start did to every ledger
before anything counts. So a request an earlier run counted is among them and is not counted again. A file that cannot be
read at that moment counts nothing for that report and the next one tries again; one unreadable as a ledger is set aside as
the store sets any aside (`AtomicJsonStore.readSync`), and the thread starts afresh, as it would have at start. Usage's
visit reads an unread thread's requests for the visit alone and keeps none of them.

Usage now reads the threads it is to visit a few per task (`UsageService`): at most three threads, and no further thread
once 5 ms have passed, with the next task queued behind whatever else main has to do. A thread of 190 requests takes about
1.2 ms there, and a flush of the store's full 4,096-row buffer, which a thread's rows can set off, about 6 ms more, so
three threads leave room for one in about 8 ms. A thread queued twice is read once, a thread whose read failed is read
again with the next publication, closing stops the reading, and the legacy seed is marked only once no thread is left
queued, so it never goes without a thread's rows. A Usage read or Clear waits for the queued threads first.

## Before and after

| Start, Usage off, 291 threads | Before | Upgrade | Later |
| --- | ---: | ---: | ---: |
| Bytes parsed | 9,818,789 | 9,818,789 | 140,653 |
| `load()` | 197.3 ms | 147.8 ms | 13.2 ms |
| CPU during it | 222 ms | 216 ms | 31 ms |
| Heap kept | 18.4 MB | 18.4 MB | 0.6 MB |
| First report on the 10,000-request thread | 0.8 ms | 0.9 ms | 29.4 ms |

The first start after an upgrade reads what every start read, with the same CPU. It finishes sooner because it reads
sixteen files at once where the old start read one at a time. In the background after it, it writes the 291 view files,
each synced to disk.

The first report on a thread after start now pays for reading its ledger: 29.4 ms on a thread of 10,000 requests, once for
each thread in a run. Forge's host's longest thread holds 1,796 requests.

### With Usage on

| Start and Usage's visit, 291 threads | Before | Upgrade | Later |
| --- | ---: | ---: | ---: |
| `load()` | 196.1 ms | 147.0 ms | 13.2 ms |
| Usage's visit, first task to last | 434.2 ms | 456.9 ms | 530.7 ms |
| Start and visit together | 630.3 ms | 603.9 ms | 543.9 ms |
| CPU during both | 744 ms | 759 ms | 651 ms |
| Tasks the visit ran in | 1 | 103 | 103 |
| Middle task | 434.1 ms | 2.6 ms | 3.5 ms |
| Longest task | 434.1 ms | 66.0 ms | 79.9 ms |
| Longest task but the long thread's | | 11.6 ms | 10.6 ms |
| Tasks over 8 ms | 1 | 7 | 8 |
| Heap kept after both | 18.7 MB | 19.0 MB | 1.1 MB |
| First report on the 10,000-request thread | 0.8 ms | 1.0 ms | 23.3 ms |

The longest task is the visit of the 10,000-request thread, whose rows Usage reads in one task however many there are:
80 ms, in the worst of three runs 81, where before the whole visit was one task of 434 ms, 464 in the worst run. The other
tasks over 8 ms each hold a flush of the store's full buffer, up to 11.1 ms in the worst run. With the visit spread out it
takes longer from first task to last, but start and visit together take less, use less CPU and keep 1.1 MB rather than
18.7. The first start after an upgrade uses 2% more CPU than before, writing the 291 view files meanwhile.

The visit costs more than a first measurement of this change showed (129 ms before), which handed each row to a counter.
Usage checks each row against its schema and buffers it, about 4.5 microseconds a row.

### Writes

Each ledger write now writes the view file after it; Usage's batching changes no write. On
`usageStreamWrites.perf.test.ts`, with its baseline set to `f976052cc` for the run, a reply streaming 150 usage frames made
five ledger writes before and after, and five view writes after, 2,442 bytes in all; its CPU over the three-second reply
went from 16.5 ms to 18.7 ms (medians of four).

## What to know

- **A price added without a new rate version.** Start reads a ledger whole to price its unpriced requests only when its
  view was priced with another rate table (`USAGE_RATE_VERSION`). A price added without bumping it, such as a new
  spelling of a priced model that `canonicalModelId` learns, reaches a thread's totals only when its requests are next
  read: its next report, or Usage's visit, which prices nothing. The rate table already says new pricing needs a new
  version.
- **A restored backup.** A copy of the folder has new modification times, so no view matches its ledger: the first start
  from it reads every ledger whole, as before this change, and writes the views again.

## The guards

- `tests/unit/main/nativeUsageLazyLoad.test.ts`, in the default suite:
  - a start of 30 threads, views written, reads no ledger file, and the first report on one of them reads that thread's
    ledger once; its streaming reply and turn's end read nothing more (with every view ignored, the test fails);
  - the first start after an earlier build reads each ledger once and writes only the views, and the next reads none;
  - for Claude, Codex and Grok, a thread replaying ten requests an earlier run counted, then two new ones, counts twelve,
    and ends with the same view and the same saved ledger as a start that read every ledger whole;
  - a view a failed write or an earlier build left behind, a view priced with another rate table, a ledger unreadable by
    its first report and one that cannot be read at that moment are each handled as above;
  - Usage's visit of an unread thread gives the rows a start that read it gives, and keeps nothing.
- `tests/unit/main/usageService.test.ts`: twenty threads are read a few per task, not in the publication's own task, and
  the seed is marked only once all are read; a thread queued twice is read once and a failed one again with the next
  publication; closing stops the reading. On the source before this change all three fail.
- `tests/unit/main/atomicJsonStore.test.ts`: `readSync` reads what `read` reads and sets a bad file aside under the same
  name, with its exact bytes.

A long ledger is still written whole once a second while it streams; that is #1938's.
