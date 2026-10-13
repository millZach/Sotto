# CPU use with multiple threads

The initial investigation below preceded the authorized local implementation. Implementation measurements follow at the end. The installed app and live threads were not changed or restarted. The installed Sotto 0.1.15 build provenance and this checkout both name `11e60a67f5529a1eefad5be5bc5990ef069f5205`.

## Findings

There is measurable CPU use in Sotto itself, and a reproducible scaling cost in its activity snapshot pipeline. One thread's update repeatedly copies and merges unchanged threads' retained activity records. This is a verified optimization target, not a complete attribution of the live application's CPU use.

Live Windows process counters on September 23, 2026, normalized over 24 logical processors:

| Process | Initial 10-second sample | Three later 5-second samples |
| --- | ---: | ---: |
| Sotto main | 2.90% machine CPU | 4.30–4.45% |
| Primary renderer | 1.20% | 1.35–1.76% |
| GPU process (CPU time, not GPU utilization) | 0.49% | 0.39–0.52% |
| Other renderer | 0.12% | 0.16–0.22% |

The later main-process samples represent approximately one logical CPU's worth of work. They were taken after the synthetic benchmark exited. The user's workload was not controlled or paused. In the initial sample, each of the three busiest Claude processes used 0.31–0.34% machine CPU, and Codex used 0.03%. These are interval deltas of `Get-Process.CPU`, not lifetime CPU totals. Other commands, builds and tests can also appear beneath Sotto in Task Manager; they are not included in the table above.

## Reproduction

Run with the project's dependencies installed:

```powershell
node tests/perf/multiThreadCpu-bench.mjs
```

During the initial investigation, this checkout had no `node_modules`. That invocation reused existing dependencies without linking or modifying them (dependencies are now installed locally):

```powershell
$env:SOTTO_BENCH_MODULES = 'D:/Talk to Text Application'
node tests/perf/multiThreadCpu-bench.mjs
```

The harness bundles the current production `WorkspaceHost` and `cloneHostSnapshot`, feeds a synthetic event-capable provider into them, subscribes to workspace snapshots, and changes one thread's valid usage metadata 1,000 times. Each command activity has 4 KiB of synthetic output. Only one thread is observed; all others retain unchanged activity records. It uses isolated temporary SQLite stores and removes its own temporary directory afterward. It never reads credentials or user conversation text.

Three samples per case alternate thread-count order. Initial population and 20 warm-up updates are excluded. All activities and usage values are checked against their production schemas without losing fields. CPU is measured with `process.cpuUsage`; a local V8 profiler identifies hot functions. Very short cases approach Windows CPU-counter resolution, so zero does not mean no work. Profiling overhead is included. Output publication retains its real 16 ms coalescing and storage retains its 250 ms cadence; this is a burst test, not a fixed real-time stream rate.

Median CPU milliseconds per incoming update:

| Retained activities per thread | 1 thread | 4 threads | 8 threads |
| --- | ---: | ---: | ---: |
| 0 | 0.016 | 0.016 | 0.031 |
| 50 | 0.063 | 0.219 | 0.374 |
| 500 | 0.500 | 2.203 | 5.796 |

[Raw synthetic measurements](evidence/2026-09-23-multi-thread-cpu.json) retain all 27 cases and their largest profiler self-time samples. In the final eight-thread, 500-activity case, `cloneValue` sampled about 3.14 seconds and `mergeAgentActivities` about 1.61 seconds over a 5.74-second measured interval. `settledHeadMovers` was a further 0.31 seconds. These sample totals are approximate and are not a live-app stack profile.

A read-only aggregate query against the local activity database found 51 threads with stored activities, including nine with 536–777 records. Their payload sizes were approximately 1.6–3.0 million characters. No titles, thread IDs, prompts or output text were retrieved. This supports the relevance of the 500-record scenario; it does not establish how many of those histories were loaded or running during the CPU samples.

## Why it scales

- `claude.ts:view` and `codex.ts:current` call `cloneHostSnapshot` over their project threads. The custom clone shares immutable strings but still walks and copies every nested object and array.
- `providerSwitch.ts:accept` copies the connected provider's snapshot again. Its aggregate includes all provider slots.
- `workspace.ts:accept` visits every incoming thread. `mergeAgentActivities` rebuilds a map, creates merged records, sorts and returns a new array even when that thread's activities did not change. Its branch-refresh checks also build sets from old and new activity lists for every thread.
- `workspace.ts:publish` creates another workspace copy. Coalescing bounds the publication rate but does not remove the per-snapshot acceptance work that happens before it.
- Activity persistence and subagent tracking have additional scans. They were not the dominant functions in the validated ordinary-command fixture. Subagent hashing warrants a separate fixture before assigning it a CPU share.

