# Dictation transcribes on this computer with Parakeet

## Status

Accepted October 10, 2026, by the owner's choice. Supersedes the transcription half of [ADR-0006](0006-hosted-transcription-mai.md); its key, migration and reset amendments still describe the OpenRouter key, which now serves AI cleanup only. Amends [ADR-0018](0018-terminals-run-on-node-pty.md) and [ADR-0063](0063-first-run-setup-covers-the-agents-and-ends-in-the-threads-tour.md).

Superseded in part October 19, 2026, by [ADR-0094](0094-dictation-runs-the-speech-model-the-user-chooses.md): the model no longer downloads on first run, and setup no longer starts the download. Nothing downloads until the user picks Parakeet v3, and on Apple silicon Macs the user can pick a Core ML Parakeet model already on this computer instead. Decisions 3 and 4 apply to Parakeet v3 once it is chosen, and decision 8's setup step is ADR-0094's; everything else here stands.

The owner found MAI-Transcribe-2 slow and unreliable, with rate-limited requests that ADR-0055's kept recording exists to survive, and wanted transcription back on the computer, so that a person can keep dictation fully private or turn on AI cleanup. The measurements behind every choice below are in [the October 10 benchmark](../perf/2026-10-10-local-speech-models.md). The owner chose each of these when asked: European languages are enough; MAI goes; the model downloads on first run from Sotto's own releases; Settings names it; it stays loaded; dictation says it is downloading rather than recording early; the dictionary is not fed to it; and the setup step is the prototype's variant A, with the key under the AI formatting switch in Settings → Cleanup.

## Context

ADR-0006 left on-device transcription because names went wrong: Parakeet on the Forge GPU box, even after cleanup, spelled only 56% of the proper-noun clip's names. MAI fixed that only because Azure took the dictionary as a phrase list. Since then the cleanup pass moved to Claude Haiku 5.5 (ADR-0069), which spells dictionary names from the transcript text alone: on MAI's unhinted output it took the proper-noun clip from 24% word errors to none.

On this laptop (Core Ultra 9 275HX, 4 threads, 8-bit weights through sherpa-onnx), NVIDIA's Parakeet TDT 0.6B v3 transcribes a 2-second clip in 0.13 s and a 17-second one in about 0.6 s, holds 0.73 GB once loaded and peaks near 1.1 GB on a dictation segment. It covers 25 European languages, works out which one is spoken, and punctuates. Whisper large-v3-turbo is more accurate in some of those languages but takes 1.5 s for a 2-second clip, pads to 30 s and peaks at 2.3 GB; Qwen3-ASR 0.6B covers Asian languages but is four to seven times slower, peaks at 2.7 GB and failed on long recordings. The 5.5 GB the owner remembered is NVIDIA's own full-precision runtime, not the 8-bit model.

## Decision

**1. Parakeet TDT 0.6B v3, 8-bit, transcribes every dictation segment on this computer.** Audio never leaves it. There is no hosted route and no fallback: MAI-Transcribe-2, its OpenRouter transcription request, the phrase list and the key check for transcription are removed. When transcription fails, the kept recording (ADR-0055) stays, and the error says what happened.

**2. sherpa-onnx runs it, as Sotto's third production dependency.** `sherpa-onnx-node` (Apache-2.0) and its prebuilt platform package load through a dynamic import in main, the way `node-pty` does (ADR-0018): kept outside the bundle and unpacked from the archive, named in the release inventory, its notices shipped. It decodes on the native thread pool (`createAsync`, `decodeAsync`), so main's event loop keeps running while a segment is transcribed. Sotto passes it 16 kHz samples decoded in JavaScript: sherpa's own WAV reader returns a buffer Electron's memory cage rejects. A WebAssembly build would avoid the native code, but it would be single-threaded or need a worker of Sotto's own, and it was not measured; the native build was.

**3. The model is downloaded once, from Sotto's releases, and checked.** Its four files (encoder, decoder, joiner, tokens; 670 MB) are release assets on `millZach/Sotto-releases`, under the tag `speech-model-parakeet-tdt-0.6b-v3-int8-1`, published as a pre-release that is never marked Latest: the updater reads only the release marked Latest (`allowPrerelease` is off), so it never sees this one. Sotto pins each file's size and SHA-256, downloads only from `github.com` and GitHub's release-asset hosts, which the README already names for update checks, resumes a dropped download where it stopped, and refuses a file whose size or checksum does not match. No new host is contacted. The model's licence (CC-BY-4.0) is credited in the notices and the README.

**4. It loads when Sotto starts and stays loaded.** Every dictation transcribes at once. Until the model is ready, Dictate, the shortcut and the widget say that it is not ready and record nothing, and Dictate and Settings → Transcription show how far its download has got. The widget says only that it is not ready and where to look: like every widget failure, its sentence is fixed copy, not a live count. If the engine will not start on files that passed their check, Sotto drops the check's record, so Try again hashes every file again and replaces any that went bad without changing size.

**5. Long dictations reach it in segments.** Memory grows with a single recording's length (1.5 GB for one minute, 3 GB for three), so a recording is always cut at pauses, at most every 15 seconds, the way streaming transcription already cut it; turning streaming off no longer sends one long recording.

**6. The dictionary is not fed to the model.** Biasing Parakeet toward listed words, at the strength that invented no words, fixed one more name of fourteen; stronger settings invented dictionary words in speech that never said them. Names are AI cleanup's job, and the dictionary keeps doing it there.

**7. The language setting goes.** Parakeet cannot be pinned to a language; it detects one of its 25 by itself. A settings file that still names a language loads and drops it.

**8. The OpenRouter key is for AI cleanup only.** First-run setup's key step becomes a speech model step that starts the download and lets setup continue while it runs. The key moves to Settings → Cleanup, under the AI formatting switch. Settings → Transcription names the model ("Parakeet v3, by NVIDIA") and shows whether it is ready, downloading or failed, with Try again.

## Considered options

- **Keep MAI, add local as a choice.** Two transcription routes, a setting to pick between them, and a hosted path whose slowness is why this change exists. The owner chose local only.
- **Whisper large-v3-turbo, or Parakeet plus Whisper for other languages.** Whisper covers 99 languages but is ten times slower on short dictations and twice the memory. European languages are enough.
- **Qwen3-ASR 0.6B.** Asian languages and hotwords, but slower, heavier, worse in five of six European languages, and it failed on long recordings.
- **Download from Hugging Face or from sherpa-onnx's own release.** Hugging Face adds a host; a third party's release can disappear. Sotto's own release is pinned and on a host already named.
- **Ship the model in the installer.** Works offline at first launch, but every installer and update grows by 670 MB.

## Consequences

Sotto is offline-first for dictation again. Audio never leaves the computer; AI cleanup, when on, sends the transcript text to OpenRouter. The README, the guide, onboarding, Settings, Help and the macOS microphone string say so.

Sotto costs about 0.73 GB of memory while it runs, and 670 MB of disk for the model. Names that sound like other words ("Zache" as "Zack") come out wrong with cleanup off.

Japanese, Chinese, Korean, Hindi and Arabic are not transcribed. Adding a language outside Parakeet's 25 is a new model and a new decision.

The release now carries a native module that must load in the installed app on Windows, macOS and Linux: the packaged-resources check loads it from the installed app, as it spawns a terminal for `node-pty`. The installer has no model, so that check proves the module loads, not that it transcribes; transcribing is proved in the running app. Every Electron upgrade reruns it. A new model version is new release assets under a new tag, new pinned sizes and checksums in `src/shared/speechModel.ts`, and a run of `scripts/asr-bench/bench-parakeet.mjs`.
