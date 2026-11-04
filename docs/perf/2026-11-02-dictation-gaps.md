# Dictation handoff timings on Apple silicon

The user ended the latency target pursuit on November 3, 2026 in Phoenix (November 4 UTC) and asked to consolidate the existing optimizations. The baseline and A–C completed their planned batches. D was implemented and has one ten-recording Code diagnostic; E was not implemented. The original targets were not achieved as a whole. This note records the measured result and its limits, not an ongoing A–E campaign.

## Measurement

- Source baseline: `07cefdd5a` (`324f5a80f` plus timing instrumentation only), local Owl `0.1.43-owl.20261103.8001`.
- Machine: Mac16,7, Apple M4 Pro (14 cores), 24 GB, macOS 27.0 (26A428); microphone permission already granted.
- Input: system default, MacBook Pro Microphone at 48 kHz.
- Transcription: Parakeet Ultra (Core ML), already installed in FluidAudio's model folder. Cloud transcription off.
- Local baseline and A–C: AI cleanup off, automatic paste on, saved paste delay 150 ms. D's Code diagnostic used 50 ms; that is a diagnostic setting, not evidence for a shipped default. History stays on: turning it off would delete the user's saved history.
- Every measurement build is a local Owl app installed with `sotto-install`; no test suite, e2e journey or design capture runs locally.
- The planned baseline and A–C batches each contain ten cold recordings using the first hotkey press after each app launch, and twenty warm recordings leaving five seconds idle between the previous recording completing and the next press. Each recording lasts five seconds. D has only ten warm Code recordings; its planned ten cold and twenty warm recordings did not complete.
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

Review tightened the collector before A: every headline measure must exist in every accepted recording, and a paste mark now requires a successful helper acknowledgement. All 30 baseline recordings have every headline measure; the target readback above separately verifies their paste success. Cleanup-enabled summaries sum all request attempts, including a fallback, rather than attributing a failed primary request to app overhead. Handoff intervals that include concurrent work or the configured success display are elapsed intervals, not unexplained idle time.

The baseline has two deliberate waits beyond the saved 150 ms paste delay: a 150 ms post-paste settle and the saved 1,400 ms success display. These are recorded above rather than hidden as processing. Cleanup rows are absent because cleanup was off. The cold path spends most time opening an AudioContext, loading its worklet and then opening the microphone, in that order.

### Idle resources

A 30.075-second idle interval after the warm batch used 12.369% of one CPU core. Aggregate RSS across the eight installed app processes ended at 1055.484 MiB (started at 1093.844 MiB). The process set includes the speech helper, key listener and Electron helpers, and excludes external provider tools. RSS counts shared pages in each process; it is a consistent comparison measure, not unique physical memory. The observed 38.360 MiB decline also means a single endpoint is too noisy to prove a 15 MB regression budget: repeat idle observations are required for that decision.

[Numeric resource evidence](2026-11-02-dictation-gaps/baseline-idle.json). Reproduce with `node scripts/measure-dictation-idle.mjs --out <file>` while the Dictate room is open, the model is ready and no capture is active. The script takes CPU-time/RSS endpoints 30 seconds apart; it refuses an interval whose app process set changes.

A second baseline interval, still running the unchanged installed build, measured 15.220% of one core over 30.091 seconds and RSS 934.891 → 851.969 MiB ([evidence](2026-11-02-dictation-gaps/baseline-idle-2.json)). This variation precedes A; the CPU and memory budgets need matched repeat observations rather than a comparison with one noisy endpoint.

## Changes, in measurement order

The original sequence was:

1. A: prepare and suspend an AudioContext and its worklet at app start; reuse it and rebuild after a device change or closed context.
2. B: dispatch Listening immediately when microphone access resolves, with synchronous source connection.
3. C: start the cue and widget presentation alongside microphone opening.
4. D: remove measured avoidable serial work after stop; select the lowest reliable paste delay across Terminal, VS Code, Chrome and Notes.
5. E: run an inference before the selected speech model reports ready.

The baseline and A–C completed ten cold and twenty warm results each. D ended after the Code diagnostic below; its four-target, full-batch and idle comparisons were not completed. E remained a proposal when the user ended the pursuit.

## A: warm suspended audio graph

Source: `a4f7db4a7fe7a7443a374bf4b927c5368ae7ddd2`, local Owl `0.1.43-owl.20261103.8002`. The controller prepares one suspended AudioContext and registers its capture worklet at startup. Each recording owns its own stream and nodes; stopping closes every microphone track, retires the worklet processor and suspends the shared context. A device change or closed context rebuilds preparation. An active capture is retired on release rather than interrupted by an unrelated device notification.

Ten cold and twenty warm recordings use the baseline settings and procedure. Independent accessibility readback found 61 matches of each expected clause: the pilot, 30 baseline recordings and all 30 A recordings. No target text was saved. Raw evidence: [cold](2026-11-02-dictation-gaps/a-cold.jsonl), [warm](2026-11-02-dictation-gaps/a-warm.jsonl). Every table entry remains p50 / p95 in milliseconds.

