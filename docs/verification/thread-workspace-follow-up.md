# Thread workspace follow-up

September 11 merge preparation (user authorized push and merge of the completed overhaul): full serial Vitest run passed **2,232 tests**, with 8 existing skips, across 127 passing files and 3 skipped files. The initial two-worker run had one Codex fixture acknowledgement timeout at its 200 ms deadline; its complete adapter suite passed in isolation and the subsequent full serial run passed unchanged. Typecheck, full lint, build, third-party notices (46 components), and staged whitespace checks passed. The authoritative design baselines were refreshed for the approved thread workspace/footer changes; all six capture journeys and the 83-tuple manifest passed. Temporary agent prompts, logs, probes, and diagnostic captures remain local. Release packaging is outside the requested merge.

The final visual comparison exposed a timer-only capture race (`00:01` versus `00:00` in the listening pill). The design harness now fixes Date in that test widget renderer and waits for its elapsed display; normal timers and the product clock are unchanged. Baselines were regenerated with the same deterministic clock; pixel comparison thresholds remain unchanged.

September 11 folder error and provider model picker:

- [x] Resolve a chosen folder by normalized path, independent of navigation's active project ID. Refresh delayed acknowledgements and retain attempted folders through retry/reselection to avoid duplicate folder submissions.
- [x] Shared model popup in New thread and composer footer: provider sidebar, adjacent searchable models, numeric model versions descending with provider order retained for ties. Catalogs do not expose release dates; this orders model versions, not inferred release timestamps.
- [x] Keyboard selection, unavailable models, focus restoration, and Escape closing only the nested model dialog. Search Enter cannot submit the parent new-thread form.
- [x] Integrated checks: 166 tests across 11 focused/neighboring suites, two Electron app journeys, node/web typecheck, targeted lint, and build pass.
- [x] Inspected Electron screenshots for New thread and composer placement; exercised provider switching/selection against synthetic catalog in T3 collaborative preview. Refreshed the live dev window and verified the real Claude/Codex/Grok catalog and existing Codex folder project. Live inspection did not create a project/thread or change a thread model.

Folder root-cause and red/green evidence: `artifacts/project-create-follow-up-result.md`. Regressions reproduce mismatched navigation IDs, Windows path separators, and the real T3 adapter joining an older shell read. Live provider creation remains unexercised; Electron mutation tests use the fixture provider. Changes remain local, with no commit, push, or release.

September 11 placement correction: model, reasoning and permission selectors belong in the composer footer, replacing the static model label, for both manual and managed Threads composers. Removed the settings row above the transcript. Kept accessible names and added hover titles; controls wrap when space is narrow. Verified in the refreshed live dev app; renderer typecheck, targeted lint and 45 existing thread/composer tests pass.

September 11 user acceptance checks:

- [x] New thread opens and completes in Threads without navigating to Agents.
- [x] Centered T3-inspired searchable project/folder picker, keyboard navigation and native local folder browsing.
- [x] Past messages load on selection/entry, with bounded caching and no dependency on focusing the composer. Both navigation queues now bypass unrelated slow commands, with selection revision guards.
- [x] Model, reasoning effort and permissions are editable for an existing thread and selectable at creation, backed by provider behavior.
- [x] Screenshot file selection and clipboard paste, previews/removal, and correct provider delivery with drafts retained on failure.
- [x] Test affected journeys and inspect rendered/live dev views; preserve the pill and hotkey focus fixes.

Backend subagents own provider options/images and the native folder chooser. A read-only audit investigates thread detail loading. Primary owns the interface and integrated verification. Preserve other work in lane-21; no commits, pushes or release actions requested.

Implemented centered native dialog, local existing-folder project creation, advertised provider option selectors, file/paste/drop screenshot previews and delivery, loading/error/retry UI, and initial 80-message rendering bound. T3 adapter uses immediate per-thread requests, four concurrent reads, 12-entry/8 MiB inactive cache with 60-second freshness and 10-minute retention. Cached activities never supply current permissions. The provider API continues to return the most recent five turns; full archival pagination is outside this change.

Independent correctness audit findings resolved: delayed FileReader completion uses the latest callback and preserves newer text; manual sends use persisted caller draft UUIDs and bounded confirmed delivery receipts, clearing only an unchanged submitted local revision; selection bypasses unrelated provider commands with guards against stale completion. Renderer regressions cover replacement screenshots with identical filename/content and late receipts. Navigation/delivery regression suites: 24 passed. Broader controller recovery/authority/attention/recording/speech suites: 252 passed.

Verification: 129 renderer/preload tests earlier in integration; final affected composer/thread/image suites 49 passed. Provider suites 329 passed/2 pre-existing skips; history suites 134 passed/2 pre-existing skips; original three history audit reds now pass; picker suites 181 passed. Build, node/web typecheck, targeted lint pass. These counts overlap and are not a unique total.

Final expanded navigation/delivery integration run: 457 passed, one existing direct-Codex adapter test hit a Windows EPERM rename/file-lock failure. That test passed in isolation; the expanded run is not described as fully green. All 24 new navigation/delivery regressions passed. See artifacts/thread-navigation-delivery-result.md for exact commands, the intermittent storage limitation, and evidence. No further production edits followed the dev build.

Electron creation/options/file/paste/managed screenshot journey passes, including retained draft and retry after a rejected managed send. Wider agent-control/workspace/full-app journeys: 11 passed initially; fixed the new popup's test locator scope and reran it plus one transient Electron restart failure, both passed. Four isolated native dictation focus cases pass; the initial hidden-case failure occurred before the hotkey while acquiring the external test editor. Pill controls journey also passed. Screenshots under artifacts/crossing/new-thread-*.png and thread-screenshot-draft.png were inspected; popup geometry is centered. Agents New session retains managed creation; Threads New thread creates an unassigned manual thread.

Live dev restarted from lane-21, launcher PID 64848, renderer http://localhost:5173/, logs artifacts/thread-final-dev.log and thread-final-dev-error.log. Computer Use inspection verified the visible Sotto window, live T3 model/reasoning/permission values, restored transcript on entry, immediate transcript loading when selecting a different thread without touching the composer, centered picker with real projects, native Windows Select Folder dialog and cancellation. Left the app on Threads. Live verification was read-only aside from local navigation; no project creation, model/permission mutation or message submission.

No live provider messages, settings changes, uploads, commits, pushes or releases during verification. T3 image contracts verified against installed 0.0.38 source maps; backend provider effects in tests are synthetic. Native Codex image support remains explicitly unavailable; T3 provider images supported.
