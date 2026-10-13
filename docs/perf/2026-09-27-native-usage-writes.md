# Native usage archive writes (#389)

Unchanged observations now request no archive writes. Changed observations share one pending snapshot while a write is in flight. Accounting remains synchronous, and graceful shutdown drains the latest totals. All nine isolated benchmark cases passed, and the synthetic Claude Electron journey passed through replay, held-write shutdown, restart and visible restored history.

Baseline: `7b5fdb843c46ca9fbd21d0ea6acc6656d7f72def`, which matched fetched `origin/main` before implementation. Usage implementation: `5e1cb9544d6dcfabf22457a0586b24542c7abafe`. Benchmark candidate: `4313677c43f1ad09430bd43abc24662c1fafc4b0`. Follow-up commits changed harnesses and documentation; the later integration of main retains the same usage implementation and imports main's other production changes. #302 still owns the visible persistence-error surface decision; this change adds none.

## Implementation and invariants

`NativeUsage` detects changed entries and compares the small current view and context metadata. Unchanged observations skip summarization and persistence. Timestamp-less replay does not refresh context age. Changed historical entries still affect totals without replacing newer context; metadata-only changes still save. Codex cumulative deltas and resets, Claude cache TTL pricing, and Grok reported costs retain their accounting and replay identities.

