# Linux package and split-test merge into voice removal

October 9, final local update: merged `main` at `6db93c4b7` (Omarchy shell/plugin plumbing, shared fixtures and fitted first-run setup), then `558929679` (explicit skip reasons and pure-test Node environments). Every setup connect remains quiet, including several installed agents. Six OpenRouter-copy onboarding captures were refreshed against the fitted layout; the Threads tour and all other baselines remain inherited. Fast typecheck/lint/build/targeted gates passed before each merge push. Full local gates subsequently passed: 8,818 tests (274 skipped), 155 notices, 25 setup journeys plus 28 remaining Electron journeys, seven theme-evidence cases, all nine design cases across five specs, all 144 manifest tuples and the Windows unpacked package. An existing cleanup failure was reproduced on pinned main and fixed in its own follow-up. The CI snapshot has Windows gates, Linux host and package jobs green, with iPhone journeys still running. See [the conflict, capture and gate record](2026-10-09-voice-control-fixtures-setup-merge.md) and [the test-skip increment](2026-10-09-voice-control-skips-merge.md).

October 9, 2026. Merged main at `2342e7d28833fbec03b83b491067c6a757a55f39` into `feat/remove-voice-control` for PR #880, in `9c046ab78` ("Merge Linux packaging and split tests into voice removal"). This includes #875, #878 and their main follow-ups. The result keeps Omarchy packaging, sign-in startup, the five design surface specs, adapter/host-service contract split and test fixtures, while retaining ADR-0065's removal and manual journeys. The follow-up below records Zach's design decision and resolves the remaining strict comparison failures.

## October 9 decision and follow-up

Zach approved refreshing only `scale-125-onboarding.png` and `scale-150-onboarding.png`: removing "and Kokoro voice" was intentional. Both replacements use the previously inspected actual captures, with identical dimensions (1340x828 and 1605x942). The manifest uses the runner's own SHA-256 `digest` function and its two-space JSON serialization. The hashes are `d4db56102802ee855eeb28d086e96a4493271cc339071b52f723f4e7c5d370eb` and `660bd95471be30fd4f580259c7a66329cc231946c053d1b6bff3d62cde251320`. No other baseline or manifest entry changes. In particular, `threads-tour-projects.png` remains byte-identical to the merge commit.

Zach chose to fix the tour's connection notice rather than refresh its image: setup and Settings, Providers already show each provider's status, so their connects leave success feedback unset. Their initial check, retry and per-provider Connect paths send `notice: false`. Main skips only its success-notice assignment when that flag is present. Provider selection, persistence, adapter connect, connection refusal, client checks and errors use the same paths. Threads-room Connect providers and Reconnect omit the flag and still report success. Startup's existing quiet-connect rule stays intact. An existing notice is not cleared by this flag.

The shared command schema accepts only the literal false, not true or text. The closed remote allow-list admits that field only on connect and independently rejects other values. Protocol v1 remains version 1; existing connect packets with or without provider still parse, and the new optional spelling carries no answer policy, permission, prompt or credential. The remote regression checks the legacy and false-only spellings with and without answer authority, rejects true/text/object/null values, and preserves refusal of extra approved fields, the field on interrupt, and retired voice commands.

Both review axes caught an older-host compatibility gap in the first implementation: Settings' flag would reach a strict old host unmodified and be refused. Fixed it before the final ordered gates. `SocketHostService` strips `notice` from every remote connect packet, preserving the exact old v1 wire shape without adding a feature negotiation. For quiet commands it suppresses only Sotto's bounded five-message connection-success vocabulary in the desktop shell, keeping visible prior feedback. The raw host cache, unrelated feedback and errors stay intact; subsequent shell reads cannot resurrect suppressed text. Suppression survives successive and overlapping quiet provider connections. A successful Threads connect makes its feedback visible; a generation guard prevents an earlier quiet reply from hiding it afterward. Main and the remote client share the success-text function, including a host choosing a different installed default provider during the connection. Paired clients that send the optional flag to a current host can only suppress success feedback there, and old phone clients send the same packets as before. The protocol guide records the narrow false-only exception authorized in ADR-0065.

