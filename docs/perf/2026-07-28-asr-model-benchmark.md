# Transcription model benchmark: can we beat Moonshine? (2026-07-28)

Moonshine is fast but mis-hears often enough to be annoying. This benchmarks
every OpenRouter model that accepts audio input against the four on-device
tiers Sotto ships, asking one question: **is anything meaningfully more
accurate than Moonshine without costing noticeable speed?**

Harness: `scripts/asr-bench/` (`bench-asr.mjs` hosted, `bench-local.mjs`
on-device, `bench-hybrid.mjs` ASR+polish, `wer.mjs` scoring). Local inference
reuses `scripts/perf-bench/bench-inference.mjs`, so it replicates the app's
worker stack (transformers.js web build, ORT WASM, q8 weights, 4 threads).

## Answer

**Nothing on OpenRouter is worth switching to, and the accuracy fix is already
in the app.** Three findings, in order of importance:

1. **Moonshine is already the best local tier — on both axes.** It is more
   accurate than whisper-base *and* whisper-small while being 2-5x faster.
   The "accurate" preset is slower and no better; the "fast" preset is worse
   at everything. There is no local upgrade to make.
2. **Hosted models cannot meet the latency bar on short utterances.** Even the
   fastest one takes 752 ms to reach its *first token*, and most take 1.2-3.2s,
   against Moonshine's 185-465 ms for a whole 2-4s clip — before any network
   cost. (On long clips they roughly tie; push-to-talk is what matters here.)
3. **Routing Moonshine through the polish pass Sotto already runs recovers
   most of the accuracy gap for free** — 6.0% -> 4.0% WER overall, and on the
   proper-noun clip 19.2% -> 7.7%, which *matches the best hosted model*.

## What "accuracy" means here

7 TTS clips (`scripts/asr-bench/fixtures/`, regenerate with
`gen-fixtures.ps1`), 76.6s of audio. Three are easy controls; four target the
failure modes Moonshine actually has: technical vocabulary, proper nouns,
numbers, and homophones.

WER is scored on normalized text (`wer.mjs`): case, punctuation, number
formatting, and compound splits are folded before scoring, identically for
every model. This matters because the hosted models are LLMs that reformat as
they transcribe — scoring raw strings would charge `$4,217` as three errors
against a reference that reads "four thousand two hundred and seventeen
dollars", which is a formatting choice, not a mishearing, and is the polish
stage's job anyway.

## On-device tiers (steady state, idle machine, 4 runs)

All four tiers in one run, same conditions (`--runs 4`, first run discarded):

| Tier | Model | Mean WER | 2.0s clip | 4.4s clip | 16.6s clip |
|---|---|---|---|---|---|
| **instant** | **moonshine-base** | **6.0%** | **185 ms** | **465 ms** | **1781 ms** |
| accurate | whisper-small | 6.7% | 6059 ms | 6340 ms | 9489 ms |
| balanced | whisper-base | 8.1% | 2177 ms | 2247 ms | 3359 ms |
| fast | whisper-tiny | 12.7% | 1181 ms | 1356 ms | 2048 ms |

Moonshine dominates: lowest WER *and* lowest latency, by 5-13x on short
utterances. Whisper's fixed 30s padding is why its 2s-clip time is barely
better than its 16s-clip time. A later idle re-run of Moonshine alone gave
174 / 480 / 1872 ms, confirming these are stable.

> These absolute times run ~2x higher than `2026-07-20-dictation-latency.md`
> (which reported ~80/220/870 ms for the same clips and model). Same harness,
> same fixtures — so treat the ranking as solid and the absolute numbers as
> machine-state dependent.

## Hosted models (OpenRouter)

20 models advertise audio input once `:batch` (async), `~` aliases, and
`openrouter/*` routers are removed. 18 benchmarked, 2 rejected:

| Model | Reason |
|---|---|
| `nvidia/nemotron-3-nano-omni-...:free` | advertises audio; the provider never receives it (replies asking for the file) |
| `mistralai/voxtral-small-24b-2507` | provider returned an error on every attempt |

