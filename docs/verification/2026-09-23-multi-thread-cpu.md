# Multi-thread CPU verification

Local implementation against `11e60a67f5529a1eefad5be5bc5990ef069f5205` on Windows 11, Intel Core Ultra 9 275HX, 24 logical processors. The installed Sotto and user conversations were not changed. This note records the local implementation evidence; subsequent authorized PR delivery and CI results are linked below. No release or installation is part of this change.

## What changed

Native adapters publish owned immutable activity trees on an optional internal subscription. Unchanged histories reuse their merge, classification and detail-signature results. SQLite skips unchanged activity scans only after successful persistence and still checks reset/privacy state. Public snapshots remain isolated and writable. Mutable legacy hosts still reconcile fully.

Connection epochs reject stale callbacks. Archive/disconnect/removal evicts live-input caches. Graceful shutdown retains final command events before detaching subscriptions. Tests cover retained snapshot immutability, in-place legacy changes, provider interleaving, failed-save retry, same-epoch reset, redaction, reconnect and bounded cache lifetime.

Legacy snapshots without any certified activity array use the original deep-copy routine. Mixed snapshots still share only certified trees.

No concurrency, capability, tools, permission, display cadence, polling, model, priority, history retention or execution limits changed. There is no dependency, network host, wire or disk-format change.

The final native-style eight-thread/500-activity benchmark, including durable flush, measured **2.142 to 0.063 CPU ms/update (97.1% lower)**. The legacy compatibility benchmark was within the plan's neighboring-regression thresholds. [Full measurements](../perf/2026-09-23-multi-thread-cpu.md).

## Required gates

- `npm test -- --maxWorkers=2`: **376 files passed, 19 skipped; 4,861 tests passed, 44 skipped** before the final archive-startup and legacy-copy adjustments. After both adjustments, all **109 focused recovery, privacy, persistence, pane, snapshot, signature and message-log tests passed**. The first suite was started while review fixes were still being integrated and caught the new archive-cache assertion against the previously loaded module; the complete final rerun passed.
- `npm run typecheck`: passed on the final production and performance-test source.
- `npm run lint`: whole-tree check passed on the final source.
- `npm run notices:verify`: passed, 174 components.
- `npm run runtime:prepare` and `npm run build`: passed. Runtime preparation made line-ending-only tracked changes, which were restored.
- Full-suite coverage includes scripted Codex, Claude, Grok and Devin adapters, coordinator authority, headless/socket contracts, multi-client routing, persistence and recovery. No paid or live native account suite was run.

The opt-in performance run initially hit 107 ms in an unchanged renderer-only send test against its 100 ms bound while an Electron diagnostic was active. The final-source quiet rerun passed all **76 tests**, retaining the 100 ms send/acknowledgment and 250 ms heartbeat bounds.

## Electron journeys

The initial affected batch passed 17 of 25 tests. Correct host-qualified identity assertions let two additional `agentAnswers` journeys pass. Both daily workspace journeys passed on the final build; the initial terminal-file wait failure did not reproduce. The first daily journey also passed on the baseline.

Five failures remain reproducible on the fixed baseline as well as the candidate:

- Two `agentAnswers` journeys answer Workshop successfully but do not advance selection to the pending Docs thread.
- One `agentControl` journey expects Later to select Docs, but selection remains Workshop.
- Two `provider-recovery` journeys time out before completion. Their exact stalled action was not established by the baseline run.

These assertions remain intact; the result is not an all-green Electron suite. Passing journeys cover permission denial, recovery, migration and restart, native Devin through the adapter, tools and subagents, drafts, independent worktrees and local publishing fixtures. The CPU change does not claim to fix the five baseline failures.

The new CPU window journey and the existing four-pane performance journey provide separate before/after measurements. The latter required test-only repairs: host-qualified IDs, streamed messages from the detail channel, and observation of each submitted user message. Normal isolated-stream coalescing is recorded, all input updates and final sequence remain checked, and every latency bound is unchanged.

Final CPU trials completed four baseline and three candidate runs; one baseline and two candidate attempts lost the Electron automation execution context. Completed runs passed visible/unfocused/minimized streaming, restore and permission denial. Their CPU and working-set medians are similar or lower, but the incomplete sample set does not establish a whole-app reduction.

Final interaction trials passed both baseline runs and one of two candidate runs. The other candidate run exceeded the unchanged 300 ms injection-to-display maximum once at 318 ms. Earlier baseline diagnostics reached 354 ms. Every final send, typed input, focus action and final stream version was observed. Display timing remains a release-verification gap; this is not an all-green performance result. See [CPU and latency evidence](../perf/2026-09-23-multi-thread-cpu.md#electron-cpu-and-interaction-checks).

## Visual inspection

Inspected current Windows captures at 1600x1000 dark, 1280x800 light and the 820x560 minimum. The thread composer, subagent roster, status, Tools and navigation remain legible and usable; deliberate clipped previews retain their expansion controls. The final CPU journey also checks dark, light and reduced-motion permission handling at these sizes. No styling changed and no design baseline was regenerated.

- [1600 dark](../../artifacts/activity-performance/cpu-agents-1600-dark.png)
- [1280 light](../../artifacts/activity-performance/cpu-agents-1280-light.png)
- [820 light](../../artifacts/activity-performance/cpu-agents-820-light.png)

- [Four panes, 1600 dark](../../artifacts/activity-performance/cpu-1600x1000-dark.png)
- [Four panes, 1280 light](../../artifacts/activity-performance/cpu-1280x800-light.png)
- [Permission, 820 reduced motion](../../artifacts/activity-performance/cpu-820x560-reduced-motion.png)

## Review and remaining scope

Independent Standards review found reconnect, disposal and in-flight shutdown lifecycle issues; all were fixed and re-reviewed. Independent Spec review found unbounded live-input cache retention; eviction and a three-cycle cardinality test resolve it. Weak derived views remain attached to deliberately retained histories and cannot retain superseded source arrays on their own. Retained-memory measurements, rather than deleting history, assess their cost.

The lead kept ownership design, merge/persistence invalidation and final review. Adapter wiring, fixture extensions, harness construction and focused checks were delegated to `gpt-6-sol` at high effort, then reviewed and independently checked. Measurement boundaries were tightened during lead review to include the final durable flush, archive startup and baseline reopening of candidate-written data. The lead took back final Electron measurement and test-instrumentation review after repeated diagnostic failures. The legacy provider path no longer pays an unnecessary deep-freeze pass; an independent review and nested subscriber-isolation regression test cover that adjustment.

Apple silicon macOS, live native accounts and a controlled before/after trial of the user's real workload remain unverified. Fixture CPU savings cannot be stated as a percentage reduction in total live Sotto CPU. Windows baseline failures above prevent an unqualified release-readiness claim.

## Pull request verification

The user authorized committing, publishing the PR, monitoring CI and review, and merging after the required checks pass. [PR #279](https://github.com/millZach/Sotto/pull/279) records the final local two-worker suite and hosted CI outcomes. Existing local Electron limitations above remain disclosed; green CI does not substitute for live-account or macOS verification.

The committed-diff Standards review found no hard violations; its only optional smell was the small activity-certification loop repeated across four adapters. Spec review found no confirmed correctness regression or agent restriction. It identified two partial verification requirements: the Electron performance fixture uses a legacy provider rather than one combined native multi-provider route through every layer, and automation interruptions prevented five complete Electron sample pairs. Native adapter and routing seams are covered separately. Neither gap is treated as evidence of a whole-app CPU reduction.
