# A Claude thread's stored records are owned as they are read (#2619)

November 15, 2026. A hang recording on Zach's laptop showed main stopped for 12.5 s. Its one stack, taken 3.9 s in, ran from a Claude stream frame (`applyFrame` → `emit` → `ProviderSnapshotPublisher.publish` → `AdapterThreadChanges.build` → `activityThread`) into `certifyActivityView` → `immutableActivities` → `copyUnshared` → `copyValue`. The note on that day is `docs/perf/2026-11-15-laptop-main-window-and-freezes.md`.

## The write that left the list unowned

A Claude thread restored after a restart doesn't read its stored records at connect (#918). It reads them when something first changes the thread's activity: the first stream frame or transcript line (`ensureActivityHistory` in `claude.ts`). That read hands back up to 2,000 records, which the workspace builds for that call alone: parsed from the thread store, or cloned from its own copy. The adapter then:

1. cloned them all with `structuredClone`, and
2. on the same frame's publication, `certifyActivityView` found the list and every record unowned and copied all of them again to own them.

So the first frame on a long restored thread copied every record twice, inside the frame. The connect path for a restored snapshot did the same at connect.

## What changed

- `ensureActivityHistory` owns the records where they are (`ownBuiltActivities`): it freezes each record and the list, and copies nothing. `ThreadHistorySource.activities` now says its records are built for the call and kept by nobody else, which is what the workspace's read already did.
- A restored snapshot's records belong to their caller, so the connect path still copies them, but once, with `immutableActivities` in place of `structuredClone`. The publication then copies none.
- A hang recording of main now says how many of its once-a-second tries got no stack while main stayed stopped (`stacksMissed`, ADR-0098's November 15 amendment). The 12.5 s recording's one stack left that unsaid.

## Numbers

`claudeTranscriptCatchUp.test.ts`, "owns the stored records a frame reads": a restored thread is handed 2,000 stored records, and one transcript line then changes one of them. The test counts the records the adapter holds afterwards that are the very ones the read handed over:

| | Before | After |
|---|---:|---:|
| Records kept as handed, of 2,000 | 0 | 1,999 (all but the one the line changed) |

`SOTTO_PERF_BENCH=1 npx vitest run tests/perf/claudeStoredActivities.perf.test.ts --maxWorkers=1`. It takes in 2,000 command records with 2 KB of output each, then the certify. Both ways run in one go; the figure is the median of seven rounds, three runs on forge, Node 24.22.1:

| | Run 1 | Run 2 | Run 3 |
|---|---:|---:|---:|
| Before: clone, then the certify's copy (ms) | 4.54 | 4.19 | 4.05 |
| After: owned where they are (ms) | 0.56 | 0.57 | 0.55 |

## What this doesn't explain

On forge, 2,000 records of 2 KB cost about 4 ms, not 12.5 s. The laptop's thread may hold larger records, with steps, agents and long outputs. The laptop was also short of memory that day, and ran out at 20:07 UTC. The recording took one stack in 12.5 s, which fits a long garbage collection after a large copy, or paging. It can't tell which, and this note doesn't claim the whole 12.5 s was the copy. The next long stop's recording will say how many of its stacks it missed.