The controller regression sits next to the startup connect-notice test introduced by `6daa2de1c`, now in `tests/unit/main/agentProviderConfigurationRecovery.test.ts`. Before the fix, both setup and Settings cases failed: expected `notice: ''`, received `notice: 'Codex connected'` (2 failed, 18 skipped; 1.40 seconds). After the fix, the four focused controller/remote/setup/Providers suites passed all 76 tests in 5.44 seconds. The new controller cases also reconnect from Threads and require its success notice. Existing renderer assertions now require the suppression flag at both owning surfaces.

The older-host regression uses the pre-change strict connect schema in `tests/unit/main/socketHostFeatures.test.ts`. Both generic and named-provider quiet connects failed red with `Unrecognized key: "notice"` (2 failed, 7 skipped; 811 milliseconds). After stripping the metadata and projecting quiet feedback locally, five focused suites passed all 85 tests in 4.24 seconds. A host changing its installed default provider was then added and passed. The next review found that a second quiet provider could reveal the first one's suppressed notice. Sequential and overlapping push scenarios both reproduced it red (2 failed, 10 skipped; 890 milliseconds), and the bounded suppression map fixed it: five focused suites then passed all 88 tests in 5.71 seconds. Coverage checks exact old wire packets, repeated shell reads, unrelated notices, errors, a different installed default, and a later Threads connection. An additional delayed-reply case checks that an explicit Threads success stays visible. Full-suite attempts were intentionally stopped after 232.89 and 404.07 seconds to fix these review findings, with no assertion failure reported; neither is counted as a passing gate. One intermediate typecheck rejected an optional class property assigned undefined under exactOptionalPropertyTypes; the final map representation avoids that assignment.

The final Spec correction also has a red/green regression: unrelated feedback arriving while a quiet remote connection was pending could be replaced by the older notice when the host pushed success. The new case failed with an empty notice instead of "Draft cleared" (1 failed, 13 skipped; 922 milliseconds). Incoming unrelated snapshots now preserve the latest visible feedback across the bounded connection-success map. All five focused suites then passed 90 tests in 6.12 seconds. The Standards review found no documented violation; its suggested repeated-loop extraction is addressed by `preserveConnectionFeedback`.

The behavior prototype is a throwaway, self-contained local HTML file under ignored `artifacts/e2e-runs/`; it embeds the unchanged tour image as its reference and demonstrates setup, Settings, Threads and failure feedback. It was driven in Chromium and visually inspected: setup and Settings stay quiet, Threads reports success, and a failed connection retains the prior feedback alongside its error. No prototype branch or tag is published, respecting this task's one-branch boundary. The two approved PNGs, notice fix, tests and decision record are intended to be one coherent follow-up commit.

The final Spec review reports no findings against the follow-up diff. Both review axes ran read-only on Sol at max reasoning; their earlier findings were fixed and covered before the final ordered gates.

### Final follow-up gates

All gates passed in the requested order on the follow-up tree. Elapsed times below include command startup. Free memory was checked through `(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory` before the full suite and each Playwright run; every reading exceeded 3 GiB, so no recovery wait was needed.

| Gate | Real result | Elapsed | Free memory before run, KiB |
| --- | --- | --- | --- |
| `npm run typecheck` | exit 0 | 52.96 s | — |
| `npm run lint` | exit 0 | 23.33 s | — |
| `npm test -- --maxWorkers=2` | 705 files passed, 52 skipped; 8,658 tests passed, 231 skipped; exit 0 | 1097.70 s | 8,296,516 |
| `npm run notices:verify` | Verified 155 third-party notice components; exit 0 | 0.46 s | — |
| `npm run build` | main, preload and renderer built; exit 0 | 18.02 s | — |
| Requested Electron specs, below | 31 passed (2.1m); exit 0 | 129.52 s | 9,906,956 |
| `npm run design:verify` | 9 passed across five surface specs; Verified 144 exact deterministic design-review tuples; exit 0 | 133.82 s | 9,881,008 |
| `node scripts/verify-design-captures.mjs` | Verified 144 exact deterministic design-review tuples; exit 0 | 0.92 s | — |
| `npm run package:dir` | Windows unpacked package, reviewed imports/resources and startup checks pass; SQLite 3.53.1, migration 4, FTS5 true, `SOTTO_PTY_PACKAGE_OK`; exit 0 | 31.47 s | — |

