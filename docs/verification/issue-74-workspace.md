# Issue 74: daily workspace acceptance

Baseline: `2297f648b092ae2d4e04774a436a5dcfff0f64e5`, September 14, 2026. Native foundation `52f1f42` is an ancestor; all #74 dependencies, including native-host retirement #24, are closed.

## Deliverables and current state

- [x] Demonstrate mixed-provider daily work: project/thread creation, activity/diagrams, terminal/browser/files, Git/PR, personal chat, voice, skills and prompt generation, within the explicit native/fixture boundaries below.
- [x] Verify Tools pin/focus, preferences, settle/restore, drafts, queue and reconnect/restart without cross-thread effects or duplicate sends.
- [x] Measure local send feedback, stream painting and pane responsiveness on representative long histories, separately from provider/network latency; fix material regressions.
- [x] Reproduce and resolve the three previously documented layout failures; inspect current Windows desktop and minimum 820x560 layouts against the approved references.
- [x] Run current automated regression, typecheck, lint/build and packaging checks; record exact fresh evidence and limitations.
- [ ] Review integrated changes, push and merge the verified work; update #74 with the actual acceptance state.
- [ ] Repeat important journeys on supported Apple silicon macOS before claiming cross-platform acceptance. Zach explicitly deferred this check: "Leave macOS pending."

Physical microphone testing remains deferred under Zach's instruction and tracked in #81. Automated voice tests must distinguish injected transcripts/audio from physical capture. Existing #18 voice latency budgets retain their scope.

## Ownership and verification boundaries

Root integrates and runs broad regression/native checks. `workspace_layout` owns existing layout failures and rendered verification; `workspace_performance` owns long-history measurements; `workspace_journey` owns the integrated daily workflow. Build output is shared and serialized; each lane uses a separate Playwright output folder. Preserve the two unrelated user PNGs already in `artifacts/`.

Use isolated owned profiles, synthetic projects and native conversations. Git publishing acceptance uses a disposable local remote and faithful GitHub fixtures; publishing this implementation PR is separately authorized by the established delivery workflow. Never operate on unrelated user threads or the normal running profile.

## Interface acceptance

This is the existing Windows desktop workspace; the proving moment is completing work in the selected thread while its tools and drafts keep the correct ownership. Preserve Sotto typography, themes and branding, the header Tools toggle, the removed collapsed Tools rail, and faithful terminal colors/glyphs from the user's supplied comparisons.

For scoped layout repairs, consider retaining the present composition, redistributing space within the affected pane, or stacking controls only when constrained. Prefer the smallest composition change that keeps transcript, input and contextual tools usable at 1280/1600 and 820x560. Existing task controls and state feedback are required; add no decorative copy or unrelated sections. Body/control/secondary type remains at existing readable sizes (16/14/12px targets); reflow before shrinking. Theme contrast, keyboard focus, pointer controls and reduced-motion behavior must remain clear. Inspect the actual render after fixes, including normal/minimum and light/dark affected states, and record the observed result in the lane evidence.

## Fresh native foundation check

The opt-in `tests/e2e/multi-provider-live.spec.ts` completed in 38.5 seconds on Windows. One bounded synthetic no-tools READY prompt was sent to each of Codex (GPT-5.6-Luna), Claude (Haiku) and Grok (Grok 4.6). All three native clients were connected together in one isolated profile. Changing the coordinator and turning off agent control preserved every provider connection and thread binding. Disconnecting Claude left all histories and the other providers usable. Reconnection and a full application restart preserved the same Sotto IDs, native session aliases, models and one authored message per thread; no additional prompts were sent, no assignment was created and the project stayed empty.

This exercises installed providers through the native adapter/controller/IPC/Threads path, with no E2E provider bridge. The launch fixture only owns the profile and folder-picker result. The harness now selects a ready lightweight model and low reasoning when the current catalog offers it. Evidence and the root-inspected restored Threads capture are in [artifacts/issue-74-native](../../artifacts/issue-74-native/). This native check establishes provider identity and recovery; tool and Git workflows are verified separately against owned projects.

## Integration findings

The first full Vitest run reported 3,360 passed, 1 failed and 22 skipped. Its failure was the release contract: `@xterm/addon-webgl` was incorrectly installed as an external production dependency in the earlier terminal change. It is imported only by the renderer and bundled into its output, like the existing xterm packages. It now belongs in devDependencies; version and license notice remain unchanged. The release contract retains its external dependency restriction and explicitly checks that WebGL is a bundled dependency. The final full run passed: **3,362 tests passed, 22 skipped, zero failures**.

