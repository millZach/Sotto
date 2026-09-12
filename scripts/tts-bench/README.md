# Sotto hosted voice benchmark

The first screen compares Kokoro `af_heart`, Flux `flux-haley-en`, Fish S2.1 Pro
with the example voice `ca3007f96ae7499ab87d27ea3599956a` from Fish's official
quickstart, and **the currently saved direct Grok voice**. System speech and
transcription are excluded. No app settings are changed.

```powershell
node --test scripts/tts-bench/bench.test.mjs
node scripts/tts-bench/run.mjs --mode smoke --budget 0.01
node scripts/tts-bench/run.mjs --mode screen --runs 3 --budget 0.9
node scripts/tts-bench/run.mjs --mode audition --budget 0.05
```

The runner launches a hidden, isolated Electron process. It reads Sotto's saved
formatting/OpenRouter and Grok credentials through safeStorage. On Windows, a
copy of the encrypted Chromium Local State key file is required in that isolated
profile. Decrypted keys stay in the main process and are sent only to their
provider's HTTPS endpoint. `OPENROUTER_API_KEY` and `XAI_API_KEY` can explicitly
override those two slots. `SOTTO_TTS_PROFILE` selects a different source profile.
Do not put keys in command arguments, generated pages or results.

Requests run serially with rotated model order. The 24 synthetic fixtures cover
six acknowledgements, six status replies, four permission/command lines, four
two-sentence summaries, two name lists and two number/time lines. Three repetitions
mean 72 scored requests per model, plus one unscored warmup each. The initial
smoke probe is reported separately. Do not claim provider-side cold/warm control:
only process and connection-pool reuse is controlled here.

Before network work, the plan reserves the UTF-8 byte count times a conservative
listed price for every request, including failed ones. Kokoro reserves the higher
$4/M endpoint tariff; Fish and Grok reserve $15/M; the explicit Flux free route
reserves zero. A local budget blocks further requests beyond that reservation.
This is an estimated usage cap at the researched tariffs, not an account billing
limit or invoice. Recheck tariffs before future runs. There are no automatic
retries. Authentication/format/model failures disable that model for the run.

Each result directory in `artifacts/tts-bench/` contains a frozen manifest,
append-only trials, summary, raw provider bodies, PCM WAVs and chunk arrival
times. OpenRouter requests PCM and the runner requires a sample rate in the
response metadata. Grok uses the actual production `GrokSpeechService`, including
its WAV validation, with an instrumented fetch. The wrapper observes chunks
without delaying their delivery to the production consumer.

**Measurements:** request-to-first nonempty audio body chunk; arrival of the
chunk containing the first sample above -50 dBFS; complete body receipt; duration,
leading silence and audio integrity. First signal availability is retrospective
PCM inspection, not actual speaker onset. Body completion excludes renderer IPC,
base64 decoding and playback setup. No microphone, private dictation history or
unrelated personal text is sent.

The audition mode adds Kokoro Bella/Michael, Flux Jack/Priya and Fish's second
documented reference voice to three fixtures. Voice preferences must come from
listening, not latency. Human blind preference and pronunciation scores, acoustic
stop latency and macOS verification remain separate gates before a product default
decision. The benchmark does not install streaming playback in Sotto.

Current deliverables:

- [x] Saved synthetic fixture set and bounded provider harness.
- [x] Four-provider smoke run, including current Grok Altair.
- [x] Three-repeat latency screen: 288/288 scored requests succeeded, plus four warmups.
- [x] Blind listening page (24 comparisons) and 27 auditions across nine voices.
- [x] Zach's 24 exported blind preferences and pronunciation feedback recorded.

September 11 run: 323 total requests including smoke probes and auditions, all
successful. Conservative estimated usage $0.178801; no invoice reconciliation.
See [the result report](../../docs/perf/2026-09-11-tts-first-screen.md).

Build the listening artifacts and serve only the result directory locally:

```powershell
node scripts/tts-bench/report.mjs artifacts/tts-bench/2026-09-12T03-46-48-703Z-screen
node scripts/tts-bench/auditions.mjs artifacts/tts-bench/2026-09-12T03-46-48-703Z-screen artifacts/tts-bench/2026-09-12T03-54-30-357Z-audition
node scripts/tts-bench/serve.mjs artifacts/tts-bench/2026-09-12T03-46-48-703Z-screen 5187
node scripts/tts-bench/verify.mjs artifacts/tts-bench/2026-09-12T03-46-48-703Z-screen
```

`report.mjs` creates a new randomized listening set: generate it before collecting
listener scores. It also finalizes streaming WAV lengths in saved listening files,
retaining original checksums and raw responses. The local server binds loopback
only. The Electron verification uses an isolated profile and muted playback;
it checks all audio durations and interactions, not sound quality or speaker latency.

References: [OpenRouter speech API](https://openrouter.ai/docs/guides/overview/multimodal/tts),
[Fish voice examples](https://docs.fish.audio/developer-guide/getting-started/quickstart),
[research shortlist](../../docs/research/2026-09-11-openrouter-tts-shortlist.md).

## Production playback baseline

The Windows harness adds Supertonic F1 and measures direct Grok Altair and OpenRouter Kokoro Heart through the production synthesizers and buffered HTMLAudioElement player. It uses an isolated Electron profile, reads existing encrypted credentials and verified local model assets, and never changes application settings.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/tts-bench/loopback-build.ps1
node scripts/tts-bench/playback-build.mjs
node scripts/tts-bench/playback.mjs --smoke
node scripts/tts-bench/playback.mjs
node scripts/tts-bench/cancellation.mjs
```

The screen runs 24 fixtures three times per provider plus three separate cold-worker Supertonic trials. Each hosted call reserves a conservative charge before dispatch; the per-process limit is $0.50, without retries. Model residency is not controlled for hosted services. No heavy test/build jobs should run concurrently with timing measurements.

[Process-specific Windows loopback](loopback.md) observes output onset and the last signal after Stop on the QPC clock. Renderer clock offset is measured by twelve round-trip pings per trial, retaining the smallest uncertainty. Stop occurs 600 ms after the playing event. Eligible stops require active output near Stop, remaining non-silent source audio, nonnegative output tail, valid uninterrupted timestamps and at least 300 ms observed silence. Ineligible stops remain in raw results and are excluded from stop percentiles.

The cancellation harness separately stops pending synthesis and immediately replaces it, checks that cancelled requests never create a player, and verifies output silence.

Generate the additional three-voice blind listening page without overwriting the original four-voice preferences:

```powershell
node scripts/tts-bench/playback-report.mjs artifacts/tts-bench/RUN-playback
node scripts/tts-bench/serve.mjs artifacts/tts-bench/RUN-playback 5188
```
