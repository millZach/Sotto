# Transcribing on this computer: Parakeet v3 against Whisper and Qwen3-ASR - October 10, 2026

The owner found MAI-Transcribe-2 slow and unreliable and wanted dictation transcribed on the computer again, in more
than English, without the memory they remembered Parakeet taking. This note measures three models that run on the
CPU through sherpa-onnx, and then the chosen one inside the running app. [ADR-0071](../adr/0071-dictation-transcribes-on-this-computer-with-parakeet.md)
records the choice it led to.

## Answer

NVIDIA's Parakeet TDT 0.6B v3, 8-bit, is the one to ship. It transcribes a 2-second clip in 0.13 s and a 17-second
one in about 0.6 s, holds 0.73 GB once loaded, and peaks near 1.1 GB on a dictation's segment. It covers 25 European
languages; in Spanish it was as accurate as anything measured. Whisper large-v3-turbo is more accurate in the other
five European languages tested, but takes 1.5 s for a 2-second clip and peaks at 2.3 GB. Qwen3-ASR 0.6B is the only
one that hears Japanese and Hindi, but it is four to seven times slower than Parakeet, worse than Parakeet in five of
the six European languages, and returned one word for a one-minute recording.

The 5.5 GB the owner remembered is NVIDIA's full-precision runtime on the Forge GPU box
([September 11](2026-09-11-stt-mai-vs-forge-parakeet-screen.md)), not this model.

Inside Sotto, a 17-second dictation came back as text 0.22 to 0.25 s after Stop, word for word, and main held
0.90 GB with the model loaded against 0.18 GB without it.

## What was measured, and how

`scripts/asr-bench/bench-parakeet.mjs` loads one model in one Node 24 process through `sherpa-onnx-node` 1.13.8 on
the CPU and reports load time, decode time per clip, peak working set, and error rates. The laptop is a Core Ultra 9
275HX on Windows 11. Each model is the 8-bit build sherpa-onnx publishes in its `asr-models` release:
`sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`, `sherpa-onnx-whisper-turbo` and
`sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25`. Four threads unless stated.

- English: the seven clips in `scripts/asr-bench/fixtures/`, scored for word error rate (WER) against their ground
  truth with `scripts/asr-bench/wer.mjs`, plus how many of the 14 names in `proper-nouns.json` came out spelled
  right.
- Other languages: eight test clips each, fetched by `scripts/asr-bench/fetch-multilingual.mjs`: Spanish, French,
  German, Italian, Portuguese and Polish from Multilingual LibriSpeech (CC-BY-4.0), Japanese and Hindi from Common
  Voice 17 (CC0). WER, or character error rate (CER) for Japanese. These are read audiobooks and read sentences,
  not dictation, and eight clips is a small sample: the numbers rank the models; they do not promise a rate.
- Long recordings: the English clips joined into 60 s and 180 s of audio, decoded whole, for memory.

The raw results, including every transcript, are in [`data/2026-10-10-local-speech-models/`](data/2026-10-10-local-speech-models/).

## Speed and memory

| Model | Load | 2 s clip | 4 s clip | 17 s clip | Loaded | Peak, dictation clips | Peak, 60 s whole | Peak, 180 s whole |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Parakeet v3** | 2.1 s | **0.13 s** | **0.18 s** | **0.57 s** | **0.73 GB** | **1.12 GB** | 1.53 GB | 3.03 GB |
| Parakeet v3, 2 threads | 2.0 s | 0.11 s | 0.20 s | 0.73 s | 0.73 GB | 1.12 GB | 1.53 GB | 3.03 GB |
| Whisper large-v3-turbo | 2.1 s | 1.52 s | 1.80 s | 4.11 s | 1.10 GB | 2.31 GB | 2.32 GB | 2.34 GB |
| Qwen3-ASR 0.6B | 3.6 s | 0.51 s | 0.87 s | 3.00 s | 1.07 GB | 2.68 GB | 3.81 GB | 6.25 GB |

