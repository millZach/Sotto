# TTS production playback baseline

Issue #19's remaining Windows benchmark is complete under Zach's updated scope: MAI transcription was already completed, system speech was excluded, and Grok Altair was chosen as default with Kokoro Heart as the lower-cost option. This report adds the missing Supertonic baseline and real output onset/interruption measurements to the [hosted screen and listening decision](2026-09-11-tts-first-screen.md).

## Results

All 219 synthesis/playback trials succeeded: 24 frozen fixtures × three repetitions × three providers, plus three separate cold Supertonic worker trials. There were no capture timestamp errors or discontinuities. Timings include synthesis, network for hosted voices, IPC transport, WAV decoding, and Windows rendered output.

| Voice | Output onset p50 / p95 | Active stop to silence p50 / p95 | Eligible stops |
| --- | ---: | ---: | ---: |
| Grok Altair | 1,044 / 1,733 ms | 65.07 / 70.34 ms | 69 / 72 |
| Kokoro Heart | 1,094 / 1,948 ms | 65.10 / 70.88 ms | 72 / 72 |
| Supertonic F1 | 3,045 / 6,365 ms | 64.80 / 69.83 ms | 68 / 72 |

Supertonic's three cold-worker starts on the same status fixture were 3,405, 3,193 and 3,426 ms. These cold samples are excluded from the table. The warm table spans replies of different lengths, so its percentile distribution is not a paired cold-versus-warm comparison. Hosted services reuse the client process/connections; provider model residency is uncontrolled.

**Decision:** retain Grok Altair as default and Kokoro Heart as the cheaper explicit choice. Their typical output onset is similar in this run, while Grok has the lower p95 and Zach's preferred technical pronunciation. Supertonic is slower in Sotto's existing whole-WAV pipeline. These measurements do not assess a different streaming implementation or prove general superiority across workloads.

## Method and evidence

- Windows build 26200, Intel Core Ultra 9 275HX, Electron 43.1.0. The normal desktop/dev app remained running; no build or unit-test workloads ran concurrently with timing trials.
- An isolated Electron profile reads the existing encrypted credential vault and verified local assets. The real production Grok/Kokoro services, `NaturalSpeechSynthesizer`, and `NativeSystemSpeech` player run unchanged. Narrow benchmark IPC transports requests; production IPC routing/authorization is covered separately by unit/Electron tests.
- Supertonic uses pinned revision `cff123c84b0655d9d647641f1b532c3cbb8f7faa`, F1, fp32 WASM, eight inference steps, speed 1.05, and 44.1 kHz output. The verified model download is 263,304,827 bytes under OpenRAIL-M. Its existing splitting/concatenation behavior is retained.
- [Process-tree WASAPI loopback](../../scripts/tts-bench/loopback.md) captures only this Electron process and descendants. It does not open a microphone or capture unrelated applications. A sample at or above approximately −60 dBFS marks signal. Full generated WAVs and per-packet signal envelopes are retained locally; captured raw PCM is not retained.
- Output onset is request-to-first rendered signal. Stop is issued 600 ms after the media `playing` event. An eligible stop requires active rendered signal within 50 ms before Stop, non-silent source audio continuing beyond Stop, a nonnegative rendered tail, valid uninterrupted timestamps, and at least 300 ms of observed subsequent silence. Seven natural-pause/short-reply trials remain in the data but are excluded from stop percentiles. Minimum observed quiet tail among eligible stops was 326.67 ms.
- Renderer timestamps are mapped to Windows QPC with twelve round-trip pings per trial, choosing the lowest uncertainty. Maximum retained clock uncertainty was 0.912 ms. Native packet timestamps and Node `hrtime` share QPC. A separate synthetic tone probe confirmed the collector sees audio continuing after a stop request.
- Six additional real-service checks passed: cancellation before onset, and cancellation followed by immediate replacement, for all three providers. They verify no late player/output from the cancelled request, exactly one replacement player when requested, and observed silence afterward.

[Committed per-trial measurements and cancellation results](data/2026-09-11-tts-playback.json) preserve the audit data. Complete generated WAVs, packet envelopes, clock calibration, manifests and the exact built timing harness are local at `artifacts/tts-bench/2026-09-12T04-49-07-684Z-playback/`. Cancellation evidence is at `artifacts/tts-bench/2026-09-12T04-59-23-150Z-cancellation/`.

The new `listening.html` in the playback directory contains 24 randomized three-voice comparisons, including Supertonic. It does not overwrite the original four-voice listening set or Zach's exported 20 Kokoro / four Grok preferences. No new human preference or pronunciation scores are fabricated.

## Spend and limits

The repeated playback run conservatively reserved **$0.091029**; the six cancellation/replacement checks reserved **$0.006669**. A $0.50 per-process ceiling was enforced before hosted requests, with no retries. One completed playback smoke run reserved $0.001235; earlier failed calibration probes reached no billable hosted request. These estimates are not invoices. Grok uses the [published $15/M-character rate](https://docs.x.ai/developers/models); Kokoro reserves $4/M for provider variation despite its [advertised starting price of $0.62/M](https://openrouter.ai/hexgrad/kokoro-82m/providers). The prior hosted screen cost is reported separately. Keys stay in main-process memory and do not enter result files.

Windows process loopback measures rendered digital output, **not physical speaker/Bluetooth acoustics**. It does not include the separate 450 ms microphone echo guard. macOS performance and device-specific drain remain unverified; no cross-platform/local-default gate is claimed. The older system-voice and hosted-opt-in requirements were superseded by Zach's explicit scope and provider decisions.

Reproduce with the [benchmark instructions](../../scripts/tts-bench/README.md). No release installer is produced by this benchmark.