| End-to-end measure | Cold (10) | Warm (20) |
| --- | ---: | ---: |
| `hotkeyToListeningCommittedMs` | 195.167 / 240.877 | 99.614 / 108.189 |
| `hotkeyToListeningShownMs` | 209.267 / 255.077 | 111.086 / 121.408 |
| `hotkeyToFirstAudioChunkMs` | 249.580 / 294.777 | 144.532 / 154.789 |
| `stopToRecorderStoppedMs` | 73.188 / 85.986 | 16.657 / 20.575 |
| `stopToLastSegmentMs` | 166.985 / 185.638 | 91.134 / 105.425 |
| `stopToPasteKeystrokeMs` | 454.781 / 757.662 | 380.533 / 417.718 |
| `stopToDeliveryReturnedMs` | 605.088 / 907.085 | 531.719 / 567.208 |
| `captureDurationMs` | 5078.000 / 5126.000 | 5084.000 / 5102.000 |

### A stage work

| Measured interval | Cold p50 / p95 | Warm p50 / p95 |
| --- | ---: | ---: |
| `commandDeliveryMs` | 0.253 / 0.576 | 0.278 / 0.442 |
| `widgetShowMs` | 0.089 / 3.357 | 0.077 / 4.208 |
| `audioContextMs` | 20.700 / 30.600 | 28.800 / 39.100 |
| `workletLoadMs` | 0.000 / 0.100 | 0.000 / 0.100 |
| `microphoneRequestMs` | 165.800 / 204.000 | 66.200 / 75.900 |
| `sourceConnectMs` | 0.100 / 0.300 | 0.000 / 0.100 |
| `startCueMs` | 139.100 / 146.100 | 126.700 / 128.899 |
| `recorderStopMs` | 70.800 / 83.500 | 13.000 / 15.899 |
| `transcriptionRequestMs` | 92.000 / 109.000 | 74.800 / 88.600 |
| `deliveryMs` | 440.100 / 739.300 | 439.000 / 448.599 |
| `focusedAppMs` | 11.242 / 18.101 | 10.926 / 11.432 |
| `clipboardWriteMs` | 0.383 / 0.779 | 0.296 / 0.334 |
| `widgetHideMs` | 0.356 / 2.582 | 0.581 / 3.142 |
| `pasteDelayMs` | 149.290 / 150.035 | 150.738 / 151.738 |
| `pasteKeystrokeMs` | 127.482 / 423.914 | 121.870 / 129.838 |
| `pasteSettleMs` | 149.417 / 150.005 | 151.041 / 151.765 |
| `historyMs` | 9.800 / 12.700 | 10.400 / 12.600 |

### A handoffs

| Measured interval | Cold p50 / p95 | Warm p50 / p95 |
| --- | ---: | ---: |
| `hotkeyToCommandMs` | 0.167 / 0.173 | 0.043 / 0.082 |
| `commandToRecorderMs` | 0.900 / 1.000 | 0.300 / 0.600 |
| `recorderToAudioContextMs` | 0.000 / 0.100 | 0.000 / 0.099 |
| `audioContextToWorkletMs` | 0.000 / 0.200 | 0.000 / 0.101 |
| `workletToMicrophoneMs` | 0.300 / 0.500 | 0.100 / 0.200 |
| `microphoneToSourceMs` | 0.200 / 0.400 | 0.000 / 0.100 |
| `sourceToListeningDispatchMs` | 0.200 / 0.400 | 0.100 / 0.200 |
| `listeningDispatchToCommitMs` | 3.700 / 9.700 | 1.200 / 1.700 |
| `listeningCommitToShownMs` | 11.400 / 14.200 | 10.400 / 15.300 |
| `sourceToFirstChunkMs` | 58.000 / 64.600 | 46.100 / 48.299 |
| `stopToCommandMs` | 0.024 / 0.033 | 0.031 / 0.060 |
| `stopCommandToControllerMs` | 0.100 / 0.200 | 0.000 / 0.100 |
| `controllerToRecorderStopMs` | 2.200 / 2.400 | 3.200 / 3.901 |
| `recorderStopToTranscriptionMs` | 0.200 / 0.300 | 0.099 / 0.100 |
| `transcriptionToLastSegmentMs` | 0.100 / 0.200 | 0.099 / 0.100 |
| `lastSegmentToDeliveryMs` | 0.800 / 1.000 | 0.200 / 0.600 |
| `deliveryToFocusedAppMs` | 2.488 / 13.171 | 2.114 / 4.684 |
| `deliveryToClipboardMs` | 3.561 / 14.471 | 3.082 / 5.623 |
| `clipboardToWidgetHideMs` | 9.845 / 15.975 | 9.718 / 10.129 |
| `focusedAppToWidgetHideMs` | 0.025 / 0.036 | 0.026 / 0.030 |
| `widgetHideToPasteDelayMs` | 0.002 / 0.004 | 0.003 / 0.005 |
| `pasteDelayToKeystrokeMs` | 0.007 / 0.011 | 0.009 / 0.019 |
| `pasteKeystrokeToSettleMs` | 0.006 / 0.008 | 0.007 / 0.008 |
| `pasteSettleToDeliveryReturnMs` | 0.207 / 0.370 | 0.220 / 0.452 |
| `deliveryToHistoryMs` | 0.000 / 0.100 | 0.000 / 0.101 |
| `historyToReadyDispatchMs` | 1401.100 / 1401.800 | 1401.300 / 1401.900 |
| `readyDispatchToWidgetMs` | 4.500 / 9.100 | 8.400 / 12.200 |