"Peak, dictation clips" is after every English and other-language clip, none longer than about 20 s. Parakeet's
memory grows with one recording's length, which is why Sotto always cuts a dictation into segments of at most 15 s
(ADR-0071, decision 5). Whisper stays flat only because it hears the first 30 s and drops the rest: both long
recordings came back as the same 68 words. Qwen3-ASR returned one word for each.

Four threads were a fifth faster than two on the 17-second clip and no faster on the 2-second one. Sotto uses half
the cores, at most four, so a dictation does not take the whole machine.

## Accuracy

| Model | English WER | Names right | es | fr | de | it | pt | pl | ja (CER) | hi |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Parakeet v3** | 7.9% | 9 of 14 | **2.1%** | 16.0% | 14.3% | 13.9% | 7.8% | 5.2% | not covered | not covered |
| Whisper large-v3-turbo | 5.8% | 8 of 14 | **2.1%** | **3.8%** | **11.5%** | **8.7%** | **5.5%** | **4.3%** | 13.9% | 90.0% |
| Qwen3-ASR 0.6B | **4.2%** | 7 of 14 | 5.4% | 11.6% | 27.0% | 21.8% | 13.6% | 34.1% | **13.2%** | **31.9%** |

Parakeet does not cover Japanese or Hindi and produced Latin-script guesses for them (172% CER, 105% WER). On the
English proper-noun clip it mishears 24.0% of the words, the same rate as MAI-Transcribe-2 without dictionary
hints. The [October 9 cleanup benchmark](2026-10-09-cleanup-haiku-5-5.md) took MAI's 24.0% to none with Haiku 5.5;
cleanup was not rerun on Parakeet's output for this note.

## Feeding the dictionary to Parakeet

sherpa-onnx can bias Parakeet toward listed words with beam search and a hotword list. The list has to be split
into the model's own pieces, so `scripts/asr-bench/build-hotword-vocab.mjs` reproduces the splits from NVIDIA's
tokenizer. The 14 names went in as hotwords at three strengths:

| Hotword score | English WER | Names right | Proper-noun clip WER | Dictionary words invented in other languages | Decode time, all clips |
| ---: | ---: | ---: | ---: | ---: | ---: |
| none (greedy) | 7.9% | 9 of 14 | 24.0% | none | 39 s |
| 1.5 | 6.3% | 10 of 14 | 16.0% | none | 62 s |
| 2.0 | 6.0% | 11 of 14 | 16.0% | 4, in 3 of 64 clips | 63 s |
| 3.0 | 5.4% | 12 of 14 | 12.0% | 102, in 18 of 64 clips | 49 s |

At 2.0, "Otter", "Kubernetes" and "Descript" appeared in French and Japanese speech that never said them; at 3.0,
"Anthropic" and "Descript" turned up across French, German, Japanese and Hindi. The setting that invented nothing
fixed one more name of fourteen and made decoding slower by half. The dictionary stays with AI cleanup (ADR-0071,
decision 6).

## In the running app

The built app, not in its test mode, in an isolated profile, with the 17-second English clip as the microphone
through Chromium's fake capture device. Auto-paste was off and the clipboard was put back afterwards. The full run
is in the [verification note](../verification/2026-10-10-local-parakeet-transcription.md).

| | Measured |
| --- | ---: |
| Start to ready, model files present but not yet checked | 10.4 s |
| Start to ready, model already checked | 2.4 s |
| Stop to text, 17-second dictation | 0.22 s, 0.25 s |
| Main process, model not loaded | 177 MB |
| Main process, model loaded | 902 to 904 MB |
| Main process, after the dictation | 1,000 MB |

The first start reads and checks 670 MB before loading, so it takes longer once. Both dictations came back word for
word.

## What this does not cover

- Apple silicon and Linux. These numbers are one Windows laptop; the packaged check loads the module on each
  platform, and transcribing there is proved in the running app.
- A real microphone in a real room. The English clips are clean recordings.
- AI cleanup on Parakeet's output.
- A WebAssembly build of sherpa-onnx, which would avoid native code but runs on one thread unless Sotto adds a
  worker.
