# Windows voice budget measurement - September 12, 2026

The fresh short-utterance screen reaches useful main-process feedback at **1,014 ms p50 (PASS)** and **2,412 ms p95 (FAIL)** when warm, against the 1,200/2,000 ms section 9 reference. These are production pipeline measurements from the last voiced PCM frame received by the renderer to the coordinator's useful state publication. They include endpoint silence, real MAI network transcription and command handling. They do not establish physical acoustic end to shipping-UI latency.

Fresh Electron retrieval passes: **13.92 ms warm p95**, with 10,000 synthetic memories and 1,000 measured queries. First-query/new-connection retrieval passes at **7.46 ms p95**; that is not disk-cold startup. Cold voice requests have only three samples: 1,634 ms p50 and 5,527 ms p95. Network variation is visible; this sample is too small for a stable population p95.

A fresh 24-trial speech screen now measures both providers through the production synthesis, voice session and player, plus Windows process loopback. **Input-to-silence passes in every trial**, with cold/warm p95 respectively **73.43/73.39 ms for Grok** and **69.64/72.57 ms for Kokoro**, below 150 ms. The click-handler-to-silence metric also passes the 100 ms interruption reference. Input is injected through Electron onto a trusted benchmark button click; physical input-switch delay is excluded.

First spoken audio is measured cold and warm: Grok p50/p95 **1,154.01/1,209.40 ms cold** and **820.52/870.83 ms warm**; Kokoro **1,770.34/2,163.46 ms cold** and **972.01/2,804.05 ms warm**. Both miss the older 300 ms on-device reference. Each provider has three fresh-process cold samples and nine warm samples; this is a small screen with a visible Kokoro network outlier, not a stable population p95. All 24 trials had valid timestamps, no discontinuities, an actively speaking source and at least 300 ms observed output silence after stopping. The settled MAI/Grok/Kokoro choices are unchanged. Acoustic end-to-shipping-UI feedback, physical input-switch/speaker delay and loaded-workload behavior remain separate unmeasured boundaries.

Re-run: `npm run perf:voice`. This executes actual MAI requests (15 short fixture uploads, bounded to at most 30 attempts including retries), isolated production voice turns, SQLite retrieval, and 24 fixed-fixture Grok/Kokoro speech starts and input-triggered stops, then writes a timestamped report under `artifacts/voice-perf/`. It leaves the live application alone. See [the harness instructions](../../scripts/voice-perf/README.md) for boundaries, cost ceiling, credential isolation and network-free replay.

Evidence: [fresh voice samples](evidence/issue-18/capture.json), [redacted production turn records](evidence/issue-18/turns.jsonl), [fresh retrieval samples](evidence/issue-18/retrieval.json), [machine-readable budget report](evidence/issue-18/report.json), [fresh speech samples](evidence/issue-18/speech.json), [raw Windows output envelopes](evidence/issue-18/speech-packets.jsonl), and [historical loopback samples](data/2026-09-11-tts-playback.json) retained only for comparison. The voice fixture hash and benchmark dates are retained. Source was baseline `6175989` with this ticket's instrumentation; no test-mocked clock or synthetic timing is counted as runtime evidence.

## Full measurement table

Generated 2026-09-12T16:17:34.264Z. Durations are milliseconds; percentiles use nearest rank. PASS/FAIL applies only to the stated measurement boundary and workload.

| Metric | Phase | n | p50 | p95 | Max | Target ms | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Acoustic end to shipping UI feedback | cold | 0 | unmeasured | unmeasured | unmeasured | p50 <= 1200; p95 <= 2000 | UNMEASURED |
| Detector frame to main useful state | cold | 3 | 1634.00 | 5527.00 | 5527.00 | timed separately | MEASURED |
| Detector frame to benchmark DOM feedback | cold | 3 | 1671.00 | 5551.00 | 5551.00 | timed separately | MEASURED |
| Memory retrieval | cold | 20 | 4.99 | 7.46 | 19.45 | p95 <= 100 | PASS |
| Physical hotkey/button to silence | cold | 0 | unmeasured | unmeasured | unmeasured | max <= 150 | UNMEASURED |
| Grok request to first loopback audio | cold | 3 | 1154.01 | 1209.40 | 1209.40 | timed separately | MEASURED |
| Grok playback interrupt to loopback silence | cold | 3 | 71.02 | 72.72 | 72.72 | max <= 100 | PASS |
| Grok injected Stop button input to loopback silence | cold | 3 | 71.96 | 73.43 | 73.43 | max <= 150 | PASS |
| Kokoro request to first loopback audio | cold | 3 | 1770.34 | 2163.46 | 2163.46 | timed separately | MEASURED |
| Kokoro playback interrupt to loopback silence | cold | 3 | 68.03 | 68.59 | 68.59 | max <= 100 | PASS |
| Kokoro injected Stop button input to loopback silence | cold | 3 | 68.99 | 69.64 | 69.64 | max <= 150 | PASS |
| Acoustic end to shipping UI feedback | warm | 0 | unmeasured | unmeasured | unmeasured | p50 <= 1200; p95 <= 2000 | UNMEASURED |
| Detector frame to main useful state | warm | 12 | 1014.00 | 2412.00 | 2412.00 | p50 <= 1200; p95 <= 2000 | FAIL |
| Detector frame to benchmark DOM feedback | warm | 12 | 2785.00 | 3441.00 | 3441.00 | p50 <= 1200; p95 <= 2000 | FAIL |
| Memory retrieval | warm | 1000 | 4.25 | 13.92 | 21.06 | p95 <= 100 | PASS |
| Physical hotkey/button to silence | warm | 0 | unmeasured | unmeasured | unmeasured | max <= 150 | UNMEASURED |
| Grok request to first loopback audio | warm | 9 | 820.52 | 870.83 | 870.83 | p95 <= 300 | FAIL |
| Grok playback interrupt to loopback silence | warm | 9 | 68.94 | 72.81 | 72.81 | max <= 100 | PASS |
| Grok injected Stop button input to loopback silence | warm | 9 | 69.56 | 73.39 | 73.39 | max <= 150 | PASS |
| Kokoro request to first loopback audio | warm | 9 | 972.01 | 2804.05 | 2804.05 | p95 <= 300 | FAIL |
| Kokoro playback interrupt to loopback silence | warm | 9 | 65.88 | 71.82 | 71.82 | max <= 100 | PASS |
| Kokoro injected Stop button input to loopback silence | warm | 9 | 66.71 | 72.57 | 72.57 | max <= 150 | PASS |

