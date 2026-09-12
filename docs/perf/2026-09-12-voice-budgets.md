# Windows voice budget measurement - September 12, 2026

The fresh short-utterance screen reaches useful main-process feedback at **1,014 ms p50 (PASS)** and **2,412 ms p95 (FAIL)** when warm, against the 1,200/2,000 ms section 9 reference. These are production pipeline measurements from the last voiced PCM frame received by the renderer to the coordinator's useful state publication. They include endpoint silence, real MAI network transcription and command handling. They do not establish physical acoustic end to shipping-UI latency.

Fresh Electron retrieval passes: **13.92 ms warm p95**, with 10,000 synthetic memories and 1,000 measured queries. First-query/new-connection retrieval passes at **7.46 ms p95**; that is not disk-cold startup. Cold voice requests have only three samples: 1,634 ms p50 and 5,527 ms p95. Network variation is visible; this sample is too small for a stable population p95.

The separately dated production WASAPI playback evidence still shows Grok and Kokoro interruption passing the 100 ms reference across all valid observations. First audio misses the older 300 ms on-device reference. That comparison does not change the settled MAI transcription, Grok default and Kokoro economical provider choices. Fresh hosted cold spoken audio, physical hotkey/button latency, loaded-workload behavior and acoustic end-to-shipping-UI feedback remain **UNMEASURED**.

Re-run: `npm run perf:voice`. This executes actual MAI requests (15 short fixture uploads, bounded to at most 30 attempts including retries), isolated production voice turns and SQLite retrieval, then writes a timestamped report under `artifacts/voice-perf/`. It leaves the live application alone. See [the harness instructions](../../scripts/voice-perf/README.md) for boundaries, cost ceiling, credential isolation and network-free replay.

Evidence: [fresh voice samples](evidence/issue-18/capture.json), [redacted production turn records](evidence/issue-18/turns.jsonl), [fresh retrieval samples](evidence/issue-18/retrieval.json), [machine-readable budget report](evidence/issue-18/report.json), and [historical loopback samples](data/2026-09-11-tts-playback.json). The voice fixture hash and benchmark dates are retained. Source was baseline `6175989` with this ticket's instrumentation; no test-mocked clock or synthetic timing is counted as runtime evidence.

## Full measurement table

Generated 2026-09-12T16:10:17.343Z. Durations are milliseconds; percentiles use nearest rank. PASS/FAIL applies only to the stated measurement boundary and workload.

| Metric | Phase | n | p50 | p95 | Max | Target ms | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Acoustic end to shipping UI feedback | cold | 0 | unmeasured | unmeasured | unmeasured | p50 <= 1200; p95 <= 2000 | UNMEASURED |
| Detector frame to main useful state | cold | 3 | 1634.00 | 5527.00 | 5527.00 | timed separately | MEASURED |
| Detector frame to benchmark DOM feedback | cold | 3 | 1671.00 | 5551.00 | 5551.00 | timed separately | MEASURED |
| Memory retrieval | cold | 20 | 4.99 | 7.46 | 19.45 | p95 <= 100 | PASS |
| Physical hotkey/button to silence | cold | 0 | unmeasured | unmeasured | unmeasured | max <= 150 | UNMEASURED |
| Grok request to first loopback audio | cold | 0 | unmeasured | unmeasured | unmeasured | timed separately | UNMEASURED |
| Grok playback interrupt to loopback silence | cold | 0 | unmeasured | unmeasured | unmeasured | max <= 100 | UNMEASURED |
| Kokoro request to first loopback audio | cold | 0 | unmeasured | unmeasured | unmeasured | timed separately | UNMEASURED |
| Kokoro playback interrupt to loopback silence | cold | 0 | unmeasured | unmeasured | unmeasured | max <= 100 | UNMEASURED |
| Acoustic end to shipping UI feedback | warm | 0 | unmeasured | unmeasured | unmeasured | p50 <= 1200; p95 <= 2000 | UNMEASURED |
| Detector frame to main useful state | warm | 12 | 1014.00 | 2412.00 | 2412.00 | p50 <= 1200; p95 <= 2000 | FAIL |
| Detector frame to benchmark DOM feedback | warm | 12 | 2785.00 | 3441.00 | 3441.00 | p50 <= 1200; p95 <= 2000 | FAIL |
| Memory retrieval | warm | 1000 | 4.25 | 13.92 | 21.06 | p95 <= 100 | PASS |
| Physical hotkey/button to silence | warm | 0 | unmeasured | unmeasured | unmeasured | max <= 150 | UNMEASURED |
| Grok request to first loopback audio | warm | 72 | 1044.28 | 1732.51 | 2963.47 | p95 <= 300 | FAIL |
| Grok playback interrupt to loopback silence | warm | 69 | 65.07 | 70.34 | 72.08 | max <= 100 | PASS |
| Kokoro request to first loopback audio | warm | 72 | 1093.87 | 1947.73 | 5579.59 | p95 <= 300 | FAIL |
| Kokoro playback interrupt to loopback silence | warm | 72 | 65.10 | 70.88 | 71.86 | max <= 100 | PASS |

