# Desktop thread shell — October 13, 2026

**Withdrawn October 15, 2026.** The change this note measures did not pay for itself: with the
envelope on, the broadcaster's send step rose from about 4–5 ms to 6.5–7 ms per send, and
main's total busy time while threads streamed was 5–8% higher than with it off, within noise
otherwise. The benchmarks this note names (`tests/perf/windowThreadShell*.perf.test.ts`,
`tests/perf/windowThreadShellPipelineElectron.perf.test.ts`) were removed with it. See
[ADR-0028](../adr/0028-agent-state-broadcast-omits-an-unchanged-catalog.md)'s October 15 amendment.

Step 4 of #991 starts from `b34e1d48be9e3495461fd35c847485e8906b520f`, after
steps 1–3 merged. Only the desktop broadcaster's thread encoding changes, under
the existing startup `streaming-publish-cost` Owl answer. Stable's array path,
complete `AGENT_GET`, command receipts and the socket protocol are unchanged.
[ADR-0028](../adr/0028-agent-state-broadcast-omits-an-unchanged-catalog.md) records
the ordered roster, revision, ownership, delivery and recovery rules.

## Shape and baseline

The opt-in fixture has 204 threads, 43 projects and 874 runtime models. Histories
are absent from its shell. Thread JSON is 332,003 bytes, including 128,737 bytes
of worktree/Git objects and 81,850 bytes of usage objects. Those worktree fields
are heavier than the audit's roughly 101–102 KB; this is generated schema data,
not padding or a copy of the owner's profile. Other shell fields stay whole.

The pre-edit run is retained outside the disposable worktree as
`.zstack/perf-991-remaining/step4-window-before.log` and its exit record (0).
One native `v8.serialize`/`deserialize` pair plus the old encoder cost roughly
1.37–2.10 ms warm and 6.98–7.04 ms cold. Warm payloads were approximately
310 KB; cold payloads 1,086,161 bytes. This is a wire approximation, not an
Electron/contextBridge measurement and not page reconciliation.

