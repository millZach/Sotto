# Reduce CPU use while preserving agent behavior

Status: implementation authorized through Fusion on September 23, 2026 and in progress. Snapshot ownership, native publication, changed-activity persistence and lifecycle guards are implemented locally. Final integrated measurements and gates are in progress.

Baseline: `11e60a67f5529a1eefad5be5bc5990ef069f5205`, also the source revision of the installed Sotto 0.1.15 build. [Investigation and measurements](../perf/2026-09-23-multi-thread-cpu.md).

## Outcome and constraints

Reduce CPU spent copying, merging and saving unchanged thread activity. The first milestone is the backend snapshot pipeline. Profile the renderer separately before making renderer changes.

Planning assumption: preserve the current streaming/display cadence. Background refresh throttling is outside this plan unless Zach later chooses it. No UI change is proposed; if implementation needs one, clarify it and use the prototype workflow before proceeding.

The following are acceptance requirements:

- Preserve simultaneous threads and providers, subagents, tool access, model/effort choices, output limits, history retention, queued prompts, steering, cancellation and supervision behavior. Add no concurrency cap, execution delay, CPU priority change, tool restriction or shorter session lifetime.
- Keep permissions and questions immediate and routed to the same thread and client. Only the user and existing policy records grant authority. Preserve command ordering and targeted refresh; a busy or stalled unrelated thread must not block an action.
- Preserve message events, activity order, anchors, terminal statuses, subagent results, usage and worktree refresh behavior. Retain the existing display coalescing semantics, including immediate lifecycle/permission delivery.
- Preserve privacy, SQLite durability, failed-save retries, restart recovery, history-off redaction and protection against replay restoring erased content. Add no network host, dependency or disk format migration for this optimization.
- Preserve desktop and headless host behavior, host-qualified identities, socket reconnects and per-client observation/detail revisions. Closing/minimizing a window or disconnecting a client must not stop agents or reduce their capabilities.

Existing authority: ADR-0002/0004 for identity and permissions, ADR-0007 for targeted refresh/ordering, ADR-0016 for history and snapshots, ADR-0023 for observed background work, and ADR-0025 for the host/client interface.

## Acceptance measures

The current synthetic benchmark measures one changing thread with 500 retained command activities per thread. Median CPU cost per update is 0.50 ms with one thread, 2.20 ms with four and 5.80 ms with eight. It is a partial pipeline benchmark; it does not establish the fraction of live CPU a fix will save.

| Measure | Required evidence |
| --- | --- |
| Unchanged history work | After warm-up, an update to thread A performs zero activity-record copies, merges, sorts or subagent rehashes for unchanged thread B on the optimized internal path. Small thread-summary iteration can remain. Explicit snapshot requests and full reconciliation are separate cases. |
| Storage work | Unchanged activity revisions perform no activity synchronization scans/writes after successful persistence. Failed saves remain dirty and retry. |
| CPU improvement | Target at least 50% lower median CPU/update in the eight-thread, 500-record case, compared with the baseline on the same machine and harness. This is a target to verify, not a promised result. |
| Neighboring performance | Investigate any repeatable increase above 10% in one-thread CPU, cold startup time, retained heap/RSS or p95 interaction latency. Resolve it before calling the change ready; do not silently relax the threshold. Small values near timer/counter resolution need longer samples. |
| Responsiveness | Preserve existing 100 ms queue/acknowledgement and 250 ms main-heartbeat gates. Compare display latency under load as well as final output. |
| Agent progress | Under identical scripted provider inputs, preserve command dispatch, tool/answer results, event order and final content. All active threads continue progressing; no new head-of-line blocking. |
| Cache lifetime | Repeated open/close, connect/disconnect and thread retirement cycles return cache entry counts to the expected live set. No retained archive or monotonic growth after warm-up. |

Work-count and correctness assertions run in normal CI. Stopwatch assertions remain opt-in through `SOTTO_PERF_ASSERT=1`, following `docs/ci.md`. Timing comparisons use at least five alternating baseline/candidate samples with equal warm-up and workloads. Capture main, renderer and child-process CPU separately; report raw intervals, logical CPU count, median, spread and workload. Do not attribute child build/test CPU to Sotto's bookkeeping.

## Phase 1: establish the regression harness

Deliverable: a behavior and performance baseline before production edits.

Extend `tests/perf/multiThreadCpu-bench.mjs` beyond usage-only updates. Keep that case as the direct comparison; add real message appends, command output growth, activity insertion/completion, nested subagent updates and mixed-provider streams. Include both fixed total update rate and fixed per-thread rate so adding active agents does not silently change the interpretation of results. Retain an unpaced burst case for stress testing.

