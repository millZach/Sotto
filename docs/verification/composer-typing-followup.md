# Composer typing follow-up

Investigation on September 24–25, 2026, following PR #287 and release 0.1.17.
The user confirmed **“Delay is gone”** after testing the combined main-process
and renderer changes in the normal installed window. The follow-up is prepared
on `fix/composer-keystroke-rendering` for issue #286. The hand-tested running fix
is temporary for that session, not an installed update or a release.

## Acceptance and current state

- [x] Inspect PR #287 and compare the composer with T3 Code.
- [x] Trace both browser work and Electron's main process under the real workload.
- [x] Demonstrate regressions that fail before the fix and pass afterward.
- [x] Confirm typing and deleting feel responsive in the user's normal app.
- [x] Run relevant Electron journeys and inspect the supported window sizes.
- [x] Finish independent standards/spec reviews and remove diagnostic collection.
- [x] Complete the full CI test run and record failures separately.
- [x] Required Windows and Linux CI gates passed on `686236ee` (5,240 tests
  passed, 50 skipped on Windows). The final test/documentation follow-up must
  also pass before merge; [PR #330](https://github.com/millZach/Sotto/pull/330)
  records checks for its exact latest revision. Baseline theme failures remain
  separately documented below.

## Cause and evidence

The missing cost was in Electron's main process. Draft saves and voice-status
commands called `AgentControl.get()`, synchronously cloning the entire loaded
state, including histories. The desktop router immediately discarded those
histories and returned a shell. PR #287 reduced model catalogs in broadcasts;
it did not remove this intermediate copy in command replies.

A 21.086-second main-process CPU profile attributed about 2.06 seconds to
JavaScript `structuredClone` samples plus 165 ms to its native samples. The
largest relevant stacks led through `get()` from voice-status and draft-save
commands. A read-only comparison on the same session (80 threads, 110 messages,
20,413 activity records) measured `get()` at 226.25 ms and `shell()` at 10.38 ms.
These are single-session measurements, not general timing budgets.

The patch returns the shell directly for draft saves (including already accepted
revisions) and voice-status reports. Model catalogs, exact draft IDs, persistence
status and errors remain in the reply. Explicit full-state reads and the separate
thread-detail channel still provide history. Persistence and revision checks are
unchanged. Regression tests spy on actual clone inputs to reject full-history
copies and also assert revision/save evidence and retained thread details. Both
new main-process cases failed with the old returns and passed with the patch.

The renderer had separate costs that also needed removal:

- The pane subscribed to the whole draft although it only needed a content flag.
  Ordinary text edits rendered the transcript and surrounding controls.
- A closed model picker grouped and sorted its catalog during composer renders.
- Broad descendant `:has()` selectors restyled unrelated elements when React
  updated the textarea. A Chromium regression with 1,000 unrelated elements
  failed against the old renderer (1,436 elements restyled) and passed after
  working-copy presence and theme inspection became explicit attributes.
- Reconciliation walked retained history arrays again on unrelated shell updates.
  A connection-owned weak cache reuses their reconciled identities.

The editor now owns the full draft subscription. Controls subscribe to the facts
they display and read the latest text when sending or adding Ultrathink. Tests
cover render counts, closed-catalog work, latest-text sending, Ultrathink,
retained histories and inspector attribute cleanup. Text updates are immediate;
the existing draft-save debounce and durability contract are unchanged.

## User confirmation and diagnostic limits

The renderer changes alone did not cure the reported delay. Applying only the
main-process reply fix produced **“Improved, still delayed.”** Applying both
produced **“Delay is gone.”** The combined trial ran in the user's normal installed
window with its actual providers and histories, not only in an empty fixture.
Drafts were flushed before the renderer reload and the prior draft was confirmed
present afterward. The installed executable was not modified.

Earlier browser Event Timing samples were inconclusive: their quantized durations
include presentation delay and do not isolate native input waiting in Electron's
main process. A paired physical-key sample had median durations of 48 ms in the
composer and 40 ms in Sotto's answer field, while keydown handlers themselves
were short. Browser-owned textarea, GPU and notification experiments did not
establish a cure. One dedicated-window asset-switch trial was invalid because a
listener retained the old root; subsequent comparisons verified the loaded asset
names and React editor component. No product changes rely on that invalid trial.

## T3 comparison

Inspected `pingdotgg/t3code` at
[`9c524d57718e639a6abe0a5fa3cbf6e9b086df86`](https://github.com/pingdotgg/t3code/tree/9c524d57718e639a6abe0a5fa3cbf6e9b086df86).
This is a source comparison, not a benchmark of the user's installed T3 version.

| Area | T3 Code | Sotto |
| --- | --- | --- |
| Editable document | Tiptap owns the document in both plain and rich modes | React-controlled textarea |
| Normal edit | Serialize editor document, update a ref, notify the draft store | Update the revisioned draft store, notify subscribers, render textarea |
| External text changes | Replace editor content only when it differs from the last editor snapshot | React reconciles the textarea value against the draft |
| Draft persistence | Deferred serialization and local storage, 300 ms debounce | Main-process persistence through an agent command, 250 ms debounce |
| Suggestions | Detect and store the active trigger | Two hooks store caret selection and derive skill/file triggers |

Sources:
[editor wrapper](https://github.com/pingdotgg/t3code/blob/9c524d57718e639a6abe0a5fa3cbf6e9b086df86/apps/web/src/components/ComposerPromptEditor.tsx),
[editor updates and controlled synchronization](https://github.com/pingdotgg/t3code/blob/9c524d57718e639a6abe0a5fa3cbf6e9b086df86/apps/web/src/components/ComposerPromptEditorTiptap.tsx#L662-L717),
[composer edit handler](https://github.com/pingdotgg/t3code/blob/9c524d57718e639a6abe0a5fa3cbf6e9b086df86/apps/web/src/components/chat/ChatComposer.tsx#L3327-L3431),
[draft store](https://github.com/pingdotgg/t3code/blob/9c524d57718e639a6abe0a5fa3cbf6e9b086df86/apps/web/src/composerDraftStore.ts#L92-L142).

T3 does update application state on each edit. Its whole composer subscribes to
the selected draft. It would be incorrect to describe it as avoiding React work
entirely or debouncing the visible text. Its editor-owned document is a meaningful
difference, but is not by itself evidence that switching to Tiptap fixes Sotto.

T3 also has a [separate Windows input-lag report](https://github.com/pingdotgg/t3code/issues/12689)
with a synchronous desktop IPC stall in its profile. Sotto's preload has no
`sendSync` calls, so that explanation does not transfer to this bug.

## Validation

Build, typecheck, lint and notices verification passed. The latest targeted run
passed 56 tests across main shell/detail, typing and thread options.

Five Electron journeys passed: attached images at the minimum size and in a
short split, keyboard focus through handoff, the new style-invalidation regression,
split-workspace independence, and the main theme journey (light/dark/system,
reduced motion, inspection, resize, saving and restart). The old sidebar pointer
interception from the earlier investigation did not recur in this run.

Two additional theme journeys failed: spotlight refreshes did not become idle
(18 root style mutations and 3 spotlight redraws in the isolated rerun), and the
minimized theme editor overlapped Send at 820x560. Both failures reproduced with
the same assertions against the unchanged installed 0.1.17 main/renderer bundle,
using separate E2E profiles via `SOTTO_E2E_MAIN_ENTRY`. They are pre-existing
defects outside this typing fix. The third theme case was run separately after
the serial suite skipped it on the spotlight failure.

Visually inspected the composer at 820x560 in dark, 1600x1000 in light and
1280x800 in dark. The composer and Send remained within the window; the middle
size also reported no horizontal document overflow. Captures:
[minimum dark](../../artifacts/phase-three-themes/threads-820x560-dark.png),
[large light](../../artifacts/phase-three-themes/threads-1600-light.png),
[middle dark](../../artifacts/phase-three-themes/composer-1280x800-dark.png).
Only these three captures are retained with this note; design baselines were not
regenerated.

`npm test -- --maxWorkers=2` finished in 925.90 seconds: 399 files passed,
1 failed and 20 skipped; 5,242 tests passed, 1 failed and 47 skipped. The failing
personal-chat recovery case at line 141 expected a retained prior message and
an error after invalid request context, but received an empty message list. All
22 cases in that file passed when rerun alone. The failure's intermittent cause
is unresolved; it is not established as a regression from this patch, and the
full test gate was not green in that run. Typecheck, lint, notices and build passed
separately.

The intermittent failure was then reproduced deterministically: waiting for
startup to connect before installing the mocked native snapshot made all 11
invalid-observation cases fail with the same empty history. `connect()` correctly
does nothing when already connected; the test had depended on startup still being
in flight to import its mock. The fixture now explicitly disconnects and reconnects
after installing the snapshot and asserts that the valid history was accepted
before introducing invalid data. All 22 recovery cases pass with that ordering.
Production personal-chat behavior was not changed.

The next local full run passed 5,242 tests and failed one Claude socket fixture
at connection setup, before the scenario ran: the fake CLI's subscription/model
probe failed. That run coincided with Windows allocation failures in concurrent
lint/build processes; its elapsed time was 1,944.23 seconds. All four socket
creation/streaming cases passed in isolation afterward. The clean Windows CI run
on `686236ee` then passed 397 files / 5,240 tests with 23 files / 50 tests skipped;
the Linux host archive/socket/SSH job also passed. Local typecheck, lint, notices
and build passed (lint/build were retried after the allocation failures).

A final Electron run also covered skills and review-comment sending; both passed,
as did typing styles, keyboard handoff and split workspace. The attachment-layout
setup exposed another timing assumption: its optimistic first message appeared
before queuing was enabled. It now waits for the enabled Queue prompt action
before pressing Enter to build the layout fixture. Both short-window cases passed
three consecutive runs afterward (six passes). Assertions were not weakened.

## Review and diagnostic cleanup

Standards and spec were reviewed separately by two independent local critics
against AGENTS.md and the user's typing/backspace symptom. This was the project's
separate-critic workflow: the code-review skill's custom reviewer role was
unavailable, and both GitHub review bots reported account usage limits. Neither
critic found an actionable defect. Standards covered privacy, theme roles, gates,
shell/detail boundaries and cache ownership. Behavior covered durability, latest
text, queue/steer/answer paths, references, keyboard behavior and appearance.
The behavior critic suggested a nonblocking coverage improvement, now added:
the review-comment send test performs a second nonempty edit before submission
to check that comments are appended to the latest text. Incidental design capture
changes were restored. The two baseline theme failures remain documented above.

The dedicated diagnostic Electron window was closed and its owned temporary
profile removed. CPU profiling and replay broadcasts stopped. Private workload
payloads were held in memory only for this round; no prompt text or protocol
bodies were added to logs. The normal window retains the confirmed temporary
fix through a scoped main-process override and local renderer interception.
Assets are pinned in the ignored `.cache/composer-verified-renderer` folder so
subsequent builds do not change the running session.
Timing collection was removed, the main-process inspector was closed (no listener
remained on port 9229), and the diagnostic JavaScript kernel was reset to release
in-memory traces and workload captures. The renderer debugger remains attached
only to serve the pinned local assets. Its fallback error list is bounded to five
entries and was empty at handoff. Restarting Sotto returns to the installed build.

A previous session's automatic tool policy rejected removal of a closed preview
profile with only “blocked by policy” as its reason. That older directory remains
at `C:\Users\zache\AppData\Local\Temp\sotto-e2e-typing-review-NEnFye`; the rejection
was not bypassed.
