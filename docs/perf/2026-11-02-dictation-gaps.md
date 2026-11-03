# Dictation handoff timings on Apple silicon

The instrumented baseline is complete. A–E are measured separately, in order.

## Measurement

- Source baseline: `07cefdd5a` (`324f5a80f` plus timing instrumentation only), local Owl `0.1.43-owl.20261103.8001`.
- Machine: Mac16,7, Apple M4 Pro (14 cores), 24 GB, macOS 27.0 (26A428); microphone permission already granted.
- Input: system default, MacBook Pro Microphone at 48 kHz.
- Transcription: Parakeet Ultra (Core ML), already installed in FluidAudio's model folder. Cloud transcription off.
- Local baseline: AI cleanup off, automatic paste on, saved paste delay 150 ms. History stays on: turning it off would delete the user's saved history.
- Every measurement build is a local Owl app installed with `sotto-install`; no test suite, e2e journey or design capture runs locally.
- Ten cold recordings use the first hotkey press after each app launch. Twenty warm recordings leave five seconds idle between the previous recording completing and the next press. Each recording lasts five seconds.
- Timing records contain fixed event names and numeric milliseconds only. They contain no words, audio, prompts, keys, application titles or user identifiers. Audio is never written to disk.
- Cold means first dictation after launch with the selected speech model ready, rather than a press while its model is still loading. Warm does not keep a microphone stream open.

The speaker-to-microphone pilot passed: a direct `say -r 220` utterance reached TextEdit through the actual microphone and paste path. Independent accessibility readback confirmed both phrase clauses without saving text. The pilot's speech process lasted 3,457 ms inside a 5,036 ms capture. It is excluded from both batches. An earlier phrase exceeded five seconds and was discarded.

The collector uses actual global hotkeys and observes capture before speaking. It aborts on a missing event rather than retrying a toggle. Cold launches wait for the selected model's enabled Start dictation control. Nearest-rank percentiles retain every completed sample; no outlier is removed. The Listening-shown mark is the second animation frame after React commits Listening, bounding its first paint opportunity. Paste-keystroke-sent is the native paste helper's acknowledgement; independent target readback verifies delivery separately. Neither mark pretends to be a hardware display or keyboard timestamp.

After the baseline, independent accessibility readback in the task's TextEdit document found 31 occurrences of each expected phrase clause: the pilot plus all 30 baseline recordings. Only match counts and character counts were returned; no target text was saved as evidence.

## Baseline

Thirty completed recordings: ten cold and twenty warm. All samples are retained, including the warm stop-to-paste maximum of 714.628 ms. With twenty samples the nearest-rank p95 is the nineteenth sorted result. No optimization has been applied.

Raw numeric evidence: [cold](2026-11-02-dictation-gaps/baseline-cold.jsonl), [warm](2026-11-02-dictation-gaps/baseline-warm.jsonl). Reproduce the aggregates with `node scripts/measure-dictation-gaps.mjs --summarize <file>`.

Every table entry is **p50 / p95 in milliseconds**.

| End-to-end measure | Cold (10) | Warm (20) |
| --- | ---: | ---: |
| Hotkey → Listening committed | 500.531 / 542.896 | 91.383 / 106.619 |
| Hotkey → Listening shown | 509.038 / 550.796 | 104.683 / 117.419 |
| Hotkey → first captured chunk | 503.432 / 545.996 | 99.379 / 121.019 |
| Stop → recorder finalized | 24.301 / 84.533 | 13.879 / 17.004 |
| Stop → last segment transcribed | 115.601 / 173.196 | 91.028 / 104.676 |
| Stop → paste helper acknowledgement | 415.186 / 491.850 | 377.558 / 398.880 |
| Stop → delivery returned | 565.601 / 642.233 | 529.028 / 549.376 |
| Captured utterance length | 5088.000 / 5105.000 | 5070.000 / 5090.000 |

### Stage work

| Measured interval | Cold p50 / p95 | Warm p50 / p95 |
| --- | ---: | ---: |
| `commandDeliveryMs` | 0.302 / 0.568 | 0.061 / 0.503 |
| `widgetShowMs` | 0.092 / 3.414 | 0.078 / 2.474 |
| `audioContextMs` | 250.200 / 283.300 | 6.000 / 20.800 |
| `workletLoadMs` | 16.700 / 25.600 | 2.700 / 6.600 |
| `microphoneRequestMs` | 218.000 / 280.300 | 77.200 / 92.500 |
| `sourceConnectMs` | 0.100 / 0.199 | 0.000 / 0.100 |
| `startCueMs` | 121.200 / 157.300 | 81.900 / 82.700 |
| `recorderStopMs` | 21.101 / 81.700 | 10.600 / 14.900 |
| `transcriptionRequestMs` | 88.199 / 92.600 | 77.200 / 87.700 |
| `deliveryMs` | 444.400 / 468.400 | 436.800 / 449.700 |
| `focusedAppMs` | 10.910 / 13.466 | 10.829 / 11.374 |
| `clipboardWriteMs` | 0.419 / 0.928 | 0.275 / 0.363 |
| `widgetHideMs` | 0.338 / 3.444 | 0.584 / 3.649 |
| `pasteDelayMs` | 149.374 / 149.994 | 150.982 / 151.398 |
| `pasteKeystrokeMs` | 128.898 / 142.910 | 119.693 / 132.587 |
| `pasteSettleMs` | 149.488 / 151.823 | 150.867 / 151.536 |
| `historyMs` | 10.000 / 23.200 | 10.600 / 15.600 |

### Handoffs

