# STT screen: MAI-Transcribe-2 on OpenRouter vs Forge Parakeet + cleanup (2026-09-11)

Ticket #19, transcription half. Question: does Microsoft MAI-Transcribe-2
through OpenRouter beat the live setup (Parakeet on the Forge LAN box, then
Sotto's medium-tier cleanup pass) on speed and accuracy, and where do Voxtral
Mini Transcribe 2 and GPT Transcribe land? Azure is out of scope; every cloud
request goes through `https://openrouter.ai/api/v1/audio/transcriptions`.

Harness: `scripts/asr-bench/bench-stt.mjs` (`--screen`: tiny, short and
propernoun fixtures, five measured runs each, two excluded warmups). Results:
`scripts/asr-bench/results/stt-2026-09-11T23-03-38-458Z.*` (all base
configurations), `stt-2026-09-11T23-06-48-689Z.*` (the three `+hints`
routes after the forwarding classifier fix) and
`stt-2026-09-11T23-08-50-837Z.*` (`+hints+cleanup`). Total screen spend
$0.083 against the $2 cap.

## Answer

**MAI with the dictionary passed as an Azure phrase list is the first
hosted route that beats the incumbent on names, and it does so completely:
every annotated name on the propernoun clip came back spelled as dictated,
including "Zache" and "Wispr Flow", which no other route got right.** It
costs about 300 ms on clips too short to trigger cleanup, and roughly ties
the incumbent on clips that do trigger it. Three findings:

1. **Vocabulary hints are the whole story, and only MAI's are verifiably
   forwarded.** Raw MAI is no better on names than raw Parakeet (both 55.6%
   exact names). With `provider.options.azure.phraseList.phrases`, MAI goes
   to 100% and 0% WER on every screen clip. Voxtral's `context_bias`
   produced a transcript identical to the raw route (not forwarded). GPT's
   `prompt` did change the output (77.8% names) but OpenRouter accepted an
   invalid-typed option silently, so forwarding is behavioral evidence only.
2. **Speed depends on whether cleanup runs.** Under five words the app skips
   cleanup, so the incumbent is Parakeet alone at ~47 ms; MAI is ~350 ms.
   At five words or more the incumbent spends ~1 s in the cleanup LLM, so
   Parakeet + cleanup lands at ~1.1 s p50 on the 4.4 s clip. MAI + hints
   without cleanup is ~440 ms there; MAI + hints + cleanup is ~1.3 s.
3. **The cleanup pass is doing accuracy work that phrase lists cannot
   replace, and vice versa.** Cleanup fixed "Sovamya" and "anthropic" for
   Parakeet but could not recover "a script" (Descript) or "Zack". The
   phrase list fixed all of those at the ASR stage. Whether MAI would replace
   Parakeet only, or Parakeet and cleanup both, is a product decision; the
   two shapes have very different latency.

## Accuracy (screen clips)

Mean WER is the macro mean over tiny, short and propernoun. Exact names are
the pooled share of the propernoun clip's nine annotated names that appear
verbatim in the normalized hypothesis, over five runs. Tiny and short were
0% WER for every route, so the differences below are all the propernoun clip.

| Configuration | Mean WER | Propernoun WER | Exact names | Hint status |
|---|---:|---:|---:|---|
| forge-parakeet (incumbent ASR) | 10.7% | 32.0% | 44.4% | n/a |
| forge-parakeet+cleanup (incumbent) | 9.3% | 28.0% | 55.6% | n/a |
| mai | 8.0% | 24.0% | 55.6% | none sent |
| **mai+hints** | **0.0%** | **0.0%** | **100%** | forwarding verified (invalid-type probe rejected upstream with HTTP 400) |
| mai+cleanup | 6.7% | 20.0% | 66.7% | none sent |
| **mai+hints+cleanup** | **0.0%** | **0.0%** | **100%** | forwarding verified |
| voxtral | 6.7% | 20.0% | 55.6% | none sent |
| voxtral+hints | 6.7% | 20.0% | 55.6% | not forwarded: transcript identical to raw on all five runs |
| voxtral+cleanup | 4.0% | 12.0% | 77.8% | none sent |
| gpt | 3.8% | 11.5% | 55.6% | none sent |
| gpt+hints | 2.7% | 8.0% | 77.8% | unverified: invalid probe accepted silently, output did change |
| gpt+cleanup | 3.4% | 10.2% | 66.7% | none sent |
| gpt+hints+cleanup | 2.7% | 8.0% | 77.8% | unverified |

Caveats that matter for reading the 100%:

- The propernoun fixture's nine names are exactly the names in the bench
  dictionary. This measures the ceiling of phrase-list biasing when the
  user's dictionary covers the vocabulary, not what happens on names the
  user never added. The technical clip (Sotto, Moonshine, ONNX, Electron,
  Whisper) is not in the screen.
- The fixture voice is TTS pronouncing "Zache" as "Zach". Raw routes
  writing "Zach" are penalized only by the exact-name rule; the phrase list
  overriding pronunciation is the behavior a dictionary user wants.
- Five repeats of one synthetic recording measure variability, not
  independent accuracy samples. The adoption gate's paired confidence
  interval needs the human recordings the MAI brief calls for.

## Latency

Milliseconds, p50/p95 of five measured runs (p95 is the maximum). Timing
covers upload through parsed transcript plus the cleanup leg; no Electron
encoding, IPC or paste time. Windows host to Forge over Tailscale; cloud over
the normal Internet route.

| Configuration | Tiny 2.0 s (4 words, cleanup skipped) | Short 4.4 s | Propernoun 9 s |
|---|---:|---:|---:|
| forge-parakeet | 48 / 249 | 81 / 132 | 176 / 207 |
| forge-parakeet+cleanup (incumbent) | 47 / 239 | 1135 / 1294 | 1241 / 1273 |
| mai | 298 / 345 | 402 / 440 | 671 / 977 |
| mai+hints | 353 / 1028 | 440 / 1171 | 983 / 2376 |
| mai+cleanup | 323 / 329 | 1214 / 2012 | 1991 / 2160 |
| mai+hints+cleanup | 322 / 780 | 1309 / 1647 | 1782 / 2560 |
| voxtral | 429 / 534 | 623 / 686 | 1312 / 1849 |
| voxtral+cleanup | 464 / 550 | 1582 / 3320 | 1883 / 2032 |
| gpt | 671 / 679 | 754 / 1531 | 2746 / 4168 |
| gpt+hints | 687 / 1137 | 936 / 1134 | 1219 / 1356 |
| gpt+cleanup | 718 / 908 | 1535 / 1732 | 1940 / 2304 |
| gpt+hints+cleanup | 546 / 843 | 1710 / 2561 | 1975 / 2382 |

Notes:

- The cleanup leg is 600 to 1050 ms on every route (Nova 2 Lite primary
  applied on all 40 short and propernoun runs; no fallback, no timeout). It
  dominates the incumbent's short-clip total; Parakeet itself is under 100 ms.
- The JSON `input_audio` form used for hinted requests carries the WAV as
  base64 and shows a wider p95 than multipart (MAI tiny 1028 vs 345). Five
  runs cannot separate encoding cost from OpenRouter jitter; the full run
  should settle it.
- MAI scales with clip length more than Parakeet does (propernoun 9 s:
  ~1 s vs ~180 ms).

## Cost

OpenRouter billed MAI at $0.10 per audio hour (usage.cost returned on every
response). Per 1,000 three-second dictations: MAI $0.088, Voxtral $0.117,
GPT Transcribe $0.237. The cleanup pass is ~$0.32 per 1,000 calls on the
short clip regardless of route, so it costs more than MAI's audio. Forge
Parakeet has no per-request charge.

## Adoption gate (MAI brief section 9.3, incumbent = Forge Parakeet + cleanup)

| Gate | mai+hints | mai+hints+cleanup |
|---|---|---|
| Proper-noun cut ≥25% relative and ≥3 points absolute vs best Parakeet | Pass on the screen (28% to 0% propernoun WER; 55.6% to 100% names). Paired CI not computable from one TTS recording. | Same |
| No mean-WER regression | Pass (9.3% to 0%) | Pass |
| 3 s clip p50/p95 not worse than the route replaced, identical polish | Cleanup-triggering clips: pass by ~700 ms p50, p95 within 130 ms. Sub-five-word clips: fail by ~300 ms (no cleanup to hide behind). | Cleanup-triggering clips: fail by ~170 ms p50, ~350 ms p95. Sub-five-word clips: fail by ~280 ms. |
| ≥99% successful requests | 60/60 MAI measured requests plus warmups and probes succeeded; too few to claim 99%. | Same |
| No hallucinated speech on silence | Not tested; there is no silence fixture yet. | Not tested |

Reading: MAI + phrase list clears the accuracy gates by a wide margin and is
only slower on the shortest clips, where the incumbent runs no LLM at all.
Per the brief, a winning result still warrants an experimental opt-in tier,
not a default change, until human-recording accuracy, 30-run p95, silence
behavior and the OpenRouter privacy position are settled.

## What the full run should decide

`node scripts/asr-bench/bench-stt.mjs --full --runs 30 --only forge-parakeet,forge-parakeet+cleanup,mai,mai+hints,mai+hints+cleanup,gpt+hints` covers all seven
fixtures (adds long 16.6 s, numbers, homophone and technical) at roughly
$0.90 of the $2 cap and about 30 minutes serial. It answers: does the phrase
list hold on the technical clip and on names not in the dictionary, does the
16.6 s clip stay under the incumbent, and are the JSON-form p95 spikes real.
A silence fixture and human coding-vocabulary recordings remain separate work
before any adoption decision.

## Setup

Forge `http://forge.tail5728ca.ts.net:5092`: `/health` `{"status":"ok"}`;
`/v1/models` lists `parakeet-tdt-0.6b` and `whisper-1` (Parakeet version not
reported by the server). OpenRouter models: `microsoft/mai-transcribe-2`
(Azure endpoint), `mistralai/voxtral-mini-transcribe` (mistral and
mistral/eu endpoints), `openai/gpt-transcribe`. Cleanup mirrors
`transcriptPolishService` medium tier: `amazon/nova-2-lite-v1` primary,
`google/gemini-3.1-flash-lite` fallback, deadline max(2500, 7000) + min(9000,
30 ms per word), skip under five words, bench dictionary of 14 terms in the
prompt. Hints use the same 14 terms. WAV 16 kHz mono PCM16 for every route.
Node v24.14.1 on Windows 11.
