# Merge Claude steering and profile cleanup into voice removal

October 9, 2026. Integrate main `04702eebb34651f02a058ca14a635d8145a1de39`: #892 uses the system temporary folder in the E2E cleanup test; #894 adds Claude steering, iPhone queue/steer/compact and question links. Incoming production and Swift files are preserved. Quiet setup/Settings connections and protocol-v1 suppression are unchanged. No baselines or manifest entries were refreshed.

## Conflict and clean changes

- `tests/unit/renderer/requests/agentRequestCard.test.tsx`: Keep incoming question-link cases and the removal's manual composer cases; the obsolete voice-readout case stays deleted.
- `tests/integration/claudeSteering.test.ts`: Keep the shared control fixture and all new steering cases; omit unused reasoning-account setup.
- `tests/integration/nativeFollowupOutcomes.test.ts`: Keep Claude steering and Grok refusal assertions, using the shared fixture without unused reasoning-account setup.

Main claimed ADR-0065 for steering. The numbering rule in `docs/agents/domain.md` requires the branch merging later to renumber itself. The removal decision and 142 existing Markdown reference files were repointed to the next free number, with the steering decision and its incoming citations preserved. Current removal decision: [ADR-0067](../adr/0067-remove-voice-control-and-thread-management.md). This is a citation correction, with no change to the removal decision. Both independent review axes found no issues; the audit checked the distinction and UTF-8 without BOM.

## Fast gates

Memory was checked before every gate; all runs started above 3 GiB.

| Run | Real output | Seconds | Free memory, KiB |
| --- | --- | ---: | ---: |
| `npm run typecheck` | PASS, exit 0;  | 33.47 | 8446596 |
| `npm run lint` | PASS, exit 0;  | 19.87 | 8436908 |
| `npm run build` | PASS, exit 0;  | 17.23 | 7970380 |
| `npx vitest run tests/integration/claudeSteering.test.ts tests/integration/claudeSteeringLive.test.ts tests/integration/nativeFollowupOutcomes.test.ts tests/unit/release/e2eLaunchCleanup.test.ts tests/unit/renderer/requests/agentRequestCard.test.tsx tests/integration/claudeAdapter.test.ts tests/integration/claudeReopenedSend.test.ts tests/integration/claudeTurnFailure.test.ts tests/unit/main/claudeOriginJournal.test.ts tests/unit/host/remoteCommands.test.ts tests/unit/main/socketHostFeatures.test.ts tests/unit/main/agentProviderConfigurationRecovery.test.ts tests/unit/renderer/onboardingSteps.test.tsx tests/integration/proofCleanup.test.mjs --maxWorkers=2` | PASS, exit 0; Test Files  13 passed / 1 skipped (14); Tests  195 passed / 5 skipped (200) | 28.0 | 6824736 |
| `npx playwright test tests/e2e/app.spec.ts tests/e2e/onboarding-microphone-step.spec.ts tests/e2e/first-run-setup-fit.spec.ts tests/e2e/host-setup.spec.ts tests/e2e/host-agent-setup.spec.ts tests/e2e/agentSetup.spec.ts tests/e2e/agentAnswers.spec.ts tests/e2e/agentControl.spec.ts --reporter=line` | PASS, exit 0; 31 passed (2.2m) | 131.59 | 7969664 |
| `npx playwright test tests/e2e/design-capture-pages.spec.ts --reporter=line` | PASS, exit 0; 1 passed (21.0s) | 21.97 | 9317108 |
| `node scripts/verify-design-captures.mjs` | PASS, exit 0; Verified 144 exact deterministic design-review tuples. | 0.82 | 9524284 |

The first standalone design command skipped without capture mode, and the second failed because its fragment directory was unset. These were invocation mistakes. The passing run uses the runner's capture-mode flag, Los Angeles timezone and a temporary fragment directory, with baseline updating disabled. It compares the unchanged Threads tour as well as onboarding.

## Targeted files

- `tests/integration/claudeSteering.test.ts`
- `tests/integration/claudeSteeringLive.test.ts`
- `tests/integration/nativeFollowupOutcomes.test.ts`
- `tests/unit/release/e2eLaunchCleanup.test.ts`
- `tests/unit/renderer/requests/agentRequestCard.test.tsx`
- `tests/integration/claudeAdapter.test.ts`
- `tests/integration/claudeReopenedSend.test.ts`
- `tests/integration/claudeTurnFailure.test.ts`
- `tests/unit/main/claudeOriginJournal.test.ts`
- `tests/unit/host/remoteCommands.test.ts`
- `tests/unit/main/socketHostFeatures.test.ts`
- `tests/unit/main/agentProviderConfigurationRecovery.test.ts`
- `tests/unit/renderer/onboardingSteps.test.tsx`
- `tests/integration/proofCleanup.test.mjs`

The previous complete local gates passed on `60b388ad5` (8,818 tests, 155 notices, 53 setup/desktop journeys, seven theme tests, nine design tests, 144 tuples and the Windows package). This production increment requires a new full run after the next fast push. Main advanced again to `1312da73d` during these focused gates; its Tiptap composer increment is integrated next to unblock CI. PR #880 remains open.
