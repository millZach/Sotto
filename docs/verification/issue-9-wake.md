# Local wake detector evidence — 2026-09-09

Wake audio is processed locally in an isolated worker. Sotto does not include or download wake model weights or the standard Sherpa runtime. A user must explicitly configure existing supported model/runtime folders; missing setup is shown before microphone capture starts. Development builds can use the pinned development runtime. This is an implementation with unresolved distribution prerequisites, not a release-ready wake experience.

## Evaluated approaches

| Local detector | Synthetic results | Decision |
|---|---|---|
| Bundled Moonshine ASR + exact text matching | David's “Hey Soto” became “Hey soda”; “Hey Sotto” became “Hey sado.” Zira produced “Hey sato.” | Rejected as a wake detector. No soda/sado text aliases added. |
| Optional Whisper tiny ASR + exact text matching | David's “Hey Soto” still became “Hey soda.” | Rejected as a wake detector. |
| Windows System.Speech constrained grammar | Initially recognized both voices; subsequent runs missed Zira. Soda/sofa negatives received high confidence, overlapping positive scores. | Rejected. Windows-only and not sufficiently discriminative. |
| Sherpa GigaSpeech BPE 3.3M, 2024 | Default parameters missed David and accepted one soda fixture. Correct BPE, fp32/int8 and threshold/boost checks did not resolve both problems. | Rejected for this phrase. Model archive has an Apache-2.0 statement. |
| Sherpa phonetic zh-en 3M, 2025 | Detected all five original positive WAVs and rejected soda, sofa, tomorrow, name-only speech, ordinary speech, synthetic noise, tone and silence. | Implemented for explicitly supplied local files; model redistribution license remains unconfirmed. |

Synthetic positives use Microsoft David/Zira System.Speech synthesis, 16 kHz mono PCM, without microphone capture. Five originals are David “Hey Sotto,” David “Hey Soto,” David “Hey Soto. Open Workshop,” Zira “Hey Sotto,” and Zira “Hey Sotto. Open Workshop.” These do not establish real microphone accuracy, room-noise rejection, accent coverage, or battery use.

The apparent “Hey Sato” hard negatives were byte-identical to “Hey Sotto” for both system voices. Their SHA-256 values are `b04a97a8aa01c628e330888e7ae8effb5f7278a7add031300976549e29e5ebef` (David) and `99e0b7875c63ceaf6c2255f3b3a02d609b67dd181394785de8f9443038bb810a` (Zira). They cannot establish a false-positive distinction between those spellings. The implemented phonetic sequences are `HH EY1 S OW1 T OW0` and `HH EY1 S AA1 T OW0`; soda's `D AH0` ending is not included.

The KWS runtime reports first/last token timestamps. The production adapter accepts a first token no later than 400 ms into the utterance (capture has at most 180 ms pre-roll plus model alignment delay). This rejected “Tell Hey Sotto to open the project” for both test voices. Only audio after the detected wake ending goes to local transcription. More diverse speech is needed to validate this timing threshold.

## Reproduce the production detector path

Run `npm ci`, `npm run build`, then:

```powershell
node scripts/probe-agent-wake.mjs --model-directory 'C:\path\to\your\local\model' --fixtures-directory 'C:\path\to\local\16khz-wavs'
```

The command uses the actual `AgentWakeService` and built worker, verifies model/runtime hashes and containment, prints each detection, and tests synthetic silence/noise/tone. It performs no downloads and opens no microphone. The model folder must contain the four original files named in `src/main/agents/wake.ts`; modified, misplaced, or missing files fail validation. No code is loaded from the model folder. The runtime is pinned as development-only `sherpa-onnx@1.13.7`. Every executable file is hash-verified before a separately supplied runtime can load.

The production-service probe prepared in 683 ms and detected the five positive WAVs in 25–28 ms on one observed run. Embedded phrases, soda/sofa/tomorrow, name-only speech, short commands, and the three synthetic non-speech signals did not activate. The identical Sato/Sotto WAVs described above both activated, as expected from identical input. This confirms the implementation boundary on those fixtures, not general microphone accuracy.

