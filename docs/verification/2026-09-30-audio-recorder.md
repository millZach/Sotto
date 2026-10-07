# Audio recorder limit and delivery

Issues #519 (S-046) and #598 (S-126), verified on Windows.

## Recorder regressions

`npx vitest run tests/unit/renderer/audioRecorder.test.ts tests/unit/renderer/dictationController.test.ts tests/unit/renderer/agentVoiceCapture.test.ts --maxWorkers=2`: 131 passed.

- A synthetic recording supplies five minutes of audio, then another worklet frame before the duration timer runs. Both manual stop at 16 kHz and automatic stop at 48 kHz deliver exactly the maximum transcription sample count. The first five minutes remain, and the encoded WAV passes the real IPC request schema. Both delivery paths failed schema validation before the fix.
- Manual stop and automatic stop deliver usable audio and leave neither an audio result nor an active session on the recorder. Both paths retained an audio result before the cache was removed. Ownership is inspected directly; this does not depend on garbage collection timing.
- Existing cancellation, device loss, streaming segmentation and dictation-controller tests still pass.

## Electron journeys

`npm run build` and `npx playwright test tests/e2e/app.spec.ts --grep 'onboards, dictates|history disabled|microphone permission|silence preserves|transcription failure'`: 5 passed.

These checks launch the built app and cover shortcut dictation, clipboard and history delivery, history off, microphone-denial recovery, silence and transcription failure. They use deterministic in-memory adapters; the delayed timer and audio ownership checks above exercise the real recorder with synthetic audio. No live microphone, hosted transcription request or actual hidden-window throttling was tested.

The fixes change recorder internals. No rendered surface, copy, theme or keyboard path changed, so no design baselines were regenerated.
