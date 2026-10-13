# The 250 ms workspace flush and the model catalog - October 13, 2026

Issue #991, step 2. Every 250 ms while any provider published, the workspace flush cloned the whole
organization state — the model catalog included — deep-compared it with the last save, and on any
change rewrote `workspace.json` pretty-printed. This step keeps the catalog out of that cycle, behind
the same Owl switch as step 1 (`streaming-publish-cost`, ADR-0072).

## How it was measured

`tests/perf/workspaceFlush.perf.test.ts` runs a workspace over a synthetic 874-model catalog (the
development machine's size when the audit measured it) and 200 threads. It times `flush()` after a
provider snapshot that changed no organization, and after one thread's usage moved so the file is
written, medians of 15, and reports the size of `workspace.json`. The benchmark runs with the Owl
feature on; "before" is the flush as step 1 left it, which is also what stable still does with the
feature off. Every payload is generated in the test; no user profile is opened.

Taken on the Windows development machine (Node v24.14.1) with other sessions running beside the
benchmark, so read the times as proportions. Two runs of "after" are given.

## Results

| | Before | After (two runs) |
| --- | ---: | ---: |
| Flush, organization unchanged | 6.02 ms | 2.58, 1.47 ms |
| Flush, one thread's usage moved | 14.53 ms | 8.12, 5.81 ms |
| `workspace.json` | 1,371,459 bytes | 353,982 bytes |

## What changed

- **No clone, a text comparison.** The flush builds the saved value without `structuredClone`,
  serializes it compact, and compares that string with the last one it wrote. Only a changed string
  is written, through `writeSerialized`, so nothing is serialized twice.
- **The catalog is spliced, not serialized.** The certified catalog's serialized form is cached while
  the catalog array itself is unchanged (it is identity-stable since #917) and spliced into the
  document text at a placeholder. A flush that changed nothing about the catalog never re-serializes
  it, and no pass clones or deep-compares it.
- **Compact file.** The workspace store is `AtomicJsonStore.compact` while the feature is on, as
  `agents.json` and the usage ledgers already are. Every reader parses either form, so stable reads
  an Owl-written file whole.
- **A provider's modes are stored once.** Devin lists the same permission modes on every model; the
  saved catalog keeps them on the first model that carries them and the workspace's own read puts
  them back onto the rest, whichever track wrote the file. A model whose modes differ from its
  provider's first keeps its own.

## What did not change

- With the feature off, the flush is the old code path exactly: clone, deep-compare, pretty write.
- What `workspace.json` holds: the same organization, the same models with their modes once read
  back. A thread's model still resolves before its provider connects.
- The catalog still lives in `workspace.json`. Persisting it in its own file, which the audit raised,
  would need a migration and a crash story for two files; the cached serialization takes the
  per-flush cost out without either, so the split is left for if the remaining write ever matters.

## Tests

- `tests/unit/main/workspaceCatalogFlush.test.ts`: with the feature on, the file is compact, a
  provider's modes are stored once and read back onto every model by a workspace with the feature
  off, and an unchanged flush writes nothing; with it off, the file is pretty and carries modes on
  every model.
- The existing workspace organization, thread-store and settings-history suites pass unchanged.

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/workspaceFlush.perf.test.ts --maxWorkers=1 --disable-console-intercept
npx vitest run tests/unit/main/workspaceCatalogFlush.test.ts tests/unit/main/workspaceOrganization.test.ts
```
