# Archive startup reads

Test citations use the current split files. Recorded counts and outcomes are from the original runs.

Issue #390. Windows, Node 24.14.1. Baseline `d6db0dac`; the candidate changes only how `WorkspaceHost` restores message windows for an event-sourced provider. It reads each thread's summary at startup and uses the existing observation path to load a pane's messages. Pending requests, activity recovery and legacy provider restoration keep their existing paths.

## Controlled workload

Run `node scripts/archive-startup-bench.mjs` from the repository root after `npm ci`. This explicit command bundles `tests/perf/archiveStartup.bench.ts` and launches fresh Node processes with `--expose-gc`. It creates and removes owned temporary SQLite workspaces; it never opens a personal profile, provider, account or network connection.

Each archive contains 1, 50 or 200 saved, settled threads. Each thread has 80 synthetic messages of about 1 KiB and 100 completed command activities of about 1 KiB. Seeding finishes before measurement. Three fresh processes per size measure `WorkspaceHost.initialize()` and retained JavaScript heap after a forced collection. A fourth process separately counts rows and UTF-8 JSON bytes returned by `ThreadStore.readMessages` and `readActivities`; serialization is excluded from the timing samples. These are logical detail reads, not physical disk I/O or every internal SQLite query. Filesystem caches are warm.

Other verification jobs were running on this machine. The elapsed times below are provisional shared-load observations, not a latency improvement claim. This is host initialization, not complete Electron startup or a measurement of a user's archive.

| Saved threads | Startup median, baseline / candidate | Retained heap after initialize, baseline / candidate | Heap after observing no threads, baseline / candidate |
| --- | --- | --- | --- |
| 1 | 71.51 / 57.31 ms | 546,840 / 517,112 bytes | 525,096 / 517,296 bytes |
| 50 | 230.48 / 226.61 ms | 9,786,856 / 8,561,320 bytes | 8,497,720 / 8,440,944 bytes |
| 200 | 556.86 / 689.79 ms | 37,517,328 / 32,641,368 bytes | 32,720,280 / 32,540,224 bytes |

The structural change is stable: startup message-window calls fall from one per thread to zero. At 200 threads, 4,000 returned message rows and 4,417,800 logical message bytes disappear, and retained startup heap falls by 4,875,960 bytes. Opening one thread still reads its newest ten turns; Show earlier messages widens that window normally. The two-workload timing result does not establish a startup speedup.

## Why the change stays narrow

Activities dominate the remaining cost: both versions return 20,000 activity rows, totaling 25,295,200 logical bytes at 200 threads. `ThreadStore.hasActivities()` itself populates the internal activity cache, before `readActivities()` returns a copy. Skipping only that latter call would misrepresent the retained work.

The activity path also validates message-reset generations, recovers subagent classification and supplies historical activity to resumed provider cursors. Deferring it would require a separate summary and recovery design. This patch takes the measured message-window reduction without changing those semantics or adding a speculative cache. Activity loading remains eager and startup still grows with the number of saved threads.

## Verification

The new regression fails on the baseline with eight unexpected message-window reads. With the change, startup reads none; observing one thread reads exactly one ten-turn window. It checks pending permissions, last-user/assistant excerpts, counts, activity epochs and retained activity, earlier-history paging, and closing the observed pane. Eighty focused workspace, event-store, activity-window and subagent tests pass.

Typecheck, lint and notices (174 components) pass. Main `53bb7910` was integrated at `3d188ed8` without changing the measured workspace, unit-test or benchmark files. Runtime preparation and build passed, followed by `native-usage-persistence.spec.ts`: one test passed in 13.4 seconds. This existing journey uses the real Claude adapter over a scripted child, waits for a held archive write during graceful quit, restarts the app, observes the saved thread and verifies visible transcript/replay plus an editable composer. Its [restart capture](../../artifacts/review-390/history-after-restart.png) was visually inspected. Generated runtime assets and previous captures were restored; no design baseline changed.

Independent native GPT-6 Astra/high Standards and Spec reviews of `3d188ed8` reported no findings. The full two-worker suite remains pending. Raw [baseline](../../artifacts/review-390/startup-baseline.json) and [candidate](../../artifacts/review-390/startup-candidate.json) samples are retained with this note; intermediate logs and regenerated runner output remain ignored.

Main `dcd5db86` integrated cleanly at `221e9f36`; the production delta remains the reviewed message-window deferral. Sixty-nine focused checks across five files pass, including current history retry, workspace restoration, activities and subagents. Typecheck, lint, notices and build pass again. The native history/held-write/graceful-restart journey passes again in 8.9 seconds, and the selected restart capture now comes from this integration. Its initial attempt exited before a window opened because restored runtime placeholders failed `runtime:verify` with a size mismatch. Preparing and verifying the runtime assets repaired that local setup; no app or test source changed. Prepared assets and historical captures were restored after verification.

The composed PR #447 Windows suite at `5867ad97` later reported 5,954 passing tests, 140 skipped and one failure in the Codex activity restart contract: the restored workspace returned no messages where the test expected two. That fixture observed the inner adapter directly, bypassing `WorkspaceHost.observeThreads`, which owns loading the deferred message window. The actual pane path observes the workspace and forwards observation to the adapter.

An unchanged targeted run at archive integration `c6dca422` reproduced the exact empty-message failure in 2.55 seconds. The fixture now checks that startup has no message window and observes through the restored workspace before connecting. Every existing activity, subagent, message identity, final-answer and no-replay assertion remains intact; no deadline, polling or production behavior changed. All 55 checks in `codexActivity.test.ts`, `workspaceThreadStore.test.ts` and `tests/unit/main/workspaceOrganization.test.ts`, `tests/unit/main/workspaceThreadCreation.test.ts`, `tests/integration/workspaceBranchNaming.test.ts`, `tests/unit/main/workspaceGitRefresh.test.ts`, `tests/unit/main/workspaceGitActions.test.ts`, `tests/unit/main/workspaceWorktreeRecovery.test.ts` then passed in 17.56 seconds with two workers, an absent benchmark-data path and live-provider flags cleared. The original red full result is retained; a corrected full gate remains required before merge.
