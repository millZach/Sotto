# Windows voice budget measurement

Run from the repository root:

```powershell
npm run perf:voice
```

Requires the installed Electron dependency and the existing Sotto OpenRouter transcription key in Windows safeStorage. No new service, model download or settings change is required. The command creates a timestamped directory under `artifacts/voice-perf/`, measures production SQLite retrieval, builds an isolated Electron harness, captures 15 real voice pipeline turns, and writes `report.md`, `report.json`, `capture.json`, `retrieval.json` and redacted `turns.jsonl`. Each of three fresh processes accepts five uploads of at most five seconds; the production transcription service permits one retry, so the ceiling is 150 audio seconds (about $0.005 at the MAI rate recorded in ADR-0006). The report reuses the explicitly dated checked-in Windows playback evidence for Grok/Kokoro; it does not pretend that evidence is a new run.

The benchmark opens an isolated hidden Electron profile. The production OS credential class reads the encrypted `formatting` slot; only encrypted Chromium key metadata is copied to the temporary profile. No plaintext key reaches the renderer or disk. Personal settings, dictionary, transcripts, project state and the memory database are not read. The temporary profile is removed after its Electron process exits. The fixture provider cannot dispatch to any real coding agent. Only the checked-in `speech-tiny.wav` synthetic fixture is uploaded; its checksum is recorded.

Fresh voice boundaries: a WebAudio source plays that WAV at real time into a MediaStream, which replaces physical `getUserMedia`. The shipped worklet, `BrowserVoiceCapture`, `AgentVoiceSession`, WAV encoder, MAI service, `AgentControl` draft composition and `TurnRecorder` execute normally. Wake detection is a fixture that always activates. A DOM draft in the hidden harness records a second diagnostic milestone after two animation frames; hidden-window scheduling can inflate it, so it is not shipping-UI evidence. No reasoning, agent delegation or spoken response runs in this workload.

Cold means the first MAI request in a fresh Electron process, not a claim about remote provider residency. Warm reuses that process but reopens capture. Retrieval cold means the first query on each of 20 newly opened SQLite connections with Windows file cache intact; warm means 1,000 queries after 100 warmups on 10,000 synthetic memories. Connection creation/seeding is excluded. This is a bounded screen, especially the three cold voice samples; external load and network variation are uncontrolled.

The production turn recorder distinguishes `detector-frame-received` from acoustic capture and `main-state-published` from renderer paint. Timestamp propagation retains endpoint silence and the renderer/main command queue in speech-to-feedback duration. The first voiced timestamp is not reconstructed by subtracting the configured silence timer. Length-capped continuous speech has no end-of-speech timestamp. Missing milestones, reversed clocks and stages never invoked remain null/excluded; older records parse with defaults. `retrievalCount` prevents zero-time absent retrieval from passing a budget.

Replay a completed capture without network calls:

```powershell
node scripts/voice-perf/run.mjs --report-only --output artifacts/voice-perf/<run-directory>
```

Optionally add `--turns <explicit-turns.jsonl>` to summarize caller-selected turn telemetry. No default lookup opens personal history; imported text, errors and IDs are never written to the report. `--playback <evidence.json>` selects another compatible loopback export. Malformed input fails the command instead of becoming a zero-ms pass.

`npm run test:voice-perf` verifies percentile/gate handling. Focused production tests are `tests/unit/main/agentTurns.test.ts`, `tests/unit/renderer/agentVoice.test.ts`, and `tests/unit/renderer/agentVoiceCapture.test.ts`. The harness main process is included in the standard Node typecheck.

Remaining physical measurement gaps are deliberately UNMEASURED: acoustic speech end to shipping UI feedback, a hardware hotkey/button event to output silence, and fresh cold/loaded hosted speech onset. See the existing `scripts/tts-bench/README.md` and `loopback.md` for the production playback/WASAPI procedure. A useful software proxy does not close those gaps.
