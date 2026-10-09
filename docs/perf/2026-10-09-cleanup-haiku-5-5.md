# One cleanup model: Claude Haiku 5.5 against the quality tiers - October 9, 2026

AI cleanup had four quality tiers in a Settings picker. The owner wanted one model and no picker, and asked how
Claude Haiku 5.5 (on OpenRouter since October 7) does as that model. This note measures it against every tier's
model on speed, quality, word accuracy and cost. [ADR-0065](../adr/0065-one-model-does-ai-cleanup.md) records the
choice it led to: Haiku 5.5 at low effort, with Mercury 2 as the backup.

## Answer

Haiku 5.5 makes the fewest word errors of anything tested and is the only model that spelled every dictionary name
right. It grades in the top group for following the cleanup rules, and costs a seventh of what Haiku 4.5 did. It is
about one second slower than Mercury 2, the old default. At low effort it never thought on any of the 76 benchmarked
transcripts, so it answers as fast as with thinking off, and it never cut a transcript short the way thinking off
did once.

## What was measured, and how

`scripts/llm-bench/compare-cleanup.mjs` imports the shipped prompt from `src/main/llm/prompt.ts` (Node 24 strips the
types) and sends the request body `TranscriptPolishService` sends, through OpenRouter, on the owner's key. Requests
go one at a time with the models interleaved, so a slow minute on the link lands on every model alike. Each
configuration ran:

- the 11 cleanup fixtures in `scripts/llm-bench/fixtures/` five times each, graded 0-10 by Claude Opus 5.5 against
  the rules the prompt states, blind to which model wrote the output (184 distinct outputs, $1.88);
- Moonshine's raw output for the 7 clips in `scripts/asr-bench/fixtures/` three times each, scored for word error
  rate (WER) against the clips' ground truth with `scripts/asr-bench/wer.mjs`;
- MAI-Transcribe-2's raw output for the 3 clips the September transcription bench kept, with and without dictionary
  hints, three times each (`--asr-source`), because MAI is what transcribes today (ADR-0006).

Latency is wall clock from this Windows laptop, request to parsed reply. OpenRouter's own generation time, read back
from its `/generation` endpoint, is given alongside so the link can be told apart from the model.

## Results

76 requests per configuration. Times in seconds. "Long" is the 199-word fixture.

| Configuration | Grade /10 | Graded 9+ | WER | Median | 90th pct | Worst | Long median | OpenRouter median | $ per 1,000 | Errors | Rejected |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Haiku 5.5, low effort** | 8.15 | 55% | **3.2%** | 1.47 | 1.92 | 2.76 | 1.92 | 1.27 | 0.19 | 0 | 0 |
| Haiku 5.5, thinking off | 8.05 | 47% | **3.2%** | 1.41 | 1.90 | 2.72 | 2.06 | 1.26 | 0.19 | 0 | 1 |
| Haiku 5.5, default thinking | 8.27 | 56% | **3.2%** | 1.50 | 3.26 | 6.24 | 2.00 | 1.33 | 0.24 | 0 | 0 |
| Mercury 2 (old Low, the default) | 7.70 | 26% | 5.8% | 0.41 | 0.70 | 0.98 | 0.63 | 0.23 | 0.12 | 3 | 0 |
| Nova 2 Lite (old Medium) | 7.58 | 35% | 4.5% | 1.03 | 1.42 | 2.17 | 1.37 | 0.85 | 0.44 | 0 | 0 |
| GLM-5.3 Flash (old Value) | 8.31 | 45% | 4.6% | 1.59 | 6.61 | 15.25 | 2.90 | 1.32 | 0.14 | 0 | 0 |
| Haiku 4.5 (old High) | 7.73 | 35% | 4.4% | 1.28 | 1.83 | 5.79 | 1.76 | 1.11 | 1.40 | 0 | 0 |

"Rejected" counts outputs the app's own guard would throw away (`src/main/llm/cleanupOutput.ts`, which the harness
imports): thinking off read "no wait let me
back up" in the ramble fixture as a self-correction and dropped everything before it, more than half the words.
Mercury 2's three errors were "Provider returned error" from Inception, two of them seconds apart. The grade's
standard error is about 0.2, so Haiku 5.5 and GLM sit about two standard errors above Mercury 2, Nova 2 Lite and
Haiku 4.5; the three Haiku 5.5 settings are within noise of one another.

Reasoning tokens: low effort and thinking off spent none on any request. Default thinking thought on 18 of 76, up to
905 tokens, which is where its 90th percentile and worst case come from.

### Word accuracy

WER per Moonshine clip after cleanup. The raw transcript averages 6.0%.

| | technical | numbers | propernoun | homophone |
| --- | ---: | ---: | ---: | ---: |
| Moonshine raw | 2.4% | 16.7% | 19.2% | 3.6% |
| Haiku 5.5 (every setting) | 2.4% | 16.7% | **0.0%** | 3.6% |
| Mercury 2 | 2.4% | 19.4% | 15.4% | 3.6% |
| Nova 2 Lite | 2.4% | 16.7% | 9.0% | 3.6% |
| GLM-5.3 Flash | 0.0% | 23.1% | 4.0% | 4.8% |
| Haiku 4.5 | 2.4% | 16.7% | 7.9% | 3.6% |

The tiny, short and long clips are 0.0% for every model. The numbers column is mostly formatting, not hearing:
the reference spells numbers out and every model writes digits ([2026-07-28](2026-07-28-asr-model-benchmark.md)).

On today's transcription the result is the same. MAI-Transcribe-2 without dictionary hints mishears 24.0% of the
proper-noun clip; after cleanup that is 0.0% for Haiku 5.5 at low effort, 5.3% for Haiku 4.5, 20.0% for Nova 2 Lite
and 24.0% for Mercury 2, which fixed none of it. With hints, MAI gets all three clips right, and every model left
them right.

### What the grader marked down

- Every model scored about 6 on `08-list`. They all copy the prompt's own few-shot example, which turns list items
  into bare commands and drops "probably", against the prompt's rule to keep hedges. That is a prompt question for
  another change, not a difference between models.
- On `10-segment-joined` thinking scored 8.2 and the others 5.4. The fixture turns on "no wait, let me back up",
  and the grades show the grader itself unsure what it retracts.

## Limits

One machine, one afternoon, one network. Five runs per fixture find typical behaviour, not rare spikes; the deadline
floor stays at the 8 seconds the High tier had for that reason. The grader is an Anthropic model grading Anthropic
models; the word accuracy, which needs no grader, points the same way.

## Reproducing

```sh
node scripts/llm-bench/compare-cleanup.mjs --runs 5 --asr-runs 3
node scripts/llm-bench/compare-cleanup.mjs --runs 0 --no-judge --asr-source "stt-2026-09-11T23-03-38-458Z.json#mai"
node scripts/llm-bench/compare-cleanup.mjs --runs 0 --no-judge --asr-source "stt-2026-09-11T23-06-48-689Z.json#mai+hints"
```

Each needs `OPENROUTER_API_KEY` or `scripts/llm-bench/.openrouter-key`. Reports go to `scripts/llm-bench/results/`.
The runs this note cites are in `evidence/2026-10-09-cleanup-haiku-5-5/`, without OpenRouter's generation IDs.