Cold Listening p95 falls from 550.796 to 255.077 ms. Worklet acquisition during a press is now at most 0.100 ms at p95. The context must still resume before capture, and opening the microphone remains 165.800 / 204.000 ms cold and 66.200 / 75.900 ms warm. A alone does not meet either Listening target.

Warm first-chunk p95 regresses from 121.019 to 154.789 ms. Its source-connect-to-first-chunk p95 is 48.299 ms, versus 15.700 ms in the baseline. This is retained as an observed regression, with its cause still to resolve; it is not counted as a successful latency cut. Stop-to-paste retains every completed sample, including the first cold paste helper's 423.914 ms execution and the warm maximum.

The 30.105-second idle observation measured 12.124% of one core across nine installed app processes, RSS 1199.469 → 1059.891 MiB ([evidence](2026-11-02-dictation-gaps/a-idle.json)). Against the first baseline interval that is −0.245 percentage points CPU and +4.407 MiB endpoint RSS. This single comparison does not prove the budgets: the unchanged baseline itself varied substantially, and A has one additional installed-app process. Matched repeat observations are still required.

Additional unchanged-build baseline observations, all retained, were 17.517% CPU and 887.859 → 895.359 MiB over 30.085 seconds ([third](2026-11-02-dictation-gaps/baseline-idle-3.json)); 5.452% and 878.969 → 617.719 MiB over 30.082 seconds ([fourth](2026-11-02-dictation-gaps/baseline-idle-4.json)); and 12.361% and 717.109 → 705.031 MiB over 30.096 seconds ([fifth](2026-11-02-dictation-gaps/baseline-idle-5.json)). The fourth interval includes a 261.250 MiB RSS drop without a code change.

An earlier installation attempt produced zero accepted samples: the delayed installer overlapped a measurement launch and rolled back. The successful run first closed the existing measurement app, waited for the installer's version-specific successful receipt and verified the installed version before starting. A direct system-speech preflight matched the baseline pilot's warmed speech output. Typecheck, lint and the measurement build passed. Recorder, controller, ownership, device-change and worklet-retirement test sources are added; they await GitHub CI and were not run locally.

## B: Listening at microphone readiness

Source: `778563e4a6b784a04612ad2071e652c93e0e6b4a`, local Owl `0.1.43-owl.20261103.8003`. The recorder calls the controller synchronously when microphone access resolves. Listening is dispatched before source connection, with no intervening await. Only a pending native permission request publishes Waiting for microphone; ordinary startup offers Cancel. A stop during unfinished startup cancels the session and rejects late readiness.

Ten cold and twenty warm recordings retain the baseline settings and five-second utterance. No accepted recording committed Waiting for microphone. Independent TextEdit accessibility readback found 91 matches of each expected clause: the pilot, baseline, A and all 30 B recordings. Only numeric counts were returned. Raw evidence: [cold](2026-11-02-dictation-gaps/b-cold.jsonl), [warm](2026-11-02-dictation-gaps/b-warm.jsonl). Every table entry is p50 / p95 in milliseconds.

| Measured interval | Cold p50 / p95 | Warm p50 / p95 |
| --- | ---: | ---: |
| `hotkeyToListeningCommittedMs` | 112.843 / 241.685 | 94.262 / 112.508 |
| `hotkeyToListeningShownMs` | 121.697 / 2083.377 | 105.444 / 127.735 |
| `hotkeyToFirstAudioChunkMs` | 159.490 / 287.785 | 142.812 / 162.008 |
| `stopToRecorderStoppedMs` | 24.973 / 87.817 | 17.029 / 18.440 |
| `stopToLastSegmentMs` | 140.319 / 227.117 | 92.549 / 102.047 |
| `stopToPasteKeystrokeMs` | 452.303 / 869.098 | 383.099 / 408.155 |
| `stopToDeliveryReturnedMs` | 602.420 / 1019.117 | 533.951 / 560.001 |
| `captureDurationMs` | 5072.000 / 5109.000 | 5078.000 / 5100.000 |

### B stage work

| Measured interval | Cold p50 / p95 | Warm p50 / p95 |
| --- | ---: | ---: |
| `commandDeliveryMs` | 0.217 / 4.115 | 0.226 / 0.495 |
| `widgetShowMs` | 0.079 / 2.709 | 0.079 / 7.282 |
| `audioContextMs` | 12.400 / 74.500 | 27.500 / 44.399 |
| `workletLoadMs` | 0.000 / 0.000 | 0.000 / 0.000 |
| `microphoneRequestMs` | 98.500 / 160.900 | 63.400 / 78.400 |
| `sourceConnectMs` | 0.100 / 0.400 | 0.100 / 0.100 |
| `startCueMs` | 131.200 / 143.400 | 126.400 / 130.000 |
| `recorderStopMs` | 22.600 / 84.800 | 13.400 / 14.200 |
| `transcriptionRequestMs` | 90.000 / 157.200 | 75.400 / 83.400 |
| `deliveryMs` | 449.400 / 791.300 | 440.400 / 462.400 |
| `focusedAppMs` | 11.858 / 27.614 | 10.960 / 13.067 |
| `clipboardWriteMs` | 0.472 / 2.633 | 0.286 / 0.415 |
| `widgetHideMs` | 0.363 / 0.440 | 0.608 / 4.877 |
| `pasteDelayMs` | 149.474 / 150.043 | 150.928 / 151.498 |
| `pasteKeystrokeMs` | 135.076 / 461.181 | 121.420 / 143.362 |
| `pasteSettleMs` | 149.746 / 151.197 | 150.863 / 151.973 |
| `historyMs` | 10.300 / 21.800 | 11.200 / 16.099 |

