# Merge explicit test skips into voice removal

October 9, 2026. Main advanced to `558929679e5aff28d70c240c2e667eba2129e2f5` (#893) before the `afd6186d6` fast push. GitHub therefore still reported PR #880 as conflicting and started no checks. Stop the owned local full run and merge the test-only increment to unblock CI. Preserve pure-test Node environments, explicit skip explanations and contract capability decisions before fixture creation; keep retired voice/runtime/management tests deleted.

Production source, E2E source, the design runner/profile and all baselines are unchanged from `afd6186d6`. Its 25 setup journeys and one onboarding design surface, including the unchanged Threads tour, remain applicable. The manifest was verified again. No extra captures were refreshed.

The first merge evidence is in [the shared-fixtures/setup note](2026-10-09-voice-control-fixtures-setup-merge.md). Its clarified capture wording records that the shorter key sentence naturally raises the key row and helper text. All six main-copy control renders have zero differences above the runner channel noise floor of 6; a raw comparison has 25-51 differing pixels per image, with maximum delta 2/255. This is tolerance equality, not byte equality. The only layout change is caused by the shortened copy; no capture-specific production CSS was added.

## Fast gates

| Gate | Real output/result | Seconds | Free memory, KiB |
| --- | --- | ---: | ---: |
| `npm run typecheck` | PASS, exit 0 | 43.56 | 6800984 |
| `npm run lint` | PASS, exit 0 | 20.44 | 6843328 |
| `npm run build` | PASS, exit 0 | 18.42 | 7418872 |
| `npx vitest run tests/integration/headlessHost.test.ts tests/integration/hostProviderLookup.test.ts tests/integration/socketServer.test.ts tests/integration/subscriptionCodexNative.test.ts tests/unit/main/providerClientUpdates.test.ts tests/unit/release/linuxTarball.test.mjs tests/unit/renderer/agentStateCatalogs.test.ts tests/unit/renderer/agents/threadFacts.test.tsx tests/unit/renderer/features/dictation/dictationLifecycle.test.ts tests/unit/renderer/pendingSettings.test.ts tests/unit/renderer/requests/requestDraftStatus.test.ts tests/unit/renderer/themeTokens.test.ts tests/unit/renderer/threadDraftStore.test.ts tests/unit/renderer/threadFactsMetadata.test.ts --maxWorkers=2` | 13 files passed / 1 skipped; 314 tests passed / 9 skipped | 56.36 | 7348376 |
| `node scripts/verify-design-captures.mjs` | Verified 144 exact deterministic design-review tuples. | 1.25 | 7471304 |

## Conflicts

- `tests/integration/subscriptionCodexNative.test.ts`: Preserve main's Node environment and explicit `requires SOTTO_NATIVE_CODEX_CONTRACT=1` suite wrapper; retain the removal's read-only native account-discovery test. Do not restore removed inference/decision calls, native tool-construction mock, response server or completion path.
- `tests/perf/longTranscript.perf.test.tsx`: Keep #893's explicit performance/profile skip reasons and layout, with the removal's manual Threads surface and cleaned shared state.
- `tests/perf/threadsRender.perf.test.tsx`: Keep #893's explicit performance/profile skip reasons and layout, with the removal's manual Threads surface and cleaned shared state.
- `tests/unit/release/linuxTarball.test.mjs`: Keep the Node environment and POSIX/Windows skip explanation; retain the native node-pty resource paths and working-directory-relative Windows tar invocation.
- `tests/unit/renderer/agentVoice.test.ts`: Keep the removal deletion; pure retired voice/speech/runtime tests stay absent.
- `tests/unit/renderer/agents/threadFacts.test.tsx`: Keep removal's manual request/row assertions and #893's Node environment; import common state/time directly so pure tests acquire no renderer/mock/DOM harness.
- `tests/unit/renderer/inferenceEnvironment.test.ts`: Keep the removal deletion; pure retired voice/speech/runtime tests stay absent.
- `tests/unit/renderer/naturalSpeech.test.ts`: Keep the removal deletion; pure retired voice/speech/runtime tests stay absent.

## Targeted test files

- `tests/integration/headlessHost.test.ts`
- `tests/integration/hostProviderLookup.test.ts`
- `tests/integration/socketServer.test.ts`
- `tests/integration/subscriptionCodexNative.test.ts`
- `tests/unit/main/providerClientUpdates.test.ts`
- `tests/unit/release/linuxTarball.test.mjs`
- `tests/unit/renderer/agentStateCatalogs.test.ts`
- `tests/unit/renderer/agents/threadFacts.test.tsx`
- `tests/unit/renderer/features/dictation/dictationLifecycle.test.ts`
- `tests/unit/renderer/pendingSettings.test.ts`
- `tests/unit/renderer/requests/requestDraftStatus.test.ts`
- `tests/unit/renderer/themeTokens.test.ts`
- `tests/unit/renderer/threadDraftStore.test.ts`
- `tests/unit/renderer/threadFactsMetadata.test.ts`

Cleanly merged adapter/host contract skip metadata, registration, teardown and provider lookup/update skip explanations were audited. Pure renderer facts now import common state/time directly, without a DOM/mock harness. No active voice or management setup was restored.

Merge commit `a818678e51e2f9b4cd59f6387ac7134ffc1f021d`, "Merge test skip explanations into voice removal", was pushed at 17:50:18 Pacific after these fast gates. CI started on the mergeable PR. The later `60b388ad5` cleanup follow-up fixed an existing Windows file-ID precision failure reproduced on this exact main checkout; its proof is in [the cleanup note](2026-10-09-proof-cleanup-file-identities.md). All full local gates subsequently passed, including 8,818 tests, 155 notices, 28 remaining Electron journeys, seven theme-evidence cases, nine design cases, 144 manifest tuples and the Windows unpacked package. The earlier 25 setup journeys remain applicable. Full output and CI snapshots are in the shared-fixtures/setup note. PR #880 remains open.
