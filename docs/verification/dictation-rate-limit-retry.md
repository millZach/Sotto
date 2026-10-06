# Dictation rate-limit retry verification

October 5, 2026, on `fix/transcription-rate-limit-retry` from `main` at 7453a2e5. The decision is ADR-0053; the glossary term is **Kept recording**. The owner picked variant C, the pill is the button, from `docs/prototypes/dictation-retry-prototype.html`.

## What was failing

The owner's long dictations, 15 seconds and more, failed with an error too quick to read. `transcription-diagnostics.jsonl` on their machine held nine failures that day, all `reason: "rate-limited"`, `status: 429`, `attempts: 2`, each turned away within about 1.5 seconds. Requests of under five seconds of audio went through in the same windows; most failures were parts of 6 to 13 seconds. A 55-second dictation had worked that morning.

Watching the file while the owner dictated ruled out the length of the audio, segmenting and parts sent while still talking: an 8.1-second request and a 15.8-second dictation split in two both went through minutes after a 6-second part was turned away. The failures came in bursts, 9:54, 11:09 to 11:11, 14:00 to 14:12, 14:17, and cleared on their own. Signing in at openrouter.ai changed nothing: a 30-second dictation failed the same way afterwards.

## What OpenRouter answers

A throwaway Electron script read the key the way Sotto does, kept it in memory, and sent Sotto's exact request with a synthetic tone, never speech. It printed only statuses, rate-limit headers and the bodies of refusals; no key or audio was written anywhere.

- `GET /api/v1/key`: a paid key, `is_free_tier: false`, no spending limit and no rate limit of its own.
- Eight requests one at a time, 3 to 12 seconds, with and without the dictionary: all 200 in 0.5 to 1.3 seconds.
- Three 9-second requests at once, a few seconds later: all three `429` with `Retry-After: 1` and the body `{"error":{"message":"Provider returned 429","code":429,"metadata":{"retry_after_seconds":1,"retry_after_seconds_raw":1,"headers":{"Retry-After":"1"}}}}`, with no `X-RateLimit-*` headers.
- After a minute: two at once, two 300 ms apart, five back to back and three at once all went through. Forty more over ten minutes, two at a time every 30 seconds, all went through.

"Provider returned 429" is OpenRouter passing on a refusal from the provider, and `microsoft/mai-transcribe-2` has one provider, Azure. Microsoft documents Azure Speech answering 429 while it scales up even within quota. Sotto retried once after 300 ms, inside the second Azure asked for, and threw away the whole dictation when one part failed.

## What the change does, in the built app

`tests/e2e/dictation-retry.spec.ts` runs the built app with the `transcription-turned-away-once` scenario, whose first transcription is turned away as rate limited and whose next is accepted.

- After Stop, Dictate says what happened and that the recording is kept, with **Try again** and **Discard recording** (`artifacts/dictation-retry/dictate-kept.png`). The widget reads **Click to try again** with a **×** (`artifacts/dictation-retry/widget-kept.png`). Neither clears on a timer; `tests/unit/renderer/dictationController.test.ts` checks that a failure sets none.
- Pressing the widget's pill transcribes the kept recording, pastes it and saves it to history (`artifacts/dictation-retry/dictate-recovered.png`).
- At the 820×560 minimum, in the light appearance, Try again and Discard recording sit on one row without overflow (`artifacts/dictation-retry/dictate-kept-minimum-light.png`). **Discard recording** returns Dictate and the widget to idle with nothing saved.

The widget's own light and dark captures are the `kept` and `error` baselines in `artifacts/design/baseline/`, checked by `tests/e2e/visual-previews.spec.ts`.

## Not verified here

- A real Azure burst against the new retry. None came during the ten-minute watch, so the one-, two- and four-second backoff is covered by `tests/unit/main/openRouterTranscriptionService.test.ts` rather than seen live. The diagnostics file now records each request that went through after a rate limit, marked `recovered`, so the owner's next bad window will show whether the waits are long enough.
- macOS. The change is renderer and main-process code with no platform branch.