The current onboarding/setup names are `app`, `onboarding-microphone-step`, `host-setup` and `host-agent-setup`; the other requested specs keep their names:

```sh
npx playwright test tests/e2e/app.spec.ts tests/e2e/onboarding-microphone-step.spec.ts tests/e2e/host-setup.spec.ts tests/e2e/host-agent-setup.spec.ts tests/e2e/agentSetup.spec.ts tests/e2e/settings-index.spec.ts tests/e2e/thread-creation.spec.ts tests/e2e/agentControl.spec.ts --reporter=line
```

The completed suite's own summary is:

```text
Test Files  705 passed | 52 skipped (757)
     Tests  8658 passed | 231 skipped (8889)
  Duration  1096.56s
```

Strict design verification passes appearance, pages (including the unchanged tour), scaling (including both approved onboarding images), threads in both modes and workspace compositions, and both widget modes. There are no final failures or waivers. The earlier merge's 29 Electron checks and seven theme-evidence checks remain recorded below; the 31-case follow-up run is separate.

A further built-app probe passed in 3.84 seconds and its three screenshots were visually inspected. Setup opened the empty Threads room with no status notice. Settings, Providers disconnected and connected Codex, showed Connected there, and kept the prior "Codex disconnected." feedback instead of adding success text. Threads' own Connect providers then showed "Codex connected". The first two probe attempts failed because their selectors used the button's text rather than its provider-qualified accessible name; correcting them to "Disconnect Codex" and "Connect Codex" fixed the probe without changing product code. Free memory before those three attempts was 8,890,060, 9,292,948 and 9,195,212 KiB. Every temporary profile was closed and removed by the owned-profile helper.

Tracked artifacts after all runs differ only in the two approved onboarding PNGs and their two manifest hashes; no unrelated artifact needed restoring. The tour and lockfile remain unchanged. The follow-up commit includes the baseline refresh with the notice fix, tests and this record.

Test citations use the current split files. Recorded counts and outcomes in the earlier removal notes are from their original runs; historical command transcripts remain verbatim.

The merge also updates PKGBUILD/.SRCINFO and the desktop entry's description to "Dictation and manual coding threads" and replaces the Linux tarball test's retired ONNX fixture with the external native PTY resource. The desktop source hash is refreshed in PKGBUILD and .SRCINFO. The tarball's file-comparison, missing-resource and permission assertions remain intact. Production dependencies remain exactly `node-pty` and `zod`; `package-lock.json` is unchanged from the premerge branch, so no dependency reinstall was needed.

## Conflict resolutions