Initial optimized experiments exposed why bytes alone are insufficient. Cloning
all page thread bodies with `structuredClone` cost more CPU than the wire saving.
Reusing a previous writable output was rejected because retained states could
alias later states. The accepted narrow copier owns schema-data containers and
uses native whole-graph fallback for unexpected nonplain values. Main still
deep-compares every incoming whole thread against an owned snapshot; it does
not borrow mutable inputs or optimize ingestion (#925).

## Actual Electron boundary

`windowThreadShellElectron.perf.test.ts` runs a real Electron BrowserWindow,
main-to-preload IPC, isolated preload contextBridge callbacks, the actual page
wrapper and `createStateSharing`. It asserts complete output equality after each
paired run. Off/on/on/off order holds the fixture and mutation schedule constant.
The process CPU intervals span 220 publishes (20 warm and 200 measured); the
separate core interval spans the 200 measured publishes. Main and renderer CPU
are recorded separately, including encoder comparisons, private snapshots and
independent page output copies. This is a generated boundary fixture, rather
than the running Sotto UI or an installed-build measurement.

The first complete warm run, retained as `step4-electron-boundary-final.log`
(exit 0), includes reconciliation:

| Changed threads | Legacy bytes | Optimized bytes | Legacy main CPU/publish | Optimized main CPU/publish | Legacy total process CPU/publish | Optimized total process CPU/publish |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 310,280 | 12,097 | 1.00–1.35 ms | 0.78–0.85 ms | 6.04–6.33 ms | 1.20–1.21 ms |
| 3 | 310,226 | 15,069 | 1.56–1.70 ms | 0.64 ms | 7.39–8.03 ms | 1.14–1.49 ms |
| 6 | 310,145 | 19,529 | 1.06–1.07 ms | 0.57–0.71 ms | 5.90 ms | 1.21 ms |

Windows process CPU counters are sampled over whole batches because individual
callbacks can be below their accounting granularity. Main's Node GC observer
also records collection time. The renderer observer is not a complete Chromium
GC instrument; process CPU remains inclusive of the renderer's actual work.
This boundary measurement includes state-sharing reconciliation but does not
mount React or measure painting, frame scheduling or retained-detail splicing.
The running application journeys and existing shell/detail assembly tests cover
those behaviors separately.

## Coordinator chain

`windowThreadShellMain.perf.test.ts` uses the event-sourced synthetic adapters,
real thread store, provider switch, workspace, coordinator, local host service,
desktop router and coalescers with 1, 3 and 6 simultaneous streams. Steps 1–3
stay enabled on both sides; only the desktop broadcaster option varies. Each
round appends 180 chunks to each stream, with three rounds per case and paired
off/on/on/off cases. It reports CPU/chunk, CPU/publish, publication cadence,
sender CPU, wire bytes, event-loop utilization, GC and heap growth.

The final sender approximation performs `v8.serialize` in the sender and no
renderer deserialization in main. It is distinguished from the actual Electron
main process measurement above. Raw earlier combined-serialization experiments
and the initial project-shape failure remain preserved; they are not accepted
main-only measurements. The measured chain's actual metadata byte weights are
printed because coordinator projections can differ from the boundary fixture.

The serialize-only approximation regressed with native whole-thread comparison.
Profiling identified comparison of the 204 private snapshots as the dominant
new sender cost, while unchanged thread bodies were correctly omitted.

The full coordinator replay also ran inside Electron main, with actual
`BrowserWindow.send`, contextBridge, page reconstruction, state sharing and
retained-detail splicing. All 12 cases passed final shell equality. With native
comparison, main thread CPU/chunk ranged 7.82?8.77 ms legacy and 8.07?9.29 ms
optimized for one stream; 2.58?2.78 and 2.75?2.95 ms for three; 1.29?1.48 and
1.40?1.58 ms for six. Aggregate main-plus-renderer process CPU/chunk ranged
10.33?11.29 and 9.37?11.03 ms for one, 3.44?3.67 and 3.39?3.88 ms for three,
and 1.82?1.97 and 1.82?2.04 ms for six. These overlapping distributions do not
establish a consistent full-pipeline or main-process win. Boundary-only savings
above do not overrule this result. Publication cadence was about 14?17/s;
the first optimized one-stream round included 99 changed bodies over 49 sends,
then approximately one body per send. The fixture has 204 threads, 43 projects
and 875 runtime models, including two provider fixture models. Thread JSON
weight is about 339 KB, worktree metadata 128,693 bytes and usage 86,334 bytes.
Event-loop utilization from the Node observer was zero under Electron's event
pump and is not usable as evidence of idle time.

A bounded inert producer-data comparator experiment kept incoming data fresh,
with native root fallback for unusual shape, symbols, deep data and cycles.
An optional private-copy observer reused enumerated owned keys. The last
alternating/reversed replay includes all unchanged/1/3/6 changed-body rows,
400 publications per row. Legacy/optimized median sender wall milliseconds
were .571/.582, .542/.543, .573/.614 and .561/.632 respectively; thread CPU
medians were .645/.645, .605/.606, .645/.684 and .645/.665. This trial supplies
no clear sender win and does not justify accepting extra comparator/cache
complexity. Earlier stricter descriptor-based trials were slower and were
removed. No performance acceptance claim follows from an exit-zero shape test.
The final candidate ran the same complete chain inside Electron again. The
four cases use legacy/optimized/optimized/legacy order, with three rounds each:

| Streams | Main thread CPU/chunk, ms | Main process CPU/chunk, ms | Main + renderer CPU/chunk, ms |
| --- | --- | --- | --- |
| 1 | 10.506 / 9.633 / 10.500 / 10.333 | 11.289 / 10.333 / 11.200 / 10.506 | 13.806 / 11.722 / 12.761 / 12.761 |
| 3 | 2.980 / 3.674 / 3.067 / 3.674 | 3.241 / 3.878 / 3.269 / 3.761 | 3.848 / 4.370 / 3.906 / 4.513 |
| 6 | 1.822 / 1.693 / 1.736 / 2.069 | 1.939 / 1.895 / 1.866 / 2.113 | 2.444 / 2.286 / 2.229 / 2.676 |

Each cell gives the median of its three rounds in the stated pair order. Six
streams improve main, sender and aggregate CPU in both directions. One and
three remain mixed; this is not evidence that every stream count improves.
All 12 cases passed final reconstructed shell equality. Histories grow during
three fresh turns in every arm. Publication cadence ranges about 14?17/s;
all raw round counts, changed bodies, detail deliveries, process CPU and GC
remain in `step4-electron-final-candidate.log`. This run embeds Node 24.18.0 in
Electron 43.1.0; the launcher uses Node 24.14.1. Its initial connection and
complete snapshot setup precede the timed streaming intervals.

A separate actual Electron cold/full test rebuilds the broadcaster for every
send, including all private copying and shape registration. In the same pair
order, main core CPU/send is 3.75 / 8.28 / 8.67 / 4.69 ms and aggregate process
CPU/send is 19.318 / 27.836 / 27.700 / 20.241 ms. Full wire bytes rise from
1,086,161 to 1,096,854. The full snapshot costs more; the optimization targets
repeated streaming shells. Cold rows include 200 measured publications and
20 warm publications in their process CPU interval, with the latter counted
consistently in both arms. Full reconstructed output equality passed. Node
renderer GC observation is incomplete Chromium GC coverage, so zero there
is not evidence of zero renderer allocation. `step4-electron-cold-candidate.log`
and its native exit-zero record preserve this cost. Independent assessment retained the candidate for the measured six-stream
main and aggregate benefit, with this cold tradeoff and mixed lower stream
counts disclosed. It does not claim a universal main scaling improvement.

## Reproduce

```powershell
$env:SOTTO_PERF_BENCH='1'
npx vitest run tests/perf/windowThreadShell.perf.test.ts --maxWorkers=1 --disable-console-intercept
npx vitest run tests/perf/windowThreadShellElectron.perf.test.ts --maxWorkers=1 --disable-console-intercept
npx vitest run tests/perf/windowThreadShellMain.perf.test.ts --maxWorkers=1 --disable-console-intercept
npx vitest run tests/perf/windowThreadShellSender.perf.test.ts --maxWorkers=1 --disable-console-intercept
npx vitest run tests/perf/windowThreadShellPipelineElectron.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

Run one heavy job at a time. Benchmarks use generated data only, contact no live
provider, and do not read or print a personal transcript. They assert shape and
output, not a stopwatch budget. Raw logs and native exit records remain in
`.zstack/perf-991-remaining/` outside the owned worktree.