The benchmark covers the provider-style clone, workspace acceptance and workspace publication. It excludes the real provider switch, coordinator, IPC, renderer, actual transcript parsing and native clients. Its results should not be multiplied into a promised machine-wide CPU saving.

Claude's transcript poll runs once per second per adapter and checks its session logs. The reader retains a byte cursor and parses only newly appended data; it does not routinely reread entire unchanged transcripts. Polling has a cost, but this investigation does not identify it as the main cause. The renderer also consumes meaningful CPU and needs its own live profile before prioritizing rendering changes.

## Recommended work

1. Carry per-thread and per-activity change information across adapter, provider switch and workspace boundaries. Preserve immutable data for unchanged threads so the acceptance path can skip their activity merge, branch checks and publication copies. Keep full reconciliation for reconnects, history resets and recovery. Keep command and permission delivery immediate. Merely comparing object identity in `WorkspaceHost` will not suffice while upstream clones replace every object.
2. Use the same change tracking to avoid repeated unchanged activity synchronization. Preserve retention changes, redaction, epoch resets and failed-write retries; do not use a shortcut that can silently skip those transitions.
3. Profile the renderer under the user's multi-thread workload after the backend improvement. Investigate redundant rendering and subscriptions while preserving display cadence, permission delivery and user actions.

Before shipping a fix, repeat this benchmark with a before/after comparison and verify the actual streaming journey with several providers, background threads, pending questions, reconnects and history resets. Record live CPU again under comparable activity. An idle/minimized comparison remains unmeasured because this investigation did not change the user's running session.

## Investigation-stage verification and uncertainty

- Completed: live process attribution, installed/source revision match, repeatable synthetic scaling experiment, sampled function attribution and read-only aggregate workload-size check.
- Completed: schema assertions and thread-count assertions in all 27 benchmark cases; ESLint for the new diagnostic script; `git diff --check`.
- At the investigation stage, no production code had changed. Implementation and verification after the authorized go are recorded below and in the verification note; the original live measurement remains an attribution sample, not a before/after trial.

An initial exploratory fixture had non-schema fields and was discarded. The saved evidence is exclusively the corrected, schema-validated run. The cause confirmed here is repeated work on unchanged activity data; its exact share of the user's live CPU remains open.


## Implementation measurements

The comparison harness reads the fixed baseline directly from Git and runs baseline and candidate in isolated Node child processes, alternating their order over five pairs. It covers usage, command growth/completion, subagents, message appends, mixed thread updates, long histories and idle thread summaries. It compares final activity, messages and durable records plus event order within each thread. Independent threads may interleave their SQLite events differently without changing their own ordering.

The event-capable synthetic provider follows native adapters' append-event contract. Its public snapshots remain writable; the candidate internal path shares certified activity trees. This differs from the earlier exploratory whole-history fixture, so only results from the same comparison harness should be compared numerically.

The final comparison includes the required durable flush in the CPU interval. Five alternating pairs of 1,000 updates with eight threads and 500 retained activities each reduced median CPU per usage update from **2.142 ms to 0.063 ms (97.1%)**. Update p95 fell from 2.864 ms to 0.022 ms. These are from the final production source and supersede earlier runs, including the preliminary result that excluded final flush. Very short cases can fall below Windows CPU-counter resolution; a reported zero is not zero CPU.

| Repeated scenario | Baseline CPU ms/update | Candidate CPU ms/update | Result |
| --- | ---: | ---: | --- |
| Eight threads, 500 activities, usage | 2.142 | 0.063 | 97.1% lower |
| Eight threads, 500 activities, command updates | 2.547 | 0.188 | 92.6% lower |
| Eight threads, mixed updates, final startup check | 0.798 | 0.530 | 33.6% lower |
| One empty thread, 10,000 updates | 0.016 | 0.017 | Tiny 0.001 ms increase; p95 unchanged at 0.008 ms |

In the long eight-thread usage case, retained heap was 32.618 to 32.489 MiB (-0.4%), RSS 211.973 to 128.969 MiB (-39.2%), and initial setup 190.104 to 190.244 ms (+0.1%). Restored archive startup in this final run was 59.919 to 60.130 ms (+0.4%). Final restored-archive checks were 37.056 to 39.605 ms for 2,000 activities (+6.9%) and 56.515 to 62.062 ms for the mixed scenario (+9.8%). Startup varied across trials. An earlier repeatable archive penalty above 10% led to removing eager freezing of private disk-loaded history; the first live merge establishes ownership instead. Recovery, privacy and isolation tests pass after that adjustment.