### B handoffs

| Measured interval | Cold p50 / p95 | Warm p50 / p95 |
| --- | ---: | ---: |
| `hotkeyToCommandMs` | 0.118 / 0.164 | 0.054 / 0.121 |
| `commandToRecorderMs` | 0.700 / 1.000 | 0.400 / 0.500 |
| `recorderToAudioContextMs` | 0.000 / 0.100 | 0.000 / 0.100 |
| `audioContextToWorkletMs` | 0.000 / 0.100 | 0.000 / 0.100 |
| `workletToMicrophoneMs` | 0.200 / 1.800 | 0.100 / 0.101 |
| `microphoneToSourceMs` | 0.300 / 0.401 | 0.200 / 0.200 |
| `microphoneToListeningDispatchMs` | 0.200 / 0.301 | 0.100 / 0.200 |
| `listeningDispatchToSourceMs` | 0.100 / 0.200 | 0.000 / 0.100 |
| `listeningDispatchToCommitMs` | 2.900 / 10.700 | 1.200 / 1.600 |
| `listeningCommitToShownMs` | 10.400 / 1899.300 | 13.599 / 15.700 |
| `sourceToFirstChunkMs` | 52.100 / 67.900 | 48.300 / 56.599 |
| `stopToCommandMs` | 0.023 / 0.026 | 0.031 / 0.057 |
| `stopCommandToControllerMs` | 0.200 / 0.201 | 0.099 / 0.100 |
| `controllerToRecorderStopMs` | 2.300 / 3.200 | 3.300 / 4.200 |
| `recorderStopToTranscriptionMs` | 0.200 / 0.200 | 0.000 / 0.100 |
| `transcriptionToLastSegmentMs` | 0.100 / 0.100 | 0.000 / 0.100 |
| `lastSegmentToDeliveryMs` | 0.900 / 1.200 | 0.200 / 0.300 |
| `deliveryToFocusedAppMs` | 2.526 / 2.955 | 2.259 / 5.163 |
| `deliveryToClipboardMs` | 4.151 / 5.286 | 3.252 / 6.280 |
| `clipboardToWidgetHideMs` | 9.751 / 22.319 | 9.690 / 11.726 |
| `focusedAppToWidgetHideMs` | 0.024 / 0.027 | 0.027 / 0.031 |
| `widgetHideToPasteDelayMs` | 0.002 / 0.006 | 0.003 / 0.005 |
| `pasteDelayToKeystrokeMs` | 0.007 / 0.019 | 0.009 / 0.013 |
| `pasteKeystrokeToSettleMs` | 0.006 / 0.007 | 0.007 / 0.009 |
| `pasteSettleToDeliveryReturnMs` | 0.249 / 0.463 | 0.198 / 0.291 |
| `deliveryToHistoryMs` | 0.000 / 0.101 | 0.000 / 0.100 |
| `historyToReadyDispatchMs` | 1401.400 / 1401.700 | 1401.200 / 1401.800 |
| `readyDispatchToWidgetMs` | 4.600 / 9.200 | 8.300 / 9.700 |
| `sourceToListeningDispatchMs` | — | 0.000 / 0.000 |

Microphone readiness to Listening dispatch is now 0.200 / 0.301 ms cold and 0.100 / 0.200 ms warm. Dispatch to source connection is 0.100 / 0.200 ms cold and 0.000 / 0.100 ms warm. These synchronous handoffs meet 16 ms; microphone opening and context resume still dominate the press. Warm Listening p95 is 127.735 ms and first-chunk p95 is 162.008 ms, both above target and worse than A. B does not yet improve the headline startup budgets.

The second cold press committed Listening at 184.077 ms, but its second-animation-frame shown mark arrived at 2083.377 ms: 1899.300 ms after commit. Its first chunk arrived at 242.677 ms. This sample remains in the cold p95. The numeric trace proves a delayed animation-frame observation, not whether the user saw an equally long display delay; its cause is unverified. Cold stop-to-paste p95 also retains the first sample's 869.098 ms, including a 461.181 ms native helper call. No sample was removed or retried.

The 30.107-second idle interval measured 11.160% of one core across nine installed-app processes, RSS 1074.500 → 1008.547 MiB ([evidence](2026-11-02-dictation-gaps/b-idle.json)). Resource variation in the unchanged baseline still prevents a budget claim from this single endpoint.

Cold-launch preparation initially failed before any hotkey. The final collector (`703926082`) waits for the exact main window, invokes Sotto's native Settings menu to show it and publish visibility, then waits for enabled Start dictation before activating TextEdit. Native unminimize/focus alone did not consistently expose the ready renderer. Preparation failures yielded zero accepted recordings; all 30 completed measurements are retained. B typecheck, lint, catalog extraction and the measurement build passed. Unit and perf test sources await GitHub CI; no local test, e2e or design capture was run.

### B cue isolation

