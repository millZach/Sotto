# Failed thread history retries (#378)

Verified on Windows against base `7b5fdb84`. No provider account, paid model turn or personal Sotto data was used. The full suite points `SOTTO_PERF_DATA` at an absent folder under `artifacts/review-378/`, so data-backed benchmarks skip instead of reading the local profile.

## Regression and behavior

`tests/integration/workspaceHistoryRetry.test.ts` drives WorkspaceHost with provider events and a real SQLite store. Only the append failure is injected. Before the fix, four of its first five cases failed: an organization save cleared the warning, shutdown lost the opening message, 600 chunks caused 601 failed appends, and the privacy transition lost the pending message. The normal coalescing case passed.

The eight final cases check ordered retry plus later text and restart, forced shutdown retry, persistent-failure backoff and shutdown rejection, both privacy transitions, normal streaming and another thread committing beside a failed thread followed by a reset. A failed thread stays in memory until its whole transaction commits. A recovered thread reloads its window even with no new provider event. During a persistent failure, repeated reads and 600 additional chunks make no extra attempt before the retry timer; delays start at one second and double up to thirty seconds. A normal 601-event burst takes at most two commits, with all 601 events retained exactly once.

Two additional post-review regressions exposed interrupted privacy changes: subagent redaction could fail before the history connection switched, and re-enabling retention afterward could promote private pending events. Both failed before the guard/provenance fix and now pass; 61 related history, activity, subagent and quit-drain tests pass. A retry refuses a durable connection while retention is off, and pending events remember the privacy transition even when another store interrupted it.

History off moves pending durable events to the ephemeral connection after redaction; enabling history discards remaining ephemeral events before reopening the durable connection. Tests search every profile file for the synthetic private text after the transitions.

Shutdown callers were inspected: runtime.close drains providers before WorkspaceHost.close; desktop registerQuitDrain catches failure, records only the stable host-shutdown-failed event and permits exit; the headless signal handler catches failure and sets exitCode to 1 while its finally blocks clean up. Pending text is memory only. Persistent disk failure at termination still loses unsaved messages; this change does not claim otherwise.

## Checks

- Typecheck, lint and third-party notices passed.
- Runtime preparation and production build passed.
- Focused history, activity and coalescing suites passed (43 tests before the final cross-thread case; the final retry suite passes all eight cases).
- Initial full two-worker gate: 435 files passed, 37 skipped; 5,733 tests passed, 129 skipped (730.55 seconds). After the interrupted-privacy correction, the latest Windows CI run passed 435 files and 5,735 tests, with 37 files and 129 tests skipped (541.40 seconds). Both GitHub checks passed on `5d4bc1f8`. The second local whole-suite run had 5,734 passed, 129 skipped and one failure: personalChatProviders.test.ts:51 compared a restored assistant timestamp ending .200Z with the live timestamp ending .202Z; IDs and text matched. Its unchanged targeted rerun passed all four cases. That personal-chat path does not instantiate WorkspaceHost. The local failed-run log remains in the ignored artifact folder; it is not counted as a green run.
- Existing performance budgets passed with `SOTTO_PERF_ASSERT=1`: codexStreamingResponsiveness, nativeStreamingResponsiveness, workspacePublishCoalescing and workspaceHistoryRetry, `--maxWorkers=2 --disable-console-intercept`: 14 tests passed (5.05 seconds). Claude, Grok and Codex each coalesced 600 events across three threads into one snapshot; longest heartbeat gaps were 35, 18 and 9 ms, below the unchanged 250 ms limit. Normal workspace publish/write bounds and all retry tests passed. The other task lanes held their heavy runs, but external Vitest/build activity had been observed, so these are shared-load budget checks, not an isolated performance comparison.

## Electron and visual inspection

The existing `daily-workspace.spec.ts` and `host-identity.spec.ts` ran against built Electron: two passed, one failed. Passing journeys cover saved drafts, queued work, settlement, disconnect/reconnect, restart, host identity and pane restoration, and the minimum window. The failed broad daily journey reaches the known #391 assertion at daily-workspace.spec.ts:152, which reads a collapsed greeting.txt diff without expanding it; the coordinator reproduced that defect on the unchanged base.

An uncommitted diagnostic copy added the existing Expand greeting.txt press and redirected captures into the ignored artifact folder. That full daily journey passed (one test, 19.1 seconds), exercising independent working copies, transcript/activity rendering, tools, terminal writes, a commit, push to an owned local bare remote and scripted GitHub PR. Its proof records zero real GitHub writes and no renderer errors. The copy was removed and unrelated tracked captures restored. After the interrupted-privacy correction, the final production build and the two relevant reconnect/restart journeys passed again (two tests, 14.0 seconds), and the final minimum-size capture was inspected.

The [dark two-pane transcript](../../artifacts/review-378/threads-dark.png) and [light restart at 820 by 560](../../artifacts/review-378/restart-minimum-light.png) were visually inspected. The transcript, independent composer drafts and minimum-size controls remain readable and usable. The light pinned-tools capture at 1600 by 1000 was also inspected. There is no UI, styling or warning-copy change, and no design baseline was regenerated. macOS and native-provider storage failure remain unverified.

## Review

Final integration at `53bb7910` includes the independent roster-readiness (#402) and fake-Claude timestamp (#403) corrections that blocked earlier CI. Typecheck, lint and notices passed. The eight retry cases plus personal-chat and fixture timestamp cases passed 13 tests; activity persistence, publish coalescing, quit drain and history-off neighbors passed 32 more. No retry production source changed during integration. Final-head CI remains the integrated full gate.

Independent native GPT-6-astra standards and spec review of `d08d6c7f` reported zero verified findings after inspecting the source, tests and shutdown callers. A follow-up independent native review of the interrupted-privacy guard and regressions also reported zero verified Standards or Spec findings. The coordinating agent performs its own review separately.

The four external CLI slots from the code-review skill were attempted. Automatic approval review rejected the Astra spec and both Grok calls because external disclosure of the private source was not authorized. Astra standards started but could not read the checkout because its child sandbox failed to initialize. No external slot produced review evidence. The authorized native review replaces those unavailable calls; this is not a cross-model review.