Both combined wake+command WAVs were trimmed at the production detector's 840 ms ending. The existing local Moonshine/WASM inference benchmark transcribed both remaining clips as “Open workshop” on two runs each (157–230 ms). Pure wake WAVs have no speech remaining after the selected ending; the session skips ASR when that remainder is effectively silent.

An earlier raw David “Send it” WAV returned empty from Moonshine. This was investigated through the actual `BrowserVoiceCapture` and `createTranscriptionRuntime`, using the installed local model/WASM, rather than accepting the raw-file result as an application defect. Real WAV samples were supplied to the capture worklet callback in 128-frame blocks with controlled microphone/context effects; no microphone was opened. The production 180 ms pre-roll and 650 ms end-silence rules emitted a 1.232-second clip from the original 1.41-second WAV. The unchanged production ASR then recognized “Send it” at 16 kHz and “Send it.” with simulated 48 kHz input followed by production resampling. Zira's “Send it” and David's “Next” also succeeded at both rates. Two complete independent runs agreed. Adding 250 ms of silence caused the David regression again, so no padding or action-word workaround was added.

The reproducible session experiment and output are retained under ignored `artifacts/agent-control-smoke/probe-short-commands.mjs` and `short-command-production-results.txt`. This checks actual capture segmentation and inference against synthetic speech, not physical microphones, acoustic device processing, accents, or general short-command reliability.

Session proof files are under ignored `artifacts/agent-control-smoke/`: `probe-wake.ps1`, `probe-sherpa.cjs`, and result JSONL files. Test WAVs were generated in a task-owned temporary folder, not committed or uploaded. Three existing local ASR bench speech fixtures were also checked. Standalone model inference took roughly 45–130 ms for short WAVs, and 250–400 ms for longer fixture speech on this Windows machine. Measurements are synthetic, single-machine observations.

## First-attempt wake diagnosis and regression, 2026-09-09

The reported repeated-wake problem has two reproduced software causes. In the first replay, the existing capture gate and detector missed 10 of 24 single-wake cases: three David/Zira wake WAVs, four input gains (1, 0.3, 0.1, 0.05), and simulated 16/48 kHz microphones. Six quiet cases never passed the capture gate. Four reached the detector but produced no keyword. Restoring the amplitude of the exact captured quiet David clip made it detect without changing timing or text, excluding the first-token timing limit as that case's cause.

Wake monitoring now uses RMS 0.006 instead of 0.012. The main process applies a single gain to the detector's copy, targeting peak 0.5 with a maximum gain of 12. It preserves silence and louder signals. The prompt audio is unchanged. Activated conversation capture returns to the original RMS 0.012: a trial that changed this threshold globally regressed David's 48 kHz “Send it” into “Send her.” Restoring the activated threshold restored all six David/Zira “Send it” and David “Next” results across both rates. No audio padding, action-word rewrite, model confidence reduction, or extra wake aliases were added.

Candidate detector peak targets of 0.3 and 0.6 each introduced one quiet “Hey Soda” false wake in the contrastive replay. Raising the keyword confidence threshold did not fix the false wake and lost true wakes. The final peak 0.5 passed the expanded matrix with production source and the same pinned local model/runtime:

- **70/70 first-wake detections:** five positive WAVs, seven gains (1, 0.7, 0.5, 0.3, 0.2, 0.1, 0.05), and 16/48 kHz simulated input. Combined wake/command fixtures may segment at their existing sentence pause; their first clip activates and later command clips do not independently activate.
- **280/280 negative cases rejected:** embedded wake phrases, name-only speech, soda/sofa/tomorrow, four short command fixtures, three ASR benchmark speech fixtures, deterministic noise, tone and silence, across the same gains/rates.
- **6/6 short command transcription checks:** the actual local Moonshine runtime recognizes captured David/Zira “Send it” and David “Next” at both rates.

The old wake acknowledgement called and awaited `session.speak`, which suppresses capture during speech preparation and playback. A cold speech model therefore discarded a separately spoken first command and delayed a combined wake/command. The real `AgentProvider` and `AgentVoiceSession` regression reproduced both failures with only external audio/model effects replaced. The callback now plays a 75 ms local tone, respecting the existing sound-cues setting, without awaiting playback, loading a speech model, or suppressing capture. Both first-command regressions pass. Generated spoken responses retain their existing echo suppression. Muting listening also permits an explicit voice preview while keeping the microphone released.