Before C, five additional warm recordings in the unchanged B app temporarily disabled Sound cues through Settings. They are diagnostic samples, not a replacement for B's twenty warm recordings. Five seconds separated presses; the model, microphone and output settings were unchanged. Sound cues was restored and verified on afterward. Independent TextEdit readback reached 96 matches of both expected clauses, confirming all five additional pastes. [Raw evidence](2026-11-02-dictation-gaps/b-cues-off.jsonl).

| Interval | B cues on (20), p50 / p95 ms | B cues off (5), p50 / p95 ms |
| --- | ---: | ---: |
| Hotkey → Listening shown | 105.444 / 127.735 | 113.336 / 121.784 |
| Hotkey → first chunk | 142.812 / 162.008 | 113.631 / 120.036 |
| Source connected → first chunk | 48.300 / 56.599 | 13.800 / 21.500 |
| Stop → paste | 383.099 / 408.155 | 372.571 / 629.812 |

This small comparison supports the inference that fresh start-cue setup blocks receipt of capture chunks in the renderer: removing cues reduces the source-to-first-chunk interval by roughly 35 ms at both percentiles, without a corresponding Listening improvement. It does not prove a particular Chromium output-cache mechanism or late hardware capture. C retained the cue and was measured with the full cold/warm batch below.

## C: prepare cues and play alongside capture

Source: `1b3a3a50d2c5ddec7ae78b1c490fffb3c7b57f8a`, local Owl `0.1.43-owl.20261103.8004`. The enabled controller prepares a separate suspended cue AudioContext alongside capture and model preparation. A press starts the recorder and cue without awaiting cue playback. The widget publication already runs independently of capture. Cue completion follows both oscillators ending, replacing the fixed 80 ms timer. The cue context suspends after the last overlapping play; failed or closed contexts are retired and rebuilt on the next play. Turning dictation off prepares none of it. No microphone stays open between recordings.

The same ten cold and twenty warm recordings completed with Sound cues on, cleanup off and paste delay 150 ms. Independent TextEdit accessibility readback found 126 matches of each expected clause: the previous 96 plus all 30 C deliveries. No target text was saved. All required marks were present, with no permission-waiting mark. [Cold evidence](2026-11-02-dictation-gaps/c-cold.jsonl), [warm evidence](2026-11-02-dictation-gaps/c-warm.jsonl).

| Measured interval | Cold (10), p50 / p95 ms | Warm (20), p50 / p95 ms |
| --- | ---: | ---: |
| `hotkeyToListeningCommittedMs` | 102.905 / 127.057 | 96.975 / 116.739 |
| `hotkeyToListeningShownMs` | 111.805 / 142.057 | 108.016 / 128.339 |
| `hotkeyToFirstAudioChunkMs` | 109.756 / 122.530 | 107.862 / 121.789 |
| `microphoneRequestMs` | 82.700 / 97.601 | 64.200 / 82.400 |
| `stopToRecorderStoppedMs` | 22.677 / 81.833 | 12.492 / 15.482 |
| `stopToLastSegmentMs` | 143.383 / 195.050 | 89.731 / 97.744 |
| `stopToPasteKeystrokeMs` | 433.928 / 742.877 | 376.046 / 406.755 |
| `stopToDeliveryReturnedMs` | 583.783 / 892.591 | 527.448 / 556.876 |
| `deliveryMs` | 443.000 / 718.800 | 436.800 / 463.300 |
| `historyMs` | 11.300 / 14.800 | 10.800 / 13.400 |
| `speechDurationMs` | 3623.000 / 3944.000 | 3485.000 / 3508.000 |
| `captureDurationMs` | 5074.000 / 5107.000 | 5071.000 / 5105.000 |

### C stage work

| Measured interval | Cold (10), p50 / p95 ms | Warm (20), p50 / p95 ms |
| --- | ---: | ---: |
| `commandDeliveryMs` | 0.280 / 0.418 | 0.229 / 0.530 |
| `widgetShowMs` | 0.076 / 1.886 | 0.078 / 5.681 |
| `audioContextMs` | 14.100 / 20.200 | 28.900 / 42.300 |
| `workletLoadMs` | 0.000 / 0.200 | 0.000 / 0.100 |
| `microphoneRequestMs` | 82.700 / 97.601 | 64.200 / 82.400 |
| `sourceConnectMs` | 0.000 / 0.200 | 0.000 / 0.100 |
| `startCueMs` | 113.300 / 130.900 | 125.500 / 146.500 |
| `recorderStopMs` | 22.100 / 81.300 | 12.099 / 14.900 |
| `transcriptionRequestMs` | 94.100 / 150.200 | 77.400 / 84.600 |
| `deliveryMs` | 443.000 / 718.800 | 436.800 / 463.300 |
| `focusedAppMs` | 12.091 / 14.226 | 10.825 / 11.866 |
| `clipboardWriteMs` | 0.999 / 1.385 | 0.300 / 0.349 |
| `widgetHideMs` | 0.330 / 0.382 | 0.665 / 2.764 |
| `pasteDelayMs` | 149.497 / 150.438 | 150.663 / 151.570 |
| `pasteKeystrokeMs` | 125.286 / 402.512 | 120.280 / 146.624 |
| `pasteSettleMs` | 149.596 / 150.075 | 151.058 / 151.885 |
| `historyMs` | 11.300 / 14.800 | 10.800 / 13.400 |