Top of the ranking (full table in `scripts/asr-bench/results/asr-2026-07-29T05-21-57.md`).
`Server` is OpenRouter-reported provider time — the portable number. `Wall` is
what this machine measured end-to-end and is dominated by its own slow link
(see below), so it is *not* a property of the model.

| # | Model | Mean WER | Server | TTFT | $/1k clips |
|---|---|---|---|---|---|
| 1 | `xiaomi/mimo-v2.5` | 2.5% | 4572 ms | 2103 ms | $0.03 |
| 2 | `google/gemini-3.6-flash` | 4.3% | 4420 ms | 1820 ms | $1.91 |
| 3 | `google/gemini-3.1-pro-preview` | 4.3% | 9442 ms | 3183 ms | $6.38 |
| 5 | `google/gemini-3-flash-preview` | 4.7% | 3061 ms | 1483 ms | $0.39 |
| 6 | `openai/gpt-audio` | 5.3% | **1705 ms** | 752 ms | $3.96 |
| 8 | `google/gemini-3.1-flash-lite-preview` | 5.5% | 1810 ms | 845 ms | $0.20 |
| 18 | `thinkingmachines/inkling` | 19.3% | 6770 ms | 1330 ms | $0.37 |

Read the latency comparison carefully. Across this clip set — which is
long-biased, five of seven clips run 10-17s — the fastest hosted model
(`gpt-audio`, 1705 ms median provider time) is roughly level with Moonshine's
1562 ms median. Hosted models are not uniformly slower.

The gap appears where dictation actually lives. Moonshine scales with audio
length (185 ms for 2s, 465 ms for 4.4s), while a hosted model pays a mostly
fixed prefill+decode cost: even the best TTFT here is 752 ms, and most sit at
1.2-3.2s *before the first token*. So on a short utterance the hosted floor is
2-6x Moonshine's total time, and that is still excluding the round trip. For
long-form dictation the two converge — but push-to-talk is the use case, so
nothing here clears the "no noticeable speed loss" bar.

## Where the accuracy actually differs

Per-clip WER. The three control clips are 0.0% for every model and are omitted.

| | technical | numbers | propernoun | homophone |
|---|---|---|---|---|
| moonshine (today) | 2.4% | 16.7% | 19.2% | 3.6% |
| moonshine + polish (medium) | 2.4% | 16.7% | **7.7%** | 3.6% |
| moonshine + polish (high) | **0.0%** | 16.7% | 8.0% | 3.6% |
| `xiaomi/mimo-v2.5` | 2.4% | 0.0% | 11.5% | 3.6% |
| `google/gemini-3.6-flash` | 2.4% | 16.7% | 7.7% | 3.6% |

Two things this table makes obvious:

**The `numbers` gap is style, not hearing.** `mimo-v2.5` scores 0.0% because it
transcribes literally ("AB four seven dash nine zero two"), matching a
reference written in spoken form. Gemini and Moonshine both format to digits
("AB47-902") and get charged for it. Moonshine's only genuine error in that
clip is hearing "B" as "V". Do not read this column as a real accuracy gap.

**Proper nouns are the only real gap — and no ASR model closes it.** Every
model tested, hosted or local, transcribes "Zache" as "Zach" and "Wispr Flow"
as "Whisper Flow". Those are homophones; they are not recoverable from audio.
The words a Sotto user most wants right — their own name, the tools they use —
are exactly the words a better ASR model *cannot* fix. Only a dictionary can.

## The hybrid: Moonshine + the polish pass already in the app

Sotto already sends every transcript through an LLM polish pass with a user
dictionary (`src/main/llm/transcriptPolishService.ts`). Feeding Moonshine's raw
output through it, with a dictionary holding the project's vocabulary:

