# Watcher's record in a file of its own - October 30, 2026

Measured with the data-transfer benchmark (`tests/perf/dataTransfer.perf.test.ts`, `docs/perf/2026-10-29-data-transfer.md`),
its main-process block on Owl: the owner-scale pipeline, with the Watcher record the benchmark builds at the owner's
scale, and each user action as the window makes it.

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/dataTransfer.perf.test.ts -t "measures what main moves" --maxWorkers=1 --disable-console-intercept
```

It prints `DATA-TRANSFER`. Each action's `files` holds the writes and bytes of every JSON file, and its `methods` the
coordinator's saves (`control.persist`) and Watcher's identity check (`watcherProfiles.readIdentity`).

## What it cost

Watcher's record was 264,085 of the 266,785 bytes of `agents.json`. Every save rewrote the whole file and synced it:
each pause in typing, each thread opened and each send, though none of them changed the record.

## The change

Watcher's record moved to `watcher-record.json` beside `agents.json` (ADR-0073, October 30 amendment). A save writes
Watcher's file only when the record changed, and first; `agents.json` follows without the record. A store saved before
reads its record from `agents.json` and moves it across on its next save.

## Before and after

Three runs each on forge, at #1929's head and with the change. Every run wrote the same bytes.

| Bytes written per action | Before | After |
| --- | ---: | ---: |
| A pause in typing (one save) | 266,785 | 2,689 |
| Opening a thread (two saves) | 533,536 | 5,344 |
| A send (four saves) | 1,069,577 | 13,193 |
| A later send (four saves) | 1,072,636 | 16,252 |
| Two background turns | 1,073,984 | 276,640 |

Of the background turns' writes, one changed Watcher's record: Watcher's file was written once, 264,435 bytes, and
`agents.json` three times, 12,205 bytes in all.

| Per action | Before | After |
| --- | ---: | ---: |
| Saves of a send (`control.persist`) | 35.1-35.7 ms | 27.9-31.4 ms |
| Saves of a later send | 30.6-36.0 ms | 22.3-26.8 ms |
| Watcher's identity check on a later send | 0.95-1.06 ms | 0.03 ms |
| Main's CPU for a pause in typing | 10.9-11.9 ms | 9.3-9.9 ms |
| Main's CPU for a send | 116-131 ms | 107-113 ms |

The saves' times include their waits for the disk. The identity check now reads only the stat of Watcher's file, which
an ordinary save leaves as it was.

## The guards

- `tests/unit/main/agentSavedSections.test.ts`, "Watcher's own file":
  - a save that leaves the record as it was writes `agents.json` alone, a quarter the size of Watcher's file at most,
    and a changed record writes Watcher's file;
  - Watcher's file is written before `agents.json`, and when it is not written, `agents.json` is left as it was and the
    next save writes both, Watcher's first;
  - a store saved before reads its record from `agents.json` and moves it across;
  - where both hold a record, Watcher's file is read.
- `tests/unit/main/agentPersistence.test.ts` moves an older store's record across, with history on and off, across
  restarts.
- The suites that read Watcher's saved record now read it where it is (`tests/fixtures/savedWatcher.ts`).
