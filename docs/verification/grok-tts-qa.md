# Grok TTS API integration

September 9, 2026. User requested a selectable Grok TTS API voice provider after reviewing xAI pricing. MAI-Transcribe research was cancelled; no transcription provider change is included.

Acceptance checks:

- [x] Separate speech provider and voice selection from subscription reasoning.
- [x] Save the xAI speech API key through the existing OS-encrypted vault; never return it in application state.
- [x] Load the available voice catalog and preserve explicit/custom voice IDs.
- [x] Preview and play replies through the existing speech/capture lifecycle, with cancellation and actionable failures.
- [x] Verify provider boundaries, persistence, desktop setup and neighboring voice behavior.
- [x] Leave the verified desktop build available; distinguish fixture testing from live xAI audio generation.

The API contract is documented in [xAI's TTS guide](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech): bearer-authenticated `POST /v1/tts` accepts text, voice ID, language and output format; `GET /v1/tts/voices` supplies the voice catalog. The [published price](https://docs.x.ai/developers/models/text-to-speech) is $15 per million input characters. [API billing is separate from the consumer Grok subscription](https://docs.x.ai/developers/faq/accounts).

## Implementation

Grok speech uses its own `grokSpeech` credential slot. The renderer receives only key presence. The main process chooses the saved provider, posts to the fixed xAI endpoint with redirects disabled, validates bounded WAV responses, and returns audio to the existing renderer playback lifecycle. Requests use automatic language selection and 24 kHz WAV. No subscription token, environment key or other saved API key is consulted. There is no automatic retry or provider fallback.

The settings load the returned voice catalog after an explicit key save or when opening Grok settings with a saved key. Every returned voice is offered, including custom entries if the API returns them. An explicit saved voice ID survives catalog changes or temporary discovery failures. Key Save/Replace/Remove actions are separate from connection saves. Preview saves only speech settings; opening settings and loading the catalog never synthesize speech. Stop speech is available while agent control is off.

HTTP authentication, permission, credit, rate-limit and service failures produce bounded messages without provider response bodies. Cancellation aborts active synthesis and permits a new preview. A review caught a pre-existing speech error persisting after successful retry: speech errors are now separate from microphone errors, so successful playback clears only output errors. Cancelling a preview does not pretend an earlier failure recovered.

## Verification

- Whole-repository typecheck, lint and production build passed.
- Eight focused unit/integration suites passed **249 tests**, including 35 Grok HTTP service cases. Tests exercise exact request shape, the dedicated key, full catalogs, missing/invalid keys, billing and server failures, bounded responses, redirects, timeout, cancellation, renderer routing, main-only IPC, OS-encrypted persistence and unrelated-setting preservation.
- **7 Electron tests passed** across agents, voice and setup. The new Grok journey saves a rejected fixture key, observes the failure, replaces it, loads the catalog, selects a custom voice, and previews successfully with agent control off. It checks that the old error clears, the key input is blank after save, stored files do not contain the plaintext fixture key, settings reopen with the selected voice, and removing the key disables preview.
- Electron tests replace xAI HTTP with a controlled response and use a short silent WAV for playback. The production service, vault, IPC, configured speech output, browser audio playback, and controller run. These are not live xAI inference tests.
- Computer Use inspected the rebuilt normal-profile app and its dark Grok settings, including the empty password field, cost disclosure, disabled preview before key setup, and Stop speech. The corresponding light-theme Electron screenshot was also inspected. Runtime stderr was empty.
- The running normal-profile build preserves the user's ChatGPT / GPT-5.6 Luna / Low reasoning selection and prior control-off state. Grok settings are left open for key entry. The existing Natural / Female 1 selection remains saved until the user saves/previews a configured Grok voice.

No live Grok speech API key was supplied, so no paid speech generation or subjective Grok audio-quality test was performed. Enter the key directly in Sotto, select **Save API key**, choose a voice, then **Use and preview voice** to complete live verification. No installer, purchase, push or release was performed.

## September 10 follow-up: live WAV response

The user supplied the dedicated xAI speech key and reported `Grok speech returned invalid WAV audio`. The original September 9 verification above used fixtures only; this follow-up exercised the live provider.

- [x] Reproduce the exact error using the saved speech key and Altair, without exposing credentials.
- [x] Replay the captured response locally and minimize it to a regression test before fixing the parser.
- [x] Finalize streaming WAV lengths while preserving samples and rejecting malformed audio.
- [x] Run relevant automated checks, rebuild, and retry the normal-profile desktop preview with Computer Use.
- [x] Preserve Grok / Altair, the saved key, enabled agent control, assignments, and ChatGPT / GPT-5.6 Luna / Low reasoning.

The live request returned HTTP 200, `audio/wav`, and 191,564 bytes, matching HTTP Content-Length. Its 24 kHz mono PCM16 header declared data length `0x7fffffff` and RIFF length `0x80000023`. Sotto recognized only the other streaming marker, `0xffffffff`, and mistook the large placeholder for a truncated data chunk. The actual payload contained 191,520 bytes of complete samples (3.99 seconds).

An offline Electron harness replayed this response through the production service and reproduced the exact error. A minimal test using the same header also failed before the fix. The parser now recognizes both streaming markers, requires a preceding format and nonempty frame-aligned samples, and writes the actual data and RIFF lengths before playback. Odd data lengths receive WAV padding. Ordinary finite oversized chunks remain errors. The captured response passes afterward, and its sample bytes are unchanged.

Verification of this fix:

- Typecheck, lint, and production build passed.
- Three focused suites passed **53 tests**: Grok service (42 cases), speech IPC, and configured renderer speech.
- The Grok Electron setup/recovery/preview test passed using an updated fixture with the live provider's streaming header. It exercises the real vault, service, IPC and audio playback lifecycle. Its earlier speech error clears only after successful output.
- An independent read-only review found no material issues.
- Computer Use observed the original error in the normal-profile app, then inspected the rebuilt app, opened settings, and ran **Use and preview voice** with the user's saved Grok / Altair selection. The completed preview displayed no speech error, and runtime stderr remained empty. The app is left open at those settings. This verifies the software playback path; no subjective listening-quality assessment is claimed.

The diagnostic generated one short synthetic phrase through xAI; the desktop preview also used the live API, and enabled control reconnected on restart. Offline replays and automated tests make no xAI requests. Debug-only synthetic audio and the replay harness remain in the ignored `artifacts/agent-control-smoke/` directory. No credential or authorization header was recorded. No installer, push, or release was performed.

Prevention: the original ideal, fully sized WAV fixture missed the provider's streaming header. The desktop fixture and dedicated regression cases now reproduce that boundary condition.