Reproduce capture plus native detection without rebuilding the application or opening a microphone:

```powershell
node scripts/probe-agent-wake-capture.mjs --model-directory 'C:\path\to\local\model' --fixtures-directory 'C:\path\to\David-Zira-wavs'
node scripts/probe-agent-wake-capture.mjs --model-directory 'C:\path\to\local\model' --fixtures-directory 'C:\path\to\David-Zira-wavs' --negative
```

The script compiles the current service/worker and capture module into an owned temporary folder, validates the existing model/runtime, supplies 128-frame microphone blocks, reports results, and exits nonzero on a miss or false wake. `--minimal` replays the original quiet David failure. Required fixture names are listed in the script; missing/empty/wrong-rate fixtures fail instead of silently passing. Session outputs remain under ignored `artifacts/agent-control-smoke/wake-positive-final.jsonl`, `wake-negative-final.jsonl`, and `wake-short-command-final.jsonl`. The four focused unit suites cover 25 checks, including unchanged prompt PCM, gain bounds, capture mode transitions, first-command retention, mute, dictation and generated-speech suppression.

These are deterministic synthetic-audio and application-session results, not physical microphone or room-acoustic measurements. The supported activation remains **“Hey Soto” / “Hey Sotto”**. Bare “Soto” is not an activation, pending explicit product direction; this change does not claim to fix that different phrase.

## Model provenance and unresolved licensing

The [official model documentation](https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html) documents the phonetic model and its custom keyword interface. The [official release archive](https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2) is 32,885,699 bytes, SHA-256 `68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6`. The deployed encoder, decoder, joiner and tokens total about 5.45 MB. No archive model LICENSE/NOTICE/README was present.

The publisher's [license clarification issue #3802](https://github.com/k2-fsa/sherpa-onnx/issues/3802) remains unanswered about this model. The maintainer redirects the [specific redistribution request #3852](https://github.com/k2-fsa/sherpa-onnx/issues/3852) to #3802. Sotto therefore does not claim that the runtime's Apache-2.0 license licenses these weights. No automatic installation or release bundling is implemented. A release that includes or distributes weights requires a confirmed model license or replacement licensed detector.

The Windows grammar prototype used local [SpeechRecognitionEngine WAV input](https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.speechrecognitionengine.setinputtowavestream). It disabled adaptation per engine instance, without changing system registry settings, microphones, or speech settings.

## Runtime distribution prerequisite

The upstream npm package declares Apache-2.0 at its package boundary. Inspecting its [Node WASM build](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.7/build-wasm-simd-nodejs.sh) and [core CMake configuration](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.7/CMakeLists.txt) showed TTS enabled, linking Piper and [espeak-ng](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.7/cmake/espeak-ng-for-piper.cmake). That pinned espeak fork includes a [GPL-3.0 COPYING file](https://github.com/csukuangfj/espeak-ng/blob/ed530aa113046142eb5115cf2fc9157854d0ffe1/COPYING). Sotto therefore excludes the standard runtime from packaged resources; this is not an Apache-only redistribution claim or a conclusion about whether separate-process distribution is permitted.

The official [dedicated KWS build](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.7/build-wasm-simd-kws.sh) disables TTS. No corresponding prebuilt artifact was found in the v1.13.7 release, and Emscripten/cmake were not available in this workstation or its existing Ubuntu environment. A reviewed KWS-only runtime build and complete dependency notices are the remaining distribution work. The pinned development package is excluded by the existing zod-only packaged module inventory and an explicit runtime exclusion check. Users can configure their own already-installed original runtime; Sotto verifies hashes before execution and does not install it.

## Still unverified

- Real microphone wake/false-trigger accuracy, accents, noise and input-device changes.
- macOS execution of the packaged WASM worker and native system voice.
- Release distribution of model weights; no license permission is inferred from local proof success.
- Reviewed KWS-only runtime build/distribution and its complete dependency notices.
- A one-step model setup experience; the current folder field is explicit development setup.