Re-run from the repository root with `npm run perf:voice`. See `scripts/voice-perf/README.md` for prerequisites, isolation, cost bound and report-only replay.

## Boundaries and provenance

- generatedAt: 2026-09-12T16:17:34.264Z
- retrievalEnvironment: {"platform":"win32","release":"10.0.26200","arch":"x64","node":"v24.18.0","electron":"43.1.0","sqlite":"3.53.1","cpu":"Intel(R) Core(TM) Ultra 9 275HX"}
- captureGeneratedAt: 2026-09-12T16:05:45.568Z
- captureFixtureSha256: 6dfabcf5a2cdf8ec17cb2395fc7e15157e9d18f978f5c50c8b9084d9bf8218a1
- freshSpeechGeneratedAt: 2026-09-12T16:16:00.275Z
- freshSpeechSourceSha256: 5cb29aa3c458e633c8bf9de89886084384fd41d2fecb7db6df3f8d8284be480e
- historicalPlaybackRun: 2026-09-12T04:49:09.120Z
- historicalPlaybackSha256: f28ebecfad14a43c4a57821abed409c5d7fe9cd1f1e518b814c40d406e9094c1
- transcription: microsoft/mai-transcribe-2 via OpenRouter; fixture dictionary empty
- speech: Grok default / Kokoro economical
- command: npm run perf:voice (15 at-most-5s uploads, each at most one retry; at most 150 billed audio seconds, about $0.005 at recorded MAI rate; plus 24 fixed replies on Grok/Kokoro, about $0.015 at recorded speech rates)

- Requires a physical input/output + shipping UI trial
- Fresh production capture/MAI/coordinator turn records; software reference
- Diagnostic only: hidden benchmark DOM, not shipping UI; frame throttling may apply
- Fresh first-query/new SQLite connection, OS cache not flushed
- No physical input-device timestamp; programmatic playback stop is separate
- Fresh production playback/WASAPI; 300 ms is former on-device reference, not a new hosted release gate
- Fresh production player stop; active-source/observed-silence validation
- Fresh Electron mouse input -> trusted benchmark button click -> AgentVoiceSession.stopSpeaking -> NativeSystemSpeech -> Windows output silence; physical switch delay excluded
- Fresh 10,000-row synthetic store after 100 warmups

The fresh voice workload uses the checked-in synthetic tiny WAV played in real time into a WebAudio MediaStream, production microphone worklet/segmentation/resampling, MAI through OpenRouter, production draft composition and turn recording. Wake detection and provider are fixtures. No reasoning or delegation is invoked, so those stages remain unmeasured. Cold means the first request in each of three new Electron processes (n=3); warm is four later requests in each (n=12). This is a small screen, not a stable population p95. Capture is reopened per trial; remote model residency, disk caches and external load are uncontrolled.

Detector frame receipt excludes unknown hardware/input buffering. Main-state publication precedes renderer IPC and paint. The hidden benchmark DOM timing includes animation-frame scheduling and is diagnostic, not a shipping UI result. No stage sum or historical ASR inference time is substituted for acoustic end-to-end latency. Physical input-switch delay, acoustic output and loaded workload still require dedicated trials. Fresh Grok/Kokoro speech rows, when present, use three cold/new-process and nine warm trials per provider; the stop boundary begins at Electron mouse input dispatch onto the benchmark button. Both input-to-silence and handler-to-silence end at the last actual Windows output sample, with at least 300 ms observed silence. These use the production speech services/session/player and process-tree Windows loopback, not physical speaker acoustics. Older captures without speech.json fall back to the explicitly dated historical playback screen. Provider choices follow MAI transcription, Grok default and Kokoro economical option; the obsolete on-device selection rule does not reverse that choice.

## Verification

Integration review added two deterministic regressions: failed reasoning must leave the resolved-intent milestone null, and an exact confirmed-message publication must keep its first-feedback timestamp even when command completion waits another five seconds. Both failed before the corrections and pass afterward. Matching command IDs associate publication with its turn; unrelated snapshots and initial busy state do not count. The original composition-only capture has no earlier provider confirmation, so these corrections do not change its recorded samples.

The input/retrieval one-command measurement and separate fresh 24-trial speech capture completed on Windows 11 build 26200, Intel Core Ultra 9 275HX, Electron 43.1.0. The three focused turn/capture/session test files passed 55 tests; the percentile/evidence-gate and actual-output stop scoring harness passed six tests. Node and renderer typechecks and focused ESLint passed. The default one-command runner now includes both already-executed capture phases, and report-only replay combines their dated evidence. No full suite or packaged build was run in the ticket worktree; the parent integration owns those checks. The report records current failures rather than treating the measurement ticket as a latency optimization or a completed physical acceptance run.
