# Wake and activated capture diagnosis — 2026-09-14

The user reported intermittent “Hey Sotto” activation and no response while the room said it was listening. This investigation covers microphone segmentation; the separate hidden-draft routing defect is handled in the integrated change.

## Reproduced cause

`BrowserVoiceCapture` accepted wake audio at RMS 0.006 but raised its floor to RMS 0.012 immediately after activation. The same quiet waveform that reached wake detection could therefore disappear before transcription once the UI said it was listening. The higher activated floor was retained for a Moonshine short-command recognition quirk documented in `issue-9-wake.md`. ADR-0006 subsequently removed that transcriber and made MAI-Transcribe-2 the sole route.

The production capture/worklet regression feeds the same amplitude-0.01 waveform before and after activation, at both 16 and 48 kHz. Before the fix, both checks failed with “expected … to have a length of 2 but got 1.” The activated speech never emitted an utterance. Both pass with the existing wake floor retained after activation. PCM amplitude, endpoint silence, pre-roll and detector parameters are unchanged.

```powershell
npx vitest run tests/unit/renderer/agentVoiceCapture.test.ts tests/unit/renderer/agentVoice.test.ts tests/unit/renderer/agentWakeAcknowledgement.test.tsx tests/unit/main/agentWakeAudio.test.ts --maxWorkers=2
```

Result: **35 passed across four files**. Controls cover sub-threshold noise in both capture modes, waveform preservation, duration limits, wake acknowledgement, and session behavior.

## Recorded synthetic speech replay

The existing `scripts/probe-agent-wake-capture.mjs` ran against the already-installed, hash-verified local model and retained Microsoft David/Zira WAV fixtures. It sends 128-frame input through the current capture and actual local detector. It opens no microphone and performs no downloads or hosted transcription.

- Wake positives: **70/70 detected**, five fixtures × seven gains × two sample rates.
- Negative controls: **280/280 rejected**, including embedded/name-only phrases, soda/sofa, ordinary commands, noise, tone and silence.

A task-local variant used the same capture replay for David “Send it,” Zira “Send it” and David “Next,” selected activated mode, and checked whether a clip was emitted instead of asking the wake detector to recognize a command. The 42-case matrix used gains 1, 0.7, 0.5, 0.3, 0.2, 0.1 and 0.05 at 16/48 kHz.

| Capture outcome | Before | After |
| --- | ---: | ---: |
| All 42 command cases emitted | 32 | 38 |
| 36 command cases at gains 0.1–1 emitted | 32 | 36 |

The remaining four misses are the most attenuated gain-0.05 “Send it” recordings at 48 kHz and “Next” at both rates. They remain below the capture floor. No further threshold or detector tuning was justified by these fixtures. The temporary probe and original/fixed JSONL are retained under `.claude/tmp/probe-active-capture.mjs` and `.claude/tmp/active-capture-{original,fixed}.jsonl` during the diagnosis session; the committed unit regression above is the portable feedback loop.

## Limits

This establishes a software cause for losing quiet speech **after** activation. All available synthetic wake cases already passed, so it does not establish why this user's physical wake phrase is intermittently missed. No live microphone, profile, app restart or device setting was touched for these checks. Room acoustics, microphone processing, accent coverage and the user's physical wake/response journey remain pending.

Subsequent integrated check: after root loaded the fixes and recovered the hidden draft, Zach tested the physical wake/reply journey and reported “It wakes and replies.” That confirms the working attempt; broader room/accent accuracy is still outside the replay evidence above.
