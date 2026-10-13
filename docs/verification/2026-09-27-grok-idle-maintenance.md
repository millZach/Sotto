# Grok history maintenance and idle age (#440)

An empty history poll no longer counts as activity. An owned read still defers its session's stop; a later sweep that sees it settled rechecks watched state, active work and current activity age. Another eligible session can stop while that read remains held. Newly accepted provider history events renew the idle window, as foreground refreshes and live notifications already do.

The correction adds one optional read predicate to the existing reaper. There is no new timer, queue, promise drain or per-poll sweep. The existing sweep cadence and stop serialization remain unchanged. Continuously overlapping in-flight reads remain protected; this does not promise a close while a read is in progress or an immediate close callback when it finishes.

The original controlled witness used the real adapter and fake Grok process, accepted creation, a controlled clock and held history RPCs. With a 150 ms idle threshold, sweeping after settled reads closed after eight reads / 160 ms. Sweeping during reads kept the session resident through 600 empty reads / 12,000 ms, with no provider or user activity. It then needed a further quiet 150 ms. One control passed and one desired assertion failed in 2.94 seconds. This proves a nearby product defect, not the cause of the historical CI failures in #218 or #310; those runs retained no eligibility trace. Both reports remain open.

The committed regression checks 600 overlapping reads, then sweeps immediately after the final read settles. On unchanged production at `671d4807`, this remained open. A second regression supplies a durable-only event from the fake provider and proves it receives its own full idle window; the old code stopped that session immediately after reading the event. The foreground refresh control passed before the change. Four shared-reaper cases cover read protection, another session's progress, and activity/watch/work appearing while a read is deferred.

The baseline command for the two files reported six failed and seven passed in 3.82 seconds. The same command after the correction passed all thirteen in 3.20 seconds:

```sh
npx vitest run tests/unit/main/sessionReaper.test.ts tests/integration/grokIdleMaintenance.test.ts --maxWorkers=1
```

Review found two ownership edges. A rejected model create followed by reconnect leaves an unloaded, unconfirmed alias whose durable history an explicit refresh can still read. The new unconditional history touch enrolled it; the public-path regression failed before adding a `loaded` guard. A shared sweep could also capture a later session's old activity age before awaiting another session's close. Two held-close cases proved that new activity and forgetting the later session were ignored. The sweep now snapshots IDs and reads each current timestamp when it reaches that session. It adds no await and preserves the existing stop order.

Final verification passed 64 tests with six skipped across the shared reaper, new maintenance cases, Grok adapter contract, Grok failure/recovery and current-residency observations (five files, 25.62 seconds, one worker). Three-project typecheck, lint and notices verification (174 components) passed. Native Standards review found no findings on the initial implementation; the Spec and parent findings above were corrected. Independent native Astra Standards and Spec reviews of the final ownership corrections at `33db6c64` both found no findings.

The owned baseline and corrected logs are under ignored `artifacts/review-440/`. Every provider run used an absent owned performance-data path, with live-provider and timing flags cleared. No production profile, paid provider or UI surface was used. The final reviewed integration full gate will run on the combined candidate in isolated hosted CI; repeated local full attempts in other lanes exhausted native process memory even when run serially. No full pass is claimed here yet.