Cover 1/4/8 active threads, 0/50/500 retained activities, one long-history case at the existing 2,000-record cap, and a large set of idle thread summaries. Use a focused matrix of representative combinations rather than the full Cartesian product. Separate ordinary-command and subagent fixtures. Exercise zero, one and several observed panes, plus background-only activity.

Add an integrated scripted-provider route through the actual adapter, provider switch, workspace, coordinator and desktop transport. Extend the existing Electron workspace-performance scenario for renderer CPU and send/type/focus/stream latency. Capture visible, unfocused and minimized/hidden cases; return to the window and verify fresh content. Use an isolated profile and synthetic data, not the user's active conversations.

Run baseline/candidate against the same deterministic event trace and compare messages, activities, requests, commands and durable records at defined checkpoints. Include checkpoints while requests are pending and while delivery is uncertain, not just at the end. Respect existing coalesced display snapshots; compare every durable message event and immediate control event, rather than requiring extra visual frames the baseline never produced. Keep the baseline implementation as a test reference/revision, not a second production engine.

Exit: reproducible CPU scaling and structural-work assertions that fail on the baseline, with existing behavior checks passing. Capture a live stack profile only if needed for attribution and available without disrupting the user's session; process-counter samples alone are not a stack profile. Profiling artifacts contain function/timing metadata, never protocol bodies, prompts or keys.

## Phase 2: stop reprocessing unchanged activity

Deliverable: a small internal update interface with a verified ownership model, then incremental adoption across the pipeline.

Target modules: `src/main/agents/host.ts`, `providerSnapshotPublisher.ts`, the four native adapters and their activity projectors, `providerSwitch.ts`, `workspace.ts`, and the coordinator's subscription path in `control.ts`. `src/shared/agentActivity.ts` owns the existing merge semantics. Inspect all subscribers before changing ownership.

Use the existing host seam. Preferred design: an optional internal subscription carrying an immutable view plus explicit per-thread change information. Existing writable `snapshot()`/`workspaceSnapshot()` results and legacy subscriptions retain their isolation guarantees. Consumers without the new contract continue through full reconciliation. Migrate the actual hot internal subscribers so a leftover legacy subscription does not quietly restore the expensive full-copy path.

The internal module owns change tracking, publication and invalidation; callers should not each maintain a separate cache with different rules. It must provide these guarantees:

- Copy on change: only modified records and their containing structures are replaced. Previously published internal views never change. Clone untrusted mutable input at ownership transfer; share only data owned by this module. TypeScript `readonly` alone is insufficient.
- Changes are recorded where data changes, including status, requests, usage, activities, subagents, project/model availability and errors. Do not discover changes by hashing or deep-comparing every unchanged history each frame.
- Scope revisions to the owning host/provider connection and Sotto thread. A reconnect, rewind/reset or replacement cannot accidentally reuse a cached revision. Include explicit removal/reset semantics.
- Accumulate all changed thread IDs while a display flush is pending. Requests, command results and lifecycle transitions flush immediately through the existing path. Never replace pending changes from one provider with the latest provider's changes.
- Unknown/missing change information, incompatible revisions or a failed transition use full reconciliation. Fallback preserves behavior and has counters in tests so it cannot silently become the common path.
- Old callbacks after disconnect are rejected by connection generation. Clean up cached records when their owner or subscription ends.

Preserve `mergeAgentActivities` rules for sequence, anchors, timing, terminal state and bounded retention. Reuse unchanged records; skip the whole merge for an unchanged activity revision. Cache branch-movement facts and subagent classifications only against the revisions that actually affect them. Test provider disconnect and time-based background-work expiration independently of activity changes.

ADR-0016 explicitly promises isolated mutable snapshots. Sharing those existing snapshots would contradict it. Preserve that contract and amend ADR-0016 to document the new internal immutable subscription and its ownership rules before landing the change. Keep IPC/socket payloads and client revision behavior unchanged; internal change metadata does not become a new permission or wire protocol.

Exit: replay parity and snapshot isolation tests pass; normal updates perform no history-sized work for unchanged threads. Demonstrate both one changing thread and all threads changing concurrently. Changing source data, a public snapshot or one subscriber's data must not mutate another consumer's prior view.

## Phase 3: skip unchanged persistence safely

Deliverable: activity saves follow changed revisions, with existing durability and recovery.

