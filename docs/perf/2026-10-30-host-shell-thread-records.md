# A paired host's shell pushes - October 30, 2026

Measured with the data-transfer benchmark (`tests/perf/dataTransfer.perf.test.ts`, `docs/perf/2026-10-29-data-transfer.md`),
its host socket block. The owner-scale pipeline, about 290 threads, runs behind a paired host's socket. Paired to it are a
desktop peer that counts what it is sent and says hello with the desktop client's features, a phone on a listener of its
own, and the desktop's own client of the host (`SocketHostService`) with a router and a window broadcast over it, as main
runs them. One host thread then streams for 60 pushes, and three for 61.

```sh
SOTTO_PERF_BENCH=1 SOTTO_AUDIT_SOCKET=1 SOTTO_AUDIT_PROFILE='socket 1' NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/dataTransfer.perf.test.ts -t "host socket" --maxWorkers=1 --disable-console-intercept
```

It prints `DATA-TRANSFER-SOCKET` with each peer's frames and bytes and the process's CPU, and writes the CPU profile of
the one-thread run to `sotto-transfer-socket-1.cpuprofile` in the temporary folder.

## What it cost

Every shell push carried every thread record whole: 232,942 bytes to the desktop, about 11 KB deflated, for a change to
the streaming thread's record. The host pushes the shell up to twenty times a second to each client while a thread
streams. The desktop's client parsed every record against the thread schema, and the router compared every one, all fresh
objects, before the window's broadcast found the one that changed.

## The change

A host lists `changed-thread-records` (ADR-0028, October 30 amendment; `docs/host-protocol.md`). A client that accepts it
is sent each shell push with only the thread records that changed since the last push to that connection, in the
window's broadcast shape, and with the state's own thread list empty. The desktop's client accepts it and puts the whole
list back from the records it holds, so a thread that did not change is the very record it already had.

## Before and after

Three runs each on forge, the same benchmark on `main` and on the branch.

| One thread streaming, 60 pushes | Before | After |
| --- | ---: | ---: |
| A desktop shell push | 232,942 bytes | 11,929-11,950 bytes |
| The same, deflated | 11,075-11,099 bytes | 1,970-1,976 bytes |
| The desktop client's work on its pushes (`receive`) | 295.0-303.4 ms | 67.3-72.5 ms |
| Of which the router and what it publishes (`notifyState`) | 60.7-62.2 ms | 9.5-10.0 ms |
| The host's shell sends to its three clients (`sendShell`) | 286.6-292.6 ms | 236.4-248.0 ms |
| Of which serializing the state (`shellText`) | 114.7-117.3 ms | 43.7-44.0 ms |
| The process's CPU | 1,490-1,532 ms | 889-945 ms |

With three threads streaming the process's CPU fell from 1,201-1,242 ms to 747-776 ms. The first push of a connection,
and the first after a `shell` read, lists every record: 205 KB. The phone, which did not accept the feature yet, was sent
the same 627,049 bytes for its two shells in every run.

The window was broadcast the same thread records. A run of each with every window broadcast logged gave every thread the
same last record and the same number of records sent, once the run's random IDs, times and temporary folders were set
aside. The host's encoding of each push's changes is inside `sendShell`.

## The iPhone

The iPhone then accepted the feature too (`ThreadRecordsCache` in SottoCore). The same benchmark, with its phone peer's
hello as the iPhone now sends it, three runs before and after:

| The phone peer | Before | After |
| --- | ---: | ---: |
| A shell push after a send on the open thread (two each run) | 220,462 bytes | 6,946 bytes |
| Its shells while one thread streams (two each run) | 627,049 bytes | 210,651 bytes |

While a thread streams a phone is pushed few shells, since its rows leave out what changes with every word. The first of
those two after its hello listed every record (204,066 bytes) and the second was 6,585 bytes. One before run sent the
phone three shells, 846,120 bytes.

What reading a push costs the iPhone was measured on a Mac test runner by `ThreadRecordsTests` in SottoCore, which
prints `THREAD-RECORDS-READ` (`swift test` in `apps/ios`). Over 290 records shaped like the benchmark's, the median of
30 reads, in each of two runs:

| One push | Bytes | Read |
| --- | ---: | ---: |
| Every record, as before | 237,498 | 3.88-4.44 ms |
| One changed record, put back on the 289 held | 1,073 | 0.68 ms |

These are the runner's times. No iPhone was timed; a trace on an iPhone is #1702.

## The guards

- `tests/integration/socketChangedThreadRecords.test.ts`:
  - an accepting client's first push lists every record with a null base beside an empty thread list, and a change to
    one thread then carries that one record, measured from the push before; a client that did not accept the feature is
    sent every record;
  - the push after a `shell` read lists every record again;
  - the desktop's client accepts the feature, shows the host's whole list and keeps the record it held for every thread
    that did not change;
  - a push measured from records the client does not hold is not shown; the client reads the shell whole, and the host's
    next push lists every record.
- `tests/integration/socketHostFeatures.test.ts` lists the feature in health, the listener file and hello.
- `apps/ios/Tests/SottoCoreTests/ThreadRecordsTests.swift`, in the macOS job: a push's records are read beside its
  state; the iPhone puts the whole list back through a change, a removal and a new order; a push measured from records
  it does not hold, or that cannot place every thread, is not shown and changes nothing held; a shell with every record
  is read as it came; a push whose records name no base is unreadable. `StreamingTests` checks the hello accepts the
  feature.

## What it leaves

The rest of the shell still crosses whole with every push, most of the 12 KB a push now carries: projects, providers,
paired hosts and the coordinator's fields. The Android client does not accept the feature yet and is sent every record
in every push.
