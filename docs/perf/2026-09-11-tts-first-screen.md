# First hosted TTS screen: Kokoro, Flux, Fish and Grok

**The network-latency screen is complete.** Fish had the fastest typical first
audio chunk; Flux had the tightest first-chunk tail; Kokoro completed full replies
fastest at the median. These are measured speed findings, not listening-quality
rankings. The application still uses its saved Grok Altair voice.

Zach's listening feedback after the run: Heart was his favorite voice sound,
but Altair was substantially better at pronunciation. His preference is to keep
Grok Voice. Retain the existing Grok Altair selection; the faster first-chunk
results do not outweigh that pronunciation preference. This is one listener's
reported assessment, not a completed three-listener study.

His exported choices were matched to this run and saved locally as
`listener-zach.json`: 24 scored replies, 20 preferences for Kokoro Heart and four
for Grok Altair, with none marked as revealed when voted. These preference votes
do not separately score pronunciation; Zach's explicit follow-up identifies
Altair as the pronunciation winner and his preferred choice for the application.

Run September 11, 2026 Pacific (started September 12 at 03:46 UTC), on the user's
Windows machine in an isolated Electron 43 process. Four models received the same
24 synthetic replies three times each, with serial requests and rotated order.
All **288 scored requests succeeded**, plus four warmups. A separate four-call
smoke test and 27 voice auditions also succeeded: **323 total requests**, with
conservative estimated usage **$0.178801**. This is not an invoice reconciliation.
There were no automatic retries or changes to production voice settings.

| Model / voice | First audio data p50 | First audio data p95 | Complete response p50 | Complete response p95 |
| --- | ---: | ---: | ---: | ---: |
| Kokoro / Heart | 441 ms | 1,813 ms | **607 ms** | 1,942 ms |
| Flux / Haley | 310 ms | **506 ms** | 2,870 ms | 5,751 ms |
| Fish S2.1 Pro / reference voice 1 | **238 ms** | 1,171 ms | 1,231 ms | 2,545 ms |
| Direct Grok / saved Altair | 792 ms | 1,394 ms | 845 ms | **1,702 ms** |

First data measures the first nonempty audio body chunk at Electron main. It can
include silence or a WAV header. The first chunk containing a sample above
-50 dBFS had p50/p95 of 463/1,850 ms for Kokoro, 325/550 ms for Flux,
238/1,171 ms for Fish and 792/1,394 ms for Grok. None of these measurements is
actual speaker onset. Full-response timing excludes renderer IPC, base64 decode
and playback setup. Reused connections do not establish a warm provider model.

The OpenRouter arms requested PCM; the response sample rate was 24 kHz for Kokoro
and Flux, 44.1 kHz for Fish. Grok used the real production GrokSpeechService and its
24 kHz WAV request with `altair`. Fish used the first example reference voice in
its official quickstart, `ca3007f96ae7499ab87d27ea3599956a`. No pronunciation hints
or model-specific emotional instructions were added. The fixture text already
verbalizes some command punctuation, identically for every model.

Kokoro was not pinned to an upstream provider, and the observed response headers
do not identify the chosen upstream. Its result describes this OpenRouter route
run. Budget reservations used the higher $4/M tariff. Fish and Grok used $15/M;
Fish was counted in UTF-8 bytes, and byte counting conservatively overestimates
character-billed models. Flux used its explicit `:free` route.

## What this means for Sotto

Prioritize **Fish and Flux for a streaming playback comparison**. Fish is the
typical-start leader, while Flux showed fewer slow starts in this sample. Flux's
long full-response time would be a disadvantage in the current buffering player.
Kokoro is worth keeping in contention for its fast full-response median and cost,
although its slow-start tail needs attention.

The saved arrival curves imply ideal uninterrupted PCM start p50/p95 values of
441/1,813 ms for Kokoro, 310/506 ms for Flux, 246/1,171 ms for Fish and
792/1,431 ms for Grok. This is an offline lower bound calculated from the entire
arrival curve. It excludes scheduling, device and IPC overhead and does not
substitute for a real streaming playback test.

## Listening and verification

- [Open the blind listening comparison](http://127.0.0.1:5187/listening.html):
  24 replies, four anonymous clips each, independently shuffled labels, saved
  preferences, notes and JSON export.
- [Explore nine voice options](http://127.0.0.1:5187/auditions.html): Kokoro
  Heart/Bella/Michael, Flux Haley/Jack/Priya, two Fish reference voices, and Grok
  Altair across status, proper-name and number fixtures. These 27 auditions are
  excluded from the repeated latency statistics.
- [Saved result directory](../../artifacts/tts-bench/2026-09-12T03-46-48-703Z-screen/report.md)
  contains raw bodies, WAVs, hashes, chunk timings, response IDs, manifests and
  category statistics. Generated audio remains local and is excluded from Git.
- Five harness tests passed, including PCM interpretation and WAV-length repair.
  An independent critic identified Flux's streaming RIFF size placeholders; saved
  listening WAVs were finalized while retaining raw bytes and original hashes.
  No inference rerun was needed for that correction.
- All 292 main-run WAVs decoded in Electron with expected durations. Automated
  muted playback, single-active-audio behavior, preference persistence, navigation,
  reveal and native file export passed. Desktop, phone and intermediate layouts
  were captured and visually inspected. The listening page is open in Chrome.

**Product decision after listening:** Zach chose Grok Altair as the default for its pronunciation, with Kokoro Heart as the lower-cost option and preferred timbre. The exported blind choices contained 20 Kokoro and four Grok selections across 24 replies. Both providers are now integrated; Kokoro uses the existing OpenRouter key. This replaces the provisional candidate recommendation above.

**Playback follow-up complete:** [Windows output onset/stop and Supertonic baseline](2026-09-11-tts-playback.md) now contain 219 successful real-player trials and six successful cancellation/replacement checks. Physical speaker acoustics and macOS performance remain unverified. System voice is excluded from the benchmark.

Reproduction: [benchmark instructions](../../scripts/tts-bench/README.md).
Research: [OpenRouter shortlist](../research/2026-09-11-openrouter-tts-shortlist.md).
