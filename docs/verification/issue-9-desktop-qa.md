# Desktop agent QA

Requested: test the actual desktop application with Computer Use, fix reproducible problems, and leave a usable development build open for Zach.

Baseline: `1173fa8` on `main`. Preserve existing dictation settings and unrelated T3 projects/threads. Test actions use a dedicated Sotto QA project and bounded prompts.

## Actual desktop checks

Computer Use operated the normal Sotto profile and the installed T3 Code 0.0.38 app. Live actions were confined to **Sotto Desktop QA**, created through Sotto at `artifacts/agent-control-smoke/Sotto Desktop QA`.

- Created the project with an explicit absolute folder. Repeating creation reported the existing-folder conflict without overwriting it.
- Created Alpha, Beta, and Gamma with the available Claude Haiku 4.5 account. Retested Gamma creation while Alpha was waiting: Gamma stayed selected, its new draft targeted Gamma, and the creation form reset.
- Sent bounded, tool-free prompts through Sotto. Alpha and Gamma returned their exact requested markers. Sotto presented the older completion first; Next and Later switched between real queued threads. A nonempty draft blocked queue advancement without losing text.
- A reply sent directly in T3 put only Alpha into manual control. Its unsent draft and ownership survived a real application restart. Cleared that QA draft in the widget, resumed management, and tested pause/resume in the main window.
- Removed and reassigned Beta. Unassigned threads displayed **Manage this thread** and hid the composer. No unrelated thread was assigned or prompted.
- Tested a running Beta turn with **Stop agent**. The thread settled, management stayed paused, and T3 displayed the truncated response with an idle composer. An earlier, shorter turn completed before interruption was established and was not counted as a passing stop test.
- Inspected long responses in the main window and widget. Queue previews are bounded; **Read full update** expands into a height-limited scrolling area. The separate latest-response preview remains readable.
- Tested widget collapse/expansion, scrolling, prompt clearing, mute/unmute, stopping an announcement, and dragging without starting dictation. Applied an equal reverse drag after the movement test.
- Started ordinary dictation from the widget, observed recording, and cancelled with Escape. Agent wake capture resumed. This check did not submit background audio for transcription.
- Verified local wake startup, restart, and mute recovery with no wake errors in the final runtime log. Human speech recognition accuracy and audible voice quality were not established by these visual states.
- Disconnected and reconnected through the main controls. T3 pairing recovered, all three assignments and queued items remained, Beta stayed paused, and local wake returned. **Set up reasoning** opened the connection form with the provider field focused; no account settings were changed.

## Fixed defects

- Creation could be displaced by an older queued thread, leaving the wrong composer selected.
- Queue answers used disposable component state and vanished on navigation. Typed and spoken answers now use one durable, question-bound composer shared by main and widget.
- Confirmed option answers left a stale draft. Only the matching question draft is now cleared; failures and unrelated drafts remain saved.
- Exact local control phrases were appended to an existing draft, and empty drafts blocked Next/Later.
- Missing reasoning setup accumulated misleading pending requests, while valid actions that failed execution lost their original request. Context now distinguishes those cases and survives an actionable correction/restart.
- An unresolved creation could be retried with a fresh ID. New creation is blocked until host reconciliation establishes the prior outcome.
- Switching API providers retained the previous provider's key. Route changes now durably clear the old credential before switching.
- A new failure arriving during reasoning or dispatch could be missed. Supervision rechecks current state when its lane finishes, respecting manual ownership, pause, and follow-up limits.
- Loud microphone audio could exceed full scale after sinc resampling and fail strict wake validation. The voice capture boundary now clamps resampled PCM; shared dictation resampling and wake IPC validation are unchanged. Regression waveforms reproduced peaks of 1.0814 at 44.1 kHz and 1.0108 at 48 kHz before the fix.
- Navigation required scrolling through every project; creation forms retained successful entries; unassigned threads showed unusable controls; typing expanded the widget unnecessarily; long queue responses buried controls. Search, bounded navigation/previews, form reset, explicit assignment, and predictable expansion address these flows.

## Verification

- Final relevant Electron run: **17 passed**, covering answers, control, setup recovery, main/widget flows, and voice/dictation routing.
- Final focused regression run: **69 passed** across controller recovery, renderer workflows, queue synchronization, voice capture, and voice sessions. The neighboring membership suite also passed earlier in this pass.
- Full application run: 50 passed, six opt-in design capture cases skipped, and one outdated privacy fixture failed because it typed into an unassigned thread. The fixture now assigns its test thread explicitly and passes in the final run. A subsequent neighboring run exposed the supervision timing race; it was reproduced deterministically, fixed, and passes in the final run.
- Typecheck, lint, production build, and diff whitespace checks passed. The full run also covered ordinary dictation, history/privacy, dark mode, shortcuts, startup, tray behavior, native topmost widget behavior, and visual preview gates.
- External reasoning, lost acknowledgments, native question/permission responses, and follow-up limits use controlled external-host/model fixtures in automated tests. They are not claimed as live reasoning API tests.

## Handoff and remaining limits

The source is committed locally with these fixes. The normal-profile application is left open on **Sotto QA Gamma**, connected to T3 with wake capture active and no unsent draft. It runs this checkout's final production output using `node_modules/electron/dist/electron.exe .`; launching from the repository root preserves Sotto's package identity and existing profile. This pass does not update the older installer, push source, or publish a paid release. The existing wake redistribution, production billing, and macOS release gates remain in their separate verification records.

Live test prompts used the account already configured in T3. Sotto reasoning remains unconfigured: using the existing OpenRouter formatting account for separate reasoning usage awaits Zach's answer. No formatting key was repurposed. Natural-language app creation and autonomous follow-ups therefore still need that account decision before live verification.

The next hands-on test should check the actual **Hey Sotto → dictate → send it** microphone journey and speech quality. Synthetic audio tests and visual capture states cannot establish room-noise, accent, microphone, or speaker performance. The dedicated QA threads are available for that test; Beta remains paused after the interrupt check.
