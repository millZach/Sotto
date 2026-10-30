# What Sotto moves, copies and writes - October 29, 2026

Zach asked for the app to feel smooth on desktop and phone by moving less data, with every gain measured and nothing a
model receives changed. This note is the benchmark that measures it, the baseline it found at `e1f838016`, and the result
of each fix, added as each one lands.

## The benchmark

`tests/perf/dataTransfer.perf.test.ts` builds main as `src/main/index.ts` wires it, from the owner-scale pipeline
(`tests/fixtures/ownerScalePipeline.ts`: 250 threads, 40 on a remote host, Watcher with the owner's record). Three of the
threads are long: 2,000 activity records of about 3 KB and 550 messages each, the size of the longest real threads on
forge's host. It streams one and three threads at twenty chunks a second for three seconds, then does what the user does
once each: saves an answer draft, types, opens a thread, sends, and has Watcher read a receipt. For each it reports:

- every message on the window's state, detail and Watcher room channels, its `node:v8` size and how many a second;
- what crosses to the thread store's worker, built with the worker handle's own `wire`;
- every JSON file written, with its bytes;
- `JSON.stringify` calls and characters, and the calls and time of the store reads, flushes and saves that grow with
  history.

`-t "host socket"` with `SOTTO_AUDIT_SOCKET=1` puts the host's socket over the same main, with a desktop and a phone
paired, each saying hello as its client does, and the desktop's own client of the host (`SocketHostService`) with a router
and a window broadcast over it. It reports each peer's frames by event and their bytes, compressed for the desktop, and,
with `SOTTO_AUDIT_PROFILE='socket 1'`, a CPU profile of the push path.

It prints JSON and asserts nothing, so it runs only under `SOTTO_PERF_BENCH=1`:

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/dataTransfer.perf.test.ts --maxWorkers=1 --disable-console-intercept
SOTTO_PERF_BENCH=1 SOTTO_AUDIT_SOCKET=1 SOTTO_AUDIT_PROFILE='socket 1' NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/dataTransfer.perf.test.ts -t "host socket" --maxWorkers=1 --disable-console-intercept
```

Times are from forge (Linux, shared with other work) and read as proportions. A profiled time is the inclusive time of a
function in a CPU profile sampled every 200 microseconds, taken the same way before and after.

## The baseline (`e1f838016`)

| Path | Measured |
| --- | --- |
| Host to each paired desktop while one host thread streams | 15 whole shells a second, 233 KB each (11 KB compressed); the new words are a 269-byte detail delta |
| Host to each phone | no shells while a thread streams (the October 26 trim); a whole 220-280 KB shell, uncompressed, on each status change |
| Desktop's client per remote push | 10.2 ms profiled: a whole copy of the shell for its listener (4.7 ms) and a schema read of the shell and the catalog; router 1.2 ms, window broadcast 1.1 ms |
| Main per streamed chunk, open thread of 2,000 records | detail revision and diff 2.9 ms (Owl), 2.2 ms (stable), against 0.15 ms for a short thread |
| A send with three long threads observed | 76.6 MB posted to the store worker, against 1.0 MB with short threads |
| A turn of a background thread nobody views | its 2,000 records read back on main (13.4 ms), then re-posted whole (6.3 MB) |
| A window command's reply | every thread whole: 271.6 KB at 293 threads; 3.0 ms of schema read in the preload |
| A debounced draft save | `agents.json` rewritten and fsynced (265 KB here, 547 KB on forge's host) |
| Window broadcast while streaming | 15 a second, 12 KB each, 9.8 KB of it unchanged since the last |

## Results

### The desktop's client stops copying each push and reading its catalog again (#996)

`SocketHostService` handed each listener of a push `state()`: a whole structured copy of the shell with every held
detail laid over it, for the router, which reads a few fields. It now hands `view()`, as a local host's broadcast is
handed. A shell naming a catalog revision the client has read, a push, an answer or a `shell` read, is read without its
catalog and handed the frozen array it read first (ADR-0028, October 29 amendment). Six command paths that only read the
shell read it in place too.

This is the desktop's work on what arrives. The bytes on the wire are unchanged: 233 KB per shell push before
compression, 11 KB after. Phones are untouched; they are sent no shells while a thread streams.

One host thread streaming, 60 pushes, profiled:

| | Before | After |
| --- | ---: | ---: |
| `SocketHostService.receive`, per push | 10.2 ms | 5.2 ms |
| of it, the listener's copy (`notifyState`) | 5.8 ms | 1.0 ms |
| Window broadcast `send`, per push | 1.09 ms | 0.69 ms |
| of it, the catalog comparison, all 60 pushes | 29.2 ms | 0.9 ms |
| `shell()` and `state()` calls per push | 1 | 0 |

What is left per push is the schema read of the shell's thread rows, which shell deltas take away.
`tests/integration/socketClientPushCopies.test.ts` fails if a push calls `shell()` or `state()`, or if a later push or a
command's answer leaves the client holding a catalog other than the one it first read.

### An answer draft saves without a status line, and without keying every answered question (#1248)

A question card's own answer is saved at each pause in typing. The card said "Saving answer…" and then "Answer draft
saved." every time, to the eye and to a screen reader; it now says nothing unless a save fails, which still shows its
error and Save again (Zach's call, October 29). In main, the first save after start or after an answer was retired built
a key for every answered question in the ledger, three serializations each, and every save wrote the whole file
indented. The ledger's index and the kept owners' keys are now made when the store loads and when a commit replaces
them, and the file is written compact with the ledger's text made once for each ledger.

`saveAnswerDraft` and `saveAnswerDraft again` in the benchmark, the owner's 256 answered questions:

| Per save | Before | After |
| --- | ---: | ---: |
| `JSON.stringify` calls, first save after start | 819 | 48 |
| `JSON.stringify` calls, each later save | 33 | 29 |
| Characters serialized, each later save | 94,885 | 6,914 |
| `request-drafts.json` written and fsynced | 88,569 bytes | 65,728 bytes |

`ownerScaleWorkBudget.perf.test.ts` holds it: serializations per save fall from 911 to 140 on Owl and from 824 to 33 on
stable, both `KNOWN_HISTORY_GROWTH` entries for the save are gone, and stable's save is flat along the history. The file
is still written whole at each save, because a retired answer and its draft change together in one atomic write.
