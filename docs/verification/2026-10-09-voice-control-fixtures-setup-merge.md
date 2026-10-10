# Merge shared fixtures and fitted setup into voice removal

October 9, 2026. Merge `main` at `6db93c4b7ff74da3ea706697888ca2d4cdfa0c50` (#877, #889, #886 and #887) into `feat/remove-voice-control`, whose previous head was `54438f767`. Keep the Linux shell/plugin plumbing, shared fixture/helper structure, fitted setup layout, microphone voice test and connect-every-installed-agent flow. Keep ADR-0066’s removal and the already approved quiet setup/Settings connections. Test citations use the current split files.

Every initial, Check again and named setup connect in `src/renderer/src/features/onboarding/AgentsStep.tsx` sends `notice: false`; Settings Connect and Retry retain that field. Threads Connect providers and Reconnect retain their success notices. The shared schema still accepts only the optional literal `false`, and the remote allow-list still rejects other values/commands. The desktop strips this field before the strict protocol-v1 host wire and suppresses only the bounded known success messages in its local projection, preserving other feedback and errors. Phones and hosts gain no new operation or authority.

The new test beside the existing connect-notice regression is `leaves every installed agent setup connection quiet, while each Threads connection still announces itself` in `tests/unit/main/agentProviderConfigurationRecovery.test.ts`: Codex, Claude Code and Grok Build connect concurrently with no notice, then each explicitly connects from Threads with its provider success notice. Renderer coverage in `tests/unit/renderer/onboardingSteps.test.tsx` also checks initial/Check again/named connections and several installed clients beside an existing connection. Removing only the quiet guard made the new test red with `Grok Build connected` instead of an empty notice; restoring the guard made it green. The existing setup and Settings cases remain green.

The first typecheck exposed a lost `TestClock` beside the replaced fixture state builder. Main’s clock and scheduler import were restored. Five conflict-resolution scripts had double-decoded punctuation in renderer tests; the damaged lines were restored against main’s UTF-8 bytes before the passing gates. These were merge-resolution defects, not claims of failures on main. The first targeted batch also found 47 Threads view failures because production imports preceded the shared harness's hook mocks. Loading the harness first fixed all 47; the unchanged 107 suites had passed and two suites were skipped. The repaired suite and three compatibility suites then passed 78 tests. No test deadline was changed. Production dependencies remain exactly `zod` and `node-pty`; the lockfile is unchanged.

## Onboarding baselines

Start from #887’s six affected PNGs and its other incoming onboarding captures. Use the real design runner’s `withSotto`, owned profile and `captureSection` helpers to drive first use through the successful microphone test and take only the OpenRouter key surface in dark/light and at 100/125/150/200 percent. Recompute the six entries with the runner’s SHA-256 `digest` export, retaining the 144-entry removal matrix. Compare each actual capture with the pinned main PNG using the runner's channel noise floor (6). The shorter sentence naturally removes a wrapped line and raises the key row and helper text. Restore main's exact sentence in the merged app's DOM as a causal control: each control render has zero changed pixels above that noise floor against its pinned main image. This supports copy as the only visible cause, with no added production CSS. Every other incoming or previously approved baseline remains unchanged, including `threads-tour-projects.png`.

| Baseline | Geometry | Changed pixels | Main-copy control changed pixels | SHA-256 |
| --- | --- | ---: | ---: | --- |
| `onboarding-step-4-openrouter-light.png` | 1070 × 660 | 26235 | 0 | `c31f18b26335da0edef69c7d201022640c26b46e8230f35a0cbb814524f9875a` |
| `onboarding-step-4-openrouter.png` | 1070 × 660 | 10209 | 0 | `894577eb99841885c152b7593d2db39402dae8386217d79bb91190d8af692365` |
| `scale-100-onboarding.png` | 1070 × 660 | 10209 | 0 | `894577eb99841885c152b7593d2db39402dae8386217d79bb91190d8af692365` |
| `scale-125-onboarding.png` | 1340 × 828 | 14435 | 0 | `5abf9969d94d36589b798aa536be1fa5b349b5e4e9738c7f5847ff0cf5aa2210` |
| `scale-150-onboarding.png` | 1605 × 942 | 18387 | 0 | `54f02b6e6ddbb6eeb2b80dd82bae8872dca6216ebc5bd5f97b7d7a14b5d4067b` |
| `scale-200-onboarding.png` | 2138 × 1320 | 33027 | 0 | `573d78bf021063669ea18d9ab2ab33528fe80d20fcb0a78a1c3e0cfde1d1246b` |

The six side-by-side comparisons were opened and visually inspected against main’s fitted layout. Only the key description loses the Kokoro wording; its shorter wrap naturally raises the key row and helper text. The main-copy control renders match main within the runner noise floor, including the card, controls, spacing and all other text.

The control comparison uses the design runner noise floor, not byte equality. With that floor, all six have zero changed pixels. A raw comparison finds only 25-51 pixels per image with a maximum channel difference of 2/255, below the runner floor of 6. The fitted layout is unchanged apart from the copy-caused reflow.

## Gate output

Memory is checked with `(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory` before every run; a run waits below 3 GiB. The full suite and Playwright runs do not overlap locally. The fast gates permit the first push; the full local gates and GitHub CI continue after it.

| Run | Result/output | Seconds | Free memory, KiB |
| --- | --- | ---: | ---: |
| `typecheck` | PASS; exit 0 | 36.38 | 8599940 |
| `lint` | PASS; exit 0 | 19.26 | 8546436 |
| `build` | PASS; exit 0 | 17.08 | 7784228 |
| `red-multi` | expected red; exit 1; Test Files  1 failed (1); Tests  1 failed / 20 skipped (21) | 2.35 | 7778404 |
| `green-multi` | PASS; exit 0; Test Files  1 passed (1); Tests  1 passed / 20 skipped (21) | 2.24 | 8477084 |
| `targeted` | FAIL; exit 1; Test Files  1 failed / 107 passed / 2 skipped (110); Tests  47 failed / 1919 passed / 42 skipped (2008) | 217.43 | 8381040 |
| `typecheck-final` | PASS; exit 0 | 38.14 | 8760540 |
| `lint-final` | PASS; exit 0 | 20.78 | 8120900 |
| `build-final` | PASS; exit 0 | 17.55 | 8039560 |
| `targeted-repair` | PASS; exit 0; Test Files  4 passed (4); Tests  78 passed (78) | 10.04 | 7605384 |
| `capture` | PASS; exit 0; 5 passed (16.9s) | 18.23 | 6624992 |
| `fast-e2e` | PASS; exit 0; 25 passed (2.1m) | 128.72 | 7278256 |
| `fast-design` | PASS; exit 0; 1 passed (25.1s) | 26.09 | 7953588 |
| `manifest` | PASS; exit 0; Verified 144 exact deterministic design-review tuples. | 0.93 | 8337548 |
| `second-typecheck` | PASS; exit 0 | 43.56 | 6800984 |
| `second-lint` | PASS; exit 0 | 20.44 | 6843328 |
| `second-build` | PASS; exit 0 | 18.42 | 7418872 |
| `second-targeted` | PASS; exit 0; Test Files  13 passed / 1 skipped (14); Tests  314 passed / 9 skipped (323) | 56.36 | 7348376 |
| `second-manifest` | PASS; exit 0; Verified 144 exact deterministic design-review tuples. | 1.25 | 7471304 |
| `cleanup-typecheck` | PASS; exit 0 | 39.7 | 8114264 |
| `cleanup-lint` | PASS; exit 0 | 20.53 | 6096308 |
| `cleanup-build` | PASS; exit 0 | 16.42 | 7651252 |
| `cleanup-red` | expected red; exit 1; Test Files  1 failed (1); Tests  1 failed / 16 skipped (17) | 1.24 | 8092916 |
| `cleanup-after-build` | PASS; exit 0; Test Files  1 passed (1); Tests  14 passed / 3 skipped (17) | 1.74 | 6978720 |
| `full` | FAIL; exit 1; Test Files  1 failed / 708 passed / 54 skipped (763); Tests  1 failed / 8816 passed / 274 skipped (9091) | 1047.5 | 7666108 |
| `full-fixed` | PASS; exit 0; Test Files  709 passed / 54 skipped (763); Tests  8818 passed / 274 skipped (9092) | 1023.04 | 6560592 |
| `notices` | PASS; exit 0; Verified 155 third-party notice components. | 0.5 | 6871484 |
| `rest-e2e` | PASS; exit 0; 28 passed (1.9m) | 115.03 | 6366252 |
| `themes` | PASS; exit 0; 7 passed (32.1s) | 33.16 | 8744208 |
| `design` | PASS; exit 0; 9 passed (2.1m); Verified 144 exact deterministic design-review tuples. | 145.57 | 6980072 |
| `package` | PASS; exit 0; Verified Claude SDK 0.3.270 history helper assets and 7 terminal assets. | 31.27 | 8274012 |

The first typecheck attempt failed before the restored clock; the table records its subsequent pass. Build output transforms main, host, preload and renderer. The fast design gate uses `tests/e2e/design-capture-pages.spec.ts`, the surface that owns onboarding, and verifies the unchanged Threads tour. Baseline refresh is part of the merge commit.

The typecheck, lint and build labels run their corresponding npm scripts. `full` and `full-fixed` both run `npm test -- --maxWorkers=2`; the latter is the complete passing rerun after the cleanup fix. Targeted Vitest commands also use `--maxWorkers=2`. The first batch plus its repaired Threads suite and three compatibility suites cover 113 distinct files: 111 passing files, two skipped files, 1,997 passing tests and 42 skipped tests. The later main increment's 14-file command is recorded in the test-skip note.

`fast-e2e` runs `app.spec.ts`, `onboarding-microphone-step.spec.ts`, `first-run-setup-fit.spec.ts`, `host-setup.spec.ts`, `host-agent-setup.spec.ts` and `agentSetup.spec.ts` with Playwright's line reporter. `rest-e2e` runs widget-dictation, pill-controls, dictation-focus, dictation-retry, settings-index, settings-mode-row, agentControl, agentAnswers, agents, crossing, effort-picker, screenshot-paste, thread-creation, remote-thread-opening and thread-sidebar-question under `tests/e2e/`, with the same reporter.

`themes` runs `theme-palettes-evidence.spec.ts` and `theme-branding-evidence.spec.ts` with both `SOTTO_THEME_EVIDENCE=1` and `SOTTO_THEME_BRANDING_EVIDENCE=1`. `design` runs `npm run design:verify` across appearance, pages, scaling, threads and voice-widget surface specs; the last retains dictation-widget cases only. `manifest` runs `node scripts/verify-design-captures.mjs` separately, and `package` runs `npm run package:dir`.

## Conflicts

All 128 conflicts, one resolution per file:

- `.gitignore`: Combine the removal evidence ignore with Linux shell/plumbing/plugin evidence exceptions.
- `artifacts/design/app-review/baseline/onboarding-step-4-openrouter-light.png`: Start from main's fitted onboarding baseline and recapture only the OpenRouter key description without Kokoro voice.
- `artifacts/design/app-review/baseline/onboarding-step-4-openrouter.png`: Start from main's fitted onboarding baseline and recapture only the OpenRouter key description without Kokoro voice.
- `artifacts/design/app-review/baseline/scale-100-onboarding.png`: Start from main's fitted onboarding baseline and recapture only the OpenRouter key description without Kokoro voice.
- `artifacts/design/app-review/baseline/scale-125-onboarding.png`: Start from main's fitted onboarding baseline and recapture only the OpenRouter key description without Kokoro voice.
- `artifacts/design/app-review/baseline/scale-150-onboarding.png`: Start from main's fitted onboarding baseline and recapture only the OpenRouter key description without Kokoro voice.
- `artifacts/design/app-review/baseline/scale-200-onboarding.png`: Start from main's fitted onboarding baseline and recapture only the OpenRouter key description without Kokoro voice.
- `artifacts/design/app-review/manifest.json`: Keep the removal matrix and main's incoming layout hashes; recalculate only the six key-copy image hashes with the runner digest.
- `docs/guide.md`: Keep Linux shell verbs/plugin instructions, manual Threads wording and quiet connect guidance; remove the restored hosted-reply voice claim.
- `eslint.config.mjs`: Combine the removal evidence ignore with Linux shell/plumbing/plugin artifact ignores.
- `src/renderer/src/features/onboarding/AgentsStep.tsx`: Keep fitted rows and every-installed-agent discovery; send notice:false from every initial, Check again and named Connect command.
- `tests/e2e/agent-attention.spec.ts`: Retain deletion; the shared-helper rewrite does not restore the removed attention/voice room.
- `tests/e2e/agentAnswers.spec.ts`: Use shared agent access and owned profiles; keep the two explicit/manual answer journeys and deleted spoken-answer cases.
- `tests/e2e/agentControl.spec.ts`: Use shared agent access; retain four manual/project/acknowledgement journeys and delete all moved supervision/utterance cases.
- `tests/e2e/agentSetup.spec.ts`: Use the owned e2e profile helper; keep Threads Connect providers failure/retry feedback without voice setup.
- `tests/e2e/agentVoice.spec.ts`: Retain deletion; no voice-management journeys are restored.
- `tests/e2e/appearance-evidence.spec.ts`: Use shared owned profiles; seed the reduced coordinator state without voice flags or assignment queues.
- `tests/e2e/checkpoint-rewind.spec.ts`: Keep the shared Git/profile wrappers; remove speak and managed fields from manual thread creation.
- `tests/e2e/command-receipt.spec.ts`: Use shared state reads; keep project-directory configuration and remove the reasoning-account journey.
- `tests/e2e/compact-pane-and-request-layout.spec.ts`: Keep shared profile/window wrappers; remove speak, assignments, queue and pending-request seed fields.
- `tests/e2e/composer-short-window.spec.ts`: Keep the shared resize helper; retain manual composer setup and omit the unused moved assignment accessor.
- `tests/e2e/daily-workspace.spec.ts`: Keep shared agent-state reads and assert that removed assignments are absent.
- `tests/e2e/dictation-focus.spec.ts`: Keep shared owned profile cleanup and the removal's reliable widget-page wait; no voice coordinator setup.
- `tests/e2e/frosted-window.spec.ts`: Keep owned profiles and the reduced thread seed; omit the unused assignment fixture import.
- `tests/e2e/native-codex-workspace-live.spec.ts`: Keep owned profile creation and assets verification in place of removed runtime verification.
- `tests/e2e/native-provider-selection.spec.ts`: Retain absent reasoning-account assertions and the visible Thread model control.
- `tests/e2e/provider-native-skills.spec.ts`: Keep owned profile wrappers; retain manual skill selection and assert no assignments.
- `tests/e2e/provider-recovery.spec.ts`: Keep shared agent-state/profile helpers; remove active assignment assertions while preserving historical upgrade-state seed coverage.
- `tests/e2e/remote-question-receipt.spec.ts`: Keep owned profiles, manual draft retention and explicit answer receipts; deleted managed-send cases remain deleted.
- `tests/e2e/remote-thread-opening.spec.ts`: Keep the manual remote-opening journey/name and use owned profile creation rather than disabled-coordinator setup.
- `tests/e2e/request-draft-restart.spec.ts`: Keep all shared profile wrappers and five explicit-answer/restart journeys; remove speak fields and preserve independent manual composer drafts.
- `tests/e2e/split-workspace.spec.ts`: Keep shared helpers and manual pane/send journeys; no assignment assertion returns.
- `tests/e2e/support/sottoLaunch.ts`: Keep owned profile lifecycle and window/capture exports plus the new microphone-success wording; delete voice enable/launch helpers and preserve widget waiting.
- `tests/e2e/theme-editor-and-request-layout.spec.ts`: Keep shared capture/window/profile wrappers; retain manual request UI and reduced agent-state seeds.
- `tests/e2e/theme-palettes-evidence.spec.ts`: Keep shared profiles and reduced thread seeds; no voice setup or assignment fixture import.
- `tests/e2e/thread-creation.spec.ts`: Keep shared agent-state/profile helpers, the earlier-thread leftover draft and exact newly created thread confirmation.
- `tests/e2e/thread-held.spec.ts`: Use the new shared monitored-thread/window geometry helper after removing its retired speak setup.
- `tests/e2e/thread-monitoring.spec.ts`: Use shared monitored-thread/window geometry helpers; keep manual thread monitoring without voice launch or Manage actions.
- `tests/e2e/thread-workspace.spec.ts`: Keep shared agent-state/profile helpers and four manual workspace journeys; remove assignments assertions and preserve settled-work wording.
- `tests/e2e/tools-sidecar.spec.ts`: Keep shared Git/profile/capture/window wrappers; manual thread creation omits speak and managed fields.
- `tests/e2e/tools-workspace.spec.ts`: Keep shared profile wrappers and manual Tools flow; remove the retired speak configuration field.
- `tests/e2e/voice-home-recovery.spec.ts`: Retain deletion; removed voice-home recovery remains absent.
- `tests/e2e/workspace-draft-and-delivery-journeys.spec.ts`: Keep shared agent-state reads and assert removed assignments are absent.
- `tests/fixtures/agentControlRecovery.ts`: Keep shared control/credential constructors and guarded teardown; remove voice intent, automatic decisions and supervision service; retain native-account compatibility helper and installed-provider options.
- `tests/fixtures/commandReceiptWindow.ts`: Keep #886 IPC harness/control/credential helpers; apply reduced IPC registration and broadcaster signature, with no voice/speech/wake services.
- `tests/fixtures/draftHandoffFixture.ts`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/fixtures/manualSendCoordinator.ts`: Keep shared control/credential constructors with unavailable encryption, remove automatic decision callback, and use manual empty reasoner.
- `tests/fixtures/renderer/liveAgentState.tsx`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/fixtures/renderer/settingsViewHarness.tsx`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/fixtures/renderer/threadOptionsHarness.tsx`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/fixtures/renderer/threadsViewHarness.tsx`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/fixtures/threadActivity/main.tsx`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/integration/answerCheckReservations.test.ts`: Keep main deferred gates; retain manual/socket owner reservations and remove voice/managed queue cases.
- `tests/integration/answerDraftProof.test.ts`: Keep shared deferred gates and manual answer proof; omit removed Resume draft management setup.
- `tests/integration/atomicDraftSend.test.ts`: Keep main deferred helpers; retain atomic manual Send cases and omit assignment/queue-progression cases.
- `tests/integration/claudeSettings.test.ts`: Keep main shared testCredentials/createAgentControl structure; reapply inert/manual reasoner and removal cases.
- `tests/integration/codexAdapterBoundary.test.ts`: Keep main shared testCredentials/createAgentControl structure; reapply inert/manual reasoner and removal cases.
- `tests/integration/codexIdentityReview.test.ts`: Keep main shared testCredentials/createAgentControl structure; reapply inert/manual reasoner and removal cases.
- `tests/integration/codexSkillDelivery.test.ts`: Keep main shared testCredentials/createAgentControl structure; reapply inert/manual reasoner and removal cases.
- `tests/integration/confirmedNativeDelivery.test.ts`: Keep main shared testCredentials/createAgentControl structure; reapply inert/manual reasoner and removal cases.
- `tests/integration/draftManagementHandoff.test.ts`: Keep deleted: the file only exercises removed voice or thread-management behavior.
- `tests/integration/draftQuestionBinding.test.ts`: Keep shared deferred gates and explicit manual question binding; omit assignment setup.
- `tests/integration/nativeQueueOwnership.test.ts`: Use main agentControlFixture ownership/disposal with an inert reasoner and manual native follow-ups.
- `tests/integration/nativeThreadDraftDelivery.test.ts`: Keep main shared testCredentials/createAgentControl structure; reapply inert/manual reasoner and removal cases.
- `tests/integration/subscriptionGrok.test.ts`: Keep main provider-record parser and removal native-provider behavior without voice routes.
- `tests/integration/workspacePersistence.test.ts`: Keep main shared testCredentials/createAgentControl structure; reapply inert/manual reasoner and removal cases.
- `tests/perf/commandReply.perf.test.ts`: Keep #886 IPC harness/control/credential helpers; apply reduced IPC registration and broadcaster signature, with no voice/speech/wake services.
- `tests/perf/detailCacheRecency.perf.test.tsx`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/perf/longTranscript.perf.test.tsx`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/perf/shellDetailCommits.perf.test.tsx`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/perf/statePipeline.perf.test.ts`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/perf/threadsRender.perf.test.tsx`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/unit/main/agentAssignmentFacts.test.ts`: Keep deleted: the file only exercises removed voice or thread-management behavior.
- `tests/unit/main/agentAttentionWorkspace.test.ts`: Use shared credentials/control fixture; retain manual authority/durable dispatch; remove spoken mute case.
- `tests/unit/main/agentAuthority.test.ts`: Use shared credentials/control/deferred helpers with the removal refresh-lane admission test, not utterance reasoning.
- `tests/unit/main/agentCommandReply.test.ts`: Use main IPC registry fixture with the reduced registerAgentIpc signature and receipt encoder.
- `tests/unit/main/agentHostService.test.ts`: Use shared credentials/control construction and inert reasoner; preserve manual-client permission attribution.
- `tests/unit/main/agentMemoryIntegration.test.ts`: Use shared credentials/control construction; retain inspector/privacy/manual coordination tests without preference reasoning.
- `tests/unit/main/agentOrbColor.test.ts`: Keep deleted: the file only exercises removed voice or thread-management behavior.
- `tests/unit/main/agentPersistence.test.ts`: Use shared credentials/control/deferred helpers and checkClientUpdates persistence instead of removed speak settings.
- `tests/unit/main/agentProviderConfigurationRecovery.test.ts`: Use shared testCredentials; retain retired-slot/manual recovery and quiet connect regressions; add three installed-agent quiet setup connects.
- `tests/unit/main/agentReasonerShutdown.test.ts`: Keep shared deferred; retain account-discovery cancellation; remove intent/decision/runtime-transform shutdown cases.
- `tests/unit/main/agentSpeechIpc.test.ts`: Keep deleted: the file only exercises removed voice or thread-management behavior.
- `tests/unit/main/agentStateBroadcast.test.ts`: Use main threadsStateFixture with manual state overrides, no assignments/queue/grokSpeech.
- `tests/unit/main/agentStatePublishing.test.ts`: Use main threadsStateFixture and control/credentials helpers with manual-only current state.
- `tests/unit/main/agentSubscriptionReasoning.test.ts`: Use main control/credentials helpers for provider account discovery; retain reduced ConfiguredAgentReasoner API and removed voice/supervision cases.
- `tests/unit/main/agentSupervisionRecovery.test.ts`: Keep deleted: the file only exercises removed voice or thread-management behavior.
- `tests/unit/main/agentTargetRefresh.test.ts`: Use main shared credentials/control helpers with an inert reasoner and native target refresh.
- `tests/unit/main/agentTurns.test.ts`: Use shared XOR credentials/control/gates; retain manual turn recording and legacy-source history, without mocked intent/supervision calls.
- `tests/unit/main/agentWakePreparation.test.ts`: Keep deleted: the file only exercises removed voice or thread-management behavior.
- `tests/unit/main/clientUpdateLine.test.ts`: Use main shared credentials/control/deferred setup; preserve installed-client update behavior with an inert reasoner.
- `tests/unit/main/desktopHostRouter.test.ts`: Keep main shared deferred helpers; omit the removed Next-based navigation case.
- `tests/unit/main/grokSpeech.test.ts`: Keep deleted: the file only exercises removed voice or thread-management behavior.
- `tests/unit/main/kokoroSpeech.test.ts`: Keep deleted: the file only exercises removed voice or thread-management behavior.
- `tests/unit/main/modelDownload.test.ts`: Keep deleted: the file only exercises removed voice or thread-management behavior.
- `tests/unit/main/providerRetirement.test.ts`: Use main shared control constructor with inert reasoner; retain custom credential encryption for retirement migration cases.
- `tests/unit/main/providerSwitch.test.ts`: Keep main shared setup and connect-every-installed-provider cases; remove automatic reasoning case and obsolete decide parameter; assert Threads success notice.
- `tests/unit/main/sottoThreads.test.ts`: Use main credentials/control/deferred helpers with inert reasoner and manual thread journeys.
- `tests/unit/main/speechModels.test.ts`: Keep deleted: the file only exercises removed voice or thread-management behavior.
- `tests/unit/main/threadNavigationDelivery.test.ts`: Use shared credentials/control/deferred setup and inert reasoner; retain manual navigation/delivery cases.
- `tests/unit/preload/agentStateForwarding.test.ts`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/unit/preload/hostClientBridge.test.ts`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/unit/preload/workspace.test.ts`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/unit/renderer/agentCommandLanes.test.tsx`: Keep shared control/credentials/deferred helpers and select Workshop explicitly for manual compose/send journeys.
- `tests/unit/renderer/agentPausedComposer.test.tsx`: Keep the removal's deletion; the refactored main file tests retired voice or management code only.
- `tests/unit/renderer/agentQueue.test.tsx`: Keep the removal's deletion; the refactored main file tests retired voice or management code only.
- `tests/unit/renderer/agentShellAssembly.test.tsx`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/unit/renderer/agentSpeechControl.test.tsx`: Keep the removal's deletion; the refactored main file tests retired voice or management code only.
- `tests/unit/renderer/agentStateCatalogs.test.ts`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/unit/renderer/agentView.test.tsx`: Keep the removal's deletion; the refactored main file tests retired voice or management code only.
- `tests/unit/renderer/agentVoice.test.ts`: Keep the removal's deletion; the refactored main file tests retired voice or management code only.
- `tests/unit/renderer/agentWakeAcknowledgement.test.tsx`: Keep the removal's deletion; the refactored main file tests retired voice or management code only.
- `tests/unit/renderer/agents/threadCreationRecovery.test.tsx`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/unit/renderer/agents/threadsView.test.tsx`: Keep #886 helpers; delete management/Agents-room journeys, retain manual late-receipt behavior, Dictate|Threads-only switch and successful Threads connect notice regressions.
- `tests/unit/renderer/clientUpdateCard.test.tsx`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/unit/renderer/emptyWorkspaceDraft.test.tsx`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/unit/renderer/features/settings/projectThreadDefaults.test.tsx`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/unit/renderer/features/settings/settingsNavigation.test.tsx`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/unit/renderer/interactiveVisual.test.tsx`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/unit/renderer/naturalSpeech.test.ts`: Keep the removal's deletion; the refactored main file tests retired voice or management code only.
- `tests/unit/renderer/newThreadDefaultsSettings.test.tsx`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/unit/renderer/newThreadProjectCreation.test.tsx`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/unit/renderer/onboardingSteps.test.tsx`: Keep #887's connect-every-installed-agent tests and #886 shared fixtures; every initial, Check again, and named connect expects notice:false, and several installed clients beside a connected one reach Ready quietly.
- `tests/unit/renderer/pendingSettings.test.ts`: Keep #886 shared fixture/helper structure and reapply removed voice/management state, controls, or context setup at its new location.
- `tests/unit/renderer/providersSettings.test.tsx`: Keep #886 shared state/deferred fixtures and the removal's reduced agent settings; preserve notice:false on named Connect and Retry.
- `tests/unit/renderer/threadNavigationConnection.test.tsx`: Keep shared helpers; retain manual send/selection/refresh behavior, remove voice dictation provider props and automatic-intent paths.
- `tests/unit/renderer/threadWorkspace.test.tsx`: Keep #886 deferred/live-state helpers, delete the management-stop handoff case, and retain rejected-send feedback/manual retry regressions.
- `tests/unit/renderer/voiceSettings.test.tsx`: Keep the removal's deletion; the refactored main file tests retired voice or management code only.

## Fast unit and integration targets

The 110-file merge batch covers retained conflicted tests and the shared-fixture rewrites overlapping removal edits; three additional suites check the remote allow-list, protocol-v1 quiet projection and reviewed release imports. Deleted pure voice/management tests remain deleted.

- `tests/integration/answerCheckReservations.test.ts`
- `tests/integration/answerDraftProof.test.ts`
- `tests/integration/atomicDraftSend.test.ts`
- `tests/integration/babysitProviders.test.ts`
- `tests/integration/claudeSettings.test.ts`
- `tests/integration/codexAdapterBoundary.test.ts`
- `tests/integration/codexIdentityReview.test.ts`
- `tests/integration/codexSkillDelivery.test.ts`
- `tests/integration/confirmedNativeDelivery.test.ts`
- `tests/integration/desktopHostsTailnet.test.ts`
- `tests/integration/draftQuestionBinding.test.ts`
- `tests/integration/draftRecoveryAdmission.test.ts`
- `tests/integration/draftSendAuthority.test.ts`
- `tests/integration/headlessWorktreeCleanup.test.ts`
- `tests/integration/nativeQueueOwnership.test.ts`
- `tests/integration/nativeThreadDraftDelivery.test.ts`
- `tests/integration/preloadBridge.test.ts`
- `tests/integration/remoteThreadPermissions.test.ts`
- `tests/integration/socketComposer.test.tsx`
- `tests/integration/socketHost.test.ts`
- `tests/integration/stableDraftDelivery.test.ts`
- `tests/integration/subscriptionClaude.test.ts`
- `tests/integration/subscriptionGrok.test.ts`
- `tests/integration/threadRowAttention.test.ts`
- `tests/integration/threadWorktreeReclaim.test.ts`
- `tests/integration/threadWorktreeSubmodules.test.ts`
- `tests/integration/workspaceControl.test.ts`
- `tests/integration/workspaceMutations.test.ts`
- `tests/integration/workspacePersistence.test.ts`
- `tests/unit/host/remoteCommands.test.ts`
- `tests/unit/main/agentAttachmentPreviewIpc.test.ts`
- `tests/unit/main/agentAttentionWorkspace.test.ts`
- `tests/unit/main/agentAuthority.test.ts`
- `tests/unit/main/agentCommandLanes.test.ts`
- `tests/unit/main/agentCommandReply.test.ts`
- `tests/unit/main/agentHostService.test.ts`
- `tests/unit/main/agentMemoryIntegration.test.ts`
- `tests/unit/main/agentPersistence.test.ts`
- `tests/unit/main/agentProjectDirectoryIpc.test.ts`
- `tests/unit/main/agentProviderConfigurationRecovery.test.ts`
- `tests/unit/main/agentReasonerShutdown.test.ts`
- `tests/unit/main/agentRuntimeBabysitting.test.ts`
- `tests/unit/main/agentRuntimeShutdown.test.ts`
- `tests/unit/main/agentShellDetail.test.ts`
- `tests/unit/main/agentStateBroadcast.test.ts`
- `tests/unit/main/agentStatePublishing.test.ts`
- `tests/unit/main/agentSubscriptionReasoning.test.ts`
- `tests/unit/main/agentTargetRefresh.test.ts`
- `tests/unit/main/agentTurns.test.ts`
- `tests/unit/main/clientUpdateLine.test.ts`
- `tests/unit/main/clientUpdatedForwarding.test.ts`
- `tests/unit/main/desktopHostRouter.test.ts`
- `tests/unit/main/dictationClient.test.ts`
- `tests/unit/main/dictationCommand.test.ts`
- `tests/unit/main/dictationStateFile.test.ts`
- `tests/unit/main/followups.test.ts`
- `tests/unit/main/hostUpdate.test.ts`
- `tests/unit/main/linuxDictationShell.test.ts`
- `tests/unit/main/linuxProcessStart.test.ts`
- `tests/unit/main/nativeDictationLifecycle.test.ts`
- `tests/unit/main/newThreadDefaults.test.ts`
- `tests/unit/main/providerClientUpdates.test.ts`
- `tests/unit/main/providerRetirement.test.ts`
- `tests/unit/main/providerSwitch.test.ts`
- `tests/unit/main/shellWidgetMonitor.test.ts`
- `tests/unit/main/socketHostFeatures.test.ts`
- `tests/unit/main/sottoThreads.test.ts`
- `tests/unit/main/threadDrafts.test.ts`
- `tests/unit/main/threadNavigationDelivery.test.ts`
- `tests/unit/main/threadOptionsAttachments.test.ts`
- `tests/unit/main/widgetVisibility.test.ts`
- `tests/unit/omarchy/installShellPlugin.test.ts`
- `tests/unit/omarchy/shellPluginModel.test.ts`
- `tests/unit/preload/agentStateForwarding.test.ts`
- `tests/unit/preload/hostClientBridge.test.ts`
- `tests/unit/preload/projectDirectory.test.ts`
- `tests/unit/preload/workspace.test.ts`
- `tests/unit/release/externalDependencyMetadata.test.ts`
- `tests/unit/renderer/agentCommandLanes.test.tsx`
- `tests/unit/renderer/agentShellAssembly.test.tsx`
- `tests/unit/renderer/agentStateCatalogs.test.ts`
- `tests/unit/renderer/agents/threadCreationRecovery.test.tsx`
- `tests/unit/renderer/agents/threadsView.test.tsx`
- `tests/unit/renderer/appShell.test.tsx`
- `tests/unit/renderer/branchToolbar.test.tsx`
- `tests/unit/renderer/clientUpdateCard.test.tsx`
- `tests/unit/renderer/emptyWorkspaceDraft.test.tsx`
- `tests/unit/renderer/features/dictation/dictationLifecycle.test.ts`
- `tests/unit/renderer/features/settings/projectThreadDefaults.test.tsx`
- `tests/unit/renderer/features/settings/settingsNavigation.test.tsx`
- `tests/unit/renderer/gitActionButton.test.tsx`
- `tests/unit/renderer/interactiveVisual.test.tsx`
- `tests/unit/renderer/localBranchNotice.test.tsx`
- `tests/unit/renderer/memory.test.tsx`
- `tests/unit/renderer/microphoneTest.test.ts`
- `tests/unit/renderer/newThreadDefaultsSettings.test.tsx`
- `tests/unit/renderer/newThreadProjectCreation.test.tsx`
- `tests/unit/renderer/onboardingSteps.test.tsx`
- `tests/unit/renderer/pendingSettings.test.ts`
- `tests/unit/renderer/providersSettings.test.tsx`
- `tests/unit/renderer/requests/agentRequestCard.test.tsx`
- `tests/unit/renderer/splitWorkspace.test.tsx`
- `tests/unit/renderer/terminalWorkspace.test.tsx`
- `tests/unit/renderer/threadBranchNotice.test.tsx`
- `tests/unit/renderer/threadComposerRecovery.test.tsx`
- `tests/unit/renderer/threadDraftReload.test.tsx`
- `tests/unit/renderer/threadDraftStore.test.ts`
- `tests/unit/renderer/threadNavigationConnection.test.tsx`
- `tests/unit/renderer/threadWorkingCopy.test.tsx`
- `tests/unit/renderer/threadWorkspace.test.tsx`
- `tests/unit/renderer/threadWorktreeReclaim.test.tsx`
- `tests/unit/renderer/tools/pullRequestSurface.test.tsx`
- `tests/unit/renderer/unusedNewThread.test.tsx`

## Cleanly merged files corrected

or inspected

- `tests/e2e/support/monitoredThread.ts`: removed the newly moved `speak: false` configuration setup; both consumers keep the shared helper.
- `tests/e2e/design-capture-threads.spec.ts`: corrected obsolete comments that described management as a beta gate; retained assertions that Pause/Resume managing controls are absent.
- `tests/e2e/support/agentAccess.ts`, `e2eProfile.ts`, `sottoWindow.ts`, `sottoCapture.ts`, `hostCapture.ts`, `designCapture.ts` and design-capture pages/appearance/scaling were inspected: no active voice setup or removed room switch. Generic "management scrollport" wording refers to the page layout, not thread management.
- `tests/e2e/first-run-setup-fit.spec.ts` and the #887 microphone assertions in setup/design helpers remain intact.

- `tests/unit/main/threadDrafts.test.ts` - Rename the surviving foreign-draft case to describe saving a draft for another thread, removing stale managed-mode wording.
- `tests/unit/main/followups.test.ts` - Rename the surviving explicit follow-up admission case, removing stale management wording.
- `tests/integration/threadRowAttention.test.ts` - Describe host request publication without a coordinator queue.

Audited 29 clean overlaps between main changes and removal edits. Remaining matches refer to native subagents, pull-request wake-up messages, or explicit legacy upgrade/refusal assertions; no live voice or per-thread management setup was restored.

- `tests/fixtures/agentControlFixture.ts` - Remove relocated retired state defaults or voice hooks; preserve all remaining fixture behavior and shared structure.
- `tests/fixtures/agentState.ts` - Remove relocated retired state defaults or voice hooks; preserve all remaining fixture behavior and shared structure.
- `tests/fixtures/threadActivity/agentContextStub.ts` - Remove relocated retired state defaults or voice hooks; preserve all remaining fixture behavior and shared structure.
- `tests/perf/support/transcriptState.ts` - Remove relocated retired state defaults or voice hooks; preserve all remaining fixture behavior and shared structure.
- `tests/unit/renderer/branchToolbar.test.tsx` - Remove relocated retired state defaults or voice hooks; preserve all remaining fixture behavior and shared structure.
- `tests/unit/renderer/features/dictation/dictationLifecycle.test.ts` - Remove relocated retired state defaults or voice hooks; preserve all remaining fixture behavior and shared structure.
- `tests/unit/renderer/gitActionButton.test.tsx` - Remove relocated retired state defaults or voice hooks; preserve all remaining fixture behavior and shared structure.
- `tests/unit/renderer/localBranchNotice.test.tsx` - Remove relocated retired state defaults or voice hooks; preserve all remaining fixture behavior and shared structure.
- `tests/unit/renderer/threadBranchNotice.test.tsx` - Remove relocated retired state defaults or voice hooks; preserve all remaining fixture behavior and shared structure.
- `tests/unit/renderer/threadDraftStore.test.ts` - Remove relocated retired state defaults or voice hooks; preserve all remaining fixture behavior and shared structure.
- `tests/unit/renderer/threadWorkingCopy.test.tsx` - Remove relocated retired state defaults or voice hooks; preserve all remaining fixture behavior and shared structure.
- `tests/unit/renderer/threadWorktreeReclaim.test.tsx` - Remove relocated retired state defaults or voice hooks; preserve all remaining fixture behavior and shared structure.
- `tests/unit/renderer/tools/pullRequestSurface.test.tsx` - Remove relocated retired state defaults or voice hooks; preserve all remaining fixture behavior and shared structure.
- `tests/unit/renderer/unusedNewThread.test.tsx` - Remove relocated retired state defaults or voice hooks; preserve all remaining fixture behavior and shared structure.

## Delivery and CI

Merge commit `afd6186d62ed4f405a13afe52c21e07c98eeaa64` - **Merge shared fixtures and fitted setup into voice removal** - was pushed to `origin/feat/remove-voice-control`; push completion was observed at 2026-10-09T17:42:25.045393-07:00. The merge has parents `54438f767` and pinned main `6db93c4b7`. Full local gates and CI are running after the fast push. No PR merge.

Main advanced to `558929679` (#893), so the first push remained conflicting and CI did not start. The owned full run was stopped to integrate that increment. Merge commit `a818678e51e2f9b4cd59f6387ac7134ffc1f021d` - **Merge test skip explanations into voice removal** - was pushed at 17:50:18 Pacific after its fast gates passed. It has parents `afd6186d6` and `558929679`. The full local gates and CI now continue on this tree.


Follow-up `60b388ad573a1b245a4764a838f409206409d52c` - **Keep full file identities in proof cleanup** - was pushed at 18:15:11 Pacific. The first complete local suite found one existing cleanup failure (8,816 passed, 274 skipped); the exact assertion failed on clean pinned main. Its own [proof and red/green regression note](2026-10-09-proof-cleanup-file-identities.md) records the fix. Typecheck/lint/build/targeted cleanup/manifest passed before this push; the full suite reruns after it.


Post-push local gates passed on source commit `60b388ad5`: 8,818 tests passed (274 skipped; 709 passing files), 155 notices, 28 remaining Electron journeys, seven theme-evidence cases, all nine design cases across five specs, 144 manifest tuples and the unpacked Windows package. The earlier 25 setup journeys remain valid: no app/E2E/design source changed in the test-skip merge or cleanup follow-up. Production dependencies and the lockfile stayed unchanged. No tracked artifact changes were left by these runs.

The Windows package verified the reviewed imports, native SQLite 3.53.1 with FTS5 and migration 4, a successful terminal process (`SOTTO_PTY_PACKAGE_OK`, exit 0), and the packaged app/worklet startup. Two-axis reviews of both merges and the cleanup fix found no remaining issues; the two initial capture-evidence wording findings are corrected here.

CI snapshot on `60b388ad5` at 18:40 Pacific, before the evidence-only follow-up push:

| CI job | Observed result |
| --- | --- |
| [Changed areas](https://github.com/millZach/Sotto/actions/runs/38012457196/job/114095509808) | success |
| [Gates (Windows)](https://github.com/millZach/Sotto/actions/runs/38012457196/job/114095509976) | success |
| [Native iOS client (macOS)](https://github.com/millZach/Sotto/actions/runs/38012457196/job/114095570302) | in_progress |
| [Package (Windows)](https://github.com/millZach/Sotto/actions/runs/38012457196/job/114095570309) | success |
| [Host archive and socket contract (Linux)](https://github.com/millZach/Sotto/actions/runs/38012457196/job/114095570319) | success |
| [Package result](https://github.com/millZach/Sotto/actions/runs/38012457196/job/114096062814) | success |

The superseded `a818678` run was automatically cancelled by the cleanup push. The evidence-only follow-up will start CI for its final head; final check outcomes are reported after that run completes. Live checks: [PR #880](https://github.com/millZach/Sotto/pull/880/checks). The PR remains open and has no auto-merge request.
