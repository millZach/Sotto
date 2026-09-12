# Native threads and Windows voice measurement

Implementation for issues #24 and #18, built on local commit `6175989`. Both review axes inspected production through `f4ee81c`; a subsequent connection-error presentation fix in `3d2097e` received another Standards review. Work is committed on `work/native-24-18` in `.worktrees/native-24-18`. It has not been pushed, merged into main, packaged or released. The normal application profile and the root checkout are unchanged.

Ten distinct subagents contributed across source research, migration, native delivery, acceptance and independent reviews, with the voice instrumentation agent working in parallel. The parent integrated the changes, resolved review findings and inspected the rendered result.

## Result

Sotto now exposes only native Codex, Claude Code and Grok Build thread providers. The intermediary runtime adapter, endpoint/token controls, probe and protocol-specific tests are removed. Previous-provider state is retired before strict parsing, with policy-redacted local recovery, disabled automatic actions, preserved historical bindings and unbound draft text/images. Recovery requires an explicit choice and protects another prompt already in the composer.

The [pinned T3 source study](../research/2026-09-12-native-thread-source-study.md) informed targeted thread reads and identity-based pending-message reconciliation. The source was inspected, including relevant tests; T3's framework was not imported. Research citations, historical ADRs and the one-time saved-state recognizer remain as provenance and migration support, not a selectable runtime provider.

Manual prompts show pending immediately. Sending and confirmation refresh only the target thread, keeping unrelated history off that path. Exact native receipts remain authoritative during continuous output; unconfirmed actions still require reconciliation without replay. Draft content, images, revisions and receipt handling share the same lifetime across manual/managed navigation. A reproduced Windows atomic-save sharing violation has a bounded retry that preserves atomic replacement and original-file safety.

Issue #18 adds real production voice milestones, a one-command Windows measurement harness (`npm run perf:voice`), raw synthetic evidence, and a [budget report](../perf/2026-09-12-voice-budgets.md). MAI transcription and Grok default/Kokoro economical speech remain unchanged. Warm detector-frame-to-useful-main-state feedback measured 1,014 ms p50 / 2,412 ms p95; the p95 misses the 2,000 ms reference. Retrieval passed at 13.92 ms warm p95. All 24 fresh speech stop trials passed, with a maximum injected-button-input-to-output-silence latency of 73.43 ms. These software/output measurements do not establish physical microphone, switch or speaker latency, shipping-UI acoustic feedback, or loaded-workload performance.

## Verification

- Final full Vitest run: **2,282 passed, 9 skipped**, across **135 passing and 4 skipped files** (`npm test -- --maxWorkers=1 --reporter=dot`, 179.81 seconds). This includes all three native adapters' shared contract suites. The earlier integration run exposed two Node benchmark files being collected by Vitest; their explicit Node runner is now excluded from Vitest. An existing 100 ms Codex fixture timeout passed in isolation and in the final full run.
- Six voice report/scoring tests and two Windows loopback scoring tests passed separately with Node's test runner.
- Both TypeScript projects, whole-repository ESLint, the production build, four runtime asset checks and 45 third-party notice checks passed.
- Final combined Electron run: **33 passed** (1.6 minutes), covering attention, answers, agent control, setup/retry, voice, provider/voice settings, Crossing navigation, migration recovery, native provider selection, thread creation with file/pasted attachments, and the manual thread workspace. Test-only follow-ups are committed through `a086b91`; production remains at `3d2097e`.
- All three actual native Windows Threads journeys passed: create, visible pending prompt, one confirmed message, reply, cleared composer and restart with the same Sotto/native binding. The final integrated build reopened those same synthetic sessions without new turns; Codex, Claude and Grok all passed. [Native acceptance details](issue-24-native-threads-ui.md).
- Three actual Electron recovery journeys plus native provider selection passed. Recovery covers unbound text/images through connection and new-thread creation, explicit binding, a conflicting local text/image draft, clear and restart, and a 760-pixel layout assertion keeping Send above the footer. The production-only missing React import and narrow-window clipping were reproduced and corrected.
- All six design-capture journeys passed after refresh, then passed again against the committed baselines. The manifest verifies **83 exact tuples**. The parent inspected the native reply/restoration screens, recovered-draft conflict screen, native-only Agents room, Threads workspace and Settings contact sheet.

Additional Electron verification exposed older test journeys that predated the working-preferences questionnaire and current session/settings/widget controls. Their assertions are retained while navigation follows the actual current UI. The workspace test also now waits for selection before typing and native confirmation before asserting authored-message counts; visible pending text is deliberately earlier. An actual duplicated connection error was corrected by rendering identical status/error text only once as an alert.

The combined run also reproduced an attachment-test race: synthetic paste bypassed input readiness and landed while Stop was processing. A temporary assertion verified that the textarea was disabled at the failing event. The test now waits for Stop to finish and the prompt to be enabled, and waits for the delivery receipt to clear the pasted attachment before checking native message counts. All three repeated attachment journeys passed after those test-only changes; the probe was removed. No attachment-handling production change was needed.

The native and recovery UI checks use isolated owned profiles and synthetic projects. They do not inspect personal history or issue work to an existing project. Native typed-path acceptance was unpackaged on Windows; packaged/macOS paths and new live permission/tool-execution scenarios are not claimed.

## Standards

Independent review found one actionable draft-ownership concern: hoisted text/images outlived submission revision and receipt refs. The exact manual-send → managed-composer unmount → late receipt → return scenario reproduced the retained already-delivered text. `useManualDrafts` now owns content and receipt reconciliation together, and the regression passes. Final read-only review through `f4ee81c`: **0 remaining findings**.

## Spec

Independent review found three issues: recovery could hide behind local text; failed reasoning received a resolved-intent timestamp; and first-feedback timing could be overwritten by delayed command completion. Each received a failing regression and correction. A further continuous-stream confirmation concern was also reproduced in two native-fixture races and fixed without relaxing pre-dispatch guards. Final read-only review through `f4ee81c`: **0 remaining material findings**.

Review totals: Standards **0 remaining**; Spec **0 remaining**. No worst remaining issue on either axis. Timing failures and explicitly unmeasured physical boundaries remain visible in the measurement report.