### C handoffs

| Measured interval | Cold (10), p50 / p95 ms | Warm (20), p50 / p95 ms |
| --- | ---: | ---: |
| `hotkeyToCommandMs` | 0.118 / 0.130 | 0.048 / 0.086 |
| `commandToRecorderMs` | 0.600 / 0.801 | 0.300 / 0.600 |
| `recorderToAudioContextMs` | 0.000 / 0.000 | 0.000 / 0.100 |
| `audioContextToWorkletMs` | 0.100 / 0.101 | 0.000 / 0.100 |
| `workletToMicrophoneMs` | 0.100 / 0.800 | 0.100 / 0.100 |
| `microphoneToSourceMs` | 0.300 / 0.400 | 0.200 / 0.300 |
| `microphoneToListeningDispatchMs` | 0.200 / 0.300 | 0.100 / 0.200 |
| `listeningDispatchToSourceMs` | 0.100 / 0.200 | 0.000 / 0.100 |
| `listeningDispatchToCommitMs` | 2.500 / 21.701 | 1.000 / 1.200 |
| `listeningCommitToShownMs` | 11.100 / 15.601 | 12.100 / 14.700 |
| `sourceToFirstChunkMs` | 4.200 / 24.000 | 4.300 / 21.100 |
| `stopToCommandMs` | 0.023 / 0.026 | 0.022 / 0.031 |
| `stopCommandToControllerMs` | 0.100 / 0.200 | 0.000 / 0.100 |
| `controllerToRecorderStopMs` | 0.200 / 0.300 | 0.100 / 0.200 |
| `recorderStopToTranscriptionMs` | 0.199 / 0.300 | 0.000 / 0.100 |
| `transcriptionToLastSegmentMs` | 0.100 / 0.200 | 0.000 / 0.100 |
| `lastSegmentToDeliveryMs` | 0.800 / 0.900 | 0.200 / 0.300 |
| `deliveryToFocusedAppMs` | 2.682 / 5.283 | 2.182 / 4.402 |
| `deliveryToClipboardMs` | 4.601 / 7.161 | 3.142 / 5.439 |
| `clipboardToWidgetHideMs` | 9.242 / 11.116 | 9.510 / 10.671 |
| `focusedAppToWidgetHideMs` | 0.022 / 0.025 | 0.026 / 0.031 |
| `widgetHideToPasteDelayMs` | 0.002 / 0.005 | 0.003 / 0.006 |
| `pasteDelayToKeystrokeMs` | 0.006 / 0.010 | 0.009 / 0.014 |
| `pasteKeystrokeToSettleMs` | 0.006 / 0.019 | 0.007 / 0.008 |
| `pasteSettleToDeliveryReturnMs` | 0.262 / 0.449 | 0.247 / 0.620 |
| `deliveryToHistoryMs` | 0.000 / 0.100 | 0.000 / 0.100 |
| `historyToReadyDispatchMs` | 1401.000 / 1401.700 | 1401.100 / 1401.800 |
| `readyDispatchToWidgetMs` | 2.701 / 8.500 | 8.400 / 11.900 |

Cold Listening p95 is 142.057 ms, 74.2% below the 550.796 ms baseline and within 150 ms in this batch. Warm Listening is 128.339 ms p95, above the 50 ms target and the 117.419 ms baseline. Its warm context resume is 42.300 ms p95 and microphone request 82.400 ms p95; these distributions overlap and their percentiles must not be added. Dispatch follows microphone readiness within 0.200 ms p95 and connects the source within another 0.100 ms. Warm first chunk is 121.789 ms p95, just above 120 ms; source-to-chunk p95 falls from B's 56.599 to 21.100 ms. The warm first-chunk regression from A and B is largely recovered, but this batch does not prove the target.

Every outlier is retained: cold stop-to-paste reaches 742.877 ms (402.512 ms in the paste helper), and warm reaches 697.142 ms (442.566 ms in the helper). The warm nearest-rank p95 is 406.755 ms; the maximum is still in the evidence. Stop-to-paste p50 remains 376.046 ms, above 350 ms. D had not yet been applied to this C build.

The 30.108-second idle observation used 11.625% of one core over nine app processes, RSS 1126.703 → 1080.016 MiB ([evidence](2026-11-02-dictation-gaps/c-idle.json)). Against the first baseline endpoint this is 0.744 CPU percentage points lower and 24.532 MiB higher. Earlier unchanged-baseline intervals varied by hundreds of MiB, so this single endpoint does not establish compliance with the 15 MB memory budget. Matched resource comparisons remain required.

C typecheck, lint, build and packaging passed. A code review found cached failed cue contexts and preparation while dictation was disabled; both were fixed before this build. Unit and perf sources await GitHub CI. No local test, e2e journey or design capture ran.

## D: native paste and immediate Ready

Source: `a3ec781c697d11f6d51a92d67362d23f8ade152e`, local Owl `0.1.43-owl.20261104.8005`. On macOS, paste uses the already-running, ready key listener to submit Command+V. It does not start a listener for paste. The existing fallback runs only when the listener reports that it did not send the command; an uncertain acknowledgement does not send it again. Focused-app lookup overlaps the clipboard write and still completes before the widget hides. After successful delivery and history, the controller publishes success, immediately resets to idle, dispatches Ready and releases the session with its existing guards. Copied keeps the configured display duration; cancellation and persistent error/recovery behavior are unchanged.

