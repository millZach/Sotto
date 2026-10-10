# Merge the Tiptap composer into voice removal

October 9, 2026. Merge main `1312da73d5aad466c3b140785e06d6adf19d6e1e` (#897) after the Claude steering/profile cleanup merge at `04702eebb`. Keep Tiptap, atomic selected-skill pills, prompt helpers, the placed-draft older-snapshot fix and development dependency/license records. Manual Threads journeys remain; management and voice-only cases stay deleted. Every setup/Settings connect remains quiet, including several installed providers. The phone/host command boundary is unchanged by this increment.

No design baseline or manifest entry is refreshed in this increment. The six approved fitted onboarding copy captures from the earlier merge remain; the Threads tour stays unchanged. Main's new skill-pill evidence images remain inherited.

## Conflicts

- `src/renderer/src/agents/ThreadPane.tsx`: Keep manual pane structure; management handoff callbacks remain removed, and main's only edit inside those removed paths is unnecessary.
- `src/renderer/src/agents/threadDraftStore.ts`: Keep main's placed-draft persistence/older-snapshot rule; a save reply cannot mark a revision observed.
- `src/renderer/src/agents/threads.css`: Keep Tiptap prompt/follow-up editor styling and minimum-window sizing; removed agent-composer/management styling stays removed.
- `tests/unit/renderer/agents/threadsView.test.tsx`: Keep Tiptap helper edits and manual journeys; drop main's management-only late-receipt case and retain removal-specific manual receipt/connect/room tests.
- `tests/unit/renderer/composerFileMentions.test.tsx`: Keep main's PromptEditor helper edits and selected-skill structure, with manual Threads props and removal's retained journeys.
- `tests/unit/renderer/composerReviewComments.test.tsx`: Keep main's PromptEditor helper edits and selected-skill structure, with manual Threads props and removal's retained journeys.
- `tests/unit/renderer/earlyStart.test.tsx`: Keep main's PromptEditor helper edits and selected-skill structure, with manual Threads props and removal's retained journeys.
- `tests/unit/renderer/nativeSkills.test.tsx`: Keep main's PromptEditor helper edits and selected-skill structure, with manual Threads props and removal's retained journeys.
- `tests/unit/renderer/threadHandoffFocus.test.tsx`: Keep deletion of management-only handoff focus cases.
- `tests/unit/renderer/threadQueuePolish.test.tsx`: Keep main's PromptEditor helper edits and selected-skill structure, with manual Threads props and removal's retained journeys.
- `tests/unit/renderer/threadQueueSkills.test.tsx`: Keep main's PromptEditor helper edits and selected-skill structure, with manual Threads props and removal's retained journeys.
- `tests/unit/renderer/threadWorkspace.test.tsx`: Keep main's PromptEditor helper edits and selected-skill structure, with manual Threads props and removal's retained journeys.
- `tests/e2e/agentControl.spec.ts`: Take prompt helpers for the retained deliberate retry; the moved automatic-reply/voice supervision case remains deleted.
- `tests/e2e/composer-short-window.spec.ts`: Take rich prompt fill/font selectors for the one manual attached-image layout journey; Manage/Stop managing/Write here refusal cases remain deleted.
- `tests/e2e/split-workspace.spec.ts`: Use rich prompt text assertions after each explicit send; retain independent pane drafts without assignments assertions.
- `tests/e2e/thread-creation.spec.ts`: Use rich prompt helpers while preserving owned profiles, earlier-thread leftover-draft journey, exact new thread confirmation and absent voice flag/assignments.
- `tests/e2e/thread-workspace.spec.ts`: Use rich prompt helpers and selected-skill atom assertion; retain four manual journeys, omitted management state and no Agents room detour.
- `docs/guide.md`: Keep selected-skill pill guidance, quiet Providers connects and manual-only models; omit retired reasoning defaults.
- `eslint.config.mjs`: Keep both the removal setup-evidence ignore and incoming skill-pill evidence ignore.
- `package-lock.json`: Keep all Tiptap/ProseMirror development packages and remove orphan voice-only protobufjs; production dependencies stay node-pty and zod.

## Cleanly merged files corrected

- `tests/e2e/agentAnswers.spec.ts`, `crossing.spec.ts`, `remote-question-receipt.spec.ts` and `thread-monitoring.spec.ts`: use incoming rich prompt helpers for removal-added manual cases.
- `tests/e2e/support/prompt.ts`, `tests/unit/renderer/helpers/promptEditor.ts` and `src/renderer/src/agents/promptSelection.ts`: retain helper behavior and correct stale removed-surface comments.
- `src/renderer/src/agents/requests/requests.css` and `splitWorkspace.css`: retain PromptEditor sizing, remove dead managed-composer aliases.
- `src/renderer/src/agents/shellCache.ts` and `src/renderer/src/state/memoryFeature.ts`: correct obsolete Agents-room comments.
- `scripts/verify-skill-composer.mjs`: retain incoming selected-skill journey without removed `speak` setup.

Production dependencies remain exactly `node-pty` and `zod`; all eight direct Tiptap development dependencies and all 30 composer lock records match incoming main. The lock conflict retains the 13 ProseMirror records and drops orphan voice-only `protobufjs`. `npm ci` was run afterward and passed (840 packages installed, 56.60 seconds). The notice inventory adds 27 composer licenses, for 182 components; runtime reviewed imports still agree with the bundle.

Main had two ADRs numbered 0065. Following `docs/agents/domain.md`, the earlier Claude steering decision keeps 0065, Tiptap becomes [0066](../adr/0066-the-thread-composer-is-a-tiptap-field.md), and removal becomes [0067](../adr/0067-remove-voice-control-and-thread-management.md). All removal citations and the Tiptap citation move with their decisions. The Tiptap consequence now refers only to the surviving floating-widget textarea. No decision changed.

## Fast gates and delivery

The memory wrapper checks `(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory` before every run and waits below 3 GiB. Fast gate results are recorded below before the merge push; the complete suite, remaining Electron journeys, theme evidence, five design surfaces, package check and current CI follow after that push.

| Run | Actual output | Seconds | Free memory, KiB |
| --- | --- | ---: | ---: |
| `npm run typecheck` | PASS; exit 0 | 33.87 | 9093276 |
| `npm run lint` | PASS; exit 0 | 19.17 | 8670516 |
| `npm run build` | PASS; exit 0 | 16.41 | 8509908 |
| `npx vitest run tests/integration/proofCleanup.test.mjs tests/unit/host/remoteCommands.test.ts tests/unit/main/agentProviderConfigurationRecovery.test.ts tests/unit/main/socketHostFeatures.test.ts tests/unit/release/externalDependencyMetadata.test.ts tests/unit/renderer/agents/threadCreationRecovery.test.tsx tests/unit/renderer/agents/threadsView.test.tsx tests/unit/renderer/composerFileMentions.test.tsx tests/unit/renderer/composerReviewComments.test.tsx tests/unit/renderer/earlyStart.test.tsx tests/unit/renderer/emptyWorkspaceDraft.test.tsx tests/unit/renderer/nativeSkills.test.tsx tests/unit/renderer/onboardingSteps.test.tsx tests/unit/renderer/promptDocument.test.ts tests/unit/renderer/promptEditor.test.tsx tests/unit/renderer/promptEditorFocus.test.tsx tests/unit/renderer/splitWorkspace.test.tsx tests/unit/renderer/themeTokens.test.ts tests/unit/renderer/threadBranchNotice.test.tsx tests/unit/renderer/threadComposerRecovery.test.tsx tests/unit/renderer/threadDraftStore.test.ts tests/unit/renderer/threadLaneBusy.test.tsx tests/unit/renderer/threadNavigationConnection.test.tsx tests/unit/renderer/threadQueuePolish.test.tsx tests/unit/renderer/threadQueueSkills.test.tsx tests/unit/renderer/threadRequestSurroundings.test.tsx tests/unit/renderer/threadTyping.test.tsx tests/unit/renderer/threadWorkspace.test.tsx tests/unit/renderer/tools/browserReview.test.tsx tests/unit/renderer/tools/phonePlayer.test.tsx --maxWorkers=2` | PASS; Test Files  30 passed (30); Tests  510 passed / 3 skipped (513) | 32.83 | 8353272 |
| `npx playwright test tests/e2e/app.spec.ts tests/e2e/onboarding-microphone-step.spec.ts tests/e2e/first-run-setup-fit.spec.ts tests/e2e/host-setup.spec.ts tests/e2e/host-agent-setup.spec.ts tests/e2e/agentSetup.spec.ts tests/e2e/agentAnswers.spec.ts tests/e2e/agentControl.spec.ts --reporter=line tests/e2e/composer-short-window.spec.ts tests/e2e/split-workspace.spec.ts tests/e2e/thread-creation.spec.ts tests/e2e/thread-workspace.spec.ts` | FAIL, repaired below; 3 failed; 36 passed (4.2m) | 253.19 | 8452688 |
| `npx playwright test tests/e2e/thread-workspace.spec.ts --reporter=line --trace=on` | PASS; 4 passed (12.9s) | 13.93 | 8194448 |
| `npm run typecheck` | PASS; exit 0 | 32.5 | 8424012 |
| `npm run lint` | PASS; exit 0 | 17.46 | 8637896 |
| `npx playwright test tests/e2e/design-capture-pages.spec.ts --reporter=line` | PASS; 1 passed (21.6s) | 22.69 | 7820736 |
| `node scripts/verify-design-captures.mjs` | PASS; Verified 144 exact deterministic design-review tuples. | 0.91 | 8982496 |

All 39 distinct Electron cases have passing output after the four-case workspace repair; 36 originally passed and the three original failures are proved on pinned main above. The final tree has additional passing typecheck/lint after that test-only correction. The build and targeted source tests are unchanged by it. Fast gates were green before pushing the merge and its separate test follow-up together. Full results are appended after the push.

## Targeted unit and integration files

- `tests/integration/proofCleanup.test.mjs`
- `tests/unit/host/remoteCommands.test.ts`
- `tests/unit/main/agentProviderConfigurationRecovery.test.ts`
- `tests/unit/main/socketHostFeatures.test.ts`
- `tests/unit/release/externalDependencyMetadata.test.ts`
- `tests/unit/renderer/agents/threadCreationRecovery.test.tsx`
- `tests/unit/renderer/agents/threadsView.test.tsx`
- `tests/unit/renderer/composerFileMentions.test.tsx`
- `tests/unit/renderer/composerReviewComments.test.tsx`
- `tests/unit/renderer/earlyStart.test.tsx`
- `tests/unit/renderer/emptyWorkspaceDraft.test.tsx`
- `tests/unit/renderer/nativeSkills.test.tsx`
- `tests/unit/renderer/onboardingSteps.test.tsx`
- `tests/unit/renderer/promptDocument.test.ts`
- `tests/unit/renderer/promptEditor.test.tsx`
- `tests/unit/renderer/promptEditorFocus.test.tsx`
- `tests/unit/renderer/splitWorkspace.test.tsx`
- `tests/unit/renderer/themeTokens.test.ts`
- `tests/unit/renderer/threadBranchNotice.test.tsx`
- `tests/unit/renderer/threadComposerRecovery.test.tsx`
- `tests/unit/renderer/threadDraftStore.test.ts`
- `tests/unit/renderer/threadLaneBusy.test.tsx`
- `tests/unit/renderer/threadNavigationConnection.test.tsx`
- `tests/unit/renderer/threadQueuePolish.test.tsx`
- `tests/unit/renderer/threadQueueSkills.test.tsx`
- `tests/unit/renderer/threadRequestSurroundings.test.tsx`
- `tests/unit/renderer/threadTyping.test.tsx`
- `tests/unit/renderer/threadWorkspace.test.tsx`
- `tests/unit/renderer/tools/browserReview.test.tsx`
- `tests/unit/renderer/tools/phonePlayer.test.tsx`

## Workspace failure proved on pinned main

The expanded fast Electron run passed 36 cases but timed out in the three ordinary `thread-workspace.spec.ts` journeys (253.19 seconds). A traced first-case rerun failed again (32.09 seconds). Its queue, prompt and saved-draft assertions completed; the next click waited for a `Docs` button after the first send generated the title `A separate manual message.` This is a naming-selector race, not an editor/focus failure.

A clean detached checkout of exact main `1312da73d` under `.worktrees/proof-880-main-1312da73d` installed its own dependencies without links (`npm ci`, 14.95 seconds) and built main (19.94 seconds). All three corresponding tests timed out there too; the settled-work case passed (97.64 seconds). Main traces wait for `Docs` in the first two cases and `Workshop` in the third. The first attempt to use the root main Playwright binary refused two installed Playwright copies before any tests ran; the proof then used the clean checkout's freshly installed pinned Playwright. Trace evidence was copied to the task's temporary log directory, and the checkout was removed with `git worktree remove --force`; its `node_modules` was verified as a normal directory, never a junction.

The first correction renamed to the existing fixture names, which the coordinator treats as a no-op; it reproduced the same three timeouts (96.60 seconds). The final test-only correction gives both threads distinct explicit user titles and uses those names for navigation. Draft, queue, selected-skill, manual-permission and send-count assertions stay intact; production code and timeouts are unchanged. This correction is committed separately from the merge.

The distinct-title correction passes all four workspace cases (13.93 seconds), including the three cases that failed on pinned main. Both independent review axes reported no findings in the composer integration. The full suite and latest-head CI remain to run after the fast push.

The post-push full suite found two removal-added socket-composer journeys still using textarea APIs. Both are adapted in a separate follow-up with red/green proof; see [the socket composer correction](2026-10-09-socket-composer-prompt-helpers.md). Its file is an additional integration target beyond the 30 fast files listed above. Complete gates are rerun after that push.

## Complete local gates after the socket correction

October 9, 2026, 20:11 Pacific. All complete local gates pass on source/test head `ea4de6447`. The build remained the verified incoming Tiptap/removal tree; both design verification and Windows packaging rebuild it again. The package records source commit `ea4de64479be55c6e79ed6145a318427bdf3e831`, 88 build artifacts, SQLite 3.53.1 with FTS5/migration 4, PTY exit 0 with `SOTTO_PTY_PACKAGE_OK`, the worklet URL and successful packaged startup. Reviewed imports and release metadata agree. Only the six previously approved onboarding copy baselines differ from incoming main; no baseline changed in the composer or test corrections.

| Run | Actual output | Seconds | Free memory, KiB |
| --- | --- | ---: | ---: |
| `npm test -- --maxWorkers=2` | PASS; Test Files  713 passed / 55 skipped (768); Tests  8860 passed / 276 skipped (9136) | 1000.32 | 9659844 |
| `npm run notices:verify` | PASS; Verified 182 third-party notice components. | 0.38 | 7856044 |
| `npx playwright test tests/e2e/widget-dictation.spec.ts tests/e2e/pill-controls.spec.ts tests/e2e/dictation-focus.spec.ts tests/e2e/dictation-retry.spec.ts tests/e2e/settings-index.spec.ts tests/e2e/settings-mode-row.spec.ts tests/e2e/agentControl.spec.ts tests/e2e/agentAnswers.spec.ts tests/e2e/agents.spec.ts tests/e2e/crossing.spec.ts tests/e2e/effort-picker.spec.ts tests/e2e/screenshot-paste.spec.ts tests/e2e/thread-creation.spec.ts tests/e2e/remote-thread-opening.spec.ts tests/e2e/thread-sidebar-question.spec.ts --reporter=line` | PASS; 28 passed (2.1m) | 124.73 | 7804532 |
| `npx playwright test tests/e2e/theme-palettes-evidence.spec.ts tests/e2e/theme-branding-evidence.spec.ts --reporter=line` | PASS; 7 passed (33.9s) | 35.19 | 8659152 |
| `npm run design:verify` | PASS; 9 passed (2.2m); Verified 144 exact deterministic design-review tuples. | 154.68 | 8904080 |
| `node scripts/verify-design-captures.mjs` | PASS; Verified 144 exact deterministic design-review tuples. | 0.94 | 8422896 |
| `npm run package:dir` | PASS; "output": "SOTTO_PTY_PACKAGE_OK" | 32.01 | 8433352 |

The theme run sets both `SOTTO_THEME_EVIDENCE=1` and `SOTTO_THEME_BRANDING_EVIDENCE=1`. All five design specs ran: `design-capture-appearance`, `design-capture-pages`, `design-capture-scaling`, `design-capture-threads` and the surviving widget cases in `design-capture-voice-widget`. All 144 tuples verify; the unchanged Threads tour passes. Each run started above 3 GiB, with the wrapper checking memory before execution; no heavy local gates overlapped.

Delivery: the Claude-steering merge `e1db54a2f`, Tiptap merge `816587553` and workspace-name correction `09efdc7dd` were pushed together at 19:26:18 Pacific. The socket-helper correction `ea4de6447` was pushed at 19:48:06. Both correction diffs and the composer integration received independent standards and spec reviews with no outstanding findings. Historical channel scanning found no live source/shared-fixture use of the eight channels absent from the current shared list. Surviving AgentReasoner uses support provider side calls; babysitting wake-ups and frozen legacy protocol fixtures remain intentionally separate from removed voice listening.

CI snapshot for `ea4de6447`, run [38018293609](https://github.com/millZach/Sotto/actions/runs/38018293609), at 20:11: Changed areas passed (14 seconds), Linux host/archive/socket passed (3m10s), Package (Windows) passed (1m31s) and Package result passed (3 seconds). Windows unit tests and native iOS journeys were still running; the final live result is reported separately. Earlier source `60b388ad5` completed every CI job, including iOS, before these incoming-main increments. The superseded `09efdc7dd` run was cancelled by the socket fix push, with package/Linux jobs passed; no failed current CI job is hidden by that cancellation. PR #880 remains open, with no PR merge performed.