The 79-case Windows workspace regression run completed with 75 passes and four failures in the short composer and file-panel journeys. Its successful cases include personal voice routing with injected transcripts, editable prompt generation, native skill selection, explicit questions/approvals, diagrams and safe rich messages, terminal color/GPU behavior, owned worktrees, uncertain-delivery reconciliation, project settlement, and full-process draft/request recovery. All four original failing scenarios passed their focused rechecks after the [short-workspace corrections](issue-74-short-workspace.md). This is a 75-pass broad run plus four successful focused rechecks, not a second all-green 79-case run.

The coherent [daily workflow](issue-74-daily-workspace.md) passed both new scenarios. Production services create independent working copies, route each pane's messages and Tools correctly, run an actual terminal, browse an isolated page, inspect files/diffs, stage/commit, and push the exact reviewed commit to an owned local bare remote. A clearly labelled GitHub IPC fixture then verifies the edited PR form and returned status. Actual GitHub command selection and reconciliation retain separate service tests. No product UI test publishes this source repository.

Native personal verification passed Claude and Grok skill invocation plus restart and same-session follow-ups. Codex's installed skill catalog was read without starting a turn. A Codex personal test timed out once after its reply had completed and been saved; the same original conversation then recovered twice without sending, and one instrumented fresh create/reply/restart test passed. No production cause was established for that timeout. The [native personal report](issue-74-native-personal.md) retains the initial failure and successful diagnostics; the test now saves bounded step timings before cleanup. Claude/Grok and catalog evidence are copied into [issue-74-native](../../artifacts/issue-74-native/).

Tools pinning and selected surface are retained across focus changes and reconnect within one renderer session, as required by #55. They are not persisted across full app restart; reopening Tools follows the restored focused pane. Thread arrangement, drafts, queues and preferences have their own durable recovery checks. This boundary is explicit in the daily workflow report.

## Final integration run

The concurrent streaming measurement found a main-process backlog: with 2,000 messages in each of four threads, a send made while another pane streamed waited up to 2.3 seconds for acknowledgement. The cause was redundant full-history state copies and publishes. The [performance report](issue-74-performance.md#concurrent-input-and-main-process-backlog) records the diagnosis, the fix in `AgentControl` and its measured effect (p50 1,947 → 789 ms, max 2,290 → 931 ms).

All results are on Windows, from the final working tree:

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run`, with nothing else running: **3,365 passed, 22 skipped, 0 failed**. A first run alongside lint and typecheck had five timeout or Windows file-lock failures in unrelated provider, Files and worktree tests; all five files passed alone (66 tests) and in the quiet full run.
  - Later full runs of the same source, with about 17 other agent sessions running, failed 27, then 22, then 1 (`--maxWorkers=4`). Every failure was a timeout, a missed acknowledgement deadline or a Windows file lock in a provider adapter test. The set changed from run to run, and the failing tests passed alone.
  - Four of the failing files (`adapterContract`, `grokAdapter`, `nativeTargetRefresh`, `codexRollback`) never import `AgentControl`, so the backlog fix cannot affect them. The three that do (`codexHost`, `claudeAdapterSafety`, `nativeThreadDraftDelivery`) were run five times each under the same load, alternating the fixed `AgentControl` with the one on `main`. The fix had 7 failures and 2 clean runs; `main` had 5 failures and 1 clean run. The two were no different in practice: failures appeared in the same files, and 4 of the fix's 7 were in tests that never construct `AgentControl`. These failures come from load, not a regression; the quiet run above is the unit result.
- `tests/e2e/workspace-performance.spec.ts`: passed twice after the fix, both history sizes, with every guard.
- A 91-case Playwright run covered the earlier 79-case set plus the daily workflow, Phase 3 UI, attention, controller, visual-fix and voice recovery specs: **89 passed, 2 failed**.
  - Personal voice dictation failed once in the long run and once in four focused reruns. The fault was in the test, not the app: it typed into the composer right after clicking New chat, before the new chat was selected, so the text sometimes landed in the previous chat's draft and the new chat held only the transcript. The saved drafts from a failing run confirmed it. `phase-five-personal-voice.spec.ts` and `phase-four-personal-providers.spec.ts`, which had the same race, now wait for a newly selected chat and a focused composer. Afterwards the voice spec passed 8 of 8 runs and the providers spec 3 of 3.
  - `phase-three-final-visual-fixes.spec.ts:116` expects theme preview badges that the Settings redesign (6c72d7d, #73) no longer renders. It fails identically without this work, so it is a stale test outside #74, not fixed here.
- `npm run package:dir` passed: packaged resources, provenance, SQLite memory store, packaged terminal (`SOTTO_PTY_PACKAGE_OK`) and the audio smoke check. No installer was built or published.

Still pending: Apple silicon macOS (deferred by Zach), physical microphone (#81), and publishing through review and merge.
