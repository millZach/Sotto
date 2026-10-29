# OpenRouter's speech models on Sotto's clips, October 29, 2026

The ranking behind **Transcribe with OpenRouter** ([ADR-0160](../adr/0160-dictation-can-be-transcribed-by-an-openrouter-speech-model.md)): every model OpenRouter lists with a transcription output, measured from forge with `scripts/asr-bench/bench-openrouter-stt.mjs` through Zach's OpenRouter key. $1.10 in all.

## How it was measured

- **Clips.** Sotto's seven English fixtures (`scripts/asr-bench/fixtures/`, 2 to 17 seconds, 77 seconds in all), three runs each, and 24 clips in Spanish, French, German, Italian, Portuguese and Polish from Multilingual LibriSpeech (four per language, fetched with `fetch-multilingual.mjs`), once each.
- **Request.** As cloud dictation sends a segment: base64 WAV to `POST /api/v1/audio/transcriptions`, routed to a zero-retention host when OpenRouter lists one. One request at a time, so none competed with another; a warm-up request per model was charged and not scored.
- **Time to text** runs from before the request to the parsed text, retries included: what someone dictating waits for. Short clips are the two under five seconds.
- **Price** is what OpenRouter billed (`usage.cost` over `usage.seconds`), per hour of audio. Three models bill by tokens and report no seconds.
- **Ranking.** Words wrong plus one point for every second of median time to text (`SECONDS_WEIGH_AS_WER = 0.01`, Zach's pick of three weightings). The order changes little between weightings: speed decides whether slow, accurate models such as Fish Audio Transcribe 1 (2.5 s) rank high.

## Results, best first

| # | Model | Words wrong (English) | Names right | Median time to text | Short clips | Other languages | $ per hour | Zero retention |
|---|---|---|---|---|---|---|---|---|
| 1 | `qwen/qwen3-asr-1.7b` | 3.3% | 30/42 | 1.02 s | 0.78 s | 6.3% | 0.027 | yes |
| 2 | `x-ai/grok-stt-1.0` | 3.3% | 30/42 | 1.20 s | 0.64 s | 4.9% | 0.1 | no |
| 3 | `nvidia/nemotron-3.5-transcribe` | 3.8% | 24/42 | 1.17 s | 0.78 s | 3.6% | 0.12 | yes |
| 4 | `qwen/qwen3-asr-0.6b` | 4.4% | 27/42 | 0.88 s | 0.53 s | 11.0% | 0.012 | yes |
| 5 | `microsoft/mai-transcribe-2` (dictionary as phrase list) | 4.4% | 42/42 | 1.08 s | 0.59 s | 2.8% | 0.1 | yes |
| 6 | `fish-audio/transcribe-1` | 3.3% | 30/42 | 2.49 s | 1.46 s | 6.3% | 0.36 | yes |
| 7 | `deepgram/nova-3` | 4.9% | 24/42 | 0.95 s | 0.50 s | 99.6% | 0.258 | yes |
| 8 | `mistralai/voxtral-small-transcribe-3-0` | 5.5% | 30/42 | 1.54 s | 0.87 s | 4.1% | 0.24 | yes |
| 9 | `elevenlabs/scribe-v2` | 6.0% | 27/42 | 1.20 s | 0.89 s | 3.8% | 0.22 | yes |
| 10 | `google/chirp-3` | 5.4% | 30/42 | 1.76 s | 1.12 s | 3.8% | 0.96 | yes |
| 11 | `assemblyai/universal-3-6-pro` | 6.6% | 30/42 | 0.92 s | 0.49 s | 18.8% | 0.3 | yes |
| 12 | `assemblyai/universal-3-5-pro` | 6.6% | 30/42 | 0.94 s | 0.48 s | 19.2% | 0.3 | yes |
| 13 | `elevenlabs/scribe-v2-medical` | 6.6% | 30/42 | 1.00 s | 0.61 s | 3.4% | 0.22 | yes |
| 14 | `openai/whisper-large-v3-turbo` | 6.5% | 27/42 | 1.26 s | 0.85 s | 6.1% | 0.012 | yes |
| 15 | `openai/gpt-transcribe` | 6.5% | 27/42 | 1.35 s | 0.91 s | 3.5% | 0.27 | no |
| 16 | `openai/whisper-large-v3` | 7.1% | 27/42 | 1.07 s | 0.93 s | 5.3% | 0.036 | yes |
| 17 | `nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b` | 6.6% | 21/42 | 1.67 s | 1.08 s | 9.1% | 0.012 | yes |
| 18 | `mistralai/voxtral-mini-3b-2507` | 7.1% | 27/42 | 1.19 s | 0.69 s | 13.7% | 0.06 | yes |
| 19 | `openai/gpt-4o-mini-transcribe` | 6.9% | 30/42 | 1.38 s | 0.85 s | 4.0% | by tokens | no |
| 20 | `google/gemini-3.5-transcribe` | 6.6% | 30/42 | 1.80 s | 1.60 s | 3.9% | by tokens | no |
| 21 | `openai/gpt-4o-transcribe` | 7.5% | 30/42 | 1.51 s | 1.07 s | 4.0% | by tokens | no |
| 22 | `mistralai/voxtral-mini-transcribe` | 7.6% | 27/42 | 1.37 s | 0.73 s | 6.0% | 0.18 | listed, route refused |
| 23 | `nvidia/parakeet-tdt-0.6b-v3` | 8.2% | 27/42 | 0.99 s | 0.57 s | 7.5% | 0.09 | yes |
| 24 | `openai/whisper-1` | 7.1% | 30/42 | 2.24 s | 1.77 s | 6.0% | 0.36 | no |
| 25 | `microsoft/mai-transcribe-1.5` | 7.6% | 27/42 | 1.82 s | 1.46 s | 2.9% | 0.36 | yes |
| 26 | `mistralai/voxtral-small-24b-2507-stt` | 7.1% | 30/42 | 2.39 s | 0.99 s | 7.1% | 0.18 | yes |
| 27 | `mistralai/voxtral-mini-transcribe-3-0` | 8.2% | 30/42 | 1.56 s | 0.91 s | 3.1% | 0.21 | yes |
| 28 | `meta/muse-voice-transcribe-1.0` | 7.4% | 25/42 | 3.10 s | 1.55 s | 6.3% | 0.18 | no |
| 29 | `fish-audio/transcribe-1-pro` | 15.3% | 27/42 | 0.81 s | 0.54 s | 11.2% | 0.36 | yes |

Without its phrase list, `microsoft/mai-transcribe-2` got 8.2% of words wrong and 27/42 names right, in 1.00 s.

The raw runs, with every transcript and time, are `scripts/asr-bench/results/openrouter-stt-2026-10-29T19-54-25-869Z.json` (all models), `…19-56-34-874Z.json` (Voxtral Mini Transcribe 2 without zero-retention routing) and `…19-57-40-469Z.json` (MAI-Transcribe-2 with the clips' names as its phrase list).

## What else the run found

- **No model took `keyterms`.** OpenRouter answered every model's request with the field "The selected model does not support keyterms". MAI-Transcribe-2 took the names as Azure's phrase list (`provider.options.azure.phraseList`), and with it spelled all 42 names right, against 24 to 30 for every other model. Sotto now sends the dictionary only as MAI's phrase list, and offers `keyterms` only to a model it has not measured.
- **One zero-retention route is refused.** `mistralai/voxtral-mini-transcribe` is on OpenRouter's zero-retention list, but its transcription route answers 404 "No endpoints found matching your data policy" to every zero-retention request. Sotto lists it as having no zero-retention host and sends it without that routing.
- **A host can go silent.** An hour after the run, Qwen3-ASR 1.7B's one host (DeepInfra) answered none of ten requests within 20 seconds, with or without zero-retention routing, while OpenRouter reported it 100% up and DeepInfra's other models answered in about a second. So Zach chose MAI-Transcribe-2, not the top of the ranking, as the model dictation uses until one is picked.
- **Deepgram Nova-3 is English only:** 99.6% of words wrong on the other languages.
- **Artificial Analysis disagrees.** Its AA-WER v2 puts MAI-Transcribe-2 first and Qwen3-ASR unscored. Seven clean English clips are a small sample: one point here is a few words. The ranking says which models did well on dictation-length clips from this computer, not which is best everywhere.

## Not measured

Real microphones and rooms, accents, long recordings sent whole, and times from Windows or macOS.