The harness checks activity/message/durable parity, per-thread event ordering, public writable isolation, and baseline reopening of candidate-written data. It records absolute post-GC heap/RSS and archive startup separately. [Full matrix](evidence/2026-09-23-multi-thread-cpu-comparison.json), [long usage](evidence/2026-09-23-multi-thread-cpu-long.json), [command](evidence/2026-09-23-multi-thread-cpu-command-long.json), [empty](evidence/2026-09-23-multi-thread-cpu-empty-long.json), [final archive](evidence/2026-09-23-multi-thread-cpu-archive-startup-check.json), and [final mixed](evidence/2026-09-23-multi-thread-cpu-mixed-startup-check.json) retain individual samples. Earlier raw runs remain as investigation evidence, not additional independent final results.

These measurements exclude native-provider parsing, the coordinator, IPC and renderer. Separate Electron checks use a legacy fixture and therefore test the downstream path and responsiveness, rather than reproducing the full native-provider saving. The installed app and active user threads have not been changed or stopped. No live account invocation is needed for this evidence.

The compatibility path has its own long comparison with `SOTTO_PERF_LEGACY=1`: eight threads, 500 activities and 1,000 updates per pair. After preserving the established clone path for snapshots with no owned arrays, median CPU was 2.094 to 2.156 ms/update (+3.0%), p95 2.889 to 2.913 ms (+0.8%), startup 183.576 to 196.127 ms (+6.8%), retained heap 32.616 to 32.651 MiB (+0.1%), and RSS 212.609 to 211.426 MiB (-0.6%). This path reconciles fully and does not claim the native-path CPU saving. [Legacy raw measurements](evidence/2026-09-23-multi-thread-cpu-legacy-long.json).

## Electron CPU and interaction checks

The final legacy-provider Electron experiment attempted five alternating pairs. Four baseline and three candidate trials completed; one baseline and two candidate trials lost the Electron automation execution context during measurement. Incomplete runs remain in [raw CPU evidence](evidence/2026-09-23-multi-thread-cpu-electron.json) and are excluded from the following medians. This is a limited descriptive comparison, not a five-complete-pair performance claim or proof of a total-app CPU reduction.

| Window state, 18 stream updates | Main CPU ms, baseline / candidate | Renderer CPU ms, baseline / candidate |
| --- | ---: | ---: |
| Visible | 1,341 / 1,317 | 393 / 364 |
| Unfocused | 1,157 / 1,097 | 370 / 336 |
| Minimized | 796 / 768 | 152 / 145 |

Intervals last at least 1.1 seconds and include update injection. Main working-set medians were approximately 539 / 518 MiB visible and 618 / 615 MiB minimized. Launch medians were 723 / 736 ms. Completed trials restored the latest streamed text and kept a pending permission actionable. Main CPU is not reduced by the native-path percentage because this fixture publishes legacy mutable snapshots.

The final four-pane interaction experiment completed two baseline and two candidate runs at both 80 and 2,000 messages per thread. All sends, typed inputs, focus changes and final stream versions arrived. Baseline passed both runs; candidate passed one and missed the unchanged 300 ms maximum injection-to-display bound once at 318 ms. Earlier baseline diagnostics also missed display limits, including 354 ms staleness. [Final interaction evidence](evidence/2026-09-23-multi-thread-cpu-interactions.json) and [earlier diagnostics](evidence/2026-09-23-multi-thread-cpu-interactions-diagnostic.json) retain the differences.

| p95 across the final scenarios | Baseline range, ms | Candidate range, ms |
| --- | ---: | ---: |
| Send to next frame | 30.1-49.2 | 28.6-32.4 |
| Pane focus to next frame | 23.7-39.2 | 29.8-37.9 |
| Detail arrival to next frame | 29.8-38.7 | 27.3-38.7 |
| Send acknowledgment during streaming | 27.9-45.3 | 36.8-42.3 |
| Typing during streaming | 23.5-26.6 | 22.9-33.9 |
| Injection to display during streaming | 120.4-149.3 | 104.1-195.4 |

These ranges do not establish equivalence for every interaction or eliminate timing risk. Occasional display spikes and automation interruptions remain a release-verification gap. No budget, production cadence or agent execution limit was relaxed to obtain these results.