| File | Resolution |
| --- | --- |
| `.gitattributes` | Keep the removal manifest rule and all Linux launcher/install/PKGBUILD/desktop LF rules. |
| `docs/perf/2026-09-22-easy-wins.md` | Keep the retirement notice and current split citations; the runnable command excludes deleted model/audio tests and the retired benchmark is historical. |
| `docs/release/releasing.md` | Keep all Linux release/install steps alongside assets verification and retired-voice rejection; remove runtime:prepare. |
| `docs/verification/2026-09-14-voice-listening.md` | Keep the removal's historical retirement notice together with #878's current-split citation notice and updated paths. |
| `docs/verification/2026-09-20-forge-client-foundations.md` | Keep the removal's historical retirement notice together with #878's current-split citation notice and updated paths. |
| `docs/verification/2026-09-26-pending-settings.md` | Keep the removal's historical retirement notice together with #878's current-split citation notice and updated paths. |
| `docs/verification/2026-09-26-screenshot-resize.md` | Keep the removal's historical retirement notice together with #878's current-split citation notice and updated paths. |
| `docs/verification/hosts-add-206-2026-09-23.md` | Keep the removal's historical retirement notice together with #878's current-split citation notice and updated paths. |
| `docs/verification/manual-thread-composer.md` | Keep the removal's historical retirement notice together with #878's current-split citation notice and updated paths. |
| `docs/verification/phase-1-appearance.md` | Keep the removal's historical retirement notice together with #878's current-split citation notice and updated paths. |
| `docs/verification/phase-1-workspace-ui.md` | Keep the removal's historical retirement notice together with #878's current-split citation notice and updated paths. |
| `docs/verification/phase-3-requests.md` | Keep the removal's historical retirement notice together with #878's current-split citation notice and updated paths. |
| `docs/verification/phase-3-review-ui-fixes.md` | Keep the removal's historical retirement notice together with #878's current-split citation notice and updated paths. |
| `docs/verification/phase-3-theme-branding.md` | Keep the removal's historical retirement notice together with #878's current-split citation notice and updated paths. |
| `docs/verification/sotto-palettes.md` | Keep the removal's historical retirement notice together with #878's current-split citation notice and updated paths. |
| `eslint.config.mjs` | Combine the removal evidence ignore with Linux package/build ignores and the split-fixture lint rules. |
| `package.json` | Keep Linux packaging and split test runners, use assets:verify on every package target, and retain exactly node-pty/zod runtime dependencies. |
| `tests/e2e/design-capture.spec.ts` | Delete the monolith; transfer the two-room/reduced-Settings captures to pages/appearance, remove the voice journey from voice-widget, and keep five surface specs and removal images. |
| `tests/integration/adapterContract.ts` | Keep the split adapter contract and adapterFixture types; remove managed create-thread setup in hostServiceContract. |
| `tests/integration/answerCheckValidation.test.ts` | Delete the monolith; retain manual delivery, question binding, reservation, recovery and authority coverage in its six split suites. |
| `tests/integration/desktopHosts.test.ts` | Keep main's moved desktop fixture and split suites; remove managed creation flags in the fixture and mixed cases. |
| `tests/integration/ipc.test.ts` | Delete the monolith; carry voice-channel refusal into preloadBridge and retired-setting rejection into settingsHistoryIpc. |
| `tests/integration/socketHost.test.ts` | Keep the moved socket fixture and splits; use native requests/manual drafts, remove management/speech setup, and retain only cancel-draft in the peer cancellation journey. |
| `tests/unit/main/agentControlRecovery.test.ts` | Delete the monolith; preserve manual provider, project/thread creation, question-draft and acknowledgement checks with a reduced recovery harness; delete supervision/gate-only splits. |
| `tests/unit/main/codexSkills.test.ts` | Keep native skill tests in main's split and transfer the empty reasoner/no assignments expectations to codexSkillDelivery. |
| `tests/unit/main/threadWorktrees.test.ts` | Delete the monolith; preserve the six Git integration splits and the removal branch's 60-second submodule/nested-repository fixture allowances. |
| `tests/unit/main/windowManager.test.ts` | Delete the monolith; keep window/widget splits, dictation-only geometry and unfocused presentation checks, and remove retired widget presentations. |
| `tests/unit/renderer/agents/threadsView.test.tsx` | Keep main's renderer splits and moved harness; preserve native/manual row states, draft recovery, connection feedback and Dictate/Threads; remove management cases. |
| `tests/unit/renderer/settingsView.test.tsx` | Delete the monolith; keep settings splits and Linux startup support, reduce Agents controls, drop voice-gate setup, and update project-default state shapes. |
| `tests/unit/renderer/threadOptions.test.tsx` | Delete the monolith; preserve options/effort/permission splits and remove retired state from their shared harness. |
| `tests/unit/renderer/widgetApp.test.tsx` | Delete the monolith; keep five dictation/widget splits, remove the agent-widget journey, and retain stale-agent-bridge refusal. |