Totals update synchronously. A microtask takes an immutable snapshot, with at most one write in flight. (Since #767 the ledger is serialized as the write starts rather than copied, and written at most once a second while a reply streams; see `2026-10-06-send-writes.md`.) Observations arriving during that write mark dirty thread IDs; the next snapshot contains their latest totals. The atomic JSON format, file sync, replacement and Windows rename retries are unchanged.

Adapters retain their explicit `closed()` / `NativeUsage.flushed()` drain. Failed writes mark affected threads' existing `persistenceError`. Success clears an error only after that thread's latest pending totals are saved. A subsequent observation, including unchanged replay, or an explicit drain retries failure; a permanently broken disk does not trigger an automatic retry loop. Reconnect retains newer unsaved memory if its retry fails. Repricing on load uses the same observable error path. Successful snapshots omit runtime failure flags.

## Structural verification

`nativeUsagePersistence.test.ts` bounds work without stopwatch assertions:

- Seeding 100 requests in one batch makes one write. Replaying an unchanged historical frame 100 times makes zero writes and retains the existing total object. The baseline audit requested 100 saves carrying 10,000 entries.
- Duplicate latest frames, stream output, elapsed results, compacted context and unidentified Grok observations make no redundant saves.
- Holding one write while 100 changes arrive across two threads produces exactly one further snapshot. The original snapshot cannot mutate; drain waits for the latest one.
- All providers retain accounting through failure, retry, persistence and restart. Tests cover cross-thread errors, stale success, bounded retries, reconnect and repricing failures.

```powershell
npx vitest run tests/unit/main/nativeUsage.test.ts tests/unit/main/nativeUsagePersistence.test.ts --maxWorkers=1
```

Persistence comparisons treat absent and undefined optional counters equivalently while preserving reported zeros and every numeric value. They retain pricing, completeness, context and rate versions. Electron comparisons additionally assert each boundary's exact model identity and compare timestamps, elapsed time and error state. An archive's native model ID intentionally differs from the qualified renderer ID.

## Isolated benchmark method

`nativeUsageWrites.perf.test.ts` bundles the baseline's actual `src/` sources from Git and the candidate's sources separately. Each sample runs in a fresh Node child with a private synthetic archive and real `AtomicJsonStore` writes, sync and replacement. No installed profile or provider is used. Baseline and candidate run sequentially in alternating order; one warm-up pair is discarded and three pairs supply medians.

Each archive receives 100 observations in ten batches separated by event-loop turns: unchanged historical replay, growing output for one request, or new requests spread across threads. Setup, bundling, seeding, reload verification and cleanup are outside measurement. Every sample checks actual archive reload; paired results must agree on counters, pricing and context. Baseline writes must equal 100; candidate writes must be zero for replay and at most ten for changing batches.

The runner measured Windows / Node 24.14.1 with neighboring implementation lanes idle and no other owned tests or benchmarks during the timing window. Normal desktop development processes remained. This was not a pristine-machine experiment.

## Results

All nine cases passed. Values below are medians of three samples, shown as baseline → candidate. Observation time covers the frame loop; drain time covers that loop plus persistence completion, not an additional interval. Entries carried count full snapshots crossing the persistence boundary, not unique entries.

| Initial archive (threads × entries each) | Workload | Write requests | Entries carried | Observation ms | Through drain ms |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 × 100 | Replay | 100 → 0 | 10,000 → 0 | 22.2 → 1.5 | 234.2 → 1.6 |
| 1 × 100 | Stream | 100 → 2 | 10,100 → 202 | 23.3 → 5.1 | 265.5 → 7.7 |
| 1 × 100 | New requests | 100 → 2 | 15,050 → 310 | 38.5 → 11.7 | 283.9 → 16.0 |
| 4 × 250 | Replay | 100 → 0 | 100,000 → 0 | 152.5 → 1.6 | 619.5 → 1.6 |
| 4 × 250 | Stream | 100 → 2 | 100,100 → 2,002 | 143.1 → 15.5 | 945.9 → 20.9 |
| 4 × 250 | New requests | 100 → 2 | 105,050 → 2,110 | 193.5 → 22.2 | 730.6 → 28.6 |
| 20 × 250 | Replay | 100 → 0 | 500,000 → 0 | 537.2 → 1.6 | 2,519.1 → 1.6 |
| 20 × 250 | Stream | 100 → 2 | 500,100 → 10,002 | 490.2 → 30.8 | 1,861.0 → 99.4 |
| 20 × 250 | New requests | 100 → 2 | 505,050 → 10,110 | 532.4 → 29.0 | 1,915.4 → 61.5 |

[Retained benchmark results](../../artifacts/review-389/native-usage-benchmark-results.json) include exact revisions, execution conditions, CPU measurements, archive bytes and heap samples. Archive byte counts agree within each pair. Heap samples are neither peak memory nor post-GC retained memory. Timings measure this synthetic ledger workload only; they make no Electron, installed-client or provider-latency claim. Structural bounds, rather than timing thresholds, run in normal CI.

To repeat in a coordinated window without other tests or benchmarks:

```powershell
$env:SOTTO_PERF_BENCH = '1'
npx vitest run tests/perf/nativeUsageWrites.perf.test.ts --maxWorkers=1 --disable-console-intercept
Remove-Item Env:SOTTO_PERF_BENCH
```

## Delivery evidence and independent review

The [native Electron verification note](../verification/2026-09-27-native-usage-writes.md) records the actual Claude adapter/ledger journey, exact totals, shutdown drain, replay after restart, visible history, isolation and selected screenshots. The original PNGs are complete; an earlier misleading image preview was incorrectly diagnosed as a capture defect. Original-file inspection and pixel comparison corrected that conclusion. No app or compositor defect was demonstrated.

- [x] Structural, accounting and persistence regressions.
- [x] Nine isolated benchmark cases with restart equivalence.
- [x] `npm run typecheck`, full `npm run lint`, and `npm run notices:verify` (174 components), reported by the runner at `ba1fbd05`.
- [x] `npm test -- --maxWorkers=2`: 440 files passed, 35 skipped; 5,775 tests passed, 135 skipped; 614.58 seconds, reported by the runner. Source, unit/integration tests and shared fixtures stayed frozen during the run.
- [x] Runtime preparation and `npm run build`, completed by the runner before main integration. The usage implementation is unchanged since `5e1cb954`.
- [x] Focused E2E lint/typecheck and the native Electron journey passed for the final `f3a80bb1` test content; original screenshots inspected. Only the excluded E2E spec and documentation changed after the broad-gate revision.
- [x] Independent native GPT-6 Astra/high Standards review: zero substantiated findings.
- [x] Independent native GPT-6 Astra/high Spec review: zero substantiated findings.

Root confirmed both reviewers' GPT-6 Astra/high configuration from the authoritative spawn calls. Standards reviewer `/root/fix_378` and Spec reviewer `/root/fix_377` independently reviewed baseline `7b5fdb84` through production/E2E revision `f3a80bb1`, then the final documentation/evidence delta through `0cc23d5d59acff35a62a84eece853a17fdce2f9b`. Both reported zero substantiated findings; no source changes were needed.

Implementation used GPT-6 Astra at high reasoning. Cross-model review was unavailable because automatic approval review rejected the external review destinations; those calls were not retried. The user specified Astra builders, not an Astra-only reviewer restriction. Completed coverage is two independent native review axes, not four cross-model reviews.

These results and reviews describe the revisions named above. Integration of `origin/main` at `2a3bcbb691fccf789da6ae79f440811c75dc14c9` preserves the benchmark/accounting implementation and retained evidence. No timing rerun was needed: the benchmark's only incoming dependency change is a comment in `perfBench.ts`. Post-integration checks and pending runner verification are recorded in the [verification note](../verification/2026-09-27-native-usage-writes.md#main-integration).