The fixed 150 ms clipboard serialization guard survives in the background. Successful delivery returns without awaiting it, allowing history and Ready to proceed; later clipboard writers still wait for it to protect the clipboard while the target consumes the submitted paste. This is not a claim that every fixed sleep except the configured paste delay has been removed. An unconfirmed paste still waits for the guard before offering copied recovery.

Only one diagnostic completed: ten warm recordings into Code, with cleanup off, history on and a saved **50 ms paste delay**. [Raw Code timings](2026-11-02-dictation-gaps/d-code.jsonl), [all numeric aggregates and samples](2026-11-02-dictation-gaps/d-code.summary.json), [numeric readback receipt](2026-11-02-dictation-gaps/d-four-apps.json).

The consolidation decision restores `DEFAULT_SETTINGS.pasteDelayMs` and its matching fixture to the previous **150 ms** because cross-app reliability is incomplete. Existing saved settings are not migrated. The 50 ms setting remains experimental evidence only: **D was not measured at 150 ms**, and the ten Code results below do not establish latency at the retained 150 ms default. Native paste, the background clipboard guard and immediate Ready are kept.

Independent readback reported ten occurrences of each expected clause and 530 characters in total, completing all ten Code deliveries at 50 ms. Despite its four-app filename, the receipt contains only Code. The runner failed while focusing Terminal before any Terminal trial; Terminal, Chrome and Notes were **not measured**. D's planned ten cold and twenty warm recordings and its idle observation did not complete. E was not implemented.

The archived raw records were checked against the source's fixed timing-event vocabulary: ten complete recordings, 45 event names and finite nonnegative numeric values only. The summary was checked against every raw sample and its nearest-rank percentiles. The receipt contains only the fixed app name Code, numeric delay/trial/clause/character counts and a boolean result. No dictated text, window titles, paths from the target, audio or other user content was copied into these artifacts.

| Measured interval | Code warm diagnostic (10), p50 / p95 ms |
| --- | ---: |
| `hotkeyToListeningCommittedMs` | 103.335 / 113.134 |
| `hotkeyToListeningShownMs` | 115.407 / 2069.788 |
| `hotkeyToFirstAudioChunkMs` | 110.007 / 131.788 |
| `microphoneRequestMs` | 65.500 / 75.400 |
| `stopToRecorderStoppedMs` | 11.396 / 28.191 |
| `stopToLastSegmentMs` | 84.396 / 171.391 |
| `stopToPasteKeystrokeMs` | 150.354 / 269.127 |
| `stopToDeliveryReturnedMs` | 150.496 / 269.391 |
| `stopToReadyMs` | 180.588 / 1888.791 |
| `deliveryMs` | 65.900 / 97.300 |
| `historyMs` | 10.100 / 14.700 |
| `speechDurationMs` | 3465.000 / 3884.000 |
| `captureDurationMs` | 5050.000 / 5082.000 |

### D stage work

| Measured interval | Code warm diagnostic (10), p50 / p95 ms |
| --- | ---: |
| `commandDeliveryMs` | 0.150 / 0.290 |
| `widgetShowMs` | 0.080 / 3.778 |
| `audioContextMs` | 35.400 / 45.000 |
| `workletLoadMs` | 0.000 / 0.100 |
| `microphoneRequestMs` | 65.500 / 75.400 |
| `sourceConnectMs` | 0.000 / 0.400 |
| `startCueMs` | 132.900 / 139.800 |
| `recorderStopMs` | 11.000 / 27.400 |
| `transcriptionRequestMs` | 73.800 / 142.900 |
| `deliveryMs` | 65.900 / 97.300 |
| `focusedAppMs` | 10.997 / 13.409 |
| `clipboardWriteMs` | 0.279 / 1.101 |
| `widgetHideMs` | 0.589 / 3.437 |
| `pasteDelayMs` | 50.953 / 51.558 |
| `pasteKeystrokeMs` | 0.613 / 30.505 |
| `pasteSettleMs` | 150.489 / 532.653 |
| `historyMs` | 10.100 / 14.700 |

### D handoffs

