# Shared Settings draft acknowledgements (#394)

This change builds on the now-merged #382. Dictionary, global shortcut, paste delay and success message duration now use one revision-aware draft hook. The hook owns draft text, edit revisions, pending submissions and acknowledgement ordering. Parsing, canonical/display formatting, field copy, commit events and save commands stay in Settings. Failed dictionary writes retain text; the numeric and shortcut callers retain their existing restore policy. Newer edits and external settings updates cannot be replaced by an older acknowledgement or failure.

The interface exposes current text, synchronous edit/read/reset operations, submission ownership, and success/failure settlement. It issues no requests. Removing it would return revision counters, receipt queues and stale-result checks to four callers. Ordered pending acknowledgements apply consistently to all four fields. Repeated commits retain the caller policy; unchanged dictionary blur and duplicate pending dictionary saves remain suppressed.

The OpenRouter key field is deliberately unchanged. Its stored-credential placeholder, exact pending-save promise reuse and Verify sequencing form a different protocol; no secret enters the generic acknowledgement matcher. No layout, copy, theme, networking or production dependency changes.

## Verification

- Frozen source `ea8773aa`: 139 focused tests passed across Settings, the hook and appearance/theme neighbors (four files, 32.65 seconds, two workers). Twelve hook tests use the same interface as the callers.
- A real Settings Profiler comparison ran the same two tests against pre-extraction source `9a10b9a5` and the extracted source; both passed. Five dictionary edits cause five commits; blur adds none, successful save feedback adds one, and matching settings publication adds one. Three numeric edits cause three commits; its existing validation reset on blur adds one, save feedback adds one, and settings publication adds one. Each field sends zero requests while typing and exactly one on blur. These are deterministic operation counts, not stopwatch assertions.
- Final typecheck, lint, notices and production build passed.
- Final real Electron `settings-index.spec.ts` passed one test (24.3 seconds) against `ea8773aa`, with exclusive desktop access and one worker: 1600x1000, 1280x800 and 820x560, both themes, reduced motion, keyboard/focus, normal save/reload and failure feedback.
- Independent native Astra Standards and Spec reviews of the final settlement delta both reported zero findings. Root independently reviewed the final source with zero findings.
- The branch's isolated hosted two-worker suite is pending; this branch is not yet ready to merge. No local full-suite pass is claimed.

All tests use synthetic data. `SOTTO_PERF_DATA` pointed to a verified-absent owned path; no paid provider or personal profile was used.

The final [Cleanup dark view](../../artifacts/review-394/cleanup-dark.png) and [minimum light Output view](../../artifacts/review-394/output-minimum-light.png) were visually inspected. Dictionary and numeric controls remain readable and fit the existing layout. The sidebar mode-row overflow seen at that earlier capture belongs to #388, now merged and included in this branch. Generated runtime and unrelated Settings captures were restored; no design baseline changed.

## Review corrections

Spec review identified three related accepted-authority cases. Desired-behavior regressions failed before each correction, through both the hook interface and actual Settings fields:

- An external value followed by an ignored older receipt must remain the rollback target when a later edit fails. The hook now retains accepted authority separately from raw incoming props. A current receipt can advance rollback while newer typing remains visible; a superseded receipt cannot.
- Explicitly returning to an ignored receipt value must send a save. Unchanged suppression requires agreement with both incoming and accepted canonical values. The inverse #382 case, blurring retained external text to repair an older receipt, remains covered.
- A successful explicit return to the same raw numeric value must become the rollback target even when React receives no changed prop. Callers settle success through the same narrow operation used for failure; its submission must still belong to the current authority generation. A later failed edit then restores the successfully saved value.

A diagnostic also considered success followed by an external update and then an older publication. No reachable application sequence established that ordering, so the diagnostic and extra retention were removed. `NativeSettingsCoordinator.updateSettings` awaits publication before returning; `AppContext.enqueueSettings` commits the returned snapshot before resolving success and rejects stale returned snapshots when `onSettingsChanged` advances its version. The retained regressions preserve #382's existing pending-save/external/late-ack contract.

The strengthened semantic renderer-test gate from #392 passed on the integrated draft branch. Two hook-test calls now explicitly name their editable number/string domains; every runtime assertion is unchanged. Root reviewed this narrow typing correction at `95352089` with zero findings and carried the prior Standards/Spec approvals. Subsequent main and explicit #441 dependency composition at `3b707399` preserves the reviewed hook and caller implementation.

The coordinating agent's composed desktop run at `1698` passed the Settings journey in 19.0 seconds with this same Settings source, plus selected-microphone, mode-row and defaults neighbors in the broader 23-journey verification. The separate composed candidate in PR #447 failed a #390 observation-transition regression; that #390 source is not part of this branch and the result is not a Settings full-suite pass. The draft remains dependent on #441/PR #448 and its own exact-head hosted gates before merge.
