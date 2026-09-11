# Sotto subscription reasoning correction

This records the first subscription implementation. Its model restrictions and Grok placeholder are superseded by the [complete native model-selection follow-up](subscription-model-selection-qa.md).

Acceptance checklist for the September 9, 2026 desktop correction:

- [x] Reproduce the missing subscription selector with a failing renderer test.
- [x] Offer native ChatGPT and Claude subscriptions separately from explicit API accounts.
- [x] Preserve the selected provider/model and restore it after restart without a Sotto API credential.
- [x] Route command interpretation and supervision through the chosen client and validate decisions.
- [x] Keep Grok visibly unavailable until its native integration can meet the same contract.
- [x] Verify native account status, bounded text-only inference, and no API fallback at the subprocess seam.
- [x] Check integrated types/lint/build and relevant controller, renderer, and Electron regression tests.
- [x] Use Computer Use to select/check/save subscriptions in the normal desktop profile and inspect the rendered result.
- [x] Leave the verified build running for Zach and record the actual live checks and remaining limits.

The original issue #9 spec calls for supported subscriptions for Sotto’s supervisor as well as coding agents. The previous API-only supervisor was an implementation omission. Existing coding-provider accounts in T3 still stay in T3; Sotto’s supervisor now has its own explicit subscription selection using each supported provider’s installed client.

No provider tokens are copied into Sotto or reused against arbitrary endpoints. No new account, subscription purchase, extra-usage setting, or API billing fallback is part of this correction. The unrelated formatting-provider key remains untouched.

## Supported routes and native proof

- **Claude Code 2.1.267:** the current native Claude.ai subscription was detected. Sonnet (the default) and Opus aliases are offered. The implemented client returned the expected JSON in a live Sonnet request. Required CLI flags are checked before readiness; safe mode disables executable customizations, built-in tools are empty, permission prompts and session persistence are disabled. Fifteen subprocess tests cover authentication refusal, environment filtering, invalid results, default model, timeouts, output bounds, and cleanup.
- **Codex CLI 0.153.4 / GPT-5.6 Luna:** the current native ChatGPT login and advertised model were detected. The final implemented client returned the expected JSON in a live request (4.7 seconds). This exact client/model combination is intentionally gated: older models can retain tools even when shell tools are disabled. Fourteen unit tests cover the native protocol and process boundary. The opt-in native contract test passed with inference redirected to an unauthenticated loopback fixture: the native request contained zero tools, configured hooks/MCP did not run, and a dummy API login in a separate temporary home was rejected without changing its auth file. Run with `SOTTO_NATIVE_CODEX_CONTRACT=1` only on a compatible installed client.
- **Grok Build 1.0.5:** installation is detected without starting it; readiness is false, no models are offered, and inference is refused. See the separate provider investigation for the concrete integration gap. This route was not used for inference.

Codex retains the user's global AGENTS instructions. Its native authentication is inspected immediately before inference; Sotto does not own an atomic lock across native auth changes made in another application between those processes. A logout-enforcing configuration flag was deliberately removed to preserve existing native accounts. Subscription usage follows each provider's current allowance and any extra usage already enabled by the user.

## Integrated verification

`npm run typecheck`, `npm run lint`, and `npm run build` passed. The six focused controller/renderer/provider suites passed **99 tests**. All five agent Electron suites passed **18 tests**, including the new subscription selector/account-check/save workflow, missing and unavailable connections, account/model persistence, question drafts, supervision bounds, permission handling, manual takeover, recovery, and synthetic voice routing.

The original missing-choice renderer regression failed before implementation. An initial new Electron test used an overly strict wrapping-label locator and timed out before selecting a provider; correcting the locator made the actual subscription flow pass. Review also caught and corrected unrelated settings being blocked by an expired subscription, native discovery blocking application startup, native auth mutation during status checking, process teardown races, and simultaneous subscription decisions being rejected instead of queued.

## Normal-profile desktop checks

Using Computer Use in the normal Sotto profile, selected **Claude subscription · Claude Code**, observed the native connection confirmation and default Sonnet model without any API-key field, saved it, and verified the missing-reasoning notice disappeared. Sent one harmless prompt to the already assigned **Sotto QA Alpha** thread, requesting only `SOTTO_SUBSCRIPTION_QA_OK` and no tools or edits. The T3 agent returned that string. Sotto then evaluated the completion through Claude and queued its own summary: “QA smoke test completed successfully — assistant replied with the exact required string SOTTO_SUBSCRIPTION_QA_OK as instructed.” The prompt cleared and no dispatch remained pending. Other user projects/threads were not assigned or prompted.

This checks live subscription supervision and native UI configuration. It is not a claim that microphone audio was exercised in this correction. A developer-console attempt to inject a transcribed command was blocked by Electron's paste protection and was abandoned without bypassing it; no command ran from that attempt. Natural command/controller routing has automated coverage, and native provider inference has separate live coverage. Actual acoustic wake/transcription testing remains a user-device check.

Repeated the native connection/save workflow with **ChatGPT subscription · Codex** and the displayed default **GPT-5.6 Luna**. Sent one more harmless prompt to the same QA Alpha thread, asking only for `SOTTO_CHATGPT_REASONING_OK`. T3 returned it; Sotto's Codex-backed decision queued the thread as ready with that text. The saved provider is `codex`, the Sotto reasoning API credential is absent, the draft is empty, the follow-up count is zero, and there is no pending dispatch.

During the real restart test, previously queued completions were reviewed again because the processed-observation map was only in memory. Fixed recovery to recognize completed observations from durable attention items while retrying decisions that were still in flight at a crash. Five new controller tests cover ready/blocked/question restoration, explicit Resume, new messages/questions, and crash recovery. This prevents repeated subscription requests just for reopening Sotto.

Final rebuild and repeat of all 18 agent Electron checks passed. Launched the final normal-profile build with `electron .`, then used Computer Use to verify the connected Agents view and the restored **ChatGPT through Codex** connection. The attention queue is byte-for-byte equivalent to the pre-restart JSON snapshot, no draft or outbox entry remains, and stderr is empty. The build is left running with the subscription selector visible; ChatGPT/GPT-5.6 Luna is selected. Changes are local; no installer was published and no remote branch was pushed.
