# Ticket 19: remaining voice benchmark

Scope confirmed by Zach on September 11: transcription is complete; MAI is selected.
This investigation covers text-to-speech only. The older ticket and spec language
requiring Parakeet to remain standard is superseded by that decision and
[ADR-0006](../adr/0006-hosted-transcription-mai.md).

Latest scope correction: Zach excluded system voice from the benchmark. Retain
Supertonic and Grok as controls; screen the hosted candidates in the
[current OpenRouter shortlist](2026-09-11-openrouter-tts-shortlist.md).
This removes system speech from the test lineup, not the application's implementation.

## Current state

- [x] Read [ticket 19](https://github.com/millZach/Sotto/issues/19), its comment,
  [section 9.2](../superpowers/specs/2026-09-10-sotto-memory-first-prototype-spec.md#92-voice-model-testing),
  and the [candidate brief](2026-09-10-voice-model-candidates.md).
- [x] Inspect the three production synthesis paths and shared playback.
- [x] Identify the missing harness, fixtures, measurements, and listening results.
- [x] Implement and run the first hosted screen after Zach's authorization:
  [Kokoro, Flux, Fish versus saved Grok Altair](../perf/2026-09-11-tts-first-screen.md).
- [x] Record Zach's exported listening choices and explicit Grok Altair default/Kokoro Heart option decision.
- [x] Add the real-player Supertonic baseline, Windows process-output onset/stop capture, and cancellation/replacement checks; final results are in the [playback report](../perf/2026-09-11-tts-playback.md).
- Physical speaker acoustics and macOS parity remain unverified; they are not claimed by the Windows process-output measurement.

At the initial investigation there was no TTS harness or measured report.
The authorized first run now has [24 fixtures and a harness](../../scripts/tts-bench/README.md).
Existing Grok verification establishes working playback and cancellation.
See [Grok verification](../verification/grok-tts-qa.md).

## Benchmark the experience Sotto actually ships

Both retained production paths wait for a complete WAV before playback:

| Incumbent | Current path | Important measurement consequence |
| --- | --- | --- |
| Supertonic v1 | [Pinned model](../../src/main/agents/speechModelManifest.json); [renderer worker](../../src/renderer/src/agents/naturalSpeechWorker.ts), fp32 WASM, eight inference steps, speed 1.05, 44.1 kHz | Replies split at 240 characters are concatenated before delivery. Cancellation during inference terminates the worker; the next synthesis is cold. |
| Grok speech | [HTTP service](../../src/main/agents/grokSpeech.ts), fixed xAI endpoint, dedicated saved credential, complete WAV returned over IPC | API streaming availability does not imply streamed playback in Sotto. Preserve current saved voice as a separately identified voice configuration. |

The shared [player](../../src/renderer/src/agents/voiceSpeech.ts) decodes base64,
creates a Blob/Audio element, then plays it. `Audio.play()` completion or a
resolved `speak()` promise is not a measurement of first audible sample or actual
speaker silence. The [voice session](../../src/renderer/src/agents/voiceSession.ts)
also has a 450 ms echo guard, which is distinct from audio stop latency.

## Smallest useful implementation

1. Freeze 24 text fixtures: six short acknowledgements, six status lines, four
   permission asks with commands, four two-sentence summaries, two proper-noun
   runs, and two times/numbers. Freeze accepted pronunciations and critical
   digits, flags, and negations before listening.
2. Add an isolated Electron harness alongside `scripts/asr-bench/`, using the
   actual worker, hosted synthesis, IPC, and player. Never use E2E silent audio
   substitutes for model measurements. Keep production settings/profile intact.
3. Screen one pinned voice per incumbent, then expand promising voices. Record
   cold and warm results separately, raw WAVs, per-trial JSON, p50/p95, failures,
   hardware/runtime/model revisions, and hosted billed/estimated characters.
4. Measure request-to-WAV and request-to-playback separately. Calibrated output
   loopback can estimate output onset/cessation; label acoustic/device latency
   unverified unless actually captured. Trigger stops during active speech,
   plus cancellation before first audio and immediate replacement.
5. Produce anonymized, randomized listening pairs and a concealed mapping.
   Use three human listeners for preference and technical pronunciation scoring.
6. Repeat on Apple silicon before selecting an on-device default. Add verified
   challengers only after the incumbent baseline. Keep streaming optimizations
   as separate benchmark configurations so model and transport effects are clear.

The spec's local-default gates are warm first audio <=300 ms on both machines,
interrupt-to-silence <=100 ms, no worse technical pronunciation, and a blind
preference win or tie. The prior brief proposes enforcing latency at p95; label
that as the proposed operational rule rather than pretending the spec explicitly
specified that percentile.

The old concurrent local-ASR condition should become a representative current
Sotto workload: renderer activity, local wake detection, and MAI request/audio
handling. Do not revive the retired Parakeet benchmark to create that load.

## Decisions and boundaries for the run

Before hosted inference, compute the actual fixture character count and enforce
a hard spending limit including repetitions, warmups, and interruption trials.
Keep keys in the existing main-process vault or an explicitly supplied environment
variable, never results or renderer state. No paid requests, downloads, model
selection changes, GitHub updates, or releases occurred during this investigation.
Windows results alone and automated audio metrics cannot settle the Mac or human
listening gates.

Current candidate availability and priorities are in the
[OpenRouter shortlist](2026-09-11-openrouter-tts-shortlist.md) and
[direct-provider comparison](2026-09-11-fast-tts-direct-providers.md).
The earlier [source check](2026-09-11-voice-bench-source-check.md) preserves
historical findings; its system-voice baseline is superseded by this scope correction.
