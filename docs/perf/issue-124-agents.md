# Agents view performance

Issue #124 adds an independently paged agent roster. Acceptance combines bounded archive work in CI with opt-in local timing measurements.

## Reproduce

```powershell
$env:SOTTO_PERF_ASSERT = '1'
$env:SOTTO_PERF_SAMPLES = '5'
$env:SOTTO_PERF_BASE_REF = '80b2207ec46c2e66d008ddc0f9de69a1b6646e2b'
node tests/perf/subagents-bench.mjs
npx vitest run tests/unit/renderer/threadQueueSkills.test.tsx tests/unit/main/threadDrafts.test.ts tests/integration/codexStreamingResponsiveness.test.ts tests/integration/nativeStreamingResponsiveness.test.ts --maxWorkers=1
```

The benchmark bundles the real `WorkspaceHost` from the requested baseline revision and current working-tree source. The baseline defaults to HEAD when `SOTTO_PERF_BASE_REF` is absent; use the explicit pre-feature revision above after the feature is committed. It never changes the checkout. Each sample runs in a fresh Node child with explicit garbage collection. Temporary databases and bundles are removed from a verified temporary directory.

Both revisions receive identical provider snapshots: three threads, twenty live agents and 600 updates, one update per event-loop turn. Both temporary folders contain the same synthetic database with 50 or 5,000 saved assignments and twenty previously working agents. Each saved assignment has a 1 KiB task and 2 KiB result. The baseline has no roster and does not open this database. Archive creation, bundling and process launch are excluded from startup. Startup measures reopening the persisted workspace and connecting its fake provider. No production profile, provider or network request is used.

Subscriptions serialize published workspace snapshots to approximate a real consumer. Measurements include provider emission time, the longest gap in a 5 ms main-process heartbeat, bounded first-page lookup, post-GC heap and process RSS. They exclude Electron window startup, IPC transport, layout and paint. Separate queue-feedback and native streaming tests exercise the existing 100 ms and 250 ms budgets.

## Initial PR branch measurements

Measured September 20, 2026 on Windows 11 (`win32 10.0.26200`), Node `v24.14.1`, Intel Core Ultra 9 275HX, 24 logical CPUs. The isolated issue branch was compared with main at `93b2f0f5de9736eb47fc77b0e2938ae6a2700830`. Five fresh-process samples per cell alternated baseline/current order with `SOTTO_PERF_ASSERT=1`. The full test suite and other development tasks were running on the host; these are shared-host measurements, not an idle-machine baseline. [Raw samples](../../artifacts/agents-view/pr-performance.json) preserve every result.

Times are milliseconds. Values are medians across five samples except heartbeat, which is the worst gap across all five. Heap is the post-GC increase from before startup through the complete update workload.

| Saved assignments | Revision | Startup | Event median | Event p95 | Worst heartbeat | First page | Retained heap MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | Baseline | 10.495 | 0.053 | 0.078 | 5.077 | unavailable | 0.433 |
| 50 | Current | 21.018 | 1.285 | 2.102 | 37.086 | 0.353 | 0.695 |
| 5,000 | Baseline | 8.723 | 0.046 | 0.076 | 5.248 | unavailable | 0.413 |
| 5,000 | Current | 17.049 | 0.979 | 1.371 | 11.004 | 0.353 | 0.724 |

At 5,000 assignments, retaining the roster adds about 0.93 ms to the median event and 0.31 MiB of retained JavaScript heap in this workload. Processing 600 unpaced updates took 35.959 ms on the baseline and 665.523 ms with the feature. This is measurable synchronous storage overhead. Every heartbeat sample passed 250 ms. Event time and retained heap remained comparable between small and large archives. Startup varies with shared-host load; these measurements do not establish a new startup budget.

At 5,000 assignments, median final heap was 15.169 MiB on the baseline and 16.075 MiB with the feature. Median process RSS was 131.902 and 159.766 MiB; RSS growth during measurement was 0.051 and 11.836 MiB. RSS includes native SQLite, filesystem and allocator effects, so it is not a measure of retained transcript memory.

The separate opt-in responsiveness command passed four files and 62 tests in 11.36 seconds. Queue feedback met the existing 100 ms gate and Codex, Claude and Grok streaming met the 250 ms heartbeat gate. No additional precise renderer timings were emitted.

