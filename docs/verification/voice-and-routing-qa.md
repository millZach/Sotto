# Voice and thread routing follow-up

User reports, September 9, 2026: spoken replies sound robotic; saying Soto often requires three attempts; asking to add a prompt and then naming a thread still produces an error.

Acceptance checks:

- [x] Offer and exercise a natural speech voice independently of the reasoning provider.
- [x] Reproduce and fix concrete wake/capture failures, including the first utterance and supported wake phrase.
- [x] Preserve the requested action and prompt across a thread clarification, resolve named threads, and display useful failures.
- [x] Repeat the reproduced scenarios and relevant neighboring tests.
- [x] Inspect the final desktop experience and report acoustic or account limitations accurately.

## Natural voice

The default is now local Supertonic speech, with five female and five male English voices. System speech remains selectable. The settings expose an explicit 263 MB download, model terms, voice selection and a preview that saves only speech settings. Speech can be previewed with agent control off or the microphone muted. Missing models produce an actionable setup error; there is no silent robotic fallback or cloud request.

The production model manager installed 20 files (263,304,827 bytes) from pinned `onnx-community/Supertonic-TTS-ONNX` revision `cff123c84b0655d9d647641f1b532c3cbb8f7faa`. Each file is size/hash verified; installation is atomic. The full OpenRAIL-M weights license is included in the UI and notices. No model weights are committed to the repository.

An isolated native Electron probe exercised the actual built renderer worker under the production CSP and model/runtime protocols. Female 1 generated 3.660 seconds of non-silent, unclipped 44.1 kHz mono audio in 3.808 seconds cold. Male 3 generated 3.258 seconds in 1.605 seconds with the worker warm. No HTTP(S) requests occurred during synthesis. The renderer's cancellation regressions cover pending status checks, active inference, stale results, timeout/retry and warm worker reuse.

The normal-profile desktop preview was invoked through Computer Use with Female 1 selected, and no speech error appeared. This confirms playback initiation and the working native inference path; it does not establish the user's subjective voice preference or physical speaker sound quality. Artifacts are retained locally in ignored `artifacts/natural-voice-qa/`, including `summary.json`, `F1.wav` and `M3.wav`.

The user did not answer the optional local-voice versus Grok speech preference, so the implemented default is local speech with no extra usage charges. Grok subscription **reasoning** is available independently. Grok speech itself was not added: its [official TTS API](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech) requires an API key, and [xAI documents separate API billing](https://docs.x.ai/developers/faq/accounts). No existing key was repurposed and no paid speech request was made.

## Wake and first command

Actual capture-to-detector replay initially missed 10 of 24 first attempts. Quiet raw audio also missed; restoring the exact captured waveform's amplitude made it detect. The final change lowers the capture gate only during wake monitoring and applies bounded detector-only gain. Prompt audio remains unchanged. More aggressive trial gains produced a false wake on quiet “Hey Soda” and were rejected.

The final replay passed 70/70 positive cases across voices, input levels and 16/48 kHz capture, while rejecting 280/280 negative cases. Six real Moonshine short-command checks still recognized “Send it” and “Next.” Separate regressions caught the old spoken “I'm listening” acknowledgment suppressing an immediate command while speech prepared. A 75 ms local cue now acknowledges wake without blocking capture. The [wake QA record](issue-9-wake.md) includes exact commands, evidence and distribution constraints.

**Physical microphone reliability, room noise and the user's accent remain unverified.** The supported phrase remains **“Hey Soto” / “Hey Sotto”**. Bare “Soto” is not supported; the optional question about which phrase the user actually says remains unanswered. Do not describe replay counts as measured real-world wake accuracy.

## Thread clarification

The controller regression reproduced a raw schema error when the reasoner resolved the original prompt plus a named thread as a `compose` action. It also rejected a prompt too early when no thread was selected. The internal decision schema now accepts a staged composition; unresolved prompts retain their original text through a bare thread name or “select/open” reply. The reasoner receives the active thread ID. Sending still requires explicit **Send it**, and an unassigned thread requires **Manage**.

The failing regression now passes, including neighboring wrong-thread, paused-thread, draft retention, empty prompt and invalid-output cases. A native ChatGPT / GPT-5.6 Luna / Low request against synthetic Workshop/Docs thread metadata asked for clarification, then staged the exact original prompt on Workshop in 8.723 seconds. It performed zero T3 actions. The user's original error text was not available, so this is a reproduced matching failure path, not a claim that the exact original error was captured.

## Final verification and desktop state

- Whole-repository typecheck, lint and production build passed.
- Twelve focused suites passed 178 tests. The separate detector-gain suite passed 2 tests. The four wake-related suites passed 25 tests (overlapping the preceding counts).
- All 19 agent Electron tests passed: 4 settings/layout/prompt tests plus 15 voice, setup, control and answer tests. One initial UI-label test failure was fixed with explicit voice-control labels; an asynchronous save test now waits for persisted state before reopening settings.
- The notices verifier passed all 45 components; the updated notice generator passed its syntax check.
- Computer Use inspected the final normal-profile desktop, ran voice preview, connected local T3 0.0.38, and confirmed the ready wake state without a voice error.
- A production-build restart retained Natural / Female 1, the user's ChatGPT / GPT-5.6 Luna / Low selection, the selected QA thread, all three assignments and all three queue items. T3 reconnected and wake monitoring became ready. There was no draft, pending request or outbox operation to interrupt.
- After verification, agent control was returned to its prior off state. The rebuilt app remains visible on Agents for the user to enable and test. No installer, release, purchase, push or deployment was performed.

An optional cleanup of the isolated probe's `electron-profile` directory was rejected by automatic approval review with the stated reason “blocked by policy.” It was retained as an ignored debug artifact. The rejection did not prevent implementation or verification.
