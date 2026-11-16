# Watcher's pass looks threads up rather than searching for them (#2618)

November 15, 2026. A minute of main on Zach's laptop (#2397, `docs/perf/2026-11-15-laptop-main-window-and-freezes.md`), with 590 threads, showed Watcher's work at 45% of main's busy time. Three of its hottest frames were searches made once per item:

| Frame | Self time in the minute | What it did |
|---|---:|---|
| `swarmPending` (`watcher.ts`) | 728 ms | For each finished turn a pass asked about, searched every thread for the thread's swarm, since a thread in no swarm has no row in delegation's index. |
| `delivery` (`watcher.ts`) | 285 ms | For each operation with no draft, searched the whole delivery ledger. Every delivery names its draft (`agentDeliverySchema`), so the search never found anything. |
| `hasTimestamp` (`threadActivity.ts`) | 264 ms | Parsed every settled thread's settled time on every publish and every room state. |

## What changed

- `swarmPending` reads the thread through the host's index (`WatcherHosts.owning`), the coordinator's `hostThreadsOf` for this computer and the list's index for a paired host.
- An operation with no draft has no delivery, so `delivery` returns none without searching.
- `hasTimestamp` keeps whether each timestamp string parses, up to 16,384 strings. Past that, a new string is parsed and not kept, so the ones kept still answer and a pass never parses every one again.

## Why the owner-scale budgets missed it

`ownerScaleWorkBudget.perf.test.ts` and `watcherPassCost.perf.test.ts` build Watcher without Owl's worker swarms, so `swarmPending` never ran. The scale fixture also mocked the coordinator's snapshot without its index, so every look-up there fell back to a search. And the extra reads grow with due events times threads: the per-thread ratio those tests check stays flat when the pass reads every thread once more for each of a fixed number of events.

The owner-scale pipeline now builds Owl's Watcher with swarms too, so it runs the laptop's path. Its budget still passes on the old code: it asks that work stay flat as the history grows and not grow faster than the threads, and a search of every thread for each of a fixed number of due events does neither. The check that fails on the old code is `watcherPassCost.perf.test.ts`, below. The owner-scale budget does not count `Date.parse`; `threadActivity.test.ts` holds the timestamps to one parse each.

`watcherAtScale` now takes `swarms` (wired as `runtime.ts` wires them, with no swarm running) and `indexed` (the coordinator's index, as main has it). `watcherPassCost.perf.test.ts` asks that swarms add no thread reads to any pass, and that operations with no draft add no ledger reads. Both fail on the old code.

## Numbers

Counts from `watcherPassCost.perf.test.ts`, swarms on and the index on (Node 24.22.1, forge):

| Count | Before | After |
|---|---:|---:|
| Wake pass thread reads, 60 threads | 564 | 0 |
| Wake pass thread reads, 250 threads | 1,764 | 0 |
| Observe ledger reads, 250 threads, five operations with no draft | 1,043 | 298 (the two reads every pass makes) |
| `Date.parse` calls for 600 settled threads read again | 600 | 0 |

Wall time per call at 590 threads, `SOTTO_PERF_BENCH=1 npx vitest run tests/perf/watcherPassCost.perf.test.ts -t "times each pass" --maxWorkers=1`, the median of five rounds of 20 calls, three runs each on forge:

| Pass | Before (ms) | After (ms) |
|---|---|---|
| Wake pass | 1.013, 0.966, 1.090 | 0.461, 0.450, 0.473 |
| Observe | 0.658, 0.622, 0.754 | 0.632, 0.691, 0.757 |
| Publish | 0.043, 0.044, 0.048 | 0.047, 0.046, 0.065 |

The fixture's wake pass has a few dozen due events. The laptop's had more, so its saving there is larger. Observe and publish don't change in this fixture, which has no settled threads and no operations without a draft.

Per call, `hasTimestamp` on a kept string takes 9 ns, against 147 ns for `Date.parse` (600 ISO strings, Node 24.22.1).

## Still to check

The issue's laptop check: the same Record a minute on the laptop at a similar load once an Owl carries this, with Watcher's share of main's busy time against the 45% above.
