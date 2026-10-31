# Watcher's identity check after a save - October 30, 2026

Measured with the data-transfer benchmark (`tests/perf/dataTransfer.perf.test.ts`, `docs/perf/2026-10-29-data-transfer.md`),
its main-process block on Owl: the owner-scale pipeline, its `agents.json` 267 KB, and two sends on the open thread, one
after the other.

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/dataTransfer.perf.test.ts -t "measures what main moves" --maxWorkers=1 --disable-console-intercept
```

It prints `DATA-TRANSFER`; each action's `methods` holds `watcherProfiles.readIdentity`, the calls and the time.

## What it cost

Every command that names a thread, a send, a steer, an answer, an interrupt or a change of settings, and every Claude
launch, asks whether the thread is Watcher's, on both tracks. The answer comes from Watcher's identity as `agents.json`
holds it on disk (ADR-0073). Every save of `agents.json` changes its stat signature, and a send's own outbox write is a
save, so nearly every command read the file again and checked all of Watcher's record against its schema. It checked it
twice: `migrateWatcherRecord` is the schema's own parse, and the identity check parsed its result again.

## The change

The check reads the file after every save as before, under the same signature. It checks Watcher's record once, and a
record the same as the last one that passed holds the same identity, so it is not checked again. A record that changed
is checked, and one that fails is refused as before.

## Before and after

Three runs each on forge.

| `readIdentity` | Before | After |
| --- | ---: | ---: |
| The first send of a run | 5.19-5.53 ms | 3.20-3.37 ms |
| A later send | 4.74-10.01 ms | 1.00-1.15 ms |

What is left of a later check is reading the file and parsing it, and comparing Watcher's record with the last one. The
owner's `agents.json` is about twice the benchmark's.

## The guard

`tests/integration/watcherLaunchProfiles.test.ts`: three saves that leave the record as it was are each read and none is
checked again, and a changed record is checked and its identity is the one that counts. A record that no longer passes,
after one that did, is refused.
