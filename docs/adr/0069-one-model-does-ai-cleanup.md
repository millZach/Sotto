# One model does AI cleanup

## Status

Accepted October 9, 2026, by the owner's choice. The owner did not want people to think about which model cleans up
their dictation: AI formatting is a switch, and nothing in the app names a model. They asked for Claude Haiku 5.5 to
be measured as the likely model, then chose it at low effort with Mercury 2 as the backup after seeing the numbers
([2026-10-09 benchmark](../perf/2026-10-09-cleanup-haiku-5-5.md)). Asked whether the switch should be renamed "AI
cleanup", they kept "AI formatting".

Numbered 0069 before it merged: ADR-0065 went to Claude thread steering while this was in review, and open terminal
agent work holds 0066. The decision is unchanged.

## Context

The cleanup pass had four quality tiers behind a "Formatting quality" picker in Settings → Cleanup: Low (Mercury 2,
the default), Medium (Nova 2 Lite), Value (GLM-5.3 Flash) and High (Claude Haiku 4.5), each with its own backup. The
picker asked people to trade speed against quality without saying what either meant for their text, and named models
most of them had never heard of. Haiku 5.5 reached OpenRouter on October 7 at $0.10 per million input tokens and
$0.50 per million output, a tenth of Haiku 4.5.

## Decision

**1. Claude Haiku 5.5, at low effort, cleans up every transcript.** It made the fewest word errors of every model
measured and spelled every dictionary name right, including the names MAI-Transcribe-2 mishears without hints, where
Mercury 2 fixed none. It grades with the best for following the cleanup rules, and costs about $0.19 per thousand
cleanups. Haiku 5.5 thinks by default; at low effort it skipped thinking on every benchmarked transcript, so it
answers as fast as with thinking off (1.47 s median, 2.76 s worst) and, unlike thinking off, never cut a transcript
short.

**2. Mercury 2 is the backup.** It answers in about 0.4 s, so it still fits inside the deadline after Haiku fails or
runs long. Nova 2 Lite and Gemini 3.1 Flash Lite are no longer used for cleanup.

**3. The deadline floor is 8 seconds,** as the High tier's was, plus the per-word allowance the tiers already had.
The benchmark's worst Haiku 5.5 answer was 2.76 s; the floor covers the spikes five runs cannot show.

**4. An answer the model did not finish counts as a failed attempt.** A reply cut off at the token limit, or declined
by the provider's content filter, goes to the backup instead of into the user's text. Haiku 5.5 runs safety
classifiers Haiku 4.5 did not, and its tokenizer spends about 30 percent more tokens on the same text.

**5. Settings shows only the switch.** The Formatting quality picker and the `llmQuality` setting are gone. A settings
file that still carries the key loads and drops it, so whoever picked a tier gets the one model.

**6. The app does not name the model; the README does.** Settings stays free of model names. The README's Privacy and
cost section and the guide say where the text goes, as they already do for MAI-Transcribe-2.

## Consequences

Cleanup takes about one second longer than Mercury 2 did as the default. Someone who chose High gets about the same
speed with fewer errors at a seventh of the cost. Per cleanup it costs about half again what Mercury 2 did.

Changing the cleanup model is now a change to `CLEANUP_MODELS` in `src/main/llm/transcriptPolishService.ts`, a run of
`scripts/llm-bench/compare-cleanup.mjs`, and an amendment here, not a new option in Settings.

Thread titles, branch names, and commit and pull request drafts are untouched: they are side calls to the thread's own
provider ([ADR-0026](0026-short-writing-runs-on-the-threads-own-provider.md)).