Target `workspace.ts:saveActivities` and `threadStore.ts:syncActivities`. Keep a last-successfully-persisted revision per thread. A captured save revision is acknowledged only after its transaction succeeds. If another update arrives while the save is pending, it stays dirty. Command-driven flushes still wait for their required durable state.

Invalidate on privacy/retention changes, activity removal, history epoch or message-reset sequence changes, restored/known-empty history, migration, reconnect reconciliation, store recovery and redaction. Record an empty activity set when required; absence of records is not permission to skip persistence. Preserve the existing protection against replay reviving erased output.

Exit: storage fault injection proves retries and overlapping saves work, restart reconstructs identical retained state, history-off leaves no retained text, and unchanged threads incur no repeated synchronization scan. Keep SQLite durability settings and event retention unchanged.

## Phase 4: verify the running experience and decide whether more work is needed

Deliverable: integrated before/after evidence and a release-readiness decision.

Run the same scripted multi-provider workload through built Electron. Inspect streaming, typing, queued sends, steering, pending permissions/questions, interruption, switching panes, Tools/subagents and restoring a hidden window. Include a busy thread alongside an idle thread and one blocked on permission. Check the headless/socket route with multiple clients observing different threads, reconnecting with old detail bases and an uncertain command.

Profile the renderer after the backend improvement. If it remains a material contributor, make a separate measured change to stable selectors, memoization or redundant subscriptions while preserving display cadence and visible output. Re-run renderer memory and latency checks. Do not broaden into restyling, reducing history or slowing agents to meet a CPU target.

Native client smoke checks are separate from fixture evidence and use existing opt-in suites when native access/account usage is authorized. Report exactly which providers and platforms were exercised. Windows Electron verification is required; Apple silicon macOS remains required before claiming the change verified there. A missing platform is an explicit remaining verification item.

## Regression matrix

| Risk | Required case and existing test area |
| --- | --- |
| Shared mutable state | Mutate provider input and public/sibling snapshots, including nested agent/attachment data; hold old internal views through later updates. `cloneHostSnapshot.test.ts`, `providerSwitch.test.ts`, shared adapter contract. |
| Lost updates or starvation | Interleave all providers; streaming, tool output, multiple changes within one coalescing window, late events and a blocked provider. `providerSnapshotPublisher.test.ts`, `workspacePublishCoalescing.test.ts`, Codex/native streaming responsiveness, `agentCommandLanes.test.ts`. |
| Missing permissions or altered authority | Permission/question appears and is answered during heavy streaming; interrupt and deny; manual takeover; coordinator/voice gate off; one provider disconnects. `agentAuthority.test.ts`, adapter contracts, `agentAnswers.spec.ts`, `agentControl.spec.ts`. |
| Broken history or recovery | Reset/replay, duplicate IDs, prune/reorder, empty history, save failure/retry, privacy off/on, crash/restart, uncertain send without automatic resend. `workspaceActivityPersistence.test.ts`, `threadActivityStore.test.ts`, `workspaceThreadStore.test.ts`, `agentControlRecovery.test.ts`, activity-persistence/provider-recovery E2E. |
| Stale derived state | Status/usage-only update, model changes, branch-moving command, subagent completion/reassignment, disconnect/expired background work; none requires new message text. Branch, pane activity, subagent workspace/store/retention and provider tests. |
| Hidden-window or cross-client regression | Hidden shell delivery, restore to current content, pinned Tools after pane closes, client-specific watched sets, reconnect/detail resync and host-qualified IDs. Renderer connection tests, headless/socket contracts and daily-workspace E2E. |
| Memory or startup regression | Repeated cache lifecycle cycles; cold start with large archive; watched-set growth/shrink; unchanged output with large retained strings. Cache counts plus repeated heap/RSS and startup measurements. |

Extend these suites at the real caller seam rather than testing a standalone cache that production callers can bypass. The new work-count tests belong under `tests/`, with no timing-dependent sleeps or shortened deadlines.

## Gates, delivery and rollback

Implement in coherent commits: harness/contract tests, internal update path and consumers, changed-only persistence, then any separately justified renderer change. Each behavior-changing commit includes its tests and is independently reviewable. Preserve a compatible full-reconciliation path throughout; use the same original trace after every stage.

Before PR readiness, run the repository gates exactly:

```powershell
npm run typecheck
npm run lint
npm test -- --maxWorkers=2
npm run notices:verify
```

Run the opt-in performance gate on a controlled machine:

