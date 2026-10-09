# Linux package and split-test merge into voice removal

October 9, 2026. Merged main at `2342e7d28833fbec03b83b491067c6a757a55f39` into `feat/remove-voice-control` for PR #880. This includes #875, #878 and their main follow-ups. The result keeps Omarchy packaging, sign-in startup, the five design surface specs, adapter/host-service contract split and test fixtures, while retaining ADR-0065's removal and manual journeys. The merge is local and is not pushed while strict design verification remains red.

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

The unchanged scaling surface remains the fifth design spec. No capture is renamed or moved; removal baseline images and manifest stay unchanged. `tests/fixtures/adapterFixture.ts` and the provider imports retain #878's split without further removal edits.

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