| Polish tier | Model | WER | Added latency |
|---|---|---|---|
| low | `inception/mercury-2` | 6.0% -> 5.4% | +2981 ms |
| medium | `amazon/nova-2-lite-v1` | 6.0% -> **4.3%** | +1875 ms |
| high | `anthropic/claude-haiku-4.5` | 6.0% -> **4.0%** | +3845 ms |

It fixes exactly what was predicted: "Sato" -> "Sotto", "Sovam Yat" -> "Sowmya",
"Kubernet's" -> "Kubernetes". On the proper-noun clip the medium tier reaches
7.7%, tying `gemini-3.6-flash` and beating `mimo-v2.5` (11.5%).

The added latency above is inflated by this machine's link and is **marginal
cost only if polish is currently off** — when `llmFormatting` is already on,
this accuracy is free, and it is bounded by `llmTimeoutMs` with a fallback to
the raw transcript.

## Measurement caveat: this machine's network

Every hosted wall-clock number here was collected on a badly degraded link, and
that shaped the methodology:

- Upload throughput: **4-12 KB/s**. A 190 KB body took 16-49s.
- TLS handshake alone: 1.9-5.5s. Not OpenRouter-specific — `google.com`
  measured 5.5-8.5s total in the same window.
- The first sweeps timed out on any clip above ~2s purely on upload.

Two fixes made the benchmark viable, both worth keeping:

1. **Serial requests.** A 6-way concurrent first pass reported a 31s median for
   a model that answers in ~2s, and timeout-rejected `gpt-audio-mini`, which
   works fine. Concurrency queues at the provider; it cannot be used to measure
   latency.
2. **MP3 instead of PCM.** The fixtures are uncompressed 16 kHz WAV. Encoding to
   32 kbps mono MP3 shrank payloads ~8x (525 KB -> 66 KB) with no meaningful
   transcript change, and turned blanket timeouts into 4-14s responses. *If
   Sotto ever sends audio to a cloud ASR, it must compress first.*

`serverMs` (from OpenRouter's `/generation` endpoint) is therefore the number
to trust for comparing models; wall-clock describes this link, not the models.

## Recommendation

1. **Keep Moonshine.** It is the fastest and the most accurate thing available
   on-device, and no hosted model is close enough on latency to justify the
   swap.
2. **Turn on the polish pass and populate the dictionary** with names, tools,
   and jargon. That is where the remaining accuracy lives: 6.0% -> 4.0%, and it
   fixes the proper-noun class that no ASR model can.
3. **Consider relabeling the presets.** "accurate" (whisper-small) is slower
   than "instant" and not more accurate on this set — the names invite users to
   pick the worse option.
4. If cloud ASR is ever revisited, `xiaomi/mimo-v2.5` is the one to watch:
   best WER measured, $0.03/1k clips (30x cheaper than the Gemini flash tier),
   and it honours "transcribe verbatim" rather than reformatting — which is
   what this pipeline wants, since polish does the formatting. Its 2103 ms TTFT
   still rules it out for push-to-talk.

## Reproducing

```sh
pwsh scripts/asr-bench/gen-fixtures.ps1          # regenerate audio + ground truth
node scripts/asr-bench/bench-local.mjs --runs 4  # on-device tiers
OPENROUTER_API_KEY=... node scripts/asr-bench/bench-asr.mjs --runs 1
OPENROUTER_API_KEY=... node scripts/asr-bench/bench-hybrid.mjs --runs 1
node scripts/asr-bench/rescore.mjs --all         # re-score saved runs after a metric change
```

`bench-asr.mjs` uploads `fixtures/speech-*.mp3` when present and falls back to
the WAVs otherwise. The MP3s are checked in because regenerating them needs an
encoder that is deliberately *not* a project dependency — they were produced
once with `lamejs` (32 kbps mono) from the WAVs that `gen-fixtures.ps1` emits.
If the clips change, either re-encode with any tool or delete the MP3s and let
the harness fall back to WAV (slower to upload, identical results).

Total OpenRouter spend for the full sweep: **$0.44**.