## Split cases and fixtures

The final integration preserves every surviving premerge case. The Linux startup test's title and unavailable-state copy follow #875, and agentShellAssembly's surviving host-catalog case now says Threads room. The old composition-navigation suite retains its two manual project/thread creation cases; only its voice cases are removed. The removal's three `agentEffects` design-host fixture checks are retained. Every test file remains under 800 lines.

- `tests/e2e/design-capture-appearance.spec.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/e2e/design-capture-pages.spec.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/e2e/design-capture-voice-widget.spec.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/e2e/support/designCapture.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/fixtures/agentControlRecovery.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/fixtures/designCaptureProfile.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/fixtures/desktopHostFixture.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/fixtures/renderer/settingsViewHarness.tsx` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/fixtures/renderer/threadOptionsHarness.tsx` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/fixtures/renderer/threadsViewHarness.tsx` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/integration/answerCheckReservations.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/integration/answerDraftProof.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/integration/atomicDraftSend.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/integration/codexSkillDelivery.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/integration/desktopHosts.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/integration/draftQuestionBinding.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/integration/draftRecoveryAdmission.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/integration/draftSendAuthority.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/integration/hostServiceContract.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/integration/preloadBridge.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/integration/settingsHistoryIpc.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/integration/socketHost.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/integration/socketHostFeatures.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/integration/stableDraftDelivery.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/integration/threadWorktreeReclaim.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/integration/threadWorktreeSubmodules.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/unit/main/agentClarificationRecovery.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/unit/main/agentCompositionNavigation.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/unit/main/agentCoordinatorGate.test.ts` - deleted: exclusively retired voice/management coverage.
- `tests/unit/main/agentEffects.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/unit/main/agentProviderConfigurationRecovery.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/unit/main/agentQuestionDraftRecovery.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/unit/main/agentSupervisionRecovery.test.ts` - deleted: exclusively retired voice/management coverage.
- `tests/unit/main/widgetMonitorFollowing.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/unit/main/widgetPresentation.test.ts` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/unit/release/linuxTarball.test.mjs` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/unit/release/assets.test.ts` - add the Linux native-build regression for the removal's asset verifier.
- `tests/unit/renderer/agents/threadCreationRecovery.test.tsx` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/unit/renderer/agents/threadFacts.test.tsx` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/unit/renderer/agents/threadsView.test.tsx` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/unit/renderer/features/settings/projectThreadDefaults.test.tsx` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/unit/renderer/features/settings/settingsNavigation.test.tsx` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/unit/renderer/widget/widgetAppearance.test.tsx` - removal edits, deleted cases or retained manual equivalents applied here.
- `tests/unit/renderer/widget/widgetEntry.test.tsx` - removal edits, deleted cases or retained manual equivalents applied here.

The scaling surface remains the fifth design spec. No capture is renamed or moved; the merge kept the removal images and manifest unchanged. Zach's later decision permits only the two onboarding replacements recorded above. `tests/fixtures/adapterFixture.ts` and the provider imports retain #878's split without further removal edits.

## Gates

The ordered run restarted from typecheck after the renderer import corrections below. These are its real results, before any baseline refresh. The full suite and every Playwright invocation started only after a fresh `Get-CimInstance Win32_OperatingSystem` check reported at least 3 GiB free. A page-only retry waited while memory was below that threshold and launched after it recovered to 6,105,948 KiB. No failure is waived.

