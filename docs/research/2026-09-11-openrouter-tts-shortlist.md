# Fast TTS and voice choices for Sotto

Checked September 11, 2026 (Pacific). This is research for ticket 19, not a
measured sound-quality ranking. MAI transcription is settled. System speech is
excluded from the benchmark per Zach's latest direction. No inference, paid
requests, model downloads, credential changes, or product voice changes occurred.

## Recommendation

Start with **Kokoro 82M, Deepgram Flux TTS, and Fish Audio S2.1 Pro through
OpenRouter**, retaining the current direct Grok voice and Supertonic as controls.
Screen two or three voices per challenger before repeating all 24 fixtures.
MiniMax Speech 2.8 Turbo is a useful second-round expressive candidate.

For a broader best-available comparison, add **Cartesia Sonic 3.6, ElevenLabs
Flash v2.5, and Inworld TTS-2 Flash** through their direct APIs. They are absent
from today's OpenRouter speech catalog and would require separate provider
credentials/access. Their speed claims use different measurement boundaries;
none is a verified Sotto winner. See the sourced
[direct-provider comparison](2026-09-11-fast-tts-direct-providers.md).

## What OpenRouter actually exposes

The dedicated [speech catalog](https://openrouter.ai/api/v1/models?output_modalities=speech)
returned 18 model variants, including free variants. The generic catalog's
`audio` output filter is not an adequate discovery method for this route.
The public response is saved in
[the catalog snapshot](../../artifacts/openrouter-speech-catalog-2026-09-11.json).
Public listing confirms discoverability, not this account's successful inference.

Use `POST /api/v1/audio/speech` with the existing OpenRouter bearer key, text in
`input`, a model-specific voice, and PCM or MP3 output. The response is raw audio
bytes. PCM is intended for streaming playback. Voice IDs and supported formats
vary by adapter; check the actual selected endpoint before running.
[TTS API documentation](https://openrouter.ai/docs/guides/overview/multimodal/tts)

| Candidate | Voice selection exposed on this route | Published price | Screening reason |
| --- | --- | --- | --- |
| [Kokoro 82M](https://openrouter.ai/hexgrad/kokoro-82m) | 54 preset IDs; 28 American/British English IDs in the catalog | $0.62/M characters via DeepInfra; $4/M via Together | Low cost and substantial English voice choice. Best-provider displayed p50 moved from 0.10 to 0.21 seconds during research; Together was 1.25–1.33 seconds. Provider selection matters. |
| [Deepgram Flux TTS](https://openrouter.ai/deepgram/flux-tts:free) | 36 English voices, multiple accents | Currently free, rate limited | Conversational candidate with useful voice variety; displayed p50 approximately 0.33 seconds. Preserve `:free` in model and endpoint lookup IDs. |
| [Fish Audio S2.1 Pro](https://openrouter.ai/fish-audio/s2.1-pro) | Dynamic reference voices rather than a fixed catalog array; cloning supported by listed endpoint | $15/M UTF-8 input bytes | Expressive quality challenger; displayed p50 approximately 0.19 seconds. Bytes and characters differ for non-ASCII text. |
| [Grok Voice TTS 1.0](https://openrouter.ai/x-ai/grok-voice-tts-1.0) | Five listed: Eve, Ara, Rex, Sal, Leo | $15/M characters | Displayed p50 approximately 0.05 seconds; useful route comparison, but current direct Altair voice is not listed here. |
| [MiniMax Speech 2.8 Turbo](https://openrouter.ai/minimax/speech-2.8-turbo) | 45 listed English voice IDs | $60/M characters | Second-round voice/style contender; displayed p50 approximately 0.36 seconds. |
| [MAI-Voice-2-Flash](https://openrouter.ai/microsoft/mai-voice-2-flash) | Four listed voices, only one English: Harper | $15/M characters | Lower priority for voice breadth; displayed p50 approximately 0.94 seconds. Choosing MAI transcription does not establish TTS superiority. |
| [Gemini 3.1 Flash TTS Preview](https://openrouter.ai/google/gemini-3.1-flash-tts-preview) | 30 voices, expressive controls and two-speaker support | $1/M input text tokens plus $20/M output audio tokens | Lower priority for short interactive replies: displayed p50 approximately 5.96 seconds at inspection. |

OpenRouter dashboard p50 values are changing aggregate service metrics, not
matched trials or audible first-sample timings on Zach's machine. They justify
screening priorities, not a definitive speed ranking. Never compare them directly
with vendor internal-inference or server-only p90/p99 claims.

Kokoro's top-level catalog price was $4/M while its model page and endpoint
metadata listed DeepInfra at $0.62/M and Together at $4/M. Budget for the actual
provider. Model pages advertise provider pinning, while speech documentation
explicitly describes provider-specific option passthrough; confirm routing
controls on this speech route before relying on a pinned tariff or latency.
Endpoint snapshots are saved beside the catalog for Kokoro, Fish, Flux, MAI Flash,
and Gemini. Their rolling latency fields can be null even when page dashboards
show latency data.

Fish's fixed `supported_voices` field is null, which means unspecified/dynamic,
not one voice or no voices. Its own API uses reference IDs from its voice library;
OpenRouter also documents reference-audio cloning. Voice choice must be validated
on the selected route before the timed run.
[Fish voice selection](https://docs.fish.audio/developer-guide/getting-started/quickstart),
[OpenRouter cloning](https://openrouter.ai/docs/guides/overview/multimodal/tts#voice-cloning)

The remaining catalog entries are Fish S1, S2 Pro and S2.1 Pro Free; Qwen Audio
3.0 TTS Flash and Plus; Deepgram Aura 2; MiniMax Speech 2.8 HD; MAI-Voice-2;
Orpheus 3B; Sesame CSM 1B; and Voxtral Mini TTS 2603. Aura 2 lists 90 voice IDs,
41 English. Voxtral's 30 IDs include emotional variants of four speakers, so
they should not be reported as 30 distinct voices. Free entries are suitable
for auditioning but do not establish a production latency or availability SLA.

## What the benchmark must resolve

Sotto currently buffers complete WAV responses before playback, including its
Grok path. Switching providers alone will not realize streamed first-audio
latency. Measure the current control behavior and a separate streamed PCM
configuration, with request-to-first-byte, first playable audio, audible onset,
and interruption-to-silence kept distinct. Do not attribute transport improvements
to the model itself.

OpenRouter's HTTP audio stream does not establish availability of a provider's
native WebSocket features. In particular, Flux's context-aware interruption
protocol needs a direct integration if the OpenRouter adapter does not expose it.
Immediate local playback cancellation is still required for every provider.

Use the [24-fixture plan](2026-09-11-voice-bench-readiness.md), prioritize technical
names, numbers and commands, and collect blind human preferences after the
latency screen. Freeze model/voice/format/provider settings and connection state.
Keep cold, warm and interrupted requests separate. No new API key is required
for the OpenRouter shortlist if the existing key has access and sufficient
credits; direct Cartesia, ElevenLabs and Inworld need their own credentials.

System voice has been removed from the active benchmark plan. Supertonic remains
a local control. There has been no removal of the application's system-speech
implementation or change to the saved voice selection in this research step.
