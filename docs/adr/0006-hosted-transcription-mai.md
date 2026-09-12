# 6. One hosted transcription model: MAI-Transcribe-2 through OpenRouter

## Status

Accepted — 2026-09-11.

## Context

Sotto shipped with on-device transcription (Moonshine base as the bundled "Standard" preset, whisper-tiny as an optional "Multi-lingual" download) and an optional LAN server path that the founder pointed at NVIDIA Parakeet on the Forge GPU box, followed by the OpenRouter LLM cleanup pass. Both routes mis-heard the names and product terms that matter in a developer's dictation: on the proper-noun fixture, Parakeet plus cleanup reached 28% word error rate and spelled only 55.6% of the annotated names correctly; Moonshine was worse on speed and no better on names.

Ticket #19 benchmarked hosted alternatives through OpenRouter's transcription endpoint (`docs/perf/2026-09-11-stt-mai-vs-forge-parakeet-screen.md`). Microsoft MAI-Transcribe-2 with the user's dictionary passed as an Azure phrase list scored 0% word error rate and 100% exact names on the same clips, in about 350 ms for a two-second clip and 440 ms for a four-second one. Voxtral's context bias was not forwarded by OpenRouter; GPT Transcribe's prompt helped but could not be verified and cost nearly three times as much.

Constraints:

- Production dependencies stay exactly `['zod']`; the upload uses Node's `fetch` from the main process because the renderer content security policy allows no cross-origin `connect-src`.
- The Supertonic natural voice for agent replies runs on the same ONNX WASM runtime and custom asset protocols that the on-device transcriber used, so that infrastructure cannot go.
- The user already stores an OpenRouter key for the cleanup pass, encrypted in the operating system credential store.

## Decision

**MAI-Transcribe-2 through OpenRouter is the only transcription route.** Every dictation segment and every agent-voice utterance is encoded as 16 kHz mono PCM16 WAV, base64-encoded into OpenRouter's JSON `input_audio` request, and sent to `microsoft/mai-transcribe-2` from the main process with the user's OpenRouter key. There is no on-device or LAN fallback: a failed request is reported to the user with its reason (no key, rejected key, offline, or a provider error) and the recording is not silently transcribed elsewhere.

**The personal dictionary is sent as spelling hints.** The same dictionary that the cleanup prompt already uses is forwarded as `provider.options.azure.phraseList.phrases`. That forwarding is the reason the bench result was a clean sweep, so it is not optional.

**One key serves transcription and cleanup.** The existing `llmApiKey` setting and its `formatting` credential slot are kept as-is and re-documented as the OpenRouter key; no credential migration is needed. Settings presents MAI-Transcribe-2 as the single, non-selectable model and moves the key field next to it, with a "Verify key" check against OpenRouter's key endpoint.

**Removed:** the Moonshine and Whisper catalog, the bundled model resources and their locks, the model download, disclosure, install and remove flows, the transcription worker and runtime, the local/remote fallback transcriber, the LAN transcription server setting and its connection test, and the Parakeet container on Forge (stopped, auto-restart disabled). Old `settings.json` files that still carry `modelPreset`, `inferencePreference`, `remoteAsr` or `remoteAsrUrl` parse and drop those keys.

**Kept:** the ONNX WASM runtime and the `sotto-model` and `sotto-runtime` protocols for the natural voice, wake-word detection, streaming segmentation, the language setting (passed to OpenRouter when it is not automatic), whitespace formatting, and the cleanup pass.

## Consequences

- Sotto is no longer offline-first for dictation. Audio leaves the computer for every dictation, an OpenRouter key and network access are required, and OpenRouter and Microsoft see the audio and the dictionary words. Onboarding, Settings, Help, the README and the macOS microphone usage string say so plainly; the "100% on-device" claim is gone.
- Cost is the user's OpenRouter balance: about $0.09 per thousand three-second dictations at $0.10 per audio hour, plus the cleanup pass when it is on.
- Short dictations under five words are about 300 ms slower than Parakeet on the LAN was, because no cleanup ran there either. Dictations that trigger cleanup are faster than before, because MAI's raw text is punctuated and capitalized and the cleanup pass does less work.
- Agent voice commands share the hosted route. The earlier rule that agent voice must use the local worker no longer applies, because there is no local worker.
- OpenRouter's transcription endpoint has no streaming partials, so streaming transcription still means per-segment requests during a long dictation, not live text.
- If OpenRouter drops or re-prices the model, the bench harness in `scripts/asr-bench/bench-stt.mjs` is the tool for choosing the replacement; adding a second hosted model is a settings choice, not an architecture change.
