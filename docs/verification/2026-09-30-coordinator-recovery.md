# Coordinator recovery

October 9, 2026: Voice control and thread management described below are historical under [ADR-0066](../adr/0066-remove-voice-control-and-thread-management.md); the original plan or evidence is retained.

Verified on Windows, September 30, 2026, with scripted providers. No live provider account was used.

## Behaviour

- Stop is dispatched when saving the follow-up queue pause fails. The assignment stays paused, and the error tells the user to check saved queued messages before sending another message. The Stop turn is recorded as completed; the queue-save failure is surfaced separately. Closed and unsupported threads refuse Stop without changing management, including when the target changes while queue persistence is pending. The restored state is saved. A separate failure to save the Stop intent still prevents dispatch and reports that failure.
- An uncertain Stop can be retried without replaying a prompt. The existing independent interrupt lanes and prompt admission checks stay in place.
- Loading earlier messages preserves management, context age, attention and speech. Coverage includes 2,001 earlier messages, two unchanged refreshes, and actual manual input both during and after paging. Saved identities stay within 2,000, use Set membership, and compare the previous visible window separately. Starting management and restoring an oversized saved record are also covered.
- Shutdown cancellation preserves the managed assignment without a false blocked item, including a failed final write and restart.
- An uncertain answer records attribution once; a definitive refusal does not.
- Coordinator actions retain their client context and use the existing command admission policy. Socket and unit tests cover composition and submission while preserving ordinary draft ownership and matching the coordinator's request-bearing queue selection.

## Electron journeys

`npm run build` and Playwright over `agentControl.spec.ts`, `agentAnswers.spec.ts`, `command-receipt.spec.ts` and `queued-steering.spec.ts`: 15 passed. The journeys cover saved answers and restart, management and takeover, uncertain delivery, draft saving, reconnect, and keyboard steering without consuming a newer draft.

The queued-message journey captures light and dark appearances at 1600x1000, 1280x800 and 820x560, checks that the queue does not overflow, and exercises reduced motion. The dark minimum-size and light full-size captures were visually inspected. The existing [dark minimum-size capture](../../artifacts/queued-steering/dark-820.png) and [light full-size capture](../../artifacts/queued-steering/light-1600.png) show the retained layout. Incidental screenshot changes were restored; no look changed and no baseline was regenerated.

Queue-pause storage failure, paging and shutdown timing were verified through coordinator and workspace regression tests rather than injected into the Electron renderer. macOS and live-provider behaviour were not tested.

## Review

The follow-up standards and spec reviews found an admission expression that did not preserve an ordinary draft's null binding and a Stop refusal race during queue persistence. Both were corrected and covered by regression tests. Separate standards and spec re-reviews found no remaining actionable findings. Both were read-only source reviews; the test results are recorded separately below.

The earlier Windows host-update readiness failure did not recur in the prior green Windows CI runs, including run 36767962482 on `724652be` and 36777213252 on `7469c3e4`. Run 36780768893 later failed another restart assertion in unchanged `launchScriptUpdate.test.ts` at line 98; the whole file then passed locally (12 passed, 1 platform skip). Its unrelated diagnostic was removed from this PR. The readiness assertion and deadlines are unchanged; the original transient failure's cause remains unverified.

## Follow-up verification

The socket Send admission regression fails when its context gate is removed. The Stop outcome regression fails when a queue-save warning is recorded as a failed Stop. The composition, refused Stop and identity-cap regressions also failed before their corresponding fixes.

The revised queue-save message was previewed in the existing Threads error line in dark and light at 820x560. Both [dark](../../artifacts/queued-steering/stop-message-dark.png) and [light](../../artifacts/queued-steering/stop-message-light.png) captures were visually inspected. This preview injects the same copy through scripted provider effects; the actual storage failure is exercised by the workspace regression. The throwaway preview source is retained locally on `prototype/stop-save-message` at `1d6814cf`; no prototype code is included in this PR.

`origin/main` at `64e6fa65` was merged without conflicts. On the merged revision, `npm run build` and the four Electron specs listed above, plus `app.spec.ts` and `new-thread-settings.spec.ts`, passed all 34 journeys. The added journeys cover app startup, shutdown and project defaults changed upstream. Typecheck, lint and notices passed. The final `npm test -- --maxWorkers=2` run passed 6,430 tests with 153 skipped (482 files passed, 39 skipped). An initial rework run had two status assertions fail in unchanged `codexSessionProcesses.test.ts`; all five cases passed alone, and both passed in the merged full run. No assertion or deadline changed. Latest CI results are recorded on PR #624. No look changed or baseline was regenerated.

Main advanced again to `4af39aa2` with Windows SSH helper changes. That merge had no conflicts. Typecheck, lint and notices passed on the combined revision, as did all 294 affected coordinator and host checks (1 platform skip). `npm run build` and the two host Electron specs (`hosts.spec.ts`, `host-setup.spec.ts`) also passed after this merge. The full CI suite runs again on the final pushed head.

Windows CI run 36783529545 passed all 6,439 tests with 150 skipped on `31bb2bfc`; Linux also passed. This includes the host-update restart case that failed in the prior run. Its original cause remains unverified. Main then advanced to `dee39cf3` with Git actions, widget IPC restrictions and iPhone thread creation. That merge had no conflicts. Both independent integration reviews were clear. Typecheck, lint, notices and build passed; 358 coordinator, socket, workspace, IPC and Git tests passed, and all 16 Electron journeys across the four coordinator specs and `git-actions.spec.ts` passed. Final CI status is recorded on PR #624.

Windows run 36785975707 passed 6,478 tests with 150 skipped on `c959a38a`; Linux passed. Main then advanced to `d343d76a` with wake preparation, Windows terminal quoting, ADR renumbering and CI path filters. The merge had no conflicts; coordinator changes from main are comments only. Typecheck, lint, notices and build passed, along with all 269 affected coordinator, wake, terminal and ADR tests.

Two unchanged terminal Electron specs initially failed before opening a terminal because they matched the bare Workshop ID. Both failures reproduced with a build of the production sources from main at `d343d76a`. Temporarily normalizing that fixture lookup for host-qualified IDs made all three terminal display/loading journeys pass on the PR build. The test files, temporary main-source overlay and incidental captures were restored. Fixture maintenance is outside this PR; the actual terminal journeys were verified with the temporary normalization.
