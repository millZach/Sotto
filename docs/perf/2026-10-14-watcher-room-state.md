# Watcher room publication and owned remote inputs

Issue #991, step 5. Remote cached reads and the complete local matrix are measured below. The built Windows app passed its Watcher journeys; final gate results are recorded in the verification note.

Step 5 keeps the existing Watcher and streaming-publish-cost startup gates. It captures complete owned desktop room notifications inside a separate 50 ms desktop room window using the existing leading/trailing rules. Direct command answers flush pending notifications on success or failure and retain their own results. Local state projection already avoided a whole local shell clone before this work; no new credit is taken for that property.

The new room-only remote input reads requested thread facts from the actual cached host state. It returns owned primitive rows and owned request ID/kind arrays, reusing connectivity and settlement for each target. Public shell reads, socket ingestion/merge, observer/tool/Stop all snapshot semantics and phone events retain their existing contracts. Whole Watcher publication can still perform observation clones; zero room-triggered clones is not zero total Watcher clones.

## Remote baseline

Native Windows real paired socket cache, generated 204 threads, 43 projects and 875 models. Cache estimate 1,094,109 bytes using node:v8 serialization, not network bytes. Three rounds of ten synchronous state or Get reads isolate room reads from asynchronous ingestion and observers. Startup Watcher and existing streaming answers are true; future reader answers were explicitly inert in the baseline owners. Fixture SHA 83349983D2A14FFAB190F471DBE99583FEC86E510E4CA1321490B0C67BA67E81, source 7a1df9c6. Native0/18.74s. Byte accounting runs after aggregate CPU endpoints; counters add instrumentation overhead and Windows CPU resolution limits apply.

| Targets | Full-shell clones/read | Estimated copied bytes/read | state CPU/read | Get CPU/read |
| --- | ---: | ---: | ---: | ---: |
| 1 | 4 | 4,376,436 | 23.4 ms | 23.5 ms |
| 3 | 12 | 13,129,308 | 75.0 ms | 73.4 ms |
| 6 | 24 | 26,258,616 | 154.6 ms | 170.2 ms |

Remote AFTER on `1681abdb50a75056bdf724addae5c6549c488044` completed native exit 0 in 3.31 seconds, all eighteen rows retained, with the exact same benchmark fixture. All scoped full-shell calls/clones and their estimated copied bytes were zero. These are counts of whole cached-shell copies, not counts of all bounded record/input copies or whole Watcher publication work.

| Targets | Method | BEFORE wall/10 reads | AFTER wall/10 reads | BEFORE process CPU/10 reads | AFTER process CPU/10 reads |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | state | 238.309 ms | 0.358 ms | 234 ms | below resolution |
| 1 | Get | 228.936 ms | 0.366 ms | 235 ms | below resolution |
| 3 | state | 755.823 ms | 0.549 ms | 750 ms | below resolution |
| 3 | Get | 700.927 ms | 0.540 ms | 734 ms | below resolution |
| 6 | state | 1,509.398 ms | 1.033 ms | 1,546 ms | 15 ms |
| 6 | Get | 1,631.301 ms | 1.187 ms | 1,702 ms | below resolution |

Entries are medians of three ten-read rounds. Zero process-CPU deltas do not mean free work; the six-target state samples include 15/16/0 ms Windows ticks. Wall time and actual clone counts remain useful below that CPU resolution. Both runs acquired an expanded quiet guard; the short AFTER had no mid-run resource sample, so no system-isolation claim is made. This benchmark proves scoped cached reads, not remote command delivery, paint or live providers. Full room value/ownership equality has separate durable tests.

## Local comparison and adverse result

AFTER04 was interrupted by the app restart after ten cases and thirty strict rows; it has no native exit marker and is not an accepted full matrix. Its complete log, thirty rows and observed external Playwright overlap remain retained. AFTER05 is one authorized full replacement on unchanged clean 1681abdb, with the same fixture, workload, CPU endpoints, oracle and deadlines; no missing cases are spliced into AFTER04. Its external wrapper records case-output receipt times, which do not establish per-round start times.