| Measured interval | Code warm diagnostic (10), p50 / p95 ms |
| --- | ---: |
| `hotkeyToCommandMs` | 0.057 / 0.123 |
| `commandToRecorderMs` | 0.300 / 0.700 |
| `recorderToAudioContextMs` | 0.000 / 0.000 |
| `audioContextToWorkletMs` | 0.000 / 0.101 |
| `workletToMicrophoneMs` | 0.100 / 2.300 |
| `microphoneToSourceMs` | 0.200 / 0.400 |
| `microphoneToListeningDispatchMs` | 0.100 / 0.300 |
| `listeningDispatchToSourceMs` | 0.000 / 0.100 |
| `listeningDispatchToCommitMs` | 1.101 / 2.300 |
| `listeningCommitToShownMs` | 10.299 / 1958.800 |
| `sourceToFirstChunkMs` | 2.200 / 22.600 |
| `stopToCommandMs` | 0.026 / 0.059 |
| `stopCommandToControllerMs` | 0.000 / 0.300 |
| `controllerToRecorderStopMs` | 0.200 / 0.300 |
| `recorderStopToTranscriptionMs` | 0.000 / 0.200 |
| `transcriptionToLastSegmentMs` | 0.000 / 0.100 |
| `lastSegmentToDeliveryMs` | 0.101 / 0.700 |
| `deliveryToFocusedAppMs` | 2.129 / 4.604 |
| `deliveryToClipboardMs` | 3.074 / 5.571 |
| `clipboardToWidgetHideMs` | 9.782 / 10.148 |
| `focusedAppToWidgetHideMs` | 0.027 / 0.057 |
| `widgetHideToPasteDelayMs` | 0.003 / 0.005 |
| `pasteDelayToKeystrokeMs` | 0.008 / 0.019 |
| `pasteKeystrokeToSettleMs` | 0.004 / 0.006 |
| `pasteKeystrokeToDeliveryReturnMs` | 0.117 / 0.621 |
| `deliveryToHistoryMs` | 0.000 / 0.100 |
| `historyToReadyDispatchMs` | 0.100 / 0.200 |
| `readyDispatchToWidgetMs` | 16.200 / 1608.500 |
| `sourceToListeningDispatchMs` | 0.000 / 0.000 |

All ten recordings and every outlier are retained. At ten samples, nearest-rank p95 is the maximum. The first trial committed Listening at 110.988 ms but marked it shown at 2069.788 ms, a 1958.800 ms observation gap. Its Ready dispatch was 280.291 ms after stop, while the widget-ready mark arrived at 1888.791 ms: an unexplained 1608.500 ms animation-frame observation lag. As with B, these marks do not establish whether the user saw the same delay. They neither prove a 1.6-second app-owned stall nor justify dropping the sample or claiming that Ready meets the handoff target. The first background clipboard guard also took 532.653 ms; that full interval remains in `pasteSettleMs`, although successful delivery did not wait for it.

Code's stop-to-paste p50 / p95 is 150.354 / 269.127 ms, compared with C's warm TextEdit 376.046 / 406.755 ms. This is a preliminary comparison across different targets, sample sizes and paste-delay settings, not a matched estimate of D's improvement. D's history-to-Ready-dispatch interval is 0.100 / 0.200 ms, and paste-acknowledgement-to-delivery-return is 0.117 / 0.621 ms; the observed widget Ready interval above remains unresolved.

The controller unit and perf sources assert immediate Ready after a pasted success while preserving complete text, including the scripted 150 ms first-word case. Affected E2E sources now check final Ready/idle and retain full-text, clipboard, history, copied and failure evidence. These sources await GitHub CI. No local unit test, E2E journey or design capture was run. Full `npm run typecheck` and `npm run lint` passed after the default and matching fixture constants were restored from 50 to 150. Both measurement scripts also passed Node's syntax check.

The final source review found no blocking correctness issues in warm capture ownership, device rebuilding, permission waiting, stop during start, cue parallelism, native paste fallback, clipboard serialization or immediate Ready. Keyboard-layout variants still need live verification. The Mac's original saved paste delay (150 ms), AI cleanup and idle-widget settings were restored. No measurement process remained running, and the temporary Code installation and Chrome paste-check profile were removed. The installed D measurement build was retained; its experimental 50 ms saved setting was not.

## Acceptance and limitations

These are the original targets, retained for comparison after the user ended the pursuit. They are not a declaration of acceptance or a plan to continue measuring.

| Measure | Original target | Measured status at consolidation |
| --- | ---: | --- |
| Hotkey to Listening, warm p95 | ≤50 ms | Not met: C 128.339 ms; D Code diagnostic 2069.788 ms with its first-trial observation outlier retained. |
| Hotkey to Listening, cold p95 | ≤150 ms | C met it at 142.057 ms in its batch; no D cold batch. |
| Hotkey to first captured chunk, warm p95 | ≤120 ms | Not met: C 121.789 ms; D Code diagnostic 131.788 ms. |
| Stop to paste, local, no cleanup, p50 / p95 | ≤350 / ≤500 ms | D Code diagnostic at a 50 ms paste delay is 150.354 / 269.127 ms. No exact D measurement at the retained 150 ms default exists; its latency and cross-app reliability are unproven. |
| App overhead beyond cleanup request time | ≤30 ms | Not measured with cleanup enabled. The diagnostic's 50 ms paste delay plus local ASR already exceeds 30 ms before other work. |
| App-owned idle gap at each handoff | ≤16 ms | Not established for every handoff. D removes the success hold and measures history-to-Ready dispatch at 0.100 / 0.200 ms; the Ready observation lag remains unexplained. |
| Idle CPU increase / memory increase | ≤0.5 percentage points / ≤15 MB | Unproven: no D idle measurement, and the baseline varied too much for single endpoint comparisons. |

The baseline and A–C full batches and D's ten Code diagnostics are the available evidence. The original goals were not achieved as a whole. No Terminal, Chrome or Notes D trials, D batch of ten cold and twenty warm recordings, D idle comparison or cleanup-enabled timing batch completed; E was not implemented. Further latency-target work ended at the user's request rather than remaining queued here. Consolidation retains the optimizations, the background clipboard guard, the outliers and the outstanding GitHub CI validation. The shipped paste-delay default is restored to 150 ms without migrating existing saved settings; the experimental 50 ms results do not prove latency at that default.