```powershell
$env:SOTTO_PERF_ASSERT = '1'
npx vitest run tests/integration/codexStreamingResponsiveness.test.ts tests/integration/nativeStreamingResponsiveness.test.ts tests/integration/personalChats.test.ts tests/unit/main/threadDrafts.test.ts tests/unit/renderer/threadQueueSkills.test.tsx --maxWorkers=2
node tests/perf/multiThreadCpu-bench.mjs
```

After `npm run build`, run affected Electron specs, starting with `workspace-performance`, `daily-workspace`, `thread-activity`, `activity-persistence`, `agentAnswers`, `agentControl`, `provider-recovery` and `subagents`. Add host-identity/remote-host journeys if the consumer migration reaches those modules. Visually inspect relevant windows at 1600x1000, 1280x800 and 820x560, light/dark and reduced motion. No design-baseline regeneration is expected.

Run the two-axis code review for standards and this plan's spec, resolve findings, and record actual evidence in `docs/verification/` with only the screenshots cited by the note. Update ADR-0016 and relevant contract documentation; update `docs/ci.md` if a gate changes and README only if user-visible behavior changes. Release and installation are outside this change. After implementation, the user separately authorized committing, opening the PR, monitoring CI and review, and merging when green.

Any state mismatch, missing control event, weakened durability/privacy, new agent restriction or unexplained repeatable neighboring regression blocks readiness even if CPU improves. If immutable ownership cannot be established safely, retain snapshot copying and narrow the first implementation to measured merge/save reductions; report the remaining CPU gap rather than claiming the target met. With no persistent format change, rollback is a code revert; verify baseline can reopen candidate-written test data. Do not undo work from other threads or interrupt live agents to roll back.

## Checklist

- [x] Establish measured bottleneck and verify installed/source revision.
- [x] Identify snapshot isolation, recovery, privacy and host/client constraints.
- [x] Define phased work, regression matrix, performance targets and stop conditions.
- [x] Extend and run the baseline harness and behavioral replay.
- [x] Implement the internal update path and verify all four scripted adapters.
- [x] Implement successful-revision-based persistence skipping.
- [x] Measure CPU, memory, startup and interaction latency; keep native-path and legacy Electron scope separate.
- [x] Run repository gates, affected Electron journeys, transport checks, visual inspection and two-axis review; record baseline failures instead of claiming all-green release readiness.
- [x] Record scripted-native/platform coverage and remaining gaps in the verification note.


## Implementation decisions

The implemented revision token is the identity of a recursively owned, frozen activity array. `activitySnapshots.ts` alone certifies ownership with a WeakSet. An optional internal subscription shares those activity trees and copies mutable metadata for each consumer. Native adapters replace changed records and arrays; public snapshots and ordinary subscriptions remain writable copies. A separate per-thread revision number or changed-ID wire payload would duplicate this signal, so this first implementation does not add either. Legacy or untrusted arrays always reconcile fully, including in-place subagent changes.

The workspace compares record identity only within a certified array. It reuses unchanged merged activity and branch facts, while the coordinator and message log reuse activity-derived signatures and summaries. SQLite skips activity-record scans only after a successful save of the same owned array, epoch, message reset sequence and privacy generation. The indexed epoch lookup remains on purpose to detect same-epoch message resets.

Live input caches are evicted on archive, disconnect, provider omission and disposal. The lifecycle test checks cardinality through three archive/reconnect cycles and retains the workspace history. Weak derived-view caches are tied to activity arrays that the application already retains; they do not keep superseded arrays alive. They can hold one derived view beside an intentionally retained archive, so the memory acceptance check concerns bounded ownership and measured retained memory, rather than deleting user history.

Provider callbacks belong to a connection epoch. Disposal detaches subscriptions and rejects already queued callbacks. Graceful close first lets command lanes finish and retain their final events, then detaches and flushes. Review found these lifecycle cases; regression tests cover them.

No provider polling interval, display coalescing window, concurrency, model choice, tools, permissions, limits, priorities or history-retention setting changes.

Legacy providers keep full reconciliation without an extra deep-freeze pass. Their uncertified activities are copied per subscriber and never qualify for revision-based persistence or signature skips. This avoids imposing ownership work on inputs whose identities cannot be reused.

Local delivery evidence: [verification](../verification/2026-09-23-multi-thread-cpu.md) and [measurements](../perf/2026-09-23-multi-thread-cpu.md). Live-account and macOS verification, baseline Electron failures and noisy display timing remain explicit release gaps. The installed app is unchanged.