| Gate | Output and result |
| --- | --- |
| `npm run typecheck` | Exit 0; all three TypeScript projects; 83.74 seconds. |
| `npm run lint` | Exit 0; 37.09 seconds. |
| `npm test -- --maxWorkers=2` | Exit 0; `705 passed | 52 skipped` files (757), `8647 passed | 231 skipped` tests (8878); Vitest 1,446.14 seconds. Started with 6,403,192 KiB free. |
| `npm run notices:verify` | Exit 0; verified 155 components; 0.56 seconds. |
| `npm run build` | Exit 0; main, headless host, preload and renderer built; 28.68 seconds. |
| Requested 16 Electron specs with `--reporter=line` | Exit 0; `29 passed (2.7m)`; 162.72 seconds, one worker. Started with 5,410,976 KiB free. The names requested in the brief remain current. |
| `theme-palettes-evidence.spec.ts` and `theme-branding-evidence.spec.ts` with both evidence flags set to 1 | Exit 0; `7 passed (42.7s)`; 44.63 seconds. Started with 3,911,972 KiB free. |
| `npm run design:verify` | Exit 1; `7 passed, 2 failed (1.5m)` across the five surface specs; 123.10 seconds including build. Started with 3,156,748 KiB free. See the baseline findings below. |
| `node scripts/verify-design-captures.mjs` | Exit 0; `Verified 144 exact deterministic design-review tuples.` Executed separately after the strict comparison failed. This verifies the manifest, not the current pixels. |
| `npm run package:dir` | Exit 0; 52.17 seconds. Windows x64 unpacked resources, exact external-import inventory, SQLite 3.53.1 / migration 4 / FTS5, native PTY (`SOTTO_PTY_PACKAGE_OK`) and startup smoke checks pass. |

The requested Electron specs were widget-dictation, pill-controls, dictation-focus, dictation-retry, settings-index, settings-mode-row, agentSetup, agentControl, agentAnswers, agents, crossing, effort-picker, screenshot-paste, thread-creation, remote-thread-opening and thread-sidebar-question. The screenshot-preview case passed; no known laptop flake was used as an exception.

## Failures and comparisons

The exploratory typechecks found missing moved-fixture references, imports, one retired ThreadsView prop and a helper whose scope changed. Corrected before the final gate sequence. Two preliminary full-suite attempts were intentionally stopped after 103.45 and 30.32 seconds, with no assertion failure: first to finish Linux package metadata and the tarball fixture, then to address the independent review findings. It is not a passing gate or a baseline claim.

