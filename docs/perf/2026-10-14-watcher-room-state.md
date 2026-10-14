# Watcher room publication — October 14, 2026

Issue #991, step 5. **After measurements pending.** The pre-implementation baseline below is complete; it establishes no performance improvement or completed implementation.

## Starting point

The pre-Step-5 source is `ec06e9d6fe5bede6e03346303e262f6fee5fa2c1`, after steps 1–4. `WatcherService.state()` already projects from `AgentControl.watcherSnapshot()` without cloning the whole local shell. `watcherRecord()` still copies the bounded Watcher record, and room projection still allocates its own objects. The remaining desktop notification subscription in `main/index.ts` sends each projected room immediately.

Remote participants have a separate existing path: `owningSnapshot()` asks the desktop host router for the owning host, whose socket service clones its cached remote state. This work preserves that path. The local-only benchmark below does not measure remote clone cost and cannot establish a remote saving. Distinct Watcher reconciliation and tool reads also remain outside the room projection change.

## Comparison

Run on a quiet native Windows laptop, with no other full suite or Electron journey:

```powershell
$env:SOTTO_PERF_BENCH = '1'
npx vitest run tests/perf/watcherRoomPipeline.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

Both sides enable Watcher and the existing `streaming-publish-cost` answer throughout the workspace, coordinator and desktop shell encoding. Muse is off; only the generated Claude and Codex providers connect. The comparison varies only the desktop room publication seam. A stable/disabled-gate correctness control is not the CPU baseline.

The generated fixture uses the existing adapter message logs, certified activity publication, provider switch, workspace, coordinator, local host service and desktop host router. It materializes 204 threads, 43 projects and 875 models from the step-4 fixture and enabled provider catalogs. Real Watcher hooks observe one, three or six local participants. An unavailable retained master prevents any model turn. Its request includes display proofs, a follow-up and receipt records; checkpoint observations supply evidence. No user profile is opened.

Each case has three rounds of 180 chunks per streaming thread, with a two-millisecond gap and one generated command record every 25 chunks. It includes the final idle publication and a 150-millisecond quiet tail. The CPU-per-chunk denominator is `180 × streaming threads`, not the number of IPC sends. Modes alternate off/on/on/off for each stream count. The before-source run intentionally uses the legacy room sender for both labels; only the after-source run can exercise the new room publisher.

The native Electron main process sends room, shell and detail payloads through real IPC. The preload forwards every payload across contextBridge. The synthetic page applies Sotto's real shell reconstruction, detail deltas and state sharing; each case resets its caches. It receives the complete room in a page callback. This measures transport and page assembly, not React painting or a person's interaction with the built app.

## Measurements to retain

Record the exact source, command, native exit, machine/resource state and raw round output for every run. Report main-thread CPU separately from main-process CPU. The total CPU column adds measured main-process and renderer CPU; it is the generated chain, not the whole running Sotto UI or system CPU. Preserve round variation rather than declaring a universal win from one median.

Count room projections and local shell reads during those projections separately from all bounded Watcher-record copies. The local projection shell-read count is expected to be zero before the change; that is an already shipped property. Projection counts need not fall when only delivery is coalesced. Added room-capture copies and their CPU must be included in the after result. The fixture has no remote participants; no remote-copy measurement is inferred from that absence.

Attempted and successful sends describe calls/enqueues on the live fixture window, not acknowledgements of every rendered state. `wireBytes` is the sum of `node:v8.serialize()` payload lengths, a size estimate rather than measured Chromium wire traffic. Byte serialization and JSON equality run after the CPU interval, so fewer sends cannot create an artificial stringify/serialization CPU win. Timed counters, bounded-record instrumentation and retained sent-payload references still add overhead; disclose it with the results.

The final page room must equal the independently retained latest projected room from before the publisher, including its `observedAt`. Comparing only with the last payload sent would miss a dropped trailing event. This equality is separate from the gate, nested capture ownership, direct-reply ordering, absent-window recovery and paired Stop-all correctness tests.

## Results

The baseline ran on the Windows development laptop from 18:50:59.501 to 18:55:32.324 UTC, native exit 0, one perf test in 272.46 seconds. Production was unchanged from `ec06e9d6`; only the prepared fixture/tests and draft documentation were present. Both labels used the prior immediate **room publisher**, with steps 1–4 enabled. They are not stable-versus-Owl comparisons. The fixture source's SHA-256 was `508064e6edddb38d0dcaf6c8d9ae4de4c3227f1bbf91921b632a20e0ad626f2c`; the perf entry's was `1778c094783331304e6f492e6e96b9103614d21c02e4c1e53cd7561fa75177c6`. Exact copies and raw start/log/exit records are retained in the durable run folder.

Pooled medians of twelve baseline rounds per stream count (all four labels execute the same prior room path):

| Streaming threads | Main-thread CPU/chunk | Main-process + renderer CPU/chunk | Room sends/round | Estimated room bytes/round |
| --- | ---: | ---: | ---: | ---: |
| 1 | 12.328 ms | 14.633 ms | 87 | 351,215 |
| 3 | 6.569 ms | 7.394 ms | 98 | 991,649 |
| 6 | 5.028 ms | 5.882 ms | 93.5 | 1,799,109 |

All 36 rounds passed exact latest-projection/page-room equality after the final idle publication and quiet tail. Room projections equalled room sends on this prior path. Every round recorded zero local shell reads **during room projection**; that was already true before this change. Bounded record copies and existing non-projection Watcher reconciliation/tool shell reads remain. This Watcher-enabled chain therefore measures substantially more work than the earlier Watcher-disabled step-4 fixture.

The initial quiet-slot check had about 12.3 GiB available and no full-suite/build/Playwright job. Mid-run checks at 18:52:52 and 18:54:30 UTC found no such competitor. A subsequent unrelated full suite started at 18:57:23, after the baseline ended. Per-copy Windows CPU deltas were quantized, including zero readings and roughly 15–16-millisecond ticks; those sums are not precise clone-cost measurements, and zero does not mean copying is free. Use aggregate pipeline CPU and actual copy counts as the primary evidence.

After measurements and paired prior/optimized room comparisons remain pending. No CPU saving, send reduction or scaling improvement is established by the baseline labels.

## Limits

Generated local data and synthetic providers; native Windows Electron IPC/contextBridge and page assembly. No installed release, paid/live provider, remote host, phone, macOS, Linux desktop or React painting result is claimed. Running-app journeys and independently inspected captures belong in the separate verification note.