Re-run from the repository root with `npm run perf:voice`. See `scripts/voice-perf/README.md` for prerequisites, isolation, cost bound and report-only replay.

## Boundaries and provenance

- generatedAt: 2026-09-12T16:10:17.343Z
- retrievalEnvironment: {"platform":"win32","release":"10.0.26200","arch":"x64","node":"v24.18.0","electron":"43.1.0","sqlite":"3.53.1","cpu":"Intel(R) Core(TM) Ultra 9 275HX"}
- captureGeneratedAt: 2026-09-12T16:05:45.568Z
- captureFixtureSha256: 6dfabcf5a2cdf8ec17cb2395fc7e15157e9d18f978f5c50c8b9084d9bf8218a1
- historicalPlaybackRun: 2026-09-12T04:49:09.120Z
- historicalPlaybackSha256: f28ebecfad14a43c4a57821abed409c5d7fe9cd1f1e518b814c40d406e9094c1
- transcription: microsoft/mai-transcribe-2 via OpenRouter; fixture dictionary empty
- speech: Grok default / Kokoro economical
- command: npm run perf:voice (15 at-most-5s uploads, each at most one retry; at most 150 billed audio seconds, about $0.005 at recorded MAI rate)

- Requires a physical input/output + shipping UI trial
- Fresh production capture/MAI/coordinator turn records; software reference
- Diagnostic only: hidden benchmark DOM, not shipping UI; frame throttling may apply
- Fresh first-query/new SQLite connection, OS cache not flushed
- No physical input-device timestamp; programmatic playback stop is separate
- Historical production playback/WASAPI; 300 ms is former on-device reference, not a new hosted release gate
- Historical production player stop; active-source/observed-silence validation
- Fresh 10,000-row synthetic store after 100 warmups

The fresh voice workload uses the checked-in synthetic tiny WAV played in real time into a WebAudio MediaStream, production microphone worklet/segmentation/resampling, MAI through OpenRouter, production draft composition and turn recording. Wake detection and provider are fixtures. No reasoning or delegation is invoked, so those stages remain unmeasured. Cold means the first request in each of three new Electron processes (n=3); warm is four later requests in each (n=12). This is a small screen, not a stable population p95. Capture is reopened per trial; remote model residency, disk caches and external load are uncontrolled.

Detector frame receipt excludes unknown hardware/input buffering. Main-state publication precedes renderer IPC and paint. The hidden benchmark DOM timing includes animation-frame scheduling and is diagnostic, not a shipping UI result. No stage sum or historical ASR inference time is substituted for acoustic end-to-end latency. Physical hotkey/button, loaded workload and hosted cold speech playback still require dedicated trials. Historical Grok/Kokoro playback uses the shipping native player and process-tree Windows loopback, not physical speaker acoustics. Provider choices follow MAI transcription, Grok default and Kokoro economical option; the obsolete on-device selection rule does not reverse that choice.

## Verification

The one-command measurement completed on Windows 11 build 26200, Intel Core Ultra 9 275HX, Electron 43.1.0. The three focused turn/capture/session test files passed 55 tests; the percentile/evidence-gate harness passed three tests. Node and renderer typechecks and focused ESLint passed. No full suite or packaged build was run in the ticket worktree; the parent integration owns those checks. The report records current failures rather than treating the measurement ticket as a latency optimization or a completed physical acceptance run.