- The new Linux asset regression was red at `prebuilds/linux-x64/pty.node`: the removal's `assets:verify` assumed a prebuilt layout and a macOS helper. Node-pty's local loader and binding.gyp confirm Linux uses `build/Release/pty.node`; the verifier now checks that file without spawn-helper. Windows and macOS checks retain their original layouts. The same focused run also reproduced the two corrupted device-name inputs; restored `LPT¹` and `com³.txt` from the removal's test.
- The first focused rerun exposed three Linux tarball cases failing with `tar (child): Cannot connect to C: resolve failed`. A clean detached main checkout at the merged SHA reproduced all three, with seven platform skips, in 8.79 seconds. It used `D:/Talk to Text Application/node_modules/.bin/vitest.cmd run tests/unit/release/linuxTarball.test.mjs --maxWorkers=2`, with clean Git status and no node_modules link. Removed `D:/Talk to Text Application/.worktrees/voice-linux-splits-main-proof` with `git worktree remove` afterward. Git's GNU tar is first on this laptop's PATH and treats an absolute drive-prefixed archive as remote. The fixture and Linux archive extractor now pass the archive basename with its parent as cwd; all three cases pass. This failure is fixed, not waived.
- The focused final regression command covers assets, manual creation, Linux tarball and Omarchy install: `3 passed | 1 skipped` files, `18 passed | 9 skipped` tests, 1.57 seconds. The Omarchy shell-install cases remain Linux-only; no live Omarchy package launch was attempted in this Windows-only merge task.
- The first complete two-worker suite finished with `6 failed | 699 passed | 52 skipped` files and `99 failed | 8,548 passed | 231 skipped` tests in 1,258.58 seconds. Import cleanup had removed five React value imports needed by Vitest's JSX transform and moved three mock-bearing fixture imports below the modules they mock. That caused 98 failures across widgetEntry, widgetAppearance, threadsView, threadCreationRecovery and settingsNavigation. Restored React imports and the fixture-first ordering. The remaining failure was nativeSteering's catalog-invalidated case: `Codex did not acknowledge the operation in time.` Its test, Codex fixture and Codex process source are identical to merged main. The six affected suites then passed all 105 tests in 26.43 seconds. A clean detached main checkout at the merged SHA passed all six nativeSteering cases in 5.10 seconds using the main checkout's Vitest binary, without a node_modules link. The timeout was not reproduced on main and is not declared pre-existing or waived. Removed the proof checkout with `git worktree remove` and restarted the ordered gates from typecheck. The local runner's console encoding also needed UTF-8 to print Vitest's failure glyphs; its saved suite log and exit code were intact.
- Strict design verification first failed at `threads-tour-projects.png` (11,882 changed pixels, allowance 388) and `scale-125-onboarding.png` (14,439 changed pixels, allowance 554). A diagnostic full-matrix run saved actual captures and caught visual-comparison assertions solely to enumerate the mismatches; it is not a passing gate. It identified exactly one more difference: `scale-150-onboarding.png` (66,908 changed pixels, allowance 755). The comparison helper was restored in a finally block and strict assertions remain intact. No baseline was written by that diagnostic.
- The tour baseline omits the "Codex connected" notice now rendered in the manual Threads room after the coding-agent setup step. Seeding an already-connected profile did not remove the mismatch: the synthetic host exposes no per-provider rows, so setup checks the provider again. A strict page-only retry failed the same pixel comparison. Reverted that ineffective fixture option rather than changing the journey or hiding the notice. The two scaled onboarding baselines still say "Kokoro voice"; the actual captures say "Used for transcription and AI cleanup." Dimensions match for all three proposed replacements. No capture was renamed or moved, so the brief's baseline restriction requires an explicit exception before updating those three PNGs and their manifest hashes. The other 141 captures remain unchanged.
- A clean detached checkout of main at the merged SHA built successfully and passed the same strict page and scaling surface specs: `2 passed (1.4m)`, starting with 4,708,048 KiB free. It used `D:/Talk to Text Application/node_modules/.bin/electron-vite.cmd` and `playwright.cmd`, had clean Git status before build, and had no node_modules link. Removed the proof checkout afterward with `git worktree remove` and verified its directory was absent. The design failures did not reproduce on main and are not declared pre-existing.

## Rendered checks

Inspected the built Electron app's fresh Settings captures at 1600x1000 dark, 1280x800 dark and 820x560 light, plus the live Citrine dark Threads capture. Settings, Agents contains only the manual new-thread/project defaults; the sidebar switch is Dictate | Threads. The reduced content fits, forms scroll naturally, and the 820-wide capture has no horizontal overflow. The settings-index evidence contains 60 layout rows with an empty error list and checks dark/light sizing, keyboard navigation, persistence, save refusal and reduced motion. Theme evidence also passed. No voice or management controls appear in these inspected views.

Compared all three proposed design corrections visually against their existing baselines. The tour changes its connection feedback and the scaled onboarding surfaces remove obsolete voice wording. Proposed PNGs are held outside the tracked baseline folder pending the explicit scope decision; the tracked manifest still verifies all 144 tuples.

The Windows unpacked package passed its real Electron startup, audio worklet load, SQLite and PTY child-process probes. It was built in this worktree and was not installed over the owner's copy. `out/main/external-dependencies.json`, the reviewed allow-list and `externalDependencyMetadata.test.ts` agree: `node:module`, `node:stream` and `node:stream/promises` are absent from the reviewed main inventory. The verifier's own use of node:module to read Node's builtins is not a bundled main import.

## Review

Two read-only axes used Sol (`gpt-6.1-sol`), max reasoning. Standards found the Linux asset preflight and obsolete runtime:prepare instructions in the guide/Omarchy README. Spec found those two plus the corrupted superscript device-name inputs. All findings are fixed. The asset/Unicode regressions were shown red before the fix and green afterward. The guide and Omarchy README now use assets:verify; no runtime preparation step remains in the active Linux instructions. Neither reviewer found another actionable split-test or removal integration gap. The lead also reviewed the tar basename/cwd portability correction against the reproduced main failure.
