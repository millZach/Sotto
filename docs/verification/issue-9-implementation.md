# Issue 9 implementation record

Baseline: `63c3c6e913da561deb314e8d337f7eaf04c0672e` on `main`. Issue: [#9](https://github.com/millZach/Sotto/issues/9). Implementation date: 2026-09-09.

This is a working desktop development implementation, with explicit prerequisites still blocking a complete paid release. It does not claim that the membership service is deployed or that physical voice and macOS acceptance have passed.

## Deliverables

- [x] Existing local T3 Code shared-state adapter, independently authenticated and verified against installed version 0.0.38.
- [x] Folder/project/thread creation, ready-account model discovery, configured defaults and explicit overrides.
- [x] Assigned-thread authority, manual takeover, bounded automatic follow-ups, permission handling, sequential queue and explicit resume.
- [x] Editable prompts and question-answer drafts pinned to their destinations, explicit submission, durable recovery and no automatic resend after an unknown acknowledgement.
- [x] Compact/expanded agent widget, local wake service, local ASR, native spoken replies, mute/stop controls and coexistence with ordinary dictation.
- [x] OS-backed encrypted credentials and formatting-key migration; separate coding, reasoning and membership accounts.
- [x] Hosted membership client with device sign-in, checkout/portal links and bounded server-confirmed entitlement caching. Packaged builds without a service grant only free dictation; unpackaged builds label private development beta access.
- [x] App-level Electron tests, live T3 proof, actual local model/capture proof, visual inspection and independent standards/spec reviews.
- [x] Packaged Windows final verification. Source and this record form the local implementation commit on `main`.
- [ ] Distribution of a reviewed keyword runtime and appropriately licensed model weights.
- [ ] Production identity/billing service, price and grace-policy decisions, hosted pages and verified billing webhooks.
- [ ] Physical microphone/speaker acceptance and Apple silicon macOS live validation.

## Implemented behavior

`AgentControl` owns thread assignment, authority, drafts, queue ordering, follow-up budgets and durable dispatch intent. Host observations can revoke automatic authority while reasoning is in flight. Direct T3 user messages transfer only their thread to manual control; selecting or reading does not. UI and spoken notices describe the handoff and explicit resume.

Prompts and freeform question answers accept several voice segments without submitting on a pause. Answers retain their host request ID through restart and use the answer operation, even while T3 reports the thread running. Exact permission decisions and explicit UI answer buttons remain deliberate immediate actions. Other queued threads do not retarget a draft.

The first adapter uses local authenticated T3 orchestration endpoints with a pinned compatibility version. It shares the existing app's projects and threads, preserves its approval policy and account choices, and refuses unsupported models or versions. The common host contract exposes capabilities; public plugin distribution and additional harnesses remain future work.

Only the main renderer receives audio-processing methods. The widget receives typed state/commands and existing dictation controls. Native sender checks reject widget credential/configuration/membership mutations. Membership is checked before reasoning and dispatch; expiration never cancels existing T3 work.

Assignments retain minimal recovery IDs and counters. Processed context expires after seven inactive days; disabling history removes stored supervision and clarification text. Failure comparison stores a digest. An unsent draft remains the disclosed recovery exception until sent or cleared. Background PCM and full host conversations are not persisted.

## Verification performed

| Check | Observed result |
| --- | --- |
| `npm run typecheck` | Passed after the final request-bound draft changes. |
| `npm run lint` | Passed after those changes. |
| Full `npm test`, run once | 1,455 passed, 5 skipped, 5 failed. The failures were outdated bridge-key and reviewed-built-in inventories in two files; expectations were updated for the intended interfaces. |
| Focused rerun of those two files | 130 passed; all five failures resolved. The full suite was not repeated, following the implementation skill's once-at-end instruction. |
| Membership + native settings regressions | 27 passed, including real atomic-write rejection and a failed native effect preserving the previous vault key. |
| Focused voice session checks | 8 passed, including setup failure before capture, discarded room speech, mute/echo suppression and dictation handoff. |
| Complete Electron suite | 45 passed; 6 opt-in design tests skipped in this invocation and exercised separately. Covers original dictation, clipboard/paste/history/settings, actual native topmost behavior, agent control, voice routing and widget credential rejection. |
| Final agent-focused Electron run after question-answer fix | 15 passed: answer pauses, running-question dispatch, request binding across restart, permissions, ownership races, unknown acknowledgements, privacy, queue priority, dark minimum-window UI and ordinary dictation. |
| Visual capture matrix | All 6 normalized comparison tests passed and all 112 expected tuples verified. The capture helper parks the pointer to prevent native checkbox hover paint without changing keyboard focus, production styling or tolerances. |
| `npm run model:verify` | 7 bundled model files and 4 runtime files verified. |
| Third-party notices verifier | 45 redistributed components verified. General Sherpa runtime and wake weights are not bundled. |
| `npm run package:dir` | Passed. The unpacked Windows app launched in an isolated ordinary profile, rejected the test-only bridge and loaded its bundled model through the production worker with WASM. Packaged resources, notices, dependency inventory and build provenance verified. |

The test environment is admitted only in unpackaged builds. Tests use the actual main process, preload, IPC, controller, persistence, renderer and voice session. Controlled external effects provide microphone samples/transcripts, keyword results, speech output, host events, reasoning responses and membership responses. They do not establish microphone or billing-provider behavior.

The implementation skill requested TDD at agreed seams, regular focused checks, one full suite, code review and a current-branch commit. Its optional `/tdd` skill was unavailable; red/green regression checks used the agreed seams directly.

## Live T3 evidence

Installed T3 Code 0.0.38 accepted Sotto's independent pairing/session and exposed ready Claude/Codex accounts. A task-owned folder, project and thread were created under `artifacts/agent-control-smoke/`. Two small subscription-backed test turns verified shared messages and a real native question/answer. Command replay and reconnect did not duplicate actions. Test sessions were revoked; unrelated threads were not edited or prompted.

The final stale-message guard reused the same thread without another model turn. An older expected user-message ID was rejected before dispatch and message IDs were unchanged. T3 offers no atomic compare-and-send operation: a direct message arriving between the final read and dispatch remains a host protocol limitation.

The existing native T3 window was inspected and the owned thread header was reached. Completed conversation content was verified through live shared host state. The computer-use surface later returned inconsistent click/screenshot state, so a completed-transcript native-window walkthrough is not claimed.

Ignored local proof records:

- `artifacts/agent-control-smoke/Sotto integration 2026-09-09T22-24-41-370Z/compatibility-report.json`
- `artifacts/agent-control-smoke/Sotto integration 2026-09-09T22-24-41-370Z/changed-thread-guard-report.json`

## Voice and visual evidence

The actual local keyword service and worker detected all five synthetic positive wake WAVs and rejected tested soda/sofa/tomorrow, embedded-name and non-speech negatives. Combined wake/command clips were trimmed and transcribed as “Open workshop.” Real `BrowserVoiceCapture` segmentation feeding the production local transcription runtime recognized David/Zira “Send it” and David “Next” at 16 kHz and simulated 48 kHz. No padding workaround or cloud transcription was added. Native Windows synthesis produced valid WAV audio. These use generated fixtures, not a human microphone or listening assessment.

Read [the wake record](issue-9-wake.md) for sources, hashes, timings, reproduction and distribution constraints. Source builds can use the pinned development runtime; installed builds require supplied compatible runtime/model folders. Files are verified before code loads or capture begins.

The main Agents view, manual-takeover notice, expanded widget, dark settings at 820×560 and dark widget prompt were rendered and inspected. The widget send button was reached by scrolling and used. Existing baselines were updated for Agents navigation and normalized pointer state, preserving the dictation UI. Agent screenshots are reproducible local artifacts under `artifacts/agent-control-smoke/`.

## Review and release gates

Independent [standards and specification reviews](issue-9-review.md) found and resolved ownership/queue, rejection recovery, clarification retention, privacy, widget, mute-state and credential transaction issues. A final pass found early submission of freeform question answers; the request-bound draft fix and three application regressions address it.

Concrete remaining release gates:

1. Confirm redistribution terms for the tested wake weights or replace them. Build/review a keyword-only runtime with complete notices; the standard development runtime includes an unwanted TTS dependency and is excluded from the package.
2. Deploy the [membership service contract](issue-9-membership-service.md), choose pricing and identity settings, then verify purchase, renewal, cancellation and webhook replay/out-of-order handling in the provider test environment. No purchase or deployment was performed.
3. Run actual microphone/speaker wake accuracy, false-trigger, latency, accent/noise, device-switch and interruption acceptance. Perform native Apple silicon app, vault, speech and T3 validation. No macOS machine was used.

These gates prevent calling issue 9 a completed paid production release. The [setup guide](../agent-control.md) describes local development use.

## Final delivery

Local delivery consists of the implementation commit on `main`, this evidence record, the setup guide and the verified unpacked Windows build at `release/win-unpacked/Sotto.exe`. The package smoke opened no microphone. No installer was produced, and no push, publication, deployment or issue closure was performed. The remaining release gates above are still open.