Use AFTER05's own counterbalanced immediate/coalesced/coalesced/immediate arms, six samples per arm at each of one, three and six streams. Upstream steps and WatcherService/router cost answers stay enabled equally; only the desktop room publisher varies. The real remote API is attached, with zero remote participants. Retain all 36 rows, positional variation, source projections, captures, main-thread and main-process plus renderer CPU, wall time, send count, estimated payload bytes and strict final-state receipt/equality. Main CPU is process.threadCpuUsage; chain CPU is process.cpuUsage plus renderer CPU. The corrected fixture prevents causal CPU comparison with historical AFTER03.

AFTER05 completed native exit 0, twelve cases and all thirty-six strict rows in 372.74 seconds, from 23:53:48.971 UTC to 00:00:02.465 UTC. No rows were pruned. Pooled medians of six rounds per arm:

| Streams | Main-thread CPU/chunk immediate → coalesced | Chain CPU/chunk immediate → coalesced | Sends/round immediate → coalesced | Wall/round immediate → coalesced |
| --- | ---: | ---: | ---: | ---: |
| 1 | 23.481 → 22.142 ms | 29.511 → 26.561 ms | 96.5 → 73.5 | 5,603.434 → 5,506.632 ms |
| 3 | 11.473 → 11.472 ms | 13.584 → 13.612 ms | 99 → 94.5 | 7,987.862 → 7,951.575 ms |
| 6 | 7.986 → 7.241 ms | 9.325 → 8.594 ms | 100.5 → 93 | 10,435.426 → 9,120.569 ms |

These are observed within-run values, not a general local CPU gain or evidence of a local runtime fix. At three streams main-thread CPU is effectively unchanged and chain CPU is slightly higher. The quiet start had 9,372,544 KiB free. Resource samples01–03 saw only the owned fixture under the expanded guard; sample04 at16:57:10 found external Usage Playwright, and samples05–06 found a later external Usage full suite. All cases and positions remain in the raw log and summary. The earliest recorded external launcher65628 started at16:56:57.496-07:00. All one-stream cases had emitted by16:55:24.110, and the first three three-stream cases by16:56:54.513; that early three-stream comparison is already mixed. External receipt timestamps bound completed cases, not exact per-round starts or causal load. Keeper and fixture cleanup plus clean1681 were verified after completion.

Historical AFTER03 on ca5d816 completed all 36 rows but raised a material concern. Immediate to coalesced main CPU/chunk was 12.369→14.803,6.915→7.262,8.058→8.572ms; chain CPU 14.186→18.272,7.914→8.651,9.274→9.960ms. Sends fell 88→57.5,93.5→68,98.5→95. The early one-stream increase precedes the late external suite, so overlap does not explain it. Capture wall and projection counts do not provide an additive explanation. Do not call this a CPU win or discard slow rows.

Six bounded strict profile rounds on 7a1df9c6 passed. Their timings reversed the ordering and are diagnostic only. Sampled main-thread profile work is dominated by shared observer/control clones, activity copies and provider-ID parsing; this is not an additive explanation of timed CPU. No confirmed optimized-only mechanism accounts for the earlier increase. Traces include profiler overhead and post-CPU validation, and main-thread profiles cannot account for renderer or worker CPU. No speculative local coalescer fix follows. The completed fresh unprofiled matrix has mixed results; it does not establish a general CPU gain.

Historical preimplementation baseline01, failed AFTER01, completion-boundary diagnostic, corrected baseline02 timeout, stage probe, clone-interceptor ABBA, integrated BEFORE03 and AFTER03 remain separately documented. The completion handshake owns an independent pre-publisher source candidate and waits for its natural renderer callback under one ten-second deadline; it never gets/flushes manually. The outer matrix deadline is 900 seconds to allow all cases, not a CPU assertion. No changed-boundary baseline is silently substituted for an earlier one.

## Proof limits

Local matrix: real Windows Electron IPC/contextBridge and selected shell/detail assembly in a synthetic page, not React paint or whole-app CPU. Remote benchmark: real cache ingestion followed by scoped synchronous reads. The built Windows app passed seventeen Watcher and gate journeys; inspected captures and final exact gates are recorded in the verification note. No installed release, live provider, Mac/Linux desktop or native-phone result is claimed. Both matrices start only after the expanded quiet guard; disclose every observed mid-run competitor and sampling limits.
