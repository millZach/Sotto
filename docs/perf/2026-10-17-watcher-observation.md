# Watcher recovery and observation cost — October 17, 2026

The takeover and quiet-wake diagnosis initially introduced avoidable work on Watcher's update path. Performance is part of the fix's acceptance criteria. Passing functional tests did not establish that acceptance: deterministic budgets and matched measurements found costs that the old streaming fixture did not cover.

## Reproduced costs and guards

| Real path | Failing observation | Current default-suite guard |
| --- | --- | --- |
| Normal stream with a known Watcher user head | 20,003 message-property reads with 20,000 older messages; 120,018 with six watches | At most twelve reads per watch; a later human behind a stale head remains protected |
| Unchanged watch and participant heads | Four record copies for one watch, fourteen for six | At most one copy and one mutation per pass, including 200 retained takeover records |
| Room state | Copied 200 private proof objects, 69,380 bytes, although no room field exposed them | Zero private proof copies; public nested return values remain detached from authority |

Each guard failed before its corresponding change. `humanTurnRunning` now checks the latest user against the known native head before scanning older history. Observation skips unchanged assignments, and the read-only remote-guard pruning reads the immutable record view. Room state copies its public projection without the private takeover field; authority retains that evidence. The copy-site inventory gains an explicit clone location because this replaces the room's call to the whole-record cloning helper, not because an extra runtime clone was added.

The guards live in `watcherObserveWorkBudget.perf.test.ts`, `watcherObserveCopyBudget.perf.test.ts`, and `watcherRoomCopyBudget.perf.test.ts`. They run without performance flags. The final focused run of these and adjacent takeover/liveness/streaming suites passed 43 tests in 44.47 seconds; typecheck and lint passed afterward.

## Matched measurement

The comparison keeps the fixture, dependencies and all other production files identical. A Vite load hook substitutes precisely the three production files changed by this lane from base `f000d7612fb270317ee32102037695edbf1765fa` or the candidate and verifies all loaded hashes. Each arm uses a fresh Vitest process and one worker. A fingerprint of tracked and untracked inputs is checked before and after every arm. The shared heavy-job helper excludes cooperating heavy work from other lanes; it does not make the computer otherwise idle.

The order is parent, candidate without metadata, candidate with metadata, metadata, candidate, parent, parent, candidate, metadata. Local workloads cross unknown/working outcome, one/three/six watches, twenty/20,000 older messages and zero/twenty/200 retained takeovers: 36 cells per arm. Each method has ten warmups and five rounds of twenty calls. Paired-host pruning uses eight immutable queued wake-ups with thirteen events each, one complete warmup and three rounds of thirty prunes. It verifies every event identity before each prune and an empty queue afterward. No real provider or protected thread is used.

Commands, run under the shared helper with `SOTTO_PERF_BENCH=1`:

```text
node node_modules/vitest/vitest.mjs run tests/perf/watcherObserveBenchmark.perf.test.ts tests/perf/watcherObservePass.perf.test.ts tests/perf/watcherRoomRemote.perf.test.ts tests/perf/streamingCopyBudget.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

`SOTTO_PERF_TAKEOVER_METADATA=1` enables the new proof metadata in the local workload. The owned comparison runner and exact substitution config are retained in `.zstack/watcher-diagnosis/`. All final aggregate cells, source hashes, streaming results and the component-isolation run are saved in [the measurement data](2026-10-17-watcher-observation.json). Timings are evidence, not default-suite assertions.

| Workload | Parent | Candidate with new metadata |
| --- | ---: | ---: |
| One watch, twenty older messages, 200 retained takeovers: observe | 3.0307 ms | 1.5951 ms |
| Six watches, same history/retention: observe | 9.3209 ms | 2.3282 ms |
| One watch, same history/retention: room read | 7.5348 ms | 6.6523 ms |
| Six watches, same history/retention: room read | 9.0345 ms | 7.3753 ms |
| Six watches, 20,000 older messages, no retained takeovers: observe | 16.6484 ms | 15.6513 ms |

These are medians of three process medians for the working-outcome cells. The last row still includes existing outcome work over long histories; the patch removes the newly introduced scan, not every existing history-dependent operation. None of the 36 candidate-with-metadata observation/room cells has a greater-than-ten-percent slower median with disjoint process ranges. Six room cells have greater-than-ten-percent slower medians within overlapping ranges; the data retains them. Sample ranges are not confidence intervals, and this is not a formal equivalence test or proof that every possible workload is faster.

Owl streaming copies fall from 21.39–21.42 to 19.39–19.44 per update with twenty and 200 threads. Stable remains approximately 9.82. Whole-state counts stay around 2.92 on Owl and 2.95 on stable. The Owl budget falls from 23.5 to 21.5; no budget is loosened.

## Paired pruning: a slower signal did not reproduce consistently

Earlier three-prune samples repeatedly showed a slower candidate. A seven-arm component comparison with thirty prunes per round did not isolate a cause: the identical baseline moved from 38.26 to 41.90 ms, bracketing both current 40.71 and the exact earlier candidate 40.94. Wake-up-only and schema-only substitutions did not reproduce the gap; there are zero direct schema parses during a measured prune.

The broader series nevertheless has prune medians of 35.79 ms parent versus 39.73 ms candidate, with ranges 31.86–40.06 and 38.85–40.20. CPU medians are 34.33 versus 37.57 ms. Both versions perform three shell reads, four shell clones, four host-list reads, eight record clones and one wake observation. Overlapping ranges alone do not dismiss that roughly eleven-percent median difference, so two further controlled comparisons followed.

First, a paired-only parent/candidate/candidate/parent run timed the complete settlement promise, due checking, persistence, queue removal, returned news and publication/observation. Nested inclusive timings are not summed; a separate exclusive partition accounts for each outer wall interval once. Observed GC entries are clipped to those windows and flushed outside measurement. These are wall overlays, not CPU or stop-the-world claims. The four wall/CPU medians were parent 40.21/36.40, candidate 43.24/38.57, candidate 36.09/32.23 and parent 45.48/39.63 ms. No phase showed a consistent candidate-specific increase or extra call. Queue removal alone varied from 4.68 to 8.52 ms across versions. Profiling adds common overhead and async boundaries, so its absolute totals are compared only within that run.

Second, the same paired-only workload ran **without phase profiling** in three balanced parent/candidate/candidate/parent blocks: twelve fresh processes, six samples per version. All source hashes, queue contents, work counts and frozen-input checks passed. Parent wall median was **42.760 ms**, range 35.93–47.38; candidate **40.485 ms**, range 36.99–43.35. CPU medians were 38.300 and 36.315 ms. Each of the three balanced blocks had lower candidate wall and CPU medians. Work counts remained identical in every run.

The broader slower signal was not reproduced in these controlled paired-only repeats. No consistent code-dependent prune slowdown was established, and no speculative production optimization was made for it. Its cause remains unproven; the earlier results are retained. The reliable regression protection is the passing deterministic work/copy budgets, backed by these bounded timing comparisons. This does not certify zero regressions in every workload or replace the repository's full PR gates.

To repeat the optional phase probe, add `SOTTO_PERF_PRUNE_PHASES=1` to the paired benchmark command. The reviewed B/C/C/B and twelve-arm source-substitution runners, full logs and manifests remain under `.zstack/watcher-diagnosis/prune-ablation/`. The committed measurement data includes every phase and unprofiled repeat result.
