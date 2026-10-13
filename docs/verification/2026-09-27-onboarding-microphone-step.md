# Resolve the onboarding microphone step (#386)

This implements approved prototype A from `prototype/code-base-review-workflows` (`58917d59`): keep the four-step layout, disable Continue on the microphone step until a successful test or explicit Skip for now, and state that choice in the existing explanation. Back, retry, optional key entry and the final completion guard remain available.

Five desired-behavior regressions failed on the unchanged baseline: idle, requesting, denied, missing and error could all leave the microphone step. With the prerequisite in place, 60 tests passed across onboarding, App and microphone lifecycle suites. Existing navigation cleanup tests now choose Skip explicitly before leaving a pending test; their resource-ownership assertions remain intact. Existing macOS recovery guidance tests also make that explicit choice.

Typecheck, full lint, notices verification and production build passed. The real Electron `onboarding-microphone-step.spec.ts` passed both journeys (16.5 seconds, one worker and exclusive desktop access): successful test and blocked permission followed by explicit Skip. Both cover 1600 by 1000, 1280 by 800 and 820 by 560, light/dark appearance, reduced motion, keyboard activation, heading focus, Back navigation, completion settings and reload. Audio/permission responses use the existing synthetic first-run fixture; no microphone hardware, provider account or paid request was used.

The [untested minimum light view](../../artifacts/review-386/untested-820-light.png) and [denied dark view](../../artifacts/review-386/denied-1280-dark.png) were visually inspected. Copy and actions remain readable, Continue is visibly unavailable, and recovery guidance remains visible. The narrow window retains the existing vertical scroll. No design baseline changed; generated runtime files were restored.

Independent native Astra Standards and Spec reviews and the coordinating source/visual review reported zero findings. The full two-worker suite remains queued. macOS was covered by renderer copy tests only, not a native app journey.

The branch includes main at `3cb36d8d` (including the phone Settings category and missing-image repair). Integrating the host/history and screenshot fixes changed none of this issue's renderer sources. Final full-suite evidence remains pending.

## Full gate and dependencies

The full two-worker suite at `2265e87d` completed with 5,864 passed, 140 skipped and one failure (446 files passed, 39 skipped and one failed; 964.78 seconds). The concurrent Codex working-copy case expected two accepted sends but received an uncertain first send and an accepted second send. It did not capture the underlying acknowledgement error, so its exact cause remains unproven. The unchanged isolated case passed. This run is not reported as green.

Separate issue #435 established a controlled fixture-budget gap: a valid acknowledgement delayed beyond the functional fixture's two-second budget could return uncertain even though both native proof files matched. That issue uses the normal adapter budget for functional checks and preserves the explicit short deadline and unchanged scripted lost-creation/no-replay coverage. Its controlled evidence does not establish the original full-run failure's cause.

Composition `f9b44df2` includes current main, the reviewed selected-microphone fix #383/PR #434 and the reviewed fixture correction #435. Onboarding's own copy and Continue prerequisite are unchanged. These are explicit dependencies; the composed hosted gate and #435's own full verification remain pending. No new local heavy check was launched during the resource hold.

## Current-main integration

Hosted verification on `f196163c4c15c9abbdda2eaa16821c8a6ded7c95` passed all three checks, including 5,888 tests with 140 skipped in the Windows gate (835.67 seconds). Both prerequisites are now merged: #383/PR #434 and #435/PR #442. The historical failed local run above remains a separate result.

Integration `c7116c5f` includes main at `22c8e90b`, including the independently merged new-thread defaults in PR #433 and Grok idle handling in PR #444. The merge was automatic and changed none of this issue's onboarding source. Exact-head hosted verification of this final integration is pending; combined desktop acceptance is tracked separately in #393.
