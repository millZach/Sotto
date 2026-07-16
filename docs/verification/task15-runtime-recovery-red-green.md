# Task 15 renderer runtime recovery: RED/GREEN evidence

Public seams agreed for this work: `TranscriptionClient`, `AudioRecorder`, and
`DictationController`. Worker and media-device fakes stand in only for browser system
boundaries; assertions use the public request/result, recorder, state, and callback APIs.

## WebGPU fallback

1. RED — explicit WebGPU did not retry:
   - Command: `npm test -- tests/integration/transcriptionClient.test.ts -t "retries explicit WebGPU failure once"`
   - Result: failed `1`; the original worker was terminated `0` times and the promise rejected with `WEBGPU_FAILED`.
2. GREEN — explicit WebGPU retries once in a fresh forced-WASM worker:
   - Same command.
   - Result: passed `1` (`13` skipped).
3. RED — recovered backend was not remembered:
   - Command: `npm test -- tests/integration/transcriptionClient.test.ts -t "uses the recovered WASM backend"`
   - Result: failed `1`; a later GPU-capable request posted `webgpu` instead of `wasm`.
4. GREEN — later auto/WebGPU-capable work uses the session's recovered WASM backend:
   - Same command.
   - Result: passed `1` (`14` skipped).
5. Regression gate:
   - Command: `npm test -- tests/integration/transcriptionClient.test.ts`
   - Result: passed `15/15`.

## Active microphone loss

1. RED — an active track `ended` event left capture active:
   - Command: `npm test -- tests/unit/renderer/audioRecorder.test.ts -t "active track ends"`
   - Result: failed `1`; the device-unavailable callback was called `0` times.
2. GREEN — track end produces a finite error and releases the graph:
   - Same command.
   - Result: passed `1` (`30` skipped at that slice).
3. RED — a stream `removetrack` event left capture active:
   - Command: `npm test -- tests/unit/renderer/audioRecorder.test.ts -t "active track is removed"`
   - Result: failed `1`; the device-unavailable callback was called `0` times.
4. GREEN — stream removal produces the same finite recovery path:
   - Same command.
   - Result: passed `1` (`31` skipped).
5. RED — the removed track was not stopped once it disappeared from `getTracks()`:
   - Command: `npm test -- tests/unit/renderer/audioRecorder.test.ts -t "active track is removed"`
   - Result: failed `1`; the removed track was stopped `0` times.
6. GREEN — the acquired track is retained for cleanup and stopped exactly once:
   - Same command.
   - Result: passed `1` (`31` skipped).
7. RED — UI notification waited for a deferred audio-context close:
   - Command: `npm test -- tests/unit/renderer/audioRecorder.test.ts -t "without waiting for a slow"`
   - Result: failed `1`; the callback was called `0` times while close remained pending.
8. GREEN — finite device loss is reported immediately while cleanup continues:
   - Same command.
   - Result: passed `1` (`32` skipped).
9. RED — dictation stayed in `listening` after the recorder reported device loss:
   - Command: `npm test -- tests/unit/renderer/dictationController.test.ts -t "recorder loses its microphone"`
   - Result: failed `1`; state remained `listening` instead of `MIC_DEVICE_NOT_FOUND`.
10. GREEN — dictation cancels capture and publishes the finite device error:
    - Same command.
    - Result: passed `1` (`44` skipped).

## Final verification

- `npm test -- tests/integration/transcriptionClient.test.ts tests/integration/transcriptionLocalOnlySmoke.test.ts tests/integration/transcriptionRuntimeResolutionSmoke.test.ts tests/integration/widgetSync.test.ts tests/unit/renderer`
  - Passed `295/295` across `21` files.
- `npm test -- tests/unit`
  - Passed `674`, skipped `1`, across `47` files.
- `npx tsc --noEmit -p tsconfig.web.json`
  - Passed.
- `npx eslint src/renderer/src/transcription/client.ts tests/integration/transcriptionClient.test.ts src/renderer/src/audio/audioRecorder.ts tests/unit/renderer/audioRecorder.test.ts src/renderer/src/features/dictation/dictationController.ts tests/unit/renderer/dictationController.test.ts`
  - Passed.
- `npm run typecheck`
  - Passed both node and web projects after concurrent Task 15 changes settled.
- `npm run lint`
  - Passed repository-wide.