| Measured interval | Cold p50 / p95 | Warm p50 / p95 |
| --- | ---: | ---: |
| `hotkeyToCommandMs` | 0.166 / 0.177 | 0.022 / 0.049 |
| `commandToRecorderMs` | 0.900 / 1.000 | 0.200 / 0.399 |
| `recorderToAudioContextMs` | 0.000 / 0.100 | 0.000 / 0.100 |
| `audioContextToWorkletMs` | 0.000 / 0.100 | 0.000 / 0.100 |
| `workletToMicrophoneMs` | 0.300 / 0.500 | 0.100 / 0.200 |
| `microphoneToSourceMs` | 0.300 / 0.500 | 0.100 / 0.101 |
| `sourceToListeningDispatchMs` | 0.200 / 0.600 | 0.100 / 0.200 |
| `listeningDispatchToCommitMs` | 4.000 / 4.800 | 1.300 / 4.000 |
| `listeningCommitToShownMs` | 11.399 / 14.701 | 11.600 / 14.700 |
| `sourceToFirstChunkMs` | 7.400 / 18.700 | 3.200 / 15.700 |
| `stopToCommandMs` | 0.022 / 0.031 | 0.022 / 0.034 |
| `stopCommandToControllerMs` | 0.100 / 0.200 | 0.000 / 0.200 |
| `controllerToRecorderStopMs` | 2.200 / 2.899 | 2.300 / 3.100 |
| `recorderStopToTranscriptionMs` | 0.200 / 0.200 | 0.000 / 0.100 |
| `transcriptionToLastSegmentMs` | 0.100 / 0.201 | 0.000 / 0.100 |
| `lastSegmentToDeliveryMs` | 0.800 / 1.200 | 0.200 / 0.300 |
| `deliveryToFocusedAppMs` | 2.427 / 11.273 | 2.737 / 5.818 |
| `deliveryToClipboardMs` | 3.438 / 12.486 | 3.851 / 6.767 |
| `clipboardToWidgetHideMs` | 9.499 / 11.362 | 9.524 / 10.100 |
| `focusedAppToWidgetHideMs` | 0.023 / 0.037 | 0.026 / 0.033 |
| `widgetHideToPasteDelayMs` | 0.001 / 0.005 | 0.002 / 0.004 |
| `pasteDelayToKeystrokeMs` | 0.007 / 0.011 | 0.009 / 0.014 |
| `pasteKeystrokeToSettleMs` | 0.006 / 0.007 | 0.008 / 0.009 |
| `pasteSettleToDeliveryReturnMs` | 0.229 / 0.385 | 0.096 / 0.382 |
| `deliveryToHistoryMs` | 0.000 / 0.100 | 0.000 / 0.101 |
| `historyToReadyDispatchMs` | 1401.100 / 1401.900 | 1401.200 / 1401.900 |
| `readyDispatchToWidgetMs` | 6.100 / 9.200 | 7.400 / 11.899 |

Stage distributions include every invocation: command delivery includes start and stop, and widget show includes updates while already visible. Handoff rows use the start command for startup and the final command for stop. Audio block arrival and animation frames are scheduling/hardware intervals, not evidence of app-owned idle work.

The baseline has two deliberate waits beyond the saved 150 ms paste delay: a 150 ms post-paste settle and the saved 1,400 ms success display. These are recorded above rather than hidden as processing. Cleanup rows are absent because cleanup was off. The cold path spends most time opening an AudioContext, loading its worklet and then opening the microphone, in that order.

### Idle resources

A 30.075-second idle interval after the warm batch used 12.369% of one CPU core. Aggregate RSS across the eight installed app processes ended at 1055.484 MiB (started at 1093.844 MiB). The process set includes the speech helper, key listener and Electron helpers, and excludes external provider tools. RSS counts shared pages in each process; it is a consistent comparison measure, not unique physical memory. The observed 38.360 MiB decline also means a single endpoint is too noisy to prove a 15 MB regression budget: repeat idle observations are required for that decision.

[Numeric resource evidence](2026-11-02-dictation-gaps/baseline-idle.json). Reproduce with `node scripts/measure-dictation-idle.mjs --out <file>` while the Dictate room is open, the model is ready and no capture is active. The script takes CPU-time/RSS endpoints 30 seconds apart; it refuses an interval whose app process set changes.

## Changes, in measurement order

1. A: prepare and suspend an AudioContext and its worklet at app start; reuse it and rebuild after a device change or closed context.
2. B: dispatch Listening immediately when microphone access resolves, with synchronous source connection.
3. C: start the cue and widget presentation alongside microphone opening.
4. D: remove measured avoidable serial work after stop; select the lowest reliable paste delay across Terminal, VS Code, Chrome and Notes.
5. E: run an inference before the selected speech model reports ready.

Each stage will record ten cold and twenty warm results before proceeding to the next.

## Acceptance and limitations

| Measure | Required |
| --- | ---: |
| Hotkey to Listening, warm p95 | ≤50 ms |
| Hotkey to Listening, cold p95 | ≤150 ms |
| Hotkey to first captured chunk, warm p95 | ≤120 ms |
| Stop to paste, local, no cleanup, p50 / p95 | ≤350 / ≤500 ms |
| App overhead beyond cleanup request time | ≤30 ms |
| App-owned idle gap at each handoff | ≤16 ms |
| Idle CPU increase / memory increase | ≤0.5 percentage points / ≤15 MB |

Pending: real-app measurements, scripted coverage for speech beginning at 150 ms, controller and recorder coverage, typecheck, lint and GitHub CI.
