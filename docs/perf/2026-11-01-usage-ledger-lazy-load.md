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
written: the claim. Each runs again with Usage on, which visits every thread's saved rows after the start, as Usage does
once a provider connects. Three runs each, alternated; the table gives medians. Every run counts the same tokens and
Usage visits the same 65,100 rows.

## What it cost

Every start read every thread's ledger whole: every request each thread ever made, and the keys that keep a replayed
request from counting twice. It re-priced what had no price, summed every thread, and kept all of it on main's heap for
the whole run, although only the threads working that run touch their requests. The round's probe on forge
(October 31) put it at 160 to 250 ms and 17 to 27 MB at the owner's scale, about 290 threads and 9 to 15 MB of ledgers.

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

## Before and after

| Start, 291 threads | Before | Upgrade | Later |
| --- | ---: | ---: | ---: |
| Bytes parsed | 9,818,789 | 9,818,789 | 140,654 |
| `load()` | 192.3 ms | 144.5 ms | 13.2 ms |
| CPU during it | 219 ms | 214 ms | 30 ms |
| Heap kept | 18.4 MB | 18.5 MB | 0.6 MB |
| First report on the 10,000-request thread | 0.8 ms | 0.9 ms | 30.1 ms |

The first start after an upgrade reads what every start read, with the same CPU. It finishes sooner because it reads
sixteen files at once where the old start read one at a time. In the background after it, it writes the 291 view files,
each synced to disk.

The first report on a thread after start now pays for reading its ledger: 30.1 ms on a thread of 10,000 requests, once for
each thread in a run. Forge's host's longest thread holds 1,796 requests.

### With Usage on

| Start and Usage's visit, 291 threads | Before | Later |
| --- | ---: | ---: |
| `load()` | 198.5 ms | 13.3 ms |
| Usage's visit of every thread | 129.4 ms | 214.4 ms |
| Heap kept after both | 18.4 MB | 0.8 MB |

Usage reads every thread's saved rows when its provider connects, so with Usage on every ledger is still read at start, now
by that visit, one file at a time on main and in one pass. Start and visit together take less (228 ms against 328) and
keep 0.8 MB rather than 18.4 MB, but the visit is one longer task on main: 214 ms where it was 129. Of the 85 ms it grew
by, a probe on the same folder, not committed, put about 7 ms in reading the files, 32 in parsing their JSON and 38 in
checking them against the ledger's schema. The store already passes over a visited row it holds, treating the ledgers as a
one-time import; visiting only the threads whose rows it may lack would take the read off the start. That is Usage's
change, not this one.

### Writes

Each ledger write now writes the view file after it. On `usageStreamWrites.perf.test.ts`, with its baseline set to
`f976052cc` for the run, a reply streaming 150 usage frames made five ledger writes before and after, and five view writes
after, 2,442 bytes in all; its CPU over the three-second reply went from 15.8 ms to 19.2 ms (medians of four).

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
- `tests/unit/main/atomicJsonStore.test.ts`: `readSync` reads what `read` reads and sets a bad file aside under the same
  name, with its exact bytes.

A long ledger is still written whole once a second while it streams; that is #1938's.
