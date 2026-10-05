# A failed dictation is kept in memory until it is tried again or discarded

Accepted October 5, 2026.

## Context

Long dictations were being lost. Every failure in the user's `transcription-diagnostics.jsonl` that day was HTTP 429. A probe that sent Sotto's own request with synthetic audio showed why: Azure, the only provider behind `microsoft/mai-transcribe-2` on OpenRouter, turns requests away in bursts, answering `Provider returned 429` with `Retry-After: 1`. The bursts have nothing to do with the key's usage. The same requests, three at once, went through a few minutes later, and the key has no limit of its own.

Three things in Sotto turned a one-second burst into a lost dictation. It retried once after 300 ms, inside the burst. A long dictation goes up in parts, and one part turned away threw away every part, including the ones that had come back. The error then showed for the success-message duration, 500 ms on the user's machine, too short to read. Dictation audio was never kept, so there was nothing to send again.

The retry is fixed in the same change: a rate-limited request now waits at least as long as `Retry-After` asks and one, two and then four seconds, within its deadline. This record is about what happens when even that is not enough.

## Decision

- **A failed transcription keeps its recording in memory.** The parts that came back keep their text and let go of their audio. The others keep their audio. This is a **kept recording**.
- **Try again sends only the parts without text**, then finishes the dictation the normal way: cleanup, paste, history. Turned away again, the recording stays kept.
- **A kept recording is let go** when the user discards it, starts another dictation or closes Sotto. It is never written to disk and never sent anywhere without a press of Try again.
- **Every dictation error stays on screen until it is dismissed**, rather than for the success-message duration.
- **The widget's pill is the button** (prototype variant C, the user's pick from `docs/prototypes/dictation-retry-prototype.html`). For a kept recording the pill reads **Click to try again**, with the failure's title and sentence in its tooltip and the screen-reader alert. A **×** beside it discards. For an error that keeps nothing, clicking the pill or the × dismisses it.
- **The Dictate room offers Try again and Discard recording** for a kept recording, and **Dismiss** for other errors, so the whole path works from the keyboard.
- **Escape does not dismiss an error.** Sotto claims Escape across every app only while a session is active. Claiming it for an error that waits until dismissed would take the key from every other app for as long as the error stays.

## Consequences

- AGENTS.md's "dictation audio is never written to disk" still holds; the README and guide now say a failed dictation stays in memory until tried again or discarded.
- An error the user ignores stays on the widget. The widget shows its error pill instead of the resting sliver until then.
- A kept recording is as large as the dictation, up to the recording limit: five minutes of 16 kHz audio is about 19 MB of memory.
- The widget bridge gains `requestRetry`, and the dictation command a `retry` type the widget may send.
- The diagnostics file says whether the provider or OpenRouter set a rate limit, and records a request that went through after one. It keeps only that word and number, never the provider's answer.

## Considered

- **Retry harder and keep nothing.** It saves most dictations but still loses one when a burst outlasts the retries, with no way back.
- **Paste the parts that came back and say the rest was lost.** It delivers incomplete text that reads as complete in the target app.
- **Buttons in the pill, or a note above it** (prototype variants A and B). The user chose the pill itself as the button: the smallest change to the widget's footprint.
- **Bring your own Azure key, or another transcription model.** Either would move off the shared capacity behind the bursts. Each needs a second key or a new provider, so each is its own product decision if the diagnostics show the retries are not enough.