## Integrated revision measurements

After merging main at `80b2207ec46c2e66d008ddc0f9de69a1b6646e2b`, a five-sample run alongside the build and full suite failed on the fifth 50-assignment current-source sample with a 506.134 ms heartbeat gap. That run did not pass. The benchmark failure now includes the complete sample metrics for diagnosis.

With the local build, Electron journeys and full suite stopped, the same five-sample benchmark and 250 ms assertion passed against that newer main revision. No production change was made between those two runs. This supports sensitivity to concurrent host load; it does not prove which competing task caused the failed gap. Other background work on the shared Windows host was not controlled. [Final raw samples](../../artifacts/agents-view/pr-final-performance.json) record the passing rerun.

| Saved assignments | Revision | Startup | Event median | Event p95 | Worst heartbeat | First page | Retained heap MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | Baseline | 12.058 | 0.055 | 0.084 | 5.375 | unavailable | 0.440 |
| 50 | Current | 23.748 | 1.206 | 1.815 | 66.957 | 0.419 | 0.879 |
| 5,000 | Baseline | 20.012 | 0.059 | 0.098 | 5.250 | unavailable | 0.421 |
| 5,000 | Current | 18.536 | 1.240 | 2.121 | 123.625 | 0.665 | 0.896 |

The integrated feature adds about 1.18 ms median event time and 0.48 MiB retained heap at 5,000 assignments. The 600 unpaced updates took 45.948 ms on the baseline and 955.796 ms with the feature. Small/large feature event times (1.206/1.240 ms) and heap (0.879/0.896 MiB) remain comparable. The lower measured large-archive feature startup is noise, not evidence of an optimization. Median final RSS was 131.504/159.973 MiB and RSS growth was 0.246/12.301 MiB; the native-memory caveats above still apply.

The integrated opt-in feedback/streaming command passed all four files and 62 tests in 13.87 seconds. Observed backend feedback was 0.695 ms against 47 ms simulated provider latency. No new timing budget or relaxed assertion was introduced.
## Regression coverage and limits

CI verifies constant archive work for 600 updates with 5,000 saved assignments: 1,830 indexed reads, 600 row writes, 600 assignment writes and zero archive-page reads. Separate classification tests verify conditional source/alias writes, duplicate suppression and indexed lookup without startup archive reads. Tests retain every saved result, page roster and assignments independently, preserve unaffected renderer rows and stop hidden or uncertain clocks. Provider tests exercise 5,000 assignments and ordinary activity eviction with bounded metadata caches.

The benchmark keeps production SQLite writes and workspace publication scheduling. Its deterministic provider does no parsing or child-process I/O; mapping, cursor recovery and projector retention require their separate regressions. It does not measure complete app memory or prove paid live-provider behavior. The heartbeat timing assertion is opt-in; structural bounds run in ordinary CI.

## Final status and migration follow-up

The final status-normalization, reset-marker and migration-order fixes were measured with the same five-sample workload against main `80b2207e`, after the local build and full suite stopped. All heartbeat assertions passed; the worst current-source gap was 198.706 ms. Shared-host background work remains uncontrolled. [Raw samples](../../artifacts/agents-view/pr-latest-performance.json) retain the final observations.

| Saved assignments | Revision | Startup ms | Event median ms | Event p95 ms | Worst heartbeat ms | First page ms | Retained heap MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | Baseline | 14.997 | 0.081 | 0.120 | 5.168 | unavailable | 0.446 |
| 50 | Current | 23.613 | 1.381 | 2.009 | 83.125 | 0.541 | 0.895 |
| 5,000 | Baseline | 31.011 | 0.079 | 0.110 | 5.207 | unavailable | 0.426 |
| 5,000 | Current | 41.168 | 1.385 | 2.271 | 198.706 | 0.611 | 0.850 |

The final 5,000-assignment sample medians show about 1.31 ms additional event time and 0.42 MiB retained heap. Small and large event times remain comparable. The separate 100 ms queue/250 ms native streaming command passed 62 tests in 12.02 seconds; observed backend feedback was 0.417 ms against 48 ms simulated provider latency. These passing runs do not erase the previously recorded concurrent-load failure or establish a new startup budget.