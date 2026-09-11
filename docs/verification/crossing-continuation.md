# Crossing continuation

Reference: `design/redesign-3/01-crossing.html`, its PNGs, and issues #32–37.

Recovered September 11, 2026 from `feature/crossing-shell` at `bff2854` and unfinished work in lanes 34, 35, and 37. Original lane files are preserved. The existing `CONTEXT.md` edit predates this continuation.

- [x] Recover the approved reference and existing implementation.
- [x] Integrate Threads and finish History, including existing actions and empty states.
- [x] Finish the Agents orb, session sheet, permission handling, and persistent color/voice controls.
- [x] Finish Settings and Help, with existing controls reachable and fields saving on blur. Voice credential controls retain their existing explicit save actions.
- [x] Run relevant behavior checks, typecheck, lint, build, and design captures.
- [x] Inspect the integrated Electron screens, motion/scale variants, and user journeys.

Acceptance: preserve the Crossing reference, black surfaces and bundled Bricolage typography; retain existing behavior and the unchanged floating widget. New Dictionary functionality (#38) and sign-in detection are separate work. No release, installation, or publication is included.

## Implemented

The main Agents room uses the recovered canvas orb, persisted color presets, real voice/working states, thread pills, explicit permission controls, and native dialog sheets for sessions, projects, configuration, and voice. Drafts survive closing a session; sending remains explicit. Threads opens the correct session or new-thread sheet.

History uses expandable rows, day groups, search, transcript facts, copy/delete, and footer clearing. Settings has the Crossing section navigation, state sentences, auto-saving fields, recording segments, account controls, and server setup sheet. Help follows the same reading layout. The development version display now reads Sotto's package version rather than Electron's runtime version.

## Evidence

- `npm test`: 112 test files passed, 3 skipped; 2,008 tests passed, 8 skipped.
- `npm run lint`, `npm run typecheck`, `npm run build`, and `git diff --check`: passed.
- `npm run design:capture` and `npm run design:verify`: all 83 required tuples captured, compared, and manifest verified.
- `npx playwright test tests/e2e/app.spec.ts tests/e2e/crossing.spec.ts --workers=1`: all 16 desktop journeys passed on the final build.
- Electron screenshots were inspected for the Agents room and permission/session sheets, Threads, History, Settings, Help, and scaling through 200%. Layout fixes include the Threads column width, Settings surfaces and switches, and native search clear control.
- The desktop journey covers onboarding, dictation, history copying, settings validation and persistence, account key removal, History keyboard navigation, orb color persistence, draft retention, explicit sending, and new thread creation.
- The final account dropdowns have explicit accessible labels. Orb animation is pinned in deterministic captures; live provider and microphone effects are replaced as described below.
- Images: `artifacts/crossing/`; authoritative captures: `artifacts/design/app-review/manifest.json`.

Earlier overlapping verification runs intermittently failed in coordinator persistence/assignment tests (Windows file operations and timing). The unchanged checkpoint's isolated suites and full suite passed; the completed worktree's final full suite also passed without overlapping Electron work. No coordinator implementation or recovery-test changes were retained. The visual harness now waits for the widget's bootstrap idle snapshot before starting its recording journey, preventing startup publication from racing the test.

## Delivery boundary

Changes are saved locally in `feature/crossing-shell`, under `.worktrees/lane-21`. They are not committed, merged, installed, or published. Original unfinished lane files and the pre-existing `CONTEXT.md` edit are preserved.

These Electron tests use deterministic microphone, transcription, provider, and delivery effects. Live microphone quality, paid provider authentication, real agent execution, installer behavior, and release packaging were not validated by this design continuation.

## Attention panel correction after dev review

The real development profile exposed a gap in the initial fixtures: saved queue items were shown while the provider was disconnected and its thread list was empty. The room rendered an overlay whenever the queue was nonempty, and its inherited Later action only rotated the queue. That made the panel appear impossible to dismiss. Its vertical offset also allowed longer updates to overlap the caption.

The room now presents attention only when connected. Its Later action dismisses the presentation locally; Review attention restores it, and a new or changed queue item reopens it. Pending requests and drafts are preserved without dispatching any provider action. The floating widget retains the original queue controls. The panel stays within the orb stage above the caption.

`tests/e2e/agent-attention.spec.ts` reproduced both failures before the fix and passes afterward. It verifies saved disconnected queues are preserved, Later cannot answer a permission, unrelated configuration changes do not reopen the panel, explicit review works, new requests resurface, and the panel does not overlap the caption. The full Crossing desktop journey and 24 existing queue/view unit tests also passed; lint, typecheck, build, and diff checks passed. The actual dev renderer was reloaded and visually inspected with the user's saved disconnected state; it now shows the orb.

For the normal dev launch, 7 model files and 4 runtime files were restored from the main checkout after checking each against this worktree's SHA-256 manifest. `npm run model:verify` passed. The launched dev process omits the inherited `ELECTRON_RUN_AS_NODE` environment variable.

The refreshed design capture passed all 83 required tuples after the attention correction.

## Connected review and speech interruption correction

The connected profile exposed a second gap. Its recorded commands showed Next cycling through the same three saved updates; each selection generated another announcement. The voice session queued those announcements instead of replacing obsolete narration. In addition, the renderer serialized Stop speech behind ordinary commands even though the main-process controller already supports immediate voice commands.

The room now finishes a review after Next has visited its pending items, without answering or deleting requests. Later and the end of review stop current narration. The room has visible Stop speech and Mute replies controls, and switching off replies cancels playback. New narration replaces old narration. Stop speech acts locally immediately, while voice commands and voice-state updates bypass the renderer's ordinary command queue. The post-playback microphone echo guard remains active, but no longer incorrectly labels stopped playback as speaking. The duplicate spoken-replies checkbox was removed from the configuration sheet.

New regression tests in `agentSpeechControl.test.tsx` and `agent-attention.spec.ts` failed before these corrections. They cover interruption during a pending command, replacement of narration, immediate stopped status, cancellation when replies are disabled, finite Next traversal, and persistence of mute through reload. Twenty focused speech/queue tests and nineteen Electron journeys passed before the final stopped-status correction. Build, lint, and typecheck passed. The first broader suite encountered backend timeouts, Windows file errors, and a worker exit; a run with limited worker concurrency is recorded separately.

Automatic spoken replies were switched off in the user's live profile while investigating. The user subsequently stopped Computer Use with Escape; no further desktop interactions were issued. The final renderer reload and refreshed visual baselines for this correction remain pending. The previous 83-tuple visual record predates the new speech controls and stopped-status correction.

The final `vitest run --maxWorkers=2` completed with 2,009 tests passed, 8 skipped, and one failure in the unchanged `agentControlRecovery.test.ts` teardown: `ENOTEMPTY` while deleting its temporary fixture directory. All speech-control regression tests, including the stopped-status correction, passed. Final typecheck, lint, and build passed. No coordinator or recovery-test changes were made for this correction.


## September 11 follow-up: reference corrections

Deliverables and acceptance checks (completed):
- [x] Inspect supplied video: Dictate speaking waveform must share widget voice gating and motion.
- [x] Inspect T3 sidebar: unsettled work above expandable Settled shelf, selected transcript and manual prompt workspace.
- [x] Implement shared listening bars; main icon now uses Dictate teal with black mark; icon controls have tooltips.
- [x] Implement thread workspace and manual prompt UI, configuration scrollbar matches History.
- [x] Verify provider last-activity and settlement metadata from real T3 shell and details.
- [x] Verify dismissal survives navigation, closed work stays out of attention and bottom pills, new live requests still appear.
- [x] Verify manual prompts send exactly once without granting automatic follow-up authority.
- [x] Repeat full affected journeys, inspect native dev app and rendered screenshots, refresh design captures.

Two GPT-6-Astra high subagents run through the configured Codex CLI: provider metadata/facts and attention/manual-send controls. Local Fable Agent tool unavailable; primary agent integrates UI directly from supplied references. No commits, pushes, installation, or release publication.


### Resumed review and integration

User resumed after the Escape interruption. All eight independent functional review findings have been addressed:

- Review selection carries an exact attention item through renderer and coordinator; spoken Allow/Deny and question composition follow the displayed request.
- Retrying an uncertain manual send reconciles its existing durable intent without dispatching again. The workspace retains an edited prompt if reconciliation did not deliver it.
- Automatic dispatch rechecks authority after persistence, so pause, unassign, takeover, settlement, and pending permissions revoke an in-flight follow-up.
- Workspace selection follows the coordinator; a draft belonging to another thread is explicitly protected. Closed requests stay hidden even in the unassigned-request fallback.
- T3 drops abandoned detail reads and merges fresh shell lifecycle/activity metadata at publication.
- Manual running work can be stopped without granting management.
- Speak-only configuration bypasses both renderer and coordinator queues; muting interrupts existing narration and suppresses subsequent replies immediately.

Verification: full Vitest 2,088 passed / 8 skipped (120 files); final affected agent/workspace Electron run 11 passed, including recovered drafts while disconnected; earlier 21 app/attention/workspace journeys passed. Typecheck, lint, build and diff whitespace checks passed. Real provider mutation and live thread sends were not used for testing.

### Final review delivery

The refreshed design capture completed all six journeys and verified the manifest's 83 required deterministic tuples. The configuration screenshot was recaptured with animations disabled and visually inspected: the sheet is opaque and its thin dark scrollbar matches History. Its settlement/workspace Electron regression passed again.

Development was restarted from this worktree at `http://localhost:5173/`. Native inspection with the real T3 profile showed three unsettled threads and 45 settled threads, actual historical activity times, the teal/black brand mark, and the manual prompt workspace. Opening a settled compatibility thread and returning to Agents did not reopen attention or add closed threads to the bottom pills. The speaker icon changed on click, and spoken replies are saved as muted for review. Manual dispatch, permissions, and retry behavior were exercised against test providers rather than sending messages to the user's live threads.

The earlier pending renderer/visual checks above are superseded by this completed verification. Changes remain local and uncommitted; no installation, release, push, or publication was performed.

## Single pill correction

User correction: remove the separate agent widget shown in the screenshot. Preserve the existing dictation pill and add microphone mute, voice mute, and explicit thread expansion to that pill.

- [x] Remove the alternate AgentWidget renderer; retain the idle sliver, hover pill, waveform, timer, stop/cancel, and drag behavior.
- [x] Add inline mute toggles and tooltips, with threads opening only through the expansion control.
- [x] Keep unsettled threads first and settled threads in a disclosure within the pill's expanded panel.
- [x] Verify all-edge native geometry and focus restoration with the backend subagent.
- [x] Verify actual widget IPC for both mute controls, including cancelling active dictation when muting the microphone.
- [x] Inspect rendered idle, recording, and expanded states; restart and inspect the development version.

The Electron journey exposed that speak-only configuration from the widget was rejected by the main-only IPC gate. The backend subagent reproduced both boolean cases failing, then added a narrow exception for this setting. Other widget configuration remains rejected.

Final checks: 121 renderer/widget-sync tests, 134 geometry/window tests, and 161 IPC tests passed. The complete pill Electron journey passed with real renderer/preload/controller communication and fixture audio/provider effects. It covers microphone mute, both directions of the voice toggle, explicit thread expansion, settled thread selection, collapse, starting dictation from the pill, and cancelling recording with microphone mute. Typecheck, lint, build, and whitespace checks passed.

Inspected `artifacts/crossing/pill-controls.png`, `pill-listening-controls.png`, and `pill-threads.png`. The existing pill surface and waveform remain, with inline controls. The development app was restarted from this worktree (launcher PID 4696, renderer at `http://localhost:5173/`); the native desktop shows the single resting sliver. Native hover automation could not target the non-focusable pill, so the detailed control verification uses the passing Electron journey and its rendered screenshots. No live thread messages were sent. Changes remain uncommitted.

## Dictation hotkey focus regression

- [x] Reproduce the external text target losing focus with the real Windows hotkey.
- [x] Remove redundant native focus changes while preserving explicit thread-panel interaction.
- [x] Check hidden-panel recovery, native recording start/stop, and automated caret/blur-event assertions.
- [x] Remove diagnostic code and restart the clean development app.

The real Ctrl+Shift+Space reproduction used a temporary editor in another Electron process, with the user's pill docked on the right. The editor blurred as recording began. An independent backend audit traced `setFocusable(false)` through Electron 43.1.0 to Windows deactivation; even an unchanged false value can transfer foreground focus. The initial E2E callback tests passed, so those tests alone did not establish reproduction.

WindowManager now remembers the applied focusability and invokes the native setter only when that value changes. If a hidden expanded panel resets to the pill, it applies the reset before revealing the native window. Two regression contracts were run red before their fixes: redundant setters during ordinary pill transitions, and restoring a hidden panel before reveal. The final targeted run passed 140 unit/integration tests.

In the native rerun, the temporary editor retained its focused outline/caret during real hotkey recording start and stop, unlike the pre-fix immediate blur. No live spoken insertion was established by the silent test recording. The final five Electron journeys passed, including four right-edge states (resting, hidden, expanded, and expanded then hidden), a separate-process text target, zero blur events through the tested cycle, and unchanged selection. The existing pill mute/expansion/dictation journey also passed. These journeys use fixture audio and paste effects.

Typecheck, lint, build, and whitespace checks passed. Temporary `[DEBUG-focus]` hooks were removed from source and the temporary editor was closed. The cleaned development version was relaunched; no commit or push was performed.
