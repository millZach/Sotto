# Stop while the microphone is connecting (#613)

Test citations use the current split files. Recorded counts and outcomes are from the original runs.

The owner's decision is that Stop during connection is remembered and cancels
dictation as soon as the microphone is ready. The controller's old test pinned
ignoring a second shortcut press during startup.

The replacement regression holds recorder startup with a deferred promise and
presses Stop or the shortcut twice. Before the fix, both cases failed because the
controller entered listening. After the fix, both cancel without entering
listening, playing recording cues, finalizing audio, transcribing a segment,
delivering text or adding history. A subsequent dictation still finishes normally.

`npx vitest run tests/unit/renderer/features/dictation/dictationLifecycle.test.ts tests/unit/renderer/features/dictation/dictationOutput.test.ts tests/unit/renderer/features/dictation/dictationPrewarm.test.ts tests/unit/renderer/features/dictation/dictationRecovery.test.ts tests/unit/renderer/audio/audioCaptureWorklet.test.ts tests/unit/renderer/audio/audioRecorder.test.ts tests/unit/renderer/audio/audioRecorderSegmentation.test.ts --maxWorkers=2`
passed all 114 tests.

After `npm run build`, Playwright passed all 22 tests in `app.spec.ts`,
`dictation-focus.spec.ts` and `dictation-recovery.spec.ts`. These exercise the
registered shortcut, ordinary dictation, native focus and caret preservation,
microphone denial recovery, silence, transcription failure and completed-text
recovery in the built Windows Electron app with deterministic adapters.

The recovery journey checks dark and light at 1600x1000, 1280x800 and 820x560
with reduced motion on. The minimum-size captures were inspected: the dictation
and recovery controls remain visible and readable. Retained captures:

- [Dark Dictate room at 820x560](../../artifacts/review-613/dictate-820-dark.png)
- [Light Dictate room at 820x560](../../artifacts/review-613/dictate-820-light.png)

No layout, controls, styles or UI copy changed. No design baselines were regenerated.
The startup timing regression is covered at the controller seam; the Electron
journeys cover neighboring behavior rather than a delayed microphone connection.
A physical microphone's cold-start timing and macOS were not tested.
